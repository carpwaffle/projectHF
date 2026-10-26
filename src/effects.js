// Gunfire effects: muzzle flash, bullet tracers and impact sparks.
//
// All drawn with additive blending and small generated canvas textures, so
// there are no extra assets to load and they stay cheap (no extra lights in
// the world; the baked map isn't lit dynamically anyway).

import * as THREE from 'three';

const FLASH_LIFE = 0.06; // seconds a muzzle flash lasts
const TRACER_LIFE = 0.16;
const IMPACT_LIFE = 0.09;

// ---- textures (generated once) ---------------------------------------------

let textures = null;

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function fxTextures() {
  textures ??= {
    // Head-on flash: hot core, soft glow and a few sharp spikes.
    star: canvasTexture(128, 128, (g, w) => {
      const c = w / 2;
      const glow = g.createRadialGradient(c, c, 0, c, c, c);
      glow.addColorStop(0, 'rgba(255,255,240,1)');
      glow.addColorStop(0.18, 'rgba(255,230,150,0.95)');
      glow.addColorStop(0.45, 'rgba(255,150,40,0.35)');
      glow.addColorStop(1, 'rgba(255,90,0,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, w, w);
      g.translate(c, c);
      for (let i = 0; i < 6; i++) {
        g.rotate(Math.PI / 3 + (i % 2 ? 0.25 : -0.15));
        const spike = g.createLinearGradient(0, 0, c * (i % 2 ? 0.75 : 0.98), 0);
        spike.addColorStop(0, 'rgba(255,245,200,0.95)');
        spike.addColorStop(1, 'rgba(255,160,40,0)');
        g.fillStyle = spike;
        g.beginPath();
        g.moveTo(0, -c * 0.07);
        g.lineTo(c * (i % 2 ? 0.75 : 0.98), 0);
        g.lineTo(0, c * 0.07);
        g.fill();
      }
    }),
    // Side view of the flame: bright at the base (bottom), tapering forward.
    flame: canvasTexture(64, 128, (g, w, h) => {
      g.translate(w / 2, h);
      g.scale(1, -1);
      const body = g.createLinearGradient(0, 0, 0, h);
      body.addColorStop(0, 'rgba(255,250,220,1)');
      body.addColorStop(0.3, 'rgba(255,200,90,0.9)');
      body.addColorStop(0.75, 'rgba(255,120,20,0.35)');
      body.addColorStop(1, 'rgba(255,80,0,0)');
      g.fillStyle = body;
      g.beginPath();
      g.moveTo(-w * 0.12, 0);
      g.bezierCurveTo(-w * 0.5, h * 0.35, -w * 0.18, h * 0.75, 0, h);
      g.bezierCurveTo(w * 0.18, h * 0.75, w * 0.5, h * 0.35, w * 0.12, 0);
      g.fill();
    }),
    // Tracer cross-section: bright core fading to the edges (along v).
    beam: canvasTexture(4, 64, (g, w, h) => {
      const across = g.createLinearGradient(0, 0, 0, h);
      across.addColorStop(0, 'rgba(255,170,60,0)');
      across.addColorStop(0.3, 'rgba(255,190,90,0.35)');
      across.addColorStop(0.5, 'rgba(255,255,235,1)');
      across.addColorStop(0.7, 'rgba(255,190,90,0.35)');
      across.addColorStop(1, 'rgba(255,170,60,0)');
      g.fillStyle = across;
      g.fillRect(0, 0, w, h);
    }),
  };
  return textures;
}

function additive(map, color = 0xffffff) {
  return new THREE.MeshBasicMaterial({
    map, color, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
}

// ---- muzzle flash ----------------------------------------------------------

let flashGeometry = null;

// A flash at the muzzle (place the group at the muzzle, barrel along -Z):
// a head-on star plus two crossed flame tongues, each shot a little
// different, blooming and fading over FLASH_LIFE. Call userData.fire() on a
// shot and userData.update(dt) every frame; userData.brightness (0..1) can
// drive a light.
export function makeMuzzleFlash() {
  const tex = fxTextures();
  flashGeometry ??= {
    star: new THREE.PlaneGeometry(0.24, 0.24),
    // Long axis along -Z, base at the origin.
    flame: new THREE.PlaneGeometry(0.11, 0.34).translate(0, 0.17, 0).rotateX(-Math.PI / 2),
  };
  const flash = new THREE.Group();
  const star = new THREE.Mesh(flashGeometry.star, additive(tex.star, 0xffe2b0));
  star.position.z = -0.02;
  const flames = [0, Math.PI / 2].map((rz) => {
    const pivot = new THREE.Group();
    pivot.rotation.z = rz;
    pivot.add(new THREE.Mesh(flashGeometry.flame, additive(tex.flame, 0xffd9a0)));
    return pivot;
  });
  flash.add(star, ...flames);
  flash.visible = false;
  for (const o of [star, ...flames.map((p) => p.children[0])]) o.renderOrder = 10;

  let age = FLASH_LIFE;
  let size = 1;
  let length = 1;
  flash.userData = {
    brightness: 0,
    fire() {
      age = 0;
      size = 0.8 + Math.random() * 0.45;
      length = 0.75 + Math.random() * 0.6;
      flash.rotation.z = Math.random() * Math.PI;
    },
    update(dt) {
      age += dt;
      const t = age / FLASH_LIFE;
      flash.visible = t < 1;
      const fade = flash.visible ? (1 - t) ** 1.5 : 0;
      flash.userData.brightness = fade;
      if (!flash.visible) return;
      const bloom = 0.7 + 0.5 * Math.min(1, t * 3);
      star.scale.setScalar(size * bloom);
      for (const pivot of flames) pivot.scale.set(size * bloom, size * bloom, length * bloom);
      star.material.opacity = fade;
      for (const pivot of flames) pivot.children[0].material.opacity = fade;
    },
  };
  return flash;
}

// ---- tracers and impacts ---------------------------------------------------

const _dir = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _side = new THREE.Vector3();
const _p = new THREE.Vector3();

// Bullet tracers: camera-facing glowing ribbons from the muzzle to where the
// shot landed (WebGL lines are always 1 px). The tail runs toward the target
// as the tracer fades, so it reads as a fast bullet. Ends a little wider
// with distance, so far tracers stay visible.
export class Tracers {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
  }

  // from, to: [x,y,z]; hit: whether it hit something (impact spark)
  add(from, to, hit = true) {
    const tex = fxTextures();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), 2));
    geometry.setIndex([0, 2, 1, 2, 3, 1]);
    const mesh = new THREE.Mesh(geometry, additive(tex.beam, 0xffdf9a));
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    this.scene.add(mesh);
    this.items.push({ mesh, a: new THREE.Vector3(...from), b: new THREE.Vector3(...to), age: 0, life: TRACER_LIFE });

    if (hit) {
      const spark = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex.star, color: 0xffd28a, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, rotation: Math.random() * Math.PI,
      }));
      spark.position.set(...to);
      this.scene.add(spark);
      this.items.push({ sprite: spark, age: 0, life: IMPACT_LIFE });
    }
  }

  update(dt, camera) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.age += dt;
      const t = item.age / item.life;
      if (t >= 1) {
        const obj = item.mesh ?? item.sprite;
        this.scene.remove(obj);
        obj.geometry?.dispose();
        obj.material.dispose();
        this.items.splice(i, 1);
        continue;
      }
      if (item.sprite) {
        item.sprite.material.opacity = 1 - t;
        item.sprite.scale.setScalar(0.25 + 0.3 * t);
        continue;
      }
      // Tail chases the head: the visible part shrinks toward the target.
      const start = _p.lerpVectors(item.a, item.b, 0.85 * t * t).clone();
      const pos = item.mesh.geometry.attributes.position;
      _dir.subVectors(item.b, start);
      [start, item.b].forEach((end, k) => {
        _toCam.subVectors(camera.position, end);
        const width = 0.012 + 0.0016 * _toCam.length();
        _side.crossVectors(_dir, _toCam).normalize().multiplyScalar(width);
        pos.setXYZ(k * 2, end.x - _side.x, end.y - _side.y, end.z - _side.z);
        pos.setXYZ(k * 2 + 1, end.x + _side.x, end.y + _side.y, end.z + _side.z);
      });
      pos.needsUpdate = true;
      item.mesh.material.opacity = (1 - t) ** 1.3;
    }
  }

  clear() {
    for (const item of this.items) {
      const obj = item.mesh ?? item.sprite;
      this.scene.remove(obj);
      obj.geometry?.dispose();
      obj.material.dispose();
    }
    this.items = [];
  }
}
