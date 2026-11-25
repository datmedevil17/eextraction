"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PLAY_LIMIT, WATER_Y, heightAt, waterDepth } from "@/game/terrain";
import { ctl, pose, ride, useGame, useRide } from "@/game/store";
import { damageEnemy, enemies, enemyCircles } from "@/game/weapons/combat";
import { bodies } from "@/game/physics";
import { pushOut } from "./colliders";
import { loadKit, setShadow } from "./modelKit";
import { dragonMarks } from "./dragonMarks";

// Drivable "D Raider" buggies (Svyatoslav Ovchinnik, CC-BY) parked around the map.
//   E: get in / out      W/S: throttle / brake + reverse      A/D: steer
//   Space: handbrake (drift)      Shift: boost      mouse: look around (recentres on its own)
// Arcade model: forward + lateral velocity in the car frame, grip bleeds the lateral part (less with
// the handbrake), four ground probes give pitch / roll, the body leaves the ground over crests.

const CAR_LEN = 4.4;
const CAR_YAW = 0; // model facing fix (radians) if the buggy turns out to be modelled backwards
const SPOTS: [number, number][] = [[14, 26], [-40, 160], [330, 470], [60, 760], [-60, -640], [900, 80], [-520, 40]];
const MAX_V = 30;
const BOOST_V = 42;
const REV_V = 9;
const ACCEL = 14;
const BRAKE = 26;
const GRAV = 22;
const WB = 2.7; // wheelbase
const TRACK = 1.7;
const ENTER_R = 3.6;

type Car = {
  g: THREE.Group; x: number; z: number; y: number; vy: number; yaw: number; vf: number; vl: number;
  pitch: number; roll: number; steer: number; air: boolean; lastG: number; bump: number;
};

// ---- speed-loss markers: what took speed off the driven car (m/s lost per cause, decayed window) ----
const CAUSES = ["slope", "water", "hit", "creature", "roll", "handbrake", "air", "fps"] as const;
type Cause = (typeof CAUSES)[number];
const LABEL: Record<Cause, string> = { slope: "uphill", water: "water", hit: "crash", creature: "creature", roll: "rolling", handbrake: "handbrake", air: "airborne", fps: "low fps" };
type RideEvent = { t: number; x: number; z: number; from: number; to: number; why: string };
const rideLog: RideEvent[] = [];

function parkSpot(x: number, z: number): [number, number] {
  for (let i = 0; i < 40; i++) {
    const a = i * 2.4, r = i * 2.5;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    const h = heightAt(px, pz);
    const slope = Math.abs(heightAt(px + 2, pz) - heightAt(px - 2, pz)) + Math.abs(heightAt(px, pz + 2) - heightAt(px, pz - 2));
    if (h < WATER_Y + 0.5 || slope > 1.2) continue;
    if (pushOut({ x: px, z: pz }, 3.2)) continue;
    return [px, pz];
  }
  return [x, z];
}

