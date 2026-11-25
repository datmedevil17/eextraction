import { create } from "zustand";

export type Phase = "menu" | "playing" | "paused" | "arsenal" | "map" | "chat";

type GameState = {
  phase: Phase;
  setPhase: (phase: Phase) => void;
};

export const useGame = create<GameState>((set) => ({
  phase: "menu",
  setPhase: (phase) => set({ phase }),
}));

/** Player pose, written every frame by Player and read by the minimap (not reactive on purpose). */
export const pose = { x: 0, y: 0, z: 10, yaw: 0 };

/** One-way control channel into Player: camera kick (radians) and respawn requests. */
export const ctl = { pitch: 0, yaw: 0, respawn: false, zoom: 1, teleport: null as null | { x: number; z: number } };

/** Vehicle hand-off: Vehicles writes it, Player follows it while `on` (third person, no own camera). */
export const ride = { on: false, x: 0, y: 0, z: 0, camYaw: 0, camPitch: 0, plane: false }; // plane: flying / parachuting (Planes owns the camera + keys)

/** Small reactive bits for the HUD (prompt + speedometer). */
export const useRide = create<{ prompt: string | null; on: boolean; plane: boolean; kmh: number; diag: string; set: (p: Partial<{ prompt: string | null; on: boolean; plane: boolean; kmh: number; diag: string }>) => void }>((set) => ({
  prompt: null,
  on: false,
  plane: false,
  kmh: 0,
  diag: "",
  set: (p) => set(p),
}));

if (typeof window !== "undefined") (window as unknown as { __dbg: unknown }).__dbg = { ctl, pose, useGame, ride };

/** Fast-travel curtain: shown while the destination streams in and its shaders compile. */
export const useLoad = create<{ active: boolean; pct: number; label: string; tip: number; start: (label: string) => void; set: (p: Partial<{ active: boolean; pct: number }>) => void }>((set) => ({
  active: false,
  pct: 0,
  label: "",
  tip: 0,
  start: (label) => set({ active: true, pct: 0, label, tip: Math.floor(Math.random() * 1000) }),
  set: (p) => set(p),
}));
if (typeof window !== "undefined") Object.assign((window as unknown as { __dbg: object }).__dbg, { useLoad });
