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

// Two teams: team 0 spawns in the north base (House01), team 1 in the south
// base (House09). No friendly fire.
export const TEAMS = [
  { name: 'Blue', color: '#4c8dff' },
  { name: 'Red', color: '#ff5a4c' },
];

export const MAX_HP = 100;
export const SPAWN_PROTECTION = 3; // seconds of invulnerability after spawning (ends early when you fire)

// Weapons (index = the number sent over the network, and key 1-6). Every
// player carries all of them; switch with the number keys, Q (last weapon)
// or the mouse wheel. Everyone spawns with DEFAULT_WEAPON.
//   cooldown: seconds between shots (incl. working a bolt / pump)
//   auto: keeps firing while the trigger is held (otherwise one shot per click)
//   spread: half-angle (radians) of the cone shots land in, standing still /
//     at full running speed / in the air; `scoped` replaces it while scoped
//   zoomFov: vertical field of view when scoped (degrees)
//   pellets: shots per trigger pull (shotgun), each in a cone of pelletSpread
//     around the aimed (spread) direction, each doing damage / headDamage,
//     falling off between falloff[0] and [1] metres to falloff[2] of it
export const WEAPONS = [
  {
    id: 'pistol', name: 'Pistol', damage: 30, headDamage: 75, cooldown: 0.15, auto: false,
    magSize: 12, reloadTime: 1.6,
    spread: { still: 0.01, move: 0.03, air: 0.07 }, // (same as the rifle)
  },
  {
    id: 'revolver', name: 'Revolver', damage: 55, headDamage: 110, cooldown: 0.35, auto: false,
    magSize: 6, reloadTime: 2.4,
    spread: { still: 0.002, move: 0.02, air: 0.045 }, // second only to the sniper
  },
  {
    id: 'rifle', name: 'Rifle', damage: 25, headDamage: 50, cooldown: 0.15, auto: true,
    magSize: 30, reloadTime: 2.2,
    spread: { still: 0.01, move: 0.03, air: 0.07 },
  },
  {
    id: 'p90', name: 'P90', damage: 17, headDamage: 34, cooldown: 0.075, auto: true,
    magSize: 50, reloadTime: 2.5,
    spread: { still: 0.014, move: 0.04, air: 0.08 },
  },
  {
    id: 'shotgun', name: 'Shotgun', damage: 13, headDamage: 20, cooldown: 0.65, auto: false,
    magSize: 6, reloadTime: 2.6,
    pellets: 8, pelletSpread: 0.07, falloff: [8, 30, 0.3],
    spread: { still: 0, move: 0.02, air: 0.05 },
  },
  {
    id: 'sniper', name: 'Sniper', damage: 80, headDamage: 200, cooldown: 1.0, auto: false,
    magSize: 5, reloadTime: 3.0,
    spread: { still: 0.001, move: 0.015, air: 0.04 }, // the most accurate, even unscoped
    scoped: { still: 0, move: 0.008, air: 0.04 },
    zoomFov: 18, scopeTime: 0.22,
  },
];
export const DEFAULT_WEAPON = WEAPONS.findIndex((w) => w.id === 'pistol'); // what everyone spawns with
export const weaponIndex = (id) => WEAPONS.findIndex((w) => w.id === id);

// Damage of one shot / pellet at `distance` metres.
export function shotDamage(weapon, headshot, distance) {
  const base = headshot ? weapon.headDamage : weapon.damage;
  if (!weapon.falloff) return base;
  const [near, far, min] = weapon.falloff;
  const k = Math.min(1, Math.max(0, (distance - near) / (far - near)));
  return Math.round(base * (1 - k * (1 - min)));
}
export const SWITCH_TIME = 0.45; // seconds to draw another weapon (can't fire meanwhile)
export const FIRE_COOLDOWN = WEAPONS.find((w) => w.id === 'rifle').cooldown; // (preview page: holds the rifle)

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

// Shot spread for a player with `weapon` moving at `speed` (m/s), on the
// ground or not, scoped or not.
export function spreadFor(weapon, speed, onGround, scoped = false) {
  const s = (scoped && weapon.scoped) || weapon.spread;
  if (!onGround) return s.air;
  return s.still + (s.move - s.still) * Math.min(1, speed / MOVE_SPEED);
}

// A random direction within `spread` radians of `dir` (uniform over the cone's disc).
export function spreadDir(dir, spread) {
  if (spread <= 0) return dir;
  const r = Math.tan(spread) * Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  // Two axes perpendicular to dir.
  const up = Math.abs(dir[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(dir, up));
  const v = cross(u, dir);
  return normalize(dir.map((d, i) => d + (u[i] * Math.cos(a) + v[i] * Math.sin(a)) * r));
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function normalize(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
}

// Hitboxes for shooting (feet at pos): the head on top of the body.
const HEAD_BOTTOM = 1.45;
const HEAD_HALF = 0.16;
export function headAABB(pos) {
  return {
    min: [pos[0] - HEAD_HALF, pos[1] + HEAD_BOTTOM, pos[2] - HEAD_HALF],
    max: [pos[0] + HEAD_HALF, pos[1] + PLAYER_HEIGHT + 0.02, pos[2] + HEAD_HALF],
  };
}
export function bodyAABB(pos) {
  return {
    min: [pos[0] - PLAYER_RADIUS, pos[1], pos[2] - PLAYER_RADIUS],
    max: [pos[0] + PLAYER_RADIUS, pos[1] + HEAD_BOTTOM, pos[2] + PLAYER_RADIUS],
  };
}

// Whole-player box (feet at pos), for where a tracer stops.
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
