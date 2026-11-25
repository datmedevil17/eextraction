import { create } from "zustand";
import { GUN_BY_ID, START_GUN } from "./arsenal";
import { ctl, ride } from "@/game/store";
import { sfx } from "./audio";

// Shared combat state. Mutable objects for the hot path, one small zustand store for the HUD.

export interface Enemy {
  id: number;
  x: number;
  y: number;
  z: number;
  r: number; // body radius
  h: number; // height
  hp: number;
  maxHp: number;
  alive: boolean;
  pain: number; // hit flash timer
  vx: number; // knockback / vortex velocity
  vz: number;
  burn: number; // seconds left
  burnDps: number;
  tag: string;
  len?: number; // long bodies (big dinos): nose-to-tail length, hit as a chain of spheres along (fx, fz)
  fx?: number;
  fz?: number;
}

// sphere chain for long bodies: [offset along length, height fraction, radius fraction, is head]
const SEGS: [number, number, number, boolean][] = [
  [0.42, 0.85, 0.5, true], [0.27, 0.68, 0.55, false], [0.1, 0.5, 1, false],
  [-0.12, 0.5, 1, false], [-0.29, 0.42, 0.6, false], [-0.43, 0.32, 0.4, false],
];
const isLong = (e: Enemy) => !!e.len && e.len > e.r * 3;

/** Ground-plane circles of an enemy's body (one for normal ones, a chain for long dinos). */
export function enemyCircles(e: Enemy, cb: (x: number, z: number, r: number) => void) {
  if (!isLong(e)) { cb(e.x, e.z, e.r); return; }
  const L = e.len!, fx = e.fx ?? 0, fz = e.fz ?? 1;
  for (const [o, , rf] of SEGS) cb(e.x + fx * o * L, e.z + fz * o * L, e.r * rf);
}

export const enemies: Enemy[] = [];
let nextId = 1;
export const makeEnemy = (tag: string, r: number, h: number, hp: number): Enemy => ({
  id: nextId++, x: 0, y: 0, z: 0, r, h, hp, maxHp: hp, alive: true, pain: 0, vx: 0, vz: 0, burn: 0, burnDps: 0, tag,
});

type Hud = {
  gun: string;
  mag: number;
  magMax: number;
  reloading: number; // 0..1 progress, 0 = idle
  charge: number;
  hp: number;
  maxHp: number;
  rad: number;
  kills: number;
  hitSeq: number;
  hitHead: boolean;
  hitKill: boolean;
  hurtSeq: number;
  ads: boolean;
  scopeOn: boolean;
  scope: number; // current magnification (0 = not scoped)
  breath: number; // 0..1 hold-breath stamina
  owned: string[];
  set: (p: Partial<Hud>) => void;
};

export const useHud = create<Hud>((set) => ({
  gun: START_GUN,
  mag: GUN_BY_ID[START_GUN].mag,
  magMax: GUN_BY_ID[START_GUN].mag,
  reloading: 0,
  charge: 0,
  hp: 100,
  maxHp: 100,
  rad: 0,
  kills: 0,
  hitSeq: 0,
  hitHead: false,
  hitKill: false,
  hurtSeq: 0,
  ads: false,
  scopeOn: false,
  scope: 0,
  breath: 1,
  owned: [],
  set: (p) => set(p),
}));

/** Grass-village guard (Knights.tsx / Villagers.tsx): `anger` > 0 = seconds the knights stay hostile to the
 *  player after the player hurt a villager or a knight. */
export const guard = { anger: 0, assassins: 0 }; // assassins: seconds the oasis rogues stay hostile (Assassins.tsx)
/** Villagers, calm knights, calm assassins: homing rounds / chain arcs never pick them on their own. */
export const friendly = (e: Enemy) =>
  e.tag === "villager" || (e.tag === "knight" && guard.anger <= 0) || (e.tag === "assassin" && guard.assassins <= 0);

/** magazine contents per gun (reserve ammo is unlimited for now) */
export const mags: Record<string, number> = Object.fromEntries(Object.values(GUN_BY_ID).map((g) => [g.id, g.mag]));

export function damageEnemy(e: Enemy, dmg: number, head: boolean, dx: number, dz: number, knock = 0) {
  if (!e.alive) return false;
  e.hp -= dmg;
  e.pain = 0.18;
  const l = Math.hypot(dx, dz) || 1;
  e.vx += (dx / l) * knock;
  e.vz += (dz / l) * knock;
  const killed = e.hp <= 0;
  if (killed) e.alive = false;
  const h = useHud.getState();
  h.set({ hitSeq: h.hitSeq + 1, hitHead: head, hitKill: killed, kills: h.kills + (killed ? 1 : 0) });
  sfx.hit(head);
  return killed;
}

export function hurtPlayer(d: number) {
  if (ride.plane) return; // nothing attacks the plane (for now)
  const h = useHud.getState();
  const hp = h.hp - d;
  sfx.hurt();
  if (hp <= 0) {
    ctl.respawn = true;
    h.set({ hp: h.maxHp, hurtSeq: h.hurtSeq + 1 });
  } else h.set({ hp, hurtSeq: h.hurtSeq + 1 });
}

/** ray vs sphere: distance along the ray or -1 */
export function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/** hit test against an enemy: body sphere + head sphere. Returns [t, head] or null. */
export function rayEnemy(e: Enemy, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, pad = 0): [number, boolean] | null {
  let best = -1, head = -1;
  if (isLong(e)) {
    const L = e.len!, fx = e.fx ?? 0, fz = e.fz ?? 1;
    for (const [o, yf, rf, hd] of SEGS) {
      const t = raySphere(ox, oy, oz, dx, dy, dz, e.x + fx * o * L, e.y + e.h * yf, e.z + fz * o * L, e.r * rf + pad);
      if (t < 0) continue;
      if (hd) head = t;
      else if (best < 0 || t < best) best = t;
    }
  } else {
    head = raySphere(ox, oy, oz, dx, dy, dz, e.x, e.y + e.h * 0.9, e.z, e.r * 0.5 + pad);
    for (const f of [0.28, 0.55]) {
      const t = raySphere(ox, oy, oz, dx, dy, dz, e.x, e.y + e.h * f, e.z, e.r + pad);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
  }
  if (head >= 0 && (best < 0 || head <= best + 0.05)) return [head, true];
  return best >= 0 ? [best, false] : null;
}

/** Last loud noise (gunshot etc.). Zombies check `seq` each frame and go investigate. */
export const noise = { x: 0, z: 0, r: 0, seq: 0 };
export function makeNoise(x: number, z: number, r: number) {
  noise.x = x;
  noise.z = z;
  noise.r = r;
  noise.seq++;
}
