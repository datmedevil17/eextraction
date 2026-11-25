"use client";

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { fbm, seededRandom, terrainHeight, nukeCity, nukePlatform, nukePoolT } from "@/game/terrain";
import { cellGen, fixedGen, wind, PropsStream, type Part, type Placement, type Species } from "./propsStream";
import { addBoxCollider, addCollider, blocked } from "./colliders";
import { FOOTS, HALLS, HEIGHTS, REACTOR, SKY, STACKS, STACK_H, TOWERS, TOWER_H, CITY } from "./nukeLayout";
import { Parts } from "./nukeParts";

// The reactor complex + the ruined city. Procedural landmarks (cooling towers, reactor,
// stacks, turbine halls, skyscrapers) plus Quaternius CC0 buildings / props, all dressed with
// a "derelict" shader: grime, rust streaks and glowing green cracks where radiation leaks out.

const GLSL = /* glsl */ `
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  vec2 h22(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
  vec3 vor(vec2 p) {
    vec2 ip = floor(p), fp = fract(p);
    float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = h22(ip + g);
      float d = length(g + o - fp);
      if (d < d1) { d2 = d1; d1 = d; id = ip + g; } else if (d < d2) { d2 = d; }
    }
    return vec3(d2 - d1, id);
  }
`;

type Look = {
  leak?: number; // glowing crack density 0..1
  windows?: boolean;
  stripes?: boolean; // red/white chimney bands
  grime?: number;
  dark?: number; // multiply base colour
};

/** Add the derelict + radiation-leak look to any standard material (instancing aware). */
function derelict<T extends THREE.MeshStandardMaterial>(m: T, key: string, look: Look = {}) {
  const leak = look.leak ?? 0.5;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uT = wind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\nvarying float vBase;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          mat4 wm = modelMatrix * instanceMatrix;
        #else
          mat4 wm = modelMatrix;
        #endif
        vWN = normalize(mat3(wm) * normal);
        vWP = (wm * vec4(transformed, 1.0)).xyz;
        vBase = wm[3].y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\nvarying float vBase;\nuniform float uT;\n${GLSL}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float hh = vWP.y - vBase;
        vec2 wallUV = vec2(vWP.x + vWP.z, vWP.y);
        float side = 1.0 - smoothstep(0.55, 0.9, abs(vWN.y));
        float grain = vn(vWP.xz * 0.9 + vWP.y * 0.7) * 0.55 + vn(vWP.xz * 4.0 + vWP.y * 3.0) * 0.45;
        diffuseColor.rgb *= ${(look.dark ?? 0.9).toFixed(2)} * (0.62 + 0.55 * grain);
        // soot at the base, rain streaks from the top
        float streak = vn(vec2((vWP.x + vWP.z) * 1.7, vWP.y * 0.05));
        diffuseColor.rgb *= 1.0 - ${(look.grime ?? 0.5).toFixed(2)} * side * (0.25 * streak + 0.5 * (1.0 - smoothstep(0.0, 14.0, hh)));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.22, 0.12), side * smoothstep(0.62, 0.9, streak) * 0.35);
        ${
          look.stripes
            ? `float band = step(0.5, fract(hh / 18.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.62, 0.1, 0.07), vec3(0.78, 0.76, 0.7), band), step(14.0, hh) * 0.9);
        diffuseColor.rgb *= 0.55 + 0.45 * grain;`
            : ""
        }
        float winLit = 0.0;
        float winGlass = 0.0;
        ${
          look.windows
            ? `if (side > 0.5) {
          vec2 cell = vec2(3.4, 3.9);
          vec2 q = wallUV / cell;
          vec2 id = floor(q); vec2 f = fract(q);
          float inWin = step(0.16, f.x) * step(f.x, 0.84) * step(0.2, f.y) * step(f.y, 0.8);
          float r = h21(id + floor(vBase));
          float broken = step(0.72, r);
          winGlass = inWin * (1.0 - broken * 0.55);
          winLit = inWin * step(0.965, h21(id * 1.7 + 4.0)) ;
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.05, 0.075, 0.08), vec3(0.01, 0.012, 0.012), broken), winGlass);
          // floor slabs / ledges
          diffuseColor.rgb *= 1.0 - 0.35 * (1.0 - step(0.08, f.y));
        }`
            : ""
        }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          ${
            look.windows
              ? `totalEmissiveRadiance += vec3(0.9, 1.0, 0.35) * winLit * 2.4 * (0.6 + 0.4 * sin(uT * 3.0 + vWP.y));`
              : ""
          }
          // radiation seeping through cracks in the concrete
          if (length(vWP - cameraPosition) < 260.0) {
          vec2 q = wallUV * 0.22 + (vec2(vn(wallUV * 0.4), vn(wallUV * 0.4 + 5.0)) - 0.5) * 0.8;
          vec3 c1 = vor(q);
          float vein = 1.0 - smoothstep(0.0, 0.05, c1.x);
          float vein2 = (1.0 - smoothstep(0.0, 0.06, vor(q * 2.8 + 9.0).x)) * 0.55;
          float halo = (1.0 - smoothstep(0.0, 0.2, c1.x)) * 0.05;
          float sel = step(1.0 - ${leak.toFixed(2)}, h21(c1.yz + 3.0));
          float pulse = 0.6 + 0.4 * sin(uT * 1.5 + h21(c1.yz) * 30.0);
          float lowMask = 1.0 - 0.6 * smoothstep(0.0, 30.0, hh) * 0.0;
          totalEmissiveRadiance += mix(vec3(0.3, 1.0, 0.08), vec3(0.85, 1.0, 0.3), vein) * (max(vein, vein2) + halo) * sel * pulse * 1.3 * lowMask * ${look.windows ? "side * 0.7" : "1.0"} * (1.0 - smoothstep(150.0, 260.0, length(vWP - cameraPosition)));
          }
        }`,
      )
      .replace(
        "#include <fog_fragment>",
        `#ifdef USE_FOG
          // distant ruins fade into dark smog, not into the bright sky
          float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor * 0.38 + vec3(0.02, 0.025, 0.02), fogF * 0.92);
        #endif`,
      );
  };
  m.customProgramCacheKey = () => "derelict-" + key;
  return m;
}

