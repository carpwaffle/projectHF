// The "server" that runs inside the host's browser tab. It owns health, scores,
// hit detection and respawns, and broadcasts world snapshots to every client.
// The host's own player is just another player with id "host" whose messages
// are delivered by direct function call instead of over WebRTC.

import {
  SNAPSHOT_RATE, MAX_HP, DAMAGE, FIRE_COOLDOWN, RESPAWN_TIME, EYE_HEIGHT, MAX_RANGE, TEAMS,
  MAG_SIZE, RELOAD_TIME, HEAD_DAMAGE, SPAWN_PROTECTION,
  pickSpawn, lookDir, headAABB, bodyAABB, rayAABB, normalize,
} from './shared.js';
import { SKINS } from './assets.js';

export const HOST_ID = 'host';

const round = (n) => Math.round(n * 100) / 100;

// The client starts its reload timer when the player presses reload, the
// host when the message arrives (half a round trip later). Finishing a little
// early here keeps the first shots after a reload from being rejected.
const RELOAD_GRACE = 0.2;

export class HostServer {
  // world: the map's World (collision, spawns), shared with the local client.
  constructor(peer, deliverLocal, world) {
    this.world = world;
    this.peer = peer;
    this.deliverLocal = deliverLocal; // (msg) => void, feeds the host's own client
    this.players = new Map();
    this.conns = new Map(); // clientId -> { rel, state }
    this.lastSnapshot = 0;

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
    const entry = this.conns.get(id);
    const conn = reliable ? entry?.rel : entry?.state;
    if (conn?.open) conn.send(msg);
  }

  broadcast(msg, reliable = true) {
    for (const id of this.players.keys()) this.sendTo(id, msg, reliable);
  }

  // ---- players -----------------------------------------------------------

  addPlayer(id, name) {
    if (this.players.has(id)) return;
    const team = this.pickTeam();
    const spawn = this.spawnPoint(team, id);
    const player = {
      id,
      name: String(name || 'Player').slice(0, 16),
      skin: this.pickSkin(),
      team,
      pos: spawn.pos,
      yaw: spawn.yaw ?? 0,
      pitch: 0,
      hp: MAX_HP,
      score: 0,
      dead: false,
      respawnAt: 0,
      lastShot: 0,
      ammo: MAG_SIZE,
      reloadEnd: 0, // host time (s) the current reload finishes, 0 = not reloading
      protectedUntil: performance.now() / 1000 + SPAWN_PROTECTION,
    };
    this.players.set(id, player);
    this.sendTo(id, { t: 'welcome', id, pos: player.pos, yaw: spawn.yaw, team });
    this.broadcast({ t: 'feed', text: `${player.name} joined ${TEAMS[team].name}` });
  }

  // The team with fewer players (random on a tie).
  pickTeam() {
    const counts = [0, 0];
    for (const p of this.players.values()) counts[p.team] += 1;
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
    this.conns.delete(id);
    entry?.rel?.close();
    entry?.state?.close();
    if (!player) return;
    this.players.delete(id);
    this.broadcast({ t: 'leave', id });
    this.broadcast({ t: 'feed', text: `${player.name} left` });
  }

  // ---- messages ----------------------------------------------------------

  handleMessage(id, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') return this.addPlayer(id, msg.name);

    const player = this.players.get(id);
    if (!player) return;
    if (msg.t === 'state') this.onState(player, msg);
    else if (msg.t === 'shoot') this.onShoot(player, msg);
    else if (msg.t === 'reload') this.onReload(player);
  }

