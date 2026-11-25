import { enemies, enemyCircles } from "@/game/weapons/combat";

// Dynamic solid bodies (big creatures) the player can't walk through. Static scenery lives in
// world/colliders.ts; zombies come from the shared `enemies` list.

export type Body = { x: number; z: number; r: number; y0: number; y1: number; on: boolean };
export const bodies: Record<string, Body> = {};

export function setBody(id: string, x: number, z: number, r: number, y0: number, y1: number, on = true) {
  const b = (bodies[id] ??= { x, z, r, y0, y1, on });
  b.x = x; b.z = z; b.r = r; b.y0 = y0; b.y1 = y1; b.on = on;
}

/** Push a circle out of dragons and living zombies. `y` = feet height, `h` = body height. Returns true if it moved. */
export function pushOutCreatures(p: { x: number; z: number }, rad: number, y: number, h = 1.8) {
  let hit = false;
  const push = (cx: number, cz: number, r: number, soft: number) => {
    const dx = p.x - cx, dz = p.z - cz;
    const min = r + rad;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return;
    const d = Math.sqrt(d2) || 1e-4;
    const pen = (min - d) * soft;
    p.x += (dx / d) * pen;
    p.z += (dz / d) * pen;
    hit = true;
  };
  for (const b of Object.values(bodies)) {
    if (!b.on || y > b.y1 || y + h < b.y0) continue;
    push(b.x, b.z, b.r, 1);
  }
  for (const e of enemies) {
    if (!e.alive || y > e.y + e.h || y + h < e.y) continue;
    enemyCircles(e, (x, z, r) => push(x, z, r, 0.6)); // creatures give a little, so you can't be pinned
  }
  return hit;
}
