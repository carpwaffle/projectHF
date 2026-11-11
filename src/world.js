// The map's collision: player movement (capsule vs. triangle mesh) and
// bullet raycasts, both accelerated with a BVH (three-mesh-bvh).
//
// Used by every client for its own movement and by the host for hit
// detection, so everyone collides against exactly the same geometry.
// Collision tagged "PlayerOnly" (window blockers) stops players, not bullets.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GRAVITY, JUMP_SPEED, MOVE_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS, FLY_SPEED, FLY_MAX_Y, CROUCH_HEIGHT, CROUCH_SPEED, CLIMB_SPEED, SMOKE } from './shared.js';

const SUBSTEP = 1 / 120; // small steps so fast movement can't tunnel through thin walls
const WALKABLE = 0.6; // surfaces whose normal.y is above this can be stood on (~53°)
const STICK_SPEED = 4; // downward speed while grounded, keeps players on ramps/stairs
const STEP_HEIGHT = 0.25; // ledges up to this high are walked onto (kerbs: 0.15), no jump needed
const NOCLIP_STEP = 0.5; // no-clip: how high a floor can be and still be stepped onto (stairs)
const NOCLIP_EDGE = 0.8; // m no-clip keeps inside the play area's edge (the boundary walls': the camera saw inside them)
const NOCLIP_FLOOR_SEARCH = 8; // m below the feet a floor must be, underground (else: solid earth behind the canal's / subway's walls)
// Ladders: the climbing area in front of one (m from its plane, beyond its
// sides, below its foot / above its top).
const LADDER_REACH = 0.85;
const LADDER_SIDE = 0.25;
const LADDER_ENDS = 0.3;
const LADDER_LET_GO = 0.4; // s after jumping off a ladder before it can be grabbed again
const LADDER_STANDOFF = PLAYER_RADIUS + 0.1; // (m) from the ladder's plane while not pushing against it

const seg = new THREE.Line3();
const box = new THREE.Box3();
const triPoint = new THREE.Vector3();
const capPoint = new THREE.Vector3();
const dir = new THREE.Vector3();
const triNormal = new THREE.Vector3();
const ray = new THREE.Ray();

