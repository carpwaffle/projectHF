"""Generate the Downtown map as an editable Blender file (maps/downtown.blend).

Run once from the project root (it refuses to overwrite an existing map
unless you pass --force, so your Blender edits are safe):

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      --python tools/map_generator.py [-- --force]

Then refine the map in Blender and export it with `npm run build:map`.

Layout (from maps/blueprint_base_2.png; metres, Blender coordinates: X east,
Y north, Z up; origin = map centre). Two-team map, point-symmetric: every
building in the north-west half has a twin rotated 180 degrees about the
centre (House01 <-> House09, 02 <-> 10, ... 07 <-> 15).
  - A cross of 16 m roads with 4 m sidewalks; the four blocks between them
    are raised to sidewalk height. A ring of inward-facing 2-3 storey facades
    closes the arena (the two halves of the ring match too).
  - House08: 5-storey octagon in the middle of the crossing, enterable,
    switchback stairs up to the top floor.
  - House01 / House09: the team bases. Long 1-2 storey buildings whose middle
    is a 2nd-floor bridge over the road. Team spawns are on its ground floor.
  - Enterable: 02/10 (2-3F), 04/12 (1F), 05/13 (4F). The rest are solid.
    Enterable buildings have no windows, only doors.
  - One-storey (3 m) cover walls on the roads.

Blender file structure (what to edit):
  Buildings   one Empty per building; move/rotate it to move the whole building.
              Custom properties: floors, enterable.
  Visual      everything that's drawn (kit pieces + generated stairs, ground,
              sidewalks). Kit pieces are linked duplicates of the kit meshes.
  Collision   simple shapes the game uses for movement and bullets (drawn as
              wireframe here, invisible in game). Keep them in sync when you
              move walls around.
  Spawns      Empties named Spawn_<team>_XX with a "team" property (0 north,
              1 south). Players face the empty's local +Y (its green axis).
"""

import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = os.getcwd()
KIT = os.path.join(ROOT, 'fbx', 'Map', 'DowntownCity')
OUT_BLEND = os.path.join(ROOT, 'maps', 'downtown.blend')

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FORCE = '--force' in argv
SEED = int(argv[argv.index('--seed') + 1]) if '--seed' in argv else 7

CELL = 2.0  # wall pieces are 2 m wide
FLOOR_H = 3.0  # and 3 m tall
PLOT_H = 0.15  # sidewalk / block height above the road
RING_SEGMENTS = 26  # outer ring of facades, 12 m (6 pieces) each
RING_SEG_LEN = 12.0
RING_R = (RING_SEG_LEN / 2) / math.tan(math.pi / RING_SEGMENTS)  # ~49.5 m to the facades
PLAY_R = 48.5  # players are kept inside this radius (map_meta.json playRadius)
BLOCK_R = RING_R + 1.0  # raised blocks run under the ring
ROAD = 8.0  # roads are |x| < 8 and |y| < 8
WALK = 12.0  # sidewalks from 8 to 12, building plots beyond
COVER_H = FLOOR_H  # cover walls on the roads are one storey tall
CEILING = FLOOR_H - 0.2  # underside of the slab above a floor
# Windows players can climb through: sill at least this high (too high to walk
# over, low enough to jump: indoors the ceiling caps a jump at ~1.0 m) and at
# least this wide. Openings that fail get a player-only blocker; bullets still
# pass. The capsule is 0.7 m wide and 1.8 m tall.
WINDOW_SILL = 0.8
WINDOW_MIN_WIDTH = 0.9

STYLES = {
    'brick': dict(wall='Brick_Plain_3', window='Brick_Window_Trim_Single', ground_window='Metal_FirstFloor_Window',
                  door='DoorFrame_Metal_Single', column='Metal_Column_Center', parapet='Brick_Plain_1'),
    'pale': dict(wall='Brick_TopTrim', window='Brick_Window_Square_Single', ground_window='Metal_FirstFloor_Window',
                 door='DoorFrame_Metal_Single', column='Trim_Column_Center', parapet='Brick_Plain_1'),
    'metal': dict(wall='Metal_Plain_3', window='Metal_Window_Half', ground_window='Metal_FirstFloor_Window',
                  door='DoorFrame_Metal_Single', column='Metal_Column_Center', parapet='Metal_Plain_1'),
    'trim': dict(wall='Trim_Plain_3', window='Trim_Window', ground_window='Trim_FirstFloor_Window_001',
                 door='DoorFrame_Trim', column='Trim_Column_Center', parapet='Metal_Plain_1'),
}

rng = random.Random(SEED)


# ---- scene setup ---------------------------------------------------------------

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    cols = {}
    for name in ('Buildings', 'Visual', 'Collision', 'Spawns'):
        col = bpy.data.collections.new(name)
        scene.collection.children.link(col)
        cols[name] = col
    return cols


# ---- kit library ---------------------------------------------------------------

LIB = {}  # piece name (+ '_Open') -> mesh datablock
OPENINGS = {}  # open piece name -> (x0, x1, z0, z1) in piece-local coords


def dedupe_materials(mesh):
    for i, mat in enumerate(mesh.materials):
        if mat and '.' in mat.name and mat.name.rsplit('.', 1)[1].isdigit():
            base = bpy.data.materials.get(mat.name.rsplit('.', 1)[0])
            if base:
                mesh.materials[i] = base


def kit_mesh(name):
    """Import a kit piece once; returns its mesh in piece-local coordinates."""
    if name in LIB:
        return LIB[name]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT, name + '.gltf'), import_pack_images=False)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:
        o.data = o.data.copy()
        o.data.transform(o.matrix_world)
        o.matrix_world = Matrix.Identity(4)
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    mesh = meshes[0].data
    mesh.name = name
    dedupe_materials(mesh)
    for o in new:
        if o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)
    LIB[name] = mesh
    return mesh


def open_mesh(name):
    """Variant of a window/door piece with the glass and fake interior removed,
    so it's a real opening. Also measures the opening for collision."""
    key = name + '_Open'
    if key in LIB:
        return LIB[key]
    mesh = kit_mesh(name).copy()
    mesh.name = key
    bm = bmesh.new()
    bm.from_mesh(mesh)
    remove = [f for f in bm.faces if mesh.materials[f.material_index] and
              mesh.materials[f.material_index].name.split('.')[0] in ('MI_Glass', 'MI_FakeInterior')]
    bmesh.ops.delete(bm, geom=remove, context='FACES')
    bm.to_mesh(mesh)
    # Find the opening: shoot rays through the wall on a grid, keep the misses.
    tree = BVHTree.FromBMesh(bm)
    hits_x, hits_z = [], []
    xs = [-0.98 + i * 0.04 for i in range(50)]
    zs = [0.02 + i * 0.04 for i in range(74)]
    for x in xs:
        for z in zs:
            loc, *_ = tree.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)), 3.0)
            if loc is None:
                hits_x.append(x)
                hits_z.append(z)
    bm.free()
    if hits_x:
        OPENINGS[key] = (min(hits_x) - 0.02, max(hits_x) + 0.02, max(0.0, min(hits_z) - 0.02), max(hits_z) + 0.02)
    LIB[key] = mesh
    return mesh


