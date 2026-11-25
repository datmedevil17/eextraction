import * as THREE from "three";

// World-space retarget: both rigs rest in a T-pose, Y-up, facing +Z (Quaternius exports), so every
// mapped bone gets the source bone's world-space rotation *delta* from rest applied on top of its own
// rest orientation. The hips' translation is scaled by the leg-length ratio.

export type BoneMap = Record<string, string>; // target bone name -> source bone name (raw glTF names)

const san = (n: string) => THREE.PropertyBinding.sanitizeNodeName(n);

function bonesByName(root: THREE.Object3D) {
  const m = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) m.set(o.name, o);
  });
  return m;
}

export function retargetClip(src: THREE.Object3D, clip: THREE.AnimationClip, tgt: THREE.Object3D, map: BoneMap, hips: [string, string], opts: { fps?: number; inPlace?: boolean } = {}) {
  const fps = opts.fps ?? 30;
  const sB = bonesByName(src);
  const tB = bonesByName(tgt);
  src.updateMatrixWorld(true);
  tgt.updateMatrixWorld(true);

  // target bones in parent-first order
  const order: THREE.Object3D[] = [];
  tgt.traverse((o) => {
    if ((o as THREE.Bone).isBone) order.push(o);
  });
  const pairs = new Map<THREE.Object3D, THREE.Object3D>();
  for (const [t, s] of Object.entries(map)) {
    const tb = tB.get(san(t)), sb = sB.get(san(s));
    if (tb && sb) pairs.set(tb, sb);
  }
  const restLocal = new Map(order.map((b) => [b, b.quaternion.clone()]));
  const tRestW = new Map(order.map((b) => [b, b.getWorldQuaternion(new THREE.Quaternion())]));
  const sRestInv = new Map([...pairs.values()].map((b) => [b, b.getWorldQuaternion(new THREE.Quaternion()).invert()]));
  const topParentW = new Map(order.filter((b) => !(b.parent as THREE.Bone)?.isBone).map((b) => [b, b.parent!.getWorldQuaternion(new THREE.Quaternion())]));

  const sHip = sB.get(san(hips[1]))!, tHip = tB.get(san(hips[0]))!;
  const sHip0 = sHip.getWorldPosition(new THREE.Vector3());
  const tHip0 = tHip.getWorldPosition(new THREE.Vector3());
  const ratio = tHip0.y / Math.max(1e-3, sHip0.y);
  const hipParentInv = tHip.parent!.matrixWorld.clone().invert();

  const mixer = new THREE.AnimationMixer(src);
  const action = mixer.clipAction(clip);
  action.play();
  const n = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(n);
  const qv = new Map(order.filter((b) => pairs.has(b)).map((b) => [b, new Float32Array(n * 4)]));
  const pv = new Float32Array(n * 3);
  const worldQ = new Map<THREE.Object3D, THREE.Quaternion>();
  const q = new THREE.Quaternion(), w = new THREE.Quaternion(), p = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const t = Math.min(clip.duration, i / fps);
    times[i] = t;
    mixer.setTime(t);
    src.updateMatrixWorld(true);
    for (const b of order) {
      const parentW = topParentW.get(b) ?? worldQ.get(b.parent!)!;
      const sb = pairs.get(b);
      let local: THREE.Quaternion;
      if (sb) {
        // target world = (source world * source rest^-1) * target rest
        w.copy(sb.getWorldQuaternion(q)).multiply(sRestInv.get(sb)!).multiply(tRestW.get(b)!);
        local = parentW.clone().invert().multiply(w);
        qv.get(b)!.set([local.x, local.y, local.z, local.w], i * 4);
      } else local = restLocal.get(b)!;
      worldQ.set(b, parentW.clone().multiply(local));
    }
    sHip.getWorldPosition(p).sub(sHip0).multiplyScalar(ratio).add(tHip0);
    p.applyMatrix4(hipParentInv);
    pv.set([p.x, p.y, p.z], i * 3);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(src);

  if (opts.inPlace) {
    // remove the horizontal drift so loops stay on the spot (the game moves the character)
    const hp = tHip0.clone().applyMatrix4(hipParentInv);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(hipParentInv);
    for (let i = 0; i < n; i++) {
      p.fromArray(pv, i * 3).sub(hp);
      const along = p.dot(up);
      p.copy(up).multiplyScalar(along).add(hp);
      pv.set([p.x, p.y, p.z], i * 3);
    }
  }

  const tracks: THREE.KeyframeTrack[] = [];
  for (const [b, v] of qv) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, v));
  tracks.push(new THREE.VectorKeyframeTrack(`${tHip.name}.position`, times, pv));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}
