// Gunfire effects: muzzle flash, bullet tracers, impact sparks and hit sparks
// (a burst on a player who's hit); the smoke bomb and its smoke.
//
// All drawn with additive blending and small generated canvas textures, so
// there are no extra assets to load and they stay cheap (no extra lights in
// the world; the baked map isn't lit dynamically anyway).

import * as THREE from 'three';
import { SMOKE, smokeCentre } from './shared.js';

const FLASH_LIFE = 0.06; // seconds a muzzle flash lasts
const TRACER_LIFE = 0.16;
const IMPACT_LIFE = 0.09;
// Hit sparks: a flash, then sparks thrown out (toward the shooter's side),
// falling and fading.
const HIT_FLASH_LIFE = 0.08;
const HIT_SPARKS = [9, 14]; // body, head
const HIT_SPARK_LIFE = [0.16, 0.3]; // seconds (each spark a random life in this range)
const HIT_SPARK_SPEED = [1.5, 4.5]; // m/s
const GRAVITY = 9.8;

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

    if (hit) this.addImpact(to);
  }

  // An impact spark at `at` ([x,y,z] or a Vector3): where a shot hits
  // something (or goes into a wall, with the wallbang hack).
  addImpact(at) {
    const spark = new THREE.Sprite(new THREE.SpriteMaterial({
      map: fxTextures().star, color: 0xffd28a, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, rotation: Math.random() * Math.PI,
    }));
    if (Array.isArray(at)) spark.position.set(...at);
    else spark.position.copy(at);
    this.scene.add(spark);
    this.items.push({ sprite: spark, age: 0, life: IMPACT_LIFE });
  }

  // A burst of sparks on a player who's hit: at `at`, thrown out round
  // `dir` (unit, toward the shooter); more for a headshot.
  addHitSparks(at, dir, head = false) {
    const tex = fxTextures();
    const material = (color, opacity = 1) => new THREE.SpriteMaterial({
      map: tex.star, color, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, rotation: Math.random() * Math.PI, // (depth-tested: not seen through walls)
    });
    const flash = new THREE.Sprite(material(0xfff0c0));
    flash.position.copy(at);
    flash.renderOrder = 11;
    this.scene.add(flash);
    this.items.push({ sprite: flash, hit: true, age: 0, life: HIT_FLASH_LIFE, grow: [head ? 0.35 : 0.25, 0.2] });
    for (let k = 0; k < HIT_SPARKS[head ? 1 : 0]; k++) {
      // Out round dir (a wide cone), a little upward.
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize()
        .addScaledVector(dir, 1.1).normalize();
      v.y += 0.35;
      v.multiplyScalar(HIT_SPARK_SPEED[0] + Math.random() * (HIT_SPARK_SPEED[1] - HIT_SPARK_SPEED[0]));
      const spark = new THREE.Sprite(material(Math.random() < 0.5 ? 0xffe08a : 0xffb347));
      spark.position.copy(at);
      spark.renderOrder = 11;
      this.scene.add(spark);
      this.items.push({
        sprite: spark, hit: true, vel: v, size: 0.07 + Math.random() * 0.05, age: 0,
        life: HIT_SPARK_LIFE[0] + Math.random() * (HIT_SPARK_LIFE[1] - HIT_SPARK_LIFE[0]),
      });
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
      // (Hit sparks and their flash grow with distance, so they still show far off.)
      const far = item.hit ? 1 + 0.06 * item.sprite.position.distanceTo(camera.position) : 1;
      if (item.vel) { // a hit spark: flies, falls, shrinks and fades
        item.vel.y -= GRAVITY * dt;
        item.sprite.position.addScaledVector(item.vel, dt);
        item.sprite.material.opacity = 1 - t * t;
        item.sprite.scale.setScalar(item.size * (1 - 0.6 * t) * far);
        continue;
      }
      if (item.sprite) {
        const [size, growth] = item.grow ?? [0.25, 0.3];
        item.sprite.material.opacity = 1 - t;
        item.sprite.scale.setScalar((size + growth * t) * far);
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

// ---- smoke bomb --------------------------------------------------------------

// The smoke bomb: a grey canister (length along -Z, like the guns), a darker
// cap at the top and a ring.
export function makeSmokeBomb() {
  const group = new THREE.Group();
  group.scale.setScalar(1.25); // (a little big: it reads in the hand)
  const body = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.55, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.5, metalness: 0.5 });
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.11, 16).rotateX(Math.PI / 2), body);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.022, 12).rotateX(Math.PI / 2), dark);
  cap.position.z = -0.064;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.003, 6, 14), dark);
  ring.position.set(0, 0.018, -0.068);
  group.add(can, cap, ring);
  return group;
}

