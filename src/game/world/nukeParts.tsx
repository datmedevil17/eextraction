"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { atm } from "@/game/atmosphere";
import { pose } from "@/game/store";
import { hurtPlayer, useHud } from "@/game/weapons/combat";
import { nukePoolT, terrainHeight } from "@/game/terrain";
import { POOLS, REACTOR, STACKS, TOWERS, TOWER_H, STACK_H } from "./nukeLayout";

// Effects of the dead reactor zone: glowing toxic pools, the reactor's light pillar,
// steam / smoke plumes, drifting ash + radioactive motes, and the radiation dose itself.

const GLOW = /* glsl */ `
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
  float fb(vec2 p) { return vn(p) * 0.5 + vn(p * 2.1 + 3.0) * 0.28 + vn(p * 4.3 + 8.0) * 0.14 + vn(p * 8.7) * 0.08; }
`;

function ToxicPools() {
  const mats = useMemo(() => {
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vWP; void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vWP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vWP; uniform float uTime;
        ${GLOW}
        void main(){
          vec2 c = vUv - 0.5; float r = length(c) * 2.0;
          if (r > 1.0) discard;
          vec2 p = vWP.xz * 0.35;
          float n = fb(p + vec2(uTime * 0.05, -uTime * 0.04));
          float n2 = fb(p * 1.7 - vec2(uTime * 0.07, uTime * 0.02) + n * 2.0);
          float bubbles = smoothstep(0.78, 0.9, vn(vWP.xz * 1.6 + vec2(uTime * 0.2, 0.0)) * n2 * 1.6);
          vec3 deep = vec3(0.05, 0.22, 0.02);
          vec3 hot = vec3(0.55, 1.35, 0.12);
          vec3 col = mix(deep, hot, smoothstep(0.25, 0.85, n2));
          col += vec3(0.7, 1.2, 0.3) * bubbles * 1.5;
          float edge = 1.0 - smoothstep(0.82, 1.0, r);
          float foam = smoothstep(0.78, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r));
          col += foam * vec3(0.5, 0.9, 0.2);
          gl_FragColor = vec4(col * 0.8, 0.93 * edge);
        }`,
    });
    return m;
  }, []);
  useFrame((s) => {
    mats.uniforms.uTime.value = s.clock.elapsedTime;
  });
  return (
    <>
      {POOLS.map(([x, z, r], i) => (
        <mesh key={i} material={mats} position={[x, -0.2, z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
          <circleGeometry args={[r * 1.18, 40]} />
        </mesh>
      ))}
      {POOLS.map(([x, z, r], i) => (
        <pointLight key={"l" + i} position={[x, 3, z]} color="#7dff2a" intensity={12 + r * 0.3} distance={r * 3.5} decay={1.6} />
      ))}
    </>
  );
}

/** The reactor's blown roof: a pillar of green light climbing into the haze. */
function ReactorBeam() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
        uniforms: { uTime: { value: 0 } },
        vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vWP; void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vWP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: /* glsl */ `
          varying vec2 vUv; varying vec3 vWP; uniform float uTime;
          ${GLOW}
          void main(){
            float y = vUv.y;
            float fall = pow(max(1.0 - y, 0.0), 1.6);
            float n = fb(vec2(vUv.x * 12.0, y * 5.0 - uTime * 0.9));
            float core = smoothstep(0.2, 0.9, n);
            float a = fall * (0.25 + 0.75 * core) * 0.55;
            vec3 col = mix(vec3(0.2, 1.0, 0.1), vec3(0.8, 1.2, 0.5), fall * core);
            gl_FragColor = vec4(col * 0.8, a * 0.4);
          }`,
      }),
    [],
  );
  useFrame((s) => {
    mat.uniforms.uTime.value = s.clock.elapsedTime;
  });
  const y = terrainHeight(REACTOR.x, REACTOR.z);
  return (
    <>
      <mesh material={mat} position={[REACTOR.x + 9, y + 20 + 220, REACTOR.z]} renderOrder={6}>
        <cylinderGeometry args={[6, 17, 440, 20, 1, true]} />
      </mesh>
      <pointLight position={[REACTOR.x + 9, y + 22, REACTOR.z]} color="#8dff30" intensity={250} distance={170} decay={1.5} />
    </>
  );
}

const STEAM_SRC: [number, number, number, number][] = [
  ...TOWERS.map((t) => [t.x, t.z, TOWER_H - 2, 1] as [number, number, number, number]),
  [REACTOR.x + 6, REACTOR.z, 52, 0.6],
  ...STACKS.map((s) => [s.x, s.z, STACK_H, 0.5] as [number, number, number, number]),
];
const PER = 12;

/** Rising, expanding plumes (billboard points computed on the GPU from time alone). */
function Plumes() {
  const { geometry, material } = useMemo(() => {
    const n = STEAM_SRC.length * PER;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 4);
    const src = new Float32Array(n * 4);
    let a = 4242;
    const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    STEAM_SRC.forEach(([x, z, h, k], si) => {
      const y = terrainHeight(x, z) + h;
      for (let i = 0; i < PER; i++) {
        const o = si * PER + i;
        pos[o * 3] = x; pos[o * 3 + 1] = y; pos[o * 3 + 2] = z;
        seed[o * 4] = rnd(); seed[o * 4 + 1] = rnd(); seed[o * 4 + 2] = rnd(); seed[o * 4 + 3] = rnd();
        src[o * 4] = k; src[o * 4 + 1] = si < TOWERS.length ? 1 : 0; src[o * 4 + 2] = 0; src[o * 4 + 3] = 0;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    g.setAttribute("aSrc", new THREE.BufferAttribute(src, 4));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uPx: { value: 900 }, uSun: { value: new THREE.Color("#e8e6c8") } },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed; attribute vec4 aSrc;
        uniform float uTime; uniform float uPx;
        varying float vA; varying float vT;
        void main(){
          float life = 14.0 + aSeed.w * 8.0;
          float t = fract(uTime / life + aSeed.x);
          vec3 p = position;
          p.y += t * (60.0 + 50.0 * aSrc.x);
          p.x += t * t * (26.0 + aSeed.y * 14.0) + (aSeed.y - 0.5) * 12.0 * t;
          p.z += t * t * 9.0 + (aSeed.z - 0.5) * 12.0 * t;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = (8.0 + t * 46.0) * (0.6 + aSrc.x * 0.5);
          gl_PointSize = clamp(size * uPx / max(-mv.z, 1.0), 2.0, 170.0);
          vA = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.55, 1.0, t)) * 0.2 * (1.0 - smoothstep(700.0, 1200.0, -mv.z));
          vT = t;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying float vT; uniform vec3 uSun;
        void main(){
          vec2 q = gl_PointCoord - 0.5;
          float r = length(q) * 2.0;
          float a = (1.0 - smoothstep(0.1, 1.0, r)) * vA;
          if (a < 0.004) discard;
          vec3 col = mix(vec3(0.3, 0.31, 0.27), vec3(0.18, 0.2, 0.17), vT);
          gl_FragColor = vec4(col, a);
        }`,
    });
    return { geometry: g, material: m };
  }, []);
  useFrame((s) => {
    material.uniforms.uTime.value = s.clock.elapsedTime;
    material.uniforms.uPx.value = s.size.height * s.viewport.dpr * 0.9;
  });
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={4} />;
}

