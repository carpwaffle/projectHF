"""Generate the Clock Tower District grey box (maps/district.blend).

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -noaudio \
      --python tools/district_generator.py [-- --force]     (or: npm run gen:map)

The blueprint: https://claude.ai/artifact/TQAqcKbaK8rvvz1DBCx93G (PROJECT_NOTES
§58, §60). Buildings are plain boxes with tiling textures (SURFACES: one per
landmark, tinted, so callouts read at a glance); props (cars, trees, crates,
ladders, ...) are models from the asset packs in map_resource/ (PROPS).

Textures and props are read from map_resource/ (not in git) the first time
and saved, base colour only and at most 1024 px, to maps/textures/ (in git),
which the .blend then uses: regenerating needs map_resource/, exporting
(npm run build:map) doesn't.

Everything below is written in GAME coordinates (x east, y up, z south; north
is -z) and converted to Blender's (x, -z, y) when the meshes are made. Blue
(team 0) is the north half; the south half is its mirror image (z -> -z),
with its own colours. The centre row is itself symmetric across z = 0.

Collections (read by tools/export_map.py):
  Visual     the buildings and ground: one mesh per material (lightmapped)
  Props      cars, trees, furniture, food, ladders: linked copies of the
             library models (drawn with real-time light in the game)
  Collision  COL_Main (movement + bullets), COLP_Rails (players only: railings
             and the ladders' backing plates; bullets pass)
  Spawns     Spawn_<team>_XX empties with a "team" property
  Buildings  (empty)
The scene's "map_meta" property holds the rest of map_meta.json as JSON:
play bounds, pickups, ladders and callout zones (see export_map.py).
"""

import json
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix

ROOT = os.getcwd()
OUT_BLEND = os.path.join(ROOT, 'maps', 'district.blend')
TEX_DIR = os.path.join(ROOT, 'maps', 'textures')
RES = os.path.join(ROOT, 'map_resource')

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FORCE = '--force' in argv

T = 0.3  # wall thickness
H = 3.0  # storey height (floors at 0, 3, 6, ...)
SLAB = 0.25  # floor slab thickness (its top is the floor)
DOOR = 2.6  # door opening height
SILL = 0.8  # window sill: too high to walk over, low enough to jump through
WIN_TOP = 2.6  # window opening top above its floor (ceiling: 2.75)
PARAPET = 1.0
LIGHTMAP_PIECE = 12.0  # (m) see make_mesh
RAIL = 1.0
BOUNDS = (-44, -60, 44, 60)  # play area (x0, z0, x1, z1)

# Each map material: (texture in maps/textures, metres per tile, sRGB tint).
# "stone" and "plaster" are greyscale versions of the kit's (see TEXTURES),
# so their tints give the landmarks their colours.
SURFACES = {
    'Ground': ('asphalt', 4, (1, 1, 1)), 'Canal': ('stone', 3, (0.72, 0.82, 0.88)), 'Plaza': ('stone', 3, (1.0, 0.92, 0.8)),
    'Boundary': ('redbrick', 3, (0.82, 0.8, 0.8)), 'Floor': ('marble', 2, (1, 1, 1)), 'Concrete': ('concrete', 3, (1, 1, 1)),
    'Cover': ('concrete', 2, (0.85, 0.78, 0.68)), 'Rail': ('concrete', 2, (0.32, 0.34, 0.37)),
    'StationBlue': ('plaster', 3, (0.62, 0.74, 0.96)), 'CityHallRed': ('stone', 3, (1.0, 0.76, 0.72)),
    'Hospital': ('plaster', 3, (1, 1, 1)), 'Hotel': ('plaster', 3, (1.0, 0.88, 0.66)),
    'Bank': ('stone', 3, (0.82, 0.82, 0.85)), 'Police': ('plaster', 3, (0.36, 0.44, 0.66)),
    'Warehouse': ('corrugated', 2, (0.5, 0.68, 0.5)), 'Factory': ('redbrick', 3, (1, 1, 1)),
    'Market': ('plaster', 3, (1.0, 0.7, 0.42)), 'Stall': ('wood', 2, (1, 1, 1)),
    'AwningRed': ('plaster', 2, (0.86, 0.12, 0.12)), 'AwningWhite': ('plaster', 2, (1.0, 0.98, 0.94)),
    'Tower': ('stone', 3, (1.0, 0.88, 0.66)), 'Crane': ('plaster', 3, (1.0, 0.78, 0.12)),
    'Subway': ('grid', 2, (0.55, 0.78, 0.76)), 'Clock': ('plaster', 2, (1.0, 1.0, 0.94)),
    'ClockHand': ('concrete', 1, (0.1, 0.1, 0.12)),
    # Signs on the landmarks' walls (see signs()).
    'SignRed': ('plaster', 2, (0.86, 0.1, 0.1)), 'SignWhite': ('plaster', 2, (1.0, 1.0, 1.0)),
    'SignGold': ('plaster', 2, (1.0, 0.76, 0.16)), 'SignMaroon': ('plaster', 2, (0.52, 0.08, 0.1)),
    'Desk': ('plaster', 2, (0.78, 0.6, 0.42)), 'Partition': ('plaster', 2, (0.5, 0.57, 0.64)),
    'Monitor': ('concrete', 1, (0.07, 0.07, 0.09)),
    # Props retextured (PROPS' 4th field): the sci-fi kit's drum and block.
    'Drum': ('concrete', 1, (0.86, 0.4, 0.14)), 'Block': ('concrete', 1, (0.84, 0.83, 0.8)),
    # Sky cover for the fly hack (see balloons()).
    'Blimp': ('plaster', 3, (0.93, 0.94, 0.96)), 'Basket': ('wood', 1, (0.9, 0.8, 0.66)),
    'BalloonBlue': ('plaster', 2, (0.16, 0.38, 0.86)), 'BalloonRed': ('plaster', 2, (0.86, 0.14, 0.12)),
    'BalloonWhite': ('plaster', 2, (1.0, 0.98, 0.94)), 'SignBlue': ('plaster', 2, (0.12, 0.32, 0.86)),
}
# Texture sources (in map_resource/): file, and whether to make it greyscale.
TEXTURES = {
    'asphalt': ('Downtown City MegaKit[Standard]/Textures/T_Concrete_Asphalt_BaseColor.png', False),
    'concrete': ('Downtown City MegaKit[Standard]/Textures/T_Concrete_BaseColor.png', False),
    'marble': ('Downtown City MegaKit[Standard]/Textures/T_MarbleFloor_BaseColor.png', False),
    'redbrick': ('Downtown City MegaKit[Standard]/Textures/T_RedBrick_BaseColor.png', False),
    'stone': ('Medieval Village MegaKit[Standard]/Textures/T_Brick_BaseColor.png', True),
    'plaster': ('Medieval Village MegaKit[Standard]/Textures/T_Plaster_BaseColor.png', True),
    'wood': ('Medieval Village MegaKit[Standard]/Textures/T_WoodTrim_BaseColor.png', False),  # (its top band: planks)
}

VIS = {}  # material -> list of faces (each a list of game-space points)
COL = []  # faces: movement + bullets
COLP = []  # faces: players only


# ---- primitives (game coordinates) ------------------------------------------------

def box_faces(x0, x1, y0, y1, z0, z1):
    p = lambda x, y, z: (x, y, z)
    return [
        [p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)],  # top
        [p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)],  # bottom
        [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)],  # south (+z)
        [p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0)],  # north (-z)
        [p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1)],  # east
        [p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)],  # west
    ]


def box(x0, x1, y0, y1, z0, z1, mat, col='main'):
    """A solid box. col: 'main' (blocks everything), 'player' (players only) or None (visual only)."""
    if x1 - x0 < 1e-4 or y1 - y0 < 1e-4 or z1 - z0 < 1e-4:
        return
    faces = box_faces(x0, x1, y0, y1, z0, z1)
    if mat:
        VIS.setdefault(mat, []).extend(faces)
    if col == 'main':
        COL.extend(faces)
    elif col == 'player':
        COLP.extend(faces)


def orient(faces):
    """Wind a convex solid's faces outwards (three.js draws front faces only;
    the bots' navigation reads floors' normals)."""
    pts = [p for f in faces for p in f]
    c = [sum(p[i] for p in pts) / len(pts) for i in range(3)]
    out = []
    for f in faces:
        a, b, d = f[0], f[1], f[2]
        u = [b[i] - a[i] for i in range(3)]
        v = [d[i] - b[i] for i in range(3)]
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        m = [sum(p[i] for p in f) / len(f) - c[i] for i in range(3)]
        out.append(f if sum(n[i] * m[i] for i in range(3)) >= 0 else f[::-1])
    return out


def prism(points, y0, y1, mat, col='main'):
    """Vertical prism over a convex polygon (x, z points)."""
    top = [(x, y1, z) for x, z in points]
    faces = [top, [(x, y0, z) for x, z in points]]
    n = len(points)
    for i in range(n):
        (ax, az), (bx, bz) = points[i], points[(i + 1) % n]
        faces.append([(ax, y0, az), (bx, y0, bz), (bx, y1, bz), (ax, y1, az)])
    faces = orient(faces)
    VIS.setdefault(mat, []).extend(faces)
    if col == 'main':
        COL.extend(faces)


def tilted(xh, xl, yh, yl, z0, z1, thick, mat, col='main'):
    """A slab sloping along x (an awning): its underside at height yh at x
    xh, falling to yl at x xl; thick m thick, from z0 to z1."""
    a = [(xh, yh, z0), (xh, yh + thick, z0), (xl, yl + thick, z0), (xl, yl, z0)]
    b = [(x, y, z1) for x, y, _ in a]
    faces = orient([a, b] + [[a[i], a[(i + 1) % 4], b[(i + 1) % 4], b[i]] for i in range(4)])
    VIS.setdefault(mat, []).extend(faces)
    if col == 'main':
        COL.extend(faces)


def face_bar(c, n, angle, r0, r1, width, d0, d1, mat):
    """A bar standing off a vertical face (visual only): centre c (x, y, z)
    on the face's surface, n (x, z) its outward normal; from r0 to r1 along
    the direction `angle` (radians clockwise from straight up, as seen from
    outside), `width` across, d0 to d1 out from the surface."""
    nx, nz = n
    rx, rz = nz, -nx  # the viewer's right
    ux, uy = math.sin(angle), math.cos(angle)  # (along: right, up)
    ax, ay = math.cos(angle), -math.sin(angle)  # (across)

    def p(r, w, d):
        right = ux * r + ax * w
        return (c[0] + rx * right + nx * d, c[1] + uy * r + ay * w, c[2] + rz * right + nz * d)
    corners = [[[p(r, w, d) for d in (d0, d1)] for w in (-width / 2, width / 2)] for r in (r0, r1)]
    (a0, a1), (b0, b1) = corners[0]
    (c0, c1), (e0, e1) = corners[1]
    faces = [[a0, b0, e0, c0], [a1, c1, e1, b1], [a0, c0, c1, a1], [b0, b1, e1, e0], [a0, a1, b1, b0], [c0, e0, e1, c1]]
    VIS.setdefault(mat, []).extend(orient(faces))


def clock(c, n, hour=10, minute=10):
    """Hour ticks, hands (showing hour:minute) and a hub on a clock face."""
    for i in range(12):
        long = i % 3 == 0
        face_bar(c, n, i * math.pi / 6, 0.92 if long else 0.98, 1.1, 0.1 if long else 0.06, 0, 0.03, 'ClockHand')
    face_bar(c, n, (hour % 12 + minute / 60) * math.pi / 6, -0.12, 0.6, 0.11, 0.02, 0.06, 'ClockHand')
    face_bar(c, n, minute * math.pi / 30, -0.15, 0.95, 0.07, 0.06, 0.1, 'ClockHand')
    face_bar(c, n, 0, -0.08, 0.08, 0.16, 0, 0.12, 'ClockHand')  # hub


def face_poly(c, n, pts, d0, d1, mat):
    """A flat convex shape standing off a vertical face (visual only): pts
    (right, up) from c on the face's surface (right: the viewer's, from
    outside), d0 to d1 out from it."""
    nx, nz = n
    rx, rz = nz, -nx
    p = lambda r, u, d: (c[0] + rx * r + nx * d, c[1] + u, c[2] + rz * r + nz * d)
    front, back = [p(r, u, d1) for r, u in pts], [p(r, u, d0) for r, u in pts]
    k = len(pts)
    faces = [front, back] + [[back[i], back[(i + 1) % k], front[(i + 1) % k], front[i]] for i in range(k)]
    VIS.setdefault(mat, []).extend(orient(faces))


def arc(cx, cy, rx, ry, a0, a1, steps=12):
    """Points on an elliptical arc, a0 to a1 degrees (0: right, 90: up)."""
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / steps)),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]


# Stroke letters for the signs: polylines in a 1 x 1 box (x right, y up).
GLYPHS = {
    'H': [[(0, 0), (0, 1)], [(1, 0), (1, 1)], [(0, 0.5), (1, 0.5)]],
    'O': [arc(0.5, 0.5, 0.5, 0.5, 0, 360, 20)],
    'T': [[(0, 1), (1, 1)], [(0.5, 0), (0.5, 1)]],
    'E': [[(1, 1), (0, 1), (0, 0), (1, 0)], [(0, 0.5), (0.8, 0.5)]],
    'L': [[(0, 1), (0, 0), (1, 0)]],
    'P': [[(0, 0), (0, 1), (0.55, 1)] + arc(0.55, 0.75, 0.45, 0.25, 90, -90) + [(0, 0.5)]],
    'I': [[(0.5, 0), (0.5, 1)], [(0.2, 1), (0.8, 1)], [(0.2, 0), (0.8, 0)]],
    'C': [arc(0.5, 0.5, 0.5, 0.5, 45, 315, 16)],
    'A': [[(0, 0), (0.5, 1), (1, 0)], [(0.24, 0.42), (0.76, 0.42)]],
    'K': [[(0, 0), (0, 1)], [(1, 1), (0.06, 0.42)], [(0.4, 0.6), (1, 0)]],
    'S': [arc(0.5, 0.75, 0.45, 0.25, 10, 270, 14) + arc(0.5, 0.25, 0.45, 0.25, 90, -170, 14)],
    'J': [[(0.3, 1), (1, 1)], [(0.65, 1), (0.65, 0.3)] + arc(0.35, 0.3, 0.3, 0.3, 0, -160, 10)],
    'U': [[(0, 1), (0, 0.35)] + arc(0.5, 0.35, 0.5, 0.35, 180, 360, 12) + [(1, 1)]],
    ' ': [],
    '$': [arc(0.5, 0.75, 0.42, 0.25, 10, 270, 14), arc(0.5, 0.25, 0.42, 0.25, 90, -170, 14), [(0.5, -0.14), (0.5, 1.14)]],
}


