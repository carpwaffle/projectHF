"""Render a top-down base image of the map for drawing a blueprint on.

  npm run blueprint      (Blender stage: this script; then tools/make_blueprint.mjs)

Renders maps/downtown.blend from directly above (orthographic, 20 px per
metre) and writes an SVG overlay: a 2 m grid (one wall piece), labelled
every 10 m, building names with storey counts, spawn points, and the play
boundary. tools/make_blueprint.mjs composites them into maps/blueprint_base.png.
"""

import json
import math
import os

import bpy

ROOT = os.getcwd()
OUT = os.path.join(ROOT, 'build', 'blueprint')
os.makedirs(OUT, exist_ok=True)

HALF = 54  # metres shown either side of the centre
PX_PER_M = 20
SIZE = HALF * 2 * PX_PER_M  # 2160 px
MARGIN = 110  # room for the title and coordinate labels
PLOT_H = 0.15
FLOOR_H = 3.0
PLAY_R = 48.5

scene = bpy.context.scene

# ---- render ----------------------------------------------------------------------

for obj in bpy.data.collections['Collision'].all_objects:
    obj.hide_render = True
# Hide the ground and sidewalk slabs: buildings read best on white.
for obj in bpy.data.collections['Visual'].objects:
    if obj.name == 'Ground' or obj.name.startswith('Plot_'):
        obj.hide_render = True

