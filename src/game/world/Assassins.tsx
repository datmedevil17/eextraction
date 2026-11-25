"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { OASIS_CENTER, OASIS_ROCK_A, WATER_Y, heightAt, oasisT } from "@/game/terrain";
import { pose, ride, useGame } from "@/game/store";
import { enemies, guard, hurtPlayer, makeEnemy, type Enemy } from "@/game/weapons/combat";
import { pushOut } from "./colliders";
import { setShadow } from "./modelKit";
import { planeHud } from "./planeState";

// The rogues of the Oasis of the Assassins. They live around the pond: some keep watch in the shade, some
// walk the shore, some go down to the water to fill a skin (PickUp). Left alone they ignore the player.
// Hurt one and the whole oasis turns on you (`guard.assassins`): the nearest few sprint in with daggers and
// roll away from gunfire. They're in `enemies` (tag "assassin") so they can be shot; dead ones come back later.

const [OX, OZ] = OASIS_CENTER;
const N = 7;
const HEIGHT = 1.78;
const HP = 150;
const ANGER = 75;
const HUNTERS = 4;
const HUNT = 90; // hostile rogues come for a player this close
const LEASH = 140; // ...but never chase further than this from the pond
const WALK = 1.35, RUN = 5.6, REACH = 1.5;
const DMG = 11;
const RESPAWN = 120;
const SHOW = 420;
const ANIM_DIST = 140;
const NOMINAL = { Walk: 1.4, Run: 5.0 }; // guessed m/s of the in-place clips at HEIGHT
const ONCE = new Set(["Dagger_Attack", "Dagger_Attack2", "Death", "PickUp", "Roll", "RecieveHit", "RecieveHit_2", "Punch"]);

/** A point on the oasis bank at angle `a`, where oasisT reaches `t` (palms/grass ring ~1.1-1.6). */
function bank(a: number, t: number): [number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  let r = 8;
  while (r < 160 && oasisT(OX + c * r, OZ + s * r) < t) r += 0.5;
  return [OX + c * r, OZ + s * r];
}
const offRock = (a: number) => Math.abs(Math.atan2(Math.sin(a - OASIS_ROCK_A), Math.cos(a - OASIS_ROCK_A))) > 0.75;

type Kit = { body: THREE.Group; clips: THREE.AnimationClip[]; k: number };
let kitP: Promise<Kit> | null = null;
function loadKit(): Promise<Kit> {
  return (kitP ??= new GLTFLoader().loadAsync("/models/assassins/Rogue.gltf").then((g) => {
    const body = g.scene as THREE.Group;
    // the file is unlit (KHR_materials_unlit): light it like everything else
    body.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const src = m.material as THREE.MeshBasicMaterial;
      m.material = new THREE.MeshStandardMaterial({ name: src.name, map: src.map, color: src.color, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
      m.frustumCulled = false;
    });
    body.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(body);
    return { body, clips: g.animations, k: HEIGHT / Math.max(1e-3, box.max.y - box.min.y) };
  }));
}

type Role = "watch" | "walker" | "water";
type State = "idle" | "walk" | "fetch" | "chase" | "attack" | "roll" | "dead";
type Ro = {
  e: Enemy; wrap: THREE.Group; mixer: THREE.AnimationMixer; act: Record<string, THREE.AnimationAction>; cur: string; mats: THREE.MeshStandardMaterial[];
  role: Role; home: [number, number]; homeA: number; state: State; t: number; yaw: number; tx: number; tz: number;
  lastHp: number; swing: number; hitDone: boolean; clip: string; rollX: number; rollZ: number; route: number; back: boolean;
};

const rnd = Math.random;
const HURT = new THREE.Color(0.9, 0.05, 0.02);
const BLACK = new THREE.Color(0);
const ROLES: Role[] = ["watch", "walker", "water", "watch", "walker", "water", "watch"];

