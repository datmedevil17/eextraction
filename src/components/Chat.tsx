"use client";

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useGame } from "@/game/store";

// Slide-in chat log. Shift+Q opens it (frees the cursor, focuses the input); Shift+Q / Esc closes it.

type Msg = { id: number; who: string; text: string; sys?: boolean };
const useChat = create<{ msgs: Msg[]; add: (who: string, text: string, sys?: boolean) => void }>((set) => ({
  msgs: [{ id: 0, who: "SYSTEM", text: "Chat online. Shift+Q to hide.", sys: true }],
  add: (who, text, sys) => set((s) => ({ msgs: [...s.msgs.slice(-79), { id: (s.msgs.at(-1)?.id ?? 0) + 1, who, text, sys }] })),
}));

/** Post a line from anywhere in the game (e.g. kill feed, system notices). */
export const chatSystem = (text: string) => useChat.getState().add("SYSTEM", text, true);

export function Chat() {
  const phase = useGame((g) => g.phase);
  const open = phase === "chat";
  const msgs = useChat((c) => c.msgs);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const { phase: ph, setPhase } = useGame.getState();
      if (e.code === "KeyQ" && e.shiftKey) {
        if (ph === "playing") {
          setPhase("chat"); // phase first so the pointer-lock handler doesn't treat it as a pause
          document.exitPointerLock();
        } else if (ph === "chat") {
          setPhase("playing");
          document.querySelector("canvas:not([data-minimap])")?.requestPointerLock();
        }
        e.preventDefault();
      } else if (e.code === "Escape" && ph === "chat") {
        setPhase("playing");
        document.querySelector("canvas:not([data-minimap])")?.requestPointerLock();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 30);
  }, [open]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [msgs, open]);

  const send = () => {
    const t = text.trim();
    if (t) useChat.getState().add("You", t);
    setText("");
  };

  return (
    <div
      style={{
        position: "fixed", left: 18, bottom: 90, width: 340, maxWidth: "80vw", zIndex: 25,
        transform: open ? "translateX(0)" : "translateX(-380px)", opacity: open ? 1 : 0,
        transition: "transform .25s ease, opacity .25s ease", pointerEvents: open ? "auto" : "none",
        background: "rgba(8,12,22,0.78)", border: "1px solid rgba(255,255,255,0.22)", borderRadius: 10,
        backdropFilter: "blur(4px)", font: "13px system-ui, sans-serif", color: "#e8ecf5",
      }}
    >
      <div style={{ padding: "6px 10px", font: "700 11px system-ui", letterSpacing: 1.5, color: "#7dd3ff", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>CHAT · Shift+Q</div>
      <div ref={list} style={{ height: 180, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
        {msgs.map((m) => (
          <div key={m.id} style={{ wordBreak: "break-word" }}>
            <b style={{ color: m.sys ? "#ffd84a" : "#7dffb0" }}>{m.who}: </b>
            <span style={{ opacity: m.sys ? 0.8 : 1 }}>{m.text}</span>
          </div>
        ))}
      </div>
      <input
        ref={input}
        value={text}
        maxLength={160}
        placeholder="Type & press Enter…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation(); // keep typing away from the game's key handlers
          if (e.code === "Enter") send();
          else if (e.code === "Escape" || (e.code === "KeyQ" && e.shiftKey)) {
            e.preventDefault();
            useGame.getState().setPhase("playing");
            document.querySelector("canvas:not([data-minimap])")?.requestPointerLock();
          }
        }}
        style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: "rgba(0,0,0,0.35)", border: 0, borderTop: "1px solid rgba(255,255,255,0.12)", color: "#fff", outline: "none", borderRadius: "0 0 10px 10px" }}
      />
    </div>
  );
}
