// One big open world. Everything is analytic: heightAt(x, z) is computed on demand
// (no giant precomputed heightmap), so terrain chunks, props, player and shaders
// (through the ground window) all agree and only what is near the camera is paid for.
//
//            north (-z)   ICE AGE      lake, conifer forest, mountains
//                         ~~~ blend ~~~
//            centre       MEADOW       village, river, grassland
//                         ~~~ blend ~~~
//            south (+z)   DESERT       dunes, playa, oasis, ruins

export const WORLD_SIZE = 3200; // metres, square
export const WORLD_HALF = WORLD_SIZE / 2;
export const PLAY_LIMIT = WORLD_HALF - 40; // invisible walls

// Biome origins: each biome's height function runs in its own local coordinates.
export const ICE_Z0 = -1300;
export const DESERT_Z0 = 1300;

export type Biome = "meadow" | "ice" | "desert" | "nuke";
export type BiomeWeights = { meadow: number; ice: number; desert: number; nuke: number };

const norm3 = (v: number[]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** One sun for the whole world. */
export const SUN_DIR: [number, number, number] = norm3([0.6, 0.4, -0.66]);

// ---------- noise ----------
function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: number) {
  return mulberry32(seed);
}

/** Deterministic hash of integer cell coordinates -> [0,1). */
export function hash2(ix: number, iz: number, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const perm = (() => {
  const rand = mulberry32(1337);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return Uint8Array.from([...p, ...p]);
})();

const GX = [1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071];
const GY = [0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071];
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 2D gradient noise, roughly in [-1, 1]. */
export function noise2(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const X = xi & 255;
  const Y = yi & 255;
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const h = perm[perm[ix & 255] + (iy & 255)] & 7;
    return GX[h] * dx + GY[h] * dy;
  };
  const u = fade(xf);
  const v = fade(yf);
  return (
    lerp(
      lerp(g(X, Y, xf, yf), g(X + 1, Y, xf - 1, yf), u),
      lerp(g(X, Y + 1, xf, yf - 1), g(X + 1, Y + 1, xf - 1, yf - 1), u),
      v,
    ) * 1.41
  );
}

export function fbm(x: number, y: number, octaves: number) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(fx, fy) * amp;
    norm += amp;
    amp *= 0.5;
    // rotate + scale each octave to hide the lattice
    const nx = fx * 1.6 - fy * 1.2;
    const ny = fx * 1.2 + fy * 1.6;
    fx = nx;
    fy = ny;
  }
  return sum / norm;
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Large-scale colour patch factor (0..1). Mirrored in the grass shader. */
export function patchAt(x: number, z: number) {
  const a = Math.sin(x * 0.07 + 1.3) * Math.sin(z * 0.06 + 0.4);
  const b = Math.sin(x * 0.19 + 2.1) * Math.sin(z * 0.23 + 1.7);
  return Math.min(1, Math.max(0, a * 0.35 + b * 0.15 + 0.5));
}

// ---------- biomes ----------
/** Biome blend weights (sum to 1). The boundary is warped so it never reads as a straight line. */
export function biomeWeights(x: number, z: number, out: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 }) {
  const p = z + fbm(x * 0.0012 + 5.5, z * 0.0012 - 2.2, 2) * 220;
  const ice = 1 - smooth(-950, -550, p);
  const desert = smooth(550, 950, p);
  out.ice = ice;
  const px = x + fbm(x * 0.0013 - 3.1, z * 0.0013 + 8.4, 2) * 200;
  const rest = Math.max(0, 1 - ice - desert);
  const nuke = smooth(640, 960, px) * rest;
  out.ice = ice;
  out.desert = desert;
  out.nuke = nuke;
  out.meadow = Math.max(0, rest - nuke);
  return out;
}

export function dominantBiome(x: number, z: number): Biome {
  const w = biomeWeights(x, z);
  return w.ice > 0.5 ? "ice" : w.desert > 0.5 ? "desert" : w.nuke > 0.5 ? "nuke" : "meadow";
}

// ---------- river (meadow) ----------
// A meandering river flowing west -> east across the whole meadow band.
export const WATER_Y = 0;
const RIVER_Z0 = -62;

