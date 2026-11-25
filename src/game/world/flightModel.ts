import * as THREE from "three";

// Arcade-sim fixed-wing flight model (pure: no React, no scene). One rigid body with
//   * lift  = q·CL(α) (linear up to the critical AoA, then it collapses toward a flat plate), q = kL·ρ·V²
//   * drag  = q·(CD0 + K·CL² + post-stall plate drag), side force = −q·CY·β (weathervaning)
//   * thrust along the nose, falling off with airspeed (a propeller), thin air above the ceiling band
//   * pitch / roll / yaw accelerations from the control surfaces ∝ V² (mushy when slow), aerodynamic
//     damping ∝ V, static stability (nose follows the airflow), dihedral, stall nose-drop + wing-drop buffet
//   * ground mode: three wheels on the terrain, rolling friction, brakes, nose-wheel steering, rotation at Vr
// Optional VTOL profile (spec.vtol): lift fans whose share of the thrust follows the "nacelle" state pl.nac
// (1 = hover, 0 = wing-borne). Hover holds a commanded climb rate, tilts the body to translate (fwd / side) with
// rotor-style drag, yaws on the spot, and a stability-augmentation loop levels it; the wing takes over as nac -> 0.
// Body axes (three.js object facing +Z): forward F = +Z, up U = +Y, right R = −X.
// Angular rates are stored as w = (roll right, pitch up, yaw right) in rad/s.

export type PlaneSpec = {
  kL: number; // ½ρS/m: lift acceleration per (m/s)² per unit CL at sea level
  CL0: number; CLa: number; aStall: number; aStallNeg: number;
  CD0: number; K: number; CY: number;
  T0: number; // full-throttle static thrust (m/s²)
  Vprop: number; // thrust has faded to zero at this airspeed
  Vref: number; // control derivatives below are quoted at this airspeed
  Me: number; Ma: number; Mq: number; aTrim: number; stallDrop: number;
  La: number; Lp: number; Lb: number;
  Nd: number; Nb: number; Nr: number;
  gearH: number; wheelbase: number; track: number; mainZ: number; len: number; span: number;
  vRot: number; rotMax: number; brake: number; rolling: number;
  ceil0: number; ceil1: number; // thin-air band (MSL metres)
  crashSink: number; crashBank: number;
  vtol?: VtolSpec;
};
export type VtolSpec = {
  lift: number; // max fan lift / weight
  tiltRate: number; // nacelle travel per second (0..1)
  climb: number; // m/s at full collective
  tilt: number; // body pitch / bank (rad) at full fwd / side input in the hover
  yawRate: number; // rad/s at full yaw input in the hover
  drag: number; // horizontal rotor drag (1/s) at full hover
  hoverThr: number; // main-engine thrust share kept in the hover (taxi / creep forward)
};

export const DEFAULT_SPEC: PlaneSpec = {
  kL: 0.009, CL0: 0.2, CLa: 4.6, aStall: 0.27, aStallNeg: -0.22,
  CD0: 0.035, K: 0.075, CY: 0.9,
  T0: 5.2, Vprop: 200,
  Vref: 60,
  Me: 7, Ma: 9, Mq: 4.2, aTrim: 0.02, stallDrop: 2.2,
  La: 8.5, Lp: 3.6, Lb: 0.9,
  Nd: 2.2, Nb: 4.5, Nr: 2.4,
  gearH: 1.45, wheelbase: 3.0, track: 2.6, mainZ: -0.4, len: 9, span: 11,
  vRot: 29, rotMax: 0.2, brake: 5.5, rolling: 0.025,
  ceil0: 500, ceil1: 1150,
  crashSink: 6.5, crashBank: 0.42,
};

