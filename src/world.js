// The map's collision: player movement (capsule vs. triangle mesh) and
// bullet raycasts, both accelerated with a BVH (three-mesh-bvh).
//
// Used by every client for its own movement and by the host for hit
// detection, so everyone collides against exactly the same geometry.
// Collision tagged "PlayerOnly" (window blockers) stops players, not bullets.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GRAVITY, JUMP_SPEED, MOVE_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS, FLY_SPEED, FLY_MAX_Y } from './shared.js';

const SUBSTEP = 1 / 120; // small steps so fast movement can't tunnel through thin walls
const WALKABLE = 0.6; // surfaces whose normal.y is above this can be stood on (~53°)
const STICK_SPEED = 4; // downward speed while grounded, keeps players on ramps/stairs
const STEP_HEIGHT = 0.25; // ledges up to this high are walked onto (kerbs: 0.15), no jump needed
const NOCLIP_STEP = 0.5; // no-clip: how high a floor can be and still be stepped onto (stairs)

const seg = new THREE.Line3();
const box = new THREE.Box3();
const triPoint = new THREE.Vector3();
const capPoint = new THREE.Vector3();
const dir = new THREE.Vector3();
const triNormal = new THREE.Vector3();
const ray = new THREE.Ray();

export class World {
  // collision: an Object3D whose meshes are the collision geometry.
  // meta: { spawns: [[x,y,z,yaw?]...], teamSpawns: [[...], [...]], playRadius }
  constructor(collision, meta) {
    collision.updateMatrixWorld(true);
    const chunks = [];
    const bulletChunks = [];
    collision.traverse((o) => {
      if (!o.isMesh) return;
      // Dequantize into plain floats in world space (meshopt-quantized
      // positions are normalized ints scaled by the node transform).
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
      const src = g.getAttribute('position');
      const out = new Float32Array(src.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < src.count; i++) {
        v.fromBufferAttribute(src, i).applyMatrix4(o.matrixWorld);
        out.set([v.x, v.y, v.z], i * 3);
      }
      chunks.push(out);
      if (o.material?.name !== 'PlayerOnly') bulletChunks.push(out);
    });
    this.bvh = buildBVH(chunks); // movement
    this.flatEdges = flatEdges(chunks);
    this.bulletBvh = buildBVH(bulletChunks); // shooting
    this.spawns = meta.spawns;
    this.teamSpawns = meta.teamSpawns ?? [meta.spawns, meta.spawns];
    this.playRadius = meta.playRadius;
  }

  // player: { pos:[x,y,z], vel:[x,y,z], onGround }
  // input:  { forward:-1..1, right:-1..1, jump:bool, yaw,
  //           speed (multiplier, default 1), fly (-1..1: fly hack up / down; undefined: no fly),
  //           noclip (bool: through walls and ceilings, still standing on floors) }
  stepPlayer(player, input, dt) {
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    let mx = -sin * input.forward + cos * input.right;
    let mz = -cos * input.forward - sin * input.right;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    const speed = MOVE_SPEED * (input.speed ?? 1);
    player.vel[0] = mx * speed;
    player.vel[2] = mz * speed;
    if (input.fly !== undefined) {
      player.vel[1] = input.fly * FLY_SPEED; // hovers when neither key is held
    } else if (input.jump && player.onGround) {
      player.vel[1] = JUMP_SPEED;
      player.onGround = false;
    }
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
    for (let i = 0; i < steps; i++) {
      if (input.noclip) this.substepNoclip(player, dt / steps, input.fly !== undefined);
      else this.substep(player, dt / steps, input.fly !== undefined);
    }
  }

