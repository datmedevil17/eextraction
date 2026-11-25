"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { VILLAGE, heightAt } from "@/game/terrain";
import { pose, ride, useGame } from "@/game/store";
import { enemies, guard, hurtPlayer, makeEnemy, type Enemy } from "@/game/weapons/combat";
import { pushOut } from "./colliders";
import { setShadow } from "./modelKit";
import { decoys, type Decoy } from "./facelessShared";
import { planeHud } from "./planeState";

// Knights of the grass village (Quaternius "Knight", CC0). Each one keeps a post on the village edge
// and walks a short beat around it. Monsters (imps, puglins, zombies) that come within reach of the
// village get charged and cut down; the monsters fight back (the knights are `decoys` for Monsters.tsx).
// Neutral to the player until the player hurts a villager or a knight (`guard.anger`): then every knight
// nearby runs the player down until the anger wears off. They're in `enemies` (tag "knight") so they can be shot.

const C = VILLAGE;
const N = 6;
const HEIGHT = 1.95;
const POST_R = C.r - 18;
const GUARD_R = C.r + 70; // monsters further than this from the village centre are left alone
const LEASH = C.r + 90; // a knight never chases further out than this
const SIGHT = 48;
const HUNT_PLAYER = 120; // angry knights within this of the player come for them
const HUNTERS = 3; // only the nearest few give chase, the rest hold their posts
const WALK = 1.45;
const RUN = 5.2;
const REACH = 2.1;
const HP = 320;
const DMG_MONSTER = 42;
const DMG_PLAYER = 12;
const ANGER = 90;
const RESPAWN = 90;
const SHOW = 420; // player distance from the village to simulate / show
const ANIM_DIST = 150;

const FILES = ["KnightCharacter", "Sword", "Helmet1", "Helmet2", "Helmet3", "ShoulderPads"] as const;
const ONCE = new Set(["Run_swordAttack", "swordAttackJump", "Death"]);
const NOMINAL: Record<string, number> = { Walking: 1.5, Run: 5.0, Run_swordRight: 5.0 }; // guessed m/s of the in-place clips at HEIGHT

// Where each accessory sits on the character in its rest pose, in the FBX's own units (character ~558 tall,
// faces +Z, right hand on -X). The accessory files are modelled around their own origin, so we place them
// here and re-express that relative to the bone they ride on.
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const basis = (x: [number, number, number], y: [number, number, number], z: [number, number, number]) =>
  new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(_bx.set(...x), _by.set(...y), _bz.set(...z)));
const MOUNTS = {
  // grip at the fist, blade forward, guard vertical (sword +Y = blade, +X = guard)
  sword: { bone: "PalmR", p: new THREE.Vector3(-93, 146, -14), q: basis([0, 1, 0], [0, 0, 1], [1, 0, 0]) },
  helmet: { bone: "Head", p: new THREE.Vector3(0, 490, -9), q: new THREE.Quaternion() },
  pads: { bone: "Neck", p: new THREE.Vector3(0, 384, -11), q: new THREE.Quaternion() },
};

type Kit = { body: THREE.Group; clips: THREE.AnimationClip[]; acc: Record<string, THREE.Group>; local: Record<keyof typeof MOUNTS, THREE.Matrix4>; k: number };

