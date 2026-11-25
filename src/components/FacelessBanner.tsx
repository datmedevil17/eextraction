"use client";

import { useEffect, useRef } from "react";
import { FACELESS, OASIS_CENTER, oasisT } from "@/game/terrain";
import { pose, ride, useGame, useLoad } from "@/game/store";

// "ENTERING DOMAIN OF THE FACELESS" / "OASIS OF THE ASSASSINS": fades in when the player (on foot, driving
// or flying) first crosses into the zone, holds ~3 s, fades out. Re-arms once the player is well outside again.

const IN = 0.8, HOLD = 3, OUT = 1.4;

type Zone = { title: string; inside: (x: number, z: number) => boolean; outside: (x: number, z: number) => boolean; color: string; glow: [string, string] };

const FACELESS_ZONE: Zone = {
  title: "DOMAIN OF THE FACELESS",
  inside: (x, z) => Math.hypot(x - FACELESS.x, z - FACELESS.z) < FACELESS.fence,
  outside: (x, z) => Math.hypot(x - FACELESS.x, z - FACELESS.z) > FACELESS.fence + 8,
  color: "#e9e2ff",
  glow: ["#8a4dff", "#5b2bd0"],
};
const near = (x: number, z: number) => Math.abs(x - OASIS_CENTER[0]) < 200 && Math.abs(z - OASIS_CENTER[1]) < 200;
const OASIS_ZONE: Zone = {
  title: "OASIS OF THE ASSASSINS",
  inside: (x, z) => near(x, z) && oasisT(x, z) < 1.55,
  outside: (x, z) => !near(x, z) || oasisT(x, z) > 1.9,
  color: "#fff1d6",
  glow: ["#d9822b", "#7a2a10"],
};

export function FacelessBanner() {
  return (
    <>
      <ZoneBanner zone={FACELESS_ZONE} />
      <ZoneBanner zone={OASIS_ZONE} />
    </>
  );
}

function ZoneBanner({ zone }: { zone: Zone }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let armed = true;
    let t0 = -1;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const x = ride.on ? ride.x : pose.x, z = ride.on ? ride.z : pose.z;
      if (armed && zone.inside(x, z)) { armed = false; t0 = now; }
      else if (!armed && zone.outside(x, z)) armed = true;
      const div = el.current;
      if (!div) return;
      // hold the banner back while the fast-travel curtain / map / pause is up
      if (t0 >= 0 && (useLoad.getState().active || useGame.getState().phase !== "playing")) t0 = now;
      if (t0 < 0) { div.style.opacity = "0"; return; }
      const t = (now - t0) / 1000;
      const o = t < IN ? t / IN : t < IN + HOLD ? 1 : Math.max(0, 1 - (t - IN - HOLD) / OUT);
      div.style.opacity = o.toFixed(3);
      div.style.letterSpacing = `${0.45 + Math.min(t, IN + HOLD + OUT) * 0.03}em`;
      if (o <= 0 && t > IN) t0 = -1;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [zone]);
  return (
    <div
      ref={el}
      style={{
        position: "absolute", top: "11%", left: 0, right: 0, textAlign: "center", pointerEvents: "none", opacity: 0,
        color: zone.color, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "clamp(18px, 2.6vw, 34px)", fontWeight: 600,
        letterSpacing: "0.45em", textShadow: `0 0 14px ${zone.glow[0]}, 0 0 32px ${zone.glow[1]}, 0 2px 4px #000`,
      }}
    >
      <div style={{ fontSize: "0.42em", letterSpacing: "0.6em", opacity: 0.75, marginBottom: 8 }}>ENTERING</div>
      {zone.title}
    </div>
  );
}