const concrete = (key: string, color: string, look?: Look) =>
  derelict(new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide }), key, look);

// ---------- procedural geometry ----------
function coolingTower() {
  const H = TOWER_H, rt = 21, c = 67.9, yt = 0.72 * H;
  const pts: THREE.Vector2[] = [];
  const N = 28;
  for (let i = 0; i <= N; i++) {
    const y = (i / N) * H;
    const rr = rt * Math.sqrt(1 + ((y - yt) / c) ** 2);
    pts.push(new THREE.Vector2(rr, y));
  }
  pts.push(new THREE.Vector2(rt * Math.sqrt(1 + ((H - yt) / c) ** 2) - 1.4, H)); // lip
  pts.push(new THREE.Vector2(rt * Math.sqrt(1 + ((H - yt) / c) ** 2) - 2.2, H - 6));
  const g = new THREE.LatheGeometry(pts, 48);
  // a ragged collapsed notch near the top rim
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    const notch = Math.max(0, Math.cos(a - 0.9)) ** 6;
    if (y > H - 22) p.setY(i, y - notch * (y - (H - 22)) * (0.5 + 0.5 * Math.sin(a * 23 + y)) * 1.1);
  }
  g.computeVertexNormals();
  return g;
}

function reactorDome() {
  const pts: THREE.Vector2[] = [new THREE.Vector2(30, -3), new THREE.Vector2(30.4, 14), new THREE.Vector2(30, 30)];
  const R = 30;
  for (let i = 1; i <= 14; i++) {
    const a = (i / 14) * (Math.PI / 2) * 0.95;
    pts.push(new THREE.Vector2(Math.cos(a) * R, 30 + Math.sin(a) * R * 0.78));
  }
  const g = new THREE.LatheGeometry(pts, 40);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // blown-open breach on the east side of the dome
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    const f = Math.max(0, Math.cos(a + 0.4)) ** 5 * Math.max(0, (y - 24) / 30);
    p.setX(i, x * (1 - f * 0.45));
    p.setZ(i, z * (1 - f * 0.45));
    p.setY(i, y - f * 12);
  }
  g.computeVertexNormals();
  return g;
}

function stackGeo() {
  const g = new THREE.CylinderGeometry(3.4, 6.2, STACK_H, 20, 12, true);
  g.translate(0, STACK_H / 2, 0);
  return g;
}

function hallGeo() {
  const parts = [
    new THREE.BoxGeometry(76, 24, 36).translate(0, 12, 0),
    new THREE.BoxGeometry(60, 6, 28).translate(-3, 27, 0),
    new THREE.CylinderGeometry(4, 4, 36, 12).rotateX(Math.PI / 2).translate(-30, 30, 0),
  ];
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
}

