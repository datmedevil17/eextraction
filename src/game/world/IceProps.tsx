"use client";

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { lakeT, noise2, seededRandom } from "@/game/terrain";
import { TREE_STYLES, buildTree, makeBarkTexture } from "./trees";
import { CONIFER_STYLES, buildConifer, makeFirTexture, taperedTube } from "./conifers";
import { buildRock } from "./Props";
import { cellGen, concatGen, fixedGen, wind, type Species } from "./propsStream";

// Everything standing on the snow: conifers, dead trees, boulders, ice
// crystals, and the bones of ice-age giants. All procedural, streamed per cell.

export const FOREST: [number, number, number] = [-330, -1250, 150]; // old-growth pines (world x, z, radius)

const GLSL_NOISE = /* glsl */ `
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
`;

/** Snow settles on upward-facing surfaces of an instanced mesh. */
function withSnowCap<T extends THREE.MeshStandardMaterial>(m: T, key: string, amount = 1) {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          mat4 wm = modelMatrix * instanceMatrix;
        #else
          mat4 wm = modelMatrix;
        #endif
        vWN = normalize(mat3(wm) * normal);
        vWP = (wm * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\n${GLSL_NOISE}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          float n = vn(vWP.xz * 2.4 + vWP.y * 1.3) * 0.6 + vn(vWP.xz * 9.0) * 0.4;
          float s = smoothstep(0.22, 0.55, vWN.y * ${amount.toFixed(2)} + (n - 0.5) * 0.5);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 1.0), s);
        }`,
      );
  };
  m.customProgramCacheKey = () => key;
  return m;
}

function buildCrystals() {
  const rand = seededRandom(404);
  const parts: THREE.BufferGeometry[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const h = 0.8 + rand() * 2.4;
    const r = 0.1 + rand() * 0.2;
    const body = new THREE.CylinderGeometry(r, r * 1.1, h, 6, 1);
    body.translate(0, h / 2, 0);
    const tip = new THREE.ConeGeometry(r, r * 2.4, 6, 1);
    tip.translate(0, h + r * 1.2, 0);
    const g = mergeGeometries([body.toNonIndexed(), tip.toNonIndexed()])!;
    const lean = 0.15 + rand() * 0.4;
    const a = rand() * Math.PI * 2;
    g.rotateZ(Math.cos(a) * lean);
    g.rotateX(Math.sin(a) * lean);
    g.translate((rand() - 0.5) * 1.2, -0.1, (rand() - 0.5) * 1.2);
    parts.push(g);
  }
  const merged = mergeGeometries(parts)!;
  merged.computeVertexNormals();
  return merged;
}

export function buildSkeleton(seed: number) {
  const rand = seededRandom(seed);
  const parts: THREE.BufferGeometry[] = [];
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // spine
  const spine = new THREE.CatmullRomCurve3([V(-3.2, 1.55, 0), V(-1.6, 1.85, 0.05), V(0, 1.9, 0), V(1.6, 1.8, -0.05), V(3.0, 1.5, 0)]);
  parts.push(taperedTube(spine, 24, 0.13, 0.07, 7));
  // rib cage: arches hanging from the spine, buried at the bottom
  for (let i = 0; i < 11; i++) {
    const u = i / 10;
    const x = -2.0 + u * 3.6;
    const R = 1.0 + 0.9 * Math.sin(Math.PI * (0.15 + 0.7 * u)) + rand() * 0.1;
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 8; k++) {
        const a = (k / 8) * Math.PI * 0.82;
        pts.push(V(x + a * 0.08, 1.85 - Math.sin(a) * R * 0.95 * (1 - 0.1 * a), side * Math.cos(a * 0.9 + 0.1) * R * 0.78 * Math.sin(a + 0.2)));
      }
      parts.push(taperedTube(new THREE.CatmullRomCurve3(pts), 14, 0.075, 0.03, 6));
    }
  }
  // tusks
  for (const side of [-1, 1]) {
    const tusk = new THREE.CatmullRomCurve3([V(-3.5, 1.2, side * 0.55), V(-4.6, 0.7, side * 0.9), V(-5.9, 0.9, side * 1.3), V(-6.9, 1.7, side * 1.1), V(-7.2, 2.7, side * 0.7)]);
    parts.push(taperedTube(tusk, 20, 0.2, 0.025, 8));
  }
  // skull dome
  const skull = new THREE.SphereGeometry(1, 14, 10);
  const p = skull.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 1 + noise2(p.getX(i) * 2 + seed, p.getZ(i) * 2) * 0.08;
    p.setXYZ(i, p.getX(i) * 1.15 * k - 3.9, Math.max(p.getY(i) * 0.95 + 0.7, -0.4), p.getZ(i) * 0.9 * k);
  }
  skull.computeVertexNormals();
  parts.push(skull.toNonIndexed());
  const flat = parts.map((q) => {
    const n = q.index ? q.toNonIndexed() : q;
    n.deleteAttribute("uv");
    n.deleteAttribute("normal");
    return n;
  });
  const g = mergeGeometries(flat)!;
  g.computeVertexNormals();
  return g;
}

export function iceSpecies(): Species[] {
  const out: Species[] = [];
  const firTex = makeFirTexture();
  const barkTex = makeBarkTexture();
  const barkMat = new THREE.MeshStandardMaterial({ map: barkTex, color: "#ffffff", roughness: 1 });
  const needleMat = new THREE.MeshStandardMaterial({
    map: firTex,
    vertexColors: true,
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.25,
  });
  needleMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aSnow;\nvarying float vSnow;\nvarying vec2 vUv2;\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vSnow = aSnow; vUv2 = uv;
        vec3 iPos = instanceMatrix[3].xyz;
        float hgt = clamp(transformed.y / 16.0, 0.0, 1.0);
        float ph = uTime * 1.1 + iPos.x * 0.17 + iPos.z * 0.23;
        transformed.x += (sin(ph + transformed.y * 0.3) * 0.5 + sin(uTime * 2.9 + transformed.x * 3.0) * 0.07) * 0.24 * hgt * hgt;
        transformed.z += cos(ph * 0.8) * 0.18 * hgt * hgt;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <aomap_fragment>", "#include <aomap_fragment>\nreflectedLight.directSpecular = vec3(0.0);\nreflectedLight.indirectSpecular = vec3(0.0);")
      .replace("#include <common>", `#include <common>\nvarying float vSnow;\nvarying vec2 vUv2;\n${GLSL_NOISE}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          float n = vn(vUv2 * vec2(6.0, 13.0)) * 0.6 + vn(vUv2 * vec2(17.0, 34.0)) * 0.4;
          if (!gl_FrontFacing) diffuseColor.rgb *= 0.62;
          float cover = vSnow * (gl_FrontFacing ? 1.0 : 0.15);
          float m = smoothstep(0.42, 0.68, n * 0.85 + cover * 0.32 - 0.12);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.94, 1.0), clamp(m * cover * 1.1, 0.0, 0.8));
        }`,
      );
  };
  needleMat.customProgramCacheKey = () => "conifer-needles-snow";
  const needleDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: firTex, alphaTest: 0.45, side: THREE.DoubleSide });

  const inForest = (x: number, z: number) => Math.hypot(x - FOREST[0], z - FOREST[1]) < FOREST[2];
  const HI = 170;
  CONIFER_STYLES.forEach((style, v) => {
    const open = cellGen({
      seed: 31 + v,
      n: 0.48,
      scale: [0.75, 1.5],
      pow: 1.6,
      biome: "ice",
      accept: (c) => {
        if (lakeT(c.x, c.z) < 1.25 || Math.hypot(c.x, c.z) < 18 || c.slope() > 0.5) return 0;
        if (c.y > 55 - noise2(c.x * 0.02, c.z * 0.02) * 12) return 0;
        return noise2(c.x * 0.011 + 31, c.z * 0.011) > -0.05 ? 1 : 0;
      },
    });
    // old-growth forest: dense, towering pines (candidate area = the cells the circle touches)
    const forest = cellGen({
      seed: 63 + v,
      n: 16,
      scale: [1.7, 3.0],
      pow: 1.6,
      accept: (c) => (inForest(c.x, c.z) && c.slope() < 0.6 && c.y < 70 ? 1 : 0),
    });
    const gen = concatGen(open, forest);
    const hi = buildConifer(style);
    out.push({
      id: `conifer-hi-${v}`,
      parts: [
        { geometry: hi.trunk, material: barkMat },
        { geometry: hi.foliage, material: needleMat, receive: false, depth: needleDepth },
      ],
      max: HI,
      castMax: 110,
      gen,
      solid: { r: style.trunkR + 0.15, h: style.height, crown: style.crownR * 0.8 },
    });
    const lo = buildConifer({ ...style, tiers: Math.max(4, Math.round(style.tiers * 0.4)) });
    out.push({
      id: `conifer-lo-${v}`,
      parts: [
        { geometry: lo.trunk, material: barkMat },
        { geometry: lo.foliage, material: needleMat, receive: false },
      ],
      min: HI,
      max: 750,
      gen,
    });
  });

  // dead trees around the lake
  const deadMat = withSnowCap(new THREE.MeshStandardMaterial({ map: barkTex, color: "#6f665e", roughness: 1 }), "dead-tree-snow", 0.9);
  const deadStyle = { ...TREE_STYLES[1], cardsPerCluster: 0, droop: 0.2, height: 8 };
  out.push({
    id: "ice-dead-trees",
    solid: { r: 0.35, h: 8 },
    parts: [{ geometry: buildTree(deadStyle).bark, material: deadMat, receive: false }],
    max: 450,
    castMax: 90,
    gen: cellGen({
      seed: 77,
      n: 6,
      scale: [0.7, 1.2],
      biome: "ice",
      accept: (c) => {
        const t = lakeT(c.x, c.z);
        return t >= 1.15 && t <= 2.4 && c.slope() < 0.4 ? 1 : 0;
      },
    }),
  });

  // boulders + big erratics
  const rockMat = withSnowCap(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), "ice-rock-snow");
  const rock = buildRock();
  out.push({
    id: "ice-boulders",
    solid: { r: 0.85, h: 0.75, minS: 0.9 },
    parts: [{ geometry: rock, material: rockMat }],
    max: 380,
    castMax: 80,
    gen: cellGen({
      seed: 9,
      n: 1,
      scale: [0.6, 3.4],
      biome: "ice",
      accept: (c) => (Math.hypot(c.x, c.z) > 12 && c.slope() < 1.2 && c.y < 160 && lakeT(c.x, c.z) > 1.0 ? 1 : 0),
    }),
  });
  out.push({
    id: "ice-erratics",
    solid: { r: 0.85, h: 0.8 },
    parts: [{ geometry: rock, material: rockMat }],
    max: 900,
    castMax: 120,
    gen: cellGen({
      seed: 19,
      n: 0.1,
      scale: [4.5, 8],
      biome: "ice",
      accept: (c) => (c.slope() < 0.6 && c.y < 60 && lakeT(c.x, c.z) > 1.1 ? 1 : 0),
    }),
  });

  // ice crystals
  const iceMat = new THREE.MeshStandardMaterial({
    color: "#a6d6f0",
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.8,
    emissive: "#1a5a86",
    emissiveIntensity: 0.35,
    envMapIntensity: 2.2,
    flatShading: true,
  });
  out.push({
    id: "ice-crystals",
    parts: [{ geometry: buildCrystals(), material: iceMat, receive: true }],
    max: 400,
    gen: concatGen(
      cellGen({
        seed: 51,
        n: 3,
        scale: [0.7, 1.6],
        biome: "ice",
        accept: (c) => {
          const t = lakeT(c.x, c.z);
          return t >= 0.95 && t <= 1.5 && c.slope() < 0.5 ? 1 : 0;
        },
      }),
      cellGen({ seed: 52, n: 0.12, scale: [0.8, 2.2], biome: "ice", accept: (c) => (c.slope() < 0.8 && c.y < 120 ? 1 : 0) }),
    ),
  });

  // bones of the giants (fixed sites)
  const boneMat = withSnowCap(new THREE.MeshStandardMaterial({ color: "#cfc3a4", roughness: 0.82 }), "bone-snow", 0.8);
  out.push({
    id: "ice-bones",
    parts: [{ geometry: buildSkeleton(8), material: boneMat }],
    max: 900,
    castMax: 150,
    gen: fixedGen([
      { x: 34, z: -1334, r: 0.6, s: 1.15, sink: 0.45 },
      { x: -165, z: -1248, r: 2.1, s: 1.15, sink: 0.45 },
      { x: 118, z: -1468, r: 4.0, s: 1.15, sink: 0.45 },
    ]),
  });
  return out;
}
