"use client";

import { useEffect, useRef } from "react";
import { planeHud as H } from "@/game/world/planeState";

// Flight HUD: one full-screen canvas redrawn every animation frame from the mutable planeHud read-outs.

const GREEN = "#8dffb0";
const AMBER = "#ffcf6a";
const RED = "#ff5a4a";

export function PlaneHud() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const g = cv.getContext("2d");
    if (!g) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = window.innerWidth, h = window.innerHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.font = "600 13px monospace";
      g.textBaseline = "middle";
      g.shadowColor = "#000";
      g.shadowBlur = 3;
      const cx = w / 2, cy = h / 2;
      const text = (s: string, x: number, y: number, col = GREEN, align: CanvasTextAlign = "center", size = 13) => {
        g.font = `600 ${size}px monospace`;
        g.textAlign = align;
        g.fillStyle = col;
        g.fillText(s, x, y);
      };
      const banner = (s: string, y: number, col: string, size = 16) => {
        g.font = `700 ${size}px monospace`;
        const tw = g.measureText(s).width + 20;
        g.shadowBlur = 0;
        g.fillStyle = "#000a";
        g.fillRect(cx - tw / 2, y - size * 0.8, tw, size * 1.6);
        g.shadowBlur = 3;
        text(s, cx, y, col, "center", size);
      };

      if (!H.active) {
        if (H.chute) {
          text(`PARACHUTE  ALT ${Math.max(0, H.agl).toFixed(0)} m  ${H.vs.toFixed(1)} m/s`, cx, h - 90, "#fff", "center", 16);
          text("WASD steer the canopy", cx, h - 68, "#fffc", "center", 12);
        }
        if (H.prompt) banner(H.prompt, h * 0.62, "#fff", 15);
        if (H.msgT > 0) banner(H.msg, h * 0.3, H.msg.startsWith("CRASH") ? RED : AMBER, 18);
        return;
      }

      const toX = (nx: number) => (nx * 0.5 + 0.5) * w, toY = (ny: number) => (-ny * 0.5 + 0.5) * h;
      g.lineWidth = 1.6;

      // ---- horizon / pitch ladder (rotates with bank, around the screen centre)
      const pxPerRad = h / 1.2; // roughly matches a ~65 deg vertical fov
      g.save();
      g.translate(cx, cy);
      g.rotate(-H.bank);
      g.strokeStyle = GREEN; g.fillStyle = GREEN;
      g.beginPath();
      g.rect(-w * 0.22, -h * 0.3, w * 0.44, h * 0.6);
      g.clip();
      for (let d = -80; d <= 80; d += 10) {
        const y = (H.pitch - (d * Math.PI) / 180) * pxPerRad;
        if (Math.abs(y) > h * 0.3) continue;
        const half = d === 0 ? w * 0.2 : 60;
        g.globalAlpha = d === 0 ? 0.9 : 0.55;
        g.setLineDash(d < 0 ? [8, 6] : []);
        g.beginPath();
        if (d === 0) { g.moveTo(-half, y); g.lineTo(-40, y); g.moveTo(40, y); g.lineTo(half, y); }
        else { g.moveTo(-half, y); g.lineTo(-22, y); g.moveTo(22, y); g.lineTo(half, y); }
        g.stroke();
        if (d !== 0) { g.font = "11px monospace"; g.textAlign = "left"; g.fillText(`${d}`, half + 4, y); g.textAlign = "right"; g.fillText(`${d}`, -half - 4, y); }
      }
      g.setLineDash([]);
      g.globalAlpha = 1;
      g.restore();

      // ---- gun reticle (where the guns converge) + aim circle (where the mouse points)
      if (H.noseOn) {
        const x = toX(H.noseX), y = toY(H.noseY);
        g.strokeStyle = H.overheat ? RED : GREEN;
        g.beginPath(); g.moveTo(x - 14, y); g.lineTo(x - 5, y); g.moveTo(x + 5, y); g.lineTo(x + 14, y); g.moveTo(x, y - 14); g.lineTo(x, y - 5); g.moveTo(x, y + 5); g.lineTo(x, y + 14); g.stroke();
        g.beginPath(); g.arc(x, y, 1.5, 0, Math.PI * 2); g.fill();
      }
      if (H.aimOn) {
        const x = toX(H.aimX), y = toY(H.aimY);
        g.strokeStyle = "#ffffffcc";
        g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke();
      }
      // ---- aim assist: lock brackets around the target (snap in on acquire), lead pip, label + health
      if (H.lockOn) {
        const x = toX(H.lockX), y = toY(H.lockY);
        const s = Math.max(16, Math.min(90, H.lockR * h * 0.5)) * (1 + 1.5 * Math.max(0, 1 - H.lockT / 0.25));
        const LOCK = "#ff4d4d";
        g.strokeStyle = LOCK; g.lineWidth = 2;
        const c = s * 0.35;
        g.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          g.moveTo(x + sx * s, y + sy * (s - c)); g.lineTo(x + sx * s, y + sy * s); g.lineTo(x + sx * (s - c), y + sy * s);
        }
        g.stroke();
        g.lineWidth = 1;
        text(`${H.lockLabel}  ${Math.round(H.lockDist)} m`, x, y - s - 8, LOCK, "center", 11);
        g.strokeStyle = LOCK; g.strokeRect(x - s, y + s + 5, s * 2, 4);
        g.fillStyle = LOCK; g.fillRect(x - s + 1, y + s + 6, (s * 2 - 2) * H.lockHp, 2);
        if (H.lockT > 0.25) text("LOCK", x, y + s + 22, LOCK, "center", 10);
      }
      if (H.lockOn && H.leadOn) {
        const x = toX(H.leadX), y = toY(H.leadY);
        g.strokeStyle = "#ffd24d"; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x + 3, y); g.moveTo(x, y - 3); g.lineTo(x, y + 3); g.stroke();
        g.lineWidth = 1;
      }

      // ---- left: speed tape, right: altitude
      const lx = cx - w * 0.27, rx = cx + w * 0.27;
      const spCol = H.stall > 0.15 ? RED : H.kmh < 115 && !H.onGround ? AMBER : GREEN;
      text(`${Math.round(H.kmh)}`, lx, cy, spCol, "right", 26);
      text("km/h", lx, cy + 22, spCol, "right", 11);
      text(`AoA ${((H.aoa * 180) / Math.PI).toFixed(0)}°  ${H.gs.toFixed(1)} g`, lx, cy + 40, GREEN, "right", 11);
      text(`${Math.round(H.alt)}`, rx, cy, GREEN, "left", 26);
      text(`m MSL   AGL ${Math.max(0, H.agl).toFixed(0)}`, rx, cy + 22, GREEN, "left", 11);
      const vsCol = H.vs < -8 && H.agl < 60 ? RED : GREEN;
      text(`VS ${H.vs >= 0 ? "+" : ""}${H.vs.toFixed(1)} m/s`, rx, cy + 40, vsCol, "left", 11);
      // heading
      text(`${String(Math.round(H.heading) % 360).padStart(3, "0")}°`, cx, h * 0.12, GREEN, "center", 16);

      // ---- throttle bar
      const tx = lx - 70, ty = cy + 70, th = 110;
      g.strokeStyle = GREEN; g.strokeRect(tx, ty, 12, th);
      g.fillStyle = H.thr > 0.95 ? AMBER : GREEN; g.fillRect(tx + 2, ty + th - 2 - (th - 4) * H.thr, 8, (th - 4) * H.thr);
      text(`THR ${Math.round(H.thr * 100)}%`, tx + 20, ty + th - 6, GREEN, "left", 11);
      if (H.brake) text("BRAKE", tx + 20, ty + 10, AMBER, "left", 11);
      if (H.onGround) text("GROUND", tx + 20, ty + 28, GREEN, "left", 11);
      if (H.vtol) {
        const mode = H.hover ? (H.nac > 0.97 ? "HOVER" : "→ HOVER") : H.nac > 0.03 ? "CONVERTING" : "WING";
        text(mode, tx + 20, ty + 46, H.hover ? "#7fd8ff" : GREEN, "left", 12);
        text(`fans ${Math.round(H.nac * 100)}%  lift ${Math.round(H.fan * 100)}%`, tx + 20, ty + 62, "#7fd8ffcc", "left", 10);
      }

      // ---- weapons (right bottom)
      const wx = rx, wy = cy + 80;
      text(`GUN ${H.ammo}/${H.ammoMax}`, wx, wy, H.ammo ? GREEN : RED, "left", 12);
      g.strokeStyle = GREEN; g.strokeRect(wx, wy + 10, 110, 7);
      g.fillStyle = H.overheat ? RED : H.heat > 0.7 ? AMBER : GREEN; g.fillRect(wx + 1, wy + 11, 108 * H.heat, 5);
      text(H.overheat ? "OVERHEAT" : "heat", wx + 116, wy + 13, H.overheat ? RED : "#8dffb099", "left", 10);
      text(`RKT ${H.rockets}/${H.rocketsMax}`, wx, wy + 32, H.rockets ? GREEN : AMBER, "left", 12);
      for (let i = 0; i < H.rocketsMax; i++) {
        g.fillStyle = i < H.rockets ? GREEN : i === H.rockets ? `rgba(141,255,176,${0.15 + 0.5 * H.rocketReload})` : "#8dffb022";
        g.fillRect(wx + i * 14, wy + 44, 10, 5);
      }

      // ---- warnings + messages
      if (H.warn) {
        const blink = H.warn.startsWith("STALL") || H.warn === "PULL UP" ? Math.floor(performance.now() / 250) % 2 === 0 : true;
        if (blink) banner(H.warn, h * 0.22, H.warn.startsWith("STALL") || H.warn === "PULL UP" ? RED : AMBER, 18);
      }
      if (H.msgT > 0) banner(H.msg, h * 0.3, H.msg.startsWith("CRASH") ? RED : AMBER, 15);
      if (H.ejectArm > 0) text("press F again to BAIL OUT", cx, h * 0.36, RED, "center", 14);

      // ---- controls hint
      g.shadowBlur = 2;
      const tail = `K ${H.vtol ? "turret" : "guns"} · L rockets (homing when locked) · V ${H.view === "chase" ? "cockpit" : "chase"} view · hold C look · F ${H.onGround ? "get out (stopped)" : "×2 bail out"}`;
      text(
        H.vtol && H.hover
          ? `HOVER: mouse look / yaw · Space up · Shift down · W/S tilt · A/D strafe · Q/E yaw · H forward flight · ${tail}`
          : `W go (takes off + climbs) · S slow · A/D turn · mouse aim · Space brake${H.vtol ? " · H hover" : ""} · ${tail}`,
        cx, h - 24, "#ffffffb0", "center", 11,
      );
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: 5 }} />;
}
