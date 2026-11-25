"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { pose, ride, useGame, useRide } from "@/game/store";
import { hurtPlayer } from "@/game/weapons/combat";
import { atm } from "@/game/atmosphere";
import { terrainHeight } from "@/game/terrain";
import { REACTOR } from "./nukeLayout";
import { dragonMarks } from "./dragonMarks";
import { treesNear } from "./treeObstacles";
import { setBody } from "@/game/physics";
import { ROAR_TIME, makeVoice, mixVoice, playRoar, type Voice } from "./dragonAudio";
import { dragonTargets, makeDragonTarget } from "./dragonHits";
import { ownMaterials } from "./modelKit";
import { sfx } from "@/game/weapons/audio";

// Real, animated dragon models (Sketchfab, CC-BY, see public/models/CREDITS.txt):
//  * the reactor wyrm circles the nuclear zone (flying.glb)
//  * the frost dragon (Tarisland model) and the sand dragon (prowler on foot, flying.glb in the air)
//    roam their territory on foot, then take off, patrol and land again.

type Key = "walk" | "idle" | "fly" | "roar" | "takeoff" | "land" | "turnL" | "turnR" | "alert" | "bite";
const ONCE: Key[] = ["roar", "takeoff", "land", "alert", "bite"];
type Spec = {
  url: string;
  len: number; // longest horizontal extent in metres
  anims: Partial<Record<Key, string>>;
  walkSpeed?: number; // ground speed (m/s) at which the walk clip plays at 1x
  roarScale?: number;
  // clips whose root bone wanders (cinematic flight paths): pin that bone to the idle pose, the code drives the body
  pin?: { bone: string; keys: Key[] };
};

const NUKE: Spec = { url: "/models/dragons/flying.glb", len: 40, anims: { fly: "Flying" } };
const ICE = {
  ground: {
    url: "/models/dragons/tarisland.glb", len: 46, walkSpeed: 6.5, roarScale: 1.9,
    anims: {
      walk: "Qishilong_walk", idle: "Qishilong_stand", fly: "Qishilong_fly2", roar: "Qishilong_attack01",
      takeoff: "Qishilong_up", land: "Qishilong_down", turnL: "Qishilong_turnleft", turnR: "Qishilong_turnright",
      alert: "Qishilong_taitou_02_12_DH", bite: "Qishilong_attack02",
    },
    // fly2 is a 36 s camera flight: the pelvis travels hundreds of metres and spins 360°; up/down leap 18 m and yaw 48°
    pin: { bone: "Bip001_03", keys: ["fly", "takeoff", "land"] },
  } satisfies Spec,
};
const SAND = {
  ground: { url: "/models/dragons/prowler.glb", len: 24, walkSpeed: 6.5, anims: { walk: "Walk" } } satisfies Spec,
  air: { url: "/models/dragons/flying.glb", len: 40, anims: { fly: "Flying" } } satisfies Spec,
};

const trim = (c: THREE.AnimationClip) => {
  // clips cut from one long timeline keep their start offset: shift them to begin at 0
  const k = c.clone();
  let t0 = Infinity;
  k.tracks.forEach((tr) => (t0 = Math.min(t0, tr.times[0])));
  if (t0 > 1e-3) k.tracks.forEach((tr) => { for (let i = 0; i < tr.times.length; i++) tr.times[i] -= t0; });
  k.resetDuration();
  return k;
};

const pinRoot = (c: THREE.AnimationClip, ref: THREE.AnimationClip | undefined, bone: string) => {
  for (const tr of c.tracks) {
    if (!tr.name.startsWith(bone + ".")) continue;
    if (!tr.name.endsWith(".position") && !tr.name.endsWith(".quaternion")) continue;
    const src = ref?.tracks.find((r) => r.name === tr.name) ?? tr;
    const n = tr.getValueSize();
    for (let i = 0; i < tr.times.length; i++) for (let k = 0; k < n; k++) tr.values[i * n + k] = src.values[k];
  }
};

type Model = {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  act: Partial<Record<Key, THREE.AnimationAction>>;
  cur: string;
  spec: Spec;
};

