"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { VILLAGE, wetAt, biomeWeights, heightAt, jungleT, nukePoolT } from "@/game/terrain";
import { ctl, pose, useGame } from "@/game/store";
import { enemies, hurtPlayer, makeEnemy, noise, useHud, type Enemy } from "@/game/weapons/combat";
import { pushOut } from "./colliders";
import { loadKit, ownMaterials, setShadow } from "./modelKit";

// Model-based dinosaurs (Sketchfab, CC-BY / CC0 - see public/models/CREDITS.txt).
//   jungle: T-rex (apex hunter), velociraptor packs (flanking, leaps), stegosaurus herds (graze, flee, tail-whip)
//   nuke:   triceratops skeletons - lie dormant as a heap of bones, rise when you come close, roar, charge.
// Pooled + streamed around the player like the zombies.

type Diet = "apex" | "pack" | "herb" | "undead";
type Zone = "jungle" | "nuke";
type Clips = { idle: string[]; walk: string; run: string; attack: string[]; roar?: string; hurt?: string; death?: string; dormant?: string; rise?: string; eat?: string; leap?: string };
type Spec = {
  id: string; url: string; fit: { len: number; head?: RegExp }; zone: Zone; n: number; group: number; diet: Diet;
  hp: number; r: number; h: number; walk: number; run: number; dmg: number; reach: number; sight: number;
  clips: Clips; nomWalk: number; nomRun: number; atkT: number; turn: number;
};

const SPECS: Spec[] = [
  {
    id: "trex", url: "/models/dinos/trex.glb", fit: { len: 12, head: /bn_Head/ }, zone: "jungle", n: 2, group: 1, diet: "apex",
    hp: 1600, r: 2.3, h: 4.6, walk: 2.6, run: 7.0, dmg: 42, reach: 5.6, sight: 95,
    clips: { idle: ["idle"], walk: "run", run: "run", attack: ["bite", "attack_tail"], roar: "roar" }, nomWalk: 7, nomRun: 7, atkT: 1.7, turn: 1.6,
  },
  {
    id: "raptor", url: "/models/dinos/raptor.glb", fit: { len: 3.6, head: /^Head/ }, zone: "jungle", n: 9, group: 3, diet: "pack",
    hp: 110, r: 0.65, h: 1.7, walk: 1.7, run: 7.8, dmg: 12, reach: 2.3, sight: 58,
    clips: { idle: ["Idle_01", "Idle_02", "Sniff"], walk: "Walk", run: "Sprint", attack: ["Bite_01", "Bite_02"], roar: "Call_Alert", hurt: "Hurt_01", death: "Death_01", leap: "Leap_01", eat: "Eat Prey" },
    nomWalk: 1.7, nomRun: 8, atkT: 1.1, turn: 5,
  },
  {
    id: "stego", url: "/models/dinos/stego.glb", fit: { len: 8, head: /^Head/ }, zone: "jungle", n: 5, group: 3, diet: "herb",
    hp: 900, r: 1.7, h: 3.4, walk: 1.4, run: 5.2, dmg: 30, reach: 6.5, sight: 22,
    clips: { idle: ["IdleA", "IdleB"], walk: "Walk", run: "Run", attack: ["TailWhip"], roar: "Roar", hurt: "HurtA", death: "Death", eat: "Eat" },
    nomWalk: 1.5, nomRun: 5, atkT: 1.9, turn: 1.4,
  },
  // herds of herbivores (Quaternius CC0 animated dinos) - they took over from the old procedural deer/boar/compy
  {
    id: "para", url: "/models/fauna/Parasaurolophus.glb", fit: { len: 7, head: /^Head$/ }, zone: "jungle", n: 8, group: 4, diet: "herb",
    hp: 320, r: 1.2, h: 3.0, walk: 1.6, run: 6.5, dmg: 12, reach: 3.5, sight: 30,
    clips: { idle: ["Armature|Parasaurolophus_Idle"], walk: "Armature|Parasaurolophus_Walk", run: "Armature|Parasaurolophus_Run", attack: ["Armature|Parasaurolophus_Attack"], death: "Armature|Parasaurolophus_Death" },
    nomWalk: 1.6, nomRun: 6.5, atkT: 1.2, turn: 2.2,
  },
  {
    id: "trike", url: "/models/fauna/Triceratops.glb", fit: { len: 8, head: /^Head$/ }, zone: "jungle", n: 5, group: 3, diet: "herb",
    hp: 1100, r: 1.8, h: 2.8, walk: 1.3, run: 6.0, dmg: 35, reach: 4.5, sight: 26,
    clips: { idle: ["Armature|Triceratops_Idle"], walk: "Armature|Triceratops_Walk", run: "Armature|Triceratops_Run", attack: ["Armature|Triceratops_Attack"], death: "Armature|Triceratops_Death" },
    nomWalk: 1.3, nomRun: 6, atkT: 1.4, turn: 1.4,
  },
  {
    id: "apato", url: "/models/fauna/Apatosaurus.glb", fit: { len: 20, head: /^Head$/ }, zone: "jungle", n: 3, group: 3, diet: "herb",
    hp: 3000, r: 3.2, h: 7.5, walk: 1.5, run: 3.8, dmg: 45, reach: 7.5, sight: 20,
    clips: { idle: ["Armature|Apatosaurus_Idle"], walk: "Armature|Apatosaurus_Walk", run: "Armature|Apatosaurus_Run", attack: ["Armature|Apatosaurus_Attack"], death: "Armature|Stegosaurus_Death" },
    nomWalk: 1.5, nomRun: 3.8, atkT: 1.8, turn: 0.8,
  },
  {
    id: "trike_skel", url: "/models/dinos/trike_skel.glb", fit: { len: 8, head: /headtop/ }, zone: "nuke", n: 4, group: 1, diet: "undead",
    hp: 700, r: 1.7, h: 2.6, walk: 1.8, run: 5.4, dmg: 32, reach: 4.6, sight: 40,
    clips: { idle: ["Armature|IdleGround"], walk: "Armature|Walk", run: "Armature|Walk", attack: ["Armature|Roar"], roar: "Armature|Roar", death: "Armature|Fall", dormant: "Armature|IdleGround", rise: "Armature|RiseUp" },
    nomWalk: 1.8, nomRun: 1.8, atkT: 1.4, turn: 1.8,
  },
];

