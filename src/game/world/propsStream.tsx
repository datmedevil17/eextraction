"use client";

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { registerSolid, type Solid } from "./treeObstacles";
import { biomeWeights, facelessT, runwayT, villageT, hash2, seededRandom, slopeAt, terrainHeight, type Biome, type BiomeWeights } from "@/game/terrain";

// Streamed, deterministic props. The world is split into 64 m cells. Every species
// generates its placements per cell from a hash-seeded RNG (so every client sees the
// same world), caches them, and only the cells within the species' draw radius are
// written into pooled InstancedMeshes. Cells are generated lazily on a time budget,
// and instance buffers are rebuilt only when the camera has moved a fair bit.

export const CELL = 64;
/** shared time uniform for all swaying props */
export const wind = { value: 0 };
export type Placement = { x: number; z: number; y: number; s: number; r: number };

export type Part = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  receive?: boolean;
  depth?: THREE.Material; // cut-out depth material for alpha-tested shadows
};

export type Species = {
  id: string;
  parts: Part[];
  min?: number; // draw band [min, max) in metres from the camera (used for LODs)
  max: number;
  castMax?: number; // shadows only within this distance (0 / undefined = never)
  gen: (cx: number, cz: number) => Placement[];
  /** collide with it (trunk / rock radius + height at scale 1); give it to the high LOD only */
  solid?: Solid;
};

export type Ctx = { x: number; z: number; y: number; w: BiomeWeights; slope: () => number; rand: () => number };

type GenOpts = {
  seed: number;
  /** average candidates per cell (fractions allowed) */
  n: number;
  scale: [number, number];
  pow?: number; // skew scale towards the minimum
  sink?: number; // bury the base by this many metres (before scale)
  keepInCity?: boolean; // allow placements inside the city
  biome?: Biome; // restrict to a biome (probability follows its blend weight)
  /** custom candidate position (default: uniform in the cell) */
  pos?: (rand: () => number, x0: number, z0: number) => [number, number];
  /** acceptance probability 0..1 (0 rejects) */
  accept?: (c: Ctx) => number;
};

const _w: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };

export function cellGen(o: GenOpts) {
  const pow = o.pow ?? 1.5;
  return (cx: number, cz: number): Placement[] => {
    const x0 = cx * CELL;
    const z0 = cz * CELL;
    if (o.biome) {
      const w = biomeWeights(x0 + CELL / 2, z0 + CELL / 2, _w);
      if (w[o.biome] < 0.02) return [];
    }
    const rand = seededRandom((hash2(cx, cz, o.seed) * 4294967296) | 0);
    const out: Placement[] = [];
    const count = Math.floor(o.n) + (rand() < o.n - Math.floor(o.n) ? 1 : 0);
    const w: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };
    for (let k = 0; k < count; k++) {
      const [x, z] = o.pos ? o.pos(rand, x0, z0) : [x0 + rand() * CELL, z0 + rand() * CELL];
      if (x < x0 || x >= x0 + CELL || z < z0 || z >= z0 + CELL) continue;
      const bw = biomeWeights(x, z, w);
      let p = o.biome ? bw[o.biome] : 1;
      if (p <= 0.02) continue;
      if (!o.keepInCity && (villageT(x, z) > 0.25 || facelessT(x, z) > 0.2 || runwayT(x, z) > 0.05)) continue; // the village clearing stays free of props
      const y = terrainHeight(x, z);
      let sl = -1;
      const ctx: Ctx = { x, z, y, w: bw, slope: () => (sl < 0 ? (sl = slopeAt(x, z)) : sl), rand };
      if (o.accept) p *= o.accept(ctx);
      const s = o.scale[0] + Math.pow(rand(), pow) * (o.scale[1] - o.scale[0]);
      const r = rand() * Math.PI * 2;
      if (p <= 0 || rand() > p) continue;
      out.push({ x, z, y: y - (o.sink ?? 0.05), s, r });
    }
    return out;
  };
}

export const concatGen =
  (...gens: ((cx: number, cz: number) => Placement[])[]) =>
  (cx: number, cz: number) =>
    gens.flatMap((g) => g(cx, cz));

/** Hand-placed landmarks (world coordinates). */
export function fixedGen(items: { x: number; z: number; r: number; s?: number; sink?: number }[]) {
  const byCell = new Map<string, Placement[]>();
  for (const it of items) {
    const key = `${Math.floor(it.x / CELL)},${Math.floor(it.z / CELL)}`;
    const list = byCell.get(key) ?? [];
    list.push({ x: it.x, z: it.z, y: terrainHeight(it.x, it.z) - (it.sink ?? 0.4), s: it.s ?? 1, r: it.r });
    byCell.set(key, list);
  }
  return (cx: number, cz: number) => byCell.get(`${cx},${cz}`) ?? [];
}

// ---------- runtime ----------
type SpState = {
  sp: Species;
  cache: Map<string, Placement[]>;
  meshes: THREE.InstancedMesh[]; // per part: [near (casts), far]
  caps: number[];
  lastX: number;
  lastZ: number;
  dirty: boolean;
};

const REBUILD_DIST = 18;
const BUDGET_MS = 3;
// Instances are split into angular slices around the camera, each its own InstancedMesh with a tight
// bounding sphere, so three.js frustum-culls the slices behind / beside the view (and the shadow pass
// culls against the sun's box). One 360° mesh can never be culled.
const SECT = 12;
/** Raised by the fast-travel loader so the destination streams in at full speed behind the curtain. */
export const streamBoost = { ms: 0 };
const runtimes = new Set<PropsRuntime>();
/** True once every species has finished streaming the cells around (px, pz). */
export function streamSettled(px: number, pz: number) {
  for (const rt of runtimes)
    for (const st of rt.states) if (st.dirty || Math.hypot(px - st.lastX, pz - st.lastZ) > REBUILD_DIST) return false;
  return true;
}

