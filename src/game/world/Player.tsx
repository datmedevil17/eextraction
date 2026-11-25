"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { pushOut } from "./colliders";
import { PLAY_LIMIT, WATER_Y, heightAt, lakeMask, waterDepth } from "@/game/terrain";
import { ctl, pose, ride, useGame } from "@/game/store";
import { pushOutCreatures } from "@/game/physics";
import { hurtPlayer } from "@/game/weapons/combat";

const EYE = 1.7;
const WALK = 4.2;
const SPRINT = 7.6;
const GRAVITY = 18;
const JUMP = 5.6;
const COYOTE = 0.12; // can still jump this long after leaving a ledge
const BUFFER = 0.12; // jump pressed slightly before landing still counts
const SLOPE_MAX = 0.95; // steeper than this (about 43 degrees) you cannot climb and you slide
const FALL_SAFE = 11; // landing faster than this (m/s) hurts
const SWIM_DEPTH = 1.25;
const SENS = 0.0022;

// Menu camera: low in the grass, looking toward the horizon with the sun to one side.
const MENU_YAW = 0.35;
const MENU_PITCH = 0.14;

export function Player() {
  const { camera, gl } = useThree();
  const s = useRef({
    yaw: MENU_YAW,
    pitch: MENU_PITCH,
    pos: new THREE.Vector3(0, 0, 10),
    vel: new THREE.Vector3(),
    vy: 0,
    grounded: true,
    bob: 0,
    fov: 62,
    air: 0, // seconds since last on the ground
    buf: 0, // jump buffer
    dip: 0, // camera dip after landing
    swim: false,
    prevSpace: false,
  });
  const keys = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      if (e.code === "Space" && useGame.getState().phase === "playing") e.preventDefault();
    };
    const up = (e: KeyboardEvent) => (keys.current[e.code] = false);
    const move = (e: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) return;
      const st = s.current;
      const sens = SENS * Math.max(0.12, ctl.zoom); // slower aim when zoomed
      st.yaw -= e.movementX * sens;
      st.pitch = THREE.MathUtils.clamp(st.pitch - e.movementY * sens, -1.45, 1.45);
    };
    const lockChange = () => {
      const { phase, setPhase } = useGame.getState();
      if (document.pointerLockElement !== gl.domElement && phase === "playing") setPhase("paused");
    };
    const lockError = () => useGame.getState().setPhase("paused");

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    document.addEventListener("mousemove", move);
    document.addEventListener("pointerlockchange", lockChange);
    document.addEventListener("pointerlockerror", lockError);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("pointerlockchange", lockChange);
      document.removeEventListener("pointerlockerror", lockError);
    };
  }, [gl]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1); // big enough that low fps doesn't become slow motion
    const st = s.current;
    const phase = useGame.getState().phase;
    const cam = camera as THREE.PerspectiveCamera;
    cam.rotation.order = "YXZ";

    if (ctl.respawn) {
      ctl.respawn = false;
      st.pos.set(0, 0, 10);
      st.vel.set(0, 0, 0);
      st.pos.y = heightAt(0, 10) + 0.5;
    }
    if (ctl.teleport) {
      const { x, z } = ctl.teleport;
      ctl.teleport = null;
      const t = { x, z };
      pushOut(t, 1.5, 0);
      st.pos.set(t.x, heightAt(t.x, t.z) + 0.5, t.z);
      st.vel.set(0, 0, 0);
      st.vy = 0;
    }
    if (ride.on) {
      // driving: the vehicle owns the camera; we just ride along (so pose / minimap / enemies follow)
      st.pos.set(ride.x, ride.y, ride.z);
      st.vel.set(0, 0, 0);
      st.vy = 0;
      st.grounded = true;
      st.yaw = ride.camYaw;
      st.pitch = THREE.MathUtils.clamp(ride.camPitch, -0.6, 0.6);
      ctl.pitch = ctl.yaw = 0;
      pose.x = st.pos.x; pose.y = st.pos.y; pose.z = st.pos.z; pose.yaw = st.yaw;
      st.fov = cam.fov;
      return;
    }
    if (phase === "playing") {
      st.pitch = THREE.MathUtils.clamp(st.pitch + ctl.pitch, -1.45, 1.45);
      st.yaw += ctl.yaw;
      ctl.pitch = ctl.yaw = 0;
      const k = keys.current;
      const fwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
      const strafe = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
      const sprinting = !!(k.ShiftLeft || k.ShiftRight) && fwd > 0;
      // wading: deeper water slows you down
      const depth = waterDepth(st.pos.x, st.pos.z);
      const speed = (sprinting ? SPRINT : WALK) * (1 - Math.min(depth, 1.2) * 0.4);

      const sin = Math.sin(st.yaw);
      const cos = Math.cos(st.yaw);
      let tx = -sin * fwd + cos * strafe;
      let tz = -cos * fwd - sin * strafe;
      const len = Math.hypot(tx, tz);
      if (len > 0) {
        tx = (tx / len) * speed;
        tz = (tz / len) * speed;
      }
      st.swim = depth > SWIM_DEPTH && st.pos.y < WATER_Y - 0.2;
      // polished lake ice is slippery: low traction, you slide
      const onIce = st.grounded && lakeMask(st.pos.x, st.pos.z) > 0.6;
      const a = 1 - Math.exp(-(onIce ? 1.4 : st.grounded ? 12 : st.swim ? 4 : 3) * dt);
      const sp = st.swim ? 0.55 : 1;
      st.vel.x += (tx * sp - st.vel.x) * a;
      st.vel.z += (tz * sp - st.vel.z) * a;

      // steep slopes: you cannot walk up them, and you slide down
      if (st.grounded && !st.swim) {
        const e = 0.7;
        const gx = (heightAt(st.pos.x + e, st.pos.z) - heightAt(st.pos.x - e, st.pos.z)) / (2 * e);
        const gz = (heightAt(st.pos.x, st.pos.z + e) - heightAt(st.pos.x, st.pos.z - e)) / (2 * e);
        const g = Math.hypot(gx, gz);
        if (g > SLOPE_MAX) {
          const ux = gx / g, uz = gz / g; // uphill
          const up = st.vel.x * ux + st.vel.z * uz;
          if (up > 0) { st.vel.x -= up * ux; st.vel.z -= up * uz; }
          const slide = Math.min(1, (g - SLOPE_MAX) * 2.2) * 16 * dt;
          st.vel.x -= ux * slide;
          st.vel.z -= uz * slide;
        }
      }

      st.pos.x = THREE.MathUtils.clamp(st.pos.x + st.vel.x * dt, -PLAY_LIMIT, PLAY_LIMIT);
      st.pos.z = THREE.MathUtils.clamp(st.pos.z + st.vel.z * dt, -PLAY_LIMIT, PLAY_LIMIT);

      pushOut(st.pos, 0.45, st.pos.y);
      pushOutCreatures(st.pos, 0.45, st.pos.y);
      const ground = heightAt(st.pos.x, st.pos.z);

      st.air = st.grounded ? 0 : st.air + dt;
      st.buf = k.Space ? (st.buf > 0 || !st.prevSpace ? BUFFER : st.buf) : Math.max(0, st.buf - dt);
      st.prevSpace = !!k.Space;
      if (st.buf > 0 && (st.grounded || st.air < COYOTE) && !st.swim) {
        st.vy = JUMP;
        st.grounded = false;
        st.air = COYOTE;
        st.buf = 0;
      }

      if (st.swim) {
        // buoyancy: float with the head above water, Space to climb out, a swimmer's drag on everything
        const want = WATER_Y - 1.05 + (k.Space ? 0.9 : 0);
        st.vy += ((want - st.pos.y) * 3.2 - st.vy) * Math.min(1, dt * 5);
        st.pos.y += st.vy * dt;
        st.grounded = false;
        if (st.pos.y < ground) { st.pos.y = ground; st.vy = Math.max(0, st.vy); }
      } else {
        st.vy -= GRAVITY * dt;
        const impact = st.vy;
        st.pos.y += st.vy * dt;
        if (st.pos.y <= ground) {
          if (!st.grounded && impact < -6) {
            st.dip = Math.min(0.35, (-impact - 6) * 0.03);
            if (impact < -FALL_SAFE && depth < 0.6) hurtPlayer((-impact - FALL_SAFE) * 5);
          }
          st.pos.y = ground;
          st.vy = 0;
          st.grounded = true;
        } else if (st.grounded && st.pos.y - ground < 0.4 && st.vy <= 0) {
          st.pos.y = ground; // glue to slopes when walking downhill
        } else if (st.pos.y > ground + 0.001) {
          st.grounded = false;
        }
      }
      st.dip *= Math.exp(-9 * dt);

      const planar = Math.hypot(st.vel.x, st.vel.z);
      if (st.grounded && planar > 0.5) st.bob += dt * planar * 1.5;
      const bobY = st.grounded ? Math.sin(st.bob * 2) * 0.035 * Math.min(1, planar / WALK) : 0;
      const bobX = st.grounded ? Math.cos(st.bob) * 0.02 * Math.min(1, planar / WALK) : 0;

      cam.position.set(st.pos.x, st.pos.y + EYE + bobY - st.dip, st.pos.z);
      cam.rotation.set(st.pitch, st.yaw, bobX * 0.15);

      const targetFov = (sprinting && planar > 5 ? 70 : 64) * ctl.zoom;
      st.fov += (targetFov - st.fov) * (1 - Math.exp(-(ctl.zoom < 1 ? 14 : 6) * dt));
    } else {
      // Menu / paused: slow cinematic drift, standing at the spawn point.
      const t = state.clock.elapsedTime;
      st.vel.set(0, 0, 0);
      st.vy = 0;
      st.grounded = true;
      st.pos.y = heightAt(st.pos.x, st.pos.z);
      if (phase === "menu") {
        st.yaw = MENU_YAW + Math.sin(t * 0.07) * 0.16;
        st.pitch = MENU_PITCH + Math.sin(t * 0.05) * 0.02;
      }
      const eye = phase === "arsenal" ? EYE : 1.15 + Math.sin(t * 0.3) * 0.02;
      cam.position.set(st.pos.x, st.pos.y + eye, st.pos.z);
      cam.rotation.set(st.pitch, st.yaw, 0);
      st.fov += (62 - st.fov) * (1 - Math.exp(-4 * dt));
    }

    pose.x = st.pos.x;
    pose.y = st.pos.y;
    pose.z = st.pos.z;
    pose.yaw = st.yaw;

    if (Math.abs(cam.fov - st.fov) > 0.01) {
      cam.fov = st.fov;
      cam.updateProjectionMatrix();
    }
  });

  return null;
}