let puffTexture = null;
// A soft, lumpy round puff (white: tinted by the material).
function smokePuffTexture() {
  puffTexture ??= canvasTexture(128, 128, (g, w) => {
    const c = w / 2;
    for (let i = 0; i < 9; i++) { // overlapping blobs: lumpy, not a perfect disc
      const a = (i / 9) * Math.PI * 2;
      const r = i === 0 ? 0 : c * 0.28;
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      const blob = g.createRadialGradient(x, y, 0, x, y, c * (i === 0 ? 0.95 : 0.6));
      blob.addColorStop(0, 'rgba(255,255,255,0.55)');
      blob.addColorStop(0.6, 'rgba(255,255,255,0.22)');
      blob.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = blob;
      g.fillRect(0, 0, w, w);
    }
  });
  return puffTexture;
}

const PUFFS = 48;
// Thrown smoke bombs in flight and the clouds they make. world: for the
// bombs' flight (World.stepGrenade, as the host runs it); onBounce(pos):
// a bounce sound.
// Inside a cloud, the puffs nearest the eye thin out, so players a few
// metres away show (they filled the view, and with the in-smoke tint only
// someone right up close could be seen). Distance to a puff over its size:
// from SMOKE_NEAR[0] (at SMOKE_NEAR_MIN of its opacity) to SMOKE_NEAR[1] (full).
const SMOKE_NEAR = [0.22, 0.8];
const SMOKE_NEAR_MIN = 0.1;
const _puffAt = new THREE.Vector3();

export class Smokes {
  constructor(scene, world, onBounce) {
    this.scene = scene;
    this.world = world;
    this.onBounce = onBounce;
    this.bombs = new Map(); // id -> { mesh, g: { pos, vel, rest }, spin }
    this.clouds = new Map(); // id -> { group, puffs, born (s, performance.now() clock), age, duration }
  }

  // A bomb leaving the hand (the host's message): pos, vel [x,y,z].
  addBomb(id, pos, vel) {
    const mesh = makeSmokeBomb();
    mesh.position.set(...pos);
    this.scene.add(mesh);
    this.bombs.set(id, { mesh, g: { pos: [...pos], vel: [...vel], rest: false }, spin: new THREE.Vector3(Math.random() * 12, Math.random() * 6, Math.random() * 12) });
  }

