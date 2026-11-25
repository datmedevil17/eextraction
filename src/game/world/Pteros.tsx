"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { heightAt, jungleT } from "@/game/terrain";
import { pose, useGame } from "@/game/store";
import { enemies, makeEnemy, useHud, type Enemy } from "@/game/weapons/combat";
import { loadKit, ownMaterials } from "./modelKit";

const DRAW = 650;

// Pterodactyl flocks circling over the world (animated flying loop, LasquetiSpice CC-BY).
// Each flock orbits a slowly drifting centre near the player; birds bank into the turn, bob, and now
// and then one dives low over the trees. They can be shot down: they tumble out of the sky.

const N = 12;
const FLOCKS = 4;
const SPAN = 9;

type Flock = { cx: number; cz: number; vx: number; vz: number; alt: number };
type P = {
  e: Enemy; wrap: THREE.Group; body: THREE.Object3D; mixer: THREE.AnimationMixer; mats: THREE.MeshStandardMaterial[];
  f: number; ang: number; rad: number; w: number; alt: number; ph: number; dive: number; bank: number;
  state: "fly" | "fall" | "down"; vy: number; t: number; spin: number; yaw: number; lx: number; lz: number;
};

const rnd = Math.random;

export function Pteros() {
  const root = useRef<THREE.Group>(null);
  const ps = useRef<P[]>([]);
  const flocks = useRef<Flock[]>([]);

  useEffect(() => {
    let dead = false;
    loadKit("/models/dinos/ptero.glb", { span: SPAN, head: /head/i }).then((kit) => {
      if (dead || !root.current) return;
      const clip = Object.values(kit.clips)[0];
      for (let f = 0; f < FLOCKS; f++) {
        const a = rnd() * 6.28, d = 100 + rnd() * 300;
        flocks.current.push({ cx: pose.x + Math.cos(a) * d, cz: pose.z + Math.sin(a) * d, vx: (rnd() - 0.5) * 3, vz: (rnd() - 0.5) * 3, alt: 60 + rnd() * 60 });
      }
      for (let i = 0; i < N; i++) {
        const body = cloneSkinned(kit.template);
        const mats = ownMaterials(body);
        body.traverse((o) => { (o as THREE.Mesh).castShadow = false; });
        const wrap = new THREE.Group();
        wrap.visible = false; // until the first flight update places it (else all 12 sit at the origin)
        wrap.add(body);
        root.current.add(wrap);
        const mixer = new THREE.AnimationMixer(body);
        if (clip) {
          const a = mixer.clipAction(clip);
          a.play();
          a.time = rnd() * clip.duration;
          a.setEffectiveTimeScale(0.85 + rnd() * 0.3);
        }
        const e = makeEnemy("ptero", 2.2, 1.2, 60);
        enemies.push(e);
        ps.current.push({
          e, wrap, body, mixer, mats, f: i % FLOCKS, ang: rnd() * 6.28, rad: 45 + rnd() * 70, w: (rnd() < 0.5 ? -1 : 1) * (0.9 + rnd() * 0.3),
          alt: (rnd() - 0.5) * 30, ph: rnd() * 6.28, dive: 0, bank: 0, state: "fly", vy: 0, t: 0, spin: 0, yaw: 0, lx: 0, lz: 0,
        });
      }
    }).catch((err) => console.error("pteros failed to load", err));
    return () => {
      dead = true;
      for (const p of ps.current) {
        const i = enemies.indexOf(p.e);
        if (i >= 0) enemies.splice(i, 1);
      }
      ps.current = [];
      flocks.current = [];
    };
  }, []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const phase = useGame.getState().phase;
    // keep flying on the menu too: they circle in the title-screen sky
    if (phase === "paused" || phase === "arsenal" || phase === "map") return;
    const time = state.clock.elapsedTime;

    // flocks drift; one that falls too far behind the player is moved ahead of them
    for (const f of flocks.current) {
      f.cx += f.vx * dt; f.cz += f.vz * dt;
      const d = Math.hypot(f.cx - pose.x, f.cz - pose.z);
      if (d > 650) {
        const a = rnd() * 6.28, r = 250 + rnd() * 250;
        f.cx = pose.x + Math.cos(a) * r; f.cz = pose.z + Math.sin(a) * r;
      }
      if (d > 350) { f.vx += ((pose.x - f.cx) / d) * dt * 0.4; f.vz += ((pose.z - f.cz) / d) * dt * 0.4; }
      const sp = Math.hypot(f.vx, f.vz);
      if (sp > 5) { f.vx *= 5 / sp; f.vz *= 5 / sp; }
    }

    for (const p of ps.current) {
      const e = p.e;
      const f = flocks.current[p.f];
      if (p.state === "fly") {
        if (!e.alive) {
          p.state = "fall"; p.vy = 0; p.spin = (rnd() - 0.5) * 6;
          continue;
        }
        if (e.burn > 0) {
          e.burn -= dt; e.hp -= e.burnDps * dt;
          if (e.hp <= 0) { e.alive = false; const h = useHud.getState(); h.set({ kills: h.kills + 1 }); }
        }
        const speed = 15 + Math.sin(time * 0.3 + p.ph) * 2;
        p.ang += (p.w * speed * dt) / p.rad;
        // occasional low pass over the jungle canopy
        p.dive -= dt;
        if (p.dive < -25 && rnd() < dt * 0.05) p.dive = 10;
        const low = p.dive > 0 ? Math.sin((p.dive / 10) * Math.PI) : 0;
        const x = f.cx + Math.cos(p.ang) * p.rad;
        const z = f.cz + Math.sin(p.ang) * p.rad;
        const ground = Math.max(heightAt(x, z), 0);
        const canopy = jungleT(x, z) > 0.2 ? 32 : 18;
        const y = Math.max(ground + canopy, ground + f.alt + p.alt + Math.sin(time * 0.5 + p.ph) * 4 - low * (f.alt + p.alt - canopy));
        // heading = direction of travel, bank into the turn
        const vx = x - p.lx, vz = z - p.lz;
        if (vx || vz) p.yaw = Math.atan2(vx, vz);
        p.lx = x; p.lz = z;
        p.bank += (-p.w * 0.45 - p.bank) * Math.min(1, dt * 2);
        const climb = Math.atan2(y - e.y, Math.max(0.5, speed * dt * 60)) * 0.6;
        e.x = x; e.z = z; e.y = y - 0.6;
        p.wrap.position.set(x, y, z);
        p.wrap.rotation.set(-climb, p.yaw, p.bank, "YXZ");
        const dist = Math.hypot(x - pose.x, z - pose.z);
        p.wrap.visible = dist < DRAW;
        if (dist < 260) p.mixer.update(dt);
      } else if (p.state === "fall") {
        p.vy -= 18 * dt;
        e.y += p.vy * dt;
        p.wrap.rotation.z += p.spin * dt;
        p.wrap.rotation.x += dt * 1.5;
        const g = heightAt(e.x, e.z);
        if (e.y <= g) { e.y = g; p.state = "down"; p.t = 10; p.wrap.rotation.set(0, p.yaw, Math.PI * 0.5); }
        p.wrap.position.set(e.x, e.y + 0.4, e.z);
        p.mixer.update(dt * 0.3);
      } else {
        p.t -= dt;
        p.wrap.visible = Math.hypot(e.x - pose.x, e.z - pose.z) < DRAW;
        if (p.t <= 0) {
          // respawn far away in the sky
          e.hp = e.maxHp; e.alive = true; e.burn = 0; e.pain = 0;
          p.state = "fly";
          p.ang = rnd() * 6.28;
          // rejoin whichever flock is farthest away, so the pop-in happens out of sight
          let far = 0, fd = -1;
          flocks.current.forEach((o, i) => { const dd = Math.hypot(o.cx - pose.x, o.cz - pose.z); if (dd > fd) { fd = dd; far = i; } });
          p.f = far;
          p.lx = flocks.current[far].cx; p.lz = flocks.current[far].cz;
        }
      }
      e.pain = Math.max(0, e.pain - dt);
      const flash = e.pain > 0 ? 0.6 : 0;
      for (const m of p.mats) m.emissive.setRGB(flash, flash * 0.1, 0);
    }
  });

  return <group ref={root} />;
}
