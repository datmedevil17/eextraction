"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { FACELESS, heightAt, wetAt } from "@/game/terrain";
import { pose, useGame } from "@/game/store";
import { enemies, hurtPlayer, makeEnemy, raySphere, rayEnemy, type Enemy } from "@/game/weapons/combat";
import { Blasts, Sparks, Streaks } from "@/game/weapons/fx";
import { terrainRay } from "@/game/weapons/Weapons";
import { pushOut } from "./colliders";
import { setShadow } from "./modelKit";
import { PLAZA_R } from "./facelessLayout";
import { decoys, facelessHouses, raids, ritual, routeVia, type Decoy } from "./facelessShared";

// The Faceless: wizards and monks (Quaternius, CC0) with blank porcelain heads living in the village.
// They idle around the plaza, go in and out of their houses and gather at the rune circle. They
// defend the village from the open-world minions (Monsters.tsx): wizards cast arcane bolts (needs a
// line of sight) and lob frost orbs over the fence, monks rush in with palm strikes and shockwaves.
// Neutral to the player until hurt: then the victim and its neighbours turn on the player for a while.

const C = FACELESS;
const N = 9;
const SCALE = 0.62;
const SIGHT = 38;
const SIM = 420; // player distance from the village to simulate / show
const HOSTILE_T = 60;
const RESPAWN = 35;
const GRAV = 9;

type Kind = "wizard" | "monk";
const KIND: Record<Kind, { file: string; hp: number; walk: number; run: number }> = {
  wizard: { file: "Wizard", hp: 120, walk: 1.4, run: 3.8 },
  monk: { file: "Monk", hp: 170, walk: 1.5, run: 4.6 },
};
const ONCE = new Set(["Death", "Spell1", "Spell2", "Staff_Attack", "Attack", "Attack2", "RecieveHit", "Punch"]);

// HDR colours (Bloom threshold is 1.0)
const COL = {
  arcane: new THREE.Color(2.6, 0.7, 4.2),
  arcaneCore: new THREE.Color(3.4, 2.6, 4.5),
  frost: new THREE.Color(0.9, 2.4, 4.2),
  frostCore: new THREE.Color(2.8, 3.6, 4.6),
  palm: new THREE.Color(1.8, 2.8, 3.6),
  halo: new THREE.Color(1.5, 0.6, 3.2),
  angry: new THREE.Color(4.0, 0.5, 0.35),
};

type State = "idle" | "walk" | "enter" | "inside" | "gather" | "fight" | "dead";
type S = {
  i: number;
  kind: Kind;
  wrap: THREE.Group;
  mixer: THREE.AnimationMixer;
  act: Record<string, THREE.AnimationAction>;
  cur: string;
  mats: THREE.MeshStandardMaterial[];
  halo: THREE.MeshBasicMaterial;
  tip: THREE.Object3D;
  e: Enemy;
  dc: Decoy;
  state: State;
  t: number;
  tx: number;
  tz: number;
  yaw: number;
  home: number;
  scan: number;
  cd: number;
  cast: number; // seconds into the current cast, -1 = none
  spell: 0 | 1 | 2 | 3; // bolt, frost orb, palm, stomp
  fired: boolean;
  tgt: Enemy | null;
  tgtPlayer: boolean;
  tpx: number;
  tpz: number;
  tvx: number;
  tvz: number;
  lastHp: number;
  hostile: number;
  hitT: number;
  slot: number;
};

// ---------- pooled VFX ----------
const GLOW_VS = /* glsl */ `varying vec2 vUv; varying vec3 vCol;
void main(){
  vUv = uv * 2.0 - 1.0;
  vCol = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #endif
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * length(instanceMatrix[0].xyz);
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FS = /* glsl */ `varying vec2 vUv; varying vec3 vCol;
void main(){
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 4.5) * 0.7 + exp(-r2 * 38.0) * 1.6;
  gl_FragColor = vec4(vCol * a * (1.0 - r2), 1.0);
}`;
const RING_VS = /* glsl */ `varying vec2 vUv; varying vec3 vCol;
void main(){
  vUv = uv * 2.0 - 1.0;
  vCol = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const RING_FS = /* glsl */ `varying vec2 vUv; varying vec3 vCol;
void main(){
  float r = length(vUv);
  if (r > 1.0) discard;
  float band = smoothstep(0.16, 0.0, abs(r - 0.88)) + smoothstep(0.05, 0.0, abs(r - 0.7)) * 0.5;
  float fill = smoothstep(0.9, 0.2, r) * 0.12;
  gl_FragColor = vec4(vCol * (band + fill), 1.0);
}`;

const _o = new THREE.Object3D();
const _c = new THREE.Color();
const additive = (vs: string, fs: string, side: THREE.Side = THREE.FrontSide) =>
  new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side });