  // It popped (at the host's position): the cloud, `age` seconds old already.
  addCloud(id, pos, duration, age = 0) {
    this.removeBomb(id);
    if (this.clouds.has(id)) return;
    const group = new THREE.Group();
    group.position.set(...smokeCentre(pos));
    const puffs = [];
    const map = smokePuffTexture();
    for (let i = 0; i < PUFFS; i++) {
      // Spread through the cloud (flatter than round, the bottom on the ground).
      const u = Math.random() * Math.PI * 2;
      const v = Math.acos(Math.random() * 2 - 1);
      const r = Math.cbrt(Math.random()) * SMOKE.radius * 0.72;
      const at = new THREE.Vector3(Math.sin(v) * Math.cos(u) * r, Math.cos(v) * r * 0.55, Math.sin(v) * Math.sin(u) * r);
      at.y = Math.max(at.y, -SMOKE.rise + 0.6);
      const shade = 0.5 + Math.random() * 0.12; // (sRGB: a mid grey)
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map, color: new THREE.Color().setRGB(shade, shade, shade * 1.03, THREE.SRGBColorSpace), transparent: true, depthWrite: false, rotation: Math.random() * Math.PI * 2,
      }));
      sprite.renderOrder = 5;
      group.add(sprite);
      puffs.push({ sprite, at, size: SMOKE.radius * (0.6 + Math.random() * 0.4), drift: (Math.random() - 0.5) * 0.25, spin: (Math.random() - 0.5) * 0.3 });
    }
    this.scene.add(group);
    this.clouds.set(id, { group, puffs, born: performance.now() / 1000 - age, age, duration });
  }

  removeBomb(id) {
    const bomb = this.bombs.get(id);
    if (!bomb) return;
    this.scene.remove(bomb.mesh);
    bomb.mesh.traverse((o) => o.geometry?.dispose());
    this.bombs.delete(id);
  }

  // camera: puffs right around it thin out (from inside, see SMOKE_NEAR).
  update(dt, camera) {
    for (const bomb of this.bombs.values()) {
      if (this.world.stepGrenade(bomb.g, dt)) this.onBounce?.(bomb.g.pos);
      bomb.mesh.position.set(...bomb.g.pos);
      if (!bomb.g.rest) bomb.mesh.rotation.set(bomb.mesh.rotation.x + bomb.spin.x * dt, bomb.mesh.rotation.y + bomb.spin.y * dt, bomb.mesh.rotation.z + bomb.spin.z * dt);
    }
    for (const [id, cloud] of this.clouds) {
      // (By the clock, not frame by frame: frames' dt is capped, so a slow or
      // background tab aged the cloud slower than the clock its blocking
      // goes by, and it stayed in view after it stopped blocking.)
      cloud.age = performance.now() / 1000 - cloud.born;
      if (cloud.age >= cloud.duration) {
        this.scene.remove(cloud.group);
        for (const { sprite } of cloud.puffs) sprite.material.dispose();
        this.clouds.delete(id);
        continue;
      }
      // Bursts out from the bomb (fast, then settling: like a blast), thins away at the end.
      const k = Math.min(1, (cloud.duration - cloud.age) / SMOKE.fadeOut);
      const swell = 1 - (1 - Math.min(1, cloud.age / SMOKE.grow)) ** 3;
      // (Only from inside: outside, by the edge, it doesn't open up.)
      const inside = camera ? THREE.MathUtils.smoothstep(1 - camera.position.distanceTo(cloud.group.position) / SMOKE.radius, 0, 0.2) : 0;
      for (const p of cloud.puffs) {
        p.sprite.position.copy(p.at).multiplyScalar(0.1 + 0.9 * swell);
        p.sprite.position.y += p.drift * cloud.age;
        p.sprite.scale.setScalar(p.size * (0.25 + 0.75 * swell));
        p.sprite.material.rotation += p.spin * dt;
        const near = inside ? cloud.group.localToWorld(_puffAt.copy(p.sprite.position)).distanceTo(camera.position) / p.sprite.scale.x : 1;
        const clear = 1 - inside * (1 - THREE.MathUtils.smoothstep(near, SMOKE_NEAR[0], SMOKE_NEAR[1]));
        p.sprite.material.opacity = 0.95 * Math.min(1, k * 1.4) * (SMOKE_NEAR_MIN + (1 - SMOKE_NEAR_MIN) * clear);
      }
    }
  }

  clear() {
    for (const id of [...this.bombs.keys()]) this.removeBomb(id);
    for (const cloud of this.clouds.values()) {
      this.scene.remove(cloud.group);
      for (const { sprite } of cloud.puffs) sprite.material.dispose();
    }
    this.clouds.clear();
  }
}
