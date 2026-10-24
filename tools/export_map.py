"""Export maps/downtown.blend for the game.

  /Applications/Blender.app/Contents/MacOS/Blender -b maps/downtown.blend \
      --python tools/export_map.py        (or: npm run build:map)

Writes:
  build/blender/map_visual.glb      the Visual collection (+ building Empties)
  build/blender/map_collision.glb   the Collision collection, positions only
  assets/models/map_meta.json       spawn points and the play radius
tools/optimize_assets.mjs then turns the GLBs into assets/models/map*.glb.
"""

import json
import math
import os

import bpy

ROOT = os.getcwd()
OUT = os.path.join(ROOT, 'build', 'blender')
os.makedirs(OUT, exist_ok=True)


def select(collections):
    bpy.ops.object.select_all(action='DESELECT')
    # Snapshot the lists first: changing visibility while iterating
    # all_objects cuts the iteration short.
    objs = [o for name in collections for o in list(bpy.data.collections[name].all_objects)]
    for obj in objs:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.hide_render = False  # the exporter skips render-hidden objects (collision is)
        obj.select_set(True)


def export(path, collections, **opts):
    select(collections)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_yup=True, export_apply=True, export_extras=False, **opts)
    print(f'wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)')


export(os.path.join(OUT, 'map_visual.glb'), ['Buildings', 'Visual'])
export(os.path.join(OUT, 'map_collision.glb'), ['Buildings', 'Collision'],
       export_materials='NONE', export_normals=False, export_texcoords=False)

# Spawns, converted to game coordinates (Y up): (x, z, -y), facing the centre.
spawns = []
for obj in sorted(bpy.data.collections['Spawns'].all_objects, key=lambda o: o.name):
    x, y, z = obj.matrix_world.translation
    spawns.append([round(x, 2), round(z, 2), round(-y, 2)])
meta = {'spawns': spawns, 'playRadius': 48.5}
with open(os.path.join(ROOT, 'assets', 'models', 'map_meta.json'), 'w') as f:
    json.dump(meta, f, indent=1)
print(f'wrote assets/models/map_meta.json ({len(spawns)} spawns)')
