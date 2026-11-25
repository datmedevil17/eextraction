"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { biomeWeights, wetAt } from "@/game/terrain";
import { pose, useGame } from "@/game/store";
import { addItem, items, stepLoose } from "@/game/loose";

// Barrels and crates lying around: shove them, shoot them, blow them up, watch them roll and float.

const CLUSTERS: [number, number, number, number][] = [
  [0, 10, 70, 22], // meadow spawn
  [1300, -40, 150, 26], // reactor yard
  [-300, 1100, 110, 16], // desert
  [-300, -1100, 110, 16], // ice
  [-520, 0, 90, 12],
];

export function LooseProps() {
  const barrels = useRef<THREE.InstancedMesh>(null);
  const crates = useRef<THREE.InstancedMesh>(null);
  const counts = useMemo(() => {
    if (items.length === 0) {
      let a = 77;
      const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (const [cx, cz, r, n] of CLUSTERS) {
        let placed = 0;
        for (let tries = 0; placed < n && tries < n * 12; tries++) {
          const ang = rnd() * 6.283, d = 12 + Math.sqrt(rnd()) * r;
          const x = cx + Math.cos(ang) * d, z = cz + Math.sin(ang) * d;
          if (wetAt(x, z, 0.4) || biomeWeights(x, z).nuke > 0.05 !== (cx > 1000)) continue;
          addItem(rnd() < 0.55 ? 0 : 1, x, z, rnd() * 6.283);
          placed++;
        }
      }
    }
    return [items.filter((i) => i.kind === 0).length, items.filter((i) => i.kind === 1).length];
  }, []);

  const mats = useMemo(
    () => ({
      barrel: new THREE.MeshStandardMaterial({ color: "#7a4a2a", roughness: 0.55, metalness: 0.6 }),
      crate: new THREE.MeshStandardMaterial({ color: "#8a6a3e", roughness: 0.85, metalness: 0.05 }),
    }),
    [],
  );
  useEffect(() => () => { mats.barrel.dispose(); mats.crate.dispose(); }, [mats]);

  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const s1 = useMemo(() => new THREE.Vector3(1, 1, 1), []);
  const p3 = useMemo(() => new THREE.Vector3(), []);
  const hide = useMemo(() => new THREE.Matrix4().makeScale(0, 0, 0), []);
  const prev = useRef({ x: 0, z: 0 });

  useFrame((_, rawDt) => {
    const phase = useGame.getState().phase;
    const dt = Math.min(rawDt, 0.05);
    if (phase === "playing") {
      const vx = (pose.x - prev.current.x) / Math.max(dt, 1e-3), vz = (pose.z - prev.current.z) / Math.max(dt, 1e-3);
      stepLoose(dt, pose.x, pose.y, pose.z, Math.abs(vx) < 30 ? vx : 0, Math.abs(vz) < 30 ? vz : 0);
    }
    prev.current.x = pose.x; prev.current.z = pose.z;
    const b = barrels.current, c = crates.current;
    if (!b || !c) return;
    let bi = 0, ci = 0;
    for (const it of items) {
      const far = Math.hypot(it.x - pose.x, it.z - pose.z) > 420;
      const mesh = it.kind === 0 ? b : c;
      const idx = it.kind === 0 ? bi++ : ci++;
      if (far) mesh.setMatrixAt(idx, hide);
      else mesh.setMatrixAt(idx, m4.compose(p3.set(it.x, it.y, it.z), it.q, s1));
    }
    b.instanceMatrix.needsUpdate = true;
    c.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={barrels} args={[undefined, undefined, Math.max(1, counts[0])]} material={mats.barrel} frustumCulled={false} castShadow>
        <cylinderGeometry args={[0.38, 0.38, 1, 14]} />
      </instancedMesh>
      <instancedMesh ref={crates} args={[undefined, undefined, Math.max(1, counts[1])]} material={mats.crate} frustumCulled={false} castShadow>
        <boxGeometry args={[0.9, 0.9, 0.9]} />
      </instancedMesh>
    </>
  );
}
