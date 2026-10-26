// Client game loop: menu, input, local movement, interpolation of remote
// players and HUD. Works the same whether we're the host or a joiner — only
// the `send` function differs.

import {
  STATE_SEND_RATE, INTERP_DELAY, EYE_HEIGHT, MAX_HP, MOVE_SPEED,
  MAX_RANGE, TEAMS, WEAPONS, DEFAULT_WEAPON, SWITCH_TIME, RESPAWN_TIME, SPAWN_PROTECTION,
  lookDir, playerAABB, rayAABB, spreadFor, spreadDir,
} from './shared.js';
import { makeRoomCode, openHostPeer, joinRoom } from './net.js';
import { HostServer, HOST_ID } from './host.js';
import { Renderer } from './render.js';
import { loadAssets, loadMap } from './assets.js';
import { World } from './world.js';
import { unlockAudio, playSound, setListener, toggleMute, audioDebug } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

const renderer = new Renderer(canvas);
renderer.onSound = playSound;

// Models must be loaded before the game can start.
$('hostBtn').disabled = true;
$('joinBtn').disabled = true;
$('status').textContent = 'Loading models…';
let world;
try {
  const [, map] = await Promise.all([loadAssets(renderer.renderer), loadMap(renderer.renderer)]);
  world = new World(map.collision, map.meta);
  renderer.setMap(map.visual, map.lightmap, map.meta.lightmap?.intensity);
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
let myTeam = 0;
let roomLabel = '';
const me = {
  pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, yaw: 0, pitch: 0, hp: MAX_HP, dead: false,
  weapon: DEFAULT_WEAPON, lastWeapon: WEAPONS.findIndex((w) => w.id === 'rifle'), // index into WEAPONS (Q: last weapon)
  ammo: WEAPONS.map((w) => w.magSize), // per weapon
  reloadEnd: 0, // performance.now() ms when the reload finishes, 0 = not reloading
  switchEnd: 0, // performance.now() ms when the weapon switch finishes
  scope: 0, // 0 = not scoped .. 1 = fully scoped
  spread: 0, // current shot spread (radians), follows movement
  protectedUntil: 0, // performance.now() ms; spawn protection (for the HUD; the host enforces it)
};
let deathInfo = null; // { killer, headshot, at } while dead
let damageDirs = []; // [{ from:[x,z], at, el }] red arcs pointing at whoever hit us
let snapshots = []; // [{ time, players: Map<id, playerState> }]
let latestPlayers = []; // most recent snapshot array, for the scoreboard
let lastStateSent = 0;
let lastShotTime = 0;
let pendingTracers = []; // our shots this frame: drawn once the rifle is posed for the frame

// ---- input -----------------------------------------------------------------

const keys = new Set();
let mouseDown = false;
let triggerPressed = false; // a click since the last frame (semi-automatic weapons)
let aimHeld = false; // right mouse button
const locked = () => document.pointerLockElement === canvas;
const weapon = () => WEAPONS[me.weapon];
const BASE_FOV = renderer.camera.fov;

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Tab' && session) { e.preventDefault(); $('scoreboard').hidden = false; }
  if (e.code === 'KeyR' && session && locked()) startReload(performance.now());
  if (e.code === 'KeyM' && session) addFeed(toggleMute() ? 'Sound off (M)' : 'Sound on (M)');
  if (session && locked()) {
    const digit = /^Digit(\d)$/.exec(e.code);
    if (digit && WEAPONS[digit[1] - 1]) switchWeapon(digit[1] - 1, performance.now());
    if (e.code === 'KeyQ') switchWeapon(me.lastWeapon, performance.now());
  }
});
window.addEventListener('wheel', (e) => {
  if (!session || !locked() || Math.abs(e.deltaY) < 1) return;
  switchWeapon((me.weapon + (e.deltaY > 0 ? 1 : WEAPONS.length - 1)) % WEAPONS.length, performance.now());
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab') $('scoreboard').hidden = true;
});
window.addEventListener('blur', () => { keys.clear(); mouseDown = false; aimHeld = false; });

