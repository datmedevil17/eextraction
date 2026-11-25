"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useGame, useLoad } from "@/game/store";
import { streamBoost, streamSettled } from "./propsStream";

// Drives the fast-travel curtain. While it is up the world stays frozen ("map" phase), props stream
// with a big per-frame budget, and every shader the destination needs is compiled up front, so the
// first playable frame there doesn't hitch. Drops the curtain once things are settled.

const MIN_S = 1.4;
const MAX_S = 12;

export function FastTravel() {
  const { gl, scene, camera } = useThree();
  const t = useRef(-1); // seconds since the curtain went up (wall clock: slow frames must not stretch it)
  const t0 = useRef(0);
  const frames = useRef(0);
  const compiled = useRef<"no" | "busy" | "done">("no");
  const quiet = useRef(0);

  useFrame((_, dt) => {
    const L = useLoad.getState();
    if (!L.active) { t.current = -1; return; }
    if (t.current < 0) { t0.current = performance.now(); frames.current = 0; compiled.current = "no"; quiet.current = 0; }
    t.current = (performance.now() - t0.current) / 1000;
    frames.current++;
    streamBoost.ms = 28;

    const settled = frames.current > 3 && streamSettled(camera.position.x, camera.position.z);
    if (settled && compiled.current === "no") {
      compiled.current = "busy";
      // compile anything new in view (props, creatures that just woke up, materials) off the hot path
      gl.compileAsync(scene, camera).catch(() => undefined).finally(() => { compiled.current = "done"; });
    }
    // and wait until frames are coming steadily (no big hitches left)
    quiet.current = dt < 0.06 ? quiet.current + 1 : 0;
    const ready = settled && compiled.current === "done" && quiet.current > 8 && t.current > MIN_S;
    const pct = Math.min(0.98, 0.15 + (settled ? 0.45 : Math.min(0.4, t.current * 0.12)) + (compiled.current === "done" ? 0.25 : 0) + Math.min(0.13, quiet.current * 0.016));
    if (ready || t.current > MAX_S) {
      streamBoost.ms = 0;
      L.set({ active: false, pct: 1 });
      if (useGame.getState().phase === "map") useGame.getState().setPhase("playing");
    } else if (Math.abs(pct - L.pct) > 0.01) L.set({ pct });
  });
  return null;
}
