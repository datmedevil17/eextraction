# Extraction

A first-person open-world survival/extraction game that runs in the browser. Built with Next.js, React Three Fiber and three.js.

The world is one continuous map made of themed zones: a grass village guarded by knights, a frozen lake, a jungle with dinosaurs, a desert with an oasis, a nuclear wasteland, and a ruined "faceless" village. Each zone has its own props, creatures and atmosphere.

## Features

- **Procedural terrain** with biome blending, streamed props, instanced grass and a spatial-hash collision system (circle and yawed-box colliders).
- **Shader-driven atmosphere**: day/night sky dome, per-zone fog and lighting, snowfall, dust.
- **Oasis**: planar-reflection water shader with refraction, caustics, foam and a heightmap bed; reeds, lily pads, palms, mud huts, and the assassins who live there.
- **Arsenal**: 20 sci-fi guns across assault rifles, SMGs, snipers, crossbows and grenades, with scopes, recoil, homing and beam weapons.
- **Enemies and NPCs**: zombies, imps and puglins, dinosaurs, pterosaurs, dragons, sorcerers, villagers, knights, and the Assassins of the Oasis. Hurting a faction turns its guards on you.
- **Vehicles and aircraft**: a raider buggy, a war plane and a VTOL gunship with a flight model.
- **HUD**: minimap, scope overlay, arsenal screen, zone banners, fast travel.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). A GPU-accelerated browser is strongly recommended.

Other scripts:

```bash
npm run build   # production build
npm run start   # serve the production build
npm run lint    # eslint
```

## Project layout

```
src/
  app/                 Next.js app router shell
  components/          HUD, minimap, arsenal, overlays, canvas host
  game/
    terrain.ts         heightfield, biome masks, oasis/village layout
    atmosphere.ts      sky, fog and sun state
    store.ts           zustand game state and shared pose
    weapons/           arsenal definitions, combat, fx, audio
    world/             scene, props streaming, creatures, vehicles, zones
public/models/         glTF/FBX assets (see CREDITS.txt)
```

## Assets and credits

All 3D models live in `public/models`. Attribution and licences are listed in [`public/models/CREDITS.txt`](public/models/CREDITS.txt). Several models are CC-BY and require attribution; the licence of `assassins/Rogue.gltf` still needs to be confirmed.
