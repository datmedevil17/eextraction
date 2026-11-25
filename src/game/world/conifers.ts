import * as THREE from "three";
import { seededRandom } from "@/game/terrain";

// Procedural conifers for the ice map: a tapered trunk plus tiers of drooping
// branch cards (alpha-cut fir-spray texture). Every card carries a snow amount
// that the material turns into snow lying on its upward face.

export type ConiferStyle = {
  seed: number;
  height: number;
  trunkR: number;
  crownR: number; // widest tier radius
  tiers: number;
  droop: number; // branch droop (0 stiff .. 1 weeping)
  snow: number; // 0..1 how snow-laden
};

export const CONIFER_STYLES: ConiferStyle[] = [
  { seed: 11, height: 13, trunkR: 0.3, crownR: 3.3, tiers: 11, droop: 0.55, snow: 0.8 },
  { seed: 12, height: 18, trunkR: 0.36, crownR: 3.7, tiers: 14, droop: 0.5, snow: 0.7 },
  { seed: 13, height: 8, trunkR: 0.2, crownR: 2.4, tiers: 8, droop: 0.6, snow: 0.9 },
  { seed: 14, height: 15, trunkR: 0.32, crownR: 2.7, tiers: 13, droop: 0.4, snow: 0.55 }, // narrow spruce
];

export function buildConifer(st: ConiferStyle) {
  const rand = seededRandom(st.seed * 104729);
  const P: number[] = [];
  const N: number[] = [];
  const UV: number[] = [];
  const C: number[] = [];
  const S: number[] = [];
  const I: number[] = [];

  const y0 = st.height * 0.16;
  const yTop = st.height * 0.97;
  const nrm = new THREE.Vector3();
  const addCard = (angle: number, y: number, r0: number, L: number, W: number, snow: number, shade: number) => {
    const ox = Math.cos(angle);
    const oz = Math.sin(angle);
    const sx = -oz;
    const sz = ox;
    const rows = [0, 0.5, 1];
    const widths = [W * 0.45, W, W * 0.5];
    const base = P.length / 3;
    for (let k = 0; k < 3; k++) {
      const t = rows[k];
      const along = r0 + L * t;
      const yy = y + L * (0.1 * t - st.droop * 0.55 * t * t);
      for (const side of [-1, 1]) {
        const w = (widths[k] / 2) * side;
        const lift = Math.abs(w) * 0.18; // slightly cupped
        P.push(ox * along + sx * w, yy + lift, oz * along + sz * w);
        nrm.set(ox * 0.35, 0.9, oz * 0.35).normalize();
        N.push(nrm.x, nrm.y, nrm.z);
        UV.push(side < 0 ? 0 : 1, t);
        const tipDark = 1 - 0.25 * t;
        C.push(shade * tipDark, shade * tipDark, shade * tipDark);
        S.push(snow);
      }
    }
    for (let k = 0; k < 2; k++) {
      const a = base + k * 2;
      I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };

  for (let i = 0; i < st.tiers; i++) {
    const t = i / (st.tiers - 1);
    const y = y0 + (yTop - y0) * Math.pow(t, 0.92);
    const R = st.crownR * Math.pow(1 - t, 0.85) + 0.25;
    const layers = t < 0.85 ? 2 : 1;
    for (let layer = 0; layer < layers; layer++) {
      const L = R * (layer === 0 ? 1.0 : 0.78) * (0.92 + rand() * 0.2);
      const W = Math.max(0.5, L * 0.78);
      const count = Math.max(5, Math.ceil((Math.PI * 2 * L * 0.8) / (W * 0.8)));
      const offset = rand() * Math.PI * 2 + layer * (Math.PI / count);
      for (let b = 0; b < count; b++) {
        const a = offset + (b / count) * Math.PI * 2 + (rand() - 0.5) * 0.25;
        const snow = Math.min(1, st.snow * (0.55 + 0.35 * rand() + 0.25 * t));
        const shade = (0.62 + rand() * 0.38) * (0.7 + 0.3 * Math.min(1, t * 1.5 + layer * 0.2));
        addCard(a, y - layer * 0.25 + (rand() - 0.5) * 0.15, 0.12, L, W, snow, shade);
      }
    }
  }
  // leader
  for (let b = 0; b < 4; b++) addCard((b / 4) * Math.PI * 2, yTop - 0.4, 0.05, 0.9, 0.5, st.snow, 0.9);

  const foliage = new THREE.BufferGeometry();
  foliage.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  foliage.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  foliage.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
  foliage.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  foliage.setAttribute("aSnow", new THREE.Float32BufferAttribute(S, 1));
  foliage.setIndex(I);

  const trunk = new THREE.CylinderGeometry(0.04, st.trunkR, st.height * 0.98, 9, 4, true);
  trunk.translate(0, st.height * 0.49 - 0.2, 0);
  const uv = trunk.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * st.height * 0.3);
  return { trunk, foliage };
}

/** A fir spray: central stem with paired needles, drawn on canvas (alpha-cut). */
export function makeFirTexture() {
  const W = 256;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const rand = seededRandom(77);
  ctx.lineCap = "round";
  // canvas y grows downward; v = 0 (trunk end) is the bottom
  const stemX = W / 2;
  ctx.strokeStyle = "#3b2d22";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(stemX, H);
  ctx.lineTo(stemX, 6);
  ctx.stroke();
  const pairs = 150;
  for (let i = 0; i < pairs; i++) {
    const s = i / pairs; // 0 trunk .. 1 tip
    const y = H - 8 - s * (H - 24);
    const env = Math.sin(Math.PI * (0.06 + 0.9 * s)) * 0.5 + 0.08; // half-width envelope
    const len = (W / 2) * env * (1.7 - 0.5 * s) * (0.85 + rand() * 0.3);
    for (const side of [-1, 1]) {
      const sweep = 0.55 + rand() * 0.25; // needles sweep towards the tip
      const x1 = stemX + side * len * Math.cos(sweep) * 1.35;
      const y1 = y - len * Math.sin(sweep) * 0.9;
      const h = 132 + rand() * 18;
      const l = 14 + rand() * 12 + s * 8;
      ctx.strokeStyle = `hsl(${h},${34 + rand() * 14}%,${l}%)`;
      ctx.lineWidth = 3.2 - s * 1.2;
      ctx.beginPath();
      ctx.moveTo(stemX, y);
      ctx.quadraticCurveTo(stemX + side * len * 0.55, y - 4, x1, y1);
      ctx.stroke();
      // lighter tip of the new growth
      if (rand() > 0.55) {
        ctx.strokeStyle = `hsl(${h + 6},${40 + rand() * 12}%,${l + 14}%)`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x1 - side * 6, y1 + 3);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Tapered tube along a curve, radius shrinking from r0 to r1 (tusks, ribs). */
export function taperedTube(curve: THREE.Curve<THREE.Vector3>, segments: number, r0: number, r1: number, radial = 8) {
  const pos: number[] = [];
  const idx: number[] = [];
  const frames = curve.computeFrenetFrames(segments, false);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    const r = r0 + (r1 - r0) * Math.pow(t, 0.8);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const nx = frames.normals[i];
      const bx = frames.binormals[i];
      pos.push(
        p.x + (nx.x * Math.cos(a) + bx.x * Math.sin(a)) * r,
        p.y + (nx.y * Math.cos(a) + bx.y * Math.sin(a)) * r,
        p.z + (nx.z * Math.cos(a) + bx.z * Math.sin(a)) * r,
      );
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      idx.push(a, b, a + radial, b, b + radial, a + radial);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