/** Heavy VTOL gunship: slower, heavier and less agile on the wing, but hovers on its lift fans (H toggles). */
export const VTOL_SPEC: PlaneSpec = {
  ...DEFAULT_SPEC,
  kL: 0.0085, CL0: 0.25, CD0: 0.05, K: 0.07,
  T0: 6.2, Vprop: 185, Vref: 62,
  Me: 5, Ma: 7, Mq: 4.8, stallDrop: 1.6,
  La: 5.5, Lp: 3.8, Lb: 0.8,
  Nd: 1.8, Nb: 4, Nr: 2.8,
  gearH: 2.2, wheelbase: 7, track: 5, mainZ: -2, len: 17.5, span: 18,
  vRot: 31, brake: 6, rolling: 0.03,
  crashSink: 8, crashBank: 0.5,
  vtol: { lift: 1.6, tiltRate: 0.45, climb: 9, tilt: 0.32, yawRate: 0.9, drag: 0.3, hoverThr: 0.3 },
};

export const G = 9.81;

export type Ctl = {
  thr: number; elev: number; ail: number; rud: number; steer: number; brake: boolean;
  // VTOL only: nacelle target (1 hover, 0 forward flight), collective / translate / yaw commands (-1..1)
  nac: number; coll: number; fwd: number; side: number; yaw: number;
};
export const makeCtl = (): Ctl => ({ thr: 0, elev: 0, ail: 0, rud: 0, steer: 0, brake: false, nac: 0, coll: 0, fwd: 0, side: 0, yaw: 0 });

export type Plane = {
  p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3;
  onGround: boolean; heading: number; rot: number; thr: number;
  // read-outs (written every step)
  V: number; alpha: number; beta: number; stall: number; gs: number; agl: number; vs: number; rho: number;
  surf: { elev: number; ail: number; rud: number };
  bump: number;
  nac: number; // VTOL nacelle state (0 = forward flight)
  fan: number; // VTOL lift-fan output 0..1 (for the HUD / glow)
};

export function makePlane(x: number, y: number, z: number, heading: number): Plane {
  const pl: Plane = {
    p: new THREE.Vector3(x, y, z), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(),
    onGround: true, heading, rot: 0, thr: 0,
    V: 0, alpha: 0, beta: 0, stall: 0, gs: 1, agl: 0, vs: 0, rho: 1,
    surf: { elev: 0, ail: 0, rud: 0 }, bump: 0, nac: 0, fan: 0,
  };
  pl.q.setFromEuler(new THREE.Euler(0, heading, 0, "YXZ"));
  return pl;
}

export type Env = {
  ground: (x: number, z: number) => number;
  water?: (x: number, z: number) => number; // water depth (0 on land)
  /** true if the plane hit scenery this step (called every air step and every ground step) */
  blocked?: (pl: Plane) => boolean;
  limit?: number; // |x|, |z| hard wall
};

export type StepEvent = null | { kind: "crash"; why: string } | { kind: "land"; sink: number } | { kind: "liftoff" };

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Lift coefficient + how stalled we are (0..1). */
export function liftCurve(s: PlaneSpec, a: number): [number, number] {
  if (a <= s.aStall && a >= s.aStallNeg) return [s.CL0 + s.CLa * a, 0];
  const pos = a > 0;
  const peak = s.CL0 + s.CLa * (pos ? s.aStall : s.aStallNeg);
  const over = pos ? a - s.aStall : s.aStallNeg - a;
  const k = sm(0, 0.12, over);
  const plate = 0.85 * Math.sin(2 * a);
  return [peak * (1 - k) + plate * k, k];
}

// scratch (no per-step allocations)
const _qi = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _vl = new THREE.Vector3();
const _vh = new THREE.Vector3();
const _L = new THREE.Vector3();
const _a = new THREE.Vector3();
const _t = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const R_LOCAL = new THREE.Vector3(-1, 0, 0);
const F = new THREE.Vector3();
const U = new THREE.Vector3();
const Rw = new THREE.Vector3();
const _pt = new THREE.Vector3();

export const fwdOf = (q: THREE.Quaternion, out: THREE.Vector3) => out.set(0, 0, 1).applyQuaternion(q);
export const upOf = (q: THREE.Quaternion, out: THREE.Vector3) => out.set(0, 1, 0).applyQuaternion(q);
export const rightOf = (q: THREE.Quaternion, out: THREE.Vector3) => out.set(-1, 0, 0).applyQuaternion(q);
/** bank angle (rad, + = right wing down) */
export function bankOf(q: THREE.Quaternion) {
  rightOf(q, Rw); upOf(q, U);
  return Math.atan2(-Rw.y, U.y);
}

