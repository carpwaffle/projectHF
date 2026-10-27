// Client game loop: menu, input, local movement, interpolation of remote
// players and HUD. Works the same whether we're the host or a joiner — only
// the `send` function differs.

import {
  STATE_SEND_RATE, INTERP_DELAY, EYE_HEIGHT, MAX_HP, MOVE_SPEED,
  MAX_RANGE, TEAMS, WEAPONS, DEFAULT_WEAPON, SWITCH_TIME, RESPAWN_TIME, SPAWN_PROTECTION,
  ADMIN_NAME, PICKUP_SPOTS, HACKS, hackId, SPEED_HACK, FLY_HACK_SPEED, RECOIL_HACK, fireCooldown, headAABB, lookDir, playerAABB, rayAABB, spreadFor, spreadDir,
} from './shared.js';
import { makeRoomCode, openHostPeer, joinRoom } from './net.js';
import { HostServer, HOST_ID } from './host.js';
import { Renderer } from './render.js';
import { loadAssets, loadMap } from './assets.js';
import { World } from './world.js';
import { unlockAudio, playSound, setListener, toggleMute, audioDebug } from './audio.js';
import { Minimap } from './minimap.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

const renderer = new Renderer(canvas);
renderer.onSound = playSound;

// Models must be loaded before the game can start.
$('hostBtn').disabled = true;
$('joinBtn').disabled = true;
$('status').textContent = 'Loading models…';
let world;
const minimap = new Minimap($('minimap'), () => world, renderer);
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
  money: 0,
  hack: 0, // index into HACKS, until our next death
  weapon: DEFAULT_WEAPON, lastWeapon: WEAPONS.findIndex((w) => w.id === 'rifle'), // index into WEAPONS
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
  // Weapon switching (number keys, wheel): only for the player named "Admin".
  // (Q / E: the fly hack.)
  if (session && locked() && isAdmin()) {
    const digit = /^Digit(\d)$/.exec(e.code);
    if (digit && WEAPONS[digit[1] - 1]) switchWeapon(digit[1] - 1, performance.now());
  }
});
window.addEventListener('wheel', (e) => {
  if (!session || !locked() || !isAdmin() || Math.abs(e.deltaY) < 1) return;
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
canvas.addEventListener('click', () => { if (session && !locked() && $('buyMenu').hidden) requestLock(); });
document.addEventListener('pointerlockchange', () => { $('clickToPlay').hidden = locked(); });
document.addEventListener('mousemove', (e) => {
  if (!locked() || buy) return; // (no looking around in the buy menu)
  const sensitivity = 0.0022 * (renderer.camera.fov / BASE_FOV); // slower when zoomed in
  me.yaw -= e.movementX * sensitivity;
  me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - e.movementY * sensitivity));
});
document.addEventListener('mousedown', (e) => {
  if (!locked() || buy) return;
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
    speed: speedHack(),
    fly: hack() === 'fly' ? k('KeyQ') - k('KeyE') : undefined,
    noclip: hack() === 'noclip',
  };
}

// ---- incoming messages -----------------------------------------------------

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      me.dead = true; // until we pick a weapon in the buy menu
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
        me.money = mine.m ?? 0;
        renderer.setViewmodel(mine.skin); // first-person body in our own skin
      }
      for (const id of renderer.avatars.keys()) if (!players.has(id)) renderer.removeAvatar(id);
      if (msg.pk) renderer.updatePickups(msg.pk, msg.pt);
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
    case 'buy': // joined, or died: pick the weapon to spawn with
      openBuyMenu(msg);
      break;
    case 'earn':
      me.money = msg.money;
      addFeed(`+$${msg.amount} for the kill`);
      break;
    case 'victory':
      showVictory(msg);
      break;
    case 'respawn':
      closeBuyMenu();
      if (msg.money !== undefined) me.money = msg.money;
      me.hack = msg.h ?? 0;
      teleport(msg.pos, msg.yaw);
      me.hp = msg.hp ?? MAX_HP;
      me.dead = false;
      deathInfo = null;
      me.protectedUntil = performance.now() + SPAWN_PROTECTION * 1000;
      me.ammo = WEAPONS.map((w) => w.magSize);
      me.weapon = msg.w ?? DEFAULT_WEAPON; // back to the spawn weapon
      me.reloadEnd = 0;
      me.switchEnd = 0;
      me.scope = 0;
      break;
    case 'pickup': { // we walked over a weapon spot (the host has already given it to us)
      const now = performance.now();
      if (msg.w !== me.weapon) me.lastWeapon = me.weapon;
      me.weapon = msg.w;
      me.ammo[msg.w] = WEAPONS[msg.w].magSize;
      me.reloadEnd = 0;
      me.switchEnd = now + SWITCH_TIME * 1000;
      me.scope = 0;
      addFeed(`Picked up ${WEAPONS[msg.w].name}`);
      playSound('pickup', null);
      break;
    }
    case 'cash': // we walked over a money spot
      me.money = msg.money;
      flash('cash', 300);
      addFeed(`+$${msg.amount}`);
      playSound('pickup', null);
      break;
    case 'heal': // we walked over a heal pack
      me.hp = msg.hp;
      flash('heal', 300);
      addFeed('Healed');
      playSound('pickup', null);
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
const hack = () => hackId(me.hack);
const speedHack = () => (hack() === 'speed' ? SPEED_HACK : hack() === 'fly' ? FLY_HACK_SPEED : 1); // movement speed multiplier

