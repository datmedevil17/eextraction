"use client";

import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { noise2, oasisHutGap, oasisRockW, oasisT, playaMask, seededRandom } from "@/game/terrain";
import { TREE_STYLES, buildTree, makeBarkTexture } from "./trees";
import { taperedTube } from "./conifers";
import { buildRock } from "./Props";
import { cellGen, concatGen, fixedGen, wind, type Species } from "./propsStream";
import { buildSkeleton } from "./IceProps";

// Everything standing on the sand: palms, cacti, scrub, hoodoos, sunken ruins,
// bleached bones. All procedural, no downloads.

/** Strip uv/normal so different primitives can be merged. */
function prep(g: THREE.BufferGeometry) {
  const c = g.clone();
  c.deleteAttribute("uv");
  c.deleteAttribute("normal");
  return c;
}
function smoothMerge(parts: THREE.BufferGeometry[]) {
  const m = mergeVertices(mergeGeometries(parts.map(prep))!, 1e-3);
  m.computeVertexNormals();
  return m;
}

const GLSL_NOISE = /* glsl */ `
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
`;

/** Drifted sand: collects on upward faces and piles up around the base. */
function withSandCap<T extends THREE.MeshStandardMaterial>(m: T, key: string, amount = 1, bury = 1.0) {
  m.onBeforeCompile = (shader) => {
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
      .replace("#include <common>", `#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\nvarying float vBase;\n${GLSL_NOISE}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          float n = vn(vWP.xz * 1.7 + vWP.y * 0.9) * 0.6 + vn(vWP.xz * 7.0) * 0.4;
          // weathering: pale and dark patches in the stone
          diffuseColor.rgb *= 0.78 + 0.4 * vn(vWP.xz * 0.8 + vWP.y * 2.2);
          float up = smoothstep(0.3, 0.7, vWN.y * ${amount.toFixed(2)} + (n - 0.5) * 0.5);
          float foot = 1.0 - smoothstep(0.0, ${bury.toFixed(2)} + n * 0.8, vWP.y - vBase);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.69, 0.43), clamp(max(up * 0.9, foot), 0.0, 1.0));
        }`,
      );
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/** Sway for card-based plants, driven by uv.y (0 at the root). */
function withSway(m: THREE.Material, wind: { value: number }, key: string, strength: number) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec3 iPos = instanceMatrix[3].xyz;
        float root = clamp(uv.y, 0.0, 1.0);
        float ph = uTime * 1.6 + iPos.x * 0.23 + iPos.z * 0.31;
        float gust = 0.6 + 0.4 * sin(uTime * 0.4 + iPos.x * 0.02);
        transformed.x += (sin(ph + transformed.y * 0.6) + sin(uTime * 3.1 + transformed.x * 4.0) * 0.25) * ${strength.toFixed(3)} * root * root * gust;
        transformed.z += cos(ph * 0.8) * ${(strength * 0.7).toFixed(3)} * root * root * gust;`,
      );
  };
  m.customProgramCacheKey = () => key;
}

// ---------------------------------------------------------------- palms
function makePalmTexture() {
  const W = 256;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const rand = seededRandom(5);
  ctx.lineCap = "round";
  ctx.strokeStyle = "#5a6a2c";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(W / 2, H);
  ctx.lineTo(W / 2, 4);
  ctx.stroke();
  const pairs = 120;
  for (let i = 0; i < pairs; i++) {
    const s = i / pairs;
    const y = H - 6 - s * (H - 14);
    const env = Math.pow(Math.sin(Math.PI * (0.06 + 0.9 * s)), 0.8) * (1 - 0.25 * s);
    const len = (W / 2) * 0.96 * env * (0.88 + rand() * 0.2);
    for (const side of [-1, 1]) {
      const hh = 78 + rand() * 22;
      const l = 22 + rand() * 16 + s * 6;
      ctx.strokeStyle = `hsl(${hh},${42 + rand() * 14}%,${l}%)`;
      ctx.lineWidth = 3.2 - s * 1.3;
      ctx.beginPath();
      ctx.moveTo(W / 2, y);
      ctx.quadraticCurveTo(W / 2 + side * len * 0.55, y - len * 0.12, W / 2 + side * len, y - len * 0.44);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function buildPalm(seed: number, height: number) {
  const rand = seededRandom(seed * 7919);
  const lean = (rand() - 0.5) * 2.2;
  const a = rand() * Math.PI * 2;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const top = V(Math.cos(a) * lean, height, Math.sin(a) * lean);
  const curve = new THREE.CatmullRomCurve3([
    V(0, -0.3, 0),
    V(Math.cos(a) * lean * 0.1, height * 0.33, Math.sin(a) * lean * 0.1),
    V(Math.cos(a) * lean * 0.45, height * 0.68, Math.sin(a) * lean * 0.45),
    top,
  ]);
  const trunk = taperedTube(curve, 22, 0.34, 0.2, 10);

  const P: number[] = [];
  const UV: number[] = [];
  const I: number[] = [];
  const nFronds = 17;
  for (let f = 0; f < nFronds; f++) {
    const ring = f % 3; // 0 = crown spike, 1 = spreading, 2 = drooping skirt
    const ang = (f / nFronds) * Math.PI * 2 * 1.618 + rand() * 0.3;
    const L = (3.6 + rand() * 1.4) * (ring === 0 ? 0.8 : 1);
    const rise = ring === 0 ? 0.85 : ring === 1 ? 0.3 : -0.05;
    const dir = V(Math.cos(ang), 0, Math.sin(ang));
    const side = V(-Math.sin(ang), 0, Math.cos(ang));
    const segs = 9;
    const base = P.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const along = L * t;
      const yy = rise * L * t - L * (ring === 0 ? 0.35 : 0.75) * t * t;
      const w = (0.12 + 0.98 * Math.sin(Math.PI * Math.pow(t, 0.7) * 0.97)) * 0.5 * (ring === 0 ? 0.7 : 1);
      for (const sd of [-1, 1]) {
        const fold = Math.abs(w) * 0.35; // V-shaped frond
        P.push(top.x + dir.x * along + side.x * w * sd, top.y + yy + fold, top.z + dir.z * along + side.z * w * sd);
        UV.push(sd < 0 ? 0 : 1, t);
      }
    }
    for (let s = 0; s < segs; s++) {
      const q = base + s * 2;
      I.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
    }
  }
  const fronds = new THREE.BufferGeometry();
  fronds.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  fronds.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
  fronds.setIndex(I);
  fronds.computeVertexNormals();
  return { trunk, fronds };
}

// ---------------------------------------------------------------- cacti
const CAC_DARK = new THREE.Color("#35603a");
const CAC_MID = new THREE.Color("#5b8a4c");
const CAC_SPINE = new THREE.Color("#d9cf9c");

function paint(g: THREE.BufferGeometry, c: THREE.Color | string) {
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.toArray(arr, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Tapered tube with longitudinal ribs; ridges carry pale spine-areole colour. */
function ribbedTube(curve: THREE.Curve<THREE.Vector3>, segments: number, r0: number, r1: number, ribs: number, tint = 0) {
  const radial = ribs * 4;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const frames = curve.computeFrenetFrames(segments, false);
  const c = new THREE.Color();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    const r = r0 + (r1 - r0) * Math.pow(t, 0.8);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cr = Math.cos(a * ribs);
      const ridge = (cr + 1) / 2;
      const rr = r * (1 + 0.1 * cr);
      const n = frames.normals[i];
      const b = frames.binormals[i];
      pos.push(p.x + (n.x * Math.cos(a) + b.x * Math.sin(a)) * rr, p.y + (n.y * Math.cos(a) + b.y * Math.sin(a)) * rr, p.z + (n.z * Math.cos(a) + b.z * Math.sin(a)) * rr);
      c.copy(CAC_DARK).lerp(CAC_MID, Math.pow(ridge, 0.7)).lerp(CAC_SPINE, Math.pow(ridge, 12) * 0.55);
      c.offsetHSL(tint, 0, 0);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < segments; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      idx.push(a, b, a + radial, b, b + radial, a + radial);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function flowerCrown(x: number, y: number, z: number, rand: () => number, r: number) {
  const out: THREE.BufferGeometry[] = [];
  const n = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand();
    const f = new THREE.SphereGeometry(0.11 + rand() * 0.04, 8, 6);
    f.scale(1, 0.7, 1);
    f.translate(x + Math.cos(a) * r * 0.55, y + 0.05, z + Math.sin(a) * r * 0.55);
    out.push(paint(f, rand() > 0.35 ? "#f4f0e0" : "#f0b9c8"));
  }
  return out;
}

function buildSaguaro(seed: number) {
  const rand = seededRandom(seed * 313);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const H = 5.5 + rand() * 3.5;
  const parts: THREE.BufferGeometry[] = [];
  const lean = (rand() - 0.5) * 0.4;
  parts.push(ribbedTube(new THREE.CatmullRomCurve3([V(0, -0.4, 0), V(lean * 0.3, H * 0.35, 0), V(lean * 0.7, H * 0.7, lean * 0.2), V(lean, H, lean * 0.3)]), 22, 0.5, 0.36, 12));
  const cap = new THREE.SphereGeometry(0.36, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.8, 1);
  cap.translate(lean, H, lean * 0.3);
  parts.push(paint(cap, CAC_MID));
  parts.push(...flowerCrown(lean, H + 0.18, lean * 0.3, rand, 0.36));
  const arms = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rand() * 1.5;
    const y0 = H * (0.3 + rand() * 0.3);
    const out = 1.1 + rand() * 1.0;
    const up = 1.5 + rand() * 2.2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const arm = new THREE.CatmullRomCurve3([V(0, y0 - 0.1, 0), V(dx * out * 0.55, y0 + 0.02, dz * out * 0.55), V(dx * out * 0.95, y0 + 0.35, dz * out * 0.95), V(dx * out * 1.03, y0 + up * 0.6, dz * out * 1.03), V(dx * out * 1.0, y0 + up, dz * out * 1.0)]);
    parts.push(ribbedTube(arm, 16, 0.3, 0.25, 10));
    const ac = new THREE.SphereGeometry(0.25, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    ac.scale(1, 0.8, 1);
    ac.translate(dx * out, y0 + up, dz * out);
    parts.push(paint(ac, CAC_MID));
    if (rand() > 0.4) parts.push(...flowerCrown(dx * out, y0 + up + 0.15, dz * out, rand, 0.25));
  }
  return smoothMerge(parts);
}

function buildBarrel() {
  const g = new THREE.SphereGeometry(0.5, 40, 20);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const th = Math.atan2(z, x);
    const cr = Math.cos(th * 18);
    const ridge = (cr + 1) / 2;
    const rib = 1 + 0.08 * cr;
    p.setXYZ(i, x * rib, p.getY(i) * 1.15 + 0.35, z * rib);
    c.copy(CAC_DARK).lerp(CAC_MID, Math.pow(ridge, 0.7)).lerp(CAC_SPINE, Math.pow(ridge, 10) * 0.6);
    c.lerp(new THREE.Color("#e8c46a"), Math.max(0, p.getY(i)) * 0.5 * ridge); // sun-bleached crown
    c.toArray(col, i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.deleteAttribute("uv");
  g.deleteAttribute("normal");
  const merged = mergeVertices(g, 1e-4);
  merged.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [merged];
  const rand = seededRandom(9);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const f = new THREE.SphereGeometry(0.09, 8, 6);
    f.scale(1, 0.6, 1);
    f.translate(Math.cos(a) * 0.16, 0.93 + rand() * 0.03, Math.sin(a) * 0.16);
    parts.push(paint(f, "#ef8a3a"));
  }
  return smoothMerge(parts);
}

function buildPricklyPear(seed: number) {
  const rand = seededRandom(seed);
  const parts: THREE.BufferGeometry[] = [];
  const pad = (x: number, y: number, z: number, s: number, tilt: number, yaw: number) => {
    const g = new THREE.SphereGeometry(0.5, 18, 12);
    g.scale(0.9 * s, 1.1 * s, 0.14 * s);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + Math.sin(p.getX(i) * 4 + seed) * 0.02);
    paint(g, rand() > 0.5 ? "#6f9a56" : "#5f8d57");
    g.rotateZ(tilt);
    g.rotateY(yaw);
    g.translate(x, y, z);
    parts.push(g);
    // red tunas along the upper rim
    for (let k = 0; k < 3; k++) {
      const t = (rand() - 0.5) * 0.9;
      const f = new THREE.SphereGeometry(0.075, 8, 6);
      f.scale(1, 1.3, 1);
      f.translate(t * 0.45 * s, 0.52 * s, 0.1 * s);
      f.rotateZ(tilt);
      f.rotateY(yaw);
      f.translate(x, y, z);
      parts.push(paint(f, "#b8344f"));
    }
  };
  pad(0, 0.4, 0, 1, 0, 0);
  let x = 0;
  let y = 0.85;
  let z = 0;
  for (let i = 0; i < 6; i++) {
    x += (rand() - 0.5) * 0.7;
    z += (rand() - 0.5) * 0.7;
    y += 0.3 + rand() * 0.2;
    pad(x, y, z, 0.7 + rand() * 0.25, (rand() - 0.5) * 0.9, rand() * Math.PI);
  }
  return smoothMerge(parts);
}

function makeCactusMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, envMapIntensity: 0.5 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      {
        // fuzzy spine halo catching the light at grazing angles
        float rim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 3.0);
        totalEmissiveRadiance += vec3(0.85, 0.8, 0.5) * rim * 0.22;
      }`,
    );
  };
  m.customProgramCacheKey = () => "cactus";
  return m;
}

