"use client";

import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { ICE_Y, LAKE_CENTER, SUN_DIR } from "@/game/terrain";
import { GROUND_GLSL } from "@/game/groundWindow";
import { sharedUniforms } from "@/game/atmosphere";

// The frozen lake: one flat quad at ICE_Y. Where the heightmap is above the ice
// the fragment is discarded (terrain shows through), so the shoreline is exact.
// Colour comes from ice thickness (= depth below the surface): thin pale-green
// ice at the rim, deep blue-black in the middle, plus cracks, frost and snow.

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vWorld = position;
    vec4 mvPosition = viewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uIceY;
  uniform float uTime;
  ${GROUND_GLSL}
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }
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
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(7.7, 3.1); a *= 0.5; }
    return s;
  }

  // distance to the nearest Voronoi cell border: thin lines = fracture network
  float cracks(vec2 p) {
    vec2 n = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    vec2 c1 = vec2(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(n + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; c1 = r; } else if (d < d2) { d2 = d; }
    }
    return sqrt(d2) - sqrt(d1);
  }

  vec3 skyCol(vec3 d) {
    float g = pow(max(d.y, 0.0), 0.5);
    vec3 sky = mix(uHorizon, uZenith, g);
    float sd = max(dot(d, uSunDir), 0.0);
    sky += vec3(1.0, 0.85, 0.62) * pow(sd, 8.0) * 0.4;
    sky += vec3(1.0, 0.92, 0.8) * pow(sd, 96.0) * 1.6;
    return sky;
  }

  void main() {
    vec2 xz = vWorld.xz;
    float depth = uIceY - groundH(xz);
    if (depth <= 0.0) discard;

    float dist = length(cameraPosition - vWorld);

    // ---- surface relief: frost grain + large-scale warping, calmer with distance ----
    float warp = fbm(xz * 0.03);
    float fine = fbm(xz * 1.6 + warp * 3.0);
    float broad = fbm(xz * 0.12 + warp);
    float e = 0.08;
    float fx = fbm((xz + vec2(e, 0.0)) * 1.6 + warp * 3.0);
    float fz = fbm((xz + vec2(0.0, e)) * 1.6 + warp * 3.0);
    float roughAmt = 0.35 / (1.0 + dist * 0.03);
    vec3 n = normalize(vec3(-(fx - fine) / e * roughAmt * 0.25, 1.0, -(fz - fine) / e * roughAmt * 0.25));

    // ---- fractures ----
    float cr = cracks(xz * 0.16 + warp * 3.0);                      // big fracture plates
    float cr2 = cracks(xz * 0.75 + warp * 4.0 + 17.0);               // fine crazing
    float broken = smoothstep(0.38, 0.62, fbm(xz * 0.35 + 21.0));   // fractures come and go
    float lineBig = (1.0 - smoothstep(0.0, 0.022, cr)) * broken;
    float lineFine = (1.0 - smoothstep(0.0, 0.035, cr2)) * smoothstep(0.4, 0.7, broad) * (0.4 + 0.6 * broken);
    float crack = clamp(lineBig * 0.9 + lineFine * 0.5, 0.0, 1.0) * (1.0 - smoothstep(60.0, 220.0, dist));

    // ---- ice colour from thickness ----
    float thick = smoothstep(0.0, 2.3, depth);
    vec3 thin = vec3(0.40, 0.70, 0.78);
    vec3 mid = vec3(0.06, 0.28, 0.50);
    vec3 deep = vec3(0.01, 0.05, 0.14);
    vec3 body = mix(thin, mid, smoothstep(0.0, 0.5, thick));
    body = mix(body, deep, smoothstep(0.45, 1.0, thick));
    // slow variation in clarity: dark clear patches, cloudier stretches
    body *= 0.8 + 0.4 * fbm(xz * 0.07 + 40.0);
    // trapped air bubbles / milky frost
    float milk = smoothstep(0.58, 0.82, fbm(xz * 0.45 + 3.0)) * (1.0 - thick * 0.6) * 0.6;
    body = mix(body, vec3(0.72, 0.86, 0.92), milk * 0.65);
    // fractures read as lighter blue-white veins with a dark core
    body = mix(body, vec3(0.78, 0.92, 1.0), lineBig * 0.4);
    body = mix(body, vec3(0.01, 0.05, 0.1), lineFine * 0.45);

    // ---- reflection (sharp where ice is polished, blurred by roughness) ----
    vec3 V = normalize(cameraPosition - vWorld);
    float F = 0.03 + 0.97 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    vec3 R = reflect(-V, n);
    R.y = abs(R.y);
    vec3 refl = skyCol(R);
    refl = mix(refl, vec3(0.78, 0.84, 0.9), (1.0 - smoothstep(0.0, 0.14, R.y)) * 0.55); // snowy far shore
    float polish = 1.0 - milk * 0.7;
    vec3 col = mix(body, refl, F * (0.3 + 0.5 * polish));
    float sunG = pow(max(dot(R, uSunDir), 0.0), 500.0) * 40.0 * polish + pow(max(dot(R, uSunDir), 0.0), 40.0) * 0.35;
    col += vec3(1.0, 0.93, 0.82) * sunG;
    // sun transmitted through the ice lights the cracks from inside
    col += vec3(0.25, 0.55, 0.75) * lineBig * crack * 0.35 * (0.4 + 0.6 * thick);

    // ---- snow: wind-blown drifts lying on the ice, thickest at the shore ----
    float edge = 1.0 - smoothstep(0.0, 0.3, depth);
    float drift = fbm(xz * vec2(0.08, 0.2) + warp * 2.0);
    float snowAmt = clamp(smoothstep(0.62, 0.82, drift) * 0.55 + edge * 0.7, 0.0, 1.0);
    vec3 snowCol = vec3(0.9, 0.94, 0.99) * (0.8 + 0.2 * fine);
    float sheet = smoothstep(0.18, 0.0, abs(fine - 0.5)); // crisp ragged edge
    snowAmt = clamp(snowAmt * (0.9 + 0.2 * sheet), 0.0, 1.0);
    col = mix(col, snowCol, snowAmt);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function IceLake() {
  const { material, geometry } = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(300, 300);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(LAKE_CENTER[0], ICE_Y, LAKE_CENTER[1]); // world-space vertices; the shader reads `position` as world
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      fog: true,
      uniforms: sharedUniforms([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uSunDir: { value: new THREE.Vector3(...SUN_DIR) },
          uIceY: { value: ICE_Y },
        },
      ]),
    });
    return { material, geometry };
  }, []);

  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return (
    <mesh geometry={geometry} material={material} frustumCulled={false} />
  );
}
