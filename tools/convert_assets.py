"""Convert the FBX source assets in fbx/ into game-ready GLB files.

Run from the project root:
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      --python tools/convert_assets.py

Outputs (build/blender/, then optimised into assets/models/ by
tools/optimize_assets.mjs; run both with `npm run build:assets`):
  characters/<Name>.glb   mesh + skeleton, scaled to game units (no animations)
  anims_male.glb          Mixamo rifle animations retargeted onto the male skeleton
  anims_female.glb        ... and onto the female skeleton
  rifle.glb               static rifle mesh, origin at the trigger, muzzle along -Z

Characters and the rifle have their flat-colour materials baked into vertex
colours with a single shared material, so each draws in one call.

Retargeting: the Mixamo clips were downloaded on Mixamo's own 65-bone rig.
Both rigs share a T-pose rest, so for every mapped bone we copy the bone's
world-space rotation *relative to its rest pose* from the Mixamo rig onto
the character rig, frame by frame, and key the result as local rotations.
"""

import os
import sys

import bpy
from mathutils import Matrix, Vector

ROOT = os.getcwd()
SRC = os.path.join(ROOT, 'fbx')
OUT = os.path.join(ROOT, 'build', 'blender')
CHAR_SCALE = 0.375  # source characters are ~4.8 units tall -> ~1.8 m
RIFLE_LENGTH = 0.9  # metres

# Mixamo animation file -> clip name in the game
CLIPS = {
    'Idle': 'idle',
    'Run Forward': 'run_forward',
    'Run Backward': 'run_backward',
    'Strafe Left': 'strafe_left',
    'Strafe Right': 'strafe_right',
    'Run Firing': 'run_firing',
    'Firing': 'firing',
    'Reload': 'reload',
    'Run Reload': 'run_reload',
    'Jump Up': 'jump_up',
    'Jump Loop': 'jump_loop',
    'Jump Down': 'jump_down',
    'Death': 'death',
}

# character bone <- mixamo bone
BONE_MAP = {
    'Body': 'Hips',
    'Hips': 'Spine',
    'Abdomen': 'Spine1',
    'Torso': 'Spine2',
    'Neck': 'Neck',
    'Head': 'Head',
    'UpperLeg.L': 'LeftUpLeg', 'LowerLeg.L': 'LeftLeg', 'Foot.L': 'LeftFoot',
    'UpperLeg.R': 'RightUpLeg', 'LowerLeg.R': 'RightLeg', 'Foot.R': 'RightFoot',
}
for side, mside in (('L', 'Left'), ('R', 'Right')):
    BONE_MAP.update({
        f'Shoulder.{side}': f'{mside}Shoulder',
        f'UpperArm.{side}': f'{mside}Arm',
        f'LowerArm.{side}': f'{mside}ForeArm',
        f'Palm.{side}': f'{mside}Hand',
        f'Fingers.{side}': f'{mside}HandMiddle1',
        f'Thumb1.{side}': f'{mside}HandThumb1',
        f'Thumb2.{side}': f'{mside}HandThumb2',
    })

# The character rig's feet hang off the root bone (an IK setup), not off the
# shins, so their position has to be driven explicitly.
FEET = {'Foot.L': 'LowerLeg.L', 'Foot.R': 'LowerLeg.R'}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def find(objs, kind):
    return [o for o in objs if o.type == kind]


def world_rot(mat):
    return mat.to_3x3().normalized().to_quaternion()


def make_opaque(objs):
    """The source FBXs store their colours with alpha 0, which the glTF
    exporter turns into fully cut-out materials. Force everything opaque."""
    for o in find(objs, 'MESH'):
        for mat in o.data.materials:
            if not mat:
                continue
            mat.diffuse_color[3] = 1.0
            if mat.node_tree:
                for node in mat.node_tree.nodes:
                    if node.type == 'BSDF_PRINCIPLED':
                        node.inputs['Alpha'].default_value = 1.0


