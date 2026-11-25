import type { Biome } from "./terrain";

// Per-map look: sky colours, fog, lighting. The sky/fog colours must match so
// the land melts into the sky at the horizon.
export const THEMES = {
  meadow: {
    label: "Sunlit Meadow",
    blurb: "Rolling grassland, a winding river",
    horizon: "#b4cde6",
    zenith: "#2c74d6",
    fog: 0.0022,
    sunColor: "#fff0d2",
    sunIntensity: 3.4,
    hemi: ["#9cc4ee", "#4a5a2a", 0.35] as [string, string, number],
    envIntensity: 0.6,
    bloom: 0.35,
  },
  ice: {
    label: "Glacial Valley",
    blurb: "Ice age. Frozen lake, blizzard, mountains",
    horizon: "#cbd8e6",
    zenith: "#4f86c6",
    fog: 0.0027,
    sunColor: "#ffe9cf",
    sunIntensity: 3.3,
    hemi: ["#b5cbe8", "#8696b0", 0.5] as [string, string, number],
    envIntensity: 0.85,
    bloom: 0.5,
  },
  desert: {
    label: "Scorched Dunes",
    blurb: "Endless dunes, sandstone mesas, a hidden oasis",
    horizon: "#ecd9b8",
    zenith: "#3f86d4",
    fog: 0.0019,
    sunColor: "#fff1d6",
    sunIntensity: 3.8,
    hemi: ["#bcd3ee", "#a8794a", 0.45] as [string, string, number],
    envIntensity: 0.75,
    bloom: 0.45,
  },
  nuke: {
    label: "Dead Reactor Zone",
    blurb: "Irradiated ash flats, cooling towers, a ruined city",
    horizon: "#3a3c2f",
    zenith: "#1c2625",
    fog: 0.0038,
    sunColor: "#ffe2a0",
    sunIntensity: 0.9,
    hemi: ["#3c463b", "#1c1b14", 0.22] as [string, string, number],
    envIntensity: 0.5,
    bloom: 0.45,
  },
} satisfies Record<Biome, unknown>;