export class World {
  // collision: an Object3D whose meshes are the collision geometry.
  // meta: { spawns: [[x,y,z,yaw?]...], teamSpawns: [[...], [...]],
  //         playBounds: [x0, z0, x1, z1], ladders, zones (see tools/export_map.py) }
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
    this.playBounds = meta.playBounds;
    // How far the play area reaches from the centre along x or z (the
    // minimap, the bots' navigation grid).
    this.extent = Math.max(...this.playBounds.map(Math.abs));
    this.ladders = meta.ladders; // [{ p: [x, z] on its plane, n: [x, z] towards the climber, w: half width, y0, y1 }]
    this.zones = meta.zones;
    this.metal = meta.metal; // [{ rect: [x0, z0, x1, z1], y: [lo, hi] }]: metal floors
  }

  // Standing on a metal floor (footstep sound)?
  onMetal(pos) {
    return this.metal.some(({ rect: [x0, z0, x1, z1], y: [lo, hi] }) =>
      pos[0] >= x0 && pos[0] <= x1 && pos[2] >= z0 && pos[2] <= z1 && pos[1] >= lo && pos[1] <= hi);
  }

  // (x, z) moved inside the play area.
  clampXZ(x, z, margin = 0) {
    const [x0, z0, x1, z1] = this.playBounds;
    return [Math.min(x1 - margin, Math.max(x0 + margin, x)), Math.min(z1 - margin, Math.max(z0 + margin, z))];
  }

  inside(x, z, margin = 0) {
    const [x0, z0, x1, z1] = this.playBounds;
    return x >= x0 + margin && x <= x1 - margin && z >= z0 + margin && z <= z1 - margin;
  }

  // The ladder whose climbing area the feet at pos are in, or null.
  ladderAt(pos) {
    for (const l of this.ladders) {
      const dx = pos[0] - l.p[0];
      const dz = pos[2] - l.p[1];
      const front = dx * l.n[0] + dz * l.n[1];
      const side = -dx * l.n[1] + dz * l.n[0];
      if (front >= -0.05 && front <= LADDER_REACH && Math.abs(side) <= l.w + LADDER_SIDE
        && pos[1] >= l.y0 - LADDER_ENDS && pos[1] <= l.y1 + LADDER_ENDS) return l;
    }
    return null;
  }

  // The callout zone at pos (main.js shows its name), or null: ones limited
  // to a height range first, then the smallest.
  zoneAt(pos) {
    let best = null;
    let bestScore = Infinity;
    for (const z of this.zones) {
      const [x0, z0, x1, z1] = z.rect;
      if (pos[0] < x0 || pos[0] > x1 || pos[2] < z0 || pos[2] > z1) continue;
      if (z.y && (pos[1] < z.y[0] || pos[1] > z.y[1])) continue;
      const score = (x1 - x0) * (z1 - z0) - (z.y ? 1e6 : 0);
      if (score < bestScore) {
        best = z;
        bestScore = score;
      }
    }
    return best;
  }

  // player: { pos:[x,y,z], vel:[x,y,z], onGround, crouched, climbing (set here) }
  // input:  { forward:-1..1, right:-1..1, jump:bool, yaw,
  //           speed (multiplier, default 1), jumpHeight (multiplier, default 1), fly (-1..1: fly hack up / down; undefined: no fly),
  //           noclip (bool: through walls and ceilings, still standing on floors),
  //           crouch (bool: held; standing up again waits for headroom) }
  stepPlayer(player, input, dt) {
    if (input.crouch) player.crouched = true;
    else if (player.crouched && (input.noclip || this.canStand(player.pos))) player.crouched = false;
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    let mx = -sin * input.forward + cos * input.right;
    let mz = -cos * input.forward - sin * input.right;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    const speed = MOVE_SPEED * (input.speed ?? 1) * (player.crouched ? CROUCH_SPEED : 1);
    player.vel[0] = mx * speed;
    player.vel[2] = mz * speed;
    // Ladders: in front of one, moving towards it climbs up, away from it
    // climbs down (on the ground: walks away), sideways shuffles along it.
    // No gravity meanwhile; jumping lets go. At the top, moving towards it
    // steps onto the floor behind.
    player.ladderOff = Math.max(0, (player.ladderOff ?? 0) - dt);
    const ladder = input.fly === undefined && !player.ladderOff ? this.ladderAt(player.pos) : null;
    const towards = ladder ? -(mx * ladder.n[0] + mz * ladder.n[1]) : 0;
    // (At its foot counts as standing: climbing down ends there.)
    const standing = player.onGround || (ladder && player.pos[1] <= ladder.y0 + 0.02);
    player.climbing = !!ladder && (!standing || towards > 0.3);
    if (player.climbing && input.jump) {
      player.climbing = false;
      player.ladderOff = LADDER_LET_GO;
      player.vel[0] = ladder.n[0] * 3;
      player.vel[2] = ladder.n[1] * 3;
      player.vel[1] = 2;
      player.onGround = false;
    } else if (player.climbing) {
      const k = input.speed ?? 1;
      const side = -mx * ladder.n[1] + mz * ladder.n[0];
      const atTop = player.pos[1] > ladder.y1 - 0.4;
      // Towards the ladder: pressed against it (at the top: onto the floor
      // behind). Otherwise held a little off it, clear of the edge at its top
      // (coming down from there, that edge would be stepped back up onto).
      const front = (player.pos[0] - ladder.p[0]) * ladder.n[0] + (player.pos[2] - ladder.p[1]) * ladder.n[1];
      const inward = towards > 0
        ? (atTop ? MOVE_SPEED * k : 1) * Math.min(1, towards)
        : Math.max(-2, Math.min(2, (front - LADDER_STANDOFF) * 8));
      // Sideways: shuffles, but no further than the ladder's sides.
      const along = -(player.pos[0] - ladder.p[0]) * ladder.n[1] + (player.pos[2] - ladder.p[1]) * ladder.n[0];
      const room = ladder.w - 0.1;
      let shuffle = side * 1.5;
      if (Math.abs(along) > room) shuffle = Math.sign(along) * Math.min(0, shuffle * Math.sign(along)) - (along - Math.sign(along) * room) * 8;
      player.vel[0] = -ladder.n[1] * shuffle - ladder.n[0] * inward;
      player.vel[2] = ladder.n[0] * shuffle - ladder.n[1] * inward;
      player.vel[1] = towards * CLIMB_SPEED * k;
      player.onGround = false;
    }
    if (player.climbing) {
      // (vertical speed set above)
    } else if (input.fly !== undefined) {
      player.vel[1] = input.fly * FLY_SPEED; // hovers when neither key is held
    } else if (input.jump && player.onGround) {
      player.vel[1] = JUMP_SPEED * Math.sqrt(input.jumpHeight ?? 1); // (height grows with speed²)
      player.onGround = false;
    }
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
    for (let i = 0; i < steps; i++) {
      const floating = input.fly !== undefined || player.climbing; // (no gravity)
      if (input.noclip) this.substepNoclip(player, dt / steps, floating);
      else this.substep(player, dt / steps, floating);
    }
  }

  // No-clip: no collision with walls or ceilings, but floors (any surface
  // below, up to a step high) are stood on, and the arena boundary holds
  // (NOCLIP_EDGE inside it). Below ground level (the canal, the subway),
  // walls hold where there'd be no floor beyond them (solid earth: we'd fall
  // out of the map): slides along them instead.
  // flying (with the fly hack too): no gravity, up to the fly ceiling.
  substepNoclip(player, h, flying = false) {
    const { pos, vel } = player;
    if (flying) {
      // (vertical speed set by stepPlayer)
    } else if (player.onGround && vel[1] <= 0) vel[1] = 0;
    else vel[1] -= GRAVITY * h;
    let x = pos[0] + vel[0] * h;
    let z = pos[2] + vel[2] * h;
    if (pos[1] < -0.05) {
      const floorAt = (fx, fz) => this.floorBelow([fx, pos[1] + NOCLIP_STEP, fz], NOCLIP_FLOOR_SEARCH);
      if (!floorAt(x, z)) {
        if (floorAt(x, pos[2])) z = pos[2];
        else if (floorAt(pos[0], z)) x = pos[0];
        else { x = pos[0]; z = pos[2]; }
      }
    }
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
    this.keepInside(player, NOCLIP_EDGE);
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
    const height = player.crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    const hit = this.collide(pos[0] + vel[0] * h, pos[1] + vel[1] * h, pos[2] + vel[2] * h, g ?? pos[1], height);
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
  // height that ledges are measured from; height: the capsule's (crouched:
  // lower).
  collide(x, y, z, ref = y, height = PLAYER_HEIGHT) {
    const r = PLAYER_RADIUS;
    seg.start.set(x, y + r, z);
    seg.end.copy(seg.start).y += height - 2 * r;
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

  // Room to stand up with the feet at pos: nothing in the part of the
  // standing capsule above the crouched one (walls we lean on don't count).
  canStand(pos) {
    const r = PLAYER_RADIUS;
    seg.start.set(pos[0], pos[1] + CROUCH_HEIGHT - r, pos[2]);
    seg.end.set(pos[0], pos[1] + PLAYER_HEIGHT - r, pos[2]);
    box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(r);
    return !this.bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => tri.closestPointToSegment(seg, triPoint, capPoint) < r - 0.02,
    });
  }

  // Safety net: stay inside the arena, never fall through the world.
  keepInside(player, margin = 0) {
    const { pos, vel } = player;
    [pos[0], pos[2]] = this.clampXZ(pos[0], pos[2], margin);
    if (pos[1] < -8) {
      pos[1] = 1;
      vel[1] = 0;
    }
  }

  // Is there a floor (a surface facing up: not the underside of a wall we're
  // inside) within maxDist below origin?
  floorBelow(origin, maxDist) {
    ray.origin.set(...origin);
    ray.direction.set(0, -1, 0);
    const hit = this.bulletBvh.raycastFirst(ray, THREE.DoubleSide, 0, maxDist);
    return !!hit && hit.face.normal.y > 0.5;
  }

  // A thrown smoke bomb (g: { pos, vel, rest }) moved on by dt: falls,
  // bounces off the map (losing speed: SMOKE.bounce across the surface,
  // SMOKE.friction along it) and comes to rest on a floor. Returns whether
  // it hit something hard (a bounce sound). The host and every client run
  // this alike (the host's end position is the one that counts).
  stepGrenade(g, dt) {
    if (g.rest) return false;
    let bounced = false;
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / steps;
    for (let i = 0; i < steps && !g.rest; i++) {
      g.vel[1] -= GRAVITY * h;
      const speed = Math.hypot(...g.vel);
      const move = speed * h;
      if (move < 1e-6) continue;
      ray.origin.set(...g.pos);
      ray.direction.set(g.vel[0] / speed, g.vel[1] / speed, g.vel[2] / speed);
      const hit = this.bulletBvh.raycastFirst(ray, THREE.DoubleSide, 0, move + SMOKE.size);
      if (!hit) {
        for (let k = 0; k < 3; k++) g.pos[k] += g.vel[k] * h;
        continue;
      }
      const n = hit.face.normal.clone();
      if (n.dot(ray.direction) > 0) n.negate(); // (facing us)
      const back = Math.max(0, hit.distance - SMOKE.size);
      for (let k = 0; k < 3; k++) g.pos[k] += ray.direction.getComponent(k) * back;
      const vn = g.vel[0] * n.x + g.vel[1] * n.y + g.vel[2] * n.z;
      const across = [n.x * vn, n.y * vn, n.z * vn];
      for (let k = 0; k < 3; k++) g.vel[k] = (g.vel[k] - across[k]) * SMOKE.friction - across[k] * SMOKE.bounce;
      if (Math.abs(vn) > 1.5) bounced = true;
      if (n.y > 0.7 && Math.hypot(...g.vel) < 0.6) {
        g.rest = true;
        g.vel = [0, 0, 0];
      }
    }
    [g.pos[0], g.pos[2]] = this.clampXZ(g.pos[0], g.pos[2]);
    return bounced;
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
  // Flat: the triangles on the edge are all in one plane, apart from hidden
  // faces (pairs back to back: where two wall boxes meet end to end). Not
  // when an exposed face meets them at an angle: a wall's corner where its
  // end face continues in the plane of another wall (ignoring that edge let
  // players cut into the corner, and they couldn't stand up from a crouch).
  const normals = new Map(); // edge key -> normals of the triangles on it
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
        const list = normals.get(key);
        if (list) list.push(n.clone());
        else normals.set(key, [n.clone()]);
      }
    }
  }
  const flat = new Set();
  for (const [key, list] of normals) {
    if (list.length < 2) continue;
    const exposed = list.filter((m) => !list.some((o) => o.dot(m) < -0.999));
    if (exposed.every((m) => Math.abs(m.dot(exposed[0])) > 0.999)) flat.add(key);
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
