"""Export maps/downtown.blend for the game, with a baked lightmap.

  /Applications/Blender.app/Contents/MacOS/Blender -b maps/downtown.blend \
      --python tools/export_map.py [-- --no-bake]     (or: npm run build:map)

Writes:
  build/blender/map_visual.glb      the visual map: one mesh, UVMap + a
                                    Lightmap UV set (TEXCOORD_1)
  build/blender/lightmap.png        the baked lighting (sRGB-encoded, see LM_MAX)
  build/blender/map_collision.glb   the Collision collection, positions only
  assets/models/map_meta.json       spawn points, play radius, lightmap info
tools/optimize_assets.mjs then turns these into assets/models/map*.

Baking (all in memory; the .blend isn't changed): every Visual object is
copied into world space and joined into one mesh, which gets its own
non-overlapping lightmap UVs (Smart UV Project + pack; the ground outside the
ring gets a tenth of the resolution). Cycles bakes sun + sky, direct and
bounced, without surface colour (the game multiplies the textures by it).
The result is exposure-normalised, lightly blurred (sampling noise), and
stored sRGB-encoded with headroom: stored = lighting / LM_MAX.

--no-bake exports the plain map (dynamic lighting in game) in seconds, for
quick layout iterations.
"""

import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

ROOT = os.getcwd()
OUT = os.path.join(ROOT, 'build', 'blender')
os.makedirs(OUT, exist_ok=True)

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
BAKE = '--no-bake' not in argv

LM_SIZE = 2048  # lightmap resolution (~7-8 texels per metre on this map)
# The map has ~35,000 UV islands (every kit piece splits into several), so
# padding must stay tiny: 1 px around each island (an 8 px gap needs more
# room than the whole texture has). The bake margin fills the gaps and empty
# space so bilinear filtering and mipmaps don't pull in black.
LM_PAD = 1
LM_BAKE_MARGIN = 4
LM_SAMPLES = 256
LM_MAX = 2.5  # stored value 1.0 = this much light (headroom for bright sun)
LM_EXPOSURE = 1.9  # the brightest outdoor surfaces (98th percentile) end up here
LM_AMBIENT = 0.16  # added everywhere, so shade and closed rooms aren't gloomy
OUTER_SCALE = 0.1  # lightmap resolution of the ground outside the ring, relative
OUTER_R = 51.0  # faces on the ground beyond this radius count as "outside"

# Sun direction matches the game's dynamic sun (three.js position 30, 50, 20).
SUN_FROM = Vector((30, -20, 50))  # Blender coordinates
# In Cycles a sky of strength S lights open ground about as much as a sun of
# strength pi * S, so these give sunlit ground ~2.2x the shade.
SUN_STRENGTH = 8.0
SUN_ANGLE = math.radians(1.5)  # angular size: slightly soft shadow edges
SKY_COLOUR = (0.55, 0.72, 1.0)
BOUNCE_ALBEDO = 0.5  # grey of the bake material (how much light bounces into shade)
SKY_STRENGTH = 1.8


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


def select_objects(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def export(path, **opts):
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_yup=True, export_apply=True, export_extras=False, **opts)
    print(f'wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)')


# ---- lightmap bake -------------------------------------------------------------

def merged_visual():
    """World-space copy of every Visual mesh, joined into one object 'Map'
    with a single UV set 'UVMap' (the textures') and no colour attributes."""
    col = bpy.data.collections.new('Baked')
    bpy.context.scene.collection.children.link(col)
    parts = []
    for o in list(bpy.data.collections['Visual'].all_objects):
        if o.type != 'MESH' or not o.data.polygons:
            continue
        me = o.data.copy()
        me.transform(o.matrix_world)
        while len(me.uv_layers) > 1:
            me.uv_layers.remove(me.uv_layers[-1])
        if not me.uv_layers:
            me.uv_layers.new(name='UVMap')
        me.uv_layers[0].name = 'UVMap'
        for attr in list(me.color_attributes):
            me.color_attributes.remove(attr)
        ob = bpy.data.objects.new(o.name, me)
        col.objects.link(ob)
        parts.append(ob)
    # Only the merged copy may show up in the bake.
    for name in ('Visual', 'Collision', 'Buildings', 'Spawns'):
        for o in list(bpy.data.collections[name].all_objects):  # (see select())
            o.hide_render = True
    select_objects(parts)
    bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    merged.name = 'Map'
    return merged