const SPAWN_MIN = 40;
const SPAWN_MAX = 130;
const SLEEP_DIST = 200;
const LEASH = 240;

type State = "sleep" | "dormant" | "rise" | "idle" | "graze" | "wander" | "flee" | "notice" | "chase" | "attack" | "search" | "return" | "dead";
type D = {
  sp: Spec; e: Enemy; wrap: THREE.Group; body: THREE.Object3D; mixer: THREE.AnimationMixer; act: Record<string, THREE.AnimationAction>; cur: string;
  mats: THREE.MeshStandardMaterial[]; state: State; t: number; yaw: number; pitch: number; tx: number; tz: number; hx: number; hz: number;
  lost: number; hitDone: boolean; dead: number; lastHp: number; cd: number; flinch: number; roarCd: number; pack: number; idx: number; leapT: number;
};

const rnd = Math.random;
const pick = <T,>(a: T[]) => a[(rnd() * a.length) | 0];

function inZone(z: Zone, x: number, zz: number, strict = true) {
  if (Math.hypot(x - VILLAGE.x, zz - VILLAGE.z) < VILLAGE.r + 30) return false;
  if (wetAt(x, zz, 0.3)) return false;
  if (z === "jungle") return jungleT(x, zz) > (strict ? 0.35 : 0.08);
  return biomeWeights(x, zz).nuke > (strict ? 0.6 : 0.3) && nukePoolT(x, zz) > 1.6;
}

function spawnPoint(z: Zone): [number, number] | null {
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2;
    const d = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
    const x = pose.x + Math.cos(a) * d, zz = pose.z + Math.sin(a) * d;
    if (!inZone(z, x, zz)) continue;
    if (pushOut({ x, z: zz }, 3)) continue;
    return [x, zz];
  }
  return null;
}

let packSeq = 1;

