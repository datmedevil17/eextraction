import { pushOutProps, rayProps } from "./treeObstacles";

// Static colliders (towers, buildings, tanks): circles, or yawed boxes for rectangular footprints.
// Spatial hash on 64 m cells. Each has a top height, so bullets can fly over low things and players
// can't walk through tall ones.

/** r = bounding radius. Boxes also carry half extents (hx, hz) and the yaw's cos/sin (same sense as Object3D.rotation.y). */
export type Collider = { x: number; z: number; r: number; y0: number; y1: number; hx?: number; hz?: number; c?: number; s?: number };
const CS = 64;
const grid = new Map<string, Collider[]>();
const key = (i: number, j: number) => `${i},${j}`;

export function addCollider(x: number, z: number, r: number, y0 = -5, y1 = 999) {
  insert({ x, z, r, y0, y1 });
}

/** Rectangular footprint w (local x) by d (local z), turned by `yaw` like a mesh's rotation.y. */
export function addBoxCollider(x: number, z: number, w: number, d: number, yaw: number, y0 = -5, y1 = 999) {
  insert({ x, z, r: Math.hypot(w, d) / 2, y0, y1, hx: w / 2, hz: d / 2, c: Math.cos(yaw), s: Math.sin(yaw) });
}

// world offset -> box-local (inverse of rotation.y)
const toLocal = (c: Collider, dx: number, dz: number): [number, number] => [dx * c.c! - dz * c.s!, dx * c.s! + dz * c.c!];
const toWorld = (c: Collider, lx: number, lz: number): [number, number] => [lx * c.c! + lz * c.s!, -lx * c.s! + lz * c.c!];

function insert(c: Collider) {
  const { x, z, r } = c;
  const i0 = Math.floor((x - r) / CS), i1 = Math.floor((x + r) / CS);
  const j0 = Math.floor((z - r) / CS), j1 = Math.floor((z + r) / CS);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = key(i, j);
      const l = grid.get(k);
      if (l) l.push(c);
      else grid.set(k, [c]);
    }
}

/** Push a circle (x, z, radius) out of every collider. `y` = feet height (skip colliders you stand above). */
export function pushOut(p: { x: number; z: number }, rad: number, y = 0) {
  const i0 = Math.floor((p.x - rad) / CS), i1 = Math.floor((p.x + rad) / CS);
  const j0 = Math.floor((p.z - rad) / CS), j1 = Math.floor((p.z + rad) / CS);
  let hit = false;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const l = grid.get(key(i, j));
      if (!l) continue;
      for (const c of l) {
        if (y > c.y1) continue;
        if (c.hx !== undefined) { if (pushBox(c, p, rad)) hit = true; continue; }
        const dx = p.x - c.x, dz = p.z - c.z;
        const min = c.r + rad;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 1e-4;
        p.x = c.x + (dx / d) * min;
        p.z = c.z + (dz / d) * min;
        hit = true;
      }
    }
  if (pushOutProps(p, rad, y === 0 ? -1e9 : y)) hit = true; // trees + rocks (y=0 = spawn checks: anything counts)
  return hit;
}

function pushBox(c: Collider, p: { x: number; z: number }, rad: number) {
  const [lx, lz] = toLocal(c, p.x - c.x, p.z - c.z);
  const hx = c.hx!, hz = c.hz!;
  if (Math.abs(lx) >= hx + rad || Math.abs(lz) >= hz + rad) return false;
  const qx = Math.max(-hx, Math.min(hx, lx)), qz = Math.max(-hz, Math.min(hz, lz));
  let nx: number, nz: number;
  if (qx === lx && qz === lz) {
    // centre inside the box: leave by the nearest face
    const ex = hx - Math.abs(lx), ez = hz - Math.abs(lz);
    if (ex < ez) { nx = Math.sign(lx || 1) * (hx + rad); nz = lz; } else { nx = lx; nz = Math.sign(lz || 1) * (hz + rad); }
  } else {
    const ddx = lx - qx, ddz = lz - qz, d2 = ddx * ddx + ddz * ddz;
    if (d2 >= rad * rad) return false;
    const d = Math.sqrt(d2) || 1e-4;
    nx = qx + (ddx / d) * rad; nz = qz + (ddz / d) * rad;
  }
  const [wx, wz] = toWorld(c, nx, nz);
  p.x = c.x + wx; p.z = c.z + wz;
  return true;
}

/** 2D ray vs yawed box (slab test in box space); entry distance or -1. */
function rayBox(c: Collider, ox: number, oz: number, dx: number, dz: number) {
  const [lx, lz] = toLocal(c, ox - c.x, oz - c.z);
  const [ldx, ldz] = toLocal(c, dx, dz);
  let t0 = -Infinity, t1 = Infinity;
  for (const [o, d, h] of [[lx, ldx, c.hx!], [lz, ldz, c.hz!]]) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(o) > h) return -1; continue; }
    let a = (-h - o) / d, b = (h - o) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return -1;
  }
  if (t1 < 0) return -1;
  return Math.max(0, t0);
}

/** First ray hit distance against the colliders (Infinity if none). Direction must be normalised. */
export function rayColliders(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) {
  const ex = ox + dx * max, ez = oz + dz * max;
  const i0 = Math.floor(Math.min(ox, ex) / CS), i1 = Math.floor(Math.max(ox, ex) / CS);
  const j0 = Math.floor(Math.min(oz, ez) / CS), j1 = Math.floor(Math.max(oz, ez) / CS);
  let best = Infinity;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const l = grid.get(key(i, j));
      if (!l) continue;
      for (const c of l) {
        const a = dx * dx + dz * dz;
        if (a < 1e-9) continue;
        if (c.hx !== undefined) {
          const t = rayBox(c, ox, oz, dx, dz);
          if (t < 0 || t > max || t >= best) continue;
          const y = oy + dy * t;
          if (y < c.y0 || y > c.y1) continue;
          best = t;
          continue;
        }
        const fx = ox - c.x, fz = oz - c.z;
        const b = fx * dx + fz * dz;
        const cc = fx * fx + fz * fz - c.r * c.r;
        const disc = b * b - a * cc;
        if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / a;
        if (t < 0 || t > max || t >= best) continue;
        const y = oy + dy * t;
        if (y < c.y0 || y > c.y1) continue;
        best = t;
      }
    }
  return Math.min(best, rayProps(ox, oy, oz, dx, dy, dz, Math.min(max, best)));
}

/** True if (x, z) lies inside any collider grown by `pad` metres (used to keep scattered props out of buildings). */
export function blocked(x: number, z: number, pad = 0) {
  for (let j = Math.floor((z - pad) / CS); j <= Math.floor((z + pad) / CS); j++)
    for (let i = Math.floor((x - pad) / CS); i <= Math.floor((x + pad) / CS); i++) {
      const l = grid.get(key(i, j));
      if (!l) continue;
      for (const c of l) {
        if (c.hx !== undefined) {
          const [lx, lz] = toLocal(c, x - c.x, z - c.z);
          const ox = Math.max(0, Math.abs(lx) - c.hx), oz = Math.max(0, Math.abs(lz) - c.hz!);
          if (ox * ox + oz * oz < pad * pad || (ox === 0 && oz === 0)) return true;
          continue;
        }
        const m = c.r + pad;
        if ((x - c.x) ** 2 + (z - c.z) ** 2 < m * m) return true;
      }
    }
  return false;
}
