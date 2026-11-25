import * as THREE from "three";
import { biomeWeights, oasisGreen, terrainHeight, waterMask, type BiomeWeights } from "./terrain";

// A toroidal "ground window": a small float texture holding (height, waterMask)
// for the ~640 m around the camera. The grass and water shaders sample it instead
// of a giant global heightmap. Texel (i, j) is stored at slot (i mod N, j mod N), so
// moving the window only recomputes the strip of cells that just came into range
// (time-sliced over a few frames) and never copies the rest.

export const GW_N = 256;
export const GW_CELL = 2.5; // metres per texel -> window spans 640 m
export const GW_VALID = 240; // shaders trust the window within this radius of its centre
const STEP = 12; // re-centre in 30 m steps
const BUDGET_MS = 2.5;

type Rect = { x0: number; x1: number; z0: number; z1: number; z: number };

const mod = (a: number) => ((a % GW_N) + GW_N) % GW_N;

class GroundWindow {
  data = new Float32Array(GW_N * GW_N * 4);
  texture: THREE.DataTexture;
  uniforms: { uGround: { value: THREE.DataTexture }; uGroundC: { value: THREE.Vector2 } };
  private x0 = 0; // committed range start (cells)
  private z0 = 0;
  private ready = false;
  private bw: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };
  private pending: Rect[] = [];
  private next: { x0: number; z0: number } | null = null;

  constructor() {
    this.texture = new THREE.DataTexture(this.data, GW_N, GW_N, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.needsUpdate = true;
    this.uniforms = { uGround: { value: this.texture }, uGroundC: { value: new THREE.Vector2() } };
  }

  private fill(r: Rect, deadline: number) {
    for (; r.z < r.z1; r.z++) {
      const sz = mod(r.z);
      for (let ix = r.x0; ix < r.x1; ix++) {
        const x = ix * GW_CELL;
        const z = r.z * GW_CELL;
        const o = (sz * GW_N + mod(ix)) * 4;
        const w = biomeWeights(x, z, this.bw);
        this.data[o] = terrainHeight(x, z);
        this.data[o + 1] = waterMask(x, z);
        this.data[o + 2] = w.desert > 0.5 ? Math.max(w.meadow, oasisGreen(x, z)) : w.meadow; // grass grows in the oasis ring too
        this.data[o + 3] = w.ice;
      }
      if (deadline && performance.now() > deadline) {
        r.z++;
        return false;
      }
    }
    return true;
  }

  private commit(x0: number, z0: number) {
    this.x0 = x0;
    this.z0 = z0;
    this.uniforms.uGroundC.value.set((x0 + GW_N / 2) * GW_CELL, (z0 + GW_N / 2) * GW_CELL);
    this.texture.needsUpdate = true;
  }

  /** Call every frame with the camera position. */
  update(px: number, pz: number) {
    const tx = Math.floor(px / GW_CELL / STEP) * STEP - GW_N / 2;
    const tz = Math.floor(pz / GW_CELL / STEP) * STEP - GW_N / 2;
    if (!this.ready) {
      this.fill({ x0: tx, x1: tx + GW_N, z0: tz, z1: tz + GW_N, z: tz }, 0);
      this.commit(tx, tz);
      this.ready = true;
      return;
    }
    if (!this.next && (tx !== this.x0 || tz !== this.z0)) {
      this.next = { x0: tx, z0: tz };
      const dx = tx - this.x0;
      const dz = tz - this.z0;
      if (Math.abs(dx) >= GW_N || Math.abs(dz) >= GW_N) {
        this.pending = [{ x0: tx, x1: tx + GW_N, z0: tz, z1: tz + GW_N, z: tz }];
      } else {
        const rects: Rect[] = [];
        if (dx > 0) rects.push({ x0: this.x0 + GW_N, x1: tx + GW_N, z0: tz, z1: tz + GW_N, z: tz });
        else if (dx < 0) rects.push({ x0: tx, x1: this.x0, z0: tz, z1: tz + GW_N, z: tz });
        if (dz > 0) rects.push({ x0: tx, x1: tx + GW_N, z0: this.z0 + GW_N, z1: tz + GW_N, z: this.z0 + GW_N });
        else if (dz < 0) rects.push({ x0: tx, x1: tx + GW_N, z0: tz, z1: this.z0, z: tz });
        this.pending = rects;
      }
    }
    if (this.next) {
      const deadline = performance.now() + BUDGET_MS;
      while (this.pending.length) {
        if (!this.fill(this.pending[0], deadline)) break;
        this.pending.shift();
      }
      if (!this.pending.length) {
        this.commit(this.next.x0, this.next.z0);
        this.next = null;
      }
    }
  }
}

export const ground = new GroundWindow();

/** GLSL: sampleGround(xz) -> (height, waterMask); groundH(xz) -> height. Needs `ground.uniforms`. */
export const GROUND_GLSL = /* glsl */ `
  uniform sampler2D uGround;
  uniform vec2 uGroundC;
  const float G_N = ${GW_N}.0;
  const float G_CELL = ${GW_CELL.toFixed(2)};
  const float G_VALID = ${GW_VALID}.0;
  vec4 gTex(ivec2 i) { return texelFetch(uGround, ivec2(mod(vec2(i), G_N)), 0); }
  float groundInside(vec2 xz) {
    vec2 e = abs(xz - uGroundC);
    return 1.0 - smoothstep(G_VALID - 40.0, G_VALID, max(e.x, e.y));
  }
  // (height, waterMask, meadowWeight, iceWeight)
  vec4 sampleGround4(vec2 xz) {
    vec2 q = xz / G_CELL;
    vec2 fl = floor(q);
    vec2 f = q - fl;
    ivec2 i = ivec2(fl);
    vec4 a = gTex(i), b = gTex(i + ivec2(1, 0)), c = gTex(i + ivec2(0, 1)), d = gTex(i + ivec2(1, 1));
    vec4 v = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    return mix(vec4(-4.0, 0.0, 0.0, 0.0), v, groundInside(xz));
  }
  vec2 sampleGround(vec2 xz) { return sampleGround4(xz).xy; }
  float groundH(vec2 xz) { return sampleGround(xz).x; }
`;
