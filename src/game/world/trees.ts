import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { seededRandom } from "@/game/terrain";

// Procedural trees: a recursive branching skeleton (trunk -> limbs -> twigs)
// with clusters of alpha-cut leaf cards at the twig tips. Client-only (uses canvas).

export type TreeStyle = {
  seed: number;
  height: number; // metres
  trunkR: number;
  branchesPerJoint: [number, number];
  spread: number; // radians from vertical at which limbs leave the trunk
  droop: number; // gravity pull on limbs
  leafSize: [number, number];
  cardsPerCluster: number;
  clusterRadius: number;
  tint: [number, number, number]; // multiplies the leaf texture
};

export const TREE_STYLES: TreeStyle[] = [
  // broad oak
  { seed: 1, height: 9, trunkR: 0.34, branchesPerJoint: [2, 3], spread: 1.0, droop: 0.12, leafSize: [1.5, 2.3], cardsPerCluster: 16, clusterRadius: 1.25, tint: [1, 1, 0.85] },
  // tall, narrower
  { seed: 2, height: 12, trunkR: 0.3, branchesPerJoint: [2, 3], spread: 0.7, droop: 0.02, leafSize: [1.3, 2.0], cardsPerCluster: 14, clusterRadius: 1.05, tint: [0.92, 1, 0.8] },
  // young / bushy
  { seed: 3, height: 6.5, trunkR: 0.2, branchesPerJoint: [3, 4], spread: 0.9, droop: 0.05, leafSize: [1.1, 1.7], cardsPerCluster: 14, clusterRadius: 0.95, tint: [1.05, 1, 0.78] },
  // spreading, slightly yellower
  { seed: 4, height: 10, trunkR: 0.38, branchesPerJoint: [2, 3], spread: 1.15, droop: 0.18, leafSize: [1.6, 2.4], cardsPerCluster: 15, clusterRadius: 1.35, tint: [1.08, 1, 0.7] },
];

const UP = new THREE.Vector3(0, 1, 0);

function tube(base: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, r1: number, seg: number) {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
  g.translate(0, len / 2, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * len * 0.35);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(base, q, new THREE.Vector3(1, 1, 1)));
  return g;
}

function jitter(v: THREE.Vector3, amount: number, rand: () => number) {
  v.x += (rand() - 0.5) * amount;
  v.y += (rand() - 0.5) * amount * 0.5;
  v.z += (rand() - 0.5) * amount;
  return v.normalize();
}

/** Far-LOD version of a style: same branches (the limbs are drawn from the RNG first), ~1/4 of the leaf
 *  cards, each bigger so the crown keeps its silhouette. */
export function lodStyle(style: TreeStyle): TreeStyle {
  return { ...style, cardsPerCluster: Math.max(3, Math.round(style.cardsPerCluster / 4)), leafSize: [style.leafSize[0] * 1.7, style.leafSize[1] * 1.7] };
}