def material(name):
    mat = bpy.data.materials.get(name)
    if mat is None:
        raise KeyError(f'material {name} not loaded yet')
    return mat


# ---- object helpers ------------------------------------------------------------

def place(cols, mesh, parent, local, name=None):
    obj = bpy.data.objects.new(name or mesh.name, mesh)
    cols['Visual'].objects.link(obj)
    obj.parent = parent
    obj.matrix_basis = local
    return obj


def rot_for_normal(nx, ny):
    """Rotation so a kit wall's exterior side (-Y in Blender) faces (nx, ny)."""
    return Matrix.Rotation(math.atan2(nx, -ny), 4, 'Z')


def new_empty(cols, name, x, y, angle):
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = 'PLAIN_AXES'
    empty.empty_display_size = 2
    empty.location = (x, y, 0)
    empty.rotation_euler = (0, 0, angle)
    cols['Buildings'].objects.link(empty)
    return empty


WALL_T = 0.2  # outside walls: a slab this thick, inside the building's outline


def wall_collision(col, mesh_name, local, block=None):
    """Wall slab, with a hole where the piece has an opening. block: the
    player-only collision, which closes window holes players shouldn't fit
    through (too narrow) or could walk through (sill too low)."""
    hole = OPENINGS.get(mesh_name)
    if not hole:
        col.box((-1, 0, 0), (1, WALL_T, FLOOR_H), local)
        return
    x0, x1, z0, z1 = hole
    col.box((-1, 0, 0), (x0, 0.2, FLOOR_H), local)
    col.box((x1, 0, 0), (1, 0.2, FLOOR_H), local)
    col.box((x0, 0, 0), (x1, 0.2, z0), local)
    col.box((x0, 0, z1), (x1, 0.2, FLOOR_H), local)
    if block is not None and 'Door' not in mesh_name:
        if x1 - x0 < WINDOW_MIN_WIDTH:
            block.box((x0, 0, z0), (x1, 0.2, z1), local)
        elif z0 < WINDOW_SILL:
            block.box((x0, 0, z0), (x1, 0.2, min(WINDOW_SILL, z1)), local)


def wall_frame(vis, col, m, half, post, sill, top, mat_index=0):
    """Concrete frame across a stretch of wall (local x along the wall, y
    inward, origin at its middle): posts at both ends, a sill below and a
    lintel above the opening."""
    y0, y1 = -0.02, 0.22
    for lo, hi in (((-half, y0, 0), (-half + post, y1, FLOOR_H)), ((half - post, y0, 0), (half, y1, FLOOR_H)),
                   ((-half + post, y0, 0), (half - post, y1, sill)), ((-half + post, y0, top), (half - post, y1, FLOOR_H))):
        vis.box(lo, hi, m, mat_index)
        col.box(lo, hi, m)


def finish_player_block(block, cols, name, parent):
    """Player-only collision (COLP_*): blocks movement, not bullets."""
    if block.bm.faces:
        block.finish(cols, 'Collision', f'COLP_{name}', parent, wire=True)
    else:
        block.bm.free()


def pick_wall(rand, style, floor, door, enterable):
    """Kit piece for one exterior wall segment. Enterable buildings get no
    windows (doors only); solid ones get closed (glass) windows."""
    if door:
        return open_mesh(style['door'])
    window = style['ground_window'] if floor == 0 else style['window']
    if enterable:
        return kit_mesh(style['wall'])
    return kit_mesh(window) if rand.random() < (0.45 if floor == 0 else 0.6) else kit_mesh(style['wall'])