/** Aerodynamic + thrust acceleration (world, no gravity) into `out`; fills the read-outs. */
function aero(pl: Plane, c: Ctl, s: PlaneSpec, out: THREE.Vector3) {
  _qi.copy(pl.q).invert();
  _vl.copy(pl.v).applyQuaternion(_qi);
  const V = _vl.length();
  const rho = 1 - sm(s.ceil0, s.ceil1, pl.p.y) * 0.85;
  pl.V = V; pl.rho = rho;
  out.set(0, 0, 0);
  let alpha = 0, beta = 0, CL = 0, st = 0;
  if (V > 0.5) {
    alpha = Math.atan2(-_vl.y, _vl.z);
    beta = Math.atan2(-_vl.x, Math.hypot(_vl.z, _vl.y));
    [CL, st] = liftCurve(s, alpha);
    const qb = s.kL * V * V * rho;
    _vh.copy(_vl).divideScalar(V);
    _L.crossVectors(R_LOCAL, _vh);
    const ll = _L.length();
    if (ll > 1e-3) out.addScaledVector(_L, (qb * CL) / ll);
    const sa = Math.sin(alpha);
    const CD = s.CD0 + s.K * CL * CL + 1.1 * sa * sa * st + (c.brake && !pl.onGround ? 0.06 : 0) + Math.abs(Math.sin(beta)) * 0.25;
    out.addScaledVector(_vh, -qb * CD);
    out.x += qb * s.CY * Math.sin(beta);
  }
  // propeller: full thrust standing still, fading with airspeed
  const vt = s.vtol, nac = vt ? pl.nac : 0;
  out.z += s.T0 * pl.thr * rho * Math.max(0, 1 - V / s.Vprop) * (vt ? 1 - nac * (1 - vt.hoverThr) : 1);
  pl.fan = 0;
  if (vt && nac > 0.01) {
    // lift fans: hold the commanded climb rate (the fans push along the body's up axis)
    const uy = Math.max(0.35, 1 - 2 * (pl.q.x * pl.q.x + pl.q.z * pl.q.z));
    // parked (on the wheels, no collective): fans at idle so the brakes hold it
    const want = pl.onGround && c.coll <= 0 ? 0 : clamp(G + (c.coll * vt.climb - pl.v.y) * 2.5, 0, vt.lift * G);
    // the fans make up whatever the wing doesn't carry yet (smooth transition), within their tilted share
    const T = clamp(want / uy - out.y, 0, vt.lift * G * nac);
    out.y += T;
    pl.fan = T / (vt.lift * G);
    st *= 1 - nac; // no wing stall while the fans carry it
  }
  out.applyQuaternion(pl.q);
  if (vt && nac > 0.01) { const k = vt.drag * nac * nac * c.nac; out.x -= pl.v.x * k; out.z -= pl.v.z * k; } // rotor drag only while hovering, not converting
  pl.alpha = alpha; pl.beta = beta; pl.stall = st;
  return CL;
}

