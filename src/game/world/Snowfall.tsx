"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { atm } from "@/game/atmosphere";

// Falling snow: points in a box that wraps around the camera, so a few thousand
// flakes fill the whole view. Position is computed on the GPU from time alone.

const BOX = new THREE.Vector3(70, 36, 70);

const vertexShader = /* glsl */ `
  attribute vec4 aSeed;          // x,y,z in 0..1, w = size/speed class
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec3 uBox;
  uniform float uPx;
  uniform float uK;
  varying float vAlpha;
  void main() {
    float fall = mix(0.9, 2.2, aSeed.w);
    float t = uTime;
    // base position drifts with the wind and falls; wrap into the box around the camera
    vec3 p = aSeed.xyz * uBox;
    p.y -= t * fall;
    p.x += t * (1.4 + 0.8 * sin(t * 0.13)) + sin(t * 0.9 + aSeed.z * 20.0) * 0.5;
    p.z += t * 0.6 + cos(t * 0.7 + aSeed.x * 20.0) * 0.5;
    vec3 c = uCam - 0.5 * uBox;
    p = c + mod(p - c, uBox);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    float d = -mv.z;
    gl_Position = projectionMatrix * mv;
    float size = mix(0.045, 0.11, aSeed.w);
    gl_PointSize = clamp(size * uPx / max(d, 0.3), 1.0, 14.0);
    // fade at the box edges and far away; flakes right on the lens vanish
    vec3 rel = (p - uCam) / (0.5 * uBox);
    float edge = 1.0 - smoothstep(0.7, 1.0, max(abs(rel.x), max(abs(rel.y), abs(rel.z))));
    vAlpha = uK * edge * smoothstep(0.2, 1.2, d) * (0.55 + 0.45 * aSeed.w);
  }
`;

const fragmentShader = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r = length(q) * 2.0;
    float a = smoothstep(1.0, 0.25, r) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.96, 0.98, 1.0), a);
  }
`;

export function Snowfall({ count = 9000 }: { count?: number }) {
  const { geometry, material } = useMemo(() => {
    const seeds = new Float32Array(count * 4);
    const pos = new Float32Array(count * 3); // unused by the shader, required by three
    let a = 12345;
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
    const k = atm.w.ice;
    if (pts.current) pts.current.visible = k > 0.02;
    material.uniforms.uK.value = k;
    material.uniforms.uTime.value = state.clock.elapsedTime;
    material.uniforms.uCam.value.copy(state.camera.position);
    material.uniforms.uPx.value = state.size.height * state.viewport.dpr * 0.9;
  });

  return <points ref={pts} geometry={geometry} material={material} frustumCulled={false} renderOrder={5} />;
}
