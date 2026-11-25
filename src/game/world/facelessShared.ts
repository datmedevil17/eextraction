import { FACELESS, heightAt } from "@/game/terrain";
import { GATE_A, placeHouses, type Placed } from "./facelessLayout";

// Glue between the Faceless sorcerers and the open-world minions (Monsters.tsx):
// - `decoys`: live sorcerers a minion may pick as its target instead of the player.
// - `raids`: requests for Monsters to wake a small pack outside the fence and send it at the village.
// - `routeVia`: steer through the gate when the target is on the other side of the fence.

export type Decoy = { id: number; x: number; y: number; z: number; alive: boolean; hit: (dmg: number, fromX: number, fromZ: number) => void };
export const decoys: Decoy[] = [];

export type Raid = { x: number; z: number; n: number; tx: number; tz: number };
export const raids: Raid[] = [];

/** Nearest live decoy within `range` of (x, z) that is also closer than `than` (the player's distance). */
export function nearestDecoy(x: number, z: number, range: number, than: number): Decoy | null {
  let best: Decoy | null = null;
  let bd = Math.min(range, than);
  for (const d of decoys) {
    if (!d.alive) continue;
    const dd = Math.hypot(d.x - x, d.z - z);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}

const GX = Math.cos(GATE_A), GZ = Math.sin(GATE_A);
export const insideFence = (x: number, z: number) => Math.hypot(x - FACELESS.x, z - FACELESS.z) < FACELESS.fence;

/** Where to walk to reach (tx, tz) from (x, z): the target itself, or a waypoint toward / through the gate
 *  when the fence is in between. Writes into `out` and returns it. */
export function routeVia(x: number, z: number, tx: number, tz: number, out: [number, number]): [number, number] {
  out[0] = tx; out[1] = tz;
  const fx = FACELESS.x, fz = FACELESS.z, R = FACELESS.fence;
  const rIn = Math.hypot(x - fx, z - fz), rT = Math.hypot(tx - fx, tz - fz);
  if ((rIn < R) === (rT < R)) return out; // same side
  const gx = fx + GX * R, gz = fz + GZ * R;
  if (Math.hypot(x - gx, z - gz) < 4.5) {
    // in the gateway: step through to the far side
    const r = rT < R ? R - 5 : R + 5;
    out[0] = fx + GX * r; out[1] = fz + GZ * r;
    return out;
  }
  if (rIn < R) { out[0] = fx + GX * (R - 4); out[1] = fz + GZ * (R - 4); return out; }
  // outside: walk around the ring toward the gate, 30° at a time
  const a = Math.atan2(z - fz, x - fx);
  let d = GATE_A - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  if (Math.abs(d) < 0.35) { out[0] = fx + GX * (R + 4); out[1] = fz + GZ * (R + 4); return out; }
  const b = a + Math.sign(d) * 0.5;
  out[0] = fx + Math.cos(b) * (R + 5); out[1] = fz + Math.sin(b) * (R + 5);
  return out;
}

let _houses: Placed[] | null = null;
/** The village houses in world space (deterministic, shared by the village and its sorcerers). */
export const facelessHouses = () => (_houses ??= placeHouses(FACELESS.x, FACELESS.z, heightAt));

/** Live bits the village reads for its ritual look (written by Sorcerers.tsx). */
export const ritual = { gathered: 0, battle: 0 };
