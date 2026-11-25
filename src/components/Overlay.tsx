"use client";

import { useGame, useLoad, useRide } from "@/game/store";
import { Minimap } from "./Minimap";
import { Arsenal } from "./Arsenal";
import { Hud } from "./Hud";
import { Scope } from "./Scope";
import { Chat } from "./Chat";
import { FacelessBanner } from "./FacelessBanner";
import { PlaneHud } from "./PlaneHud";

function RideHud() {
  const { prompt, on, kmh, diag } = useRide();
  const box = { position: "absolute", left: "50%", transform: "translateX(-50%)", color: "#fff", fontFamily: "monospace", textShadow: "0 1px 3px #000", pointerEvents: "none" } as const;
  if (on)
    return (
      <div style={{ ...box, bottom: 70, textAlign: "center" }}>
        <div style={{ fontSize: 34, fontWeight: 700 }}>{kmh}<span style={{ fontSize: 14 }}> km/h</span></div>
        <div style={{ fontSize: 12, minHeight: 15, color: diag ? "#ffcf6b" : "#9be89b" }}>{diag ? `losing speed: ${diag} km/h/s` : "no speed loss"}</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>W/S gas·brake · A/D steer · Space handbrake · Shift boost · E exit</div>
      </div>
    );
  if (prompt) return <div style={{ ...box, top: "58%", fontSize: 16, background: "#0008", padding: "4px 10px", borderRadius: 4 }}>{prompt}</div>;
  return null;
}

const TIPS = [
  "Press E next to a buggy to drive it — Space for a handbrake drift.",
  "Raptors hunt in packs. If you see one, the others are flanking.",
  "Stegosaurs are peaceful until hurt — then watch the tail.",
  "The bones in the wasteland are not as dead as they look.",
  "Gunfire carries. Villagers scatter, monsters come looking.",
  "Pterodactyls can be shot down — they drop like stones.",
];

/** Full-screen curtain while fast travel streams the destination in. */
function TravelCurtain() {
  const { active, pct, label, tip } = useLoad();
  if (!active) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "radial-gradient(ellipse at center, #16241a 0%, #070b08 75%)", color: "#e8f0e4", fontFamily: "inherit" }}>
      <div style={{ width: "min(520px, 80vw)", textAlign: "center" }}>
        <div style={{ fontSize: 12, letterSpacing: 6, opacity: 0.6 }}>FAST TRAVEL</div>
        <div style={{ fontSize: 40, fontWeight: 800, margin: "10px 0 26px", letterSpacing: 1 }}>{label}</div>
        <div style={{ height: 6, background: "#ffffff1a", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.round(pct * 100)}%`, background: "linear-gradient(90deg, #7bd88f, #d6f5a6)", transition: "width 0.25s ease-out" }} />
        </div>
        <div style={{ fontSize: 13, opacity: 0.55, marginTop: 22 }}>{TIPS[tip % TIPS.length]}</div>
      </div>
    </div>
  );
}

function lockPointer() {
  document.querySelector("canvas")?.requestPointerLock();
}

export function Overlay() {
  const phase = useGame((s) => s.phase);
  const setPhase = useGame((s) => s.setPhase);

  const enter = () => {
    setPhase("playing");
    lockPointer(); // must run inside the click handler (user gesture)
  };

  if (phase === "playing" || phase === "arsenal" || phase === "map" || phase === "chat") {
    return (
      <>
        <div className="hud">
          <Minimap />
          <Hud />
          <Scope />
          <Chat />
          <RideHud />
          <PlaneHud />
          <FacelessBanner />
          <div id="fps" className="fps" />
          <div className="hint">WASD move · Shift sprint · Space jump · LMB fire · RMB aim · G arsenal · M map · Esc pause</div>
        </div>
        {phase === "arsenal" && <Arsenal />}
        <TravelCurtain />
      </>
    );
  }

  return (
    <div className="screen">
      <div className="panel">
        <p className="eyebrow">{phase === "menu" ? "Solana Blitz v10" : "Paused"}</p>
        {phase === "menu" && <h1>EXTRACTION</h1>}
        {phase === "menu" && <p className="tagline">Stake in. Grab what you can. Get out alive.</p>}
        <button className="enter" onClick={enter}>
          {phase === "menu" ? "Enter Game" : "Resume"}
        </button>
      </div>
    </div>
  );
}
