// Optimises the game's models for size and runtime performance.
//
//   node tools/optimize_assets.mjs        (or: npm run build:assets)
//
// Inputs:  build/blender/  (from tools/convert_assets.py)
//          fbx/Map/DowntownCity/*.gltf  (Quaternius Downtown City kit, glTF export)
// Outputs: assets/models/
//
// Characters, rifle: quantized + meshopt-compressed geometry.
// Animations: meshes dropped, channels that never leave the rest pose
//   removed, rotations stored as 16-bit, meshopt-compressed.
// Map (from tools/export_map.py): visual geometry flattened and joined by
//   material (a few draw calls for the whole map), same texture treatment as
//   the kit; collision reduced to positions only. With a baked lightmap: the
//   lightmap UVs (TEXCOORD_1) are kept, normal/ORM textures dropped (the game
//   draws the lightmapped map unlit), and lightmap.png becomes
//   map_lightmap.ktx2 (UASTC + Zstandard: smooth gradients band in ETC1S).
// City kit: every piece merged into one library file (city_kit.glb) so
//   shared textures and materials exist once; textures downsized and
//   GPU-compressed to KTX2 (Basis Universal), which stays compressed in
//   video memory; geometry quantized + meshopt-compressed. COLOR_0 and
//   TEXCOORD_1/2 are removed: they're masks and data for Quaternius's custom
//   engine shaders (wear, fake interiors) and render as a red tint otherwise.
//   They are NOT lightmap UVs (they overlap); lightmap UVs get generated for
//   the assembled map at bake time.

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join, mergeDocuments, meshopt, prune, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { ktx2 } from 'ktx2-encoder/gltf-transform';
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';

const ROOT = process.cwd();
const BLENDER_OUT = path.join(ROOT, 'build', 'blender');
const KIT_SRC = path.join(ROOT, 'fbx', 'Map', 'DowntownCity');
const OUT = path.join(ROOT, 'assets', 'models');

// Texture budget for the city kit (pixels per side).
const TEXTURE_SIZE = {
  baseColor: 1024, // colour detail is what the eye notices most
  normal: 512,
  orm: 512, // occlusion / roughness / metallic
};

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const report = [];

async function write(doc, outPath, sourceBytes) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await io.write(outPath, doc);
  const size = fs.statSync(outPath).size;
  report.push([path.relative(ROOT, outPath), sourceBytes, size]);
}

// ---- characters & rifle --------------------------------------------------------

async function optimizeMesh(file) {
  const src = path.join(BLENDER_OUT, file);
  const doc = await io.read(src);
  await doc.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await write(doc, path.join(OUT, file), fs.statSync(src).size);
}

// ---- animations ----------------------------------------------------------------

// Remove channels whose every keyframe equals the bone's rest value. The
// mixer falls back to the rest pose for unanimated bones, so they're redundant.
function stripStaticChannels(doc) {
  let removed = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    for (const channel of anim.listChannels()) {
      const node = channel.getTargetNode();
      const prop = channel.getTargetPath();
      const rest = { translation: node.getTranslation(), rotation: node.getRotation(), scale: node.getScale() }[prop];
      const values = channel.getSampler().getOutput().getArray();
      const eps = prop === 'rotation' ? 1e-4 : 1e-4;
      let isStatic = !!rest;
      for (let i = 0; isStatic && i < values.length; i++) {
        let d = values[i] - rest[i % rest.length];
        // q and -q are the same rotation
        if (prop === 'rotation' && Math.abs(d) > eps) d = values[i] + rest[i % rest.length];
        if (Math.abs(d) > eps) isStatic = false;
      }
      if (isStatic) {
        const sampler = channel.getSampler();
        channel.dispose();
        sampler.dispose(); // otherwise its keyframe accessors linger
        removed++;
      }
    }
  }
  return removed;
}

// Store rotation keyframes as normalized int16 instead of float32 (allowed by
// the glTF spec for rotations; three.js decodes them).
function quantizeRotations(doc) {
  const done = new Set();
  for (const anim of doc.getRoot().listAnimations()) {
    for (const channel of anim.listChannels()) {
      if (channel.getTargetPath() !== 'rotation') continue;
      const out = channel.getSampler().getOutput();
      if (done.has(out)) continue;
      done.add(out);
      const src = out.getArray();
      const q = new Int16Array(src.length);
      for (let i = 0; i < src.length; i++) q[i] = Math.round(Math.max(-1, Math.min(1, src[i])) * 32767);
      out.setArray(q).setNormalized(true);
    }
  }
}

