import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GUNS, type GunDef } from "./arsenal";

// Loads each gun once, normalises it (barrel -> -Z, ~0.62 m long) and hands out clones.

export type GunModel = { root: THREE.Group; muzzle: THREE.Vector3; length: number; ejector: THREE.Vector3 };

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GunModel>>();
export const hologramUniforms = {
  uReveal: { value: 1 },
  uHolo: { value: new THREE.Color("#35e0ff") },
  uTime: { value: 0 },
};

function patch(m: THREE.Material) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, hologramUniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vHP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHP = (modelViewMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vHP; uniform float uReveal; uniform vec3 uHolo; uniform float uTime;
        float hh(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164))) * 43758.5453); }`,
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        if (uReveal < 0.999) {
          // scan front sweeps from stock to muzzle (camera-space depth)
          float k = clamp((-vHP.z - 0.2) / 0.9, 0.0, 1.0);
          float n = hh(floor(vHP * 90.0)) * 0.18;
          float front = uReveal * 1.35 - 0.12 - k + n;
          if (front < 0.0) discard;
          float edge = 1.0 - smoothstep(0.0, 0.16, front);
          float scan = 0.5 + 0.5 * sin(vHP.y * 220.0 - uTime * 18.0);
          vec3 holo = uHolo * (1.6 + scan * 1.4);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, holo, clamp(edge + (1.0 - uReveal) * 0.55, 0.0, 1.0));
          gl_FragColor.a = 1.0;
        }`,
      );
  };
  m.customProgramCacheKey = () => "holo-gun";
}

function load(def: GunDef): Promise<GunModel> {
  let p = cache.get(def.id);
  if (p) return p;
  p = loader.loadAsync(`/models/guns/${def.id}.gltf`).then((gltf) => {
    const src = gltf.scene;
    const box = new THREE.Box3().setFromObject(src);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const isLauncher = def.cls === "Launcher";
    const target = isLauncher ? 0.7 : def.cls === "Sniper" || def.cls === "Crossbow" ? 0.95 : def.cls === "Pistol" ? 0.34 : 0.7;
    const scale = target / size.x;
    // inner: recentre so the grip area sits near the origin, rotate +X -> -Z
    const inner = new THREE.Group();
    const rear = def.cls === "Pistol" ? 0.3 : def.cls === "Sniper" || def.cls === "Crossbow" ? 0.2 : 0.26;
    src.position.set(-(box.min.x + size.x * rear), -c.y, -c.z); // grip near the origin, barrel runs forward
    inner.add(src);
    inner.scale.setScalar(scale);
    const root = new THREE.Group();
    inner.rotation.y = Math.PI / 2;
    root.add(inner);
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
        const cl = m.clone() as THREE.MeshStandardMaterial;
        cl.envMapIntensity = 1.2;
        if (cl.name === "Main") cl.emissive = new THREE.Color(def.color).multiplyScalar(0.05);
        patch(cl);
        return cl;
      });
      mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
      mesh.frustumCulled = false;
    });
    root.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(root);
    const muzzle = new THREE.Vector3((b2.min.x + b2.max.x) / 2, (b2.min.y + b2.max.y) / 2 + (b2.max.y - b2.min.y) * 0.1, b2.min.z - 0.02);
    const ejector = new THREE.Vector3(b2.max.x, muzzle.y, (b2.min.z + b2.max.z) / 2);
    return { root, muzzle, length: b2.max.z - b2.min.z, ejector };
  });
  cache.set(def.id, p);
  return p;
}

export const loadGun = load;
export const preloadAll = () => Promise.all(GUNS.map(load));

/** a fresh clone of the gun (own matrices, shared geometry/materials) */
export async function cloneGun(def: GunDef) {
  const m = await load(def);
  return { root: m.root.clone(true), muzzle: m.muzzle.clone(), length: m.length };
}

// ---------- thumbnails (offscreen, rendered lazily one at a time) ----------
const thumbs = new Map<string, string>();
let tr: THREE.WebGLRenderer | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function thumbnail(def: GunDef): Promise<string> {
  const hit = thumbs.get(def.id);
  if (hit) return Promise.resolve(hit);
  const job = queue.then(async () => {
    const again = thumbs.get(def.id);
    if (again) return again;
    const m = await load(def);
    if (!tr) tr = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    tr.setSize(360, 200, false);
    tr.setClearColor(0x000000, 0);
    tr.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const obj = m.root.clone(true);
    obj.rotation.set(0.12, -Math.PI / 2 + 0.55, 0); // side-on, a touch of three-quarter
    scene.add(obj);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2.2));
    const key = new THREE.DirectionalLight(def.color, 3);
    key.position.set(2, 2, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 2);
    rim.position.set(-3, 1, -2);
    scene.add(rim);
    const holoWas = hologramUniforms.uReveal.value;
    hologramUniforms.uReveal.value = 1;
    const cam = new THREE.PerspectiveCamera(24, 360 / 200, 0.1, 20);
    const dist = Math.max(m.length, 0.45) * 2.3;
    cam.position.set(0, 0.05, dist);
    cam.lookAt(0, 0, 0);
    tr.render(scene, cam);
    hologramUniforms.uReveal.value = holoWas;
    const url = tr.domElement.toDataURL("image/png");
    thumbs.set(def.id, url);
    return url;
  });
  queue = job.catch(() => undefined);
  return job;
}