cam_data = bpy.data.cameras.new('BlueprintCam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = HALF * 2
cam_data.clip_end = 500
cam = bpy.data.objects.new('BlueprintCam', cam_data)
cam.location = (0, 0, 200)  # looking straight down, north (+Y) at the top
scene.collection.objects.link(cam)
scene.camera = cam

scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'TEXTURE'
scene.display.shading.show_shadows = False
scene.display.shading.show_cavity = True
scene.render.resolution_x = SIZE
scene.render.resolution_y = SIZE
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = os.path.join(OUT, 'render.png')
bpy.ops.render.render(write_still=True)

# ---- overlay ---------------------------------------------------------------------

def px(x, y):
    return MARGIN + (x + HALF) * PX_PER_M, MARGIN + (HALF - y) * PX_PER_M


W = SIZE + 2 * MARGIN
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{W}" font-family="Helvetica, Arial, sans-serif">']

# Grid: thin every 2 m, thick every 10 m.
for k in range(-HALF, HALF + 1, 2):
    major = k % 10 == 0
    stroke = 'rgba(30,90,200,0.55)' if major else 'rgba(30,90,200,0.18)'
    width = 2 if major else 1
    x0, y0 = px(k, -HALF)
    x1, y1 = px(k, HALF)
    svg.append(f'<line x1="{x0}" y1="{y0}" x2="{x1}" y2="{y1}" stroke="{stroke}" stroke-width="{width}"/>')
    x0, y0 = px(-HALF, k)
    x1, y1 = px(HALF, k)
    svg.append(f'<line x1="{x0}" y1="{y0}" x2="{x1}" y2="{y1}" stroke="{stroke}" stroke-width="{width}"/>')
    if major:
        tx, _ = px(k, 0)
        _, ty = px(0, k)
        for (ax, ay, anchor) in ((tx, MARGIN - 18, 'middle'), (tx, W - MARGIN + 34, 'middle')):
            svg.append(f'<text x="{ax}" y="{ay}" font-size="24" fill="#1e5ac8" text-anchor="{anchor}">{k}</text>')
        for (ax, anchor) in ((MARGIN - 12, 'end'), (W - MARGIN + 12, 'start')):
            svg.append(f'<text x="{ax}" y="{ty + 8}" font-size="24" fill="#1e5ac8" text-anchor="{anchor}">{k}</text>')

# Play boundary.
cx, cy = px(0, 0)
svg.append(f'<circle cx="{cx}" cy="{cy}" r="{PLAY_R * PX_PER_M}" fill="none" stroke="rgba(220,40,40,0.8)" stroke-width="3" stroke-dasharray="16 10"/>')

# Buildings: name + storeys at the footprint centre.
labels = []
for empty in bpy.data.collections['Buildings'].objects:
    if empty.name in ('Ring', 'Props'):
        continue
    kids = [o for o in empty.children_recursive if o.type == 'MESH' and o.users_collection[0].name == 'Visual']
    if not kids:
        continue
    pts = [o.matrix_world @ v.co for o in kids if not o.name.endswith('_Generated') for v in list(o.data.vertices)[::7]]
    xs, ys, zs = [p.x for p in pts], [p.y for p in pts], [p.z for p in pts]
    floors = max(1, round((max(zs) - PLOT_H - 1.0) / FLOOR_H))
    enterable = empty.name in ('Centre', 'Quadrant')
    roof = any(o.name.endswith('_Generated') for o in kids) and not enterable
    tag = f'{floors}F' + (' · enterable' if enterable else '') + (' · roof stairs' if roof else '')
    bx, by = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    if empty.name == 'Quadrant':
        bx, by = 26, 16  # label the long wing, not the courtyard
    labels.append({'name': empty.name, 'tag': tag, 'x': round(bx, 1), 'y': round(by, 1)})
    lx, ly = px(bx, by)
    size = 30 if enterable else 20
    for (y, text, s) in ((ly - 4, empty.name.replace('_', ' '), size), (ly + size * 0.85, tag, size * 0.75)):
        svg.append(f'<text x="{lx}" y="{y}" font-size="{s:.0f}" font-weight="bold" text-anchor="middle" '
                   f'fill="#111" stroke="white" stroke-width="5" paint-order="stroke">{text}</text>')

# Courtyard label.
qx, qy = px(32, 32)
svg.append(f'<text x="{qx}" y="{qy}" font-size="26" font-style="italic" text-anchor="middle" fill="#333" stroke="white" stroke-width="5" paint-order="stroke">courtyard</text>')

# Spawns.
spawns = []
for obj in sorted(bpy.data.collections['Spawns'].objects, key=lambda o: o.name):
    x, y, _ = obj.matrix_world.translation
    spawns.append([round(x, 1), round(y, 1)])
    sx, sy = px(x, y)
    svg.append(f'<g stroke="#0a9a3a" stroke-width="4"><line x1="{sx - 10}" y1="{sy - 10}" x2="{sx + 10}" y2="{sy + 10}"/>'
               f'<line x1="{sx - 10}" y1="{sy + 10}" x2="{sx + 10}" y2="{sy - 10}"/></g>')

# Title, scale, north arrow, legend.
svg.append(f'<text x="{MARGIN}" y="40" font-size="30" font-weight="bold" fill="#111">Downtown map · top view · 1 small square = 2 m (one wall piece) · numbers = metres from the centre</text>')
nx, ny = W - MARGIN - 70, MARGIN + 90
svg.append(f'<g transform="translate({nx},{ny})"><polygon points="0,-55 18,0 -18,0" fill="#111"/><text y="40" font-size="34" font-weight="bold" text-anchor="middle">N</text></g>')
legend = [('#0a9a3a', 'X  spawn point'), ('rgba(220,40,40,0.9)', '- - -  play boundary (outer wall)'), ('#111', 'nF = storeys')]
for k, (colour, text) in enumerate(legend):
    svg.append(f'<text x="{MARGIN + 20}" y="{W - MARGIN - 20 - 34 * (len(legend) - 1 - k)}" font-size="26" fill="{colour}" '
               f'stroke="white" stroke-width="5" paint-order="stroke">{text}</text>')
svg.append('</svg>')

with open(os.path.join(OUT, 'overlay.svg'), 'w') as f:
    f.write('\n'.join(svg))
with open(os.path.join(OUT, 'layout.json'), 'w') as f:
    json.dump({'buildings': labels, 'spawns': spawns, 'pxPerMetre': PX_PER_M, 'half': HALF, 'margin': MARGIN}, f, indent=1)
print(f'blueprint: rendered {SIZE}px, {len(labels)} buildings, {len(spawns)} spawns')
