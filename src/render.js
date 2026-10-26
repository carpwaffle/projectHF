// Everything three.js: the arena, player avatars, the first-person body and
// rifle, and tracers.

import * as THREE from 'three';
import { Character, makeRifle, makeGun, MUZZLE } from './character.js';
import { Tracers } from './effects.js';
import { WEAPONS, PICKUP_SPOTS, PICKUP_RADIUS, HEAL_SPOTS } from './shared.js';

// Where the camera sits relative to the head bone (metres, view-aligned:
// side, up, forward), per holding style, blended when switching. A little
// left of centre so the gun shows lower right instead of covering the
// crosshair; higher for the pistol, which is held up at eye level.
const VIEW_EYE = {
  rifle: [-0.14, -0.04, 0.18],
  pistol: [-0.13, 0.05, 0.12],
};
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
    this.onSound = null; // (name, position | null, intensity, variant) => void, set by main.js
    this.tracers = new Tracers(this.scene);
    this.buildPickupSpots();

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
    avatar.onSound = (sound, intensity, variant) => this.onSound?.(sound, avatar.object.position.toArray(), intensity, variant);
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
    this.view.onSound = (sound, intensity, variant) => this.onSound?.(sound, null, intensity, variant); // our own: not positioned
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

  // state: { pos, yaw, pitch, vel, dead, reloading, weapon, hidden, eye:[x,y,z] (the camera) }
  updateViewmodel(dt, state) {
    const view = this.view;
    if (!view) return;
    view.object.visible = !state.dead && !state.hidden;
    if (state.dead) return;
    view.update(dt, state);
    view.shadow.visible = false;
    view.label.visible = false;
    // Shift the whole body so its eyes (just above and in front of the head
    // bone, turned with the view) sit exactly at the camera.
    view.bones.head.getWorldPosition(_eyePoint);
    const k = view.pistolBlend;
    const [side, up, forward] = VIEW_EYE.rifle.map((r, i) => r + (VIEW_EYE.pistol[i] - r) * k);
    _offset.set(side, up, -forward).applyEuler(_euler.set(state.pitch, state.yaw, 0, 'YXZ'));
    _eyePoint.add(_offset);
    view.object.position.add(_shift.set(...state.eye).sub(_eyePoint));
    view.object.updateMatrixWorld(true);
  }

  // ---- weapon pickups ----------------------------------------------------

  // A thick circle on the floor at each spot (white: weapon, green: heal
  // pack), and a slot above it for what's on offer (spinning and bobbing).
  // Same order as the host's pickups: weapon spots, then heal spots.
  buildPickupSpots() {
    const ring = new THREE.RingGeometry(PICKUP_RADIUS - 0.16, PICKUP_RADIUS, 48).rotateX(-Math.PI / 2);
    const ringMaterial = (color) => new THREE.MeshBasicMaterial({
      color, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const white = ringMaterial(0xffffff);
    const green = ringMaterial(0x3cff6e);
    const spots = [...PICKUP_SPOTS.map((p) => [p, false]), ...HEAL_SPOTS.map((p) => [p, true])];
    this.pickups = spots.map(([[x, y, z], heal], i) => {
      const circle = new THREE.Mesh(ring, heal ? green : white);
      circle.position.set(x, y + 0.02, z);
      this.scene.add(circle);
      const holder = new THREE.Group();
      holder.position.set(x, y + 1.0, z);
      holder.rotation.y = i * 1.3; // (not all in step)
      this.scene.add(holder);
      // Countdown to the next weapon, shown while the spot is empty.
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 64;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const timer = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, toneMapped: false }));
      timer.scale.set(1.0, 0.5, 1);
      timer.position.set(x, y + 1.0, z);
      timer.visible = false;
      this.scene.add(timer);
      return { holder, heal, weapon: -1, gun: null, timer, canvas, texture, readyAt: 0, shown: -1 };
    });
  }

  // A first-aid box: white, a red cross on every side.
  makeHealPack() {
    if (!this.healPackGeometry) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const g = canvas.getContext('2d');
      g.fillStyle = '#f4f4f4';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#e02424';
      g.fillRect(24, 10, 16, 44);
      g.fillRect(10, 24, 44, 16);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      this.healPackGeometry = new THREE.BoxGeometry(0.42, 0.42, 0.42);
      this.healPackMaterial = new THREE.MeshLambertMaterial({ map });
    }
    return new THREE.Mesh(this.healPackGeometry, this.healPackMaterial);
  }

  drawTimer(spot, seconds) {
    if (seconds === spot.shown) return;
    spot.shown = seconds;
    const g = spot.canvas.getContext('2d');
    g.clearRect(0, 0, 128, 64);
    g.font = 'bold 44px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 8;
    g.strokeStyle = 'rgba(0,0,0,0.65)';
    g.strokeText(String(seconds), 64, 34);
    g.fillStyle = '#ffffff';
    g.fillText(String(seconds), 64, 34);
    spot.texture.needsUpdate = true;
  }

  // weapons: per spot, the index into WEAPONS on offer or -1 (empty); null
  // hides them all (not in a game). remaining: per spot, seconds until an
  // empty one gets its next weapon.
  updatePickups(weapons, remaining = []) {
    const now = performance.now() / 1000;
    this.pickups.forEach((spot, i) => {
      const w = weapons ? weapons[i] ?? -1 : -1;
      spot.timer.visible = !!weapons && w < 0;
      if (spot.timer.visible) spot.readyAt = now + (remaining[i] ?? 0);
      if (w === spot.weapon) return;
      spot.weapon = w;
      if (spot.gun) spot.holder.remove(spot.gun);
      spot.gun = null;
      if (w < 0) return;
      if (spot.heal) {
        spot.gun = this.makeHealPack();
        spot.holder.add(spot.gun);
        return;
      }
      const id = WEAPONS[w].id;
      spot.gun = makeGun(id);
      // Parts only shown in the hand during a reload (speedloader, shell).
      const reload = spot.gun.userData.points.reload;
      if (reload?.hideOutside) {
        for (const name of [reload.part, ...(reload.partAlso ?? [])]) spot.gun.userData.bones[name]?.scale.setScalar(1e-4);
      }
      spot.gun.scale.setScalar(id === 'pistol' || id === 'revolver' ? 2.2 : 1.4); // easy to see from afar
      spot.holder.add(spot.gun);
    });
  }

  animatePickups(dt) {
    const t = performance.now() / 1000;
    for (const spot of this.pickups) {
      if (spot.timer.visible) this.drawTimer(spot, Math.max(1, Math.ceil(spot.readyAt - t)));
      if (!spot.gun) continue;
      spot.holder.rotation.y += dt * 1.6;
      spot.gun.position.y = Math.sin(t * 2 + spot.holder.rotation.x) * 0.08;
    }
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

  // Someone else's shot: the tracer(s) start at their gun's muzzle as we
  // draw them (the host's message carries their eye position). ends / hits:
  // one per bullet or pellet.
  remoteShot(id, eye, ends, hits) {
    const avatar = this.avatars.get(id);
    const from = avatar ? avatar.muzzleWorld().toArray() : eye;
    ends.forEach((end, i) => this.addTracer(from, end, hits[i]));
    avatar?.fire();
  }

  setFov(fov) {
    if (Math.abs(this.camera.fov - fov) < 0.01) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
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
    this.animatePickups(dt);
    // Teammates' names stay readable far away (and through walls): they grow
    // with distance beyond 12 m instead of shrinking.
    for (const avatar of this.avatars.values()) {
      const grow = avatar.team === this.localTeam
        ? Math.max(1, avatar.object.position.distanceTo(this.camera.position) / 12) : 1;
      avatar.label.scale.set(3.2 * grow, 0.4 * grow, 1);
    }
    if (this.view) {
      const flash = this.view.gun.userData.flash;
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


