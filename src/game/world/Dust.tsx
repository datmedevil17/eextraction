"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { atm } from "@/game/atmosphere";

// Wind-blown sand: points in a low box that wraps around the camera, streaming
// along the wind just above the dunes. Position is computed on the GPU from time alone.

const BOX = new THREE.Vector3(90, 9, 90);

const vertexShader = /* glsl */ `
  attribute vec4 aSeed;          // x,y,z in 0..1, w = size/speed class
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec3 uBox;
  uniform float uPx;
  uniform float uK;
  varying float vAlpha;
  void main() {
    float fall = mix(0.05, 0.25, aSeed.w);
    float t = uTime;
    // base position drifts with the wind and falls; wrap into the box around the camera
    vec3 p = aSeed.xyz * uBox;
    p.y -= t * fall;
    float gust = 0.75 + 0.25 * sin(t * 0.21 + aSeed.y * 6.0);
    p.x += t * (5.2 + 4.0 * aSeed.w) * gust * 0.82 + sin(t * 0.9 + aSeed.z * 20.0) * 0.4;
    p.z += t * (5.2 + 4.0 * aSeed.w) * gust * 0.57 + cos(t * 0.7 + aSeed.x * 20.0) * 0.4;
    vec3 c = uCam - 0.5 * uBox;
    p = c + mod(p - c, uBox);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    float d = -mv.z;
    gl_Position = projectionMatrix * mv;
    float size = mix(0.03, 0.075, aSeed.w);
    gl_PointSize = clamp(size * uPx / max(d, 0.3), 1.0, 14.0);
    // fade at the box edges and far away; flakes right on the lens vanish
    vec3 rel = (p - uCam) / (0.5 * uBox);
    float edge = 1.0 - smoothstep(0.7, 1.0, max(abs(rel.x), max(abs(rel.y), abs(rel.z))));
    vAlpha = uK * edge * smoothstep(0.2, 1.2, d) * (0.3 + 0.35 * aSeed.w);
  }
`;

const fragmentShader = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r = length(q) * 2.0;
    float a = smoothstep(1.0, 0.25, r) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.82, 0.6, 0.34), a);
  }
`;

export function Dust({ count = 6500 }: { count?: number }) {
  const { geometry, material } = useMemo(() => {
    const seeds = new Float32Array(count * 4);
    const pos = new Float32Array(count * 3); // unused by the shader, required by three
    let a = 777;
    const rand = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < count; i++) {
      seeds[i * 4] = rand();
      seeds[i * 4 + 1] = rand();
      seeds[i * 4 + 2] = rand();
      seeds[i * 4 + 3] = Math.pow(rand(), 2.2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: BOX },
        uPx: { value: 900 },
        uK: { value: 0 },
      },
    });
    return { geometry, material };
  }, [count]);

  const pts = useRef<THREE.Points>(null);
  useFrame((state) => {
    const k = atm.w.desert;
    if (pts.current) pts.current.visible = k > 0.02;
    material.uniforms.uK.value = k;
    material.uniforms.uTime.value = state.clock.elapsedTime;
    material.uniforms.uCam.value.copy(state.camera.position);
    material.uniforms.uPx.value = state.size.height * state.viewport.dpr * 0.9;
  });

  return <points ref={pts} geometry={geometry} material={material} frustumCulled={false} renderOrder={5} />;
}
