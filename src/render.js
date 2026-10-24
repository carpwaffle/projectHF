// Everything three.js: the arena, player avatars, the view-model gun and tracers.

import * as THREE from 'three';
import { Character, makeRifle } from './character.js';

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xa9c9e8);
    this.scene.fog = new THREE.Fog(0xa9c9e8, 70, 180);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    // Simple dynamic lighting until the map gets baked lightmaps.
    this.scene.add(new THREE.HemisphereLight(0xdfeeff, 0x5a5048, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
    sun.position.set(30, 50, 20);
    this.scene.add(sun);


    this.avatars = new Map(); // id -> Character
    this.tracers = [];

    const resize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();
  }

  setMap(visual) {
    this.scene.add(visual);
  }

  buildGun() {
    // First-person rifle (origin at the trigger), below and right of the camera.
    // Call once loadAssets() has finished.
    this.gun = makeRifle();
    this.gunRest = new THREE.Vector3(0.17, -0.19, -0.36);
    this.gun.position.copy(this.gunRest);
    this.gun.rotation.y = 0.03;
    this.gunKick = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.camera.add(this.gun);
  }

  // ---- avatars -----------------------------------------------------------

  ensureAvatar(id, name, skin) {
    let avatar = this.avatars.get(id);
    if (avatar) return avatar;
    avatar = new Character(name, skin);
    this.scene.add(avatar.object);
    this.avatars.set(id, avatar);
    return avatar;
  }

  // state: { pos, yaw, pitch, dead }
  updateAvatar(id, name, skin, state, dt) {
    this.ensureAvatar(id, name, skin).update(dt, state);
  }

  avatarFired(id) {
    this.avatars.get(id)?.fire();
  }

  removeAvatar(id) {
    const avatar = this.avatars.get(id);
    if (!avatar) return;
    this.scene.remove(avatar.object);
    avatar.dispose();
    this.avatars.delete(id);
  }

  clearAvatars() {
    for (const id of [...this.avatars.keys()]) this.removeAvatar(id);
  }

  // ---- effects -----------------------------------------------------------

  addTracer(from, to) {
    const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true, opacity: 1 });
    const line = new THREE.Line(geom, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.12 });
  }

  kickGun() {
    this.gunKick = 1;
    this.gunFlash = 0.05;
    this.gun.userData.flash.rotation.z = Math.random() * Math.PI;
  }

  // ---- frame -------------------------------------------------------------

  // First-person weapon bob (figure-eight while running), idle sway and recoil.
  animateGun(dt, move) {
    this.bobAmount = THREE.MathUtils.damp(this.bobAmount, move, 8, dt);
    this.bobPhase += dt * (2 + 9 * this.bobAmount);
    this.gunKick = THREE.MathUtils.damp(this.gunKick, 0, 18, dt);
    this.gunFlash = (this.gunFlash ?? 0) - dt;

    const b = this.bobAmount;
    const idle = 1 - b;
    this.gun.position.set(
      this.gunRest.x + Math.sin(this.bobPhase) * 0.018 * b + Math.sin(this.bobPhase * 0.5) * 0.003 * idle,
      this.gunRest.y - Math.abs(Math.cos(this.bobPhase)) * 0.016 * b + Math.sin(this.bobPhase) * 0.003 * idle - 0.012 * b,
      this.gunRest.z + this.gunKick * 0.06,
    );
    this.gun.rotation.x = this.gunKick * 0.06;
    this.gun.rotation.z = Math.sin(this.bobPhase) * 0.025 * b;
    this.gun.userData.flash.visible = this.gunFlash > 0;
  }

  // move: 0 standing … 1 running at full speed (0 while airborne)
  render(dt, eye, yaw, pitch, move = 0) {
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.rotation.set(pitch, yaw, 0);
    this.animateGun(dt, move);

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.12);
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}

