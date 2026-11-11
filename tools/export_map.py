"""Export maps/district.blend for the game, with a baked lightmap.

  /Applications/Blender.app/Contents/MacOS/Blender -b maps/district.blend \
      --python tools/export_map.py [-- --no-bake]     (or: npm run build:map)

The scene property "map_meta" (JSON, written by tools/district_generator.py)
is merged into the meta file (play bounds, pickups, ladders, zones).

Writes:
  build/blender/district_visual.glb     the visual map: one mesh, UVMap + a
                                        Lightmap UV set (TEXCOORD_1)
  build/blender/district_lightmap.png   the baked lighting (sRGB-encoded, see LM_MAX)
  build/blender/district_props.glb      the Props collection (not lightmapped)
  build/blender/district_collision.glb  the Collision collection, positions only
  assets/models/district_meta.json      spawns, play bounds, pickups, ladders,
                                        zones, lightmap info
tools/optimize_assets.mjs then turns these into assets/models/district*.

Baking (all in memory; the .blend isn't changed): every Visual object is
copied into world space and joined into one mesh, which gets its own
non-overlapping lightmap UVs (Smart UV Project + pack). Cycles bakes sun + sky, direct and
bounced, without surface colour (the game multiplies the textures by it).
The result is exposure-normalised, lightly blurred (sampling noise), and
stored sRGB-encoded with headroom: stored = lighting / LM_MAX.

--no-bake exports the plain map (dynamic lighting in game) in seconds, for
quick layout iterations.

--retone only redoes the post-processing (exposure, dark lift, ambient) from
the raw bake saved by the last full bake (build/blender/district_lightmap_raw.npy),
in seconds: `npm run build:lightmap` after changing the LM_* numbers below.
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
RETONE = '--retone' in argv
NAME = 'district'  # output file names: build/blender/district_*, assets/models/district_*
RAW = os.path.join(OUT, NAME + '_lightmap_raw.npy')
LIGHTMAP_PNG = os.path.join(OUT, NAME + '_lightmap.png')

LM_SIZE = 2048  # lightmap resolution (~7-8 texels per metre on this map)
# The map has ~35,000 UV islands (every kit piece splits into several), so
# padding must stay tiny: 1 px around each island (an 8 px gap needs more
# room than the whole texture has). The bake margin fills the gaps and empty
# space so bilinear filtering and mipmaps don't pull in black.
LM_PAD = 1
LM_BAKE_MARGIN = 4
LM_SAMPLES = 1024  # (flat-coloured surfaces show sampling noise that textures used to hide)
LM_MAX = 2.5  # stored value 1.0 = this much light (headroom for bright sun)
LM_EXPOSURE = 1.9  # the brightest outdoor surfaces (98th percentile) end up here
LM_AMBIENT = 0.08  # added everywhere
# Dark lift: adds DARK_LIFT * DARK_KNEE / (light + DARK_KNEE), so the darkest
# spots (closed rooms) gain DARK_LIFT, outdoor shade (~0.8) about a quarter
# of that, and sunlit surfaces almost nothing. Brightens rooms without
# flattening the outdoors.
DARK_LIFT = 0.42
DARK_KNEE = 0.3
# Ambient occlusion: a second bake, multiplied in, darkens corners, the
# joins of floors and walls and the edges of steps (indoors, where there's
# little direct light, they'd look flat). 1 - AO_STRENGTH = fully occluded.
AO_DISTANCE = 1.0  # (m) how far occluders count
AO_STRENGTH = 0.85
AO_CURVE = 0.5  # < 1: partly occluded spots (near corners, under steps' edges) darken more
AO_RAW = os.path.join(OUT, NAME + '_ao_raw.npy')

# Sun direction matches the game's dynamic sun (three.js position 30, 50, 20).
SUN_FROM = Vector((30, -20, 50))  # Blender coordinates
# In Cycles a sky of strength S lights open ground about as much as a sun of
# strength pi * S, so these give sunlit ground ~2.2x the shade.
SUN_STRENGTH = 12.0
SUN_ANGLE = math.radians(5)  # angular size: soft shadow edges
SUN_COLOUR = (1.0, 0.93, 0.82)  # warm afternoon sun
SKY_COLOUR = (0.55, 0.72, 1.0)
BOUNCE_ALBEDO = 0.7  # grey of the bake material: lighter carries window light deeper into rooms
DIFFUSE_BOUNCES = 6  # (Cycles default 4) more bounces also reach further indoors
SKY_STRENGTH = 1.5


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
                              export_yup=True, export_apply=True, export_extras=False,
                              **opts)
    print(f'wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)')


# ---- lightmap bake -------------------------------------------------------------

def merged_visual(lightmap=False):
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
        # Faces with no area (some models have them; decimated ones more)
        # get no lightmap area either, which throws the packing's scale.
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.dissolve_degenerate(bm, dist=1e-4, edges=bm.edges)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-6], context='FACES')
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(o.name, me)
        col.objects.link(ob)
        parts.append(ob)
        if lightmap:
            project_lightmap(ob)
    # Only the merged copy may show up in the bake.
    # (Props stay: they cast shadows into the bake. See export_props.)
    for name in ('Visual', 'Collision', 'Buildings', 'Spawns'):
        for o in list(bpy.data.collections[name].all_objects):  # (see select())
            o.hide_render = True
    select_objects(parts)
    bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    merged.name = 'Map'
    # (No welding: the generator already joined each material's boxes, and
    # cut them into pieces for the lightmap's islands, see LIGHTMAP_PIECE in
    # tools/district_generator.py; welding would join those again.)
    # Faces pressed against another one back to back (a wall against the
    # boundary blocks) can't be seen; they also threw the lightmap UVs off
    # (projected edge-on, they set the packing's scale): removed.
    bm = bmesh.new()
    bm.from_mesh(merged.data)
    seen = {}
    for f in bm.faces:
        key = tuple(sorted((round(v.co.x, 3), round(v.co.y, 3), round(v.co.z, 3)) for v in f.verts))
        seen.setdefault(key, []).append(f)
    hidden = [f for group in seen.values() if len(group) > 1 for f in group]
    bmesh.ops.delete(bm, geom=hidden, context='FACES')
    bm.to_mesh(merged.data)
    bm.free()
    print(f'{len(hidden)} hidden faces removed')
    return merged


def project_lightmap(obj):
    """A 'Lightmap' UV set for one object (before joining): each face
    projected along its main axis, in metres (a box projection). Faces turned
    the same way that share an edge form one island; the packing then spaces
    and scales them all alike. (Blender's smart projection, tried first,
    turned some walls and furniture edge-on, with almost no UV area, and the
    packing then used ~1-4% of the lightmap.)"""
    me = obj.data
    lm = me.uv_layers.new(name='Lightmap')
    co = np.zeros(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    uv = np.zeros((len(me.loops), 2), np.float32)
    for p in me.polygons:
        axis = int(np.argmax(np.abs(p.normal)))
        keep = [k for k in range(3) if k != axis]
        sign = 1 if p.normal[axis] >= 0 else -1  # (mirrored for the faces turned away, not overlapping)
        for li, vi in zip(p.loop_indices, p.vertices):
            uv[li] = (co[vi][keep[0]] * sign, co[vi][keep[1]])
    lm.data.foreach_set('uv', uv.ravel())


def lightmap_uvs(obj):
    """Pack the joined map's lightmap islands, sized by their area."""
    me = obj.data
    me.uv_layers.active = me.uv_layers['Lightmap']  # bake target and the UV operators use the active layer
    me.uv_layers['UVMap'].active_render = True  # textures keep using their own UVs
    select_objects([obj])
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=LM_PAD / LM_SIZE)
    bpy.ops.object.mode_set(mode='OBJECT')
    print(f'lightmap UVs: {len(me.polygons)} faces')


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
    sun.data.color = SUN_COLOUR
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
    scene.cycles.diffuse_bounces = DIFFUSE_BOUNCES
    scene.cycles.max_bounces = max(scene.cycles.max_bounces, DIFFUSE_BOUNCES)
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
    # Ambient occlusion, into a second image.
    ao = bpy.data.images.new('AOBake', LM_SIZE, LM_SIZE, float_buffer=True)
    node.select = False
    ao_node = nodes.new('ShaderNodeTexImage')
    ao_node.image = ao
    ao_node.select = True
    nodes.active = ao_node
    bpy.context.scene.world.light_settings.distance = AO_DISTANCE
    print(f'baking ambient occlusion ({AO_DISTANCE} m)')
    bpy.ops.object.bake(type='AO', use_clear=True, margin=LM_BAKE_MARGIN)
    for i, m in enumerate(real):
        obj.data.materials[i] = m
    return img, ao


