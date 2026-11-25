import * as THREE from "three";
import { WATER_Y, fbm, lakeMask, noise2, nukeCity, nukePlatform, nukePoolT, oasisGreen, oasisRockW, oasisT, patchAt, playaMask, riverMask, jungleT, villageT, runwayT, type BiomeWeights } from "./terrain";

// Per-vertex ground colour for each biome, blended by the biome weights.
// The meadow colours stay close to the grass shader so blades melt into the ground.

const sm = THREE.MathUtils.smoothstep;

// meadow
const SOIL = new THREE.Color("#25360f");
const GRASS = new THREE.Color("#3d6a1c");
const DRY = new THREE.Color("#8f8c3e");
const ROCK = new THREE.Color("#6b6355");
const BANK = new THREE.Color("#a09068");
const WET = new THREE.Color("#5e553f");
const BED = new THREE.Color("#3a352b");

// ice
const SNOW = new THREE.Color("#eef4fb");
const HOLLOW = new THREE.Color("#b9cde4");
const WIND = new THREE.Color("#f7f3ec");
const ROCK_A = new THREE.Color("#4a4c55");
const ROCK_B = new THREE.Color("#6b665f");
const GLACIER = new THREE.Color("#8fc3e2");
const SHORE = new THREE.Color("#c4d8ea");

// desert
const SAND = new THREE.Color("#e8b86a");
const SAND_PALE = new THREE.Color("#f2cf8f");
const SAND_WARM = new THREE.Color("#d38a45");
const SAND_RED = new THREE.Color("#c27a45");
const DARK_MINERAL = new THREE.Color("#7a5238");
const CLAY = new THREE.Color("#dccaa6");
const DAMP = new THREE.Color("#a98458");
const GREEN = new THREE.Color("#4f5a22");
const WET_SAND = new THREE.Color("#6e5434");
const SANDSTONE = new THREE.Color("#b5653a");
const SANDSTONE_B = new THREE.Color("#d48b55");
const STRATA = ["#b5653a", "#d08a52", "#94502f", "#e0b078", "#a35a35", "#c4824e"].map((c) => new THREE.Color(c));

// nuclear wasteland
const ASH = new THREE.Color("#2a2a23");
const ASH_PALE = new THREE.Color("#38372c");
const DEAD = new THREE.Color("#23221a");
const SCORCH = new THREE.Color("#0c0b08");
const CONCRETE = new THREE.Color("#3f3f3a");
const ASPHALT = new THREE.Color("#101112");
const TOXIC = new THREE.Color("#7fa21c");
const TOXIC_DEEP = new THREE.Color("#31440f");
const RUSTY = new THREE.Color("#6e4a2c");

const JUNGLE = new THREE.Color("#2e5a1a");
const JUNGLE_LIGHT = new THREE.Color("#4a8a2a");
const MUD = new THREE.Color("#3a2f1c");
const VILLAGE_DIRT = new THREE.Color("#6b5a3e");
const VILLAGE_DIRT_B = new THREE.Color("#85724f");
const RUNWAY_A = new THREE.Color("#4a4844");
const RUNWAY_B = new THREE.Color("#5c5a55");
const jc = new THREE.Color();
const cc = new THREE.Color();
const rock = new THREE.Color();

function meadowColor(x: number, y: number, z: number, slope: number, c: THREE.Color) {
  const patch = patchAt(x, z);
  const meadow = fbm(x * 0.012, z * 0.012, 3) * 0.5 + 0.5;
  c.copy(GRASS).lerp(DRY, patch * 0.4).lerp(SOIL, meadow * 0.35);
  c.lerp(ROCK, sm(slope, 0.12, 0.35));
  const bank = riverMask(x, z);
  if (bank > 0) {
    const grain = fbm(x * 0.35, z * 0.35, 2) * 0.5 + 0.5;
    c.lerp(BANK, sm(bank + (grain - 0.5) * 0.45, 0.12, 0.65));
    c.lerp(BANK, 0.25 * grain);
    c.lerp(WET, 1 - sm(y - WATER_Y, 0.0, 0.35));
    c.lerp(BED, sm(WATER_Y - y, 0.1, 0.8));
  }
}

