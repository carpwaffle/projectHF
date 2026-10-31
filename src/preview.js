// Standalone page for viewing and tuning the character animations
// (open /preview.html). The character runs "on a treadmill": it stays in
// place while velocity is fed in directly and the floor scrolls underneath.
// Third person (orbit camera) or first person (the game's own view: the same
// body, head collapsed, eyes at the camera), with every gun.

import * as THREE from 'three';
import { Character } from './character.js';
import { SKINS, loadAssets } from './assets.js';
import { MOVE_SPEED, JUMP_SPEED, GRAVITY, CROUCH_SPEED, eyeHeight, WEAPONS, headAABB, bodyAABBs } from './shared.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Tone mapping and lights as in the game (render.js), so the characters
// look the same here.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.15;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8de);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
camera.rotation.order = 'YXZ';

scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x9a8a76, 2.5));
const sun = new THREE.DirectionalLight(0xffe6c4, 2.6);
sun.position.set(30, 50, 20);
scene.add(sun);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshLambertMaterial({ color: 0x55606b }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(40, 40, 0x3a424a, 0x3a424a);
grid.position.y = 0.01;
scene.add(grid);

await loadAssets(renderer);
let skin = 0;
let character = null;
let headScale = 1;
function showSkin(index) {
  skin = (index + SKINS.length) % SKINS.length;
  if (character) {
    scene.remove(character.object);
    character.dispose();
  }
  character = new Character(SKINS[skin].replace('_', ' '), skin);
  headScale = character.bones.head.scale.x;
  scene.add(character.object);
  $('skinName').textContent = SKINS[skin].replace('_', ' ');
}
showSkin(0);
// For poking at the character from the browser console.
window.preview = {
  get character() { return character; }, scene, camera,
  orbit(yawAngle, pitchAngle, dist = distance) { orbitYaw = yawAngle; orbitPitch = pitchAngle; distance = dist; },
};
$('prevSkin').onclick = () => showSkin(skin - 1);
$('nextSkin').onclick = () => showSkin(skin + 1);

// ---- controls ------------------------------------------------------------------

// Movement in the character's frame: [forward, right].
const MOVES = {
  Idle: [0, 0], Forward: [1, 0], Backpedal: [-1, 0], 'Strafe L': [0, -1], 'Strafe R': [0, 1], Diagonal: [0.707, 0.707],
};
let move = 'Forward';
let weapon = WEAPONS.findIndex((w) => w.id === 'rifle');
let firstPerson = false;
let autoFire = false;
let reloadEnd = 0; // performance.now() when the current reload ends (0: not reloading)
let dead = false;
let crouch = false;
let spin = false;
let showBoxes = false;
let yaw = 0;
let y = 0;
let vy = 0;

function buttons(parent, labels, onClick) {
  return labels.map((label, i) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { onClick(i, label); refresh(); };
    $(parent).appendChild(b);
    return b;
  });
}
const viewButtons = buttons('views', ['Third person', 'First person'], (i) => { firstPerson = i === 1; });
const weaponButtons = buttons('weapons', WEAPONS.map((w) => w.name), (i) => { weapon = i; reloadEnd = 0; });
const moveButtons = buttons('moves', Object.keys(MOVES), (i, name) => { move = name; });
$('jump').onclick = () => { if (y === 0 && !dead) vy = JUMP_SPEED; };
$('fire').onclick = () => { autoFire = !autoFire; refresh(); };
$('crouch').onclick = () => { crouch = !crouch; refresh(); };
$('reload').onclick = () => { if (!dead) reloadEnd = performance.now() + WEAPONS[weapon].reloadTime * 1000; };
$('die').onclick = () => { dead = !dead; reloadEnd = 0; refresh(); };
$('spin').onclick = () => { spin = !spin; refresh(); };
$('boxes').onclick = () => { showBoxes = !showBoxes; refresh(); };

// The head and body hitboxes, exactly as the host tests shots (shared.js).
const hitboxes = [0xffd23f, 0xff5a4c, 0xff5a4c].map((color) => {
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color, depthTest: false }));
  box.renderOrder = 10;
  scene.add(box);
  return box;
});

