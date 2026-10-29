// AI players ("bots"), run by the host: they fill each team up to the size
// the host picks in the buy menu, and leave again as people join.
//
// A bot is an ordinary player in the HostServer (same movement physics,
// shots, hits, money, pickups) with no connection: what the server sends it
// arrives at Bot.onMessage, and it acts by calling the server's handlers
// directly (onSpawn, onShoot, onReload). Bots never buy hacks.
//
// Movement: paths over the navigation graph (nav.js) to a goal: a heal pack
// when hurt, a weapon spot while holding the pistol, a money spot, or
// somewhere near an enemy. Combat: enemies in view and line of sight, after
// a reaction time; aim turns at a limited rate with an error that shrinks
// while it tracks the target (the weapon's spread applies on top).

import {
  EYE_HEIGHT, WEAPONS, DEFAULT_WEAPON, PICKUP_RADIUS,
  lookDir, spreadFor, spreadDir, fireCooldown, headCenter,
} from './shared.js';
import { NavGraph } from './nav.js';

export const BOT_PREFIX = '[BOT] ';
const NAMES = ['Alex', 'Blake', 'Casey', 'Drew', 'Eden', 'Finn', 'Gray', 'Hayden', 'Jules', 'Kai', 'Lane', 'Morgan'];
export const MAX_FILL = 4; // most players per team the host can fill to

// "Normal" difficulty.
const SIGHT = 70; // m
const FOV = (150 * Math.PI) / 180 / 2; // half-angle bots notice enemies in (closer than NEAR: all around)
const NEAR = 6;
const REACTION = [0.3, 0.55]; // seconds from seeing an enemy to the first shot
const TURN_RATE = 7; // rad/s
const AIM_ERROR = [0.05, 0.11]; // rad, when acquiring a target...
const AIM_SETTLE = 0.6; // ... shrinking by 1/e every this many seconds...
const AIM_JITTER = 0.012; // ... to this
const HEAD_CHANCE = 0.2; // engagements aimed at the head (otherwise the chest)
const SEMI_DELAY = [0.08, 0.22]; // extra seconds between semi-automatic shots
const BURST = [0.4, 0.9]; // automatic weapons beyond 15 m: fire this long...
const BURST_PAUSE = [0.2, 0.45]; // ... then pause this long
const MEMORY = 4; // seconds a lost enemy is chased to where it was last seen
const PERCEIVE_EVERY = 0.1; // seconds
const COAST = 0.4; // seconds a bot keeps walking while it waits for a new path
const PATHS_PER_TICK = 1; // A* searches per host tick (all bots; long ones take a few ms)
// Preferred distance to the target, per weapon (moves closer / backs off).
const RANGE = { pistol: 16, revolver: 20, rifle: 24, p90: 14, shotgun: 6, sniper: 35 };

