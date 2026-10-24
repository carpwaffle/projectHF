"""Generate the Downtown map as an editable Blender file (maps/downtown.blend).

Run once from the project root (it refuses to overwrite an existing map
unless you pass --force, so your Blender edits are safe):

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      --python tools/map_generator.py [-- --force] [-- --seed N]

Then refine the map in Blender and export it with `npm run build:map`.

Layout (metres, Blender coordinates: X east, Y north, Z up; origin = map centre):
  - Circular arena: a ring of inward-facing 2-3 storey facades around it.
  - Centre building: 16x16 m, 3 storeys, enterable, stairs up to the top floor.
  - Quadrant building: L-shaped, 2 storeys, enterable, wrapping a courtyard
    in the north-east quarter.
  - Random 1-2 storey buildings at random angles, so streets are irregular.
    A few have outside stairs to a rooftop.

Blender file structure (what to edit):
  Buildings   one Empty per building; move/rotate it to move the whole building
  Visual      everything that's drawn (kit pieces + generated stairs, ground,
              sidewalks). Kit pieces are linked duplicates of the kit meshes.
  Collision   simple shapes the game uses for movement and bullets (drawn as
              wireframe here, invisible in game). Keep them in sync when you
              move walls around.
  Spawns      Empties named Spawn_XX where players can spawn.
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
PLOT_H = 0.15  # sidewalk / building plot height above the street
SIDEWALK = 1.5
RING_SEGMENTS = 26
RING_SEG_LEN = 12.0
RING_R = (RING_SEG_LEN / 2) / math.tan(math.pi / RING_SEGMENTS)  # ~49.5 m to the facades
PLAY_R = RING_R - 1.0

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

    def prism(self, polygon, z0, z1, matrix=Matrix.Identity(4), mat_index=0, bottom=False):
        """Vertical extrusion of a 2D polygon (counter-clockwise)."""
        lo = [self.bm.verts.new(matrix @ Vector((x, y, z0))) for x, y in polygon]
        hi = [self.bm.verts.new(matrix @ Vector((x, y, z1))) for x, y in polygon]
        faces = [self.bm.faces.new(hi)]
        if bottom:
            faces.append(self.bm.faces.new(list(reversed(lo))))
        n = len(polygon)
        for i in range(n):
            j = (i + 1) % n
            faces.append(self.bm.faces.new((lo[i], lo[j], hi[j], hi[i])))
        for f in faces:
            f.material_index = mat_index

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


# ---- buildings -----------------------------------------------------------------

DIRS = {'E': (1, 0), 'W': (-1, 0), 'N': (0, 1), 'S': (0, -1)}


class Building:
    """A building on a 2 m cell grid in its own local frame.

    cells: set of (i, j); cell (i, j) spans x in [2i, 2i+2], y in [2j, 2j+2].
    doors: set of (i, j, side) ground-floor door edges.
    stairs: list of (floor, [(i, j), ...], direction) flights, 3 cells long.
    partitions: list of ('x'|'y', line, from, to, door_from) interior walls.
    cover: list of (floor, i, j, along_x) low walls.
    """

    def __init__(self, name, x, y, angle, cells, floors, style, enterable,
                 doors=(), stairs=(), partitions=(), cover=(), roof_stairs=None):
        self.name, self.x, self.y, self.angle = name, x, y, angle
        self.cells = set(cells)
        self.floors = floors
        self.style = STYLES[style]
        self.enterable = enterable
        self.doors = set(doors)
        self.stairs = list(stairs)
        self.partitions = list(partitions)
        self.cover = list(cover)
        self.roof_stairs = roof_stairs  # (side, offset_cells) for an outside stair to the roof
        self.top = PLOT_H + floors * FLOOR_H

    def boundary(self):
        """Exterior edges: (i, j, side, nx, ny, mid_x, mid_y)."""
        out = []
        for (i, j) in sorted(self.cells):
            for side, (dx, dy) in DIRS.items():
                if (i + dx, j + dy) in self.cells:
                    continue
                cx, cy = (i + 0.5) * CELL, (j + 0.5) * CELL
                out.append((i, j, side, dx, dy, cx + dx * CELL / 2, cy + dy * CELL / 2))
        return out

    def corners(self):
        """Grid points where the outline turns (convex or concave corners)."""
        count = {}
        for (i, j, side, dx, dy, mx, my) in self.boundary():
            if dx:  # vertical edge: endpoints differ in y
                pts = [(mx, my - CELL / 2), (mx, my + CELL / 2)]
                orient = 'v'
            else:
                pts = [(mx - CELL / 2, my), (mx + CELL / 2, my)]
                orient = 'h'
            for p in pts:
                key = (round(p[0], 3), round(p[1], 3))
                count.setdefault(key, set()).add(orient)
        return [p for p, o in count.items() if len(o) == 2]

    def footprint_rects(self):
        """Merge cells into rectangles row by row (for slabs / collision)."""
        rows = {}
        for (i, j) in self.cells:
            rows.setdefault(j, []).append(i)
        rects = []
        for j, xs in rows.items():
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
        vis = MeshBuilder()  # generated visual geometry (stairs, partitions, cover)
        col = MeshBuilder()
        st = self.style
        openings = {(i, j, f): set() for f in range(self.floors) for (i, j) in self.cells}
        for (floor, cells, _) in self.stairs:
            for (i, j) in cells:
                openings.setdefault((i, j, floor + 1), set()).add('stair')
        roof_gap = set()
        if self.roof_stairs:
            roof_gap = self.build_roof_stairs(cols, root, vis, col)

        # Exterior walls, floor by floor.
        for f in range(self.floors):
            z = PLOT_H + f * FLOOR_H
            for (i, j, side, dx, dy, mx, my) in self.boundary():
                local = Matrix.Translation((mx, my, z)) @ rot_for_normal(dx, dy)
                if self.enterable:
                    if f == 0 and (i, j, side) in self.doors:
                        mesh = open_mesh(st['door'])
                    elif rng.random() < (0.35 if f == 0 else 0.55):
                        mesh = open_mesh(st['ground_window'] if f == 0 else st['window'])
                    else:
                        mesh = kit_mesh(st['wall'])
                    place(cols, mesh, root, local)
                    self.wall_collision(col, mesh.name, local)
                else:
                    r = rng.random()
                    name = st['wall'] if r > (0.45 if f == 0 else 0.6) else (st['ground_window'] if f == 0 else st['window'])
                    place(cols, kit_mesh(name), root, local)
            for (cx, cy) in self.corners():
                place(cols, kit_mesh(st['column']), root, Matrix.Translation((cx, cy, z)))

        # Floors (enterable buildings only) and roof.
        floor_mesh = kit_mesh('Floor_2x2')
        roof_mesh = kit_mesh('Roof_2x2')
        for (i, j) in self.cells:
            cx, cy = (i + 0.5) * CELL, (j + 0.5) * CELL
            if self.enterable:
                for f in range(self.floors + 1):  # floors[0] is ground, last is the top ceiling
                    if 'stair' in openings.get((i, j, f), ()):
                        continue
                    z = PLOT_H + f * FLOOR_H + (0.01 if f == 0 else 0)
                    place(cols, floor_mesh, root, Matrix.Translation((cx, cy, z)))
                    if f > 0:
                        col.box((i * CELL, j * CELL, z - 0.2), ((i + 1) * CELL, (j + 1) * CELL, z))
            place(cols, roof_mesh, root, Matrix.Translation((cx, cy, self.top + 0.21)))

        # Parapet around the roof.
        for (i, j, side, dx, dy, mx, my) in self.boundary():
            if (i, j, side) in roof_gap:
                continue
            local = Matrix.Translation((mx, my, self.top)) @ rot_for_normal(dx, dy)
            place(cols, kit_mesh(st['parapet']), root, local)
            if self.roof_stairs:
                col.box((-1, 0, 0), (1, 0.2, 1.0), local)

        if not self.enterable:
            for (x0, y0, x1, y1) in self.footprint_rects():
                col.box((x0, y0, PLOT_H), (x1, y1, self.top + 0.01))

        self.build_interior(cols, root, vis, col)

        if vis.bm.faces:
            vis.finish(cols, 'Visual', f'{self.name}_Generated', root,
                       materials=[material('MI_Concrete'), material('MI_InteriorWall')])
        else:
            vis.bm.free()
        col.finish(cols, 'Collision', f'COL_{self.name}', root, wire=True)
        return root

    def wall_collision(self, col, mesh_name, local):
        """Wall slab, with a hole where the piece has an opening."""
        hole = OPENINGS.get(mesh_name)
        if not hole:
            col.box((-1, 0, 0), (1, 0.2, FLOOR_H), local)
            return
        x0, x1, z0, z1 = hole
        col.box((-1, 0, 0), (x0, 0.2, FLOOR_H), local)
        col.box((x1, 0, 0), (1, 0.2, FLOOR_H), local)
        col.box((x0, 0, 0), (x1, 0.2, z0), local)
        col.box((x0, 0, z1), (x1, 0.2, FLOOR_H), local)

    def build_interior(self, cols, root, vis, col):
        # Staircases: solid concrete steps (visual) + a ramp (collision).
        for (floor, cells, (di, dj)) in self.stairs:
            i0, j0 = cells[0]
            z0 = PLOT_H + floor * FLOOR_H
            # Frame: origin at the start cell's back edge, +Y along the run.
            cx, cy = (i0 + 0.5) * CELL - di * CELL / 2, (j0 + 0.5) * CELL - dj * CELL / 2
            frame = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(math.atan2(-di, dj), 4, 'Z')
            run = len(cells) * CELL
            steps = 15
            for s in range(steps):
                vis.box((-0.95, s * run / steps, z0), (0.95, (s + 1) * run / steps, z0 + (s + 1) * FLOOR_H / steps), frame, 0)
            col.wedge(-0.95, 0.95, 0, run, z0, z0 + FLOOR_H, frame)

        # Interior walls with a doorway, on every floor.
        for (axis, line, a, b, door) in self.partitions:
            for f in range(self.floors):
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
        edges = sorted([e for e in self.boundary() if e[2] == side], key=lambda e: (e[0], e[1]))
        run_edges = edges[offset:offset + 3]
        (i, j, _, dx, dy, mx, my) = run_edges[0]
        (i2, j2, _, _, _, mx2, my2) = run_edges[-1]
        # Run direction along the wall, outward offset 1 m from the wall.
        ux, uy = (mx2 - mx), (my2 - my)
        length = math.hypot(ux, uy) or 1
        ux, uy = ux / length, uy / length
        sx, sy = mx - ux * CELL / 2 + dx * 1.0, my - uy * CELL / 2 + dy * 1.0
        frame = Matrix.Translation((sx, sy, 0)) @ Matrix.Rotation(math.atan2(-ux, uy), 4, 'Z')
        run = 3 * CELL
        rise = self.top - PLOT_H
        steps = 15
        for s in range(steps):
            vis.box((-0.9, s * run / steps, PLOT_H), (0.9, (s + 1) * run / steps, PLOT_H + (s + 1) * rise / steps), frame, 0)
        col.wedge(-0.9, 0.9, 0, run, PLOT_H, PLOT_H + rise, frame)
        # Landing at the top over the last cell's edge, so players step onto the roof.
        top_edge = run_edges[-1]
        return {(top_edge[0], top_edge[1], side)}


# ---- map layout ----------------------------------------------------------------

def rect_cells(x0, y0, x1, y1):
    return {(i, j) for i in range(int(x0 / CELL), int(x1 / CELL)) for j in range(int(y0 / CELL), int(y1 / CELL))}


def obb_corners(cx, cy, hw, hd, angle):
    c, s = math.cos(angle), math.sin(angle)
    return [(cx + c * x - s * y, cy + s * x + c * y) for x, y in ((-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd))]


def obb_overlap(a, b):
    """Separating axis test for two convex quads (lists of 4 corners)."""
    for poly in (a, b):
        for k in range(4):
            x0, y0 = poly[k]
            x1, y1 = poly[(k + 1) % 4]
            nx, ny = y1 - y0, x0 - x1
            pa = [nx * x + ny * y for x, y in a]
            pb = [nx * x + ny * y for x, y in b]
            if max(pa) < min(pb) or max(pb) < min(pa):
                return False
    return True


def point_in_poly(px, py, poly):
    inside = False
    n = len(poly)
    for k in range(n):
        x0, y0 = poly[k]
        x1, y1 = poly[(k + 1) % n]
        if (y0 > py) != (y1 > py) and px < x0 + (py - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def centre_building():
    cells = rect_cells(-8, -8, 8, 8)
    return Building(
        'Centre', 0, 0, 0, cells, floors=3, style='trim', enterable=True,
        doors={(0, -4, 'S'), (-1, 3, 'N'), (3, 0, 'E'), (-4, -1, 'W')},
        stairs=[(0, [(3, -3), (3, -2), (3, -1)], (0, 1)),  # ground -> 1st, along the east wall
                (1, [(-4, 0), (-4, 1), (-4, 2)], (0, 1))],  # 1st -> 2nd, along the west wall
        partitions=[('x', 0.0, -7.8, -2.2, -5.0)],
        cover=[(0, -2, 1, True), (0, 1, -2, False), (1, 0, -2, True), (1, 1, 2, False),
               (2, -1, 0, False), (2, 1, -2, True), (2, -2, 2, True)],
    )


def quadrant_building():
    # Two wings around a courtyard in the north-east quarter.
    cells = rect_cells(10, 10, 42, 22) | rect_cells(10, 22, 22, 42)
    return Building(
        'Quadrant', 0, 0, 0, cells, floors=2, style='brick', enterable=True,
        doors={(8, 5, 'S'), (14, 5, 'S'), (19, 5, 'S'), (5, 7, 'W'), (5, 15, 'W'),
               (13, 10, 'N'), (18, 10, 'N'), (10, 14, 'E'), (10, 19, 'E'), (20, 7, 'E'), (7, 20, 'N')},
        stairs=[(0, [(14, 6), (15, 6), (16, 6)], (1, 0)),
                (0, [(6, 11), (6, 12), (6, 13)], (0, 1))],
        partitions=[('x', 26.0, 10.2, 21.8, 15.2), ('x', 36.0, 10.2, 21.8, 18.2), ('y', 30.0, 10.2, 21.8, 15.2)],
        cover=[(0, 9, 8, True), (0, 11, 7, False), (0, 18, 8, True), (0, 7, 18, False),
               (1, 11, 8, True), (1, 19, 7, False), (1, 8, 17, True), (1, 7, 9, False)],
    )


def quadrant_plaza():
    """Courtyard + plot of the quadrant building: square clipped by the ring."""
    start = 8.5
    edge = math.sqrt(RING_R ** 2 - start ** 2)
    a0, a1 = math.atan2(start, edge), math.atan2(edge, start)
    arc = [(RING_R * math.cos(a0 + (a1 - a0) * k / 24), RING_R * math.sin(a0 + (a1 - a0) * k / 24)) for k in range(25)]
    return [(start, start)] + arc


def random_buildings(blocked):
    """Rejection-sample small buildings at random angles."""
    out = []
    plots = list(blocked)
    styles = list(STYLES)
    for attempt in range(8000):
        if len(out) >= 22:
            break
        w = rng.choice([4, 6, 6, 8, 8, 10])
        d = rng.choice([4, 6, 6, 8])
        angle = math.radians(rng.uniform(-35, 35) + rng.choice([0, 90]))
        r = rng.uniform(13, PLAY_R - 4)
        a = rng.uniform(0, 2 * math.pi)
        cx, cy = r * math.cos(a), r * math.sin(a)
        walk = 1.0  # narrower sidewalks than the two main buildings
        plot = obb_corners(cx, cy, w / 2 + walk, d / 2 + walk, angle)
        if any(math.hypot(x, y) > PLAY_R - 1.5 for x, y in plot):
            continue  # leaves at least a narrow alley to the outer ring
        gap = rng.uniform(3.0, 7.0) / 2  # half the street width to the neighbours
        padded = obb_corners(cx, cy, w / 2 + walk + gap, d / 2 + walk + gap, angle)
        if any(obb_overlap(padded, p) for p in plots):
            continue
        plots.append(plot)
        floors = rng.choice([1, 1, 2])
        roof = None
        if floors == 1 and w >= 6 and sum(1 for b in out if b[0].roof_stairs) < 3:
            roof = ('S', 0)
        # Local frame: building centred on (cx, cy); cells from (-w/2, -d/2).
        cells = rect_cells(0, 0, w, d)
        c, s = math.cos(angle), math.sin(angle)
        ox, oy = cx - c * w / 2 + s * d / 2, cy - s * w / 2 - c * d / 2
        b = Building(f'House_{len(out):02d}', ox, oy, angle, cells, floors, rng.choice(styles), False, roof_stairs=roof)
        out.append((b, plot))
    return out


# ---- ground, plots, ring, props, spawns ----------------------------------------

def build_ground(cols):
    vis = MeshBuilder()
    n = 96
    verts = [vis.bm.verts.new((130 * math.cos(2 * math.pi * k / n), 130 * math.sin(2 * math.pi * k / n), 0)) for k in range(n)]
    vis.bm.faces.new(verts)
    vis.finish(cols, 'Visual', 'Ground', materials=[material('MI_Asphalt')], uv_scale=1 / 6)
    col = MeshBuilder()
    col.box((-140, -140, -1), (140, 140, 0))
    col.finish(cols, 'Collision', 'COL_Ground', wire=True)


def build_plot(cols, name, polygon, matrix=Matrix.Identity(4)):
    vis = MeshBuilder()
    vis.prism(polygon, 0, PLOT_H, matrix)
    vis.finish(cols, 'Visual', f'Plot_{name}', materials=[material('MI_Trim_MetalConcrete')], uv_scale=1 / 3)
    col = MeshBuilder()
    col.prism(polygon, -0.5, PLOT_H, matrix, bottom=True)
    col.finish(cols, 'Collision', f'COL_Plot_{name}', wire=True)


def build_ring(cols):
    root = new_empty(cols, 'Ring', 0, 0, 0)
    col = MeshBuilder()
    styles = list(STYLES.values())
    for k in range(RING_SEGMENTS):
        a = 2 * math.pi * k / RING_SEGMENTS
        nx, ny = -math.cos(a), -math.sin(a)  # facades face the centre
        tx, ty = -math.sin(a), math.cos(a)
        cx, cy = RING_R * math.cos(a), RING_R * math.sin(a)
        st = rng.choice(styles)
        floors = rng.choice([2, 2, 3])
        rot = rot_for_normal(nx, ny)
        for f in range(floors):
            for p in range(6):
                off = -5 + 2 * p
                name = st['wall'] if rng.random() > 0.55 else (st['ground_window'] if f == 0 else st['window'])
                local = Matrix.Translation((cx + tx * off, cy + ty * off, f * FLOOR_H)) @ rot
                place(cols, kit_mesh(name), root, local)
        for p in range(6):
            off = -5 + 2 * p
            place(cols, kit_mesh(st['parapet']), root, Matrix.Translation((cx + tx * off, cy + ty * off, floors * FLOOR_H)) @ rot)
        # Joint column between segments.
        ja = a + math.pi / RING_SEGMENTS
        jr = RING_R / math.cos(math.pi / RING_SEGMENTS)
        for f in range(3):
            place(cols, kit_mesh('Metal_Column_Center'), root, Matrix.Translation((jr * math.cos(ja), jr * math.sin(ja), f * FLOOR_H)))
        col.box((-6.3, 0, -1), (6.3, 1.5, 30), Matrix.Translation((cx, cy, 0)) @ rot)
    col.finish(cols, 'Collision', 'COL_Ring', root, wire=True)


def build_props(cols, buildings, plots):
    root = new_empty(cols, 'Props', 0, 0, 0)
    # Planters in the courtyard (cover).
    for (x, y) in [(28, 28), (33, 25), (25, 34), (31, 33), (37, 30), (27, 40)]:
        place(cols, kit_mesh('Prop_Planter_Single'), root, Matrix.Translation((x, y, PLOT_H)))
    col = MeshBuilder()
    for (x, y) in [(28, 28), (33, 25), (25, 34), (31, 33), (37, 30), (27, 40)]:
        col.box((x - 1, y - 1, PLOT_H), (x + 1, y + 1, PLOT_H + 0.6))
    col.finish(cols, 'Collision', 'COL_Props', root, wire=True)
    # AC units on flat roofs, manholes and drains on the streets.
    for b in buildings:
        if not b.enterable and not b.roof_stairs:
            m = Matrix.Translation((b.x, b.y, 0)) @ Matrix.Rotation(b.angle, 4, 'Z')
            for _ in range(rng.randint(1, 3)):
                (i, j) = rng.choice(sorted(b.cells))
                place(cols, kit_mesh('Prop_ACUnit'), root, m @ Matrix.Translation(((i + 0.5) * CELL, (j + 0.5) * CELL, b.top)))
    for _ in range(14):
        for _try in range(50):
            r, a = rng.uniform(5, PLAY_R - 3), rng.uniform(0, 2 * math.pi)
            x, y = r * math.cos(a), r * math.sin(a)
            if not any(point_in_poly(x, y, p) for p in plots):
                place(cols, kit_mesh(rng.choice(['Prop_ManholeCover', 'Prop_Drain'])), root,
                      Matrix.Translation((x, y, 0.005)) @ Matrix.Rotation(rng.uniform(0, 6.3), 4, 'Z'))
                break


def build_spawns(cols, plots, plaza):
    spawns = []
    for _try in range(5000):
        if len(spawns) >= 16:
            break
        r, a = math.sqrt(rng.uniform(0, 1)) * (PLAY_R - 3), rng.uniform(0, 2 * math.pi)
        x, y = r * math.cos(a), r * math.sin(a)
        if any(point_in_poly(x, y, p) for p in plots):
            continue
        in_plaza = point_in_poly(x, y, plaza)
        if in_plaza and (x < 23 or y < 23):
            continue  # the quadrant building itself (only its courtyard is open)
        if any(math.hypot(x - sx, y - sy) < 9 for sx, sy, _ in spawns):
            continue
        spawns.append((x, y, PLOT_H if in_plaza else 0.0))
    for k, (x, y, z) in enumerate(spawns):
        e = bpy.data.objects.new(f'Spawn_{k:02d}', None)
        e.empty_display_type = 'SINGLE_ARROW'
        e.location = (x, y, z)
        cols['Spawns'].objects.link(e)


# ---- main ----------------------------------------------------------------------

def main():
    if os.path.exists(OUT_BLEND) and not FORCE:
        print(f'{OUT_BLEND} exists; pass "-- --force" to regenerate (this discards your edits).')
        return
    cols = reset_scene()
    # Load materials used by generated geometry.
    for piece in ('Street_Asphalt_6x6', 'Sidewalk_Straight_3m', 'Stairs_Entrance_Concrete', 'Brick_InteriorWall_3'):
        kit_mesh(piece)

    build_ground(cols)
    centre = centre_building()
    quad = quadrant_building()
    plaza = quadrant_plaza()

    centre_plot = obb_corners(0, 0, 8 + SIDEWALK, 8 + SIDEWALK, 0)
    build_plot(cols, 'Centre', centre_plot)
    build_plot(cols, 'Quadrant', plaza)

    # Keep random buildings out of the centre street ring and the quadrant.
    blocked = [obb_corners(0, 0, 8 + SIDEWALK + 4.5, 8 + SIDEWALK + 4.5, 0), [(4.0, 4.0), (60, 4.0), (60, 60), (4.0, 60)]]
    houses = random_buildings(blocked)

    buildings = [centre, quad] + [b for b, _ in houses]
    for b in buildings:
        b.build(cols)
    for b, plot in houses:
        build_plot(cols, b.name, plot)
    build_ring(cols)
    plots = [centre_plot] + [p for _, p in houses]
    build_props(cols, buildings, plots + [plaza])
    build_spawns(cols, plots, plaza)

    os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, relative_remap=True)
    n_vis = len(cols['Visual'].objects)
    print(f'saved {os.path.relpath(OUT_BLEND, ROOT)}: {len(buildings)} buildings, {n_vis} visual objects, '
          f'{len(cols["Spawns"].objects)} spawns; openings: ' +
          ', '.join(f'{k}={tuple(round(v, 2) for v in o)}' for k, o in OPENINGS.items()))


main()