function startReload(now) {
  if (hack() === 'ammo') return; // infinite ammo: never reloads
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
    && now - lastShotTime > BOLT_BUSY * (fireCooldown(w, me.hack) / w.cooldown) * 1000;
  me.scope = want ? Math.min(1, me.scope + dt / w.scopeTime) : Math.max(0, me.scope - dt / 0.12);
  const fov = w.zoomFov ? BASE_FOV + (w.zoomFov - BASE_FOV) * me.scope : BASE_FOV;
  renderer.setFov(fov);
}

function tryShoot(now) {
  const w = weapon();
  const pulled = w.auto ? mouseDown : triggerPressed; // semi-automatic: one shot per click
  triggerPressed = false;
  if (!pulled || me.dead || !locked() || now - lastShotTime < fireCooldown(w, me.hack) * 1000 || now < me.switchEnd) return;
  const infinite = hack() === 'ammo';
  if (me.reloadEnd && !infinite) return;
  if (me.ammo[me.weapon] <= 0 && !infinite) return startReload(now); // pulling the trigger on empty reloads
  lastShotTime = now;
  if (!infinite) me.ammo[me.weapon] -= 1;
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
    if (pb.gone) { renderer.removeAvatar(id); continue; } // in the buy menu
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
      fast: hackId(pb.h) === 'ammo', // (teammates only: enemies' hacks aren't sent)
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
  for (const h of ['Team', 'Player', 'Kills', 'Money', 'Hack']) {
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
    row.insertCell().textContent = `$${p.m ?? 0}`;
    // Hacks: only teammates' (the host doesn't send the other team's).
    row.insertCell().textContent = p.h === undefined ? '' : p.h ? HACKS[p.h].name.replace(/ hack$/, '') : '-';
  }
}

function showRoomInfo() {
  const info = $('roomInfo');
  info.textContent = myId ? `${roomLabel} · You are ${TEAMS[myTeam].name}` : roomLabel;
  info.style.borderLeft = myId ? `4px solid ${TEAMS[myTeam].color}` : '';
}

const isAdmin = () => nameOf(myId) === ADMIN_NAME;

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
  $('weaponName').textContent = isAdmin()
    ? WEAPONS.map((w, i) => (i === me.weapon ? `[${i + 1}] ${w.name}` : `${i + 1}`)).join('  ')
    : WEAPONS[me.weapon].name;
  $('ammoCount').textContent = hack() === 'ammo' ? '∞' : me.ammo[me.weapon];
  $('magSize').textContent = weapon().magSize;
  $('ammo').classList.toggle('empty', me.ammo[me.weapon] === 0 && hack() !== 'ammo');
  $('hackName').textContent = me.hack && !me.dead ? HACKS[me.hack].name : '';
  minimap.update(hack() === 'map' && !me.dead, me, myTeam);
  renderer.wallHack = hack() === 'wall' && !me.dead;
  updateVictory(now);
  $('scope').hidden = me.scope < 0.85;
  $('crosshair').hidden = $('crosshairTicks').hidden = me.scope > 0.05;
  $('reloadMsg').hidden = !me.reloadEnd || me.dead;

  $('money').textContent = `$${me.money}`;
  $('clickToPlay').hidden = locked() || !!buy; // (the buy menu has its own Start)
  updateBuyMenu(now);
  $('deadMsg').hidden = !me.dead || !$('buyMenu').hidden || !$('victory').hidden;
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