# The gun FBXs carry no material colours (all default grey), so colour them by
# material name. sRGB hex.
NAMED_COLORS = {
    'Black': '1c1c1e', 'Metal': '5a5f66', 'Barrels': '3a3d42', 'DarkMetal': '33363b',
    'DarkWood': '5c3a21', 'LightWood': '8a5a33', 'Wood': '7a4e2c',
    'BulletYellow': 'c9a227', 'BulletOrange': 'c8742a', 'BulletRed': 'a8322a',
}


def srgb_to_linear(hex_color):
    def channel(c):
        c = int(c, 16) / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(channel(hex_color[i:i + 2]) for i in (0, 2, 4)) + (1.0,)


def principled_color(mat):
    if mat.name in NAMED_COLORS:
        return srgb_to_linear(NAMED_COLORS[mat.name])
    if mat.node_tree:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                return tuple(node.inputs['Base Color'].default_value)
    return tuple(mat.diffuse_color)


def bake_material_colors(objs):
    """Replace each mesh's flat-colour materials with per-corner vertex colours
    and one shared material: one draw call per mesh instead of one per colour."""
    shared = bpy.data.materials.new('VertexColor')
    shared.use_nodes = True
    nodes = shared.node_tree.nodes
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    attr = nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    shared.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.7
    bsdf.inputs['Metallic'].default_value = 0.0
    for o in find(objs, 'MESH'):
        me = o.data
        colors = [principled_color(m) if m else (1, 1, 1, 1) for m in me.materials] or [(1, 1, 1, 1)]
        layer = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        for poly in me.polygons:
            c = colors[min(poly.material_index, len(colors) - 1)]
            for li in poly.loop_indices:
                layer.data[li].color = (c[0], c[1], c[2], 1.0)
        me.materials.clear()
        me.materials.append(shared)


def import_character(path):
    """Import a character, drop its own animations, scale it to game units."""
    objs = import_fbx(path)
    make_opaque(objs)
    arm = find(objs, 'ARMATURE')[0]
    for o in objs:
        if o.animation_data:
            o.animation_data_clear()
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    arm.scale = [s * CHAR_SCALE for s in arm.scale]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return arm, objs


def export_glb(path, objs, animations):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_animations=animations,
        export_animation_mode='ACTIONS',
        export_apply=True,
        export_yup=True,
    )
    print(f'wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)')


def bones_parent_first(arm):
    order, queue = [], [b for b in arm.data.bones if b.parent is None]
    while queue:
        b = queue.pop(0)
        order.append(b)
        queue.extend(b.children)
    return order


def retarget(src, dst, clip_name):
    """Bake src's current action onto dst as a new action named clip_name."""
    scene = bpy.context.scene
    src_action = src.animation_data.action
    f0, f1 = (int(round(x)) for x in src_action.frame_range)
    scene.render.fps = 30

    def sbone(name):
        return src.pose.bones.get('mixamorig:' + name)

    src_rest = {n: world_rot(src.matrix_world @ sbone(m).bone.matrix_local) for n, m in BONE_MAP.items()}
    dst_rest = {n: world_rot(dst.matrix_world @ dst.data.bones[n].matrix_local) for n in BONE_MAP}
    hips_rest = src.matrix_world @ sbone('Hips').bone.head_local
    root_scale = dst.data.bones['Body'].head_local.z / hips_rest.z
    dst_inv = dst.matrix_world.inverted()
    # Feet are positioned from their shins, so solve them after everything else.
    order = bones_parent_first(dst)
    def under_foot(b):
        return b.name in FEET or (b.parent is not None and under_foot(b.parent))
    order = [b for b in order if not under_foot(b)] + [b for b in order if under_foot(b)]

    action = bpy.data.actions.new(clip_name)
    action.use_fake_user = True
    dst.animation_data_create()
    dst.animation_data.action = action
    for pb in dst.pose.bones:
        pb.rotation_mode = 'QUATERNION'

    for frame in range(f0, f1 + 1):
        scene.frame_set(frame)
        pose = {}  # armature-space pose matrices of dst, computed parent-first
        for bone in order:
            rest = bone.matrix_local
            inherited = pose[bone.parent.name] @ bone.parent.matrix_local.inverted() @ rest if bone.parent else rest.copy()
            name = bone.name
            if name in BONE_MAP:
                src_now = world_rot(src.matrix_world @ sbone(BONE_MAP[name]).matrix)
                rot = world_rot(dst_inv) @ (src_now @ src_rest[name].inverted() @ dst_rest[name])
                if name == 'Body':
                    hips_now = src.matrix_world @ sbone('Hips').head
                    pos = rest.translation + dst_inv.to_3x3() @ ((hips_now - hips_rest) * root_scale)
                elif name in FEET:
                    shin = FEET[name]
                    pos = pose[shin] @ Vector((0, dst.data.bones[shin].length, 0))
                else:
                    pos = inherited.translation
                pose[name] = Matrix.LocRotScale(pos, rot, None)
            else:
                pose[name] = inherited

            if name in BONE_MAP:
                basis = inherited.inverted() @ pose[name]
                loc, quat, _ = basis.decompose()
                pb = dst.pose.bones[name]
                pb.rotation_quaternion = quat
                pb.keyframe_insert('rotation_quaternion', frame=frame - f0)
                if name == 'Body' or name in FEET:
                    pb.location = loc
                    pb.keyframe_insert('location', frame=frame - f0)

    # Leave the rig in rest pose for the next clip.
    dst.animation_data.action = None
    for pb in dst.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
    return action


