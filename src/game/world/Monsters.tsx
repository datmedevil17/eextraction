"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { VILLAGE, wetAt, biomeWeights, heightAt, jungleT, type BiomeWeights } from "@/game/terrain";
import { pose, useGame } from "@/game/store";
import { enemies, hurtPlayer, makeEnemy, noise, useHud, type Enemy } from "@/game/weapons/combat";
import { pushOut } from "./colliders";
import { retargetClip, type BoneMap } from "./retarget";
import { setShadow } from "./modelKit";
import { nearestDecoy, raids, routeVia } from "./facelessShared";

// Open-world minions: Quaternius "Bestiary - Dungeon Monsters" Imp + Puglin, animated with the
// Quaternius Universal Animation Library (CC0) retargeted onto their skeleton at load time.
// Each biome gets its own skin: ice = blue, desert = red, normal land = green.
// They roam the ice, desert and meadow (never the nuke zone, never inside the village).

const POOL = 22;
const SPAWN_MIN = 55;
const SPAWN_MAX = 150;
const SLEEP_DIST = 230;
const LEASH = 150;
const VILLAGE_KEEP = VILLAGE.r + 22; // monsters never get closer than this to the village centre

type Biome = "meadow" | "desert" | "ice";
type Kind = "imp" | "puglin";
const SKIN: Record<Kind, Record<Biome, number>> = {
  imp: { desert: 1, meadow: 2, ice: 3 },
  puglin: { meadow: 1, desert: 2, ice: 3 },
};
const KINDS: Record<Kind, { file: string; hp: number; speed: number; scale: number; dmg: number; sight: number; reach: number; r: number; h: number; attack: string; run: string; weight: number }> = {
  imp: { file: "Imp", hp: 140, speed: 3.6, scale: 1.35, dmg: 15, sight: 40, reach: 1.9, r: 0.45, h: 1.42, attack: "Sword_Attack", run: "Jog_Fwd_Loop", weight: 0.55 },
  puglin: { file: "Puglin", hp: 70, speed: 5.2, scale: 1.75, dmg: 9, sight: 46, reach: 1.5, r: 0.4, h: 0.74, attack: "Punch_Cross", run: "Sprint_Loop", weight: 0.45 },
};
const CLIPS = ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Sword_Attack", "Punch_Cross", "Hit_Chest", "Death01"];
const ONCE = new Set(["Sword_Attack", "Punch_Cross", "Hit_Chest", "Death01"]);
const NOMINAL: Record<string, number> = { Walk_Loop: 1.35, Jog_Fwd_Loop: 3.1, Sprint_Loop: 5.6 }; // m/s of the source clips

const MAP: BoneMap = {
  pelvis: "DEF-hips", spine_01: "DEF-spine.001", spine_02: "DEF-spine.002", spine_03: "DEF-spine.003", neck_01: "DEF-neck", Head: "DEF-head",
};
for (const [s, S] of [["l", "L"], ["r", "R"]]) {
  Object.assign(MAP, {
    [`clavicle_${s}`]: `DEF-shoulder.${S}`, [`upperarm_${s}`]: `DEF-upper_arm.${S}`, [`lowerarm_${s}`]: `DEF-forearm.${S}`, [`hand_${s}`]: `DEF-hand.${S}`,
    [`thigh_${s}`]: `DEF-thigh.${S}`, [`calf_${s}`]: `DEF-shin.${S}`, [`foot_${s}`]: `DEF-foot.${S}`, [`ball_${s}`]: `DEF-toe.${S}`,
  });
  for (const f of ["index", "middle", "ring"]) for (const k of [1, 2, 3]) MAP[`${f}_0${k}_${s}`] = `DEF-f_${f}.0${k}.${S}`;
  for (const k of [1, 2, 3]) MAP[`thumb_0${k}_${s}`] = `DEF-thumb.0${k}.${S}`;
}

type State = "sleep" | "idle" | "wander" | "investigate" | "notice" | "chase" | "attack" | "search" | "return" | "dead";
type Model = { scene: THREE.Object3D; clips: Record<string, THREE.AnimationClip>; maps: Record<number, THREE.Texture>; legs: number };
type M = {
  e: Enemy;
  kind: Kind;
  wrap: THREE.Group;
  mixer: THREE.AnimationMixer;
  act: Record<string, THREE.AnimationAction>;
  cur: string;
  mats: THREE.MeshStandardMaterial[];
  state: State;
  t: number;
  hitT: number;
  yaw: number;
  tx: number;
  tz: number;
  hx: number;
  hz: number;
  lost: number;
  hitDone: boolean;
  dead: number;
  lastHp: number;
};

