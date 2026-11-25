// Domain of the Faceless: pure layout math (no three / React), so it can also be previewed standalone.
// Medieval Village MegaKit pieces sit on a 2 m grid: walls are 2 m wide, origin bottom-centre, outer
// face toward +z. A house is W (x) by L (z) in its own frame with the front (door) wall at z = +L/2;
// the village rotates every house so its front faces the plaza.

export type Part = { k: string; x: number; y: number; z: number; ry: number; sx?: number; sy?: number; sz?: number; alt?: boolean }; // alt = violet glass
export type HouseSpec = { storeys: 1 | 2; len: 6 | 8; brick: boolean; balcony: boolean; stairs: boolean; violet: boolean; chimney: number };
export type Placed = HouseSpec & { x: number; z: number; ry: number; y: number; door: [number, number] };

export const STOREY = 3; // floor-to-floor height (walls are 3.12 tall, the top 0.12 tucks under the next storey)
export const W = 6;
const HALF_PI = Math.PI / 2;

/** All pieces of one house in its local frame (y = 0 at the ground floor). */
export function houseParts(h: HouseSpec): Part[] {
  const out: Part[] = [];
  const L = h.len, hw = W / 2, hl = L / 2;
  const add = (k: string, x: number, y: number, z: number, ry: number, extra?: Partial<Part>) => out.push({ k, x, y, z, ry, ...extra });
  const along = (n: number) => Array.from({ length: n }, (_, i) => -n + 1 + i * 2); // segment centres on a 2 m grid

  for (let s = 0; s < h.storeys; s++) {
    const y = s * STOREY;
    const ground = s === 0;
    const mat = ground && h.brick ? "Wall_UnevenBrick_" : "Wall_Plaster_";
    const win = (thin: boolean) => mat + (thin ? "Window_Thin_Round" : "Window_Wide_Round");
    const withWindow = (x: number, z: number, ry: number, thin: boolean, shutters: boolean) => {
      add(win(thin), x, y, z, ry);
      add(thin ? "Window_Thin_Round1" : "Window_Wide_Round1", x, y, z, ry, { alt: h.violet });
      if (shutters) add(thin ? "WindowShutters_Thin_Round_Open" : "WindowShutters_Wide_Round_Open", x, y, z, ry);
    };
    // front (+z)
    for (const x of along(3)) {
      if (x === 0 && ground) {
        add(mat + "Door_Round", x, y, hl, 0);
        add("Door_1_Round", x - 0.53, y, hl - 0.12, 0, { alt: h.violet });
      } else if (x === 0 && h.balcony) {
        add("Wall_Plaster_Door_Flat", x, y, hl, 0);
        add("Door_1_Flat", x - 0.53, y, hl - 0.12, 0);
      } else withWindow(x, hl, 0, !ground && x !== 0, ground);
    }
    // back (-z)
    for (const x of along(3)) {
      if (x === 0) withWindow(x, -hl, Math.PI, true, false);
      else add(mat + "Straight", x, y, -hl, Math.PI);
    }
    // sides
    for (const sx of [1, -1]) {
      const segs = along(L / 2);
      segs.forEach((z, i) => {
        const ry = sx * HALF_PI;
        const topDoor = h.stairs && sx === 1 && !ground && i === 0;
        if (topDoor) {
          add("Wall_Plaster_Door_Flat", sx * hw, y, z, ry);
          add("Door_1_Flat", sx * hw - 0.12, y, z + 0.53, ry);
        } else if (i === Math.floor(segs.length / 2) || (L === 8 && i === 1 && !ground)) withWindow(sx * hw, z, ry, !ground, false);
        else add(mat + "Straight", sx * hw, y, z, ry);
      });
    }
    // corner posts + the beam between storeys
    const post = ground && h.brick ? "Corner_Exterior_Brick" : "Corner_Exterior_Wood";
    for (const [cx, cz, ry] of [[hw, hl, 0], [-hw, hl, -HALF_PI], [-hw, -hl, Math.PI], [hw, -hl, HALF_PI]] as const) add(post, cx, y, cz, ry);
    if (!ground) {
      for (const x of along(3)) { add("Wall_BottomCover", x, y, hl, 0); add("Wall_BottomCover", x, y, -hl, Math.PI); }
      for (const z of along(L / 2)) { add("Wall_BottomCover", hw, y, z, HALF_PI); add("Wall_BottomCover", -hw, y, z, -HALF_PI); }
    }
  }
  const top = h.storeys * STOREY;
  add(L === 6 ? "Roof_RoundTiles_6x6" : "Roof_RoundTiles_6x8", 0, top, 0, 0);
  add("Roof_Front_Brick6", 0, top, hl, 0);
  add("Roof_Front_Brick6", 0, top, -hl, Math.PI);
  add("Prop_Chimney", h.chimney * 1.7, top + 0.4, -hl + 1.6, 0);
  // ground-floor floor (seen through the door when it is open)
  for (const x of along(3)) for (const z of along(L / 2)) add("Floor_WoodDark", x, 0.02, z, 0);

  if (h.balcony && h.storeys === 2) {
    add("Floor_WoodDark", 0, STOREY, hl + 0.5, 0, { sz: 0.5 });
    add("Balcony_Simple_Straight", 0, STOREY, hl, 0);
    add("Prop_Support", -0.9, 0, hl, 0, { sz: 0.55 });
    add("Prop_Support", 0.9, 0, hl, 0, { sz: 0.55 });
  }
  if (h.stairs && h.storeys === 2) {
    // a stone flight along the right wall climbing toward the back, up to a landing at the side door
    const zd = along(L / 2)[0];
    for (let j = 0; j < 3; j++) for (let y = j; y >= 0; y--) add(y === j ? "Stairs_Exterior_Straight" : "Stairs_Exterior_Platform", hw + 1, y, zd + 2 * (3 - j), 0);
    for (let y = 0; y < 3; y++) add("Stairs_Exterior_Platform", hw + 1, y, zd, 0);
  }
  return out;
}