/** Skyscraper: box with a jagged, partially collapsed roof. */
function skyscraper(w: number, h: number, seed: number) {
  const g = new THREE.BoxGeometry(w, h, w, 4, 6, 4).toNonIndexed();
  g.translate(0, h / 2, 0);
  const rnd = seededRandom(seed * 7919 + (w | 0) * 31 + (h | 0));
  const p = g.attributes.position;
  const cut = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y > h - 0.01) {
      const k = `${x.toFixed(2)},${z.toFixed(2)}`;
      if (!cut.has(k)) cut.set(k, Math.pow(rnd(), 1.4) * Math.min(26, h * 0.3));
      p.setY(i, y - (cut.get(k) as number));
    }
  }
  g.computeVertexNormals();
  g.deleteAttribute("uv");
  return g;
}

// ---------- glTF models (Quaternius, CC0) ----------
type Model = { parts: Part[]; w: number; d: number; h: number };
const MODEL_DIR = "/models/nuke/";
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

function floatAttr(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number) {
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) {
    out[i * size] = a.getX(i);
    if (size > 1) out[i * size + 1] = a.getY(i);
    if (size > 2) out[i * size + 2] = a.getZ(i);
  }
  return new THREE.BufferAttribute(out, size);
}

async function loadModel(name: string, targetH: number, key: string, look: Look): Promise<Model> {
  const gltf = await loader.loadAsync(MODEL_DIR + name + ".glb");
  gltf.scene.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.geometry;
    const pos = src.attributes.position;
    const g = new THREE.BufferGeometry();
    const P = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
      P.set([v.x, v.y, v.z], i * 3);
      box.expandByPoint(v);
    }
    g.setAttribute("position", new THREE.BufferAttribute(P, 3));
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    if (src.attributes.normal) {
      const n = src.attributes.normal;
      const N = new Float32Array(n.count * 3);
      for (let i = 0; i < n.count; i++) {
        v.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(nm).normalize();
        N.set([v.x, v.y, v.z], i * 3);
      }
      g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    }
    if (src.attributes.uv) g.setAttribute("uv", floatAttr(src.attributes.uv, 2));
    if (src.attributes.color) g.setAttribute("color", floatAttr(src.attributes.color, 3));
    if (src.index) g.setIndex(src.index.clone());
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
    const l = byMat.get(mat) ?? [];
    l.push(g);
    byMat.set(mat, l);
  });
  const size = box.getSize(new THREE.Vector3());
  const k = targetH / Math.max(0.001, size.y);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const parts: Part[] = [];
  let mi = 0;
  for (const [mat, geos] of byMat) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos.map((g) => (g.index && geos.some((q) => !q.index) ? g.toNonIndexed() : g)), false);
    if (!merged) continue;
    merged.translate(-cx, -box.min.y, -cz);
    merged.scale(k, k, k);
    const std = mat as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardMaterial({ color: std.color ?? new THREE.Color("#888"), map: std.map ?? null, roughness: 0.9, metalness: 0.1, vertexColors: !!merged.attributes.color });
    m.color.multiplyScalar(0.75);
    parts.push({ geometry: merged, material: derelict(m, `${key}-${mi++}`, look) });
  }
  return { parts, w: size.x * k, d: size.z * k, h: targetH };
}

// ---------- species ----------
function items(list: { x: number; z: number; r: number; s?: number }[], sink = 0.4) {
  return fixedGen(list.map((i) => ({ ...i, sink })));
}

const scatterRand = seededRandom(424242);