// ---------------------------------------------------------------- hoodoos
function buildHoodoo(seed: number) {
  const rand = seededRandom(seed * 17);
  const pts: THREE.Vector2[] = [];
  const H = 7 + rand() * 6;
  const n = 20;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const neck = 0.55 + 0.25 * Math.sin(t * 9 + seed);
    const flare = t > 0.78 ? 1 + 1.5 * Math.sin(((t - 0.78) / 0.22) * Math.PI * 0.5) : 1;
    const foot = 1 + 1.4 * Math.pow(1 - Math.min(1, t / 0.18), 2);
    pts.push(new THREE.Vector2(Math.max(0.15, neck * flare * foot * (t > 0.99 ? 0.4 : 1)), t * H - 0.8));
  }
  const g = new THREE.LatheGeometry(pts, 22);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const STR = ["#b5653a", "#d99a62", "#9a5532", "#e3b982", "#a85f38"].map((c) => new THREE.Color(c));
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + noise2(x * 0.9 + seed, z * 0.9 + y * 0.6) * 0.16 + noise2(x * 3, z * 3 + y * 3) * 0.05;
    p.setXYZ(i, x * k, y, z * k);
    const band = (y + noise2(x * 0.5, z * 0.5) * 0.4) / 1.1;
    const bi = Math.floor(band);
    tmp.copy(STR[((bi % STR.length) + STR.length) % STR.length]).lerp(STR[(((bi + 1) % STR.length) + STR.length) % STR.length], Math.max(0, band - bi - 0.6) * 2.5);
    col[i * 3] = tmp.r;
    col[i * 3 + 1] = tmp.g;
    col[i * 3 + 2] = tmp.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.deleteAttribute("uv");
  g.deleteAttribute("normal");
  const w = mergeVertices(g, 1e-4);
  w.computeVertexNormals();
  return w;
}