function refresh() {
  viewButtons.forEach((b, i) => b.classList.toggle('on', (i === 1) === firstPerson));
  weaponButtons.forEach((b, i) => b.classList.toggle('on', i === weapon));
  moveButtons.forEach((b) => b.classList.toggle('on', b.textContent === move));
  $('fire').classList.toggle('on', autoFire);
  $('crouch').classList.toggle('on', crouch);
  $('die').textContent = dead ? 'Respawn' : 'Die';
  $('die').classList.toggle('on', dead);
  $('spin').classList.toggle('on', spin);
  $('boxes').classList.toggle('on', showBoxes);
  $('crosshair').hidden = !firstPerson;
  $('hint').textContent = firstPerson ? 'Drag to look around' : 'Drag to orbit · scroll to zoom';
  camera.fov = firstPerson ? 75 : 45; // (the game's field of view)
  camera.updateProjectionMatrix();
}
refresh();

// Dragging: orbits the camera (third person) or looks around (first person).
let orbitYaw = Math.PI - 0.7; // front three-quarter view (character faces -Z)
let orbitPitch = 0.25;
let distance = 4.2;
let dragging = false;
canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  if (firstPerson) {
    yaw -= e.movementX * 0.004;
    const pitch = $('pitch');
    pitch.value = Math.max(Number(pitch.min), Math.min(Number(pitch.max), Number(pitch.value) - e.movementY * 0.004));
    return;
  }
  orbitYaw -= e.movementX * 0.008;
  orbitPitch = Math.max(-0.2, Math.min(1.3, orbitPitch + e.movementY * 0.008));
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  distance = Math.max(1.5, Math.min(12, distance * (1 + e.deltaY * 0.001)));
}, { passive: false });

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---- loop ----------------------------------------------------------------------

let last = performance.now();
let fireTimer = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (spin) yaw += dt * 0.6;
  if (reloadEnd && now >= reloadEnd) reloadEnd = 0;

  // Body-frame movement → world velocity.
  const [f, r] = dead ? [0, 0] : MOVES[move];
  const speed = MOVE_SPEED * Number($('speed').value) * (crouch ? CROUCH_SPEED : 1);
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const vx = (-sin * f + cos * r) * speed;
  const vz = (-cos * f - sin * r) * speed;

  vy -= GRAVITY * dt;
  y = Math.max(0, y + vy * dt);
  if (y === 0) vy = 0;

  // Treadmill: scroll the grid instead of moving the character.
  grid.position.x = (((grid.position.x - vx * dt) % 1) + 1) % 1;
  grid.position.z = (((grid.position.z - vz * dt) % 1) + 1) % 1;

  fireTimer -= dt;
  if (autoFire && !dead && !reloadEnd && fireTimer <= 0) {
    character.fire();
    fireTimer = WEAPONS[weapon].cooldown;
  }

  const pitch = Number($('pitch').value);
  character.update(dt, { pos: [0, y, 0], yaw, pitch, dead, crouch, vel: [vx, vy, vz], weapon, reloading: !!reloadEnd, ground: 0 });
  const pose = { yaw, pitch, weapon, vel: [vx, vy, vz], skin, crouch };
  [headAABB([0, y, 0], pose), ...bodyAABBs([0, y, 0], pose)].forEach((b, i) => {
    hitboxes[i].visible = showBoxes && !dead;
    hitboxes[i].position.set(...b.min.map((v, k) => (v + b.max[k]) / 2));
    hitboxes[i].scale.set(...b.max.map((v, k) => v - b.min[k]));
  });

  // First person as in the game (render.js updateViewmodel): head collapsed
  // so it can't block the view, no label or blob shadow, eyes at the camera.
  character.bones.head.scale.setScalar(firstPerson ? 0.001 : headScale);
  if (firstPerson) {
    character.label.visible = false;
    character.shadow.visible = false;
    camera.position.set(0, y + eyeHeight(crouch ? 1 : 0), 0);
    camera.rotation.set(pitch, yaw, 0);
    if (!dead) character.placeEyes(camera.position.toArray(), yaw, pitch);
  } else {
    camera.position.set(
      Math.sin(orbitYaw) * Math.cos(orbitPitch) * distance,
      1.1 + Math.sin(orbitPitch) * distance,
      Math.cos(orbitYaw) * Math.cos(orbitPitch) * distance,
    );
    camera.lookAt(0, 1.0, 0);
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