export function riverCenterZ(x: number) {
  return RIVER_Z0 + 30 * Math.sin(x * 0.008 + 0.5) + 12 * Math.sin(x * 0.023 + 1.1) + 4 * Math.sin(x * 0.061 + 0.3);
}

export function riverHalfWidth(x: number) {
  return 8 + 2.5 * Math.sin(x * 0.013 + 1.7) + 1.2 * Math.sin(x * 0.041);
}

/** Distance to the river centre line in units of the local half-width. */
export function riverT(x: number, z: number) {
  const slope =
    30 * 0.008 * Math.cos(x * 0.008 + 0.5) +
    12 * 0.023 * Math.cos(x * 0.023 + 1.1) +
    4 * 0.061 * Math.cos(x * 0.061 + 0.3);
  const d = Math.abs(z - riverCenterZ(x)) / Math.sqrt(1 + slope * slope);
  const wob = 1 + 0.2 * noise2(x * 0.045 + 7.1, z * 0.045 - 3.3) + 0.09 * noise2(x * 0.15, z * 0.15 + 9.7);
  return d / (riverHalfWidth(x) * wob);
}

/** 1 on the channel + sandy banks, fading to 0 on the meadow. */
export function riverMask(x: number, z: number) {
  if (Math.abs(z - riverCenterZ(x)) > 60) return 0;
  return 1 - smooth(1.3, 2.4, riverT(x, z));
}

function meadowHeight(x: number, z: number) {
  const r = Math.hypot(x, z);
  const spawn = smooth(25, 170, r); // village at the origin stays gentle
  const big = fbm(x * 0.0016 + 31.7, z * 0.0016 - 12.3, 3) * 26;
  const mid = fbm(x * 0.006, z * 0.006, 4) * 7;
  const small = fbm(x * 0.03, z * 0.03, 2) * 0.35;
  const h0 = (big + mid) * (0.12 + 0.88 * spawn) + small;

  if (Math.abs(z - riverCenterZ(x)) > 140) return h0;
  const t = riverT(x, z);
  if (t > 9) return h0;
  const floor = 0.5 + noise2(x * 0.05, z * 0.05) * 0.2;
  let h = h0 + (floor - h0) * (1 - smooth(1.5, 9, t));
  const channel = 1 - smooth(0.9, 1.7, t);
  const pool = 0.5 + 0.5 * noise2(x * 0.022 + 2.2, z * 0.022 + 5.5);
  const bed = -(0.35 + 1.15 * pool) * (1 - smooth(0.05, 1.0, t)) - 0.04;
  h += (bed - h) * channel;
  return h;
}

// ---------- ice age (north) ----------
export const ICE_Y = 0; // frozen surface level
const LAKE_X = -70;
const LAKE_Z = -100 + ICE_Z0;
const LAKE_R = 68;

/** Distance from the lake centre in units of the (wobbly, elongated) lake radius. */
export function lakeT(x: number, z: number) {
  const dx = x - LAKE_X;
  const dz = (z - LAKE_Z) * 1.25;
  const a = Math.atan2(dz, dx);
  const wob = 1 + 0.18 * noise2(Math.cos(a) * 1.4 + 11, Math.sin(a) * 1.4 + 3) + 0.08 * noise2(Math.cos(a) * 4.5 + 1, Math.sin(a) * 4.5 + 7);
  return Math.hypot(dx, dz) / (LAKE_R * wob);
}
export const LAKE_CENTER: [number, number] = [LAKE_X, LAKE_Z];
export function lakeMask(x: number, z: number) {
  if (Math.abs(x - LAKE_X) > 160 || Math.abs(z - LAKE_Z) > 200) return 0;
  return 1 - smooth(1.0, 1.5, lakeT(x, z));
}