  // No-clip: no collision with walls or ceilings, but floors (any surface
  // below, up to a step high) are stood on, and the arena boundary holds.
  // flying (with the fly hack too): no gravity, up to the fly ceiling.
  substepNoclip(player, h, flying = false) {
    const { pos, vel } = player;
    if (flying) {
      // (vertical speed set by stepPlayer)
    } else if (player.onGround && vel[1] <= 0) vel[1] = 0;
    else vel[1] -= GRAVITY * h;
    const x = pos[0] + vel[0] * h;
    const z = pos[2] + vel[2] * h;
    let y = pos[1] + vel[1] * h;
    // The highest floor between a step above our feet and where we'd end up
    // (a little lower while grounded, to follow stairs and ramps down).
    const top = Math.max(pos[1], y) + NOCLIP_STEP;
    const bottom = Math.min(pos[1], y) - (player.onGround ? NOCLIP_STEP : 0);
    const span = top - bottom;
    const d = this.raycast([x, top, z], [0, -1, 0], span + 0.01);
    player.onGround = false;
    if (d <= span && vel[1] <= 0) {
      y = top - d;
      vel[1] = 0;
      player.onGround = true;
    }
    pos[0] = x;
    pos[1] = flying ? Math.min(FLY_MAX_Y, y) : y;
    pos[2] = z;
    this.keepInside(player);
  }

  substep(player, h, flying = false) {
    const { pos, vel } = player;
    if (flying) {
      // (vertical speed set by stepPlayer; no gravity)
    } else if (player.onGround && vel[1] <= 0) vel[1] = -STICK_SPEED;
    else vel[1] -= GRAVITY * h;

    // Edges up to STEP_HEIGHT above the floor we're standing on can be
    // stepped onto (in the air: above our feet; see collide). groundY: that
    // floor's height, kept while standing on an edge so we can't climb one
    // step at a time; taken from our feet when unknown (landed on an edge)
    // or not near them (respawned, teleported).
    let g = player.onGround && !flying ? player.groundY : undefined;
    if (player.onGround && !flying && (g === undefined || pos[1] - g < -0.05 || pos[1] - g > STEP_HEIGHT + 0.01)) g = pos[1];
    const hit = this.collide(pos[0] + vel[0] * h, pos[1] + vel[1] * h, pos[2] + vel[2] * h, g ?? pos[1]);
    player.groundY = hit.onFloor ? hit.y : hit.grounded ? g ?? hit.y : undefined;

    pos[0] = hit.x;
    pos[1] = hit.y;
    pos[2] = hit.z;
    player.onGround = hit.grounded;
    if (hit.grounded && vel[1] < 0) vel[1] = 0;
    if (hit.ceiling && vel[1] > 0) vel[1] = 0;
    if (flying && pos[1] > FLY_MAX_Y) {
      pos[1] = FLY_MAX_Y;
      vel[1] = 0;
    }
    this.keepInside(player);
  }

  // The player's capsule with its feet at (x, y, z), pushed out of the map:
  // where it ends up, whether it stands on something (grounded; onFloor: on
  // a floor or slope, not just an edge) or hit a ceiling. ref: the feet
  // height that ledges are measured from.
  collide(x, y, z, ref = y) {
    const r = PLAYER_RADIUS;
    seg.start.set(x, y + r, z);
    seg.end.copy(seg.start).y += PLAYER_HEIGHT - 2 * r;
    box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(r);

    let grounded = false;
    let onFloor = false;
    let ceiling = false;
    this.bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => {
        const distance = tri.closestPointToSegment(seg, triPoint, capPoint);
        if (distance >= r) return;
        const depth = r - distance;
        if (distance > 1e-6) {
          dir.subVectors(capPoint, triPoint).divideScalar(distance);
        } else {
          tri.getNormal(triNormal);
          dir.copy(triNormal);
          capPoint.copy(seg.start).add(seg.end).multiplyScalar(0.5);
          if (dir.dot(capPoint.sub(triPoint)) < 0) dir.negate();
        }
        // Touching a face, or an edge (a corner of a box: a kerb, a sill)?
        // The capsule's round bottom rides up any edge it's pushed into hard
        // enough, and fast moves sink into a block's top, so how high you got
        // depended on speed and angle (the speed hack took window sills, slow
        // runs stopped at kerbs). Instead: floors, and level or gently sloped
        // edges (a kerb, a ramp's side; not a wall's vertical corner), up to
        // STEP_HEIGHT above ref are stepped onto; higher ones push back level.
        const face = distance <= 1e-6 || Math.abs(dir.dot(tri.getNormal(triNormal))) > 0.999;
        const edge = face ? null : edgeAt(tri, triPoint, this.flatEdges);
        if (edge === 'flat') return; // (the diagonal inside a flat quad: its other half pushes)
        const ledge = face ? dir.y > WALKABLE : dir.y > 0 && edge === 'level';
        if (ledge && triPoint.y - ref <= STEP_HEIGHT) {
          // Standing on it: push straight up, so slopes and stairs don't slide
          // (onto an edge: no higher than the edge).
          const up = face ? depth / dir.y : Math.min(depth / dir.y, triPoint.y - (seg.start.y - r));
          seg.start.y += up;
          seg.end.y += up;
          grounded = true;
          if (face || dir.y > WALKABLE) onFloor = true; // (on an edge with the capsule's middle off it: not yet)
        } else {
          if (dir.y > 0) dir.setY(0).normalize(); // (below the capsule's middle: level, not riding up)
          seg.start.addScaledVector(dir, depth);
          seg.end.addScaledVector(dir, depth);
          if (dir.y < -0.5) ceiling = true;
        }
      },
    });
    return { x: seg.start.x, y: seg.start.y - r, z: seg.start.z, grounded, onFloor, ceiling };
  }

  // Safety net: stay inside the arena, never fall through the world.
  keepInside(player) {
    const { pos, vel } = player;
    const d = Math.hypot(pos[0], pos[2]);
    if (d > this.playRadius) {
      pos[0] *= this.playRadius / d;
      pos[2] *= this.playRadius / d;
    }
    if (pos[1] < -5) {
      pos[1] = 1;
      vel[1] = 0;
    }
  }

  // Distance to the first map surface along a (normalised) ray, capped at maxDist.
  raycast(origin, direction, maxDist) {
    ray.origin.set(...origin);
    ray.direction.set(...direction);
    const hit = this.bulletBvh.raycastFirst(ray, THREE.DoubleSide, 0, maxDist);
    return hit ? Math.min(hit.distance, maxDist) : maxDist;
  }
}