/** Camera-facing soft glows (instanced), rebuilt every frame. */
class Glows {
  mesh: THREE.InstancedMesh;
  n = 0;
  constructor(public cap: number) {
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), additive(GLOW_VS, GLOW_FS), cap);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.setColorAt(0, _c.set(0));
    this.mesh.count = 0;
  }
  add(x: number, y: number, z: number, size: number, c: THREE.Color, k: number) {
    if (this.n >= this.cap || size <= 0.001) return;
    _o.position.set(x, y, z);
    _o.quaternion.identity();
    _o.scale.setScalar(size);
    _o.updateMatrix();
    this.mesh.setMatrixAt(this.n, _o.matrix);
    this.mesh.setColorAt(this.n, _c.copy(c).multiplyScalar(k));
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.n = 0;
  }
}

/** Short-lived effects in fixed slots: expanding ground rings and flash glows. */
type Fade = { on: boolean; x: number; y: number; z: number; t: number; dur: number; r: number; c: THREE.Color };
const fades = (n: number): Fade[] => Array.from({ length: n }, () => ({ on: false, x: 0, y: 0, z: 0, t: 0, dur: 1, r: 1, c: new THREE.Color() }));
function spawnFade(list: Fade[], x: number, y: number, z: number, r: number, dur: number, c: THREE.Color) {
  let f = list.find((o) => !o.on);
  if (!f) f = list.reduce((a, b) => (a.t / a.dur > b.t / b.dur ? a : b));
  f.on = true; f.x = x; f.y = y; f.z = z; f.r = r; f.dur = dur; f.t = 0; f.c.copy(c);
}

const TRAIL = 10;
type Proj = { on: boolean; orb: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; hostile: boolean; trail: Float32Array; tn: number };

// ---------- assets ----------
type Model = { scene: THREE.Object3D; clips: THREE.AnimationClip[] };
const clipOf = (clips: THREE.AnimationClip[], n: string) => clips.find((c) => c.name === n || c.name.endsWith("|" + n));

/** Blank porcelain head + halo on the template (clones inherit them), and a marker at the casting point. */
function prepare(kind: Kind, m: Model) {
  const s = m.scene;
  const mixer = new THREE.AnimationMixer(s);
  const idle = clipOf(m.clips, "Idle");
  if (idle) mixer.clipAction(idle).play();
  mixer.update(0);
  s.updateMatrixWorld(true);
  // original model faces stay visible (no porcelain mask)
  const head = s.getObjectByName("Head");
  if (head) {
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.022, 6, 40),
      new THREE.MeshBasicMaterial({ color: COL.halo, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    halo.name = "halo";
    halo.rotation.x = Math.PI / 2 - 0.25;
    halo.position.set(0, 3.0, 0.05);
    s.add(halo);
    halo.updateMatrixWorld();
    head.attach(halo);
  }
  const tip = new THREE.Object3D();
  tip.name = "castTip";
  const staff = s.getObjectByName("Wizard_Staff") as THREE.Mesh | undefined;
  if (kind === "wizard" && staff?.isMesh) {
    staff.geometry.computeBoundingBox();
    const bb = staff.geometry.boundingBox!;
    const size = bb.getSize(new THREE.Vector3());
    const ax = size.x > size.y ? (size.x > size.z ? "x" : "z") : size.y > size.z ? "y" : "z";
    const c = bb.getCenter(new THREE.Vector3());
    const a = c.clone(), b = c.clone();
    a[ax] = bb.min[ax]; b[ax] = bb.max[ax];
    const wa = a.clone().applyMatrix4(staff.matrixWorld), wb = b.clone().applyMatrix4(staff.matrixWorld);
    tip.position.copy(wa.y > wb.y ? a : b).lerp(c, 0.06);
    staff.add(tip);
  } else (s.getObjectByName("FistR") ?? head ?? s).add(tip);
  mixer.stopAllAction();
  mixer.uncacheRoot(s);
}

async function loadModels(): Promise<Record<Kind, Model>> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const [w, m] = await Promise.all([loader.loadAsync("/models/faceless/Wizard.glb"), loader.loadAsync("/models/faceless/Monk.glb")]);
  const out: Record<Kind, Model> = { wizard: { scene: w.scene, clips: w.animations }, monk: { scene: m.scene, clips: m.animations } };
  prepare("wizard", out.wizard);
  prepare("monk", out.monk);
  return out;
}

const KINDS: Kind[] = ["wizard", "monk", "wizard", "wizard", "monk", "wizard", "monk", "wizard", "monk"];
const isMinion = (e: Enemy) => e.alive && (e.tag === "imp" || e.tag === "puglin");
const rnd = Math.random;
const _via: [number, number] = [0, 0];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

function hurtMinion(e: Enemy, dmg: number, fx: number, fz: number, knock: number) {
  e.hp -= dmg;
  e.pain = Math.max(e.pain, 0.2);
  const l = Math.hypot(e.x - fx, e.z - fz) || 1;
  e.vx += ((e.x - fx) / l) * knock;
  e.vz += ((e.z - fz) / l) * knock;
  if (e.hp <= 0) { e.hp = 0; e.alive = false; }
}