function makeModel(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }, spec: Spec, grounded: boolean): Model {
  const inner = cloneSkinned(gltf.scene) as THREE.Group;
  inner.traverse((o) => {
    o.frustumCulled = false;
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false;
  });
  inner.updateMatrixWorld(true);
  inner.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.update(); });
  const box = new THREE.Box3().setFromObject(inner, true);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  inner.position.set(-c.x, grounded ? -box.min.y : -c.y, -c.z);
  const root = new THREE.Group();
  root.add(inner);
  root.scale.setScalar(spec.len / Math.max(size.x, size.z, 1e-3));
  const mixer = new THREE.AnimationMixer(inner);
  const act: Model["act"] = {};
  const idleClip = spec.anims.idle ? gltf.animations.find((a) => a.name === spec.anims.idle) : undefined;
  for (const [k, name] of Object.entries(spec.anims) as [Key, string][]) {
    const clip = gltf.animations.find((a) => a.name === name);
    if (!clip) continue;
    const c = trim(clip);
    if (spec.pin?.keys.includes(k)) pinRoot(c, idleClip ? trim(idleClip) : undefined, spec.pin.bone);
    const a = mixer.clipAction(c);
    if (ONCE.includes(k)) a.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
    act[k] = a;
  }
  return { root, mixer, act, cur: "", spec };
}

function play(m: Model, key: Key, ts = 1, fade = 0.5) {
  const a = m.act[key] ?? m.act.walk ?? m.act.fly;
  if (!a) return;
  if (m.cur !== key) {
    const prev = m.cur ? m.act[m.cur as Key] : undefined;
    if (prev && prev !== a) prev.fadeOut(fade);
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    m.cur = key;
  }
  a.timeScale = ts;
}
/** 0..1 progress of a one-shot clip (1 when missing) */
const prog = (m: Model, key: Key) => { const a = m.act[key]; if (!a) return 1; return m.cur === key ? Math.min(1, a.time / a.getClip().duration) : 0; };

const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const rr = (a: number, b: number) => a + Math.random() * (b - a);
const paused = () => {
  const p = useGame.getState().phase;
  return p === "menu" || p === "paused" || p === "arsenal" || p === "map";
};

// ---------- reactor wyrm ----------
const CIRCLE_R = 250;
const WYRM_HP = 2200;
const WYRM_RESPAWN = 90; // s after it hits the ground
// hit spheres in the model frame (+Z = nose): x, y, z, r
const WYRM_SPHERES: [number, number, number, number][] = [
  [0, 0, 15, 3.2], [0, 0, 8, 4.5], [0, 0, 0, 5], [0, 0, -8, 4], [0, 0, -15, 3],
  [9, 0.5, 0, 5], [-9, 0.5, 0, 5], [17, 0.5, -2, 4], [-17, 0.5, -2, 4],
];
const _sq = new THREE.Quaternion();
const _sv = new THREE.Vector3();
const _flash = new THREE.Color();