type ModelSpec = { file: string; h: number; look?: Look; rad?: number; solid?: { r: number; h: number } };
const BUILDINGS: ModelSpec[] = [
  { file: "Building1_Large", h: 34 },
  { file: "Building1_Small", h: 20 },
  { file: "Building2_Large", h: 30 },
  { file: "Building2_Small", h: 18 },
  { file: "Building3_Big", h: 28 },
  { file: "Building3_Small", h: 16 },
  { file: "Building4", h: 22 },
  { file: "4Story_Mat", h: 17 },
  { file: "4Story_Center_Mat", h: 17 },
  { file: "4Story_Wide_2Doors_Mat", h: 16 },
  { file: "6Story_Stack_Mat", h: 26 },
  { file: "3Story_Slim_Mat", h: 13 },
];
const PLANT_PROPS: ModelSpec[] = [
  { file: "Tank", h: 16 },
  { file: "Tank3", h: 14 },
];
const SMALL: ModelSpec[] = [
  { file: "Battery_Big", h: 1.4, solid: { r: 0.6, h: 1.4 } },
  { file: "GasCan", h: 0.7 },
  { file: "PropaneTank", h: 1.4, solid: { r: 0.4, h: 1.4 } },
  { file: "Sign_Stop", h: 3.4, solid: { r: 0.14, h: 3.4 } },
  { file: "Streetlight_Double", h: 8.5, solid: { r: 0.25, h: 8.5 } },
  { file: "TrafficLight", h: 5.4, solid: { r: 0.22, h: 5.4 } },
  { file: "Trashcan", h: 1.1, solid: { r: 0.38, h: 1.1 } },
];

type Loaded = Record<string, Model>;

