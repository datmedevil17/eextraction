"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import { Bloom, EffectComposer, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode, type BloomEffect } from "postprocessing";
import * as THREE from "three";
import { SUN_DIR } from "@/game/terrain";
import { atm, updateAtmosphere } from "@/game/atmosphere";
import { ground } from "@/game/groundWindow";
import { WorldTerrain } from "./WorldTerrain";
import { GrassField } from "./Grass";
import { SkyDome } from "./SkyDome";
import { IceLake } from "./IceLake";
import { DesertOasis } from "./DesertOasis";
import { Assassins } from "./Assassins";
import { OasisHuts } from "./OasisHuts";
import { Snowfall } from "./Snowfall";
import { Dust } from "./Dust";
import { River } from "./River";
import { Player } from "./Player";
import { Zombies } from "./Zombies";
import { Weapons } from "@/game/weapons/Weapons";
import { NuclearZone } from "./NuclearProps";
import { Dragons } from "./Dragons";
import { PropsStream, type Species } from "./propsStream";
import { meadowSpecies } from "./Props";
import { iceSpecies } from "./IceProps";
import { desertSpecies } from "./DesertProps";
import { jungleSpecies } from "./JungleProps";
import { Village } from "./Village";
import { Monsters } from "./Monsters";
import { Dinos } from "./Dinos";
import { Pteros } from "./Pteros";
import { Vehicles } from "./Vehicles";
import { Planes } from "./Planes";
import { Villagers } from "./Villagers";
import { Knights } from "./Knights";
import { FacelessVillage } from "./FacelessVillage";
import { Sorcerers } from "./Sorcerers";
import { FastTravel } from "./FastTravel";
import { FpsProbe } from "./FpsProbe";

const buildAll = (): Species[] => [...meadowSpecies(), ...iceSpecies(), ...desertSpecies(), ...jungleSpecies()];

/** Per-frame world state: ground window, blended atmosphere, fog, lights. Runs before everything else. */
function WorldDriver({ hemi, sun, bloom }: { hemi: React.RefObject<THREE.HemisphereLight | null>; sun: React.RefObject<THREE.DirectionalLight | null>; bloom: React.RefObject<BloomEffect | null> }) {
  const scene = useThree((s) => s.scene);
  useFrame(({ camera }) => {
    const p = camera.position;
    ground.update(p.x, p.z);
    updateAtmosphere(p.x, p.z);
    if (!scene.fog) scene.fog = new THREE.FogExp2(atm.horizon.getHex(), atm.fog);
    const fog = scene.fog as THREE.FogExp2;
    fog.color.copy(atm.horizon);
    fog.density = atm.fog;
    scene.environmentIntensity = atm.envIntensity;
    if (hemi.current) {
      hemi.current.color.copy(atm.hemiSky);
      hemi.current.groundColor.copy(atm.hemiGround);
      hemi.current.intensity = atm.hemiIntensity;
    }
    if (sun.current) {
      sun.current.color.copy(atm.sunColor);
      sun.current.intensity = atm.sunIntensity;
      sun.current.position.set(p.x + SUN_DIR[0] * 120, p.y + SUN_DIR[1] * 120, p.z + SUN_DIR[2] * 120);
      sun.current.target.position.copy(p);
      sun.current.target.updateMatrixWorld();
    }
    if (bloom.current) bloom.current.intensity = atm.bloom;
  }, -10);
  return null;
}

export function Scene() {
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const bloom = useRef<BloomEffect>(null);

  return (
    <>
      <WorldDriver hemi={hemi} sun={sun} bloom={bloom} />
      <SkyDome />

      {/* Image-based light baked once from the meadow sky; its strength follows the biome. */}
      <Environment resolution={256} frames={1}>
        <SkyDome envMode />
      </Environment>
      <hemisphereLight ref={hemi} />
      <directionalLight
        ref={sun}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-camera-near={1}
        shadow-camera-far={300}
        shadow-bias={-0.0004}
        shadow-normalBias={0.05}
      />

      <WorldTerrain />
      <GrassField />
      <River />
      <IceLake />
      <DesertOasis />
      <PropsStream build={buildAll} />
      <NuclearZone />
      <Village />
      <Villagers />
      <Knights />
      <Assassins />
      <OasisHuts />
      <FacelessVillage />
      <Sorcerers />
      <Dragons />
      <Snowfall />
      <Dust />
      <Player />
      <Zombies />
      <Monsters />
      <Dinos />
      <Pteros />
      <Vehicles />
      <Planes />
      <Weapons />
      <FastTravel />
      <FpsProbe />

      <EffectComposer multisampling={2}>
        <Bloom ref={bloom} intensity={0.3} luminanceThreshold={1.0} luminanceSmoothing={0.2} mipmapBlur />
        <Vignette eskil={false} offset={0.25} darkness={0.55} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </>
  );
}