let kitP: Promise<Kit> | null = null;
function loadKit(): Promise<Kit> {
  return (kitP ??= (async () => {
    const L = new FBXLoader();
    const objs = await Promise.all(FILES.map((f) => L.loadAsync(`/models/knights/${f}.fbx`)));
    const acc: Record<string, THREE.Group> = {};
    FILES.forEach((f, i) => { acc[f] = objs[i]; });
    // FBX gives Phong materials: swap for standard ones so the knights sit in the same lighting as everything else
    for (const o of objs) {
      o.traverse((n) => {
        const m = n as THREE.Mesh;
        if (!m.isMesh) return;
        const conv = (src: THREE.Material) => {
          const p = src as THREE.MeshPhongMaterial;
          const metal = /metal|grey|gray|gold|armor/i.test(p.name);
          return new THREE.MeshStandardMaterial({ name: p.name, color: p.color, map: p.map ?? null, roughness: metal ? 0.42 : 0.8, metalness: metal ? 0.55 : 0 });
        };
        m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
        m.frustumCulled = false;
      });
    }
    const body = objs[0];
    body.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(body);
    const k = HEIGHT / Math.max(1e-3, box.max.y - box.min.y);
    const local = {} as Kit["local"];
    for (const [key, m] of Object.entries(MOUNTS) as [keyof typeof MOUNTS, (typeof MOUNTS)["sword"]][]) {
      const bone = body.getObjectByName(m.bone);
      if (!bone) throw new Error(`knight bone ${m.bone} missing`);
      local[key] = bone.matrixWorld.clone().invert().multiply(new THREE.Matrix4().compose(m.p, m.q, new THREE.Vector3(1, 1, 1)));
    }
    return { body, clips: body.animations, acc, local, k };
  })());
}

const mount = (kit: Kit, root: THREE.Object3D, key: keyof typeof MOUNTS, file: string) => {
  const bone = root.getObjectByName(MOUNTS[key].bone);
  if (!bone) return;
  const a = kit.acc[file].clone(true);
  kit.local[key].decompose(a.position, a.quaternion, a.scale);
  bone.add(a);
};

type State = "post" | "patrol" | "chase" | "attack" | "return" | "dead";
type Kn = {
  e: Enemy; dc: Decoy; wrap: THREE.Group; mixer: THREE.AnimationMixer; act: Record<string, THREE.AnimationAction>; cur: string;
  mats: THREE.MeshStandardMaterial[];
  state: State; t: number; yaw: number; postA: number; tx: number; tz: number; scan: number;
  tgt: Enemy | null; tgtPlayer: boolean; lastHp: number; swing: number; hitDone: boolean; clip: string;
};

const rnd = Math.random;
const isMonster = (e: Enemy) => e.alive && (e.tag === "imp" || e.tag === "puglin" || e.tag === "zombie");
const postXZ = (a: number, r = POST_R): [number, number] => [C.x + Math.cos(a) * r, C.z + Math.sin(a) * r];
const HURT = new THREE.Color(0.9, 0.05, 0.02);
const BLACK = new THREE.Color(0);

