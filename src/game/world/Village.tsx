"use client";

import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { VILLAGE, hash2, heightAt } from "@/game/terrain";
import { pose } from "@/game/store";
import { addCollider } from "./colliders";

// Medieval village (Quaternius CC0, public/models/village): a cobbled square with a well and market,
// ten spoke roads, two rings of houses facing the square, the inn / smithy / stable / mill / sawmill /
// bell tower on the edges, yard clutter, and a fence ring. Everything is instanced.

const DIR = "/models/village/";
const S = 2.8; // pack is tiny (house ≈ 3 m) -> scale up to human size
const FRONT = 0; // set to Math.PI if the doors turn out to face away from the square
const GY = VILLAGE.y;

const KEYS = [
  "House_1", "House_2", "Inn", "Blacksmith", "Stable", "Mill", "Sawmill", "Bell_Tower",
  "Well", "Bonfire_Lit", "MarketStand_1", "MarketStand_2", "Bench_1", "Bench_2", "Cauldron", "Gazebo",
  "Fence", "Path_Straight", "Path_Square", "Barrel", "Crate", "Hay", "Cart", "Package_1", "Package_2", "Bags", "Rock_1", "Rock_2", "Rock_3",
] as const;
type Key = (typeof KEYS)[number];

type Part = { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] };
type Model = { parts: Part[]; cx: number; cz: number; sx: number; sz: number };
type Inst = { k: Key; x: number; z: number; y?: number; ry: number; s: number; sx?: number };

const stdCache = new Map<string, THREE.Material>();
function std(m: THREE.Material): THREE.Material {
  const src = m as THREE.MeshPhongMaterial;
  const id = src.name + src.color.getHexString();
  let r = stdCache.get(id);
  if (!r) {
    const win = /window/i.test(src.name);
    r = new THREE.MeshStandardMaterial({
      color: src.color.clone().convertLinearToSRGB(), // pack colours are authored as display values
      roughness: win ? 0.3 : 0.88,
      metalness: 0,
      emissive: win ? new THREE.Color("#ffb347") : new THREE.Color(0),
      emissiveIntensity: win ? 0.35 : 0,
    });
    stdCache.set(id, r);
  }
  return r;
}

async function loadAll() {
  const out: Record<string, Model> = {};
  await Promise.all(
    KEYS.map(async (k) => {
      const mats = await new MTLLoader().setPath(DIR).loadAsync(k + ".mtl");
      mats.preload();
      const obj = await new OBJLoader().setMaterials(mats).setPath(DIR).loadAsync(k + ".obj");
      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      const parts: Part[] = [];
      obj.traverse((o) => {
        const me = o as THREE.Mesh;
        if (!me.isMesh) return;
        const geo = me.geometry.clone();
        geo.applyMatrix4(me.matrixWorld);
        parts.push({ geo, mat: Array.isArray(me.material) ? me.material.map(std) : std(me.material) });
      });
      out[k] = { parts, cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2, sx: box.max.x - box.min.x, sz: box.max.z - box.min.z };
    }),
  );
  return out;
}

const polar = (r: number, deg: number): [number, number] => [VILLAGE.x + Math.cos((deg * Math.PI) / 180) * r, VILLAGE.z + Math.sin((deg * Math.PI) / 180) * r];
const faceCentre = (x: number, z: number) => Math.atan2(VILLAGE.x - x, VILLAGE.z - z) + FRONT;