// ---------------------------------------------------------------- ruins
function erode(g: THREE.BufferGeometry, seed: number, k = 0.07) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const d = noise2(x * 1.7 + seed, y * 1.7 + z * 1.3) * k + noise2(x * 5, z * 5 + y * 5) * k * 0.4;
    p.setXYZ(i, x + d, y + d * 0.6, z + d);
  }
  return g;
}

function buildRuins() {
  const parts: THREE.BufferGeometry[] = [];
  const keep = (g: THREE.BufferGeometry) => parts.push(prep(g));
  const column = (x: number, z: number, h: number, seed: number, tilt = 0) => {
    const r = 0.62;
    const g = new THREE.CylinderGeometry(r * 0.92, r, h, 20, 10);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const th = Math.atan2(p.getZ(i), p.getX(i));
      const f = 1 + 0.05 * Math.cos(th * 16);
      p.setXYZ(i, p.getX(i) * f, p.getY(i), p.getZ(i) * f);
    }
    erode(g, seed, 0.06);
    g.translate(0, h / 2, 0);
    g.rotateZ(tilt);
    g.translate(x, 0, z);
    keep(g);
    // base + capital
    const base = erode(new THREE.BoxGeometry(1.7, 0.45, 1.7, 5, 2, 5), seed + 1, 0.05);
    base.translate(x, 0.1, z);
    keep(base);
    if (h > 5) {
      const cap = erode(new THREE.BoxGeometry(1.8, 0.5, 1.8, 5, 2, 5), seed + 2, 0.05);
      cap.translate(x, h + 0.1, z);
      keep(cap);
    }
  };
  // a colonnade: two tall columns carrying a lintel, the rest snapped off
  column(-5, 0, 7.4, 1);
  column(-1.6, 0, 7.4, 2);
  column(1.8, 0, 3.4, 3);
  column(5.2, 0, 1.6, 4);
  const lintel = erode(new THREE.BoxGeometry(5.6, 1.1, 1.9, 10, 3, 4), 9, 0.07);
  lintel.translate(-3.3, 8.15, 0);
  keep(lintel);
  // fallen drums and blocks
  for (let i = 0; i < 4; i++) {
    const drum = erode(new THREE.CylinderGeometry(0.6, 0.6, 1.3, 16, 3), 20 + i, 0.06);
    drum.rotateZ(Math.PI / 2);
    drum.rotateY(i * 0.8);
    drum.translate(5 + i * 1.7 + Math.sin(i) * 0.6, 0.5, 2 + i * 0.8);
    keep(drum);
  }
  for (let i = 0; i < 7; i++) {
    const rr = seededRandom(60 + i);
    const b = erode(new THREE.BoxGeometry(1 + rr() * 1.4, 0.7 + rr() * 0.7, 0.9 + rr(), 4, 3, 4), 30 + i, 0.08);
    b.rotateY(rr() * 3);
    b.rotateZ((rr() - 0.5) * 0.5);
    b.translate(-7 + rr() * 16, 0.3, -3.5 + rr() * 7 + (rr() > 0.5 ? 2 : 0));
    keep(b);
  }
  // a broken wall run
  for (let i = 0; i < 6; i++) {
    const hgt = 2.4 - i * 0.28 + (i % 2) * 0.3;
    const w = erode(new THREE.BoxGeometry(1.6, hgt, 0.9, 4, 4, 3), 44 + i, 0.06);
    w.translate(-9 - i * 1.55, hgt / 2 - 0.3, -3.2);
    keep(w);
  }
  const m = mergeGeometries(parts)!;
  m.computeVertexNormals();
  return m;
}