class PropsRuntime {
  group = new THREE.Group();
  states: SpState[];
  private o = new THREE.Object3D();
  private turn = 0;

  constructor(species: Species[]) {
    this.states = species.map((sp) => ({
      sp,
      cache: new Map(),
      meshes: [],
      caps: [],
      lastX: Infinity,
      lastZ: Infinity,
      dirty: true,
    }));
  }

  private mesh(st: SpState, idx: number, part: Part, cast: boolean, need: number) {
    const cur = st.meshes[idx];
    if (cur && cur.instanceMatrix.count >= need) return cur;
    if (cur) {
      this.group.remove(cur);
      cur.dispose();
    }
    const cap = Math.max(32, Math.ceil(need * 1.5));
    const m = new THREE.InstancedMesh(part.geometry, part.material, cap);
    m.castShadow = cast;
    m.receiveShadow = part.receive ?? true;
    m.frustumCulled = true;
    m.count = 0;
    if (part.depth) m.customDepthMaterial = part.depth;
    st.meshes[idx] = m;
    this.group.add(m);
    return m;
  }

  private refresh(st: SpState, px: number, pz: number, deadline: number) {
    const { sp } = st;
    const r = sp.max;
    const c0x = Math.floor((px - r) / CELL);
    const c1x = Math.floor((px + r) / CELL);
    const c0z = Math.floor((pz - r) / CELL);
    const c1z = Math.floor((pz + r) / CELL);
    const near: Placement[][] = Array.from({ length: SECT }, () => []);
    const far: Placement[][] = Array.from({ length: SECT }, () => []);
    const min = sp.min ?? 0;
    const castMax = sp.castMax ?? 0;
    let complete = true;
    let generated = false;
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        // skip cells whose nearest point is outside the band
        const dx = Math.max(0, Math.abs((cx + 0.5) * CELL - px) - CELL / 2);
        const dz = Math.max(0, Math.abs((cz + 0.5) * CELL - pz) - CELL / 2);
        if (Math.hypot(dx, dz) > r) continue;
        const key = `${cx},${cz}`;
        let list = st.cache.get(key);
        if (!list) {
          if (performance.now() > deadline) {
            complete = false;
            continue;
          }
          list = sp.gen(cx, cz);
          st.cache.set(key, list);
          generated = true;
        }
        for (const p of list) {
          const d = Math.hypot(p.x - px, p.z - pz);
          if (d < min || d >= r) continue;
          const sec = Math.min(SECT - 1, Math.floor(((Math.atan2(p.z - pz, p.x - px) + Math.PI) / (Math.PI * 2)) * SECT));
          (d < castMax ? near : far)[sec].push(p);
        }
      }
    }
    st.dirty = !complete; // unfinished cells -> come back next frame
    if (!generated && !complete) return; // budget ran out before anything new: skip a pointless rewrite
    st.lastX = px;
    st.lastZ = pz;
    const o = this.o;
    sp.parts.forEach((part, pi) => {
      [near, far].forEach((lists, k) => {
        lists.forEach((list, sec) => {
          const idx = (pi * 2 + k) * SECT + sec;
          if (!list.length && !st.meshes[idx]) return;
          const m = this.mesh(st, idx, part, k === 0, list.length);
          list.forEach((it, i) => {
            o.position.set(it.x, it.y, it.z);
            o.rotation.set(0, it.r, 0);
            o.scale.setScalar(it.s);
            o.updateMatrix();
            m.setMatrixAt(i, o.matrix);
          });
          m.count = list.length;
          m.instanceMatrix.needsUpdate = true;
          if (list.length) m.computeBoundingSphere(); // walks only the live instances
          m.visible = list.length > 0;
        });
      });
    });
    // prune the cache of cells far behind us
    if (st.cache.size > 4000) {
      for (const key of st.cache.keys()) {
        const [cx, cz] = key.split(",").map(Number);
        if (Math.hypot((cx + 0.5) * CELL - px, (cz + 0.5) * CELL - pz) > r * 1.6) st.cache.delete(key);
      }
    }
  }

  update(px: number, pz: number, budgetMs = BUDGET_MS) {
    const deadline = performance.now() + Math.max(budgetMs, streamBoost.ms);
    const n = this.states.length;
    this.turn = (this.turn + 1) % n;
    for (let k = 0; k < n; k++) {
      const st = this.states[(k + this.turn) % n]; // rotate the start so late species never starve
      const moved = Math.hypot(px - st.lastX, pz - st.lastZ);
      if (moved > REBUILD_DIST || st.dirty) this.refresh(st, px, pz, deadline);
    }
  }

  dispose() {
    for (const st of this.states) for (const m of st.meshes) m?.dispose();
  }
}

export function PropsStream({ build }: { build: () => Species[] }) {
  const camera = useThree((s) => s.camera);
  const runtime = useMemo(() => {
    const list = build();
    for (const sp of list) if (sp.solid) registerSolid(sp.id, sp.gen, sp.solid);
    const rt = new PropsRuntime(list);
    runtimes.add(rt);
    // a first generous pass so the area around the spawn is populated immediately
    rt.update(0, 10, 350);
    if (typeof window !== "undefined" && rt.states.some((s) => s.sp.id === "meadow-tree-0")) ((window as unknown as { __dbg?: Record<string, unknown> }).__dbg ??= {}).props1 = rt;
    return rt;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { runtimes.delete(runtime); }, [runtime]);
  useFrame((state) => {
    wind.value = state.clock.elapsedTime;
    runtime.update(camera.position.x, camera.position.z);
  });
  return <primitive object={runtime.group} />;
}