def lightmap_uvs(obj):
    me = obj.data
    lm = me.uv_layers.new(name='Lightmap')
    me.uv_layers.active = lm  # bake target and the UV operators use the active layer
    me.uv_layers['UVMap'].active_render = True  # textures keep using their own UVs
    select_objects([obj])
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    # The ground outside the ring: shrink its islands so it takes little space.
    bm = bmesh.from_edit_mesh(me)
    uv = bm.loops.layers.uv['Lightmap']
    outer = [f for f in bm.faces
             if f.calc_center_median().z < 0.01 and f.calc_center_median().to_2d().length > OUTER_R]
    loops = [l for f in outer for l in f.loops]
    if loops:
        c = sum((l[uv].uv for l in loops), Vector((0, 0))) / len(loops)
        for l in loops:
            l[uv].uv = c + (l[uv].uv - c) * OUTER_SCALE
    bmesh.update_edit_mesh(me)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=LM_PAD / LM_SIZE)
    bpy.ops.object.mode_set(mode='OBJECT')
    print(f'lightmap UVs: {len(me.polygons)} faces ({len(outer)} outside the ring)')


def setup_lighting():
    scene = bpy.context.scene
    world = bpy.data.worlds.new('Sky')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (*SKY_COLOUR, 1)
    bg.inputs['Strength'].default_value = SKY_STRENGTH
    scene.world = world
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = SUN_STRENGTH
    sun.data.angle = SUN_ANGLE
    sun.rotation_euler = SUN_FROM.to_track_quat('Z', 'Y').to_euler()  # light travels along -Z
    scene.collection.objects.link(sun)


def bake(obj):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for device_type in ('METAL', 'OPTIX', 'CUDA', 'HIP'):
        try:
            prefs.compute_device_type = device_type
            break
        except TypeError:
            continue
    prefs.get_devices()
    gpus = [d for d in prefs.devices if d.type != 'CPU']
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = 'GPU' if gpus else 'CPU'
    scene.cycles.samples = LM_SAMPLES
    scene.cycles.use_denoising = False
    scene.render.bake.margin = LM_BAKE_MARGIN
    scene.render.bake.margin_type = 'EXTEND'
    print(f'baking {LM_SIZE}px, {LM_SAMPLES} samples on {scene.cycles.device} ({", ".join(d.name for d in gpus) or "CPU"})')

    img = bpy.data.images.new('LightmapBake', LM_SIZE, LM_SIZE, float_buffer=True)
    # Bake with one plain light-grey diffuse material on every face, not the
    # kit's own: those (packed ORM textures, glass, fake interiors) baked black,
    # and the lightmap should hold lighting only anyway; the game multiplies
    # the real textures by it. The real materials go back afterwards.
    mat = bpy.data.materials.new('LightmapBakeMaterial')
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next(n for n in nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (BOUNCE_ALBEDO, BOUNCE_ALBEDO, BOUNCE_ALBEDO, 1)
    bsdf.inputs['Roughness'].default_value = 1.0
    for n in nodes:
        n.select = False
    node = nodes.new('ShaderNodeTexImage')
    node.image = img
    node.select = True  # the bake target is the active, selected image node
    nodes.active = node
    real = list(obj.data.materials)
    for i in range(len(real)):
        obj.data.materials[i] = mat
    select_objects([obj])
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, use_clear=True, margin=LM_BAKE_MARGIN)
    for i, m in enumerate(real):
        obj.data.materials[i] = m
    return img


