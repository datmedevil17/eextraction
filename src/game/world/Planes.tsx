"use client";

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PLAY_LIMIT, RUNWAYS, heightAt, waterDepth } from "@/game/terrain";
import { ctl, pose, ride, useGame, useRide } from "@/game/store";
import { damageEnemy, enemies, hurtPlayer, rayEnemy } from "@/game/weapons/combat";
import { sfx } from "@/game/weapons/audio";
import { Blasts, Sparks, Streaks } from "@/game/weapons/fx";
import { terrainRay } from "@/game/weapons/Weapons";
import { bodies, setBody } from "@/game/physics";
import { pushOut } from "./colliders";
import { loadKit, setShadow } from "./modelKit";
import { damageDragon, dragonTargets, dragonsNear, rayDragon, type DragonTarget } from "./dragonHits";
import { DEFAULT_SPEC, G, VTOL_SPEC, bankOf, fwdOf, instructor, makeCtl, makePlane, rightOf, step, upOf, type Ctl, type Env, type Plane, type PlaneSpec } from "./flightModel";
import { planeHud, planeMarks } from "./planeState";

// Flyable planes parked at the two airstrips (terrain.ts RUNWAYS). Arcade-sim flight model in flightModel.ts.
//   F: get in / out (out only when stopped on the ground)   double-tap F in the air: bail out (parachute)
//   mouse: aim (the plane flies where you look, instructor style)   W/S: throttle   A/D: roll   Q/E: rudder
//   arrows Up/Down: manual pitch (no stall protection)   Space: brakes / air brake   LMB: guns   RMB: rockets
//   V: chase / cockpit view   hold C: free look
// VTOL gunship (spec.vtol) in hover mode: Space / Shift up / down, W/S tilt fwd / back, A/D strafe, Q/E or the mouse yaw,
//   H: hover <-> forward flight (the fans hand over to the wing as it gains speed). Its chin turret aims at the mouse.

// ---------------------------------------------------------------- config
type Axis = "x" | "y" | "z";
/** Drop-in model per spot (loadKit conventions: scaled to `len` along Z, wheels on y=0, `yaw` fixes the facing). */
type GlbCfg = {
  url: string;
  len: number; // nose-to-tail metres
  yaw?: number; // radians, if the model isn't modelled facing +Z
  gearH?: number; // CG height above the wheel contact patch (defaults to the flight spec's 1.45 m)
  prop?: RegExp; propAxis?: Axis; // spinning node + its local spin axis (default z)
  aileronL?: RegExp; aileronR?: RegExp; elevator?: RegExp; rudder?: RegExp; // control-surface nodes
  surfAxis?: { ail?: Axis; elev?: Axis; rud?: Axis }; // local hinge axes (default x, x, y)
  surfK?: { ail?: number; elev?: number; rud?: number }; // deflection (rad) at full input; flip the sign if one moves backwards
  guns?: RegExp; // gun-barrel node(s): muzzles = their front-most points, one per side
  turret?: RegExp; // node re-pivoted at its centre and turned toward the aim point (its gun fires along the aim)
  fans?: RegExp; engines?: RegExp; // lift-fan / main-engine nodes: glow discs added under / behind them (one per side)
};
type V3 = [number, number, number];
type SpotCfg = {
  id: string; label: string; runway: number; along: number; color: string; accent: string;
  spec?: PlaneSpec; // handling profile (default DEFAULT_SPEC)
  cockpit?: V3; muzzles?: V3[]; pylons?: V3[]; // body frame (x right, y up, z forward), metres from the CG
  glb?: GlbCfg;
};

// Drop a GLB in public/models/planes/ and point a spot at it; remove `glb` to fly the primitive placeholder.
// Control-surface example: aileronL: /aileron_?l/i, aileronR: /aileron_?r/i, elevator: /elevator/i, rudder: /rudder/i
const SPOTS: SpotCfg[] = [
  {
    id: "north", label: "Faceless Airstrip", runway: 0, along: 24, color: "#d5dae0", accent: "#2f6fd6",
    glb: { url: "/models/planes/warplane.glb", len: 9, yaw: 0, gearH: 1.7, prop: /^fan/i, guns: /^gun_barrel/i },
  },
  {
    id: "desert", label: "Desert Airstrip", runway: 1, along: 30, color: "#e6d3a3", accent: "#c4512b",
    spec: VTOL_SPEC, cockpit: [0, 1.5, 6.4], muzzles: [[0, -1.2, 6.5]], pylons: [[4.6, -0.9, 1], [-4.6, -0.9, 1]],
    glb: { url: "/models/planes/vtol.glb", len: 17.5, yaw: 0, turret: /^ball_turret/i, fans: /^vertical_thrust/i, engines: /^main_engine/i },
  },
];

const ENTER_R = 7;
const STEPS_HZ = 60;
const GUN_RATE = 18; // rounds / s (both guns together)
const MUZZLE_V = 650;
const CONVERGE = 300;
const AIM_DIST = 400; // the aim circle sits this far out along the mouse direction
const GUN_DMG = 22;
const AMMO = 1000;
const HEAT_SHOT = 0.02;
const HEAT_COOL = 0.16;
const ROCKETS = 8;
const ROCKET_RELOAD = 3;
const ROCKET_DMG = 260;
const SPLASH = 10;
const WRECK_T = 9;
const CHUTE_VY = -6;
const MUZZLES: [number, number, number][] = [[2.3, -0.35, 1.2], [-2.3, -0.35, 1.2]]; // body frame: x = right
const PYLONS: [number, number, number][] = [[3.4, -0.6, 0.5], [-3.4, -0.6, 0.5]];

const sm = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------- model rig
type Surf = { o: THREE.Object3D; axis: Axis; k: number; base: number };
type Rig = {
  root: THREE.Object3D; prop: THREE.Object3D | null; propAxis: Axis; propBase: number; blur: THREE.Mesh | null; elev: Surf[]; ail: Surf[]; rud: Surf[];
  turret: THREE.Object3D | null; guns: V3[] | null; fanGlow: THREE.Mesh[]; engGlow: THREE.Mesh[];
};

/** Primitive stand-in: lathe fuselage, low wing with ailerons, tail with elevator + rudder, 3-blade prop, tricycle gear. */
function buildPlaceholder(s: PlaneSpec, color: string, accent: string): Rig {
  const root = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.45 });
  const trim = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: "#222428", metalness: 0.4, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: "#1b3550", metalness: 0.9, roughness: 0.08, envMapIntensity: 1.4 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const pivot = (x: number, y: number, z: number) => {
    const p = new THREE.Group();
    p.position.set(x, y, z);
    root.add(p);
    return p;
  };
  const L = s.len;
  // fuselage (lathe around Y, turned to Z)
  const prof = [[0.04, -0.5], [0.22, -0.46], [0.48, -0.28], [0.74, -0.05], [0.8, 0.17], [0.72, 0.36], [0.55, 0.46], [0.3, 0.5]].map(([r, y]) => new THREE.Vector2(r, y * L));
  const fus = new THREE.LatheGeometry(prof, 18);
  fus.rotateX(Math.PI / 2);
  add(fus, body, 0, 0, 0);
  // stripe + canopy
  add(new THREE.CylinderGeometry(0.805, 0.805, 0.5, 18, 1, true).rotateX(Math.PI / 2), trim, 0, 0, -1.6);
  const can = add(new THREE.SphereGeometry(1, 18, 12), glass, 0, 0.62, 0.7);
  can.scale.set(0.5, 0.45, 1.15);
  // wing (centre section + outer panels), ailerons hinge at the trailing edge
  const wy = -0.3, wz = 0.35, chord = 1.7, te = wz - chord / 2;
  add(new THREE.BoxGeometry(s.span, 0.16, chord), body, 0, wy, wz);
  add(new THREE.BoxGeometry(0.9, 0.17, chord * 0.98), trim, s.span / 2 - 0.45, wy, wz);
  add(new THREE.BoxGeometry(0.9, 0.17, chord * 0.98), trim, -s.span / 2 + 0.45, wy, wz);
  const ail: Surf[] = [];
  for (const side of [1, -1]) {
    const p = pivot(side * (s.span * 0.33), wy, te);
    add(new THREE.BoxGeometry(s.span * 0.26, 0.1, 0.42), trim, 0, 0, -0.21, p);
    // x > 0 is the left wing: its aileron goes down for a right roll
    ail.push({ o: p, axis: "x", k: side > 0 ? -0.35 : 0.35, base: 0 });
  }
  // tail
  const tz = -L * 0.43;
  add(new THREE.BoxGeometry(3.6, 0.1, 0.9), body, 0, 0.15, tz);
  const ep = pivot(0, 0.15, tz - 0.45);
  add(new THREE.BoxGeometry(3.6, 0.08, 0.5), trim, 0, 0, -0.25, ep);
  const fin = add(new THREE.BoxGeometry(0.12, 1.5, 1.1), body, 0, 0.95, tz + 0.05);
  fin.rotation.x = -0.25;
  const rp = pivot(0, 0.95, tz - 0.5);
  add(new THREE.BoxGeometry(0.1, 1.4, 0.45), trim, 0, 0, -0.22, rp);
  // propeller
  const prop = pivot(0, 0, L / 2 + 0.05);
  add(new THREE.ConeGeometry(0.28, 0.6, 12).rotateX(Math.PI / 2), trim, 0, 0, 0.2, prop);
  for (let i = 0; i < 3; i++) {
    const b = add(new THREE.BoxGeometry(0.2, 1.35, 0.05), dark, 0, 0, 0, prop);
    b.geometry.translate(0, 0.68, 0);
    b.rotation.z = (i / 3) * Math.PI * 2;
    b.rotation.y = 0.25;
  }
  const blur = new THREE.Mesh(new THREE.CircleGeometry(1.4, 28), new THREE.MeshBasicMaterial({ color: "#c8c8c8", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  blur.position.set(0, 0, L / 2 + 0.08);
  root.add(blur);
  // gear: mains under the wing, nose wheel forward; wheel bottoms on y = -gearH
  const wheel = (r: number) => new THREE.CylinderGeometry(r, r, 0.22, 14).rotateZ(Math.PI / 2);
  for (const side of [1, -1]) {
    const x = side * s.track / 2;
    add(new THREE.CylinderGeometry(0.07, 0.07, s.gearH - 0.5, 6), dark, x, wy - (s.gearH - 0.5) / 2 - 0.05, s.mainZ);
    add(wheel(0.35), dark, x, -s.gearH + 0.35, s.mainZ);
  }
  const nz = s.mainZ + s.wheelbase;
  add(new THREE.CylinderGeometry(0.06, 0.06, s.gearH - 0.4, 6), dark, 0, -(s.gearH - 0.4) / 2 - 0.25, nz);
  add(wheel(0.28), dark, 0, -s.gearH + 0.28, nz);
  return { root, prop, propAxis: "z", propBase: 0, blur, elev: [{ o: ep, axis: "x", k: 0.4, base: 0 }], ail, rud: [{ o: rp, axis: "y", k: 0.4, base: 0 }], turret: null, guns: null, fanGlow: [], engGlow: [] };
}

/** Per-side bounding boxes (root frame, +x = left side) of the meshes under `objs`, from their vertices. */
function sideBoxes(objs: THREE.Object3D[]) {
  const L = new THREE.Box3(), R = new THREE.Box3(), v = new THREE.Vector3();
  for (const o of objs) o.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    const st = Math.max(1, Math.floor(pos.count / 6000));
    for (let i = 0; i < pos.count; i += st) { v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); (v.x >= 0 ? L : R).expandByPoint(v); }
  });
  return [L, R].filter((b) => !b.isEmpty());
}
const glowMat = (color: string) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });

