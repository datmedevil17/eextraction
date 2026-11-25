"use client";

import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { jungleT, noise2, riverCenterZ, riverHalfWidth, riverT } from "@/game/terrain";
import { TREE_STYLES, buildTree, lodStyle, makeBarkTexture, makeLeafTexture } from "./trees";
import { CELL, cellGen, concatGen, wind, type Placement, type Species } from "./propsStream";

// Procedural props: scattered trees and boulders. No external assets, so the
// scene loads instantly and offline.

function paint(geo: THREE.BufferGeometry, fn: (y: number, x: number, z: number) => THREE.Color) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = fn(pos.getY(i), pos.getX(i), pos.getZ(i));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

export function buildRock() {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 3);
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  geo = mergeVertices(geo, 1e-4); // shared vertices -> smooth normals instead of faceted
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + noise2(x * 1.6 + 3, y * 1.6 + z * 1.6) * 0.38 + noise2(x * 4, z * 4 + y * 4) * 0.08;
    p.setXYZ(i, x * k, Math.max(y * k * 0.7, -0.25), z * k * 1.15);
  }
  geo.computeVertexNormals();
  paint(geo, (y, x, z) => {
    const s = noise2(x * 4, z * 4 + y * 4) * 0.5 + 0.5;
    return new THREE.Color("#4d4a45").lerp(new THREE.Color("#8d8678"), s);
  });
  return geo;
}

export function meadowSpecies(): Species[] {
  const out: Species[] = [];
  const leafTex = makeLeafTexture();
  const barkMat = new THREE.MeshStandardMaterial({ map: makeBarkTexture(), roughness: 1, metalness: 0 });
  const leafMat = new THREE.MeshStandardMaterial({
    map: leafTex,
    vertexColors: true,
    alphaTest: 0.4,
    roughness: 0.85,
    metalness: 0,
    envMapIntensity: 0.9,
  });
  // leaves sway: displacement grows with height, phase varies per tree
  leafMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 iPos = instanceMatrix[3].xyz;
        #else
          vec3 iPos = vec3(0.0);
        #endif
        float hgt = clamp(transformed.y / 9.0, 0.0, 1.0);
        float ph = uTime * 1.5 + iPos.x * 0.21 + iPos.z * 0.27;
        transformed.x += (sin(ph + transformed.y * 0.5) * 0.6 + sin(uTime * 3.3 + transformed.x * 5.0) * 0.18) * 0.16 * hgt;
        transformed.z += (cos(ph * 0.8 + transformed.x * 0.4) * 0.5 + sin(uTime * 2.7 + transformed.z * 5.0) * 0.15) * 0.12 * hgt;`,
      );
  };
  leafMat.customProgramCacheKey = () => "tree-leaves-sway";
  // shadows need the same cut-out so cards don't cast solid squares
  const leafDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.4 });

  TREE_STYLES.forEach((style, v) => {
    const { bark, leaves } = buildTree(style);
    const lod = buildTree(lodStyle(style));
    const gen = cellGen({
        seed: 300 + v,
        n: 0.22,
        scale: [0.8, 1.3],
        pow: 1,
        biome: "meadow",
        accept: (c) => (riverT(c.x, c.z) > 2.8 && Math.hypot(c.x, c.z) >= 60 && noise2(c.x * 0.01 + 3, c.z * 0.01) > -0.15 ? 1 : 0),
      });
    out.push({
      id: `meadow-tree-${v}`,
      parts: [
        { geometry: bark, material: barkMat },
        { geometry: leaves, material: leafMat, receive: false, depth: leafDepth },
      ],
      max: 170,
      castMax: 120,
      gen,
      solid: { r: style.trunkR + 0.12, h: style.height, crown: 3 },
    });
    out.push({ id: `meadow-tree-${v}-lod`, parts: [{ geometry: lod.bark, material: barkMat }, { geometry: lod.leaves, material: leafMat, receive: false }], min: 170, max: 650, gen });
  });

  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  const rock = buildRock();
  out.push({
    id: "meadow-rocks",
    parts: [{ geometry: rock, material: rockMat }],
    solid: { r: 0.85, h: 0.75, minS: 0.9 },
    max: 350,
    castMax: 80,
    // the forest keeps only trees + grass
    gen: noForest(concatGen(
      cellGen({
        seed: 409,
        n: 0.6,
        scale: [0.5, 2.4],
        biome: "meadow",
        accept: (c) => (riverT(c.x, c.z) > 2.8 && Math.hypot(c.x, c.z) >= 14 && noise2(c.x * 0.01 + 9, c.z * 0.01) > -0.15 ? 1 : 0),
      }),
      // boulders lining the river banks
      cellGen({
        seed: 421,
        n: 8,
        scale: [0.25, 1.6],
        pow: 2,
        biome: "meadow",
        pos: (rand, x0) => {
          const x = x0 + rand() * CELL;
          const side = rand() > 0.5 ? 1 : -1;
          return [x, riverCenterZ(x) + side * riverHalfWidth(x) * (0.9 + rand() * 1.1)];
        },
      }),
    )),
  });
  return out;
}

const noForest = (g: (cx: number, cz: number) => Placement[]) => (cx: number, cz: number) => g(cx, cz).filter((p) => jungleT(p.x, p.z) < 0.15);