def blur(a, radius=1, sigma=0.75):
    """Separable Gaussian blur of an H x W x C array, against sampling noise.
    Radius 1 px: at an island's edge it only reads that island's own margin."""
    k = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    k /= k.sum()
    for axis in (0, 1):
        p = np.pad(a, [(radius, radius) if i == axis else (0, 0) for i in range(a.ndim)], mode='edge')
        a = sum(w * np.take(p, range(i, i + a.shape[axis]), axis=axis) for i, w in enumerate(k))
    return a


def raw_pixels(img, path):
    """A baked image as an H x W x 3 float array, also cached for --retone."""
    px = np.empty(LM_SIZE * LM_SIZE * 4, np.float32)
    img.pixels.foreach_get(px)
    rgb = px.reshape(LM_SIZE, LM_SIZE, 4)[..., :3].copy()
    np.save(path, rgb)
    return rgb


def save_lightmap(rgb, ao, path):
    size = rgb.shape[0]
    lum = rgb.mean(axis=2)
    lit = lum[lum > 1e-4]
    if lit.size == 0:
        raise RuntimeError('the bake came out black (check the lightmap UVs are inside 0..1)')
    ref = np.percentile(lit, 98)
    rgb = blur(rgb) * (LM_EXPOSURE / ref)
    light = rgb.mean(axis=2, keepdims=True)
    rgb = rgb + DARK_LIFT * DARK_KNEE / (light + DARK_KNEE) + LM_AMBIENT
    if ao is not None:
        occlusion = 1 - np.clip(blur(ao).mean(axis=2, keepdims=True), 0, 1)
        rgb = rgb * (1 - AO_STRENGTH * occlusion ** AO_CURVE)
    v = np.clip(rgb / LM_MAX, 0, 1)
    srgb = np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)
    out = bpy.data.images.new('Lightmap', size, size, alpha=False)
    out.colorspace_settings.name = 'Non-Color'  # we did the sRGB encoding ourselves
    flat = np.concatenate([srgb, np.ones((size, size, 1), np.float32)], axis=2).ravel()
    out.pixels.foreach_set(flat.astype(np.float32))
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    print(f'wrote {os.path.relpath(path, ROOT)} (exposure x{LM_EXPOSURE / ref:.2f})')


