// Client game loop: menu, input, local movement, interpolation of remote
// players and HUD. Works the same whether we're the host or a joiner — only
// the `send` function differs.

import {
  STATE_SEND_RATE, INTERP_DELAY, EYE_HEIGHT, FIRE_COOLDOWN, MAX_HP, MOVE_SPEED,
  MAX_RANGE, lookDir, playerAABB, rayAABB,
} from './shared.js';
import { makeRoomCode, openHostPeer, joinRoom } from './net.js';
import { HostServer, HOST_ID } from './host.js';
import { Renderer } from './render.js';
import { loadAssets, loadMap } from './assets.js';
import { World } from './world.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

const renderer = new Renderer(canvas);

// Models must be loaded before the game can start.
$('hostBtn').disabled = true;
$('joinBtn').disabled = true;
$('status').textContent = 'Loading models…';
let world;
try {
  const [, map] = await Promise.all([loadAssets(renderer.renderer), loadMap(renderer.renderer)]);
  world = new World(map.collision, map.meta);
  renderer.setMap(map.visual);
} catch (err) {
  $('status').textContent = `Could not load models: ${err.message}`;
  throw err;
}
renderer.buildGun();
$('status').textContent = '';
$('hostBtn').disabled = false;
$('joinBtn').disabled = false;

// ---- session state ---------------------------------------------------------

let session = null; // { send(msg, reliable), close(), code, isHost }
let myId = null;
const me = { pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, yaw: 0, pitch: 0, hp: MAX_HP, dead: false };
let snapshots = []; // [{ time, players: Map<id, playerState> }]
let latestPlayers = []; // most recent snapshot array, for the scoreboard
let lastStateSent = 0;
let lastShotTime = 0;

// ---- input -----------------------------------------------------------------

const keys = new Set();
let mouseDown = false;
const locked = () => document.pointerLockElement === canvas;

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Tab' && session) { e.preventDefault(); $('scoreboard').hidden = false; }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab') $('scoreboard').hidden = true;
});
window.addEventListener('blur', () => { keys.clear(); mouseDown = false; });

// Rejects when not triggered by a user gesture (e.g. after an await); the
// "Click to play" prompt covers that case.
const requestLock = () => Promise.resolve(canvas.requestPointerLock()).catch(() => {});
canvas.addEventListener('click', () => { if (session && !locked()) requestLock(); });
document.addEventListener('pointerlockchange', () => { $('clickToPlay').hidden = locked(); });
document.addEventListener('mousemove', (e) => {
  if (!locked()) return;
  me.yaw -= e.movementX * 0.0022;
  me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - e.movementY * 0.0022));
});
document.addEventListener('mousedown', (e) => { if (locked() && e.button === 0) mouseDown = true; });
document.addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; });

function readMoveInput() {
  const active = locked() && !me.dead;
  const k = (code) => (active && keys.has(code) ? 1 : 0);
  return {
    forward: k('KeyW') - k('KeyS'),
    right: k('KeyD') - k('KeyA'),
    jump: !!k('Space'),
    yaw: me.yaw,
  };
}

// ---- incoming messages -----------------------------------------------------

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      myId = msg.id;
      teleport(msg.pos);
      break;
    case 'snap': {
      const players = new Map(msg.players.map((p) => [p.id, p]));
      snapshots.push({ time: performance.now(), players });
      if (snapshots.length > 30) snapshots.shift();
      latestPlayers = msg.players;
      const mine = players.get(myId);
      if (mine) { me.hp = mine.hp; me.dead = mine.dead; }
      for (const id of renderer.avatars.keys()) if (!players.has(id)) renderer.removeAvatar(id);
      updateScoreboard();
      break;
    }
    case 'shot':
      if (msg.from !== myId) {
        renderer.addTracer(msg.o, msg.e); // our own were drawn instantly
        renderer.avatarFired(msg.from);
      }
      break;
    case 'hit':
      if (msg.attacker === myId) flash('hitmarker', 120);
      if (msg.victim === myId) {
        me.hp = msg.hp;
        if (msg.hp === 0) me.dead = true;
        flash('damage', 150);
      }
      break;
    case 'respawn':
      teleport(msg.pos);
      me.hp = MAX_HP;
      me.dead = false;
      break;
    case 'leave':
      renderer.removeAvatar(msg.id);
      break;
    case 'feed':
      addFeed(msg.text);
      break;
  }
}