async function optimizeAnimations(file) {
  const src = path.join(BLENDER_OUT, file);
  const doc = await io.read(src);
  // Only the animation data is needed; the clips bind to bones by name.
  for (const node of doc.getRoot().listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
  }
  const removed = stripStaticChannels(doc);
  // No keyframe resampling: it would give every channel its own timeline,
  // and the per-accessor JSON then outweighs the keyframe data. Keeping every
  // frame lets all channels of a clip share one input accessor, and the
  // regular data compresses well with meshopt.
  quantizeRotations(doc);
  await doc.transform(prune({ keepLeaves: true }), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await write(doc, path.join(OUT, file), fs.statSync(src).size);
  const channels = doc.getRoot().listAnimations().reduce((n, a) => n + a.listChannels().length, 0);
  console.log(`${file}: removed ${removed} static channels, ${channels} remain`);
}

// ---- city kit ------------------------------------------------------------------

const imageDecoder = async (buffer) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

// Resize + KTX2-compress textures by slot (see TEXTURE_SIZE).
function textureTransforms() {
  return [
    textureCompress({ encoder: sharp, targetFormat: 'png', resize: [TEXTURE_SIZE.baseColor, TEXTURE_SIZE.baseColor], slots: /^(baseColorTexture|emissiveTexture)$/ }),
    textureCompress({ encoder: sharp, targetFormat: 'png', resize: [TEXTURE_SIZE.normal, TEXTURE_SIZE.normal], slots: /^normalTexture$/ }),
    textureCompress({ encoder: sharp, targetFormat: 'png', resize: [TEXTURE_SIZE.orm, TEXTURE_SIZE.orm], slots: /^(metallicRoughnessTexture|occlusionTexture)$/ }),
    // Colour: ETC1S (smallest; fine for albedo). Normal/ORM: UASTC (higher
    // quality, needed for data textures), with Zstandard supercompression.
    ktx2({ isUASTC: false, isPerceptual: true, qualityLevel: 160, generateMipmap: true, slots: /^(baseColorTexture|emissiveTexture)$/, imageDecoder }),
    ktx2({ isUASTC: true, isNormalMap: true, isPerceptual: false, needSupercompression: true, generateMipmap: true, slots: /^normalTexture$/, imageDecoder }),
    ktx2({ isUASTC: true, isPerceptual: false, needSupercompression: true, generateMipmap: true, slots: /^(metallicRoughnessTexture|occlusionTexture)$/, imageDecoder }),
  ];
}

// The kit's COLOR_0 / TEXCOORD_1/2 are data for Quaternius's engine shaders.
// keep: semantics to leave alone (the baked map's TEXCOORD_1 is our lightmap UV).
function stripEngineAttributes(doc, keep = []) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of ['COLOR_0', 'TEXCOORD_1', 'TEXCOORD_2']) {
        if (!keep.includes(semantic)) prim.setAttribute(semantic, null);
      }
    }
  }
}

// The lightmapped map is drawn unlit, so lighting-only textures are dead weight.
function dropLightingTextures(doc) {
  for (const material of doc.getRoot().listMaterials()) {
    material.setNormalTexture(null).setMetallicRoughnessTexture(null).setOcclusionTexture(null);
  }
}

async function encodeLightmap(baked, lightmapSrc) {
  const lightmapOut = path.join(OUT, 'map_lightmap.ktx2');
  if (baked) {
    const ktx = await encodeToKTX2(new Uint8Array(fs.readFileSync(lightmapSrc)), {
      isUASTC: true, needSupercompression: true, isPerceptual: true, generateMipmap: true, imageDecoder,
    });
    fs.writeFileSync(lightmapOut, ktx);
    report.push([path.relative(ROOT, lightmapOut), fs.statSync(lightmapSrc).size, ktx.length]);
  } else if (fs.existsSync(lightmapOut)) {
    fs.rmSync(lightmapOut);
  }
}

