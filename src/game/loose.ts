import * as THREE from "three";
import { WATER_Y, heightAt } from "./terrain";
import { pushOut } from "./world/colliders";

// Loose rigid-ish props (barrels, crates): gravity, bouncing, rolling, sliding down slopes, floating,
// shoved by the player, kicked by bullets and blasts. They sleep when still and when far from the player.

export type Item = {
  kind: 0 | 1; // 0 barrel, 1 crate
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  q: THREE.Quaternion;
  yaw: number;
  rc: number; // collision radius (centre height above ground)
  still: number; // seconds at rest
  asleep: boolean;
};

export const items: Item[] = [];
const G = 18;
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _u = new THREE.Quaternion();

export function addItem(kind: 0 | 1, x: number, z: number, yaw: number) {
  const rc = 0.5;
  items.push({ kind, x, y: heightAt(x, z) + rc, z, vx: 0, vy: 0, vz: 0, q: new THREE.Quaternion().setFromAxisAngle(UP, yaw), yaw, rc, still: 0, asleep: false });
}

const wake = (it: Item) => { it.asleep = false; it.still = 0; };

export function kickLoose(p: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, power: number, rad = 1.1) {
  for (const it of items) {
    if (Math.hypot(it.x - p.x, it.y - p.y, it.z - p.z) > rad + it.rc) continue;
    it.vx += dir.x * power; it.vz += dir.z * power; it.vy += dir.y * power + power * 0.25;
    wake(it);
  }
}

export function blastLoose(p: { x: number; y: number; z: number }, radius: number, power: number) {
  const R = radius * 1.6;
  for (const it of items) {
    const dx = it.x - p.x, dy = it.y - p.y, dz = it.z - p.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > R) continue;
    const k = (1 - d / R) * power / Math.max(d, 0.5);
    it.vx += dx * k; it.vz += dz * k; it.vy += dy * k + (1 - d / R) * power * 0.4;
    wake(it);
  }
}

/** distance to the first loose prop along the ray (Infinity if none); direction normalised */
export function looseRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) {
  let best = Infinity;
  for (const it of items) {
    const fx = ox - it.x, fy = oy - it.y, fz = oz - it.z;
    const b = fx * dx + fy * dy + fz * dz;
    const c = fx * fx + fy * fy + fz * fz - 0.55 * 0.55;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t <= max && t < best) best = t;
  }
  return best;
}

export function stepLoose(dt: number, px: number, py: number, pz: number, pvx: number, pvz: number) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dp = Math.hypot(it.x - px, it.z - pz);
    if (dp > 260) continue;
    // player shoves anything it walks into (and wakes sleepers)
    const reach = it.rc + 0.5;
    if (dp < reach && Math.abs(py + 0.9 - it.y) < 1.4) {
      const nx = (it.x - px) / (dp || 1), nz = (it.z - pz) / (dp || 1);
      const toward = Math.max(0, pvx * nx + pvz * nz);
      const vn = it.vx * nx + it.vz * nz;
      const want = Math.max(vn, toward * 1.05 + 1.5);
      it.vx += nx * (want - vn);
      it.vz += nz * (want - vn);
      wake(it);
    }
    if (it.asleep) continue;

    it.vy -= G * dt;
    it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;

    const g = heightAt(it.x, it.z);
    const floor = Math.max(g, WATER_Y - 0.25);
    const inWater = g < WATER_Y - 0.15;
    let onGround = false;
    if (it.y - it.rc < floor) {
      it.y = floor + it.rc;
      if (inWater) {
        it.vy *= 0.2;
        it.vx *= Math.exp(-1.8 * dt); it.vz *= Math.exp(-1.8 * dt); // float and drift
      } else {
        if (it.vy < -2) { it.vy = -it.vy * 0.28; } else it.vy = 0;
        onGround = true;
        const e = 0.6;
        const gx = (heightAt(it.x + e, it.z) - heightAt(it.x - e, it.z)) / (2 * e);
        const gz = (heightAt(it.x, it.z + e) - heightAt(it.x, it.z - e)) / (2 * e);
        it.vx -= gx * G * 0.5 * dt; it.vz -= gz * G * 0.5 * dt; // slides downhill
        const f = Math.exp(-(it.kind === 0 ? 1.6 : 3.2) * dt);
        it.vx *= f; it.vz *= f;
      }
    }

    // scenery
    const p = { x: it.x, z: it.z };
    if (pushOut(p, it.rc, it.y - it.rc)) {
      const nx = p.x - it.x, nz = p.z - it.z;
      const l = Math.hypot(nx, nz) || 1;
      const vn = (it.vx * nx + it.vz * nz) / l;
      if (vn < 0) { it.vx -= (1.3 * vn * nx) / l; it.vz -= (1.3 * vn * nz) / l; }
      it.x = p.x; it.z = p.z;
    }
    // each other
    for (let j = i + 1; j < items.length; j++) {
      const o = items[j];
      const dx = o.x - it.x, dz = o.z - it.z;
      if (Math.abs(dx) > 1.1 || Math.abs(dz) > 1.1 || Math.abs(o.y - it.y) > 1) continue;
      const d = Math.hypot(dx, dz);
      const min = it.rc + o.rc;
      if (d >= min || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d, pen = (min - d) * 0.5;
      it.x -= nx * pen; it.z -= nz * pen; o.x += nx * pen; o.z += nz * pen;
      const rel = (it.vx - o.vx) * nx + (it.vz - o.vz) * nz;
      if (rel > 0) { it.vx -= nx * rel * 0.7; it.vz -= nz * rel * 0.7; o.vx += nx * rel * 0.7; o.vz += nz * rel * 0.7; wake(o); }
    }

    // orientation: roll with the motion, then settle upright again
    const sp = Math.hypot(it.vx, it.vz);
    if (sp > 0.15 && onGround) {
      _a.set(it.vz, 0, -it.vx).normalize();
      _q.setFromAxisAngle(_a, (sp * dt) / it.rc * 0.55);
      it.q.premultiply(_q);
    }
    _u.setFromAxisAngle(UP, it.yaw);
    it.q.slerp(_u, 1 - Math.exp(-(onGround ? (sp < 1 ? 5 : 1.4) : 0.2) * dt)).normalize();

    if (onGround && sp < 0.06 && Math.abs(it.vy) < 0.1) {
      it.still += dt;
      if (it.still > 1) { it.asleep = true; it.vx = it.vz = it.vy = 0; }
    } else it.still = 0;
  }
}