// ---- buy menu --------------------------------------------------------------
// On joining and after every death: pick the weapon to spawn with (what you
// can't afford is greyed out), then Start (after the respawn delay). The host
// checks the price and charges it at the spawn.

let buy = null; // { readyAt (performance.now ms), sent } while the menu is open
let buyChoice = DEFAULT_WEAPON; // remembered between deaths
let buyHack = 0; // index into HACKS, remembered too

// Radio options: name, price (and a description for hacks).
function buyOptions(items, group, onPick) {
  return items.map((item, i) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.value = i;
    input.addEventListener('change', () => onPick(i));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    if (item.desc) {
      const desc = document.createElement('small');
      desc.textContent = item.desc;
      name.append(desc);
    }
    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = item.price ? `$${item.price.toLocaleString()}` : 'Free';
    label.append(input, name, price);
    return label;
  });
}

function openBuyMenu(msg) {
  const now = performance.now();
  buy = { readyAt: now + (msg.wait ?? 0) * 1000, sent: false };
  me.dead = true;
  me.hack = 0; // hacks end with death
  me.money = msg.money ?? me.money;
  const info = $('buyInfo');
  info.replaceChildren();
  if (msg.earned !== undefined) {
    const killed = document.createElement('div');
    killed.textContent = deathInfo ? `Killed by ${deathInfo.killer}${deathInfo.headshot ? ' · headshot' : ''}` : 'You died';
    const earned = document.createElement('div');
    earned.className = 'earned';
    earned.textContent = `Survived ${msg.alive} s: +$${msg.earned}`;
    info.append(killed, earned);
  } else {
    info.textContent = msg.round ? 'New round! Pick a weapon and a hack.' : 'Pick a weapon and a hack to start with.';
  }
  $('buyList').replaceChildren(...buyOptions(WEAPONS, 'buyWeapon', (i) => { buyChoice = i; }));
  $('buyHacks').replaceChildren(...buyOptions(HACKS, 'buyHack', (i) => { buyHack = i; }));
  // Last time's picks if still affordable (dropping the hack first).
  if (WEAPONS[buyChoice].price + HACKS[buyHack].price > me.money) buyHack = 0;
  if (WEAPONS[buyChoice].price > me.money) buyChoice = DEFAULT_WEAPON;
  $('buyMenu').hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
  updateBuyMenu(now);
}

function closeBuyMenu() {
  buy = null;
  $('buyMenu').hidden = true;
}

// Every frame while open: money, what's affordable (with the other pick),
// the total, the Start countdown.
function updateBuyMenu(now) {
  if (!buy) return;
  // The menu needs the mouse pointer: release it if anything locked it.
  if (!buy.sent && document.pointerLockElement) document.exitPointerLock();
  $('buyMoney').textContent = `$${me.money.toLocaleString()}`;
  const weaponPrice = WEAPONS[buyChoice].price;
  const hackPrice = HACKS[buyHack].price;
  const mark = (list, items, chosen, otherPrice) => list.querySelectorAll('label').forEach((label, i) => {
    const input = label.firstChild;
    const locked = items[i].price + otherPrice > me.money;
    label.classList.toggle('locked', locked);
    input.disabled = locked || buy.sent;
    input.checked = i === chosen;
  });
  mark($('buyList'), WEAPONS, buyChoice, hackPrice);
  mark($('buyHacks'), HACKS, buyHack, weaponPrice);
  const total = weaponPrice + hackPrice;
  $('buyTotal').textContent = `Total $${total.toLocaleString()}`;
  $('buyTotal').classList.toggle('over', total > me.money);
  const start = $('buyStart');
  const wait = (buy.readyAt - now) / 1000;
  start.disabled = buy.sent || wait > 0 || total > me.money;
  start.textContent = buy.sent ? 'Spawning…' : wait > 0 ? `Start in ${wait.toFixed(1)}` : 'Start';
}