export function buildTree(style: TreeStyle) {
  const rand = seededRandom(style.seed * 7919);
  const tubes: THREE.BufferGeometry[] = [];
  const spots: THREE.Vector3[] = [];

  const limb = (start: THREE.Vector3, dir0: THREE.Vector3, len: number, r: number, depth: number) => {
    const pos = start.clone();
    const dir = dir0.clone();
    const segs = depth === 1 ? 3 : 2;
    let radius = r;
    for (let i = 0; i < segs; i++) {
      const segLen = len / segs;
      const next = radius * 0.62;
      tubes.push(tube(pos, dir, segLen, radius, next, 5));
      pos.addScaledVector(dir, segLen);
      radius = next;
      dir.y -= style.droop * (depth === 1 ? 1 : 0.5);
      jitter(dir, 0.35, rand);
      if (depth === 1 && i > 0) {
        // twigs off the limb
        const twigs = 2;
        for (let t = 0; t < twigs; t++) {
          const d = jitter(dir.clone().add(new THREE.Vector3((rand() - 0.5) * 1.4, 0.15 + rand() * 0.4, (rand() - 0.5) * 1.4)), 0, rand);
          limb(pos, d, len * (0.38 + rand() * 0.15), radius * 0.6, 2);
        }
      }
    }
    spots.push(pos.clone());
    if (depth === 2) spots.push(pos.clone().addScaledVector(dir, -len * 0.35));
  };

  // trunk (leader) with a gentle lean and taper
  const trunkSegs = 6;
  const segLen = (style.height * 0.9) / trunkSegs;
  const pos = new THREE.Vector3(0, -0.3, 0);
  const dir = new THREE.Vector3((rand() - 0.5) * 0.12, 1, (rand() - 0.5) * 0.12).normalize();
  let r = style.trunkR;
  let azimuth = rand() * Math.PI * 2;
  for (let j = 0; j < trunkSegs; j++) {
    const next = r * (j === trunkSegs - 1 ? 0.45 : 0.84);
    const bottomR = j === 0 ? r * 1.35 : r; // root flare
    tubes.push(tube(pos, dir, segLen, bottomR, next, 8));
    pos.addScaledVector(dir, segLen);
    r = next;
    jitter(dir, 0.1, rand);
    dir.y += 0.25;
    dir.normalize();

    if (j >= 2 && j < trunkSegs - 1) {
      const count = Math.round(style.branchesPerJoint[0] + rand() * (style.branchesPerJoint[1] - style.branchesPerJoint[0]));
      for (let b = 0; b < count; b++) {
        azimuth += 2.399963 + (rand() - 0.5) * 0.6; // golden angle
        const polar = style.spread * (0.75 + rand() * 0.5) * (1 - (j - 2) * 0.1);
        const d = new THREE.Vector3(Math.sin(polar) * Math.cos(azimuth), Math.cos(polar) * 0.9 + 0.1, Math.sin(polar) * Math.sin(azimuth)).normalize();
        const len = style.height * (0.5 - (j - 2) * 0.07) * (0.8 + rand() * 0.4);
        limb(pos, d, len, r * 0.7, 1);
      }
    }
  }
  spots.push(pos.clone().addScaledVector(dir, segLen * 0.5));

  // ---- leaf cards ----
  const centre = new THREE.Vector3();
  spots.forEach((s) => centre.add(s));
  centre.divideScalar(spots.length);
  let maxD = 0;
  spots.forEach((s) => (maxD = Math.max(maxD, s.distanceTo(centre))));

  const P: number[] = [];
  const N: number[] = [];
  const UV: number[] = [];
  const C: number[] = [];
  const I: number[] = [];
  const corners = [
    [-0.5, -0.5, 0, 0],
    [0.5, -0.5, 1, 0],
    [0.5, 0.5, 1, 1],
    [-0.5, 0.5, 0, 1],
  ];
  const v = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const n = new THREE.Vector3();

  for (const spot of spots) {
    for (let k = 0; k < style.cardsPerCluster; k++) {
      // random point in a sphere around the twig tip
      const c = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize().multiplyScalar(Math.cbrt(rand()) * style.clusterRadius).add(spot);
      const size = style.leafSize[0] + rand() * (style.leafSize[1] - style.leafSize[0]);
      e.set(rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2);
      q.setFromEuler(e);

      const outward = c.distanceTo(centre) / (maxD + style.clusterRadius);
      const shade = 0.5 + 0.5 * Math.min(1, outward * 1.1); // darker inside the crown
      const jit = 0.88 + rand() * 0.12;
      const col = [style.tint[0] * shade * jit, style.tint[1] * shade * jit, style.tint[2] * shade * jit];

      const base = P.length / 3;
      // Both faces get the same soft "crown" normal so lighting is
      // consistent from either side (no DoubleSide normal flipping).
      for (let side = 0; side < 2; side++) {
        for (const [cx, cy, u, w] of corners) {
          v.set(cx * size, cy * size, 0).applyQuaternion(q).add(c);
          P.push(v.x, v.y, v.z);
          n.copy(v).sub(centre).normalize();
          n.y += 0.35;
          n.normalize();
          N.push(n.x, n.y, n.z);
          UV.push(u, w);
          C.push(col[0], col[1], col[2]);
        }
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3); // front
      I.push(base + 4, base + 6, base + 5, base + 4, base + 7, base + 6); // back (reversed)
    }
  }

  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  leaves.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  leaves.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
  leaves.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  leaves.setIndex(I);

  return { bark: mergeGeometries(tubes)!, leaves };
}

// ---------- textures (procedural, drawn on canvas) ----------

export function makeLeafTexture() {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d")!;
  const rand = seededRandom(5);
  for (let i = 0; i < 170; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 205;
    const x = S / 2 + Math.cos(a) * r;
    const y = S / 2 + Math.sin(a) * r;
    const len = 46 + rand() * 34;
    const wid = len * 0.4;
    const h = 88 + rand() * 28;
    const s = 42 + rand() * 20;
    const l = 24 + rand() * 18;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + (rand() - 0.5) * 1.3);
    const grad = ctx.createLinearGradient(0, -wid, 0, wid);
    grad.addColorStop(0, `hsl(${h},${s}%,${l + 10}%)`);
    grad.addColorStop(1, `hsl(${h},${s}%,${l - 6}%)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.quadraticCurveTo(0, -wid, len / 2, 0);
    ctx.quadraticCurveTo(0, wid, -len / 2, 0);
    ctx.fill();
    ctx.strokeStyle = `hsla(${h},${s}%,${l - 12}%,0.65)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.lineTo(len / 2, 0);
    ctx.stroke();
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function makeBarkTexture() {
  const W = 128;
  const H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const rand = seededRandom(11);
  ctx.fillStyle = "#5a4733";
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 220; i++) {
    const x = rand() * W;
    const w = 1 + rand() * 4;
    const y = rand() * H;
    const len = 30 + rand() * 120;
    const light = rand() > 0.5;
    ctx.fillStyle = light ? `rgba(150,125,95,${0.15 + rand() * 0.25})` : `rgba(20,14,8,${0.25 + rand() * 0.35})`;
    for (const off of [0, -W, W]) ctx.fillRect(x + off, y, w, len); // wrap horizontally
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