export function Assassins() {
  const root = useRef<THREE.Group>(null);
  const list = useRef<Ro[]>([]);
  const wasAngry = useRef(false);

  useEffect(() => {
    let dead = false;
    const mine: Ro[] = [];
    loadKit().then((kit) => {
      if (dead || !root.current) return;
      for (let i = 0; i < N; i++) {
        const body = cloneSkinned(kit.body) as THREE.Group;
        const mats: THREE.MeshStandardMaterial[] = [];
        const shade = 0.78 + rnd() * 0.22; // a little variety in cloth tone
        body.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const c = (m.material as THREE.MeshStandardMaterial).clone();
          if (!/dagger/i.test(c.name)) c.color.multiplyScalar(shade);
          mats.push(c);
          m.material = c;
          m.frustumCulled = false;
        });
        body.scale.setScalar(kit.k * (0.95 + rnd() * 0.08));
        const wrap = new THREE.Group();
        wrap.add(body);
        root.current.add(wrap);
        const mixer = new THREE.AnimationMixer(body);
        const act: Ro["act"] = {};
        for (const c of kit.clips) {
          const name = c.name.split("|").pop()!;
          const a = mixer.clipAction(c);
          if (ONCE.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
          act[name] = a;
        }
        act.Idle?.play();
        mixer.update(rnd() * 3);

        // spread them round the pond, away from the rock face
        let a = (i / N) * Math.PI * 2 + 0.5;
        while (!offRock(a)) a += 0.3;
        const role = ROLES[i % ROLES.length];
        const home = bank(a, role === "watch" ? 1.35 : 1.2);
        const e = makeEnemy("assassin", 0.35, HEIGHT, HP);
        e.x = home[0]; e.z = home[1]; e.y = heightAt(e.x, e.z);
        const yaw = Math.atan2(OX - e.x, OZ - e.z) + Math.PI; // watchers look out over the dunes
        const ro: Ro = {
          e, wrap, mixer, act, cur: "Idle", mats, role, home, homeA: a, state: "idle", t: 2 + rnd() * 8, yaw, tx: e.x, tz: e.z,
          lastHp: HP, swing: 0, hitDone: false, clip: "", rollX: 0, rollZ: 0, route: a, back: false,
        };
        wrap.position.set(e.x, e.y, e.z); // placed now: the frame loop is skipped in the menu
        wrap.rotation.y = yaw;
        enemies.push(e);
        mine.push(ro);
      }
      list.current = mine;
    }).catch((err) => console.error("assassins failed to load", err));
    return () => {
      dead = true;
      for (const ro of mine) {
        const i = enemies.indexOf(ro.e);
        if (i >= 0) enemies.splice(i, 1);
      }
      list.current = [];
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const phase = useGame.getState().phase;
    if (phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map") return;
    guard.assassins = Math.max(0, guard.assassins - dt);
    const angry = guard.assassins > 0;
    if (angry && !wasAngry.current) { planeHud.msg = "You drew blood in the oasis — the assassins are hunting you"; planeHud.msgT = 4; }
    wasAngry.current = angry;

    const rs = list.current;
    const g = root.current;
    if (!g || !rs.length) return;
    const pv = Math.hypot(pose.x - OX, pose.z - OZ);
    g.visible = pv < SHOW;
    if (!g.visible) return;
    const playerOk = phase === "playing" && !ride.plane;
    const hunters = new Set<Ro>();
    if (angry && playerOk && pv < LEASH + 30) {
      const alive = rs.filter((r) => r.state !== "dead");
      alive.sort((a, b) => Math.hypot(a.e.x - pose.x, a.e.z - pose.z) - Math.hypot(b.e.x - pose.x, b.e.z - pose.z));
      for (const r of alive.slice(0, HUNTERS)) hunters.add(r);
    }

    for (const ro of rs) {
      const e = ro.e;
      const play = (name: string, fade = 0.2) => {
        if (ro.cur === name || !ro.act[name]) return;
        ro.act[name].reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
        ro.act[ro.cur]?.fadeOut(fade);
        ro.cur = name;
      };
      const once = (name: string, fade = 0.1) => { ro.cur = ro.cur === name ? "" : ro.cur; play(name, fade); return ro.act[name]?.getClip().duration ?? 0.8; };
      const pd = Math.hypot(pose.x - e.x, pose.z - e.z);

      // ---- damage: any hp lost here came from the player ----
      if (ro.state !== "dead") {
        if (e.burn > 0) { e.burn -= dt; e.hp -= e.burnDps * dt; }
        const hurt = e.hp < ro.lastHp - 0.01;
        ro.lastHp = e.hp;
        if (hurt) guard.assassins = ANGER;
        if (e.hp <= 0) {
          ro.state = "dead"; ro.t = 0; e.alive = false; e.burn = 0;
          for (const a of Object.values(ro.act)) a.fadeOut(0.15);
          ro.act.Death?.reset().setEffectiveWeight(1).fadeIn(0.1).play();
          ro.cur = "Death";
        } else if (hurt && ro.state !== "roll" && ro.state !== "attack" && rnd() < 0.4 && ro.act.Roll) {
          // dodge roll, sideways to the line of fire
          const dx = e.x - pose.x, dz = e.z - pose.z, l = Math.hypot(dx, dz) || 1, side = rnd() < 0.5 ? 1 : -1;
          ro.rollX = (-dz / l) * side; ro.rollZ = (dx / l) * side;
          ro.yaw = Math.atan2(ro.rollX, ro.rollZ);
          ro.state = "roll"; ro.swing = once("Roll");
        }
      }
      e.pain = Math.max(0, e.pain - dt);
      const flash = e.pain > 0 ? Math.min(1, e.pain / 0.2) : 0;
      for (const m of ro.mats) m.emissive.copy(BLACK).lerp(HURT, flash * 0.6);

      if (ro.state === "dead") {
        ro.t += dt;
        ro.wrap.position.set(e.x, e.y - Math.max(0, ro.t - 20) * 0.25, e.z);
        ro.wrap.visible = ro.t < 26;
        if (pd < ANIM_DIST && ro.wrap.visible) ro.mixer.update(dt);
        if (ro.t > RESPAWN && pd > 80) {
          e.x = ro.home[0]; e.z = ro.home[1]; e.y = heightAt(e.x, e.z); e.hp = HP; e.alive = true; e.vx = e.vz = 0;
          ro.lastHp = HP; ro.state = "idle"; ro.t = 3; ro.wrap.visible = true;
          ro.act.Death?.stop();
          ro.cur = "";
          play("Idle", 0);
        }
        continue;
      }

      const hunting = hunters.has(ro) && pd < HUNT && Math.hypot(e.x - OX, e.z - OZ) < LEASH;
      if (hunting && (ro.state === "idle" || ro.state === "walk" || ro.state === "fetch")) ro.state = "chase";
      if (!hunting && ro.state === "chase") { ro.state = "walk"; [ro.tx, ro.tz] = ro.home; }

      // ---- brain ----
      let mx = 0, mz = 0, pace = 0;
      const goTo = (x: number, z: number) => {
        const dx = x - e.x, dz = z - e.z, l = Math.hypot(dx, dz) || 1;
        mx = dx / l; mz = dz / l;
        return l;
      };
      ro.t -= dt;
      switch (ro.state) {
        case "idle":
          if (ro.cur !== "PickUp") play(angry ? "Attacking_Idle" : "Idle", 0.3);
          if (ro.t <= 0) {
            if (ro.role === "walker") {
              // next waypoint along the shore path (skipping the rock face)
              ro.route += (0.35 + rnd() * 0.35) * (ro.homeA % 2 > 1 ? 1 : -1);
              while (!offRock(ro.route)) ro.route += 0.4 * (ro.homeA % 2 > 1 ? 1 : -1);
              [ro.tx, ro.tz] = bank(ro.route, 1.15 + rnd() * 0.2);
              ro.state = "walk"; ro.t = 40;
            } else if (ro.role === "water") {
              if (ro.back) { ro.back = false; [ro.tx, ro.tz] = ro.home; ro.state = "walk"; ro.t = 40; }
              else { [ro.tx, ro.tz] = bank(ro.homeA + (rnd() - 0.5) * 0.3, 0.99); ro.state = "fetch"; ro.t = 40; }
            } else {
              // watcher: shift a few steps, turn to scan another stretch of desert
              const a = ro.homeA + (rnd() - 0.5) * 0.12;
              [ro.tx, ro.tz] = bank(a, 1.3 + rnd() * 0.12);
              ro.state = "walk"; ro.t = 20;
            }
          }
          break;
        case "walk":
          pace = WALK;
          if (goTo(ro.tx, ro.tz) < 0.7 || ro.t <= 0) {
            ro.state = "idle"; ro.t = ro.role === "watch" ? 10 + rnd() * 14 : ro.role === "water" ? 15 + rnd() * 20 : 3 + rnd() * 6;
            ro.yaw = ro.role === "watch" ? Math.atan2(e.x - OX, e.z - OZ) + (rnd() - 0.5) * 0.9 : ro.yaw;
          }
          break;
        case "fetch":
          pace = WALK;
          if (goTo(ro.tx, ro.tz) < 0.6 || ro.t <= 0) {
            // kneel at the water's edge, then walk back up
            ro.yaw = Math.atan2(OX - e.x, OZ - e.z);
            ro.state = "idle"; ro.t = once("PickUp", 0.25) + 1.5 + rnd() * 2;
            ro.back = true; // then carry it back up to camp
          }
          break;
        case "chase": {
          const d = goTo(pose.x, pose.z);
          pace = RUN;
          if (d < REACH + 0.4 && playerOk) {
            ro.state = "attack";
            ro.clip = rnd() < 0.5 && ro.act.Dagger_Attack2 ? "Dagger_Attack2" : "Dagger_Attack";
            ro.swing = once(ro.clip);
            ro.hitDone = false;
          }
          break;
        }
        case "attack": {
          ro.yaw = Math.atan2(pose.x - e.x, pose.z - e.z);
          ro.swing -= dt;
          const dur = ro.act[ro.clip]?.getClip().duration ?? 0.8;
          if (!ro.hitDone && ro.swing < dur * 0.45) {
            ro.hitDone = true;
            if (pd < REACH + 0.9 && playerOk) hurtPlayer(DMG);
          }
          if (ro.swing <= 0) ro.state = hunting ? "chase" : "idle";
          break;
        }
        case "roll":
          ro.swing -= dt;
          e.x += ro.rollX * 4.5 * dt; e.z += ro.rollZ * 4.5 * dt;
          if (ro.swing <= 0) { ro.state = hunting ? "chase" : "idle"; ro.t = 1; }
          break;
      }

      // ---- movement ----
      if (pace > 0) {
        let dy = Math.atan2(mx, mz) - ro.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        ro.yaw += dy * Math.min(1, dt * 8);
        let sx = 0, sz = 0;
        for (const o of rs) {
          if (o === ro || o.state === "dead") continue;
          const ox = e.x - o.e.x, oz = e.z - o.e.z, q = ox * ox + oz * oz;
          if (q < 1.2 && q > 1e-4) { const l = Math.sqrt(q); sx += (ox / l) * (1.1 - l) * 2; sz += (oz / l) * (1.1 - l) * 2; }
        }
        const nx = e.x + (Math.sin(ro.yaw) * pace + sx) * dt, nz = e.z + (Math.cos(ro.yaw) * pace + sz) * dt;
        if (heightAt(nx, nz) > WATER_Y - 0.45) { e.x = nx; e.z = nz; } // they wade, they don't swim
      }
      if (e.vx || e.vz) {
        e.x += e.vx * dt; e.z += e.vz * dt;
        const k = Math.exp(-6 * dt);
        e.vx *= k; e.vz *= k;
        if (Math.abs(e.vx) + Math.abs(e.vz) < 0.05) e.vx = e.vz = 0;
      }
      pushOut(e, e.r, e.y);
      e.y += (heightAt(e.x, e.z) - e.y) * Math.min(1, dt * 10);

      // ---- animation ----
      if (ro.state === "walk" || ro.state === "fetch" || ro.state === "chase") {
        if (pace > WALK * 1.7) { play("Run", 0.15); ro.act.Run?.setEffectiveTimeScale(pace / NOMINAL.Run); }
        else { play("Walk", 0.25); ro.act.Walk?.setEffectiveTimeScale(pace / NOMINAL.Walk); }
      }

      ro.wrap.visible = pd < 260;
      setShadow(ro.wrap, pd < 50);
      ro.wrap.position.set(e.x, e.y, e.z);
      ro.wrap.rotation.y = ro.yaw;
      if (pd < ANIM_DIST && ro.wrap.visible) ro.mixer.update(dt);
    }
  });

  return <group ref={root} />;
}
