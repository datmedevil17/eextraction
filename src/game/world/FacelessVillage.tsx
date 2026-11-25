"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { FACELESS, heightAt } from "@/game/terrain";
import { pose, useGame } from "@/game/store";
import { addCollider } from "./colliders";
import { fenceParts, GATE_A, GATE_HALF, houseParts, PLAZA_R, STOREY, toWorld, W, type Part } from "./facelessLayout";
import { bake, frost, readPieces } from "./facelessKit";
import { facelessHouses, ritual } from "./facelessShared";

// Domain of the Faceless: a sorcerers' hamlet on the east shore of the frozen lake. Seven modular
// houses (Quaternius Medieval Village MegaKit, CC0) face a rune circle around an obsidian monolith
// with the floating blank mask; a ring of black iron fence with a gate toward the lake.
// All kit geometry is baked into one mesh per material (≈ 12 draw calls for the whole village).

const C = FACELESS;
const URL_KIT = "/models/faceless/kit.glb";
const SHOW = 900;
const RUNE_R = 7.5;

// ---------- static colliders (registered once; the collider grid has no removal) ----------
let collidersDone = false;
function registerColliders() {
  if (collidersDone) return;
  collidersDone = true;
  for (const h of facelessHouses()) {
    const hw = W / 2, hl = h.len / 2, top = h.y + h.storeys * STOREY + 4.5;
    const pts: [number, number][] = [];
    const inset = 0.55;
    const ex = hw - inset, ez = hl - inset;
    for (let x = -ex; x <= ex + 1e-3; x += (2 * ex) / Math.ceil((2 * ex) / 1.15)) { pts.push([x, ez]); pts.push([x, -ez]); }
    for (let z = -ez; z <= ez + 1e-3; z += (2 * ez) / Math.ceil((2 * ez) / 1.15)) { pts.push([ex, z]); pts.push([-ex, z]); }
    pts.push([0, 0], [0, ez * 0.5], [0, -ez * 0.5]);
    if (h.stairs) for (let z = -hl + 0.6; z <= hl + 2.4; z += 1.2) pts.push([hw + 1, z]);
    for (const [lx, lz] of pts) {
      const w = toWorld(h, { k: "", x: lx, y: 0, z: lz, ry: 0 });
      addCollider(w.x, w.z, 0.85, h.y - 2, top);
    }
  }
  // fence ring, leaving the gate open
  const n = Math.round((Math.PI * 2 * C.fence) / 1.15);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const d = Math.atan2(Math.sin(a - GATE_A), Math.cos(a - GATE_A));
    if (Math.abs(d) < GATE_HALF - 0.02) continue;
    const x = C.x + Math.cos(a) * C.fence, z = C.z + Math.sin(a) * C.fence;
    const y = heightAt(x, z);
    addCollider(x, z, 0.45, y - 2, y + 2.85);
  }
  for (const [x, z, r, h] of solids()) addCollider(x, z, r, heightAt(x, z) - 2, heightAt(x, z) + h);
}

/** Primitive-built solids: monolith, braziers, gate pillars, wagon, crates. [x, z, r, height] */
function solids(): [number, number, number, number][] {
  const out: [number, number, number, number][] = [[C.x, C.z, 1.3, 9]];
  for (const [x, z] of braziers()) out.push([x, z, 0.6, 1.6]);
  for (const [x, z] of gatePillars()) out.push([x, z, 0.85, 5]);
  return out;
}
function braziers(): [number, number][] {
  return Array.from({ length: 5 }, (_, i) => {
    const a = GATE_A + Math.PI / 5 + (i / 5) * Math.PI * 2;
    return [C.x + Math.cos(a) * (RUNE_R + 1.6), C.z + Math.sin(a) * (RUNE_R + 1.6)];
  });
}
function gatePillars(): [number, number][] {
  return [-1, 1].map((s) => {
    const a = GATE_A + s * (GATE_HALF + 0.012);
    return [C.x + Math.cos(a) * C.fence, C.z + Math.sin(a) * C.fence];
  });
}