/** Rig a loaded GLB: find the prop / control-surface nodes by name. */
function rigGlb(inst: THREE.Object3D, cfg: GlbCfg, gearH: number): Rig {
  const root = new THREE.Group();
  inst.position.y -= gearH; // loadKit puts the lowest point (wheels) on y=0; the plane's origin is its CG
  root.add(inst);
  const find = (re?: RegExp) => {
    const out: THREE.Object3D[] = [];
    if (re) inst.traverse((o) => { if (re.test(o.name)) out.push(o); });
    // keep only the top-most matches (a hinge node and its child meshes often share the name)
    return out.filter((o) => !out.some((p) => p !== o && isAncestor(p, o)));
  };
  const ax = cfg.surfAxis ?? {}, k = cfg.surfK ?? {};
  const surf = (re: RegExp | undefined, axis: Axis, kk: number): Surf[] => find(re).map((o) => ({ o, axis, k: kk, base: o.rotation[axis] }));
  root.updateMatrixWorld(true);
  // spinning / aiming parts are modelled around the file's origin: hang them on a pivot at their own centre
  const repivot = (o: THREE.Object3D | undefined) => {
    if (!o) return null;
    const box = new THREE.Box3().setFromObject(o);
    const pv = new THREE.Group();
    box.getCenter(pv.position);
    root.add(pv);
    pv.updateMatrixWorld(true);
    pv.attach(o);
    return pv;
  };
  const prop = repivot(find(cfg.prop)[0]);
  const turret = repivot(find(cfg.turret)[0]);
  const guns = cfg.guns ? sideBoxes(find(cfg.guns)).map((b): V3 => { const c = b.getCenter(new THREE.Vector3()); return [-c.x, c.y, b.max.z]; }) : [];
  const fanGlow = cfg.fans ? sideBoxes(find(cfg.fans)).map((b) => {
    const sz = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const m = new THREE.Mesh(new THREE.CircleGeometry(1, 24).rotateX(Math.PI / 2), glowMat("#7fd8ff"));
    m.scale.set(sz.x * 0.42, 1, sz.z * 0.42);
    m.position.set(c.x, b.min.y - 0.05, c.z);
    root.add(m);
    return m;
  }) : [];
  const engGlow = cfg.engines ? sideBoxes(find(cfg.engines)).map((b) => {
    const sz = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const m = new THREE.Mesh(new THREE.CircleGeometry(Math.min(sz.x, sz.y) * 0.32, 20), glowMat("#ffb36a"));
    m.position.set(c.x, c.y, b.min.z - 0.05);
    root.add(m);
    return m;
  }) : [];
  return {
    root, prop, propAxis: cfg.propAxis ?? "z", propBase: 0, blur: null, turret, guns: guns.length ? guns : null, fanGlow, engGlow,
    elev: surf(cfg.elevator, ax.elev ?? "x", k.elev ?? 0.4),
    ail: [...surf(cfg.aileronL, ax.ail ?? "x", -(k.ail ?? 0.35)), ...surf(cfg.aileronR, ax.ail ?? "x", k.ail ?? 0.35)],
    rud: surf(cfg.rudder, ax.rud ?? "y", k.rud ?? 0.4),
  };
}
const enterPad = (c: { spec: PlaneSpec }) => Math.max(0, c.spec.len * 0.5 - 4.5); // big craft: reach the door, not the CG
const isAncestor = (a: THREE.Object3D, b: THREE.Object3D) => { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; };

function buildChute() {
  const g = new THREE.Group();
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(4.2, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshStandardMaterial({ color: "#ff7a1a", roughness: 0.8, side: THREE.DoubleSide }));
  canopy.scale.y = 0.6;
  canopy.position.y = 6.5;
  g.add(canopy);
  const pilot = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.0, 4, 8), new THREE.MeshStandardMaterial({ color: "#3b4a2f", roughness: 0.9 }));
  pilot.position.y = 0.8;
  g.add(pilot);
  const pts: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(0, 1.5, 0, Math.cos(a) * 3.4, 6.5 + 0.9, Math.sin(a) * 3.4);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: "#222" })));
  g.visible = false;
  return g;
}

function buildWreck() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: "#1c1a18", roughness: 1 });
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(7, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#0d0b0a", transparent: true, opacity: 0.75, depthWrite: false }));
  scorch.position.y = 0.12;
  g.add(scorch);
  const parts: [number, number, number, number, number, number, number][] = [[0, 0.5, 0, 1.6, 1.0, 5, 0.2], [2.5, 0.2, 1, 4, 0.15, 1.5, 0.5], [-3, 0.3, -1, 3.5, 0.15, 1.4, -0.7], [0.5, 0.6, -3.2, 2.5, 0.8, 0.6, 1.2]];
  for (const [x, y, z, w, h, d, r] of parts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.set(r * 0.3, r, r * 0.2);
    g.add(m);
  }
  g.visible = false;
  return g;
}

