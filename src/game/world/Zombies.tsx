"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { wetAt, biomeWeights, heightAt, nukePoolT, type BiomeWeights } from "@/game/terrain";
import { pose, useGame } from "@/game/store";
import { enemies, hurtPlayer, makeEnemy, noise, useHud, type Enemy } from "@/game/weapons/combat";
import { pushOut } from "./colliders";
import { HOTSPOTS } from "./nukeLayout";

// Zombie Hazmat by LxNazarov (CC-BY-4.0) - Mixamo rig with Idle / Walk / EnemySpotted / Skill clips.
//
// Pooled and streamed: the horde lives in the reactor zone's hotspots. Zombies are only "woken"
// when the player is within ~190 m of a hotspot and are put back to sleep when left far behind.
// Brain:  idle / wander  ->  (see, hear a gunshot, get hurt)  investigate | notice (roar, alert pack)
//         ->  chase -> attack  ->  lost target? search last known spot  ->  return home (leash).
// Variants: walker, runner (fast, fragile), brute (slow, huge, hits hard).

const POOL = 34;
const WAKE_MIN = 45;
const WAKE_MAX = 220;
const SLEEP_DIST = 260;
const LEASH = 170;

type Kind = "walker" | "runner" | "brute";
const KINDS: Record<Kind, { hp: number; speed: number; scale: number; dmg: number; sight: number; tint: [1, 1, 1]; weight: number }> = {
  walker: { hp: 90, speed: 2.1, scale: 1, dmg: 12, sight: 36, tint: [1, 1, 1], weight: 0.62 },
  runner: { hp: 55, speed: 4.6, scale: 0.94, dmg: 8, sight: 46, tint: [1, 1, 1], weight: 0.28 },
  brute: { hp: 330, speed: 2.5, scale: 1.4, dmg: 26, sight: 34, tint: [1, 1, 1], weight: 0.1 },
};
const REACH = 1.7;
const walkTs = (v: number) => Math.min(3, Math.max(0.4, v / 1.5)); // clip speed ~ ground speed -> no foot sliding

type State = "sleep" | "idle" | "wander" | "investigate" | "notice" | "chase" | "attack" | "search" | "return" | "dead";
type Z = {
  e: Enemy;
  obj: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  act: Record<string, THREE.AnimationAction>;
  cur: string;
  kind: Kind;
  state: State;
  t: number;
  yaw: number;
  tx: number;
  tz: number;
  hx: number;
  hz: number;
  lost: number;
  hitDone: boolean;
  dead: number;
  lastHp: number;
  mats: THREE.MeshStandardMaterial[];
  base: THREE.Color[];
};

const rnd = () => Math.random();
// the dead zone fades in over ~320 m: zombies live well inside it, never on the boundary
const SPAWN_NUKE = 0.92;
const ROAM_NUKE = 0.8; // they stop at this line even when chasing
const _zw: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };
const wsum = HOTSPOTS.reduce((a, h) => a + h[3], 0);

function pickKind(): Kind {
  const r = rnd();
  return r < KINDS.walker.weight ? "walker" : r < KINDS.walker.weight + KINDS.runner.weight ? "runner" : "brute";
}

/** A random spot inside a hotspot, at a streaming distance from the player. */
/** Anywhere in the dead zone: a ring around the player (so the whole zone is populated, not just the hotspots). */
function ringPoint(): [number, number] | null {
  for (let i = 0; i < 10; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 40 + rnd() * 90;
    const x = pose.x + Math.cos(a) * d, z = pose.z + Math.sin(a) * d;
    if (biomeWeights(x, z).nuke < SPAWN_NUKE) continue;
    const inNuke = true;
    if (wetAt(x, z, 0.3) || (inNuke && nukePoolT(x, z) < 1.6)) continue;
    const t = { x, z };
    if (pushOut(t, 1.2)) continue;
    return [x, z];
  }
  return null;
}

function wakePoint(): [number, number] | null {
  for (let i = 0; i < 12; i++) {
    let r = rnd() * wsum;
    let h = HOTSPOTS[0];
    for (const c of HOTSPOTS) {
      r -= c[3];
      if (r <= 0) { h = c; break; }
    }
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * h[2];
    const x = h[0] + Math.cos(a) * d, z = h[1] + Math.sin(a) * d;
    const pd = Math.hypot(x - pose.x, z - pose.z);
    if (pd < WAKE_MIN || pd > WAKE_MAX) continue;
    if (biomeWeights(x, z).nuke < SPAWN_NUKE) continue;
    if (wetAt(x, z, 0.3) || nukePoolT(x, z) < 1.6) continue;
    const t = { x, z };
    if (pushOut(t, 1.2)) continue;
    return [x, z];
  }
  return null;
}

