// Live dragon positions + territories, shared with the minimap.
export type DragonMark = { label: string; color: string; x: number; z: number; cx: number; cz: number; r: number; mode: string };
export const dragonMarks: Record<string, DragonMark> = {};
