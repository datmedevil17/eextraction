"use client";

import { useEffect, useRef, useState } from "react";
import { ctl, pose, useGame, useLoad } from "@/game/store";
import { dragonMarks } from "@/game/world/dragonMarks";
import { drawPlaneMarks } from "@/game/world/planeState";
import { PLAY_LIMIT, WATER_Y, WORLD_SIZE, biomeWeights, terrainHeight, waterMask, jungleT, villageT, facelessT, oasisT, OASIS_CENTER, nukeCity, runwayT, type BiomeWeights } from "@/game/terrain";

/** Human name of a spot, for the fast-travel screen. */
function placeName(x: number, z: number) {
  if (villageT(x, z) > 0.3) return "The Village";
  if (facelessT(x, z) > 0.3) return "Domain of the Faceless";
  if (Math.hypot(x - OASIS_CENTER[0], z - OASIS_CENTER[1]) < 200 && oasisT(x, z) < 1.6) return "Oasis of the Assassins";
  if (jungleT(x, z) > 0.3) return "The Jungle";
  const w = biomeWeights(x, z);
  if (w.nuke > 0.5) return nukeCity(x, z) > 0.3 ? "Ruined City" : "Nuclear Wasteland";
  if (w.ice > 0.5) return "Frozen North";
  if (w.desert > 0.5) return "Southern Desert";
  return "Meadowlands";
}

// Top-down relief map rendered once from the shared heightmap, then drawn every
// frame either as a small rotating radar (heading up) or a full north-up map (M).

const BASE = 512; // 3200 m / 512 = 6.25 m per pixel
const MAP_SIZE = WORLD_SIZE;
const SMALL = 190;
const BIG = 620;
const RADIUS = 300; // metres visible in the small map
const ROWS_PER_TICK = 8;

