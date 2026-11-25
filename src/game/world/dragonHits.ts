import { raySphere, useHud } from "@/game/weapons/combat";
import { sfx } from "@/game/weapons/audio";

// Shootable dragons (the plane's guns + rockets): each registers a chain of hit spheres it refreshes every frame.

export type DragonTarget = {
  id: string;
  label: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  flash: number; // hit flash timer (s), the dragon fades its tint with it
  /** sphere chain x, y, z, r (world), `n` used */
  s: Float32Array;
  n: number;
};

export const dragonTargets: Record<string, DragonTarget> = {};

export const makeDragonTarget = (id: string, label: string, hp: number, spheres = 12): DragonTarget => ({
  id, label, hp, maxHp: hp, alive: true, flash: 0, s: new Float32Array(spheres * 4), n: 0,
});

/** Nearest hit along a ray (direction normalised) within max: [t, target] or null. */
export function rayDragon(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, pad = 0): [number, DragonTarget] | null {
  let best = max, hit: DragonTarget | null = null;
  for (const id in dragonTargets) {
    const tg = dragonTargets[id];
    if (!tg.alive) continue;
    for (let i = 0; i < tg.n; i++) {
      const k = i * 4;
      const t = raySphere(ox, oy, oz, dx, dy, dz, tg.s[k], tg.s[k + 1], tg.s[k + 2], tg.s[k + 3] + pad);
      if (t >= 0 && t < best) { best = t; hit = tg; }
    }
  }
  return hit ? [best, hit] : null;
}

/** Targets whose spheres come within r of a point (splash damage): calls cb with the falloff 0..1. */
export function dragonsNear(x: number, y: number, z: number, r: number, cb: (tg: DragonTarget, k: number) => void) {
  for (const id in dragonTargets) {
    const tg = dragonTargets[id];
    if (!tg.alive) continue;
    let best = Infinity;
    for (let i = 0; i < tg.n; i++) {
      const k = i * 4;
      const d = Math.hypot(tg.s[k] - x, tg.s[k + 1] - y, tg.s[k + 2] - z) - tg.s[k + 3];
      if (d < best) best = d;
    }
    if (best < r) cb(tg, 1 - Math.max(0, best) / r);
  }
}

export function damageDragon(tg: DragonTarget, dmg: number) {
  if (!tg.alive) return false;
  tg.hp -= dmg;
  tg.flash = 0.12;
  const killed = tg.hp <= 0;
  if (killed) { tg.alive = false; tg.hp = 0; }
  const h = useHud.getState();
  h.set({ hitSeq: h.hitSeq + 1, hitHead: false, hitKill: killed, kills: h.kills + (killed ? 1 : 0) });
  sfx.hit(false);
  return killed;
}
