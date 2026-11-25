"use client";

import * as THREE from "three";
import { jungleT } from "@/game/terrain";
import { buildTree, lodStyle, makeBarkTexture, makeLeafTexture, type TreeStyle } from "./trees";
import { cellGen, wind, type Species } from "./propsStream";

// The western jungle: towering rainforest trees only (grass comes from the shared grass field).

const STYLES: TreeStyle[] = [
  { seed: 21, height: 19, trunkR: 0.5, branchesPerJoint: [2, 3], spread: 0.75, droop: 0.08, leafSize: [2.0, 3.0], cardsPerCluster: 18, clusterRadius: 1.7, tint: [0.62, 0.9, 0.55] },
  { seed: 22, height: 25, trunkR: 0.6, branchesPerJoint: [2, 3], spread: 0.6, droop: 0.04, leafSize: [2.2, 3.2], cardsPerCluster: 18, clusterRadius: 1.9, tint: [0.55, 0.85, 0.5] },
  { seed: 23, height: 13, trunkR: 0.3, branchesPerJoint: [3, 4], spread: 0.95, droop: 0.1, leafSize: [1.6, 2.4], cardsPerCluster: 16, clusterRadius: 1.35, tint: [0.7, 1, 0.55] },
  { seed: 24, height: 16, trunkR: 0.42, branchesPerJoint: [2, 3], spread: 1.1, droop: 0.2, leafSize: [1.9, 2.8], cardsPerCluster: 16, clusterRadius: 1.6, tint: [0.6, 0.95, 0.6] },
];


export function jungleSpecies(): Species[] {
  const out: Species[] = [];
  const leafTex = makeLeafTexture();
  const barkMat = new THREE.MeshStandardMaterial({ map: makeBarkTexture(), roughness: 1, color: "#b8ab92" });
  const leafMat = new THREE.MeshStandardMaterial({ map: leafTex, vertexColors: true, alphaTest: 0.4, roughness: 0.8 }); // cards already carry a back face
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
        float hgt = clamp(transformed.y / 14.0, 0.0, 1.0);
        float ph = uTime * 1.2 + iPos.x * 0.17 + iPos.z * 0.23;
        transformed.x += sin(ph + transformed.y * 0.4) * 0.22 * hgt;
        transformed.z += cos(ph * 0.8) * 0.18 * hgt;`,
      );
  };
  leafMat.customProgramCacheKey = () => "jungle-leaves";
  const leafDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.4 });

  STYLES.forEach((style, v) => {
    const { bark, leaves } = buildTree(style);
    const lod = buildTree(lodStyle(style));
    const gen = cellGen({
        seed: 700 + v,
        n: 2.6,
        scale: [0.9, 1.5],
        pow: 1.2,
        accept: (c) => {
          const j = jungleT(c.x, c.z);
          return j > 0.05 && c.w.meadow > 0.5 ? Math.min(1, j * 1.3) : 0;
        },
      });
    // full trees close by, the light LOD further out; the jungle haze swallows everything past ~300 m
    out.push({
      id: `jungle-tree-${v}`,
      parts: [
        { geometry: bark, material: barkMat },
        { geometry: leaves, material: leafMat, receive: false, depth: leafDepth },
      ],
      max: 120,
      castMax: 80,
      gen,
      solid: { r: style.trunkR + 0.12, h: style.height, crown: 3.5 },
    });
    out.push({ id: `jungle-tree-${v}-lod`, parts: [{ geometry: lod.bark, material: barkMat }, { geometry: lod.leaves, material: leafMat, receive: false }], min: 120, max: 310, gen });
  });

  return out;
}