function teleport(pos) {
  me.pos = [...pos];
  me.vel = [0, 0, 0];
  // Face the arena centre.
  me.yaw = Math.atan2(pos[0], pos[2]);
  me.pitch = 0;
}

// ---- shooting --------------------------------------------------------------

function tryShoot(now) {
  if (!mouseDown || me.dead || !locked() || now - lastShotTime < FIRE_COOLDOWN * 1000) return;
  lastShotTime = now;

  // Draw the tracer immediately against what we currently see, so shooting
  // feels responsive. The host decides whether it actually hit.
  const origin = [me.pos[0], me.pos[1] + EYE_HEIGHT, me.pos[2]];
  const dir = lookDir(me.yaw, me.pitch);
  let dist = world.raycast(origin, dir, MAX_RANGE);
  for (const [id, avatar] of renderer.avatars) {
    if (avatar.dead || id === myId) continue;
    const box = playerAABB(avatar.object.position.toArray());
    dist = Math.min(dist, rayAABB(origin, dir, box.min, box.max));
  }
  const muzzle = [origin[0] + dir[0] * 0.5, origin[1] - 0.15, origin[2] + dir[2] * 0.5];
  renderer.addTracer(muzzle, origin.map((o, i) => o + dir[i] * dist));
  renderer.kickGun();

  session.send({ t: 'shoot', yaw: me.yaw, pitch: me.pitch }, true);
}

// ---- remote player interpolation --------------------------------------------

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function renderRemotePlayers(now, dt) {
  if (snapshots.length === 0) return;
  const renderTime = now - INTERP_DELAY;

  // Find the two snapshots that bracket renderTime.
  let a = snapshots[0];
  let b = snapshots[0];
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].time <= renderTime) {
      a = snapshots[i];
      b = snapshots[i + 1] ?? snapshots[i];
      break;
    }
  }
  const span = b.time - a.time;
  const t = span > 0 ? Math.min(1, (renderTime - a.time) / span) : 1;

  for (const [id, pb] of b.players) {
    if (id === myId) continue;
    let pa = a.players.get(id) ?? pb;
    // Don't slide across the map when someone respawns.
    if (Math.hypot(pb.p[0] - pa.p[0], pb.p[2] - pa.p[2]) > 3) pa = pb;
    renderer.updateAvatar(id, pb.name, pb.skin, {
      pos: [0, 1, 2].map((i) => pa.p[i] + (pb.p[i] - pa.p[i]) * t),
      yaw: lerpAngle(pa.yaw, pb.yaw, t),
      pitch: pa.pitch + (pb.pitch - pa.pitch) * t,
      dead: pb.dead,
    }, dt);
  }
}

// ---- HUD -------------------------------------------------------------------

const flashTimers = {};
function flash(id, ms) {
  const el = $(id);
  el.classList.add('show');
  clearTimeout(flashTimers[id]);
  flashTimers[id] = setTimeout(() => el.classList.remove('show'), ms);
}

function addFeed(text) {
  const div = document.createElement('div');
  div.textContent = text;
  $('killfeed').prepend(div);
  setTimeout(() => div.remove(), 5000);
}

function updateScoreboard() {
  const table = $('scoreboard');
  table.replaceChildren();
  const header = table.insertRow();
  for (const h of ['Player', 'Kills']) {
    const th = document.createElement('th');
    th.textContent = h;
    header.appendChild(th);
  }
  for (const p of [...latestPlayers].sort((x, y) => y.score - x.score)) {
    const row = table.insertRow();
    if (p.id === myId) row.className = 'me';
    row.insertCell().textContent = p.name;
    row.insertCell().textContent = p.score;
  }
}

function updateHud() {
  $('hp').textContent = me.hp;
  $('deadMsg').hidden = !me.dead;
}

// ---- main loop -------------------------------------------------------------

