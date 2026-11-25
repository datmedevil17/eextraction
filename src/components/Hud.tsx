"use client";

import { useHud } from "@/game/weapons/combat";
import { GUN_BY_ID } from "@/game/weapons/arsenal";
import { useRide } from "@/game/store";

export function Hud() {
  const s = useHud();
  const d = GUN_BY_ID[s.gun];
  const driving = useRide((r) => r.on || r.plane);
  return (
    <>
      <div key={`h${s.hurtSeq}`} className={`vignette-hurt${s.hurtSeq ? " on" : ""}`} />
      <div key={`x${s.hitSeq}`} className={`xhair${s.scopeOn || driving ? " off" : ""}${s.ads ? " ads" : ""}${s.hitSeq ? " hit" : ""}${s.hitHead ? " head" : ""}${s.hitKill ? " kill" : ""}`} style={{ ["--c" as string]: d.color }}>
        <i /><i /><i /><i />
        <b />
      </div>
      {s.charge > 0 && (
        <div className="charge" style={{ ["--c" as string]: d.color }}>
          <i style={{ width: `${s.charge * 100}%` }} />
        </div>
      )}
      {s.rad > 0.02 && (
        <div className="geiger" style={{ opacity: 0.55 + s.rad * 0.45 }}>
          <b>☢ RADIATION</b>
          <i style={{ width: `${Math.min(100, s.rad * 100)}%` }} />
        </div>
      )}
      <div className="vitals">
        <div className="hpbar"><i style={{ width: `${(s.hp / s.maxHp) * 100}%` }} /><span>{Math.ceil(s.hp)}</span></div>
        <span className="kills">☠ {s.kills}</span>
      </div>
      <div className="ammo" hidden={driving} style={{ ["--c" as string]: d.color, ...(driving ? { display: "none" } : null) }}>
        <span className="gn">{d.name}</span>
        <span className="mag">{s.reloading > 0 ? "RELOADING" : s.mag}<small>/{s.magMax}</small></span>
        {s.reloading > 0 && <div className="rl"><i style={{ width: `${s.reloading * 100}%` }} /></div>}
        <span className="keys">G arsenal · R reload · Q last · RMB aim</span>
      </div>
    </>
  );
}