// Rejects when not triggered by a user gesture (e.g. after an await); the
// "Click to play" prompt covers that case.
const requestLock = () => Promise.resolve(canvas.requestPointerLock()).catch(() => {});
canvas.addEventListener('click', () => { if (session && !locked()) requestLock(); });
document.addEventListener('pointerlockchange', () => { $('clickToPlay').hidden = locked(); });
document.addEventListener('mousemove', (e) => {
  if (!locked()) return;
  const sensitivity = 0.0022 * (renderer.camera.fov / BASE_FOV); // slower when zoomed in
  me.yaw -= e.movementX * sensitivity;
  me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - e.movementY * sensitivity));
});
document.addEventListener('mousedown', (e) => {
  if (!locked()) return;
  if (e.button === 0) { mouseDown = true; triggerPressed = true; }
  if (e.button === 2) aimHeld = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDown = false;
  if (e.button === 2) aimHeld = false;
});

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
      myTeam = msg.team ?? 0;
      renderer.setLocalTeam(myTeam);
      showRoomInfo();
      teleport(msg.pos, msg.yaw);
      me.protectedUntil = performance.now() + SPAWN_PROTECTION * 1000;
      break;
    case 'snap': {
      const players = new Map(msg.players.map((p) => [p.id, p]));
      snapshots.push({ time: performance.now(), players });
      if (snapshots.length > 30) snapshots.shift();
      latestPlayers = msg.players;
      const mine = players.get(myId);
      if (mine) {
        me.hp = mine.hp;
        me.dead = mine.dead;
        renderer.setViewmodel(mine.skin); // first-person body in our own skin
      }
      for (const id of renderer.avatars.keys()) if (!players.has(id)) renderer.removeAvatar(id);
      updateScoreboard();
      break;
    }
    case 'shot':
      if (msg.from !== myId) { // (our own were drawn instantly)
        const ends = msg.es ?? [msg.e];
        const hit = (e) => Math.hypot(...e.map((v, i) => v - msg.o[i])) < MAX_RANGE - 0.5;
        renderer.remoteShot(msg.from, msg.o, ends, ends.map(hit));
      }
      break;
    case 'hit':
      if (msg.attacker === myId) {
        showHitmarker(msg.blocked ? 'blocked' : msg.hp === 0 ? 'kill' : msg.hs ? 'head' : 'body');
        if (msg.hp === 0 && !msg.blocked) showKillConfirm(nameOf(msg.victim), msg.hs);
      }
      if (msg.victim === myId && !msg.blocked) {
        me.hp = msg.hp;
        flash('damage', 150);
        if (msg.from) addDamageDir(msg.from);
        if (msg.hp === 0) {
          me.dead = true;
          deathInfo = { killer: nameOf(msg.attacker), headshot: !!msg.hs, at: performance.now() };
        }
      }
      break;
    case 'respawn':
      teleport(msg.pos, msg.yaw);
      me.hp = MAX_HP;
      me.dead = false;
      deathInfo = null;
      me.protectedUntil = performance.now() + SPAWN_PROTECTION * 1000;
      me.ammo = WEAPONS.map((w) => w.magSize);
      me.reloadEnd = 0;
      me.switchEnd = 0;
      break;
    case 'leave':
      renderer.removeAvatar(msg.id);
      break;
    case 'feed':
      addFeed(msg.text);
      break;
  }
}

// yaw: the spawn's facing from the map; without one, face the arena centre.
function teleport(pos, yaw) {
  me.pos = [...pos];
  me.vel = [0, 0, 0];
  me.yaw = yaw ?? Math.atan2(pos[0], pos[2]);
  me.pitch = 0;
}

// ---- shooting --------------------------------------------------------------

// Ammo is predicted here for an instant HUD; the host keeps its own count
// and ignores shots while reloading or empty.
function startReload(now) {
  if (me.dead || me.reloadEnd || me.ammo[me.weapon] >= weapon().magSize) return;
  me.reloadEnd = now + weapon().reloadTime * 1000;
  session.send({ t: 'reload' }, true);
}

function updateReload(now) {
  if (me.dead) me.reloadEnd = 0;
  if (me.reloadEnd && now >= me.reloadEnd) {
    me.ammo[me.weapon] = weapon().magSize;
    me.reloadEnd = 0;
  }
  renderer.reload = me.reloadEnd ? 1 - (me.reloadEnd - now) / (weapon().reloadTime * 1000) : -1;
}

// Every player carries all the weapons; switching cancels a reload, and the
// new one can't fire until it's drawn (SWITCH_TIME). The host enforces both.
function switchWeapon(index, now) {
  if (me.dead || index === me.weapon || !WEAPONS[index]) return;
  me.lastWeapon = me.weapon;
  me.weapon = index;
  me.reloadEnd = 0;
  me.switchEnd = now + SWITCH_TIME * 1000;
  me.scope = 0;
  session.send({ t: 'weapon', w: index }, true);
}