# ---- main ----------------------------------------------------------------------

if RETONE:
    if not os.path.exists(RAW):
        sys.exit('no raw bake yet: run a full `npm run build:map` first')
    save_lightmap(np.load(RAW), np.load(AO_RAW) if os.path.exists(AO_RAW) else None, LIGHTMAP_PNG)
    sys.exit(0)

lightmap_meta = None
if BAKE:
    merged = merged_visual(lightmap=True)
    lightmap_uvs(merged)
    setup_lighting()
    image, ao_image = bake(merged)
    save_lightmap(raw_pixels(image, RAW), raw_pixels(ao_image, AO_RAW), LIGHTMAP_PNG)
    merged.hide_render = False
    select_objects([merged])
    export(os.path.join(OUT, f'{NAME}_visual.glb'))
    lightmap_meta = {'file': f'{NAME}_lightmap.ktx2', 'intensity': LM_MAX}
else:
    for stale in (LIGHTMAP_PNG, RAW, AO_RAW):  # the optimiser / --retone must not pair them with this map
        if os.path.exists(stale):
            os.remove(stale)
    merged = merged_visual()
    merged.hide_render = False
    select_objects([merged])
    export(os.path.join(OUT, f'{NAME}_visual.glb'))

# Props (cars, trees, furniture, food): their own file, lit in real time in
# the game like the characters. Lightmapping them too (tens of thousands of
# small curved faces) left the packing unable to fit the lightmap.
select(['Props'])
export(os.path.join(OUT, f'{NAME}_props.glb'))

select(['Buildings', 'Collision'])
export(os.path.join(OUT, f'{NAME}_collision.glb'), export_materials='NONE', export_normals=False, export_texcoords=False)

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
meta = {'spawns': spawns, 'teamSpawns': team_spawns, 'lightmap': lightmap_meta}
extra = bpy.context.scene.get('map_meta')
meta.update(json.loads(extra))
with open(os.path.join(ROOT, 'assets', 'models', f'{NAME}_meta.json'), 'w') as f:
    json.dump(meta, f, indent=1)
print(f'wrote assets/models/{NAME}_meta.json ({len(spawns)} spawns, lightmap: {"yes" if lightmap_meta else "no"})')
