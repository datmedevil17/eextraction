"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { VILLAGE, heightAt } from "@/game/terrain";
import { pose, useGame } from "@/game/store";
import { enemies, guard, makeEnemy, noise, type Enemy } from "@/game/weapons/combat";
import { pushOut } from "./colliders";
import { loadKit, setShadow, type Kit } from "./modelKit";

// Village folk (Quaternius modular men / women, CC0). They stroll along the spoke roads between the
// square and the outer rings, stop to chat in the square or work (Interact) by the road, wave when
// the player walks up, and scatter (run, then cower) when they hear gunfire nearby.
// They can be shot (`enemies`, tag "villager"): hurting one sets `guard.anger` and the knights
// (Knights.tsx) come for the player. The dead lie there a while, then someone new walks in.

const MODELS = ["m_farmer", "m_worker", "m_king", "m_adventurer", "f_medieval", "f_witch", "f_worker", "f_adventurer"];
const PER_MODEL = 4;
const SPOKES = 10; // the village has a road every 36°
const SQUARE_R = 11; // walking ring around the square (between the benches and the market stands)
const WALK = 1.25;
const RUN = 4.6;
const SHOW_DIST = 260;
const ANIM_DIST = 120;
const HP = 60;
const ANGER = 90; // seconds the guard stays after the player once a villager is hurt
const RESPAWN = 120;

type State = "idle" | "walk" | "chat" | "work" | "wave" | "flee" | "cower" | "dead";
type V = {
  g: THREE.Group; mixer: THREE.AnimationMixer; act: Record<string, THREE.AnimationAction>; cur: string;
  x: number; z: number; y: number; yaw: number; spoke: number; r: number;
  path: [number, number][]; state: State; t: number; waveCd: number; speed: number; ph: number;
  e: Enemy; lastHp: number;
};

const rnd = Math.random;
const spokeA = (s: number) => (s * 36 * Math.PI) / 180;
const at = (s: number, r: number): [number, number] => [VILLAGE.x + Math.cos(spokeA(s)) * r, VILLAGE.z + Math.sin(spokeA(s)) * r];

/** Waypoints from (spoke s, radius r) to (spoke t, radius r2): along the road, round the square if needed. */
function route(s: number, r: number, t: number, r2: number): [number, number][] {
  if (s === t) return [at(t, r2)];
  const out: [number, number][] = [at(s, SQUARE_R)];
  let d = (t - s + SPOKES) % SPOKES;
  const dir = d > SPOKES / 2 ? -1 : 1;
  if (dir < 0) d = SPOKES - d;
  for (let i = 1; i <= d; i++) {
    const s0 = s + dir * (i - 1), s1 = s + dir * i;
    // two in-between points so the walk follows the circle instead of cutting across
    for (const f of [1 / 3, 2 / 3, 1]) {
      const a = spokeA(s0) + (spokeA(s1) - spokeA(s0)) * f;
      out.push([VILLAGE.x + Math.cos(a) * SQUARE_R, VILLAGE.z + Math.sin(a) * SQUARE_R]);
    }
  }
  if (r2 > SQUARE_R + 0.5) out.push(at(t, r2));
  return out;
}

/** Run out along the nearest road, away from (fx, fz) (a shooter / whoever hit them). */
function scatter(v: V, fx: number, fz: number) {
  const away = Math.atan2(v.z - fz, v.x - fx);
  let best = 0, bd = 9;
  for (let s = 0; s < SPOKES; s++) { const d = Math.abs(Math.atan2(Math.sin(spokeA(s) - away), Math.cos(spokeA(s) - away))); if (d < bd) { bd = d; best = s; } }
  v.path = [[v.x + Math.cos(away) * 3, v.z + Math.sin(away) * 3], ...route(v.spoke, v.r, best, 70 + rnd() * 30)];
  v.spoke = best;
  v.state = "flee"; v.t = 25;
}

