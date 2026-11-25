"use client";

import dynamic from "next/dynamic";
import { Overlay } from "./Overlay";

// WebGL only exists in the browser, so skip prerendering the canvas.
const GameCanvas = dynamic(() => import("./GameCanvas"), {
  ssr: false,
  loading: () => <div className="loading">Loading world…</div>,
});

export function Game() {
  return (
    <main className="stage">
      <GameCanvas />
      <Overlay />
    </main>
  );
}
