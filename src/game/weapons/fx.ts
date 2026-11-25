import * as THREE from "three";

// Additive, bloom-friendly effect pools: streaks (bolts, beams, arcs), sparks, blasts.
// Colours are pushed above 1.0 on toneMapped=false materials so the Bloom pass makes them glow.

const mat = () =>
  new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });

const _o = new THREE.Object3D();
const _c = new THREE.Color();
const _d = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);

export class Streaks {
  mesh: THREE.InstancedMesh;
  n = 0;
  constructor(public cap: number) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(), cap);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 10;
    this.mesh.setColorAt(0, _c.set(0));
  }
  begin() {
    this.n = 0;
  }
  add(a: THREE.Vector3, b: THREE.Vector3, w: number, color: THREE.Color, k: number) {
    if (this.n >= this.cap) return;
    _o.position.copy(a).add(b).multiplyScalar(0.5);
    _d.copy(b).sub(a);
    const len = _d.length();
    if (len < 1e-4) return;
    _o.quaternion.setFromUnitVectors(_z, _d.divideScalar(len));
    _o.scale.set(w, w, len);
    _o.updateMatrix();
    this.mesh.setMatrixAt(this.n, _o.matrix);
    this.mesh.setColorAt(this.n, _c.copy(color).multiplyScalar(k));
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export class Sparks {
  mesh: THREE.InstancedMesh;
  px: Float32Array; py: Float32Array; pz: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  life: Float32Array; max: Float32Array; size: Float32Array;
  col: THREE.Color[];
  head = 0;
  constructor(public cap = 700) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(), cap);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.count = 0;
    this.px = new Float32Array(cap); this.py = new Float32Array(cap); this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap); this.size = new Float32Array(cap);
    this.col = Array.from({ length: cap }, () => new THREE.Color());
    this.mesh.setColorAt(0, _c.set(0));
  }
  burst(p: THREE.Vector3, color: THREE.Color, n: number, speed: number, size = 0.05, dir?: THREE.Vector3, spreadK = 1) {
    for (let i = 0; i < n; i++) {
      const k = this.head++ % this.cap;
      this.px[k] = p.x; this.py[k] = p.y; this.pz[k] = p.z;
      let x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1;
      const l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
      if (dir) { x = x * spreadK + dir.x; y = y * spreadK + dir.y; z = z * spreadK + dir.z; }
      const s = speed * (0.35 + Math.random() * 0.65);
      this.vx[k] = x * s; this.vy[k] = y * s; this.vz[k] = z * s;
      this.life[k] = this.max[k] = 0.25 + Math.random() * 0.4;
      this.size[k] = size * (0.6 + Math.random() * 0.8);
      this.col[k].copy(color);
    }
  }
  update(dt: number) {
    let n = 0;
    for (let k = 0; k < this.cap; k++) {
      if (this.life[k] <= 0) continue;
      this.life[k] -= dt;
      if (this.life[k] <= 0) continue;
      this.vy[k] -= 6 * dt;
      const d = Math.exp(-2.2 * dt);
      this.vx[k] *= d; this.vy[k] *= d; this.vz[k] *= d;
      this.px[k] += this.vx[k] * dt; this.py[k] += this.vy[k] * dt; this.pz[k] += this.vz[k] * dt;
      const f = this.life[k] / this.max[k];
      _o.position.set(this.px[k], this.py[k], this.pz[k]);
      _o.quaternion.identity();
      _o.scale.setScalar(this.size[k] * (0.4 + f));
      _o.updateMatrix();
      this.mesh.setMatrixAt(n, _o.matrix);
      this.mesh.setColorAt(n, _c.copy(this.col[k]).multiplyScalar(2.5 * f + 0.3));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

type Blast = { x: number; y: number; z: number; t: number; dur: number; r: number; c: THREE.Color };
export class Blasts {
  mesh: THREE.InstancedMesh;
  list: Blast[] = [];
  constructor(public cap = 24) {
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 20, 14), mat(), cap);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.setColorAt(0, _c.set(0));
    this.mesh.count = 0; // nothing until the first add (else `cap` white unit spheres sit at the origin)
  }
  add(p: THREE.Vector3, r: number, color: THREE.Color, dur = 0.45) {
    if (this.list.length >= this.cap) this.list.shift();
    this.list.push({ x: p.x, y: p.y, z: p.z, t: 0, dur, r, c: color.clone() });
  }
  update(dt: number) {
    this.list = this.list.filter((b) => (b.t += dt) < b.dur);
    this.list.forEach((b, i) => {
      const f = b.t / b.dur;
      const e = 1 - Math.pow(1 - f, 3);
      _o.position.set(b.x, b.y, b.z);
      _o.scale.setScalar(Math.max(0.01, b.r * (0.15 + e * 0.85)));
      _o.quaternion.identity();
      _o.updateMatrix();
      this.mesh.setMatrixAt(i, _o.matrix);
      this.mesh.setColorAt(i, _c.copy(b.c).multiplyScalar(Math.pow(1 - f, 2) * 2.2));
    });
    this.mesh.count = this.list.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
