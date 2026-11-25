// The arsenal: 19 guns from the asset pack, each with its own laser colour, firing
// pattern and sound. Pure data - combat.ts interprets it.

export type GunClass = "AR" | "SMG" | "Pistol" | "Sniper" | "Crossbow" | "Launcher";
export type Rarity = "common" | "rare" | "epic" | "legendary";
export type Mode = "auto" | "semi" | "burst" | "charge";
export type Kind = "bolt" | "beam" | "lob";

export type Sfx = { wave: OscillatorType; f0: number; f1: number; dur: number; vol?: number; noise?: number };

export interface GunDef {
  id: string; // file name without extension
  name: string;
  cls: GunClass;
  rarity: Rarity;
  tagline: string; // the identity, one line
  color: string; // laser colour
  mode: Mode;
  interval: number; // seconds between triggers
  burst?: number;
  burstGap?: number;
  charge?: number; // seconds to full charge
  pellets?: [number, number][]; // angular offsets (deg) fired per trigger
  spread: number; // base cone (deg)
  spreadGrow?: number; // added per shot (deg), recovers while idle
  spreadMax?: number;
  kind: Kind;
  speed?: number; // m/s (bolt/lob)
  gravity?: number;
  life?: number;
  size: number; // beam / bolt thickness (m)
  damage: number;
  head?: number; // headshot multiplier (default 2)
  pierce?: number; // extra targets a shot passes through
  aoe?: number; // explosion radius
  homing?: number; // turn rate rad/s
  chain?: { n: number; range: number; frac: number };
  burn?: { sec: number; dps: number };
  cluster?: number; // bomblets on explosion
  vortex?: number; // seconds of gravity well before it detonates
  knock?: number;
  mag: number;
  reload: number;
  recoil: number; // deg of camera kick
  kick: number; // viewmodel kick 0..1
  zoom: number; // ADS field-of-view multiplier
  scopes?: number[]; // scope zoom levels (fov multipliers, wheel to switch) - enables the scope overlay
  stats: [number, number, number, number]; // damage, fire rate, range, control (0..100)
  optic?: { part: string; x: number };
  sfx: Sfx;
}

const g = (d: GunDef) => d;

