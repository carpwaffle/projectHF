// Hack FPS relay: a Cloudflare Worker with one Durable Object per room.
//
// Players normally connect to the host browser-to-browser (WebRTC, see
// src/net.js). When that fails (VPNs, strict firewalls) or the PeerJS
// server can't be reached, they connect here instead: the host and the
// players each open a WebSocket to the room's object, which passes messages
// between them. It knows nothing about the game and stores nothing; the
// host's browser still runs the game.
//
//   wss://<worker>/room/ABC12?role=host     the host (one per room)
//   wss://<worker>/room/ABC12?role=player   a player (needs the host there)
//
// Messages are text. Host -> relay: "<to>\n<payload>", <to> = "*" (every
// player) or player ids separated by commas; "!close\n<id>" disconnects a
// player. Relay -> host: "<id>\n<payload>" from a player, "!join\n<id>",
// "!leave\n<id>". Player <-> relay: the payload as it is. Everyone first
// gets "!hello\n<their id>". Refused or ended: "!bye\n<code>" (CLOSE), then
// the socket closes with that code (the message is what clients go by: a
// close doesn't always reach them promptly).

import { DurableObject } from 'cloudflare:workers';

// Where the game is served from (browsers send it as the Origin header);
// localhost too, for testing.
const ALLOWED_ORIGINS = ['https://carpwaffle.github.io'];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const MAX_PLAYERS = 16; // per room (the host not counted)
const MAX_MESSAGE = 64 * 1024; // characters
// Messages per second a socket may send (more are dropped): a player sends
// ~30 position updates plus its shots; the host a few per player.
const RATE = { player: 120, host: 2000 };

export const CLOSE = {
  hostLeft: 4000, // (to players) the room is gone
  noRoom: 4004, // no host for that code
  taken: 4009, // that code already has a host
  full: 4029,
  kicked: 4010, // the host dropped this player
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = /^\/room\/([A-Z0-9]{5})$/.exec(url.pathname)?.[1];
    if (!room) return new Response('Hack FPS relay', { status: url.pathname === '/' ? 200 : 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const origin = request.headers.get('Origin') ?? '';
    if (!ALLOWED_ORIGINS.includes(origin) && !LOCAL_ORIGIN.test(origin)) return new Response('Forbidden', { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

// Tell a socket why it's being closed, then close it.
function bye(ws, code) {
  try {
    ws.send(`!bye\n${code}`);
    ws.close(code, 'bye');
  } catch { /* (already closing) */ }
}

// One room. Sockets are accepted with the hibernation API, so a quiet room
// costs nothing; each carries its role and id (tags and attachment).
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rates = new Map(); // socket -> { second, count } (in memory only: fine to lose)
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role') === 'host' ? 'host' : 'player';
    const { 0: client, 1: server } = new WebSocketPair();
    const host = this.host();
    // Refused: accepted, then closed with the reason (browsers can't see
    // why a WebSocket handshake failed, but they do get the close code).
    const refuse = role === 'host' ? (host ? CLOSE.taken : 0)
      : !host ? CLOSE.noRoom : this.ctx.getWebSockets('player').length >= MAX_PLAYERS ? CLOSE.full : 0;
    const id = role === 'host' ? 'host' : crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server, refuse ? ['refused'] : [role, id]);
    server.serializeAttachment({ role, id, refused: !!refuse });
    if (refuse) {
      bye(server, refuse);
    } else {
      server.send(`!hello\n${id}`);
      if (role === 'player') host.send(`!join\n${id}`);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  host() {
    return this.ctx.getWebSockets('host')[0] ?? null;
  }

  async webSocketMessage(ws, data) {
    const { role, id, refused } = ws.deserializeAttachment();
    if (refused || typeof data !== 'string' || data.length > MAX_MESSAGE || !this.allow(ws, role)) return;
    if (role === 'player') {
      this.host()?.send(`${id}\n${data}`);
      return;
    }
    const nl = data.indexOf('\n');
    if (nl < 0) return;
    const to = data.slice(0, nl);
    const payload = data.slice(nl + 1);
    if (to === '!close') {
      for (const p of this.ctx.getWebSockets(payload)) bye(p, CLOSE.kicked);
      return;
    }
    const players = to === '*' ? this.ctx.getWebSockets('player') : to.split(',').flatMap((pid) => this.ctx.getWebSockets(pid));
    for (const p of players) {
      try { p.send(payload); } catch { /* (closing) */ }
    }
  }

  async webSocketClose(ws, code) {
    this.left(ws);
    try { ws.close(code === 1005 ? 1000 : code, 'closed'); } catch { /* (already closed) */ }
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  // The host gone: so is the room. A player gone: the host is told.
  left(ws) {
    this.rates.delete(ws);
    const { role, id, refused } = ws.deserializeAttachment();
    if (refused) return;
    if (role === 'host') {
      for (const p of this.ctx.getWebSockets('player')) bye(p, CLOSE.hostLeft);
    } else {
      try { this.host()?.send(`!leave\n${id}`); } catch { /* (closing) */ }
    }
  }

  // Under its rate this second?
  allow(ws, role) {
    const second = Math.floor(Date.now() / 1000);
    let r = this.rates.get(ws);
    if (!r || r.second !== second) this.rates.set(ws, r = { second, count: 0 });
    return ++r.count <= RATE[role];
  }
}
