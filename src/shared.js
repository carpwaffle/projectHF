// Constants and small helpers shared by host and clients. Map collision and
// movement physics live in world.js.

export const STATE_SEND_RATE = 30; // client -> host position updates per second
export const SNAPSHOT_RATE = 20; // host -> clients world snapshots per second
export const INTERP_DELAY = 100; // ms clients render remote players behind real time

export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;
export const MOVE_SPEED = 7;
export const JUMP_SPEED = 7;
export const GRAVITY = 20;

export const MAX_HP = 100;
export const DAMAGE = 25;
export const FIRE_COOLDOWN = 0.15; // seconds
export const RESPAWN_TIME = 2; // seconds
export const MAX_RANGE = 200;

// Pick a spawn point far from other living players (randomly among the best
// few, so spawns don't become predictable).
export function pickSpawn(points, otherPositions) {
  const scored = points.map((s) => {
    let nearest = Infinity;
    for (const p of otherPositions) nearest = Math.min(nearest, Math.hypot(s[0] - p[0], s[2] - p[2]));
    return { s, nearest };
  }).sort((a, b) => b.nearest - a.nearest);
  const pick = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
  return [...pick.s];
}

// Camera convention (three.js): yaw rotates around Y, pitch around X, forward is -Z.
export function lookDir(yaw, pitch) {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

// Player hitbox for shooting (feet at pos).
export function playerAABB(pos) {
  return {
    min: [pos[0] - PLAYER_RADIUS, pos[1], pos[2] - PLAYER_RADIUS],
    max: [pos[0] + PLAYER_RADIUS, pos[1] + PLAYER_HEIGHT, pos[2] + PLAYER_RADIUS],
  };
}

// Slab test. Returns distance along the (normalised) ray, or Infinity on miss.
export function rayAABB(o, d, min, max) {
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return Infinity;
    } else {
      let t1 = (min[i] - o[i]) / d[i];
      let t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}