let lastFrame = performance.now();
let menuAngle = 0.6;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (session && myId) {
    if (!me.dead) world.stepPlayer(me, readMoveInput(), dt);
    tryShoot(now);

    if (!me.dead && now - lastStateSent >= 1000 / STATE_SEND_RATE) {
      lastStateSent = now;
      session.send({ t: 'state', p: me.pos, yaw: me.yaw, pitch: me.pitch }, false);
    }

    renderRemotePlayers(now, dt);
    updateHud();
  } else {
    // Idle camera orbiting the map behind the menu.
    menuAngle += dt * 0.05;
  }

  renderer.gun.visible = !!session;
  if (session) {
    const eye = [me.pos[0], me.pos[1] + EYE_HEIGHT, me.pos[2]];
    const move = !me.dead && me.onGround ? Math.hypot(me.vel[0], me.vel[2]) / MOVE_SPEED : 0;
    renderer.render(dt, eye, me.yaw, me.pitch, move);
  } else {
    const eye = [Math.sin(menuAngle) * 38, 18, Math.cos(menuAngle) * 38];
    renderer.render(dt, eye, menuAngle, -Math.atan2(16, 38), 0);
  }
}
requestAnimationFrame(frame);

// For inspecting the game from the browser console while developing.
window.hackfps = { renderer, me, world };

// ---- host / join -----------------------------------------------------------

// A Web Worker drives the host tick: worker timers aren't throttled as hard
// as main-thread timers when the host tab is in the background.
function startTicker(fn) {
  const src = 'setInterval(() => postMessage(0), 1000 / 60);';
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = fn;
  return () => worker.terminate();
}

function playerName() {
  return $('name').value.trim() || 'Player';
}

function setStatus(text) {
  $('status').textContent = text;
}

function setBusy(busy) {
  $('hostBtn').disabled = busy;
  $('joinBtn').disabled = busy;
}

function enterGame(code, isHost) {
  $('menu').hidden = true;
  $('hud').hidden = false;
  setStatus('');
  $('roomInfo').textContent = isHost
    ? `Hosting · Room code: ${code} · share it with friends`
    : `Room ${code}`;
  requestLock();
}

function leaveGame(reason) {
  const old = session;
  session = null; // clear first: closing fires 'close' events that call back here
  old?.close();
  myId = null;
  snapshots = [];
  latestPlayers = [];
  me.dead = false;
  me.hp = MAX_HP;
  renderer.clearAvatars();
  if (document.pointerLockElement) document.exitPointerLock();
  $('hud').hidden = true;
  $('menu').hidden = false;
  setBusy(false);
  setStatus(reason ?? '');
}

$('hostBtn').addEventListener('click', async () => {
  setBusy(true);
  setStatus('Creating room…');
  let peer;
  let code;
  for (let attempt = 0; attempt < 3 && !peer; attempt++) {
    code = makeRoomCode();
    try {
      peer = await openHostPeer(code);
    } catch (err) {
      if (err.type !== 'unavailable-id') {
        setStatus(`Could not host: ${err.message}`);
        setBusy(false);
        return;
      }
    }
  }
  if (!peer) {
    setStatus('Could not get a free room code, try again');
    setBusy(false);
    return;
  }

  const server = new HostServer(peer, onMessage, world);
  const stopTicker = startTicker(() => server.tick());
  peer.on('error', (err) => console.warn('peer error', err));

  session = {
    send: (msg) => server.handleMessage(HOST_ID, msg),
    close: () => { stopTicker(); server.destroy(); },
  };
  server.handleMessage(HOST_ID, { t: 'join', name: playerName() });
  enterGame(code, true);
});

$('joinBtn').addEventListener('click', async () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 5) return setStatus('Enter a 5-character room code');
  setBusy(true);
  setStatus('Connecting…');

  let conn;
  try {
    conn = await joinRoom(code);
  } catch (err) {
    setStatus(err.message);
    setBusy(false);
    return;
  }

  const { peer, rel, state } = conn;
  rel.on('data', onMessage);
  state.on('data', onMessage);
  const onLost = () => { if (session) leaveGame('Disconnected from host'); };
  rel.on('close', onLost);
  rel.on('error', onLost);

  session = {
    send: (msg, reliable) => {
      const c = reliable ? rel : state;
      if (c.open) c.send(msg);
    },
    close: () => peer.destroy(),
  };
  rel.send({ t: 'join', name: playerName() });
  enterGame(code, false);
});

$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
