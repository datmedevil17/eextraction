"use client";

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SUN_DIR, biomeWeights, fbm, nukePlatform, nukePoolT, smooth, terrainHeight, type BiomeWeights } from "@/game/terrain";
import { terrainColor } from "@/game/terrainColor";
import { atm } from "@/game/atmosphere";

// Chunked, LOD'd terrain. The world is an endless grid of 128 m chunks; only the
// chunks inside the view radius exist, each at a resolution that depends on its
// distance (2 m / 4 m / 8 m / 16 m vertex spacing). Chunks are generated lazily
// (time-sliced, a few ms per frame) and thrown away when you walk away from them.
//  * skirts hide the cracks between neighbouring LODs
//  * heights are sampled with a 1-vertex border so normals match across chunk edges
//  * one shared material blends meadow / ice / desert looks through vertex data

export const CHUNK = 128;
const LODS = [64, 32, 16, 8]; // segments per chunk side
const LOD_DIST = [300, 620, 980]; // switch distances (nearest point of the chunk)
const HYST = 48;
export const VIEW_RADIUS = 1300;
const KEEP_RADIUS = VIEW_RADIUS + 220;
const BUDGET_MS = 5;
const PRIME_RADIUS = 280; // built synchronously before the first frame is shown

// ---------- procedural textures (tileable) ----------
function tile(size: number, fn: (x: number, y: number) => number, repeat = 1) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.round(Math.min(1, Math.max(0, fn(x, y))) * 255);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.repeat.set(repeat, repeat);
  tex.needsUpdate = true;
  return tex;
}

/** cross-fade four shifted samples so the noise tiles seamlessly */
function seamless(size: number, f: (x: number, y: number) => number) {
  return (x: number, y: number) => {
    const a = x / size;
    const b = y / size;
    return (f(x, y) * (1 - a) + f(x - size, y) * a) * (1 - b) + (f(x, y - size) * (1 - a) + f(x - size, y - size) * a) * b;
  };
}

function makeDetail() {
  const f = seamless(256, (x, y) => fbm(x * 0.045 + 20, y * 0.045 + 20, 4));
  return tile(256, (x, y) => Math.min(1, Math.max(0.7, 0.88 + f(x, y) * 0.35)));
}
function makeGrain() {
  const f = seamless(256, (x, y) => fbm(x * 0.11 + 7, y * 0.11 + 3, 4));
  return tile(256, (x, y) => 0.5 + f(x, y) * 0.8);
}
function makeRipple() {
  const size = 256;
  const TAU = Math.PI * 2;
  let seed = 99;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  return tile(size, (x, y) => {
    const u = x / size;
    const v = y / size;
    const warp = 0.1 * Math.sin(TAU * (u * 2 + 0.3)) + 0.06 * Math.sin(TAU * (u * 3 + v * 2)) + 0.04 * Math.sin(TAU * (u * 5 - v));
    const ridge = Math.sin(TAU * (v * 9 + warp * 3));
    const prof = ridge > 0 ? ridge : ridge * 0.6; // gentle windward side, steeper lee side
    return 0.5 + 0.38 * prof + (rnd() - 0.5) * 0.12;
  });
}