// ---------------------------------------------------------------- buildings
const flat = (g: THREE.BufferGeometry) => {
  const n = g.index ? g.toNonIndexed() : g.clone();
  n.deleteAttribute("uv");
  n.deleteAttribute("normal");
  return n;
};

/** A wall slab with arched openings and a ragged, broken top edge. */
function archWall(w: number, h: number, t: number, arches: number, seed: number, jag = 1) {
  const rand = seededRandom(seed);
  const sh = new THREE.Shape();
  const top = (x: number) => h * (1 - 0.35 * jag * Math.max(0, noise2(x * 0.7 + seed, 3.1)) - (rand() > 0.8 ? 0.12 * jag : 0));
  sh.moveTo(-w / 2, 0);
  sh.lineTo(w / 2, 0);
  const steps = 14;
  for (let i = 0; i <= steps; i++) sh.lineTo(w / 2 - (i / steps) * w, top(w / 2 - (i / steps) * w));
  const cell = w / arches;
  for (let a = 0; a < arches; a++) {
    const cx = -w / 2 + cell * (a + 0.5);
    const ow = cell * 0.42;
    const oh = h * 0.5;
    const hole = new THREE.Path();
    hole.moveTo(cx - ow / 2, 0);
    hole.lineTo(cx - ow / 2, oh);
    hole.absarc(cx, oh, ow / 2, Math.PI, 0, true);
    hole.lineTo(cx + ow / 2, 0);
    hole.lineTo(cx - ow / 2, 0);
    sh.holes.push(hole);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 8 });
  g.translate(0, 0, -t / 2);
  return flat(g);
}