function iceColor(x: number, y: number, z: number, slope: number, c: THREE.Color) {
  const hollow = fbm(x * 0.02 + 5, z * 0.02, 3) * 0.5 + 0.5;
  const scour = fbm(x * 0.05 + z * 0.012, z * 0.014 - x * 0.004, 3) * 0.5 + 0.5;
  c.copy(SNOW).lerp(HOLLOW, (1 - hollow) * 0.38).lerp(WIND, sm(scour, 0.55, 0.9) * 0.5);
  const grit = fbm(x * 0.09, z * 0.09, 3);
  const rockiness = sm(slope + grit * 0.09 + Math.max(0, y - 70) / 500, 0.17, 0.4);
  rock.copy(ROCK_A).lerp(ROCK_B, sm(grit, -0.2, 0.4));
  c.lerp(rock, rockiness);
  const gl = sm(fbm(x * 0.006 + 80, z * 0.006 + 20, 3), 0.05, 0.35) * (1 - rockiness) * sm(y, 14, 45);
  const streak = 0.55 + 0.45 * (fbm(x * 0.1 + z * 0.02, z * 0.012, 2) * 0.5 + 0.5);
  c.lerp(GLACIER, gl * streak * 0.85);
  c.lerp(SHORE, lakeMask(x, z) * 0.7);
}

/** Returns the playa (dry lakebed) amount. */
function desertColor(x: number, y: number, z: number, slope: number, c: THREE.Color) {
  const tone = fbm(x * 0.012 + 3, z * 0.012 - 8, 3) * 0.5 + 0.5;
  const patch = fbm(x * 0.045, z * 0.045 + 6, 2) * 0.5 + 0.5;
  c.copy(SAND).lerp(SAND_PALE, sm(tone, 0.5, 0.85) * 0.7).lerp(SAND_WARM, sm(1 - tone, 0.45, 0.9) * 0.55);
  c.lerp(SAND_RED, sm(patch, 0.62, 0.9) * 0.28);
  const streak = fbm(x * 0.018 + z * 0.052, z * 0.018 - x * 0.036, 3);
  c.lerp(DARK_MINERAL, sm(streak, 0.28, 0.5) * 0.3);

  const grit = fbm(x * 0.06, z * 0.06, 3);
  const band = (y + grit * 4) / 9;
  const bi = Math.floor(band);
  const n = STRATA.length;
  rock.copy(STRATA[((bi % n) + n) % n]);
  rock.lerp(STRATA[(((bi + 1) % n) + n) % n], sm(band - bi, 0.7, 1));
  rock.multiplyScalar(0.82 + 0.3 * (noise2(x * 0.5, y * 0.9 + z * 0.5) * 0.5 + 0.5));
  c.lerp(rock, sm(slope + grit * 0.1 + Math.max(0, y - 30) / 400, 0.1, 0.3));

  const pm = playaMask(x, z);
  if (pm > 0) c.lerp(CLAY, pm * 0.9);

  const ot = oasisT(x, z);
  if (ot < 2.8) {
    const rk = oasisRockW(x, z) * sm(ot, 0.85, 1.1) * (1 - sm(ot, 1.5, 2.5));
    // sandstone outcrop: warm layered rock on the faces, wind-blown sand on the ledges
    const face = sm(slope, 0.12, 0.3) * rk;
    rock.copy(SANDSTONE).lerp(SANDSTONE_B, sm(Math.sin(y * 2.3 + grit * 3), -0.3, 0.8) * 0.6);
    c.lerp(rock, face * 0.85);
    c.lerp(DAMP, (1 - sm(ot, 0.95, 1.4)) * (1 - face));
    c.lerp(WET_SAND, (1 - sm(y - WATER_Y, 0.02, 0.4)) * (1 - face) * 0.8); // dark wet line at the waterline
    c.lerp(GREEN, oasisGreen(x, z) * 0.8 * (1 - face));
  }
  return pm;
}

