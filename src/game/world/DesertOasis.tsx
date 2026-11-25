"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { OASIS_CENTER, SUN_DIR, WATER_Y, noise2, oasisRockW, seededRandom, terrainHeight } from "@/game/terrain";
import { GROUND_GLSL } from "@/game/groundWindow";
import { atm, sharedUniforms } from "@/game/atmosphere";

// The desert oasis pond.
//  * Surface: layered directional ripples + advected wind ripples, with slow "cat's paw" gusts that roughen
//    patches of the water. Normals fade with distance so it doesn't shimmer.
//  * Reflection: a real planar mirror pass (oblique-clipped camera into a half-res HDR target) while the
//    camera is near, so the palms and the sandstone outcrop show up in the water. Far away / fallback: sky.
//  * Under the surface: the view ray is refracted and traced to the bed (local hi-res heightmap), the bed is
//    shaded procedurally (rippled sand, pebbles, algae in the deep spring) and lit by chromatic animated
//    caustics; the water column absorbs per channel (Beer-Lambert) and in-scatters turquoise light.
//  * Schlick Fresnel, GGX sun highlight, soft wet edge with a little froth at the waterline.
// Plus reeds / cattails on the shore and lily pads on the shallows (instanced, wind sway).

const [OX, OZ] = OASIS_CENTER;
const HM_SIZE = 200; // metres covered by the local heightmap
const HM_N = 256;
const WATER_SIZE = 160;
const REFLECT_DIST = 340; // mirror pass only while the camera is this close
const FRAME_PRIORITY = 0.9; // after every normal frame callback (camera moved), before the composer (1)