function buildTemple() {
  const parts: THREE.BufferGeometry[] = [];
  const place = (g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => {
    const f = flat(g);
    f.rotateY(ry);
    f.translate(x, y, z);
    parts.push(f);
  };
  // stepped platform
  for (let i = 0; i < 4; i++) place(new THREE.BoxGeometry(22 - i * 2.4, 0.55, 15 - i * 1.8), 0, i * 0.55 + 0.27, 0);
  const top = 2.2;
  // back wall with arched windows, side walls broken lower
  place(archWall(15, 8, 1.1, 4, 5, 1), 0, top, -5.6);
  place(archWall(10, 5.5, 1, 3, 8, 1.6), -7, top, -0.4, Math.PI / 2);
  place(archWall(7, 3.4, 1, 2, 9, 2), 7, top, -2, Math.PI / 2);
  // front colonnade, partly fallen
  for (let i = 0; i < 6; i++) {
    const h = i === 2 ? 2.4 : i === 4 ? 5.2 : 6.6;
    const c = new THREE.CylinderGeometry(0.5, 0.58, h, 14, 5);
    erode(c, 70 + i, 0.05);
    c.translate(0, h / 2, 0);
    place(c, -6.5 + i * 2.6, top, 5);
    place(new THREE.BoxGeometry(1.4, 0.4, 1.4), -6.5 + i * 2.6, top + 0.2, 5);
  }
  place(erode(new THREE.BoxGeometry(5.4, 0.9, 1.5, 6, 2, 3), 3, 0.06), -5.2, top + 6.6 + 0.45, 5);
  // fallen drums
  for (let i = 0; i < 4; i++) {
    const d = erode(new THREE.CylinderGeometry(0.55, 0.55, 1.2, 12, 2), 80 + i, 0.05);
    d.rotateZ(Math.PI / 2);
    place(d, 3 + i * 2, 0.55, 8.5 + (i % 2) * 1.2, i);
  }
  // a toppled statue head's worth of block, and rubble
  for (let i = 0; i < 9; i++) {
    const rr = seededRandom(120 + i);
    const b = erode(new THREE.BoxGeometry(0.8 + rr() * 1.4, 0.6 + rr() * 0.8, 0.8 + rr() * 1.1, 3, 2, 3), 130 + i, 0.07);
    b.rotateZ((rr() - 0.5) * 0.6);
    place(b, -9 + rr() * 18, 0.35, -3 + rr() * 11, rr() * 3);
  }
  const m = mergeGeometries(parts)!;
  m.computeVertexNormals();
  return m;
}

function buildObelisk() {
  const parts: THREE.BufferGeometry[] = [];
  const H = 11;
  const shaft = new THREE.CylinderGeometry(0.55, 0.95, H, 4, 8);
  erode(shaft, 4, 0.05);
  shaft.rotateY(Math.PI / 4);
  shaft.translate(0, H / 2, 0);
  parts.push(flat(shaft));
  const tip = new THREE.ConeGeometry(0.55, 1.1, 4);
  tip.rotateY(Math.PI / 4);
  tip.translate(0, H + 0.55, 0);
  parts.push(flat(tip));
  const base = erode(new THREE.BoxGeometry(2.8, 0.7, 2.8, 4, 1, 4), 6, 0.04);
  base.translate(0, 0.1, 0);
  parts.push(flat(base));
  const m = mergeGeometries(parts)!;
  m.rotateZ(0.08); // leaning
  m.computeVertexNormals();
  return m;
}

/** Abandoned mud-brick houses: boxy walls, doorway, flat roof or collapsed dome. */
function buildMudVillage() {
  const parts: THREE.BufferGeometry[] = [];
  const house = (x: number, z: number, w: number, d: number, h: number, ry: number, dome: boolean, seed: number) => {
    const g: THREE.BufferGeometry[] = [];
    g.push(archWall(w, h, 0.5, 1, seed, 0.8).translate(0, 0, d / 2));
    g.push(archWall(w, h, 0.5, 0, seed + 1, 0.8).translate(0, 0, -d / 2));
    g.push(archWall(d, h, 0.5, 0, seed + 2, 0.8).rotateY(Math.PI / 2).translate(w / 2, 0, 0));
    g.push(archWall(d, h, 0.5, 0, seed + 3, 1.5).rotateY(Math.PI / 2).translate(-w / 2, 0, 0));
    if (dome) {
      const s = new THREE.SphereGeometry(Math.min(w, d) * 0.55, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.42);
      s.translate(0, h - 0.2, 0);
      g.push(flat(s));
    } else {
      g.push(flat(new THREE.BoxGeometry(w * 0.7, 0.3, d, 2, 1, 2).translate(-w * 0.15, h - 0.1, 0)));
    }
    for (const q of g) {
      q.rotateY(ry);
      q.translate(x, 0, z);
      parts.push(q);
    }
  };
  house(0, 0, 7, 6, 3.6, 0.1, true, 11);
  house(10, 3, 5.5, 5, 3.2, -0.4, false, 21);
  house(-9, 4, 6, 5, 3.4, 0.5, true, 31);
  house(3, -10, 6.5, 5.5, 3.0, 0.9, false, 41);
  // courtyard wall
  parts.push(archWall(14, 2.0, 0.5, 0, 51, 1.6).translate(2, 0, 11));
  const m = mergeGeometries(parts)!;
  m.computeVertexNormals();
  return m;
}

// ---------------------------------------------------------------- scrub
function makeScrubTexture() {
  const W = 256;
  const H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const rand = seededRandom(31);
  ctx.lineCap = "round";
  for (let i = 0; i < 90; i++) {
    const x0 = W * (0.12 + 0.76 * rand());
    const lean = (rand() - 0.5) * W * 0.5;
    const hgt = H * (0.45 + 0.5 * rand());
    ctx.strokeStyle = `hsl(${40 + rand() * 18},${28 + rand() * 24}%,${34 + rand() * 30}%)`;
    ctx.lineWidth = 2 + rand() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x0, H);
    ctx.quadraticCurveTo(x0 + lean * 0.25, H - hgt * 0.65, x0 + lean, H - hgt);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function buildTuftGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const q = new THREE.PlaneGeometry(1.5, 1, 1, 2);
    q.translate(0, 0.5, 0);
    q.rotateY((i / 3) * Math.PI);
    parts.push(q);
  }
  return mergeGeometries(parts)!;
}

