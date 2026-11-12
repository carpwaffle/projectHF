// The "server" that runs inside the host's browser tab. It owns health, scores,
// hit detection and respawns, and broadcasts world snapshots to every client.
// The host's own player is just another player with id "host" whose messages
// are delivered by direct function call instead of over WebRTC.

import {
  SNAPSHOT_RATE, MAX_HP, RESPAWN_TIME, eyeHeight, MAX_RANGE,
  WEAPONS, DEFAULT_WEAPON, SWITCH_TIME, SPAWN_PROTECTION, shotDamage, ADMIN_NAME, ADMIN_MONEY,
  MODES, weaponAllowed, weaponPrice, hacksOffMask,
  PICKUP_RADIUS, PICKUP_RESPAWN, randomPickupWeapon, HEAL_RESPAWN, ALL_SPOTS, MONEY_AMOUNT, MONEY_RESPAWN,
  SURVIVAL_RATE, KILL_REWARD, PLAYER_TIMEOUT, ALL_HACKS, HACK_LIMIT, hasHack, withinHackLimit, hacksPrice, HACK_HP, HEAL_AMOUNT, VICTORY_SCREEN, fireCooldown,
  CHAT_MAX, CHAT_GAP, FAKE_LAG_GHOST, FAKE_LAG_REVEAL, SMOKE, THROW_TIME, THROW_RELEASE, smokeBlocks,
  pickSpawn, lookDir, rayPlayer, normalize, PLAYER_RADIUS,
} from './shared.js';
import { SKINS } from './assets.js';
import { BotManager } from './bots.js';

export const HOST_ID = 'host';

const round = (n) => Math.round(n * 100) / 100;

// The client starts its reload timer when the player presses reload, the
// host when the message arrives (half a round trip later). Finishing a little
// early here keeps the first shots after a reload from being rejected.
const RELOAD_GRACE = 0.2;

const SWING_ANGLE = 0.9; // radians either side of the aim a knife reaches (~52°)
const SWING_HEIGHT = 1.4; // m above / below (not the floor above)
const BACKSTAB = 0.5; // the victim faces within ~60° of the swing's direction: from behind
const MAX_SHOT_ORIGIN_OFFSET = 1.5; // m between a shot's origin and the shooter's last reported eye
const HISTORY = 12; // snapshots kept for lag compensation (0.6 s at 20 per second): the furthest back a shot is checked

export class HostServer {
  // world: the map's World (collision, spawns), shared with the local client.
  // hackLimit: hacks per life (the default mode: HACK_LIMIT; 0: no limit).
  // mode: the game mode (an id in MODES).
  constructor(peer, deliverLocal, world, { hackLimit = HACK_LIMIT, mode = 'normal' } = {}) {
    this.world = world;
    this.hackLimit = hackLimit;
    this.modeId = MODES[mode] ? mode : 'normal';
    this.mode = MODES[this.modeId];
    this.teamKills = [0, 0]; // this round
    this.peer = peer;
    this.deliverLocal = deliverLocal; // (msg) => void, feeds the host's own client
    this.players = new Map();
    // Lag compensation: what the last snapshots showed (see seenBy).
    this.snapSeq = 0;
    this.history = []; // [{ n, players: Map<id, { pos, yaw, pitch, weapon }> }], oldest first
    this.grenades = []; // smoke bombs thrown: { id, owner, releaseAt, yaw, pitch, pos, vel, rest, popAt }
    this.smokes = []; // smoke clouds: { id, pos, at, duration }
    this.grenadeSeq = 0;
    this.conns = new Map(); // clientId -> { rel, state }
    this.lastSnapshot = 0;
    this.roundOverAt = 0; // host time (s) the victory screen ends (0 = round in progress)
    // Pickups (ALL_SPOTS: weapon, heal and money spots). item: the weapon
    // on offer (index into WEAPONS) / 1 for a heal pack or money, -1 =
    // empty; readyAt: when an empty one refills.
    this.pickups = ALL_SPOTS.map(({ pos, kind }) => ({ pos, kind, item: this.refill(kind), readyAt: 0 }));
    this.bots = new BotManager(this); // AI players (bots.js)
    this.lastTick = performance.now() / 1000;

    peer.on('connection', (conn) => this.onConnection(conn));
  }

  // ---- connections -------------------------------------------------------

  onConnection(conn) {
    const id = conn.peer;
    const entry = this.conns.get(id) ?? {};
    entry[conn.label] = conn;
    this.conns.set(id, entry);

    conn.on('data', (msg) => this.handleMessage(id, msg));
    conn.on('close', () => this.removePlayer(id));
    conn.on('error', () => this.removePlayer(id));
  }