export function Villagers() {
  const root = useRef<THREE.Group>(null);
  const vs = useRef<V[]>([]);
  const seen = useRef(noise.seq);

  useEffect(() => {
    let dead = false;
    Promise.all(MODELS.map((m) => loadKit(`/models/npcs/${m}.glb`, { height: m === "m_king" ? 1.9 : m.startsWith("f_") ? 1.72 : 1.82, yaw: 0 })))
      .then((kits: Kit[]) => {
        if (dead || !root.current) return;
        kits.forEach((kit, mi) => {
          for (let k = 0; k < PER_MODEL; k++) {
            const body = cloneSkinned(kit.template);
            const g = new THREE.Group();
            g.add(body);
            root.current!.add(g);
            const mixer = new THREE.AnimationMixer(body);
            const act: V["act"] = {};
            for (const [n, c] of Object.entries(kit.clips)) {
              act[n] = mixer.clipAction(c);
              if (n === "Wave") { act[n].setLoop(THREE.LoopRepeat, 2); act[n].clampWhenFinished = true; }
              if (n === "Death" || n === "HitRecieve") { act[n].setLoop(THREE.LoopOnce, 1); act[n].clampWhenFinished = true; }
            }
            act.Idle.play();
            mixer.update(rnd() * 3);
            const spoke = Math.floor(rnd() * SPOKES), r = SQUARE_R + rnd() * 80;
            const [x, z] = at(spoke, r);
            g.position.set(x, heightAt(x, z), z); // placed now: the menu skips the update loop
            const e = makeEnemy("villager", 0.32, MODELS[mi].startsWith("f_") ? 1.7 : 1.8, HP);
            e.x = x; e.y = heightAt(x, z); e.z = z;
            enemies.push(e);
            vs.current.push({
              e, lastHp: HP,
              g, mixer, act, cur: "Idle", x, z, y: heightAt(x, z), yaw: rnd() * 6.28, spoke, r, path: [], state: "idle",
              t: rnd() * 4, waveCd: 0, speed: WALK * (0.85 + rnd() * 0.3) * (MODELS[mi] === "m_king" ? 0.8 : 1), ph: rnd(),
            });
          }
        });
      })
      .catch((err) => console.error("villagers failed to load", err));
    return () => {
      dead = true;
      for (const v of vs.current) { const i = enemies.indexOf(v.e); if (i >= 0) enemies.splice(i, 1); }
      vs.current = [];
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const phase = useGame.getState().phase;
    if (phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map") return;
    const pd = Math.hypot(pose.x - VILLAGE.x, pose.z - VILLAGE.z);
    if (root.current) root.current.visible = pd < SHOW_DIST + VILLAGE.r;
    if (pd > SHOW_DIST + VILLAGE.r) return;

    // gunfire within earshot of the village -> everyone near it panics
    const heard = noise.seq !== seen.current;
    if (heard) seen.current = noise.seq;
    const shots = heard && Math.hypot(noise.x - VILLAGE.x, noise.z - VILLAGE.z) < VILLAGE.r + noise.r * 0.5;

    for (const v of vs.current) {
      const play = (name: string, fade = 0.3) => {
        if (v.cur === name || !v.act[name]) return;
        v.act[name].reset().fadeIn(fade).play();
        v.act[v.cur]?.fadeOut(fade);
        v.cur = name;
      };
      const pdx = pose.x - v.x, pdz = pose.z - v.z, pdist = Math.hypot(pdx, pdz);
      v.t -= dt;
      v.waveCd -= dt;

      const e = v.e;
      // ---- damage: anything that took hp off a villager came from the player (weapons, car) ----
      if (v.state !== "dead") {
        if (e.burn > 0) { e.burn -= dt; e.hp -= e.burnDps * dt; }
        e.pain = Math.max(0, e.pain - dt);
        const hurt = e.hp < v.lastHp - 0.01;
        v.lastHp = e.hp;
        if (hurt) guard.anger = ANGER;
        if (e.hp <= 0) {
          e.alive = false; e.burn = 0;
          v.state = "dead"; v.t = 0; v.path = [];
          for (const a of Object.values(v.act)) a.fadeOut(0.15);
          v.act.Death?.reset().setEffectiveWeight(1).fadeIn(0.1).play();
          v.cur = "Death";
        } else if (hurt && v.state !== "flee") {
          v.act.HitRecieve?.reset().setEffectiveWeight(1).fadeIn(0.05).play();
          v.act.HitRecieve?.fadeOut(0.5);
          scatter(v, pose.x, pose.z);
        }
      }
      if (v.state === "dead") {
        v.t += dt;
        v.g.visible = v.t < 25 && pdist < 220;
        if (pdist < ANIM_DIST && v.g.visible) v.mixer.update(dt);
        if (v.t > RESPAWN && pdist > 70) {
          // someone new walks in from the square
          const spoke = Math.floor(rnd() * SPOKES);
          [v.x, v.z] = at(spoke, SQUARE_R);
          v.y = heightAt(v.x, v.z); v.spoke = spoke; v.r = SQUARE_R;
          e.hp = HP; e.alive = true; e.vx = e.vz = 0; v.lastHp = HP;
          v.state = "idle"; v.t = rnd() * 2;
          v.act.Death?.stop();
          v.act.Idle.reset().play(); v.cur = "Idle";
          v.g.position.set(v.x, v.y, v.z);
          e.x = v.x; e.y = v.y; e.z = v.z;
        }
        continue;
      }

      if (shots && v.state !== "flee" && Math.hypot(noise.x - v.x, noise.z - v.z) < noise.r) scatter(v, noise.x, noise.z);

      switch (v.state) {

        case "idle":
        case "chat":
        case "work":
          if (pdist < 5 && v.waveCd <= 0 && phase === "playing") { v.state = "wave"; v.t = 2.6; v.waveCd = 25 + rnd() * 20; break; }
          if (v.t <= 0) {
            const go = rnd();
            if (go < 0.3) {
              // gather in the square
              const t = Math.floor(rnd() * SPOKES);
              v.path = route(v.spoke, v.r, t, SQUARE_R);
              v.spoke = t; v.r = SQUARE_R;
            } else {
              const t = rnd() < 0.5 ? v.spoke : Math.floor(rnd() * SPOKES), r2 = 18 + rnd() * 80;
              v.path = route(v.spoke, v.r, t, r2);
              v.spoke = t; v.r = r2;
            }
            v.state = "walk";
          }
          break;
        case "walk":
          if (!v.path.length) {
            // arrived: chat if someone else is standing close, otherwise loiter or work
            const mate = vs.current.find((o) => o !== v && o.state !== "walk" && o.state !== "flee" && Math.hypot(o.x - v.x, o.z - v.z) < 4);
            if (mate) { v.state = "chat"; v.yaw = Math.atan2(mate.x - v.x, mate.z - v.z); v.t = 8 + rnd() * 10; }
            else if (v.r > 20 && rnd() < 0.45) { v.state = "work"; v.t = 6 + rnd() * 8; v.yaw += (rnd() < 0.5 ? 1 : -1) * Math.PI / 2; }
            else { v.state = "idle"; v.t = 3 + rnd() * 7; }
          }
          break;
        case "wave":
          v.yaw += Math.atan2(Math.sin(Math.atan2(pdx, pdz) - v.yaw), Math.cos(Math.atan2(pdx, pdz) - v.yaw)) * Math.min(1, dt * 5);
          if (v.t <= 0) { v.state = "idle"; v.t = 1 + rnd() * 3; }
          break;
        case "flee":
          if (!v.path.length) { v.state = "cower"; v.t = 8 + rnd() * 6; }
          break;
        case "cower":
          if (v.t <= 0) { v.state = "idle"; v.t = rnd() * 2; }
          break;
      }

      // ---- move along the path ----
      const moving = (v.state === "walk" || v.state === "flee") && v.path.length > 0;
      if (moving) {
        const [tx, tz] = v.path[0];
        const dx = tx - v.x, dz = tz - v.z, d = Math.hypot(dx, dz);
        if (d < 0.6) v.path.shift();
        else {
          let dy = Math.atan2(dx, dz) - v.yaw;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          v.yaw += dy * Math.min(1, dt * 6);
          const sp = v.state === "flee" ? RUN : v.speed;
          // gentle side-step around other villagers
          let sx = 0, sz = 0;
          for (const o of vs.current) {
            if (o === v) continue;
            const ox = v.x - o.x, oz = v.z - o.z, q = ox * ox + oz * oz;
            if (q < 1.2 && q > 1e-4) { const l = Math.sqrt(q); sx += (ox / l) * (1.1 - l); sz += (oz / l) * (1.1 - l); }
          }
          v.x += (Math.sin(v.yaw) * sp + sx) * dt;
          v.z += (Math.cos(v.yaw) * sp + sz) * dt;
          pushOut(v, 0.35, v.y);
        }
      }
      // keep clear of the player
      if (pdist < 0.9 && pdist > 1e-3) { v.x -= (pdx / pdist) * (0.9 - pdist); v.z -= (pdz / pdist) * (0.9 - pdist); }
      // knockback from hits
      if (e.vx || e.vz) {
        v.x += e.vx * dt; v.z += e.vz * dt;
        const k = Math.exp(-6 * dt);
        e.vx *= k; e.vz *= k;
        if (Math.abs(e.vx) + Math.abs(e.vz) < 0.05) e.vx = e.vz = 0;
      }
      v.y += (heightAt(v.x, v.z) - v.y) * Math.min(1, dt * 10);
      e.x = v.x; e.y = v.y; e.z = v.z;

      // ---- animation ----
      if (moving) {
        const run = v.state === "flee";
        play(run ? "Run" : "Walk", 0.25);
        v.act[run ? "Run" : "Walk"]?.setEffectiveTimeScale(run ? 1 : v.speed / WALK);
      } else if (v.state === "wave") play("Wave", 0.2);
      else if (v.state === "work") play("Interact", 0.4);
      else if (v.state === "cower") play("Idle_Neutral", 0.3);
      else if (v.state === "chat") play(Math.sin(performance.now() * 0.0004 + v.ph * 6) > 0.6 ? "Interact" : "Idle", 0.5);
      else play("Idle", 0.4);

      v.g.visible = pdist < 220;
      setShadow(v.g, pdist < 45);
      v.g.position.set(v.x, v.y, v.z);
      v.g.rotation.y = v.yaw;
      if (pdist < ANIM_DIST && v.g.visible) v.mixer.update(dt);
    }
  });

  return <group ref={root} />;
}