const rnd = Math.random;
const _via: [number, number] = [0, 0];
const _w: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };

function biomeAt(x: number, z: number): Biome | null {
  const w = biomeWeights(x, z, _w);
  if (w.nuke > 0.12 || jungleT(x, z) > 0.2) return null; // nuke zone and jungle belong to the dinos
  if (w.ice >= w.desert && w.ice >= w.meadow) return "ice";
  if (w.desert >= w.meadow) return "desert";
  return "meadow";
}
const nearVillage = (x: number, z: number, pad = 0) => Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < VILLAGE_KEEP + pad;

function spawnPoint(): [number, number, Biome] | null {
  for (let i = 0; i < 10; i++) {
    const a = rnd() * Math.PI * 2;
    const d = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
    const x = pose.x + Math.cos(a) * d, z = pose.z + Math.sin(a) * d;
    if (Math.abs(x) > 1550 || Math.abs(z) > 1550 || nearVillage(x, z, 10)) continue;
    const b = biomeAt(x, z);
    if (!b || wetAt(x, z, 0.4)) continue;
    if (pushOut({ x, z }, 1.2)) continue;
    return [x, z, b];
  }
  return null;
}

async function loadAll(): Promise<Record<Kind, Model>> {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const [ual, ...gl] = await Promise.all([loader.loadAsync("/models/monsters/ual.gltf"), loader.loadAsync("/models/monsters/Imp.glb"), loader.loadAsync("/models/monsters/Puglin.glb")]);
  const src = ual.scene;
  const out = {} as Record<Kind, Model>;
  (["imp", "puglin"] as Kind[]).forEach((kind, i) => {
    const scene = gl[i].scene;
    const clips: Model["clips"] = {};
    for (const name of CLIPS) {
      const c = ual.animations.find((a) => a.name === name);
      if (c) clips[name] = retargetClip(src, c, scene, MAP, ["pelvis", "DEF-hips"], { inPlace: name !== "Death01" });
    }
    const maps: Model["maps"] = {};
    for (const v of [1, 2, 3]) {
      const t = texLoader.load(`/models/monsters/${KINDS[kind].file}_${v}.jpg`);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      maps[v] = t;
    }
    let pelvisY = 0.8;
    scene.traverse((o) => { if (o.name === "pelvis") pelvisY = o.getWorldPosition(new THREE.Vector3()).y; });
    out[kind] = { scene, clips, maps, legs: (pelvisY * KINDS[kind].scale) / 0.92 };
  });
  return out;
}