// What p, a point on the triangle's boundary, lies on: 'flat' (an edge
// between two triangles in the same plane, like a wall quad's diagonal: not a
// real edge), 'level' (a level or gently sloped edge, or the top corner) or
// 'steep' (like a wall's vertical corner).
const edgeDir = new THREE.Vector3();
const onEdge = new THREE.Vector3();
function edgeAt(tri, p, flat) {
  for (const [a, b] of [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]]) {
    edgeDir.subVectors(b, a);
    const len2 = edgeDir.lengthSq();
    const t = THREE.MathUtils.clamp(onEdge.subVectors(p, a).dot(edgeDir) / len2, 0, 1);
    if (onEdge.copy(a).addScaledVector(edgeDir, t).distanceToSquared(p) > 1e-6) continue;
    if (t > 1e-3 && t < 1 - 1e-3) {
      if (flat.has(edgeKey(a.x, a.y, a.z, b.x, b.y, b.z))) return 'flat';
      return Math.abs(edgeDir.y) / Math.sqrt(len2) < 0.7 ? 'level' : 'steep'; // (under ~45°)
    }
    return Math.max(tri.a.y, tri.b.y, tri.c.y) - p.y < 0.01 ? 'level' : 'steep';
  }
  return 'steep';
}

const edgeKey = (ax, ay, az, bx, by, bz) => {
  const a = `${Math.round(ax * 1000)},${Math.round(ay * 1000)},${Math.round(az * 1000)}`;
  const b = `${Math.round(bx * 1000)},${Math.round(by * 1000)},${Math.round(bz * 1000)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

// The edges shared by two triangles in the same plane (see edgeAt).
function flatEdges(chunks) {
  const normals = new Map(); // edge key -> normal of the first triangle with it
  const flat = new Set();
  const tri = new THREE.Triangle();
  const n = new THREE.Vector3();
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 9) {
      tri.a.fromArray(c, i);
      tri.b.fromArray(c, i + 3);
      tri.c.fromArray(c, i + 6);
      tri.getNormal(n);
      for (const [a, b] of [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]]) {
        const key = edgeKey(a.x, a.y, a.z, b.x, b.y, b.z);
        const other = normals.get(key);
        if (!other) normals.set(key, n.clone());
        else if (Math.abs(other.dot(n)) > 0.999) flat.add(key);
      }
    }
  }
  return flat;
}

function buildBVH(chunks) {
  const positions = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    positions.set(c, offset);
    offset += c.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new MeshBVH(geometry);
}