/** Kit parts that are not houses: plaza paving, crates, wagon. */
function propParts(): { plaza: Part[]; props: Part[] } {
  const plaza: Part[] = [];
  for (let gx = -PLAZA_R; gx <= PLAZA_R; gx += 2)
    for (let gz = -PLAZA_R; gz <= PLAZA_R; gz += 2) {
      const r = Math.hypot(gx, gz);
      if (r > PLAZA_R || r < 1.6) continue;
      const x = C.x + gx, z = C.z + gz;
      const y = Math.max(heightAt(x - 1, z - 1), heightAt(x + 1, z - 1), heightAt(x - 1, z + 1), heightAt(x + 1, z + 1)) + 0.02;
      plaza.push({ k: "Floor_UnevenBrick", x, y, z, ry: 0 });
    }
  // the paved lane from the gate to the plaza
  for (let r = PLAZA_R + 1; r < C.fence + 2; r += 2) {
    for (const off of [-1, 1]) {
      const x = C.x + Math.cos(GATE_A) * r - Math.sin(GATE_A) * off, z = C.z + Math.sin(GATE_A) * r + Math.cos(GATE_A) * off;
      plaza.push({ k: "Floor_UnevenBrick", x, y: heightAt(x, z) + 0.03, z, ry: GATE_A });
    }
  }
  const props: Part[] = [];
  const hs = facelessHouses();
  hs.forEach((h, i) => {
    if (i % 2 === 0) {
      props.push(toWorld(h, { k: "Prop_Crate", x: 2.3, y: 0, z: h.len / 2 + 0.9, ry: 0.3 }));
      if (i % 4 === 0) props.push(toWorld(h, { k: "Prop_Crate", x: 2.35, y: 1.06, z: h.len / 2 + 0.85, ry: 0.9 }));
    } else props.push(toWorld(h, { k: "Prop_Crate", x: -2.4, y: 0, z: -h.len / 2 - 1, ry: 0.6 }));
  });
  const wa = GATE_A + 0.32, wr = C.fence - 9;
  const wx = C.x + Math.cos(wa) * wr, wz = C.z + Math.sin(wa) * wr;
  props.push({ k: "Prop_Wagon", x: wx, y: heightAt(wx, wz), z: wz, ry: wa + 0.4 });
  return { plaza, props };
}

// ---------- shaders ----------
const RUNE_VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RUNE_FS = /* glsl */ `
uniform float uTime; uniform float uPower; varying vec2 vUv;
#define PI 3.14159265
float hash(float n){ return fract(sin(n * 91.345) * 47453.12); }
float ring(float r, float rr, float w){ return smoothstep(w, 0.0, abs(r - rr)); }
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float c = ring(r, 0.97, 0.012) + ring(r, 0.9, 0.007) + ring(r, 0.62, 0.008) + ring(r, 0.57, 0.005) * 0.7;
  // rotating glyph band
  float aa = a + uTime * 0.12;
  float u = fract((aa + PI) / (2.0 * PI) * 28.0), cell = floor((aa + PI) / (2.0 * PI) * 28.0);
  float v = (r - 0.66) / 0.2;
  if (v > 0.0 && v < 1.0) {
    float h1 = hash(cell), h2 = hash(cell + 7.1), h3 = hash(cell + 3.3);
    float g = smoothstep(0.06, 0.0, abs(u - (0.3 + h1 * 0.4)));
    g += smoothstep(0.06, 0.0, abs(v - (0.25 + h2 * 0.5))) * step(abs(u - 0.5), 0.3);
    g += smoothstep(0.07, 0.0, abs((u - 0.5) - (v - 0.5) * (h3 > 0.5 ? 1.0 : -1.0))) * step(h3, 0.75);
    c += min(g, 1.0) * smoothstep(0.0, 0.15, v) * smoothstep(1.0, 0.85, v);
  }
  // counter-rotating pentagram
  float star = 0.0;
  for (int k = 0; k < 5; k++) {
    float th = -uTime * 0.07 + float(k) * 2.0 * PI / 5.0 + PI / 5.0;
    star += smoothstep(0.012, 0.0, abs(dot(p, vec2(cos(th), sin(th))) - 0.57 * 0.309));
  }
  c += star * step(r, 0.57);
  float pulse = 0.75 + 0.25 * sin(uTime * 1.7 + r * 6.0);
  vec3 col = mix(vec3(0.55, 0.2, 1.6), vec3(0.3, 0.9, 1.8), smoothstep(0.5, 1.0, r));
  float glow = exp(-r * 3.0) * 0.12;
  gl_FragColor = vec4(col * (c * pulse * uPower + glow * uPower), 1.0);
}`;