/** One fixed step. Returns what happened (crash / touchdown / liftoff) or null. */
export function step(pl: Plane, c: Ctl, env: Env, s: PlaneSpec, dt: number, rnd = Math.random): StepEvent {
  // throttle spools, control surfaces move at a finite rate (also what the model animates)
  pl.thr += clamp(c.thr - pl.thr, -0.8 * dt, 0.8 * dt);
  if (s.vtol) {
    // conversion corridor: the fans only hand over as fast as the wing can take the weight
    const Vs = Math.sqrt(G / (s.kL * (s.CL0 + s.CLa * s.aStall)));
    const floor = pl.onGround ? 0 : clamp(1 - (pl.V - 0.5 * Vs) / Vs, 0, 0.95);
    const target = Math.max(c.nac, Math.min(floor, pl.nac));
    pl.nac += clamp(target - pl.nac, -s.vtol.tiltRate * dt, s.vtol.tiltRate * dt);
  }
  const sf = pl.surf, k = Math.min(1, dt * 12);
  sf.elev += (c.elev - sf.elev) * k; sf.ail += (c.ail - sf.ail) * k; sf.rud += (c.rud - sf.rud) * k;
  pl.bump *= Math.exp(-5 * dt);
  const ev = pl.onGround ? groundStep(pl, c, env, s, dt) : airStep(pl, c, env, s, dt, rnd);
  const g = env.ground(pl.p.x, pl.p.z);
  pl.agl = pl.p.y - s.gearH - g;
  pl.vs = pl.v.y;
  // world bounds: a hard wall (the caller steers the pilot back before that)
  const lim = env.limit;
  if (lim) {
    if (Math.abs(pl.p.x) > lim) { pl.p.x = Math.sign(pl.p.x) * lim; if (pl.v.x * pl.p.x > 0) pl.v.x *= -0.2; }
    if (Math.abs(pl.p.z) > lim) { pl.p.z = Math.sign(pl.p.z) * lim; if (pl.v.z * pl.p.z > 0) pl.v.z *= -0.2; }
  }
  return ev;
}

// contact points in the body frame (x = right, y = up, z = forward), cached per spec
const pts = new WeakMap<PlaneSpec, { probes: [number, number, number][]; wheels: [number, number][] }>();
function pointsOf(s: PlaneSpec) {
  let p = pts.get(s);
  if (!p) {
    p = {
      probes: [[0, 0.1, s.len * 0.5], [0, 0.4, -s.len * 0.5], [s.span * 0.5, -0.3, 0.3], [-s.span * 0.5, -0.3, 0.3], [0, 1.1, 0.3]],
      wheels: [[s.track / 2, s.mainZ], [-s.track / 2, s.mainZ], [0, s.mainZ + s.wheelbase]],
    };
    pts.set(s, p);
  }
  return p;
}

