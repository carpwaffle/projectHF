// Connections between the host and the players. Normally PeerJS: the host
// registers a peer ID derived from a room code on the PeerJS signaling
// broker; clients connect to that ID. After the WebRTC handshake, all
// traffic flows browser-to-browser.
//
// Each client opens two data channels to the host:
//   "rel"   – reliable + ordered: join, shots, kills, respawns
//   "state" – unreliable + unordered (UDP-like): positions and snapshots
//
// Fallback: the relay (relay/, a Cloudflare Worker; RELAY_URL). The host
// opens the room there too; a player whose direct connection fails (VPNs,
// firewalls) or can't reach PeerJS joins through it instead. Relayed
// connections look like PeerJS ones to the rest of the game (on('data'),
// send, open, close; both channels share the one WebSocket), so a room can
// mix direct and relayed players.

import { Peer } from 'peerjs';
import { ICE_SERVERS, RELAY_URL } from './config.js';

const ID_PREFIX = 'hackfps-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER_OPTIONS = { config: { iceServers: ICE_SERVERS } };
// "?relay" in the page address: join through the relay straight away (testing).
const FORCE_RELAY = new URLSearchParams(location.search).has('relay');
const DIRECT_TIMEOUT = RELAY_URL ? 8000 : 15000; // ms a direct join gets (sooner to the relay, if there is one)
const RELAY_TIMEOUT = 8000; // ms to reach the relay
const PEER_GRACE = 4000; // ms PeerJS still gets once the relay has the room
// The relay's close codes (relay/src/index.js: CLOSE).
const RELAY_CLOSE = { hostLeft: 4000, noRoom: 4004, taken: 4009, full: 4029, kicked: 4010 };
// Direct-join failures that mean the host was there (see explainFailure).
const FOUND_HOST = ['net.noAnswer', 'net.noDirect', 'net.failed'];

// Same-machine testing: browsers advertise their local address as a random
// "<uuid>.local" name that has to be resolved over multicast DNS. VPNs and
// endpoint security software often block mDNS, so the connection never
// starts. When served from localhost, also try each such candidate at
// 127.0.0.1, which reaches another browser/tab on this same computer.
if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  const addIceCandidate = RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate = function (candidate, ...rest) {
    const result = addIceCandidate.call(this, candidate, ...rest);
    const init = typeof candidate?.toJSON === 'function' ? candidate.toJSON() : candidate;
    if (/ udp .*\S+\.local /i.test(init?.candidate ?? '')) {
      const loopback = { ...init, candidate: init.candidate.replace(/\S+\.local/, '127.0.0.1') };
      addIceCandidate.call(this, loopback).catch(() => {});
    }
    return result;
  };
}

export function makeRoomCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

// An error whose message the menu shows in the player's language (i18n.js key).
function gameError(key, params) {
  return Object.assign(new Error(key), { i18n: key, params });
}

function withTimeout(promise, ms, key) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(gameError(key)), ms)),
  ]);
}

const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves with the host's end of the room: PeerJS and the relay (whichever
// opened; at least one). Like a Peer: on('connection' | 'error'), destroy().
// Rejects with type 'unavailable-id' if either already has that room code.
export async function openHostPeer(code) {
  const peer = settle(openPeerHost(code));
  const relay = await (RELAY_URL ? settle(openRelayHost(code)) : null);
  // With the relay up, PeerJS gets a few more seconds (behind some VPNs it
  // never answers); a late one is closed.
  let direct = relay?.value ? await Promise.race([peer, delay(PEER_GRACE).then(() => null)]) : await peer;
  if (!direct) {
    peer.then((late) => late.value?.destroy());
    direct = { error: gameError('net.signalTimeout') };
  }
  const parts = [direct.value, relay?.value].filter(Boolean);
  const taken = [direct.error, relay?.error].find((err) => err?.type === 'unavailable-id');
  if (taken || !parts.length) {
    for (const part of parts) part.destroy();
    throw taken ?? direct.error;
  }
  if (direct.error) console.warn('[net] hosting through the relay only:', direct.error);
  if (relay?.error) console.warn('[net] hosting without the relay:', relay.error);
  return new HostLink(parts);
}

