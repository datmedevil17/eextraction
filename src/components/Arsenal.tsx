"use client";

import { useEffect, useMemo, useState } from "react";
import { useGame } from "@/game/store";
import { CLASS_ORDER, GUNS, GUN_BY_ID, RARITY_COLOR, type GunClass, type GunDef } from "@/game/weapons/arsenal";
import { thumbnail } from "@/game/weapons/library";
import { useHud } from "@/game/weapons/combat";

const STAT_LABELS = ["DMG", "RATE", "RANGE", "CONTROL"];
const MODE_LABEL: Record<string, string> = { auto: "FULL-AUTO", semi: "SEMI", burst: "BURST", charge: "CHARGE" };
const KIND_LABEL: Record<string, string> = { bolt: "PLASMA BOLT", beam: "HITSCAN BEAM", lob: "ARCED CHARGE" };

function perks(d: GunDef) {
  const p: string[] = [];
  if (d.pierce) p.push(d.pierce > 9 ? "PIERCES ALL" : `PIERCE ×${d.pierce}`);
  if (d.chain) p.push(`ARC ×${d.chain.n}`);
  if (d.burn) p.push("BURN");
  if (d.homing) p.push("HOMING");
  if (d.aoe) p.push(`BLAST ${d.aoe}m`);
  if (d.cluster) p.push(`CLUSTER ×${d.cluster}`);
  if (d.vortex) p.push("GRAVITY WELL");
  if (d.pellets && d.pellets.length > 1) p.push(`${d.pellets.length} SHOTS`);
  if (d.head && d.head > 2) p.push(`HEAD ×${d.head}`);
  return p;
}

function Thumb({ def, big }: { def: GunDef; big?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    thumbnail(def).then((u) => live && setSrc(u)).catch(() => {});
    return () => {
      live = false;
    };
  }, [def]);
  return (
    <div className={`gthumb${big ? " big" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt={def.name} draggable={false} /> : <span className="gload" />}
    </div>
  );
}

export function Arsenal() {
  const equipped = useHud((s) => s.gun);
  const setPhase = useGame((s) => s.setPhase);
  const [cls, setCls] = useState<GunClass | "ALL">("ALL");
  const [sel, setSel] = useState<string>(equipped);
  const list = useMemo(() => (cls === "ALL" ? GUNS : GUNS.filter((g) => g.cls === cls)), [cls]);
  const d = GUN_BY_ID[sel];

  const equip = (id: string) => {
    window.dispatchEvent(new CustomEvent("equip-gun", { detail: id }));
    const h = useHud.getState();
    if (!h.owned.includes(id) && h.owned.length < 9) h.set({ owned: [...h.owned, id] });
    setPhase("playing");
    document.querySelector("canvas")?.requestPointerLock(); // inside the click: counts as a user gesture
  };

  return (
    <div className="arsenal" style={{ ["--c" as string]: d.color }}>
      <div className="ar-head">
        <div>
          <p className="eyebrow">QUARTERMASTER</p>
          <h2>ARSENAL</h2>
        </div>
        <div className="ar-tabs">
          {(["ALL", ...CLASS_ORDER] as const).map((c) => (
            <button key={c} className={c === cls ? "on" : ""} onClick={() => setCls(c)}>
              {c}
            </button>
          ))}
        </div>
        <span className="ar-close">G / ESC to close</span>
      </div>

      <div className="ar-body">
        <div className="ar-grid">
          {list.map((g) => (
            <button
              key={g.id}
              className={`card${g.id === sel ? " sel" : ""}${g.id === equipped ? " eq" : ""}`}
              style={{ ["--r" as string]: RARITY_COLOR[g.rarity], ["--gc" as string]: g.color }}
              onClick={() => setSel(g.id)}
              onDoubleClick={() => equip(g.id)}
            >
              <span className="rar">{g.rarity}</span>
              <Thumb def={g} />
              <span className="gname">{g.name}</span>
              <span className="gcls">{g.cls} · {MODE_LABEL[g.mode]}</span>
              {g.id === equipped && <span className="tag">EQUIPPED</span>}
            </button>
          ))}
        </div>

        <aside className="ar-detail" style={{ ["--r" as string]: RARITY_COLOR[d.rarity] }}>
          <span className="rar big">{d.rarity}</span>
          <Thumb def={d} big />
          <h3>{d.name}</h3>
          <p className="tagline">{d.tagline}</p>
          <div className="chips">
            <span>{KIND_LABEL[d.kind]}</span>
            <span>{MODE_LABEL[d.mode]}</span>
            <span>MAG {d.mag}</span>
            {perks(d).map((p) => (
              <span key={p} className="perk">{p}</span>
            ))}
          </div>
          <div className="stats">
            {d.stats.map((v, i) => (
              <div key={i}>
                <label>{STAT_LABELS[i]}</label>
                <div className="bar"><i style={{ width: `${v}%` }} /></div>
              </div>
            ))}
          </div>
          <button className="enter equip" onClick={() => equip(d.id)} disabled={d.id === equipped}>
            {d.id === equipped ? "EQUIPPED" : "MATERIALISE"}
          </button>
        </aside>
      </div>
    </div>
  );
}
