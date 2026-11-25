"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { OASIS_HUTS, heightAt } from "@/game/terrain";
import { addCollider } from "./colliders";

// The assassins' huts on the oasis bank: round mud-plaster walls, a doorway facing the pond, a two-tier
// palm-thatch roof. You can walk in (the wall is a ring of small colliders with the doorway left open).

const WALL_H = 2.35; // above the highest ground under the wall
const DOOR_W = 1.05, DOOR_H = 1.9;
const THICK = 0.24;

function rand(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, r: () => number) => void, seed: number, rep: [number, number]) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  draw(g, rand(seed));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...rep);
  t.anisotropy = 4;
  return t;
}

/** Hand-smoothed mud plaster: blotchy tone, smears, a few hairline cracks, darker splash near the foot. */
const mudTex = () => canvasTex(256, 256, (g, r) => {
  g.fillStyle = "#a9805a"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    const l = 0.82 + r() * 0.3;
    g.fillStyle = `rgba(${(169 * l) | 0},${(128 * l) | 0},${(90 * l) | 0},${0.12 + r() * 0.2})`;
    g.beginPath(); g.ellipse(r() * 256, r() * 256, 3 + r() * 14, 2 + r() * 6, r() * 3, 0, 7); g.fill();
  }
  g.strokeStyle = "rgba(60,38,22,0.35)"; g.lineWidth = 0.8;
  for (let i = 0; i < 14; i++) {
    let x = r() * 256, y = r() * 256;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += (r() - 0.5) * 18; y += 4 + r() * 10; g.lineTo(x, y); }
    g.stroke();
  }
  const gr = g.createLinearGradient(0, 200, 0, 256);
  gr.addColorStop(0, "rgba(70,45,25,0)"); gr.addColorStop(1, "rgba(70,45,25,0.45)");
  g.fillStyle = gr; g.fillRect(0, 200, 256, 56);
}, 11, [5, 1]);

/** Dry palm thatch: strands running apex to eave, darker lashing bands between tiers. */
const thatchTex = () => canvasTex(256, 256, (g, r) => {
  g.fillStyle = "#7d6036"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const x = r() * 256, y = r() * 256, l = 0.7 + r() * 0.6;
    g.strokeStyle = `rgba(${(176 * l) | 0},${(140 * l) | 0},${(82 * l) | 0},${0.35 + r() * 0.5})`;
    g.lineWidth = 0.6 + r() * 1.4;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 5, y + 18 + r() * 40); g.stroke();
  }
  for (const y of [64, 128, 192]) { g.fillStyle = "rgba(40,26,12,0.35)"; g.fillRect(0, y + (r() - 0.5) * 6, 256, 3); }
}, 23, [7, 1]);

/** Striped kilim rug. */
const rugTex = (seed: number) => canvasTex(128, 256, (g, r) => {
  const cols = ["#7a1f18", "#c48a2c", "#24140e", "#a8461f", "#e0c48c"];
  let y = 0;
  while (y < 256) {
    const h = 6 + ((r() * 22) | 0), c = cols[(r() * cols.length) | 0];
    g.fillStyle = c; g.fillRect(0, y, 128, h);
    if (h > 14) { g.fillStyle = cols[(r() * cols.length) | 0]; for (let x = 8; x < 128; x += 20) { g.beginPath(); g.moveTo(x, y + h / 2); g.lineTo(x + 6, y + 2); g.lineTo(x + 12, y + h / 2); g.lineTo(x + 6, y + h - 2); g.fill(); } }
    y += h;
  }
  g.fillStyle = "rgba(0,0,0,0.12)"; for (let i = 0; i < 300; i++) g.fillRect(r() * 128, r() * 256, 1, 2);
}, seed, [1, 1]);

/** A cone, open at the base, sitting on y=0, its rim pushed in and out like loose thatch. */
function thatchCone(radius: number, height: number, seed: number) {
  const g = new THREE.ConeGeometry(radius, height, 36, 5, true);
  g.translate(0, height / 2, 0);
  const p = g.attributes.position as THREE.BufferAttribute;
  const r = rand(seed);
  const jit = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = `${Math.round(Math.atan2(z, x) * 100)}:${Math.round(y * 100)}`; // keep the seam welded
    let j = jit.get(k);
    if (j === undefined) { j = (r() - 0.5) * 0.12; jit.set(k, j); }
    const f = 1 + j * (1 - y / height);
    p.setXYZ(i, x * f, y - (y < 0.02 ? r() * 0.12 : 0), z * f);
  }
  g.computeVertexNormals();
  return g;
}

