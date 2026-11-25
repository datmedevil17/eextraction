import type { GunDef, Sfx } from "./arsenal";

// Tiny synthesiser: every gun gets its own pitch sweep + noise so it sounds like itself.
let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

function ac() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    ctx = new AudioContext();
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(s: Sfx, vol = 1, pitch = 1) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const out = a.createGain();
  out.gain.setValueAtTime((s.vol ?? 0.18) * vol, t);
  out.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
  out.connect(a.destination);
  const o = a.createOscillator();
  o.type = s.wave;
  o.frequency.setValueAtTime(s.f0 * pitch, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, s.f1 * pitch), t + s.dur);
  o.connect(out);
  o.start(t);
  o.stop(t + s.dur + 0.02);
  if (s.noise) noise(s.dur, s.noise * (s.vol ?? 0.18) * vol, 3000);
}

function noise(dur: number, vol: number, cutoff: number) {
  const a = ac();
  if (!a || !noiseBuf) return;
  const t = a.currentTime;
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  const f = a.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.setValueAtTime(cutoff, t);
  f.frequency.exponentialRampToValueAtTime(200, t + dur);
  const gn = a.createGain();
  gn.gain.setValueAtTime(vol, t);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(gn).connect(a.destination);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

export const sfx = {
  shot: (d: GunDef, charge = 1) => tone(d.sfx, 0.6 + 0.4 * charge, 0.95 + Math.random() * 0.1),
  reload: () => {
    tone({ wave: "square", f0: 500, f1: 300, dur: 0.05, vol: 0.08 });
    setTimeout(() => tone({ wave: "square", f0: 700, f1: 900, dur: 0.07, vol: 0.08 }), 350);
  },
  equip: (d: GunDef) => tone({ wave: "sine", f0: 300, f1: 1400, dur: 0.35, vol: 0.1 }, 1, d.sfx.f0 > 1500 ? 1.2 : 1),
  hit: (head: boolean) => tone({ wave: "triangle", f0: head ? 1800 : 900, f1: head ? 1200 : 500, dur: 0.06, vol: 0.1 }),
  boom: (size = 1) => {
    noise(0.5 * size, 0.35, 1800);
    tone({ wave: "sine", f0: 120, f1: 35, dur: 0.45 * size, vol: 0.3 });
  },
  hurt: () => tone({ wave: "sawtooth", f0: 180, f1: 70, dur: 0.18, vol: 0.2 }),
  click: () => tone({ wave: "square", f0: 900, f1: 700, dur: 0.03, vol: 0.06 }),
};
