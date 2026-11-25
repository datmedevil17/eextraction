"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";

// Tiny frame-rate readout (top-left). Writes straight to the DOM twice a second: no React re-renders.
// Shows the average fps and the worst frame time in that window, so hitches are visible too.
export function FpsProbe() {
  const acc = useRef({ t: 0, n: 0, worst: 0 });
  useFrame((_, dt) => {
    const a = acc.current;
    a.t += dt; a.n++; a.worst = Math.max(a.worst, dt);
    if (a.t < 0.5) return;
    const el = document.getElementById("fps");
    if (el) {
      const fps = Math.round(a.n / a.t);
      el.textContent = `${fps} fps · worst ${Math.round(a.worst * 1000)} ms`;
      el.style.color = fps < 30 ? "#ff6b5e" : fps < 50 ? "#ffd166" : "#9be89b";
    }
    a.t = 0; a.n = 0; a.worst = 0;
  });
  return null;
}