// ---------------------------------------------------------------- smoke (normal-blended puffs)
class Puffs {
  mesh: THREE.InstancedMesh;
  px: Float32Array; py: Float32Array; pz: Float32Array; vx: Float32Array; vy: Float32Array; vz: Float32Array;
  life: Float32Array; max: Float32Array; s0: Float32Array; s1: Float32Array; head = 0;
  private o = new THREE.Object3D();
  private c = new THREE.Color();
  constructor(public cap = 400) {
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false, fog: true }), cap);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    const f = () => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.max = f(); this.s0 = f(); this.s1 = f();
    this.mesh.setColorAt(0, this.c.set(0));
  }
  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, s0: number, s1: number, life: number, grey: number) {
    const k = this.head++ % this.cap;
    this.px[k] = x; this.py[k] = y; this.pz[k] = z; this.vx[k] = vx; this.vy[k] = vy; this.vz[k] = vz;
    this.life[k] = this.max[k] = life; this.s0[k] = s0; this.s1[k] = s1;
    this.mesh.setColorAt(k, this.c.setScalar(grey));
  }
  update(dt: number) {
    let n = 0;
    for (let k = 0; k < this.cap; k++) {
      if (this.life[k] <= 0) { this.o.scale.setScalar(0); this.o.updateMatrix(); this.mesh.setMatrixAt(k, this.o.matrix); continue; }
      this.life[k] -= dt;
      const d = Math.exp(-1.5 * dt);
      this.vx[k] *= d; this.vz[k] *= d; this.vy[k] = this.vy[k] * d + 0.8 * dt;
      this.px[k] += this.vx[k] * dt; this.py[k] += this.vy[k] * dt; this.pz[k] += this.vz[k] * dt;
      const f = 1 - Math.max(0, this.life[k]) / this.max[k];
      const s = (this.s0[k] + (this.s1[k] - this.s0[k]) * Math.sqrt(f)) * (f > 0.8 ? (1 - f) / 0.2 : 1);
      this.o.position.set(this.px[k], this.py[k], this.pz[k]);
      this.o.scale.setScalar(Math.max(0.001, s));
      this.o.updateMatrix();
      this.mesh.setMatrixAt(k, this.o.matrix);
      n = k + 1;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- engine / gun sound (own tiny synth)
class PlaneAudio {
  ctx: AudioContext | null = null;
  gain: GainNode | null = null;
  o1: OscillatorNode | null = null;
  o2: OscillatorNode | null = null;
  filt: BiquadFilterNode | null = null;
  noise: AudioBuffer | null = null;
  ensure() {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.gain = ctx.createGain(); this.gain.gain.value = 0;
      this.filt = ctx.createBiquadFilter(); this.filt.type = "lowpass"; this.filt.frequency.value = 600;
      this.o1 = ctx.createOscillator(); this.o1.type = "sawtooth";
      this.o2 = ctx.createOscillator(); this.o2.type = "square";
      this.o1.connect(this.filt); this.o2.connect(this.filt); this.filt.connect(this.gain); this.gain.connect(ctx.destination);
      this.o1.start(); this.o2.start();
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }
  engine(on: boolean, thr: number, V: number) {
    if (!this.ctx || !this.gain || !this.o1 || !this.o2 || !this.filt) return;
    const t = this.ctx.currentTime;
    const f = 38 + thr * 70 + V * 0.35;
    this.o1.frequency.setTargetAtTime(f, t, 0.08);
    this.o2.frequency.setTargetAtTime(f * 0.5 + 3, t, 0.08);
    this.filt.frequency.setTargetAtTime(380 + thr * 900 + V * 6, t, 0.1);
    this.gain.gain.setTargetAtTime(on ? 0.035 + thr * 0.06 : 0, t, 0.15);
  }
  burst(vol: number, freq: number, dur = 0.08) {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = vol;
    g.gain.setTargetAtTime(0, ctx.currentTime + dur * 0.5, dur * 0.4);
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start();
    src.stop(ctx.currentTime + dur * 2.5);
  }
}

// ---------------------------------------------------------------- state
type Craft = {
  id: string; cfg: SpotCfg; spec: PlaneSpec; pl: Plane; c: Ctl; g: THREE.Group; rig: Rig;
  home: { x: number; z: number; h: number };
  state: "idle" | "flown" | "pilotless" | "wreck";
  wreckT: number; wreck: THREE.Group; strayT: number;
  propA: number; heat: number; overheat: boolean; ammo: number; rockets: number; rocketT: number; gunCd: number; side: number; refillT: number;
};
const BCAP = 220, RCAP = 16;
type World = ReturnType<typeof makeWorld>;

function homeOf(cfg: SpotCfg) {
  const r = RUNWAYS[cfg.runway];
  const L = Math.hypot(r.x1 - r.x0, r.z1 - r.z0);
  const dx = (r.x1 - r.x0) / L, dz = (r.z1 - r.z0) / L;
  return { x: r.x0 + dx * cfg.along, z: r.z0 + dz * cfg.along, h: Math.atan2(dx, dz) };
}

function makeWorld() {
  const crafts: Craft[] = SPOTS.map((cfg) => {
    const base = cfg.spec ?? DEFAULT_SPEC;
    const spec: PlaneSpec = cfg.glb?.gearH ? { ...base, gearH: cfg.glb.gearH } : base;
    const home = homeOf(cfg);
    const pl = makePlane(home.x, heightAt(home.x, home.z) + spec.gearH, home.z, home.h);
    pl.nac = spec.vtol ? 1 : 0;
    const g = new THREE.Group();
    const rig = buildPlaceholder(spec, cfg.color, cfg.accent);
    g.add(rig.root);
    const c = makeCtl();
    c.brake = true;
    c.nac = pl.nac;
    return {
      id: cfg.id, cfg, spec, pl, c, g, rig, home, state: "idle" as const, wreckT: 0, wreck: buildWreck(), strayT: 0,
      propA: 0, heat: 0, overheat: false, ammo: AMMO, rockets: ROCKETS, rocketT: 0, gunCd: 0, side: 0, refillT: 0,
    };
  });
  const f = (n: number) => new Float32Array(n);
  return {
    crafts,
    streaks: new Streaks(BCAP + RCAP),
    sparks: new Sparks(600),
    blasts: new Blasts(24),
    puffs: new Puffs(500),
    chute: buildChute(),
    audio: new PlaneAudio(),
    // bullets
    b: { x: f(BCAP), y: f(BCAP), z: f(BCAP), vx: f(BCAP), vy: f(BCAP), vz: f(BCAP), life: f(BCAP), head: 0 },
    // rockets
    r: { x: f(RCAP), y: f(RCAP), z: f(RCAP), vx: f(RCAP), vy: f(RCAP), vz: f(RCAP), life: f(RCAP), boost: f(RCAP), smoke: f(RCAP), head: 0 },
  };
}

// scratch
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _bp = { x: 0, z: 0 };
const ORANGE = new THREE.Color(1, 0.55, 0.15);
const TRACER = new THREE.Color(1, 0.72, 0.3);
const SPARK = new THREE.Color(1, 0.8, 0.45);
const BLOOD = new THREE.Color(0.9, 0.15, 0.1);

// ---------------------------------------------------------------- aim assist
// Targets: pteros (enemies tagged "ptero") and the shootable dragons. Lock = nearest to the aim inside a cone.
type Lock = { e: (typeof enemies)[number] | null; tg: DragonTarget | null };
const LOCK_CONE = 0.24; // rad (~14°) to acquire
const LOCK_KEEP = 0.42; // rad: a held lock survives this far off the aim
const LOCK_RANGE = 1200;
const GIMBAL = 0.14; // rad: fixed guns may bend this far toward the lead point
const TURN_RATE = 0.85; // rad/s of aim yaw for A/D
const lockAlive = (l: Lock) => (l.e ? l.e.alive : !!l.tg?.alive);
/** centre of a lock target (dragons: their biggest hit sphere) + its radius */
function lockPoint(l: Lock, out: THREE.Vector3) {
  if (l.e) { out.set(l.e.x, l.e.y + l.e.h * 0.5, l.e.z); return l.e.r; }
  const tg = l.tg!;
  let bi = 0;
  for (let i = 1; i < tg.n; i++) if (tg.s[i * 4 + 3] > tg.s[bi * 4 + 3]) bi = i;
  out.set(tg.s[bi * 4], tg.s[bi * 4 + 1], tg.s[bi * 4 + 2]);
  return tg.s[bi * 4 + 3];
}
const _lp = new THREE.Vector3();
/** angle between dir and the target as seen from o, minus its angular radius (big dragons are easy to pick) */
function lockAngle(l: Lock, o: THREE.Vector3, dir: THREE.Vector3) {
  const r = lockPoint(l, _lp);
  _lp.sub(o);
  const d = _lp.length();
  if (d > LOCK_RANGE || d < 1) return Infinity;
  return Math.acos(THREE.MathUtils.clamp(_lp.dot(dir) / d, -1, 1)) - Math.asin(Math.min(1, r / d));
}
function findLock(o: THREE.Vector3, dir: THREE.Vector3, cur: Lock | null): Lock | null {
  if (cur && lockAlive(cur) && lockAngle(cur, o, dir) < LOCK_KEEP) return cur;
  let best: Lock | null = null, ba = LOCK_CONE;
  for (const e of enemies) {
    if (!e.alive || e.tag !== "ptero") continue;
    const l = { e, tg: null }, a = lockAngle(l, o, dir);
    if (a < ba) { ba = a; best = l; }
  }
  for (const id in dragonTargets) {
    const tg = dragonTargets[id];
    if (!tg.alive || !tg.n) continue;
    const l = { e: null, tg }, a = lockAngle(l, o, dir);
    if (a < ba) { ba = a; best = l; }
  }
  return best;
}
/** move v up toward lo by at most step (never down) */
const raise = (v: number, lo: number, step: number) => (v < lo ? Math.min(lo, v + step) : v);
const sameLock = (a: Lock | null, b: Lock | null) => !!a && !!b && a.e === b.e && a.tg === b.tg;

const dirOf = (yaw: number, pitch: number, out: THREE.Vector3) => out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
/** world point of a body-frame offset (x = right, y = up, z = forward) */
const bodyPt = (pl: Plane, x: number, y: number, z: number, out: THREE.Vector3) => out.set(-x, y, z).applyQuaternion(pl.q).add(pl.p);

/** Ground + scenery for the flight model. blocked() is called every step, so it stays cheap. */
let blockSpan = DEFAULT_SPEC.span; // wingspan of the craft being stepped
const env: Env = {
  ground: heightAt,
  water: waterDepth,
  limit: PLAY_LIMIT,
  blocked: (pl) => {
    const y = pl.p.y - 0.7;
    _bp.x = pl.p.x; _bp.z = pl.p.z;
    if (pushOut(_bp, 1.1, y)) return true; // towers, buildings, trees, rocks (each knows its height)
    if (pl.agl < 45) {
      rightOf(pl.q, _r);
      for (const s of [-1, 1]) {
        const h = blockSpan * 0.5 * s;
        _bp.x = pl.p.x + _r.x * h; _bp.z = pl.p.z + _r.z * h;
        if (pushOut(_bp, 0.5, pl.p.y + _r.y * h - 0.4)) return true;
      }
    }
    for (const id in bodies) {
      const b = bodies[id];
      if (!b.on || id.startsWith("plane-") || pl.p.y < b.y0 - 1 || pl.p.y > b.y1 + 1) continue;
      if (Math.hypot(pl.p.x - b.x, pl.p.z - b.z) < b.r + 2.5) return true;
    }
    for (const id in dragonTargets) {
      const tg = dragonTargets[id];
      if (!tg.alive) continue;
      for (let i = 0; i < tg.n; i++) {
        const k = i * 4;
        if (Math.hypot(pl.p.x - tg.s[k], pl.p.y - tg.s[k + 1], pl.p.z - tg.s[k + 2]) < tg.s[k + 3] + 2.5) return true;
      }
    }
    return false;
  },
};

// ---------------------------------------------------------------- component
export function Planes() {
  const { camera, gl } = useThree();
  const W = useMemo(() => makeWorld(), []);
  // per-session input / camera state (plain object: mutated from handlers + the frame loop)
  const io = useMemo(() => ({
    keys: {} as Record<string, boolean>,
    fly: null as Craft | null,
    chute: false, chP: new THREE.Vector3(), chV: new THREE.Vector3(),
    aimYaw: 0, aimPitch: 0, lookYaw: 0, lookPitch: 0,
    view: "chase" as "chase" | "cockpit",
    fire: false, rocketReq: 0,
    camOff: new THREE.Vector3(0, 4, -14), shake: 0, lastF: 0,
    turn: 0, camDir: new THREE.Vector3(0, 0, 1), camUp: new THREE.Vector3(0, 1, 0),
    mouseT: 9, // seconds since the mouse last moved the aim (auto-climb only takes over when it's idle)
    // aim assist: the locked target, its smoothed velocity and the lead point the guns fire at
    lock: null as Lock | null, lockP: new THREE.Vector3(), lockV: new THREE.Vector3(), lead: new THREE.Vector3(), lockT: 0,
    rTgt: Array.from({ length: RCAP }, () => null as Lock | null),
    dbg: { fire: false, rocket: 0, keys: {} as Record<string, boolean>, aimYaw: null as number | null, aimPitch: null as number | null },
  }), []);

  // ------------------------------------------------ enter / leave
  const enter = (cr: Craft) => {
    io.fly = cr;
    cr.state = "flown";
    cr.c.brake = false;
    io.chute = false;
    fwdOf(cr.pl.q, _f);
    io.aimYaw = Math.atan2(_f.x, _f.z);
    io.aimPitch = 0;
    io.lookYaw = io.lookPitch = 0;
    io.camOff.set(-_f.x * 15, 4, -_f.z * 15);
    io.camDir.copy(_f); io.camUp.set(0, 1, 0); io.turn = 0;
    ride.on = true;
    ride.plane = true;
    useRide.getState().set({ plane: true, prompt: null });
    planeHud.active = true;
    planeHud.ejectArm = 0;
    W.audio.ensure();
    say(cr.spec.vtol ? `${cr.cfg.label} gunship: Space lift off, W/S tilt, A/D strafe, H forward flight` : `${cr.cfg.label}: hold W to take off (it climbs on its own) · A/D turn · K guns · L rockets`);
  };
  const onFoot = (x: number, z: number) => {
    ride.on = false;
    ride.plane = false;
    io.chute = false;
    W.chute.visible = false;
    planeHud.active = false;
    planeHud.chute = false;
    useRide.getState().set({ plane: false });
    ctl.teleport = { x, z };
    W.audio.engine(false, 0, 0);
  };
  const leave = (cr: Craft) => {
    // step out next to the left wing
    rightOf(cr.pl.q, _r);
    const off = cr.spec.span / 2 + 1.8;
    io.fly = null;
    cr.state = "idle";
    cr.c.thr = 0; cr.c.brake = true; cr.c.elev = cr.c.ail = cr.c.rud = cr.c.steer = 0;
    onFoot(cr.pl.p.x - _r.x * off, cr.pl.p.z - _r.z * off);
  };
  const eject = (cr: Craft) => {
    io.fly = null;
    cr.state = cr.pl.onGround ? "idle" : "pilotless";
    cr.c.thr = 0; cr.c.elev = cr.c.ail = cr.c.rud = cr.c.steer = 0; cr.c.brake = cr.pl.onGround;
    cr.c.fwd = cr.c.side = cr.c.yaw = 0; cr.c.coll = -0.5; // a hovering gunship settles down on its own
    upOf(cr.pl.q, _u);
    io.chute = true;
    io.chP.copy(cr.pl.p).addScaledVector(_u, 3);
    io.chV.copy(cr.pl.v).multiplyScalar(0.35).addScaledVector(_u, 9);
    W.chute.visible = true;
    planeHud.active = false;
    planeHud.chute = true;
    say("Bailed out: WASD to steer the parachute");
    sfx.boom(0.4);
  };
  function say(m: string, t = 4) { planeHud.msg = m; planeHud.msgT = t; }
  const toggleHover = (cr: Craft) => {
    const c = cr.c;
    if (c.nac > 0.5) {
      c.nac = 0;
      c.thr = Math.max(c.thr, 0.85);
      fwdOf(cr.pl.q, _f);
      io.aimYaw = Math.atan2(_f.x, _f.z);
      io.aimPitch = 0.03;
      say(cr.pl.onGround ? "Forward flight: take off down the runway" : "Converting to forward flight: the fans hand over as speed builds", 2.5);
    } else {
      c.nac = 1;
      say("Hover mode: Space / Shift climb / descend, W/S tilt, A/D strafe", 2.5);
    }
  };
  const resetCraft = (cr: Craft) => {
    const pl = makePlane(cr.home.x, heightAt(cr.home.x, cr.home.z) + cr.spec.gearH, cr.home.z, cr.home.h);
    cr.pl = pl;
    cr.state = "idle";
    cr.c = makeCtl(); cr.c.brake = true;
    pl.nac = cr.c.nac = cr.spec.vtol ? 1 : 0;
    cr.g.visible = true; cr.wreck.visible = false;
    cr.ammo = AMMO; cr.rockets = ROCKETS; cr.heat = 0; cr.overheat = false; cr.strayT = 0;
  };
  const crash = (cr: Craft, why: string) => {
    const p = cr.pl.p;
    explode(p.x, p.y, p.z, 16, 0, 2.5);
    for (let i = 0; i < 30; i++) W.puffs.add(p.x, p.y + 1, p.z, (Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14, 2, 7, 3 + Math.random() * 3, 0.12);
    const flown = cr.state === "flown";
    cr.state = "wreck";
    cr.wreckT = WRECK_T;
    cr.g.visible = false;
    const gy = heightAt(p.x, p.z);
    cr.wreck.position.set(p.x, gy, p.z);
    cr.wreck.rotation.y = cr.pl.heading;
    cr.wreck.visible = waterDepth(p.x, p.z) < 0.5;
    if (flown) {
      io.fly = null;
      // thrown clear: nearest dry, open spot ~20 m from the wreck
      let sx = cr.home.x, sz = cr.home.z;
      for (let i = 0; i < 60; i++) {
        const a = i * 2.4, rr = 16 + i * 2;
        const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
        if (Math.abs(x) > PLAY_LIMIT || Math.abs(z) > PLAY_LIMIT || waterDepth(x, z) > 0.2) continue;
        _bp.x = x; _bp.z = z;
        if (pushOut(_bp, 1.5)) continue;
        sx = x; sz = z;
        break;
      }
      onFoot(sx, sz);
      hurtPlayer(30);
      say(`CRASHED: ${why}. You were thrown clear.`, 5);
    }
  };

  // ------------------------------------------------ weapons
  const explode = (x: number, y: number, z: number, r: number, dmg: number, boom: number) => {
    _o.set(x, y, z);
    W.blasts.add(_o, r, ORANGE, 0.6);
    W.sparks.burst(_o, ORANGE, 40, r * 3, 0.4);
    for (let i = 0; i < 8; i++) W.puffs.add(x, y, z, (Math.random() - 0.5) * r, Math.random() * r * 0.5, (Math.random() - 0.5) * r, r * 0.25, r * 0.7, 2 + Math.random() * 1.5, 0.22);
    sfx.boom(boom);
    if (dmg <= 0) return;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.x - x, dy = e.y + e.h * 0.5 - y, dz = e.z - z;
      const d = Math.hypot(dx, dy, dz) - e.r;
      if (d < SPLASH) damageEnemy(e, dmg * (1 - Math.max(0, d) / SPLASH), false, dx, dz, 10);
    }
    dragonsNear(x, y, z, SPLASH, (tg, k) => damageDragon(tg, dmg * k));
  };
  /** first hit along a segment: terrain/colliders, creatures, dragons. Returns t (Infinity = none) + what. */
  const hit = { t: Infinity, kind: 0, e: null as (typeof enemies)[number] | null, head: false, tg: null as (typeof dragonTargets)[string] | null };
  const segHit = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, L: number, pad: number) => {
    hit.t = Infinity; hit.kind = 0; hit.e = null; hit.tg = null;
    _o.set(ox, oy, oz); _d.set(dx, dy, dz);
    const tt = terrainRay(_o, _d, L);
    if (tt < L) { hit.t = tt; hit.kind = 1; }
    const mx = ox + dx * L * 0.5, my = oy + dy * L * 0.5, mz = oz + dz * L * 0.5;
    for (const e of enemies) {
      if (!e.alive) continue;
      const reach = L * 0.5 + e.r + (e.len ?? 0) + e.h + pad;
      if (Math.abs(e.x - mx) > reach || Math.abs(e.z - mz) > reach || Math.abs(e.y - my) > reach) continue;
      const rh = rayEnemy(e, ox, oy, oz, dx, dy, dz, pad);
      if (rh && rh[0] < hit.t && rh[0] <= L) { hit.t = rh[0]; hit.kind = 2; hit.e = e; hit.head = rh[1]; }
    }
    const rd = rayDragon(ox, oy, oz, dx, dy, dz, Math.min(L, hit.t), pad * 0.5);
    if (rd) { hit.t = rd[0]; hit.kind = 3; hit.tg = rd[1]; hit.e = null; }
    return hit;
  };
  const fireGun = (cr: Craft) => {
    const pl = cr.pl, B = W.b, rig = cr.rig;
    if (cr.spec.vtol) {
      // chin turret: fires along the aim (mouse) from the ball, converging on the aim point
      if (rig.turret) bodyPt(pl, -rig.turret.position.x, rig.turret.position.y, rig.turret.position.z, _o);
      else { const [mx, my, mz] = (cr.cfg.muzzles ?? MUZZLES)[0]; bodyPt(pl, mx, my, mz, _o); }
      _o.addScaledVector(_aim, 1.4);
      _w.copy(pl.p).addScaledVector(_aim, AIM_DIST);
      cr.side++;
    } else {
      const mz = rig.guns ?? cr.cfg.muzzles ?? MUZZLES;
      const [mx, my, mzz] = mz[cr.side++ % mz.length];
      bodyPt(pl, mx, my, mzz, _o);
      bodyPt(pl, 0, 0, CONVERGE, _w); // both guns converge on a point dead ahead
    }
    // aim assist: a locked target near the gun line pulls the stream onto its lead point
    if (io.lock) {
      fwdOf(pl.q, _f);
      _d.copy(io.lead).sub(pl.p).normalize();
      if (cr.spec.vtol || Math.acos(THREE.MathUtils.clamp(_d.dot(_f), -1, 1)) < GIMBAL) _w.copy(io.lead);
    }
    _d.copy(_w).sub(_o).normalize();
    _d.x += (Math.random() - 0.5) * 0.006; _d.y += (Math.random() - 0.5) * 0.006; _d.z += (Math.random() - 0.5) * 0.006;
    _d.normalize();
    const k = B.head++ % BCAP;
    B.x[k] = _o.x; B.y[k] = _o.y; B.z[k] = _o.z;
    B.vx[k] = _d.x * MUZZLE_V + pl.v.x; B.vy[k] = _d.y * MUZZLE_V + pl.v.y; B.vz[k] = _d.z * MUZZLE_V + pl.v.z;
    B.life[k] = 1.6;
    W.sparks.burst(_o, SPARK, 2, 6, 0.12, _d, 0.4);
    W.audio.burst(0.09, 900 + Math.random() * 300, 0.05);
    cr.ammo--;
    cr.heat = Math.min(1, cr.heat + HEAT_SHOT);
    if (cr.heat >= 1) { cr.overheat = true; say("GUNS OVERHEATED", 2); }
    io.shake = Math.max(io.shake, 0.018); // light rumble, not a jitter
  };
  const fireRocket = (cr: Craft) => {
    const pl = cr.pl, R = W.r;
    const py0 = cr.cfg.pylons ?? PYLONS;
    const [px, py, pz] = py0[cr.rockets % py0.length];
    bodyPt(pl, px, py, pz, _o);
    fwdOf(pl.q, _f);
    const k = R.head++ % RCAP;
    R.x[k] = _o.x; R.y[k] = _o.y; R.z[k] = _o.z;
    R.vx[k] = pl.v.x + _f.x * 30; R.vy[k] = pl.v.y + _f.y * 30; R.vz[k] = pl.v.z + _f.z * 30;
    R.life[k] = 6; R.boost[k] = 1.4; R.smoke[k] = 0;
    io.rTgt[k] = io.lock; // locked: the rocket homes on it
    cr.rockets--;
    cr.rocketT = ROCKET_RELOAD;
    W.audio.burst(0.25, 300, 0.35);
  };
  const updateProjectiles = (dt: number) => {
    const B = W.b, R = W.r, S = W.streaks;
    S.begin();
    for (let k = 0; k < BCAP; k++) {
      if (B.life[k] <= 0) continue;
      B.life[k] -= dt;
      B.vy[k] -= G * dt;
      const ox = B.x[k], oy = B.y[k], oz = B.z[k];
      const vx = B.vx[k], vy = B.vy[k], vz = B.vz[k];
      const sp = Math.hypot(vx, vy, vz);
      const L = sp * dt;
      const dx = vx / sp, dy = vy / sp, dz = vz / sp;
      const h = segHit(ox, oy, oz, dx, dy, dz, L, 0.9);
      if (h.kind) {
        _o.set(ox + dx * h.t, oy + dy * h.t, oz + dz * h.t);
        if (h.kind === 2 && h.e) { damageEnemy(h.e, GUN_DMG * (h.head ? 1.6 : 1), h.head, dx, dz, 2); W.sparks.burst(_o, BLOOD, 6, 8, 0.2); }
        else if (h.kind === 3 && h.tg) { damageDragon(h.tg, GUN_DMG); W.sparks.burst(_o, SPARK, 6, 10, 0.25); }
        else { W.sparks.burst(_o, SPARK, 4, 7, 0.15); if (Math.random() < 0.3) W.puffs.add(_o.x, _o.y, _o.z, 0, 1, 0, 0.3, 1.2, 0.8, 0.55); }
        B.life[k] = 0;
        continue;
      }
      B.x[k] = ox + vx * dt; B.y[k] = oy + vy * dt; B.z[k] = oz + vz * dt;
      _o.set(B.x[k], B.y[k], B.z[k]);
      _w.set(B.x[k] - dx * Math.min(16, L + 4), B.y[k] - dy * Math.min(16, L + 4), B.z[k] - dz * Math.min(16, L + 4));
      S.add(_w, _o, 0.14, TRACER, 3.2);
    }
    for (let k = 0; k < RCAP; k++) {
      if (R.life[k] <= 0) continue;
      R.life[k] -= dt;
      let vx = R.vx[k], vy = R.vy[k], vz = R.vz[k];
      let sp = Math.hypot(vx, vy, vz);
      if (R.boost[k] > 0) {
        R.boost[k] -= dt;
        const a = 240 * dt;
        vx += (vx / sp) * a; vy += (vy / sp) * a; vz += (vz / sp) * a;
      }
      vy -= 2.5 * dt;
      // homing: turn the velocity toward the locked target (limited rate, after a short straight launch)
      const rt = io.rTgt[k];
      if (rt && lockAlive(rt) && R.life[k] < 5.85) {
        sp = Math.hypot(vx, vy, vz);
        lockPoint(rt, _lp);
        const tx = _lp.x - R.x[k], ty = _lp.y - R.y[k], tz = _lp.z - R.z[k], tl = Math.hypot(tx, ty, tz) || 1;
        const turn = Math.min(1, 3.2 * dt);
        vx += ((tx / tl) * sp - vx) * turn; vy += ((ty / tl) * sp - vy) * turn; vz += ((tz / tl) * sp - vz) * turn;
      }
      R.vx[k] = vx; R.vy[k] = vy; R.vz[k] = vz;
      sp = Math.hypot(vx, vy, vz);
      const ox = R.x[k], oy = R.y[k], oz = R.z[k];
      const L = sp * dt, dx = vx / sp, dy = vy / sp, dz = vz / sp;
      const h = segHit(ox, oy, oz, dx, dy, dz, L, 3.5); // fat pad = proximity fuse
      // smoke trail: a puff every ~5 m
      R.smoke[k] += L;
      while (R.smoke[k] > 5) {
        R.smoke[k] -= 5;
        const back = R.smoke[k];
        W.puffs.add(ox + dx * (L - back), oy + dy * (L - back), oz + dz * (L - back), 0, 0.5, 0, 0.4, 2.2, 2.4, 0.78);
      }
      if (h.kind || R.life[k] <= 0) {
        const t = h.kind ? h.t : L;
        R.life[k] = 0;
        explode(ox + dx * t, oy + dy * t, oz + dz * t, SPLASH, ROCKET_DMG, 1.2);
        continue;
      }
      R.x[k] = ox + vx * dt; R.y[k] = oy + vy * dt; R.z[k] = oz + vz * dt;
      _o.set(R.x[k], R.y[k], R.z[k]);
      _w.set(R.x[k] - dx * 3, R.y[k] - dy * 3, R.z[k] - dz * 3);
      S.add(_w, _o, 0.35, ORANGE, 4);
    }
    S.end();
  };

  // ------------------------------------------------ setup: input, GLBs, registry
  useEffect(() => {
    let dead = false;
    for (const cr of W.crafts) {
      planeMarks[cr.id] = { label: cr.cfg.label, color: cr.cfg.accent, x: cr.pl.p.x, z: cr.pl.p.z, heading: cr.pl.heading, flying: false, wreck: false, mine: false };
      const glb = cr.cfg.glb;
      if (glb) loadKit(glb.url, { len: glb.len, yaw: glb.yaw }).then((kit) => {
        if (dead) return;
        const rig = rigGlb(kit.template.clone(true), glb, cr.spec.gearH);
        cr.g.remove(cr.rig.root);
        cr.rig = rig;
        cr.g.add(rig.root);
      }).catch((err) => console.warn(`plane model ${glb.url} failed, keeping the placeholder`, err));
    }
    const down = (e: KeyboardEvent) => {
      io.keys[e.code] = true;
      if (e.repeat) return;
      const phase = useGame.getState().phase;
      if (phase !== "playing") return;
      if (ride.plane && io.fly) {
        if (e.code === "KeyV") io.view = io.view === "chase" ? "cockpit" : "chase";
        if (e.code === "KeyH" && io.fly.spec.vtol) toggleHover(io.fly);
        if (e.code === "KeyL") io.rocketReq++;
        if (e.code === "Space") e.preventDefault();
      }
      if (e.code !== "KeyF") return;
      const cr = io.fly;
      if (cr) {
        const now = performance.now();
        if (cr.pl.onGround && cr.pl.V < 3) { leave(cr); return; }
        if (now - io.lastF < 650) { eject(cr); io.lastF = 0; return; }
        io.lastF = now;
        planeHud.ejectArm = 0.65;
        say(cr.pl.onGround ? "Too fast to get out: brake (Space). Double-tap F to bail out." : "Double-tap F to bail out", 1.5);
        return;
      }
      if (ride.on) return; // in a car / under the chute
      let best: Craft | null = null, bd = ENTER_R;
      for (const c of W.crafts) {
        if (c.state === "wreck") continue;
        const d = Math.hypot(c.pl.p.x - pose.x, c.pl.p.z - pose.z) - enterPad(c);
        if (d < bd && Math.abs(c.pl.p.y - pose.y) < 6) { bd = d; best = c; }
      }
      if (best) enter(best);
    };
    const up = (e: KeyboardEvent) => { io.keys[e.code] = false; };
    const move = (e: MouseEvent) => {
      if (!ride.plane || document.pointerLockElement !== gl.domElement || useGame.getState().phase !== "playing") return;
      if (io.keys.KeyC) {
        io.lookYaw = THREE.MathUtils.clamp(io.lookYaw - e.movementX * 0.003, -2.6, 2.6);
        io.lookPitch = THREE.MathUtils.clamp(io.lookPitch - e.movementY * 0.003, -1.2, 1.2);
      } else {
        io.aimYaw -= e.movementX * 0.0022;
        io.aimPitch = THREE.MathUtils.clamp(io.aimPitch - e.movementY * 0.0022, -1.45, 1.45);
        if (Math.abs(e.movementY) > 2) io.mouseT = 0;
      }
    };
    const md = (e: MouseEvent) => {
      if (!io.fly || document.pointerLockElement !== gl.domElement) return;
      if (e.button === 0) io.fire = true;
      if (e.button === 2) io.rocketReq++;
    };
    const mu = (e: MouseEvent) => { if (e.button === 0) io.fire = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    document.addEventListener("mousemove", move);
    window.addEventListener("mousedown", md);
    window.addEventListener("mouseup", mu);
    const dbgRoot = (window as unknown as { __dbg?: Record<string, unknown> }).__dbg ??= {};
    dbgRoot.planes = {
      crafts: W.crafts, hud: planeHud, marks: planeMarks, io, dragons: dragonTargets, enemies,
      input: io.dbg,
      enter: (id: string) => { const c = W.crafts.find((k) => k.id === id); if (c && c.state !== "wreck") { ctl.teleport = null; enter(c); } return !!c; },
      leave: () => { if (io.fly) leave(io.fly); },
      eject: () => { if (io.fly) eject(io.fly); },
      reset: (id: string) => { const c = W.crafts.find((k) => k.id === id); if (c && c !== io.fly) resetCraft(c); },
      state: () => W.crafts.map((c) => ({
        id: c.id, state: c.state, x: +c.pl.p.x.toFixed(1), y: +c.pl.p.y.toFixed(1), z: +c.pl.p.z.toFixed(1), kmh: Math.round(c.pl.V * 3.6),
        agl: +c.pl.agl.toFixed(1), vs: +c.pl.vs.toFixed(1), onGround: c.pl.onGround, stall: +c.pl.stall.toFixed(2), aoa: +c.pl.alpha.toFixed(3),
        thr: +c.pl.thr.toFixed(2), bank: Math.round(bankOf(c.pl.q) * 57.3), heading: Math.round(((Math.atan2(fwdOf(c.pl.q, _f).x, _f.z) * 57.3) + 360) % 360),
        ammo: c.ammo, rockets: c.rockets, heat: +c.heat.toFixed(2),
      })),
    };
    return () => {
      dead = true;
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("mousemove", move);
      window.removeEventListener("mousedown", md);
      window.removeEventListener("mouseup", mu);
      for (const cr of W.crafts) { delete planeMarks[cr.id]; setBody(`plane-${cr.id}`, 0, 0, 0, 0, 0, false); }
      if (ride.plane) { ride.plane = false; ride.on = false; useRide.getState().set({ plane: false }); }
      io.fly = null;
      planeHud.active = planeHud.chute = false;
      planeHud.prompt = null;
      W.audio.engine(false, 0, 0);
      delete dbgRoot.planes;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W, io, gl]);

  // ------------------------------------------------ frame
  useFrame((_, rawDt) => {
    const frameDt = Math.min(rawDt, 0.25);
    const phase = useGame.getState().phase;
    const frozen = phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map";
    const H = planeHud;
    if (frozen) {
      W.audio.engine(false, 0, 0);
      // the menu never runs the sim, so park the models on their strips (not at the origin)
      for (const cr of W.crafts) if (cr.g.position.lengthSq() === 0) { cr.g.position.copy(cr.pl.p); cr.g.quaternion.copy(cr.pl.q); }
      return;
    }
    const playing = phase === "playing";
    const fly = io.fly;
    if (!fly) io.lock = null;

    // fast travel / respawn while flying: abandon the plane (it goes home) and let Player take the teleport
    if (ride.plane && ctl.teleport) {
      const t = ctl.teleport;
      if (fly) resetCraft(fly);
      io.fly = null;
      onFoot(t.x, t.z);
      return;
    }

    // ---- input -> controls (keyboard overrides on top of the mouse-aim instructor)
    const K = io.keys, DK = io.dbg.keys;
    const key = (c: string) => playing && (!!K[c] || !!DK[c]);
    if (io.dbg.aimYaw !== null) { io.aimYaw = io.dbg.aimYaw; io.dbg.aimYaw = null; }
    if (io.dbg.aimPitch !== null) { io.aimPitch = io.dbg.aimPitch; io.dbg.aimPitch = null; }
    if (fly) {
      const c = fly.c;
      const thrIn = (key("KeyW") ? 1 : 0) - (key("KeyS") ? 1 : 0);
      const hov = !!fly.spec.vtol && c.nac > 0.5;
      if (!hov) c.thr = THREE.MathUtils.clamp(c.thr + thrIn * 1.1 * frameDt, 0, 1);
      c.brake = key("Space") || (!hov && fly.pl.onGround && key("KeyS") && c.thr < 0.05);
      io.mouseT += frameDt;
      const fp = fly.pl;
      if (!hov) {
        // A/D: turn. In the air the aim swings and the instructor banks into the turn on its own.
        const turn = fp.onGround ? 0 : (key("KeyA") ? 1 : 0) - (key("KeyD") ? 1 : 0);
        io.turn += (turn - io.turn) * Math.min(1, frameDt * (turn ? 3 : 5)); // ramp in / out: no snap into the bank
        if (Math.abs(io.turn) > 0.002) io.aimYaw += io.turn * TURN_RATE * frameDt;
        // W: go forward AND up on its own - rotate at take-off speed, climb out, then settle into a gentle climb
        if (key("KeyW")) {
          if (fp.onGround) { if (fp.V > fly.spec.vRot * 0.95) io.aimPitch = raise(io.aimPitch, 0.24, 0.5 * frameDt); }
          else if (fp.agl < 60) io.aimPitch = raise(io.aimPitch, 0.2, 0.4 * frameDt);
          else if (io.mouseT > 1.2) io.aimPitch += ((fp.agl < 400 ? 0.12 : 0.02) - io.aimPitch) * Math.min(1, frameDt * 0.8);
        }
        // terrain safety net: about to fly into the ground -> lift the aim
        if (!fp.onGround && fp.vs < -2 && fp.agl / -fp.vs < 3.5) io.aimPitch = raise(io.aimPitch, 0.18, 1.2 * frameDt);
      }
      // ---- aim assist: lock the target nearest the aim, lead it, gently pull the aim onto it
      dirOf(io.aimYaw, io.aimPitch, _aim);
      const prev = io.lock;
      io.lock = findLock(fp.p, _aim, prev);
      if (io.lock) {
        lockPoint(io.lock, _o);
        if (!sameLock(prev, io.lock)) { io.lockV.set(0, 0, 0); io.lockT = 0; }
        else if (frameDt > 0) { _d.copy(_o).sub(io.lockP).divideScalar(frameDt); if (_d.lengthSq() < 200 * 200) io.lockV.lerp(_d, Math.min(1, frameDt * 4)); }
        io.lockP.copy(_o);
        io.lockT += frameDt;
        // lead: where to point so a round (muzzle speed + our own velocity, gravity drop) meets it
        _d.copy(io.lockV).sub(fp.v);
        let t = _o.distanceTo(fp.p) / MUZZLE_V;
        for (let i = 0; i < 3; i++) {
          io.lead.copy(_o).addScaledVector(_d, t);
          io.lead.y += 0.5 * G * t * t;
          t = io.lead.distanceTo(fp.p) / MUZZLE_V;
        }
        // magnetism: stronger while shooting, never yanks (small rate, only inside the keep cone)
        const firing = io.fire || io.dbg.fire || key("KeyK");
        const k = Math.min(1, frameDt * (firing ? 2.6 : 1.1));
        _w.copy(io.lead).sub(fp.p);
        const wy = Math.atan2(_w.x, _w.z), wp = Math.atan2(_w.y, Math.hypot(_w.x, _w.z));
        if (!hov || fly.spec.vtol) { io.aimYaw += wrapA(wy - io.aimYaw) * k; io.aimPitch += (wp - io.aimPitch) * k; }
      }
      // keep away from the world edge: bend the aim back toward the middle
      const p = fly.pl.p, edge = Math.max(Math.abs(p.x), Math.abs(p.z));
      H.warn = "";
      if (edge > PLAY_LIMIT - 220 && !fly.pl.onGround) {
        const want = Math.atan2(-p.x, -p.z);
        io.aimYaw += THREE.MathUtils.clamp(wrapA(want - io.aimYaw), -1.2 * frameDt, 1.2 * frameDt);
        io.aimPitch = Math.max(io.aimPitch, fly.pl.agl < 150 ? 0.15 : 0.04); // turn back climbing (the rim is mountains)
        H.warn = "TURN BACK: edge of the world";
      }
    }

    // ---- physics, fixed substeps
    const steps = Math.max(1, Math.ceil(frameDt / (1 / STEPS_HZ)));
    const dt = frameDt / steps;
    dirOf(io.aimYaw, io.aimPitch, _aim);
    for (const cr of W.crafts) {
      if (cr.state === "wreck") {
        cr.wreckT -= frameDt;
        if (Math.random() < frameDt * 6) W.puffs.add(cr.wreck.position.x + (Math.random() - 0.5) * 4, cr.wreck.position.y + 1, cr.wreck.position.z + (Math.random() - 0.5) * 4, 0.5, 3, 0, 1.2, 5, 4, 0.1);
        if (cr.wreckT <= 0) resetCraft(cr);
        continue;
      }
      const pl = cr.pl;
      const flown = cr === fly;
      const hover = !!cr.spec.vtol && cr.c.nac > 0.5;
      blockSpan = cr.spec.span;
      // parked and still: nothing to simulate
      if (!flown && pl.onGround && pl.V < 0.05 && pl.thr < 0.01) {
        pl.v.set(0, 0, 0);
      } else {
        for (let i = 0; i < steps; i++) {
          if (flown && hover) {
            // hover: the fans' stability loop flies it; keys / mouse give translate, yaw and climb commands
            const c = cr.c;
            c.elev = c.ail = c.rud = c.steer = 0;
            c.fwd = (key("KeyW") ? 1 : 0) - (key("KeyS") ? 1 : 0);
            c.side = (key("KeyD") ? 1 : 0) - (key("KeyA") ? 1 : 0);
            const yk = (key("KeyE") ? 1 : 0) - (key("KeyQ") ? 1 : 0);
            fwdOf(pl.q, _f);
            c.yaw = yk || THREE.MathUtils.clamp(-wrapA(io.aimYaw - Math.atan2(_f.x, _f.z)) * 2, -1, 1);
            c.coll = (key("Space") ? 1 : 0) - (key("ShiftLeft") || key("ShiftRight") ? 1 : 0);
            c.brake = pl.onGround && !c.fwd && !c.side;
          } else if (flown) {
            const c = cr.c;
            c.fwd = c.side = c.yaw = c.coll = 0;
            instructor(pl, _aim, c, cr.spec);
            const roll = (key("KeyD") ? 1 : 0) - (key("KeyA") ? 1 : 0);
            const pitch = (key("ArrowDown") ? 1 : 0) - (key("ArrowUp") ? 1 : 0);
            const yaw = (key("KeyE") ? 1 : 0) - (key("KeyQ") ? 1 : 0);
            if (roll && pl.onGround) c.steer = roll; // in the air A/D turn the aim (see input), the instructor banks
            if (pitch) c.elev = pitch;
            if (yaw) { c.rud = yaw; if (pl.onGround) c.steer = yaw; }
          } else if (cr.state === "pilotless") {
            // nobody at the stick: wings level-ish, idle, let it glide down
            cr.c.ail = THREE.MathUtils.clamp(-bankOf(pl.q) * 1.5, -1, 1);
            cr.c.elev = 0; cr.c.rud = 0;
          }
          const ev = step(pl, cr.c, env, cr.spec, dt);
          if (!ev) continue;
          if (ev.kind === "crash") { crash(cr, ev.why); break; }
          if (ev.kind === "land") {
            if (cr.state === "pilotless") { cr.state = "idle"; cr.c.brake = true; cr.c.coll = 0; }
            if (flown) say(`Touchdown · ${ev.sink.toFixed(1)} m/s sink`, 2);
          }
        }
        if ((cr.state as Craft["state"]) === "wreck") continue;
      }
      // keyboard overrides: the aim point follows the nose so letting go doesn't snap back
      if (flown && !hover && ((pl.onGround && (key("KeyA") || key("KeyD"))) || key("ArrowUp") || key("ArrowDown") || key("KeyQ") || key("KeyE"))) {
        fwdOf(pl.q, _f);
        io.aimYaw = Math.atan2(_f.x, _f.z);
        io.aimPitch = Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1));
      }
      if (flown && !hover && pl.onGround && !key("KeyA") && !key("KeyD") && !key("KeyQ") && !key("KeyE")) {
        // on the runway the aim's yaw also drifts back to the nose (mouse steering is relative)
        fwdOf(pl.q, _f);
        io.aimYaw += wrapA(Math.atan2(_f.x, _f.z) - io.aimYaw) * Math.min(1, frameDt * 0.6);
      }
      // left somewhere far from home with nobody around: tow it back
      const away = Math.hypot(pl.p.x - cr.home.x, pl.p.z - cr.home.z) > 40;
      if (!flown && pl.onGround && pl.V < 0.5 && away && Math.hypot(pl.p.x - pose.x, pl.p.z - pose.z) > 300) {
        cr.strayT += frameDt;
        if (cr.strayT > 60) resetCraft(cr);
      } else cr.strayT = 0;

      // ---- guns / rockets
      if (cr.overheat && cr.heat < 0.35) cr.overheat = false;
      cr.heat = Math.max(0, cr.heat - HEAT_COOL * frameDt);
      cr.gunCd -= frameDt;
      if (cr.rockets < ROCKETS) { cr.rocketT -= frameDt; if (cr.rocketT <= 0) { cr.rockets++; cr.rocketT = ROCKET_RELOAD; } }
      if (pl.onGround && pl.V < 1) { cr.refillT += frameDt; if (cr.refillT > 3 && cr.ammo < AMMO) { cr.ammo = AMMO; if (flown) say("Rearmed", 1.5); } } else cr.refillT = 0;
      if (flown && playing) {
        const firing = io.fire || io.dbg.fire || key("KeyK");
        while (firing && cr.gunCd <= 0 && cr.ammo > 0 && !cr.overheat) { fireGun(cr); cr.gunCd += 1 / GUN_RATE; }
        if (cr.gunCd < 0) cr.gunCd = 0;
        if (io.dbg.rocket > 0) { io.rocketReq += io.dbg.rocket; io.dbg.rocket = 0; }
        while (io.rocketReq > 0) { io.rocketReq--; if (cr.rockets > 0) fireRocket(cr); }
      }

      // ---- visuals
      const g = cr.g;
      g.position.copy(pl.p);
      g.quaternion.copy(pl.q);
      if (pl.bump > 0.05) g.position.y -= pl.bump * 0.25;
      const rig = cr.rig;
      cr.propA += (pl.thr * 55 + 6 * (pl.thr > 0.01 || pl.V > 5 ? 1 : 0) + pl.V * 0.3) * frameDt;
      if (rig.prop) rig.prop.rotation[rig.propAxis] = rig.propBase + cr.propA;
      if (rig.blur) (rig.blur.material as THREE.MeshBasicMaterial).opacity = sm(0.15, 0.6, pl.thr) * 0.22;
      for (const s of rig.elev) s.o.rotation[s.axis] = s.base + s.k * pl.surf.elev;
      for (const s of rig.ail) s.o.rotation[s.axis] = s.base + s.k * pl.surf.ail;
      for (const s of rig.rud) s.o.rotation[s.axis] = s.base + s.k * pl.surf.rud;
      const live = flown || cr.state === "pilotless";
      const flick = 0.85 + Math.random() * 0.15;
      for (const m of rig.fanGlow) (m.material as THREE.MeshBasicMaterial).opacity = live ? pl.fan * 0.85 * flick : 0;
      for (const m of rig.engGlow) (m.material as THREE.MeshBasicMaterial).opacity = live ? (0.15 + pl.thr * 0.75) * (1 - 0.6 * pl.nac) * flick : 0;
      if (rig.turret) {
        // ball turret follows the aim (body frame), within its chin arc; parked it rests forward
        if (flown) { _q.copy(pl.q).invert(); _v.copy(_aim).applyQuaternion(_q); _v.z = Math.max(_v.z, 0.15); _v.y = Math.min(_v.y, 0.35); _v.normalize(); }
        else _v.set(0, 0, 1);
        _q.setFromUnitVectors(_zAxis, _v);
        rig.turret.quaternion.slerp(_q, Math.min(1, frameDt * 10));
      }
      // rotor downwash kicks up dust near the ground
      if (live && pl.fan > 0.15 && pl.agl < 28 && Math.random() < frameDt * 25 * pl.fan) {
        const a = Math.random() * Math.PI * 2, rr = 3 + Math.random() * cr.spec.span * 0.4, gx = pl.p.x + Math.cos(a) * rr, gz = pl.p.z + Math.sin(a) * rr;
        W.puffs.add(gx, heightAt(gx, gz) + 0.4, gz, Math.cos(a) * 12, 0.6, Math.sin(a) * 12, 0.6, 3.2, 1.6, 0.72);
      }
      const dCam = camera.position.distanceTo(pl.p);
      g.visible = dCam < 3500;
      setShadow(g, dCam < 160);
      // a parked plane is solid for cars / creatures / the player
      setBody(`plane-${cr.id}`, pl.p.x, pl.p.z, 3.2 * Math.max(1, cr.spec.span / 11), pl.p.y - cr.spec.gearH - 0.5, pl.p.y + 1.5 + cr.spec.gearH, !flown && pl.onGround);
      // engine smoke when damaged? (not modelled) - exhaust haze at full power
      if (!cr.spec.vtol && pl.thr > 0.85 && Math.random() < frameDt * 10) { bodyPt(pl, 0.6, -0.2, cr.spec.len * 0.3, _o); W.puffs.add(_o.x, _o.y, _o.z, pl.v.x * 0.2, 0.5, pl.v.z * 0.2, 0.15, 0.6, 0.7, 0.35); }
    }
    for (const cr of W.crafts) {
      const m = planeMarks[cr.id];
      if (!m) continue;
      const p = cr.state === "wreck" ? cr.wreck.position : cr.pl.p;
      m.x = p.x; m.z = p.z; m.heading = cr.pl.heading;
      if (!cr.pl.onGround) { fwdOf(cr.pl.q, _f); m.heading = Math.atan2(_f.x, _f.z); }
      m.flying = !cr.pl.onGround && cr.state !== "wreck";
      m.wreck = cr.state === "wreck";
      m.mine = cr === io.fly;
    }

    // ---- parachute
    if (io.chute) {
      const P = io.chP, V = io.chV;
      V.y -= G * frameDt;
      if (V.y < CHUTE_VY) V.y += (CHUTE_VY - V.y) * Math.min(1, frameDt * 2.5);
      const fx = (key("KeyW") ? 1 : 0) - (key("KeyS") ? 1 : 0), sx = (key("KeyD") ? 1 : 0) - (key("KeyA") ? 1 : 0);
      const cy = io.aimYaw;
      const wx = Math.sin(cy) * fx * 4 - Math.cos(cy) * sx * 4, wz = Math.cos(cy) * fx * 4 + Math.sin(cy) * sx * 4;
      V.x += (wx - V.x) * Math.min(1, frameDt * 0.8);
      V.z += (wz - V.z) * Math.min(1, frameDt * 0.8);
      P.addScaledVector(V, frameDt);
      P.x = THREE.MathUtils.clamp(P.x, -PLAY_LIMIT, PLAY_LIMIT); P.z = THREE.MathUtils.clamp(P.z, -PLAY_LIMIT, PLAY_LIMIT);
      W.chute.position.copy(P);
      W.chute.rotation.set(Math.sin(performance.now() * 0.0012) * 0.06, cy, Math.sin(performance.now() * 0.0009) * 0.06);
      const gy = Math.max(heightAt(P.x, P.z), waterDepth(P.x, P.z) > 0 ? 0 : -1e9);
      if (P.y <= gy + 0.05) { onFoot(P.x, P.z); say("Landed", 1.5); }
    }

    // ---- projectiles + fx
    updateProjectiles(frameDt);
    W.sparks.update(frameDt);
    W.blasts.update(frameDt);
    W.puffs.update(frameDt);

    // ---- on-foot prompt
    if (!ride.on && playing) {
      let near: Craft | null = null;
      for (const c of W.crafts) if (c.state !== "wreck" && Math.hypot(c.pl.p.x - pose.x, c.pl.p.z - pose.z) - enterPad(c) < ENTER_R && Math.abs(c.pl.p.y - pose.y) < 6) near = c;
      H.prompt = near ? `F · fly the ${near.cfg.label} ${near.spec.vtol ? "gunship" : "plane"}` : null;
    } else H.prompt = null;
    H.msgT = Math.max(0, H.msgT - frameDt);
    H.ejectArm = Math.max(0, H.ejectArm - frameDt);

    // ---- camera + HUD
    const cam = camera as THREE.PerspectiveCamera;
    const cur = io.fly;
    if (!io.keys.KeyC) { io.lookYaw *= Math.exp(-6 * frameDt); io.lookPitch *= Math.exp(-6 * frameDt); }
    if (cur) {
      const pl = cur.pl;
      fwdOf(pl.q, _f);
      dirOf(io.aimYaw + io.lookYaw, THREE.MathUtils.clamp(io.aimPitch + io.lookPitch, -1.4, 1.4), _cam);
      // the camera trails the aim (critically damped-ish) so aim jumps / magnetism never jerk the view
      io.camDir.lerp(_cam, 1 - Math.exp(-(io.keys.KeyC ? 14 : 6) * frameDt)).normalize();
      _cam.copy(io.camDir);
      // lean a little with the plane's bank (30%), like a chase cam on a boom
      upOf(pl.q, _u);
      _v.set(0, 1, 0).lerp(_u, 0.3).normalize();
      io.camUp.lerp(_v, 1 - Math.exp(-4 * frameDt)).normalize();
      io.shake = Math.max(io.shake * Math.exp(-10 * frameDt), pl.stall * 0.12 * Math.min(1, pl.V / 30), pl.bump * 0.3);
      let fov = 62 + THREE.MathUtils.clamp((pl.V - 25) * 0.22, 0, 20);
      const big = Math.max(1, cur.spec.len / 12);
      if (io.view === "chase") {
        const dist = (13 + pl.V * 0.035) * big;
        _v.set(-_cam.x * dist, -_cam.y * dist + 3.2 * big, -_cam.z * dist);
        io.camOff.lerp(_v, 1 - Math.exp(-7 * frameDt));
        cam.position.copy(pl.p).add(io.camOff);
        const gy = heightAt(cam.position.x, cam.position.z) + 1.2;
        if (cam.position.y < gy) cam.position.y = gy;
        _w.copy(pl.p).addScaledVector(_cam, 60);
        _w.y += 1.5 * big;
        cam.up.copy(io.camUp);
        cam.lookAt(_w);
        cam.up.set(0, 1, 0);
      } else {
        const [ckx, cky, ckz] = cur.cfg.cockpit ?? [0, 0.95, 0.75];
        bodyPt(pl, ckx, cky, ckz, _o);
        cam.position.copy(_o);
        _q.copy(pl.q).multiply(_qFlip);
        _e.set(io.lookPitch, io.lookYaw, 0, "YXZ");
        cam.quaternion.copy(_q).multiply(new THREE.Quaternion().setFromEuler(_e));
        fov += 8;
      }
      if (io.shake > 0.002) { cam.position.x += (Math.random() - 0.5) * io.shake; cam.position.y += (Math.random() - 0.5) * io.shake; }
      if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, frameDt * 3); cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
      ride.x = pl.p.x; ride.y = pl.p.y - cur.spec.gearH; ride.z = pl.p.z;
      ride.camYaw = Math.atan2(-_cam.x, -_cam.z);
      ride.camPitch = Math.asin(THREE.MathUtils.clamp(_cam.y, -1, 1));
      // HUD numbers
      H.kmh = pl.V * 3.6; H.ias = H.kmh * Math.sqrt(pl.rho);
      H.alt = pl.p.y - cur.spec.gearH; H.agl = pl.agl; H.vs = pl.vs; H.thr = cur.c.thr; H.gs = pl.gs;
      H.aoa = pl.alpha; H.stall = pl.stall; H.rho = pl.rho; H.onGround = pl.onGround; H.brake = cur.c.brake;
      H.heading = ((Math.atan2(_f.x, _f.z) * 180) / Math.PI + 360) % 360;
      H.pitch = Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1)); H.bank = bankOf(pl.q);
      H.view = io.view; H.freeLook = !!io.keys.KeyC;
      H.vtol = !!cur.spec.vtol; H.hover = cur.c.nac > 0.5; H.nac = pl.nac; H.fan = pl.fan;
      H.heat = cur.heat; H.overheat = cur.overheat; H.ammo = cur.ammo; H.ammoMax = AMMO; H.rockets = cur.rockets; H.rocketsMax = ROCKETS;
      H.rocketReload = cur.rockets < ROCKETS ? 1 - cur.rocketT / ROCKET_RELOAD : 1;
      _v.copy(pl.p).addScaledVector(_aim, AIM_DIST).project(cam);
      H.aimX = _v.x; H.aimY = _v.y; H.aimOn = _v.z < 1;
      if (cur.spec.vtol) _v.copy(pl.p).addScaledVector(_aim, AIM_DIST); // turret gun: the reticle is the aim point
      else bodyPt(pl, 0, 0, CONVERGE, _v);
      _v.project(cam);
      H.noseX = _v.x; H.noseY = _v.y; H.noseOn = _v.z < 1;
      H.lockOn = false; H.leadOn = false;
      if (io.lock) {
        const r = lockPoint(io.lock, _v);
        const dist = _v.distanceTo(pl.p);
        _v.project(cam);
        H.lockOn = _v.z < 1; H.lockX = _v.x; H.lockY = _v.y;
        H.lockR = Math.max(0.025, Math.min(0.25, r / Math.max(1, dist) * 1.6));
        H.lockDist = dist;
        H.lockLabel = io.lock.e ? "PTERO" : io.lock.tg!.label.toUpperCase();
        H.lockHp = io.lock.e ? Math.max(0, io.lock.e.hp / io.lock.e.maxHp) : io.lock.tg!.hp / io.lock.tg!.maxHp;
        H.lockT = io.lockT;
        _v.copy(io.lead).project(cam);
        H.leadOn = _v.z < 1; H.leadX = _v.x; H.leadY = _v.y;
      }
      if (!H.warn) {
        const tti = pl.vs < -2 ? pl.agl / -pl.vs : 99;
        if (pl.stall > 0.15) H.warn = "STALL: push the nose down";
        else if (!pl.onGround && tti < 4 && pl.agl < 120) H.warn = "PULL UP";
        else if (pl.rho < 0.55) H.warn = "THIN AIR: ceiling";
        else if (!pl.onGround && pl.nac < 0.3 && pl.V < cur.spec.vRot * 1.05) H.warn = cur.spec.vtol ? "LOW SPEED: H for hover" : "LOW SPEED";
      }
      W.audio.engine(true, pl.thr, pl.V);
    } else if (io.chute) {
      const P = io.chP;
      dirOf(io.aimYaw + io.lookYaw, THREE.MathUtils.clamp(io.aimPitch + io.lookPitch - 0.25, -1.3, 1.3), _cam);
      _v.set(P.x - _cam.x * 11, P.y - _cam.y * 11 + 4, P.z - _cam.z * 11);
      cam.position.lerp(_v, 1 - Math.exp(-6 * frameDt));
      const gy = heightAt(cam.position.x, cam.position.z) + 1;
      if (cam.position.y < gy) cam.position.y = gy;
      cam.lookAt(P.x, P.y + 3, P.z);
      ride.x = P.x; ride.y = P.y; ride.z = P.z;
      ride.camYaw = Math.atan2(-_cam.x, -_cam.z);
      ride.camPitch = 0;
      H.alt = P.y; H.agl = P.y - heightAt(P.x, P.z); H.vs = io.chV.y;
      // the abandoned plane keeps humming as it glides away
      W.audio.engine(false, 0, 0);
    }
  }, -5);

  return (
    <group>
      {W.crafts.map((c) => <primitive key={c.id} object={c.g} />)}
      {W.crafts.map((c) => <primitive key={`w${c.id}`} object={c.wreck} />)}
      <primitive object={W.chute} />
      <primitive object={W.streaks.mesh} />
      <primitive object={W.sparks.mesh} />
      <primitive object={W.blasts.mesh} />
      <primitive object={W.puffs.mesh} />
    </group>
  );
}
export type { World };