function airStep(pl: Plane, c: Ctl, env: Env, s: PlaneSpec, dt: number, rnd: () => number): StepEvent {
  aero(pl, c, s, _a);
  const an = _a.length();
  _a.y -= G;
  pl.gs = an / G;
  pl.v.addScaledVector(_a, dt);
  pl.p.addScaledVector(pl.v, dt);
  // hard ceiling (the thin air above ceil0 should keep you well below it)
  if (pl.p.y > s.ceil1 + 150) { pl.p.y = s.ceil1 + 150; pl.v.y = Math.min(pl.v.y, 0); }

  // ---- rotation ----
  const Vn = pl.V / s.Vref;
  const Q = Vn * Vn * pl.rho;
  const D = Math.max(Vn, 0.3) * pl.rho + 0.15;
  const st = pl.stall;
  const w = pl.w; // x roll, y pitch, z yaw
  const sf = pl.surf;
  const buffet = st > 0.05 ? (rnd() - 0.5) * 14 * st * Math.min(1, Q * 2) : 0;
  let pd = s.La * sf.ail * Q * (1 - 0.6 * st) - s.Lp * w.x * D - s.Lb * pl.beta * Q + buffet;
  let qd = s.Me * sf.elev * Q - s.Ma * (pl.alpha - s.aTrim) * Q - s.Mq * w.y * D - s.stallDrop * st * Math.max(Q, 0.15);
  let rd = s.Nd * sf.rud * Q + s.Nb * pl.beta * Q - s.Nr * w.z * D;
  // slow / hanging on the prop: the heavy nose falls toward the ground
  const hov = s.vtol ? pl.nac : 0;
  const slow = (1 - sm(0.25, 0.6, Vn)) * (1 - hov);
  if (slow > 0) {
    _t.set(0, -1, 0).applyQuaternion(_qi.copy(pl.q).invert());
    qd += slow * 1.6 * Math.atan2(_t.y, Math.max(_t.z, -1));
    rd += slow * 0.8 * Math.atan2(-_t.x, Math.max(_t.z, 0.2));
  }
  // asymmetric wing drop when deep in the stall
  if (st > 0.5) pd += (st - 0.5) * 3 * Math.sign(w.x || pl.beta || 1) * Math.min(1, Q * 3);
  w.x += pd * dt; w.y += qd * dt; w.z += rd * dt;
  if (s.vtol && hov > 0.01) {
    // hover stability augmentation: attitude targets from fwd / side, yaw rate from yaw
    const vt = s.vtol;
    fwdOf(pl.q, F);
    const pitch = Math.asin(clamp(F.y, -1, 1)), bank = bankOf(pl.q);
    const kk = Math.min(1, dt * 7) * hov;
    w.x += ((c.side * vt.tilt - bank) * 2.6 - w.x) * kk;
    w.y += ((-c.fwd * vt.tilt - pitch) * 2.6 - w.y) * kk;
    w.z += (c.yaw * vt.yawRate - w.z) * kk;
  }
  _ax.set(-w.y, -w.z, w.x);
  const ang = _ax.length() * dt;
  if (ang > 1e-9) {
    _dq.setFromAxisAngle(_ax.normalize(), ang);
    pl.q.multiply(_dq).normalize();
  }

  // ---- ground / scenery contact ----
  if (env.blocked?.(pl)) return { kind: "crash", why: "hit an obstacle" }; // towers / trees / creatures: the caller keeps this cheap
  const g = env.ground(pl.p.x, pl.p.z);
  if (pl.p.y - g > s.span + 4) return null;
  fwdOf(pl.q, F); upOf(pl.q, U); rightOf(pl.q, Rw);
  const depth = env.water?.(pl.p.x, pl.p.z) ?? 0;
  if (depth > 0.5 && pl.p.y - s.gearH < g + depth + 0.2) return { kind: "crash", why: "ditched in water" };
  // fuselage / wingtips / tail scraping the ground
  const { probes, wheels } = pointsOf(s);
  for (const [x, y, z] of probes) {
    _pt.copy(pl.p).addScaledVector(Rw, -x).addScaledVector(U, y).addScaledVector(F, z);
    if (_pt.y < env.ground(_pt.x, _pt.z)) return { kind: "crash", why: z > s.len * 0.4 ? "nosed into the ground" : x ? "wingtip struck the ground" : "hit the ground" };
  }
  // wheels
  let touch = false;
  for (const [x, z] of wheels) {
    _pt.copy(pl.p).addScaledVector(Rw, -x).addScaledVector(U, -s.gearH).addScaledVector(F, z);
    if (_pt.y <= env.ground(_pt.x, _pt.z) + 0.02) { touch = true; break; }
  }
  if (!touch) return null;
  const sink = -pl.v.y;
  if (sink < 0.3) {
    // brushing the runway while climbing away (just after liftoff): ride over it, stay airborne
    pl.p.y += Math.max(0, env.ground(pl.p.x, pl.p.z) + s.gearH - pl.p.y);
    if (pl.v.y < 0) pl.v.y = 0;
    return null;
  }
  const bank = Math.atan2(-Rw.y, U.y);
  const pitch = Math.asin(clamp(F.y, -1, 1));
  if (sink > s.crashSink) return { kind: "crash", why: `hard landing (${sink.toFixed(1)} m/s sink)` };
  if (Math.abs(bank) > s.crashBank || U.y < 0.6) return { kind: "crash", why: "cartwheeled (wing down on touchdown)" };
  if (pl.V > 105) return { kind: "crash", why: "touched down far too fast" };
  const tp = terrainPitch(pl, env, s, Math.atan2(F.x, F.z));
  if (pitch - tp < -0.12 && sink > 1.5) return { kind: "crash", why: "landed nose first" };
  // touchdown: switch to the wheels
  pl.onGround = true;
  pl.heading = Math.atan2(F.x, F.z);
  pl.rot = clamp(pitch - tp, 0, s.rotMax);
  pl.w.set(0, 0, 0);
  pl.bump = Math.min(1, sink / s.crashSink);
  if (sink > 3) pl.v.y = sink * 0.15; // a little bounce on a firm arrival
  return { kind: "land", sink };
}

