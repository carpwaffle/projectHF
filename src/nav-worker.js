// Builds the bots' navigation graph (see nav.js) from the map's collision
// triangles, in a Web Worker: it takes a few seconds, and the host tab must
// keep serving meanwhile.
//
// Nodes: places a player can stand, on a CELL grid, on every floor (roads,
// each storey, stairs, roofs). Edges: to the 8 neighbours on the grid when the
// step between them is walkable, or a drop down a ledge (one way).
//
// (Workers can't use the page's import map: full URLs.)

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import { MeshBVH } from 'https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.9.16/+esm';
import { PLAYER_HEIGHT } from './shared.js';
import { CELL } from './nav.js';

const TOP = 40; // highest point searched for floors
const CLEAR_R = 0.42; // free space needed around a node (a bit more than the player)
const STEP_UP = 0.4; // highest step between neighbours that can be walked up
const DROP = 3.5; // highest ledge that can be dropped down
const WALKABLE = 0.75; // floor normal.y (stairs' treads: flat; ramps up to ~40°)

const ray = new THREE.Ray();
const seg = new THREE.Line3();
const box = new THREE.Box3();
const p1 = new THREE.Vector3();
const p2 = new THREE.Vector3();

self.onmessage = ({ data: { positions, playRadius } }) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const bvh = new MeshBVH(geometry);
  const nav = build(bvh, playRadius);
  self.postMessage(nav, Object.values(nav).filter((v) => v?.buffer).map((v) => v.buffer));
};

function build(bvh, playRadius) {
  const half = Math.ceil((playRadius + 0.5) / CELL); // grid: -half..half per axis
  const size = half * 2 + 1;

  // Heights of the standable surfaces in a column, low to high: upward-facing
  // surfaces with room for a player above them.
  const floors = (x, z) => {
    ray.origin.set(x, TOP, z);
    ray.direction.set(0, -1, 0);
    const hits = bvh.raycast(ray, THREE.DoubleSide, 0, TOP + 5).sort((a, b) => a.distance - b.distance);
    const out = [];
    let ceiling = Infinity; // the lowest surface seen so far above
    for (const h of hits) {
      const y = h.point.y;
      if (h.face.normal.y > WALKABLE && ceiling - y > PLAYER_HEIGHT + 0.05) out.push(y);
      ceiling = y;
    }
    return out.reverse();
  };

  // Room for a player standing at (x, y, z): nothing within CLEAR_R of the
  // body (from a step above the floor to the top of the head).
  const fits = (x, y, z) => {
    seg.start.set(x, y + 0.3 + CLEAR_R, z);
    seg.end.set(x, y + PLAYER_HEIGHT - CLEAR_R, z);
    box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(CLEAR_R);
    return !bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => tri.closestPointToSegment(seg, p1, p2) < CLEAR_R,
    });
  };

  const openBelow = (x, z, top, bottom) => {
    ray.origin.set(x, top, z);
    ray.direction.set(0, -1, 0);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, top - bottom);
    return !hit || hit.distance >= top - bottom - 0.05;
  };

  // Nodes, by grid cell.
  const xs = [], ys = [], zs = [];
  const cells = new Map(); // cell index -> [node ids], low to high
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i - half) * CELL;
      const z = (j - half) * CELL;
      if (Math.hypot(x, z) > playRadius - 0.3) continue;
      const ids = [];
      for (const y of floors(x, z)) {
        if (!fits(x, y, z)) continue;
        ids.push(xs.length);
        xs.push(x); ys.push(y); zs.push(z);
      }
      if (ids.length) cells.set(j * size + i, ids);
    }
  }
  const count = xs.length;

  // Edges. Between neighbours: nothing in the way at the midpoint (diagonals:
  // so paths don't clip corners). A drop: open air above the lower floor up
  // to the higher one.
  const edges = Array.from({ length: count }, () => []);
  for (const [cell, ids] of cells) {
    const i = cell % size;
    const j = (cell - i) / size;
    for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]]) { // (each pair once; both ways below)
      const other = cells.get((j + dj) * size + (i + di));
      if (!other) continue;
      for (const a of ids) {
        for (const b of other) {
          const dy = ys[b] - ys[a];
          if (Math.abs(dy) > DROP) continue;
          const top = Math.max(ys[a], ys[b]);
          if (!fits((xs[a] + xs[b]) / 2, top, (zs[a] + zs[b]) / 2)) continue;
          if (Math.abs(dy) > STEP_UP) {
            const lo = dy > 0 ? a : b;
            if (!openBelow(xs[lo], zs[lo], top + 0.2, ys[lo])) continue;
          }
          const cost = Math.hypot(di, dj) * CELL + Math.abs(dy) * 0.5;
          if (dy <= STEP_UP) edges[a].push(b, cost); // a -> b: up at most a step (or any drop)
          if (-dy <= STEP_UP) edges[b].push(a, cost);
        }
      }
    }
  }

  // Keep the biggest connected area (drops nodes on top of walls, fences, ...).
  const comp = new Int32Array(count).fill(-1);
  let best = -1, bestSize = 0;
  for (let s = 0, c = 0; s < count; s++, c++) {
    if (comp[s] >= 0) continue;
    const stack = [s];
    comp[s] = c;
    let n = 0;
    while (stack.length) {
      const e = edges[stack.pop()];
      n += 1;
      for (let k = 0; k < e.length; k += 2) if (comp[e[k]] < 0) { comp[e[k]] = c; stack.push(e[k]); }
    }
    if (n > bestSize) { bestSize = n; best = c; }
  }
  const ok = Uint8Array.from(comp, (c) => (c === best ? 1 : 0));

  // Flat arrays (transferable): edges per node and nodes per cell.
  const edgeStart = new Int32Array(count + 1);
  for (let n = 0; n < count; n++) edgeStart[n + 1] = edgeStart[n] + edges[n].length / 2;
  const edgeTo = new Int32Array(edgeStart[count]);
  const edgeCost = new Float32Array(edgeStart[count]);
  for (let n = 0; n < count; n++) {
    const e = edges[n];
    for (let k = 0; k < e.length; k += 2) {
      edgeTo[edgeStart[n] + k / 2] = e[k];
      edgeCost[edgeStart[n] + k / 2] = e[k + 1];
    }
  }
  const cellStart = new Int32Array(size * size + 1);
  const cellNodes = new Int32Array(count);
  for (let c = 0, k = 0; c < size * size; c++) {
    cellStart[c] = k;
    for (const n of cells.get(c) ?? []) cellNodes[k++] = n;
    cellStart[c + 1] = k;
  }
  return {
    half, size,
    x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs),
    ok, edgeStart, edgeTo, edgeCost, cellStart, cellNodes,
  };
}