function layout() {
  const out: Inst[] = [];
  // every piece sits on the real ground (the village is flattened, the outskirts are not)
  const put = (k: Key, x: number, z: number, ry: number, s = S, dy = 0) => out.push({ k, x, z, ry, s, y: heightAt(x, z) + dy });

  // special buildings (angles sit midway between spokes)
  const specials: [Key, number, number][] = [
    ["Inn", 44, 90], ["Bell_Tower", 32, 270], ["Blacksmith", 60, 18], ["Stable", 64, 162], ["Mill", 104, 234], ["Sawmill", 62, 306],
  ];
  const sp: [number, number][] = [];
  for (const [k, r, a] of specials) {
    const [x, z] = polar(r, a);
    put(k, x, z, faceCentre(x, z), S * (k === "Inn" ? 1.15 : 1));
    sp.push([x, z]);
  }

  // houses in two rings
  // House_3 / House_4 in the pack are roofless shells (under construction), so only the finished ones
  const houses: Key[] = ["House_1", "House_2"];
  const ring = (r: number, n: number, off: number, tag: number) => {
    for (let i = 0; i < n; i++) {
      const [x, z] = polar(r, off + (i * 360) / n);
      if (sp.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 21)) continue;
      const h = hash2(i, tag, 41);
      if (h < 0.04) continue; // a gap now and then
      const k = houses[Math.floor(hash2(i, tag, 42) * 2)];
      const jitter = (hash2(i, tag, 43) - 0.5) * 0.25;
      put(k, x, z, faceCentre(x, z) + jitter, S * (0.92 + hash2(i, tag, 44) * 0.2));
      // yard clutter beside the house
      const side = hash2(i, tag, 45) < 0.5 ? 1 : -1;
      const tx = -Math.sin(faceCentre(x, z) - FRONT), tz = Math.cos(faceCentre(x, z) - FRONT);
      const yard: Key[] = ["Barrel", "Crate", "Hay", "Package_1", "Package_2", "Bags", "Cart"];
      for (let q = 0; q < 2; q++) {
        const yk = yard[Math.floor(hash2(i, tag, 50 + q) * yard.length)];
        const along = side * (5.2 + q * 1.6), back = 1 + q * 1.5;
        const px = x + tx * along + (VILLAGE.x - x) * 0.02 * back, pz = z + tz * along + (VILLAGE.z - z) * 0.02 * back;
        put(yk, px, pz, hash2(i, q, 60) * 6.28, S * (yk === "Cart" ? 1 : 1.1));
      }
    }
  };
  ring(52, 10, 18, 1);
  ring(76, 18, 0, 2);
  ring(100, 24, 7.5, 3);

  // square: cobbles, well, fires, market, benches
  for (let i = -6; i <= 6; i++)
    for (let j = -6; j <= 6; j++) {
      const x = VILLAGE.x + i * 2, z = VILLAGE.z + j * 2;
      if (Math.hypot(i, j) < 6.4) put("Path_Square", x, z, 0, 4, 0.04);
    }
  put("Well", VILLAGE.x, VILLAGE.z, 0, S * 1.2);
  for (let a = 0; a < 4; a++) {
    const [x, z] = polar(8.5, a * 90 + 45);
    put("Bonfire_Lit", x, z, 0, S * 1.3);
    const [bx, bz] = polar(6, a * 90);
    put(a % 2 ? "Bench_1" : "Bench_2", bx, bz, faceCentre(bx, bz) + Math.PI / 2, S * 1.1);
  }
  put("Cauldron", ...polar(4.5, 200), 0, S * 1.2);
  for (let a = 0; a < 6; a++) {
    const [x, z] = polar(15, a * 60 + 30);
    put(a % 2 ? "MarketStand_1" : "MarketStand_2", x, z, faceCentre(x, z) + Math.PI, S * 1.2);
  }
  put("Gazebo", ...polar(28, 54), 0, S * 1.2);
  put("Gazebo", ...polar(28, 126), 0, S * 1.2);

  // spoke roads
  for (let k = 0; k < 10; k++) {
    const a = (k * 36 * Math.PI) / 180;
    const ry = Math.atan2(Math.cos(a), Math.sin(a));
    for (let d = 14; d < 118; d += 3) put("Path_Straight", VILLAGE.x + Math.cos(a) * d, VILLAGE.z + Math.sin(a) * d, ry, 3, 0.03);
  }
  // fence ring with gates at the spokes
  const fr = 116, step = 2.2 / fr;
  for (let a = 0; a < Math.PI * 2; a += step) {
    const m = (((a * 180) / Math.PI) % 36 + 36) % 36;
    if (m < 4.8 || m > 31.2) continue;
    put("Fence", VILLAGE.x + Math.cos(a) * fr, VILLAGE.z + Math.sin(a) * fr, Math.atan2(-Math.cos(a), -Math.sin(a)), S);
  }
  // boulders outside the fence
  for (let i = 0; i < 28; i++) {
    const a = hash2(i, 7, 70) * 6.28, r = 121 + hash2(i, 8, 70) * 10;
    put((["Rock_1", "Rock_2", "Rock_3"] as Key[])[i % 3], VILLAGE.x + Math.cos(a) * r, VILLAGE.z + Math.sin(a) * r, a * 3, 6 + hash2(i, 9, 70) * 6, -0.2);
  }
  return out;
}

const SOLID: Partial<Record<Key, [number, number]>> = {
  House_1: [0.9, 5], House_2: [0.9, 5], Inn: [0.9, 6], Blacksmith: [0.9, 5], Stable: [0.85, 4],
  Mill: [0.9, 8], Sawmill: [0.85, 5], Bell_Tower: [0.85, 14], Well: [0.8, 2], MarketStand_1: [0.7, 3], MarketStand_2: [0.7, 3], Gazebo: [0.7, 4],
};

export function Village() {
  const ref = useRef<THREE.Group>(null);
  const [built, setBuilt] = useState<{ group: THREE.Group; solids: [number, number, number][] } | null>(null);

  useEffect(() => {
    let dead = false;
    loadAll().then((models) => {
      if (dead) return;
      const insts = layout();
      const by = new Map<Key, Inst[]>();
      for (const it of insts) (by.get(it.k) ?? by.set(it.k, []).get(it.k)!).push(it);
      const group = new THREE.Group();
      const o = new THREE.Object3D();
      const solids: [number, number, number][] = [];
      for (const [k, list] of by) {
        const mdl = models[k];
        for (const p of mdl.parts) {
          const im = new THREE.InstancedMesh(p.geo, p.mat, list.length);
          list.forEach((it, i) => {
            o.position.set(it.x, it.y ?? GY, it.z);
            o.rotation.set(0, it.ry, 0);
            o.scale.setScalar(it.s);
            o.updateMatrix();
            im.setMatrixAt(i, o.matrix);
          });
          im.frustumCulled = false;
          im.castShadow = true;
          im.receiveShadow = true;
          group.add(im);
        }
        const sol = SOLID[k];
        if (sol)
          for (const it of list) {
            const c = Math.cos(it.ry), s = Math.sin(it.ry);
            const ox = (mdl.cx * c + mdl.cz * s) * it.s, oz = (-mdl.cx * s + mdl.cz * c) * it.s;
            solids.push([it.x + ox, it.z + oz, (Math.max(mdl.sx, mdl.sz) / 2) * it.s * sol[0] * (k === "Stable" || k === "Sawmill" ? 0.8 : 1)]);
          }
      }
      setBuilt({ group, solids });
    });
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    if (!built) return;
    for (const [x, z, r] of built.solids) addCollider(x, z, r, -5, GY + 8);
  }, [built]);

  useFrame(() => {
    if (ref.current) ref.current.visible = Math.hypot(pose.x - VILLAGE.x, pose.z - VILLAGE.z) < 800;
  });

  return (
    <group ref={ref}>
      {built && <primitive object={built.group} />}
      {/* warm light at the square fires */}
      <pointLight position={[VILLAGE.x, GY + 3, VILLAGE.z]} color="#ff9a3c" intensity={40} distance={45} decay={1.8} />
    </group>
  );
}