// ---------- material ----------
function createMaterial() {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.7 });
  const uniforms = {
    uSun: { value: new THREE.Vector3(...SUN_DIR) },
    uTime: { value: 0 },
    uDetail: { value: makeDetail() },
    uGrain: { value: makeGrain() },
    uRipple: { value: makeRipple() },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 aBiome;\nattribute float aNuke;\nvarying float vNuke;\nvarying vec3 vBiome;\nvarying vec3 vWP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBiome = aBiome;\nvNuke = aNuke;\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vBiome; // x: ice, y: desert, z: playa
        varying vec3 vWP;
        varying float vNuke;
        uniform float uTime;
        uniform vec3 uSun;
        uniform sampler2D uDetail;
        uniform sampler2D uGrain;
        uniform sampler2D uRipple;
        vec2 h2(vec2 p) {
          p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
          return fract(sin(p) * 43758.5453);
        }
        float h1(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vn(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y);
        }
        // distance to the nearest Voronoi cell wall (crack lines) + cell id
        vec3 cracks(vec2 p) {
          vec2 ip = floor(p), fp = fract(p);
          float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = h2(ip + g);
            float d = length(g + o - fp);
            if (d < d1) { d2 = d1; d1 = d; id = ip + g; } else if (d < d2) { d2 = d; }
          }
          return vec3(d2 - d1, id);
        }
        // wind ripples on the dunes, fine grain on the snow
        float bumpH(vec2 p) {
          const float cr = 0.5735, sr = 0.8192; // ripples run along the dune crests (rotation 0.96)
          vec2 q = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y) / 6.0;
          return texture2D(uRipple, q).x * 1.4 * vBiome.y + texture2D(uGrain, p / 5.45).x * vBiome.x;
        }
        vec3 perturbW(vec3 surf_pos, vec3 surf_norm, float faceDirection, float fade) {
          vec2 p = vWP.xz;
          vec2 dpx = dFdx(p), dpy = dFdy(p);
          float h0 = bumpH(p);
          vec2 dH = vec2(bumpH(p + dpx) - h0, bumpH(p + dpy) - h0) * fade;
          vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
          vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
          vec3 R1 = cross(vSigmaY, surf_norm);
          vec3 R2 = cross(surf_norm, vSigmaX);
          float fDet = dot(vSigmaX, R1) * faceDirection;
          vec3 vGrad = sign(fDet) * (dH.x * R1 + dH.y * R2);
          return normalize(abs(fDet) * surf_norm - vGrad);
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float camD = length(vWP - cameraPosition);
        float meadowW = clamp(1.0 - vBiome.x - vBiome.y, 0.0, 1.0);
        diffuseColor.rgb *= mix(1.0, texture2D(uDetail, vWP.xz / 8.0).r, meadowW * (1.0 - smoothstep(80.0, 300.0, camD)));
        if (vBiome.z > 0.02) {
          vec2 q = vWP.xz * 0.55 + (vec2(vn(vWP.xz * 0.9), vn(vWP.xz * 0.9 + 7.0)) - 0.5) * 0.35;
          vec3 cr = cracks(q);
          float line = 1.0 - smoothstep(0.0, 0.07, cr.x);
          float small = 1.0 - smoothstep(0.0, 0.1, cracks(q * 3.3 + 4.0).x);
          float tint = h1(cr.yz);
          diffuseColor.rgb *= mix(1.0, 0.86 + 0.26 * tint, vBiome.z);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.38, 0.32, 0.27), clamp(line * 0.85 + small * 0.3, 0.0, 1.0) * vBiome.z);
        }`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        normal = perturbW(-vViewPosition, normal, faceDirection, 1.0 - smoothstep(70.0, 260.0, camD));`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        if (vNuke > 0.02 && camD < 420.0) {
          // radiation seeping up through the fractured ground
          vec2 q = vWP.xz * 0.16 + (vec2(vn(vWP.xz * 0.35), vn(vWP.xz * 0.35 + 5.0)) - 0.5) * 0.9;
          vec3 c1 = cracks(q);
          vec3 c2 = cracks(q * 2.7 + 11.0);
          float w1 = 1.0 - smoothstep(0.0, 0.055, c1.x);
          float w2 = (1.0 - smoothstep(0.0, 0.07, c2.x)) * 0.6;
          float vein = max(w1, w2);
          float halo = (1.0 - smoothstep(0.0, 0.15, c1.x)) * 0.03;
          float pulse = 0.65 + 0.35 * sin(uTime * 1.6 + h1(c1.yz) * 40.0 + vn(vWP.xz * 0.05) * 6.0);
          float live = smoothstep(0.3, 0.9, vNuke) * step(0.6, h1(c1.yz + 2.0));
          float seep = (vein + halo) * pulse * live;
          vec3 glowC = mix(vec3(0.35, 1.0, 0.1), vec3(0.8, 1.0, 0.25), vein);
          totalEmissiveRadiance += glowC * seep * 1.2 * (1.0 - smoothstep(260.0, 520.0, camD));
        }
        if (camD < 45.0) {
          // sand grains and ice crystals catching the sun
          vec3 Vd = normalize(cameraPosition - vWP);
          vec3 Hh = normalize(Vd + uSun);
          vec2 cellS = floor(vWP.xz * 55.0);
          vec2 cellI = floor(vWP.xz * 70.0);
          float a1 = fract(sin(dot(cellS, vec2(12.9898, 78.233))) * 43758.5453);
          float a2 = fract(sin(dot(cellS, vec2(39.346, 11.135))) * 24634.6345);
          float b1 = fract(sin(dot(cellI, vec2(12.9898, 78.233))) * 43758.5453);
          float b2 = fract(sin(dot(cellI, vec2(39.346, 11.135))) * 24634.6345);
          float sandSpark = pow(max(dot(normalize(vec3(a1 - 0.5, 0.9, a2 - 0.5)), Hh), 0.0), 2600.0);
          float iceSpark = pow(max(dot(normalize(vec3(b1 - 0.5, 0.9, b2 - 0.5)), Hh), 0.0), 3200.0);
          float snowy = smoothstep(0.62, 0.9, vColor.b) * (1.0 - smoothstep(0.0, 0.5, abs(vColor.b - vColor.r) - 0.1));
          totalEmissiveRadiance += vec3(1.0, 0.9, 0.7) * sandSpark * 9.0 * smoothstep(40.0, 4.0, camD) * vBiome.y * (1.0 - vBiome.z);
          totalEmissiveRadiance += vec3(1.0, 0.97, 0.92) * iceSpark * 22.0 * smoothstep(45.0, 4.0, camD) * snowy * vBiome.x;
        }`,
      );
  };
  material.customProgramCacheKey = () => "world-terrain";
  return { material, uniforms };
}

// ---------- chunk geometry ----------
const indexCache = new Map<number, THREE.BufferAttribute>();
function indexFor(n: number) {
  let idx = indexCache.get(n);
  if (idx) return idx;
  const row = n + 1;
  const V = row * row;
  const out: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      out.push(a, c, b, b, c, d);
    }
  }
  // skirts: north, south, west, east
  const N0 = V;
  const S0 = V + row;
  const W0 = V + 2 * row;
  const E0 = V + 3 * row;
  for (let i = 0; i < n; i++) {
    const tN0 = i;
    const tN1 = i + 1;
    out.push(tN0, tN1, N0 + i, tN1, N0 + i + 1, N0 + i);
    const tS0 = n * row + i;
    const tS1 = tS0 + 1;
    out.push(tS0, S0 + i, tS1, tS1, S0 + i, S0 + i + 1);
    const tW0 = i * row;
    const tW1 = (i + 1) * row;
    out.push(tW0, W0 + i, tW1, tW1, W0 + i, W0 + i + 1);
    const tE0 = i * row + n;
    const tE1 = (i + 1) * row + n;
    out.push(tE0, tE1, E0 + i, tE1, E0 + i + 1, E0 + i);
  }
  idx = new THREE.BufferAttribute(new Uint16Array(out), 1);
  indexCache.set(n, idx);
  return idx;
}

function* buildChunk(ci: number, cj: number, lod: number): Generator<void, THREE.BufferGeometry> {
  const n = LODS[lod];
  const row = n + 1;
  const s = CHUNK / n;
  const ox = ci * CHUNK;
  const oz = cj * CHUNK;
  const m = n + 3;
  const H = new Float32Array(m * m); // (n + 1) + 1-vertex border all round
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) H[j * m + i] = terrainHeight(ox + (i - 1) * s, oz + (j - 1) * s);
    if ((j & 7) === 7) yield;
  }

  const V = row * row;
  const total = V + 4 * row;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const bio = new Float32Array(total * 3);
  const nk = new Float32Array(total);
  const c = new THREE.Color();
  const w: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };
  const yieldEvery = lod === 0 ? 2 : lod === 1 ? 4 : 16;

  for (let j = 0; j < row; j++) {
    for (let i = 0; i < row; i++) {
      const v = j * row + i;
      const gi = (j + 1) * m + (i + 1);
      const y = H[gi];
      const nx = (H[gi - 1] - H[gi + 1]) / (2 * s);
      const nz = (H[gi - m] - H[gi + m]) / (2 * s);
      const il = 1 / Math.hypot(nx, 1, nz);
      const wx = ox + i * s;
      const wz = oz + j * s;
      pos[v * 3] = i * s;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = j * s;
      nor[v * 3] = nx * il;
      nor[v * 3 + 1] = il;
      nor[v * 3 + 2] = nz * il;
      biomeWeights(wx, wz, w);
      const playa = terrainColor(wx, y, wz, 1 - il, w, c);
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
      bio[v * 3] = w.ice;
      bio[v * 3 + 1] = w.desert;
      bio[v * 3 + 2] = playa;
      if (w.nuke > 0.01) {
        const pt = nukePoolT(wx, wz);
        const hot = Math.max(nukePlatform(wx, wz) * 0.8, 1 - smooth(1.4, 3.2, pt), 0.1);
        nk[v] = Math.min(1, w.nuke * hot * 1.15);
      }
    }
    if (j % yieldEvery === yieldEvery - 1) yield;
  }

  // skirts: copies of the border vertices dropped straight down
  const drop = 1.5 + s * 0.6;
  const copy = (dst: number, src: number) => {
    for (let k = 0; k < 3; k++) {
      pos[dst * 3 + k] = pos[src * 3 + k];
      nor[dst * 3 + k] = nor[src * 3 + k];
      col[dst * 3 + k] = col[src * 3 + k];
      bio[dst * 3 + k] = bio[src * 3 + k];
    }
    nk[dst] = nk[src];
    pos[dst * 3 + 1] -= drop;
  };
  for (let i = 0; i < row; i++) {
    copy(V + i, i); // north (j = 0)
    copy(V + row + i, n * row + i); // south (j = n)
    copy(V + 2 * row + i, i * row); // west (i = 0)
    copy(V + 3 * row + i, i * row + n); // east (i = n)
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aBiome", new THREE.BufferAttribute(bio, 3));
  g.setAttribute("aNuke", new THREE.BufferAttribute(nk, 1));
  g.setIndex(indexFor(n));
  g.computeBoundingSphere();
  return g;
}

// ---------- chunk manager ----------
type Chunk = { mesh: THREE.Mesh; lod: number };
type Job = { key: string; ci: number; cj: number; lod: number; gen: Generator<void, THREE.BufferGeometry> };

function lodFor(dist: number, cur?: number) {
  let l = 0;
  while (l < LOD_DIST.length && dist > LOD_DIST[l]) l++;
  if (cur !== undefined && cur !== l && Math.abs(cur - l) === 1) {
    const edge = LOD_DIST[Math.min(cur, l)];
    if (Math.abs(dist - edge) < HYST) return cur;
  }
  return l;
}

function chunkDist(ci: number, cj: number, px: number, pz: number) {
  const cx = (ci + 0.5) * CHUNK;
  const cz = (cj + 0.5) * CHUNK;
  return Math.hypot(Math.max(0, Math.abs(cx - px) - CHUNK / 2), Math.max(0, Math.abs(cz - pz) - CHUNK / 2));
}

class ChunkManager {
  group = new THREE.Group();
  chunks = new Map<string, Chunk>();
  job: Job | null = null;
  frame = 0;
  constructor(private material: THREE.Material) {}

  private finish(job: Job, geo: THREE.BufferGeometry) {
    const old = this.chunks.get(job.key);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(job.ci * CHUNK, 0, job.cj * CHUNK);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.chunks.set(job.key, { mesh, lod: job.lod });
    if (old) this.drop(old);
  }

  private drop(c: Chunk) {
    this.group.remove(c.mesh);
    c.mesh.geometry.dispose();
  }

  private pick(px: number, pz: number): Job | null {
    const r = Math.ceil(VIEW_RADIUS / CHUNK) + 1;
    const pci = Math.floor(px / CHUNK);
    const pcj = Math.floor(pz / CHUNK);
    let best: { ci: number; cj: number; lod: number; d: number } | null = null;
    for (let cj = pcj - r; cj <= pcj + r; cj++) {
      for (let ci = pci - r; ci <= pci + r; ci++) {
        const d = chunkDist(ci, cj, px, pz);
        if (d > VIEW_RADIUS) continue;
        const have = this.chunks.get(`${ci},${cj}`);
        const lod = lodFor(d, have?.lod);
        if (have && have.lod === lod) continue;
        if (!best || d < best.d) best = { ci, cj, lod, d };
      }
    }
    if (!best) return null;
    return { key: `${best.ci},${best.cj}`, ci: best.ci, cj: best.cj, lod: best.lod, gen: buildChunk(best.ci, best.cj, best.lod) };
  }

  /** Build everything near (px, pz) right now (blocking). */
  prime(px: number, pz: number) {
    for (;;) {
      const job = this.pick(px, pz);
      if (!job || chunkDist(job.ci, job.cj, px, pz) > PRIME_RADIUS) break;
      let r = job.gen.next();
      while (!r.done) r = job.gen.next();
      this.finish(job, r.value);
    }
  }

  update(px: number, pz: number) {
    const t0 = performance.now();
    while (performance.now() - t0 < BUDGET_MS) {
      if (!this.job) this.job = this.pick(px, pz);
      if (!this.job) break;
      const r = this.job.gen.next();
      if (r.done) {
        this.finish(this.job, r.value);
        this.job = null;
      }
    }
    if (++this.frame % 30 === 0) {
      for (const [key, c] of this.chunks) {
        const [ci, cj] = key.split(",").map(Number);
        if (chunkDist(ci, cj, px, pz) > KEEP_RADIUS) {
          this.drop(c);
          this.chunks.delete(key);
        }
      }
    }
  }

  dispose() {
    for (const c of this.chunks.values()) this.drop(c);
    this.chunks.clear();
  }
}

export function WorldTerrain() {
  const camera = useThree((s) => s.camera);
  const { manager, material, far, uniforms } = useMemo(() => {
    const { material, uniforms } = createMaterial();
    const manager = new ChunkManager(material);
    manager.prime(0, 10);
    // below every hill: the horizon is never see-through (it is fogged out long before you could see it)
    const far = new THREE.Mesh(new THREE.CircleGeometry(9000, 24), new THREE.MeshBasicMaterial({ color: "#b4cde6" }));
    far.rotation.x = -Math.PI / 2;
    far.frustumCulled = false;
    return { manager, material, far, uniforms };
  }, []);

  useEffect(
    () => () => {
      manager.dispose();
      material.dispose();
    },
    [manager, material],
  );

  useFrame((state) => {
    uniforms.uTime.value = state.clock.elapsedTime;
    const p = camera.position;
    manager.update(p.x, p.z);
    far.position.set(p.x, -45, p.z);
    (far.material as THREE.MeshBasicMaterial).color.copy(atm.horizon);
  });

  return (
    <>
      <primitive object={manager.group} />
      <primitive object={far} />
    </>
  );
}
