// Mutable plane read-outs shared by Planes (writer), PlaneHud and the minimap (readers). Not reactive on purpose.

export type PlaneMark = { label: string; color: string; x: number; z: number; heading: number; flying: boolean; wreck: boolean; mine: boolean };
/** live plane positions for the radar / full map, keyed by plane id */
export const planeMarks: Record<string, PlaneMark> = {};

export const planeHud = {
  active: false, // in the cockpit (HUD shown)
  chute: false, // under the parachute
  prompt: null as string | null, // "F · fly" etc. when on foot next to a plane
  kmh: 0, ias: 0, alt: 0, agl: 0, vs: 0, thr: 0, gs: 1, aoa: 0, stall: 0, rho: 1,
  heading: 0, pitch: 0, bank: 0,
  onGround: true, brake: false, view: "chase" as "chase" | "cockpit", freeLook: false,
  heat: 0, overheat: false, ammo: 0, ammoMax: 0, rockets: 0, rocketsMax: 0, rocketReload: 0,
  /** screen positions (NDC -1..1, z > 1 = behind the camera) of the aim point and of where the guns point */
  aimX: 0, aimY: 0, aimOn: false, noseX: 0, noseY: 0, noseOn: false,
  /** aim assist: locked target box (NDC centre + size), its lead pip, label / range / health */
  lockOn: false, lockX: 0, lockY: 0, lockR: 0.05, lockDist: 0, lockLabel: "", lockHp: 1, lockT: 0, leadOn: false, leadX: 0, leadY: 0,
  warn: "" as string, // stall / pull up / turn back / ceiling
  msg: "" as string, msgT: 0, // transient banner (crash, eject, ...)
  ejectArm: 0, // > 0: a second F bails out
  vtol: false, hover: false, nac: 0, fan: 0, // VTOL: hover mode selected, nacelle state (1 = fans), fan output
};

/** Draw every plane (icon + label on the big map) into a minimap context. toXY maps world -> screen; rot = how much the
 *  map is rotated (radar: the player's yaw, full map: 0) so the icon points along the plane's heading. */
export function drawPlaneMarks(ctx: CanvasRenderingContext2D, toXY: (x: number, z: number) => [number, number], big: boolean, rot: number) {
  for (const id in planeMarks) {
    const m = planeMarks[id];
    const [sx, sy] = toXY(m.x, m.z);
    const u = big ? 1.15 : 0.85;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath();
    ctx.arc(0, 0, 10 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = m.wreck ? "#ff5a4a" : m.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.rotate(Math.PI - m.heading + rot);
    ctx.scale(u, u);
    ctx.fillStyle = m.wreck ? "#ff5a4a" : m.flying ? "#ffffff" : m.color;
    ctx.beginPath(); // top-down silhouette, nose up (-y)
    ctx.moveTo(0, -8); ctx.lineTo(1.4, -5); ctx.lineTo(1.4, -1.5); ctx.lineTo(7.5, 0); ctx.lineTo(7.5, 1.6); ctx.lineTo(1.4, 1.4);
    ctx.lineTo(1, 5); ctx.lineTo(3.6, 6.2); ctx.lineTo(3.6, 7.3); ctx.lineTo(0, 7); ctx.lineTo(-3.6, 7.3); ctx.lineTo(-3.6, 6.2);
    ctx.lineTo(-1, 5); ctx.lineTo(-1.4, 1.4); ctx.lineTo(-7.5, 1.6); ctx.lineTo(-7.5, 0); ctx.lineTo(-1.4, -1.5); ctx.lineTo(-1.4, -5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (big) {
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.fillText(`${m.label}${m.wreck ? " · wrecked" : m.mine ? " · you" : m.flying ? " · flying" : ""}`, sx, sy + 20);
    }
  }
}