const vertexShader = /* glsl */ `
  uniform mat4 uTexMat;
  varying vec3 vWorld;
  varying vec4 vRefl;
  #include <fog_pars_vertex>
  void main() {
    vWorld = position;
    vRefl = uTexMat * vec4(position, 1.0);
    vec4 mvPosition = viewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uSunI;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uWaterY;
  uniform vec2 uWind;
  uniform sampler2D uHMap;
  uniform vec3 uHRect; // x0, z0, 1/size
  uniform sampler2D uRefl;
  uniform float uReflOn;
  ${GROUND_GLSL}
  varying vec3 vWorld;
  varying vec4 vRefl;
  #include <fog_pars_fragment>

  #define PI 3.14159265
  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm3(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(5.3, 1.7); a *= 0.5; }
    return s;
  }

  float bedH(vec2 p) {
    vec2 uv = (p - uHRect.xy) * uHRect.z;
    if (uv.x < 0.003 || uv.y < 0.003 || uv.x > 0.997 || uv.y > 0.997) return groundH(p);
    return texture2D(uHMap, uv).r;
  }

  // slow gusts: patches where the wind touches the water and roughens it
  float gustAt(vec2 p, float t) {
    float g = fbm3(p * 0.035 - uWind * t * 0.06);
    return 0.25 + 1.1 * smoothstep(0.42, 0.72, g);
  }
  // surface height field (metres); fine detail fades with distance (fd = 1 near .. 0 far)
  float waveH(vec2 p, float t, float gust, float fd) {
    float h = 0.0;
    h += sin(dot(p, vec2(0.62, 0.78)) * 1.6 + t * 1.8) * 0.010;
    h += sin(dot(p, vec2(0.95, -0.31)) * 2.7 + t * 2.5) * 0.006;
    h += sin(dot(p, vec2(-0.28, 0.96)) * 4.1 - t * 3.0) * 0.004;
    vec2 q = p * 2.6 - uWind * t * 0.55;
    h += (fbm3(q) - 0.45) * 0.026 * gust;
    h += (vnoise(p * 8.5 - uWind * t * 1.3) - 0.5) * 0.009 * gust * fd;
    h += (vnoise(p * 19.0 + uWind.yx * t * 1.9) - 0.5) * 0.0035 * gust * fd * fd;
    return h;
  }

  vec3 skyCol(vec3 d) {
    float g = pow(max(d.y, 0.0), 0.42);
    vec3 sky = mix(uHorizon, uZenith, g);
    float sd = max(dot(d, uSunDir), 0.0);
    sky += uSunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 64.0) * 0.6);
    return sky;
  }

  // classic iterative caustic pattern (tileable in 2*PI)
  float caustic(vec2 p, float t) {
    p = mod(p, 6.2831853) - 250.0;
    vec2 i = p;
    float c = 1.0;
    for (int n = 0; n < 4; n++) {
      float tt = t * (1.0 - 3.5 / float(n + 1));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
    }
    c /= 4.0;
    c = 1.17 - pow(c, 1.4);
    return pow(abs(c), 7.0);
  }

  vec3 bedAlbedo(vec2 p, float dep) {
    float n1 = fbm3(p * 0.3);
    vec3 sand = mix(vec3(0.50, 0.40, 0.27), vec3(0.70, 0.58, 0.40), n1);
    // ripple marks in the sand, warped
    float rip = sin(dot(p, vec2(0.8, 0.6)) * 5.5 + fbm3(p * 0.6) * 7.0);
    sand *= 0.88 + 0.12 * rip * smoothstep(2.5, 0.3, dep);
    // pebbles
    float pb = smoothstep(0.74, 0.8, vnoise(p * 2.6 + 3.1)) * (0.5 + 0.5 * vnoise(p * 0.4));
    sand = mix(sand, vec3(0.30, 0.26, 0.22) * (0.8 + 0.4 * hash(floor(p * 2.6))), pb * 0.8);
    // silt / algae towards the spring
    float alg = smoothstep(0.7, 2.6, dep) * smoothstep(0.35, 0.65, fbm3(p * 0.45 + 7.0));
    sand = mix(sand, vec3(0.14, 0.21, 0.09), alg * 0.8);
    sand = mix(sand, vec3(0.22, 0.24, 0.17), smoothstep(2.0, 3.6, dep) * 0.6);
    return sand;
  }

  void main() {
    vec2 xz = vWorld.xz;
    float d0 = uWaterY - bedH(xz);
    // the waterline laps a few centimetres up and down
    float lap = 0.018 * sin(uTime * 0.9 + dot(xz, vec2(0.3, 0.2))) + 0.01 * sin(uTime * 1.7 - xz.x * 0.5);
    if (d0 + lap <= 0.0) discard;

    float t = uTime;
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / dist;
    float fd = 1.0 - smoothstep(25.0, 140.0, dist);
    float gust = gustAt(xz, t);
    float e = 0.035 + dist * 0.002;
    float h0 = waveH(xz, t, gust, fd);
    float hx = waveH(xz + vec2(e, 0.0), t, gust, fd);
    float hz = waveH(xz + vec2(0.0, e), t, gust, fd);
    float amp = mix(0.35, 1.0, fd) * smoothstep(0.0, 0.25, d0); // calmer in the shallow fringe
    vec3 n = normalize(vec3(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));

    // ---- reflection ----
    float NoV = max(dot(n, V), 1e-3);
    float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
    vec3 R = reflect(-V, n);
    R.y = abs(R.y);
    vec3 refl = skyCol(R);
    if (uReflOn > 0.5) {
      vec2 ruv = vRefl.xy / vRefl.w + n.xz * vec2(0.6, 0.6) * (0.08 / (1.0 + dist * 0.02));
      ruv = clamp(ruv, vec2(0.001), vec2(0.999));
      refl = texture2D(uRefl, ruv).rgb;
    }

    // ---- refraction: trace to the bed ----
    vec3 T = refract(-V, n, 1.0 / 1.333);
    float ty = max(-T.y, 0.2);
    float L = max(d0, 0.0) / ty;
    vec2 bp = xz + T.xz * L;
    float d1 = max(uWaterY - bedH(bp), 0.0);
    L = 0.5 * (L + d1 / ty);
    bp = xz + T.xz * L;
    float dB = max(uWaterY - bedH(bp), 0.0);

    // sunlight reaching the bed: absorbed on the way down, focused into caustics by the waves
    vec3 sigma = vec3(0.50, 0.15, 0.17);
    float sunUp = max(uSunDir.y, 0.05);
    vec3 sunRad = uSunColor * uSunI;
    vec3 Tdown = exp(-sigma * dB / sunUp);
    vec2 cp = bp * 0.55 + uSunDir.xz * dB * 0.4;
    float ct = t * 0.55;
    vec3 caus = vec3(caustic(cp, ct), caustic(cp + 0.025, ct), caustic(cp + 0.05, ct));
    float cAmt = smoothstep(0.02, 0.35, dB) * exp(-dB * 0.3) * (0.6 + 0.4 * gust);
    vec3 Ebed = sunRad * sunUp * Tdown * (0.55 + caus * 2.4 * cAmt) + uZenith * 0.55 * exp(-sigma * dB);
    vec3 bed = bedAlbedo(bp, dB) * Ebed / PI;

    // the water column between the surface and the bed
    vec3 Tview = exp(-sigma * L);
    vec3 scatter = vec3(0.025, 0.13, 0.115) * (sunRad * sunUp * 0.35 + uZenith * 0.5);
    vec3 refr = bed * Tview + scatter * (1.0 - Tview);

    vec3 col = mix(refr, refl, F);

    // ---- sun highlight (GGX) ----
    vec3 Hh = normalize(V + uSunDir);
    float NoH = max(dot(n, Hh), 0.0);
    float NoL = max(dot(n, uSunDir), 0.0);
    float a = 0.045 + 0.04 * gust * fd;
    float a2 = a * a;
    float dd = NoH * NoH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(Hh, V), 0.0), 5.0);
    col += sunRad * min(D * Fs * NoL / (4.0 * NoV + 0.05), 30.0);

    // froth and a glossy wet line at the waterline
    float edge = 1.0 - smoothstep(0.0, 0.1, d0 + lap);
    float froth = smoothstep(0.5, 0.85, vnoise(xz * 7.0 + t * 0.25) * 0.6 + vnoise(xz * 23.0 - t * 0.4) * 0.4) * edge;
    col = mix(col, (sunRad * sunUp + uZenith * 0.5) * 0.85 / PI, froth * 0.55);

    float alpha = smoothstep(0.0, 0.2, d0 + lap);
    alpha = max(alpha, F * smoothstep(0.0, 0.03, d0 + lap));
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function buildHeightmap() {
  const data = new Uint16Array(HM_N * HM_N);
  const x0 = OX - HM_SIZE / 2, z0 = OZ - HM_SIZE / 2, step = HM_SIZE / (HM_N - 1);
  for (let j = 0; j < HM_N; j++)
    for (let i = 0; i < HM_N; i++) data[j * HM_N + i] = THREE.DataUtils.toHalfFloat(terrainHeight(x0 + i * step, z0 + j * step));
  const tex = new THREE.DataTexture(data, HM_N, HM_N, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  // texel centres sit on the samples: shift the rect by half a texel so uv maps exactly
  const size = step * HM_N;
  return { tex, rect: new THREE.Vector3(x0 - step / 2, z0 - step / 2, 1 / size) };
}

// ---------- planar mirror ----------
const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();
const _rot = new THREE.Matrix4();
const _camPos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _view = new THREE.Vector3();
const _target = new THREE.Vector3();
const _size = new THREE.Vector2();
const UP = new THREE.Vector3(0, 1, 0);

function updateMirror(cam: THREE.PerspectiveCamera, mirror: THREE.PerspectiveCamera, texMat: THREE.Matrix4) {
  const p = new THREE.Vector3(OX, WATER_Y, OZ);
  _camPos.setFromMatrixPosition(cam.matrixWorld);
  _view.subVectors(p, _camPos);
  _view.reflect(UP).negate().add(p);
  _rot.extractRotation(cam.matrixWorld);
  _look.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
  _target.subVectors(p, _look).reflect(UP).negate().add(p);
  mirror.position.copy(_view);
  mirror.up.set(0, 1, 0).applyMatrix4(_rot).reflect(UP);
  mirror.lookAt(_target);
  mirror.far = cam.far;
  mirror.near = cam.near;
  mirror.updateMatrixWorld();
  mirror.projectionMatrix.copy(cam.projectionMatrix);
  texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  texMat.multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
  // oblique near plane = the water plane, so nothing under the water leaks into the reflection
  _plane.setFromNormalAndCoplanarPoint(UP, p).applyMatrix4(mirror.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const pm = mirror.projectionMatrix.elements;
  _q.set((Math.sign(_clip.x) + pm[8]) / pm[0], (Math.sign(_clip.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
  _clip.multiplyScalar(2 / _clip.dot(_q));
  pm[2] = _clip.x; pm[6] = _clip.y; pm[10] = _clip.z + 1 - 0.003; pm[14] = _clip.w;
}

export function DesertOasis() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const mesh = useRef<THREE.Mesh>(null);
  const hidden = useRef<{ list: THREE.Object3D[]; t: number }>({ list: [], t: 0 });

  const { geometry, material, rt, mirror, hm } = useMemo(() => {
    const hm = buildHeightmap();
    const geometry = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(OX, WATER_Y, OZ);
    const rt = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, depthBuffer: true });
    rt.texture.generateMipmaps = false;
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: sharedUniforms([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uSunDir: { value: new THREE.Vector3(...SUN_DIR) },
          uSunI: { value: 3 },
          uWaterY: { value: WATER_Y },
          uWind: { value: new THREE.Vector2(0.8, 0.6) },
          uHRect: { value: hm.rect },
          uReflOn: { value: 0 },
          uTexMat: { value: new THREE.Matrix4() },
        },
      ]),
    });
    // shared live objects (merge() would have cloned them)
    material.uniforms.uSunColor = { value: atm.sunColor };
    material.uniforms.uHMap = { value: hm.tex };
    material.uniforms.uRefl = { value: rt.texture };
    return { geometry, material, rt, mirror: new THREE.PerspectiveCamera(), hm };
  }, []);

  useEffect(() => () => { rt.dispose(); hm.tex.dispose(); material.dispose(); geometry.dispose(); }, [rt, hm, material, geometry]);

  useFrame((state) => {
    const u = material.uniforms;
    u.uTime.value = state.clock.elapsedTime;
    u.uSunI.value = atm.sunIntensity;
    const cam = state.camera as THREE.PerspectiveCamera;
    const m = mesh.current;
    const near = Math.hypot(cam.position.x - OX, cam.position.z - OZ) < REFLECT_DIST && cam.position.y > WATER_Y + 0.05;
    u.uReflOn.value = 0;
    if (!m || !near || !cam.isPerspectiveCamera) return;

    gl.getDrawingBufferSize(_size);
    const w = Math.max(256, Math.round(_size.x * 0.5)), h = Math.max(128, Math.round(_size.y * 0.5));
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);

    // things that shouldn't show up in the water (grass: too costly; the first-person gun)
    const hd = hidden.current;
    if (state.clock.elapsedTime > hd.t) {
      hd.t = state.clock.elapsedTime + 2;
      hd.list = [];
      scene.traverse((o) => { if (o.userData.noReflect) hd.list.push(o); });
    }
    cam.updateMatrixWorld();
    updateMirror(cam, mirror, u.uTexMat.value);

    const prevRT = gl.getRenderTarget();
    const prevShadow = gl.shadowMap.autoUpdate;
    const prevVis = hd.list.map((o) => o.visible);
    m.visible = false;
    for (const o of hd.list) o.visible = false;
    gl.shadowMap.autoUpdate = false;
    gl.setRenderTarget(rt);
    gl.clear();
    gl.render(scene, mirror);
    gl.setRenderTarget(prevRT);
    gl.shadowMap.autoUpdate = prevShadow;
    hd.list.forEach((o, i) => { o.visible = prevVis[i]; });
    m.visible = true;
    u.uReflOn.value = 1;
  }, FRAME_PRIORITY);

  return (
    <>
      <mesh ref={mesh} geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />
      <OasisFlora />
    </>
  );
}

// ---------- reeds, cattails, lily pads ----------

function buildReedClump(seed: number) {
  const rnd = seededRandom(seed);
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.Color("#2f4a1a"), tip = new THREE.Color("#9aa850"), brown = new THREE.Color("#4a2c16"), stemC = new THREE.Color("#6f7a3a");
  const paint = (g: THREE.BufferGeometry, f: (y: number, c: THREE.Color) => void) => {
    const p = g.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) { f(p.getY(i), c); c.toArray(col, i * 3); }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  };
  const blades = 13 + Math.floor(rnd() * 6);
  for (let b = 0; b < blades; b++) {
    const H = 1.0 + rnd() * 1.3, W = 0.035 + rnd() * 0.03, seg = 5;
    const g = new THREE.PlaneGeometry(W, H, 1, seg);
    g.translate(0, H / 2, 0);
    const p = g.attributes.position;
    const lean = (rnd() * 2 - 1) * 0.35, bend = 0.15 + rnd() * 0.35;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i), k = y / H;
      p.setX(i, p.getX(i) * (1 - k * 0.92));
      p.setZ(i, bend * k * k * H * 0.4);
    }
    g.rotateZ(lean * 0.4);
    g.rotateY(rnd() * Math.PI * 2);
    const r = Math.sqrt(rnd()) * 0.32, a = rnd() * Math.PI * 2;
    g.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
    paint(g, (y, c) => c.copy(base).lerp(tip, Math.min(1, y / H) * (0.7 + rnd() * 0.3)));
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
  }
  const heads = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < heads; i++) {
    const H = 1.5 + rnd() * 0.7, r = Math.sqrt(rnd()) * 0.22, a = rnd() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const stem = new THREE.CylinderGeometry(0.007, 0.01, H, 4, 1, true).translate(x, H / 2, z);
    paint(stem, (_, c) => c.copy(stemC));
    const head = new THREE.CylinderGeometry(0.03, 0.03, 0.24, 7).translate(x, H - 0.12, z);
    paint(head, (_, c) => c.copy(brown));
    const spike = new THREE.CylinderGeometry(0.002, 0.005, 0.12, 3).translate(x, H + 0.06, z);
    paint(spike, (_, c) => c.copy(stemC));
    for (const g of [stem, head, spike]) parts.push(g.toNonIndexed());
  }
  return mergeGeometries(parts)!;
}

function buildLilyPad() {
  const g = new THREE.CircleGeometry(1, 22, 0.22, Math.PI * 2 - 0.22);
  g.rotateX(-Math.PI / 2);
  // dish the rim up a touch so the light catches it
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const r = Math.hypot(p.getX(i), p.getZ(i)); p.setY(i, r * r * 0.04); }
  g.computeVertexNormals();
  return g;
}

function buildFlower() {
  const parts: THREE.BufferGeometry[] = [];
  const white = new THREE.Color("#fff4f6"), core = new THREE.Color("#f2c230");
  const paint = (g: THREE.BufferGeometry, col: THREE.Color, tipCol?: THREE.Color) => {
    const pp = g.attributes.position, arr = new Float32Array(pp.count * 3), c = new THREE.Color();
    for (let i = 0; i < pp.count; i++) { c.copy(col); if (tipCol) c.lerp(tipCol, Math.min(1, pp.getY(i) / 0.1)); c.toArray(arr, i * 3); }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  };
  for (let ring = 0; ring < 2; ring++)
    for (let i = 0; i < 8; i++) {
      const g = new THREE.PlaneGeometry(0.05, 0.11);
      g.translate(0, 0.055, 0);
      g.rotateX(-(ring ? 0.55 : 1.0));
      g.rotateY((i / 8) * Math.PI * 2 + ring * 0.4);
      paint(g, white.clone().multiplyScalar(0.92), white);
      parts.push(g.toNonIndexed());
    }
  const c = new THREE.SphereGeometry(0.022, 6, 4).translate(0, 0.025, 0);
  paint(c, core);
  parts.push(c.toNonIndexed());
  for (const g of parts) g.deleteAttribute("uv");
  return mergeGeometries(parts)!;
}

function swayMaterial(m: THREE.MeshStandardMaterial, time: { value: number }) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          float sw = max(position.y, 0.0); sw *= sw;
          vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
          float ph = uTime * 1.5 + ip.x * 0.31 + ip.y * 0.23;
          float gust = 0.6 + 0.4 * sin(uTime * 0.35 + ip.x * 0.02);
          transformed.x += (sin(ph) * 0.05 + sin(ph * 2.7 + position.x * 9.0) * 0.012) * sw * gust;
          transformed.z += (cos(ph * 0.83) * 0.035) * sw * gust;
        }`,
      );
  };
  m.customProgramCacheKey = () => "oasis-sway";
  return m;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _qq = new THREE.Quaternion();