function iceHeight(x: number, wz: number) {
  const z = wz - ICE_Z0; // local coordinates
  let rolling = fbm(x * 0.004 + 9, z * 0.004 - 4, 4) * 16 + fbm(x * 0.013, z * 0.013 + 5, 3) * 4;
  if (rolling < 0) rolling *= 0.2;
  const rid = 1 - Math.abs(noise2(x * 0.007 + 3, z * 0.007 + 8));
  const ridge = rid * rid * rid * 16;
  const drift = fbm(x * 0.03, z * 0.012, 2) * 0.7 + fbm(x * 0.2, z * 0.2, 2) * 0.07;
  let h = 4 + rolling + ridge;

  // mountain range along the far north and the east / west flanks
  const m = Math.max(smooth(1150, 1500, Math.abs(x)), smooth(-1470, -1600, wz));
  if (m > 0) {
    const pk = 1 - Math.abs(fbm(x * 0.012 + 40, wz * 0.012 + 11, 4));
    h += m * (30 + 190 * pk * pk);
  }

  const t = lakeT(x, wz);
  let channel = 0;
  if (t < 2.4) {
    const shore = 0.35 + noise2(x * 0.08, z * 0.08) * 0.12;
    h += (shore - h) * (1 - smooth(1.05, 2.4, t));
    channel = 1 - smooth(0.82, 1.04, t);
    const bed = -2.6 * (1 - smooth(0.3, 1.0, t)) - 0.2;
    h += (bed - h) * channel;
  }
  return h + drift * (1 - channel);
}

// ---------- desert (south) ----------
const OASIS_X = -105;
const OASIS_Z = 125 + DESERT_Z0;
const OASIS_R = 32;
/** Direction (from the pond centre, radians in the xz plane) of the sandstone outcrop on the far bank. */
export const OASIS_ROCK_A = 2.35;
const PLAYA_X = 120;
const PLAYA_Z = -120 + DESERT_Z0;
const PLAYA_R = 75;
export const OASIS_CENTER: [number, number] = [OASIS_X, OASIS_Z];
export const PLAYA_CENTER: [number, number] = [PLAYA_X, PLAYA_Z];

function blobT(x: number, z: number, cx: number, cz: number, R: number, seed: number) {
  const dx = x - cx;
  const dz = z - cz;
  const a = Math.atan2(dz, dx);
  const wob = 1 + 0.2 * noise2(Math.cos(a) * 1.3 + seed, Math.sin(a) * 1.3 + 5) + 0.08 * noise2(Math.cos(a) * 4 + 3, Math.sin(a) * 4 + seed);
  return Math.hypot(dx, dz) / (R * wob);
}
export const oasisT = (x: number, z: number) => blobT(x, z, OASIS_X, OASIS_Z, OASIS_R, 21);
export const playaT = (x: number, z: number) => blobT(x, z, PLAYA_X, PLAYA_Z, PLAYA_R, 8);
export const oasisMask = (x: number, z: number) => (Math.abs(x - OASIS_X) > 120 || Math.abs(z - OASIS_Z) > 120 ? 0 : 1 - smooth(0.9, 1.1, oasisT(x, z)));
export const OASIS_RADIUS = OASIS_R;
/** 0..1 weight of the sandstone outcrop that rises from the water on one side of the oasis. */
export function oasisRockW(x: number, z: number) {
  let d = Math.atan2(z - OASIS_Z, x - OASIS_X) - OASIS_ROCK_A;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.exp(-(d * d) / (0.5 * 0.5));
}
/** The assassins' mud huts on the oasis bank: centre, door yaw (facing the pond), wall radius. */
export const OASIS_HUTS: { x: number; z: number; yaw: number; r: number }[] = [
  { a: 0.95, t: 1.5, r: 2.6 },
  { a: 4.55, t: 1.48, r: 2.3 },
].map(({ a, t, r }) => {
  const wob = 1 + 0.2 * noise2(Math.cos(a) * 1.3 + 21, Math.sin(a) * 1.3 + 5) + 0.08 * noise2(Math.cos(a) * 4 + 3, Math.sin(a) * 4 + 21);
  const d = t * OASIS_R * wob;
  const x = OASIS_X + Math.cos(a) * d, z = OASIS_Z + Math.sin(a) * d;
  return { x, z, yaw: Math.atan2(OASIS_X - x, OASIS_Z - z), r };
});
/** Distance past the nearest hut wall (negative inside); big when far from the huts. */
export function oasisHutGap(x: number, z: number) {
  let g = 1e9;
  for (const h of OASIS_HUTS) g = Math.min(g, Math.hypot(x - h.x, z - h.z) - h.r);
  return g;
}
/** Lush ring around the oasis: grass grows here (fed into the ground window's meadow channel). */
export function oasisGreen(x: number, z: number) {
  if (Math.abs(x - OASIS_X) > 160 || Math.abs(z - OASIS_Z) > 160) return 0;
  const t = oasisT(x, z);
  if (t > 2.6) return 0;
  const patchy = 0.75 + 0.5 * noise2(x * 0.06 + 3, z * 0.06 - 8);
  const ring = smooth(0.93, 1.06, t) * (1 - smooth(1.2 + 0.2 * noise2(x * 0.03, z * 0.03 + 2), 1.65, t));
  const trodden = smooth(0.4, 2.6, oasisHutGap(x, z)); // bare packed earth in and around the huts
  return Math.max(0, Math.min(1, ring * patchy)) * (1 - oasisRockW(x, z) * smooth(0.9, 1.2, t) * 0.95) * trodden;
}
export const playaMask = (x: number, z: number) => (Math.abs(x - PLAYA_X) > 200 || Math.abs(z - PLAYA_Z) > 200 ? 0 : 1 - smooth(0.95, 1.35, playaT(x, z)));