// Scoping (weapons with a zoomFov): hold the right mouse button. Not while
// reloading, switching or working the bolt (it scopes back in afterwards).
const BOLT_BUSY = 0.75; // seconds after a sniper shot the bolt is being worked
function updateScope(dt, now) {
  const w = weapon();
  const want = aimHeld && w.zoomFov && !me.dead && !me.reloadEnd && now >= me.switchEnd
    && now - lastShotTime > BOLT_BUSY * 1000;
  me.scope = want ? Math.min(1, me.scope + dt / w.scopeTime) : Math.max(0, me.scope - dt / 0.12);
  const fov = w.zoomFov ? BASE_FOV + (w.zoomFov - BASE_FOV) * me.scope : BASE_FOV;
  renderer.setFov(fov);
}

function tryShoot(now) {
  const w = weapon();
  const pulled = w.auto ? mouseDown : triggerPressed; // semi-automatic: one shot per click
  triggerPressed = false;
  if (!pulled || me.dead || !locked() || now - lastShotTime < w.cooldown * 1000 || now < me.switchEnd) return;
  if (me.reloadEnd) return;
  if (me.ammo[me.weapon] <= 0) return startReload(now); // pulling the trigger on empty reloads
  lastShotTime = now;
  me.ammo[me.weapon] -= 1;
  me.protectedUntil = 0; // firing ends spawn protection

  // Draw the tracer immediately against what we currently see, so shooting
  // feels responsive. The host decides whether it actually hit. The spread
  // is applied here so the tracer shows where the shot really goes.
  const origin = [me.pos[0], me.pos[1] + EYE_HEIGHT, me.pos[2]];
  const aim = spreadDir(lookDir(me.yaw, me.pitch), me.spread);
  // Shotgun: several pellets in a cone around the aimed direction.
  const dirs = w.pellets ? Array.from({ length: w.pellets }, () => spreadDir(aim, w.pelletSpread)) : [aim];
  for (const dir of dirs) {
    let dist = world.raycast(origin, dir, MAX_RANGE);
    for (const [id, avatar] of renderer.avatars) {
      if (avatar.dead || id === myId || avatar.team === myTeam) continue;
      const box = playerAABB(avatar.object.position.toArray());
      dist = Math.min(dist, rayAABB(origin, dir, box.min, box.max));
    }
    pendingTracers.push({ end: origin.map((o, i) => o + dir[i] * dist), hit: dist < MAX_RANGE });
  }

  session.send(w.pellets
    ? { t: 'shoot', w: me.weapon, yaw: me.yaw, pitch: me.pitch, ds: dirs }
    : { t: 'shoot', w: me.weapon, yaw: me.yaw, pitch: me.pitch, d: aim }, true);
  if (me.ammo[me.weapon] === 0) startReload(now); // auto-reload when the magazine runs dry
}

