"use client";

import { useHud } from "@/game/weapons/combat";
import { GUN_BY_ID } from "@/game/weapons/arsenal";

// Sniper scope: circular lens over the zoomed world, mil-dot reticle, hold-breath meter.
export function Scope() {
  const on = useHud((s) => s.scopeOn);
  const mag = useHud((s) => s.scope);
  const breath = useHud((s) => s.breath);
  const gun = useHud((s) => s.gun);
  if (!on) return null;
  const c = GUN_BY_ID[gun].color;
  const dots = [-80, -60, -40, -20, 20, 40, 60, 80];
  return (
    <div className="scope" style={{ ["--c" as string]: c }}>
      <svg viewBox="-100 -100 200 200" className="reticle">
        <circle r="99" fill="none" stroke="#000" strokeWidth="3" />
        {/* thick outer posts, thin centre */}
        <path d="M-99 0H-16M16 0H99M0 -99V-16M0 16V99" stroke="#000" strokeWidth="0.35" opacity="0.9" />
        <path d="M-99 0H-62M62 0H99M0 -99V-62M0 62V99" stroke="#000" strokeWidth="1.6" />
        <path d="M-16 0H-3M3 0H16M0 -16V-3M0 3V16" stroke="var(--c)" strokeWidth="0.35" />
        {dots.map((d) => (
          <g key={d}>
            <circle cx={d} cy="0" r="0.9" fill="#000" />
            <circle cx="0" cy={d} r="0.9" fill="#000" />
          </g>
        ))}
        {[30, 50, 70].map((d, i) => (
          <g key={d} stroke="#000" strokeWidth="0.4">
            <path d={`M-${5 - i}  ${d}H${5 - i}`} />
          </g>
        ))}
        <circle r="0.7" fill="var(--c)" />
        <circle r="0.7" fill="var(--c)" opacity="0.6">
          <animate attributeName="r" values="0.7;3;0.7" dur="1.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.6;0;0.6" dur="1.8s" repeatCount="indefinite" />
        </circle>
      </svg>
      <div className="scope-read">
        <b>{mag}×</b>
        <span>WHEEL ZOOM · SHIFT HOLD BREATH</span>
        <div className="sbreath"><i style={{ width: `${breath * 100}%` }} /></div>
      </div>
    </div>
  );
}