def stroke(c, n, pts, t, d0, d1, mat):
    """A polyline t thick on a vertical face (visual only): pts (right, up)
    from c; square ends, mitred corners, closed if it ends where it starts.
    One piece per segment, sharing their edges (no overlaps: those bake
    dark, each shading the other)."""
    pts = [p for i, p in enumerate(pts) if i == 0 or math.dist(p, pts[i - 1]) > 1e-6]  # (repeats: where a glyph's parts meet)
    closed = math.dist(pts[0], pts[-1]) < 1e-6
    if closed:
        pts = pts[:-1]
    k = len(pts)
    seg = []  # unit directions
    for i in range(k if closed else k - 1):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % k]
        length = math.hypot(bx - ax, by - ay)
        seg.append(((bx - ax) / length, (by - ay) / length))
    def offset(i):  # the point's two outline corners: (left side, right side)
        x, y = pts[i]
        before = seg[i - 1] if (closed or i > 0) else None
        after = seg[i % len(seg)] if (closed or i < k - 1) else None
        if before is None or after is None:  # an end: squared off, half a stroke beyond
            dx, dy = after or before
            x, y = (x - dx * t / 2, y - dy * t / 2) if before is None else (x + dx * t / 2, y + dy * t / 2)
            nx_, ny_ = -dy, dx
            return (x + nx_ * t / 2, y + ny_ * t / 2), (x - nx_ * t / 2, y - ny_ * t / 2)
        n1, n2 = (-before[1], before[0]), (-after[1], after[0])
        mx, my = n1[0] + n2[0], n1[1] + n2[1]
        ml = math.hypot(mx, my)
        mx, my = mx / ml, my / ml
        scale = (t / 2) / max(0.3, mx * n1[0] + my * n1[1])
        return (x + mx * scale, y + my * scale), (x - mx * scale, y - my * scale)
    corners = [offset(i) for i in range(k)]
    for i in range(len(seg)):
        (al, ar), (bl, br) = corners[i], corners[(i + 1) % k]
        face_poly(c, n, [al, bl, br, ar], d0, d1, mat)


def sign_text(c, n, text, h, w, gap, t, mat, d=(0.02, 0.12)):
    """Letters (GLYPHS) h tall, w wide, gap apart, strokes t thick, on a
    vertical face, centred on c (on its surface; n: its outward normal).
    Each of a letter's strokes stands a little further out than the one
    before, where they cross."""
    left = -(len(text) * w + (len(text) - 1) * gap) / 2
    for i, ch in enumerate(text):
        x0 = left + i * (w + gap)
        for j, line in enumerate(GLYPHS[ch]):
            stroke(c, n, [(x0 + x * w, y * h - h / 2) for x, y in line], t, d[0], d[1] + 0.02 * j, mat)


def star(c, n, radius, mat, d=(0.02, 0.14)):
    """A five-pointed star (point up) on a vertical face, centred on c."""
    pt = lambda r, k: (r * math.cos(math.radians(90 + 36 * k)), r * math.sin(math.radians(90 + 36 * k)))
    inner = radius * 0.382
    face_poly(c, n, [pt(inner, 2 * i + 1) for i in range(5)], *d, mat)  # (the middle)
    for i in range(5):
        face_poly(c, n, [pt(inner, 2 * i - 1), pt(radius, 2 * i), pt(inner, 2 * i + 1)][::-1], *d, mat)


def signs():
    """Big signs on the landmarks' walls toward the centre, clear of the
    windows: the Hospital's red cross and the Hotel's name in the column
    above their canal-side doors (x -23.4 .. -16), the Bank's \$ in a column
    of its south wall (x 16.6 .. 20) and the Police Station's star and name
    along the ground floor of its north wall (no windows below 3.8 m)."""
    # Hospital: a red cross (an upright bar and two arms meeting it, no overlaps).
    for pts in (((-0.75, -2.4), (0.75, -2.4), (0.75, 2.4), (-0.75, 2.4)),
                ((-2.4, -0.75), (-0.75, -0.75), (-0.75, 0.75), (-2.4, 0.75)),
                ((0.75, -0.75), (2.4, -0.75), (2.4, 0.75), (0.75, 0.75))):
        face_poly((-19.7, 10, -16), (0, 1), pts, 0.02, 0.14, 'SignRed')
    sign_text((-19.7, 11.5, 16), (0, -1), 'HOTEL', 2.0, 1.1, 0.3, 0.34, 'SignMaroon')
    sign_text((18.3, 6.2, -18), (0, 1), '$', 4.2, 2.4, 0, 0.45, 'SignGold')
    # Police Station: the star on the viewer's left (+x: this wall faces -z), then the name.
    star((22.7, 2.3, 18), (0, -1), 1.15, 'SignGold')
    sign_text((16.5, 2.3, 18), (0, -1), 'POLICE', 2.0, 1.2, 0.3, 0.34, 'SignWhite')


def flight(x0, x1, z0, z1, ybot, ytop, up, mat='Concrete'):
    """Stairs over the rectangle, rising towards `up` ('N', 'S', 'E', 'W').
    Drawn as steps; the collision is a smooth ramp (a wedge)."""
    rise = ytop - ybot
    n = max(1, round(rise / 0.2))
    along_x = up in 'EW'
    lo, hi = (x0, x1) if along_x else (z0, z1)
    forward = up in 'ES'  # rising towards +x / +z
    for i in range(n):
        a = lo + (hi - lo) * i / n
        b = lo + (hi - lo) * (i + 1) / n
        k = (i + 1) if forward else (n - i)
        y = ybot + rise * k / n
        if along_x:
            VIS.setdefault(mat, []).extend(box_faces(a, b, ybot - 0.01, y, z0, z1))
        else:
            VIS.setdefault(mat, []).extend(box_faces(x0, x1, ybot - 0.01, y, a, b))
    # Ramp: the low edge at the bottom end, the high edge at the top end.
    def pt(u, y, w):  # u along the rise, w across
        return (u, y, w) if along_x else (w, y, u)
    ulo, uhi = (lo, hi) if forward else (hi, lo)  # bottom end, top end
    wlo, whi = (z0, z1) if along_x else (x0, x1)
    b0, b1 = pt(ulo, ybot, wlo), pt(ulo, ybot, whi)
    t0, t1 = pt(uhi, ytop, wlo), pt(uhi, ytop, whi)
    f0, f1 = pt(uhi, ybot, wlo), pt(uhi, ybot, whi)
    COL.extend(orient([[b0, b1, t1, t0], [b0, f0, f1, b1], [f0, t0, t1, f1], [b0, t0, f0], [b1, f1, t1]]))


def rect_minus(x0, x1, z0, z1, holes):
    """The rectangle minus holes, as rectangles (grid decomposition, merged along x)."""
    xs = sorted({x0, x1, *[c for h in holes for c in (h[0], h[1]) if x0 < c < x1]})
    zs = sorted({z0, z1, *[c for h in holes for c in (h[2], h[3]) if z0 < c < z1]})
    out = []
    for j in range(len(zs) - 1):
        za, zb = zs[j], zs[j + 1]
        run = None
        for i in range(len(xs) - 1):
            xa, xb = xs[i], xs[i + 1]
            cx, cz = (xa + xb) / 2, (za + zb) / 2
            solid = not any(h[0] <= cx <= h[1] and h[2] <= cz <= h[3] for h in holes)
            if solid:
                run = [run[0], xb] if run else [xa, xb]
            elif run:
                out.append((run[0], run[1], za, zb))
                run = None
        if run:
            out.append((run[0], run[1], za, zb))
    return out


def slab(x0, x1, z0, z1, top, mat='Floor', holes=(), thick=SLAB):
    for a, b, c, d in rect_minus(x0, x1, z0, z1, list(holes)):
        box(a, b, top - thick, top, c, d, mat)


def wall(axis, fixed0, fixed1, lo, hi, y0, y1, mat, openings=()):
    """A wall along x (axis 'x': spans x lo..hi, z fixed0..fixed1) or along z,
    with openings (a, b, oy0, oy1) cut out of it."""
    def piece(a, b, ya, yb):
        if axis == 'x':
            box(a, b, ya, yb, fixed0, fixed1, mat)
        else:
            box(fixed0, fixed1, ya, yb, a, b, mat)
    # Split into vertical strips at every opening edge.
    cuts = sorted({lo, hi, *[c for o in openings for c in (o[0], o[1]) if lo < c < hi]})
    for i in range(len(cuts) - 1):
        a, b = cuts[i], cuts[i + 1]
        mid = (a + b) / 2
        gaps = sorted((o[2], o[3]) for o in openings if o[0] <= mid <= o[1])
        y = y0
        for g0, g1 in gaps:
            if g0 > y:
                piece(a, b, y, g0)
            y = max(y, g1)
        if y < y1:
            piece(a, b, y, y1)


def shell(x0, x1, z0, z1, y1, mat, openings=None, y0=0.0, floor='Floor'):
    """Four walls inside the footprint (outer faces on its edges). openings:
    {'N'|'S'|'E'|'W': [(a, b, oy0, oy1), ...]} with a, b along the wall (x for
    N/S walls, z for E/W). floor: the ground floor's surface (drawn 1 cm over
    the ground, which stays the collision)."""
    o = openings or {}
    if floor and y0 == 0:
        box(x0 + T, x1 - T, 0, 0.01, z0 + T, z1 - T, floor, None)
    wall('x', z0, z0 + T, x0, x1, y0, y1, mat, o.get('N', ()))
    wall('x', z1 - T, z1, x0, x1, y0, y1, mat, o.get('S', ()))
    wall('z', x0, x0 + T, z0 + T, z1 - T, y0, y1, mat, o.get('W', ()))
    wall('z', x1 - T, x1, z0 + T, z1 - T, y0, y1, mat, o.get('E', ()))


def rail(x0, x1, z0, z1, y, mat='Rail'):
    """A railing (thin, players only) along a line: either x0 == x1 or z0 == z1."""
    w = 0.05
    if abs(x1 - x0) < 1e-6:
        box(x0 - w, x0 + w, y, y + RAIL, z0, z1, mat, 'player')
    else:
        box(x0, x1, y, y + RAIL, z0 - w, z0 + w, mat, 'player')


def door(a, b, floor=0.0):
    return (a, b, floor, floor + DOOR)


def windows(spans, floors):
    return [(a, b, f + SILL, f + WIN_TOP) for f in floors for a, b in spans]


# ---- mirror: everything north of the centre line gets a south twin ---------------

class Recorder:
    """Records calls made while building the north half, then replays them
    mirrored (z -> -z) with the south twin's materials."""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        fn = globals()[name]

        def call(*args, **kw):
            self.calls.append((name, args, kw))
            return fn(*args, **kw)
        return call


def mirror_call(name, args, kw, mats):
    m = lambda mat: mats.get(mat, mat)
    a = list(args)
    if name == 'box':
        x0, x1, y0, y1, z0, z1, mat = a[:7]
        box(x0, x1, y0, y1, -z1, -z0, m(mat), *a[7:], **kw)
    elif name == 'flight':
        x0, x1, z0, z1, yb, yt, up = a[:7]
        up = {'N': 'S', 'S': 'N'}.get(up, up)
        flight(x0, x1, -z1, -z0, yb, yt, up, *[m(v) for v in a[7:]], **{k: m(v) for k, v in kw.items()})
    elif name == 'slab':
        x0, x1, z0, z1, top = a[:5]
        rest = a[5:]
        kw = dict(kw)
        if rest:
            kw['mat'] = rest[0]
        if len(rest) > 1:
            kw['holes'] = rest[1]
        kw['mat'] = m(kw.get('mat', 'Floor'))
        kw['holes'] = [(h[0], h[1], -h[3], -h[2]) for h in kw.get('holes', ())]
        slab(x0, x1, -z1, -z0, top, **kw)
    elif name == 'shell':
        x0, x1, z0, z1, y1, mat = a[:6]
        o = dict(a[6] if len(a) > 6 else kw.get('openings') or {})
        flip = lambda ops: [(-q[1], -q[0], q[2], q[3]) for q in ops]
        o2 = {'N': o.get('S', ()), 'S': o.get('N', ()), 'E': flip(o.get('E', ())), 'W': flip(o.get('W', ()))}
        shell(x0, x1, -z1, -z0, y1, m(mat), o2, **{k: v for k, v in kw.items() if k != 'openings'})
    elif name == 'wall':
        axis, f0, f1, lo, hi, y0, y1, mat = a[:8]
        ops = list(a[8] if len(a) > 8 else kw.get('openings', ()))
        if axis == 'x':
            wall(axis, -f1, -f0, lo, hi, y0, y1, m(mat), ops)
        else:
            wall(axis, f0, f1, -hi, -lo, y0, y1, m(mat), [(-q[1], -q[0], q[2], q[3]) for q in ops])
    elif name == 'rail':
        x0, x1, z0, z1, y = a[:5]
        rail(x0, x1, -z1, -z0, y, *a[5:], **kw)
    elif name == 'tilted':
        xh, xl, yh, yl, z0, z1 = a[:6]
        tilted(xh, xl, yh, yl, -z1, -z0, a[6], m(a[7]), *a[8:], **kw)
    elif name == 'prism':
        pts, y0, y1, mat = a[:4]
        prism([(x, -z) for x, z in reversed(pts)], y0, y1, m(mat), *a[4:], **kw)
    else:
        raise ValueError(name)


# ---- the map ----------------------------------------------------------------------

LADDERS = []  # {p: [x, z] (on the ladder's plane), n: [nx, nz] (towards the climber), w, y0, y1}
LADDER_MODELS = []  # (x, z, nx, nz, y0, y1): drawn with the Platformer Pack's ladders (see place_ladders)
PROP_LIST = []  # (key, x, y, z, rot in degrees about up (Blender's), collide)
METAL = []  # {rect, y}: metal floors (footstep sound)
SPAWNS = []  # (x, y, z, team, turn)
PICKUPS = {'weapon': [], 'heal': [], 'money': []}
ZONES = []  # see export: {id, rect: [x0, z0, x1, z1], y?: [lo, hi], floors?: base, roof?}