// ---- the village ----
export const PLAZA_R = 12;
export const HOUSE_R = 25;
export const GATE_A = Math.PI; // the gate faces the frozen lake (west, -x)
export const GATE_HALF = 0.11; // radians of open fence either side of the gate axis (≈ 4.4 m each side at r = 40)

const SPECS: HouseSpec[] = [
  { storeys: 2, len: 8, brick: true, balcony: true, stairs: false, violet: false, chimney: -1 },
  { storeys: 1, len: 6, brick: false, balcony: false, stairs: false, violet: true, chimney: 1 },
  { storeys: 2, len: 6, brick: true, balcony: false, stairs: true, violet: false, chimney: -1 },
  { storeys: 2, len: 8, brick: false, balcony: true, stairs: false, violet: true, chimney: 1 },
  { storeys: 1, len: 8, brick: true, balcony: false, stairs: false, violet: false, chimney: -1 },
  { storeys: 2, len: 6, brick: false, balcony: true, stairs: false, violet: false, chimney: 1 },
  { storeys: 2, len: 8, brick: true, balcony: false, stairs: true, violet: true, chimney: -1 },
];

/** World placement of the houses around the plaza. `groundY` samples the terrain. */
export function placeHouses(cx: number, cz: number, groundY: (x: number, z: number) => number): Placed[] {
  return SPECS.map((s, i) => {
    const a = GATE_A + ((i + 1) / (SPECS.length + 1)) * Math.PI * 2;
    const r = HOUSE_R + s.len / 2 - 3;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const ry = Math.atan2(cx - x, cz - z); // local +z -> toward the plaza
    // sit the house on the highest corner so nothing floats
    let y = -Infinity;
    const c = Math.cos(ry), sn = Math.sin(ry);
    for (const [lx, lz] of [[-3, -s.len / 2], [3, -s.len / 2], [-3, s.len / 2], [3, s.len / 2], [0, 0]]) y = Math.max(y, groundY(x + lx * c + lz * sn, z - lx * sn + lz * c));
    const dl = s.len / 2 + 1.2;
    return { ...s, x, z, ry, y: y - 0.05, door: [x + dl * sn, z + dl * c] };
  });
}

/** Local -> world for a part of a placed house. */
export function toWorld(h: { x: number; y: number; z: number; ry: number }, p: Part): Part {
  const c = Math.cos(h.ry), s = Math.sin(h.ry);
  return { ...p, x: h.x + p.x * c + p.z * s, y: h.y + p.y, z: h.z - p.x * s + p.z * c, ry: h.ry + p.ry };
}

/** Fence segment transforms (2 m pieces tangent to the circle), leaving the gate open. */
export function fenceParts(cx: number, cz: number, r: number, groundY: (x: number, z: number) => number): Part[] {
  const n = Math.round((Math.PI * 2 * r) / 1.95);
  const out: Part[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    let d = a - GATE_A;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < GATE_HALF) continue;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    // piece runs along local x: align local x with the tangent (-sin a, cos a); outer face (+z) points outward
    const ry = Math.atan2(-Math.cos(a), -Math.sin(a));
    out.push({ k: i % 6 === 0 ? "Prop_MetalFence_Ornament" : "Prop_MetalFence_Simple", x, y: groundY(x, z) - 0.15, z, ry, sx: ((Math.PI * 2 * r) / n) / 1.95 });
  }
  return out;
}
