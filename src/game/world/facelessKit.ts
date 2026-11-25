import * as THREE from "three";
import type { Part } from "./facelessLayout";

// Bakes Medieval Village MegaKit pieces (one packed GLB, public/models/faceless/kit.glb) into one merged
// geometry per material, so a whole village of modular houses costs a handful of draw calls.

type Prim = { pos: Float32Array; nor: Float32Array; uv: Float32Array; idx: Uint32Array; mat: string };
export type Pieces = Map<string, Prim[]>;

const toF = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, n: number, size: number) => {
  const out = new Float32Array(n * size);
  if (!a) return out;
  for (let i = 0; i < n; i++) {
    out[i * size] = a.getX(i);
    if (size > 1) out[i * size + 1] = a.getY(i);
    if (size > 2) out[i * size + 2] = a.getZ(i);
  }
  return out;
};

/** Every top-level node of the kit scene becomes a piece (its node transform is baked in). */
export function readPieces(scene: THREE.Object3D): { pieces: Pieces; mats: Map<string, THREE.Material> } {
  const pieces: Pieces = new Map();
  const mats = new Map<string, THREE.Material>();
  scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (const node of scene.children) {
    const list: Prim[] = [];
    node.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry;
      const n = g.attributes.position.count;
      const pos = toF(g.attributes.position, n, 3);
      const nor = toF(g.attributes.normal, n, 3);
      const uv = toF(g.attributes.uv, n, 2);
      nm.getNormalMatrix(m.matrixWorld);
      for (let i = 0; i < n; i++) {
        v.fromArray(pos, i * 3).applyMatrix4(m.matrixWorld).toArray(pos, i * 3);
        v.fromArray(nor, i * 3).applyMatrix3(nm).normalize().toArray(nor, i * 3);
      }
      const idx = g.index ? Uint32Array.from({ length: g.index.count }, (_, i) => g.index!.getX(i)) : Uint32Array.from({ length: n }, (_, i) => i);
      const mat = m.material as THREE.Material;
      mats.set(mat.name, mat);
      list.push({ pos, nor, uv, idx, mat: mat.name });
    });
    pieces.set(node.name, list);
  }
  return { pieces, mats };
}

/** Merge many placed parts into one BufferGeometry per material key (glass of `alt` parts gets "<mat>#alt"). */
export function bake(pieces: Pieces, parts: Part[]): Map<string, THREE.BufferGeometry> {
  type Acc = { items: [Prim, THREE.Matrix4][]; nv: number; ni: number };
  const acc = new Map<string, Acc>();
  for (const p of parts) {
    const prims = pieces.get(p.k);
    if (!prims) { console.warn("faceless kit: missing piece", p.k); continue; }
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(p.x, p.y, p.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.ry),
      new THREE.Vector3(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1),
    );
    for (const pr of prims) {
      const key = p.alt && /glass/i.test(pr.mat) ? pr.mat + "#alt" : pr.mat;
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { items: [], nv: 0, ni: 0 }));
      a.items.push([pr, m]);
      a.nv += pr.pos.length / 3;
      a.ni += pr.idx.length;
    }
  }
  const out = new Map<string, THREE.BufferGeometry>();
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (const [key, a] of acc) {
    const pos = new Float32Array(a.nv * 3), nor = new Float32Array(a.nv * 3), uv = new Float32Array(a.nv * 2);
    const idx = new Uint32Array(a.ni);
    let ov = 0, oi = 0;
    for (const [pr, m] of a.items) {
      const n = pr.pos.length / 3;
      nm.getNormalMatrix(m);
      for (let i = 0; i < n; i++) {
        v.fromArray(pr.pos, i * 3).applyMatrix4(m).toArray(pos, (ov + i) * 3);
        v.fromArray(pr.nor, i * 3).applyMatrix3(nm).normalize().toArray(nor, (ov + i) * 3);
      }
      uv.set(pr.uv, ov * 2);
      for (let i = 0; i < pr.idx.length; i++) idx[oi + i] = pr.idx[i] + ov;
      ov += n;
      oi += pr.idx.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    out.set(key, g);
  }
  return out;
}

/** Cold-biome look for kit materials: snow on up-facing surfaces, a frosty blue-grey cast elsewhere. */
export function frost(mat: THREE.MeshStandardMaterial, snow = 1) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = { value: snow };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFrostW;\nvarying float vFrostUp;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvFrostW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFrostUp = normalize(mat3(modelMatrix) * objectNormal).y;",
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFrostW;\nvarying float vFrostUp;\nuniform float uSnow;\nfloat frostH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\nfloat frostN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(frostH(i), frostH(i + vec2(1, 0)), f.x), mix(frostH(i + vec2(0, 1)), frostH(i + vec2(1, 1)), f.x), f.y); }")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          float n = frostN(vFrostW.xz * 1.7) * 0.6 + frostN(vFrostW.xz * 6.0) * 0.4;
          float up = smoothstep(0.35, 0.8, vFrostUp + (n - 0.5) * 0.5);
          float rime = smoothstep(0.55, 0.95, n) * 0.18;
          vec3 cold = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15))), 0.35) * vec3(0.86, 0.92, 1.06);
          diffuseColor.rgb = mix(cold, vec3(0.9, 0.94, 1.0), clamp(up * uSnow + rime, 0.0, 1.0));
        }`,
      );
  };
  mat.customProgramCacheKey = () => "frost" + snow;
  return mat;
}