function terrainPitch(pl: Plane, env: Env, s: PlaneSpec, heading: number) {
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const zn = s.mainZ + s.wheelbase;
  const hn = env.ground(pl.p.x + fx * zn, pl.p.z + fz * zn);
  const hm = env.ground(pl.p.x + fx * s.mainZ, pl.p.z + fz * s.mainZ);
  return Math.atan2(hn - hm, s.wheelbase);
}

function groundStep(pl: Plane, c: Ctl, env: Env, s: PlaneSpec, dt: number): StepEvent {
  const h = pl.heading;
  const fx = Math.sin(h), fz = Math.cos(h);
  const rx = -Math.cos(h), rz = Math.sin(h); // right
  // wheel heights -> attitude on the ground
  const zn = s.mainZ + s.wheelbase;
  const hn = env.ground(pl.p.x + fx * zn, pl.p.z + fz * zn);
  const hm = env.ground(pl.p.x + fx * s.mainZ, pl.p.z + fz * s.mainZ);
  const hl = env.ground(pl.p.x - rx * s.track / 2 + fx * s.mainZ, pl.p.z - rz * s.track / 2 + fz * s.mainZ);
  const hr = env.ground(pl.p.x + rx * s.track / 2 + fx * s.mainZ, pl.p.z + rz * s.track / 2 + fz * s.mainZ);
  const tp = Math.atan2(hn - hm, s.wheelbase);
  const roll = Math.atan2(hl - hr, s.track);
  pl.q.setFromEuler(_e.set(-(tp + pl.rot), h, roll, "YXZ"));

  const CL = aero(pl, c, s, _a);
  pl.gs = 1;
  void CL;
  // forward / lateral speeds in the heading frame
  let vf = pl.v.x * fx + pl.v.z * fz;
  let vlat = pl.v.x * rx + pl.v.z * rz;
  const load = Math.max(0, G - _a.y) / G; // lift takes weight off the wheels
  let af = _a.x * fx + _a.z * fz - G * Math.sin(tp) * Math.cos(tp);
  const fric = (s.rolling + (c.brake ? s.brake / G : 0)) * G * load;
  // friction can stop the plane but never push it backwards
  if (Math.abs(vf) < fric * dt && Math.abs(af) < fric) { vf = 0; af = 0; }
  else af -= Math.sign(vf || af) * fric;
  vf += af * dt;
  vlat += (_a.x * rx + _a.z * rz) * dt;
  vlat *= Math.exp(-7 * dt * Math.max(0.2, load));

  // nose-wheel steering (tight when slow), plus the rudder once there's airflow
  const V = Math.abs(vf);
  const lock = 0.6 / (1 + V * 0.12);
  const Vn = pl.V / s.Vref;
  let yawRate = (vf / s.wheelbase) * Math.tan(c.steer * lock) + s.Nd * c.rud * Vn * Vn * 0.25;
  if (s.vtol) yawRate += c.yaw * s.vtol.yawRate * 0.5 * pl.nac; // pivot on the spot with the fans (yawRate > 0 turns right)
  const maxYaw = (0.45 * G) / Math.max(V, 4); // tyres give ~0.45 g sideways
  yawRate = clamp(yawRate, -maxYaw, maxYaw);
  pl.heading -= yawRate * dt;

  // rotation: the elevator lifts the nose once the airflow is strong enough
  const want = c.elev > 0 ? c.elev * s.rotMax * sm(0.7 * s.vRot, s.vRot, pl.V) : 0;
  pl.rot += clamp(want - pl.rot, -0.35 * dt, 0.25 * dt);

  const nfx = Math.sin(pl.heading), nfz = Math.cos(pl.heading);
  const nrx = -Math.cos(pl.heading), nrz = Math.sin(pl.heading);
  pl.v.set(nfx * vf + nrx * vlat, 0, nfz * vf + nrz * vlat);
  const px = pl.p.x, pz = pl.p.z, py = pl.p.y;
  pl.p.x += pl.v.x * dt;
  pl.p.z += pl.v.z * dt;
  const g = env.ground(pl.p.x, pl.p.z);
  const groundV = (g + s.gearH - py) / dt;
  pl.w.set(0, 0, -yawRate);

  const depth = env.water?.(pl.p.x, pl.p.z) ?? 0;
  if (depth > 0.6) {
    if (V > 6) return { kind: "crash", why: "taxied into the water" };
    pl.p.x = px; pl.p.z = pz; pl.v.set(0, 0, 0);
  }
  if (env.blocked?.(pl)) {
    if (V > 9) return { kind: "crash", why: "rammed an obstacle" };
    pl.p.x = px; pl.p.z = pz; pl.v.multiplyScalar(-0.2);
  }
  // net upward force: fly
  if (_a.y > G * 1.02 && (pl.V > s.vRot * 0.75 || (s.vtol && pl.nac > 0.5))) {
    pl.onGround = false;
    pl.p.y = Math.max(py, g + s.gearH) + 0.02;
    pl.v.y = Math.max(0.3, groundV * 0.5);
    pl.w.set(0, 0, 0);
    return { kind: "liftoff" };
  }
  // over a crest / off a ledge faster than the wheels can follow
  if (groundV < -6 && V > 12) {
    pl.onGround = false;
    pl.v.y = 0;
    return { kind: "liftoff" };
  }
  pl.p.y = g + s.gearH;
  pl.v.y = clamp(groundV, -20, 20);
  return null;
}