  // Clients simulate their own movement and report the result. We trust it,
  // apart from keeping players inside the arena. (See README: "Cheating".)
  onState(player, msg) {
    if (player.dead || !Array.isArray(msg.p)) return;
    const [x, y, z] = msg.p.map(Number);
    if (![x, y, z, msg.yaw, msg.pitch].every(Number.isFinite)) return;
    const r = Math.hypot(x, z);
    const k = r > this.world.playRadius ? this.world.playRadius / r : 1;
    player.pos = [x * k, Math.max(-2, Math.min(40, y)), z * k];
    player.yaw = msg.yaw;
    player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, msg.pitch));
  }

  onShoot(shooter, msg) {
    const now = performance.now() / 1000;
    if (shooter.dead || now - shooter.lastShot < FIRE_COOLDOWN * 0.9) return;
    if (shooter.reloadEnd || shooter.ammo <= 0) return; // no shooting while reloading or empty
    if (!Number.isFinite(msg.yaw) || !Number.isFinite(msg.pitch)) return;
    shooter.lastShot = now;
    shooter.ammo -= 1;
    shooter.protectedUntil = 0; // firing ends spawn protection

    const origin = [shooter.pos[0], shooter.pos[1] + EYE_HEIGHT, shooter.pos[2]];
    // The shot's direction, spread included (applied by the shooter so their
    // tracer shows where it really went; see README "Cheating").
    const dir = Array.isArray(msg.d) && msg.d.length === 3 && msg.d.every(Number.isFinite)
      ? normalize(msg.d) : lookDir(msg.yaw, msg.pitch);

    let dist = this.world.raycast(origin, dir, MAX_RANGE);
    let victim = null;
    let headshot = false;
    for (const p of this.players.values()) {
      if (p.team === shooter.team || p.dead) continue; // bullets pass through teammates
      const head = headAABB(p.pos);
      const body = bodyAABB(p.pos);
      const th = rayAABB(origin, dir, head.min, head.max);
      const tb = rayAABB(origin, dir, body.min, body.max);
      const t = Math.min(th, tb);
      if (t < dist) { dist = t; victim = p; headshot = th <= tb; }
    }
    dist = Math.min(dist, MAX_RANGE);
    const end = origin.map((o, i) => round(o + dir[i] * dist));
    this.broadcast({ t: 'shot', from: shooter.id, o: origin.map(round), e: end });

    if (!victim) return;
    const hit = { t: 'hit', attacker: shooter.id, victim: victim.id, from: origin.map(round) };
    if (now < victim.protectedUntil) {
      this.broadcast({ ...hit, hp: victim.hp, blocked: 1 }); // spawn-protected: no damage
      return;
    }
    victim.hp = Math.max(0, victim.hp - (headshot ? HEAD_DAMAGE : DAMAGE));
    this.broadcast({ ...hit, hp: victim.hp, hs: headshot ? 1 : 0 });
    if (victim.hp === 0) {
      victim.dead = true;
      victim.respawnAt = now + RESPAWN_TIME;
      victim.reloadEnd = 0;
      shooter.score += 1;
      this.broadcast({ t: 'feed', text: `${shooter.name} ➜ ${victim.name}${headshot ? ' (headshot)' : ''}` });
    }
  }

  onReload(player) {
    if (player.dead || player.reloadEnd || player.ammo >= MAG_SIZE) return;
    player.reloadEnd = performance.now() / 1000 + RELOAD_TIME - RELOAD_GRACE;
  }

  // ---- tick --------------------------------------------------------------

  // Called at a steady rate from a Web Worker timer (see main.js), so the
  // host keeps serving even while its tab is in the background.
  tick() {
    const now = performance.now() / 1000;

    for (const p of this.players.values()) {
      if (p.dead && now >= p.respawnAt) {
        const spawn = this.spawnPoint(p.team, p.id);
        p.pos = spawn.pos;
        p.hp = MAX_HP;
        p.dead = false;
        p.ammo = MAG_SIZE;
        p.protectedUntil = now + SPAWN_PROTECTION;
        this.sendTo(p.id, { t: 'respawn', pos: p.pos, yaw: spawn.yaw });
      }
    }

    for (const p of this.players.values()) {
      if (p.reloadEnd && now >= p.reloadEnd) {
        p.ammo = MAG_SIZE;
        p.reloadEnd = 0;
      }
    }

    if (now - this.lastSnapshot >= 1 / SNAPSHOT_RATE) {
      this.lastSnapshot = now;
      const players = [...this.players.values()].map((p) => ({
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
        rl: p.reloadEnd ? 1 : 0, // reloading (for the animation)
        sp: now < p.protectedUntil ? 1 : 0, // spawn-protected
      }));
      this.broadcast({ t: 'snap', players }, false);
    }
  }

  destroy() {
    for (const id of [...this.conns.keys()]) this.removePlayer(id);
    this.peer.destroy();
  }
}