def blur(a, radius=1, sigma=0.75):
    """Separable Gaussian blur of an H x W x C array, against sampling noise.
    Radius 1 px: at an island's edge it only reads that island's own margin."""
    k = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    k /= k.sum()
    for axis in (0, 1):
        p = np.pad(a, [(radius, radius) if i == axis else (0, 0) for i in range(a.ndim)], mode='edge')
        a = sum(w * np.take(p, range(i, i + a.shape[axis]), axis=axis) for i, w in enumerate(k))
    return a


def save_lightmap(img, path):
    px = np.empty(LM_SIZE * LM_SIZE * 4, np.float32)
    img.pixels.foreach_get(px)
    rgb = px.reshape(LM_SIZE, LM_SIZE, 4)[..., :3]
    lum = rgb.mean(axis=2)
    lit = lum[lum > 1e-4]
    if lit.size == 0:
        raise RuntimeError('the bake came out black (check the lightmap UVs are inside 0..1)')
    ref = np.percentile(lit, 98)
    rgb = blur(rgb) * (LM_EXPOSURE / ref) + LM_AMBIENT
    v = np.clip(rgb / LM_MAX, 0, 1)
    srgb = np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)
    out = bpy.data.images.new('Lightmap', LM_SIZE, LM_SIZE, alpha=False)
    out.colorspace_settings.name = 'Non-Color'  # we did the sRGB encoding ourselves
    flat = np.concatenate([srgb, np.ones((LM_SIZE, LM_SIZE, 1), np.float32)], axis=2).ravel()
    out.pixels.foreach_set(flat.astype(np.float32))
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    print(f'wrote {os.path.relpath(path, ROOT)} (exposure x{LM_EXPOSURE / ref:.2f})')


# ---- main ----------------------------------------------------------------------

lightmap_meta = None
if BAKE:
    merged = merged_visual()
    lightmap_uvs(merged)
    setup_lighting()
    image = bake(merged)
    save_lightmap(image, os.path.join(OUT, 'lightmap.png'))
    merged.hide_render = False
    select_objects([merged])
    export(os.path.join(OUT, 'map_visual.glb'))
    lightmap_meta = {'file': 'map_lightmap.ktx2', 'intensity': LM_MAX}
else:
    lightmap_png = os.path.join(OUT, 'lightmap.png')
    if os.path.exists(lightmap_png):
        os.remove(lightmap_png)  # stale: the optimiser must not pair it with this map
    select(['Buildings', 'Visual'])
    export(os.path.join(OUT, 'map_visual.glb'))

select(['Buildings', 'Collision'])
export(os.path.join(OUT, 'map_collision.glb'), export_materials='NONE', export_normals=False, export_texcoords=False)

# Spawns, converted to game coordinates (Y up): (x, z, -y, yaw), grouped by
# the empties' "team" property (0 = north base, 1 = south base). A spawn
# faces its local +Y axis (rotate the empty about Z to aim it); in the game
# that is the camera yaw, with yaw 0 looking north.
spawns = []
team_spawns = [[], []]
for obj in sorted(bpy.data.collections['Spawns'].all_objects, key=lambda o: o.name):
    x, y, z = obj.matrix_world.translation
    yaw = obj.matrix_world.to_euler().z
    point = [round(x, 2), round(z, 2), round(-y, 2), round(yaw, 3)]
    spawns.append(point)
    team_spawns[int(obj.get('team', 0))].append(point)
meta = {'spawns': spawns, 'teamSpawns': team_spawns, 'playRadius': 48.5, 'lightmap': lightmap_meta}
with open(os.path.join(ROOT, 'assets', 'models', 'map_meta.json'), 'w') as f:
    json.dump(meta, f, indent=1)
print(f'wrote assets/models/map_meta.json ({len(spawns)} spawns, lightmap: {"yes" if lightmap_meta else "no"})')