def ladder(px, pz, nx, nz, y0, y1, backing=False, half=0.32, mirrored=True):
    """A ladder on a plane through (px, pz) facing (nx, nz) (the climber's
    side). Its south twin too unless mirrored=False (centre row). backing: a
    thin players-only plate behind it (free-standing ladders)."""
    for s in ((1, -1) if mirrored else (1,)):
        qz, mz = pz * s, nz * s
        LADDERS.append({'p': [px, qz], 'n': [nx, mz], 'w': half, 'y0': y0, 'y1': y1})
        tx, tz = -mz, nx  # along the ladder
        LADDER_MODELS.append((px + nx * 0.12, qz + mz * 0.12, nx, mz, y0, y1))
        if backing:  # 0.1 m thick, behind the plane (away from the climber)
            ends = [(px + tx * e * (half + 0.05) - nx * d, qz + tz * e * (half + 0.05) - mz * d) for e in (-1, 1) for d in (0, 0.1)]
            xs, zs = [e[0] for e in ends], [e[1] for e in ends]
            box(min(xs), max(xs), y0, y1, min(zs), max(zs), None, 'player')


# turn: radians from straight ahead (Blue: south; Red, mirrored: north),
# positive = towards +x.
def spawn(x, y, z, turn=0):
    SPAWNS.append((x, y, z, 0, turn))
    SPAWNS.append((x, y, -z, 1, turn))


def pickup(kind, x, y, z, mirrored=True):
    PICKUPS[kind].append([x, y, z])
    if mirrored:
        PICKUPS[kind].append([x, y, -z])


def zone(zid, x0, z0, x1, z1, south=None, y=None, floors=None, roof=None):
    """A callout area (and its south twin, called `south`; None: the centre row)."""
    for name, a, b in ((zid, z0, z1), (south, -z1, -z0)):
        if name is None:
            continue
        z = {'id': name, 'rect': [x0, a, x1, b]}
        if y is not None:
            z['y'] = y
        if floors is not None:
            z['floor'] = floors
        if roof is not None:
            z['roof'] = roof
        ZONES.append(z)


def prop(key, x, y, z, rot=0, collide=True, mirrored=True):
    """A model from PROPS at game (x, y, z), turned rot degrees (0: its length
    along z). mirrored: its south twin too (turned to mirror its front)."""
    PROP_LIST.append((key, x, y, z, rot, collide))
    if mirrored:
        PROP_LIST.append((key, x, y, -z, 180 - rot, collide))


def metal(x0, z0, x1, z1, lo, hi, mirrored=True):
    for a, b in ((z0, z1), (-z1, -z0)) if mirrored else ((z0, z1),):
        METAL.append({'rect': [x0, a, x1, b], 'y': [lo, hi]})


SOUTH = {'StationBlue': 'CityHallRed', 'Hospital': 'Hotel', 'Bank': 'Police', 'Warehouse': 'Factory'}


# Models (in map_resource/) placed with prop(): file, how far to lift it so
# it stands on the floor (None: by its lowest point), and a scale (the food
# and house interior packs are modelled ~2x and ~10x too big), and optionally
# a SURFACES material to retexture it with (box-projected UVs).
FURNITURE = 0.55
RUG_LIFT = 0.015  # m: the rugs are mostly flat at their base, level with the floor (z-fighting)
PROPS = {
    'car1': ('Realistic Car Pack - Nov 2018/OBJ/NormalCar1.obj', 0),
    'car2': ('Realistic Car Pack - Nov 2018/OBJ/NormalCar2.obj', 0),
    'suv': ('Realistic Car Pack - Nov 2018/OBJ/SUV.obj', 0.02),
    'sports': ('Realistic Car Pack - Nov 2018/OBJ/SportsCar.obj', 0),
    'taxi': ('Realistic Car Pack - Nov 2018/OBJ/Taxi.obj', 0.01),
    'cop': ('Realistic Car Pack - Nov 2018/OBJ/Cop.obj', 0.02),
    'tree': ('Stylized Nature MegaKit[Standard]/glTF/CommonTree_3.gltf', 0),
    'bush': ('Stylized Nature MegaKit[Standard]/glTF/Bush_Common.gltf', 0),
    'crate': ('Medieval Village MegaKit[Standard]/glTF/Prop_Crate.gltf', 0),
    'crate2': ('Modular SciFi MegaKit[Standard]/glTF/Props/Prop_Crate4.gltf', 0.56, 1, 'Block'),
    'barrel': ('Modular SciFi MegaKit[Standard]/glTF/Props/Prop_Barrel_Large.gltf', 0, 1, 'Drum'),
    'wagon': ('Medieval Village MegaKit[Standard]/glTF/Prop_Wagon.gltf', 0),
    'ac': ('Downtown City MegaKit[Standard]/Exports/glTF (Godot)/Prop_ACUnit.gltf', 0),
    'bollard': ('Downtown City MegaKit[Standard]/Exports/glTF (Godot)/Prop_Bollard.gltf', 0),
    'planter': ('Downtown City MegaKit[Standard]/Exports/glTF (Godot)/Prop_Planter_Single.gltf', 0),
    'ladder_long': ('Platformer Pack - Nov 2018/OBJ/Ladder_long.obj', 0.02),
    'ladder_medium': ('Platformer Pack - Nov 2018/OBJ/Ladder_medium.obj', 0.01),
    'ladder_short': ('Platformer Pack - Nov 2018/OBJ/Ladder_short.obj', 0.02),
    # House interior
    'bed': ('Ultimate House Interior Pack - June 2020/OBJ/Bed_Single.obj', 0, FURNITURE),
    'nightstand': ('Ultimate House Interior Pack - June 2020/OBJ/NightStand_1.obj', 0, FURNITURE),
    'bookshelf': ('Ultimate House Interior Pack - June 2020/OBJ/Bookshelf.obj', None, FURNITURE),
    'shelf': ('Ultimate House Interior Pack - June 2020/OBJ/Shelf_Large.obj', None, FURNITURE),
    'chair': ('Ultimate House Interior Pack - June 2020/OBJ/Chair_1.obj', 0, FURNITURE),
    'chair2': ('Ultimate House Interior Pack - June 2020/OBJ/Chair_2.obj', 0, FURNITURE),
    'table': ('Ultimate House Interior Pack - June 2020/OBJ/Table_RoundSmall.obj', None, FURNITURE),
    'table_long': ('Ultimate House Interior Pack - June 2020/OBJ/Table_RoundLarge.obj', None, FURNITURE),
    'couch': ('Ultimate House Interior Pack - June 2020/OBJ/Couch_Large1.obj', 0, FURNITURE),
    'couch2': ('Ultimate House Interior Pack - June 2020/OBJ/Couch_Medium1.obj', None, FURNITURE),
    'drawers': ('Ultimate House Interior Pack - June 2020/OBJ/Drawer_3.obj', 0, FURNITURE),
    'kitchen': ('Ultimate House Interior Pack - June 2020/OBJ/Kitchen_3Drawers.obj', 0, FURNITURE),
    'fridge': ('Ultimate House Interior Pack - June 2020/OBJ/Kitchen_Fridge.obj', None, FURNITURE),
    'plant': ('Ultimate House Interior Pack - June 2020/OBJ/Houseplant_3.obj', 0, 1.7),  # a cactus, ~1.4 m
    'plant2': ('Ultimate House Interior Pack - June 2020/OBJ/Houseplant_6.obj', 0, 1.15),  # a big leafy plant, ~1.1 m tall and wide
    'bin': ('Ultimate House Interior Pack - June 2020/OBJ/Trashcan_Green.obj', 0, FURNITURE),
    'bin2': ('Ultimate House Interior Pack - June 2020/OBJ/Trashcan_Large.obj', None, FURNITURE),
    'lamp': ('Ultimate House Interior Pack - June 2020/OBJ/Light_Floor1.obj', None, FURNITURE),
    'carpet': ('Ultimate House Interior Pack - June 2020/OBJ/Carpet_1.obj', RUG_LIFT, FURNITURE),
    'stool': ('Ultimate House Interior Pack - June 2020/OBJ/Stool.obj', 0, FURNITURE),
    'sink': ('Ultimate House Interior Pack - June 2020/OBJ/Bathroom_Sink.obj', None, FURNITURE),
    'fireplace': ('Ultimate House Interior Pack - June 2020/OBJ/Fireplace.obj', 0, FURNITURE),
    'sofa': ('Ultimate House Interior Pack - June 2020/OBJ/Couch_Large2.obj', 0, FURNITURE),
    'armchair': ('Ultimate House Interior Pack - June 2020/OBJ/Couch_Small2.obj', 0, FURNITURE),
    'rug': ('Ultimate House Interior Pack - June 2020/OBJ/Carpet_2.obj', RUG_LIFT, FURNITURE),
    'rug2': ('Ultimate House Interior Pack - June 2020/OBJ/Carpet_1.obj', RUG_LIFT, FURNITURE),
    'rug_round': ('Ultimate House Interior Pack - June 2020/OBJ/Carpet_Round.obj', RUG_LIFT, FURNITURE),
    'coffee_table': ('Ultimate House Interior Pack - June 2020/OBJ/Table_RoundSmall2.obj', None, FURNITURE),
    'floor_lamp': ('Ultimate House Interior Pack - June 2020/OBJ/Light_Stand1.obj', 0, FURNITURE),
    'sideboard': ('Ultimate House Interior Pack - June 2020/OBJ/Drawer_1.obj', 0, FURNITURE),
    'curtain': ('Ultimate House Interior Pack - June 2020/OBJ/Curtains_Single.obj', 0, FURNITURE),
    # Food (on the market stalls)
    'apple': ('Ultimate Food Pack - Oct 2019/OBJ/Apple.obj', None, 0.22),
    'orange': ('Ultimate Food Pack - Oct 2019/OBJ/Orange.obj', None, 0.24),
    'tomato': ('Ultimate Food Pack - Oct 2019/OBJ/Tomato.obj', None, 0.24),
    'broccoli': ('Ultimate Food Pack - Oct 2019/OBJ/Broccoli.obj', None, 0.3),
    'coconut': ('Ultimate Food Pack - Oct 2019/OBJ/Coconut.obj', None, 0.25),
    'bread': ('Ultimate Food Pack - Oct 2019/OBJ/Bread.obj', None, 0.3),
    'fish': ('Ultimate Food Pack - Oct 2019/OBJ/Fish.obj', None, 0.17),
    'pumpkin': ('Ultimate Food Pack - Oct 2019/OBJ/Pumpkin.obj', None, 0.3),
    'lettuce': ('Ultimate Food Pack - Oct 2019/OBJ/Lettuce_Whole.obj', None, 0.22),
    'eggplant': ('Ultimate Food Pack - Oct 2019/OBJ/Eggplant.obj', None, 0.22),
}


def props_north():
    """Props in the north half (mirrored into the south)."""
    # Main Street: parked along the kerbs, one stopped across the road (cover).
    prop('car1', -6.3, 0, -21, 0)
    prop('car2', -6.3, 0, -28.5, 0)
    # Beside the Bank: an SUV and a sports car; beside the Police Station
    # (their mirror spots), police cars.
    for key, x, z, rot in (('suv', 6.3, -14.5, 180), ('sports', 1.0, -25, 70)):
        prop(key, x, 0, z, rot, mirrored=False)
        prop('cop', x, 0, -z, 180 - rot, mirrored=False)
    prop('taxi', -18.5, 0, -42.5, 90)  # waiting at the station / City Hall
    prop('car1', 5.5, 0, -41, 95)
    # In front of the Bank: ordinary cars; the Police Station's are police cars.
    for x, rot in ((13, 90), (22, 95)):
        prop('car2' if x < 20 else 'suv', x, 0, -42.5, rot, mirrored=False)
        prop('cop', x, 0, 42.5, 180 - rot, mirrored=False)
    # Trees at the plaza's corners and on Bridge Street; planters with bushes.
    prop('tree', -9.5, 0, -10.5, collide='trunk')
    prop('tree', 9.6, 0, -10.6, 40, collide='trunk')
    prop('tree', -29.3, 0, -6.5, 120, collide='trunk')
    for x, z in ((-29.5, -11.5), (-12.7, -13.5)):
        prop('planter', x, 0, z)
        prop('bush', x, 0.55, z, 30, collide=False)
    for x in (-10.2, -8.4, 8.4, 10.2):  # bollards along the plaza's edge
        prop('bollard', x, 0, -12.4)
    # Warehouse: crates and barrels round the containers.
    prop('crate', 40, 0, -30.5)
    prop('crate', 40, 1.06, -30.5, 15)
    prop('crate', 40.9, 0, -29.3, 40)
    for x, z in ((33, -27.6), (33.6, -27.0), (32.9, -26.3)):
        prop('barrel', x, 0, z)
    # Market Alley and Market Hall: carts and crates.
    prop('wagon', 29.9, 0, -44.5)
    prop('crate', 30.4, 0, -32.5)
    prop('crate', 26.1, 0, -24.3, 20)
    prop('crate', 42.6, 0, -8.6)
    prop('crate', 42.6, 1.06, -8.6, 30)
    # Construction: barrels and crates.
    prop('barrel', 12.3, 0, -8.6)
    prop('barrel', 12.95, 0, -9.1)
    prop('crate2', 23.6, 0, -8.8)
    prop('crate2', 23.6, 1.12, -8.8, 25)
    # Canal: crates by the ramp, barrels on the far quay and under the bridge.
    prop('crate', -29.2, 0, -44.5)
    prop('crate', -29.2, 1.06, -44.5, 25)
    prop('crate', -28.0, 0, -44.9, 10)
    for x, z in ((-42.5, -33), (-42.0, -32.4), (-38.6, -2.6)):
        prop('barrel', x, 0 if x < -40 else -2.5, z)
    # Roofs: air conditioning units.
    for x, y, z in ((-21.5, 15, -36.6), (-16, 15, -36.6), (22.5, 9, -20.6), (13.5, 9, -36.4),
                    (37, 6.25, -6), (-22, 6.25, -57), (18, 6.25, -58)):
        prop('ac', x, y, z)
    # Market Alley stalls: a fruit stall, a fishmonger's, a greengrocer's.
    for (sx0, sx1, sz0, sz1), kinds in zip(((25, 27.5, -36, -32), (28.5, 31, -28, -24), (25, 27.5, -20, -16)),
                                           (('apple', 'orange', 'coconut'), ('fish',),
                                            ('tomato', 'broccoli', 'lettuce', 'eggplant', 'pumpkin'))):
        food_on(sx0, sx1, sz0, sz1, 1.1, kinds)
    # Furniture.
    furnish_north()
    # Metal floors: the Warehouse's catwalks.
    metal(41.5, -39.7, 43.7, -14.3, 4, 5)
    metal(31.3, -39.7, 41.5, -38, 4, 5)