$('buyStart').addEventListener('click', () => {
  if (!buy || buy.sent || !session || WEAPONS[buyChoice].price + HACKS[buyHack].price > me.money) return;
  buy.sent = true;
  session.send({ t: 'spawn', w: buyChoice, h: buyHack }, true);
  if (hackId(buyHack) !== 'victory') requestLock(); // (a click: allowed to lock the mouse)
});

// ---- victory ---------------------------------------------------------------
// Someone bought the victory hack: their team wins; a new round follows
// (the host sends everyone back to the buy menu with $0).

let victoryUntil = 0; // performance.now() ms

function showVictory(msg) {
  closeBuyMenu();
  me.dead = true;
  me.hack = 0;
  victoryUntil = performance.now() + msg.time * 1000;
  const team = TEAMS[msg.team];
  const el = $('victory');
  el.replaceChildren();
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${team.name} wins!`;
  title.style.color = team.color;
  const by = document.createElement('div');
  by.textContent = `${msg.by} bought the Victory hack`;
  const next = document.createElement('div');
  next.className = 'next';
  el.append(title, by, next);
  el.hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

function updateVictory(now) {
  const el = $('victory');
  if (el.hidden) return;
  const left = (victoryUntil - now) / 1000;
  if (left <= -1 || buy) { el.hidden = true; return; } // (the new round's buy menu is up)
  el.querySelector('.next').textContent = `Next round in ${Math.max(0, Math.ceil(left))}`;
}

// ---- aim hack ---------------------------------------------------------------
// While Shift is held: snap the view onto the head of the visible enemy
// closest to where we're aiming (in sight and on screen).

const _head = [0, 0, 0];
function aimLock() {
  const eye = [me.pos[0], me.pos[1] + EYE_HEIGHT, me.pos[2]];
  const view = lookDir(me.yaw, me.pitch);
  const halfFov = (renderer.camera.fov / 2) * (Math.PI / 180);
  const limit = Math.atan(Math.tan(halfFov) * Math.hypot(1, renderer.camera.aspect)); // to the screen's corners
  let best = null;
  let bestAngle = limit;
  for (const [id, avatar] of renderer.avatars) {
    if (avatar.dead || id === myId || avatar.team === myTeam) continue;
    const head = headAABB(avatar.object.position.toArray());
    for (let i = 0; i < 3; i++) _head[i] = (head.min[i] + head.max[i]) / 2;
    const d = _head.map((v, i) => v - eye[i]);
    const dist = Math.hypot(...d);
    const dir = d.map((v) => v / dist);
    const angle = Math.acos(Math.max(-1, Math.min(1, dir[0] * view[0] + dir[1] * view[1] + dir[2] * view[2])));
    if (angle >= bestAngle) continue;
    if (world.raycast(eye, dir, dist) < dist - 0.05) continue; // behind a wall
    bestAngle = angle;
    best = d;
  }
  if (!best) return;
  me.yaw = Math.atan2(-best[0], -best[2]);
  me.pitch = Math.atan2(best[1], Math.hypot(best[0], best[2]));
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
    if (hack() === 'aim' && (keys.has('ShiftLeft') || keys.has('ShiftRight')) && locked() && !me.dead) aimLock();
    tryShoot(now);

    if (!me.dead && now - lastStateSent >= 1000 / STATE_SEND_RATE) {
      lastStateSent = now;
      session.send({ t: 'state', p: me.pos, yaw: me.yaw, pitch: me.pitch }, false);
    }

    // Spread eases toward what the current movement allows.
    // (Flying counts as standing on the ground; the recoil hack cuts it 85%.)
    const speed = Math.hypot(me.vel[0], me.vel[2]) / speedHack();
    const target = spreadFor(weapon(), speed, me.onGround || hack() === 'fly', me.scope > 0.95) * (hack() === 'recoil' ? RECOIL_HACK : 1);
    me.spread += (target - me.spread) * (1 - Math.exp(-12 * dt));

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
      fast: hack() === 'ammo',
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
  // No pointer lock yet: the game starts in the buy menu, which needs the
  // mouse pointer; its Start button locks it.
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
  renderer.updatePickups(null);
  closeBuyMenu();
  me.money = 0;
  me.hack = 0;
  renderer.wallHack = false;
  $('victory').hidden = true;
  $('minimap').hidden = true;
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