export function Knights() {
  const root = useRef<THREE.Group>(null);
  const list = useRef<Kn[]>([]);
  const wasAngry = useRef(false);

  useEffect(() => {
    let dead = false;
    const mine: Kn[] = [];
    loadKit().then((kit) => {
      if (dead || !root.current) return;
      for (let i = 0; i < N; i++) {
        const body = cloneSkinned(kit.body) as THREE.Group;
        mount(kit, body, "sword", "Sword");
        mount(kit, body, "helmet", `Helmet${1 + (i % 3)}`);
        if (i % 2 === 0) mount(kit, body, "pads", "ShoulderPads");
        const mats: THREE.MeshStandardMaterial[] = [];
        body.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.frustumCulled = false;
          const own = (x: THREE.Material) => { const c = (x as THREE.MeshStandardMaterial).clone(); mats.push(c); return c; };
          m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material);
        });
        body.scale.setScalar(kit.k);
        const wrap = new THREE.Group();
        wrap.add(body);
        root.current.add(wrap);
        const mixer = new THREE.AnimationMixer(body);
        const act: Kn["act"] = {};
        for (const c of kit.clips) {
          const name = c.name.split("|").pop()!;
          const a = mixer.clipAction(c);
          if (ONCE.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
          act[name] = a;
        }
        (act.Idle_swordRight ?? act.Idle).play();
        mixer.update(rnd() * 3);
        const postA = (i / N) * Math.PI * 2 + 0.31; // between the spoke roads
        const [x, z] = postXZ(postA);
        const e = makeEnemy("knight", 0.45, HEIGHT, HP);
        e.x = x; e.z = z; e.y = heightAt(x, z);
        const kn: Kn = {
          e, dc: null as unknown as Decoy, wrap, mixer, act, cur: act.Idle_swordRight ? "Idle_swordRight" : "Idle", mats,
          state: "post", t: rnd() * 5, yaw: Math.atan2(Math.cos(postA), Math.sin(postA)), postA, tx: x, tz: z, scan: rnd() * 0.3,
          tgt: null, tgtPlayer: false, lastHp: HP, swing: 0, hitDone: false, clip: "",
        };
        kn.dc = {
          id: e.id, x, y: e.y, z, alive: true,
          hit: (dmg, fromX, fromZ) => {
            if (kn.state === "dead") return;
            e.hp -= dmg;
            kn.lastHp = e.hp; // monster damage: not the player's doing
            e.pain = 0.2;
            const l = Math.hypot(e.x - fromX, e.z - fromZ) || 1;
            e.vx += ((e.x - fromX) / l) * 1.5; e.vz += ((e.z - fromZ) / l) * 1.5;
          },
        };
        wrap.position.set(x, e.y, z); // placed now: the frame loop is skipped in the menu
        wrap.rotation.y = kn.yaw;
        enemies.push(e);
        decoys.push(kn.dc);
        mine.push(kn);
      }
      list.current = mine;
    }).catch((err) => console.error("knights failed to load", err));
    return () => {
      dead = true;
      for (const kn of mine) {
        const i = enemies.indexOf(kn.e);
        if (i >= 0) enemies.splice(i, 1);
        const j = decoys.indexOf(kn.dc);
        if (j >= 0) decoys.splice(j, 1);
      }
      list.current = [];
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const phase = useGame.getState().phase;
    if (phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map") return;
    guard.anger = Math.max(0, guard.anger - dt);
    const angry = guard.anger > 0;
    if (angry && !wasAngry.current) { planeHud.msg = "You hurt the villagers — the knights are coming for you"; planeHud.msgT = 4; }
    wasAngry.current = angry;

    const ks = list.current;
    const g = root.current;
    if (!g || !ks.length) return;
    const pv = Math.hypot(pose.x - C.x, pose.z - C.z);
    g.visible = pv < SHOW + C.r;
    if (!g.visible) return;
    const playerOk = phase === "playing" && !ride.plane;
    // the HUNTERS live knights nearest the player are the ones allowed to go after them
    const hunters = new Set<Kn>();
    if (angry && playerOk) {
      const alive = ks.filter((k) => k.state !== "dead");
      alive.sort((a, b) => Math.hypot(a.e.x - pose.x, a.e.z - pose.z) - Math.hypot(b.e.x - pose.x, b.e.z - pose.z));
      for (const k of alive.slice(0, HUNTERS)) hunters.add(k);
    }

    for (const kn of ks) {
      const e = kn.e;
      const play = (name: string, fade = 0.2) => {
        if (kn.cur === name || !kn.act[name]) return;
        kn.act[name].reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
        kn.act[kn.cur]?.fadeOut(fade);
        kn.cur = name;
      };
      const pd = Math.hypot(pose.x - e.x, pose.z - e.z);

      // ---- damage bookkeeping: hp lost outside the decoy path (monsters) came from the player ----
      if (kn.state !== "dead") {
        if (e.burn > 0) { e.burn -= dt; e.hp -= e.burnDps * dt; }
        if (e.hp < kn.lastHp - 0.01) guard.anger = ANGER;
        kn.lastHp = e.hp;
        if (e.hp <= 0) {
          kn.state = "dead"; kn.t = 0; e.alive = false; e.burn = 0; kn.dc.alive = false; kn.tgt = null;
          for (const a of Object.values(kn.act)) a.fadeOut(0.15);
          kn.act.Death?.reset().setEffectiveWeight(1).fadeIn(0.1).play();
          kn.cur = "Death";
        }
      }
      e.pain = Math.max(0, e.pain - dt);
      const flash = e.pain > 0 ? e.pain / 0.2 : 0;
      for (const m of kn.mats) m.emissive.copy(BLACK).lerp(HURT, flash * 0.6);

      if (kn.state === "dead") {
        kn.t += dt;
        kn.wrap.position.set(e.x, e.y - Math.max(0, kn.t - 20) * 0.25, e.z);
        kn.wrap.visible = kn.t < 26;
        if (pd < ANIM_DIST && kn.wrap.visible) kn.mixer.update(dt);
        if (kn.t > RESPAWN && pd > 60) {
          // a fresh knight takes the post
          const [x, z] = postXZ(kn.postA);
          e.x = x; e.z = z; e.y = heightAt(x, z); e.hp = HP; e.alive = true; e.vx = e.vz = 0;
          kn.lastHp = HP; kn.dc.alive = true; kn.state = "post"; kn.t = 2; kn.wrap.visible = true;
          kn.act.Death?.stop();
          kn.cur = "";
          play("Idle_swordRight", 0);
        }
        continue;
      }

      // ---- target scan ----
      kn.scan -= dt;
      if (kn.scan <= 0) {
        kn.scan = 0.3;
        let best: Enemy | null = null, bd = SIGHT;
        for (const o of enemies) {
          if (!isMonster(o) || Math.hypot(o.x - C.x, o.z - C.z) > GUARD_R) continue;
          const d = Math.hypot(o.x - e.x, o.z - e.z);
          if (d < bd) { bd = d; best = o; }
        }
        const wantPlayer = hunters.has(kn) && pd < HUNT_PLAYER && pv < LEASH + 20 && pd < bd + 6;
        kn.tgtPlayer = wantPlayer;
        kn.tgt = wantPlayer ? null : best;
        if ((best || wantPlayer) && kn.state !== "attack") kn.state = "chase";
        else if (!best && !wantPlayer && (kn.state === "chase")) { kn.state = "return"; }
      }
      if (kn.tgt && !kn.tgt.alive) { kn.tgt = null; if (kn.state === "chase") kn.state = "return"; }

      // ---- brain ----
      let mx = 0, mz = 0, pace = 0;
      const goTo = (x: number, z: number) => {
        const dx = x - e.x, dz = z - e.z, l = Math.hypot(dx, dz) || 1;
        mx = dx / l; mz = dz / l;
        return l;
      };
      const tx = kn.tgtPlayer ? pose.x : kn.tgt ? kn.tgt.x : 0;
      const tz = kn.tgtPlayer ? pose.z : kn.tgt ? kn.tgt.z : 0;
      const tr = kn.tgtPlayer ? 0.4 : kn.tgt ? kn.tgt.r : 0;
      kn.t -= dt;
      switch (kn.state) {
        case "post":
          // stand guard facing out, now and then walk the beat
          if (kn.t <= 0) {
            kn.state = "patrol"; kn.t = 25;
            const a = kn.postA + (rnd() * 2 - 1) * 0.16, r = POST_R + (rnd() * 2 - 1) * 8;
            [kn.tx, kn.tz] = postXZ(a, r);
          }
          break;
        case "patrol":
          pace = WALK;
          if (goTo(kn.tx, kn.tz) < 0.8 || kn.t <= 0) {
            kn.state = "post"; kn.t = 5 + rnd() * 8;
            // look out over the fields
            const ox = Math.cos(kn.postA), oz = Math.sin(kn.postA);
            kn.yaw = Math.atan2(ox, oz) + (rnd() * 2 - 1) * 0.6;
          }
          break;
        case "return": {
          pace = WALK * 1.6;
          const [px, pz] = postXZ(kn.postA);
          if (goTo(px, pz) < 1.5) { kn.state = "post"; kn.t = 2 + rnd() * 4; }
          break;
        }
        case "chase": {
          if (!kn.tgt && !kn.tgtPlayer) { kn.state = "return"; break; }
          const d = goTo(tx, tz);
          pace = RUN;
          const out = Math.hypot(e.x - C.x, e.z - C.z);
          if (out > LEASH) { kn.state = "return"; kn.tgt = null; kn.tgtPlayer = false; break; }
          if (d < REACH + tr) {
            kn.state = "attack";
            kn.clip = rnd() < 0.3 && kn.act.swordAttackJump ? "swordAttackJump" : "Run_swordAttack";
            kn.swing = kn.act[kn.clip].getClip().duration;
            kn.hitDone = false;
            kn.cur = kn.cur === kn.clip ? "" : kn.cur;
            play(kn.clip, 0.1);
          }
          break;
        }
        case "attack": {
          if (kn.tgt || kn.tgtPlayer) kn.yaw = Math.atan2(tx - e.x, tz - e.z);
          kn.swing -= dt;
          const dur = kn.act[kn.clip].getClip().duration;
          if (!kn.hitDone && kn.swing < dur * 0.5) {
            kn.hitDone = true;
            const d = Math.hypot(tx - e.x, tz - e.z);
            if (d < REACH + tr + 0.8) {
              if (kn.tgtPlayer) { if (playerOk) hurtPlayer(DMG_PLAYER); }
              else if (kn.tgt && kn.tgt.alive) {
                const o = kn.tgt;
                o.hp -= DMG_MONSTER; o.pain = 0.25;
                const l = d || 1;
                o.vx += ((o.x - e.x) / l) * 4; o.vz += ((o.z - e.z) / l) * 4;
                if (o.hp <= 0) o.alive = false; // its own AI plays the death
              }
            }
          }
          if (kn.swing <= 0) kn.state = kn.tgt || kn.tgtPlayer ? "chase" : "return";
          break;
        }
      }

      // ---- movement ----
      if (pace > 0) {
        let dy = Math.atan2(mx, mz) - kn.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        kn.yaw += dy * Math.min(1, dt * 8);
        // don't bunch up with the other knights
        let sx = 0, sz = 0;
        for (const o of ks) {
          if (o === kn || o.state === "dead") continue;
          const ox = e.x - o.e.x, oz = e.z - o.e.z, q = ox * ox + oz * oz;
          if (q < 1.6 && q > 1e-4) { const l = Math.sqrt(q); sx += (ox / l) * (1.3 - l) * 2; sz += (oz / l) * (1.3 - l) * 2; }
        }
        e.x += (Math.sin(kn.yaw) * pace + sx) * dt;
        e.z += (Math.cos(kn.yaw) * pace + sz) * dt;
      }
      if (e.vx || e.vz) {
        e.x += e.vx * dt; e.z += e.vz * dt;
        const k = Math.exp(-6 * dt);
        e.vx *= k; e.vz *= k;
        if (Math.abs(e.vx) + Math.abs(e.vz) < 0.05) e.vx = e.vz = 0;
      }
      pushOut(e, e.r, e.y);
      e.y += (heightAt(e.x, e.z) - e.y) * Math.min(1, dt * 10);
      kn.dc.x = e.x; kn.dc.y = e.y; kn.dc.z = e.z;

      // ---- animation ----
      if (kn.state !== "attack") {
        if (pace > WALK * 1.7) {
          play("Run_swordRight", 0.15);
          kn.act.Run_swordRight?.setEffectiveTimeScale(pace / NOMINAL.Run_swordRight);
        } else if (pace > 0) {
          play("Walking", 0.25);
          kn.act.Walking?.setEffectiveTimeScale(pace / NOMINAL.Walking);
        } else play("Idle_swordRight", 0.3);
      }

      kn.wrap.visible = pd < 260;
      setShadow(kn.wrap, pd < 50);
      kn.wrap.position.set(e.x, e.y, e.z);
      kn.wrap.rotation.y = kn.yaw;
      if (pd < ANIM_DIST && kn.wrap.visible) kn.mixer.update(dt);
    }
  });

  return <group ref={root} />;
}
