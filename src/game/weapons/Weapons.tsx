"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { heightAt } from "@/game/terrain";
import { rayColliders } from "@/game/world/colliders";
import { ctl, pose, ride, useGame } from "@/game/store";
import { GUN_BY_ID, START_GUN, type GunDef } from "./arsenal";
import { cloneGun, hologramUniforms, preloadAll } from "./library";
import { blastLoose, kickLoose, looseRay } from "@/game/loose";
import { damageEnemy, enemies, friendly, makeNoise, mags, rayEnemy, useHud, type Enemy } from "./combat";
import { Blasts, Sparks, Streaks } from "./fx";
import { sfx } from "./audio";

// First-person viewmodel + every weapon behaviour. One component, no per-shot allocations in the hot loop
// beyond the small pools below.

type Proj = {
  alive: boolean; lob: boolean; mini: boolean;
  p: THREE.Vector3; v: THREE.Vector3; prev: THREE.Vector3;
  def: GunDef; life: number; pierce: number; hit: Set<number>; dmgK: number; spin: number;
};
type Arc = { a: THREE.Vector3; b: THREE.Vector3; t: number; dur: number; w: number; c: THREE.Color; k: number };
type Vortex = { p: THREE.Vector3; t: number; def: GunDef; ring: number };

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const dirV = new THREE.Vector3();
const white = new THREE.Color(1, 1, 1);
const hurtRed = new THREE.Color(1.4, 0.12, 0.08);
const colT = new THREE.Color();
const rnd = () => Math.random();

// hip x, hip y, hip z, ads y (per class) - the viewmodel's resting pose
const HIP: Record<string, [number, number, number, number]> = {
  AR: [0.2, -0.19, -0.34, -0.09],
  SMG: [0.19, -0.18, -0.32, -0.085],
  Pistol: [0.14, -0.16, -0.3, -0.085],
  Sniper: [0.21, -0.2, -0.3, -0.1],
  Crossbow: [0.2, -0.2, -0.32, -0.1],
  Launcher: [0.2, -0.21, -0.3, -0.11],
};

