// Standalone page for viewing and tuning the character animations
// (open /preview.html). The character runs "on a treadmill": it stays in
// place while velocity is fed in directly and the floor scrolls underneath.

import * as THREE from 'three';
import { Character } from './character.js';
import { SKINS, loadAssets } from './assets.js';
import { MOVE_SPEED, JUMP_SPEED, GRAVITY, FIRE_COOLDOWN } from './shared.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8de);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(5, 10, 3);
scene.add(sun);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x55606b }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(40, 40, 0x3a424a, 0x3a424a);
grid.position.y = 0.01;
scene.add(grid);

await loadAssets(renderer);
let skin = 0;
let character = null;
function showSkin(index) {
  skin = (index + SKINS.length) % SKINS.length;
  if (character) {
    scene.remove(character.object);
    character.dispose();
  }
  character = new Character(SKINS[skin].replace('_', ' '), skin);
  scene.add(character.object);
  $('skinName').textContent = SKINS[skin].replace('_', ' ');
}
showSkin(0);
// For poking at the character from the browser console.
window.preview = { get character() { return character; }, scene, camera };
$('prevSkin').onclick = () => showSkin(skin - 1);
$('nextSkin').onclick = () => showSkin(skin + 1);

// ---- controls ------------------------------------------------------------------

// Movement in the character's frame: [forward, right].
const MOVES = {
  Idle: [0, 0], Forward: [1, 0], Backpedal: [-1, 0], 'Strafe L': [0, -1], 'Strafe R': [0, 1], Diagonal: [0.707, 0.707],
};
let move = 'Forward';
let autoFire = false;
let dead = false;
let spin = false;
let yaw = 0;
let y = 0;
let vy = 0;

const moveButtons = Object.keys(MOVES).map((name) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => { move = name; refresh(); };
  $('moves').appendChild(b);
  return b;
});
$('jump').onclick = () => { if (y === 0 && !dead) vy = JUMP_SPEED; };
$('fire').onclick = () => { autoFire = !autoFire; refresh(); };
$('die').onclick = () => { dead = !dead; refresh(); };
$('spin').onclick = () => { spin = !spin; refresh(); };

function refresh() {
  moveButtons.forEach((b) => b.classList.toggle('on', b.textContent === move));
  $('fire').classList.toggle('on', autoFire);
  $('die').textContent = dead ? 'Respawn' : 'Die';
  $('die').classList.toggle('on', dead);
  $('spin').classList.toggle('on', spin);
}
refresh();

// Orbit camera
let orbitYaw = Math.PI - 0.7; // front three-quarter view (character faces -Z)
let orbitPitch = 0.25;
let distance = 4.2;
let dragging = false;
canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
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

  // Body-frame movement → world velocity.
  const [f, r] = dead ? [0, 0] : MOVES[move];
  const speed = MOVE_SPEED * Number($('speed').value);
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
  if (autoFire && !dead && fireTimer <= 0) {
    character.fire();
    fireTimer = FIRE_COOLDOWN;
  }

  const pitch = Number($('pitch').value);
  character.update(dt, { pos: [0, y, 0], yaw, pitch, dead, vel: [vx, vy, vz] });

  camera.position.set(
    Math.sin(orbitYaw) * Math.cos(orbitPitch) * distance,
    1.1 + Math.sin(orbitPitch) * distance,
    Math.cos(orbitYaw) * Math.cos(orbitPitch) * distance,
  );
  camera.lookAt(0, 1.0, 0);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