const _e = new THREE.Euler();
const _c = new THREE.Color();

function OasisFlora() {
  const time = useMemo(() => ({ value: 0 }), []);
  const built = useMemo(() => {
    const rnd = seededRandom(4471);
    const reedGeo = [buildReedClump(11), buildReedClump(12), buildReedClump(13)];
    const reedMat = swayMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85 }), time);
    const padMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.42, metalness: 0, side: THREE.DoubleSide });
    const flowerMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });

    const reeds: THREE.Matrix4[][] = [[], [], []];
    const pads: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const flowers: THREE.Matrix4[] = [];
    const S = 130, step = 1.05;
    for (let z = OZ - S / 2; z < OZ + S / 2; z += step)
      for (let x = OX - S / 2; x < OX + S / 2; x += step) {
        const jx = x + (rnd() - 0.5) * step, jz = z + (rnd() - 0.5) * step;
        const h = terrainHeight(jx, jz);
        const rock = oasisRockW(jx, jz);
        // reeds stand in the wet margin, from ankle-deep water to just above the line
        if (h > WATER_Y - 0.55 && h < WATER_Y + 0.22 && rock < 0.4) {
          const cl = noise2(jx * 0.07 + 3.3, jz * 0.07 - 1.1);
          if (cl > -0.15 && rnd() < 0.42 + cl * 0.5) {
            const sc = 0.75 + rnd() * 0.55;
            _m.compose(_p.set(jx, h - 0.05, jz), _qq.setFromEuler(_e.set((rnd() - 0.5) * 0.12, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.12)), _s.set(sc, sc * (0.85 + rnd() * 0.3), sc));
            reeds[Math.floor(rnd() * 3)].push(_m.clone());
          }
        }
        // lily pads cluster on the calm shallows
        const dep = WATER_Y - h;
        if (dep > 0.3 && dep < 2.1) {
          const cl = noise2(jx * 0.045 + 11, jz * 0.045 - 4);
          if (cl > 0.18 && rnd() < (cl - 0.18) * 2.2) {
            const n = 1 + Math.floor(rnd() * 2);
            for (let k = 0; k < n; k++) {
              const px = jx + (rnd() - 0.5) * 0.9, pz = jz + (rnd() - 0.5) * 0.9;
              if (WATER_Y - terrainHeight(px, pz) < 0.2) continue;
              const sc = 0.22 + rnd() * 0.32;
              _m.compose(_p.set(px, WATER_Y + 0.025 + rnd() * 0.01, pz), _qq.setFromEuler(_e.set(0, rnd() * Math.PI * 2, 0)), _s.set(sc, 1, sc));
              pads.push({ m: _m.clone(), c: _c.setHSL(0.24 + rnd() * 0.06, 0.45 + rnd() * 0.2, 0.17 + rnd() * 0.1).clone() });
              if (rnd() < 0.09) {
                const fs = 0.8 + rnd() * 0.5;
                _m.compose(_p.set(px + (rnd() - 0.5) * sc * 0.5, WATER_Y + 0.035, pz + (rnd() - 0.5) * sc * 0.5), _qq.setFromEuler(_e.set(0, rnd() * 6.28, 0)), _s.set(fs, fs, fs));
                flowers.push(_m.clone());
              }
            }
          }
        }
      }

    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, ms: THREE.Matrix4[], cols?: THREE.Color[]) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, ms.length));
      ms.forEach((m, i) => im.setMatrixAt(i, m));
      if (cols) cols.forEach((c, i) => im.setColorAt(i, c));
      im.count = ms.length;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.receiveShadow = true;
      return im;
    };
    const group = new THREE.Group();
    reeds.forEach((ms, i) => { const im = inst(reedGeo[i], reedMat, ms); im.castShadow = true; group.add(im); });
    group.add(inst(buildLilyPad(), padMat, pads.map((p) => p.m), pads.map((p) => p.c)));
    group.add(inst(buildFlower(), flowerMat, flowers));
    return { group, dispose: () => { group.traverse((o) => { const m = o as THREE.InstancedMesh; if (m.isInstancedMesh) { m.geometry.dispose(); m.dispose(); } }); reedMat.dispose(); padMat.dispose(); flowerMat.dispose(); } };
  }, [time]);

  useEffect(() => built.dispose, [built]);
  useFrame((state) => { time.value = state.clock.elapsedTime; });
  return <primitive object={built.group} />;
}