function makeFlashTex() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.25, "rgba(255,255,255,.7)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = "lighter";
  g.fillStyle = "rgba(255,255,255,.9)";
  for (let i = 0; i < 6; i++) {
    g.save();
    g.translate(64, 64);
    g.rotate((i / 6) * Math.PI);
    g.fillRect(-62, -1.5, 124, 3);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function terrainRay(o: THREE.Vector3, d: THREE.Vector3, max: number): number {
  return Math.min(groundRay(o, d, max), rayColliders(o.x, o.y, o.z, d.x, d.y, d.z, max), looseRay(o.x, o.y, o.z, d.x, d.y, d.z, max));
}

function groundRay(o: THREE.Vector3, d: THREE.Vector3, max: number): number {
  const step = 1.5;
  let prevT = 0;
  for (let t = step; t <= max; t += step) {
    const y = o.y + d.y * t;
    if (y < heightAt(o.x + d.x * t, o.z + d.z * t)) {
      let lo = prevT, hi = t; // refine
      for (let i = 0; i < 6; i++) {
        const m = (lo + hi) / 2;
        if (o.y + d.y * m < heightAt(o.x + d.x * m, o.z + d.z * m)) hi = m;
        else lo = m;
      }
      return hi;
    }
    prevT = t;
  }
  return max;
}

function spreadDir(base: THREE.Vector3, camQ: THREE.Quaternion, deg: number, ox = 0, oy = 0, out = dirV) {
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(rnd()) * THREE.MathUtils.degToRad(deg);
  const yaw = Math.cos(a) * r + THREE.MathUtils.degToRad(ox);
  const pitch = Math.sin(a) * r + THREE.MathUtils.degToRad(oy);
  out.copy(base);
  tmpC.set(0, 1, 0).applyQuaternion(camQ);
  out.applyAxisAngle(tmpC, -yaw);
  tmpC.set(1, 0, 0).applyQuaternion(camQ);
  out.applyAxisAngle(tmpC, pitch);
  return out.normalize();
}

export function Weapons() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const rig = useRef<THREE.Group>(null); // follows the camera
  const comp = useRef<THREE.Group>(null); // cancels fov change so the gun keeps its size
  const hand = useRef<THREE.Group>(null); // sways / recoils
  const flashTex = useMemo(() => makeFlashTex(), []);
  const gunSlot = useRef<THREE.Group>(null);
  const flash = useRef<THREE.Mesh>(null);

  const fx = useMemo(() => {
    const bolts = new Streaks(300);
    const beams = new Streaks(96);
    const sparks = new Sparks(800);
    const blasts = new Blasts(24);
    const grp = new THREE.Group();
    [beams.mesh, bolts.mesh, sparks.mesh, blasts.mesh].forEach((m) => grp.add(m));
    return { bolts, beams, sparks, blasts, grp };
  }, []);

  const S = useRef({
    gun: GUN_BY_ID[START_GUN] as GunDef,
    color: new THREE.Color(GUN_BY_ID[START_GUN].color),
    muzzle: new THREE.Vector3(0, 0, -0.5),
    cd: 0,
    held: false,
    prevHeld: false,
    burstLeft: 0,
    burstT: 0,
    charge: 0,
    reload: 0, // seconds remaining
    reloadMax: 1,
    heat: 0, // extra spread
    ads: 0,
    adsWant: false,
    kick: 0,
    swayX: 0, swayY: 0,
    mx: 0, my: 0,
    pendP: 0, pendY: 0,
    equipT: 1,
    token: 0,
    projs: [] as Proj[],
    arcs: [] as Arc[],
    vortices: [] as Vortex[],
    lobs: [] as THREE.Object3D[],
    lobModel: null as THREE.Object3D | null,
    beamQueue: [] as Arc[],
    flashT: 0,
    lastGun: "",
    shake: 0,
    hudCharge: 0,
    scopeIdx: 0,
    breath: 1,
    winded: false,
    shift: false,
    spd: 0, spr: 0, bobT: 0, lx: 0, lz: 0, hudBreath: 1,
  });

  // ---- equip: swap the model in the hand and replay the hologram reveal ----
  const equip = async (id: string, silent = false) => {
    const def = GUN_BY_ID[id];
    if (!def) return;
    const st = S.current;
    const token = ++st.token;
    const m = await cloneGun(def);
    if (token !== st.token) return;
    const slot = gunSlot.current;
    if (!slot) return;
    slot.clear();
    slot.add(m.root);
    if (st.gun.id !== id) st.lastGun = st.gun.id;
    st.gun = def;
    st.color.set(def.color);
    hologramUniforms.uHolo.value.set(def.color);
    st.muzzle.copy(m.muzzle);
    st.cd = 0.25;
    st.reload = 0;
    st.charge = 0;
    st.burstLeft = 0;
    st.equipT = 0;
    st.heat = 0;
    st.scopeIdx = 0;
    const h = useHud.getState();
    h.set({ gun: id, mag: mags[id], magMax: def.mag, reloading: 0, charge: 0 });
    if (!silent) sfx.equip(def);
  };

  // ---- one-time setup ----
  useEffect(() => {
    const st = S.current;
    void preloadAll();
    void equip(START_GUN, true);
    new GLTFLoader().loadAsync("/models/guns/Grenade.gltf").then((g) => {
      const b = new THREE.Box3().setFromObject(g.scene);
      const s = 0.26 / Math.max(...b.getSize(new THREE.Vector3()).toArray());
      g.scene.scale.setScalar(s);
      const wrap = new THREE.Group();
      g.scene.position.copy(b.getCenter(new THREE.Vector3())).multiplyScalar(-s);
      wrap.add(g.scene);
      st.lobModel = wrap;
    });
    const unsub = useGame.subscribe((s, prev) => {
      if (s.phase !== "playing" && prev.phase === "playing") {
        st.held = false;
        st.adsWant = false;
      }
    });
    const locked = () => document.pointerLockElement === gl.domElement && useGame.getState().phase === "playing";
    const md = (e: MouseEvent) => {
      if (!locked()) return;
      if (e.button === 0) st.held = true;
      if (e.button === 2) st.adsWant = true;
    };
    const mu = (e: MouseEvent) => {
      if (e.button === 0) st.held = false;
      if (e.button === 2) st.adsWant = false;
    };
    const mm = (e: MouseEvent) => {
      if (!locked()) return;
      st.mx += e.movementX;
      st.my += e.movementY;
    };
    const ctx = (e: Event) => e.preventDefault();
    const ku = (e: KeyboardEvent) => {
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") st.shift = false;
    };
    const wheel = (e: WheelEvent) => {
      const sc = st.gun.scopes;
      if (!sc || !locked() || st.ads < 0.5) return;
      e.preventDefault();
      st.scopeIdx = THREE.MathUtils.clamp(st.scopeIdx + (e.deltaY < 0 ? 1 : -1), 0, sc.length - 1);
    };
    const kd = (e: KeyboardEvent) => {
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") st.shift = true;
      if (ride.plane) return; // flying: the plane owns the keys (no arsenal / reload / gun swap)
      const phase = useGame.getState().phase;
      if (e.code === "KeyG") {
        if (phase === "playing") {
          useGame.getState().setPhase("arsenal"); // phase first, so the pointer-lock handler doesn't treat it as a pause
          document.exitPointerLock();
        } else if (phase === "arsenal") {
          useGame.getState().setPhase("playing");
          gl.domElement.requestPointerLock();
        }
      } else if (e.code === "Escape" && phase === "arsenal") {
        useGame.getState().setPhase("playing");
        gl.domElement.requestPointerLock();
      } else if (phase === "playing") {
        if (e.code === "KeyR") startReload();
        if (e.code === "KeyQ" && !e.shiftKey && st.lastGun) void equip(st.lastGun);
        const n = e.code.startsWith("Digit") ? Number(e.code.slice(5)) : 0;
        if (n >= 1 && n <= 9) {
          const owned = useHud.getState().owned;
          const pick = owned[n - 1];
          if (pick) void equip(pick);
        }
      }
    };
    const onEquip = (e: Event) => void equip((e as CustomEvent<string>).detail);
    window.addEventListener("mousedown", md);
    window.addEventListener("mouseup", mu);
    document.addEventListener("mousemove", mm);
    window.addEventListener("contextmenu", ctx);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("equip-gun", onEquip);
    return () => {
      unsub();
      window.removeEventListener("mousedown", md);
      window.removeEventListener("mouseup", mu);
      document.removeEventListener("mousemove", mm);
      window.removeEventListener("contextmenu", ctx);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("equip-gun", onEquip);
    };
  }, [gl]);

  const startReload = () => {
    const st = S.current;
    const d = st.gun;
    if (st.reload > 0 || mags[d.id] >= d.mag) return;
    st.reload = st.reloadMax = d.reload;
    st.charge = 0;
    st.burstLeft = 0;
    sfx.reload();
  };

  // ---- damage helpers ----
  const addArc = (a: THREE.Vector3, b: THREE.Vector3, dur: number, w: number, c: THREE.Color, k = 3) => {
    S.current.arcs.push({ a: a.clone(), b: b.clone(), t: 0, dur, w, c, k });
  };

  const explode = (p: THREE.Vector3, def: GunDef, radius: number, dmg: number, skip?: number) => {
    const st = S.current;
    blastLoose(p, radius, 9 + radius * 2);
    fx.blasts.add(p, radius, st.color, 0.5);
    fx.blasts.add(p, radius * 0.5, white, 0.22);
    fx.sparks.burst(p, st.color, 40, radius * 4, 0.09);
    sfx.boom(Math.min(1.6, radius / 3 + 0.5));
    st.shake = Math.max(st.shake, Math.min(1, radius / 6) * Math.max(0, 1 - p.distanceTo(camera.position) / 40));
    for (const e of enemies) {
      if (!e.alive || e.id === skip) continue;
      const d = Math.hypot(e.x - p.x, e.y + e.h * 0.5 - p.y, e.z - p.z);
      if (d > radius + e.r) continue;
      const f = 1 - Math.min(1, d / (radius + e.r)) * 0.7;
      damageEnemy(e, dmg * f, false, e.x - p.x, e.z - p.z, (def.knock ?? 0) * f);
    }
  };

  const killed0 = (e: Enemy, dmg: number) => e.hp - dmg <= 0;
  const hitEnemy = (e: Enemy, def: GunDef, dmg: number, head: boolean, at: THREE.Vector3, dir: THREE.Vector3) => {
    const st = S.current;
    // heavier hits: +20% damage, knockback that scales with the round (big bodies shrug more off),
    // a longer stagger, a flash + spray at the wound and a small camera thump
    const total = dmg * 1.2 * (head ? (def.head ?? 2) : 1);
    const knock = ((def.knock ?? 0) * 0.6 + 1.6 + Math.min(6, total * 0.07)) / Math.max(1, e.r * 0.8);
    const killed = damageEnemy(e, total, head, dir.x, dir.z, killed0(e, total) ? knock * 1.8 : knock);
    e.pain = Math.max(e.pain, 0.22 + Math.min(0.4, total * 0.004));
    fx.sparks.burst(at, st.color, head ? 26 : 16, 7 + Math.min(6, total * 0.05), 0.06, tmpB.copy(dir).multiplyScalar(3));
    fx.sparks.burst(at, hurtRed, head ? 14 : 8, 4, 0.05);
    fx.blasts.add(at, 0.35 + Math.min(1.4, total * 0.01) + (head ? 0.3 : 0), st.color, 0.14);
    st.shake = Math.max(st.shake, Math.min(0.35, 0.08 + total * 0.0025) * (killed ? 1.6 : 1));
    if (def.burn && !killed) {
      e.burn = def.burn.sec;
      e.burnDps = def.burn.dps;
    }
    if (def.chain && !killed) {
      let from = at;
      const used = new Set<number>([e.id]);
      for (let i = 0; i < def.chain.n; i++) {
        let best: Enemy | null = null;
        let bd = def.chain.range;
        for (const o of enemies) {
          if (!o.alive || used.has(o.id) || friendly(o)) continue;
          const d = Math.hypot(o.x - from.x, o.y + o.h * 0.6 - from.y, o.z - from.z);
          if (d < bd) { bd = d; best = o; }
        }
        if (!best) break;
        used.add(best.id);
        const to = tmpB.set(best.x, best.y + best.h * 0.6, best.z);
        addArc(from, to, 0.14, 0.035, st.color, 4);
        damageEnemy(best, dmg * def.chain.frac, false, to.x - from.x, to.z - from.z, 1);
        from = to.clone();
      }
    }
  };

  const detonate = (pr: Proj, at: THREE.Vector3) => {
    const def = pr.def;
    const aoe = pr.mini ? def.aoe! * 0.55 : def.aoe!;
    if (def.vortex && !pr.mini) {
      S.current.vortices.push({ p: at.clone(), t: 0, def, ring: 0 });
      return;
    }
    explode(at, def, aoe, def.damage * pr.dmgK * (pr.mini ? 0.7 : 1));
    if (def.cluster && !pr.mini) {
      for (let i = 0; i < def.cluster; i++) {
        const a = (i / def.cluster) * Math.PI * 2 + rnd();
        spawnProj(def, at.clone().add(tmpA.set(0, 0.3, 0)), tmpB.set(Math.cos(a) * 7, 8 + rnd() * 3, Math.sin(a) * 7), true, 1);
      }
    }
  };

  const spawnProj = (def: GunDef, p: THREE.Vector3, v: THREE.Vector3, mini = false, dmgK = 1) => {
    const list = S.current.projs;
    let pr = list.find((q) => !q.alive);
    if (!pr) {
      if (list.length >= 160) return;
      pr = { alive: false, lob: false, mini: false, p: new THREE.Vector3(), v: new THREE.Vector3(), prev: new THREE.Vector3(), def, life: 0, pierce: 0, hit: new Set(), dmgK: 1, spin: 0 };
      list.push(pr);
    }
    pr.alive = true;
    pr.def = def;
    pr.lob = def.kind === "lob";
    pr.mini = mini;
    pr.p.copy(p);
    pr.prev.copy(p);
    pr.v.copy(v);
    pr.life = def.life ?? (pr.lob ? 4 : 2.2);
    pr.pierce = def.pierce ?? 0;
    pr.hit.clear();
    pr.dmgK = dmgK;
    pr.spin = rnd() * 6;
  };

  // ---- the shot ----
  const fire = (charge = 1) => {
    const st = S.current;
    const d = st.gun;
    if (mags[d.id] <= 0) {
      sfx.click();
      st.cd = 0.25;
      startReload();
      return;
    }
    mags[d.id]--;
    useHud.getState().set({ mag: mags[d.id] });
    sfx.shot(d, charge);
    makeNoise(pose.x, pose.z, d.id.startsWith("Pistol") || d.id.startsWith("SMG") ? 55 : d.id.startsWith("Sniper") ? 95 : 75);

    const camQ = camera.quaternion;
    const fwd = tmpA.set(0, 0, -1).applyQuaternion(camQ).clone();
    const eye = camera.position;
    const adsK = 1 - st.ads * 0.65;
    const cone = (d.spread + st.heat) * adsK;
    const mw = st.muzzle.clone();
    gunSlot.current?.localToWorld(mw);
    if (d.scopes && st.ads > 0.85) mw.copy(eye).addScaledVector(fwd, 0.5).y -= 0.05; // gun is hidden behind the scope: shoot from the lens
    const offsets = d.pellets ?? [[0, 0]];
    for (const [ox, oy] of offsets) {
      const dir = spreadDir(fwd, camQ, cone, ox, oy, new THREE.Vector3());
      const dmgK = d.mode === "charge" ? 0.35 + 0.65 * charge : 1;
      if (d.kind === "beam") fireBeam(d, eye, dir, mw, dmgK);
      else if (d.kind === "bolt") {
        // aim the bolt at where the crosshair ray lands, so it converges from the muzzle
        const tDist = Math.min(terrainRay(eye, dir, 80), 80);
        const target = eye.clone().addScaledVector(dir, Math.max(tDist, 6));
        const v = target.sub(mw).normalize().multiplyScalar((d.speed ?? 200) * (d.mode === "charge" ? 0.6 + 0.4 * charge : 1));
        spawnProj(d, mw, v, false, dmgK);
      } else {
        const v = dir.clone().multiplyScalar(d.speed ?? 26);
        v.y += 2.5;
        spawnProj(d, mw, v, false, 1);
      }
    }
    fx.sparks.burst(mw, st.color, 5, 3, 0.03);
    st.flashT = 0.06;
    st.kick = Math.min(1.4, st.kick + d.kick * (0.4 + 0.6 * charge));
    st.pendP += THREE.MathUtils.degToRad(d.recoil * (0.6 + 0.4 * charge) * (1 - st.ads * 0.35));
    st.pendY += THREE.MathUtils.degToRad((rnd() - 0.5) * d.recoil * 0.5);
    st.heat = Math.min(d.spreadMax ?? 0, st.heat + (d.spreadGrow ?? 0));
    if (mags[d.id] <= 0) setTimeout(startReload, 220);
  };

  const fireBeam = (d: GunDef, eye: THREE.Vector3, dir: THREE.Vector3, mw: THREE.Vector3, dmgK: number) => {
    const st = S.current;
    const maxD = 400;
    const tHit = terrainRay(eye, dir, maxD);
    const hits: { e: Enemy; t: number; head: boolean }[] = [];
    for (const e of enemies) {
      if (!e.alive) continue;
      const r = rayEnemy(e, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, d.size * 0.5);
      if (r && r[0] < tHit) hits.push({ e, t: r[0], head: r[1] });
    }
    hits.sort((a, b) => a.t - b.t);
    let end = tHit;
    const n = (d.pierce ?? 0) + 1;
    hits.slice(0, n).forEach((h) => {
      const at = eye.clone().addScaledVector(dir, h.t);
      hitEnemy(h.e, d, d.damage * dmgK, h.head, at, dir);
    });
    if (hits.length > n) end = hits[n - 1].t;
    const endP = eye.clone().addScaledVector(dir, end);
    kickLoose(endP, dir, 2.5 + d.damage * 0.05);
    if (end >= tHit - 0.01) {
      fx.sparks.burst(endP, st.color, 18, 6, 0.06);
      fx.blasts.add(endP, 0.6 + d.size * 3, st.color, 0.25);
    }
    const w = d.size * (0.4 + 0.6 * dmgK);
    st.beamQueue.push({ a: mw, b: endP, t: 0, dur: d.id === "Sniper_2" ? 0.5 : d.id === "Sniper_1" ? 0.28 : 0.18, w, c: st.color, k: 4 });
    st.shake = Math.max(st.shake, d.id === "Sniper_2" ? 0.5 : 0.2);
  };

  // ---- frame ----
  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const st = S.current;
    const phase = useGame.getState().phase;
    const g = hand.current;
    const rg = rig.current;
    if (!g || !rg) return;
    const d = st.gun;
    const t0 = state.clock.elapsedTime;
    hologramUniforms.uTime.value = t0;

    // follow camera
    rg.position.copy(camera.position);
    rg.quaternion.copy(camera.quaternion);
    rg.visible = (phase === "playing" || phase === "arsenal" || phase === "paused") && !ride.on;
    const playing = phase === "playing" && !ride.on;

    if (playing) {
      st.cd -= dt;
      st.heat = Math.max(0, st.heat - dt * 5);
      if (st.reload > 0) {
        st.reload -= dt;
        useHud.getState().set({ reloading: 1 - Math.max(0, st.reload) / st.reloadMax });
        if (st.reload <= 0) {
          mags[d.id] = d.mag;
          useHud.getState().set({ mag: d.mag, reloading: 0 });
        }
      }
      const can = st.reload <= 0 && st.equipT > 0.55;
      const press = st.held && !st.prevHeld;
      const release = !st.held && st.prevHeld;
      if (can) {
        if (d.mode === "auto") {
          if (st.held && st.cd <= 0) { fire(); st.cd = d.interval; }
        } else if (d.mode === "semi") {
          if (press && st.cd <= 0) { fire(); st.cd = d.interval; }
        } else if (d.mode === "burst") {
          if (press && st.cd <= 0 && st.burstLeft <= 0) { st.burstLeft = d.burst ?? 3; st.burstT = 0; st.cd = d.interval; }
          if (st.burstLeft > 0) {
            st.burstT -= dt;
            if (st.burstT <= 0) { fire(); st.burstLeft--; st.burstT = d.burstGap ?? 0.06; }
          }
        } else if (d.mode === "charge") {
          if (st.held && st.cd <= 0) {
            if (st.charge === 0) sfx.click();
            st.charge = Math.min(1, st.charge + dt / (d.charge ?? 1));
          }
          if (release && st.charge > 0.12) { fire(st.charge); st.cd = d.interval; st.charge = 0; }
          else if (release) st.charge = 0;
        }
      }
      st.prevHeld = st.held;
      if (Math.abs(st.charge - st.hudCharge) > 0.02 || (st.charge === 0 && st.hudCharge !== 0)) {
        st.hudCharge = st.charge;
        useHud.getState().set({ charge: st.charge });
      }
      // camera kick released smoothly
      const take = Math.min(1, dt * 22);
      ctl.pitch += st.pendP * take;
      ctl.yaw += st.pendY * take;
      st.pendP -= st.pendP * take;
      st.pendY -= st.pendY * take;
    } else {
      st.prevHeld = false;
    }

    // ---- aim / scope ----
    const hud = useHud.getState();
    const scopes = d.scopes;
    st.ads += ((playing && st.adsWant && st.reload <= 0 ? 1 : 0) - st.ads) * (1 - Math.exp(-(scopes ? 10 : 14) * dt));
    const scopeOn = !!scopes && st.ads > 0.85;
    const mag = scopeOn && scopes ? Math.round(10 / scopes[st.scopeIdx]) / 10 : 0;
    if (st.ads > 0.5 !== hud.ads || scopeOn !== hud.scopeOn || mag !== hud.scope) hud.set({ ads: st.ads > 0.5, scopeOn, scope: mag });
    if (scopeOn && playing) {
      const hold = st.shift && !st.winded;
      if (hold) {
        st.breath = Math.max(0, st.breath - dt / 3.5);
        if (st.breath <= 0) st.winded = true;
      } else {
        st.breath = Math.min(1, st.breath + dt / (st.winded ? 4 : 2.5));
        if (st.winded && st.breath > 0.35) st.winded = false;
      }
      const amp = hold ? 0.002 : 0.02; // rad/s of drift
      ctl.pitch += (Math.sin(t0 * 1.3) + 0.5 * Math.sin(t0 * 2.9 + 1)) * amp * dt;
      ctl.yaw += (Math.sin(t0 * 1.1 + 2) + 0.5 * Math.sin(t0 * 3.3)) * amp * dt;
    } else st.breath = Math.min(1, st.breath + dt / 2.5);
    if (Math.abs(st.breath - st.hudBreath) > 0.02) {
      st.hudBreath = st.breath;
      hud.set({ breath: st.breath });
    }

    // ---- movement feel ----
    const mvx = pose.x - st.lx, mvz = pose.z - st.lz;
    st.lx = pose.x; st.lz = pose.z;
    const spd = Math.min(12, Math.hypot(mvx, mvz) / Math.max(dt, 1e-3));
    st.spd += (spd - st.spd) * (1 - Math.exp(-8 * dt));
    const walk = Math.min(1, st.spd / 4.2);
    const sprintT = playing && st.shift && st.spd > 5.5 && !st.adsWant && !st.held ? 1 : 0;
    st.spr += (sprintT - st.spr) * (1 - Math.exp(-9 * dt));
    st.bobT += dt * (3 + st.spd * 1.1);

    st.equipT = Math.min(1, st.equipT + dt / 0.75);
    hologramUniforms.uReveal.value = 1 - Math.pow(1 - st.equipT, 3);
    st.kick *= Math.exp(-14 * dt);

    // sway from mouse + view bob
    st.swayX += (THREE.MathUtils.clamp(-st.mx * 0.0006, -0.05, 0.05) - st.swayX) * (1 - Math.exp(-10 * dt));
    st.swayY += (THREE.MathUtils.clamp(st.my * 0.0006, -0.05, 0.05) - st.swayY) * (1 - Math.exp(-10 * dt));
    st.mx = st.my = 0;
    const t = state.clock.elapsedTime;
    const breathe = Math.sin(t * 1.6) * 0.002;
    const rl = st.reload > 0 ? Math.sin(Math.PI * (1 - st.reload / st.reloadMax)) : 0;
    const eq = 1 - Math.pow(1 - st.equipT, 3);
    const a = st.ads;
    const sp = st.spr;
    const [hx, hy, hz, ay] = HIP[d.cls] ?? HIP.AR;
    const bobK = walk * (1 - a * 0.85) * (1 + sp * 0.9);
    const bobX = Math.cos(st.bobT) * 0.007 * bobK;
    const bobY = -Math.abs(Math.sin(st.bobT)) * 0.011 * bobK;
    g.position.set(
      THREE.MathUtils.lerp(hx, 0, a) + st.swayX + bobX - sp * 0.05,
      THREE.MathUtils.lerp(hy, ay, a) + st.swayY + breathe + bobY - rl * 0.16 - (1 - eq) * 0.14 - sp * 0.06,
      THREE.MathUtils.lerp(hz, hz + 0.04, a) + st.kick * 0.07 + sp * 0.03,
    );
    g.rotation.set(
      st.kick * 0.1 + rl * 0.5 + st.swayY * 1.2 - (1 - eq) * 0.7 + sp * 0.25,
      THREE.MathUtils.lerp(0.04, 0, a) + st.swayX * 1.5 + sp * 0.75 + (1 - eq) * 0.5,
      rl * -0.5 + st.swayX * 0.8 + bobX * 2.5 - sp * 0.2,
    );
    g.position.y += (1 - eq) * Math.sin(t * 9) * 0.004; // hologram flicker
    g.visible = !scopeOn;
    if (comp.current) {
      // keep the gun the same size on screen whatever the fov does (sprint fov, ADS zoom)
      const k = Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov / 2)) / Math.tan(THREE.MathUtils.degToRad(32));
      comp.current.scale.setScalar(THREE.MathUtils.clamp(k, 0.55, 1.2));
    }
    if (flash.current) {
      st.flashT -= dt;
      flash.current.visible = st.flashT > 0;
      flash.current.position.copy(st.muzzle).add(tmpA.set(0, 0, -0.03));
      flash.current.scale.setScalar(0.16 + rnd() * 0.12);
      flash.current.rotation.z = rnd() * 6;
      (flash.current.material as THREE.MeshBasicMaterial).color.copy(st.color).lerp(white, 0.35).multiplyScalar(5);
    }

    ctl.zoom = THREE.MathUtils.lerp(1, scopes ? scopes[st.scopeIdx] : d.zoom, st.ads);

    updateWorld(dt);
  });

  const updateWorld = (dt: number) => {
    const st = S.current;

    // projectiles
    for (const pr of st.projs) {
      if (!pr.alive) continue;
      const d = pr.def;
      pr.life -= dt;
      pr.prev.copy(pr.p);
      if (pr.lob) pr.v.y -= (d.gravity ?? 14) * dt;
      else if (d.homing) {
        let best: Enemy | null = null;
        let bd = 30;
        const sp = pr.v.length();
        for (const e of enemies) {
          if (!e.alive || friendly(e)) continue;
          const dd = Math.hypot(e.x - pr.p.x, e.y + e.h * 0.6 - pr.p.y, e.z - pr.p.z);
          if (dd < bd) {
            tmpA.set(e.x - pr.p.x, e.y + e.h * 0.6 - pr.p.y, e.z - pr.p.z).normalize();
            if (tmpA.dot(tmpB.copy(pr.v).normalize()) > 0.35) { bd = dd; best = e; }
          }
        }
        if (best) {
          tmpA.set(best.x - pr.p.x, best.y + best.h * 0.6 - pr.p.y, best.z - pr.p.z).normalize();
          tmpB.copy(pr.v).normalize().lerp(tmpA, Math.min(1, d.homing * dt)).normalize();
          pr.v.copy(tmpB).multiplyScalar(sp);
        }
      }
      pr.p.addScaledVector(pr.v, dt);
      pr.spin += dt * 9;
      let dead = pr.life <= 0;
      // vs enemies (swept)
      const seg = tmpA.copy(pr.p).sub(pr.prev);
      const len = seg.length();
      if (len > 1e-5 && !dead) {
        const dir = seg.divideScalar(len).clone();
        for (const e of enemies) {
          if (!e.alive || pr.hit.has(e.id)) continue;
          const r = rayEnemy(e, pr.prev.x, pr.prev.y, pr.prev.z, dir.x, dir.y, dir.z, d.size * 0.4 + (pr.lob ? 0.15 : 0));
          if (!r || r[0] > len) continue;
          const at = pr.prev.clone().addScaledVector(dir, r[0]);
          pr.hit.add(e.id);
          if (pr.lob) { pr.p.copy(at); detonate(pr, at); dead = true; break; }
          hitEnemy(e, d, d.damage * pr.dmgK, r[1], at, dir);
          if (d.aoe) explode(at, d, d.aoe, d.damage * 0.6 * pr.dmgK, e.id);
          if (pr.pierce-- <= 0) { dead = true; break; }
        }
        // terrain
        if (!dead && pr.p.y < heightAt(pr.p.x, pr.p.z)) {
          pr.p.y = heightAt(pr.p.x, pr.p.z) + 0.05;
          const at = pr.p.clone();
          if (pr.lob) detonate(pr, at);
          else {
            fx.sparks.burst(at, st.color, 16, 5, 0.06, tmpB.set(0, 1.6, 0));
            fx.blasts.add(at, 0.3 + d.size * 4, st.color, 0.12);
            kickLoose(at, dir, 1.5 + d.damage * 0.04);
            if (d.aoe) explode(at, d, d.aoe, d.damage * 0.8 * pr.dmgK);
          }
          dead = true;
        }
      }
      if (dead) {
        pr.alive = false;
        if (pr.lob && pr.life <= 0) detonate(pr, pr.p.clone());
      }
    }

    // vortex wells: pull everything in, then collapse
    for (let i = st.vortices.length - 1; i >= 0; i--) {
      const v = st.vortices[i];
      v.t += dt;
      const dur = v.def.vortex ?? 1.5;
      for (const e of enemies) {
        if (!e.alive) continue;
        const dx = v.p.x - e.x, dz = v.p.z - e.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 11 && dist > 0.4) { e.vx += (dx / dist) * 24 * dt; e.vz += (dz / dist) * 24 * dt; }
      }
      v.ring += dt;
      if (v.ring > 0.03) {
        v.ring = 0;
        const a = rnd() * 6.28, r = 3 + rnd() * 3;
        fx.sparks.burst(tmpA.set(v.p.x + Math.cos(a) * r, v.p.y + 0.4 + rnd(), v.p.z + Math.sin(a) * r), st.color, 1, 0.3, 0.07);
      }
      fx.blasts.add(v.p, 0.6 + Math.sin(v.t * 20) * 0.1, st.color, 0.06);
      if (v.t >= dur) {
        explode(v.p, v.def, v.def.aoe!, v.def.damage);
        st.vortices.splice(i, 1);
      }
    }

    // draw bolts / lobs
    fx.bolts.begin();
    let lobN = 0;
    for (const pr of st.projs) {
      if (!pr.alive) continue;
      if (pr.lob) {
        let o = st.lobs[lobN];
        if (!o && st.lobModel) {
          o = st.lobModel.clone(true);
          fx.grp.add(o);
          st.lobs[lobN] = o;
        }
        if (o) {
          o.visible = true;
          o.position.copy(pr.p);
          o.rotation.set(pr.spin, pr.spin * 0.6, 0);
          o.scale.setScalar(pr.mini ? 0.6 : 1);
        }
        lobN++;
        tmpA.copy(pr.p).addScaledVector(pr.v, -0.02);
        fx.bolts.add(tmpA, pr.p, 0.1, st.color, 2.5);
      } else {
        const len = Math.min(pr.def.size * 14 + 0.7, pr.v.length() * 0.05 + 0.5);
        tmpA.copy(pr.p).addScaledVector(tmpB.copy(pr.v).normalize(), -len);
        fx.bolts.add(tmpA, pr.p, pr.def.size, colT.set(pr.def.color), 5);
      }
    }
    for (let i = lobN; i < st.lobs.length; i++) if (st.lobs[i]) st.lobs[i].visible = false;
    fx.bolts.end();

    // beams & arcs
    fx.beams.begin();
    const queue = st.beamQueue;
    for (const b of queue) st.arcs.push(b);
    queue.length = 0;
    st.arcs = st.arcs.filter((a) => (a.t += dt) < a.dur);
    for (const a of st.arcs) {
      const f = 1 - a.t / a.dur;
      fx.beams.add(a.a, a.b, a.w * (0.25 + f * 0.75), a.c, a.k * f);
      fx.beams.add(a.a, a.b, a.w * 0.3 * (0.2 + f), white, a.k * 1.4 * f);
    }
    fx.beams.end();
    fx.sparks.update(dt);
    fx.blasts.update(dt);

    // screen shake rides on the camera kick channel
    if (st.shake > 0.01) {
      ctl.pitch += (rnd() - 0.5) * 0.004 * st.shake;
      ctl.yaw += (rnd() - 0.5) * 0.004 * st.shake;
      st.shake *= Math.exp(-9 * dt);
    }
  };

  return (
    <>
      <primitive object={fx.grp} />
      <group ref={rig} userData={{ noReflect: true }}>
        <group ref={comp}>
        <group ref={hand}>
          <group ref={gunSlot} />
          <mesh ref={flash} visible={false}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial map={flashTex} toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
        </group>
      </group>
    </>
  );
}