const mixc = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Paint the whole 3200 m world a few rows per frame so nothing blocks. Returns the canvas immediately. */
function buildBase() {
  const c = document.createElement("canvas");
  c.width = c.height = BASE;
  const ctx = c.getContext("2d")!;
  const w: BiomeWeights = { meadow: 1, ice: 0, desert: 0, nuke: 0 };
  const step = MAP_SIZE / BASE;
  let py = 0;
  let stop = false;
  const tick = () => {
    if (stop) return;
    const rows = Math.min(ROWS_PER_TICK, BASE - py);
    const img = ctx.createImageData(BASE, rows);
    for (let r = 0; r < rows; r++) {
      const z = (py + r + 0.5) * step - MAP_SIZE / 2;
      for (let px = 0; px < BASE; px++) {
        const x = (px + 0.5) * step - MAP_SIZE / 2;
        const h = terrainHeight(x, z);
        const dx = terrainHeight(x + step, z) - h;
        const dz = terrainHeight(x, z + step) - h;
        const shade = Math.min(1.4, Math.max(0.6, 1 + (-dx - dz) * 0.045));
        biomeWeights(x, z, w);
        const wm = waterMask(x, z);
        const slope = Math.hypot(dx, dz) / step;
        let col: number[];
        if (wm > 0.2 && h < WATER_Y + 0.05) {
          col = w.ice > 0.5 ? [150, 205, 225] : w.desert > 0.5 ? [60, 160, 160] : [40, 110, 140];
        } else {
          const t = Math.min(1, Math.max(0, (h + 12) / 34));
          const meadow = [74 + t * 54, 118 + t * 14, 52 + t * 20];
          const hi = Math.min(1, Math.max(0, h / 160));
          const ice = [232 - 40 * hi, 240 - 36 * hi, 250 - 18 * hi];
          const desert = [232 - 30 * hi, 196 - 50 * hi, 142 - 50 * hi];
          const nuke = [112 + t * 20, 110 + t * 16, 86 + t * 10];
          col = [
            meadow[0] * w.meadow + ice[0] * w.ice + desert[0] * w.desert + nuke[0] * w.nuke,
            meadow[1] * w.meadow + ice[1] * w.ice + desert[1] * w.desert + nuke[1] * w.nuke,
            meadow[2] * w.meadow + ice[2] * w.ice + desert[2] * w.desert + nuke[2] * w.nuke,
          ];
          const rock = Math.min(1, Math.max(0, (slope - 0.35) / 0.6));
          col = mixc(col, [105, 100, 98], rock);
          const jt = jungleT(x, z);
          if (jt > 0.01) col = mixc(col, [30, 84, 38], Math.min(1, jt * 1.1));
          const ct = villageT(x, z);
          if (ct > 0.01) col = mixc(col, [128, 108, 76], Math.min(1, ct * 0.8));
          const rw = runwayT(x, z);
          if (rw > 0.3) col = mixc(col, [74, 72, 68], Math.min(1, (rw - 0.3) * 2));
        }
        const o = (r * BASE + px) * 4;
        img.data[o] = col[0] * shade;
        img.data[o + 1] = col[1] * shade;
        img.data[o + 2] = col[2] * shade;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, py);
    py += rows;
    if (py < BASE) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return { canvas: c, cancel: () => (stop = true) };
}

function arrow(ctx: CanvasRenderingContext2D, size: number) {
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.7, size * 0.8);
  ctx.lineTo(0, size * 0.4);
  ctx.lineTo(-size * 0.7, size * 0.8);
  ctx.closePath();
  ctx.fillStyle = "#ffd84a";
  ctx.strokeStyle = "#1b1b1b";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
}

export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const phase = useGame((g) => g.phase);
  const open = phase === "map";
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);
  const hoverRef = useRef<{ x: number; z: number } | null>(null);
  const base = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const { phase: ph, setPhase } = useGame.getState();
      if (useLoad.getState().active) return; // travelling
      if (e.code === "KeyM") {
        if (ph === "playing") {
          setPhase("map"); // phase first so the pointer-lock handler doesn't treat it as a pause
          document.exitPointerLock();
        } else if (ph === "map") {
          setPhase("playing");
          document.querySelector("canvas")?.requestPointerLock();
        }
      } else if (e.code === "Escape" && ph === "map") setPhase("paused");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = open ? BIG : SMALL;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    if (!base.current) base.current = buildBase().canvas;
    const bg = base.current;
    let raf = 0;

    const marks = (k: number, toXY: (x: number, z: number) => [number, number], big: boolean) => {
      // k: screen pixels per world metre; toXY maps world -> screen
      for (const m of Object.values(dragonMarks)) {
        const [tx, tz] = toXY(m.cx, m.cz);
        ctx.strokeStyle = m.color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.arc(tx, tz, m.r * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const [dx, dz] = toXY(m.x, m.z);
        const u = big ? 1 : 0.8;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.beginPath();
        ctx.arc(dx, dz, 10 * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 2 * u;
        ctx.stroke();
        ctx.fillStyle = m.color;
        ctx.font = `${12 * u}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🐉", dx, dz + 0.5 * u);
        if (big) {
          ctx.font = "700 11px system-ui, sans-serif";
          ctx.fillStyle = "#fff";
          ctx.fillText(`${m.label} · ${m.mode === "fly" || m.mode === "takeoff" || m.mode === "land" ? "flying" : m.mode === "swoop" ? "DIVING at you" : m.mode === "hunt" ? "HUNTING you" : "on ground"}`, dx, dz + 22);
        }
      }
      drawPlaneMarks(ctx, toXY, big, big ? 0 : pose.yaw);
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const { x, z, yaw } = pose;

      if (!open) {
        const k = size / 2 / RADIUS;
        ctx.save();
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = "#1d2a1a";
        ctx.fillRect(0, 0, size, size);
        ctx.translate(size / 2, size / 2);
        ctx.rotate(yaw);
        ctx.scale(k, k);
        ctx.translate(-x, -z);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bg, -MAP_SIZE / 2, -MAP_SIZE / 2, MAP_SIZE, MAP_SIZE);
        ctx.restore();
        // dragons (screen space, icons stay upright)
        ctx.save();
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.translate(size / 2, size / 2);
        marks(k, (wx, wz) => {
          const ox = (wx - x) * k, oz = (wz - z) * k;
          return [ox * Math.cos(yaw) - oz * Math.sin(yaw), ox * Math.sin(yaw) + oz * Math.cos(yaw)];
        }, false);
        ctx.restore();

        // view cone + player
        ctx.save();
        ctx.translate(size / 2, size / 2);
        const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.42);
        cone.addColorStop(0, "rgba(255,255,255,0.35)");
        cone.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = cone;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, size * 0.42, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
        ctx.closePath();
        ctx.fill();
        arrow(ctx, 8);
        // north marker orbits the rim as you turn
        const nx = Math.sin(yaw) * (size / 2 - 13);
        const nz = -Math.cos(yaw) * (size / 2 - 13);
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.beginPath();
        ctx.arc(nx, nz, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("N", nx, nz + 0.5);
        ctx.restore();
      } else {
        ctx.drawImage(bg, 0, 0, size, size);
        // 400 m grid
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let m = -1200; m <= 1200; m += 400) {
          const p = ((m / MAP_SIZE + 0.5) * size) | 0;
          ctx.moveTo(p + 0.5, 0);
          ctx.lineTo(p + 0.5, size);
          ctx.moveTo(0, p + 0.5);
          ctx.lineTo(size, p + 0.5);
        }
        ctx.stroke();
        const px = (x / MAP_SIZE + 0.5) * size;
        const pz = (z / MAP_SIZE + 0.5) * size;
        marks(size / MAP_SIZE, (wx, wz) => [(wx / MAP_SIZE + 0.5) * size, (wz / MAP_SIZE + 0.5) * size], true);
        ctx.save();
        ctx.translate(px, pz);
        ctx.rotate(-yaw);
        const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, 70);
        cone.addColorStop(0, "rgba(255,255,255,0.45)");
        cone.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = cone;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 70, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
        ctx.closePath();
        ctx.fill();
        arrow(ctx, 11);
        ctx.restore();
        ctx.fillStyle = "#fff";
        ctx.font = "700 14px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("N ↑", size / 2, 20);
        const hv = hoverRef.current;
        if (hv) {
          const hx = (hv.x / MAP_SIZE + 0.5) * size;
          const hz = (hv.z / MAP_SIZE + 0.5) * size;
          ctx.strokeStyle = "#7dffb0";
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(px, pz);
          ctx.lineTo(hx, hz);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(hx, hz, 7, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(hx - 11, hz); ctx.lineTo(hx + 11, hz); ctx.moveTo(hx, hz - 11); ctx.lineTo(hx, hz + 11);
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const toWorld = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * MAP_SIZE;
    const z = ((e.clientY - r.top) / r.height - 0.5) * MAP_SIZE;
    return { x: Math.max(-PLAY_LIMIT, Math.min(PLAY_LIMIT, x)), z: Math.max(-PLAY_LIMIT, Math.min(PLAY_LIMIT, z)) };
  };
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!open) return;
    const p = toWorld(e);
    hoverRef.current = p;
    setHover(p);
  };
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!open) return;
    const p = toWorld(e);
    ctl.teleport = p; // fast travel
    hoverRef.current = null;
    setHover(null);
    // stay frozen ("map") behind a loading curtain until the destination is streamed in; the
    // FastTravel driver in the scene flips us to "playing". Pointer lock must be asked for here (click).
    useLoad.getState().start(placeName(p.x, p.z));
    document.querySelector("canvas:not([data-minimap])")?.requestPointerLock();
  };

  const wrap: React.CSSProperties = open
    ? { position: "fixed", inset: 0, display: "grid", placeItems: "center", background: "rgba(5,10,5,0.55)", backdropFilter: "blur(3px)", pointerEvents: "auto", zIndex: 20 }
    : { position: "fixed", top: 18, right: 18, pointerEvents: "none", zIndex: 20 };
  const frame: React.CSSProperties = open
    ? { width: BIG, height: BIG, borderRadius: 14, border: "2px solid rgba(255,255,255,0.6)", boxShadow: "0 20px 60px rgba(0,0,0,0.6)", maxWidth: "92vmin", maxHeight: "92vmin" }
    : { width: SMALL, height: SMALL, borderRadius: "50%", border: "3px solid rgba(255,255,255,0.65)", boxShadow: "0 6px 20px rgba(0,0,0,0.45), inset 0 0 18px rgba(0,0,0,0.4)" };

  return (
    <div style={wrap}>
      <div style={{ position: "relative" }}>
        <canvas ref={ref} data-minimap="" onMouseMove={onMove} onMouseLeave={() => { hoverRef.current = null; setHover(null); }} onClick={onClick} style={{ display: "block", ...frame, cursor: open ? "crosshair" : "default" }} />
        {!open && (
          <div style={{ position: "absolute", bottom: -22, right: 4, font: "600 11px system-ui", color: "rgba(255,255,255,0.8)", textShadow: "0 1px 3px #000" }}>
            M · map
          </div>
        )}
        {open && (
          <div style={{ position: "absolute", bottom: -26, left: 0, right: 0, textAlign: "center", font: "600 12px system-ui", color: "rgba(255,255,255,0.85)" }}>
            {hover ? `Click to fast travel → X ${Math.round(hover.x)} · Z ${Math.round(hover.z)} (${Math.round(Math.hypot(hover.x - pose.x, hover.z - pose.z))} m)` : "Click anywhere to fast travel · M to close"}
          </div>
        )}
      </div>
    </div>
  );
}