// The PeerJS part: an open Peer that owns the room code.
function openPeerHost(code) {
  const peer = new Peer(ID_PREFIX + code, PEER_OPTIONS);
  const ready = new Promise((resolve, reject) => {
    peer.once('open', () => resolve(peer));
    peer.once('error', (err) => { peer.destroy(); reject(err); });
  });
  // If we lose the signaling server, existing games keep working but new
  // players can't join until we reconnect.
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  return withTimeout(ready, 10000, 'net.signalTimeout');
}

// Resolves with { peer, rel, state } once both channels to the host are
// open: directly, or else through the relay (onRelay() called first).
export async function joinRoom(code, onRelay) {
  let direct = null;
  if (!FORCE_RELAY || !RELAY_URL) {
    try {
      return await joinDirect(code);
    } catch (err) {
      if (!RELAY_URL) throw err;
      direct = err;
      console.warn('[net] direct join failed, trying the relay:', err);
    }
  }
  onRelay?.();
  try {
    return await joinRelay(code);
  } catch (err) {
    // Which to show: if the direct way found the host (a host without the
    // relay), why it failed; otherwise the relay's answer (no such room...).
    throw FOUND_HOST.includes(direct?.i18n) ? direct : err;
  }
}

function joinDirect(code) {
  const peer = new Peer(PEER_OPTIONS);
  let rel = null;
  let reachedHost = false;
  const ready = new Promise((resolve, reject) => {
    peer.once('error', (err) => {
      reject(err.type === 'peer-unavailable' ? gameError('net.roomNotFound') : err);
    });
    peer.once('open', () => {
      const hostId = ID_PREFIX + code;
      rel = peer.connect(hostId, { label: 'rel', reliable: true, serialization: 'json' });
      const state = peer.connect(hostId, { label: 'state', reliable: false, serialization: 'json' });
      watchIce(rel, () => { reachedHost = true; });
      const opened = (c) => new Promise((res) => c.once('open', res));
      Promise.all([opened(rel), opened(state)]).then(() => resolve({ peer, rel, state }));
    });
  });
  return withTimeout(ready, DIRECT_TIMEOUT, 'timeout').catch((err) => {
    const ice = rel?.peerConnection?.iceConnectionState;
    peer.destroy();
    if (err.i18n !== 'timeout') throw err;
    throw explainFailure(ice, reachedHost);
  });
}

// Log ICE progress to the console (useful when debugging connections) and
// note whether the host ever answered the WebRTC handshake.
function watchIce(conn, onRemoteAnswer) {
  const attach = () => {
    const pc = conn.peerConnection;
    if (!pc) return setTimeout(attach, 50);
    pc.addEventListener('iceconnectionstatechange', () => console.log('[net] ICE', pc.iceConnectionState));
    pc.addEventListener('signalingstatechange', () => {
      if (pc.signalingState === 'stable' && pc.remoteDescription) onRemoteAnswer();
    });
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) console.log('[net] local candidate', e.candidate.type, e.candidate.address);
    });
  };
  attach();
}

// Why a join timed out (the messages are in i18n.js: net.*).
function explainFailure(ice, reachedHost) {
  if (!reachedHost) return gameError('net.noAnswer');
  if (ice === 'checking' || ice === 'new' || ice === 'failed') return gameError('net.noDirect');
  return gameError('net.failed', { state: ice ?? 'unknown' });
}

// ---- relay ----------------------------------------------------------------

// A minimal event emitter (PeerJS objects' on / emit).
class Emitter {
  constructor() {
    this.handlers = {};
  }

  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event] ?? []) fn(...args);
  }
}

// The host's end of a room made of several parts (PeerJS, the relay).
class HostLink extends Emitter {
  constructor(parts) {
    super();
    this.parts = parts;
    for (const part of parts) {
      part.on('connection', (conn) => this.emit('connection', conn));
      part.on('error', (err) => this.emit('error', err));
    }
  }

  destroy() {
    for (const part of this.parts) part.destroy();
  }
}

// A WebSocket to the room on the relay; resolves once it says hello, with
// the socket, or rejects with why not (the room code taken: type
// 'unavailable-id', as PeerJS; no such room; full; unreachable).
function openRelaySocket(code, role) {
  const ws = new WebSocket(`${RELAY_URL}/room/${code}?role=${role}`);
  const ready = new Promise((resolve, reject) => {
    ws.onmessage = ({ data }) => {
      const [head, body] = split(data);
      if (head === '!hello') resolve(ws);
      else if (head === '!bye') reject(relayRefusal(Number(body)));
    };
    ws.onclose = () => reject(gameError('net.relayUnreachable'));
  });
  return withTimeout(ready, RELAY_TIMEOUT, 'net.relayUnreachable').catch((err) => {
    ws.close();
    throw err;
  });
}

