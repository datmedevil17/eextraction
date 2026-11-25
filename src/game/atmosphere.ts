import * as THREE from "three";
import { biomeWeights, jungleT, SUN_DIR, type BiomeWeights } from "./terrain";
import { THEMES } from "./themes";

// Sky, fog and light are blended every frame from the biome weights under the
// camera, so walking from the meadow into the snow (or the dunes) shifts the whole
// look smoothly instead of switching maps. Everything here is shared, live state:
// the sky dome, water shaders, fog and lights all read the same objects.

const col = (hex: string) => new THREE.Color(hex);
const T = {
  meadow: { ...THEMES.meadow, h: col(THEMES.meadow.horizon), z: col(THEMES.meadow.zenith), s: col(THEMES.meadow.sunColor), hs: col(THEMES.meadow.hemi[0]), hg: col(THEMES.meadow.hemi[1]) },
  ice: { ...THEMES.ice, h: col(THEMES.ice.horizon), z: col(THEMES.ice.zenith), s: col(THEMES.ice.sunColor), hs: col(THEMES.ice.hemi[0]), hg: col(THEMES.ice.hemi[1]) },
  nuke: { ...THEMES.nuke, h: col(THEMES.nuke.horizon), z: col(THEMES.nuke.zenith), s: col(THEMES.nuke.sunColor), hs: col(THEMES.nuke.hemi[0]), hg: col(THEMES.nuke.hemi[1]) },
  desert: { ...THEMES.desert, h: col(THEMES.desert.horizon), z: col(THEMES.desert.zenith), s: col(THEMES.desert.sunColor), hs: col(THEMES.desert.hemi[0]), hg: col(THEMES.desert.hemi[1]) },
};

export const atm = {
  horizon: new THREE.Color(T.meadow.h),
  zenith: new THREE.Color(T.meadow.z),
  sunColor: new THREE.Color(T.meadow.s),
  hemiSky: new THREE.Color(T.meadow.hs),
  hemiGround: new THREE.Color(T.meadow.hg),
  hemiIntensity: 0.35,
  sunIntensity: 3.4,
  envIntensity: 0.6,
  bloom: 0.35,
  fog: 0.0022,
  w: { meadow: 1, ice: 0, desert: 0, nuke: 0 } as BiomeWeights,
};

/** Live uniform objects shared by the sky dome and every water shader. */
export const skyUniforms = {
  uSunDir: { value: new THREE.Vector3(...SUN_DIR) },
  uHorizon: { value: atm.horizon },
  uZenith: { value: atm.zenith },
  uIce: { value: 0 },
  uDry: { value: 0 },
};

const mix = (out: THREE.Color, k: "h" | "z" | "s" | "hs" | "hg", w: BiomeWeights) =>
  out.setRGB(
    T.meadow[k].r * w.meadow + T.ice[k].r * w.ice + T.desert[k].r * w.desert + T.nuke[k].r * w.nuke,
    T.meadow[k].g * w.meadow + T.ice[k].g * w.ice + T.desert[k].g * w.desert + T.nuke[k].g * w.nuke,
    T.meadow[k].b * w.meadow + T.ice[k].b * w.ice + T.desert[k].b * w.desert + T.nuke[k].b * w.nuke,
  );
const num = (k: "fog" | "sunIntensity" | "envIntensity" | "bloom", w: BiomeWeights) =>
  T.meadow[k] * w.meadow + T.ice[k] * w.ice + T.desert[k] * w.desert + T.nuke[k] * w.nuke;

const JH = col("#7f9a72");
const JZ = col("#3c6a4a");

export function updateAtmosphere(x: number, z: number) {
  const w = biomeWeights(x, z, atm.w);
  mix(atm.horizon, "h", w);
  mix(atm.zenith, "z", w);
  mix(atm.sunColor, "s", w);
  mix(atm.hemiSky, "hs", w);
  mix(atm.hemiGround, "hg", w);
  atm.hemiIntensity = T.meadow.hemi[2] * w.meadow + T.ice.hemi[2] * w.ice + T.desert.hemi[2] * w.desert + T.nuke.hemi[2] * w.nuke;
  atm.fog = num("fog", w);
  atm.sunIntensity = num("sunIntensity", w);
  atm.envIntensity = num("envIntensity", w);
  atm.bloom = num("bloom", w);
  // sub-zones: humid green haze in the jungle, dark neon dusk over the city
  const j = jungleT(x, z);
  if (j > 0.01) {
    atm.horizon.lerp(JH, j * 0.7);
    atm.zenith.lerp(JZ, j * 0.6);
    atm.fog += 0.0035 * j;
    atm.sunIntensity *= 1 - 0.35 * j;
    atm.hemiSky.lerp(JH, j * 0.4);
  }
  skyUniforms.uIce.value = w.ice;
  skyUniforms.uDry.value = w.desert;
}

import { ground } from "./groundWindow";

/**
 * Build a ShaderMaterial uniforms object. UniformsUtils.merge clones textures and
 * colours, which would detach them from the live shared state, so the shared
 * objects (sky colours, ground window) are attached after merging.
 */
export function sharedUniforms(parts: Parameters<typeof THREE.UniformsUtils.merge>[0]) {
  const u = THREE.UniformsUtils.merge(parts);
  u.uHorizon = skyUniforms.uHorizon;
  u.uZenith = skyUniforms.uZenith;
  u.uGround = ground.uniforms.uGround;
  u.uGroundC = ground.uniforms.uGroundC;
  return u;
}