const rand = ([a, b]) => a + Math.random() * (b - a);
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class BotManager {
  constructor(server) {
    this.server = server;
    this.world = server.world;
    this.fill = 0; // players per team (0 = no bots)
    this.bots = new Map(); // player id -> Bot
    this.nav = null;
    this.navLoading = null;
    this.nextId = 1;
    this.spotNodes = null; // per pickup spot: its nav node, or -1 if bots can't reach it
  }

  // The host's pick in the buy menu.
  setFill(n) {
    this.fill = Math.max(0, Math.min(MAX_FILL, Math.floor(n) || 0));
    if (this.fill && !this.nav && !this.navLoading) {
      this.navLoading = NavGraph.build(this.world).then((nav) => {
        this.nav = nav;
        this.spotNodes = this.server.pickups.map((spot) => {
          const n = nav.nearest(spot.pos);
          const ok = n >= 0 && Math.hypot(nav.x[n] - spot.pos[0], nav.z[n] - spot.pos[2]) < PICKUP_RADIUS * 0.8
            && Math.abs(nav.y[n] - spot.pos[1]) < 0.6;
          return ok ? n : -1;
        });
      }).catch((err) => {
        console.warn('bots: navigation graph failed', err);
        this.server.broadcast({ t: 'feed', text: 'Bots unavailable on this map' });
      });
    }
  }

  isBot(id) {
    return this.bots.has(id);
  }

  deliver(id, msg) {
    this.bots.get(id)?.onMessage(msg);
  }

  update(now, dt) {
    if (this.nav) this.balance();
    let paths = PATHS_PER_TICK;
    for (const bot of this.bots.values()) {
      if (bot.update(now, dt, paths > 0)) paths -= 1;
    }
  }

  // Each team: add bots up to `fill` players, remove bots over it (people
  // count first). One change per tick.
  balance() {
    const counts = [0, 0];
    const teamBots = [[], []];
    for (const p of this.server.players.values()) {
      counts[p.team] += 1;
      if (this.bots.has(p.id)) teamBots[p.team].push(p.id);
    }
    for (const team of [0, 1]) {
      if (counts[team] > this.fill && teamBots[team].length) {
        this.remove(teamBots[team].pop());
        return;
      }
    }
    for (const team of [0, 1]) {
      if (counts[team] < this.fill) {
        this.add(team);
        return;
      }
    }
  }

  add(team) {
    const used = new Set([...this.server.players.values()].map((p) => p.name));
    const name = BOT_PREFIX + (NAMES.find((n) => !used.has(BOT_PREFIX + n)) ?? `Bot ${this.nextId}`);
    const id = `bot-${this.nextId++}`;
    this.bots.set(id, new Bot(this, id)); // (before addPlayer: it sends the bot 'buy')
    this.server.addPlayer(id, name, team);
  }

  remove(id) {
    this.bots.delete(id);
    this.server.removePlayer(id);
  }

  removeAll() {
    for (const id of [...this.bots.keys()]) this.remove(id);
  }
}

class Bot {
  constructor(manager, id) {
    this.manager = manager;
    this.server = manager.server;
    this.id = id;
    this.reset();
  }

  get player() {
    return this.server.players.get(this.id);
  }

  reset() {
    this.path = null;
    this.step = 0;
    this.goal = null; // { node, spot? }
    this.wantPath = true;
    this.target = null; // enemy player being fought
    this.targetSeen = 0; // host time last seen
    this.lastSeenPos = null;
    this.nextPerceive = 0;
    this.reactAt = 0;
    this.err = [0, 0];
    this.aimHead = false;
    this.nextShot = 0;
    this.burstEnd = 0;
    this.burstPause = 0;
    this.strafe = 1;
    this.strafeUntil = 0;
    this.stuckCheck = { at: 0, pos: null };
    this.jump = false;
    this.hurtBy = null;
    this.visible = false;
  }

  onMessage(msg) {
    const p = this.player;
    if (!p) return;
    if (msg.t === 'buy') {
      this.server.onSpawn(p, this.pickWeapon(msg.money), 0);
    } else if (msg.t === 'respawn') {
      p.vel = [0, 0, 0];
      p.onGround = false;
      this.reset();
    } else if (msg.t === 'hit' && msg.victim === this.id && !msg.blocked) {
      this.hurtBy = msg.attacker;
    }
  }

  // Spend on a weapon (never a hack): usually one of the better ones it can
  // afford, sometimes whatever.
  pickWeapon(money) {
    const affordable = WEAPONS.map((w, i) => i).filter((i) => i !== DEFAULT_WEAPON && WEAPONS[i].price <= money);
    if (!affordable.length || Math.random() < 0.15) return DEFAULT_WEAPON;
    affordable.sort((a, b) => WEAPONS[b].price - WEAPONS[a].price);
    return affordable[Math.floor(Math.random() * Math.min(3, affordable.length))];
  }

  // Returns true if it used a path search.
  update(now, dt, canPath) {
    const p = this.player;
    if (!p || p.dead) return false;
    if (now >= this.nextPerceive) {
      this.nextPerceive = now + PERCEIVE_EVERY;
      this.perceive(now, p);
    }
    let searched = false;
    if (this.wantPath && canPath && !this.target) {
      this.planPath(now, p);
      searched = true;
    }
    let move = this.target ? this.fightMove(now, p) : this.followPath(now, p);
    // Between paths (goal reached, waiting a tick or two for the next one):
    // keep walking the same way for a moment instead of stopping dead.
    if (move !== null) {
      this.lastMove = move;
      this.lastMoveAt = now;
    } else if (!this.target && now - (this.lastMoveAt ?? -1) < COAST && this.safeStep(p, this.lastMove)) {
      move = this.lastMove;
    }
    this.aim(now, dt, p);
    if (this.target) this.shoot(now, p);
    else this.tidy(p);

    this.server.world.stepPlayer(p, { forward: move ? 1 : 0, right: 0, jump: this.jump, yaw: move ?? 0 }, dt);
    this.jump = false;
    this.checkStuck(now, p, move !== null);
    return searched;
  }