/** Sawtooth-ish dune cross-section: long rise, crest, short steep fall. */
function duneProfile(p: number) {
  const s = p - Math.floor(p);
  const k = 0.74;
  if (s < k) return Math.pow(s / k, 1.35);
  const u = (s - k) / (1 - k);
  return (1 - u) * (1 - u);
}

function desertHeight(x: number, wz: number) {
  const z = wz - DESERT_Z0; // local coordinates
  const wx = 0.82;
  const wzd = 0.57;
  const u = x * wx + z * wzd;
  const v = -x * wzd + z * wx;
  const warp = fbm(x * 0.004 + 3, z * 0.004 + 9, 3) * 70 + fbm(x * 0.013, z * 0.013, 2) * 9 + noise2(v * 0.008 + 4, 1.7) * 45;
  const amp = 5.5 + 7 * (fbm(x * 0.0028 + 11, z * 0.0028 - 5, 2) * 0.5 + 0.5);
  const big = duneProfile((u + warp) / 120) * amp;
  const mid = duneProfile((u * 0.92 - v * 0.4 + warp * 0.8) / 42 + 0.37) * (1.1 + 1.6 * (fbm(x * 0.006, z * 0.006 + 4, 2) * 0.5 + 0.5));
  const small = fbm(x * 0.045, z * 0.045, 2) * 0.22;
  let h = 3 + (big + mid) * 0.95 + small;

  // flat hazy horizon at the south edge
  const e = Math.max(Math.abs(x), Math.abs(wz));
  h += (1.0 - h) * smooth(1450, 1580, e);

  const pt = playaT(x, wz);
  if (pt < 1.5) h += (0.5 + noise2(x * 0.05, z * 0.05) * 0.05 - h) * (1 - smooth(0.9, 1.5, pt));

  const ot = oasisT(x, wz);
  if (ot < 2.8) {
    // a gently shelving beach that rises to low banks, then the dunes take over again
    const bank = 0.55 + 0.45 * smooth(1.0, 2.2, ot) + noise2(x * 0.08, z * 0.08) * 0.1;
    h += (bank - h) * (1 - smooth(1.3, 2.8, ot));
    // the pond: a shallow sandy shelf, then a deep spring in the middle
    const channel = 1 - smooth(0.72, 1.0, ot);
    const bed = -0.15 - 1.0 * (1 - smooth(0.55, 0.98, ot)) - 2.6 * (1 - smooth(0.05, 0.6, ot)) + noise2(x * 0.11, z * 0.11) * 0.18;
    h += (bed - h) * channel;
    // sandstone outcrop on the far bank: ledges stepping up out of the water
    const rw = oasisRockW(x, wz);
    if (rw > 0.01) {
      const crag = fbm(x * 0.07 + 5, z * 0.07 - 3, 3);
      const rise = smooth(0.84, 1.06 + crag * 0.06, ot) * (1 - smooth(1.45, 2.5, ot));
      let r = rw * rise * (6.5 + 3.5 * crag);
      const step = 1.4;
      const k = Math.floor(r / step);
      r = (k + smooth(0.55, 1.0, r / step - k)) * step; // terraces
      h = Math.max(h, h * (1 - rw * rise) + (0.5 + r) * rw * rise);
    }
  }
  return h;
}

