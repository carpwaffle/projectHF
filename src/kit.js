// Catalogue of the city kit pieces (open /kit.html): every piece laid out on a
// grid with its name, plus render stats. Also a check that the compressed
// assets (meshopt geometry, KTX2 textures) decode and render correctly.

import * as THREE from 'three';
import { loadCityKit } from './assets.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8de);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(30, 60, 20);
scene.add(sun);

const loadStart = performance.now();
const pieces = await loadCityKit(renderer);
const loadMs = performance.now() - loadStart;

// Grid layout: small pieces in rows, sorted by size; big buildings at the back.
const GAP = 1.5;
const entries = Object.entries(pieces).map(([name, piece]) => {
  const box = new THREE.Box3().setFromObject(piece);
  return { name, piece, box, size: box.getSize(new THREE.Vector3()) };
}).sort((a, b) => a.size.x * a.size.z - b.size.x * b.size.z);

const layout = [];
let x = 0;
let z = 0;
let rowDepth = 0;
const ROW_WIDTH = 60;
for (const e of entries) {
  if (x + e.size.x > ROW_WIDTH) {
    x = 0;
    z += rowDepth + GAP + 1;
    rowDepth = 0;
  }
  // Put the piece's bounding box min corner at (x, z).
  e.piece.position.set(x - e.box.min.x, -Math.min(0, e.box.min.y), z - e.box.min.z);
  scene.add(e.piece);
  const label = makeLabel(e.name);
  label.position.set(x + e.size.x / 2, e.size.y + Math.max(0, -e.box.min.y) + 0.5, z + e.size.z / 2);
  scene.add(label);
  layout.push({ ...e, label });
  x += e.size.x + GAP;
  rowDepth = Math.max(rowDepth, e.size.z);
}
const extent = new THREE.Box3().setFromObject(scene);
const target = extent.getCenter(new THREE.Vector3());
target.y = 0;

// Filter
$('filter').addEventListener('input', () => {
  const q = $('filter').value.trim().toLowerCase();
  for (const e of layout) {
    const show = !q || e.name.toLowerCase().includes(q);
    e.piece.visible = show;
    e.label.visible = show;
  }
});

// Orbit / pan / zoom
let orbitYaw = 0.6;
let orbitPitch = 0.7;
let distance = 70;
let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { drag = e.button; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointermove', (e) => {
  if (drag === 0) {
    orbitYaw -= e.movementX * 0.006;
    orbitPitch = Math.max(0.05, Math.min(1.5, orbitPitch + e.movementY * 0.006));
  } else if (drag === 2) {
    const right = new THREE.Vector3(Math.cos(orbitYaw), 0, -Math.sin(orbitYaw));
    const fwd = new THREE.Vector3(-Math.sin(orbitYaw), 0, -Math.cos(orbitYaw));
    const k = distance * 0.0015;
    target.addScaledVector(right, -e.movementX * k).addScaledVector(fwd, e.movementY * k);
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  distance = Math.max(3, Math.min(400, distance * (1 + e.deltaY * 0.001)));
}, { passive: false });

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Texture memory estimate from the GPU formats actually used. Several
// Texture objects can share one image, so count each image once.
function textureStats() {
  const images = new Set();
  let bytes = 0;
  let compressed = false;
  scene.traverse((o) => {
    if (o.isSprite) return; // labels
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const t of Object.values(m)) {
        if (!t?.isTexture) continue;
        const key = t.isCompressedTexture ? t.mipmaps[0].data.buffer : t.source;
        if (images.has(key)) continue;
        images.add(key);
        if (t.isCompressedTexture) {
          compressed = true;
          for (const mip of t.mipmaps) bytes += mip.data.byteLength;
        } else if (t.image?.width) {
          bytes += t.image.width * t.image.height * 4 * 1.33;
        }
      }
    }
  });
  return { count: images.size, mb: bytes / 1048576, compressed };
}

let frames = 0;
let fpsTime = performance.now();
let fps = 0;
function frame(now) {
  requestAnimationFrame(frame);
  camera.position.set(
    target.x + Math.sin(orbitYaw) * Math.cos(orbitPitch) * distance,
    target.y + Math.sin(orbitPitch) * distance,
    target.z + Math.cos(orbitYaw) * Math.cos(orbitPitch) * distance,
  );
  camera.lookAt(target);
  renderer.render(scene, camera);

  frames++;
  if (now - fpsTime > 500) {
    fps = (frames * 1000) / (now - fpsTime);
    frames = 0;
    fpsTime = now;
    const tex = textureStats();
    const { calls, triangles } = renderer.info.render;
    $('stats').textContent = `${layout.length} pieces · loaded in ${(loadMs / 1000).toFixed(1)} s
${calls} draw calls · ${(triangles / 1000).toFixed(0)}k triangles
${tex.count} textures · ~${tex.mb.toFixed(1)} MB GPU${tex.compressed ? ' (GPU-compressed)' : ''}
${fps.toFixed(0)} fps`;
  }
}
requestAnimationFrame(frame);

// For poking at the kit from the browser console.
window.kit = { pieces, scene, renderer };

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(text, 256, 32);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 256, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  sprite.scale.set(4, 0.5, 1);
  return sprite;
}