FOOD_SIZE = {'apple': 0.18, 'orange': 0.18, 'tomato': 0.17, 'coconut': 0.2, 'broccoli': 0.2,
             'lettuce': 0.36, 'eggplant': 0.24, 'pumpkin': 0.44, 'bread': 0.3, 'fish': 0.3}  # (m, across)
PILED = ('apple', 'orange', 'tomato', 'coconut')  # round: heaped in layers


def food_on(x0, x1, z0, z1, top, kinds, mirrored=True):
    """Produce on a counter (visual only): the counter shared out along its
    length between the kinds, each a loose patch of a random size and spot
    in its share, at random turns; round fruit heaped up in layers (each
    one above resting on two below), the rest a single layer."""
    rng = random.Random(f'{x0},{z0},{top}')  # (the same every build)
    along_x = x1 - x0 >= z1 - z0
    lo, hi = (x0, x1) if along_x else (z0, z1)
    for k, kind in enumerate(kinds):
        s = FOOD_SIZE[kind]
        a0, a1 = lo + (hi - lo) * k / len(kinds), lo + (hi - lo) * (k + 1) / len(kinds)
        rx0, rx1, rz0, rz1 = (a0, a1, z0, z1) if along_x else (x0, x1, a0, a1)
        piled = kind in PILED
        m = 0.04 + s * 0.4  # (kept off the edges)
        hx, hz = max((rx1 - rx0) / 2 - m, s / 2), max((rz1 - rz0) / 2 - m, s / 2)
        lo_f = 0.55 if piled else 0.85  # (big produce: a single layer, so most of its share)
        fx, fz = rng.uniform(lo_f, lo_f + 0.3), rng.uniform(lo_f, lo_f + 0.3)  # the patch's size
        fx, fz = min(fx, 1), min(fz, 1)
        cx = (rx0 + rx1) / 2 + rng.uniform(-1, 1) * hx * (1 - fx)
        cz = (rz0 + rz1) / 2 + rng.uniform(-1, 1) * hz * (1 - fz)
        placed = []  # (x, z, layer)
        for layer in range(3 if piled else 1):
            shrink = 1 - 0.35 * layer
            below = [p for p in placed if p[2] == layer - 1]
            for _ in range(300):
                u, v = rng.uniform(-1, 1), rng.uniform(-1, 1)
                if piled and u * u + v * v > 1:  # (heaps round, the rest the patch's whole rectangle)
                    continue
                x, z = cx + u * hx * fx * shrink, cz + v * hz * fz * shrink
                if any((x - p[0]) ** 2 + (z - p[1]) ** 2 < ((0.9 if piled else 0.75) * s) ** 2 for p in placed if p[2] == layer):
                    continue
                if layer and sum((x - p[0]) ** 2 + (z - p[1]) ** 2 < (0.8 * s) ** 2 for p in below) < 2:
                    continue
                placed.append((x, z, layer))
                prop(kind, x, top + 0.72 * s * layer, z, rng.uniform(0, 360), collide=False, mirrored=mirrored)


def station_lounge():
    """Central Station (City Hall) 2nd floor: the staff lounge, all along the
    north wall (z -59.7 .. -54.8; City Hall: the south wall), so the south
    half and both stair heads (x -26.7 / 24.7 sides, z -53 .. -48) stay
    clear. Turns (prop's rot): 0 faces south, 180 north, 90 east, -90 west.
    Middle: a fireplace with a rug, a coffee table, a sofa facing it (its back
    to the room) and two armchairs, bookshelves and lamps either side. West:
    a sofa corner round a second coffee table. East: a pantry (counter,
    fridge) and two café tables."""
    y, wall = 3, -59.7
    small = dict(collide=False)
    # Fireplace lounge.
    prop('fireplace', -1, y, wall + 0.3, 0)
    prop('rug', -1, y, -56.9, 90, **small)
    prop('coffee_table', -1, y, -56.9)
    prop('sofa', -1, y, -55.3, 180)
    prop('armchair', -3.3, y, -56.9, 90)
    prop('armchair', 1.3, y, -56.9, -90)
    for x in (-5.4, 3.4):
        prop('bookshelf', x, y, wall + 0.25)
    for x in (-3.6, 1.6):
        prop('floor_lamp', x, y, -59.2, **small)
    for x in (-2.4, 0.4):
        prop('plant', x, y, -59.35, **small)
    # West: sofa corner.
    prop('sofa', -15, y, wall + 0.45, 0)
    prop('rug2', -15, y, -57.3, 90, **small)
    prop('coffee_table', -15, y, -57.3)
    for x in (-16.3, -13.7):
        prop('armchair', x, y, -55.6, 180)
    prop('floor_lamp', -17.3, y, -59.3, **small)
    prop('plant2', -12.6, y, -59.3, **small)
    prop('sideboard', -20.5, y, wall + 0.35)
    prop('plant', -22, y, -59.3, **small)
    prop('bookshelf', -9.5, y, wall + 0.25)
    # East: pantry and café tables.
    for i in range(4):
        prop('kitchen', 12.4 + 0.56 * i, y, wall + 0.32)
    prop('fridge', 14.95, y, wall + 0.38)
    prop('bin', 11.6, y, -59.3, **small)
    for x in (10.5, 15.5):
        prop('rug_round', x, y, -56.6, **small)
        prop('table', x, y, -56.6)
        prop('chair', x - 0.85, y, -56.6, 90, **small)
        prop('chair', x + 0.85, y, -56.6, -90, **small)
    # Between the lounge and the pantry: a second sofa by the wall.
    prop('sofa', 7.2, y, wall + 0.45, 0)
    prop('floor_lamp', 5.2, y, -59.3, **small)
    prop('plant2', 9.4, y, -59.3, **small)
    prop('plant', 18.8, y, -59.3, **small)


def south(key, x, y, z, rot=0, **kw):
    """A prop given in north-half coordinates, placed only at its south twin
    (for the south buildings' own furniture: the Hotel, the Police Station)."""
    prop(key, x, y, -z, 180 - rot, mirrored=False, **kw)


def north(key, x, y, z, rot=0, **kw):
    """A prop placed only in the north half (the Hospital's, the Bank's own)."""
    prop(key, x, y, z, rot, mirrored=False, **kw)


def hotel():
    """The Hotel's furniture, given in the Hospital's coordinates (x -27 ..
    -11, z -38 .. -16) and placed at the mirror (south()), so z -16 here is
    the Hotel's north side. Ground floor: the lobby, a reception desk by the canal-side
    entrance, a fireplace lounge and a second sofa group at the far end.
    Upper floors: a lounge at the far end; on the canal side two guest rooms
    (walls in north_half), each with a bed, rug, table, chair and shelf kept
    clear of the paths from its door to its windows."""
    small = dict(collide=False)
    # Ground floor. Reception: a long desk (two drawer units) facing the
    # lobby, a shelf and the clerk's chair behind it.
    for z in (-19.3, -21.6):
        south('drawers', -14, 0, z, 90)
    south('shelf', -11.55, 0, -20.5, -90)
    south('chair', -12.6, 0, -20.5, -90, **small)
    south('plant', -14, 0, -17.2, **small)
    for x in (-22.8, -18.2):  # either side of the canal-side entrance
        south('plant2', x, 0, -16.8, **small)
    # Fireplace lounge.
    south('fireplace', -26.4, 0, -33.5, 90)
    south('rug', -23.6, 0, -33.5, **small)
    south('coffee_table', -23.6, 0, -33.5)
    south('sofa', -21.6, 0, -33.5, -90)
    south('armchair', -23.6, 0, -35.6, 0)
    south('armchair', -23.6, 0, -31.4, 180)
    for z in (-35.8, -31.2):
        south('floor_lamp', -26.2, 0, z, **small)
    south('plant', -26.2, 0, -37.2, **small)
    # Second sofa group.
    south('sofa', -15.5, 0, -37.25, 0)
    south('rug2', -15.5, 0, -35.3, 90, **small)
    south('coffee_table', -15.5, 0, -35.3)
    south('armchair', -17.7, 0, -35.3, 90)
    south('armchair', -13.3, 0, -35.3, -90)
    south('floor_lamp', -17.6, 0, -37.3, **small)
    south('plant', -12, 0, -37.2, **small)
    for f in (3, 6, 9, 12):
        # Lounge at the far end (clear of the stairs' ends at z -26.8, the
        # windows and the 3rd floor's skybridge door in the east wall).
        south('sofa', -20, f, -37.25, 0)
        south('rug', -20, f, -35.2, 90, **small)
        south('coffee_table', -20, f, -35.2)
        south('armchair', -22.2, f, -35.2, 90)
        south('armchair', -17.8, f, -35.2, -90)
        for x in (-22.2, -17.8):
            south('floor_lamp', x, f, -37.3, **small)
        south('sideboard', -25, f, -37.35)
        south('bookshelf', -14.5, f, -37.45)
        south('plant', -26.2, f, -37.2, **small)
        south('plant2', -12.2, f, -37.2, **small)
        # West room (x -26.7 .. -19.2; door x -25 .. -23.6, windows in the
        # west wall and the canal wall at its west end: kept clear).
        south('bed', -20, f, -17.4, 0)
        south('bookshelf', -20.2, f, -20.05, 0)
        south('table', -22, f, -17.6)
        south('chair', -22, f, -18.45, 0, **small)
        south('rug2', -21.3, f, -18.3, 90, **small)
        # East room (x -18.9 .. -11.3; door x -15 .. -13.6, windows in the
        # canal wall at x -16 .. -14.4 and the east wall: kept clear).
        south('bed', -18.2, f, -17.4, 0)
        south('bookshelf', -17.6, f, -20.05, 0)
        south('table', -12.4, f, -17.4)
        south('chair', -13.3, f, -17.4, 90, **small)
        south('rug2', -15.2, f, -18.3, 90, **small)


def police():
    """The Police Station's furniture, given in the Bank's coordinates (x 11
    .. 25, z -38 .. -18) and placed at the mirror (south()). Ground floor: the front desk along the
    canal-side wall (officers' chairs and shelves behind it, monitors in
    north_half), waiting sofas against the walls clear of the doors and the
    stairs' foot, and an interview table with two chairs. Upper floors: the
    office (desks and partitions in office()); shelves along the walls."""
    small = dict(collide=False)
    # Front desk (three drawer units facing the room) and the officers' side.
    for x in (15.6, 17.88, 20.16):
        south('drawers', x, 0, -21.6)  # (its drawers toward the officers)
        south('chair2', x, 0, -20.75, 180, **small)
    for x in (14.5, 21.1):
        south('bookshelf', x, 0, -18.55, 180)
    south('sideboard', 17.8, 0, -18.65, 180)
    # Waiting area: sofas against the walls.
    south('sofa', 11.75, 0, -34.3, 90)
    south('sofa', 13.3, 0, -37.25, 0)
    south('sofa', 19.7, 0, -37.25, 0)
    south('sofa', 11.75, 0, -24.0, 90)
    south('sofa', 24.25, 0, -27.0, -90)
    south('coffee_table', 13.3, 0, -34.3)
    south('plant', 11.8, 0, -37.2, **small)
    south('plant2', 11.9, 0, -26.1, **small)
    south('plant', 24.2, 0, -29.2, **small)
    south('plant2', 24.1, 0, -19.0, **small)
    # Interview table.
    south('table', 18.5, 0, -32)
    south('chair', 17.65, 0, -32, 90, **small)
    south('chair', 19.35, 0, -32, -90, **small)
    for f in (3, 6):
        south('bookshelf', 13.2, f, -18.55, 180)
        south('drawers', 18.3, f, -18.7, 180)
        south('bookshelf', 23.3, f, -18.55, 180)
        south('bookshelf', 12.2, f, -37.45)
        south('plant2', 11.9, f, -18.9, **small)
        south('plant', 24.2, f, -21.2, **small)
        south('plant', 18.4, f, -37.2, **small)
        # Meeting table.
        south('table_long', 17.5, f, -21.3)
        for x in (17, 18):
            south('chair', x, f, -22.15, 0, **small)
            south('chair', x, f, -20.45, 180, **small)


def hospital():
    """The Hospital's own furniture (the Hotel's mirror plan: walls, doors,
    windows and stairs). Ground floor: reception by the canal-side entrance
    (monitors in north_half), a patients' waiting area of sofas. Upper
    floors: a ward of four curtained beds along the north wall and a
    nurses' desk; on the canal side two patient
    rooms (two beds and one), each with a sink and a visitor's chair, kept
    clear of the paths from their doors to their windows."""
    small = dict(collide=False)
    # Reception.
    for z in (-19.3, -21.6):
        north('drawers', -14, 0, z, 90)
    for z in (-19.9, -21.2):
        north('chair2', -12.6, 0, z, -90, **small)
    north('shelf', -11.55, 0, -20.5, -90)
    north('plant', -14, 0, -17.2, **small)
    for x in (-22.8, -18.2):  # either side of the canal-side entrance
        north('plant2', x, 0, -16.8, **small)
    # Patients' waiting area: sofas along the walls (clear of the west and
    # east doors and the stairs' foot) and two back-to-back in the middle.
    for x in (-24.6, -21.5, -16.5, -13.4):
        north('sofa', x, 0, -37.25, 0)
    for z in (-34.4, -31.3, -28.2):
        north('sofa', -26.25, 0, z, 90)
    for z in (-34.6, -31.7, -25.3):
        north('sofa', -11.75, 0, z, -90)
    for x in (-21.0, -17.6):
        north('sofa', x, 0, -33.6, 180)
        north('sofa', x, 0, -32.5, 0)
    north('plant', -19.0, 0, -37.3, **small)
    north('plant2', -26.3, 0, -37.3, **small)
    north('plant', -11.7, 0, -37.3, **small)
    north('bin', -26.3, 0, -26.2, **small)
    for f in (3, 6, 9, 12):
        # Ward: four beds along the north wall, curtains between the pairs.
        for x, ns in ((-25, -26.2), (-22.4, -21.2), (-16, -17.2), (-13.4, -12.2)):
            north('bed', x, f, -36.6, 180)
            north('nightstand', ns, f, -37.4)
        for x in (-23.7, -14.7):
            for z in (-37.2, -36.3):
                north('curtain', x, f, z, 90, **small)
        north('shelf', -19.0, f, -37.45)
        # Nurses' desk (clear of the west windows and the stairs' landing).
        north('drawers', -24.0, f, -30.2)
        north('chair2', -24.0, f, -29.3, 180, **small)
        north('plant', -26.2, f, -27.0, **small)
        # West patient room: two beds (clear of the door-to-window path at
        # x -25 .. -23.4), a sink by the west wall, a visitor's chair.
        for x in (-22.2, -20.2):
            north('bed', x, f, -17.4, 0)
        north('nightstand', -21.2, f, -16.6)
        north('sink', -26.45, f, -16.8, 90)
        north('chair2', -21.2, f, -19.4, 0, **small)
        # East patient room: one bed, a sink by the east wall, a chair.
        north('bed', -18.2, f, -17.4, 0)
        north('nightstand', -17.3, f, -16.6)
        north('sink', -11.55, f, -16.8, -90)
        north('chair2', -18.2, f, -19.4, 0, **small)


