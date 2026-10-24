// The map's collision: player movement (capsule vs. triangle mesh) and
// bullet raycasts, both accelerated with a BVH (three-mesh-bvh).
//
// Used by every client for its own movement and by the host for hit
// detection, so everyone collides against exactly the same geometry.
// Collision tagged "PlayerOnly" (window blockers) stops players, not bullets.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GRAVITY, JUMP_SPEED, MOVE_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS } from './shared.js';

const SUBSTEP = 1 / 120; // small steps so fast movement can't tunnel through thin walls
const WALKABLE = 0.6; // surfaces whose normal.y is above this can be stood on (~53°)
const STICK_SPEED = 4; // downward speed while grounded, keeps players on ramps/stairs

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
    this.bulletBvh = buildBVH(bulletChunks); // shooting
    this.spawns = meta.spawns;
    this.teamSpawns = meta.teamSpawns ?? [meta.spawns, meta.spawns];
    this.playRadius = meta.playRadius;
  }

  // player: { pos:[x,y,z], vel:[x,y,z], onGround }
  // input:  { forward:-1..1, right:-1..1, jump:bool, yaw }
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
    player.vel[0] = mx * MOVE_SPEED;
    player.vel[2] = mz * MOVE_SPEED;
    if (input.jump && player.onGround) {
      player.vel[1] = JUMP_SPEED;
      player.onGround = false;
    }
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
    for (let i = 0; i < steps; i++) this.substep(player, dt / steps);
  }

  substep(player, h) {
    const { pos, vel } = player;
    if (player.onGround && vel[1] <= 0) vel[1] = -STICK_SPEED;
    else vel[1] -= GRAVITY * h;

    const r = PLAYER_RADIUS;
    seg.start.set(pos[0] + vel[0] * h, pos[1] + vel[1] * h + r, pos[2] + vel[2] * h);
    seg.end.copy(seg.start).y += PLAYER_HEIGHT - 2 * r;
    box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(r);

    let grounded = false;
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
        if (dir.y > WALKABLE) {
          // Standing on it: push straight up, so slopes and stairs don't slide.
          const up = depth / dir.y;
          seg.start.y += up;
          seg.end.y += up;
          grounded = true;
        } else {
          seg.start.addScaledVector(dir, depth);
          seg.end.addScaledVector(dir, depth);
          if (dir.y < -0.5) ceiling = true;
        }
      },
    });

    pos[0] = seg.start.x;
    pos[1] = seg.start.y - r;
    pos[2] = seg.start.z;
    player.onGround = grounded;
    if (grounded && vel[1] < 0) vel[1] = 0;
    if (ceiling && vel[1] > 0) vel[1] = 0;

    // Safety net: stay inside the arena, never fall through the world.
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