// ---- remote player interpolation --------------------------------------------

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Height of the map surface under a position (for the blob shadow).
const SHADOW_PROBE = 10;
function groundBelow(pos) {
  const start = pos[1] + 0.1;
  return start - world.raycast([pos[0], start, pos[2]], [0, -1, 0], SHADOW_PROBE);
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
    const pos = [0, 1, 2].map((i) => pa.p[i] + (pb.p[i] - pa.p[i]) * t);
    renderer.updateAvatar(id, pb.name, pb.skin, pb.team, {
      pos,
      ground: groundBelow(pos),
      yaw: lerpAngle(pa.yaw, pb.yaw, t),
      pitch: pa.pitch + (pb.pitch - pa.pitch) * t,
      dead: pb.dead,
      reloading: !!pb.rl,
      protected: !!pb.sp,
      weapon: pb.w ?? 0,
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

// Team score = the team's total kills.
function updateScoreboard() {
  const totals = TEAMS.map((_, t) => latestPlayers.filter((p) => p.team === t).reduce((n, p) => n + p.score, 0));
  const teamScore = $('teamScore');
  teamScore.replaceChildren();
  TEAMS.forEach((team, t) => {
    const span = document.createElement('span');
    span.textContent = `${team.name} ${totals[t]}`;
    span.style.color = team.color;
    if (t === myTeam) span.className = 'mine';
    teamScore.appendChild(span);
  });

  const table = $('scoreboard');
  table.replaceChildren();
  const header = table.insertRow();
  for (const h of ['Team', 'Player', 'Kills']) {
    const th = document.createElement('th');
    th.textContent = h;
    header.appendChild(th);
  }
  for (const p of [...latestPlayers].sort((x, y) => x.team - y.team || y.score - x.score)) {
    const row = table.insertRow();
    if (p.id === myId) row.className = 'me';
    const team = row.insertCell();
    team.textContent = TEAMS[p.team]?.name ?? '';
    team.style.color = TEAMS[p.team]?.color ?? '';
    row.insertCell().textContent = p.name;
    row.insertCell().textContent = p.score;
  }
}

function showRoomInfo() {
  const info = $('roomInfo');
  info.textContent = myId ? `${roomLabel} · You are ${TEAMS[myTeam].name}` : roomLabel;
  info.style.borderLeft = myId ? `4px solid ${TEAMS[myTeam].color}` : '';
}

function nameOf(id) {
  return latestPlayers.find((p) => p.id === id)?.name ?? 'someone';
}

// kind: 'body' | 'head' (gold) | 'kill' (big red) | 'blocked' (grey: spawn-protected)
function showHitmarker(kind) {
  const el = $('hitmarker');
  el.classList.remove('body', 'head', 'kill', 'blocked');
  el.classList.add(kind);
  flash('hitmarker', kind === 'kill' ? 260 : 120);
}

function showKillConfirm(name, headshot) {
  const el = $('killConfirm');
  el.textContent = `Eliminated ${name}${headshot ? ' · headshot' : ''}`;
  flash('killConfirm', 1600);
}

// A red arc around the crosshair pointing at where the shot came from; it
// keeps pointing there as you turn, and fades out.
const DAMAGE_DIR_TIME = 1500;
function addDamageDir(from) {
  const el = document.createElement('div');
  el.className = 'damageDir';
  $('damageDirs').appendChild(el);
  damageDirs.push({ from: [from[0], from[2]], at: performance.now(), el });
}

function updateDamageDirs(now) {
  const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw); // forward
  const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw); // right
  damageDirs = damageDirs.filter((d) => {
    const age = now - d.at;
    if (age > DAMAGE_DIR_TIME) {
      d.el.remove();
      return false;
    }
    const vx = d.from[0] - me.pos[0], vz = d.from[1] - me.pos[2];
    const angle = Math.atan2(vx * rx + vz * rz, vx * fx + vz * fz); // 0 = ahead, + = right
    d.el.style.transform = `rotate(${angle}rad) translateY(-130px)`;
    d.el.style.opacity = String(1 - age / DAMAGE_DIR_TIME);
    return true;
  });
}

// Crosshair ticks spread apart to show the current shot spread.
function updateCrosshair() {
  const halfFov = (renderer.camera.fov / 2) * (Math.PI / 180);
  const gap = 4 + (Math.tan(me.spread) / Math.tan(halfFov)) * (window.innerHeight / 2);
  $('crosshairTicks').style.setProperty('--gap', `${gap.toFixed(1)}px`);
}

function updateHud(now) {
  $('hp').textContent = me.hp;
  $('weaponName').textContent = WEAPONS.map((w, i) => (i === me.weapon ? `[${i + 1}] ${w.name}` : `${i + 1}`)).join('  ');
  $('ammoCount').textContent = me.ammo[me.weapon];
  $('magSize').textContent = weapon().magSize;
  $('ammo').classList.toggle('empty', me.ammo[me.weapon] === 0);
  $('scope').hidden = me.scope < 0.85;
  $('crosshair').hidden = $('crosshairTicks').hidden = me.scope > 0.05;
  $('reloadMsg').hidden = !me.reloadEnd || me.dead;

  $('deadMsg').hidden = !me.dead;
  if (me.dead) {
    const left = deathInfo ? Math.max(0, RESPAWN_TIME - (now - deathInfo.at) / 1000) : null;
    $('deadMsg').innerHTML = '';
    const title = document.createElement('div');
    title.textContent = deathInfo ? `Killed by ${deathInfo.killer}${deathInfo.headshot ? ' · headshot' : ''}` : 'You died';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = left === null ? 'Respawning…' : `Respawning in ${left.toFixed(1)}`;
    $('deadMsg').append(title, sub);
  }

  const protectedLeft = me.dead ? 0 : (me.protectedUntil - now) / 1000;
  $('protectMsg').hidden = protectedLeft <= 0;
  if (protectedLeft > 0) $('protectMsg').textContent = `Spawn protection ${protectedLeft.toFixed(1)}`;

  updateDamageDirs(now);
  updateCrosshair();
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
    updateReload(now);
    updateScope(dt, now);
    tryShoot(now);

    if (!me.dead && now - lastStateSent >= 1000 / STATE_SEND_RATE) {
      lastStateSent = now;
      session.send({ t: 'state', p: me.pos, yaw: me.yaw, pitch: me.pitch }, false);
    }

    // Spread eases toward what the current movement allows.
    const speed = Math.hypot(me.vel[0], me.vel[2]);
    me.spread += (spreadFor(weapon(), speed, me.onGround, me.scope > 0.95) - me.spread) * (1 - Math.exp(-12 * dt));

    renderRemotePlayers(now, dt);
    updateHud(now);
  } else {
    // Idle camera orbiting the map behind the menu.
    menuAngle += dt * 0.05;
  }

  renderer.gun.visible = !!session && !me.dead;
  if (session) {
    const eye = [me.pos[0], me.pos[1] + EYE_HEIGHT, me.pos[2]];
    renderer.updateViewmodel(dt, {
      pos: me.pos,
      yaw: me.yaw,
      pitch: me.pitch,
      vel: [me.vel[0], me.onGround ? 0 : me.vel[1], me.vel[2]],
      dead: me.dead,
      reloading: !!me.reloadEnd,
      ground: me.onGround ? me.pos[1] : groundBelow(me.pos),
      weapon: me.weapon,
      hidden: me.scope > 0.85, // looking through the scope
      eye,
    });
    setListener(eye, lookDir(me.yaw, me.pitch));
    // Tracers start at the muzzle as it's drawn this frame, before the recoil
    // kick (applied from the next frame) lifts the rifle: otherwise the line
    // hangs ~5 cm above the muzzle while the rifle drops back.
    if (pendingTracers.length) {
      const muzzle = renderer.localMuzzle();
      for (const shot of pendingTracers) renderer.addTracer(muzzle, shot.end, shot.hit);
      renderer.kickGun(); // once per trigger pull (a shotgun's pellets are one shot)
    }
    pendingTracers = [];
    const move = !me.dead && me.onGround ? Math.hypot(me.vel[0], me.vel[2]) / MOVE_SPEED : 0;
    renderer.render(dt, eye, me.yaw, me.pitch, move);
  } else {
    const eye = [Math.sin(menuAngle) * 38, 18, Math.cos(menuAngle) * 38];
    renderer.render(dt, eye, menuAngle, -Math.atan2(16, 38), 0);
  }
}
requestAnimationFrame(frame);