def bank():
    """The Bank's own furniture (the Police Station's mirror plan; the office
    cubicles upstairs and the counter's monitors are shared map geometry).
    Ground floor: the teller counter where the police desk is, tellers'
    chairs and filing behind it, benches against the walls, two writing
    tables in front of the queue and an advisor's table. Upper floors:
    filing, a client sofa corner between the canal-side windows, plants."""
    small = dict(collide=False)
    for x in (15.6, 17.88, 20.16):
        north('drawers', x, 0, -21.6)
        north('chair2', x, 0, -20.75, 180, **small)
    for x in (14.4, 21.2):
        north('sideboard', x, 0, -18.65, 180)
    north('plant2', 17.8, 0, -18.9, **small)
    north('couch2', 11.85, 0, -34.3, 90)
    north('couch2', 13.3, 0, -37.2, 0)
    north('couch2', 24.15, 0, -27.0, -90)
    for x in (15.0, 18.5):
        north('table', x, 0, -25.5)
    north('table', 18.5, 0, -32)
    north('chair', 17.65, 0, -32, 90, **small)
    north('chair', 19.35, 0, -32, -90, **small)
    north('plant', 11.8, 0, -37.2, **small)
    north('plant2', 11.9, 0, -26.1, **small)
    north('plant', 24.2, 0, -29.2, **small)
    north('bin', 24.2, 0, -19.0, **small)
    for f in (3, 6):
        north('drawers', 13.2, f, -18.7, 180)
        north('drawers', 23.3, f, -18.7, 180)
        north('couch', 18.3, f, -18.85, 180)
        north('coffee_table', 18.3, f, -20.4)
        north('armchair', 16.2, f, -20.4, 90)
        north('armchair', 20.4, f, -20.4, -90)
        north('bookshelf', 12.2, f, -37.45)
        north('plant2', 11.9, f, -18.9, **small)
        north('plant', 24.2, f, -21.2, **small)
        north('plant', 18.4, f, -37.2, **small)


def office(r, f):
    """The Bank's (Police Station's) upper floor at height f: pods of desks
    back to back across a partition, with dividers between the desks, a
    monitor and keyboard on each and a chair: three pods (14 seats), with
    wide aisles between them, to the windows, the stairs' landing and the
    skybridge door. Desks:
    1.4 m wide, 0.7 m deep; partitions 1.25 m high (1.1 between desks)."""
    W, D, t = 1.4, 0.7, 0.025
    for x0, n, cz in ((13.0, 3, -32.5), (13.0, 2, -25.6), (18.6, 2, -25.6)):
        x1 = x0 + n * W
        r.box(x0, x1, f, f + 1.25, cz - t, cz + t, 'Partition')
        for i in range(n + 1):
            xi = x0 + i * W
            r.box(xi - t, xi + t, f, f + (1.25 if i in (0, n) else 1.1), cz - D, cz + D, 'Partition')
        for i in range(n):
            xm = x0 + (i + 0.5) * W
            for s in (1, -1):  # the south side, then the north
                za, zb = sorted((cz + s * t, cz + s * D))
                r.box(x0 + i * W + t, x0 + (i + 1) * W - t, f + 0.72, f + 0.76, za, zb, 'Desk')
                za, zb = sorted((cz + s * 0.07, cz + s * 0.1))
                r.box(xm - 0.27, xm + 0.27, f + 0.86, f + 1.18, za, zb, 'Monitor', col=None)
                za, zb = sorted((cz + s * 0.06, cz + s * 0.12))
                r.box(xm - 0.03, xm + 0.03, f + 0.76, f + 0.86, za, zb, 'Monitor', col=None)
                za, zb = sorted((cz + s * 0.34, cz + s * 0.5))
                r.box(xm - 0.2, xm + 0.2, f + 0.76, f + 0.78, za, zb, 'Monitor', col=None)
                prop('chair2', xm, f, cz + s * 0.95, 180 if s > 0 else 0, collide=False)


def furnish_north():
    """Inside the buildings (mirrored into the south). Beds, tables, couches,
    shelves and counters are solid; chairs, plants, lamps and bins aren't
    (they'd only snag players)."""
    small = dict(collide=False)
    station_lounge()
    prop('bin2', -15, 0, -47, **small)
    prop('bin2', 12, 0, -47, **small)
    hotel()
    hospital()
    police()
    bank()
    # Streets: bins.
    prop('bin', -10.5, 0, -14, 90, **small)
    prop('bin', 10.5, 0, -40.5, **small)


def north_half(r):
    """Everything in the north half (mirrored into the south). r: a Recorder."""
    # Central Station (Blue base): 2 storeys, spawns upstairs, 4 exits.
    x0, x1, z0, z1 = -27, 25, -60, -46
    # 2nd floor windows (8 m wide): east, west, and south only within the
    # widths of the Hospital (x -27 .. -11) and the Bank (11 .. 25) in front,
    # so they block any line of fire to City Hall's twins.
    r.shell(x0, x1, z0, z1, 6, 'StationBlue', {
        'W': [door(-57, -54)] + windows([(-57, -49)], [3]), 'E': [door(-57, -54)] + windows([(-57, -49)], [3]),  # (E / W: the walls' middles)
        'S': [door(-20, -17), door(14, 17)] + windows([(-23, -15), (14, 22)], [3]),
    })
    west, east = (-26.7, -25.1), (23.1, 24.7)
    # Middle stairs: from a landing at the middle of the south wall, one
    # flight down to the west and one to the east (facing the exits).
    mid_z = (-47.9, -46.3)
    mid_w, mid_e = (-6.2, -1.4), (0.6, 5.4)
    r.slab(x0 + T, x1 - T, z0 + T, z1 - T, 3, 'Floor', [(*west, -52.8, -48), (*east, -52.8, -48), (*mid_w, *mid_z), (*mid_e, *mid_z)])
    r.flight(*mid_w, *mid_z, 0, 3, 'E')
    r.flight(*mid_e, *mid_z, 0, 3, 'W')
    for a, b in (mid_w, mid_e):
        r.rail(a, b, mid_z[0], mid_z[0], 3)
    r.rail(mid_w[0], mid_w[0], *mid_z, 3)
    r.rail(mid_e[1], mid_e[1], *mid_z, 3)
    r.slab(x0, x1, z0, z1, 6.25, 'StationBlue', [], thick=0.25)
    r.box(-10, 10, 6.25, 9.5, -58, -48, 'StationBlue')  # raised hall roof (silhouette)
    for lane in (west, east):
        r.flight(*lane, -52.8, -48, 0, 3, 'N')
        r.rail(lane[0] if lane is east else lane[1], lane[0] if lane is east else lane[1], -52.8, -48, 3)
        r.rail(*lane, -48, -48, 3)
    for x in (-12, -2, 8):  # ticket kiosks downstairs
        r.box(x, x + 3, 0, 1.1, -53, -51, 'Cover')

    # Hospital (Hotel): 5 storeys + roof (sniper perch over the canal).
    x0, x1, z0, z1 = -27, -11, -38, -16
    floors = [3, 6, 9, 12]
    r.shell(x0, x1, z0, z1, 15 + PARAPET, 'Hospital', {
        'W': [door(-24, -21)] + windows([(-35, -33.4), (-29, -27.4), (-19.6, -18)], floors),  # (the last: in the guest room)
        'E': [door(-30, -27), (-35, -32, 6, 8.4)] + windows([(-24, -22.4), (-20, -18.4)], floors),
        'S': [door(-22, -19)] + windows([(-16, -14.4), (-25, -23.4)], floors),
        'N': [(-14.6, -13.4, 15, 15 + PARAPET)],  # gap for the fire ladder
    })
    lane_a, lane_b = (-21.2, -19.6), (-19.4, -17.8)
    for k in range(5):  # flight k: floor 3k -> 3k + 3, alternating lanes
        lane = lane_a if k % 2 == 0 else lane_b
        r.flight(*lane, -26.8, -22, 3 * k, 3 * k + 3, 'N' if k % 2 == 0 else 'S')
    for j in range(1, 6):  # floor j (3j m) has a hole over flight j - 1
        lane = lane_a if (j - 1) % 2 == 0 else lane_b
        top = 3 * j
        if j < 5:
            r.slab(x0 + T, x1 - T, z0 + T, z1 - T, top, 'Floor', [(*lane, -26.8, -22)])
        else:
            r.slab(x0 + T, x1 - T, z0 + T, z1 - T, top, 'Hospital', [(*lane, -26.8, -22)])
        if lane is lane_a:
            r.rail(lane[0], lane[0], -26.8, -22, top)
            r.rail(*lane, -22, -22, top)
            if j == 5:
                r.rail(lane[1], lane[1], -26.8, -22, top)
        else:
            r.rail(lane[1], lane[1], -26.8, -22, top)
            r.rail(*lane, -26.8, -26.8, top)
    # Guest rooms on the canal side of each upper floor (z -20.3 .. -16.3),
    # off a corridor past the stairs' ends (z -22 .. -20.6).
    for f in floors:
        top = f + H - SLAB
        r.wall('x', -20.6, -20.3, x0 + T, x1 - T, f, top, 'Hospital', [door(-25, -23.6, f), door(-15, -13.6, f)])
        r.wall('z', -19.2, -18.9, -20.3, z1 - T, f, top, 'Hospital')
    for z in (-19.9, -21.2):  # the reception desk's monitors (facing the clerks; the Hotel's too)
        r.box(-14.15, -14.12, 0.97, 1.29, z - 0.27, z + 0.27, 'Monitor', col=None)
        r.box(-14.18, -14.12, 0.87, 0.97, z - 0.03, z + 0.03, 'Monitor', col=None)
    r.box(-25, -23.8, 15, 16.2, -30, -28.8, 'Cover')  # roof: AC units
    r.box(-15, -13.8, 15, 16.2, -25, -23.8, 'Cover')

    # Bank (Police Station): 3 storeys, roof reachable.
    x0, x1, z0, z1 = 11, 25, -38, -18
    floors = [3, 6]
    r.shell(x0, x1, z0, z1, 9 + PARAPET, 'Bank', {
        'W': [door(-30, -27), (-35, -32, 6, 8.4)] + windows([(-27, -25.4), (-23, -21.4)], floors) + windows([(-35, -33.4)], [3]),
        'E': [door(-24, -21)] + windows([(-32, -30.4), (-26, -24.4)], floors),
        'N': [door(15, 18)],
        'S': windows([(15, 16.6), (20, 21.6)], floors),
    })
    lane_a, lane_b = (21.4, 23.0), (23.1, 24.7)
    for k in range(3):
        lane = lane_a if k % 2 == 0 else lane_b
        r.flight(*lane, -34.8, -30, 3 * k, 3 * k + 3, 'N' if k % 2 == 0 else 'S')
    for j in range(1, 4):
        lane = lane_a if (j - 1) % 2 == 0 else lane_b
        top = 3 * j
        r.slab(x0 + T, x1 - T, z0 + T, z1 - T, top, 'Floor' if j < 3 else 'Bank', [(*lane, -34.8, -30)])
        if lane is lane_a:
            r.rail(lane[0], lane[0], -34.8, -30, top)
            r.rail(*lane, -30, -30, top)
            if j == 3:
                r.rail(lane[1], lane[1], -34.8, -30, top)
        else:
            r.rail(*lane, -34.8, -34.8, top)
    r.box(13, 14.2, 9, 10.2, -24, -22.8, 'Cover')
    for f in floors:
        office(r, f)
    for x in (15.6, 17.88, 20.16):  # the front desk's monitors (facing the officers)
        r.box(x - 0.27, x + 0.27, 0.97, 1.29, -21.75, -21.72, 'Monitor', col=None)
        r.box(x - 0.03, x + 0.03, 0.87, 0.97, -21.78, -21.72, 'Monitor', col=None)

    # Skybridge (3rd floor) between the Hospital and the Bank, over Main Street.
    r.slab(-11, 11, -35, -32, 6, 'Concrete')
    for zz in ((-35, -34.8), (-32.2, -32)):
        r.wall('x', *zz, -11, 11, 6, 8.6, 'Concrete', [(-9, -1, 6.8, 8.2), (1, 9, 6.8, 8.2)])
    r.box(-11, 11, 8.6, 8.85, -35, -32, 'Concrete')

    # Warehouse (Factory): a 9 m hall, catwalks at 4.5 m, a roof hatch.
    x0, x1, z0, z1 = 31, 44, -40, -14
    r.shell(x0, x1, z0, z1, 9 + PARAPET, 'Warehouse', floor='Concrete', openings={
        'W': [(-34, -30, 0, 4), door(-22, -19)],
        'N': [(35, 39, 0, 4)],
        'S': [(35, 39, 0, 3)],
    })
    r.slab(x0 + T, x1 - T, z0 + T, z1 - T, 9.25, 'Warehouse', [(41.8, 43.6, -37.2, -36.2)])
    r.slab(41.5, x1 - T, z0 + T, z1 - T, 4.5, 'Concrete')  # east catwalk
    r.slab(x0 + T, 41.5, z0 + T, -38, 4.5, 'Concrete')  # north catwalk
    r.flight(34.3, 41.5, -20, -18.4, 0, 4.5, 'E')
    r.rail(41.5, 41.5, -38, -20, 4.5)
    r.rail(41.5, 41.5, -18.4, z1 - T, 4.5)
    r.rail(x0 + T, 41.5, -38, -38, 4.5)
    for zz in (-37.2,):  # roof railing round the hatch (open on the ladder side)
        r.rail(41.8, 41.8, zz, -36.2, 9.25)
        r.rail(43.6, 43.6, zz, -36.2, 9.25)
        r.rail(41.8, 43.6, -36.2, -36.2, 9.25)
    r.box(32, 34.4, 0, 2.6, -37, -31, 'Cover')  # containers
    r.box(36, 38.4, 0, 2.6, -31, -25, 'Cover')
    r.box(36, 38.4, 2.6, 5.2, -31, -25, 'Cover')
    r.box(32, 38, 0, 2.6, -24.5, -22.1, 'Cover')

    # Market Alley stalls (counter + awning roof).
    for sx0, sx1, sz0, sz1 in ((25, 27.5, -36, -32), (28.5, 31, -28, -24), (25, 27.5, -20, -16)):
        r.box(sx0, sx1, 0, 1.1, sz0, sz1, 'Stall')
        west = sx0 < 26  # awnings reach 0.4 m over the alley
        xh, xl = (sx0, sx1 + 0.4) if west else (sx1, sx0 - 0.4)  # (from the wall out over the alley)
        for k in range(10):  # red and white stripes, sloping down toward the alley
            r.tilted(xh, xl, 2.95, 2.5, sz0 + 0.4 * k, sz0 + 0.4 * (k + 1), 0.12, ('AwningRed', 'AwningWhite')[k % 2])

    # Main Street: parked cars; North Avenue.
    props_north()

    # Canal: ramps out of it, barges.
    r.flight(-33.5, -31, -46, -42, -2.5, 0, 'N', 'Concrete')
    r.box(-33.5, -31, -2.8, 0, -48, -46, 'Concrete')
    r.flight(-40, -37.5, -18, -14, -2.5, 0, 'N', 'Concrete')
    r.box(-40, -37.5, -2.8, 0, -20, -18, 'Concrete')
    r.box(-38, -34, -2.5, -1.3, -29, -21, 'Cover')
    r.box(-37.5, -35.5, -1.3, 0.4, -27, -24, 'Cover')

    # Market Hall's north half is symmetric with its south half: built below.

    # Construction: the north flight of each storey (mirrored).
    r.flight(16.2, 21, -7.6, -6.0, 0, 3, 'W')
    r.flight(13, 17.8, -4.0, -2.4, 3, 6, 'E')
    r.rail(16.2, 21, -7.6, -7.6, 3)
    r.rail(21, 21, -7.6, -6.0, 3)
    r.rail(16.2, 21, -6.0, -6.0, 3)
    r.rail(13, 17.8, -4.0, -4.0, 6)
    r.rail(13, 17.8, -2.4, -2.4, 6)
    r.rail(13, 13, -4.0, -2.4, 6)
    r.box(12, 15, 3, 4, -10, -9.7, 'Concrete')  # low walls on the slab edges
    r.box(11, 11.3, 6, 7, -8, -5, 'Concrete')

    # Plaza: subway stairs (north), benches.
    r.flight(4.5, 7.5, -11, -3.8, -4.5, 0, 'N', 'Subway')
    for xx in (4.2, 7.5):
        r.box(xx, xx + 0.3, -4.8, -0.3, -11, -4, 'Subway')
    r.rail(4.5, 4.5, -11, -4, 0)
    r.rail(7.5, 7.5, -11, -4, 0)
    r.rail(4.5, 7.5, -4, -4, 0)
    r.box(-9, -6, 0, 0.5, -9.4, -8.8, 'Cover')

    # Spawns (2nd floor of the base), pickups, ladders.
    # Turned 45° towards the more open diagonal (the middle two: towards the
    # centre), so you see down the hall instead of the wall in front.
    d = math.pi / 4
    for x, z, turn in ((-14, -51.5, -d), (-5, -51.5, d), (4, -51.5, -d), (13, -51.5, d), (-20, -49.5, d), (18, -49.5, -d)):  # (south of the lounge)
        spawn(x, 3, z, turn)
    pickup('weapon', -14.5, 0, -29.5)  # Hospital (Hotel) ground floor
    pickup('weapon', 18, 9, -28)  # Bank roof
    pickup('heal', 42.6, 4.5, -27)  # Warehouse catwalk
    pickup('heal', -24, 0, -20)  # Hospital lobby
    ladder(-14, -38, 0, -1, 0, 15)  # Hospital fire ladder (north wall, to the roof)
    ladder(42.7, -37.2, 0, 1, 4.5, 9.25, backing=True, half=0.3)  # Warehouse roof hatch

    # Callout zones (north name, south name).
    zone('hospital', -27, -38, -11, -16, 'hotel', floors=0, roof=15)
    zone('bank', 11, -38, 25, -18, 'police', floors=0, roof=9)
    zone('warehouse', 31, -40, 44, -14, 'factory', floors=None, roof=9.25)
    zone('station', -27, -60, 25, -46, 'cityHall', floors=0, roof=6.25)
    zone('skybridge', -11, -35, 11, -32, 'skybridge', y=[5, 10])
    zone('marketAlley', 25, -46, 31, -10, 'marketAlley')
    zone('northAve', -44, -46, 44, -38, 'southAve')
    zone('mainStreet', -11, -38, 11, -12, 'mainStreet')
    zone('canal', -44, -60, -27, -4, 'canal')
    zone('northAve', -44, -60, 44, -46, 'southAve')  # (beside the base)
    zone('bridgeStreet', -31, -16, -11, -4, 'bridgeStreet')
    zone('marketAlley', 11, -18, 31, -10, 'marketAlley')  # (the cross street to the alley)
    zone('subway', 4.2, -11, 7.8, -4, 'subway', y=[-6, -0.5])  # plaza stairs