// ---------- instructor (mouse-aim autopilot) ----------
const _d = new THREE.Vector3();
/**
 * Steer the plane toward a world direction (unit vector): bank toward the target and pull, rudder for fine
 * aim, wings level when the target is near the nose. Writes elev / ail / rud / steer into `c` (keyboard
 * overrides are applied by the caller afterwards). `limitAoA` keeps the pull below the stall.
 */
export function instructor(pl: Plane, dir: THREE.Vector3, c: Ctl, s: PlaneSpec, limitAoA = true) {
  _d.copy(dir).applyQuaternion(_qi.copy(pl.q).invert());
  const up = _d.y, fw = _d.z, rt = -_d.x;
  const off = Math.acos(clamp(fw, -1, 1));
  const pitchErr = Math.atan2(up, Math.max(fw, 0.05) + (fw < 0.05 ? Math.abs(rt) * 0.2 : 0));
  const yawErr = Math.atan2(rt, Math.max(fw, 0.05));
  const w = pl.w;
  if (pl.onGround) {
    c.steer = clamp(yawErr * 2.5, -1, 1);
    c.rud = clamp(yawErr * 2, -1, 1);
    c.ail = 0;
    // look above the horizon to rotate
    c.elev = clamp((Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) - 0.04) * 5, -0.3, 1);
    return;
  }
  // roll: put the target "above" the canopy when it's off the nose, else level the wings
  const bank = bankOf(pl.q);
  let wRoll = sm(0.04, 0.22, off);
  if (up < 0) wRoll *= sm(0.25, 0.7, off); // slightly below: push, don't roll inverted
  const toTarget = Math.atan2(rt, up);
  const rollErr = wRoll * toTarget + (1 - wRoll) * -bank;
  const Vn = Math.max(0.35, pl.V / s.Vref);
  c.ail = clamp((rollErr * 3.2 - w.x * 0.55) / Vn, -1, 1);
  let elev = (pitchErr * 4.5 - w.y * 0.9) / Vn;
  if (up < 0 && wRoll > 0.5) elev = Math.max(elev, -0.15); // rolling over to it: don't push
  if (limitAoA) {
    elev = Math.min(elev, (s.aStall - 0.035 - pl.alpha) * 10 + 0.25);
    elev = Math.max(elev, (s.aStallNeg + 0.04 - pl.alpha) * 10 - 0.25);
    // G limit ~7.5 at speed
    if (pl.gs > 7.5) elev = Math.min(elev, 0.1);
  }
  c.elev = clamp(elev, -1, 1);
  c.rud = clamp(yawErr * 2.4 * (1 - wRoll * 0.6) - w.z * 0.5 + pl.beta * 1.5, -1, 1);
  c.steer = 0;
}
