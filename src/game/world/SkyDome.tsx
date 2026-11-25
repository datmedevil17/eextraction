"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { SUN_DIR } from "@/game/terrain";
import { skyUniforms } from "@/game/atmosphere";


const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // always at the far plane, whatever the camera's far is
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vDir;
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uSunBoost;
  uniform float uClouds;
  uniform float uIce;
  uniform float uDry;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) {
      s += a * vnoise(p);
      p = p * 2.03 + vec2(17.1, 9.2);
      a *= 0.5;
    }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = max(d.y, 0.0);

    // clear-sky gradient: pale haze at the horizon -> deep blue overhead
    float g = pow(up, 0.42);
    vec3 sky = mix(uHorizon, uZenith, g);

    // sun: broad warm glow + tight bright core
    float sd = max(dot(d, uSunDir), 0.0);
    sky += vec3(1.0, 0.82, 0.55) * pow(sd, 6.0) * 0.18;
    sky += vec3(1.0, 0.9, 0.7) * pow(sd, 64.0) * 0.9;
    // low polar sun: wide peach halo and a warm band along the horizon on its side
    sky += vec3(1.0, 0.7, 0.48) * (pow(sd, 3.0) * 0.2 + pow(sd, 14.0) * 0.25) * uIce;
    sky = mix(sky, sky * vec3(1.06, 1.0, 0.92), uIce * (1.0 - up) * 0.5);
    // desert: dusty gold haze hugging the horizon
    sky = mix(sky, sky * vec3(1.1, 1.0, 0.84) + vec3(0.05, 0.03, 0.0), uDry * pow(1.0 - up, 3.0) * 0.8);
    sky += vec3(1.0, 0.8, 0.5) * pow(sd, 4.0) * 0.12 * uDry;
    sky += vec3(1.0, 0.95, 0.85) * smoothstep(0.99965, 0.99985, sd) * 60.0 * uSunBoost;

    // sparse fair-weather clouds
    if (uClouds > 0.5 && d.y > 0.015) {
      vec2 uv = d.xz / (d.y + 0.14) * 0.85 + uTime * vec2(0.010, 0.004);
      float n = fbm(uv * 1.15);
      float cover = smoothstep(mix(0.64, 0.5, uIce) + uDry * 0.14, mix(0.84, 0.82, uIce) + uDry * 0.08, n);
      cover *= smoothstep(0.015, 0.22, d.y);

      vec2 toSun = normalize(uSunDir.xz + 1e-4) * 0.07;
      float nSun = fbm((uv + toSun) * 1.15);
      float lit = clamp(0.62 + (n - nSun) * 5.0, 0.0, 1.0);

      vec3 cloudCol = mix(mix(vec3(0.46, 0.55, 0.70), vec3(0.62, 0.70, 0.82), uIce), vec3(1.25, 1.22, 1.15), lit);
      cloudCol += vec3(1.0, 0.85, 0.6) * pow(sd, 10.0) * 0.8;
      sky = mix(sky, cloudCol, cover * mix(0.9, 0.78, uIce));
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;

export function SkyDome({ envMode = false }: { envMode?: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        uniforms: {
          uTime: { value: 0 },
          uSunBoost: { value: envMode ? 0.12 : 1 }, // keep the baked env map from being blown out
          uClouds: { value: envMode ? 0 : 1 },
          // live mode shares the blended atmosphere; the baked env map stays on the meadow sky
          ...(envMode
            ? {
                uSunDir: { value: new THREE.Vector3(...SUN_DIR) },
                uHorizon: { value: new THREE.Color("#b4cde6") },
                uZenith: { value: new THREE.Color("#2c74d6") },
                uIce: { value: 0 },
                uDry: { value: 0 },
              }
            : skyUniforms),
        },
      }),
    [envMode],
  );

  useFrame((state) => {
    if (envMode) return;
    material.uniforms.uTime.value = state.clock.elapsedTime;
    mesh.current?.position.copy(state.camera.position);
  });

  return (
    <mesh ref={mesh} material={material} frustumCulled={false} renderOrder={-1}>
      <sphereGeometry args={[500, 48, 24]} />
    </mesh>
  );
}