// ---------- nuclear wasteland (east) ----------
export const NUKE_CX = 1260;
export const NUKE_CZ = 0;
/** Toxic pools: [x, z, radius] */
export const NUKE_POOLS: [number, number, number][] = [
  [1135, 175, 34], [1390, -190, 42], [1010, -240, 28], [1500, 150, 36], [1215, 330, 30],
];
/** 1 inside the flattened plant platform, fading out over ~90 m. */
export function nukePlatform(x: number, z: number) {
  const d = Math.hypot((x - NUKE_CX) / 1.15, z - NUKE_CZ);
  return 1 - smooth(210, 300, d);
}
/** 1 in the city-ruin district (north-east of the plant). */
export function nukeCity(x: number, z: number) {
  const d = Math.hypot(x - 1330, z + 400);
  return 1 - smooth(150, 230, d);
}
export function nukePoolT(x: number, z: number) {
  let t = 9;
  for (const [px, pz, r] of NUKE_POOLS) t = Math.min(t, Math.hypot(x - px, z - pz) / r);
  return t;
}
function nukeHeight(x: number, z: number) {
  const big = fbm(x * 0.002 + 70.1, z * 0.002 + 4.4, 3) * 14;
  const mid = fbm(x * 0.009 + 9, z * 0.009 - 2, 3) * 3.2;
  const small = fbm(x * 0.05, z * 0.05, 2) * 0.25;
  let h = 3 + big * 0.6 + mid + small;
  const plat = nukePlatform(x, z);
  const city = nukeCity(x, z);
  const flat = Math.max(plat, city * 0.97);
  h += (2.2 + small * 0.4 - h) * flat;
  const pt = nukePoolT(x, z);
  if (pt < 2) h += (-1.4 - h) * (1 - smooth(0.55, 1.9, pt)) + 0.0;
  return h;
}

// ---------- sub-zones (masks on top of the biomes) ----------
/** Neo-city carved into the south-east desert. */
export const VILLAGE = { x: 330, z: 280, r: 140, y: 3 };
const _zw: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };

/** 1 inside the western jungle (a warped band on the far-west meadow), 0 elsewhere. */
export function jungleT(x: number, z: number) {
  const w = biomeWeights(x, z, _zw);
  if (w.meadow < 0.01) return 0;
  const px = x + fbm(x * 0.0021 + 11.3, z * 0.0021 + 2.7, 2) * 130;
  return w.meadow * (1 - smooth(-900, -640, px));
}

/** 1 inside the village clearing, soft edge. */
export function villageT(x: number, z: number) {
  const dx = x - VILLAGE.x, dz = z - VILLAGE.z;
  if (Math.abs(dx) > VILLAGE.r * 1.4 || Math.abs(dz) > VILLAGE.r * 1.4) return 0;
  const warp = fbm(x * 0.01 + 1.9, z * 0.01 - 6.1, 2) * 8;
  const d = Math.hypot(dx, dz) + warp;
  const w = biomeWeights(x, z, _zw);
  return Math.min(1, w.meadow * 1.3) * (1 - smooth(VILLAGE.r * 0.8, VILLAGE.r, d));
}

/** "Domain of the Faceless": the sorcerers' walled hamlet on the east shore of the frozen lake. */
export const FACELESS = { x: 85, z: -1400, r: 50, fence: 40, y: 7 };

/** 1 inside the Faceless clearing (flattened, no streamed props), soft edge. */
export function facelessT(x: number, z: number) {
  const dx = x - FACELESS.x, dz = z - FACELESS.z;
  if (Math.abs(dx) > FACELESS.r * 1.3 || Math.abs(dz) > FACELESS.r * 1.3) return 0;
  const d = Math.hypot(dx, dz) + fbm(x * 0.02 - 3.3, z * 0.02 + 8.1, 2) * 4;
  return 1 - smooth(FACELESS.r * 0.85, FACELESS.r * 1.15, d);
}

