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

export const MAX_HP = 200;
export const SPAWN_PROTECTION = 3; // seconds of invulnerability after spawning (ends early when you fire)

// Weapons (index = the number sent over the network, and key 1-6). Every
// player carries all of them; switch with the number keys, Q (last weapon)
// or the mouse wheel. Everyone spawns with DEFAULT_WEAPON.
//   cooldown: seconds between shots (incl. working a bolt / pump)
//   auto: keeps firing while the trigger is held (otherwise one shot per click)
//   price: what it costs to spawn with it (dollars)
//   spread: half-angle (radians) of the cone shots land in, standing still /
//     at full running speed / in the air; `scoped` replaces it while scoped
//   zoomFov: vertical field of view when scoped (degrees)
//   pellets: shots per trigger pull (shotgun), each in a cone of pelletSpread
//     around the aimed (spread) direction, each doing damage / headDamage,
//     falling off between falloff[0] and [1] metres to falloff[2] of it
export const WEAPONS = [
  {
    id: 'pistol', name: 'Pistol', damage: 30, headDamage: 75, cooldown: 0.15, auto: false,
    price: 0,
    magSize: 12, reloadTime: 1.6,
    spread: { still: 0.01, move: 0.03, air: 0.07 }, // (same as the rifle)
  },
  {
    id: 'revolver', name: 'Revolver', damage: 55, headDamage: 110, cooldown: 0.35, auto: false,
    price: 250,
    magSize: 6, reloadTime: 2.4,
    spread: { still: 0.002, move: 0.02, air: 0.045 }, // second only to the sniper
  },
  {
    id: 'rifle', name: 'Rifle', damage: 25, headDamage: 50, cooldown: 0.15, auto: true,
    price: 500,
    magSize: 30, reloadTime: 2.2,
    spread: { still: 0.01, move: 0.03, air: 0.07 },
  },
  {
    id: 'p90', name: 'P90', damage: 17, headDamage: 34, cooldown: 0.075, auto: true,
    price: 400,
    magSize: 50, reloadTime: 2.5,
    spread: { still: 0.014, move: 0.04, air: 0.08 },
  },
  {
    id: 'shotgun', name: 'Shotgun', damage: 13, headDamage: 20, cooldown: 0.65, auto: false,
    price: 400,
    magSize: 6, reloadTime: 2.6,
    pellets: 8, pelletSpread: 0.07, falloff: [8, 30, 0.3],
    spread: { still: 0, move: 0.02, air: 0.05 },
  },
  {
    id: 'sniper', name: 'Sniper', damage: 80, headDamage: 200, cooldown: 1.0, auto: false,
    price: 650,
    magSize: 5, reloadTime: 3.0,
    spread: { still: 0.001, move: 0.015, air: 0.04 }, // the most accurate, even unscoped
    scoped: { still: 0, move: 0.008, air: 0.04 },
    zoomFov: 18, scopeTime: 0.22,
  },
];
export const DEFAULT_WEAPON = WEAPONS.findIndex((w) => w.id === 'pistol'); // what everyone spawns with
export const weaponIndex = (id) => WEAPONS.findIndex((w) => w.id === id);

// Money: earned on every death (SURVIVAL_RATE per second alive) and kill
// (KILL_REWARD); spent on the weapon you spawn with (WEAPONS[].price). Everyone
// starts with $0. The host keeps the accounts.
export const SURVIVAL_RATE = 4; // dollars per second alive
export const KILL_REWARD = 250;

