// Thin wrapper around PeerJS. The host registers a peer ID derived from a room
// code on the PeerJS signaling broker; clients connect to that ID. After the
// WebRTC handshake, all traffic flows browser-to-browser.
//
// Each client opens two data channels to the host:
//   "rel"   – reliable + ordered: join, shots, kills, respawns
//   "state" – unreliable + unordered (UDP-like): positions and snapshots

import { Peer } from 'peerjs';
import { ICE_SERVERS } from './config.js';

const ID_PREFIX = 'hackfps-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER_OPTIONS = { config: { iceServers: ICE_SERVERS } };

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

// Resolves with an open Peer that owns the room code.
export function openHostPeer(code) {
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

// Resolves with { peer, rel, state } once both channels to the host are open.
export function joinRoom(code) {
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
  return withTimeout(ready, 15000, 'timeout').catch((err) => {
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