async function buildMap() {
  const visualSrc = path.join(BLENDER_OUT, 'map_visual.glb');
  const collisionSrc = path.join(BLENDER_OUT, 'map_collision.glb');
  if (!fs.existsSync(visualSrc)) return;

  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'map_meta.json'), 'utf8'));
  const lightmapSrc = path.join(BLENDER_OUT, 'lightmap.png');
  const baked = !!meta.lightmap && fs.existsSync(lightmapSrc);
  if (LIGHTMAP_ONLY) return encodeLightmap(baked, lightmapSrc);

  const visual = await io.read(visualSrc);
  stripEngineAttributes(visual, baked ? ['TEXCOORD_1'] : []);
  if (baked) dropLightingTextures(visual);
  await visual.transform(
    dedup(),
    flatten(), // bake the building hierarchy into world space...
    join({ keepNamed: false }), // ...so everything sharing a material merges into one draw call
    // keepAttributes: no material references the lightmap UVs (the game adds
    // the lightmap), and prune would drop them as unused.
    prune({ keepAttributes: baked }),
    ...textureTransforms(),
    // The map spans ~260 m: 16-bit positions keep ~4 mm precision (14-bit would crack seams).
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeTexcoord: 14 }),
  );
  await write(visual, path.join(OUT, 'map.glb'), fs.statSync(visualSrc).size);

  await encodeLightmap(baked, lightmapSrc);

  const collision = await io.read(collisionSrc);
  // Player-only collision (COLP_* objects: window blockers that bullets pass
  // through) is tagged with a "PlayerOnly" material, so join() keeps it apart
  // and world.js can tell it from the rest.
  const playerOnly = collision.createMaterial('PlayerOnly');
  for (const node of collision.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of prim.listSemantics()) if (semantic !== 'POSITION') prim.setAttribute(semantic, null);
      prim.setMaterial(node.getName().startsWith('COLP_') ? playerOnly : null);
    }
  }
  await collision.transform(flatten(), join({ keepNamed: false }), weld(), prune(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16 }));
  await write(collision, path.join(OUT, 'map_collision.glb'), fs.statSync(collisionSrc).size);

  const root = visual.getRoot();
  const prims = root.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
  let tris = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
  console.log(`map.glb: ${prims} draw calls, ${(tris / 1000).toFixed(0)}k triangles, ${root.listTextures().length} textures`);
}

async function buildCityKit() {
  const files = fs.readdirSync(KIT_SRC).filter((f) => f.endsWith('.gltf')).sort();
  let sourceBytes = 0;
  for (const f of fs.readdirSync(KIT_SRC)) sourceBytes += fs.statSync(path.join(KIT_SRC, f)).size;

  // Merge every piece into one document: one scene, one root node per piece
  // (named after the file), so pieces can be cloned by name at runtime.
  const kit = await io.read(path.join(KIT_SRC, files[0]));
  const scene = kit.getRoot().getDefaultScene() ?? kit.getRoot().listScenes()[0];
  const wrap = (name, children) => {
    const piece = kit.createNode(name);
    for (const child of children) piece.addChild(child);
    scene.addChild(piece);
  };
  wrap(files[0].replace('.gltf', ''), scene.listChildren());
  for (const f of files.slice(1)) {
    const doc = await io.read(path.join(KIT_SRC, f));
    const map = mergeDocuments(kit, doc);
    for (const srcScene of doc.getRoot().listScenes()) {
      const merged = map.get(srcScene);
      wrap(f.replace('.gltf', ''), merged.listChildren());
      merged.dispose();
    }
  }
  stripEngineAttributes(kit);

  // All pieces' buffers into one.
  const buffer = kit.getRoot().listBuffers()[0];
  for (const accessor of kit.getRoot().listAccessors()) accessor.setBuffer(buffer);
  for (const b of kit.getRoot().listBuffers()) if (b !== buffer) b.dispose();

  await kit.transform(
    dedup(), // identical textures/materials/meshes from different files become one
    prune(),
    ...textureTransforms(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizeTexcoord: 14 }),
  );
  await write(kit, path.join(OUT, 'city_kit.glb'), sourceBytes);

  const root = kit.getRoot();
  console.log(`city_kit.glb: ${root.listScenes()[0].listChildren().length} pieces, ${root.listMaterials().length} materials, ${root.listTextures().length} textures`);
}

// ---- run -----------------------------------------------------------------------

// --map-only: just the map (used by `npm run build:map` after editing the .blend).
// --lightmap-only: just re-encode the lightmap (`npm run build:lightmap`).
const LIGHTMAP_ONLY = process.argv.includes('--lightmap-only');
if (!process.argv.includes('--map-only') && !LIGHTMAP_ONLY) {
  for (const f of fs.readdirSync(path.join(BLENDER_OUT, 'characters'))) {
    if (f.endsWith('.glb')) await optimizeMesh(path.join('characters', f));
  }
  await optimizeMesh('rifle.glb');
  await optimizeAnimations('anims_male.glb');
  await optimizeAnimations('anims_female.glb');
  await buildCityKit();
}
await buildMap();

let before = 0;
let after = 0;
console.log('\nfile'.padEnd(46), 'source'.padStart(10), 'optimised'.padStart(10));
for (const [file, src, out] of report) {
  before += src;
  after += out;
  console.log(file.padEnd(45), kb(src).padStart(10), kb(out).padStart(10), `${(100 * out / src).toFixed(0)}%`.padStart(6));
}
console.log('total'.padEnd(45), kb(before).padStart(10), kb(after).padStart(10));