// Hacks: bought in the buy menu like weapons (separately: you pay for both),
// one at a time, active until your next death. Index = the number sent over
// the network.
export const HACKS = [
  { id: 'none', name: 'No hack', price: 0, desc: '' },
  { id: 'map', name: 'Map hack', price: 300, desc: 'Minimap: every player and pickup timer' },
  { id: 'speed', name: 'Speed hack', price: 400, desc: 'Move 3x faster' },
  { id: 'recoil', name: 'Recoil hack', price: 400, desc: '85% less spread' },
  { id: 'ammo', name: 'Infinite ammo hack', price: 500, desc: 'No reloads; faster shotgun and sniper' },
  { id: 'wall', name: 'Wall hack', price: 600, desc: 'See players and hitboxes through walls' },
  { id: 'fly', name: 'Fly hack', price: 700, desc: 'Q up, E down (up to 25 m); a bit faster' },
  { id: 'noclip', name: 'No-clip hack', price: 800, desc: 'Walk through walls and ceilings' },
  { id: 'hp', name: 'HP hack', price: 800, desc: '1500 HP' },
  { id: 'aim', name: 'Aim hack', price: 900, desc: 'Hold Shift: lock onto a visible head' },
  { id: 'victory', name: 'Victory hack', price: 10000, desc: 'Your team wins the round' },
];
export const hackIndex = (id) => HACKS.findIndex((h) => h.id === id);
export const hackId = (index) => HACKS[index]?.id ?? 'none';
export const SPEED_HACK = 3.0; // movement speed multiplier
export const FLY_HACK_SPEED = 1.3; // ... while flying with the fly hack
export const RECOIL_HACK = 0.15; // spread multiplier (85% less)
export const FLY_SPEED = 6; // m/s up / down with the fly hack
export const FLY_MAX_Y = 25; // fly ceiling (House08's roof is at 15 m)
export const HACK_HP = 1500; // max HP with the HP hack
export const HEAL_AMOUNT = 100; // a heal pack heals this much (up to max HP)
export const FAST_CYCLE = 0.5; // infinite ammo: shotgun pump / sniper bolt time multiplier
export const VICTORY_SCREEN = 10; // seconds the winning team is shown before the next round

// Seconds between shots for a weapon, with the player's hack.
export function fireCooldown(weapon, hack) {
  const fast = hackId(hack) === 'ammo' && (weapon.id === 'shotgun' || weapon.id === 'sniper');
  return weapon.cooldown * (fast ? FAST_CYCLE : 1);
}

// Only the player with this name can switch weapons (number keys, Q, wheel).
// Everyone else uses the spawn weapon until they pick another one up.
export const ADMIN_NAME = 'Admin';
export const ADMIN_MONEY = 999999; // (testing) what Admin starts every round with

// Weapon pickups: spots (game coordinates: x, floor height, z) marked with a
// white circle. Walking over one holding a different weapon takes it (full
// magazine) until you die or take another; the spot then stays empty for
// PICKUP_RESPAWN seconds and gets a new random weapon (not the spawn pistol).
export const PICKUP_SPOTS = [
  [-19, 0.15, -40.41], // House04
  [19, 0.15, 40.41], // House12
  [45, 0, 0], // east end of the road
  [-45, 0, 0], // west end of the road
  [4.5, 12.15, 3.5], [-4.5, 12.15, -3.5], [3.5, 12.15, -4.5], [-3.5, 12.15, 4.5], // House08, 5th floor
  [0, 3.15, -28], [0, 3.15, 28], // middle of the House01 / House09 bridges
];
// Heal packs, marked with a green circle: walking over one while hurt heals
// to full; the spot then refills after HEAL_RESPAWN seconds.
export const HEAL_SPOTS = [
  [-34.59, 9.15, -20.59], [34.59, 9.15, 20.59], // House05 / House13, 4th floor
  [17, 0.15, -37], [-17, 0.15, 37], // House01's north annex / House09's south annex (ground floor)
  [4.5, 15.15, 0], [-4.5, 15.15, 0], // House08 roof
];
export const HEAL_RESPAWN = 20; // seconds
// Money spots, marked with a yellow circle: walking over one gives
// MONEY_AMOUNT; the spot then refills after MONEY_RESPAWN seconds.
export const MONEY_SPOTS = [
  [38, 3.16, -16], [-38, 3.16, 16], // House03 / House11 roofs
  [-17, 6.16, -17], [17, 6.16, 17], // House07 / House15 roofs (behind the billboards)
];
export const MONEY_AMOUNT = 1000;
export const MONEY_RESPAWN = 20; // seconds

// All pickup spots in one list, in the order the host and clients share
// (weapon spots, heal spots, money spots): [{ pos, kind }].
export const ALL_SPOTS = [
  ...PICKUP_SPOTS.map((pos) => ({ pos, kind: 'weapon' })),
  ...HEAL_SPOTS.map((pos) => ({ pos, kind: 'heal' })),
  ...MONEY_SPOTS.map((pos) => ({ pos, kind: 'money' })),
];
export const PICKUP_RADIUS = 1.0; // the circle's (outer) radius
export const PICKUP_RESPAWN = 20; // seconds
export const PICKUP_WEAPONS = WEAPONS.map((_, i) => i).filter((i) => i !== DEFAULT_WEAPON);
export const randomPickupWeapon = () => PICKUP_WEAPONS[Math.floor(Math.random() * PICKUP_WEAPONS.length)];

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