def centre_row():
    """The unique centre (symmetric across z = 0 by construction)."""
    # Clock Tower: ladder inside to the 14 m balcony, ladder outside to the top.
    s = 2.5
    shell(-s, s, -s, s, 20 + PARAPET, 'Tower', {
        'N': [door(-0.8, 0.8), (-0.8, 0.8, 14, 16.4)],
        'S': [door(-0.8, 0.8), (-0.8, 0.8, 14, 16.4)],
        'W': [(-0.8, 0.8, 14, 16.4)],
        'E': [(-0.6, 0.6, 20, 20 + PARAPET)],
    })
    slab(-s + T, s - T, -s + T, s - T, 14, 'Tower', [(-s + T, -0.6, -0.7, 0.7)])
    slab(-s + T, s - T, -s + T, s - T, 20, 'Tower')
    slab(-3.7, 3.7, -3.7, 3.7, 14, 'Tower', [(-s, s, -s, s)], thick=0.3)  # balcony
    for a, b, c, d in ((-3.7, 3.7, -3.7, -3.55), (-3.7, 3.7, 3.55, 3.7), (-3.7, -3.55, -3.55, 3.55), (3.55, 3.7, -3.55, 3.55)):
        box(a, b, 14, 14 + PARAPET, c, d, 'Tower')
    rail(-s + T, -0.6, -0.7, -0.7, 14)
    rail(-s + T, -0.6, 0.7, 0.7, 14)
    rail(-0.6, -0.6, -0.7, 0.7, 14)  # (the hole's open side: the ladder is on the wall)
    for a, b, c, d in ((-1.2, 1.2, -2.6, -2.5), (-1.2, 1.2, 2.5, 2.6), (-2.6, -2.5, -1.2, 1.2)):
        box(a, b, 16.8, 19.2, c, d, 'Clock', None)  # clock faces
    for c, n in (((0, 18, -2.6), (0, -1)), ((0, 18, 2.6), (0, 1)), ((-2.6, 18, 0), (-1, 0))):
        clock(c, n)
    signs()
    # Up the west wall to the balcony: at the top, on through the opening above it.
    ladder(-s + T, 0, 1, 0, 0, 14, mirrored=False)
    ladder(s, 0, 1, 0, 14, 20, mirrored=False)

    # Plaza: fountain, then its south half.
    oct_pts = [(-6 + 2.2 * math.cos(a), 2.2 * math.sin(a)) for a in (i * math.pi / 4 + math.pi / 8 for i in range(8))]
    prism(oct_pts, 0, 0.9, 'Plaza')

    # Subway: the entrance building, the concourse under the plaza, the
    # stairs up into Construction. The building reaches 2 m west of the
    # stairs' head, so the side doors lead round the stairs' low walls to it.
    shell(-26, -14, -6, 6, 4, 'Subway', floor=None, openings={  # (its floor is the ground, with the stairs' hole)
        'W': [door(-1.5, 1.5)], 'E': [door(-1.5, 1.5)],
        'N': [door(-20, -17)], 'S': [door(-20, -17)],
    })
    slab(-26, -14, -6, 6, 4.3, 'Subway', thick=0.3)
    flight(-23.5, -16.3, -1.5, 1.5, -4.5, 0, 'W', 'Subway')
    rail(-23.5, -16.3, -1.5, -1.5, 0)
    rail(-23.5, -16.3, 1.5, 1.5, 0)
    rail(-16.3, -16.3, -1.5, 1.5, 0)
    slab(-24, 12, -4, 4, -4.5, 'Subway', thick=0.3)
    wall('x', -4.3, -4.0, -24.3, 12.3, -4.8, -0.3, 'Subway', [(4.5, 7.5, -4.8, -0.3)])
    wall('x', 4.0, 4.3, -24.3, 12.3, -4.8, -0.3, 'Subway', [(4.5, 7.5, -4.8, -0.3)])
    wall('z', -24.3, -24.0, -4.0, 4.0, -4.8, -0.3, 'Subway')
    wall('z', 12.0, 12.3, -4.0, 4.0, -4.8, -0.3, 'Subway', [(-1.5, 1.5, -4.8, -0.3)])
    for x in (-10, -4, 2, 8):
        box(x - 0.3, x + 0.3, -4.5, -0.3, -0.3, 0.3, 'Subway')
    flight(12, 19.2, -1.5, 1.5, -4.5, 0, 'E', 'Subway')
    for zz in ((-1.8, -1.5), (1.5, 1.8)):
        box(12, 19.2, -4.8, -0.3, *zz, 'Subway')
    rail(12, 19.2, -1.5, -1.5, 0)
    rail(12, 19.2, 1.5, 1.5, 0)
    rail(12, 12, -1.5, 1.5, 0)

    # Construction: open concrete frame, floors at 3 and 6, the crane.
    for x in (11.25, 15.9, 20.5, 24.75):
        for z in (-9.75, -4.5, 4.5, 9.75):
            box(x - 0.25, x + 0.25, 0, 9, z - 0.25, z + 0.25, 'Concrete')
    slab(11, 25, -10, 10, 3, 'Concrete', [(16.2, 21, -7.6, -6.0), (16.2, 21, 6.0, 7.6)])
    slab(11, 25, -10, 10, 6, 'Concrete', [(13, 17.8, -4.0, -2.4), (13, 17.8, 2.4, 4.0)])
    box(22, 24, 0, 18, -1, 1, 'Crane')  # mast
    slab(20, 24, -2.5, 2.5, 18, 'Crane')  # cab deck
    rail(20, 24, -2.5, -2.5, 18)
    rail(20, 24, 2.5, 2.5, 18)
    rail(20, 20, -2.5, 2.5, 18)
    rail(24, 24, -2.5, -0.5, 18)
    rail(24, 24, 0.5, 2.5, 18)
    # The neck up to the mast top: a lattice (corner posts, X braces on its
    # z sides), open toward the ladder and the far side, in line with the
    # ladder's landing, so the way onto the deck stays clear (0.96 m between
    # the posts, 2 m under the top). The braced sides: players only.
    for x in (22.46, 23.54):
        for z in (-0.54, 0.54):
            box(x - 0.06, x + 0.06, 18, 20, z - 0.06, z + 0.06, 'Crane')
        box(x - 0.06, x + 0.06, 19.88, 20, -0.48, 0.48, 'Crane')  # (above head height)
    brace = math.atan2(1.08, 2.0)
    for side in (1, -1):
        for k, angle in enumerate((brace, -brace)):
            d = (0, 0.08) if k else (-0.08, 0)  # (side by side where they cross: no overlap)
            face_bar((23.0, 19.0, 0.54 * side), (0, side), angle, -1.14, 1.14, 0.08, *d, 'Crane')
        box(22.4, 23.6, 18, 20, *sorted((0.48 * side, 0.6 * side)), None, 'player')
    box(22.4, 23.6, 20, 21.5, -0.6, 0.6, 'Crane')  # mast top
    box(4, 23, 20.2, 21, -0.4, 0.4, 'Crane')  # jib
    box(23, 29, 20.2, 21, -0.4, 0.4, 'Crane')  # counter-jib
    box(27, 29, 19, 20.2, -1, 1, 'Concrete')  # counterweight
    ladder(24, 0, 1, 0, 6, 18, mirrored=False)

    # Market Hall: 2 storeys, symmetric.
    x0, x1, z0, z1 = 31, 44, -10, 10
    shell(x0, x1, z0, z1, 6, 'Market', {
        'W': [door(-1.5, 1.5)] + windows([(-7, -5.4), (5.4, 7)], [3]),
        'N': [door(35, 38)] + windows([(39, 40.6)], [3]),
        'S': [door(35, 38)] + windows([(39, 40.6)], [3]),
    })
    slab(x0 + T, x1 - T, z0 + T, z1 - T, 3, 'Floor', [(41.9, 43.5, -5.8, -1), (41.9, 43.5, 1, 5.8)])
    slab(x0, x1, z0, z1, 6.25, 'Market')
    flight(41.9, 43.5, -5.8, -1, 0, 3, 'N')
    flight(41.9, 43.5, 1, 5.8, 0, 3, 'S')
    for zz in ((-5.8, -1), (1, 5.8)):
        rail(41.9, 41.9, *zz, 3)
    rail(41.9, 43.5, -1, -1, 3)
    rail(41.9, 43.5, 1, 1, 3)
    for z in (-6, 4.8):
        box(33, 37, 0, 1.0, z, z + 1.2, 'Stall')
        box(35, 38, 3, 4.0, z, z + 1.2, 'Stall')
        # (each counter its own: the hall is built whole, not mirrored)
        food_on(33, 37, z, z + 1.2, 1.0, ('pumpkin', 'lettuce', 'eggplant') if z < 0 else ('bread',), mirrored=False)
        food_on(35, 38, z, z + 1.2, 4.0, ('apple', 'orange', 'tomato') if z < 0 else ('fish',), mirrored=False)
    # More stalls (x0, x1, z0, z1, floor, produce), clear of the doors, the
    # stairs, the windows and the café: ground floor along the north and
    # south walls west of the doors, either side of the aisle from the west
    # door, and by the stairs; upstairs either side of the middle, by the
    # stair heads and along the north and south walls.
    for sx0, sx1, sz0, sz1, f, kinds in (
            (31.6, 34.2, -9.6, -8.6, 0, ('coconut', 'orange')), (31.6, 34.2, 8.6, 9.6, 0, ('fish',)),
            (33.5, 36.5, -2.4, -1.4, 0, ('broccoli', 'tomato')), (33.5, 36.5, 1.4, 2.4, 0, ('apple', 'orange')),
            (38.8, 40.8, -6, -4.8, 0, ('bread',)), (38.8, 40.8, 4.8, 6, 0, ('lettuce', 'eggplant')),
            (33, 35.5, -2.4, -1.4, 3, ('pumpkin',)), (33, 35.5, 1.4, 2.4, 3, ('apple', 'coconut')),
            (38.6, 40.6, -2.4, -1.4, 3, ('broccoli', 'lettuce', 'tomato')), (38.6, 40.6, 1.4, 2.4, 3, ('bread',)),
            (35.2, 38.2, -9.6, -8.6, 3, ('fish',)), (35.2, 38.2, 8.6, 9.6, 3, ('orange', 'tomato'))):
        box(sx0, sx1, f, f + 1.0, sz0, sz1, 'Stall')
        food_on(sx0, sx1, sz0, sz1, f + 1.0, kinds, mirrored=False)
    for z in (-8.5, 8.5):  # a café upstairs
        prop('table', 33.5, 3, z, mirrored=False)
        prop('chair', 33.5, 3, z - 0.75, 0, collide=False, mirrored=False)
        prop('chair', 33.5, 3, z + 0.75, 180, collide=False, mirrored=False)

    # Bridge over the canal, with low walls.
    box(-40, -31, -0.4, 0, -4, 4, 'Concrete')
    box(-40, -31, 0, 1.0, -4, -3.8, 'Concrete')
    box(-40, -31, 0, 1.0, 3.8, 4, 'Concrete')

    pickup('weapon', -35.5, -2.5, 0, mirrored=False)  # under the canal bridge
    pickup('weapon', -1, -4.5, 0, mirrored=False)  # subway
    pickup('weapon', 37.5, 3, 0, mirrored=False)  # Market Hall 2F
    pickup('weapon', 16, 6, 0, mirrored=False)  # Construction 3F
    pickup('heal', -14.5, -4.5, 0, mirrored=False)  # subway
    pickup('heal', 40, 0, 0, mirrored=False)  # Market Hall
    pickup('money', -1, 20, 0, mirrored=False)  # Clock Tower top
    pickup('money', 21, 18, 0, mirrored=False)  # crane cab
    pickup('money', -7, -4.5, 2.5, mirrored=False)  # subway concourse (between the pillars)
    pickup('money', -20, 4.3, 0, mirrored=False)  # Subway entrance roof
    pickup('money', -6, 0.9, 0, mirrored=False)  # on the fountain
    pickup('money', 6, 0, 0, mirrored=False)  # plaza, between the subway stairs

    metal(20, -2.5, 24, 2.5, 17.5, 18.6, mirrored=False)  # the crane's cab deck

    zone('clockTower', -3.7, -3.7, 3.7, 3.7)
    zone('crane', 19.5, -2.6, 25, 2.6, y=[6.5, 30])
    zone('construction', 11, -10, 25, 10)
    zone('marketHall', 31, -10, 44, 10, floors=0, roof=6.25)
    zone('subway', -26, -6, -14, 6)
    zone('subway', -24.3, -4.3, 19.2, 4.3, y=[-6, -0.5])  # concourse
    zone('plaza', -11, -12, 11, 12)
    zone('canalBridge', -40, -4, -31, 4)
    zone('bridgeStreet', -31, -4, -11, 4)
    zone('marketAlley', 25, -10, 31, 10)