export function Zombies() {
  const root = useRef<THREE.Group>(null);
  const zs = useRef<Z[]>([]);
  const tick = useRef(0);
  const seen = useRef(noise.seq);

  useEffect(() => {
    let dead = false;
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/models/zombie.glb").then((gltf) => {
      if (dead || !root.current) return;
      // strip root motion: keep the hips' height bob but pin them horizontally
      for (const clip of gltf.animations) {
        for (const tr of clip.tracks) {
          if (tr.name.startsWith("mixamorig:Hips") && tr.name.endsWith(".position")) {
            const v = tr.values;
            const x0 = v[0], z0 = v[2];
            for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
          }
        }
      }
      const clips = Object.fromEntries(gltf.animations.map((c) => [c.name.replace("Zombie_", ""), c]));
      for (let i = 0; i < POOL; i++) {
        const obj = cloneSkinned(gltf.scene);
        const mats: THREE.MeshStandardMaterial[] = [];
        const base: THREE.Color[] = [];
        obj.traverse((o) => {
          const m = o as THREE.SkinnedMesh;
          if (!m.isMesh) return;
          m.frustumCulled = false;
          m.castShadow = true;
          const mm = (m.material as THREE.MeshStandardMaterial).clone();
          m.material = mm;
          mats.push(mm);
          base.push(mm.color.clone());
        });
        const wrap = new THREE.Group();
        wrap.add(obj);
        wrap.visible = false;
        root.current.add(wrap);
        const mixer = new THREE.AnimationMixer(obj);
        const act: Z["act"] = {};
        for (const k of ["Idle", "Walk_Root", "EnemySpotted", "Skill"]) {
          act[k] = mixer.clipAction(clips[k]);
          if (k === "EnemySpotted" || k === "Skill") act[k].setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
        }
        act.Idle.play();
        const e = makeEnemy("zombie", 0.5, 1.8, 90);
        e.alive = false; // asleep: invisible to hit tests
        enemies.push(e);
        zs.current.push({ e, obj: wrap, mixer, act, cur: "Idle", kind: "walker", state: "sleep", t: 0, yaw: 0, tx: 0, tz: 0, hx: 0, hz: 0, lost: 0, hitDone: false, dead: 0, lastHp: 90, mats, base });
      }
    });
    return () => {
      dead = true;
      for (const z of zs.current) {
        const i = enemies.indexOf(z.e);
        if (i >= 0) enemies.splice(i, 1);
      }
      zs.current = [];
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const phase = useGame.getState().phase;
    const frozen = phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map";
    if (frozen) return;
    const list = zs.current;

    // ---- stream: wake sleepers near hotspots ----
    tick.current -= dt;
    if (tick.current <= 0 && list.length) {
      tick.current = 0.35;
      for (const z of list) {
        if (z.state !== "sleep") continue;
        const p = wakePoint() ?? ringPoint();
        if (!p) break;
        const kind = pickKind();
        const K = KINDS[kind];
        const e = z.e;
        e.x = p[0]; e.z = p[1]; e.y = heightAt(p[0], p[1]);
        e.hp = e.maxHp = K.hp; e.alive = true; e.burn = 0; e.vx = e.vz = 0; e.pain = 0;
        e.r = 0.5 * K.scale; e.h = 1.8 * K.scale;
        z.kind = kind;
        z.lastHp = K.hp;
        z.hx = p[0]; z.hz = p[1];
        z.state = "idle"; z.t = rnd() * 0.6; z.yaw = rnd() * 6.28; z.lost = 0;
        z.obj.scale.setScalar(K.scale);
        z.obj.visible = true;
        z.mats.forEach((m, i) => m.color.copy(z.base[i]).multiply(new THREE.Color(...K.tint)));
        for (const k of Object.keys(z.act)) z.act[k].stop();
        z.act.Idle.reset().play();
        z.cur = "Idle";
        z.mixer.update(rnd() * 3);
        z.act.Idle.setEffectiveTimeScale(0.85 + rnd() * 0.3);
        break; // one per tick keeps the spike small
      }
    }

    // ---- noise (gunshots) ----
    const heard = noise.seq !== seen.current;
    if (heard) seen.current = noise.seq;

    for (const z of list) {
      const e = z.e;
      if (z.state === "sleep") continue;
      const K = KINDS[z.kind];
      const play = (name: string, fade = 0.25, speed = 1) => {
        if (z.cur === name) return;
        const next = z.act[name];
        next.reset().setEffectiveTimeScale(speed).fadeIn(fade).play();
        z.act[z.cur]?.fadeOut(fade);
        z.cur = name;
      };

      const dx = pose.x - e.x, dz = pose.z - e.z;
      const dist = Math.hypot(dx, dz);

      // far behind the player: back to the pool
      if (dist > SLEEP_DIST && z.state !== "chase") {
        z.state = "sleep"; e.alive = false; z.obj.visible = false;
        continue;
      }

      // burning damage over time
      if (e.alive && e.burn > 0) {
        e.burn -= dt;
        e.hp -= e.burnDps * dt;
        if (e.hp <= 0) {
          e.alive = false;
          const h = useHud.getState();
          h.set({ kills: h.kills + 1 });
        }
      }
      if (!e.alive && z.state !== "dead") {
        z.state = "dead";
        z.dead = 0;
        z.act[z.cur]?.fadeOut(0.2);
      }

      if (z.state === "dead") {
        z.dead += dt;
        const f = Math.min(1, z.dead / 0.7);
        z.obj.rotation.set(-Math.PI / 2 * (1 - Math.pow(1 - f, 3)), z.yaw, 0, "YXZ");
        z.obj.position.set(e.x, e.y + 0.15 * f - Math.max(0, z.dead - 5) * 0.4, e.z);
        z.mixer.update(dt * 0.2);
        if (z.dead > 8 || dist > 200) {
          z.state = "sleep"; z.obj.visible = false; e.alive = false;
        }
        continue;
      }

      // ---- senses ----
      e.pain = Math.max(0, e.pain - dt);
      const hurt = e.hp < z.lastHp - 0.01;
      z.lastHp = e.hp;
      const fx = Math.sin(z.yaw), fz = Math.cos(z.yaw);
      const facing = (dx * fx + dz * fz) / (dist || 1); // 1 = dead ahead
      const calm = z.state === "idle" || z.state === "wander" || z.state === "return" || z.state === "search" || z.state === "investigate";
      const sees = dist < K.sight * (facing > 0.1 ? 1 : 0.3) && (facing > -0.35 || dist < 7);
      if (calm && (sees || hurt || dist < 4)) {
        z.state = "notice"; z.tx = 0; z.t = z.kind === "brute" ? 1.3 : 0.9;
        play("EnemySpotted", 0.15);
        // roar alerts the pack
        for (const o of list) {
          if (o === z || (o.state !== "idle" && o.state !== "wander" && o.state !== "return")) continue;
          if (Math.hypot(o.e.x - e.x, o.e.z - e.z) < 24) { o.state = "investigate"; o.tx = pose.x; o.tz = pose.z; o.t = 8; }
        }
      } else if (heard && calm && z.state !== "investigate") {
        const nd = Math.hypot(noise.x - e.x, noise.z - e.z);
        if (nd < noise.r) {
          z.state = nd < 22 ? "notice" : "investigate";
          z.tx = noise.x; z.tz = noise.z; z.t = nd < 22 ? 0.8 : 10;
          if (nd < 22) play("EnemySpotted", 0.15);
        }
      }

      // ---- brain ----
      z.t -= dt;
      let mx = 0, mz = 0, pace = 0;
      const goTo = (x: number, zz: number) => {
        const ddx = x - e.x, ddz = zz - e.z;
        const l = Math.hypot(ddx, ddz) || 1;
        mx = ddx / l; mz = ddz / l;
        return l;
      };
      switch (z.state) {
        case "idle":
          if (z.t <= 0) {
            z.state = "wander"; z.t = 6 + rnd() * 8;
            const a = rnd() * 6.28, r = 8 + rnd() * 30;
            z.tx = z.hx + Math.cos(a) * r; z.tz = z.hz + Math.sin(a) * r;
            play("Walk_Root", 0.4, walkTs(K.speed * 0.75));
          }
          break;
        case "wander":
          pace = 0.75;
          if (goTo(z.tx, z.tz) < 1.5 || z.t <= 0) {
            // mindless: mostly keep shambling to a new spot, only now and then stand and sway
            z.state = "idle";
            z.t = rnd() < 0.3 ? 1.5 + rnd() * 3 : 0.05;
            if (z.t > 0.1) play("Idle", 0.4);
          }
          break;
        case "investigate": {
          pace = 1.15;
          play("Walk_Root", 0.3, walkTs(K.speed * 1.15));
          const d = goTo(z.tx, z.tz);
          if (d < 2 || z.t <= 0) { z.state = "search"; z.t = 4 + rnd() * 3; play("Idle", 0.4); }
          break;
        }
        case "search":
          if (z.t <= 0) { z.state = "return"; play("Walk_Root", 0.4, walkTs(K.speed * 0.8)); }
          break;
        case "return":
          pace = 0.8;
          if (goTo(z.hx, z.hz) < 3) { z.state = "idle"; z.t = 2; play("Idle", 0.4); }
          break;
        case "notice":
          z.yaw = Math.atan2(z.tx ? z.tx - e.x : dx, z.tx ? z.tz - e.z : dz);
          if (z.t <= 0) { z.state = "chase"; z.lost = 0; play("Walk_Root", 0.3, walkTs(K.speed)); }
          break;
        case "chase": {
          pace = 1;
          goTo(pose.x, pose.z);
          const home = Math.hypot(e.x - z.hx, e.z - z.hz);
          z.lost = dist > K.sight * 1.8 ? z.lost + dt : 0;
          if (z.lost > 4 || home > LEASH) {
            z.state = "search"; z.tx = pose.x; z.tz = pose.z; z.t = 4;
            play("Idle", 0.4);
          } else if (dist < REACH * K.scale) {
            z.state = "attack"; z.t = 1.5; z.hitDone = false;
            z.act.Skill.reset().play();
            play("Skill", 0.15);
          }
          break;
        }
        case "attack":
          z.yaw = Math.atan2(dx, dz);
          if (!z.hitDone && z.t < 1.0) {
            z.hitDone = true;
            if (dist < (REACH + 0.6) * K.scale) hurtPlayer(K.dmg);
          }
          if (z.t <= 0) {
            z.state = "chase";
            z.act.Skill.fadeOut(0.2);
            z.cur = "Skill";
            play("Walk_Root", 0.2, walkTs(K.speed));
          }
          break;
      }

      // ---- movement ----
      const staggered = e.pain > 0;
      const speed = K.speed * pace * (staggered ? 0.25 : 1);
      if (mx || mz) {
        // soft steering: blend towards the desired heading so turns look shambling
        let want = Math.atan2(mx, mz);
        let d = want - z.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        z.yaw += d * Math.min(1, dt * (z.state === "chase" ? 7 : 4));
        want = z.yaw;
        mx = Math.sin(want); mz = Math.cos(want);
      }
      // separation from other zombies
      let sx = 0, sz = 0;
      for (const o of list) {
        if (o === z || o.state === "sleep" || o.state === "dead") continue;
        const ox = e.x - o.e.x, oz = e.z - o.e.z;
        const d2 = ox * ox + oz * oz;
        if (d2 < 1.6 && d2 > 1e-4) { const l = Math.sqrt(d2); sx += ox / l * (1.3 - l); sz += oz / l * (1.3 - l); }
      }
      e.vx *= Math.exp(-5 * dt);
      e.vz *= Math.exp(-5 * dt);
      const px = e.x, pz = e.z;
      e.x += (mx * speed + sx * 1.5) * dt + e.vx * dt;
      e.z += (mz * speed + sz * 1.5) * dt + e.vz * dt;
      // never walk through the plant / buildings
      const blocked = pushOut(e, 0.5 * K.scale, e.y);
      // water / pools are off limits
      if (wetAt(e.x, e.z, -0.5) || nukePoolT(e.x, e.z) < 0.9 || biomeWeights(e.x, e.z, _zw).nuke < ROAM_NUKE) { e.x = px; e.z = pz; }
      if (blocked && (z.state === "wander" || z.state === "return")) z.t = Math.min(z.t, 0.2);
      e.y += (heightAt(e.x, e.z) - e.y) * Math.min(1, dt * 12);

      z.obj.position.set(e.x, e.y, e.z);
      z.obj.rotation.set(0, z.yaw, 0);
      if (dist < 130) z.mixer.update(dt * (z.state === "wander" || z.state === "return" ? 1 : 1));

      const glow = e.burn > 0 ? 0.6 + Math.sin(performance.now() * 0.03) * 0.2 : 0;
      for (const m of z.mats) {
        m.emissive.setRGB(e.pain > 0 ? 0.9 : glow, e.pain > 0 ? 0.1 : glow * 0.4, 0.05);
        m.emissiveIntensity = e.pain > 0 || glow > 0 ? 1 : 0;
      }
    }
  });

  return <group ref={root} />;
}