  // ---- seeing -------------------------------------------------------------

  eye(p) {
    return [p.pos[0], p.pos[1] + EYE_HEIGHT, p.pos[2]];
  }

  canSee(from, q) {
    for (const h of [1.6, 1.1]) { // head, then chest
      const d = [q.pos[0] - from[0], q.pos[1] + h - from[1], q.pos[2] - from[2]];
      const dist = Math.hypot(...d);
      if (dist > SIGHT) return false;
      if (this.server.world.raycast(from, d.map((v) => v / dist), dist) >= dist - 0.05) return true;
    }
    return false;
  }

  perceive(now, p) {
    const eye = this.eye(p);
    let best = null;
    let bestD = Infinity;
    for (const q of this.server.players.values()) {
      if (q.team === p.team || q.dead || now < q.protectedUntil) continue;
      const dx = q.pos[0] - p.pos[0];
      const dz = q.pos[2] - p.pos[2];
      const d = Math.hypot(dx, dz, q.pos[1] - p.pos[1]);
      if (d > SIGHT) continue;
      const facing = Math.abs(angleDiff(Math.atan2(-dx, -dz), p.yaw)) < FOV;
      const known = q === this.target || q.id === this.hurtBy;
      if (!facing && !known && d > NEAR) continue;
      if (d < bestD && this.canSee(eye, q)) {
        best = q;
        bestD = d;
      }
    }
    this.hurtBy = null;
    this.visible = !!best;
    if (best) {
      if (best !== this.target) {
        // New target: react, then aim with an error that settles.
        const fresh = now - this.targetSeen > 1;
        this.target = best;
        this.reactAt = now + (fresh ? rand(REACTION) : rand(REACTION) * 0.4);
        const s = () => (Math.random() < 0.5 ? -1 : 1);
        this.err = [s() * rand(AIM_ERROR), s() * rand(AIM_ERROR) * 0.5];
        this.aimHead = Math.random() < HEAD_CHANCE;
        this.strafeUntil = 0;
      }
      this.targetSeen = now;
      this.lastSeenPos = [...best.pos];
    } else if (this.target && (this.target.dead || now - this.targetSeen > 0.5)) {
      // Lost it: go where it was last seen.
      this.target = null;
      if (this.lastSeenPos && now - this.targetSeen < MEMORY && this.manager.nav) {
        this.goal = { node: this.manager.nav.nearest(this.lastSeenPos) };
        this.wantPath = true;
        this.path = null;
      }
    }
  }

  // ---- moving -------------------------------------------------------------

  chooseGoal(now, p) {
    const { nav, spotNodes } = this.manager;
    const spots = this.server.pickups;
    // One of the two nearest available spots of a kind (so teammates don't
    // all run the same way), or -1.
    const nearestSpot = (ok) => {
      const near = [];
      spots.forEach((s, i) => {
        if (spotNodes[i] >= 0 && s.item >= 0 && ok(s)) near.push([Math.hypot(s.pos[0] - p.pos[0], s.pos[2] - p.pos[2]), i]);
      });
      near.sort((a, b) => a[0] - b[0]);
      return near.length ? near[Math.floor(Math.random() * Math.min(2, near.length))][1] : -1;
    };
    let spot = -1;
    if (p.hp < p.maxHp * 0.5) spot = nearestSpot((s) => s.kind === 'heal');
    if (spot < 0 && p.weapon === DEFAULT_WEAPON) spot = nearestSpot((s) => s.kind === 'weapon');
    if (spot < 0 && Math.random() < 0.3) spot = nearestSpot((s) => s.kind === 'money' || s.kind === 'weapon');
    if (spot >= 0) return { node: spotNodes[spot], spot };
    // Hunt: somewhere near a random living enemy (60%), or anywhere.
    const enemies = [...this.server.players.values()].filter((q) => q.team !== p.team && !q.dead);
    if (enemies.length && Math.random() < 0.6) {
      const q = enemies[Math.floor(Math.random() * enemies.length)];
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 10;
      const n = nav.nearest([q.pos[0] + Math.cos(a) * r, q.pos[1], q.pos[2] + Math.sin(a) * r]);
      if (n >= 0) return { node: n };
    }
    return { node: nav.random() };
  }