const Z0 = 1300; // old desert-local z -> world z
const fx = (list: [number, number, number, number?, number?][], sink: number) =>
  fixedGen(list.map(([x, z, r, sc, sk]) => ({ x, z: z + Z0, r, s: sc ?? 1, sink: sk ?? sink })));

export function desertSpecies(): Species[] {
  const out: Species[] = [];
  const barkTex = makeBarkTexture();
  const land = (min = 1.2) => (c: { x: number; z: number; slope: () => number }, maxSlope = 0.35) =>
    oasisT(c.x, c.z) > min && playaMask(c.x, c.z) < 0.05 && c.slope() < maxSlope && oasisHutGap(c.x, c.z) > 3 ? 1 : 0;
  const dry = land();

  // palms around the oasis
  const palmTex = makePalmTexture();
  const frondMat = new THREE.MeshStandardMaterial({ map: palmTex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8, envMapIntensity: 0.5 });
  withSway(frondMat, wind, "palm-fronds", 0.22);
  const frondDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: palmTex, alphaTest: 0.4, side: THREE.DoubleSide });
  const trunkMat = new THREE.MeshStandardMaterial({ color: "#8c6a46", roughness: 1 });
  [0, 1, 2].forEach((v) => {
    const { trunk, fronds } = buildPalm(v + 1, 8 + v * 1.6);
    out.push({
      id: `palm-${v}`,
      solid: { r: 0.4, h: 8 + v * 1.6 },
      parts: [
        { geometry: trunk, material: trunkMat },
        { geometry: fronds, material: frondMat, receive: false, depth: frondDepth },
      ],
      max: 650,
      castMax: 120,
      gen: concatGen(
        cellGen({ seed: 61 + v * 7, n: 4, scale: [0.85, 1.3], biome: "desert", accept: (c) => { const t = oasisT(c.x, c.z); return t >= 1.12 && t <= 1.9 && c.slope() < 0.9 && oasisRockW(c.x, c.z) < 0.3 && oasisHutGap(c.x, c.z) > 3.5 ? 1 : 0; } }),
        cellGen({ seed: 62 + v * 7, n: 0.04, scale: [0.7, 1.1], biome: "desert", accept: (c) => (oasisT(c.x, c.z) > 3 && c.slope() < 0.25 && noise2(c.x * 0.011 + 62, c.z * 0.011) > 0.1 ? 1 : 0) }),
      ),
    });
  });

  // cacti
  const cactusMat = makeCactusMaterial();
  [31, 32, 33].forEach((sd) =>
    out.push({
      id: `saguaro-${sd}`,
      solid: { r: 0.55, h: 6 },
      parts: [{ geometry: buildSaguaro(sd), material: cactusMat, receive: false }],
      max: 500,
      castMax: 90,
      gen: cellGen({ seed: 70 + sd, n: 0.4, scale: [0.8, 1.4], biome: "desert", accept: (c) => (Math.hypot(c.x, c.z) > 30 ? dry(c) : 0) }),
    }),
  );
  out.push({
    id: "barrel",
    parts: [{ geometry: buildBarrel(), material: cactusMat, receive: false }],
    max: 220,
    gen: cellGen({ seed: 81, n: 0.9, scale: [0.7, 1.6], biome: "desert", accept: dry }),
  });
  out.push({
    id: "pear",
    parts: [{ geometry: buildPricklyPear(5), material: cactusMat, receive: false }],
    max: 220,
    gen: cellGen({ seed: 82, n: 0.6, scale: [0.8, 1.5], biome: "desert", accept: dry }),
  });

  // scrub
  const scrubTex = makeScrubTexture();
  const tuft = buildTuftGeometry();
  const dryMat = new THREE.MeshStandardMaterial({ map: scrubTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, color: "#e8d9a8" });
  withSway(dryMat, wind, "scrub-dry", 0.1);
  const greenMat = new THREE.MeshStandardMaterial({ map: scrubTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, color: "#9fd05f" });
  withSway(greenMat, wind, "scrub-green", 0.1);
  const tuftDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: scrubTex, alphaTest: 0.5, side: THREE.DoubleSide });
  out.push({
    id: "scrub-dry",
    parts: [{ geometry: tuft, material: dryMat, receive: false, depth: tuftDepth }],
    max: 200,
    gen: cellGen({ seed: 91, n: 6.5, scale: [0.5, 1.3], biome: "desert", accept: (c) => (dry(c, 0.5) && noise2(c.x * 0.011 + 91, c.z * 0.011) > 0.05 ? 1 : 0) }),
  });
  out.push({
    id: "scrub-green",
    parts: [{ geometry: tuft, material: greenMat, receive: false, depth: tuftDepth }],
    max: 260,
    gen: cellGen({ seed: 92, n: 70, scale: [0.8, 1.7], biome: "desert", accept: (c) => { const t = oasisT(c.x, c.z); return t >= 1.1 && t <= 3.4 && c.slope() < 0.9 && oasisRockW(c.x, c.z) < 0.5 && oasisHutGap(c.x, c.z) > 1.5 ? 1 : 0; } }),
  });

  // dead trees
  const deadMat = new THREE.MeshStandardMaterial({ map: barkTex, color: "#9a8d7c", roughness: 1 });
  const deadStyle = { ...TREE_STYLES[1], cardsPerCluster: 0, droop: 0.15, height: 7 };
  out.push({
    id: "desert-dead",
    parts: [{ geometry: buildTree(deadStyle).bark, material: deadMat, receive: false }],
    max: 450,
    castMax: 80,
    gen: cellGen({ seed: 77, n: 0.12, scale: [0.7, 1.2], biome: "desert", accept: (c) => (dry(c, 0.3) && noise2(c.x * 0.011 + 77, c.z * 0.011) > 0.1 ? 1 : 0) }),
  });

  // rocks
  const rockMat = withSandCap(new THREE.MeshStandardMaterial({ vertexColors: true, color: "#ffc99a", roughness: 0.95 }), "desert-rock", 0.6, 0.5);
  const rock = buildRock();
  out.push({
    id: "desert-rocks",
    solid: { r: 0.85, h: 0.75, minS: 0.9 },
    parts: [{ geometry: rock, material: rockMat }],
    max: 350,
    castMax: 80,
    gen: cellGen({ seed: 9, n: 0.9, scale: [0.5, 2.8], biome: "desert", accept: (c) => (c.slope() < 1 && c.y < 140 ? 1 : 0) }),
  });
  out.push({
    id: "desert-erratics",
    solid: { r: 0.85, h: 0.8 },
    parts: [{ geometry: rock, material: rockMat }],
    max: 800,
    castMax: 120,
    gen: cellGen({ seed: 19, n: 0.1, scale: [4.5, 8], biome: "desert", accept: (c) => dry(c, 0.5) }),
  });

  // hoodoos
  const hoodooMat = withSandCap(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), "hoodoo", 0.5, 1.4);
  [1, 2, 3].forEach((sd) =>
    out.push({
      id: `hoodoo-${sd}`,
      solid: { r: 1.3, h: 9 },
      parts: [{ geometry: buildHoodoo(sd), material: hoodooMat }],
      max: 800,
      castMax: 150,
      gen: cellGen({ seed: 110 + sd, n: 0.035, scale: [0.9, 1.7], biome: "desert", accept: (c) => (Math.hypot(c.x, c.z - Z0) > 120 ? dry(c, 0.4) : 0) }),
    }),
  );

  // landmarks (hand-placed)
  const ruinMat = withSandCap(new THREE.MeshStandardMaterial({ color: "#d6b184", roughness: 1 }), "ruins", 0.7, 1.3);
  out.push({ id: "ruins", parts: [{ geometry: buildRuins(), material: ruinMat }], max: 900, castMax: 200, gen: fx([[62, 78, 0.5, 1.15], [-175, -65, 2.4, 1.15], [185, 150, 4.2, 1.15]], 0.9) });
  const bldMat = withSandCap(new THREE.MeshStandardMaterial({ color: "#d9b88a", roughness: 1 }), "buildings", 0.8, 1.6);
  const mudMat = withSandCap(new THREE.MeshStandardMaterial({ color: "#c79a68", roughness: 1 }), "mud", 0.7, 1.0);
  out.push({ id: "temples", parts: [{ geometry: buildTemple(), material: bldMat }], max: 900, castMax: 200, gen: fx([[-190, 150, 0.6], [210, -190, 3.6, 0.9]], 0.4) });
  out.push({
    id: "obelisks",
    parts: [{ geometry: buildObelisk(), material: bldMat }],
    max: 900,
    castMax: 200,
    gen: fx([[-95, 40, 0], [150, 60, 1], [20, -150, 2], [-210, -140, 0.5], [95, 190, 2.6], [-60, 210, 1.3]], 0.4),
  });
  out.push({ id: "mud-villages", parts: [{ geometry: buildMudVillage(), material: mudMat }], max: 900, castMax: 200, gen: fx([[235, 45, 0.7], [-150, 235, 2.2]], 0.3) });
  const boneMat = withSandCap(new THREE.MeshStandardMaterial({ color: "#e4d8bb", roughness: 0.85 }), "bones-sand", 0.5, 0.7);
  out.push({ id: "desert-bones", parts: [{ geometry: buildSkeleton(8), material: boneMat }], max: 900, castMax: 150, gen: fx([[-30, -40, 1.1, 1.2], [150, -20, 3.3, 1.2]], 0.5) });
  return out;
}