class MeshBuilder:
    """Accumulates boxes / prisms into one mesh object (for collision or for
    generated visual geometry)."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')

    def box(self, lo, hi, matrix=Matrix.Identity(4), mat_index=0):
        size = [h - l for l, h in zip(lo, hi)]
        if min(size) <= 0:
            return
        centre = [(l + h) / 2 for l, h in zip(lo, hi)]
        m = matrix @ Matrix.Translation(centre) @ Matrix.Diagonal((*size, 1))
        res = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        for f in {f for v in res['verts'] for f in v.link_faces}:
            f.material_index = mat_index

    def prism(self, polygon, z0, z1, matrix=Matrix.Identity(4), mat_index=0, bottom=False, top_mat=None, bottom_mat=None):
        """Vertical extrusion of a 2D polygon (counter-clockwise)."""
        if len(polygon) < 3:
            return
        lo = [self.bm.verts.new(matrix @ Vector((x, y, z0))) for x, y in polygon]
        hi = [self.bm.verts.new(matrix @ Vector((x, y, z1))) for x, y in polygon]
        self.bm.faces.new(hi).material_index = mat_index if top_mat is None else top_mat
        if bottom:
            self.bm.faces.new(list(reversed(lo))).material_index = mat_index if bottom_mat is None else bottom_mat
        n = len(polygon)
        for i in range(n):
            j = (i + 1) % n
            self.bm.faces.new((lo[i], lo[j], hi[j], hi[i])).material_index = mat_index

    def wedge(self, x0, x1, s0, s1, z0, z1, matrix, mat_index=0):
        """Ramp rising from (s0, z0) to (s1, z1) along local +Y, across x0..x1."""
        v = lambda x, s, z: self.bm.verts.new(matrix @ Vector((x, s, z)))
        a, b = v(x0, s0, z0), v(x1, s0, z0)
        c, d = v(x1, s1, z0), v(x0, s1, z0)
        e, f = v(x1, s1, z1), v(x0, s1, z1)
        for face in ((a, b, e, f), (a, d, c, b), (d, f, e, c), (a, f, d), (b, c, e)):
            self.bm.faces.new(face).material_index = mat_index

    def finish(self, cols, collection, name, parent=None, materials=(), uv_scale=0.25, wire=False):
        # (Faces are built with outward winding; no normal recalculation, which
        # can flip open shells like the ground disc.)
        self.bm.normal_update()
        # Box-projected UVs (metres * uv_scale), so tiling textures line up.
        for f in self.bm.faces:
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            u, w = [(1, 2), (0, 2), (0, 1)][ax]
            for loop in f.loops:
                co = loop.vert.co
                loop[self.uv].uv = (co[u] * uv_scale, co[w] * uv_scale)
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in materials:
            mesh.materials.append(m)
        obj = bpy.data.objects.new(name, mesh)
        cols[collection].objects.link(obj)
        if parent:
            obj.parent = parent
        if wire:
            obj.display_type = 'WIRE'
            obj.hide_render = True
        return obj


def stair_flight(vis, col, frame, run, z0, rise=FLOOR_H, half=0.95, steps=15, top=0.0):
    """Solid concrete steps (visual) + a ramp (collision), rising along the
    frame's +Y from (0, z0) to (run - top, z0 + rise), then flat for `top` m.
    The flat top lets players reach full height when the flight ends at a
    wall (their capsule stops 0.35 m short of it)."""
    slope = run - top
    for s in range(steps):
        vis.box((-half, s * slope / steps, z0), (half, (s + 1) * slope / steps, z0 + (s + 1) * rise / steps), frame, 0)
    col.wedge(-half, half, 0, slope, z0, z0 + rise, frame)
    if top > 0:
        vis.box((-half, slope, z0), (half, run, z0 + rise), frame, 0)
        col.box((-half, slope, z0), (half, run, z0 + rise), frame)


# ---- 2D polygon helpers --------------------------------------------------------

def clip(poly, a, b, c):
    """Sutherland-Hodgman: keep the part of a polygon where a*x + b*y <= c."""
    out = []
    n = len(poly)
    for k in range(n):
        p, q = poly[k], poly[(k + 1) % n]
        dp = a * p[0] + b * p[1] - c
        dq = a * q[0] + b * q[1] - c
        if dp <= 0:
            out.append(p)
        if (dp <= 0) != (dq <= 0):
            t = dp / (dp - dq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return out


def clip_rect(poly, x0, y0, x1, y1):
    for a, b, c in ((-1, 0, -x0), (1, 0, x1), (0, -1, -y0), (0, 1, y1)):
        poly = clip(poly, a, b, c)
    return poly


def clip_circle(poly, r, segments=96):
    for k in range(segments):
        a = 2 * math.pi * (k + 0.5) / segments
        poly = clip(poly, math.cos(a), math.sin(a), r)
    return poly


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def octagon(apothem):
    """Regular octagon with flat sides facing E, NE, N, ... (counter-clockwise)."""
    r = apothem / math.cos(math.pi / 8)
    return [(r * math.cos(math.pi / 8 + k * math.pi / 4), r * math.sin(math.pi / 8 + k * math.pi / 4)) for k in range(8)]


# ---- buildings -----------------------------------------------------------------

DIRS = {'E': (1, 0), 'W': (-1, 0), 'N': (0, 1), 'S': (0, -1)}


def rect_cells(x0, y0, x1, y1):
    return {(i, j) for i in range(math.floor(x0 / CELL), math.floor(x1 / CELL))
            for j in range(math.floor(y0 / CELL), math.floor(y1 / CELL))}


class Building:
    """A building on a 2 m cell grid in its own local frame.

    parts: [(cells, base, top)]: cell (i, j) spans x in [2i, 2i+2], y in
           [2j, 2j+2] and has floors base .. top-1 (base 1 = a bridge with no
           ground floor).
    doors: set of (i, j, side) ground-floor door edges, or (i, j, side, floor).
    windows: list of (floor, side, [(i, j), ...][, post[, sill]]) windows: a
             concrete frame across those wall cells with posts `post` m wide
             at each end (default 0.6), opening from `sill` (default
             WINDOW_SILL) to the ceiling.
    railings: list of (level, (x0, y0, x1, y1)) 1 m concrete railings, e.g.
              round a stair opening in a roof (level = floor index of the roof).
    stairs: list of (floor, [(i, j), ...], direction[, half_width]) flights,
            usually 3 cells long (a flight on a roof just has floor = the roof's level).
            A flight needs a free cell in front of its bottom end (the sides of
            a ramp are too tall to step onto); the top may end at a wall, as
            long as the floor beside it is solid.
    partitions: list of ('x'|'y', line, from, to, door_from[, floors]) interior walls.
    cover: list of (floor, i, j, along_x) low walls.
    roof_gaps: parapet edges (i, j, side) to leave open, e.g. where a roof stair arrives.
    rng_key: twins share a key, so they get the same windows.
    """

    def __init__(self, name, x, y, angle, parts, style, enterable,
                 doors=(), stairs=(), partitions=(), cover=(), roof_stairs=None, rng_key=None,
                 windows=(), roof_gaps=(), railings=()):
        self.name, self.x, self.y, self.angle = name, x, y, angle
        self.levels = {}
        for cells, base, top in parts:
            for c in cells:
                self.levels[c] = (base, top)
        self.cells = set(self.levels)
        self.floors = max(top for _, top in self.levels.values())
        self.style_name = style
        self.style = STYLES[style]
        self.enterable = enterable
        self.doors = {d if len(d) == 4 else (*d, 0) for d in doors}
        self.windows = list(windows)
        self.roof_gaps = set(roof_gaps)
        self.railings = list(railings)
        self.stairs = list(stairs)
        self.partitions = list(partitions)
        self.cover = list(cover)
        self.roof_stairs = roof_stairs  # (side, offset_cells) for an outside stair to the roof
        self.top = PLOT_H + self.floors * FLOOR_H
        self.rng = random.Random(f'{SEED}-{rng_key or name}')

    def present(self, cell, floor):
        lv = self.levels.get(cell)
        return lv is not None and lv[0] <= floor < lv[1]

    def boundary(self, floor):
        """Exterior edges on one floor: (i, j, side, nx, ny, mid_x, mid_y)."""
        out = []
        for (i, j) in sorted(self.cells):
            if not self.present((i, j), floor):
                continue
            for side, (dx, dy) in DIRS.items():
                if self.present((i + dx, j + dy), floor):
                    continue
                cx, cy = (i + 0.5) * CELL, (j + 0.5) * CELL
                out.append((i, j, side, dx, dy, cx + dx * CELL / 2, cy + dy * CELL / 2))
        return out

    def corners(self, floor):
        """Grid points where the outline turns (convex or concave corners)."""
        count = {}
        for (i, j, side, dx, dy, mx, my) in self.boundary(floor):
            if dx:  # vertical edge: endpoints differ in y
                pts = [(mx, my - CELL / 2), (mx, my + CELL / 2)]
                orient = 'v'
            else:
                pts = [(mx - CELL / 2, my), (mx + CELL / 2, my)]
                orient = 'h'
            for p in pts:
                key = (round(p[0], 3), round(p[1], 3))
                count.setdefault(key, set()).add(orient)
        return sorted(p for p, o in count.items() if len(o) == 2)

    def footprint_rects(self, cells):
        """Merge cells into rectangles row by row (for collision)."""
        rows = {}
        for (i, j) in cells:
            rows.setdefault(j, []).append(i)
        rects = []
        for j, xs in sorted(rows.items()):
            xs.sort()
            start = prev = xs[0]
            for x in xs[1:] + [None]:
                if x is not None and x == prev + 1:
                    prev = x
                    continue
                rects.append((start * CELL, j * CELL, (prev + 1) * CELL, (j + 1) * CELL))
                if x is not None:
                    start = prev = x
        return rects

    def build(self, cols):
        root = new_empty(cols, self.name, self.x, self.y, self.angle)
        root['floors'] = self.floors
        root['enterable'] = self.enterable
        vis = MeshBuilder()  # generated visual geometry (stairs, partitions, cover)
        col = MeshBuilder()
        block = MeshBuilder()
        st = self.style
        holes = {(i, j, floor + 1) for (floor, cells, *_) in self.stairs for (i, j) in cells}
        window_edges = {(i, j, side, floor) for (floor, side, cells, *_) in self.windows for (i, j) in cells}
        roof_gap = set(self.roof_gaps)
        if self.roof_stairs:
            roof_gap |= self.build_roof_stairs(cols, root, vis, col)

        # Exterior walls, floor by floor.
        for f in range(self.floors):
            z = PLOT_H + f * FLOOR_H
            for (i, j, side, dx, dy, mx, my) in self.boundary(f):
                if (i, j, side, f) in window_edges:
                    continue
                local = Matrix.Translation((mx, my, z)) @ rot_for_normal(dx, dy)
                door = (i, j, side, f) in self.doors
                mesh = pick_wall(self.rng, st, f, door, self.enterable)
                place(cols, mesh, root, local)
                if self.enterable:
                    wall_collision(col, mesh.name, local, block)
            for (cx, cy) in self.corners(f):
                place(cols, kit_mesh(st['column']), root, Matrix.Translation((cx, cy, z)))
        for (f, side, cells, *opts) in self.windows:
            dx, dy = DIRS[side]
            mids = [((i + 0.5 + dx / 2) * CELL, (j + 0.5 + dy / 2) * CELL) for (i, j) in cells]
            cx, cy = (mids[0][0] + mids[-1][0]) / 2, (mids[0][1] + mids[-1][1]) / 2
            m = Matrix.Translation((cx, cy, PLOT_H + f * FLOOR_H)) @ rot_for_normal(dx, dy)
            post, sill = (list(opts) + [0.6, WINDOW_SILL][len(opts):])[:2]
            wall_frame(vis, col, m, len(cells) * CELL / 2, post, sill, CEILING)
        for (level, (x0, y0, x1, y1)) in self.railings:
            z = PLOT_H + level * FLOOR_H
            vis.box((x0, y0, z), (x1, y1, z + 1.0))
            col.box((x0, y0, z), (x1, y1, z + 1.0))

        # Floors (enterable buildings only) and roofs.
        floor_mesh = kit_mesh('Floor_2x2')
        roof_mesh = kit_mesh('Roof_2x2')
        for (i, j) in sorted(self.cells):
            base, top = self.levels[(i, j)]
            cx, cy = (i + 0.5) * CELL, (j + 0.5) * CELL
            if self.enterable:
                for f in range(base, top + 1):  # the last one is the top ceiling
                    if (i, j, f) in holes:
                        continue
                    z = PLOT_H + f * FLOOR_H + (0.01 if f == 0 else 0)
                    place(cols, floor_mesh, root, Matrix.Translation((cx, cy, z)))
                    if f > 0:
                        col.box((i * CELL, j * CELL, z - (0.5 if f == base else 0.2)), ((i + 1) * CELL, (j + 1) * CELL, z))
                if base > 0:  # concrete underside of a bridge
                    z = PLOT_H + base * FLOOR_H
                    vis.box((i * CELL, j * CELL, z - 0.5), ((i + 1) * CELL, (j + 1) * CELL, z - 0.21), mat_index=0)
            if (i, j, top) not in holes:
                place(cols, roof_mesh, root, Matrix.Translation((cx, cy, PLOT_H + top * FLOOR_H + 0.21)))

        # Parapets along roof edges that drop to a lower roof or the ground.
        for (i, j) in sorted(self.cells):
            top = self.levels[(i, j)][1]
            for side, (dx, dy) in DIRS.items():
                if self.levels.get((i + dx, j + dy), (0, 0))[1] >= top or (i, j, side) in roof_gap:
                    continue
                mx, my = (i + 0.5 + dx / 2) * CELL, (j + 0.5 + dy / 2) * CELL
                local = Matrix.Translation((mx, my, PLOT_H + top * FLOOR_H)) @ rot_for_normal(dx, dy)
                place(cols, kit_mesh(st['parapet']), root, local)
                if self.enterable or self.roof_stairs:
                    col.box((-1, 0, 0), (1, 0.2, 1.0), local)

        if not self.enterable:
            for (base, top) in sorted(set(self.levels.values())):
                cells = [c for c, lv in self.levels.items() if lv == (base, top)]
                for (x0, y0, x1, y1) in self.footprint_rects(cells):
                    col.box((x0, y0, PLOT_H + base * FLOOR_H), (x1, y1, PLOT_H + top * FLOOR_H + 0.01))

        self.build_interior(cols, root, vis, col)

        if vis.bm.faces:
            vis.finish(cols, 'Visual', f'{self.name}_Generated', root,
                       materials=[material('MI_Concrete'), material('MI_InteriorWall')])
        else:
            vis.bm.free()
        col.finish(cols, 'Collision', f'COL_{self.name}', root, wire=True)
        finish_player_block(block, cols, self.name, root)
        return root

    def build_interior(self, cols, root, vis, col):
        # Staircases.
        for (floor, cells, (di, dj), *half) in self.stairs:
            i0, j0 = cells[0]
            # Frame: origin at the start cell's back edge, +Y along the run.
            cx, cy = (i0 + 0.5) * CELL - di * CELL / 2, (j0 + 0.5) * CELL - dj * CELL / 2
            frame = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(math.atan2(-di, dj), 4, 'Z')
            # A flight ending at an outside wall stops at the wall's inner face
            # (the slab is WALL_T thick, inside the outline); otherwise its top
            # pokes out through the wall.
            il, jl = cells[-1]
            at_wall = (il + di, jl + dj) not in self.cells
            stair_flight(vis, col, frame, len(cells) * CELL - (WALL_T if at_wall else 0), PLOT_H + floor * FLOOR_H,
                         top=1.0, half=half[0] if half else 0.95)

        # Interior walls with a doorway.
        for (axis, line, a, b, door, *floors) in self.partitions:
            for f in (floors[0] if floors else range(self.floors)):
                z0 = PLOT_H + f * FLOOR_H
                z1 = z0 + FLOOR_H - 0.2
                segs = [(a, door), (door + 1.4, b)]
                for (s0, s1) in segs:
                    lo, hi = ((line - 0.1, s0, z0), (line + 0.1, s1, z1)) if axis == 'x' else ((s0, line - 0.1, z0), (s1, line + 0.1, z1))
                    vis.box(lo, hi, mat_index=1)
                    col.box(lo, hi)
                lo, hi = ((line - 0.1, door, z0 + 2.3), (line + 0.1, door + 1.4, z1)) if axis == 'x' else ((door, line - 0.1, z0 + 2.3), (door + 1.4, line + 0.1, z1))
                vis.box(lo, hi, mat_index=1)
                col.box(lo, hi)

        # Low cover walls.
        for (floor, i, j, along_x) in self.cover:
            z0 = PLOT_H + floor * FLOOR_H
            cx, cy = (i + 0.5) * CELL, (j + 0.5) * CELL
            hx, hy = (0.8, 0.15) if along_x else (0.15, 0.8)
            lo, hi = (cx - hx, cy - hy, z0), (cx + hx, cy + hy, z0 + 1.1)
            vis.box(lo, hi, mat_index=1)
            col.box(lo, hi)

    def build_roof_stairs(self, cols, root, vis, col):
        """Outside stair along one side, up to the roof. Returns the parapet
        edges to leave open where the stair arrives."""
        side, offset = self.roof_stairs
        edges = sorted([e for e in self.boundary(0) if e[2] == side], key=lambda e: (e[0], e[1]))
        run_edges = edges[offset:offset + 3]
        (i, j, _, dx, dy, mx, my) = run_edges[0]
        (i2, j2, _, _, _, mx2, my2) = run_edges[-1]
        # Run direction along the wall, outward offset 1 m from the wall.
        ux, uy = (mx2 - mx), (my2 - my)
        length = math.hypot(ux, uy) or 1
        ux, uy = ux / length, uy / length
        sx, sy = mx - ux * CELL / 2 + dx * 1.0, my - uy * CELL / 2 + dy * 1.0
        frame = Matrix.Translation((sx, sy, 0)) @ Matrix.Rotation(math.atan2(-ux, uy), 4, 'Z')
        stair_flight(vis, col, frame, 3 * CELL, PLOT_H, rise=self.top - PLOT_H, half=0.9)
        top_edge = run_edges[-1]
        return {(top_edge[0], top_edge[1], side)}


def centred(cx, cy, angle, w, d):
    """Building origin so a w x d m block of cells starting at (0, 0) is
    centred on (cx, cy) when rotated by angle."""
    c, s = math.cos(angle), math.sin(angle)
    return cx - (c * w / 2 - s * d / 2), cy - (s * w / 2 + c * d / 2)


class Octagon:
    """House08: regular octagon (6 m sides, three wall pieces each) with a
    switchback stairwell in the middle: flights alternate between two 2 m
    lanes (x -2..0 going north, x 0..2 going south) with landings on the
    floors at both ends (y -5..-3 and 3..5). The last flight comes up
    through the roof (railings round the opening).

    Entrances and window-floor windows are concrete frames filling almost the
    whole 6 m side: entrances 5 x 2.6 m, windows 5 m wide from a 0.8 m sill
    to the ceiling (jump through them)."""

    SIDE = 6.0
    JAMB = 0.5  # frame posts at each end of a side

    def __init__(self, name, floors, style, door_sides, window_floors=()):
        self.name = name
        self.floors = floors
        self.style = STYLES[style]
        self.door_sides = set(door_sides)  # side k faces angle k * 45 degrees (0 = east)
        self.window_floors = set(window_floors)  # 0 = ground floor
        self.apothem = self.SIDE / 2 / math.tan(math.pi / 8)  # ~7.24 m
        self.top = PLOT_H + floors * FLOOR_H
        self.rng = random.Random(f'{SEED}-{name}')

    def sides(self):
        for k in range(8):
            a = k * math.pi / 4
            nx, ny = math.cos(a), math.sin(a)
            yield k, nx, ny, -ny, nx

    def build(self, cols):
        root = new_empty(cols, self.name, 0, 0, 0)
        root['floors'] = self.floors
        root['enterable'] = True
        vis = MeshBuilder()
        col = MeshBuilder()
        st, ap = self.style, self.apothem

        for f in range(self.floors):
            z = PLOT_H + f * FLOOR_H
            for k, nx, ny, tx, ty in self.sides():
                side = Matrix.Translation((nx * ap, ny * ap, z)) @ rot_for_normal(nx, ny)
                if f == 0 and k in self.door_sides:
                    self.frame(vis, col, side, sill=0.0, top=2.6)
                elif f in self.window_floors:
                    self.frame(vis, col, side, sill=WINDOW_SILL, top=CEILING)
                else:
                    for off in (-2.0, 0.0, 2.0):
                        local = Matrix.Translation((nx * ap + tx * off, ny * ap + ty * off, z)) @ rot_for_normal(nx, ny)
                        mesh = kit_mesh(st['wall'])
                        place(cols, mesh, root, local)
                        wall_collision(col, mesh.name, local)
        # Roof parapet (walkable roof, so it has collision).
        for k, nx, ny, tx, ty in self.sides():
            for off in (-2.0, 0.0, 2.0):
                local = Matrix.Translation((nx * ap + tx * off, ny * ap + ty * off, self.top)) @ rot_for_normal(nx, ny)
                place(cols, kit_mesh(st['parapet']), root, local)
                col.box((-1, 0, 0), (1, 0.2, 1.0), local)

        # Floor slabs (inset 0.1 m so their edges hide inside the walls), each
        # with the stairwell hole of the flight arriving from below.
        outline = octagon(ap - 0.1)
        z = PLOT_H
        vis.prism(outline, z, z + 0.01, mat_index=2)
        for level in range(1, self.floors + 1):  # the last level is the roof
            z = PLOT_H + level * FLOOR_H
            x0 = -2.0 if (level - 1) % 2 == 0 else 0.0
            hole = (x0, -3.0, x0 + 2.0, 3.0)
            pieces = [clip(outline, 1, 0, hole[0]), clip(outline, -1, 0, -hole[2]),
                      clip_rect(outline, hole[0], hole[3], hole[2], 99), clip_rect(outline, hole[0], -99, hole[2], hole[1])]
            for poly in pieces:
                vis.prism(poly, z - 0.2, z, mat_index=0, bottom=True, top_mat=4 if level == self.floors else 2, bottom_mat=3)
                col.prism(poly, z - 0.2, z, bottom=True)
        # Railings round the stair opening on the roof (open on the north
        # side, where the stairs arrive).
        x0 = -2.0 if (self.floors - 1) % 2 == 0 else 0.0
        z = self.top
        for lo, hi in (((x0 - 0.15, -3.15, z), (x0, 3.0, z + 1.0)), ((x0 + 2.0, -3.15, z), (x0 + 2.15, 3.0, z + 1.0)),
                       ((x0 - 0.15, -3.15, z), (x0 + 2.15, -3.0, z + 1.0))):
            vis.box(lo, hi)
            col.box(lo, hi)

        for f in range(self.floors):
            north = f % 2 == 0
            frame = Matrix.Translation((-1.0 if north else 1.0, -3.0 if north else 3.0, 0)) @ \
                Matrix.Rotation(0 if north else math.pi, 4, 'Z')
            stair_flight(vis, col, frame, 6.0, PLOT_H + f * FLOOR_H)

        # Low cover on every floor, point-symmetric like the rest of the map.
        for f in range(self.floors):
            z0 = PLOT_H + f * FLOOR_H
            for (cx, cy) in ((4.6, 1.6), (-4.6, -1.6)):
                lo, hi = (cx - 0.15, cy - 0.8, z0), (cx + 0.15, cy + 0.8, z0 + 1.1)
                vis.box(lo, hi, mat_index=1)
                col.box(lo, hi)

        vis.finish(cols, 'Visual', f'{self.name}_Generated', root, uv_scale=0.5,
                   materials=[material('MI_Concrete'), material('MI_InteriorWall'), material('MI_InteriorFloor'),
                              material('MI_InteriorRoof'), material('MI_Asphalt')])
        col.finish(cols, 'Collision', f'COL_{self.name}', root, wire=True)
        return root

    def frame(self, vis, col, side, sill, top):
        """Concrete frame across a whole side (local x along the side, y
        inward): posts at both ends, a sill below and a lintel above the opening."""
        wall_frame(vis, col, side, self.SIDE / 2, self.JAMB, sill, top)


# ---- map layout ----------------------------------------------------------------
# The north-west half (plus the centre); main() adds each building's twin.
# Coordinates read off maps/blueprint_base_2.png and snapped to the 2 m grid.

def north_buildings():
    out = []
    # House01: north team base. West wing 2F, bridge over the road (2nd floor
    # only), east wing 2F (team spawns downstairs), east end 1F, annex 1F.
    out.append(Building(
        'House01', 0, 0, 0,
        [(rect_cells(-22, 24, -12, 32), 0, 2), (rect_cells(-12, 24, 12, 32), 1, 2),
         (rect_cells(12, 24, 22, 32), 0, 2), (rect_cells(22, 24, 34, 32), 0, 1),
         (rect_cells(12, 32, 22, 42), 0, 1)],
        'brick', True,
        doors={(-9, 12, 'S'), (12, 12, 'S'), (6, 17, 'W')},
        stairs=[(0, [(-10, 15), (-9, 15), (-8, 15)], (1, 0)),
                (0, [(7, 12), (8, 12), (9, 12)], (1, 0))],
        partitions=[('x', -12.0, 24.2, 31.8, 27.3, [1]), ('x', 12.0, 24.2, 31.8, 27.3, [1]),
                    ('x', 22.0, 24.2, 31.8, 27.3, [0]), ('y', 32.0, 12.2, 21.8, 16.3, [0])],
        cover=[(1, -4, 14, False), (1, 3, 13, False), (1, -1, 12, True), (1, 0, 15, True)],
        # West wing: a big, low-sill west window upstairs (easy to jump out).
        # Bridge: 4 medium windows each side, every 6 m. East wing: medium
        # windows west downstairs (under the bridge) and south upstairs (by
        # the stair landing). East end: a medium window south.
        windows=[(1, 'W', [(-11, 13), (-11, 14)], 0.3, 0.6)] +
                [(1, side, [(i, j)], 0.25) for side, j in (('N', 15), ('S', 12)) for i in (-5, -2, 1, 4)] +
                [(0, 'W', [(6, 14)], 0.25), (1, 'S', [(10, 12)], 0.25), (0, 'S', [(15, 12)], 0.25)],
        rng_key='House01'))
    # House02: 3F west half, 2F east half. Switchback stairs in the 3F half:
    # up east along the north wall (row 9; narrowed to clear the wall), step
    # across to row 8 at the top, up west in row 8. (Row 7 blocked the view /
    # way in from the south door.) A 3rd-floor door opens onto the 2F half's roof, where
    # an outside stair along the north edge climbs to the 3F roof.
    # Wide windows (the user specified them for House10, the twin, so here
    # north and south are swapped): 2F half south (both floors) and north
    # (2nd floor); 3F half south (2nd + 3rd floor) and north (3rd floor).
    out.append(Building(
        'House02', 0, 0, 0,
        [(rect_cells(12, 12, 20, 20), 0, 3), (rect_cells(20, 12, 30, 20), 0, 2)],
        'metal', True,
        doors={(12, 9, 'N'), (7, 6, 'S'), (9, 7, 'E', 2)},
        stairs=[(0, [(7, 9), (8, 9), (9, 9)], (1, 0), 0.75),
                (1, [(8, 8), (7, 8), (6, 8)], (-1, 0)),
                (2, [(13, 9), (12, 9), (11, 9), (10, 9)], (-1, 0), 0.8)],
        windows=[(0, 'S', [(10, 6), (11, 6)]), (0, 'S', [(13, 6), (14, 6)]),
                 (1, 'S', [(10, 6), (11, 6)]), (1, 'S', [(13, 6), (14, 6)]),
                 (1, 'N', [(10, 9), (11, 9)]), (1, 'N', [(13, 9), (14, 9)]),
                 (1, 'S', [(7, 6), (8, 6)]), (2, 'S', [(7, 6), (8, 6)]), (2, 'N', [(7, 9), (8, 9)])],
        roof_gaps={(9, 9, 'E')},
        partitions=[('x', 20.0, 12.2, 19.8, 13.0, [0, 1])],
        rng_key='House02'))
    out.append(Building('House03', 0, 0, 0, [(rect_cells(32, 12, 44, 20), 0, 1)], 'pale', False, rng_key='House03'))
    # House04: 1F, 8 m square turned 45 degrees, doors on the NE and SW faces.
    a = math.pi / 4
    out.append(Building('House04', *centred(-19, 39, a, 8, 8), a, [(rect_cells(0, 0, 8, 8), 0, 1)], 'trim', True,
                        doors={(3, 1, 'E'), (0, 2, 'W')}, cover=[(0, 1, 1, True)], rng_key='House04'))
    # House05: 4F, 8 m square turned 45 degrees, door facing the centre (SE).
    # Switchback stairs in rows 2/3 up to the roof (railing round the roof
    # opening, open at the west end where the stairs arrive). Two medium
    # windows (1.5 m) on every wall except the one facing the ring (local N),
    # on the 2nd-4th floors.
    out.append(Building(
        'House05', *centred(-36, 22, a, 8, 8), a, [(rect_cells(0, 0, 8, 8), 0, 4)], 'brick', True,
        doors={(2, 0, 'S')},
        stairs=[(0, [(1, 2), (2, 2), (3, 2)], (1, 0)),
                (1, [(2, 3), (1, 3), (0, 3)], (-1, 0)),
                (2, [(1, 2), (2, 2), (3, 2)], (1, 0)),
                (3, [(2, 3), (1, 3), (0, 3)], (-1, 0))],
        windows=[(f, side, [cell], 0.25) for f in (1, 2, 3)
                 for side, cells in (('E', [(3, 0), (3, 3)]), ('W', [(0, 0), (0, 3)]), ('S', [(0, 0), (3, 0)]))
                 for cell in cells],
        railings=[(4, (1.2, 5.85, 6.0, 6.0)), (4, (6.0, 5.85, 6.15, 7.8))],
        rng_key='House05'))
    out.append(Building('House06', 0, 0, 0, [(rect_cells(-32, 12, -24, 20) - rect_cells(-32, 16, -30, 20), 0, 1)],
                        'metal', False, rng_key='House06'))
    out.append(Building('House07', *centred(-17, 17, a, 6, 6), a, [(rect_cells(0, 0, 6, 6), 0, 2)], 'pale', False,
                        rng_key='House07'))
    return out


TWINS = {'House01': 'House09', 'House02': 'House10', 'House03': 'House11', 'House04': 'House12',
         'House05': 'House13', 'House06': 'House14', 'House07': 'House15'}


def twin(b):
    """The same building rotated 180 degrees about the map centre (same windows too)."""
    return Building(TWINS[b.name], -b.x, -b.y, b.angle + math.pi,
                    [({c}, *lv) for c, lv in b.levels.items()], b.style_name, b.enterable,
                    b.doors, b.stairs, b.partitions, b.cover, b.roof_stairs, rng_key=b.name,
                    windows=b.windows, roof_gaps=b.roof_gaps, railings=b.railings)


# Roof pickup spots (src/shared.js; Blender coordinates, game z = -y): no AC
# units within 2.5 m of these.
ROOF_SPOTS = [(-17, 17), (17, -17), (38, 16), (-38, -16)]
# Billboards on House07 / House15's roofs between their heal pack and House08
# (cover from the tower): building-local, the side facing the centre.
BILLBOARD_ROOFS = ('House07', 'House15')

# Cover walls on the roads: (x, y, along_x), north/west ones; twins added.
COVER = [(-2, 37, True), (-35, 4, False), (-25, 4, False), (-31, -4, False)]

# Team 0 spawns, on the ground floor of House01's east wing (clear of the
# stairs along its south wall), facing west (towards the window onto the road
# under the bridge; facing the centre would mean staring at the stairs). Team 1
# gets the twins in House09.
TEAM_SPAWNS = [(14.0, 30.5), (18.0, 30.5), (20.5, 28.0), (14.0, 27.5)]
SPAWN_FACING = math.pi / 2  # rotation about Z: local +Y turned to point west


# ---- ground, cover, props, spawns ----------------------------------------------

def build_ground(cols):
    """Asphalt roads (the cross, inside the ring), asphalt beyond the ring
    (`GroundOuter`, only seen from high up; kept separate so it can get a
    low-resolution lightmap), raised sidewalks and blocks."""
    vis = MeshBuilder()
    big = BLOCK_R + 5
    for poly in (rect(-big, -ROAD, big, ROAD), rect(-ROAD, ROAD, ROAD, big), rect(-ROAD, -big, ROAD, -ROAD)):
        vis.prism(clip_circle(poly, BLOCK_R), -0.01, 0)  # (only the top face shows)
    vis.finish(cols, 'Visual', 'Ground', materials=[material('MI_Asphalt')], uv_scale=1 / 6)
    # Annulus from the clip polygon used above (circumscribed 96-gon) out to 130 m.
    vis = MeshBuilder()
    n = 96
    r_in = BLOCK_R / math.cos(math.pi / n)
    inner = [vis.bm.verts.new((r_in * math.cos(2 * math.pi * k / n), r_in * math.sin(2 * math.pi * k / n), 0)) for k in range(n)]
    outer = [vis.bm.verts.new((130 * math.cos(2 * math.pi * k / n), 130 * math.sin(2 * math.pi * k / n), 0)) for k in range(n)]
    for k in range(n):
        vis.bm.faces.new((inner[k], outer[k], outer[(k + 1) % n], inner[(k + 1) % n]))
    vis.finish(cols, 'Visual', 'GroundOuter', materials=[material('MI_Asphalt')], uv_scale=1 / 6)
    col = MeshBuilder()
    col.box((-140, -140, -1), (140, 140, 0))
    col.finish(cols, 'Collision', 'COL_Ground', wire=True)

    big = BLOCK_R + 5
    kinds = {
        'Sidewalks': ([rect(ROAD, ROAD, WALK, big), rect(WALK, ROAD, big, WALK)], 'MI_Trim_MetalConcrete', 1 / 3),
        'Blocks': ([rect(WALK, WALK, big, big)], 'MI_Concrete', 1 / 4),
    }
    col = MeshBuilder()
    for kind, (polys, mat, uv_scale) in kinds.items():
        vis = MeshBuilder()
        for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
            for poly in polys:
                p = [(x * sx, y * sy) for x, y in clip_circle(poly, BLOCK_R)]
                if sx * sy < 0:
                    p.reverse()  # keep counter-clockwise
                vis.prism(p, 0, PLOT_H)
                col.prism(p, -0.5, PLOT_H, bottom=True)
        vis.finish(cols, 'Visual', f'Plot_{kind}', materials=[material(mat)], uv_scale=uv_scale)
    col.finish(cols, 'Collision', 'COL_Plots', wire=True)


def build_octagon_plot(cols, octa):
    poly = octagon(octa.apothem + 1.0)
    vis = MeshBuilder()
    vis.prism(poly, 0, PLOT_H)
    vis.finish(cols, 'Visual', f'Plot_{octa.name}', materials=[material('MI_Trim_MetalConcrete')], uv_scale=1 / 3)
    col = MeshBuilder()
    col.prism(poly, -0.5, PLOT_H, bottom=True)
    col.finish(cols, 'Collision', f'COL_Plot_{octa.name}', wire=True)


def build_props(cols, buildings):
    root = new_empty(cols, 'Props', 0, 0, 0)
    # One-storey concrete walls on the roads.
    vis, col = MeshBuilder(), MeshBuilder()
    for (x, y, along_x) in COVER + [(-x, -y, ax) for x, y, ax in COVER]:
        hx, hy = (2.0, 0.5) if along_x else (0.5, 2.0)
        vis.box((x - hx, y - hy, 0), (x + hx, y + hy, COVER_H))
        col.box((x - hx, y - hy, 0), (x + hx, y + hy, COVER_H))
    vis.finish(cols, 'Visual', 'Cover_Generated', root, materials=[material('MI_Concrete')], uv_scale=0.5)
    col.finish(cols, 'Collision', 'COL_Cover', root, wire=True)
    # AC units on the roofs of solid buildings, manholes and drains on the roads.
    for b in buildings:
        if isinstance(b, Building) and not b.enterable and not b.roof_stairs:
            m = Matrix.Translation((b.x, b.y, 0)) @ Matrix.Rotation(b.angle, 4, 'Z')
            for _ in range(b.rng.randint(1, 3)):
                (i, j) = b.rng.choice(sorted(b.cells))
                at = m @ Vector(((i + 0.5) * CELL, (j + 0.5) * CELL, b.top))
                if any(math.hypot(at.x - x, at.y - y) < 2.5 for x, y in ROOF_SPOTS):
                    continue  # keep pickup spots clear
                place(cols, kit_mesh('Prop_ACUnit'), root, m @ Matrix.Translation(((i + 0.5) * CELL, (j + 0.5) * CELL, b.top)))
    # Billboards: two posts and a panel (bullet-proof cover), across the roof
    # 1.8 m from the middle, on the side facing the centre (local -Y for
    # these 6 x 6 m buildings turned 45 degrees; their twins match).
    vis, col = MeshBuilder(), MeshBuilder()
    for b in buildings:
        if b.name not in BILLBOARD_ROOFS:
            continue
        m = Matrix.Translation((b.x, b.y, 0)) @ Matrix.Rotation(b.angle, 4, 'Z')
        z, y0, y1 = b.top, 1.1, 1.3
        for px in (1.3, 4.7):  # posts, behind the panel
            vis.box((px - 0.1, y1, z), (px + 0.1, y1 + 0.2, z + 3.3), m, 0)
            col.box((px - 0.1, y1, z), (px + 0.1, y1 + 0.2, z + 3.3), m)
        vis.box((0.8, y0, z + 0.3), (5.2, y1, z + 3.4), m, 1)  # the board
        vis.box((0.75, y0 - 0.02, z + 0.25), (5.25, y1 + 0.02, z + 0.3), m, 0)  # frame, bottom
        vis.box((0.75, y0 - 0.02, z + 3.4), (5.25, y1 + 0.02, z + 3.45), m, 0)  # frame, top
        col.box((0.8, y0, z + 0.3), (5.2, y1, z + 3.4), m)
    vis.finish(cols, 'Visual', 'Billboards_Generated', root,
               materials=[material('MI_Trim_Dark'), material('MI_Trim_Green')], uv_scale=0.5)
    col.finish(cols, 'Collision', 'COL_Billboards', root, wire=True)
    placed = 0
    while placed < 12:
        x, y = rng.uniform(-PLAY_R, PLAY_R), rng.uniform(-PLAY_R, PLAY_R)
        on_road = min(abs(x), abs(y)) < ROAD - 1
        if not on_road or math.hypot(x, y) < 10 or math.hypot(x, y) > PLAY_R - 2:
            continue
        place(cols, kit_mesh(rng.choice(['Prop_ManholeCover', 'Prop_Drain'])), root,
              Matrix.Translation((x, y, 0.005)) @ Matrix.Rotation(rng.uniform(0, 6.3), 4, 'Z'))
        placed += 1


def plain_material(name, rgb):
    """A flat-coloured material (no texture), e.g. for the boundary blocks."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.9
    return mat


def build_ring(cols):
    """The arena's boundary: plain blocky buildings (like the skyline beyond
    the map, see src/render.js) all round, entirely outside the ring line
    (where the old facades stood; local +y points away from the centre), so
    nothing reaches into the arena. Each 12 m segment is 2-3 blocks of
    different heights and depths, with a taller block outside each joint. Segment k and k + 13 face
    each other across the centre and are built the same, like the rest of
    the map."""
    root = new_empty(cols, 'Ring', 0, 0, 0)
    col = MeshBuilder()
    vis = MeshBuilder()
    half = RING_SEGMENTS // 2
    for k in range(RING_SEGMENTS):
        rand = random.Random(f'{SEED}-ring-{k % half}')
        a = 2 * math.pi * k / RING_SEGMENTS
        nx, ny = -math.cos(a), -math.sin(a)  # (rot_for_normal: local +y points away from the centre)
        cx, cy = RING_R * math.cos(a), RING_R * math.sin(a)
        m = Matrix.Translation((cx, cy, 0)) @ rot_for_normal(nx, ny)
        n = rand.choice([2, 2, 3])
        cuts = sorted(rand.uniform(-4.5, 4.5) for _ in range(n - 1))
        edges = [-6.4] + cuts + [6.4]
        for x0, x1 in zip(edges, edges[1:]):
            h = rand.uniform(7.0, 15.0)
            d = rand.uniform(5.0, 11.0)
            vis.box((x0, 0, 0), (x1, d, h), m, rand.randrange(3))
        # Joint block between segments, just outside the corner.
        ja = a + math.pi / RING_SEGMENTS
        jr = RING_R / math.cos(math.pi / RING_SEGMENTS) + 1.7
        jm = Matrix.Translation((jr * math.cos(ja), jr * math.sin(ja), 0)) @ Matrix.Rotation(ja, 4, 'Z')
        vis.box((-1.6, -1.6, 0), (1.6, 1.6, rand.uniform(10.0, 18.0)), jm, rand.randrange(3))
        col.box((-6.3, 0, -1), (6.3, 1.5, 30), m)
    vis.finish(cols, 'Visual', 'Ring_Blocks', root, uv_scale=0.25, materials=[
        # (Dark-ish: in game these are multiplied by the bright baked light.)
        # Close to the skyline's bluish grey (render.js SKYLINE), so they blend.
        plain_material('MI_Block_Grey', (0.165, 0.185, 0.215)),
        plain_material('MI_Block_Warm', (0.18, 0.175, 0.17)),
        plain_material('MI_Block_Dark', (0.13, 0.145, 0.175)),
    ])
    col.finish(cols, 'Collision', 'COL_Ring', root, wire=True)


def build_spawns(cols):
    z = PLOT_H + 0.05
    for team, sign in ((0, 1), (1, -1)):
        for k, (x, y) in enumerate(TEAM_SPAWNS):
            e = bpy.data.objects.new(f'Spawn_{"AB"[team]}_{k:02d}', None)
            e.empty_display_type = 'ARROWS'
            e.location = (x * sign, y * sign, z)
            e.rotation_euler = (0, 0, SPAWN_FACING + (math.pi if team else 0))
            e['team'] = team
            cols['Spawns'].objects.link(e)


# ---- main ----------------------------------------------------------------------

def main():
    if os.path.exists(OUT_BLEND) and not FORCE:
        print(f'{OUT_BLEND} exists; pass "-- --force" to regenerate (this discards your edits).')
        return
    cols = reset_scene()
    # Load materials used by generated geometry.
    for piece in ('Street_Asphalt_6x6', 'Sidewalk_Straight_3m', 'Stairs_Entrance_Concrete', 'Brick_InteriorWall_3', 'Floor_2x2'):
        kit_mesh(piece)

    build_ground(cols)
    # Doors NW and SE; big windows on the 4th and 5th floors; stairs to the roof.
    octa = Octagon('House08', floors=5, style='trim', door_sides=(3, 7), window_floors=(3, 4))
    build_octagon_plot(cols, octa)
    north = north_buildings()
    buildings = north + [twin(b) for b in north]
    buildings.sort(key=lambda b: b.name)
    octa.build(cols)
    for b in buildings:
        b.build(cols)
    build_ring(cols)
    build_props(cols, buildings)
    build_spawns(cols)

    os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, relative_remap=True)
    n_vis = len(cols['Visual'].objects)
    print(f'saved {os.path.relpath(OUT_BLEND, ROOT)}: {len(buildings) + 1} buildings, {n_vis} visual objects, '
          f'{len(cols["Spawns"].objects)} spawns')


main()