def build_characters():
    names = sorted(f[:-4] for f in os.listdir(os.path.join(SRC, 'Character')) if f.endswith('.fbx'))
    for name in names:
        reset()
        _, objs = import_character(os.path.join(SRC, 'Character', name + '.fbx'))
        bake_material_colors(objs)
        export_glb(os.path.join(OUT, 'characters', name + '.glb'), objs, animations=False)
    return names


def build_animations(gender, reference):
    reset()
    dst, objs = import_character(os.path.join(SRC, 'Character', reference))
    actions = []
    for file, clip in CLIPS.items():
        path = os.path.join(SRC, 'Character Animation', file + '.fbx')
        if not os.path.exists(path):
            print(f'skip {file}: not found')
            continue
        src_objs = import_fbx(path)
        src = find(src_objs, 'ARMATURE')[0]
        actions.append(retarget(src, dst, clip))
        for o in src_objs:
            bpy.data.objects.remove(o, do_unlink=True)
        for a in list(bpy.data.actions):
            if a not in actions:
                bpy.data.actions.remove(a)
    # The exporter needs each action reachable from the armature.
    track_owner = dst.animation_data
    for a in actions:
        track = track_owner.nla_tracks.new()
        track.name = a.name
        track.strips.new(a.name, 0, a)
    export_glb(os.path.join(OUT, f'anims_{gender}.glb'), objs, animations=True)


def build_rifle():
    reset()
    objs = import_fbx(os.path.join(SRC, 'Gun', 'Rifle.fbx'))
    arm = find(objs, 'ARMATURE')[0]
    trigger = arm.matrix_world @ arm.data.bones['Trigger'].head_local
    mesh = find(objs, 'MESH')[0]
    # Freeze the skinned mesh in its rest pose and drop the armature.
    bpy.context.view_layer.objects.active = mesh
    for mod in list(mesh.modifiers):
        if mod.type == 'ARMATURE':
            bpy.ops.object.modifier_apply(modifier=mod.name)
    world = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.matrix_world = world
    for o in objs:
        if o is not mesh:
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # Origin at the trigger, scaled to RIFLE_LENGTH. The muzzle points +Y in
    # Blender, which becomes -Z (forward) in the game.
    length = mesh.dimensions.y
    mesh.data.transform(Matrix.Scale(RIFLE_LENGTH / length, 4) @ Matrix.Translation(-trigger))
    bake_material_colors([mesh])
    export_glb(os.path.join(OUT, 'rifle.glb'), [mesh], animations=False)


if __name__ == '__main__':
    names = build_characters()
    build_animations('male', 'Male_Casual.fbx')
    build_animations('female', 'Female_Casual.fbx')
    build_rifle()
    print('characters:', names)