def solid(faces, mats, col='main'):
    """A convex solid from faces (wound outwards here), each faces[i] in
    mats[i]'s mesh (or mats: one for all)."""
    faces = orient(faces)
    for i, f in enumerate(faces):
        VIS.setdefault(mats if isinstance(mats, str) else mats[i], []).append(f)
    if col == 'main':
        COL.extend(faces)


def blimp(cx, cy, cz, yaw, text, mat):
    """An advertising blimp: an ellipsoid 15 m long, its nose at -x turned
    yaw degrees about up (+: x toward -z), the ad's text along both sides'
    middles (each letter flat on the hull there), tail fins at +x (text and
    fins in mat), a gondola below. Solid, and its top can be stood on."""
    L, W, H = 7.5, 2.5, 2.4  # half-length, half-width, half-height
    c, s_ = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    T = lambda x, y, z: (cx + x * c + z * s_, cy + y, cz - x * s_ + z * c)  # local -> game
    section = [(math.cos(math.radians(a)), math.sin(math.radians(a))) for a in range(0, 360, 15)]  # (z, y) on a unit circle
    rings = [(L * math.sin(math.radians(t)), math.cos(math.radians(t))) for t in range(-90, 91, 10)]  # (x, scale)
    k = len(section)
    faces = []
    for (xa, sa), (xb, sb) in zip(rings, rings[1:]):
        a = [T(xa, H * y * sa, W * z * sa) for z, y in section]
        b = [T(xb, H * y * sb, W * z * sb) for z, y in section]
        for j in range(k):
            if sa < 1e-6:
                faces.append([a[j], b[(j + 1) % k], b[j]])
            elif sb < 1e-6:
                faces.append([a[j], a[(j + 1) % k], b[j]])
            else:
                faces.append([a[j], a[(j + 1) % k], b[(j + 1) % k], b[j]])
    solid(faces, 'Blimp')
    # The ad: letters along the equator, read left to right from either side.
    h, w, gap = 1.1, 0.7, 0.25
    left = -(len(text) * w + (len(text) - 1) * gap) / 2 + w / 2
    for side in (1, -1):
        for i, ch in enumerate(text):
            x = side * (left + i * (w + gap))  # (+z side: +x is the viewer's right)
            z = side * W * math.sqrt(1 - (x / L) ** 2)
            nx, nz = x / L ** 2, z / W ** 2
            nl = math.hypot(nx, nz)
            p, q = T(x, 0, z), T(nx / nl, 0, nz / nl)
            sign_text(p, (q[0] - cx, q[2] - cz), ch, h, w, 0, 0.22, mat, d=(0.1, 0.2))

    def part(x0, x1, y0, y1, z0, z1, mat):
        solid([[T(*v) for v in f] for f in box_faces(x0, x1, y0, y1, z0, z1)], mat)
    part(5.4, 7.6, 0.9, 2.5, -0.07, 0.07, mat)  # tail fins
    part(5.4, 7.6, -2.5, -0.9, -0.07, 0.07, mat)
    part(5.4, 7.6, -0.07, 0.07, 0.9, 2.5, mat)
    part(5.4, 7.6, -0.07, 0.07, -2.5, -0.9, mat)
    part(-1.4, 1.4, -H - 0.75, -H + 0.25, -0.65, 0.65, 'Rail')  # gondola


def hot_air_balloon(cx, cy, cz, colours):
    """A hot-air balloon: the envelope's centre at (cx, cy, cz), gores in
    the two colours, a flat crown to stand on; below it a basket (floor at
    cy - 8.6) with walls to crouch behind, hung on ropes, and the burner."""
    R, N = 3.6, 16
    profile = [(R * math.sin(math.radians(p)), cy + R * math.cos(math.radians(p))) for p in range(15, 116, 10)]
    profile.append((1.0, cy - R * 1.55))  # the throat
    pt = lambda r, y, j: (cx + r * math.cos(2 * math.pi * j / N), y, cz + r * math.sin(2 * math.pi * j / N))
    faces, mats = [], []
    for (ra, ya), (rb, yb) in zip(profile, profile[1:]):
        for j in range(N):
            faces.append([pt(ra, ya, j), pt(ra, ya, j + 1), pt(rb, yb, j + 1), pt(rb, yb, j)])
            mats.append(colours[j % 2])
    for r, y in (profile[0], profile[-1]):  # crown, throat
        faces.append([pt(r, y, j) for j in range(N)])
        mats.append(colours[0])
    solid(faces, mats)
    floor = cy - 8.6
    half, t = 0.85, 0.1
    box(cx - half, cx + half, floor - 0.15, floor, cz - half, cz + half, 'Basket')
    for x0, x1, z0, z1 in ((-half, half, -half, -half + t), (-half, half, half - t, half), (-half, -half + t, -half + t, half - t), (half - t, half, -half + t, half - t)):
        box(cx + x0, cx + x1, floor, floor + 1.1, cz + z0, cz + z1, 'Basket')
    for sx in (-0.75, 0.75):
        for sz in (-0.75, 0.75):
            box(cx + sx - 0.03, cx + sx + 0.03, floor + 1.1, profile[-1][1], cz + sz - 0.03, cz + sz + 0.03, 'Rail', None)
    box(cx - 0.3, cx + 0.3, floor + 2.1, floor + 2.6, cz - 0.3, cz + 0.3, 'Rail', None)  # burner


def balloons():
    """Cover in the sky for fly-hack players (up to 25 m), one of each per
    half: an ad blimp high over Market Alley where the cross street meets it
    (the construction site's ends), turned a little so the two aren't side
    to side (Blue's: HACK SOJU in blue, Red's: HACK COLA in red), and a
    hot-air balloon by the canal at the planters on Bridge Street, in the
    half's team colour, its crown at 24 m (standing room under the 25 m fly
    ceiling). Solid; their tops can be stood on."""
    for side, colours, ad, mat in ((1, ('BalloonBlue', 'BalloonWhite'), 'HACK SOJU', 'SignBlue'), (-1, ('BalloonRed', 'BalloonWhite'), 'HACK COLA', 'SignRed')):
        blimp(28, 20, -14 * side, 18 * side, ad, mat)
        hot_air_balloon(-30.5, 20.5, -11.5 * side, colours)


def ground():
    x0, z0, x1, z1 = BOUNDS
    stairs = [(4.5, 7.5, -11, -4), (4.5, 7.5, 4, 11)]  # plaza subway stairs
    holes = [(-40, -31, z0, z1),  # canal
             (-11, 11, -12, 12),  # plaza (below)
             (-23.5, -16.3, -1.5, 1.5), (12, 19.2, -1.5, 1.5)]  # subway building, construction
    for a, b, c, d in rect_minus(x0, x1, z0, z1, holes):
        box(a, b, -0.3, 0, c, d, 'Ground')
    for a, b, c, d in rect_minus(-11, 11, -12, 12, stairs):
        box(a, b, -0.3, 0, c, d, 'Plaza')
    # Canal bed and walls, end walls.
    box(-40, -31, -2.8, -2.5, z0, z1, 'Canal')
    box(-40.5, -40, -2.8, -0.3, z0, z1, 'Canal')
    box(-31, -30.5, -2.8, -0.3, z0, z1, 'Canal')
    # Boundary: blocks of facades round the edge (solid, taller than a jump).
    for a, b, c, d, h in ((-48, 48, -64, -60, 12), (-48, 48, 60, 64, 12), (-48, -44, -60, 60, 10), (44, 48, -60, 60, 10)):
        box(a, b, -0.3, h, c, d, 'Boundary')
        box(a, b, h, 80, c, d, None, 'player')  # (invisible, players only: nobody stands on its top edge)


# ---- textures, materials ------------------------------------------------------

def save_image(image, path):
    image.filepath_raw = path
    image.file_format = 'PNG'
    image.save()
    return image