export function Dinos() {
  const root = useRef<THREE.Group>(null);
  const ds = useRef<D[]>([]);
  const tick = useRef(0);
  const seen = useRef(noise.seq);
  const rr = useRef(0);

  useEffect(() => {
    let dead = false;
    Promise.all(SPECS.map((sp) => loadKit(sp.url, sp.fit).then((kit) => ({ sp, kit })))).then((list) => {
      if (dead || !root.current) return;
      for (const { sp, kit } of list) {
        const once = new Set([...sp.clips.attack, sp.clips.roar, sp.clips.hurt, sp.clips.death, sp.clips.rise, sp.clips.leap].filter(Boolean) as string[]);
        for (let i = 0; i < sp.n; i++) {
          const body = cloneSkinned(kit.template);
          const mats = ownMaterials(body);
          const wrap = new THREE.Group();
          wrap.add(body);
          wrap.visible = false;
          root.current.add(wrap);
          const mixer = new THREE.AnimationMixer(body);
          const act: D["act"] = {};
          for (const [name, clip] of Object.entries(kit.clips)) {
            act[name] = mixer.clipAction(clip);
            if (once.has(name)) { act[name].setLoop(THREE.LoopOnce, 1); act[name].clampWhenFinished = true; }
          }
          const idle = sp.clips.idle[0];
          act[idle]?.play();
          const e = makeEnemy(sp.id, sp.r, sp.h, sp.hp);
          e.len = sp.fit.len;
          e.alive = false;
          enemies.push(e);
          ds.current.push({ sp, e, wrap, body, mixer, act, cur: idle, mats, state: "sleep", t: 0, yaw: 0, pitch: 0, tx: 0, tz: 0, hx: 0, hz: 0, lost: 0, hitDone: false, dead: 0, lastHp: sp.hp, cd: 0, flinch: 0, roarCd: 0, pack: 0, idx: 0, leapT: 0 });
        }
      }
    }).catch((err) => console.error("dinos failed to load", err));
    return () => {
      dead = true;
      for (const d of ds.current) {
        const i = enemies.indexOf(d.e);
        if (i >= 0) enemies.splice(i, 1);
      }
      ds.current = [];
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const phase = useGame.getState().phase;
    if (phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map") return;
    const list = ds.current;
    if (!list.length) return;

    // ---- stream: wake a sleeper (or a whole pack) around the player ----
    tick.current -= dt;
    if (tick.current <= 0) {
      tick.current = 0.4;
      rr.current = (rr.current + 1) % SPECS.length;
      const sp = SPECS[rr.current];
      const sleepers = list.filter((d) => d.sp === sp && d.state === "sleep");
      const p = sleepers.length ? spawnPoint(sp.zone) : null;
      if (p) {
        const pack = packSeq++;
        const crew = sleepers.slice(0, sp.group);
        crew.forEach((d, i) => {
          const a = rnd() * 6.28, off = i === 0 ? 0 : 3 + rnd() * 4;
          const x = p[0] + Math.cos(a) * off, z = p[1] + Math.sin(a) * off;
          const e = d.e;
          e.x = x; e.z = z; e.y = heightAt(x, z);
          e.hp = e.maxHp = sp.hp; e.alive = true; e.burn = 0; e.vx = e.vz = 0; e.pain = 0;
          d.lastHp = sp.hp; d.hx = p[0]; d.hz = p[1]; d.pack = pack; d.idx = i;
          d.yaw = rnd() * 6.28; d.pitch = 0; d.lost = 0; d.cd = 0; d.flinch = 0; d.roarCd = 4 + rnd() * 6; d.dead = 0;
          d.state = sp.diet === "undead" ? "dormant" : "idle";
          d.t = 1 + rnd() * 4;
          d.wrap.visible = true;
          d.body.rotation.set(0, 0, 0);
          for (const a2 of Object.values(d.act)) a2.stop();
          d.cur = sp.diet === "undead" ? sp.clips.dormant! : pick(sp.clips.idle);
          d.act[d.cur]?.reset().play();
          d.mixer.update(rnd() * 2);
        });
      }
    }

    const heard = noise.seq !== seen.current;
    if (heard) seen.current = noise.seq;

    for (const d of list) {
      if (d.state === "sleep") continue;
      const { sp, e } = d;
      const C = sp.clips;
      const play = (name: string | undefined, fade = 0.3, ts = 1) => {
        if (!name || !d.act[name]) return;
        if (d.cur !== name) {
          d.act[name].reset().setEffectiveWeight(1).fadeIn(fade).play();
          d.act[d.cur]?.fadeOut(fade);
          d.cur = name;
        }
        d.act[name].setEffectiveTimeScale(ts);
      };
      const once = (name: string | undefined, fade = 0.15) => {
        if (!name || !d.act[name]) return 0;
        d.act[name].reset();
        d.cur = d.cur === name ? "" : d.cur;
        play(name, fade);
        return d.act[name].getClip().duration;
      };

      const dx = pose.x - e.x, dz = pose.z - e.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SLEEP_DIST && d.state !== "chase") {
        d.state = "sleep"; e.alive = false; d.wrap.visible = false;
        continue;
      }

      // burning
      if (e.alive && e.burn > 0) {
        e.burn -= dt;
        e.hp -= e.burnDps * dt;
        if (e.hp <= 0) { e.alive = false; const h = useHud.getState(); h.set({ kills: h.kills + 1 }); }
      }
      if (!e.alive && d.state !== "dead") {
        d.state = "dead"; d.dead = 0;
        if (C.death) once(C.death, 0.12);
        else d.act[d.cur]?.fadeOut(0.4);
      }
      if (d.state === "dead") {
        d.dead += dt;
        if (!C.death) d.body.rotation.z = Math.min(1, d.dead / 1.1) ** 2 * (Math.PI / 2) * 0.92; // keel over
        d.wrap.position.set(e.x, e.y - Math.max(0, d.dead - 9) * 0.4, e.z);
        if (dist < 160) d.mixer.update(dt);
        for (const m of d.mats) m.emissive.setRGB(0, 0, 0);
        if (d.dead > 13) { d.state = "sleep"; d.wrap.visible = false; d.body.rotation.z = 0; }
        continue;
      }

      // ---- senses ----
      e.pain = Math.max(0, e.pain - dt);
      const hurt = e.hp < d.lastHp - 0.01;
      d.lastHp = e.hp;
      d.t -= dt; d.cd -= dt; d.flinch -= dt; d.roarCd -= dt; d.leapT -= dt;
      const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw);
      const facing = (dx * fx + dz * fz) / (dist || 1);
      const sees = dist < sp.sight * (facing > 0 ? 1 : 0.4) || dist < sp.r + 6;
      const calm = d.state === "idle" || d.state === "graze" || d.state === "wander" || d.state === "search" || d.state === "return";
      const hunter = sp.diet === "apex" || sp.diet === "pack";
      const alertPack = (to: State) => {
        for (const o of list) if (o !== d && o.pack === d.pack && o.e.alive && (o.state === "idle" || o.state === "graze" || o.state === "wander" || o.state === "return" || o.state === "search")) {
          o.state = to; o.t = to === "flee" ? 6 + rnd() * 2 : 0.6 + rnd() * 0.5;
          if (to === "flee") { o.tx = o.e.x - (pose.x - o.e.x) * 6; o.tz = o.e.z - (pose.z - o.e.z) * 6; }
        }
      };

      if (sp.diet === "undead") {
        if ((d.state === "dormant" && (dist < 34 || hurt)) || (calm && (sees || hurt))) {
          d.state = d.state === "dormant" && C.rise ? "rise" : "notice";
          d.t = d.state === "rise" ? once(C.rise, 0.2) * 0.95 : Math.min(2.6, once(C.roar));
        }
      } else if (hunter && calm && (sees || hurt)) {
        d.state = "notice"; d.t = Math.min(sp.diet === "apex" ? 2.8 : 1.4, once(C.roar)) || 0.6;
        if (sp.diet === "pack") alertPack("notice");
      } else if (hunter && calm && heard && Math.hypot(noise.x - e.x, noise.z - e.z) < noise.r * 1.2) {
        d.state = "wander"; d.tx = noise.x; d.tz = noise.z; d.t = 14;
      } else if (sp.diet === "herb" && (calm || d.state === "notice")) {
        if (hurt && dist < sp.reach + 3 && d.cd <= 0) { d.state = "attack"; d.t = sp.atkT; d.hitDone = false; once(C.attack[0]); d.cd = 2.5; }
        else if (hurt || (dist < 9 && d.state !== "notice")) {
          if (!hurt && d.roarCd <= 0) { d.state = "notice"; d.t = Math.min(2.2, once(C.roar)); d.roarCd = 12; }
          else { d.state = "flee"; d.t = 7 + rnd() * 3; d.tx = e.x - dx * 8; d.tz = e.z - dz * 8; alertPack("flee"); }
        }
      }
      if (hurt && C.hurt && d.flinch <= 0 && (d.state === "chase" || d.state === "flee")) { once(C.hurt, 0.08); d.flinch = 1.6; d.leapT = 0.35; }

      // ---- brain ----
      let mx = 0, mz = 0, pace = 0;
      const goTo = (x: number, z: number) => {
        const a = x - e.x, b = z - e.z, l = Math.hypot(a, b) || 1;
        mx = a / l; mz = b / l;
        return l;
      };
      switch (d.state) {
        case "dormant":
          play(C.dormant, 0.4);
          break;
        case "rise":
          d.yaw += Math.atan2(Math.sin(Math.atan2(dx, dz) - d.yaw), Math.cos(Math.atan2(dx, dz) - d.yaw)) * Math.min(1, dt * 0.8);
          if (d.t <= 0) { d.state = "notice"; d.t = Math.min(2.6, once(C.roar, 0.3)); }
          break;
        case "idle":
          play(d.cur && C.idle.includes(d.cur) ? d.cur : pick(C.idle), 0.4);
          if (d.t <= 0) {
            if (C.eat && rnd() < (sp.diet === "herb" ? 0.5 : 0.15)) { d.state = "graze"; d.t = 4 + rnd() * 6; }
            else {
              d.state = "wander"; d.t = 8 + rnd() * 10;
              const a = rnd() * 6.28, r = 10 + rnd() * (sp.diet === "apex" ? 60 : 30);
              d.tx = d.hx + Math.cos(a) * r; d.tz = d.hz + Math.sin(a) * r;
              if (d.idx > 0) { // pack/herd members tag along with their leader
                const lead = list.find((o) => o.pack === d.pack && o.idx === 0 && o.e.alive);
                if (lead) { d.tx = lead.e.x + Math.cos(a) * 5; d.tz = lead.e.z + Math.sin(a) * 5; }
              }
            }
          }
          break;
        case "graze":
          play(C.eat, 0.4);
          if (d.t <= 0) { d.state = "idle"; d.t = 1 + rnd() * 3; }
          break;
        case "wander":
          pace = sp.walk;
          if (goTo(d.tx, d.tz) < 2 || d.t <= 0) { d.state = "idle"; d.t = 2 + rnd() * 5; }
          if (!inZone(sp.zone, e.x + mx * 6, e.z + mz * 6, false)) { d.tx = d.hx; d.tz = d.hz; }
          break;
        case "flee":
          pace = sp.run;
          goTo(d.tx, d.tz);
          if (d.t <= 0 || !inZone(sp.zone, e.x + mx * 8, e.z + mz * 8, false)) { d.state = "idle"; d.t = 2 + rnd() * 2; d.hx = e.x; d.hz = e.z; }
          break;
        case "notice":
          d.yaw += Math.atan2(Math.sin(Math.atan2(dx, dz) - d.yaw), Math.cos(Math.atan2(dx, dz) - d.yaw)) * Math.min(1, dt * 4);
          if (d.t <= 0) {
            if (sp.diet === "herb") { d.state = "idle"; d.t = 1; }
            else { d.state = "chase"; d.lost = 0; }
          }
          break;
        case "chase": {
          pace = sp.run;
          let tx = pose.x, tz = pose.z;
          if (sp.diet === "pack" && dist > 9 && d.idx > 0) {
            // flank: approach from the sides
            const side = d.idx % 2 ? 1 : -1;
            tx += (-dz / (dist || 1)) * side * Math.min(10, dist * 0.4);
            tz += (dx / (dist || 1)) * side * Math.min(10, dist * 0.4);
          }
          goTo(tx, tz);
          if (sp.diet === "pack" && C.leap && dist > 4 && dist < 9 && d.cd <= 0 && facing > 0.8) {
            once(C.leap, 0.1); d.leapT = -0.7; d.cd = 3 + rnd() * 2; // leapT < 0 = airborne burst
          }
          if (sp.diet === "apex" && d.roarCd <= 0 && dist > 25) { d.state = "notice"; d.t = Math.min(2.2, once(C.roar)); d.roarCd = 15 + rnd() * 10; break; }
          const home = Math.hypot(e.x - d.hx, e.z - d.hz);
          d.lost = dist > sp.sight * 1.7 ? d.lost + dt : 0;
          if (d.lost > 4 || home > LEASH) { d.state = "search"; d.t = 4; }
          else if (dist < sp.reach && d.cd <= 0.5 && facing > 0.5) {
            d.state = "attack"; d.t = sp.atkT; d.hitDone = false;
            if (sp.diet !== "undead") once(pick(sp.clips.attack));
          }
          break;
        }
        case "attack":
          d.yaw += Math.atan2(Math.sin(Math.atan2(dx, dz) - d.yaw), Math.cos(Math.atan2(dx, dz) - d.yaw)) * Math.min(1, dt * sp.turn);
          if (sp.diet === "undead") { pace = sp.run * 1.3; goTo(pose.x, pose.z); } // ram straight through
          if (!d.hitDone && d.t < sp.atkT * 0.55) {
            d.hitDone = true;
            if (dist < sp.reach + 1.4) {
              hurtPlayer(sp.dmg);
              ctl.pitch += 0.04 + sp.dmg * 0.0015;
            }
          }
          if (d.t <= 0) { d.state = sp.diet === "herb" ? "flee" : "chase"; d.t = 5; d.tx = e.x - dx * 8; d.tz = e.z - dz * 8; d.cd = sp.diet === "undead" ? 1.6 : 0.6; }
          break;
        case "search":
          play(pick(C.idle), 0.4);
          if (d.t <= 0) d.state = "return";
          break;
        case "return":
          pace = sp.walk;
          if (goTo(d.hx, d.hz) < 4) { d.state = sp.diet === "undead" ? "dormant" : "idle"; d.t = 3; }
          break;
      }

      // ---- movement ----
      const burst = d.leapT < 0 && d.leapT > -0.7 ? 1.6 : 1;
      const speed = pace * (e.pain > 0 && sp.diet === "pack" ? 0.5 : 1) * burst;
      if (mx || mz) {
        let a = Math.atan2(mx, mz) - d.yaw;
        a = Math.atan2(Math.sin(a), Math.cos(a));
        d.yaw += a * Math.min(1, dt * sp.turn * (d.state === "chase" ? 1.4 : 1));
        mx = Math.sin(d.yaw); mz = Math.cos(d.yaw);
      }
      let sx = 0, sz = 0;
      for (const o of list) {
        if (o === d || o.state === "sleep" || o.state === "dead") continue;
        const ox = e.x - o.e.x, oz = e.z - o.e.z, min = sp.r + o.sp.r + 0.4;
        const d2 = ox * ox + oz * oz;
        if (d2 < min * min && d2 > 1e-4) { const l = Math.sqrt(d2); sx += (ox / l) * (min - l); sz += (oz / l) * (min - l); }
      }
      e.vx *= Math.exp(-5 * dt);
      e.vz *= Math.exp(-5 * dt);
      const px = e.x, pz = e.z;
      e.x += (mx * speed + sx * 2) * dt + (e.vx * dt) / Math.max(1, sp.r);
      e.z += (mz * speed + sz * 2) * dt + (e.vz * dt) / Math.max(1, sp.r);
      const blocked = pushOut(e, sp.r, e.y);
      if (wetAt(e.x, e.z, -0.8) || Math.hypot(e.x - VILLAGE.x, e.z - VILLAGE.z) < VILLAGE.r + 25) { e.x = px; e.z = pz; }
      if (blocked && (d.state === "wander" || d.state === "return")) d.t = Math.min(d.t, 0.3);
      e.y += (heightAt(e.x, e.z) - e.y) * Math.min(1, dt * 10);
      e.fx = Math.sin(d.yaw); e.fz = Math.cos(d.yaw); // long-body hitbox follows the heading

      // ---- animation ----
      const moved = Math.hypot(e.x - px, e.z - pz) / Math.max(dt, 1e-4);
      const busy = d.state === "attack" || d.state === "notice" || d.state === "rise" || (d.flinch > 1.2 && C.hurt) || (d.leapT < 0 && d.leapT > -0.7);
      if (!busy && d.state !== "dormant" && d.state !== "graze") {
        if (moved > 0.4 && speed > 0.2) {
          const run = speed > (sp.walk + sp.run) / 2;
          play(run ? C.run : C.walk, 0.35, Math.min(2.2, Math.max(0.35, moved / (run ? sp.nomRun : sp.nomWalk))));
        } else if (!C.idle.includes(d.cur)) play(pick(C.idle), 0.4);
      }

      // body follows the ground slope
      const L = sp.fit.len * 0.35;
      const hf = heightAt(e.x + Math.sin(d.yaw) * L, e.z + Math.cos(d.yaw) * L);
      const hb = heightAt(e.x - Math.sin(d.yaw) * L, e.z - Math.cos(d.yaw) * L);
      d.pitch += (-Math.atan2(hf - hb, 2 * L) * 0.8 - d.pitch) * Math.min(1, dt * 4);
      d.wrap.position.set(e.x, e.y, e.z);
      d.wrap.rotation.set(d.pitch, d.yaw, 0, "YXZ");
      setShadow(d.wrap, dist < 80);
      if (dist < 170) d.mixer.update(dt);

      const flash = e.pain > 0 ? 0.55 : 0;
      const glow = e.burn > 0 ? 0.5 + Math.sin(performance.now() * 0.03) * 0.2 : 0;
      for (const m of d.mats) m.emissive.setRGB(flash + glow, flash * 0.1 + glow * 0.35, 0.02);
    }
  });

  return <group ref={root} />;
}