function relayRefusal(code) {
  if (code === RELAY_CLOSE.taken) return Object.assign(gameError('net.roomTaken'), { type: 'unavailable-id' });
  if (code === RELAY_CLOSE.noRoom) return gameError('net.roomNotFound');
  if (code === RELAY_CLOSE.full) return gameError('net.roomFull');
  return gameError('net.relayUnreachable');
}

// "<head>\n<body>" -> [head, body]; a payload alone (JSON has no raw line
// breaks) -> ['', payload].
function split(data) {
  const nl = data.indexOf('\n');
  return nl < 0 ? ['', data] : [data.slice(0, nl), data.slice(nl + 1)];
}

// The relay part of the host's end: each player there shows up (event
// 'connection') as two connections, 'rel' and 'state', over this socket.
async function openRelayHost(code) {
  return new RelayHost(await openRelaySocket(code, 'host'));
}

class RelayHost extends Emitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.players = new Map(); // id -> { rel, state }
    ws.onmessage = ({ data }) => this.receive(data);
    ws.onclose = () => {
      for (const id of [...this.players.keys()]) this.drop(id);
      if (!this.destroyed) this.emit('error', gameError('net.relayUnreachable'));
    };
  }

  receive(data) {
    const [head, body] = split(data);
    if (head === '!join') {
      const conns = { rel: new RelayConnection(this, body, 'rel'), state: new RelayConnection(this, body, 'state') };
      this.players.set(body, conns);
      this.emit('connection', conns.rel);
      this.emit('connection', conns.state);
    } else if (head === '!leave') {
      this.drop(body);
    } else if (head === '!bye') {
      this.ws.close();
    } else if (head && head[0] !== '!') {
      const conns = this.players.get(head);
      if (!conns) return;
      let msg;
      try { msg = JSON.parse(body); } catch { return; }
      conns.rel.emit('data', msg); // (the host handles both channels alike)
    }
  }

  // A player gone (left, or the relay lost): their connections close.
  drop(id) {
    const conns = this.players.get(id);
    if (!conns) return;
    this.players.delete(id);
    for (const conn of [conns.rel, conns.state]) {
      conn.open = false;
      conn.emit('close');
    }
  }

  // One message to several players (the relay copies it to each).
  send(ids, msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(`${ids.join(',')}\n${JSON.stringify(msg)}`);
  }

  // The host dropping a player: the relay disconnects them.
  kick(id) {
    const conns = this.players.get(id);
    if (!conns) return;
    this.players.delete(id);
    conns.rel.open = false;
    conns.state.open = false;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(`!close\n${id}`);
  }

  destroy() {
    this.destroyed = true;
    this.ws.close();
  }
}

// A relayed player's connection as the host sees it (PeerJS DataConnection's
// peer, label, open, send, close, on). relay: for sending to several at once
// (HostServer.sendMany).
class RelayConnection extends Emitter {
  constructor(relay, peer, label) {
    super();
    this.relay = relay;
    this.peer = peer;
    this.label = label;
    this.open = true;
  }

  send(msg) {
    if (this.open) this.relay.send([this.peer], msg);
  }

  close() {
    this.relay.kick(this.peer);
  }
}

// A player joining through the relay: { peer, rel, state } like joinDirect.
// Everything from the host arrives on rel; state only sends.
async function joinRelay(code) {
  const ws = await openRelaySocket(code, 'player');
  const rel = new Emitter();
  const state = new Emitter();
  const open = () => ws.readyState === WebSocket.OPEN && !rel.ended;
  const send = (msg) => { if (open()) ws.send(JSON.stringify(msg)); };
  const end = () => {
    if (rel.ended) return;
    rel.ended = true;
    rel.emit('close');
  };
  for (const conn of [rel, state]) {
    Object.defineProperty(conn, 'open', { get: open });
    conn.send = send;
  }
  ws.onmessage = ({ data }) => {
    const [head] = split(data);
    if (head === '!bye') return end(); // (the host left, or dropped us)
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    rel.emit('data', msg);
  };
  ws.onclose = end;
  return { peer: { destroy: () => ws.close() }, rel, state, relayed: true };
}