function nukeColor(x: number, y: number, z: number, slope: number, c: THREE.Color) {
  const tone = fbm(x * 0.01 + 40, z * 0.01 - 6, 3) * 0.5 + 0.5;
  const fine = fbm(x * 0.08, z * 0.08, 2) * 0.5 + 0.5;
  c.copy(ASH).lerp(ASH_PALE, sm(tone, 0.45, 0.85) * 0.7).lerp(DEAD, sm(1 - tone, 0.5, 0.9) * 0.6);
  c.lerp(SCORCH, sm(fine, 0.62, 0.95) * 0.35);
  c.lerp(RUSTY, sm(fbm(x * 0.02 - 9, z * 0.02 + 3, 2), 0.35, 0.7) * 0.25);
  c.lerp(ROCK, sm(slope, 0.18, 0.45) * 0.7);
  // concrete apron under the plant + asphalt roads
  const plat = nukePlatform(x, z);
  const apron = sm(plat, 0.55, 0.95);
  c.lerp(CONCRETE, apron * (0.55 + 0.25 * fine));
  const city = nukeCity(x, z);
  c.lerp(ASPHALT, sm(city, 0.4, 0.8) * 0.8);
  // roads: grid in the city, main road east-west towards the plant
  const road = Math.max(roadMask(x, z), 0);
  c.lerp(ASPHALT, road * 0.9 * (0.8 + 0.2 * fine));
  // toxic pools
  const pt = nukePoolT(x, z);
  if (pt < 2.2) {
    c.lerp(TOXIC_DEEP, 1 - sm(pt, 1.0, 2.2));
    c.lerp(TOXIC, (1 - sm(pt, 0.5, 1.15)) * (0.6 + 0.4 * fine));
  }
}

/** 0..1: asphalt road network (main road + city grid). */
export function roadMask(x: number, z: number) {
  // main road: from the meadow border through the plant gate
  const wob = Math.sin(x * 0.01) * 6;
  const main = 1 - sm(Math.abs(z - 40 - wob), 3.5, 5.2);
  const along = sm(x, 780, 900) * (1 - sm(x, 1500, 1580));
  // road to the city
  const toCity = 1 - sm(Math.abs(x - 1290 - Math.sin(z * 0.012) * 5), 3.5, 5.2);
  const cz = sm(-z, 130, 190) * (1 - sm(-z, 430, 470));
  // city grid
  const city = nukeCity(x, z);
  const gx = 1 - sm(Math.abs(((x - 1330 + 1000) % 60) - 30), 11, 13);
  const gz = 1 - sm(Math.abs(((z + 400 + 1000) % 60) - 30), 11, 13);
  return Math.max(main * along, toCity * cz, Math.max(gx, gz) * city * 0.9) * (1 - nukePoolT(x, z) * 0 );
}

const cm = new THREE.Color();
const ci = new THREE.Color();
const cd = new THREE.Color();
const cn = new THREE.Color();

/** Blend the three biome palettes. Returns the playa amount (for the cracked-clay shader). */
export function terrainColor(x: number, y: number, z: number, slope: number, w: BiomeWeights, out: THREE.Color) {
  let playa = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  if (w.meadow > 0.003) {
    meadowColor(x, y, z, slope, cm);
    r += cm.r * w.meadow;
    g += cm.g * w.meadow;
    b += cm.b * w.meadow;
  }
  if (w.ice > 0.003) {
    iceColor(x, y, z, slope, ci);
    r += ci.r * w.ice;
    g += ci.g * w.ice;
    b += ci.b * w.ice;
  }
  if (w.desert > 0.003) {
    playa = desertColor(x, y, z, slope, cd);
    r += cd.r * w.desert;
    g += cd.g * w.desert;
    b += cd.b * w.desert;
  }
  if (w.nuke > 0.003) {
    nukeColor(x, y, z, slope, cn);
    r += cn.r * w.nuke;
    g += cn.g * w.nuke;
    b += cn.b * w.nuke;
  }
  const t = w.meadow + w.ice + w.desert + w.nuke || 1;
  out.setRGB(r / t, g / t, b / t);
  const j = jungleT(x, z);
  if (j > 0.01) {
    const n = fbm(x * 0.03 + 3, z * 0.03, 3) * 0.5 + 0.5;
    jc.copy(JUNGLE).lerp(JUNGLE_LIGHT, n * 0.5).lerp(MUD, sm(slope, 0.12, 0.4));
    out.lerp(jc, Math.min(1, j * 1.15));
  }
  const c = villageT(x, z);
  if (c > 0.01) {
    cc.copy(VILLAGE_DIRT).lerp(VILLAGE_DIRT_B, fbm(x * 0.2, z * 0.2, 2) * 0.5 + 0.5);
    out.lerp(cc, Math.min(1, c * 0.55));
    playa *= 1 - c;
  }
  const rw = runwayT(x, z);
  if (rw > 0.01) {
    cc.copy(RUNWAY_A).lerp(RUNWAY_B, fbm(x * 0.15, z * 0.15, 2) * 0.5 + 0.5);
    out.lerp(cc, sm(rw, 0.55, 0.9) * 0.9);
    playa *= 1 - rw;
  }
  return playa;
}