export function Monsters() {
  const root = useRef<THREE.Group>(null);
  const ms = useRef<M[]>([]);
  const models = useRef<Record<Kind, Model> | null>(null);
  const tick = useRef(0);
  const seen = useRef(noise.seq);

  useEffect(() => {
    let dead = false;
    loadAll().then((mods) => {
      if (dead || !root.current) return;
      models.current = mods;
      for (let i = 0; i < POOL; i++) {
        const kind: Kind = i % 2 === 0 ? "imp" : "puglin";
        const K = KINDS[kind];
        const obj = cloneSkinned(mods[kind].scene);
        const mats: THREE.MeshStandardMaterial[] = [];
        obj.traverse((o) => {
          const m = o as THREE.SkinnedMesh;
          if (!m.isMesh) return;
          m.frustumCulled = false;
          m.castShadow = true;
          const mm = (m.material as THREE.MeshStandardMaterial).clone();
          m.material = mm;
          mats.push(mm);
        });
        obj.scale.setScalar(K.scale);
        const wrap = new THREE.Group();
        wrap.add(obj);
        wrap.visible = false;
        root.current.add(wrap);
        const mixer = new THREE.AnimationMixer(obj);
        const act: M["act"] = {};
        for (const [name, clip] of Object.entries(mods[kind].clips)) {
          act[name] = mixer.clipAction(clip);
          if (ONCE.has(name)) {
            act[name].setLoop(THREE.LoopOnce, 1);
            act[name].clampWhenFinished = true;
          }
        }
        act.Idle_Loop.play();
        const e = makeEnemy(kind, K.r * K.scale, K.h * K.scale, K.hp);
        e.alive = false;
        enemies.push(e);
        ms.current.push({ e, kind, wrap, mixer, act, cur: "Idle_Loop", mats, state: "sleep", t: 0, hitT: 0, yaw: 0, tx: 0, tz: 0, hx: 0, hz: 0, lost: 0, hitDone: false, dead: 0, lastHp: K.hp });
      }
    }).catch((err) => console.error("monsters failed to load", err));
    return () => {
      dead = true;
      for (const m of ms.current) {
        const i = enemies.indexOf(m.e);
        if (i >= 0) enemies.splice(i, 1);
      }
      ms.current = [];
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const phase = useGame.getState().phase;
    if (phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map") return;
    const list = ms.current;
    const mods = models.current;
    if (!mods) return;

    // ---- stream: wake one sleeper per tick somewhere around the player ----
    const wake = (m: M, x: number, z: number, biome: Biome) => {
      const K = KINDS[m.kind];
      const e = m.e;
      e.x = x; e.z = z; e.y = heightAt(x, z);
      e.hp = e.maxHp = K.hp; e.alive = true; e.burn = 0; e.vx = e.vz = 0; e.pain = 0;
      m.lastHp = K.hp;
      m.hx = x; m.hz = z;
      m.state = "idle"; m.t = rnd() * 2; m.yaw = rnd() * 6.28; m.lost = 0; m.hitT = 0;
      const map = mods[m.kind].maps[SKIN[m.kind][biome]];
      for (const mat of m.mats) {
        if (mat.map) { mat.map = map; mat.needsUpdate = true; }
        mat.color.setRGB(1, 1, 1);
      }
      m.wrap.visible = true;
      m.wrap.rotation.set(0, m.yaw, 0);
      for (const a of Object.values(m.act)) a.stop();
      m.act.Idle_Loop.reset().play();
      m.cur = "Idle_Loop";
      m.mixer.update(rnd() * 3);
    };
    tick.current -= dt;
    if (tick.current <= 0) {
      tick.current = 0.45;
      const m = list.find((o) => o.state === "sleep");
      const p = m && spawnPoint();
      if (m && p) wake(m, p[0], p[1], p[2]);
    }
    // ---- raids on the Faceless village (queued by Sorcerers.tsx) ----
    for (const r of raids.splice(0)) {
      for (let i = 0; i < r.n; i++) {
        // a sleeper from the pool, else nudge a calm one already roaming nearby
        const m = list.find((o) => o.state === "sleep") ?? list.find((o) => (o.state === "idle" || o.state === "wander") && Math.hypot(o.e.x - r.tx, o.e.z - r.tz) < 160);
        if (!m) break;
        if (m.state === "sleep") wake(m, r.x + (rnd() - 0.5) * 8, r.z + (rnd() - 0.5) * 8, "ice");
        m.state = "investigate"; m.tx = r.tx; m.tz = r.tz; m.t = 45;
      }
    }

    const heard = noise.seq !== seen.current;
    if (heard) seen.current = noise.seq;
    const playerInVillage = nearVillage(pose.x, pose.z, -4);

    for (const m of list) {
      if (m.state === "sleep") continue;
      const e = m.e;
      const K = KINDS[m.kind];
      const legs = mods[m.kind].legs;
      const play = (name: string, fade = 0.25) => {
        if (m.cur === name) return;
        const next = m.act[name];
        if (!next) return;
        next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
        m.act[m.cur]?.fadeOut(fade); // cur is "" right after a hit flinch
        m.cur = name;
      };

      const pdist = Math.hypot(pose.x - e.x, pose.z - e.z);
      if (pdist > SLEEP_DIST && m.state !== "chase") {
        m.state = "sleep"; e.alive = false; m.wrap.visible = false;
        continue;
      }
      // a Faceless sorcerer closer than the player becomes the target instead (facelessShared.ts)
      const dc = m.state === "dead" ? null : nearestDecoy(e.x, e.z, K.sight, pdist);
      const tgx = dc ? dc.x : pose.x, tgz = dc ? dc.z : pose.z;
      const dx = tgx - e.x, dz = tgz - e.z;
      const dist = Math.hypot(dx, dz);

      if (e.alive && e.burn > 0) {
        e.burn -= dt;
        e.hp -= e.burnDps * dt;
        if (e.hp <= 0) {
          e.alive = false;
          const h = useHud.getState();
          h.set({ kills: h.kills + 1 });
        }
      }
      if (!e.alive && m.state !== "dead") {
        m.state = "dead"; m.dead = 0;
        play("Death01", 0.12);
      }
      if (m.state === "dead") {
        m.dead += dt;
        m.wrap.position.set(e.x, e.y - Math.max(0, m.dead - 5) * 0.35, e.z);
        if (pdist < 140) m.mixer.update(dt);
        for (const mat of m.mats) mat.color.setRGB(1, 1, 1);
        if (m.dead > 8) { m.state = "sleep"; m.wrap.visible = false; }
        continue;
      }

      // ---- senses ----
      e.pain = Math.max(0, e.pain - dt);
      const hurt = e.hp < m.lastHp - 0.01;
      m.lastHp = e.hp;
      if (hurt && m.state !== "attack") { m.hitT = 0.38; m.act.Hit_Chest.reset(); m.cur = m.cur === "Hit_Chest" ? "" : m.cur; }
      const fx = Math.sin(m.yaw), fz = Math.cos(m.yaw);
      const facing = (dx * fx + dz * fz) / (dist || 1);
      const calm = m.state === "idle" || m.state === "wander" || m.state === "return" || m.state === "search" || m.state === "investigate";
      const open = dc !== null || !playerInVillage;
      const sees = open && dist < K.sight * (facing > 0.1 ? 1 : 0.35) && (facing > -0.35 || dist < 8);
      if (calm && (sees || hurt || (dist < 5 && open))) {
        m.state = "notice"; m.t = 0.5;
        for (const o of list) {
          if (o === m || (o.state !== "idle" && o.state !== "wander" && o.state !== "return")) continue;
          if (Math.hypot(o.e.x - e.x, o.e.z - e.z) < 26) { o.state = "investigate"; o.tx = tgx; o.tz = tgz; o.t = 8; }
        }
      } else if (heard && calm && m.state !== "investigate") {
        const nd = Math.hypot(noise.x - e.x, noise.z - e.z);
        if (nd < noise.r) { m.state = "investigate"; m.tx = noise.x; m.tz = noise.z; m.t = 10; }
      }

      // ---- brain ----
      m.t -= dt;
      m.hitT -= dt;
      let mx = 0, mz = 0, pace = 0;
      const goTo = (x: number, zz: number) => {
        const ddx = x - e.x, ddz = zz - e.z;
        const l = Math.hypot(ddx, ddz) || 1;
        mx = ddx / l; mz = ddz / l;
        return l;
      };
      switch (m.state) {
        case "idle":
          if (m.t <= 0) {
            m.state = "wander"; m.t = 6 + rnd() * 8;
            const a = rnd() * 6.28, r = 8 + rnd() * 28;
            m.tx = m.hx + Math.cos(a) * r; m.tz = m.hz + Math.sin(a) * r;
          }
          break;
        case "wander":
          pace = 0.38;
          if (goTo(m.tx, m.tz) < 1.5 || m.t <= 0) { m.state = "idle"; m.t = 1.5 + rnd() * 4; }
          break;
        case "investigate":
          pace = 0.7;
          goTo(...routeVia(e.x, e.z, m.tx, m.tz, _via));
          if (Math.hypot(m.tx - e.x, m.tz - e.z) < 2 || m.t <= 0) { m.state = "search"; m.t = 3 + rnd() * 3; }
          break;
        case "search":
          if (m.t <= 0) m.state = "return";
          break;
        case "return":
          pace = 0.4;
          if (goTo(m.hx, m.hz) < 3) { m.state = "idle"; m.t = 2; }
          break;
        case "notice":
          m.yaw = Math.atan2(dx, dz);
          if (m.t <= 0) { m.state = "chase"; m.lost = 0; }
          break;
        case "chase": {
          pace = 1;
          if (dc) goTo(...routeVia(e.x, e.z, tgx, tgz, _via));
          else goTo(pose.x, pose.z);
          const home = Math.hypot(e.x - m.hx, e.z - m.hz);
          m.lost = dist > K.sight * 1.8 || (!dc && playerInVillage) ? m.lost + dt : 0;
          if (m.lost > 3 || home > LEASH) { m.state = "search"; m.t = 3; }
          else if (dist < K.reach) {
            m.state = "attack"; m.t = m.kind === "imp" ? 1.25 : 0.9; m.hitDone = false;
            m.act[K.attack].reset();
            m.cur = m.cur === K.attack ? "" : m.cur;
          }
          break;
        }
        case "attack":
          m.yaw = Math.atan2(dx, dz);
          if (!m.hitDone && m.t < (m.kind === "imp" ? 0.7 : 0.55)) {
            m.hitDone = true;
            if (dist < K.reach + 0.7) { if (dc) dc.hit(K.dmg, e.x, e.z); else hurtPlayer(K.dmg); }
          }
          if (m.t <= 0) m.state = "chase";
          break;
      }

      // ---- movement ----
      const staggered = e.pain > 0;
      const speed = K.speed * pace * (staggered ? 0.3 : 1);
      if (mx || mz) {
        let d = Math.atan2(mx, mz) - m.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        m.yaw += d * Math.min(1, dt * (m.state === "chase" ? 8 : 4));
        mx = Math.sin(m.yaw); mz = Math.cos(m.yaw);
      }
      let sx = 0, sz = 0;
      for (const o of list) {
        if (o === m || o.state === "sleep" || o.state === "dead") continue;
        const ox = e.x - o.e.x, oz = e.z - o.e.z;
        const d2 = ox * ox + oz * oz;
        if (d2 < 2 && d2 > 1e-4) { const l = Math.sqrt(d2); sx += (ox / l) * (1.45 - l); sz += (oz / l) * (1.45 - l); }
      }
      e.vx *= Math.exp(-5 * dt);
      e.vz *= Math.exp(-5 * dt);
      const px = e.x, pz = e.z;
      e.x += (mx * speed + sx * 1.5) * dt + e.vx * dt;
      e.z += (mz * speed + sz * 1.5) * dt + e.vz * dt;
      const blocked = pushOut(e, e.r, e.y);
      if (wetAt(e.x, e.z, -0.3) || !biomeAt(e.x, e.z)) { e.x = px; e.z = pz; }
      // keep out of the village: slide along its boundary
      const vx = e.x - VILLAGE.x, vz = e.z - VILLAGE.z, vd = Math.hypot(vx, vz);
      if (vd < VILLAGE_KEEP) { e.x = VILLAGE.x + (vx / (vd || 1)) * VILLAGE_KEEP; e.z = VILLAGE.z + (vz / (vd || 1)) * VILLAGE_KEEP; }
      if (blocked && (m.state === "wander" || m.state === "return")) m.t = Math.min(m.t, 0.2);
      e.y += (heightAt(e.x, e.z) - e.y) * Math.min(1, dt * 12);

      // ---- animation ----
      const moved = Math.hypot(e.x - px, e.z - pz) / Math.max(dt, 1e-4);
      if (m.state === "attack") play(K.attack, 0.12);
      else if (m.hitT > 0) play("Hit_Chest", 0.08);
      else if (speed > 0.2 && moved > 0.3) {
        const run = speed > K.speed * 0.55;
        const name = run ? K.run : "Walk_Loop";
        play(name, 0.3);
        m.act[name].setEffectiveTimeScale(Math.min(2.2, Math.max(0.5, moved / (NOMINAL[name] * legs))));
      } else play("Idle_Loop", 0.35);

      m.wrap.position.set(e.x, e.y, e.z);
      m.wrap.rotation.set(0, m.yaw, 0);
      setShadow(m.wrap, pdist < 60);
      if (pdist < 140) m.mixer.update(dt);

      const flash = e.pain > 0 ? 1 : 0;
      const glow = e.burn > 0 ? 0.5 + Math.sin(performance.now() * 0.03) * 0.2 : 0;
      for (const mat of m.mats) mat.color.setRGB(1 + flash * 1.2 + glow, 1 - flash * 0.5 + glow * 0.4, 1 - flash * 0.5);
    }
  });

  return <group ref={root} />;
}
