import { NUKE_CX, NUKE_CZ, NUKE_POOLS, hash2, nukeCity, seededRandom, terrainHeight } from "@/game/terrain";
import { addBoxCollider, addCollider } from "./colliders";

// Deterministic layout of the reactor complex and the ruined city (same on every client).

export const PLANT = { x: NUKE_CX, z: NUKE_CZ };
export const CITY = { x: 1330, z: -400 };

export type Item = { x: number; z: number; r: number; s?: number };

// cooling towers (hyperboloid, ~120 m)
export const TOWERS: Item[] = [
  { x: 1215, z: -78, r: 0 },
  { x: 1215, z: 78, r: 0 },
  { x: 1290, z: -135, r: 0 },
  { x: 1290, z: 135, r: 0 },
];
export const REACTOR = { x: 1300, z: 0 };
export const STACKS: Item[] = [
  { x: 1160, z: -30, r: 0 },
  { x: 1160, z: 34, r: 0 },
];
export const HALLS: Item[] = [
  { x: 1370, z: -80, r: 0.2 },
  { x: 1380, z: 82, r: -0.15 },
];
export const TOWER_H = 120;
export const STACK_H = 150;

/** Skyscraper placements by size class. cls = height index * 2 + footprint index. */
export const HEIGHTS = [45, 65, 90, 120, 155, 190];
export const FOOTS = [22, 30];
export type Sky = { x: number; z: number; cls: number; r: number; variant: number };
export const SKY: Sky[] = [];
(() => {
  const rnd = seededRandom(90210);
  for (let i = -3; i <= 3; i++)
    for (let j = -3; j <= 3; j++) {
      const x = CITY.x - 30 + i * 60 + 0; // block centres sit at x ≡ 30 (mod 60)
      const z = CITY.z + j * 60 + (40 - (((CITY.z % 60) + 60) % 60)); // z ≡ 40 (mod 60)
      const bx = Math.round((x - 30) / 60) * 60 + 30;
      const bz = Math.round((z - 40) / 60) * 60 + 40;
      const d = Math.hypot(bx - CITY.x, bz - CITY.z);
      if (d > 175 || nukeCity(bx, bz) < 0.5) continue;
      if (rnd() < 0.2) continue; // empty lot
      const core = 1 - d / 190;
      const h = Math.min(5, Math.floor(Math.pow(rnd(), 1.3) * 3 + core * 3.2));
      SKY.push({ x: bx, z: bz, cls: h * 2 + (rnd() < 0.5 ? 0 : 1), r: Math.floor(rnd() * 4) * (Math.PI / 2), variant: Math.floor(rnd() * 4) });
    }
})();

export const POOLS = NUKE_POOLS;

/** Zombie spawn areas: [x, z, radius, weight] */
export const HOTSPOTS: [number, number, number, number][] = [
  [1250, 20, 70, 3], // plant yard
  [1190, -140, 40, 1],
  [1330, -330, 80, 3], // city south
  [1330, -440, 70, 3], // city centre
  [1100, 60, 60, 2], // main road approach
  [1420, 130, 50, 1],
];

export function registerColliders() {
  const y = (x: number, z: number) => terrainHeight(x, z);
  for (const t of TOWERS) addCollider(t.x, t.z, 33, y(t.x, t.z) - 5, 130);
  addCollider(REACTOR.x, REACTOR.z, 31, y(REACTOR.x, REACTOR.z) - 5, 60);
  for (const s of STACKS) addCollider(s.x, s.z, 6, y(s.x, s.z) - 5, 160);
  for (const h of HALLS) addBoxCollider(h.x, h.z, 76, 36, h.r, y(h.x, h.z) - 5, 34); // hallGeo footprint
  for (const s of SKY) addBoxCollider(s.x, s.z, FOOTS[s.cls & 1], FOOTS[s.cls & 1], s.r, y(s.x, s.z) - 5, HEIGHTS[s.cls >> 1]);
  void hash2;
  void PLANT;
}
registerColliders();