export function Sorcerers() {
  const root = useRef<THREE.Group>(null);
  const list = useRef<S[]>([]);
  const light = useRef<THREE.PointLight>(null);
  const raidT = useRef(22);
  const ritualT = useRef(0);

  const fx = useMemo(() => {
    const sparks = new Sparks(600);
    const blasts = new Blasts(20);
    const streaks = new Streaks(260);
    const glows = new Glows(160);
    const ringMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), additive(RING_VS, RING_FS, THREE.DoubleSide), 16);
    ringMesh.frustumCulled = false;
    ringMesh.renderOrder = 8;
    ringMesh.setColorAt(0, _c.set(0));
    ringMesh.count = 0;
    const projs: Proj[] = Array.from({ length: 24 }, () => ({ on: false, orb: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, hostile: false, trail: new Float32Array(TRAIL * 3), tn: 0 }));
    return { sparks, blasts, streaks, glows, ringMesh, rings: fades(16), flashes: fades(24), projs, flash: { i: 0, x: 0, y: 0, z: 0 } };
  }, []);

  useEffect(() => {
    let dead = false;
    const mine: S[] = [];
    loadModels().then((mods) => {
      if (dead || !root.current) return;
      const houses = facelessHouses();
      for (let i = 0; i < N; i++) {
        const kind = KINDS[i];
        const K = KIND[kind];
        const obj = cloneSkinned(mods[kind].scene);
        const mats: THREE.MeshStandardMaterial[] = [];
        let halo: THREE.MeshBasicMaterial | null = null;
        let tip: THREE.Object3D | null = null;
        obj.traverse((o) => {
          if (o.name === "castTip") tip = o;
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.frustumCulled = false;
          if (o.name === "halo") { halo = (m.material as THREE.MeshBasicMaterial).clone(); m.material = halo; return; }
          const mm = (m.material as THREE.MeshStandardMaterial).clone();
          m.material = mm;
          mats.push(mm);
        });
        obj.scale.setScalar(SCALE);
        const wrap = new THREE.Group();
        wrap.add(obj);
        root.current.add(wrap);
        const mixer = new THREE.AnimationMixer(obj);
        const act: S["act"] = {};
        for (const c of mods[kind].clips) {
          const name = c.name.split("|").pop()!;
          const a = mixer.clipAction(c);
          if (ONCE.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
          act[name] = a;
        }
        act.Idle.play();
        mixer.update(rnd() * 3);
        const e = makeEnemy("sorcerer", 0.45, 1.9, K.hp);
        const s: S = {
          i, kind, wrap, mixer, act, cur: "Idle", mats, halo: halo!, tip: tip ?? obj, e, dc: null as unknown as Decoy,
          state: "idle", t: rnd() * 4, tx: 0, tz: 0, yaw: rnd() * 6.28, home: i % houses.length, scan: rnd() * 0.3, cd: 0, cast: -1, spell: 0, fired: false,
          tgt: null, tgtPlayer: false, tpx: 0, tpz: 0, tvx: 0, tvz: 0, lastHp: K.hp, hostile: 0, hitT: 0, slot: i,
        };
        s.dc = {
          id: e.id, x: 0, y: 0, z: 0, alive: true,
          hit: (dmg, fromX, fromZ) => {
            if (s.state === "dead" || s.state === "inside") return;
            e.hp -= dmg;
            s.lastHp = e.hp;
            e.pain = 0.2;
            const l = Math.hypot(e.x - fromX, e.z - fromZ) || 1;
            e.vx += ((e.x - fromX) / l) * 2.5; e.vz += ((e.z - fromZ) / l) * 2.5;
            fx.sparks.burst(_p.set(e.x, e.y + 1.2, e.z), COL.halo, 6, 3, 0.04);
          },
        };
        // start spread over the plaza
        const a = rnd() * Math.PI * 2, r = 4 + rnd() * (PLAZA_R - 2);
        e.x = C.x + Math.cos(a) * r; e.z = C.z + Math.sin(a) * r; e.y = heightAt(e.x, e.z);
        wrap.position.set(e.x, e.y, e.z); // the frame loop skips the menu / far away: never leave them at the origin
        wrap.rotation.y = s.yaw;
        enemies.push(e);
        decoys.push(s.dc);
        mine.push(s);
      }
      list.current = mine;
      if (typeof window !== "undefined") Object.assign(((window as unknown as { __dbg?: Record<string, unknown> }).__dbg ??= {}), { sorcerers: mine, raids, raidNow: () => { raidT.current = 0; } });
    }).catch((err) => console.error("sorcerers failed to load", err));
    return () => {
      dead = true;
      for (const s of mine) {
        const i = enemies.indexOf(s.e);
        if (i >= 0) enemies.splice(i, 1);
        const j = decoys.indexOf(s.dc);
        if (j >= 0) decoys.splice(j, 1);
      }
      list.current = [];
    };
  }, [fx]);

  useFrame(({ clock }, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const phase = useGame.getState().phase;
    if (phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map") return;
    const ss = list.current;
    const g = root.current;
    if (!g || !ss.length) return;
    const pv = Math.hypot(pose.x - C.x, pose.z - C.z);
    g.visible = pv < SIM;
    if (!g.visible) return;
    const time = clock.elapsedTime;
    const houses = facelessHouses();
    const R = C.fence;

    // ---- raids: send a pack of minions at the village every minute or so while the player is around ----
    raidT.current -= dt;
    if (raidT.current <= 0 && pv < 170) {
      raidT.current = 55 + rnd() * 30;
      for (let k = 0; k < 8; k++) {
        const a = rnd() * Math.PI * 2;
        const x = C.x + Math.cos(a) * (R + 30), z = C.z + Math.sin(a) * (R + 30);
        if (wetAt(x, z, 2)) continue;
        raids.push({ x, z, n: 3 + Math.floor(rnd() * 3), tx: C.x, tz: C.z });
        break;
      }
    }
    // ---- ritual cycle: 22 s of every 60 s idle sorcerers gather around the rune circle ----
    ritualT.current = (ritualT.current + dt) % 60;
    const gathering = ritualT.current > 30 && ritualT.current < 52;
    let gathered = 0, fighting = 0;
    let threat = false;
    for (const e of enemies) if (isMinion(e) && Math.hypot(e.x - C.x, e.z - C.z) < R + 14) { threat = true; break; }

    for (const s of ss) {
      const e = s.e;
      const K = KIND[s.kind];
      const play = (name: string, fade = 0.25) => {
        if (s.cur === name) return;
        const next = s.act[name];
        if (!next) return;
        next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
        s.act[s.cur]?.fadeOut(fade);
        s.cur = name;
      };
      const pd = Math.hypot(pose.x - e.x, pose.z - e.z);

      // ---- damage bookkeeping: hp lost outside our own decoy path came from the player ----
      if (s.state !== "dead" && s.state !== "inside") {
        if (e.burn > 0) { e.burn -= dt; e.hp -= e.burnDps * dt; }
        if (e.hp < s.lastHp - 0.01) {
          for (const o of ss) if (o === s || Math.hypot(o.e.x - e.x, o.e.z - e.z) < 30) o.hostile = HOSTILE_T;
          s.hitT = 0.35;
        }
        s.lastHp = e.hp;
        if (e.hp <= 0) {
          s.state = "dead"; s.t = 0; e.alive = false; s.cast = -1;
          for (const a of Object.values(s.act)) a.fadeOut(0.15);
          s.act.Death.reset().setEffectiveWeight(1).fadeIn(0.1).play();
          s.cur = "Death";
          fx.sparks.burst(_p.set(e.x, e.y + 1.4, e.z), COL.halo, 30, 5, 0.05);
          spawnFade(fx.flashes, e.x, e.y + 1.4, e.z, 2.2, 0.6, COL.halo);
        }
      }
      s.hostile = Math.max(0, s.hostile - dt);
      s.halo.color.copy(s.hostile > 0 ? COL.angry : COL.halo);
      e.pain = Math.max(0, e.pain - dt);
      s.hitT -= dt;
      s.cd -= dt;

      let mx = 0, mz = 0, pace = 0;
      const goTo = (x: number, z: number) => {
        routeVia(e.x, e.z, x, z, _via);
        const ddx = _via[0] - e.x, ddz = _via[1] - e.z;
        const l = Math.hypot(ddx, ddz) || 1;
        mx = ddx / l; mz = ddz / l;
        return Math.hypot(x - e.x, z - e.z);
      };
      const face = (x: number, z: number) => { s.yaw = Math.atan2(x - e.x, z - e.z); };

      // ---- target scan ----
      s.scan -= dt;
      if (s.scan <= 0 && s.state !== "dead") {
        s.scan = 0.3;
        let best: Enemy | null = null, bd = SIGHT;
        for (const o of enemies) {
          if (!isMinion(o) || Math.hypot(o.x - C.x, o.z - C.z) > R + 25) continue;
          const d = Math.hypot(o.x - e.x, o.z - e.z);
          if (d < bd) { bd = d; best = o; }
        }
        const wantPlayer = s.hostile > 0 && pd < SIGHT && pd < bd;
        if (best || wantPlayer) {
          if (s.state === "inside" && s.t > 1) s.t = 0.4 + rnd(); // hurry out
          else if (s.state !== "inside") {
            if (s.state !== "fight") { s.state = "fight"; s.cd = 0.4 + rnd() * 0.8; }
            if (best !== s.tgt || wantPlayer !== s.tgtPlayer) { s.tvx = s.tvz = 0; s.tpx = wantPlayer ? pose.x : best!.x; s.tpz = wantPlayer ? pose.z : best!.z; }
            s.tgt = wantPlayer ? null : best;
            s.tgtPlayer = wantPlayer;
          }
        } else if (s.state === "fight" && s.cast < 0) { s.state = "idle"; s.t = 1 + rnd() * 2; s.tgt = null; s.tgtPlayer = false; }
      }

      // ---- brain ----
      s.t -= dt;
      switch (s.state) {
        case "idle":
          if (s.t <= 0) {
            const roll = rnd();
            if (gathering && roll < 0.75) s.state = "gather";
            else if (roll < 0.3 && !threat) { s.state = "enter"; s.home = (s.i + Math.floor(rnd() * 3)) % houses.length; }
            else {
              s.state = "walk"; s.t = 14;
              const a = rnd() * Math.PI * 2, r = 3.5 + rnd() * (PLAZA_R + 2);
              s.tx = C.x + Math.cos(a) * r; s.tz = C.z + Math.sin(a) * r;
            }
          }
          break;
        case "walk":
          pace = K.walk;
          if (goTo(s.tx, s.tz) < 0.8 || s.t <= 0) { s.state = "idle"; s.t = 2 + rnd() * 6; }
          break;
        case "enter": {
          pace = K.walk;
          const [dx, dz] = houses[s.home].door;
          if (goTo(dx, dz) < 0.7) { s.state = "inside"; s.t = 8 + rnd() * 14; s.wrap.visible = false; e.alive = false; }
          break;
        }
        case "inside":
          if (s.t <= 0) {
            const h = houses[s.home];
            e.x = h.door[0]; e.z = h.door[1]; e.y = heightAt(e.x, e.z);
            s.yaw = h.ry; s.wrap.visible = true; e.alive = true;
            s.state = "walk"; s.t = 10;
            const a = rnd() * Math.PI * 2, r = 4 + rnd() * PLAZA_R;
            s.tx = C.x + Math.cos(a) * r; s.tz = C.z + Math.sin(a) * r;
          }
          break;
        case "gather": {
          const a = (s.slot / N) * Math.PI * 2 + 0.3;
          const gx = C.x + Math.cos(a) * 5.2, gz = C.z + Math.sin(a) * 5.2;
          if (Math.hypot(gx - e.x, gz - e.z) > 0.6) { pace = K.walk; goTo(gx, gz); }
          else { face(C.x, C.z); gathered++; }
          if (!gathering) { s.state = "idle"; s.t = 1 + rnd() * 3; }
          break;
        }
        case "fight": {
          fighting++;
          const tg = s.tgt;
          if (!s.tgtPlayer && (!tg || !tg.alive)) { s.state = "idle"; s.t = 1; s.tgt = null; break; }
          const tx = s.tgtPlayer ? pose.x : tg!.x, tz = s.tgtPlayer ? pose.z : tg!.z;
          const ty = s.tgtPlayer ? pose.y + 1.1 : tg!.y + tg!.h * 0.5;
          // smoothed target velocity, for leading shots
          const k = Math.min(1, dt * 4);
          s.tvx += ((tx - s.tpx) / Math.max(dt, 1e-3) - s.tvx) * k;
          s.tvz += ((tz - s.tpz) / Math.max(dt, 1e-3) - s.tvz) * k;
          s.tpx = tx; s.tpz = tz;
          const dist = Math.hypot(tx - e.x, tz - e.z);
          if (s.cast >= 0) {
            face(tx, tz);
            s.cast += dt;
            const fireAt = s.spell === 0 ? 0.5 : s.spell === 1 ? 0.75 : s.spell === 2 ? 0.38 : 0.45;
            const endAt = s.spell === 0 ? 0.95 : s.spell === 1 ? 1.25 : 0.8;
            const tipP = s.tip.getWorldPosition(_a);
            const charge = Math.min(1, s.cast / fireAt);
            if (!s.fired) {
              const col = s.spell === 0 ? COL.arcane : s.spell === 1 ? COL.frost : COL.palm;
              fx.glows.add(tipP.x, tipP.y, tipP.z, 0.25 + charge * (s.spell === 1 ? 0.75 : 0.5), col, 0.4 + charge * 1.2);
              if (rnd() < dt * 30) {
                // motes swirling into the tip
                _d.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
                fx.sparks.burst(_b.copy(tipP).addScaledVector(_d, 0.6), col, 1, 1.2, 0.03, _d.multiplyScalar(-2), 0.3);
              }
            }
            if (!s.fired && s.cast >= fireAt) {
              s.fired = true;
              if (s.spell <= 1) {
                const orb = s.spell === 1;
                const lead = orb ? Math.max(1.1, dist / 14) : dist / 40;
                const ax = tx + s.tvx * lead * 0.8, az = tz + s.tvz * lead * 0.8;
                const p = fx.projs.find((o) => !o.on);
                if (p) {
                  p.on = true; p.orb = orb; p.x = tipP.x; p.y = tipP.y; p.z = tipP.z; p.hostile = s.tgtPlayer || s.hostile > 0; p.tn = 0;
                  if (orb) {
                    const T = lead;
                    const aty = heightAt(ax, az) + 0.3;
                    p.vx = (ax - p.x) / T; p.vz = (az - p.z) / T; p.vy = (aty - p.y + 0.5 * GRAV * T * T) / T;
                    p.life = T + 1.5;
                  } else {
                    _d.set(ax - p.x, ty - p.y, az - p.z).normalize().multiplyScalar(40);
                    p.vx = _d.x; p.vy = _d.y; p.vz = _d.z; p.life = 1.6;
                  }
                  fx.sparks.burst(tipP, orb ? COL.frost : COL.arcane, 12, 4, 0.04);
                  spawnFade(fx.flashes, tipP.x, tipP.y, tipP.z, orb ? 1.4 : 1, 0.2, orb ? COL.frostCore : COL.arcaneCore);
                }
              } else {
                // palm strike (2) or ground stomp (3)
                const stomp = s.spell === 3;
                const hx = stomp ? e.x : tipP.x, hz = stomp ? e.z : tipP.z;
                const rad = stomp ? 5 : 2.6;
                if (dist < 2.6) {
                  if (s.tgtPlayer) hurtPlayer(stomp ? 14 : 22);
                  else if (tg) hurtMinion(tg, stomp ? 28 : 42, e.x, e.z, 7);
                }
                for (const o of enemies) {
                  if (!isMinion(o) || o === tg) continue;
                  const d = Math.hypot(o.x - hx, o.z - hz);
                  if (d < rad) hurtMinion(o, (stomp ? 22 : 12) * (1 - d / rad * 0.6), hx, hz, stomp ? 9 : 5);
                }
                const gy = heightAt(hx, hz);
                spawnFade(fx.rings, hx, gy + 0.12, hz, rad, stomp ? 0.7 : 0.45, COL.palm);
                if (stomp) spawnFade(fx.rings, hx, gy + 0.15, hz, rad * 0.6, 0.45, COL.halo);
                spawnFade(fx.flashes, tipP.x, tipP.y, tipP.z, stomp ? 2.4 : 1.6, 0.3, COL.palm);
                fx.sparks.burst(tipP, COL.palm, stomp ? 36 : 20, stomp ? 7 : 5, 0.05);
                fx.blasts.add(_b.set(hx, gy + 0.5, hz), stomp ? 2.2 : 1.1, COL.palm, 0.35);
                const f = fx.flash; f.i = Math.max(f.i, stomp ? 1 : 0.7); f.x = hx; f.y = gy + 1.2; f.z = hz;
              }
            }
            if (s.cast >= endAt) { s.cast = -1; s.cd = s.spell === 0 ? 1.4 + rnd() * 0.8 : s.spell === 1 ? 3 + rnd() : 0.5 + rnd() * 0.5; }
            break;
          }
          face(tx, tz);
          if (s.kind === "wizard") {
            // keep a casting distance, never leave the fence
            if (dist > 30) { pace = K.run; goTo(tx, tz); }
            else if (dist < 7) { pace = K.run * 0.7; mx = (e.x - tx) / (dist || 1); mz = (e.z - tz) / (dist || 1); }
            if (s.cd <= 0 && dist < SIGHT) {
              const eye = _b.set(e.x, e.y + 1.5, e.z);
              _d.set(tx - eye.x, ty - eye.y, tz - eye.z);
              const L = _d.length();
              _d.divideScalar(L || 1);
              const los = terrainRay(eye, _d, L) >= L - 0.6;
              s.spell = los && (dist < 14 || rnd() < 0.65) ? 0 : 1;
              s.cast = 0; s.fired = false;
              const name = s.spell === 0 ? "Spell1" : "Spell2";
              s.act[name].reset();
              s.cur = s.cur === name ? "" : s.cur;
            }
          } else {
            const leash = Math.hypot(tx - C.x, tz - C.z) < R + 14;
            if (dist > 1.7 && leash) { pace = K.run; goTo(tx, tz); }
            else if (!leash && Math.hypot(e.x - C.x, e.z - C.z) > R - 4) { pace = K.walk; goTo(C.x, C.z); }
            if (s.cd <= 0 && dist < 2.1) {
              const near = enemies.reduce((n, o) => n + (isMinion(o) && Math.hypot(o.x - e.x, o.z - e.z) < 4.5 ? 1 : 0), 0);
              s.spell = near >= 2 || rnd() < 0.25 ? 3 : 2;
              s.cast = 0; s.fired = false;
              const name = s.spell === 3 ? "Attack2" : "Attack";
              s.act[name].reset();
              s.cur = s.cur === name ? "" : s.cur;
            }
          }
          break;
        }
        case "dead":
          if (s.t > 3) s.wrap.position.y = e.y - (s.t - 3) * 0.4;
          if (s.t > 6) s.wrap.visible = false;
          if (s.t > RESPAWN) {
            // a new one steps out of a house
            const h = houses[Math.floor(rnd() * houses.length)];
            s.home = houses.indexOf(h);
            e.x = h.door[0]; e.z = h.door[1]; e.y = heightAt(e.x, e.z);
            e.hp = e.maxHp; e.alive = true; e.burn = 0; e.vx = e.vz = 0; s.lastHp = e.hp; s.hostile = 0;
            s.yaw = h.ry; s.wrap.visible = true; s.state = "walk"; s.t = 10;
            s.tx = C.x + (rnd() - 0.5) * 12; s.tz = C.z + (rnd() - 0.5) * 12;
            s.act.Death.stop(); s.act.Idle.reset().play(); s.cur = "Idle";
            spawnFade(fx.rings, e.x, e.y + 0.1, e.z, 2.2, 0.9, COL.halo);
          }
          s.t += 2 * dt; // (t counts down by dt above)
          break;
      }

      const alive = s.state !== "dead" && s.state !== "inside";
      s.dc.alive = alive;
      s.dc.x = e.x; s.dc.y = e.y; s.dc.z = e.z;
      if (!alive) {
        if (s.state === "dead") { s.wrap.position.x = e.x; s.wrap.position.z = e.z; if (pd < 140) s.mixer.update(dt); }
        continue;
      }

      // ---- movement ----
      if (s.cast >= 0 && s.kind === "wizard") pace = 0;
      if (e.pain > 0) pace *= 0.4;
      if (mx || mz) {
        let d = Math.atan2(mx, mz) - s.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        s.yaw += d * Math.min(1, dt * 7);
      }
      let sx = 0, sz = 0;
      for (const o of ss) {
        if (o === s || o.state === "dead" || o.state === "inside") continue;
        const ox = e.x - o.e.x, oz = e.z - o.e.z, d2 = ox * ox + oz * oz;
        if (d2 < 1.2 && d2 > 1e-4) { const l = Math.sqrt(d2); sx += (ox / l) * (1.1 - l); sz += (oz / l) * (1.1 - l); }
      }
      e.vx *= Math.exp(-5 * dt); e.vz *= Math.exp(-5 * dt);
      const px = e.x, pz = e.z;
      e.x += (mx * pace + sx * 1.5 + e.vx) * dt;
      e.z += (mz * pace + sz * 1.5 + e.vz) * dt;
      pushOut(e, e.r, e.y);
      if (wetAt(e.x, e.z, -0.3)) { e.x = px; e.z = pz; }
      if (s.kind === "wizard") {
        const r = Math.hypot(e.x - C.x, e.z - C.z);
        if (r > R - 1.5) { e.x = C.x + ((e.x - C.x) / r) * (R - 1.5); e.z = C.z + ((e.z - C.z) / r) * (R - 1.5); }
      }
      e.y += (heightAt(e.x, e.z) - e.y) * Math.min(1, dt * 12);

      // ---- animation ----
      const moved = Math.hypot(e.x - px, e.z - pz) / Math.max(dt, 1e-4);
      if (s.cast >= 0) play(s.spell === 0 ? "Spell1" : s.spell === 1 ? "Spell2" : s.spell === 3 ? "Attack2" : "Attack", 0.1);
      else if (s.hitT > 0) play("RecieveHit", 0.08);
      else if (moved > 0.3 && pace > 0) play(pace > K.walk * 1.5 ? "Run" : "Walk", 0.25);
      else if (s.state === "gather" && gathering) play("Idle_Attacking", 0.5);
      else play("Idle", 0.35);

      s.wrap.position.set(e.x, e.y, e.z);
      s.wrap.rotation.set(0, s.yaw, 0);
      setShadow(s.wrap, pd < 60);
      if (pd < 140) s.mixer.update(dt);
      const flash = e.pain > 0 ? 1 : 0;
      for (const m of s.mats) m.color.setRGB(1 + flash * 1.5, 1 + flash * 0.6, 1 + flash * 2);
      // a faint ever-present glow at the staff / fist
      if (pd < 120) {
        const tp = s.tip.getWorldPosition(_a);
        fx.glows.add(tp.x, tp.y, tp.z, s.kind === "wizard" ? 0.32 : 0.16, s.kind === "wizard" ? COL.arcane : COL.palm, 0.35 + 0.1 * Math.sin(time * 3 + s.i));
      }
    }
    ritual.gathered = gathered;
    ritual.battle = Math.min(1, fighting / 3);

    // ---- projectiles ----
    fx.streaks.begin();
    for (const p of fx.projs) {
      if (!p.on) continue;
      p.life -= dt;
      if (p.orb) p.vy -= GRAV * dt;
      const L = Math.hypot(p.vx, p.vy, p.vz) * dt;
      _a.set(p.x, p.y, p.z);
      _d.set(p.vx, p.vy, p.vz).normalize();
      let tHit = Math.min(terrainRay(_a, _d, L), L + 1);
      let hit: Enemy | null = null, hitPlayer = false;
      for (const o of enemies) {
        if (!isMinion(o)) continue;
        const r = rayEnemy(o, p.x, p.y, p.z, _d.x, _d.y, _d.z, p.orb ? 0.35 : 0.2);
        if (r && r[0] < tHit && r[0] <= L) { tHit = r[0]; hit = o; }
      }
      if (p.hostile) {
        const t = raySphere(p.x, p.y, p.z, _d.x, _d.y, _d.z, pose.x, pose.y + 1.0, pose.z, 0.6);
        if (t >= 0 && t <= L && t < tHit) { tHit = t; hit = null; hitPlayer = true; }
      }
      const boom = tHit <= L || p.life <= 0;
      const step = Math.min(tHit, L);
      p.x += _d.x * step; p.y += _d.y * step; p.z += _d.z * step;
      // trail history
      p.trail.copyWithin(3, 0, (TRAIL - 1) * 3);
      p.trail[0] = p.x; p.trail[1] = p.y; p.trail[2] = p.z;
      p.tn = Math.min(TRAIL, p.tn + 1);
      if (boom) {
        p.on = false;
        _b.set(p.x, p.y, p.z);
        const fl = fx.flash;
        if (p.orb) {
          const rad = 3.6;
          for (const o of enemies) {
            if (!isMinion(o)) continue;
            const d = Math.hypot(o.x - p.x, o.z - p.z, o.y + o.h * 0.5 - p.y);
            if (d < rad) hurtMinion(o, 36 * (1 - (d / rad) * 0.55), p.x, p.z, 6);
          }
          if (p.hostile && Math.hypot(pose.x - p.x, pose.z - p.z, pose.y + 1 - p.y) < rad) hurtPlayer(18);
          const gy = heightAt(p.x, p.z);
          spawnFade(fx.rings, p.x, Math.max(gy, p.y - 1) + 0.12, p.z, rad, 0.6, COL.frost);
          spawnFade(fx.flashes, p.x, p.y, p.z, 3.2, 0.45, COL.frostCore);
          fx.blasts.add(_b, 2.6, COL.frost, 0.5);
          fx.sparks.burst(_b, COL.frostCore, 46, 8, 0.06, _p.set(0, 0.6, 0), 1);
          fl.i = 1.3;
        } else {
          if (hit) hurtMinion(hit, 24, p.x - _d.x, p.z - _d.z, 3.5);
          if (hitPlayer) hurtPlayer(12);
          spawnFade(fx.flashes, p.x, p.y, p.z, 1.6, 0.25, COL.arcaneCore);
          fx.blasts.add(_b, 0.8, COL.arcane, 0.3);
          fx.sparks.burst(_b, COL.arcane, 22, 6, 0.04, _p.copy(_d).multiplyScalar(-0.8), 1);
          fl.i = Math.max(fl.i, 0.8);
        }
        fl.x = p.x; fl.y = p.y + 0.4; fl.z = p.z;
        continue;
      }
      // visuals: hot core, soft halo, tapered trail, shed sparks
      const core = p.orb ? COL.frostCore : COL.arcaneCore, col = p.orb ? COL.frost : COL.arcane;
      fx.glows.add(p.x, p.y, p.z, p.orb ? 0.5 : 0.26, core, 1.4);
      fx.glows.add(p.x, p.y, p.z, p.orb ? 1.4 : 0.8, col, 0.6 + 0.15 * Math.sin(time * 40));
      for (let k = 0; k + 1 < p.tn; k++) {
        _a.fromArray(p.trail, k * 3);
        _b.fromArray(p.trail, k * 3 + 3);
        const f = 1 - k / TRAIL;
        fx.streaks.add(_a, _b, (p.orb ? 0.22 : 0.1) * f, col, 1.6 * f);
      }
      if (rnd() < dt * (p.orb ? 50 : 35)) fx.sparks.burst(_a.set(p.x, p.y, p.z), p.orb ? COL.frostCore : COL.arcane, 1, 1.2, p.orb ? 0.06 : 0.035);
    }
    fx.streaks.end();

    // ---- transient fades ----
    let ri = 0;
    for (const f of fx.rings) {
      if (!f.on) continue;
      f.t += dt;
      if (f.t >= f.dur) { f.on = false; continue; }
      const k = f.t / f.dur, ease = 1 - Math.pow(1 - k, 3);
      _o.position.set(f.x, f.y, f.z); _o.quaternion.identity(); _o.scale.setScalar(Math.max(0.05, f.r * (0.2 + 0.8 * ease))); _o.updateMatrix();
      fx.ringMesh.setMatrixAt(ri, _o.matrix);
      fx.ringMesh.setColorAt(ri, _c.copy(f.c).multiplyScalar(1.6 * (1 - k) * (1 - k)));
      ri++;
    }
    fx.ringMesh.count = ri;
    fx.ringMesh.instanceMatrix.needsUpdate = true;
    if (fx.ringMesh.instanceColor) fx.ringMesh.instanceColor.needsUpdate = true;
    for (const f of fx.flashes) {
      if (!f.on) continue;
      f.t += dt;
      if (f.t >= f.dur) { f.on = false; continue; }
      const k = f.t / f.dur;
      fx.glows.add(f.x, f.y, f.z, f.r * (0.6 + 0.4 * k), f.c, 1.6 * (1 - k));
    }
    fx.glows.end();
    fx.sparks.update(dt);
    fx.blasts.update(dt);
    const fl = fx.flash;
    fl.i *= Math.exp(-7 * dt);
    if (light.current) {
      light.current.intensity = fl.i * 60;
      light.current.position.set(fl.x, fl.y, fl.z);
    }
  });

  return (
    <group>
      <group ref={root} />
      <primitive object={fx.sparks.mesh} />
      <primitive object={fx.blasts.mesh} />
      <primitive object={fx.streaks.mesh} />
      <primitive object={fx.glows.mesh} />
      <primitive object={fx.ringMesh} />
      <pointLight ref={light} color="#b48cff" intensity={0} distance={22} decay={1.8} />
    </group>
  );
}