function Wyrm({ id, a0, dir, alt, label }: { id: string; a0: number; dir: 1 | -1; alt: number; label: string }) {
  const gltf = useGLTF(NUKE.url);
  const { m, mats, base } = useMemo(() => {
    const m = makeModel(gltf, NUKE, false);
    const mats = ownMaterials(m.root).filter((mt) => mt.emissive); // own materials: the hit flash must not tint the other wyrm
    return { m, mats, base: mats.map((mt) => mt.emissive.clone()) };
  }, [gltf]);
  const tg = useMemo(() => makeDragonTarget(id, label, WYRM_HP), [id, label]);
  useEffect(() => {
    dragonTargets[id] = tg;
    return () => { delete dragonTargets[id]; };
  }, [id, tg]);
  const voice = useRef<Voice | null>(null);
  const g = useRef<THREE.Group>(null);
  const st = useRef({ a: a0, t: 0, nextRoar: 5, roar: -1, prev: new THREE.Vector3(), init: false, bank: 0, pitch: 0, dead: false, deadT: 0, vx: 0, vy: 0, vz: 0, lit: false });
  const _p = useMemo(() => new THREE.Vector3(), []);
  const _fwd = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt0) => {
    if (paused()) {
      if (voice.current) voice.current.master.gain.value = 0;
      if (!st.current.init && g.current) g.current.visible = false; // never placed yet: it'd sit at the origin (spawn)
      return;
    }
    const dt = Math.min(dt0, 0.05);
    const s = st.current;
    s.t += dt;
    const t = s.t;
    const root = g.current;
    if (!root) return;
    play(m, "fly", 1);
    // hit flash
    tg.flash = Math.max(0, tg.flash - dt);
    if (tg.flash > 0 || s.lit) {
      const k = tg.flash / 0.12;
      mats.forEach((mt, i) => mt.emissive.copy(base[i]).add(_flash.setRGB(1.6 * k, 0.5 * k, 0.3 * k)));
      s.lit = tg.flash > 0;
    }
    if (!tg.alive) {
      // shot down: tumble out of the sky, lie where it fell, come back later
      if (!s.dead) { s.dead = true; s.deadT = 0; s.vx = _fwd.x / dt; s.vy = Math.min(0, _fwd.y / dt); s.vz = _fwd.z / dt; tg.n = 0; sfx.boom(2); }
      const gy = terrainHeight(root.position.x, root.position.z) + 3;
      if (root.position.y > gy) {
        s.vy -= 9.81 * dt;
        s.vx *= Math.exp(-0.3 * dt); s.vz *= Math.exp(-0.3 * dt);
        root.position.x += s.vx * dt; root.position.y = Math.max(gy, root.position.y + s.vy * dt); root.position.z += s.vz * dt;
        root.rotation.x += (0.7 - root.rotation.x) * Math.min(1, dt * 0.8);
        root.rotation.z += dt * 0.6;
        m.mixer.update(dt * 0.4);
        if (root.position.y <= gy) sfx.boom(2.5);
      } else s.deadT += dt;
      dragonMarks[id] = { label: `${label} (down)`, color: "#9dff3a", x: root.position.x, z: root.position.z, cx: REACTOR.x, cz: REACTOR.z, r: CIRCLE_R * 1.3, mode: "down" };
      if (s.deadT > WYRM_RESPAWN) { tg.alive = true; tg.hp = tg.maxHp; s.dead = false; s.init = false; root.rotation.set(0, 0, 0); }
      if (voice.current) voice.current.master.gain.value = 0;
      return;
    }
    m.mixer.update(dt);

    const R = CIRCLE_R * (1 + 0.28 * Math.sin(t * 0.07) + 0.1 * Math.sin(t * 0.19));
    s.a += dir * (30 / R) * dt;
    const cy = terrainHeight(REACTOR.x, REACTOR.z);
    _p.set(REACTOR.x + Math.cos(s.a) * R, cy + alt + Math.sin(t * 0.31) * 8 + Math.sin(t * 0.9) * 2, REACTOR.z + Math.sin(s.a) * R);
    if (!s.init) { s.prev.copy(_p); s.init = true; }
    _fwd.copy(_p).sub(s.prev);
    s.prev.copy(_p);
    if (_fwd.length() > 1e-4) {
      const yaw = Math.atan2(_fwd.x, _fwd.z);
      const dy = wrapA(yaw - root.rotation.y);
      root.rotation.order = "YXZ";
      s.bank += (-dy * 11 - s.bank) * Math.min(1, dt * 1.5);
      s.pitch += (-Math.atan2(_fwd.y, Math.hypot(_fwd.x, _fwd.z)) - s.pitch) * Math.min(1, dt * 2);
      root.rotation.y += dy;
      root.rotation.x = s.pitch;
      root.rotation.z = THREE.MathUtils.clamp(s.bank, -0.55, 0.55);
    }
    root.position.copy(_p);
    root.visible = true;
    // hit spheres follow the body
    _sq.setFromEuler(root.rotation);
    tg.n = WYRM_SPHERES.length;
    WYRM_SPHERES.forEach(([x, y, z, r], i) => {
      _sv.set(x, y, z).applyQuaternion(_sq).add(_p);
      tg.s[i * 4] = _sv.x; tg.s[i * 4 + 1] = _sv.y; tg.s[i * 4 + 2] = _sv.z; tg.s[i * 4 + 3] = r;
    });
    dragonMarks[id] = { label, color: "#9dff3a", x: _p.x, z: _p.z, cx: REACTOR.x, cz: REACTOR.z, r: CIRCLE_R * 1.3, mode: "fly" };

    s.nextRoar -= dt;
    if (s.roar < 0 && s.nextRoar <= 0 && atm.w.nuke > 0.15) {
      s.roar = 0;
      s.nextRoar = 16 + Math.random() * 14;
      voice.current ??= makeVoice();
      playRoar(voice.current);
    } else if (s.nextRoar <= 0 && atm.w.nuke <= 0.15) s.nextRoar = 5;
    if (s.roar >= 0) {
      s.roar += dt;
      if (s.roar > ROAR_TIME) s.roar = -1;
    }
    mixVoice(voice.current, _p, state.camera, 1700);
  });

  return (
    <group ref={g} frustumCulled={false}>
      <primitive object={m.root} />
    </group>
  );
}

// ---------- ground-and-sky dragons ----------
// idle/walk/turn: territory life. alert -> hunt -> bite when the player walks in; takeoff -> fly (-> swoop at the
// player) -> land when bored or out-run. Every transition has its own clip on the Tarisland model; the prowler
// (sand) falls back to walk for whatever it lacks.
type Mode = "idle" | "walk" | "turn" | "alert" | "hunt" | "bite" | "takeoff" | "fly" | "swoop" | "land" | "touchdown";
const AIR: Mode[] = ["takeoff", "fly", "swoop", "land"];
const SENSE = 120; // notices a player on foot this close (inside its territory)
const BITE_R = 24; // jaws reach from the body centre (46 m model)
const TAKEOFF_T = 5;
const BODY_W = 8; // half-width of the walking body incl. wings folded, for tree clearance

