import * as THREE from "three";
import { pose } from "@/game/store";

// ---------- roar (Web Audio synth) ----------
export type Voice = { master: GainNode; pan: StereoPannerNode };
let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

/** one output chain (gain -> echo -> pan) per dragon so they can be mixed by distance independently */
export function makeVoice(): Voice | null {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const master = ctx.createGain();
  master.gain.value = 0;
  const pan = ctx.createStereoPanner();
  // a long dark echo so it booms across the wasteland
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.34;
  const fb = ctx.createGain();
  fb.gain.value = 0.4;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1100;
  delay.connect(lp).connect(fb).connect(delay);
  master.connect(pan);
  master.connect(delay);
  delay.connect(pan);
  pan.connect(ctx.destination);
  return { master, pan };
}

/** distance fade + stereo placement for a voice */
export function mixVoice(v: Voice | null, p: THREE.Vector3, cam: THREE.Camera, range: number) {
  if (!v) return;
  const d = Math.hypot(p.x - pose.x, p.y - cam.position.y, p.z - pose.z);
  v.master.gain.value = Math.pow(Math.max(0, 1 - d / range), 1.6) * 1.1;
  const right = _R.set(1, 0, 0).applyQuaternion(cam.quaternion);
  const to = _T.set(p.x - pose.x, 0, p.z - pose.z).normalize();
  v.pan.pan.value = THREE.MathUtils.clamp(right.dot(to) * 0.8, -1, 1);
}
const _R = new THREE.Vector3();
const _T = new THREE.Vector3();

const curve = (() => {
  const c = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const x = (i / 511) * 2 - 1;
    c[i] = Math.tanh(x * 3.2);
  }
  return c;
})();

export const ROAR_TIME = 3.4;

/** pitch < 1 = deeper / bigger */
export function playRoar(voice: Voice | null, pitch = 1) {
  const a = ctx;
  if (!a || !voice || !noiseBuf) return;
  const master = voice.master;
  void a.resume();
  const t = a.currentTime;
  const T = ROAR_TIME;
  const out = a.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(1, t + 0.35);
  out.gain.setValueAtTime(1, t + T * 0.55);
  out.gain.exponentialRampToValueAtTime(0.0001, t + T);
  const shaper = a.createWaveShaper();
  shaper.curve = curve;
  shaper.connect(out);
  out.connect(master);
  // growl: low saw pair, pitch bends up then falls
  for (const [f0, f1, f2, g] of [[62, 105, 44, 0.5], [93, 160, 66, 0.35], [31, 52, 24, 0.5]].map((r) => r.map((x, i) => (i < 3 ? x * pitch : x)))) {
    const o = a.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f1, t + 0.7);
    o.frequency.exponentialRampToValueAtTime(f2, t + T);
    const am = a.createGain();
    am.gain.value = g * 0.6;
    const lfo = a.createOscillator();
    lfo.frequency.value = 26 + Math.random() * 8; // throat rattle
    const lg = a.createGain();
    lg.gain.value = g * 0.4;
    lfo.connect(lg).connect(am.gain);
    o.connect(am).connect(shaper);
    o.start(t);
    lfo.start(t);
    o.stop(t + T + 0.1);
    lfo.stop(t + T + 0.1);
  }
  // screech: formant-swept noise + a high wavering tone
  const n = a.createBufferSource();
  n.buffer = noiseBuf;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 3.5;
  bp.frequency.setValueAtTime(380, t);
  bp.frequency.exponentialRampToValueAtTime(1400, t + 0.9);
  bp.frequency.exponentialRampToValueAtTime(320, t + T);
  const ng = a.createGain();
  ng.gain.value = 1.3;
  n.connect(bp).connect(ng).connect(shaper);
  n.start(t, Math.random() * 2);
  n.stop(t + T + 0.1);
  const s = a.createOscillator();
  s.type = "sawtooth";
  s.frequency.setValueAtTime(240 * pitch, t);
  s.frequency.exponentialRampToValueAtTime(760 * pitch, t + 0.8);
  s.frequency.exponentialRampToValueAtTime(190 * pitch, t + T);
  const vib = a.createOscillator();
  vib.frequency.value = 9;
  const vg = a.createGain();
  vg.gain.value = 22;
  vib.connect(vg).connect(s.frequency);
  const sg = a.createGain();
  sg.gain.value = 0.16;
  s.connect(sg).connect(shaper);
  s.start(t);
  vib.start(t);
  s.stop(t + T + 0.1);
  vib.stop(t + T + 0.1);
}