/** Turned clay pot. */
function potGeo(h: number, w: number) {
  const pts = [[0, 0], [w * 0.55, 0], [w * 0.95, h * 0.3], [w, h * 0.5], [w * 0.75, h * 0.82], [w * 0.42, h * 0.9], [w * 0.5, h], [w * 0.44, h]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 18);
}

type Hut = (typeof OASIS_HUTS)[number];
/** Local frame of a hut: local -> world, ground under a local point, wall foot/top heights, door half-angle. */
function frame(h: Hut) {
  const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  const world = (lx: number, lz: number): [number, number] => [h.x + lx * c + lz * s, h.z - lx * s + lz * c];
  const ground = (lx: number, lz: number) => heightAt(...world(lx, lz));
  // the wall runs from below the lowest ground under it to a level top
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, y = ground(Math.sin(a) * h.r, Math.cos(a) * h.r);
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  return { world, ground, y0: lo - 0.4, top: hi + WALL_H, half: DOOR_W / 2 / h.r };
}

let collidersDone = false;
/** A ring of posts round each wall, the doorway left open, so you can walk in. */
function addHutColliders() {
  if (collidersDone) return;
  collidersDone = true;
  for (const h of OASIS_HUTS) {
    const { world, y0, top, half } = frame(h);
    const pr = 0.4, rc = h.r - THICK / 2;
    const a0 = half + pr / rc + 0.02;
    const n = Math.ceil(((Math.PI * 2 - 2 * a0) * rc) / 0.55);
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((Math.PI * 2 - 2 * a0) * i) / n;
      const [x, z] = world(Math.sin(a) * rc, Math.cos(a) * rc);
      addCollider(x, z, pr, y0 - 1, top + 2.5);
    }
  }
}