const ROAMER_RESPAWN = 120; // s after a shot-down roamer hits the ground
// hit spheres for the prowler on foot (model frame, feet at y=0, +Z = nose); in the air it's the wyrm model (WYRM_SPHERES)
const PROWLER_SPHERES: [number, number, number, number][] = [[0, 5, 8.5, 2.4], [0, 4.6, 4, 3.2], [0, 4.2, 0, 3.6], [0, 3.6, -4.5, 3], [0, 2.6, -9, 2.2]];

function Roamer({ kind, spec, cx, cz, r, pitch, hp }: { kind: "ice" | "sand"; spec: { ground: Spec; air?: Spec }; cx: number; cz: number; r: number; pitch: number; hp?: number }) {
  const gGltf = useGLTF(spec.ground.url);
  const aGltf = useGLTF((spec.air ?? spec.ground).url);
  const { ground, air, mats, base } = useMemo(() => {
    const ground = makeModel(gGltf, spec.ground, true);
    const air = spec.air ? makeModel(aGltf, spec.air, false) : ground;
    // own emissive materials so the hit flash only tints this dragon
    const mats = hp ? [...ownMaterials(ground.root), ...(air !== ground ? ownMaterials(air.root) : [])].filter((mt) => mt.emissive) : [];
    return { ground, air, mats, base: mats.map((mt) => mt.emissive.clone()) };
  }, [gGltf, aGltf, spec, hp]);
  const label = kind === "ice" ? "Frost Dragon" : "Sand Dragon";
  // shootable from the planes (guns / rockets) when it has hit points
  const tg = useMemo(() => (hp ? makeDragonTarget(kind, label, hp) : null), [kind, label, hp]);
  useEffect(() => {
    if (!tg) return;
    dragonTargets[kind] = tg;
    return () => { delete dragonTargets[kind]; };
  }, [kind, tg]);
  const g = useRef<THREE.Group>(null);
  const voice = useRef<Voice | null>(null);
  const S = useRef({
    mode: "idle" as Mode, timer: 3, t: 0, x: cx, z: cz, y: 0, yaw: (cx * 0.013) % 6.28, speed: 0, alt: 0, flyAlt: 90,
    tx: cx, tz: cz, ang: 0, roar: -1, nextRoar: 6, bank: 0, pitchA: 0, init: false,
    after: "walk" as Mode, turnDir: 0, hunt: 0, calm: 0, bit: false, swoopCd: 8,
    dead: false, deadT: 0, vy: 0, lit: false,
  });
  const P = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt0) => {
    if (paused()) {
      if (voice.current) voice.current.master.gain.value = 0;
      if (!S.current.init && g.current) g.current.visible = false; // not placed yet (would sit at the origin)
      return;
    }
    const root = g.current;
    if (!root) return;
    const dt = Math.min(dt0, 0.05);
    const s = S.current;
    s.t += dt;
    const t = s.t;
    const ground0 = (x: number, z: number) => terrainHeight(x, z);
    if (!s.init) { s.init = true; s.y = ground0(s.x, s.z); }
    if (tg) {
      // hit flash
      tg.flash = Math.max(0, tg.flash - dt);
      if (tg.flash > 0 || s.lit) {
        const k = tg.flash / 0.12;
        mats.forEach((mt, i) => mt.emissive.copy(base[i]).add(_flash.setRGB(1.6 * k, 0.5 * k, 0.3 * k)));
        s.lit = tg.flash > 0;
      }
      if (!tg.alive) {
        // shot down: drop out of the sky (or slump where it stands), lie there, come back later at home
        if (!s.dead) { s.dead = true; s.deadT = 0; s.vy = 0; tg.n = 0; sfx.boom(2); setBody(kind, 0, 0, 0, 0, 0, false); }
        const gy = ground0(s.x, s.z) + (air.root.visible ? 3 : 0);
        if (s.y > gy + 0.05) {
          s.vy -= 9.81 * dt;
          s.x += Math.sin(s.yaw) * s.speed * dt; s.z += Math.cos(s.yaw) * s.speed * dt;
          s.speed *= Math.exp(-0.4 * dt);
          s.y = Math.max(gy, s.y + s.vy * dt);
          s.pitchA += (0.7 - s.pitchA) * Math.min(1, dt * 0.8);
          if (s.y <= gy) sfx.boom(2.5);
        } else { s.deadT += dt; s.pitchA *= Math.exp(-2 * dt); }
        s.bank += (1.25 - s.bank) * Math.min(1, dt * 1.5); // rolls onto its side
        root.rotation.order = "YXZ";
        root.rotation.set(s.pitchA, s.yaw, s.bank);
        root.position.set(s.x, s.y, s.z);
        dragonMarks[kind] = { label: `${label} (down)`, color: kind === "ice" ? "#6fe6ff" : "#ffb04a", x: s.x, z: s.z, cx, cz, r, mode: "down" };
        if (voice.current) voice.current.master.gain.value = 0;
        if (s.deadT > ROAMER_RESPAWN) {
          tg.alive = true; tg.hp = tg.maxHp; s.dead = false;
          s.x = cx; s.z = cz; s.y = ground0(cx, cz); s.alt = 0; s.speed = 0; s.bank = 0; s.pitchA = 0; s.mode = "idle"; s.timer = 5; s.calm = 10;
        }
        return;
      }
    }
    const gm = ground;
    // trees have no colliders: keep the 46 m body out of them by planning around the tree layout
    const clearAt = (x: number, z: number, rad: number) => treesNear(x, z, rad) === 0;
    const pathClear = (x0: number, z0: number, x1: number, z1: number) => {
      const L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / 10);
      for (let i = 1; i <= n; i++) if (!clearAt(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n, BODY_W)) return false;
      return true;
    };
    /** a reachable spot in the territory; `air` = landing spot (needs a clearing, path doesn't matter) */
    const pick = (rad: number, airPick = false): [number, number] | null => {
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * 6.283;
        const d = Math.sqrt(Math.random()) * rad;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (terrainHeight(x, z) <= 0.8) continue;
        if (airPick ? clearAt(x, z, BODY_W * 2.2) : clearAt(x, z, BODY_W * 1.4) && pathClear(s.x, s.z, x, z)) return [x, z];
      }
      return null;
    };
    /** heading to walk towards (tx, tz) without entering trees; null = boxed in */
    const detour = (tx: number, tz: number): [number, number] | null => {
      const base = Math.atan2(tx - s.x, tz - s.z);
      const far = Math.min(30, Math.hypot(tx - s.x, tz - s.z));
      for (const off of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4]) {
        const a = base + off;
        const ok = [12, 22, far].every((d) => d < 6 || clearAt(s.x + Math.sin(a) * d, s.z + Math.cos(a) * d, BODY_W));
        if (ok) return [s.x + Math.sin(a) * 30, s.z + Math.cos(a) * 30];
      }
      return null;
    };
    const diffTo = (tx: number, tz: number) => wrapA(Math.atan2(tx - s.x, tz - s.z) - s.yaw);
    const steer = (tx: number, tz: number, rate: number) => {
      const step = THREE.MathUtils.clamp(diffTo(tx, tz), -rate * dt, rate * dt);
      s.yaw += step;
      return step / Math.max(dt, 1e-3);
    };
    const startRoar = () => {
      if (s.roar >= 0) return;
      s.roar = 0;
      voice.current ??= makeVoice();
      playRoar(voice.current, pitch);
    };
    const go = (m: Mode, timer = 0) => { s.mode = m; s.timer = timer; };
    // on the ground, big heading changes are done standing, with the turn clip
    const turnThen = (tx: number, tz: number, next: Mode) => {
      if (Math.abs(diffTo(tx, tz)) > 0.9 && gm.act.turnL) { s.tx = tx; s.tz = tz; s.after = next; go("turn", 4); }
      else { s.tx = tx; s.tz = tz; go(next, next === "hunt" ? s.timer : 0); }
    };
    const takeoff = () => { go("takeoff", TAKEOFF_T); s.flyAlt = rr(70, 115); startRoar(); };

    const dxP = pose.x - s.x, dzP = pose.z - s.z;
    const distP = Math.hypot(dxP, dzP);
    const pHome = Math.hypot(pose.x - cx, pose.z - cz);
    const driving = useRide.getState().on;
    const inPlane = ride.plane; // nothing attacks the plane (for now)
    const intruder = !inPlane && pHome < r * 1.1 && distP < SENSE * (driving ? 0.6 : 1) && pose.y - s.y < 25;
    let turn = 0;
    const prevY = s.y;

    switch (s.mode) {
      case "idle": {
        s.speed += (0 - s.speed) * Math.min(1, dt * 2);
        s.timer -= dt;
        if (intruder && s.calm <= 0) { s.tx = pose.x; s.tz = pose.z; go("alert", 6); s.hunt = 0; break; }
        if (s.timer <= 0) {
          const to = Math.random() < 0.18 ? null : pick(r * 0.85);
          if (to) turnThen(to[0], to[1], "walk"); else takeoff(); // nowhere clear to walk: fly instead
        }
        break;
      }
      case "turn": {
        s.speed += (0 - s.speed) * Math.min(1, dt * 4);
        const d = diffTo(s.tx, s.tz);
        s.turnDir = Math.sign(d);
        s.yaw += THREE.MathUtils.clamp(d, -1.1 * dt, 1.1 * dt);
        s.timer -= dt;
        if (Math.abs(d) < 0.12 || s.timer <= 0) {
          if (s.after === "takeoff") takeoff(); else go(s.after, s.after === "hunt" ? 20 : 0);
        }
        break;
      }
      case "walk": {
        const w = detour(s.tx, s.tz);
        if (!w) { takeoff(); break; }
        turn = steer(w[0], w[1], 0.7);
        const d = Math.hypot(s.tx - s.x, s.tz - s.z);
        s.speed += (6.5 * (Math.abs(turn) > 0.5 ? 0.4 : 1) - s.speed) * Math.min(1, dt * 1.5);
        if (intruder && s.calm <= 0) { s.tx = pose.x; s.tz = pose.z; go("alert", 6); s.hunt = 0; }
        else if (d < 7 || (s.timer -= dt) < -45) { go("idle", rr(12, 26)); if (Math.random() < 0.4) startRoar(); } // timer: detours that never arrive
        break;
      }
      case "alert": {
        // stop, rear the head up at the intruder, roar, then commit
        s.speed += (0 - s.speed) * Math.min(1, dt * 3);
        turn = steer(pose.x, pose.z, 0.8);
        s.timer -= dt;
        if (s.timer < 3.5) startRoar();
        if (s.timer <= 0 || prog(gm, "alert") >= 0.98) { if (distP < SENSE * 1.3) go("hunt", 20); else go("idle", 4); }
        break;
      }
      case "hunt": {
        if (inPlane) { s.calm = 20; go("idle", 3); break; }
        s.hunt += dt;
        s.timer -= dt;
        const d = Math.abs(diffTo(pose.x, pose.z));
        if (d > 1.4 && distP > BITE_R) { s.tx = pose.x; s.tz = pose.z; s.after = "hunt"; go("turn", 3); break; }
        // player hiding in the trees: can't follow on foot, so go up and come down on them
        const w = distP < BITE_R ? [pose.x, pose.z] : detour(pose.x, pose.z);
        if (!w) { s.swoopCd = 1; takeoff(); break; }
        turn = steer(w[0], w[1], 0.9);
        s.speed += ((distP < BITE_R * 1.6 ? 4 : 10) * (Math.abs(turn) > 0.5 ? 0.5 : 1) - s.speed) * Math.min(1, dt * 1.2);
        if (distP < BITE_R && d < 0.6) { go("bite", 0); s.bit = false; break; }
        // out-run, left the territory, or it's been chasing too long: take to the sky and hunt from there
        if (pHome > r * 1.35 || distP > SENSE * 1.6) { s.calm = 20; go("idle", 3); }
        else if (s.hunt > 22) { s.swoopCd = 2; takeoff(); }
        break;
      }
      case "bite": {
        s.speed += (0 - s.speed) * Math.min(1, dt * 5);
        turn = steer(pose.x, pose.z, 0.5);
        const k = prog(gm, "bite");
        if (!s.bit && k > 0.44) {
          s.bit = true;
          const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
          const ahead = (dxP * fx + dzP * fz) / (distP || 1);
          if (distP < BITE_R + 4 && ahead > 0.55 && pose.y - s.y < 12) hurtPlayer(driving ? 25 : 45);
          startRoar();
        }
        if (k >= 0.98 || !gm.act.bite) go("hunt", Math.max(s.timer, 6));
        break;
      }
      case "takeoff": {
        s.timer -= dt;
        const e = TAKEOFF_T - s.timer;
        // crouch + leap first (the clip), then climb out while the wings take over
        const k = THREE.MathUtils.clamp((e - 0.7) / (TAKEOFF_T - 0.7), 0, 1);
        s.speed += ((e < 0.9 ? 0 : 6 + k * 22) - s.speed) * Math.min(1, dt * 1.2);
        s.alt = s.flyAlt * k * k * (3 - 2 * k) + (e > 0.5 && e < 1.4 ? (e - 0.5) * 6 : e >= 1.4 ? 5.4 * (1 - k) : 0);
        if (s.timer <= 0) { go("fly", rr(14, 22)); s.ang = Math.atan2(s.z - cz, s.x - cx); }
        break;
      }
      case "fly": {
        s.timer -= dt;
        s.swoopCd -= dt;
        s.ang += (24 / (r * 0.75)) * dt;
        const pr = r * (0.75 + 0.25 * Math.sin(t * 0.1));
        turn = steer(cx + Math.cos(s.ang + 0.5) * pr, cz + Math.sin(s.ang + 0.5) * pr, 0.6);
        s.speed += (25 - s.speed) * Math.min(1, dt);
        s.alt += (s.flyAlt + Math.sin(t * 0.35) * 14 - s.alt) * Math.min(1, dt * 0.8);
        // a player in its territory gets dive-bombed now and then
        if (!inPlane && s.swoopCd <= 0 && pHome < r * 1.2 && distP < r * 1.6) { go("swoop", 12); s.bit = false; startRoar(); }
        else if (s.timer <= 0) { const to = pick(r * 0.7, true); if (to) { go("land"); [s.tx, s.tz] = to; } else s.timer = 4; }
        break;
      }
      case "swoop": {
        s.timer -= dt;
        const lead = 1.2; // aim a little past the player so it overflies instead of hovering on them
        const tx = pose.x + Math.sin(s.yaw) * 14 * lead, tz = pose.z + Math.cos(s.yaw) * 14 * lead;
        turn = steer(tx, tz, s.bit ? 0.35 : 0.85);
        s.speed += ((s.bit ? 26 : 34) - s.speed) * Math.min(1, dt * 1.2);
        const want = s.bit ? s.flyAlt : THREE.MathUtils.clamp(distP * 0.25, 9, s.flyAlt);
        s.alt += (want - s.alt) * Math.min(1, dt * (s.bit ? 0.6 : 1.1));
        if (inPlane) s.bit = true; // abort the dive
        if (!s.bit && distP < 16 && s.alt < 16) { s.bit = true; hurtPlayer(driving ? 15 : 30); }
        if (!s.bit && distP < 12) s.bit = true; // missed: pull up anyway
        if (s.timer <= 0 || (s.bit && s.alt > s.flyAlt * 0.8)) { s.swoopCd = rr(10, 18); go("fly", rr(8, 14)); s.ang = Math.atan2(s.z - cz, s.x - cx); }
        break;
      }
      case "land": {
        const d = Math.hypot(s.tx - s.x, s.tz - s.z);
        turn = steer(s.tx, s.tz, 0.9);
        const want = THREE.MathUtils.clamp((d - 8) * 0.32, 0, s.flyAlt);
        s.alt += (want - s.alt) * Math.min(1, dt * 1.2);
        s.speed += (THREE.MathUtils.clamp(d * 0.22, 5, 24) - s.speed) * Math.min(1, dt * 1.5);
        // flare: wings back, legs out, the landing clip carries the last few metres
        if (d < 22 && s.alt < 9) go("touchdown", 2);
        break;
      }
      case "touchdown": {
        s.timer -= dt;
        s.speed += (0 - s.speed) * Math.min(1, dt * 2.5);
        s.alt += (0 - s.alt) * Math.min(1, dt * 3.5);
        if (s.timer <= 0 || (prog(gm, "land") >= 0.98 && s.alt < 0.5)) { s.alt = 0; go("idle", intruder ? 1.5 : rr(16, 30)); startRoar(); }
        break;
      }
    }
    s.calm -= dt;

    s.x += Math.sin(s.yaw) * s.speed * dt;
    s.z += Math.cos(s.yaw) * s.speed * dt;
    // never wander off the map edge of its own territory
    const hx = s.x - cx, hz = s.z - cz, hd = Math.hypot(hx, hz);
    if (hd > r * 1.5) { s.x = cx + (hx / hd) * r * 1.5; s.z = cz + (hz / hd) * r * 1.5; }
    const flying = AIR.includes(s.mode) || (s.mode === "touchdown" && s.alt > 1);
    const gy = ground0(s.x, s.z);
    s.y += (Math.max(gy + s.alt, gy) - s.y) * Math.min(1, dt * (flying ? 4 : 8));
    const vy = (s.y - prevY) / Math.max(dt, 1e-3);

    const ahead = ground0(s.x + Math.sin(s.yaw) * 5, s.z + Math.cos(s.yaw) * 5);
    const behind = ground0(s.x - Math.sin(s.yaw) * 5, s.z - Math.cos(s.yaw) * 5);
    const airborne = s.alt > 4 || (s.mode === "takeoff" && s.timer < TAKEOFF_T - 1);
    const wantPitch = flying && airborne ? -Math.atan2(vy, Math.max(s.speed, 6)) * 0.9 : -Math.atan2(ahead - behind, 10) * 0.8;
    s.pitchA += (wantPitch - s.pitchA) * Math.min(1, dt * 3);
    s.bank += (THREE.MathUtils.clamp(-turn * 0.9, -0.5, 0.5) * (flying ? 1 : 0) - s.bank) * Math.min(1, dt * 2);
    root.rotation.order = "YXZ";
    root.rotation.set(s.pitchA, s.yaw, s.bank);
    root.position.set(s.x, s.y, s.z);
    P.set(s.x, s.y, s.z);
    if (tg) {
      // hit spheres follow the body: wyrm-shaped in the air, prowler-shaped on foot
      const sph = flying && airborne && air !== ground ? WYRM_SPHERES : PROWLER_SPHERES;
      _sq.setFromEuler(root.rotation);
      tg.n = sph.length;
      sph.forEach(([x, y, z, rad], i) => {
        _sv.set(x, y, z).applyQuaternion(_sq).add(P);
        tg.s[i * 4] = _sv.x; tg.s[i * 4 + 1] = _sv.y; tg.s[i * 4 + 2] = _sv.z; tg.s[i * 4 + 3] = rad;
      });
    }
    const shown = s.mode === "touchdown" ? "land" : s.mode === "turn" ? (s.after === "hunt" ? "hunt" : "walk") : s.mode;
    dragonMarks[kind] = { label, color: kind === "ice" ? "#6fe6ff" : "#ffb04a", x: s.x, z: s.z, cx, cz, r, mode: shown };
    root.visible = distP < 2400;
    // solid body while on the ground (the player can't walk through it)
    const br = (flying ? spec.air ?? spec.ground : spec.ground).len * 0.16;
    setBody(kind, s.x, s.z, br, s.y - 1, s.y + br * 1.6, !airborne);

    s.nextRoar -= dt;
    if (s.nextRoar <= 0) { s.nextRoar = rr(18, 34); if (distP < 900) startRoar(); }
    if (s.roar >= 0) {
      s.roar += dt;
      if (s.roar > ROAR_TIME) s.roar = -1;
    }
    mixVoice(voice.current, P, state.camera, 1500);

    // which model is shown, and what it plays
    const useAir = flying && airborne && air !== ground;
    ground.root.visible = !useAir;
    if (air !== ground) air.root.visible = useAir;
    const m = useAir ? air : ground;
    if (root.visible) {
      const has = (k: Key) => !!m.act[k];
      const walkTs = THREE.MathUtils.clamp(s.speed / (m.spec.walkSpeed ?? 6.5), 0.3, 1.6);
      if (s.mode === "takeoff" && has("takeoff") && TAKEOFF_T - s.timer < 1.45) play(m, "takeoff", 1, 0.3);
      else if (s.mode === "touchdown" && has("land")) play(m, "land", 1, 0.35);
      else if (flying && airborne) play(m, "fly", s.mode === "swoop" && !s.bit ? 0.6 : 1, 0.6); // dive: wings tucked, slower beat
      else if (s.mode === "bite" && has("bite")) play(m, "bite", 1.5, 0.25);
      else if (s.mode === "alert" && has("alert")) play(m, "alert", 1.3, 0.4);
      else if (s.mode === "turn" && has("turnL")) play(m, s.turnDir >= 0 ? "turnL" : "turnR", 1, 0.3);
      else if (m === ground && !flying && s.roar >= 0 && ground.act.roar && s.mode === "idle") play(m, "roar", ground.spec.roarScale ?? 1);
      else if (s.speed > 0.8) play(m, "walk", walkTs, 0.4);
      else play(m, ground.act.idle ? "idle" : "walk", ground.act.idle ? 1 : 0.05);
      m.mixer.update(dt);
    }
  });

  return (
    <group ref={g} frustumCulled={false}>
      <primitive object={ground.root} />
      {air !== ground && <primitive object={air.root} />}
    </group>
  );
}

export function Dragons() {
  return (
    <Suspense fallback={null}>
      <Wyrm id="nuke" label="Reactor Wyrm" a0={0.6} dir={1} alt={55} />
      <Wyrm id="nuke2" label="Ash Wyrm" a0={3.74} dir={-1} alt={78} />
      <Roamer kind="ice" spec={ICE} cx={-300} cz={-1100} r={230} pitch={1.12} />
      <Roamer kind="sand" spec={SAND} cx={-300} cz={1100} r={230} pitch={0.9} hp={1800} />
    </Suspense>
  );
}