// For inspecting the game from the browser console while developing.
window.hackfps = { renderer, me, world, audioDebug };

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
  roomLabel = isHost ? `Hosting · Room code: ${code} · share it with friends` : `Room ${code}`;
  showRoomInfo(); // (the host's own welcome has already arrived)
  requestLock();
}

function leaveGame(reason) {
  const old = session;
  session = null; // clear first: closing fires 'close' events that call back here
  old?.close();
  myId = null;
  snapshots = [];
  latestPlayers = [];
  deathInfo = null;
  for (const d of damageDirs) d.el.remove();
  damageDirs = [];
  me.protectedUntil = 0;
  $('teamScore').replaceChildren();
  me.dead = false;
  me.hp = MAX_HP;
  me.weapon = DEFAULT_WEAPON;
  me.ammo = WEAPONS.map((w) => w.magSize);
  me.reloadEnd = 0;
  me.switchEnd = 0;
  me.scope = 0;
  aimHeld = false;
  renderer.setFov(BASE_FOV);
  renderer.reload = -1;
  renderer.clearAvatars();
  renderer.clearViewmodel();
  if (document.pointerLockElement) document.exitPointerLock();
  $('hud').hidden = true;
  $('menu').hidden = false;
  setBusy(false);
  setStatus(reason ?? '');
}

$('hostBtn').addEventListener('click', async () => {
  unlockAudio(); // (browsers allow audio only after a click)
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
  window.hackfps.server = server; // (dev hook)
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
  unlockAudio();
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