  sendTo(id, msg, reliable = true) {
    if (id === HOST_ID) return this.deliverLocal(msg);
    if (this.bots.isBot(id)) return this.bots.deliver(id, msg);
    const entry = this.conns.get(id);
    const conn = reliable ? entry?.rel : entry?.state;
    if (conn?.open) conn.send(msg);
  }

  broadcast(msg, reliable = true) {
    this.sendMany([...this.players.keys()], msg, reliable);
  }

  // The same message to several players. Those on the relay get it as one
  // message for all (the relay copies it to each: less of its quota).
  sendMany(ids, msg, reliable = true) {
    const relayed = [];
    for (const id of ids) {
      const conn = this.conns.get(id)?.rel;
      if (conn?.relay) {
        if (conn.open) relayed.push(id);
      } else {
        this.sendTo(id, msg, reliable);
      }
    }
    if (relayed.length) this.conns.get(relayed[0]).rel.relay.send(relayed, msg);
  }

  // ---- players -----------------------------------------------------------

  // team: (bots) the team to join; people get the smaller one.
  addPlayer(id, name, team = this.pickTeam()) {
    if (this.players.has(id)) return;
    const spawn = this.spawnPoint(team, id);
    const player = {
      id,
      name: this.bots.isBot(id) ? name : String(name || 'Player').slice(0, 16),
      skin: this.pickSkin(),
      team,
      pos: spawn.pos,
      yaw: spawn.yaw ?? 0,
      pitch: 0,
      crouch: 0, // 1 while crouched (reported by the client)
      hp: MAX_HP,
      score: 0,
      money: 0, // (set below)
      // Not in the world until they've picked a weapon (the buy menu): joining
      // players and the dead. spawnWeapon: their pick (-1 = none yet).
      dead: true,
      joining: true,
      spawnWeapon: -1,
      spawnHack: 0,
      hack: 0, // hacks (bit mask, see HACKS), until the next death
      smokeAt: 0, // smoke bomb: usable again then (host seconds); everyone spawns with one
      holdingSmoke: false,
      ghost: null, // fake-lag hack: the afterimage enemies see ({ pos, yaw, pitch, crouch, weapon }), renewed at ghostAt
      ghostAt: 0,
      revealUntil: 0, // ... shown to everyone until then (attacked)
      maxHp: MAX_HP,
      spawnedAt: 0,
      respawnAt: 0,
      lastShot: 0,
      weapon: DEFAULT_WEAPON, // index into WEAPONS
      ammo: WEAPONS.map((w) => w.magSize), // per weapon
      switchEnd: 0, // host time (s) the weapon switch finishes (can't fire before)
      reloadEnd: 0, // host time (s) the current reload finishes, 0 = not reloading
      protectedUntil: 0,
      lastSeen: performance.now() / 1000,
    };
    player.money = this.startMoney(player);
    this.players.set(id, player);
    this.sendTo(id, { t: 'welcome', id, pos: player.pos, yaw: spawn.yaw, team, hackLimit: this.hackLimit, mode: this.modeId });
    this.sendTo(id, { t: 'buy', money: player.money, wait: 0 });
    this.broadcast({ t: 'feed', key: 'joined', name: player.name, team });
  }

  // Everyone starts a round with $0; Admin with ADMIN_MONEY (for testing).
  startMoney(player) {
    return player.name === ADMIN_NAME ? ADMIN_MONEY : 0;
  }

  // The team with fewer people (bots make way: see BotManager.balance), then
  // fewer players, then random.
  pickTeam() {
    const people = [0, 0];
    const counts = [0, 0];
    for (const p of this.players.values()) {
      counts[p.team] += 1;
      if (!this.bots.isBot(p.id)) people[p.team] += 1;
    }
    if (people[0] !== people[1]) return people[0] < people[1] ? 0 : 1;
    if (counts[0] !== counts[1]) return counts[0] < counts[1] ? 0 : 1;
    return Math.random() < 0.5 ? 0 : 1;
  }

  // One of the team's base spawns, away from other living players:
  // { pos, yaw } (yaw undefined if the map doesn't give the spawn a facing).
  spawnPoint(team, id) {
    const others = [...this.players.values()].filter((p) => p.id !== id && !p.dead).map((p) => p.pos);
    const [x, y, z, yaw] = pickSpawn(this.world.teamSpawns[team], others);
    return { pos: [x, y, z], yaw };
  }

