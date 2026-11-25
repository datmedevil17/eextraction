"use client";

import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { SUN_DIR, WATER_Y, WORLD_HALF, riverCenterZ, riverHalfWidth } from "@/game/terrain";
import { GROUND_GLSL } from "@/game/groundWindow";
import { sharedUniforms } from "@/game/atmosphere";

// The water is a flat ribbon at y = WATER_Y that follows the river centre line.
// It is wider than the channel: the terrain pokes through on the banks, so the
// shoreline is exact. Depth for colour/foam is read from the same heightmap the
// terrain was built from.

const vertexShader = /* glsl */ `
  attribute vec2 aFlow;
  attribute float aSide;
  varying float vSide;
  varying vec3 vWorld;
  varying vec2 vFlow;
  #include <fog_pars_vertex>
  void main() {
    vWorld = position;
    vFlow = aFlow;
    vSide = aSide;
    vec4 mvPosition = viewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform float uWaterY;
  ${GROUND_GLSL}

  varying vec3 vWorld;
  varying vec2 vFlow;
  varying float vSide;
  #include <fog_pars_fragment>

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
  float fbm3(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.07 + vec2(5.3, 1.7); a *= 0.5; }
    return s;
  }

  // ripple height field: two layers drifting downstream at different speeds
  float ripples(vec2 p, vec2 flow, float spd) {
    vec2 across = vec2(-flow.y, flow.x);
    vec2 q1 = p * 0.55 - flow * uTime * spd;
    vec2 q2 = p * 1.7 + across * sin(uTime * 0.4 + p.x * 0.05) * 0.6 - flow * uTime * spd * 1.8;
    return fbm3(q1) * 0.65 + fbm3(q2) * 0.35;
  }

  vec3 skyCol(vec3 d) {
    float g = pow(max(d.y, 0.0), 0.42);
    vec3 sky = mix(uHorizon, uZenith, g);
    float sd = max(dot(d, uSunDir), 0.0);
    sky += vec3(1.0, 0.82, 0.55) * pow(sd, 6.0) * 0.18;
    sky += vec3(1.0, 0.9, 0.7) * pow(sd, 64.0) * 0.9;
    return sky;
  }

  void main() {
    vec2 xz = vWorld.xz;
    // beyond the ground window, fake the channel profile from the ribbon itself
    float depth = mix(1.1 * (1.0 - smoothstep(0.5, 0.68, abs(vSide))), max(0.0, uWaterY - groundH(xz)), groundInside(xz));
    depth = max(depth, 0.0);
    if (depth <= 0.0) discard;

    vec2 flow = normalize(vFlow);
    float spd = 0.55 * (0.35 + 0.65 * smoothstep(0.0, 0.7, depth)); // slower in the shallows

    // surface normal from the ripple field (finite differences)
    float dist = length(cameraPosition - vWorld);
    float amp = 1.15 / (1.0 + dist * 0.045); // calm the ripples with distance (less shimmer)
    float e = 0.12;
    float h0 = ripples(xz, flow, spd);
    float hx = ripples(xz + vec2(e, 0.0), flow, spd);
    float hz = ripples(xz + vec2(0.0, e), flow, spd);
    vec3 n = normalize(vec3(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));

    vec3 V = normalize(cameraPosition - vWorld);
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    vec3 R = reflect(-V, n);
    R.y = abs(R.y);

    // reflection: sky, plus a cheap stand-in for the far bank near the horizon
    vec3 refl = skyCol(R);
    float bankAmt = (1.0 - smoothstep(0.0, 0.3, R.y)) * 0.6;
    refl = mix(refl, vec3(0.07, 0.15, 0.05), bankAmt);

    // body colour: clear shallows -> deep green-blue
    float absorb = 1.0 - exp(-depth * 1.5);
    vec3 body = mix(uShallow, uDeep, absorb);
    float cs = 0.5 + 0.5 * h0;
    body = mix(vec3(0.42, 0.38, 0.28) * (0.8 + 0.4 * cs), body, smoothstep(0.0, 0.55, depth)); // see the bed through the shallows
    body *= 0.55 + 0.45 * clamp(uSunDir.y * 1.6, 0.0, 1.0);

    vec2 acr = vec2(-flow.y, flow.x);
    vec2 sp = vec2(dot(xz, flow), dot(xz, acr));
    float streak = fbm3(vec2(sp.x * 0.12 - uTime * spd * 0.9, sp.y * 1.3));
    body *= 0.9 + 0.22 * smoothstep(0.35, 0.75, streak);
    vec3 col = mix(body, refl, F);
    float glint = pow(max(dot(R, uSunDir), 0.0), 900.0) * 55.0 + pow(max(dot(R, uSunDir), 0.0), 90.0) * 0.5;
    col += uSunColor * glint;

    // shoreline foam: streaky, drifting downstream
    float fn = fbm3(xz * vec2(2.2) - flow * uTime * 0.35);
    float foam = smoothstep(0.2, 0.0, depth) * smoothstep(0.42, 0.7, fn) * 0.8;
    col = mix(col, vec3(0.85, 0.9, 0.92), clamp(foam, 0.0, 1.0) * 0.6);

    float alpha = smoothstep(0.0, 0.22, depth) * (0.45 + 0.5 * absorb);
    alpha = max(alpha, F * smoothstep(0.0, 0.2, depth));
    alpha = max(alpha, clamp(foam, 0.0, 1.0) * 0.6);

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function buildRibbon() {
  const N = 1400;
  const x0 = -WORLD_HALF + 10;
  const x1 = WORLD_HALF - 10;
  const pos: number[] = [];
  const flow: number[] = [];
  const side: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const x = x0 + ((x1 - x0) * i) / N;
    const z = riverCenterZ(x);
    const dz = (riverCenterZ(x + 1) - riverCenterZ(x - 1)) / 2;
    const len = Math.hypot(1, dz);
    const tx = 1 / len;
    const tz = dz / len;
    const w = riverHalfWidth(x) * 1.5;
    pos.push(x - tz * w, WATER_Y, z + tx * w, x + tz * w, WATER_Y, z - tx * w);
    flow.push(tx, tz, tx, tz);
    side.push(-1, 1);
    if (i < N) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 2));
  g.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

export function River() {
  const { geometry, material } = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      uniforms: sharedUniforms([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uSunDir: { value: new THREE.Vector3(...SUN_DIR) },
          uSunColor: { value: new THREE.Color("#fff0d2") },
          uShallow: { value: new THREE.Color("#3d7a6a") },
          uDeep: { value: new THREE.Color("#0b3440") },
          uWaterY: { value: WATER_Y },
        },
      ]),
    });
    return { geometry: buildRibbon(), material };
  }, []);

  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />;
}