export const GUNS: GunDef[] = [
  g({ id: "AR_1", name: "PULSE-7", cls: "AR", rarity: "common", tagline: "Steady cyan pulse. Does everything, masters nothing.", color: "#35e0ff", mode: "auto", interval: 0.095, spread: 0.7, spreadGrow: 0.22, spreadMax: 3.2, kind: "bolt", speed: 230, size: 0.035, damage: 18, mag: 30, reload: 1.7, recoil: 0.55, kick: 0.5, zoom: 0.85, stats: [45, 72, 60, 62], sfx: { wave: "sawtooth", f0: 1400, f1: 300, dur: 0.09 } }),
  g({ id: "AR_2", name: "TRI-BURST", cls: "AR", rarity: "rare", tagline: "Three-round burst, then breathe. Pin-point at range.", color: "#7aa8ff", mode: "burst", burst: 3, burstGap: 0.055, interval: 0.34, spread: 0.35, spreadGrow: 0.15, spreadMax: 1.4, kind: "bolt", speed: 270, size: 0.04, damage: 24, mag: 30, reload: 1.8, recoil: 0.5, kick: 0.45, zoom: 0.8, stats: [58, 52, 72, 80], optic: { part: "Sight_2", x: 0.12 }, sfx: { wave: "square", f0: 1800, f1: 500, dur: 0.06 } }),
  g({ id: "AR_3", name: "ARC-9", cls: "AR", rarity: "rare", tagline: "Hits arc to the nearest enemies. Crowd breaker.", color: "#b8f0ff", mode: "auto", interval: 0.11, spread: 0.9, spreadGrow: 0.25, spreadMax: 3.4, kind: "bolt", speed: 250, size: 0.03, damage: 14, chain: { n: 2, range: 8, frac: 0.6 }, mag: 32, reload: 1.9, recoil: 0.5, kick: 0.45, zoom: 0.85, stats: [50, 66, 55, 58], sfx: { wave: "sawtooth", f0: 2600, f1: 200, dur: 0.12, noise: 0.3 } }),
  g({ id: "AR_4", name: "INFERNO", cls: "AR", rarity: "epic", tagline: "Plasma that keeps burning after the hit.", color: "#ff7a1a", mode: "auto", interval: 0.08, spread: 1.4, spreadGrow: 0.3, spreadMax: 4, kind: "bolt", speed: 175, size: 0.05, damage: 11, burn: { sec: 3, dps: 9 }, mag: 40, reload: 2.1, recoil: 0.6, kick: 0.55, zoom: 0.88, stats: [56, 82, 45, 45], sfx: { wave: "sawtooth", f0: 400, f1: 90, dur: 0.14, noise: 0.5 } }),
  g({ id: "AR_5", name: "PHASE LANCE", cls: "AR", rarity: "epic", tagline: "Shots phase through up to three bodies.", color: "#c06bff", mode: "auto", interval: 0.15, spread: 0.5, spreadGrow: 0.18, spreadMax: 2, kind: "bolt", speed: 310, size: 0.045, damage: 26, pierce: 3, mag: 24, reload: 2, recoil: 0.7, kick: 0.6, zoom: 0.82, stats: [66, 50, 78, 70], sfx: { wave: "sine", f0: 900, f1: 2400, dur: 0.16 } }),
  g({ id: "AR_6", name: "TRIAD", cls: "AR", rarity: "rare", tagline: "Three parallel beams per trigger. Stitches targets.", color: "#3dff9a", mode: "semi", interval: 0.2, pellets: [[-1.3, 0], [0, 0], [1.3, 0]], spread: 0.25, spreadGrow: 0.2, spreadMax: 1.5, kind: "bolt", speed: 260, size: 0.03, damage: 15, mag: 30, reload: 1.9, recoil: 0.6, kick: 0.55, zoom: 0.85, stats: [62, 58, 62, 68], optic: { part: "Sight_1", x: 0.1 }, sfx: { wave: "triangle", f0: 1100, f1: 400, dur: 0.12 } }),

  g({ id: "SMG_1", name: "HORNET", cls: "SMG", rarity: "common", tagline: "Absurd fire rate, wild spray. Get close.", color: "#ffe14a", mode: "auto", interval: 0.055, spread: 2, spreadGrow: 0.35, spreadMax: 6, kind: "bolt", speed: 200, size: 0.025, damage: 9, mag: 45, reload: 1.5, recoil: 0.35, kick: 0.3, zoom: 0.9, stats: [32, 96, 30, 38], optic: { part: "Sight_3", x: 0.08 }, sfx: { wave: "square", f0: 2000, f1: 900, dur: 0.045 } }),
  g({ id: "SMG_2", name: "SWARM", cls: "SMG", rarity: "epic", tagline: "Bolts curve toward enemies. Aim near, not at.", color: "#44ffd0", mode: "auto", interval: 0.07, spread: 3, spreadGrow: 0.3, spreadMax: 6, kind: "bolt", speed: 120, size: 0.03, damage: 10, homing: 5, life: 2.5, mag: 36, reload: 1.7, recoil: 0.3, kick: 0.3, zoom: 0.9, stats: [38, 88, 50, 50], optic: { part: "Sight_1", x: 0.2 }, sfx: { wave: "sine", f0: 1500, f1: 2300, dur: 0.06 } }),

  g({ id: "Pistol_1", name: "SIDEARM", cls: "Pistol", rarity: "common", tagline: "Pink, precise, reliable. Never runs out of charm.", color: "#ff4fd8", mode: "semi", interval: 0.17, spread: 0.2, spreadGrow: 0.5, spreadMax: 2, kind: "bolt", speed: 250, size: 0.035, damage: 28, mag: 14, reload: 1.3, recoil: 0.8, kick: 0.6, zoom: 0.9, stats: [40, 45, 55, 82], sfx: { wave: "square", f0: 1600, f1: 400, dur: 0.08 } }),
  g({ id: "Pistol_2", name: "TWIN NEEDLE", cls: "Pistol", rarity: "rare", tagline: "Two needles per squeeze, one in each eye.", color: "#ff8ab0", mode: "semi", interval: 0.16, pellets: [[-0.7, 0], [0.7, 0]], spread: 0.3, spreadGrow: 0.4, spreadMax: 2, kind: "bolt", speed: 280, size: 0.025, damage: 15, mag: 18, reload: 1.4, recoil: 0.7, kick: 0.55, zoom: 0.9, stats: [44, 50, 58, 76], sfx: { wave: "triangle", f0: 2200, f1: 900, dur: 0.07 } }),
  g({ id: "Pistol_3", name: "HELLCAT", cls: "Pistol", rarity: "epic", tagline: "One slow, enormous shot. Kicks like a mule.", color: "#ff3030", mode: "semi", interval: 0.55, spread: 0.15, spreadGrow: 1, spreadMax: 3, kind: "bolt", speed: 210, size: 0.09, damage: 95, aoe: 1.4, knock: 3, mag: 6, reload: 1.8, recoil: 2.6, kick: 1, zoom: 0.9, stats: [88, 22, 50, 40], sfx: { wave: "sawtooth", f0: 500, f1: 60, dur: 0.22, noise: 0.5 } }),

  g({ id: "Sniper_1", name: "RAILGUN", cls: "Sniper", rarity: "legendary", tagline: "Instant beam. Passes through everything in line.", color: "#e8fbff", mode: "semi", interval: 1.1, spread: 0.02, kind: "beam", size: 0.09, damage: 140, head: 2, pierce: 99, mag: 5, reload: 2.4, recoil: 2.2, kick: 0.9, zoom: 0.33, scopes: [0.33, 0.17, 0.09], stats: [92, 14, 100, 88], sfx: { wave: "sawtooth", f0: 3000, f1: 80, dur: 0.5, noise: 0.35 } }),
  g({ id: "Sniper_2", name: "VOID LANCE", cls: "Sniper", rarity: "legendary", tagline: "Hold to charge. Release to erase a corridor.", color: "#a040ff", mode: "charge", charge: 1.2, interval: 0.8, spread: 0.02, kind: "beam", size: 0.26, damage: 320, head: 1.5, pierce: 99, mag: 3, reload: 2.8, recoil: 3, kick: 1, zoom: 0.4, scopes: [0.4, 0.2, 0.1], stats: [100, 8, 100, 72], optic: { part: "Scope_2", x: 0.15 }, sfx: { wave: "sine", f0: 140, f1: 40, dur: 0.7, noise: 0.6 } }),
  g({ id: "Sniper_3", name: "MARKSMAN", cls: "Sniper", rarity: "rare", tagline: "Fast bolt-action beam. Headshots hit four times harder.", color: "#7dff6b", mode: "semi", interval: 0.6, spread: 0.03, kind: "beam", size: 0.05, damage: 70, head: 4, pierce: 1, mag: 8, reload: 2, recoil: 1.4, kick: 0.8, zoom: 0.28, scopes: [0.28, 0.14, 0.08], stats: [72, 30, 96, 94], sfx: { wave: "square", f0: 2400, f1: 300, dur: 0.2 } }),

  g({ id: "Crossbow_1", name: "ION BOW", cls: "Crossbow", rarity: "rare", tagline: "Draw back and release. Charged bolts pierce five.", color: "#9dff3a", mode: "charge", charge: 0.7, interval: 0.3, spread: 0.1, kind: "bolt", speed: 210, size: 0.06, damage: 110, pierce: 5, mag: 6, reload: 1.8, recoil: 0.9, kick: 0.7, zoom: 0.75, scopes: [0.5, 0.3], stats: [74, 28, 70, 80], sfx: { wave: "sine", f0: 300, f1: 1800, dur: 0.25 } }),
  g({ id: "Crossbow_2", name: "RAIL BOW", cls: "Crossbow", rarity: "legendary", tagline: "Slow draw, explosive tip, goes through the whole line.", color: "#ffd23a", mode: "charge", charge: 1.1, interval: 0.5, spread: 0.05, kind: "bolt", speed: 340, size: 0.08, damage: 200, pierce: 99, aoe: 3, mag: 3, reload: 2.4, recoil: 1.8, kick: 0.9, zoom: 0.6, scopes: [0.4, 0.22], stats: [96, 15, 90, 70], sfx: { wave: "sawtooth", f0: 200, f1: 60, dur: 0.4, noise: 0.4 } }),

  g({ id: "Grenade_1", name: "PLASMA LOBBER", cls: "Launcher", rarity: "rare", tagline: "Lobs a plasma charge that bursts on contact.", color: "#2dffb0", mode: "semi", interval: 0.9, spread: 0.3, kind: "lob", speed: 28, gravity: 14, size: 0.12, damage: 130, aoe: 5.5, knock: 6, mag: 6, reload: 2.2, recoil: 1.2, kick: 0.8, zoom: 0.9, stats: [80, 24, 40, 60], sfx: { wave: "sine", f0: 200, f1: 90, dur: 0.18 } }),
  g({ id: "Grenade_2", name: "CLUSTER", cls: "Launcher", rarity: "epic", tagline: "Bursts into five bomblets. Clears rooms.", color: "#ff9d2e", mode: "semi", interval: 1.1, spread: 0.3, kind: "lob", speed: 26, gravity: 14, size: 0.12, damage: 60, aoe: 3.2, cluster: 5, knock: 3, mag: 4, reload: 2.4, recoil: 1.2, kick: 0.8, zoom: 0.9, stats: [78, 20, 38, 55], sfx: { wave: "triangle", f0: 300, f1: 120, dur: 0.2 } }),
  g({ id: "Grenade_3", name: "SINGULARITY", cls: "Launcher", rarity: "legendary", tagline: "A gravity well drags everyone in, then collapses.", color: "#8c5bff", mode: "semi", interval: 1.4, spread: 0.3, kind: "lob", speed: 26, gravity: 12, size: 0.14, damage: 160, aoe: 7, vortex: 1.8, mag: 3, reload: 2.8, recoil: 1.3, kick: 0.85, zoom: 0.9, stats: [90, 16, 36, 52], sfx: { wave: "sine", f0: 120, f1: 400, dur: 0.35 } }),
];

export const GUN_BY_ID: Record<string, GunDef> = Object.fromEntries(GUNS.map((x) => [x.id, x]));
export const CLASS_ORDER: GunClass[] = ["AR", "SMG", "Pistol", "Sniper", "Crossbow", "Launcher"];
export const RARITY_COLOR: Record<Rarity, string> = { common: "#9aa4b2", rare: "#4aa8ff", epic: "#b45cff", legendary: "#ffb733" };
export const START_GUN = "Pistol_1";