  planPath(now, p) {
    const { nav } = this.manager;
    this.wantPath = false;
    if (!nav) return;
    const from = nav.nearest(p.pos);
    if (!this.goal || this.goal.node < 0) this.goal = this.chooseGoal(now, p);
    this.path = nav.path(from, this.goal.node);
    this.step = 0;
    if (!this.path) {
      this.goal = null; // unreachable: another goal next time
      this.wantPath = true;
    }
  }

  // Yaw to walk along the path (null: standing still).
  followPath(now, p) {
    const { nav } = this.manager;
    if (!this.path || !nav) return null;
    // A spot that's been emptied: pick something else.
    if (this.goal?.spot >= 0 && this.server.pickups[this.goal.spot].item < 0) return this.newGoal();
    // Skip waypoints already reached (looking a few ahead, for smooth turns).
    while (this.step < this.path.length) {
      const n = this.path[this.step];
      const d = Math.hypot(nav.x[n] - p.pos[0], nav.z[n] - p.pos[2]);
      if (d > 0.6 || Math.abs(nav.y[n] - p.pos[1]) > 0.5) break; // (not the floor above / below)
      this.step += 1;
    }
    if (this.step >= this.path.length) return this.newGoal();
    const n = this.path[this.step];
    if (Math.hypot(nav.x[n] - p.pos[0], nav.z[n] - p.pos[2]) > 4 || p.pos[1] < nav.y[n] - 1.5) {
      this.path = null; // knocked off the path (fell, pushed): plan again
      this.wantPath = true;
      return null;
    }
    // Steer a waypoint ahead (smoother turns), unless that one is on another
    // level or nearly under us (after a drop): then at the next one.
    let ahead = this.path[Math.min(this.step + 1, this.path.length - 1)];
    if (Math.abs(nav.y[ahead] - nav.y[n]) > 0.5 || Math.hypot(nav.x[ahead] - p.pos[0], nav.z[ahead] - p.pos[2]) < 0.4) ahead = n;
    return Math.atan2(-(nav.x[ahead] - p.pos[0]), -(nav.z[ahead] - p.pos[2]));
  }

  newGoal() {
    this.goal = null;
    this.path = null;
    this.wantPath = true;
    return null;
  }

  // In a fight: strafe, and close in or back off to the weapon's range.
  // Never off a ledge: a step that leaves the walkable floor turns back.
  fightMove(now, p) {
    const q = this.target;
    const dx = q.pos[0] - p.pos[0];
    const dz = q.pos[2] - p.pos[2];
    const dist = Math.hypot(dx, dz);
    const toward = Math.atan2(-dx, -dz);
    if (now >= this.strafeUntil) {
      this.strafe = Math.random() < 0.5 ? -1 : 1;
      this.strafeUntil = now + 0.5 + Math.random() * 0.9;
    }
    const want = RANGE[WEAPONS[p.weapon].id] ?? 18;
    const closer = dist > want * 1.3 ? 1 : dist < want * 0.6 ? -1 : 0;
    // Strafe direction (90° from the target) blended with closing in / backing off.
    let yaw = toward + this.strafe * (Math.PI / 2) * (closer === 0 ? 1 : closer > 0 ? 0.5 : 1.5);
    if (!this.safeStep(p, yaw)) {
      this.strafe = -this.strafe;
      yaw = toward + this.strafe * (Math.PI / 2) * (closer === 0 ? 1 : closer > 0 ? 0.5 : 1.5);
      if (!this.safeStep(p, yaw)) return null;
    }
    return yaw;
  }

  safeStep(p, yaw) {
    const { nav } = this.manager;
    if (!nav) return true;
    const ahead = [p.pos[0] - Math.sin(yaw) * 0.9, p.pos[1], p.pos[2] - Math.cos(yaw) * 0.9];
    const n = nav.nearest(ahead);
    return n >= 0 && Math.hypot(nav.x[n] - ahead[0], nav.z[n] - ahead[2]) < 0.5 && Math.abs(nav.y[n] - p.pos[1]) < 0.5;
  }

