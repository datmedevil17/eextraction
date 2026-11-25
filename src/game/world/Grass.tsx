"use client";

import { useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SUN_DIR, VILLAGE, seededRandom } from "@/game/terrain";
import { GROUND_GLSL } from "@/game/groundWindow";
import { sharedUniforms } from "@/game/atmosphere";

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec2 uCenter;
  uniform float uTile;
  uniform float uInner;
  uniform vec3 uVillage;
  uniform float uBladeH;
  uniform float uBladeW;
  uniform vec2 uWindDir;
  ${GROUND_GLSL}
  uniform vec3 uRoot;
  uniform vec3 uTip;
  uniform vec3 uDry;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;

  attribute vec2 aOffset;
  attribute vec4 aRand;

  varying vec3 vColor;

  #include <fog_pars_vertex>

  float patchAt(vec2 p) {
    float a = sin(p.x * 0.07 + 1.3) * sin(p.y * 0.06 + 0.4);
    float b = sin(p.x * 0.19 + 2.1) * sin(p.y * 0.23 + 1.7);
    return clamp(a * 0.35 + b * 0.15 + 0.5, 0.0, 1.0);
  }

  void main() {
    float t = position.y; // 0 at root, 1 at tip

    // Tile wraps around the player so the field is endless.
    vec2 rel = mod(aOffset - uCenter + 0.5 * uTile, uTile) - 0.5 * uTile;
    vec2 xz = uCenter + rel;
    float dist = length(rel);

    float fadeOut = 1.0 - smoothstep(0.38 * uTile, 0.5 * uTile, dist);
    float fadeIn = smoothstep(uInner, uInner + 8.0, dist);
    vec4 map = sampleGround4(xz);
    // no grass in the water or on the sandy banks
    float vis = fadeOut * fadeIn * (1.0 - smoothstep(0.12, 0.7, map.y)) * smoothstep(0.3, 0.75, map.z);

    // the village is trampled: sparse, short tufts only
    float vk = smoothstep(uVillage.z * 0.7, uVillage.z * 1.05, length(xz - uVillage.xy));
    vis *= mix(step(0.82, aRand.w) * 0.55, 1.0, vk);
    float ground = map.x - 0.03;
    float height = uBladeH * (0.55 + aRand.y * 0.9) * vis;

    float ang = aRand.x * 6.28318;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 side = vec2(-dir.y, dir.x);

    float bend = t * t;
    vec2 off = side * (aRand.z - 0.5) * 0.5 * bend * height; // natural lean

    // wind: slow travelling swell + gusts + flutter
    float swell = sin(dot(xz, uWindDir) * 0.12 + uTime * 1.3) * 0.5 + 0.5;
    float gust = sin(dot(xz, uWindDir) * 0.035 - uTime * 0.6) * 0.5 + 0.5;
    float flutter = sin(dot(xz, vec2(-uWindDir.y, uWindDir.x)) * 0.31 + uTime * 2.1 + aRand.w * 6.0);
    off += uWindDir * swell * (0.2 + 0.55 * gust) * bend * height;
    off += vec2(-uWindDir.y, uWindDir.x) * flutter * 0.1 * bend * height;

    // the player pushes grass aside
    float push = 1.0 - smoothstep(0.0, 1.4, dist);
    off += normalize(rel + vec2(1e-4)) * push * bend * height * 0.9;

    float lx = position.x * uBladeW * (0.6 + aRand.y * 0.8);
    vec3 p = vec3(xz.x + dir.x * lx + off.x, ground + t * height * (1.0 - 0.25 * push * bend), xz.y + dir.y * lx + off.y);

    // colour + fake lighting (no normals: blades are treated as mostly-up)
    float patchV = patchAt(xz);
    vec3 tipCol = mix(uTip, uDry, clamp(patchV * 0.4 + (aRand.w - 0.5) * 0.25 - 0.05, 0.0, 1.0));
    vec3 col = mix(uRoot, tipCol, pow(t, 0.75)) * (0.8 + 0.4 * aRand.w);
    vec3 n = normalize(vec3(side.x * 0.55, 1.0, side.y * 0.55));
    float ndl = clamp(dot(n, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
    vec3 V = normalize(p - cameraPosition);
    float sss = pow(max(dot(V, uSunDir), 0.0), 5.0) * t; // translucency when backlit
    vColor = col * (uAmbient + uSunColor * ndl * 0.85) + col * uSunColor * sss * 0.7;

    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** One tapered blade, y = 0..1 along its length, x = -0.5..0.5 across. */
function bladeGeometry(segments: number) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const w = 1 - t * 0.85;
    pos.push(-0.5 * w, t, 0, 0.5 * w, t, 0);
  }
  pos.push(0, 1, 0); // tip
  for (let i = 0; i < segments - 1; i++) {
    const a = 2 * i;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = 2 * (segments - 1);
  idx.push(last, last + 1, 2 * segments);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

type GrassProps = {
  count: number;
  tile: number; // metres, square that wraps around the player
  bladeH: number;
  bladeW: number;
  segments: number;
  inner?: number; // hide blades closer than this (used by the mid layer)
  seed: number;
};

export function Grass({ count, tile, bladeH, bladeW, segments, inner = 0, seed }: GrassProps) {
  const camera = useThree((s) => s.camera);

  const { geometry, material } = useMemo(() => {
    const base = bladeGeometry(segments);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    geo.instanceCount = count;

    const rand = seededRandom(seed);
    const offsets = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      offsets[i * 2] = rand() * tile;
      offsets[i * 2 + 1] = rand() * tile;
      rnd[i * 4] = rand();
      rnd[i * 4 + 1] = rand();
      rnd[i * 4 + 2] = rand();
      rnd[i * 4 + 3] = rand();
    }
    geo.setAttribute("aOffset", new THREE.InstancedBufferAttribute(offsets, 2));
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rnd, 4));

    const sun = new THREE.Vector3(...SUN_DIR);
    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      fog: true,
      uniforms: sharedUniforms([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uCenter: { value: new THREE.Vector2() },
          uTile: { value: tile },
          uInner: { value: inner },
          uVillage: { value: new THREE.Vector3(VILLAGE.x, VILLAGE.z, VILLAGE.r) },
          uBladeH: { value: bladeH },
          uBladeW: { value: bladeW },
          uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
          uRoot: { value: new THREE.Color("#1c3a0e") },
          uTip: { value: new THREE.Color("#78b83a") },
          uDry: { value: new THREE.Color("#b9ae4e") },
          uSunDir: { value: sun },
          uSunColor: { value: new THREE.Color("#fff0d2") },
          uAmbient: { value: new THREE.Color("#5f7f9c").multiplyScalar(0.55) },
        },
      ]),
    });
    return { geometry: geo, material: mat };
  }, [count, tile, bladeH, bladeW, segments, inner, seed]);

  useFrame((state) => {
    const u = material.uniforms;
    u.uTime.value = state.clock.elapsedTime;
    u.uCenter.value.set(camera.position.x, camera.position.z);
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} userData={{ noReflect: true }} />; // skipped by the oasis mirror pass
}

/** Dense near field + sparser, taller mid field. */
export function GrassField() {
  return (
    <>
      <Grass count={220000} tile={52} bladeH={0.62} bladeW={0.05} segments={5} seed={11} />
      <Grass count={170000} tile={230} bladeH={0.8} bladeW={0.13} segments={3} inner={18} seed={23} />
    </>
  );
}