const BOX = new THREE.Vector3(80, 28, 80);

/** Ash flakes + drifting radioactive motes around the camera, only inside the zone. */
function Ash() {
  const ref = useRef<THREE.Points>(null);
  const { geometry, material } = useMemo(() => {
    const count = 5200;
    const seeds = new Float32Array(count * 4);
    let a = 909;
    const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < count; i++) {
      seeds[i * 4] = rnd(); seeds[i * 4 + 1] = rnd(); seeds[i * 4 + 2] = rnd(); seeds[i * 4 + 3] = rnd() < 0.12 ? 1 : rnd() * 0.9;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: BOX }, uPx: { value: 900 }, uK: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed; uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform float uPx; uniform float uK;
        varying float vA; varying float vMote;
        void main(){
          float mote = step(0.99, aSeed.w);
          vec3 p = aSeed.xyz * uBox;
          p.y -= uTime * mix(0.5, 0.9, aSeed.w) * (1.0 - mote) - mote * uTime * 0.6;
          p.x += uTime * 1.6 + sin(uTime * 0.6 + aSeed.z * 30.0) * 1.2;
          p.z += uTime * 0.7 + cos(uTime * 0.5 + aSeed.x * 30.0) * 1.2;
          vec3 c = uCam - 0.5 * uBox;
          p = c + mod(p - c, uBox);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = mix(0.05, 0.14, aSeed.w) * (1.0 + mote * 0.8);
          gl_PointSize = clamp(size * uPx / max(-mv.z, 0.3), 1.0, 16.0);
          vec3 rel = (p - uCam) / (0.5 * uBox);
          float edge = 1.0 - smoothstep(0.7, 1.0, max(abs(rel.x), max(abs(rel.y), abs(rel.z))));
          vA = uK * edge * smoothstep(0.2, 1.0, -mv.z) * mix(0.35, 0.9, mote);
          vMote = mote;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying float vMote;
        void main(){
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.2, 1.0, r)) * vA;
          if (a < 0.01) discard;
          vec3 col = mix(vec3(0.42, 0.4, 0.36), vec3(0.35, 1.3, 0.2), vMote);
          gl_FragColor = vec4(col, a);
        }`,
    });
    return { geometry: g, material: m };
  }, []);
  useFrame((s) => {
    const k = atm.w.nuke;
    if (ref.current) ref.current.visible = k > 0.03;
    material.uniforms.uK.value = k;
    material.uniforms.uTime.value = s.clock.elapsedTime;
    material.uniforms.uCam.value.copy(s.camera.position);
    material.uniforms.uPx.value = s.size.height * s.viewport.dpr * 0.9;
  });
  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} renderOrder={5} />;
}

/** Dose rate (0..~1) at a ground position. */
export function radiationAt(x: number, z: number) {
  let d = 0;
  const pt = nukePoolT(x, z);
  if (pt < 1.5) d = Math.max(d, 1 - pt / 1.5);
  const rd = Math.hypot(x - REACTOR.x - 9, z - REACTOR.z);
  if (rd < 95) d = Math.max(d, (1 - rd / 95) ** 1.5 * 0.9);
  return d;
}

function Radiation() {
  const acc = useRef(0);
  useFrame((_, dt) => {
    const d = radiationAt(pose.x, pose.z);
    if (useHud.getState().rad !== d) useHud.setState({ rad: d });
    if (d > 0.05) {
      acc.current += dt;
      if (acc.current > 0.5) {
        acc.current = 0;
        hurtPlayer(1 + d * 5);
      }
    }
  });
  return null;
}

export function Parts() {
  return (
    <>
      <ToxicPools />
      <ReactorBeam />
      <Plumes />
      <Ash />
      <Radiation />
    </>
  );
}