  // Not making progress while trying to move: jump; still stuck: new plan.
  checkStuck(now, p, moving) {
    const s = this.stuckCheck;
    if (!moving) {
      s.pos = null;
      return;
    }
    if (!s.pos) {
      s.pos = [...p.pos];
      s.at = now;
      s.tries = 0;
      return;
    }
    if (now - s.at < 0.8) return;
    const moved = Math.hypot(p.pos[0] - s.pos[0], p.pos[2] - s.pos[2]);
    s.pos = [...p.pos];
    s.at = now;
    if (moved > 0.6) {
      s.tries = 0;
      return;
    }
    s.tries += 1;
    this.jump = true;
    if (s.tries >= 3) {
      this.newGoal();
      this.strafe = -this.strafe;
      s.tries = 0;
    }
  }

  // ---- aiming and shooting -------------------------------------------------

  aim(now, dt, p) {
    let yaw;
    let pitch;
    if (this.target) {
      const q = this.target;
      const eye = this.eye(p);
      const at = this.aimHead ? headCenter(q.pos, this.server.seenBy()(q)) : [q.pos[0], q.pos[1] + 1.1, q.pos[2]];
      const d = at.map((v, i) => v - eye[i]);
      // The error settles while tracking, down to a jitter.
      const k = Math.exp(-dt / AIM_SETTLE);
      this.err = this.err.map((e) => e * k + (Math.random() - 0.5) * AIM_JITTER * 0.5);
      yaw = Math.atan2(-d[0], -d[2]) + this.err[0];
      pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) + this.err[1];
    } else {
      // Look where it's going (level).
      const { nav } = this.manager;
      const n = this.path?.[Math.min(this.step + 3, this.path.length - 1)];
      const dx = n === undefined ? 0 : nav.x[n] - p.pos[0];
      const dz = n === undefined ? 0 : nav.z[n] - p.pos[2];
      yaw = Math.hypot(dx, dz) > 0.3 ? Math.atan2(-dx, -dz) : p.yaw;
      pitch = 0;
    }
    const turn = TURN_RATE * dt;
    const dy = angleDiff(yaw, p.yaw);
    p.yaw += Math.max(-turn, Math.min(turn, dy));
    p.yaw = Math.atan2(Math.sin(p.yaw), Math.cos(p.yaw));
    p.pitch += Math.max(-turn, Math.min(turn, pitch - p.pitch));
    this.onTarget = Math.abs(dy) < 0.04 && Math.abs(pitch - p.pitch) < 0.04;
  }

  shoot(now, p) {
    const weapon = WEAPONS[p.weapon];
    if (now < this.reactAt || !this.onTarget || !this.visible) return;
    if (p.reloadEnd) return;
    if (p.ammo[p.weapon] <= 0) {
      this.server.onReload(p);
      return;
    }
    const cooldown = fireCooldown(weapon, p.hack);
    if (now < this.nextShot) return;
    // Bursts at range with automatic weapons.
    const dist = Math.hypot(...this.target.pos.map((v, i) => v - p.pos[i]));
    if (weapon.auto && dist > 15) {
      if (now < this.burstPause) return;
      if (!this.burstEnd) this.burstEnd = now + rand(BURST);
      if (now > this.burstEnd) {
        this.burstEnd = 0;
        this.burstPause = now + rand(BURST_PAUSE);
        return;
      }
    }
    const speed = Math.hypot(p.vel?.[0] ?? 0, p.vel?.[2] ?? 0);
    const aim = spreadDir(lookDir(p.yaw, p.pitch), spreadFor(weapon, speed, p.onGround ?? true));
    const msg = { t: 'shoot', w: p.weapon, yaw: p.yaw, pitch: p.pitch };
    if (weapon.pellets) msg.ds = Array.from({ length: weapon.pellets }, () => spreadDir(aim, weapon.pelletSpread));
    else msg.d = aim;
    this.server.onShoot(p, msg);
    this.nextShot = now + cooldown + (weapon.auto ? 0 : rand(SEMI_DELAY));
  }

  // Out of a fight: top up a half-empty magazine.
  tidy(p) {
    if (!p.reloadEnd && p.ammo[p.weapon] < WEAPONS[p.weapon].magSize * 0.5) this.server.onReload(p);
  }
}
