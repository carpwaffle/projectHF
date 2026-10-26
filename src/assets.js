// Loads the optimised GLB models produced by `npm run build:assets`
// (meshopt-compressed geometry/animation, KTX2 textures).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const BASIS_TRANSCODER = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/';

// Index = the "skin" number the host assigns to each player.
export const SKINS = [
  'Male_Casual', 'Male_LongSleeve', 'Male_Shirt', 'Male_Suit',
  'Female_Alternative', 'Female_Casual', 'Female_Dress', 'Female_TankTop',
];

export const assets = {
  characters: {}, // skin name -> gltf scene
  clips: {}, // 'male' | 'female' -> { clipName: AnimationClip }
  rifle: null, // gltf scene
  guns: {}, // weapon id -> gltf scene (all but the rifle are skinned: Magazine, Handle, Slide, Drum, Reload... bones)
};

let loader = null;
let ktx2Loader = null;
let loading = null;

// The KTX2 transcoder picks a GPU texture format the device supports, so it
// needs the WebGLRenderer.
function getLoader(webglRenderer) {
  if (!loader) {
    ktx2Loader = new KTX2Loader().setTranscoderPath(BASIS_TRANSCODER).detectSupport(webglRenderer);
    loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2Loader);
  }
  return loader;
}

const modelUrl = (path) => new URL(`../assets/models/${path}`, import.meta.url).href;

function load(webglRenderer, path) {
  return getLoader(webglRenderer).loadAsync(modelUrl(path));
}

// Characters, animations and the rifle.
export function loadAssets(webglRenderer) {
  loading ??= (async () => {
    const gunIds = ['rifle', 'sniper', 'pistol', 'revolver', 'p90', 'shotgun'];
    const [characters, male, female, guns] = await Promise.all([
      Promise.all(SKINS.map((name) => load(webglRenderer, `characters/${name}.glb`))),
      load(webglRenderer, 'anims_male.glb'),
      load(webglRenderer, 'anims_female.glb'),
      Promise.all(gunIds.map((id) => load(webglRenderer, `${id}.glb`))),
    ]);
    SKINS.forEach((name, i) => { assets.characters[name] = characters[i].scene; });
    for (const [gender, gltf] of [['male', male], ['female', female]]) {
      assets.clips[gender] = Object.fromEntries(gltf.animations.map((clip) => [clip.name, clip]));
    }
    assets.guns = Object.fromEntries(gunIds.map((id, i) => [id, guns[i].scene]));
    assets.rifle = assets.guns.rifle;
    return assets;
  })();
  return loading;
}

// The map: visual scene, collision scene, metadata (spawns, play radius,
// lightmap info) and the baked lightmap texture (null if the map wasn't baked).
export async function loadMap(webglRenderer) {
  const meta = await fetch(modelUrl('map_meta.json')).then((r) => r.json());
  const [visual, collision, lightmap] = await Promise.all([
    load(webglRenderer, 'map.glb'),
    load(webglRenderer, 'map_collision.glb'),
    meta.lightmap ? loadLightmap(webglRenderer, meta.lightmap.file) : null,
  ]);
  return { visual: visual.scene, collision: collision.scene, meta, lightmap };
}

async function loadLightmap(webglRenderer, file) {
  getLoader(webglRenderer);
  const texture = await ktx2Loader.loadAsync(modelUrl(file));
  texture.colorSpace = THREE.SRGBColorSpace; // stored sRGB-encoded (see tools/export_map.py)
  texture.channel = 1; // the map's second UV set (TEXCOORD_1)
  texture.anisotropy = 4;
  return texture;
}

// The Downtown City kit: one root object per piece, keyed by piece name.
export async function loadCityKit(webglRenderer) {
  const gltf = await load(webglRenderer, 'city_kit.glb');
  return Object.fromEntries(gltf.scene.children.map((piece) => [piece.name, piece]));
}