const FLAME_VS = /* glsl */ `attribute float aSeed; varying vec2 vUv; varying float vSeed;
void main(){ vUv = uv; vSeed = aSeed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FLAME_FS = /* glsl */ `
uniform float uTime; varying vec2 vUv; varying float vSeed;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main(){
  vec2 q = vUv;
  float t = uTime * 2.6 + vSeed * 17.0;
  float n = n2(vec2(q.x * 4.0, q.y * 3.0 - t)) * 0.6 + n2(vec2(q.x * 9.0, q.y * 7.0 - t * 1.6)) * 0.4;
  float w = (0.42 - q.y * 0.34) * (0.8 + n * 0.5);
  float body = smoothstep(w, w * 0.35, abs(q.x - 0.5)) * smoothstep(1.0, 0.25, q.y + n * 0.35) * smoothstep(0.0, 0.08, q.y);
  vec3 col = mix(vec3(0.35, 0.12, 1.6), vec3(1.4, 1.2, 3.2), body * body);
  gl_FragColor = vec4(col * body * 1.4, 1.0);
}`;

function flameGeometry(spots: [number, number, number, number][]) {
  const geos: THREE.BufferGeometry[] = [];
  spots.forEach(([x, y, z, s], i) => {
    for (const ry of [0, Math.PI / 2]) {
      const g = new THREE.PlaneGeometry(1.1 * s, 1.9 * s);
      g.translate(0, 0.95 * s, 0);
      g.rotateY(ry + i);
      g.translate(x, y, z);
      g.setAttribute("aSeed", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(i * 0.37), 1));
      geos.push(g);
    }
  });
  return mergeGeometries(geos)!;
}

type Built = { root: THREE.Group; casters: THREE.Mesh[] };

function useKit() {
  const [built, setBuilt] = useState<Built | null>(null);
  useEffect(() => {
    let dead = false;
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(URL_KIT).then((gltf) => {
      if (dead) return;
      const { pieces, mats } = readPieces(gltf.scene);
      const hs = facelessHouses();
      const houseList: Part[] = [];
      for (const h of hs) for (const p of houseParts(h)) houseList.push(toWorld(h, p));
      const { plaza, props } = propParts();
      houseList.push(...props);
      const root = new THREE.Group();
      const casters: THREE.Mesh[] = [];
      const matCache = new Map<string, THREE.Material>();
      const material = (key: string, snow: number) => {
        const id = key + "|" + snow;
        let m = matCache.get(id);
        if (m) return m;
        if (/glass/i.test(key)) {
          m = new THREE.MeshBasicMaterial({ color: key.includes("#alt") ? new THREE.Color(1.4, 0.55, 3.2) : new THREE.Color(2.6, 1.25, 0.4), toneMapped: false });
        } else {
          const src = mats.get(key) as THREE.MeshStandardMaterial;
          const mm = frost(src.clone(), snow);
          if (/Metal/i.test(key)) { mm.color.setRGB(0.32, 0.3, 0.38); mm.metalness = 0.6; mm.roughness = 0.45; }
          m = mm;
        }
        matCache.set(id, m);
        return m;
      };
      const add = (geos: Map<string, THREE.BufferGeometry>, snow: number, cast: boolean) => {
        for (const [key, g] of geos) {
          const mesh = new THREE.Mesh(g, material(key, snow));
          mesh.receiveShadow = true;
          mesh.castShadow = false;
          if (cast) casters.push(mesh);
          root.add(mesh);
        }
      };
      add(bake(pieces, houseList), 1, true);
      add(bake(pieces, fenceParts(C.x, C.z, C.fence, heightAt)), 0.6, false);
      add(bake(pieces, plaza), 0.3, false);
      setBuilt({ root, casters });
    }).catch((err) => console.error("faceless village failed to load", err));
    return () => {
      dead = true;
    };
  }, []);
  return built;
}

export function FacelessVillage() {
  const ref = useRef<THREE.Group>(null);
  const built = useKit();
  const light = useRef<THREE.PointLight>(null);
  const mask = useRef<THREE.Group>(null);

  useEffect(() => registerColliders(), []);

  const gy = useMemo(() => heightAt(C.x, C.z), []);
  const prims = useMemo(() => {
    const runeMat = new THREE.ShaderMaterial({
      vertexShader: RUNE_VS, fragmentShader: RUNE_FS, uniforms: { uTime: { value: 0 }, uPower: { value: 1 } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const flameMat = new THREE.ShaderMaterial({
      vertexShader: FLAME_VS, fragmentShader: FLAME_FS, uniforms: { uTime: { value: 0 } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    });
    const stone = frost(new THREE.MeshStandardMaterial({ color: 0x3a3844, roughness: 0.85 }), 1);
    const obsidian = new THREE.MeshStandardMaterial({ color: 0x0c0a12, roughness: 0.18, metalness: 0.35, emissive: new THREE.Color(0.08, 0.02, 0.2) });
    const porcelain = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.3, emissive: new THREE.Color(0.25, 0.2, 0.4) });
    const halo = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.6, 3.4), toneMapped: false, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const flames: [number, number, number, number][] = [];
    const bowls: [number, number, number][] = [];
    for (const [x, z] of braziers()) { const y = heightAt(x, z); bowls.push([x, y, z]); flames.push([x, y + 1.25, z, 0.7]); }
    const pillars = gatePillars().map(([x, z]) => [x, heightAt(x, z), z] as [number, number, number]);
    for (const [x, y, z] of pillars) flames.push([x, y + 4.4, z, 0.8]);
    return { runeMat, flameMat, flameGeo: flameGeometry(flames), stone, obsidian, porcelain, halo, bowls, pillars };
  }, []);

  useFrame(({ clock }, dt) => {
    const g = ref.current;
    if (!g) return;
    const d = Math.hypot(pose.x - C.x, pose.z - C.z);
    g.visible = d < SHOW;
    if (!g.visible) return;
    const phase = useGame.getState().phase;
    if (phase === "menu" || phase === "paused" || phase === "arsenal" || phase === "map") return;
    const t = clock.elapsedTime;
    prims.runeMat.uniforms.uTime.value = t;
    prims.flameMat.uniforms.uTime.value = t;
    const want = 0.9 + Math.min(3, ritual.gathered) * 0.45 + ritual.battle * 0.5;
    const pw = prims.runeMat.uniforms.uPower;
    pw.value += (want - pw.value) * Math.min(1, dt * 1.5);
    if (light.current) light.current.intensity = (30 + pw.value * 18) * (0.9 + Math.sin(t * 2.3) * 0.1);
    if (mask.current) {
      mask.current.position.y = gy + 7.2 + Math.sin(t * 0.6) * 0.25;
      mask.current.rotation.y = Math.sin(t * 0.15) * 1.2;
      mask.current.children[1].rotation.z = t * 0.4;
      mask.current.children[2].rotation.z = -t * 0.27;
    }
    if (built) for (const m of built.casters) m.castShadow = d < 130;
  });

  return (
    <group ref={ref}>
      {built && <primitive object={built.root} />}
      {/* rune circle on the plaza */}
      <mesh position={[C.x, gy + 0.08, C.z]} rotation={[-Math.PI / 2, 0, 0]} material={prims.runeMat} renderOrder={5}>
        <planeGeometry args={[RUNE_R * 2, RUNE_R * 2]} />
      </mesh>
      {/* the monolith and the floating blank mask of the Faceless */}
      <mesh position={[C.x, gy + 2.6, C.z]} rotation={[0, Math.PI / 4, 0]} material={prims.obsidian} castShadow receiveShadow>
        <cylinderGeometry args={[0.35, 0.95, 5.4, 4]} />
      </mesh>
      <mesh position={[C.x, gy + 0.25, C.z]} material={prims.stone} receiveShadow castShadow>
        <cylinderGeometry args={[1.5, 1.7, 0.5, 8]} />
      </mesh>
      <group ref={mask} position={[C.x, gy + 7.2, C.z]}>
        <mesh material={prims.porcelain} scale={[1, 1.3, 0.55]}>
          <sphereGeometry args={[0.7, 28, 20]} />
        </mesh>
        <mesh material={prims.halo} rotation={[0, 0, 0]}>
          <torusGeometry args={[1.25, 0.03, 8, 64]} />
        </mesh>
        <mesh material={prims.halo} rotation={[0, 0, 0]} scale={1.3}>
          <torusGeometry args={[1.25, 0.02, 8, 64]} />
        </mesh>
      </group>
      <pointLight ref={light} position={[C.x, gy + 3.5, C.z]} color="#9a5cff" intensity={40} distance={36} decay={1.6} />
      {/* braziers and gate pillars */}
      {prims.bowls.map(([x, y, z], i) => (
        <group key={"b" + i} position={[x, y, z]}>
          <mesh material={prims.stone} position={[0, 0.5, 0]} castShadow>
            <cylinderGeometry args={[0.18, 0.3, 1, 6]} />
          </mesh>
          <mesh material={prims.stone} position={[0, 1.12, 0]} castShadow>
            <cylinderGeometry args={[0.55, 0.3, 0.3, 8]} />
          </mesh>
        </group>
      ))}
      {prims.pillars.map(([x, y, z], i) => (
        <group key={"p" + i} position={[x, y, z]}>
          <mesh material={prims.stone} position={[0, 2.1, 0]} castShadow receiveShadow>
            <boxGeometry args={[1.1, 4.2, 1.1]} />
          </mesh>
          <mesh material={prims.stone} position={[0, 4.3, 0]} castShadow>
            <cylinderGeometry args={[0.6, 0.4, 0.25, 8]} />
          </mesh>
        </group>
      ))}
      <mesh geometry={prims.flameGeo} material={prims.flameMat} renderOrder={6} frustumCulled={false} />
    </group>
  );
}
