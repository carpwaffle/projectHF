// Everything three.js: the arena, player avatars, the first-person body and
// rifle, and tracers.

import * as THREE from 'three';
import { Character, makeRifle, MUZZLE } from './character.js';
import { Tracers } from './effects.js';

// Where the camera sits relative to the head bone (metres, view-aligned).
// A little left of centre and high, so the rifle (held in the middle of the
// chest) shows lower right instead of covering the crosshair.
const VIEW_EYE_SIDE = -0.14;
const VIEW_EYE_UP = -0.04;
const VIEW_EYE_FORWARD = 0.18;
const _eyePoint = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _shift = new THREE.Vector3();
const _euler = new THREE.Euler();

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Tone mapping lets bright light stay bright without washing out colour.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xb7d6f2);
    this.scene.fog = new THREE.Fog(0xb7d6f2, 80, 190);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    // Dynamic lights: they light the characters and the first-person rifle,
    // and the map too when it has no baked lightmap. The baked map is drawn
    // unlit (see setMap); the sun here points the same way as the baked sun
    // (tools/export_map.py).
    const addLights = (scene) => {
      scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x8a7a66, 2.0));
      const sun = new THREE.DirectionalLight(0xffe6c4, 2.6);
      sun.position.set(30, 50, 20);
      scene.add(sun);
    };
    addLights(this.scene);

    // First-person body (see setViewmodel): drawn in a second pass on top of
    // the world, so the rifle and arms never poke through walls.
    this.viewScene = new THREE.Scene();
    addLights(this.viewScene);
    // Warm flash of light on your own arms and rifle when you fire.
    this.muzzleLight = new THREE.PointLight(0xffb060, 0, 3, 2);
    this.viewScene.add(this.muzzleLight);
    this.view = null; // Character
    this.viewSkin = -1;


    this.avatars = new Map(); // id -> Character
    this.onSound = null; // (name, position | null, intensity) => void, set by main.js
    this.tracers = new Tracers(this.scene);

    const resize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();
  }

  // lightmap: the baked lighting (or null); intensity: its LM_MAX scale.
  setMap(visual, lightmap = null, intensity = 1) {
    if (lightmap) {
      // Baked lighting replaces dynamic lighting on the map: unlit materials
      // (cheaper than lit ones) showing texture x lightmap. MeshBasicMaterial
      // divides the lightmap by pi, hence the factor.
      visual.traverse((o) => {
        if (!o.isMesh) return;
        const old = o.material;
        o.material = new THREE.MeshBasicMaterial({
          name: old.name,
          map: old.map,
          color: old.color,
          lightMap: lightmap,
          lightMapIntensity: intensity * Math.PI,
          transparent: old.transparent,
          opacity: old.opacity,
          alphaTest: old.alphaTest,
          side: old.side,
        });
        old.dispose();
      });
    }
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
    this.reload = -1; // reload progress 0..1, or -1 when not reloading
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.camera.add(this.gun);
  }

  // ---- avatars -----------------------------------------------------------

  ensureAvatar(id, name, skin, team) {
    let avatar = this.avatars.get(id);
    if (avatar) return avatar;
    avatar = new Character(name, skin, team);
    this.applyLabelRule(avatar);
    avatar.onSound = (sound, intensity) => this.onSound?.(sound, avatar.object.position.toArray(), intensity);
    this.scene.add(avatar.object);
    this.avatars.set(id, avatar);
    return avatar;
  }

  // Teammates' names show through walls; enemies' only when in view.
  setLocalTeam(team) {
    this.localTeam = team;
    for (const avatar of this.avatars.values()) this.applyLabelRule(avatar);
  }

  applyLabelRule(avatar) {
    const teammate = avatar.team === this.localTeam;
    avatar.label.material.depthTest = !teammate;
    avatar.label.material.needsUpdate = true;
    // Draw teammates' labels last: other see-through things (e.g. the map's
    // window glass, sorted as one object at the map centre) would cover them.
    avatar.label.renderOrder = teammate ? 999 : 0;
  }

  // state: { pos, yaw, pitch, dead }
  updateAvatar(id, name, skin, team, state, dt) {
    this.ensureAvatar(id, name, skin, team).update(dt, state);
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

  // ---- first-person body -------------------------------------------------

  // The local player's own character, seen from its eyes: the same model and
  // animations other players see (arms holding the rifle, reloads, running,
  // legs when looking down), with the head collapsed so it can't block the view.
  setViewmodel(skin) {
    if (this.view && this.viewSkin === skin) return;
    this.clearViewmodel();
    this.view = new Character('', skin);
    this.view.onSound = (sound, intensity) => this.onSound?.(sound, null, intensity); // our own: not positioned
    this.viewSkin = skin;
    this.view.bones.head.scale.setScalar(0.001);
    this.view.label.visible = false;
    this.viewScene.add(this.view.object);
  }

  clearViewmodel() {
    if (!this.view) return;
    this.viewScene.remove(this.view.object);
    this.view.dispose();
    this.view = null;
    this.viewSkin = -1;
  }

  // state: { pos, yaw, pitch, vel, dead, reloading, eye:[x,y,z] (the camera) }
  updateViewmodel(dt, state) {
    const view = this.view;
    if (!view) return;
    view.object.visible = !state.dead;
    if (state.dead) return;
    view.update(dt, state);
    view.shadow.visible = false;
    view.label.visible = false;
    // Shift the whole body so its eyes (just above and in front of the head
    // bone, turned with the view) sit exactly at the camera.
    view.bones.head.getWorldPosition(_eyePoint);
    _offset.set(VIEW_EYE_SIDE, VIEW_EYE_UP, -VIEW_EYE_FORWARD).applyEuler(_euler.set(state.pitch, state.yaw, 0, 'YXZ'));
    _eyePoint.add(_offset);
    view.object.position.add(_shift.set(...state.eye).sub(_eyePoint));
    view.object.updateMatrixWorld(true);
  }

  // ---- effects -----------------------------------------------------------

  // from, to: [x,y,z]; hit: the shot hit something (impact spark)
  addTracer(from, to, hit = true) {
    this.tracers.add(from, to, hit);
  }

  // Our own rifle's muzzle, as drawn this frame (call after updateViewmodel).
  localMuzzle() {
    if (this.view?.object.visible) return this.view.muzzleWorld().toArray();
    this.gun.updateWorldMatrix(true, false);
    return this.gun.localToWorld(MUZZLE.clone()).toArray();
  }

  // Someone else's shot: the tracer starts at their rifle's muzzle as we
  // draw them (the host's message carries their eye position).
  remoteShot(id, eye, end, hit) {
    const avatar = this.avatars.get(id);
    this.addTracer(avatar ? avatar.muzzleWorld().toArray() : eye, end, hit);
    avatar?.fire();
  }

  kickGun() {
    this.view?.fire();
    this.gunKick = 1;
    this.gun.userData.flash.userData.fire();
  }

  // ---- frame -------------------------------------------------------------

  // First-person weapon bob (figure-eight while running), idle sway and recoil.
  animateGun(dt, move) {
    this.bobAmount = THREE.MathUtils.damp(this.bobAmount, move, 8, dt);
    this.bobPhase += dt * (2 + 9 * this.bobAmount);
    this.gunKick = THREE.MathUtils.damp(this.gunKick, 0, 18, dt);

    const b = this.bobAmount;
    const idle = 1 - b;
    this.gun.position.set(
      this.gunRest.x + Math.sin(this.bobPhase) * 0.018 * b + Math.sin(this.bobPhase * 0.5) * 0.003 * idle,
      this.gunRest.y - Math.abs(Math.cos(this.bobPhase)) * 0.016 * b + Math.sin(this.bobPhase) * 0.003 * idle - 0.012 * b,
      this.gunRest.z + this.gunKick * 0.06,
    );
    this.gun.rotation.x = this.gunKick * 0.06;
    this.gun.rotation.z = Math.sin(this.bobPhase) * 0.025 * b;

    // Reload: the rifle drops a little, tilts up and rolls towards the
    // camera (magazine side in view), then comes back.
    if (this.reload >= 0) {
      const dip = Math.sin(Math.PI * Math.min(1, this.reload)) ** 0.7;
      this.gun.position.y -= 0.05 * dip;
      this.gun.position.x -= 0.03 * dip;
      this.gun.rotation.x += 0.25 * dip;
      this.gun.rotation.z += 0.65 * dip;
    }
    this.gun.userData.flash.userData.update(dt);
  }

  // move: 0 standing … 1 running at full speed (0 while airborne)
  render(dt, eye, yaw, pitch, move = 0) {
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.rotation.set(pitch, yaw, 0);
    this.animateGun(dt, move);

    this.camera.updateMatrixWorld();
    this.tracers.update(dt, this.camera);
    // Teammates' names stay readable far away (and through walls): they grow
    // with distance beyond 12 m instead of shrinking.
    for (const avatar of this.avatars.values()) {
      const grow = avatar.team === this.localTeam
        ? Math.max(1, avatar.object.position.distanceTo(this.camera.position) / 12) : 1;
      avatar.label.scale.set(3.2 * grow, 0.4 * grow, 1);
    }
    if (this.view) {
      const flash = this.view.rifle.userData.flash;
      flash.getWorldPosition(this.muzzleLight.position);
      this.muzzleLight.intensity = 6 * flash.userData.brightness;
    }

    const firstPerson = this.view?.object.visible;
    if (firstPerson) this.gun.visible = false;
    this.renderer.render(this.scene, this.camera);
    if (firstPerson) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.viewScene, this.camera);
      this.renderer.autoClear = true;
    }
  }
}


