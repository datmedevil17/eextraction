"use client";

import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { Scene } from "@/game/world/Scene";

// Resolution adapts to the frame rate: drops toward 0.75x when frames suffer, climbs back to 1.5x
// (never the full retina 2x — the post chain + alpha-tested foliage are fill-rate bound).
export default function GameCanvas() {
  const [dpr, setDpr] = useState(1.25);
  return (
    <Canvas
      dpr={dpr}
      shadows="percentage"
      camera={{ fov: 62, near: 0.1, far: 20000, position: [0, 1.5, 10] }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
    >
      <PerformanceMonitor
        bounds={(refresh) => (refresh > 90 ? [55, 85] : [45, 58])}
        flipflops={4}
        onChange={({ factor }) => setDpr(Math.round((0.75 + factor * 0.75) * 20) / 20)}
        onFallback={() => setDpr(0.85)}
      />
      <Scene />
    </Canvas>
  );
}
