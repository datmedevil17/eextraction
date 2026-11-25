import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// Loads a (Sketchfab-style) GLB and normalises it: feet on y = 0, centred, facing +Z, scaled so its
// body length (or height / wingspan) matches a target in metres. Facing is detected from the head
// bone (or a given yaw). Returns a template to clone with SkeletonUtils.clone + the clips by name.

export type Kit = { template: THREE.Group; clips: Record<string, THREE.AnimationClip>; size: THREE.Vector3 };
type Fit = { len?: number; height?: number; span?: number; yaw?: number; head?: RegExp };

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<Kit>>();

export function loadKit(url: string, fit: Fit): Promise<Kit> {
  const key = url + JSON.stringify({ ...fit, head: fit.head?.source });
  let p = cache.get(key);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => build(gltf.scene, gltf.animations, fit));
    cache.set(key, p);
  }
  return p;
}

function build(scene: THREE.Object3D, anims: THREE.AnimationClip[], fit: Fit): Kit {
  scene.updateMatrixWorld(true);
  let yaw = fit.yaw;
  if (yaw === undefined) {
    const box = new THREE.Box3().setFromObject(scene, true);
    const c = box.getCenter(new THREE.Vector3());
    let head: THREE.Object3D | undefined;
    const re = fit.head ?? /head|skull/i;
    scene.traverse((o) => {
      if (!head && (o as THREE.Bone).isBone && re.test(o.name)) head = o;
    });
    yaw = 0;
    if (head) {
      const h = head.getWorldPosition(new THREE.Vector3()).sub(c);
      // rotate so the head points to +Z (snap to the nearest axis)
      const a = Math.atan2(h.x, h.z);
      yaw = -Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
    }
  }
  const spin = new THREE.Group();
  spin.rotation.y = yaw;
  spin.add(scene);
  spin.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(spin, true);
  const size = box.getSize(new THREE.Vector3());
  const k = fit.len ? fit.len / size.z : fit.span ? fit.span / Math.max(size.x, size.z) : fit.height ? fit.height / size.y : 1;
  const c = box.getCenter(new THREE.Vector3());
  const fitG = new THREE.Group();
  fitG.scale.setScalar(k);
  fitG.position.set(-c.x * k, -box.min.y * k, -c.z * k);
  fitG.add(spin);
  const template = new THREE.Group();
  template.add(fitG);
  template.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    // skinned meshes keep their bind-pose bounds, so they would pop out while animating; static ones cull normally
    m.frustumCulled = !(m as THREE.SkinnedMesh).isSkinnedMesh;
    m.castShadow = true;
    m.receiveShadow = true;
  });
  return { template, clips: Object.fromEntries(anims.map((a) => [a.name, a])), size: size.multiplyScalar(k) };
}

/** Toggle shadow casting on a whole instance, only touching the tree when the state changes. */
const shadowState = new WeakMap<THREE.Object3D, boolean>();
export function setShadow(obj: THREE.Object3D, on: boolean) {
  if (shadowState.get(obj) === on) return;
  shadowState.set(obj, on);
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = on; });
}

/** Clone every mesh material of an instance so it can be tinted on its own. */
export function ownMaterials(obj: THREE.Object3D) {
  const mats: THREE.MeshStandardMaterial[] = [];
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mm = (m.material as THREE.MeshStandardMaterial).clone();
    m.material = mm;
    mats.push(mm);
  });
  return mats;
}
