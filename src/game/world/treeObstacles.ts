import type { Placement } from "./propsStream";

// Streamed props (trees, rocks, cacti) are instanced meshes without colliders. Their placement is deterministic,
// so species flagged `solid` register their generator here and we re-run it per 64 m cell on demand:
//   * pushOutProps / rayProps -> the player, cars, creatures and bullets collide with trunks and rocks
//   * treesNear               -> big creatures (the 46 m frost dragon) plan around whole crowns
export type Solid = { r: number; h: number; minS?: number; crown?: number }; // sizes at scale 1
type Src = Solid & { gen: (cx: number, cz: number) => Placement[] };
type P = { x: number; z: number; y0: number; y1: number; r: number; crown: number }; // crown 0 = not a tree
const srcs = new Map<string, Src>(); // keyed, so a remount / StrictMode re-run doesn't double-register
const CELL = 64;
const cache = new Map<string, P[]>();

export function registerSolid(id: string, gen: Src["gen"], s: Solid) {
  srcs.set(id, { ...s, gen });
  cache.clear();
}

function cell(cx: number, cz: number) {
  const k = `${cx},${cz}`;
  let l = cache.get(k);
  if (!l) {
    l = [];
    for (const s of srcs.values())
      for (const p of s.gen(cx, cz)) {
        if (p.s < (s.minS ?? 0)) continue;
        l.push({ x: p.x, z: p.z, y0: p.y - 1, y1: p.y + s.h * p.s, r: s.r * p.s, crown: (s.crown ?? 0) * p.s });
      }
    if (cache.size > 3000) cache.clear();
    cache.set(k, l);
  }
  return l;
}

function each(x: number, z: number, rad: number, f: (t: P) => void) {
  for (let j = Math.floor((z - rad) / CELL); j <= Math.floor((z + rad) / CELL); j++)
    for (let i = Math.floor((x - rad) / CELL); i <= Math.floor((x + rad) / CELL); i++) for (const t of cell(i, j)) f(t);
}

/** Number of trees whose crown comes within `rad` of (x, z). */
export function treesNear(x: number, z: number, rad: number) {
  let n = 0;
  each(x, z, rad + 8, (t) => {
    if (!t.crown) return; // rocks / cacti: a dragon just steps over them
    const m = rad + t.crown, dx = t.x - x, dz = t.z - z;
    if (dx * dx + dz * dz < m * m) n++;
  });
  return n;
}

/** Push a circle out of trunks / rocks. `y` = feet height (you can stand on top of low rocks). */
export function pushOutProps(p: { x: number; z: number }, rad: number, y = -1e9) {
  if (!srcs.size) return false;
  let hit = false;
  each(p.x, p.z, rad + 9, (t) => {
    if (y > t.y1 - 0.35) return; // on top of it (or stepping over)
    const dx = p.x - t.x, dz = p.z - t.z, min = t.r + rad, d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return;
    const d = Math.sqrt(d2) || 1e-4;
    p.x = t.x + (dx / d) * min;
    p.z = t.z + (dz / d) * min;
    hit = true;
  });
  return hit;
}

/** First ray hit distance against trunks / rocks (Infinity if none). Direction normalised. */
export function rayProps(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) {
  if (!srcs.size) return Infinity;
  let best = Infinity;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return best;
  // walk the cells along the ray (64 m cells, few of them for gun ranges)
  const steps = Math.ceil(max / 48);
  const seen = new Set<string>();
  for (let s = 0; s <= steps; s++) {
    const px = ox + dx * Math.min(max, s * 48), pz = oz + dz * Math.min(max, s * 48);
    for (let j = Math.floor((pz - 34) / CELL); j <= Math.floor((pz + 34) / CELL); j++)
      for (let i = Math.floor((px - 34) / CELL); i <= Math.floor((px + 34) / CELL); i++) {
        const k = `${i},${j}`;
        if (seen.has(k)) continue;
        seen.add(k);
        for (const c of cell(i, j)) {
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
  }
  return best;
}