/** Flattened airstrips (planes): centre line x0,z0 -> x1,z1, half-width hw, surface height stations ys. */
export const RUNWAYS = [
  { id: "north", x0: 70, z0: -1290, x1: 530, z1: -1290, hw: 12, ys: [17.1, 15.7, 16.4, 14.1, 16.3, 14.4] },
  { id: "desert", x0: 130, z0: 1417.3, x1: 350, z1: 1036.3, hw: 12, ys: [3.6, 4.2, 4.2, 4.2, 6.1, 6.6] },
];
const RW_EDGE = 22;
let rwY = 0;
/** 1 on an airstrip (flattened, no streamed props), soft shoulders; also leaves the strip height in rwY. */
export function runwayT(x: number, z: number) {
  let best = 0;
  for (const r of RUNWAYS) {
    const dx = r.x1 - r.x0, dz = r.z1 - r.z0, L2 = dx * dx + dz * dz;
    const t = Math.min(1, Math.max(0, ((x - r.x0) * dx + (z - r.z0) * dz) / L2));
    const d = Math.hypot(x - r.x0 - dx * t, z - r.z0 - dz * t);
    if (d > r.hw + RW_EDGE) continue;
    const m = 1 - smooth(r.hw, r.hw + RW_EDGE, d);
    if (m <= best) continue;
    best = m;
    const f = t * (r.ys.length - 1), i = Math.min(r.ys.length - 2, Math.floor(f)), u = f - i;
    rwY = r.ys[i] + (r.ys[i + 1] - r.ys[i]) * u * u * (3 - 2 * u);
  }
  return best;
}

// ---------- the world ----------
const _w: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };

/** Raw terrain surface (includes the lake bed under the ice). Used for meshes and shaders. */
export function terrainHeight(x: number, z: number) {
  const w = biomeWeights(x, z, _w);
  let h = 0;
  if (w.meadow > 0.001) h += meadowHeight(x, z) * w.meadow;
  if (w.ice > 0.001) h += iceHeight(x, z) * w.ice;
  if (w.desert > 0.001) h += desertHeight(x, z) * w.desert;
  if (w.nuke > 0.001) h += nukeHeight(x, z) * w.nuke;
  const j = jungleT(x, z);
  if (j > 0.001) h += (fbm(x * 0.012 + 40, z * 0.012 + 9, 3) * 7 + fbm(x * 0.04, z * 0.04 + 3, 2) * 1.2) * j;
  const c = villageT(x, z);
  if (c > 0.001) h += (VILLAGE.y - h) * smooth(0.0, 0.55, c);
  const f = facelessT(x, z);
  if (f > 0.001) h += (FACELESS.y + fbm(x * 0.05, z * 0.05, 2) * 0.25 - h) * smooth(0.0, 0.6, f);
  const rw = runwayT(x, z);
  if (rw > 0.001) h += (rwY + fbm(x * 0.05, z * 0.05, 2) * 0.04 - h) * smooth(0.0, 0.7, rw);
  return h;
}

/** Height you walk on: terrain, but on top of the frozen lake surface. */
export function heightAt(x: number, z: number) {
  const h = terrainHeight(x, z);
  return lakeMask(x, z) > 0 ? Math.max(h, ICE_Y) : h;
}

/** 1 on water (river / frozen lake / oasis), fading to 0 on land. */
export function waterMask(x: number, z: number) {
  return Math.max(riverMask(x, z) * (1 - biomeWeights(x, z, _w).nuke), lakeMask(x, z), oasisMask(x, z));
}

/** Depth of actual water at (x, z): 0 on dry ground, even where the terrain dips below WATER_Y
 *  (meadow noise makes plenty of dry hollows under 0 that have no water drawn in them). */
/** Below the water line *and* where water actually is (dry hollows below WATER_Y are land). */
export function wetAt(x: number, z: number, margin = 0) {
  return heightAt(x, z) < WATER_Y + margin && waterMask(x, z) > 0.35;
}

export function waterDepth(x: number, z: number) {
  const d = WATER_Y - heightAt(x, z);
  if (d <= 0) return 0;
  return waterMask(x, z) > 0.35 ? d : 0;
}

/** Slope (rise over run) from a central difference. */
export function slopeAt(x: number, z: number, d = 1.5) {
  const dx = terrainHeight(x + d, z) - terrainHeight(x - d, z);
  const dz = terrainHeight(x, z + d) - terrainHeight(x, z - d);
  return Math.hypot(dx, dz) / (2 * d);
}