  // Random character model, avoiding ones already in use while any are free.
  pickSkin() {
    const used = new Set([...this.players.values()].map((p) => p.skin));
    const free = SKINS.map((_, i) => i).filter((i) => !used.has(i));
    const pool = free.length ? free : SKINS.map((_, i) => i);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  removePlayer(id) {
    const player = this.players.get(id);
    const entry = this.conns.get(id);
    // Forget them before closing: closing fires 'close', which calls back here.
    this.conns.delete(id);
    this.players.delete(id);
    entry?.rel?.close();
    entry?.state?.close();
    if (!player) return;
    this.broadcast({ t: 'leave', id });
    this.broadcast({ t: 'feed', key: 'left', name: player.name });
  }

  // ---- messages ----------------------------------------------------------

  handleMessage(id, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') return this.addPlayer(id, msg.name);

    const player = this.players.get(id);
    if (!player) return;
    player.lastSeen = performance.now() / 1000; // (any message, incl. 'ping')
    if (msg.t === 'bye') return this.removePlayer(id); // closed their tab
    if (msg.t === 'ping') return this.sendTo(id, { t: 'pong', at: msg.at }); // (round-trip time)
    if (msg.t === 'state') this.onState(player, msg);
    else if (msg.t === 'shoot') this.onShoot(player, msg);
    else if (msg.t === 'throw') this.onThrow(player, msg);
    else if (msg.t === 'reload') this.onReload(player);
    else if (msg.t === 'chat') this.onChat(player, msg.text);
    else if (msg.t === 'weapon') this.onWeapon(player, msg.w);
    else if (msg.t === 'spawn') this.onSpawn(player, msg.w, msg.h ?? 0);
    else if (msg.t === 'bots' && id === HOST_ID) this.bots.setFill(msg.n);
    else if (msg.t === 'botHacks' && id === HOST_ID) this.bots.setHacks(msg.on);
  }

  // Clients simulate their own movement and report the result. We trust it,
  // apart from keeping players inside the arena. (See README: "Cheating".)
  onState(player, msg) {
    if (player.dead || !Array.isArray(msg.p)) return;
    const [x, y, z] = msg.p.map(Number);
    if (![x, y, z, msg.yaw, msg.pitch].every(Number.isFinite)) return;
    const [cx, cz] = this.world.clampXZ(x, z);
    player.pos = [cx, Math.max(-6, Math.min(40, y)), cz];
    player.yaw = msg.yaw;
    player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, msg.pitch));
    player.crouch = msg.c ? 1 : 0;
    player.holdingSmoke = !!msg.s; // (for others to draw)
    player.climbing = !!msg.l;
  }

  onShoot(shooter, msg) {
    const now = performance.now() / 1000;
    const weapon = WEAPONS[shooter.weapon];
    if (msg.w !== undefined && msg.w !== shooter.weapon) return; // fired before our switch arrived
    const infinite = hasHack(shooter.hack, 'ammo');
    if (shooter.dead || now - shooter.lastShot < fireCooldown(weapon, shooter.hack) * 0.9 || now < shooter.switchEnd - 0.1) return;
    if (weapon.melee) {
      this.revealFakeLag(shooter, now);
      return this.onSwing(shooter, weapon, msg, now);
    }
    if (!infinite && (shooter.reloadEnd || shooter.ammo[shooter.weapon] <= 0)) return; // no shooting while reloading or empty
    if (!Number.isFinite(msg.yaw) || !Number.isFinite(msg.pitch)) return;
    shooter.lastShot = now;
    this.revealFakeLag(shooter, now);
    if (!infinite) shooter.ammo[shooter.weapon] -= 1;
    shooter.protectedUntil = 0; // firing ends spawn protection

    // Fired from the shooter's eye as they saw it (o): our copy of their
    // position is one 'state' message behind, which while running puts the
    // shot ~0.3 m off. Only trusted near where we have them (bots send none).
    const eye = [shooter.pos[0], shooter.pos[1] + eyeHeight(shooter.crouch), shooter.pos[2]];
    const o = Array.isArray(msg.o) && msg.o.length === 3 && msg.o.every(Number.isFinite) ? msg.o : null;
    const origin = o && Math.hypot(...o.map((x, i) => x - eye[i])) < MAX_SHOT_ORIGIN_OFFSET ? o : eye;
    // The shot's direction(s), spread included (applied by the shooter so their
    // tracers show where the shots really went; see README "Cheating"): one,
    // or one per pellet.
    const valid = (d) => Array.isArray(d) && d.length === 3 && d.every(Number.isFinite);
    let dirs;
    if (weapon.pellets) {
      if (!Array.isArray(msg.ds) || msg.ds.length !== weapon.pellets || !msg.ds.every(valid)) return;
      dirs = msg.ds.map(normalize);
    } else {
      dirs = [valid(msg.d) ? normalize(msg.d) : lookDir(msg.yaw, msg.pitch)];
    }

    // Trace each shot against the other players where the shooter saw them
    // (see seenBy); add up the damage per player hit.
    const seen = this.seenBy(msg.v);
    const ends = [];
    const hits = new Map(); // victim -> { damage, headshot }
    const wallbang = hasHack(shooter.hack, 'wallbang'); // (through walls: anyone along the shot)
    for (const dir of dirs) {
      const wall = this.world.raycast(origin, dir, MAX_RANGE);
      let dist = wallbang ? MAX_RANGE : wall;
      let victim = null;
      let headshot = false;
      for (const p of this.players.values()) {
        if (p.team === shooter.team || p.dead) continue; // bullets pass through teammates
        const pose = seen(p);
        const hit = rayPlayer(origin, dir, pose.pos, pose);
        if (hit.t < dist) { dist = hit.t; victim = p; headshot = hit.headshot; }
      }
      if (!victim) dist = wall; // (a miss still stops at the wall)
      dist = Math.min(dist, MAX_RANGE);
      ends.push(origin.map((o, i) => round(o + dir[i] * dist)));
      if (victim && (headshot || !this.mode.headshotOnly)) { // (headshot mode: the body takes the shot, unhurt)
        const h = hits.get(victim) ?? { damage: 0, headshot: false };
        h.damage += shotDamage(weapon, headshot, dist);
        h.headshot ||= headshot;
        hits.set(victim, h);
      }
    }
    this.broadcast(weapon.pellets
      ? { t: 'shot', from: shooter.id, w: shooter.weapon, o: origin.map(round), es: ends }
      : { t: 'shot', from: shooter.id, w: shooter.weapon, o: origin.map(round), e: ends[0] });

    for (const [victim, { damage, headshot }] of hits) this.applyHit(shooter, victim, damage, headshot, origin, now);
  }

  // A knife swing: hits the nearest enemy (where the swinger saw them) within
  // reach, in front (within SWING_ANGLE of where they look, about level with
  // them) and not behind a wall. From behind (the victim facing the same way
  // as the swing): the weapon's backDamage.
  onSwing(shooter, weapon, msg, now) {
    if (!Number.isFinite(msg.yaw) || !Number.isFinite(msg.pitch)) return;
    shooter.lastShot = now;
    shooter.protectedUntil = 0;
    const eye = [shooter.pos[0], shooter.pos[1] + eyeHeight(shooter.crouch), shooter.pos[2]];
    const fx = -Math.sin(msg.yaw);
    const fz = -Math.cos(msg.yaw);
    const seen = this.seenBy(msg.v);
    let victim = null;
    let nearest = Infinity;
    for (const p of this.players.values()) {
      if (p.team === shooter.team || p.dead) continue;
      const pose = seen(p);
      const dx = pose.pos[0] - shooter.pos[0];
      const dz = pose.pos[2] - shooter.pos[2];
      const dist = Math.hypot(dx, dz);
      if (dist > weapon.melee.range + PLAYER_RADIUS || Math.abs(pose.pos[1] - shooter.pos[1]) > SWING_HEIGHT) continue;
      if (dist > PLAYER_RADIUS && (dx * fx + dz * fz) / dist < Math.cos(SWING_ANGLE)) continue;
      const chest = [pose.pos[0], pose.pos[1] + 1.1, pose.pos[2]];
      const d = chest.map((v, i) => v - eye[i]);
      const len = Math.hypot(...d);
      if (!hasHack(shooter.hack, 'wallbang') && this.world.raycast(eye, d.map((v) => v / len), len) < len - 0.05) continue;
      if (dist < nearest) { nearest = dist; victim = p; }
    }
    this.broadcast({ t: 'shot', from: shooter.id, w: shooter.weapon, o: eye.map(round), es: [] }); // (others see the swing)
    if (!victim) return;
    const { yaw } = seen(victim);
    const behind = -Math.sin(yaw) * fx - Math.cos(yaw) * fz > BACKSTAB;
    this.applyHit(shooter, victim, behind ? weapon.melee.backDamage : weapon.damage, false, eye, now);
  }

  // A chat message: to everyone, with the sender's name and team (trimmed,
  // at most CHAT_MAX characters, one per CHAT_GAP seconds per player).
  onChat(p, text) {
    const now = performance.now() / 1000;
    if (typeof text !== 'string' || now - (p.chatAt ?? 0) < CHAT_GAP) return;
    text = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return;
    p.chatAt = now;
    this.broadcast({ t: 'chat', name: p.name, team: p.team, text });
  }

  // A smoke bomb thrown: if theirs is ready, it leaves the hand
  // THROW_RELEASE into the throw (others see the throw now), flies (see
  // updateGrenades) and pops; theirs is ready again SMOKE.cooldown later.
  onThrow(p, msg) {
    const now = performance.now() / 1000;
    if (p.dead || now < p.smokeAt || !Number.isFinite(msg.yaw) || !Number.isFinite(msg.pitch)) return;
    p.smokeAt = now + SMOKE.cooldown;
    p.protectedUntil = 0;
    this.grenades.push({
      id: ++this.grenadeSeq, owner: p, releaseAt: now + THROW_TIME * THROW_RELEASE,
      yaw: msg.yaw, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, msg.pitch)),
    });
    this.broadcast({ t: 'throw', from: p.id, m: msg.m ? 1 : 0 });
  }

  // Smoke bombs: leave the hand (from the eye, along the view, up a little:
  // everyone simulates the flight from there), fly, pop into a cloud after
  // SMOKE.fuse; clouds clear after their duration.
  updateGrenades(now, dt) {
    for (const g of [...this.grenades]) {
      if (!g.pos) {
        if (now < g.releaseAt) continue;
        const p = g.owner;
        if (p.dead) { this.grenades.splice(this.grenades.indexOf(g), 1); continue; }
        const dir = lookDir(g.yaw, g.pitch);
        const eye = [p.pos[0], p.pos[1] + eyeHeight(p.crouch), p.pos[2]];
        const out = Math.max(0.1, Math.min(0.5, this.world.raycast(eye, dir, 0.6) - 0.1)); // (not through a wall in front)
        g.pos = eye.map((v, i) => v + dir[i] * out);
        g.vel = dir.map((v, i) => v * SMOKE.speed + (i === 1 ? SMOKE.up : 0));
        g.popAt = now + SMOKE.fuse;
        this.broadcast({ t: 'nade', id: g.id, p: g.pos.map(round), v: g.vel.map(round) });
        continue;
      }
      this.world.stepGrenade(g, dt);
      if (now >= g.popAt) {
        this.grenades.splice(this.grenades.indexOf(g), 1);
        const smoke = { id: g.id, pos: g.pos.map(round), at: now, duration: SMOKE.duration };
        this.smokes.push(smoke);
        this.broadcast({ t: 'smoke', id: smoke.id, p: smoke.pos, d: smoke.duration });
      }
    }
    this.smokes = this.smokes.filter((s) => now < s.at + s.duration);
  }

  // Is the line of sight from a to b through smoke? (Bots.)
  smokeBlocks(a, b) {
    return smokeBlocks(this.smokes, a, b, performance.now() / 1000);
  }

  // Fake-lag hack: attacking removes the afterimage and shows the player to
  // everyone for FAKE_LAG_REVEAL seconds; the next afterimage then.
  revealFakeLag(p, now) {
    if (!hasHack(p.hack, 'fakelag')) return;
    p.ghost = null;
    p.revealUntil = now + FAKE_LAG_REVEAL;
    p.ghostAt = p.revealUntil;
  }

  // Renew fake-lag players' afterimages (every FAKE_LAG_GHOST seconds, not
  // while revealed); none for anyone else.
  updateFakeLag(now) {
    for (const p of this.players.values()) {
      if (p.dead || !hasHack(p.hack, 'fakelag')) {
        p.ghost = null;
        p.ghostAt = 0;
        p.revealUntil = 0;
      } else if (now >= p.revealUntil && now >= p.ghostAt) {
        p.ghost = { pos: [...p.pos], yaw: p.yaw, pitch: p.pitch, crouch: p.crouch, weapon: p.weapon };
        p.ghostAt = now + FAKE_LAG_GHOST;
      }
    }
  }

  // Where enemies (bots, other players' hacks) see a player: { pos, pose }
  // (pose for headCenter), or null if they can't (fake-lag with no
  // afterimage yet). A fake-lag player not revealed: their afterimage.
  apparent(q, now = performance.now() / 1000) {
    if (hasHack(q.hack, 'fakelag') && now >= q.revealUntil) {
      const g = q.ghost;
      return g && { pos: g.pos, pose: { yaw: g.yaw, pitch: g.pitch, weapon: g.weapon, crouch: g.crouch, skin: q.skin } };
    }
    return { pos: q.pos, pose: this.seenBy()(q) };
  }

  // Lag compensation. Clients draw the other players between two snapshots,
  // INTERP_DELAY behind (plus the trip from the host), and say which with
  // each shot: v = [snapshot n before, snapshot n after, fraction between].
  // Returns p => the pose a player had there (position, aim, weapon, crouch,
  // and velocity for the head's lean; skin: body size), as the shooter saw it. Without v (bots),
  // or once those snapshots are older than HISTORY: where they are now.
  seenBy(v) {
    const find = (n) => this.history.find((h) => h.n === n);
    const latest = this.history.at(-1);
    let a = Array.isArray(v) ? find(v[0]) : null;
    let b = Array.isArray(v) ? find(v[1]) : null;
    const k = Array.isArray(v) && Number.isFinite(v[2]) ? Math.min(1, Math.max(0, v[2])) : 1;
    if (!a || !b) a = b = null;
    return (p) => {
      let pa = a?.players.get(p.id);
      let pb = b?.players.get(p.id);
      if (!pa || !pb) {
        // Now; velocity from the last two snapshots.
        const prev = this.history.at(-2)?.players.get(p.id);
        const last = latest?.players.get(p.id);
        const vel = prev && last ? last.pos.map((x, i) => (x - prev.pos[i]) * SNAPSHOT_RATE) : undefined;
        return { pos: p.pos, yaw: p.yaw, pitch: p.pitch, weapon: p.weapon, vel, skin: p.skin, crouch: p.crouch };
      }
      if (Math.hypot(pb.pos[0] - pa.pos[0], pb.pos[2] - pa.pos[2]) > 3) pa = pb; // respawned (as the client draws it)
      const steps = Math.max(1, b.n - a.n);
      return {
        pos: pa.pos.map((x, i) => x + (pb.pos[i] - x) * k),
        yaw: pa.yaw + Math.atan2(Math.sin(pb.yaw - pa.yaw), Math.cos(pb.yaw - pa.yaw)) * k,
        pitch: pa.pitch + (pb.pitch - pa.pitch) * k,
        weapon: pb.weapon,
        crouch: pa.crouch + (pb.crouch - pa.crouch) * k, // (eased in between, like the drawn character)
        vel: pb.pos.map((x, i) => ((x - pa.pos[i]) * SNAPSHOT_RATE) / steps),
        skin: p.skin,
      };
    };
  }

  applyHit(shooter, victim, damage, headshot, origin, now) {
    const hit = { t: 'hit', attacker: shooter.id, victim: victim.id, from: origin.map(round) };
    if (now < victim.protectedUntil) {
      this.broadcast({ ...hit, hp: victim.hp, blocked: 1 }); // spawn-protected: no damage
      return;
    }
    victim.hp = Math.max(0, victim.hp - damage);
    this.broadcast({ ...hit, hp: victim.hp, hs: headshot ? 1 : 0 });
    if (victim.hp === 0) {
      victim.dead = true;
      victim.respawnAt = now + RESPAWN_TIME;
      victim.reloadEnd = 0;
      victim.spawnWeapon = -1;
      victim.hack = 0; // hacks last until death
      victim.maxHp = MAX_HP;
      shooter.score += 1;
      this.teamKills[shooter.team] += 1;
      // Money: the victim for the time they stayed alive, the killer per kill.
      const alive = now - victim.spawnedAt;
      const earned = Math.round(alive * SURVIVAL_RATE);
      victim.money += earned;
      shooter.money += KILL_REWARD;
      this.sendTo(victim.id, { t: 'buy', money: victim.money, wait: RESPAWN_TIME, earned, alive: Math.round(alive) });
      this.sendTo(shooter.id, { t: 'earn', amount: KILL_REWARD, money: shooter.money });
      this.broadcast({ t: 'feed', key: 'kill', killer: shooter.name, victim: victim.name, hs: headshot ? 1 : 0 });
      const target = this.mode.killTarget;
      if (target && !this.roundOverAt && this.teamKills[shooter.team] >= target) this.teamWins(shooter.team, now);
    }
  }

  onReload(player) {
    const weapon = WEAPONS[player.weapon];
    if (player.dead || player.reloadEnd || player.ammo[player.weapon] >= weapon.magSize || hasHack(player.hack, 'ammo')) return;
    player.reloadEnd = performance.now() / 1000 + weapon.reloadTime - RELOAD_GRACE;
  }

  // Switching (Admin only) cancels a reload; the new weapon can fire after SWITCH_TIME.
  onWeapon(player, index) {
    if (player.name !== ADMIN_NAME) return;
    if (player.dead || !Number.isInteger(index) || !weaponAllowed(this.mode, index) || index === player.weapon) return;
    this.giveWeapon(player, index);
  }

  // The buy menu's Start: spawn with that weapon and hacks (when the respawn
  // delay is over, if they can afford both; charged at the spawn).
  onSpawn(player, index, hack) {
    if (!player.dead || !Number.isInteger(index) || !WEAPONS[index] || !Number.isInteger(hack) || hack < 0 || hack > ALL_HACKS) return;
    if (!withinHackLimit(hack, this.hackLimit) || !weaponAllowed(this.mode, index) || (hack & hacksOffMask(this.mode))) return;
    if (weaponPrice(this.mode, index) + hacksPrice(hack) > player.money) return;
    player.spawnWeapon = index;
    player.spawnHack = hack;
  }

  giveWeapon(player, index) {
    player.weapon = index;
    player.reloadEnd = 0;
    player.switchEnd = performance.now() / 1000 + SWITCH_TIME;
  }

  // (-2: a weapon spot in a mode with set weapons: off.)
  refill(kind) {
    if (kind === 'weapon' && this.mode.weapons) return -2;
    return kind === 'weapon' ? randomPickupWeapon() : 1;
  }

  // A living player standing in a spot's circle takes what's there: a
  // weapon if it's not the one they hold (full magazine), a heal pack if
  // they're hurt, money always.
  updatePickups(now) {
    for (const spot of this.pickups) {
      if (spot.item < 0) {
        if (now >= spot.readyAt) spot.item = this.refill(spot.kind);
        continue;
      }
      const [x, y, z] = spot.pos;
      for (const p of this.players.values()) {
        if (p.dead) continue;
        if (spot.kind === 'heal' ? p.hp >= p.maxHp : spot.kind === 'weapon' && p.weapon === spot.item) continue;
        if (Math.hypot(p.pos[0] - x, p.pos[2] - z) > PICKUP_RADIUS || Math.abs(p.pos[1] - y) > 1.2) continue;
        if (spot.kind === 'heal') {
          p.hp = Math.min(p.maxHp, p.hp + HEAL_AMOUNT);
          this.sendTo(p.id, { t: 'heal', hp: p.hp });
        } else if (spot.kind === 'money') {
          p.money += MONEY_AMOUNT;
          this.sendTo(p.id, { t: 'cash', amount: MONEY_AMOUNT, money: p.money });
        } else {
          this.giveWeapon(p, spot.item);
          p.ammo[spot.item] = WEAPONS[spot.item].magSize;
          this.sendTo(p.id, { t: 'pickup', w: spot.item });
        }
        spot.item = -1;
        spot.readyAt = now + ({ heal: HEAL_RESPAWN, money: MONEY_RESPAWN }[spot.kind] ?? PICKUP_RESPAWN);
        break;
      }
    }
  }

  // ---- tick --------------------------------------------------------------

  // Called at a steady rate from a Web Worker timer (see main.js), so the
  // host keeps serving even while its tab is in the background.
  tick() {
    const now = performance.now() / 1000;

    // Players gone silent (closed / crashed tab, lost connection).
    for (const p of [...this.players.values()]) {
      if (p.id !== HOST_ID && !this.bots.isBot(p.id) && now - (p.lastSeen ?? now) > PLAYER_TIMEOUT) this.removePlayer(p.id);
    }

    if (this.roundOverAt && now >= this.roundOverAt) this.newRound();
    if (!this.roundOverAt) this.spawnPlayers(now); // (victory screen: nobody spawns)
    if (!this.roundOverAt) this.updatePickups(now);
    const dt = Math.min(0.1, now - this.lastTick);
    this.lastTick = now;
    this.updateFakeLag(now);
    this.updateGrenades(now, dt);
    this.bots.update(now, dt);

    for (const p of this.players.values()) {
      if (p.reloadEnd && now >= p.reloadEnd) {
        p.ammo[p.weapon] = WEAPONS[p.weapon].magSize;
        p.reloadEnd = 0;
      }
    }

    if (now - this.lastSnapshot >= 1 / SNAPSHOT_RATE) this.sendSnapshots(now);
  }

  // Players whose buy-menu pick is in and whose respawn delay is over.
  spawnPlayers(now) {
    for (const p of this.players.values()) {
      if (p.dead && p.spawnWeapon >= 0 && now >= p.respawnAt) {
        const price = weaponPrice(this.mode, p.spawnWeapon) + hacksPrice(p.spawnHack);
        if (price > p.money) { p.spawnWeapon = -1; continue; }
        p.money -= price;
        if (hasHack(p.spawnHack, 'victory')) {
          this.victory(p, now);
          return; // (round over)
        }
        const spawn = this.spawnPoint(p.team, p.id);
        p.pos = spawn.pos;
        p.hack = p.spawnHack;
        p.smokeAt = 0; // (a fresh smoke bomb)
        p.holdingSmoke = false;
        p.maxHp = this.mode.hp ?? (hasHack(p.hack, 'hp') ? HACK_HP : MAX_HP);
        p.hp = p.maxHp;
        p.dead = false;
        p.ammo = WEAPONS.map((w) => w.magSize);
        p.weapon = p.spawnWeapon; // the one they bought (picked-up weapons are lost on death)
        p.spawnWeapon = -1;
        p.joining = false;
        p.spawnedAt = now;
        p.reloadEnd = 0;
        p.switchEnd = 0;
        p.protectedUntil = now + SPAWN_PROTECTION;
        p.crouch = 0;
        p.climbing = false;
        this.sendTo(p.id, { t: 'respawn', pos: p.pos, yaw: spawn.yaw, w: p.weapon, h: p.hack, hp: p.hp, money: p.money });
      }
    }
  }

  sendSnapshots(now) {
    this.lastSnapshot = now;
    const all = [...this.players.values()];
    const n = ++this.snapSeq;
    this.history.push({ n, players: new Map(all.map((p) => [p.id, { pos: [...p.pos], yaw: p.yaw, pitch: p.pitch, weapon: p.weapon, crouch: p.crouch }])) });
    if (this.history.length > HISTORY) this.history.shift();
    const players = all.map((p) => ({
      id: p.id,
      name: p.name,
      skin: p.skin,
      team: p.team,
      p: p.pos.map(round),
      yaw: round(p.yaw),
      pitch: round(p.pitch),
      hp: p.hp,
      score: p.score,
      dead: p.dead,
      w: p.weapon,
      rl: p.reloadEnd ? 1 : 0, // reloading (for the animation)
      c: p.crouch, // crouched
      l: p.climbing ? 1 : 0, // on a ladder (for the animation)
      sp: now < p.protectedUntil ? 1 : 0, // spawn-protected
      m: p.money,
      gone: p.dead && (p.joining || now >= p.respawnAt) ? 1 : 0, // in the buy menu: not drawn
      sm: p.holdingSmoke && !p.dead ? 1 : 0, // holding the smoke bomb
      sc: round(Math.max(0, p.smokeAt - now)), // seconds until their smoke bomb is ready
      // Fake-lag hack (everyone sees its effects): on, revealed, the afterimage.
      ...(!p.dead && hasHack(p.hack, 'fakelag') ? {
        fl: 1,
        rv: now < p.revealUntil ? 1 : 0,
        g: p.ghost && { p: p.ghost.pos.map(round), yaw: round(p.ghost.yaw), pitch: round(p.ghost.pitch), c: p.ghost.crouch, w: p.ghost.weapon },
      } : {}),
    }));
    const pk = this.pickups.map((s) => s.item); // what's on each spot (-1 = empty), in ALL_SPOTS order
    const pt = this.pickups.map((s) => (s.item < 0 ? round(Math.max(0, s.readyAt - now)) : 0)); // seconds until refilled
    // Hacks are secret from the other team: each team's snapshot carries
    // only its own players' hacks (h).
    // Smoke clouds out now (for players who join while one's out): how old.
    const sk = this.smokes.map((s) => ({ id: s.id, p: s.pos, age: round(now - s.at), d: s.duration }));
    const byTeam = [0, 1].map((team) => ({
      t: 'snap', n, pk, pt, sk, tk: this.teamKills,
      players: players.map((s, i) => (all[i].team === team ? { ...s, h: all[i].hack } : s)),
    }));
    for (const team of [0, 1]) this.sendMany(all.filter((p) => p.team === team).map((p) => p.id), byTeam[team], false);
  }

  // Someone bought the victory hack: their team wins.
  victory(player, now) {
    this.endRound(now);
    this.broadcast({ t: 'victory', team: player.team, by: player.name, time: VICTORY_SCREEN });
    this.broadcast({ t: 'feed', key: 'victory', name: player.name, team: player.team });
  }

  // A team reached the mode's kill target: it wins.
  teamWins(team, now) {
    this.endRound(now);
    this.broadcast({ t: 'victory', team, kills: this.mode.killTarget, time: VICTORY_SCREEN });
    this.broadcast({ t: 'feed', key: 'teamWins', n: this.mode.killTarget, team });
  }

  // Everyone leaves the world for the victory screen; then a new round
  // starts from scratch.
  endRound(now) {
    this.roundOverAt = now + VICTORY_SCREEN;
    for (const p of this.players.values()) {
      p.dead = true;
      p.joining = true;
      p.spawnWeapon = -1;
      p.reloadEnd = 0;
      p.hack = 0;
    }
  }

  newRound() {
    this.roundOverAt = 0;
    this.teamKills = [0, 0];
    this.grenades = [];
    this.smokes = [];
    for (const p of this.players.values()) {
      Object.assign(p, {
        money: this.startMoney(p), score: 0, hack: 0, maxHp: MAX_HP, hp: MAX_HP, dead: true, joining: true,
        spawnWeapon: -1, spawnHack: 0, respawnAt: 0, weapon: DEFAULT_WEAPON,
      });
      p.ammo = WEAPONS.map((w) => w.magSize);
      this.sendTo(p.id, { t: 'buy', money: p.money, wait: 0, round: true });
    }
    for (const spot of this.pickups) {
      spot.item = this.refill(spot.kind);
      spot.readyAt = 0;
    }
  }

  destroy() {
    this.bots.removeAll();
    for (const id of [...this.conns.keys()]) this.removePlayer(id);
    this.peer.destroy();
  }
}