export function Vehicles() {
  const { camera } = useThree();
  const root = useRef<THREE.Group>(null);
  const cars = useRef<Car[]>([]);
  const keys = useRef<Record<string, boolean>>({});
  const drive = useRef<Car | null>(null);
  const look = useRef({ yaw: 0, pitch: 0.18, idle: 0 });
  const camPos = useRef(new THREE.Vector3());
  const ram = useRef(new Map<number, number>());
  const hudT = useRef(0);
  // per-cause loss rate (m/s per second, exponentially smoothed) + a 0.6 s speed history for drop events
  const loss = useRef(Object.fromEntries(CAUSES.map((k) => [k, 0])) as Record<Cause, number>);
  const hist = useRef<{ t: number; v: number }[]>([]);
  const lastEvt = useRef(0);

  useEffect(() => {
    let dead = false;
    loadKit("/models/vehicles/raider.glb", { len: CAR_LEN, yaw: CAR_YAW }).then((kit) => {
      if (dead || !root.current) return;
      for (const [sx, sz] of SPOTS) {
        const [x, z] = parkSpot(sx, sz);
        const g = kit.template.clone(true);
        root.current.add(g);
        const y = heightAt(x, z);
        const car: Car = { g, x, z, y, vy: 0, yaw: Math.random() * 6.28, vf: 0, vl: 0, pitch: 0, roll: 0, steer: 0, air: false, lastG: y, bump: 0 };
        cars.current.push(car);
        place(car); // the menu skips the update loop, so park it now (not at the origin)
      }
      if (typeof window !== "undefined") Object.assign(((window as unknown as { __dbg?: Record<string, unknown> }).__dbg ??= {}), { cars: cars.current, enemies, rideLog, dragonMarks });
    }).catch((err) => console.error("vehicles failed to load", err));

    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      if (e.code !== "KeyE" || e.repeat || ride.plane || useGame.getState().phase !== "playing") return; // E is the rudder in a plane
      const cur = drive.current;
      if (cur) {
        if (Math.abs(cur.vf) > 8) return; // too fast to jump out
        // step out on the driver's side, facing where the camera looks
        const rx = Math.cos(cur.yaw), rz = -Math.sin(cur.yaw);
        ctl.teleport = { x: cur.x - rx * 2.6, z: cur.z - rz * 2.6 };
        ride.on = false;
        drive.current = null;
        useRide.getState().set({ on: false, kmh: 0 });
      } else {
        let best: Car | null = null, bd = ENTER_R;
        for (const c of cars.current) {
          const d = Math.hypot(c.x - pose.x, c.z - pose.z);
          if (d < bd) { bd = d; best = c; }
        }
        if (best) {
          drive.current = best;
          ride.on = true;
          look.current = { yaw: 0, pitch: 0.18, idle: 0 };
          camPos.current.set(best.x - Math.sin(best.yaw) * 9, best.y + 4, best.z - Math.cos(best.yaw) * 9);
          useRide.getState().set({ on: true, prompt: null });
        }
      }
    };
    const up = (e: KeyboardEvent) => (keys.current[e.code] = false);
    const move = (e: MouseEvent) => {
      if (!drive.current || !document.pointerLockElement) return;
      const l = look.current;
      l.yaw -= e.movementX * 0.0026;
      l.pitch = THREE.MathUtils.clamp(l.pitch + e.movementY * 0.002, -0.15, 0.9);
      l.idle = 0;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    document.addEventListener("mousemove", move);
    return () => {
      dead = true;
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("mousemove", move);
      ride.on = false;
      cars.current = [];
    };
  }, []);

  useFrame((_, rawDt) => {
    // physics in fixed-size substeps: a slow frame must not turn into slow motion (or tunnelling)
    const frameDt = Math.min(rawDt, 0.25);
    const steps = Math.max(1, Math.ceil(frameDt / (1 / 40)));
    let dt = frameDt / steps;
    const phase = useGame.getState().phase;
    const frozen = phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map";

    // "E · drive" prompt
    const R = useRide.getState();
    if (!drive.current) {
      const near = phase === "playing" && !ride.plane && cars.current.some((c) => Math.hypot(c.x - pose.x, c.z - pose.z) < ENTER_R);
      const prompt = near ? "E · drive" : null;
      if (R.prompt !== prompt) R.set({ prompt });
    }

    for (let si = 0; si < steps; si++) for (const c of cars.current) {
      const driving = c === drive.current && !frozen;
      const k = keys.current;
      const thr = driving && phase === "playing" ? (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) : 0;
      const steerIn = driving && phase === "playing" ? (k.KeyA || k.ArrowLeft ? 1 : 0) - (k.KeyD || k.ArrowRight ? 1 : 0) : 0;
      const hand = driving && !!k.Space;
      const boost = driving && !!(k.ShiftLeft || k.ShiftRight) && thr > 0;
      if (frozen) continue;
      if (!driving && Math.abs(c.vf) < 0.05 && !c.air && Math.abs(c.vl) < 0.05) { place(c); continue; }

      // ---- drive forces ----
      const top = boost ? BOOST_V : MAX_V;
      const L = loss.current;
      const me = c === drive.current;
      const lose = (k: Cause, before: number) => { if (me) { const d = Math.abs(before) - Math.abs(c.vf); if (d > 0) L[k] += d; } };
      let v0 = c.vf;
      if (me && c.air && thr > 0) L.air += ACCEL * dt * 0.5; // throttle does nothing in the air
      if (!c.air) {
        if (thr > 0) c.vf += (c.vf < 0 ? BRAKE : ACCEL * (boost ? 1.6 : 1) * (1 - Math.max(0, c.vf) / top)) * dt;
        else if (thr < 0) c.vf -= (c.vf > 0.5 ? BRAKE : ACCEL * 0.6 * (1 - Math.max(0, -c.vf) / REV_V)) * dt;
        else c.vf *= Math.exp(-0.35 * dt);
        if (thr === 0 && me) lose("roll", v0);
        v0 = c.vf;
        if (hand) { c.vf *= Math.exp(-1.1 * dt); lose("handbrake", v0); }
        // rolling resistance + gravity along the slope
        v0 = c.vf;
        c.vf -= Math.sin(-c.pitch) * GRAV * 0.55 * dt;
        lose("slope", v0);
        v0 = c.vf;
        c.vf -= Math.sign(c.vf) * Math.min(Math.abs(c.vf), 0.6 * dt);
        lose("roll", v0);
      }
      const wet = waterDepth(c.x, c.z);
      v0 = c.vf;
      if (wet > 0.3) { c.vf *= Math.exp(-2.5 * wet * dt); c.vl *= Math.exp(-3 * dt); }
      lose("water", v0);

      // steering: less lock at speed, rate grows with speed
      const lock = 0.62 / (1 + Math.abs(c.vf) * 0.045);
      c.steer += (steerIn * lock - c.steer) * Math.min(1, dt * 7);
      if (!c.air) {
        const yawRate = (c.vf / WB) * Math.tan(c.steer) * (hand ? 1.35 : 1);
        c.yaw += yawRate * dt;
        // turning pushes the body outwards; grip eats the lateral slide
        c.vl -= yawRate * c.vf * dt * (hand ? 0.55 : 0.18);
        c.vl *= Math.exp(-(hand ? 1.4 : 9) * dt);
      }

      // ---- integrate ----
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      const rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
      const px = c.x, pz = c.z;
      c.x = THREE.MathUtils.clamp(c.x + (fx * c.vf + rx * c.vl) * dt, -PLAY_LIMIT, PLAY_LIMIT);
      c.z = THREE.MathUtils.clamp(c.z + (fz * c.vf + rz * c.vl) * dt, -PLAY_LIMIT, PLAY_LIMIT);

      // scenery: bounce off, lose most of the speed
      v0 = c.vf;
      if (pushOut(c, 1.7, c.y + 0.3)) {
        const mvx = c.x - px, mvz = c.z - pz;
        if (Math.hypot(mvx, mvz) < Math.abs(c.vf) * dt * 0.6) { c.bump = Math.min(1, Math.abs(c.vf) / 25); c.vf *= -0.25; c.vl *= 0.3; }
      }
      lose("hit", v0);
      v0 = c.vf;
      // creatures: run small ones over, bounce off the big ones (long dinos: every body segment)
      for (const e of enemies) {
        if (!e.alive || e.y > c.y + 3 || e.y + e.h < c.y - 0.5) continue;
        let touched = false;
        enemyCircles(e, (qx, qz, qr) => {
          const ex = c.x - qx, ez = c.z - qz, min = qr + 1.5, d2 = ex * ex + ez * ez;
          if (d2 >= min * min) return;
          const dd = Math.sqrt(d2) || 1e-3;
          const sp = Math.abs(c.vf);
          const t = performance.now();
          if (!touched && sp > 4 && (ram.current.get(e.id) ?? 0) < t) {
            ram.current.set(e.id, t + 500);
            damageEnemy(e, sp * sp * 0.35, false, -ex / dd, -ez / dd, sp * 0.8);
            c.bump = Math.min(1, sp / 30);
          }
          touched = true;
          if (e.r > 1.2) { c.x += (ex / dd) * (min - dd); c.z += (ez / dd) * (min - dd); if (sp > 0.5) c.vf *= e.r > 2 ? -0.3 : 0.6; }
          else c.vf *= Math.exp(-0.6 * dt * 60 * 0.05);
        });
      }
      // dragons (physics bodies): a wall of scales - bounce off, hard
      for (const id in bodies) {
        const b = bodies[id];
        if (!b.on || c.y > b.y1 || c.y + 2 < b.y0) continue;
        const ex = c.x - b.x, ez = c.z - b.z, min = b.r + 1.6, d2 = ex * ex + ez * ez;
        if (d2 >= min * min) continue;
        const dd = Math.sqrt(d2) || 1e-3;
        c.x += (ex / dd) * (min - dd); c.z += (ez / dd) * (min - dd);
        // only kill the part of the velocity that drives into the body
        const into = -(Math.sin(c.yaw) * ex + Math.cos(c.yaw) * ez) / dd;
        if (into > 0.2 && c.vf > 0 || into < -0.2 && c.vf < 0) { c.bump = Math.max(c.bump, Math.min(1, Math.abs(c.vf) / 20)); c.vf *= -0.3; c.vl *= 0.3; }
      }
      // other cars: shove apart, swap a share of the forward momentum
      for (const o of cars.current) {
        if (o === c) continue;
        const ex = c.x - o.x, ez = c.z - o.z, min = 3.4, d2 = ex * ex + ez * ez;
        if (d2 >= min * min || Math.abs(c.y - o.y) > 2.5) continue;
        const dd = Math.sqrt(d2) || 1e-3, pen = (min - dd) / 2;
        c.x += (ex / dd) * pen; c.z += (ez / dd) * pen;
        o.x -= (ex / dd) * pen; o.z -= (ez / dd) * pen;
        // closing speed along the contact normal (world velocities)
        const cvx = Math.sin(c.yaw) * c.vf, cvz = Math.cos(c.yaw) * c.vf;
        const ovx = Math.sin(o.yaw) * o.vf, ovz = Math.cos(o.yaw) * o.vf;
        const close = ((ovx - cvx) * ex + (ovz - cvz) * ez) / dd;
        if (close <= 0) continue;
        const j = close * 0.6; // half the impulse each, a little lost to crumple
        const nx = ex / dd, nz = ez / dd;
        c.vf += (Math.sin(c.yaw) * nx + Math.cos(c.yaw) * nz) * j;
        o.vf -= (Math.sin(o.yaw) * nx + Math.cos(o.yaw) * nz) * j;
        c.bump = Math.max(c.bump, Math.min(1, close / 20)); o.bump = Math.max(o.bump, Math.min(1, close / 20));
        place(o);
      }
      lose(v0 !== c.vf && cars.current.some((o) => o !== c && Math.hypot(o.x - c.x, o.z - c.z) < 3.6) ? "hit" : "creature", v0);

      // ---- suspension / ground ----
      const hf = heightAt(c.x + fx * WB * 0.5, c.z + fz * WB * 0.5);
      const hb = heightAt(c.x - fx * WB * 0.5, c.z - fz * WB * 0.5);
      const hl = heightAt(c.x - rx * TRACK * 0.5, c.z - rz * TRACK * 0.5);
      const hr = heightAt(c.x + rx * TRACK * 0.5, c.z + rz * TRACK * 0.5);
      const g = (hf + hb + hl + hr) / 4;
      const wantPitch = -Math.atan2(hf - hb, WB);
      const wantRoll = Math.atan2(hr - hl, TRACK);
      if (c.air) {
        c.vy -= GRAV * dt;
        c.y += c.vy * dt;
        c.pitch += (Math.max(-0.5, Math.min(0.5, -c.vy * 0.02)) - c.pitch) * dt * 1.2;
        if (c.y <= g) {
          c.air = false;
          c.bump = Math.max(c.bump, Math.min(1, -c.vy / 18));
          c.y = g; c.vy = 0;
        }
      } else {
        const groundV = (g - c.lastG) / dt;
        // leave the ground over a crest when the terrain drops faster than the car would follow
        if (c.vy > 3 && groundV < c.vy - 4) { c.air = true; c.y = g + 0.05; }
        else { c.y = g; c.vy = THREE.MathUtils.clamp(groundV, -30, 30); }
        c.pitch += (wantPitch - c.pitch) * Math.min(1, dt * 10);
        c.roll += (wantRoll - c.roll) * Math.min(1, dt * 10);
      }
      c.lastG = g;
      c.bump *= Math.exp(-6 * dt);
      place(c);
    }

    // ---- driving camera + hand-off ----
    dt = frameDt;
    const c = drive.current;
    if (c) {
      ride.x = c.x; ride.y = c.y; ride.z = c.z;
      const l = look.current;
      l.idle += dt;
      if (l.idle > 1.4) { l.yaw *= Math.exp(-2.2 * dt); l.pitch += (0.18 - l.pitch) * Math.min(1, dt * 1.5); }
      const yaw = c.yaw + l.yaw;
      const spd = Math.abs(c.vf);
      const dist = 8.5 + spd * 0.06;
      const want = new THREE.Vector3(c.x - Math.sin(yaw) * dist * Math.cos(l.pitch), c.y + 2.2 + Math.sin(l.pitch) * dist, c.z - Math.cos(yaw) * dist * Math.cos(l.pitch));
      want.y = Math.max(want.y, heightAt(want.x, want.z) + 0.8);
      camPos.current.lerp(want, 1 - Math.exp(-9 * dt));
      const shake = c.bump * 0.25;
      camera.position.copy(camPos.current).add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
      camera.lookAt(c.x, c.y + 1.4, c.z);
      // player yaw convention: forward = (-sin, -cos)
      ride.camYaw = Math.atan2(-(c.x - camPos.current.x), -(c.z - camPos.current.z));
      ride.camPitch = -l.pitch;
      const cam = camera as THREE.PerspectiveCamera;
      const fov = 64 + Math.min(16, spd * 0.4);
      if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 4); cam.updateProjectionMatrix(); }
      // ---- speed-loss markers ----
      const L = loss.current;
      if (rawDt > 1 / 25) L.fps += (rawDt - frameDt) * ACCEL + (rawDt > 1 / 25 ? 0.02 : 0); // frames we had to drop / clamp
      const now = performance.now() / 1000;
      const H = hist.current;
      H.push({ t: now, v: spd });
      while (H.length && now - H[0].t > 0.6) H.shift();
      const top = () => (CAUSES.map((k) => [k, L[k]] as const).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]));
      const held = keys.current.KeyW || keys.current.ArrowUp;
      if (held && H.length > 2 && H[0].v - spd > 1.2 && now - lastEvt.current > 1) {
        lastEvt.current = now;
        const why = top().slice(0, 3).map(([k, v]) => `${LABEL[k]} −${(v * 3.6).toFixed(0)}`).join(", ") || "unknown";
        const ev = { t: +now.toFixed(1), x: Math.round(c.x), z: Math.round(c.z), from: Math.round(H[0].v * 3.6), to: Math.round(spd * 3.6), why };
        rideLog.push(ev);
        if (rideLog.length > 200) rideLog.shift();
        console.warn(`[ride] ${ev.from}→${ev.to} km/h at (${ev.x}, ${ev.z}): ${why}`);
      }
      hudT.current -= dt;
      if (hudT.current <= 0) {
        hudT.current = 0.1;
        const parts = top().slice(0, 3).map(([k, v]) => `${LABEL[k]} −${(v * 3.6 / 0.5).toFixed(0)}`);
        R.set({ kmh: Math.round(spd * 3.6), diag: parts.join(" · ") });
      }
      // decay: the numbers are "km/h lost per second" over roughly the last half second
      for (const k of CAUSES) L[k] *= Math.exp(-dt / 0.5);
    }
  });

  function place(c: Car) {
    // 56k-tri model: only draw it near the player, shadows only up close
    const d = Math.hypot(c.x - pose.x, c.z - pose.z);
    c.g.visible = d < 350;
    setShadow(c.g, d < 70);
    c.g.position.set(c.x, c.y, c.z);
    c.g.rotation.set(c.pitch, c.yaw, c.roll, "YXZ");
  }

  return <group ref={root} />;
}