def texture(key):
    """maps/textures/<key>.png, made the first time (see TEXTURES)."""
    path = os.path.join(TEX_DIR, key + '.png')
    if os.path.exists(path):
        return bpy.data.images.load(path, check_existing=True)
    os.makedirs(TEX_DIR, exist_ok=True)
    if key == 'grid':  # 1 m lines, stronger every 2 m (one tile)
        size = 256
        v = np.ones((size, size), np.float32) * 0.86
        for k in (0, size // 2):
            v[k:k + 2, :] = v[:, k:k + 2] = 0.62
        v[0:3, :] = v[:, 0:3] = 0.5
    elif key == 'corrugated':  # ridges every 25 cm, a seam between sheets
        size = 512
        x = np.arange(size) / size
        ridge = 0.74 + 0.16 * np.sin(2 * np.pi * 8 * x) + 0.04 * np.sin(2 * np.pi * 16 * x)
        v = np.tile(ridge, (size, 1)).astype(np.float32)
        v *= 0.97 + 0.03 * np.random.default_rng(3).random((size, size)).astype(np.float32)
        v[0:4, :] *= 0.7
    else:
        src, grey = TEXTURES[key]
        image = bpy.data.images.load(os.path.join(RES, src))
        if image.size[0] > 1024:
            image.scale(1024, 1024)
        if key == 'wood':  # the trim sheet's top band (rows 0 .. 29%: light planks), 4 times over
            w, h = image.size
            px = np.array(image.pixels[:], np.float32).reshape(h, w, 4)  # (bottom row first)
            band = px[h - int(h * 0.29):]
            band = np.tile(band[np.linspace(0, len(band) - 1, h // 4).astype(int)], (4, 1, 1))
            image.pixels.foreach_set(np.ascontiguousarray(band).ravel())
            return save_image(image, path)
        if grey:  # luminance, evened out to a light grey so tints show true
            w, h = image.size
            px = np.array(image.pixels[:], np.float32).reshape(h, w, 4)
            lum = px[..., 0] * 0.3 + px[..., 1] * 0.59 + px[..., 2] * 0.11
            lum = np.clip(lum * (0.78 / lum.mean()), 0, 1)
            px[..., 0] = px[..., 1] = px[..., 2] = lum
            image.pixels.foreach_set(px.ravel())
        return save_image(image, path)
    image = bpy.data.images.new(key, size, size, alpha=False)
    px = np.ones((size, size, 4), np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = v
    image.pixels.foreach_set(px.ravel())
    return save_image(image, path)


def material(name):
    tex_key, _, rgb = SURFACES[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.9
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = texture(tex_key)
    mix = nodes.new('ShaderNodeMix')  # texture x tint: the glTF exporter writes the tint as baseColorFactor
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]  # (tints are sRGB)
    mix.inputs[7].default_value = (*lin, 1)
    links.new(tex.outputs['Color'], mix.inputs[6])
    links.new(mix.outputs[2], bsdf.inputs['Base Color'])
    return mat


# ---- props --------------------------------------------------------------------------

LIB = {}  # key -> hidden library object (its mesh is shared by every copy placed)
NOT_BASE_COLOUR = ('_Normal', '_ORM', '_Roughness', '_Emissive', '_DetailMask', '_Metallic', '_Occlusion')  # (name endings)


def dedupe(datablocks):
    """Name.001 copies (each import brings its own) replaced by the original."""
    for d in list(datablocks):
        base = d.name.rsplit('.', 1)[0]
        if base != d.name and d.name.rsplit('.', 1)[1].isdigit() and base in datablocks:
            d.user_remap(datablocks[base])
            datablocks.remove(d)


def load_prop(key):
    if key in LIB:
        return LIB[key]
    path = os.path.join(RES, PROPS[key][0])
    before = set(bpy.data.objects)
    if path.endswith('.obj'):
        bpy.ops.wm.obj_import(filepath=path)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:  # into one mesh, in world space
        o.data = o.data.copy()
        o.data.transform(o.matrix_world)
    for o in meshes:
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    for o in bpy.data.objects:  # (the join removed the other meshes; the rest: empties)
        if o not in before and o != obj:
            bpy.data.objects.remove(o, do_unlink=True)
    lift, scale = PROPS[key][1], PROPS[key][2] if len(PROPS[key]) > 2 else 1
    obj.data.transform(Matrix.Scale(scale, 4))
    if 'Food' in PROPS[key][0]:  # small on screen: a third of the triangles is plenty
        mod = obj.modifiers.new('Decimate', 'DECIMATE')
        mod.ratio = 0.33
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if len(PROPS[key]) > 3:
        retexture(obj, PROPS[key][3])
    if lift is None:
        lift = -min(v.co.z for v in obj.data.vertices)
    obj.data.transform(Matrix.Translation((0, 0, lift)))
    obj.name = f'LIB_{key}'
    obj.hide_render = True
    obj.hide_set(True)
    xs, ys, zs = zip(*(v.co for v in obj.data.vertices))
    obj['bounds'] = [min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)]
    if 'Car Pack' in PROPS[key][0]:
        obj['profile'] = car_profile(obj)
    LIB[key] = obj
    return obj


CAR_SLICES = 20


def car_profile(obj):
    """A car's height along its length (Blender y): the highest point at
    each of CAR_SLICES + 1 evenly spaced cuts (at a cut, the higher of the
    two slices either side), so straight lines between them stay on or
    above the body."""
    _, y0, _, _, y1, _ = obj['bounds']
    top = [0.0] * CAR_SLICES
    for v in obj.data.vertices:
        k = min(CAR_SLICES - 1, int((v.co.y - y0) / (y1 - y0) * CAR_SLICES))
        top[k] = max(top[k], v.co.z)
    return [top[0]] + [max(a, b) for a, b in zip(top, top[1:])] + [top[-1]]


def retexture(obj, surface):
    """One SURFACES material over the whole model, its texture projected
    onto each face from the axis the face looks along (a tile per metres
    per tile, like the map's)."""
    tile = SURFACES[surface][1]
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new()
    uv = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        n = [abs(c) for c in poly.normal]
        a, b = ((1, 2), (0, 2), (0, 1))[n.index(max(n))]  # the two other axes
        for li in poly.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            uv[li].uv = (co[a] / tile, co[b] / tile)
    mat = PROP_MATS.get(surface) or PROP_MATS.setdefault(surface, material(surface))
    mesh.materials.clear()
    mesh.materials.append(mat)


PROP_MATS = {}  # SURFACES name -> material made for retextured props


def tidy_prop_textures():
    """Props keep only their base colour textures (the game draws the map
    unlit with baked light), at most 1024 px, saved to maps/textures/props."""
    dedupe(bpy.data.images)
    dedupe(bpy.data.materials)
    for mat in bpy.data.materials:
        if not mat.node_tree:
            continue
        for node in list(mat.node_tree.nodes):
            if node.bl_idname == 'ShaderNodeTexImage' and node.image and os.path.splitext(node.image.name)[0].endswith(NOT_BASE_COLOUR):
                mat.node_tree.nodes.remove(node)
    folder = os.path.join(TEX_DIR, 'props')
    os.makedirs(folder, exist_ok=True)
    found = {}  # (some packs' models look for their textures next to them; they're in the pack's Textures/)
    for folder_, _, files in os.walk(RES):
        for f in files:
            found.setdefault(f, os.path.join(folder_, f))
    for image in list(bpy.data.images):
        if image.users == 0:
            bpy.data.images.remove(image)
        elif not bpy.path.abspath(image.filepath).startswith(TEX_DIR) or image.packed_file:
            if not image.has_data:
                image.filepath = found[os.path.basename(image.filepath)]
                image.reload()
            if max(image.size) > 1024:
                image.scale(1024, 1024)
            save_image(image, os.path.join(folder, os.path.splitext(image.name)[0] + '.png'))
            if image.packed_file:  # (the glTF importer packs them into the .blend)
                image.unpack(method='REMOVE')


def palette_flat_materials():
    """Props' plain-coloured materials (the cars have ~15) become cells of one
    small palette texture, so they draw as one material (one draw call)."""
    flat = {}
    for lib in LIB.values():
        for m in lib.data.materials:
            if m and m.node_tree and not any(n.bl_idname == 'ShaderNodeTexImage' for n in m.node_tree.nodes) and m.name not in SURFACES:
                flat[m.name] = m
    if not flat:
        return
    names = sorted(flat)
    cell = 8
    width = cell * len(names)
    px = np.ones((cell, width, 4), np.float32)
    for i, name in enumerate(names):
        bsdf = next(n for n in flat[name].node_tree.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled')
        lin = list(bsdf.inputs['Base Color'].default_value)[:3]
        srgb = [12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055 for c in lin]
        px[:, i * cell:(i + 1) * cell, :3] = srgb
    image = bpy.data.images.new('PropPalette', width, cell, alpha=False)
    image.pixels.foreach_set(px.ravel())
    save_image(image, os.path.join(TEX_DIR, 'props', 'palette.png'))
    palette = bpy.data.materials.new('PropPalette')
    palette.use_nodes = True
    tex = palette.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.interpolation = 'Closest'
    palette.node_tree.links.new(tex.outputs['Color'], palette.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    for lib in LIB.values():
        me = lib.data
        slots = [m.name if m else None for m in me.materials]
        if not any(n in flat for n in slots):
            continue
        uv = me.uv_layers[0] if me.uv_layers else me.uv_layers.new(name='UVMap')
        for poly in me.polygons:
            name = slots[poly.material_index]
            if name in flat:
                u = (names.index(name) + 0.5) / len(names)
                for li in poly.loop_indices:
                    uv.data[li].uv = (u, 0.5)
        for i, name in enumerate(slots):
            if name in flat:
                me.materials[i] = palette


def solid_box(corners, y0, y1):
    """Collision: a vertical box over 4 (x, z) corners (any rotation)."""
    faces = [[(x, y1, z) for x, z in corners], [(x, y0, z) for x, z in corners]]
    for i in range(4):
        (ax, az), (bx, bz) = corners[i], corners[(i + 1) % 4]
        faces.append([(ax, y0, az), (bx, y0, bz), (bx, y1, bz), (ax, y1, az)])
    COL.extend(orient(faces))


def place(key, x, y, z, rot, collide, col, scale=1.0, mat=None):
    lib = load_prop(key)
    obj = bpy.data.objects.new(f'P_{key}', lib.data)
    obj.location = to_blender((x, y, z))
    obj.rotation_euler = (0, 0, math.radians(rot))
    obj.scale = (1, 1, scale)
    col.objects.link(obj)
    if not collide:
        return
    x0, y0, z0, x1, y1, z1 = lib['bounds']
    if collide == 'trunk':  # trees: the trunk only (shots go through the leaves)
        x0, y0, x1, y1, z1 = -0.3, -0.3, 0.3, 0.3, 3
    c, s_ = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    if 'profile' in lib.keys() and collide is True:
        # Cars: slices along the length, each topped by a slope following the
        # body (bonnet, windscreen, roof, boot), so you can jump onto the
        # bonnet and walk up onto the roof.
        h = lib['profile']
        n = len(h) - 1
        to_game = lambda bx, by: (x + bx * c - by * s_, z - (bx * s_ + by * c))
        for k in range(n):
            ya, yb = y0 + (y1 - y0) * k / n, y0 + (y1 - y0) * (k + 1) / n
            base = y + max(0, z0)
            ta, tb = y + h[k] * scale, y + h[k + 1] * scale
            quad = [(x0, ya, ta), (x1, ya, ta), (x1, yb, tb), (x0, yb, tb)]  # (local x, local y, top)
            g = [to_game(bx, by) + (top,) for bx, by, top in quad]  # (game x, game z, top)
            faces = [[(gx, top, gz) for gx, gz, top in g], [(gx, base, gz) for gx, gz, _ in g]]
            for i in range(4):
                (ax, az, at), (bx, bz, bt) = g[i], g[(i + 1) % 4]
                faces.append([(ax, base, az), (bx, base, bz), (bx, bt, bz), (ax, at, az)])
            COL.extend(orient(faces))
        return
    corners = []
    for bx, by in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):  # Blender local -> game
        wx, wy = bx * c - by * s_, bx * s_ + by * c
        corners.append((x + wx, z - wy))
    solid_box(corners, y + max(0, z0), y + z1 * scale)


def place_ladders(col, mat):
    """The Platformer Pack's ladders (recoloured), stacked and stretched a
    little to each ladder's height."""
    lengths = {'ladder_long': 7.29, 'ladder_medium': 4.48, 'ladder_short': 2.25}
    for key in lengths:
        load_prop(key).data.materials.clear()
        LIB[key].data.materials.append(mat)
    for x, z, nx, nz, y0, y1 in LADDER_MODELS:
        h = y1 - y0
        options = [(key, max(1, round(h / n)), h / (max(1, round(h / n)) * n)) for key, n in lengths.items()]
        key, count, scale = min(options, key=lambda o: abs(o[2] - 1))
        rot = math.degrees(math.atan2(-nz, nx)) - 90  # its rungs' plane facing the climber
        for k in range(count):
            place(key, x, y0 + k * h / count, z, rot, False, col, scale)


def to_blender(p):
    x, y, z = p
    return (x, -z, y)


def make_mesh(name, faces, col, mat=None, uvs=True, tile=2.0):
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap') if uvs else None
    for f in faces:
        verts = [bm.verts.new(to_blender(p)) for p in f]
        try:
            face = bm.faces.new(verts)
        except ValueError:
            continue
        if uv:
            face.normal_update()
            n = face.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for loop in face.loops:
                co = loop.vert.co
                u, v = [(co.y, co.z), (co.x, co.z), (co.x, co.y)][ax]
                loop[uv].uv = (u / tile, v / tile)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    if uvs:
        # Cut into pieces at most LIGHTMAP_PIECE across (separate lightmap
        # islands): the lightmap packing is scaled to its longest island, and
        # the 120 m canal and boundary walls left two thirds of it unused.
        cuts = []
        for axis in (0, 1):
            for k in range(-6, 7):
                no = (1, 0, 0) if axis == 0 else (0, 1, 0)
                co = (k * LIGHTMAP_PIECE, 0, 0) if axis == 0 else (0, k * LIGHTMAP_PIECE, 0)
                res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no)
                cuts += [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        bmesh.ops.split_edges(bm, edges=list({e for e in cuts if e.is_valid}))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    col.objects.link(obj)
    return obj


def main():
    if os.path.exists(OUT_BLEND) and not FORCE:
        print(f'{OUT_BLEND} exists; pass "-- --force" to regenerate.')
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    cols = {}
    for name in ('Buildings', 'Visual', 'Props', 'Collision', 'Spawns'):
        cols[name] = bpy.data.collections.new(name)
        scene.collection.children.link(cols[name])

    ground()
    r = Recorder()
    north_half(r)
    for name, args, kw in r.calls:
        mirror_call(name, args, kw, SOUTH)
    centre_row()
    balloons()

    mats = {name: material(name) for name in sorted(set(VIS) | {'Rail'})}
    for key, x, y, z, rot, collide in PROP_LIST:
        place(key, x, y, z, rot, collide, cols['Props'])
    place_ladders(cols['Props'], mats['Rail'])
    tidy_prop_textures()
    palette_flat_materials()
    for mat_name, faces in sorted(VIS.items()):
        make_mesh(f'V_{mat_name}', faces, cols['Visual'], mats[mat_name], tile=SURFACES[mat_name][1])
    make_mesh('COL_Main', COL, cols['Collision'], uvs=False)
    make_mesh('COLP_Rails', COLP, cols['Collision'], uvs=False)
    for o in cols['Collision'].objects:
        o.display_type = 'WIRE'
        o.hide_render = True

    for i, (x, y, z, team, turn) in enumerate(SPAWNS):
        e = bpy.data.objects.new(f'Spawn_{team}_{i:02d}', None)
        e.empty_display_type = 'ARROWS'
        e.location = to_blender((x, y + 0.05, z))
        # Players face the empty's +Y: Blue (north) faces south, Red north;
        # turned towards +x (game yaw: Blue +, Red -).
        e.rotation_euler = (0, 0, math.pi + turn if team == 0 else -turn)
        e['team'] = team
        cols['Spawns'].objects.link(e)

    scene['map_meta'] = json.dumps({
        'playBounds': list(BOUNDS),
        'pickups': PICKUPS,
        'ladders': LADDERS,
        'zones': ZONES,
        'metal': METAL,
    })
    os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
    tris = sum(len(f) - 2 for fs in VIS.values() for f in fs)
    per_key = {}
    for key, *_ in PROP_LIST:
        per_key[key] = per_key.get(key, 0) + sum(len(f.vertices) - 2 for f in LIB[key].data.polygons)
    tris += sum(per_key.values())
    print('prop triangles:', ', '.join(f'{k} {v // 1000}k' for k, v in sorted(per_key.items(), key=lambda kv: -kv[1])[:12]))
    print(f'saved {os.path.relpath(OUT_BLEND, ROOT)}: {len(PROP_LIST)} props, ~{tris // 1000}k triangles, '
          f'{len(COL) + len(COLP)} collision faces, {len(SPAWNS)} spawns, {len(LADDERS)} ladders, '
          f'{sum(len(v) for v in PICKUPS.values())} pickups, {len(ZONES)} zones')


main()
