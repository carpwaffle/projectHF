// Loads the optimised GLB models produced by `npm run build:assets`
// (meshopt-compressed geometry/animation, KTX2 textures).

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
};

let loader = null;
let loading = null;

// The KTX2 transcoder picks a GPU texture format the device supports, so it
// needs the WebGLRenderer.
function getLoader(webglRenderer) {
  if (!loader) {
    const ktx2 = new KTX2Loader().setTranscoderPath(BASIS_TRANSCODER).detectSupport(webglRenderer);
    loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
  }
  return loader;
}

function load(webglRenderer, path) {
  return getLoader(webglRenderer).loadAsync(new URL(`../assets/models/${path}`, import.meta.url).href);
}

// Characters, animations and the rifle.
export function loadAssets(webglRenderer) {
  loading ??= (async () => {
    const [characters, male, female, rifle] = await Promise.all([
      Promise.all(SKINS.map((name) => load(webglRenderer, `characters/${name}.glb`))),
      load(webglRenderer, 'anims_male.glb'),
      load(webglRenderer, 'anims_female.glb'),
      load(webglRenderer, 'rifle.glb'),
    ]);
    SKINS.forEach((name, i) => { assets.characters[name] = characters[i].scene; });
    for (const [gender, gltf] of [['male', male], ['female', female]]) {
      assets.clips[gender] = Object.fromEntries(gltf.animations.map((clip) => [clip.name, clip]));
    }
    assets.rifle = rifle.scene;
    return assets;
  })();
  return loading;
}

// The map: visual scene, collision scene and metadata (spawns, play radius).
export async function loadMap(webglRenderer) {
  const [visual, collision, meta] = await Promise.all([
    load(webglRenderer, 'map.glb'),
    load(webglRenderer, 'map_collision.glb'),
    fetch(new URL('../assets/models/map_meta.json', import.meta.url)).then((r) => r.json()),
  ]);
  return { visual: visual.scene, collision: collision.scene, meta };
}

// The Downtown City kit: one root object per piece, keyed by piece name.
export async function loadCityKit(webglRenderer) {
  const gltf = await load(webglRenderer, 'city_kit.glb');
  return Object.fromEntries(gltf.scene.children.map((piece) => [piece.name, piece]));
}