/** Procedural + glTF species. `models` must already be loaded. */
function nukeSpecies(models: Loaded): Species[] {
  const out: Species[] = [];
  const leakLook: Look = { leak: 0.55, grime: 0.6 };

  out.push({
    id: "nuke-towers",
    parts: [{ geometry: coolingTower(), material: concrete("tower", "#9a9a92", { leak: 0.75, grime: 0.7 }) }],
    max: 1500,
    castMax: 160,
    gen: items(TOWERS, 1.5),
  });
  out.push({
    id: "nuke-reactor",
    parts: [{ geometry: reactorDome(), material: concrete("reactor", "#8c8f88", { leak: 0.95, grime: 0.75 }) }],
    max: 1500,
    castMax: 140,
    gen: items([{ x: REACTOR.x, z: REACTOR.z, r: 0 }], 2),
  });
  out.push({
    id: "nuke-stacks",
    parts: [{ geometry: stackGeo(), material: concrete("stack", "#a6a39a", { stripes: true, leak: 0.2 }) }],
    max: 1500,
    castMax: 80,
    gen: items(STACKS, 1),
  });
  out.push({
    id: "nuke-halls",
    parts: [{ geometry: hallGeo(), material: concrete("hall", "#7d8078", { leak: 0.6, grime: 0.8 }) }],
    max: 1000,
    castMax: 120,
    gen: items(HALLS, 0.5),
  });

  // skyscrapers: one species per (height, footprint, roof variant)
  for (let cls = 0; cls < HEIGHTS.length * 2; cls++) {
    const h = HEIGHTS[cls >> 1];
    const w = FOOTS[cls & 1];
    for (let v = 0; v < 4; v++) {
      const mine = SKY.filter((s) => s.cls === cls && s.variant === v);
      if (!mine.length) continue;
      out.push({
        id: `nuke-sky-${cls}-${v}`,
        parts: [
          {
            geometry: skyscraper(w, h, v + cls * 5),
            material: concrete(`sky${(cls >> 1) % 3}`, ["#6c7076", "#80786c", "#5d6670"][(cls >> 1) % 3], { windows: true, leak: 0.35, grime: 0.7, dark: 0.85 }),
          },
        ],
        max: 1300,
        castMax: cls >> 1 >= 3 ? 0 : 140,
        gen: items(mine.map((s) => ({ x: s.x, z: s.z, r: s.r })), 2),
      });
    }
  }

  // glTF low-rise buildings: ring around the plant + the city edge + roadside
  const rng = seededRandom(1337);
  const plan: Record<string, { x: number; z: number; r: number }[]> = {};
  // every building claims its footprint right away, so later ones (and all the scatter) can't overlap it
  const place = (file: string, x: number, z: number, r: number, force = false) => {
    const m = models[file];
    if (!m) return false;
    const rad = Math.max(m.w, m.d) * 0.55;
    if (!force && blocked(x, z, rad + 3)) return false;
    (plan[file] ??= []).push({ x, z, r });
    addBoxCollider(x, z, m.w * 0.94, m.d * 0.94, r, terrainHeight(x, z) - 3, terrainHeight(x, z) + m.h); // the real footprint, corners included
    return true;
  };
  // outer city, between the skyscrapers and the plant
  for (let i = 0, tries = 0; i < 90 && tries < 600; tries++) {
    const a = rng() * Math.PI * 2;
    const d = 185 + rng() * 120;
    const x = CITY.x + Math.cos(a) * d * 1.1;
    const z = CITY.z + Math.sin(a) * d;
    if (nukeCity(x, z) > 0.05 && rng() < 0.15) continue;
    if (nukePoolT(x, z) < 1.6) continue;
    const b = BUILDINGS[Math.floor(rng() * BUILDINGS.length)];
    if (place(b.file, x, z, Math.floor(rng() * 4) * (Math.PI / 2))) i++;
  }
  // service buildings in the plant yard
  const yard: [number, number][] = [[1130, -120], [1120, 130], [1235, 190], [1235, -195], [1390, -170], [1395, 175], [1085, 0], [1180, 90], [1180, -90]];
  yard.forEach(([x, z], i) => place(BUILDINGS[(i * 5 + 1) % BUILDINGS.length].file, x, z, (i % 4) * (Math.PI / 2)));
  // fuel tanks beside the turbine halls
  const tanks: [string, number, number][] = [["Tank", 1345, 20], ["Tank", 1345, -20], ["Tank3", 1420, 10], ["Tank3", 1210, 0], ["Tank", 1120, 55], ["Tank3", 1120, -60]];
  tanks.forEach(([f, x, z]) => place(f, x, z, 0));

  for (const b of [...BUILDINGS, ...PLANT_PROPS]) {
    const m = models[b.file];
    const list = plan[b.file];
    if (!m || !list?.length) continue;
    out.push({
      id: "nuke-m-" + b.file,
      parts: m.parts,
      max: b.h > 20 ? 1200 : 800,
      castMax: 110,
      gen: items(list, 0.3),
    });
  }

  // street furniture along the main road + cell scatter
  const lamps: { x: number; z: number; r: number }[] = [];
  for (let x = 790; x < 1500; x += 38) {
    const z = 40 + Math.sin(x * 0.01) * 6 + (x % 76 < 38 ? 7 : -7);
    lamps.push({ x, z, r: x % 76 < 38 ? Math.PI / 2 : -Math.PI / 2 });
  }
  if (models.Streetlight_Double)
    out.push({ id: "nuke-lamps", parts: models.Streetlight_Double.parts, max: 380, castMax: 0, gen: items(lamps, 0.1), solid: { r: 0.25, h: 8.5 } });

  const nukeScatter = (seed: number, n: number, scale: [number, number], extra?: (c: { x: number; z: number; w: { nuke: number } }) => number, pad = 4) =>
    cellGen({
      seed,
      n,
      scale,
      biome: "nuke",
      accept: (c) => {
        const road = Math.abs(c.z - 40 - Math.sin(c.x * 0.01) * 6) < 7 && c.x > 780 ? 0.15 : 1;
        if (nukePoolT(c.x, c.z) < 1.4) return 0;
        if (blocked(c.x, c.z, pad)) return 0; // never inside / clipping a building
        return road * (extra ? extra(c) : 1);
      },
    });

  // solid scatter: register a collider the first time a placement is generated (cells are cached, so once)
  const solidGen = (gen: (cx: number, cz: number) => Placement[], r: number, h: number) => {
    const seen = new Set<string>();
    return (cx: number, cz: number) => {
      const list = gen(cx, cz);
      const k = cx + "," + cz;
      if (!seen.has(k)) {
        seen.add(k);
        for (const p of list) addCollider(p.x, p.z, r * p.s, p.y - 2, p.y + h * p.s);
      }
      return list;
    };
  };

  // same, with the real rectangular footprint (w x d at scale 1, turned with the placement)
  const boxGen = (gen: (cx: number, cz: number) => Placement[], w: number, d: number, h: number) => {
    const seen = new Set<string>();
    return (cx: number, cz: number) => {
      const list = gen(cx, cz);
      const k = cx + "," + cz;
      if (!seen.has(k)) {
        seen.add(k);
        for (const p of list) addBoxCollider(p.x, p.z, w * p.s, d * p.s, p.r, p.y - 2, p.y + h * p.s);
      }
      return list;
    };
  };

  // dead trees
  const treeMat = new THREE.MeshStandardMaterial({ color: "#2a251d", roughness: 1 });
  out.push({
    id: "nuke-deadtrees",
    parts: [{ geometry: deadTree(), material: treeMat }],
    max: 330,
    castMax: 60,
    gen: solidGen(nukeScatter(5101, 2.2, [0.8, 1.7], (c) => (nukePlatform(c.x, c.z) > 0.4 || nukeCity(c.x, c.z) > 0.5 ? 0.2 : 1) * (0.5 + 0.5 * (fbm(c.x * 0.01, c.z * 0.01, 2) + 1) / 2), 3), 0.45, 9),
  });
  // rubble + shattered concrete
  const rubble = new THREE.MeshStandardMaterial({ color: "#56554d", roughness: 1, flatShading: true });
  out.push({
    id: "nuke-rubble",
    parts: [{ geometry: rubbleGeo(), material: derelict(rubble, "rubble", { leak: 0.3 }) }],
    max: 280,
    castMax: 40,
    gen: nukeScatter(5102, 7, [0.7, 2.6], (c) => 0.35 + 0.65 * Math.max(nukeCity(c.x, c.z), nukePlatform(c.x, c.z))),
    solid: { r: 1.1, h: 1.0, minS: 1.1 }, // the bigger heaps block you, small ones you step over
  });
  // shipping containers and barrels
  const cont = new THREE.MeshStandardMaterial({ color: "#7a4a2e", roughness: 0.8, metalness: 0.4 });
  out.push({
    id: "nuke-containers",
    parts: [{ geometry: new THREE.BoxGeometry(6.1, 2.6, 2.44).translate(0, 1.3, 0), material: derelict(cont, "cont", { leak: 0.1 }) }],
    max: 380,
    castMax: 90,
    gen: boxGen(nukeScatter(5103, 0.7, [1, 1], (c) => Math.max(nukePlatform(c.x, c.z), nukeCity(c.x, c.z) * 0.5) > 0.3 ? 1 : 0.1, 5), 6.1, 2.44, 2.6),
  });
  // little props via models
  for (const [i, b] of SMALL.entries()) {
    const m = models[b.file];
    if (!m || b.file === "Streetlight_Double") continue;
    out.push({ id: "nuke-s-" + b.file, parts: m.parts, max: 240, castMax: 0, gen: nukeScatter(5200 + i, 1.4, [0.9, 1.15], (c) => 0.3 + 0.7 * Math.max(nukeCity(c.x, c.z), nukePlatform(c.x, c.z))), solid: b.solid });
  }
  void leakLook;
  void scatterRand;
  return out;
}