export function OasisHuts() {
  useEffect(addHutColliders, []);
  const group = useMemo(() => {
    const root = new THREE.Group();
    const mud = new THREE.MeshStandardMaterial({ map: mudTex(), roughness: 0.96, metalness: 0, side: THREE.DoubleSide });
    const mudDark = new THREE.MeshStandardMaterial({ color: "#7c5a3c", roughness: 1 });
    const thatch = new THREE.MeshStandardMaterial({ map: thatchTex(), roughness: 1, side: THREE.DoubleSide });
    const wood = new THREE.MeshStandardMaterial({ color: "#5a3e26", roughness: 0.9 });
    const clay = new THREE.MeshStandardMaterial({ color: "#a5552f", roughness: 0.85 });
    const cloth = new THREE.MeshStandardMaterial({ color: "#5e1814", roughness: 0.95, side: THREE.DoubleSide });
    const bed = new THREE.MeshStandardMaterial({ color: "#8f7a5a", roughness: 1 });
    const glow = new THREE.MeshStandardMaterial({ color: "#3a2410", emissive: "#ffae4a", emissiveIntensity: 2.2 });

    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = cast; m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    OASIS_HUTS.forEach((h, n) => {
      const hut = new THREE.Group();
      hut.position.set(h.x, 0, h.z);
      hut.rotation.y = h.yaw;
      root.add(hut);
      const { ground, y0, top, half } = frame(h);
      const wh = top - y0;
      const doorY = ground(0, h.r);
      const lintel = doorY + DOOR_H;

      // wall shell (outer, inner), the doorway left open
      const shell = (r: number, rt: number, t0: number, tl: number, hh: number, yb: number) =>
        add(hut, new THREE.CylinderGeometry(rt, r, hh, 48, 3, true, t0, tl).translate(0, hh / 2, 0), mud, 0, yb);
      shell(h.r, h.r - 0.06, half, Math.PI * 2 - 2 * half, wh, y0);
      shell(h.r - THICK, h.r - THICK - 0.06, half, Math.PI * 2 - 2 * half, wh, y0).castShadow = false;
      // over the door
      shell(h.r, h.r - 0.06, -half, 2 * half, top - lintel, lintel);
      shell(h.r - THICK, h.r - THICK - 0.06, -half, 2 * half, top - lintel, lintel).castShadow = false;
      // wall top cap
      const cap = new THREE.RingGeometry(h.r - THICK - 0.06, h.r - 0.04, 48, 1).rotateX(-Math.PI / 2);
      add(hut, cap, mudDark, 0, top, 0, false);
      // door jambs and underside of the opening
      for (const sd of [-1, 1]) {
        const jamb = add(hut, new THREE.BoxGeometry(0.08, lintel - y0, THICK), mudDark, sd * (DOOR_W / 2 + 0.02), y0 + (lintel - y0) / 2, h.r - THICK / 2 - 0.03);
        jamb.castShadow = false;
      }
      add(hut, new THREE.BoxGeometry(DOOR_W + 0.06, 0.06, THICK), mudDark, 0, lintel, h.r - THICK / 2 - 0.03, false);
      // palm-trunk lintel beam poking out either side
      const beam = add(hut, new THREE.CylinderGeometry(0.07, 0.08, DOOR_W + 0.7, 8).rotateZ(Math.PI / 2), wood, 0, lintel + 0.1, h.r + 0.02);
      beam.castShadow = true;

      // roof: two thatch tiers and a lashed knot on top
      const rr = h.r + 0.75;
      add(hut, thatchCone(rr, 1.75, 31 + n), thatch, 0, top - 0.25);
      add(hut, thatchCone(rr * 0.62, 1.55, 47 + n), thatch, 0, top + 0.75);
      add(hut, new THREE.ConeGeometry(0.16, 0.5, 8).translate(0, 0.25, 0), wood, 0, top + 2.1);

      // door curtain, tied back to one side
      const curtain = new THREE.PlaneGeometry(0.42, DOOR_H - 0.1, 2, 6);
      const cp = curtain.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < cp.count; i++) { const y = cp.getY(i); cp.setX(i, cp.getX(i) * (0.45 + 0.55 * Math.abs(y / (DOOR_H / 2)))); cp.setZ(i, Math.sin(y * 3) * 0.03); }
      curtain.computeVertexNormals();
      add(hut, curtain, cloth, -DOOR_W / 2 + 0.24, doorY + DOOR_H / 2 + 0.02, h.r - THICK - 0.05, false);

      // lantern hanging by the door
      add(hut, new THREE.BoxGeometry(0.16, 0.22, 0.16), glow, DOOR_W / 2 + 0.45, lintel - 0.25, h.r + 0.18, false);
      add(hut, new THREE.CylinderGeometry(0.008, 0.008, 0.25, 4), wood, DOOR_W / 2 + 0.45, lintel - 0.02, h.r + 0.18, false);

      // rug at the doorstep
      const rug = add(hut, new THREE.PlaneGeometry(1.4, 2.2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: rugTex(5 + n), roughness: 1 }), 0, 0, h.r + 1.35, false);
      rug.position.y = ground(0, h.r + 1.35) + 0.04;

      // water pots by the wall
      const pr = rand(70 + n);
      for (let i = 0; i < 3 + n; i++) {
        const a = 0.55 + i * 0.28 + pr() * 0.1, rr2 = h.r + 0.35;
        const lx = Math.sin(a) * rr2, lz = Math.cos(a) * rr2;
        const pot = add(hut, potGeo(0.5 + pr() * 0.35, 0.2 + pr() * 0.1), clay, lx, ground(lx, lz) - 0.03, lz);
        pot.rotation.z = (pr() - 0.5) * 0.12;
      }

      // inside: a bedroll and a low chest
      const fy = ground(0, 0);
      const roll = add(hut, new THREE.CapsuleGeometry(0.28, 1.4, 4, 10).rotateZ(Math.PI / 2), bed, -0.3, fy + 0.2, -h.r * 0.45, false);
      roll.rotation.y = 0.15;
      add(hut, new THREE.BoxGeometry(0.8, 0.45, 0.5), wood, h.r * 0.5, fy + 0.22, -h.r * 0.2, false).rotation.y = -0.9;
      add(hut, new THREE.CircleGeometry(h.r - THICK, 32).rotateX(-Math.PI / 2), mudDark, 0, fy + 0.03, 0, false);

    });
    return root;
  }, []);

  return <primitive object={group} />;
}