function deadTree() {
  const rnd = seededRandom(77);
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.1, 0.22, 4.2, 6, 1, true);
  trunk.translate(0, 2.1, 0);
  parts.push(trunk);
  for (let i = 0; i < 6; i++) {
    const b = new THREE.CylinderGeometry(0.02, 0.09, 1.7, 5, 1, true);
    b.translate(0, 0.85, 0);
    b.rotateZ(0.7 + rnd() * 0.5);
    b.rotateY(rnd() * 6.28);
    b.translate(0, 2.2 + rnd() * 1.8, 0);
    parts.push(b);
  }
  return mergeGeometries(parts.map((g) => { const c = g.toNonIndexed(); c.deleteAttribute("uv"); return c; }))!;
}

function rubbleGeo() {
  const rnd = seededRandom(31);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const b = new THREE.BoxGeometry(0.5 + rnd() * 1.4, 0.3 + rnd() * 0.9, 0.5 + rnd() * 1.4);
    b.rotateY(rnd() * 3).rotateX((rnd() - 0.5) * 0.7).rotateZ((rnd() - 0.5) * 0.7);
    b.translate((rnd() - 0.5) * 2.2, 0.25 + rnd() * 0.3, (rnd() - 0.5) * 2.2);
    parts.push(b.toNonIndexed());
  }
  return mergeGeometries(parts)!;
}

// ---------- mount ----------
const ALL_MODELS: ModelSpec[] = [...BUILDINGS, ...PLANT_PROPS, ...SMALL];

export function NuclearZone() {
  const [models, setModels] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(
      ALL_MODELS.map((s) =>
        loadModel(s.file, s.h, s.file, s.look ?? { leak: 0.3, grime: 0.7 }).then(
          (m) => [s.file, m] as const,
          () => null,
        ),
      ),
    ).then((r) => {
      if (!live) return;
      const o: Loaded = {};
      for (const e of r) if (e) o[e[0]] = e[1];
      setModels(o);
    });
    return () => {
      live = false;
    };
  }, []);
  const build = useMemo(() => (models ? () => nukeSpecies(models) : null), [models]);
  return (
    <>
      {build && <PropsStream build={build} />}
      <Parts />
    </>
  );
}
