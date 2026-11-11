// Client game loop: menu, input, local movement, interpolation of remote
// players and HUD. Works the same whether we're the host or a joiner — only
// the `send` function differs.

import {
  STATE_SEND_RATE, INTERP_DELAY, eyeHeight, CROUCH_TIME, MAX_HP, MOVE_SPEED, HOST_TIMEOUT,
  MAX_RANGE, TEAMS, WEAPONS, DEFAULT_WEAPON, SWITCH_TIME, RESPAWN_TIME, SPAWN_PROTECTION,
  SMOKE, THROW_TIME, smokeRadius, smokeCentre, smokeBlocks,
  MODES, weaponAllowed, weaponPrice, startWeapon, hacksOffMask,
  ADMIN_NAME, useMapSpots, HACKS, hasHack, HACK_LIMIT, hackCount, withinHackLimit, hackList, hacksPrice, SPEED_HACK, SPEED_HACK_JUMP, FLY_HACK_SPEED, RECOIL_HACK, fireCooldown, headAABB, lookDir, rayPlayer, spreadFor, spreadDir,
} from './shared.js';
import { makeRoomCode, openHostPeer, joinRoom } from './net.js';
import { HostServer, HOST_ID } from './host.js';
import { Renderer } from './render.js';
import { loadAssets, loadMap } from './assets.js';
import { World } from './world.js';
import { unlockAudio, playSound, setListener, toggleMute, audioDebug } from './audio.js';
import { Minimap } from './minimap.js';
import { t, lang, setLang, LANGUAGES, applyPageText, teamName, weaponName, hackName, hackShort, hackDesc, zoneName } from './i18n.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

const renderer = new Renderer(canvas);
// Footsteps on metal (catwalks, the crane, ladders: see World.onMetal) sound like it.
renderer.onSound = (name, position, intensity, variant) => {
  const where = position ?? (name === 'step' || name === 'climb' ? me.pos : null);
  if (name === 'climb' || (name === 'step' && where && world?.onMetal(where))) name = 'stepMetal';
  playSound(name, position, intensity, variant);
};

// ---- language ---------------------------------------------------------------
// The main menu's English / 한국어 switch (remembered in this browser).

let status = null; // the menu's status line: { key, params, err } (shown in the current language)
function setStatus(key, params) {
  status = key ? { key, params } : null;
  showStatus();
}
// An error: on its own, or as key's {error}.
function setStatusError(err, key) {
  status = { key, err };
  showStatus();
}
// An error's message: its key (net.js) or, failing that, its own text.
const errorText = (err) => (err.i18n ? t(err.i18n, err.params) : err.message);
function showStatus() {
  if (!status) $('status').textContent = '';
  else if (!status.err) $('status').textContent = t(status.key, status.params);
  else $('status').textContent = status.key ? t(status.key, { error: errorText(status.err) }) : errorText(status.err);
}

// ---- main menu: Join / Create tabs; the mode of rooms we host -----------------
// The tab is remembered (Join the first time, and always from an invite link).

let menuTab = 'join';
let hostMode = 'normal'; // game mode (MODES)
let hostLimit = 'limit'; // hacks per life: 'limit' (HACK_LIMIT) or 'any'
try {
  menuTab = localStorage.getItem('hackfps.tab') === 'host' ? 'host' : 'join';
  hostMode = MODES[localStorage.getItem('hackfps.gameMode')] ? localStorage.getItem('hackfps.gameMode') : 'normal';
  hostLimit = localStorage.getItem('hackfps.mode') === 'any' ? 'any' : 'limit';
} catch { /* (storage blocked) */ }
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* (storage blocked) */ } };

function showMenuTab(tab) {
  menuTab = tab;
  for (const b of $('menuTabs').children) {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  $('joinTab').hidden = tab !== 'join';
  $('hostTab').hidden = tab !== 'host';
  $('menu').querySelector('.panel').classList.toggle('wide', tab === 'host');
}
$('menuTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (!tab) return;
  showMenuTab(tab);
  remember('hackfps.tab', tab);
  if (tab === 'join') $('codeInput').focus();
});

const MODE_ICONS = { normal: '💻', melee: '🔪', headshot: '🎯' };
// A card per mode: name, what it is, and the hacks it turns off.
function showModeCards() {
  $('modeCards').replaceChildren(...Object.entries(MODES).map(([id, m]) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.setAttribute('role', 'radio');
    card.dataset.mode = id;
    card.classList.toggle('on', id === hostMode);
    card.setAttribute('aria-checked', String(id === hostMode));
    const icon = document.createElement('span');
    icon.className = 'modeIcon';
    icon.textContent = MODE_ICONS[id];
    const name = document.createElement('b');
    name.textContent = t(`mode.${id}`);
    const desc = document.createElement('span');
    desc.className = 'modeDesc';
    desc.textContent = t(`mode.${id}.desc`, { n: m.killTarget });
    const hacks = document.createElement('small');
    hacks.textContent = m.hacksOff.length
      ? t('mode.hacksOff', { list: m.hacksOff.map((h) => hackShort(HACKS.find((x) => x.id === h))).join(', ') })
      : t('mode.allHacks');
    card.append(icon, name, desc, hacks);
    return card;
  }));
  for (const b of $('hackLimitPick').children) {
    b.textContent = b.dataset.limit === 'any' ? t('menu.limitAny') : t('menu.limitN', { n: HACK_LIMIT });
    b.classList.toggle('on', b.dataset.limit === hostLimit);
    b.setAttribute('aria-checked', String(b.dataset.limit === hostLimit));
  }
}
$('modeCards').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.dataset.mode;
  if (!id) return;
  hostMode = id;
  remember('hackfps.gameMode', id);
  showModeCards();
});
$('hackLimitPick').addEventListener('click', (e) => {
  const limit = e.target.closest('button')?.dataset.limit;
  if (!limit) return;
  hostLimit = limit;
  remember('hackfps.mode', limit);
  showModeCards();
});

function showLanguage() {
  applyPageText();
  showModeCards();
  for (const b of $('langSwitch').children) b.classList.toggle('on', b.dataset.lang === lang);
  showStatus();
}
for (const [code, label] of Object.entries(LANGUAGES)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.lang = code;
  b.textContent = label;
  b.addEventListener('click', () => { setLang(code); showLanguage(); });
  $('langSwitch').appendChild(b);
}
showLanguage();
showMenuTab(menuTab);

// Models must be loaded before the game can start.
$('hostBtn').disabled = true;
$('joinBtn').disabled = true;
setStatus('status.loading');
let world;
const minimap = new Minimap($('minimap'), () => world, renderer);
try {
  const [, map] = await Promise.all([loadAssets(renderer.renderer), loadMap(renderer.renderer)]);
  useMapSpots(map.meta);
  world = new World(map.collision, map.meta);
  renderer.setMap(map.visual, map.props, map.lightmap, map.meta.lightmap?.intensity, world);
} catch (err) {
  setStatusError(err, 'status.loadFailed');
  throw err;
}
renderer.buildGun();
setStatus(null);
$('hostBtn').disabled = false;
$('joinBtn').disabled = false;

// ---- session state ---------------------------------------------------------

let session = null; // { send(msg, reliable), close(), code, isHost }
let myId = null;
let myTeam = 0;
let room = { code: '', hosting: false }; // the room we're in (for the HUD's room line)
const me = {
  pos: [0, 0, 0], vel: [0, 0, 0], onGround: true, yaw: 0, pitch: 0, hp: MAX_HP, dead: false,
  money: 0,
  hack: 0, // our hacks (bit mask, see HACKS), until our next death
  weapon: DEFAULT_WEAPON, lastWeapon: WEAPONS.findIndex((w) => w.id === 'rifle'), // index into WEAPONS
  ammo: WEAPONS.map((w) => w.magSize), // per weapon
  reloadEnd: 0, // performance.now() ms when the reload finishes, 0 = not reloading
  switchEnd: 0, // performance.now() ms when the weapon switch finishes
  scope: 0, // 0 = not scoped .. 1 = fully scoped
  spread: 0, // current shot spread (radians), follows movement
  crouched: false, // (hold Ctrl or Shift; set by World.stepPlayer: stays down until there's room to stand)
  crouch: 0, // 0 = standing .. 1 = crouched, eased over CROUCH_TIME (the eyes)
  climbing: false, // on a ladder (set by World.stepPlayer): no shooting, gun away
  protectedUntil: 0, // performance.now() ms; spawn protection (for the HUD; the host enforces it)
};
let deathInfo = null; // { killer, headshot, at } while dead
let damageDirs = []; // [{ from:[x,z], at, el }] red arcs pointing at whoever hit us
let snapshots = []; // [{ time, n (the host's number), players: Map<id, playerState> }]
let viewing = null; // the snapshots the other players are drawn between: [n before, n after, fraction]
let latestPlayers = []; // most recent snapshot array, for the scoreboard
let lastStateSent = 0;
let lastShotTime = 0;
let pendingTracers = []; // our shots this frame: drawn once the rifle is posed for the frame

// ---- input -----------------------------------------------------------------

const keys = new Set();
let mouseDown = false;
let triggerPressed = false; // a click since the last frame (semi-automatic weapons)
let aimHeld = false; // right mouse button
// The smoke bomb (C: take it out / put it away; a click throws it).
let smokeHeld = false;
let throwUntil = 0; // performance.now() the throw in progress ends (then back to the weapon)
let smokeReadyAt = 0; // ... ours is usable again (0: ready)
let lastThrowAt = -1e9;
const smokes = []; // smoke clouds out: { id, pos, at (s, our clock), duration }
const smokesDone = new Set(); // ids of clouds that have cleared (the host's next snapshot may still list one)
const nowSec = () => performance.now() / 1000;
const locked = () => document.pointerLockElement === canvas;
const weapon = () => WEAPONS[me.weapon];
const BASE_FOV = renderer.camera.fov;

// Windows Chrome closes the tab on Ctrl+W (crouch + forward) and pages can't
// block it, so ask before leaving a match. (Shift crouches without the risk.)
window.addEventListener('beforeunload', (e) => {
  if (session) e.preventDefault();
});

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if ((e.ctrlKey || e.altKey) && locked()) e.preventDefault(); // (Ctrl: crouch, Alt: aim hack; not the browser's shortcuts)
  if (e.code === 'Tab' && session) { e.preventDefault(); $('scoreboard').hidden = false; }
  if (e.code === 'KeyR' && session && locked()) startReload(performance.now());
  if (e.code === 'KeyC' && session && locked()) toggleSmoke(performance.now());
  if (e.code === 'KeyM' && session) addFeed(t(toggleMute() ? 'feed.soundOff' : 'feed.soundOn'));
  // Weapon switching (number keys, wheel): only for the player named "Admin".
  // (Q / E: the fly hack.)
  if (session && locked() && canSwitch()) {
    const digit = /^Digit(\d)$/.exec(e.code);
    if (digit && WEAPONS[digit[1] - 1]) switchWeapon(digit[1] - 1, performance.now());
  }
});
window.addEventListener('wheel', (e) => {
  if (!session || !locked() || !canSwitch() || Math.abs(e.deltaY) < 1) return;
  switchWeapon((me.weapon + (e.deltaY > 0 ? 1 : WEAPONS.length - 1)) % WEAPONS.length, performance.now());
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.key === 'Alt' && locked()) e.preventDefault(); // (else Windows focuses the browser menu)
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
    speed: speedHack() * (weapon().moveSpeed ?? 1), // (a little faster with the knife)
    jumpHeight: has('speed') ? SPEED_HACK_JUMP : 1,
    fly: has('fly') ? k('KeyQ') - k('KeyE') : undefined,
    noclip: has('noclip'),
    crouch: !!(k('ControlLeft') || k('ControlRight') || k('ShiftLeft') || k('ShiftRight')),
  };
}

// ---- incoming messages -----------------------------------------------------

let lastHostMessage = 0; // performance.now() ms, for HOST_TIMEOUT
let rtt = 0; // round trip to the host (ms, smoothed; 0 for the host itself)

function onMessage(msg) {
  lastHostMessage = performance.now();
  switch (msg.t) {
    case 'welcome':
      me.dead = true; // until we pick a weapon in the buy menu
      myId = msg.id;
      myTeam = msg.team ?? 0;
      hackLimit = msg.hackLimit ?? HACK_LIMIT;
      modeId = MODES[msg.mode] ? msg.mode : 'normal';
      mode = MODES[modeId];
      if (!weaponAllowed(mode, buyChoice)) buyChoice = startWeapon(mode);
      buyHacks &= ~hacksOffMask(mode);
      renderer.setLocalTeam(myTeam);
      showRoomInfo();
      teleport(msg.pos, msg.yaw);
      me.protectedUntil = performance.now() + SPAWN_PROTECTION * 1000;
      break;
    case 'pong': {
      const sample = performance.now() - msg.at;
      if (Number.isFinite(sample) && sample >= 0) rtt = rtt ? rtt * 0.8 + sample * 0.2 : sample;
      break;
    }
    case 'snap': {
      const players = new Map(msg.players.map((p) => [p.id, p]));
      snapshots.push({ time: performance.now(), n: msg.n, players });
      if (snapshots.length > 30) snapshots.shift();
      latestPlayers = msg.players;
      teamKills = msg.tk ?? null;
      const mine = players.get(myId);
      if (mine) {
        me.hp = mine.hp;
        me.dead = mine.dead;
        me.money = mine.m ?? 0;
        // Our smoke bomb's cooldown (the host's word, except just after a throw it hasn't heard yet).
        if (mine.sc > 0) smokeReadyAt = performance.now() + mine.sc * 1000;
        else if (performance.now() - lastThrowAt > 1500) smokeReadyAt = 0;
        renderer.setViewmodel(mine.skin); // first-person body in our own skin
      }
      for (const id of renderer.avatars.keys()) if (!players.has(id)) renderer.removeAvatar(id);
      if (msg.pk) renderer.updatePickups(msg.pk, msg.pt);
      for (const s of msg.sk ?? []) addSmoke(s.id, s.p, s.d, s.age); // (clouds already out when we joined)
      updateScoreboard();
      break;
    }
    case 'throw': // someone threw a smoke bomb (ours was shown already)
      if (msg.from !== myId) renderer.avatars.get(msg.from)?.throwSmoke(!!msg.m);
      break;
    case 'nade': // ... it left their hand
      renderer.smokes?.addBomb(msg.id, msg.p, msg.v);
      break;
    case 'smoke': // ... and went off
      addSmoke(msg.id, msg.p, msg.d);
      playSound('hiss', msg.p);
      break;
    case 'shot':
      if (msg.from !== myId) { // (our own were drawn instantly)
        const ends = msg.es ?? [msg.e];
        const hit = (e) => Math.hypot(...e.map((v, i) => v - msg.o[i])) < MAX_RANGE - 0.5;
        renderer.remoteShot(msg.from, msg.o, ends, ends.map(hit));
      }
      break;
    case 'hit':
      if (!msg.blocked && msg.victim !== myId) renderer.hitSparks(msg.victim, msg.from, !!msg.hs);
      if (msg.attacker === myId) {
        const kind = msg.blocked ? 'blocked' : msg.hp === 0 ? 'kill' : msg.hs ? 'head' : 'body';
        showHitmarker(kind);
        if (kind !== 'blocked') playSound(kind === 'kill' ? 'hitKill' : kind === 'head' ? 'hitHead' : 'hitBody', null);
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
      addFeed(t('feed.killReward', { n: msg.amount }));
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
      smokeHeld = false; // (a fresh smoke bomb)
      throwUntil = 0;
      smokeReadyAt = 0;
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
      addFeed(t('feed.pickedUp', { weapon: weaponName(WEAPONS[msg.w]) }));
      playSound('pickup', null);
      break;
    }
    case 'cash': // we walked over a money spot
      me.money = msg.money;
      flash('cash', 300);
      addFeed(t('feed.cash', { n: msg.amount }));
      playSound('pickup', null);
      break;
    case 'heal': // we walked over a heal pack
      me.hp = msg.hp;
      flash('heal', 300);
      addFeed(t('feed.healed'));
      playSound('pickup', null);
      break;
    case 'leave':
      renderer.removeAvatar(msg.id);
      break;
    case 'feed':
      addFeed(feedText(msg));
      break;
  }
}

// yaw: the spawn's facing from the map; without one, face the arena centre.
function teleport(pos, yaw) {
  me.pos = [...pos];
  me.vel = [0, 0, 0];
  me.yaw = yaw ?? Math.atan2(pos[0], pos[2]);
  me.pitch = 0;
  me.crouched = false;
  me.crouch = 0;
  me.climbing = false;
}
const myEye = () => [me.pos[0], me.pos[1] + eyeHeight(me.crouch), me.pos[2]];

// ---- shooting --------------------------------------------------------------

// Ammo is predicted here for an instant HUD; the host keeps its own count
// and ignores shots while reloading or empty.
const has = (id) => hasHack(me.hack, id); // (one of our hacks)
const speedHack = () => (has('speed') ? SPEED_HACK : has('fly') ? FLY_HACK_SPEED : 1); // movement speed multiplier

function startReload(now) {
  if (has('ammo')) return; // infinite ammo: never reloads
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
  if (!throwUntil) smokeHeld = false; // (the smoke bomb goes away)
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
  const want = aimHeld && w.zoomFov && !smokeHeld && !me.dead && !me.reloadEnd && now >= me.switchEnd
    && now - lastShotTime > BOLT_BUSY * (fireCooldown(w, me.hack) / w.cooldown) * 1000;
  me.scope = want ? Math.min(1, me.scope + dt / w.scopeTime) : Math.max(0, me.scope - dt / 0.12);
  const fov = w.zoomFov ? BASE_FOV + (w.zoomFov - BASE_FOV) * me.scope : BASE_FOV;
  renderer.setFov(fov);
}

function tryShoot(now) {
  if (smokeHeld) { // a click throws the smoke bomb instead (not the triggerbot)
    const clicked = triggerPressed || mouseDown;
    triggerPressed = false;
    if (clicked && !throwUntil && !me.dead && !me.climbing && locked()) throwSmoke(now);
    return;
  }
  const w = weapon();
  const pulled = (w.auto ? mouseDown : triggerPressed) // semi-automatic: one shot per click
    || (has('trigger') && !me.dead && crosshairOnEnemy(w)); // the triggerbot pulls it for us
  triggerPressed = false;
  if (!pulled || me.dead || me.climbing || !locked() || now - lastShotTime < fireCooldown(w, me.hack) * 1000 || now < me.switchEnd) return;
  if (w.melee) { // a knife swing: the host finds who it hits
    lastShotTime = now;
    me.protectedUntil = 0;
    renderer.kickGun();
    session.send({ t: 'shoot', w: me.weapon, yaw: me.yaw, pitch: me.pitch, v: viewing }, true);
    return;
  }
  const infinite = has('ammo');
  if (me.reloadEnd && !infinite) return;
  if (me.ammo[me.weapon] <= 0 && !infinite) return startReload(now); // pulling the trigger on empty reloads
  lastShotTime = now;
  if (!infinite) me.ammo[me.weapon] -= 1;
  me.protectedUntil = 0; // firing ends spawn protection

  // Draw the tracer immediately against what we currently see, so shooting
  // feels responsive. The host decides whether it actually hit. The spread
  // is applied here so the tracer shows where the shot really goes.
  const origin = myEye();
  const aim = spreadDir(lookDir(me.yaw, me.pitch), me.spread);
  // Shotgun: several pellets in a cone around the aimed direction.
  const dirs = w.pellets ? Array.from({ length: w.pellets }, () => spreadDir(aim, w.pelletSpread)) : [aim];
  for (const dir of dirs) {
    // (The wallbang hack: through walls to anyone along the shot; a spark where it goes in.)
    const wall = world.raycast(origin, dir, MAX_RANGE);
    let dist = has('wallbang') ? MAX_RANGE : wall;
    for (const [id, avatar] of renderer.avatars) {
      if (avatar.dead || id === myId || avatar.team === myTeam) continue;
      dist = Math.min(dist, rayPlayer(origin, dir, avatar.object.position.toArray(), avatar.pose).t);
    }
    if (dist >= MAX_RANGE) dist = wall;
    const through = dist > wall + 0.01 ? origin.map((o, i) => o + dir[i] * wall) : null;
    pendingTracers.push({ end: origin.map((o, i) => o + dir[i] * dist), hit: dist < MAX_RANGE, wall: through });
  }

  session.send(w.pellets
    ? { t: 'shoot', w: me.weapon, yaw: me.yaw, pitch: me.pitch, o: origin, ds: dirs, v: viewing }
    : { t: 'shoot', w: me.weapon, yaw: me.yaw, pitch: me.pitch, o: origin, d: aim, v: viewing }, true);
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
  viewing = [a.n, b.n, Math.round(t * 1000) / 1000]; // (sent with shots: the host checks hits against this)

  for (const [id, pb] of b.players) {
    if (id === myId) { // our fake-lag afterimage; we're see-through while hidden
      const ghost = ghostState(pb);
      renderer.updateGhost(id, pb.name, pb.skin, pb.team, ghost, dt);
      // (Not drawn when we're in it: standing still, it covered the camera.)
      const mine = renderer.ghosts.get(id);
      if (mine) mine.object.visible = Math.hypot(ghost.pos[0] - me.pos[0], ghost.pos[2] - me.pos[2]) > OWN_GHOST_HIDE;
      renderer.view?.setFade(pb.fl && !pb.rv ? seeThrough(Math.hypot(me.vel[0], me.vel[2]) / speedHack()) : 1);
      continue;
    }
    if (pb.gone) { renderer.removeAvatar(id); continue; } // in the buy menu
    let pa = a.players.get(id) ?? pb;
    // Don't slide across the map when someone respawns.
    if (Math.hypot(pb.p[0] - pa.p[0], pb.p[2] - pa.p[2]) > 3) pa = pb;
    const pos = [0, 1, 2].map((i) => pa.p[i] + (pb.p[i] - pa.p[i]) * t);
    // Velocity between the two snapshots (none between the same one: the
    // character then works it out from the position).
    const vel = pa !== pb && span > 0 ? [0, 1, 2].map((i) => (pb.p[i] - pa.p[i]) / (span / 1000)) : undefined;
    // On a ladder the body faces it, wherever they look.
    const ladder = pb.l ? world.ladderAt(pos) : null;
    renderer.updateAvatar(id, pb.name, pb.skin, pb.team, {
      pos,
      vel,
      ground: groundBelow(pos),
      yaw: ladder ? Math.atan2(ladder.n[0], ladder.n[1]) : lerpAngle(pa.yaw, pb.yaw, t),
      pitch: pa.pitch + (pb.pitch - pa.pitch) * t,
      dead: pb.dead,
      crouch: !!pb.c,
      climbing: !!pb.l,
      reloading: !!pb.rl,
      protected: !!pb.sp,
      weapon: pb.w ?? 0,
      smoke: !!pb.sm, // holding the smoke bomb
      fast: hasHack(pb.h ?? 0, 'ammo'), // (teammates only: enemies' hacks aren't sent)
    }, dt);
    // Fake-lag hack: hidden from enemies, see-through to the team (fully
    // there while revealed by attacking); the afterimage.
    const avatar = renderer.avatars.get(id);
    const hidden = !!pb.fl && !pb.rv;
    const enemy = pb.team !== myTeam;
    avatar.setFade(hidden ? (enemy ? 0 : seeThrough(Math.hypot(avatar.velocity.x, avatar.velocity.z))) : 1);
    avatar.fakeHidden = hidden && enemy; // (hacks go by the afterimage)
    renderer.updateGhost(id, pb.name, pb.skin, pb.team, ghostState(pb), dt);
    // Enemies' names don't show through smoke (nor their afterimage's).
    if (enemy) {
      const eye = myEye();
      for (const shown of [avatar, renderer.ghosts.get(id)]) {
        if (!shown?.label.visible) continue;
        const p = shown.object.position;
        if (smoked(eye, [p.x, p.y + 1.6, p.z])) shown.label.visible = false;
      }
    }
  }
}

// Fake-lag: how see-through a hidden player is to themself and their team,
// more so moving (speed: m/s). Rounded, so the materials aren't redone
// every frame.
const SEE_THROUGH = [0.5, 0.2]; // standing, at full speed
const OWN_GHOST_HIDE = 0.5; // m: our own afterimage isn't drawn this close (it covered the camera)
function seeThrough(speed) {
  const k = Math.min(1, speed / MOVE_SPEED);
  return Math.round((SEE_THROUGH[0] + (SEE_THROUGH[1] - SEE_THROUGH[0]) * k) * 20) / 20;
}

// A fake-lag player's afterimage (pb.g from the snapshot) as a character
// state for the renderer, or null.
function ghostState(pb) {
  const g = pb.fl && pb.g;
  if (!g) return null;
  return { pos: g.p, vel: [0, 0, 0], ground: groundBelow(g.p), yaw: g.yaw, pitch: g.pitch, dead: false, crouch: !!g.c, weapon: g.w ?? 0 };
}

// Where an enemy appears to us (for the aim hack and triggerbot): { pos,
// pose }, a fake-lag player's afterimage while they're hidden (null: none).
function apparent(id, avatar) {
  const shown = avatar.fakeHidden ? renderer.ghosts.get(id) : avatar;
  return shown && { pos: shown.object.position.toArray(), pose: shown.pose };
}

// ---- HUD -------------------------------------------------------------------

const flashTimers = {};
function flash(id, ms) {
  const el = $(id);
  el.classList.add('show');
  clearTimeout(flashTimers[id]);
  flashTimers[id] = setTimeout(() => el.classList.remove('show'), ms);
}

// A feed message from the host: a key and its values, in our language.
function feedText(msg) {
  switch (msg.key) {
    case 'joined': return t('feed.joined', { name: msg.name, team: teamName(msg.team) });
    case 'left': return t('feed.left', { name: msg.name });
    case 'kill': return t(msg.hs ? 'feed.killHeadshot' : 'feed.kill', { killer: msg.killer, victim: msg.victim });
    case 'victory': return t('feed.victory', { name: msg.name, team: teamName(msg.team) });
    case 'teamWins': return t('feed.teamWins', { n: msg.n, team: teamName(msg.team) });
    case 'noBots': return t('feed.noBots');
    default: return msg.text ?? '';
  }
}

function addFeed(text) {
  const div = document.createElement('div');
  div.textContent = text;
  $('killfeed').prepend(div);
  setTimeout(() => div.remove(), 5000);
}

// Team score = the team's kills this round (out of the mode's kill target).
function updateScoreboard() {
  const totals = teamKills ?? TEAMS.map((_, i) => latestPlayers.filter((p) => p.team === i).reduce((n, p) => n + p.score, 0));
  const teamScore = $('teamScore');
  teamScore.replaceChildren();
  TEAMS.forEach((team, i) => {
    const span = document.createElement('span');
    span.textContent = `${teamName(i)} ${totals[i]}${mode.killTarget ? ` / ${mode.killTarget}` : ''}`;
    span.style.color = team.color;
    if (i === myTeam) span.className = 'mine';
    teamScore.appendChild(span);
  });

  const table = $('scoreboard');
  table.replaceChildren();
  const header = table.insertRow();
  for (const h of ['team', 'player', 'kills', 'money', 'hacks']) {
    const th = document.createElement('th');
    th.textContent = t(`board.${h}`);
    header.appendChild(th);
  }
  for (const p of [...latestPlayers].sort((x, y) => x.team - y.team || y.score - x.score)) {
    const row = table.insertRow();
    if (p.id === myId) row.className = 'me';
    const team = row.insertCell();
    team.textContent = TEAMS[p.team] ? teamName(p.team) : '';
    team.style.color = TEAMS[p.team]?.color ?? '';
    row.insertCell().textContent = p.name;
    row.insertCell().textContent = p.score;
    row.insertCell().textContent = `$${p.m ?? 0}`;
    // Hacks: only teammates' (the host doesn't send the other team's).
    row.insertCell().textContent = p.h === undefined ? '' : p.h ? hackList(p.h).map(hackShort).join(', ') : '-';
  }
}

function showRoomInfo() {
  const info = $('roomInfo');
  const label = t(room.hosting ? 'room.hosting' : 'room.joined', { code: room.code });
  info.textContent = myId ? `${label} · ${t(`mode.${modeId}`)} · ${hackLimit ? t('room.limit', { n: hackLimit }) : t('room.noLimit')} · ${t('room.team', { team: teamName(myTeam) })}` : label;
  info.style.borderLeft = myId ? `4px solid ${TEAMS[myTeam].color}` : '';
}

const isAdmin = () => nameOf(myId) === ADMIN_NAME;
const canSwitch = () => isAdmin() && !mode.weapons; // (modes with set weapons: no switching)

function nameOf(id) {
  return latestPlayers.find((p) => p.id === id)?.name ?? t('hud.someone');
}

// kind: 'body' (small white X) | 'head' (bigger red X) | 'kill' (red skull) | 'blocked' (grey X: spawn-protected)
function showHitmarker(kind) {
  const el = $('hitmarker');
  el.classList.remove('body', 'head', 'kill', 'blocked', 'show');
  void el.offsetWidth; // (restarts the skull's pop)
  el.classList.add(kind);
  flash('hitmarker', kind === 'kill' ? 500 : kind === 'head' ? 200 : 140);
}

function showKillConfirm(name, headshot) {
  const el = $('killConfirm');
  el.textContent = t('hud.eliminated', { name }) + (headshot ? ` · ${t('hud.headshot')}` : '');
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

// Where we are, by the map's callout names ("Hospital · 4F", "Hotel · Roof").
function showLocation() {
  const z = !me.dead && world.zoneAt(me.pos);
  let text = '';
  if (z) {
    text = zoneName(z.id);
    if (z.roof !== undefined && me.pos[1] > z.roof - 0.3) text += ` · ${t('hud.roof')}`;
    else if (z.floor !== undefined && me.pos[1] > z.floor + 2) text += ` · ${Math.floor((me.pos[1] - z.floor + 0.5) / 3) + 1}F`;
  }
  if ($('location').textContent !== text) $('location').textContent = text;
}

function updateHud(now) {
  $('hp').textContent = me.hp;
  $('weaponName').textContent = canSwitch()
    ? WEAPONS.map((w, i) => (i === me.weapon ? `[${i + 1}] ${weaponName(w)}` : `${i + 1}`)).join('  ')
    : weaponName(WEAPONS[me.weapon]);
  $('ammoCount').textContent = has('ammo') ? '∞' : me.ammo[me.weapon];
  $('magSize').textContent = weapon().magSize;
  $('ammo').classList.toggle('empty', me.ammo[me.weapon] === 0 && !has('ammo'));
  $('ammo').hidden = !!weapon().melee || smokeHeld;
  if (smokeHeld) $('weaponName').textContent = t('weapon.smoke');
  updateSmokeHud(now);
  $('hackName').textContent = me.hack && !me.dead ? hackList(me.hack).map(hackName).join(' · ') : '';
  minimap.update(has('map') && !me.dead, me, myTeam);
  showLocation();
  renderer.wallHack = has('wall') && !me.dead;
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
    title.textContent = killedText();
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = left === null ? t('hud.respawning') : t('hud.respawningIn', { s: left.toFixed(1) });
    $('deadMsg').append(title, sub);
  }

  const protectedLeft = me.dead ? 0 : (me.protectedUntil - now) / 1000;
  $('protectMsg').hidden = protectedLeft <= 0;
  if (protectedLeft > 0) $('protectMsg').textContent = t('hud.protection', { s: protectedLeft.toFixed(1) });

  updateDamageDirs(now);
  updateCrosshair();
}

// "Killed by X · headshot", or "You died".
function killedText() {
  if (!deathInfo) return t('hud.died');
  return t('hud.killedBy', { name: deathInfo.killer }) + (deathInfo.headshot ? ` · ${t('hud.headshot')}` : '');
}

// ---- buy menu --------------------------------------------------------------
// On joining and after every death: pick the weapon to spawn with (what you
// can't afford is greyed out), then Start (after the respawn delay). The host
// checks the price and charges it at the spawn.

let buy = null; // { readyAt (performance.now ms), sent } while the menu is open
let buyChoice = DEFAULT_WEAPON; // remembered between deaths
let buyHacks = 0; // hacks picked (bit mask), remembered too
let hackLimit = HACK_LIMIT; // the room's mode (from the host's welcome): hacks per life (0: any number)
let modeId = 'normal'; // ... and game mode (MODES)
let mode = MODES.normal;
let teamKills = null; // [blue, red] this round (from snapshots)

// Options: name, price (and a description for hacks). Radio buttons (one
// weapon) or checkboxes (hacks): onPick(index, checked).
function buyOptions(items, group, onPick, type = 'radio') {
  return items.map((item, i) => {
    const label = document.createElement('label');
    if (item.id) label.dataset.id = item.id;
    const input = document.createElement('input');
    input.type = type;
    input.name = group;
    input.value = i;
    input.addEventListener('change', () => onPick(i, input.checked));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    if (item.off) label.classList.add('off');
    // The victory hack is the game's goal: marked so (see style.css).
    if (item.id === 'victory' && !item.off) {
      const goal = document.createElement('b');
      goal.className = 'goal';
      goal.textContent = t('buy.goal');
      name.prepend('🏆 ');
      name.append(goal);
    }
    if (item.desc) {
      const desc = document.createElement('small');
      desc.textContent = item.desc;
      name.append(desc);
    }
    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = item.off ? t('buy.off') : item.price ? `$${item.price.toLocaleString()}` : t('buy.free');
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
    killed.textContent = killedText();
    const earned = document.createElement('div');
    earned.className = 'earned';
    earned.textContent = t('buy.survived', { s: msg.alive, n: msg.earned });
    info.append(killed, earned);
  } else {
    info.textContent = t(`buy.${msg.round ? 'newRound' : 'start'}${hackLimit ? 'Limit' : 'Any'}`, { n: hackLimit });
  }
  // Modes other than the default: what it is and the goal.
  if (modeId !== 'normal') {
    const rules = document.createElement('div');
    rules.className = 'modeRules';
    rules.textContent = `${t(`mode.${modeId}`)}: ${t(`mode.${modeId}.desc`, { n: mode.killTarget })}`;
    info.append(rules);
  }
  $('buyHacksMode').textContent = hackLimit ? t('buy.upTo', { n: hackLimit }) : t('buy.anyNumber');
  const off = hacksOffMask(mode);
  const weapons = WEAPONS.map((w, i) => ({ name: weaponName(w), price: weaponPrice(mode, i), off: !weaponAllowed(mode, i) }));
  const hacks = HACKS.map((h, i) => ({ id: h.id, name: hackName(h), desc: hackDesc(h), price: h.price, off: (off & (1 << i)) !== 0 }));
  $('buyList').replaceChildren(...buyOptions(weapons, 'buyWeapon', (i) => { buyChoice = i; }));
  $('buyHacks').replaceChildren(...buyOptions(hacks, 'buyHack', (i, on) => {
    if (on && !withinHackLimit(buyHacks | (1 << i), hackLimit)) return; // (locked next frame)
    buyHacks = on ? buyHacks | (1 << i) : buyHacks & ~(1 << i);
  }, 'checkbox'));
  // Last time's picks if still affordable: the weapon, then the hacks
  // dropping the priciest first (also down to the room's limit).
  const priciest = () => HACKS.reduce((best, h, i) => (buyHacks & (1 << i) && (best < 0 || h.price > HACKS[best].price) ? i : best), -1);
  if (!weaponAllowed(mode, buyChoice) || weaponPrice(mode, buyChoice) > me.money) buyChoice = startWeapon(mode);
  buyHacks &= ~off;
  while (buyHacks && (!withinHackLimit(buyHacks, hackLimit) || weaponPrice(mode, buyChoice) + hacksPrice(buyHacks) > me.money)) buyHacks &= ~(1 << priciest());
  $('botRow').hidden = !session?.isHost;
  showBotFill();
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
  const price = weaponPrice(mode, buyChoice);
  const hackPrice = hacksPrice(buyHacks);
  const off = hacksOffMask(mode);
  // Locked: what can't be added with the rest of the picks (picked hacks can
  // always be unticked; at the room's limit the other hacks are locked).
  const full = hackLimit && hackCount(buyHacks) >= hackLimit;
  // (Off in this mode: always locked.)
  const mark = (list, prices, isOff, chosen, otherPrice, atLimit = false) => list.querySelectorAll('label').forEach((label, i) => {
    const input = label.firstChild;
    const on = chosen(i);
    const locked = isOff(i) || (!on && (atLimit || prices[i] + otherPrice > me.money));
    label.classList.toggle('locked', locked);
    input.disabled = locked || buy.sent;
    input.checked = on;
  });
  mark($('buyList'), WEAPONS.map((w, i) => weaponPrice(mode, i)), (i) => !weaponAllowed(mode, i), (i) => i === buyChoice, hackPrice);
  mark($('buyHacks'), HACKS.map((h) => h.price), (i) => (off & (1 << i)) !== 0, (i) => (buyHacks & (1 << i)) !== 0, price + hackPrice, full);
  const total = price + hackPrice;
  $('buyTotal').textContent = t('buy.total', { n: total.toLocaleString() });
  $('buyTotal').classList.toggle('over', total > me.money);
  const start = $('buyStart');
  const wait = (buy.readyAt - now) / 1000;
  start.disabled = buy.sent || wait > 0 || total > me.money;
  start.textContent = buy.sent ? t('buy.spawning') : wait > 0 ? t('buy.startIn', { s: wait.toFixed(1) }) : t('buy.start');
}

$('buyStart').addEventListener('click', () => {
  if (!buy || buy.sent || !session || weaponPrice(mode, buyChoice) + hacksPrice(buyHacks) > me.money) return;
  buy.sent = true;
  session.send({ t: 'spawn', w: buyChoice, h: buyHacks }, true);
  if (!hasHack(buyHacks, 'victory')) requestLock(); // (a click: allowed to lock the mouse)
});

// Host only: bots fill each team up to this many players (0 = none).
// Remembered in this browser.
let botFill = 0;
try { botFill = Number(localStorage.getItem('hackfps.bots')) || 0; } catch { /* (storage blocked) */ }

// Host only: whether bots buy hacks (remembered too).
let botHacks = true;
try { botHacks = localStorage.getItem('hackfps.botHacks') !== '0'; } catch { /* (storage blocked) */ }
$('botHacks').checked = botHacks;
$('botHacks').addEventListener('change', () => {
  botHacks = $('botHacks').checked;
  try { localStorage.setItem('hackfps.botHacks', botHacks ? '1' : '0'); } catch { /* (storage blocked) */ }
  if (session?.isHost) session.send({ t: 'botHacks', on: botHacks });
});

const showBotFill = () => $('botFill').querySelectorAll('button').forEach((b) => {
  b.classList.toggle('on', Number(b.dataset.n) === botFill);
  b.setAttribute('aria-checked', String(Number(b.dataset.n) === botFill));
});
$('botFill').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  botFill = Number(button.dataset.n);
  showBotFill();
  try { localStorage.setItem('hackfps.bots', String(botFill)); } catch { /* (storage blocked) */ }
  if (session?.isHost) session.send({ t: 'bots', n: botFill });
});

// ---- victory ---------------------------------------------------------------
// Someone bought the victory hack, or a team reached the mode's kill
// target: that team wins; a new round follows
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
  title.textContent = t('victory.wins', { team: teamName(msg.team) });
  title.style.color = team.color;
  const by = document.createElement('div');
  by.textContent = msg.by ? t('victory.by', { name: msg.by }) : t('victory.kills', { n: msg.kills });
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
  el.querySelector('.next').textContent = t('victory.next', { s: Math.max(0, Math.ceil(left)) });
}

// ---- aim hack ---------------------------------------------------------------
// While Alt is held: snap the view onto the head of the visible enemy
// closest to where we're aiming (in sight and on screen), exactly where it's
// drawn: with lag compensation the host checks the shot against what we saw
// (see HostServer.seenBy), so there's nothing to lead.

const _head = [0, 0, 0];
function aimLock() {
  const eye = myEye();
  const view = lookDir(me.yaw, me.pitch);
  const halfFov = (renderer.camera.fov / 2) * (Math.PI / 180);
  const limit = Math.atan(Math.tan(halfFov) * Math.hypot(1, renderer.camera.aspect)); // to the screen's corners
  let best = null;
  let bestAngle = limit;
  for (const [id, avatar] of renderer.avatars) {
    if (avatar.dead || id === myId || avatar.team === myTeam) continue;
    const seen = apparent(id, avatar);
    if (!seen) continue;
    const head = headAABB(seen.pos, seen.pose);
    for (let i = 0; i < 3; i++) _head[i] = (head.min[i] + head.max[i]) / 2;
    const d = _head.map((v, i) => v - eye[i]);
    const dist = Math.hypot(...d);
    const dir = d.map((v) => v / dist);
    const angle = Math.acos(Math.max(-1, Math.min(1, dir[0] * view[0] + dir[1] * view[1] + dir[2] * view[2])));
    if (angle >= bestAngle) continue;
    if (world.raycast(eye, dir, dist) < dist - 0.05) continue; // behind a wall
    if (smoked(eye, _head)) continue; // behind (or in) smoke
    bestAngle = angle;
    best = d;
  }
  if (!best) return;
  me.yaw = Math.atan2(-best[0], -best[2]);
  me.pitch = Math.atan2(best[1], Math.hypot(best[0], best[2]));
}

// ---- smoke bomb --------------------------------------------------------------
// C takes it out, or puts it away; while it's cooling down C does nothing
// but shake its icon. A click throws it (the host starts the cooldown and
// flies it; we just show the throw), then we're back on the weapon.

function toggleSmoke(now) {
  if (me.dead) return;
  if (smokeHeld) {
    if (!throwUntil) smokeHeld = false;
    return;
  }
  if (now < smokeReadyAt) {
    const icon = $('smokeIcon');
    icon.classList.remove('shake');
    void icon.offsetWidth; // (restarts the shake)
    icon.classList.add('shake');
    return;
  }
  smokeHeld = true;
}

function throwSmoke(now) {
  const moving = Math.hypot(me.vel[0], me.vel[2]) > 1;
  session.send({ t: 'throw', yaw: me.yaw, pitch: me.pitch, m: moving ? 1 : 0 }, true);
  renderer.view?.throwSmoke(moving);
  throwUntil = now + THROW_TIME * 1000;
  lastThrowAt = now;
  smokeReadyAt = now + SMOKE.cooldown * 1000;
  me.protectedUntil = 0;
}

// A smoke cloud out (popped `age` seconds ago).
function addSmoke(id, pos, duration, age = 0) {
  if (smokesDone.has(id) || smokes.some((s) => s.id === id)) return;
  smokes.push({ id, pos, at: nowSec() - age, duration });
  renderer.smokes?.addCloud(id, pos, duration, age);
}

// Is the line of sight from a to b through smoke (for the aim hack,
// triggerbot, enemy names)?
const smoked = (a, b) => smokeBlocks(smokes, a, b, nowSec());

// The smoke bomb's icon (bottom right): ready, held, or cooling down (the
// part still to go shaded, the seconds left); and the view greyed inside a
// cloud.
function updateSmokeHud(now) {
  const icon = $('smokeIcon');
  icon.hidden = me.dead;
  const left = Math.max(0, smokeReadyAt - now) / 1000;
  icon.classList.toggle('held', smokeHeld);
  icon.classList.toggle('cooling', left > 0);
  icon.style.setProperty('--left', (left / SMOKE.cooldown).toFixed(3));
  icon.querySelector('.cd').textContent = left > 0 ? Math.ceil(left) : '';
  const eye = myEye();
  let inside = 0;
  for (const s of smokes) {
    const r = smokeRadius(nowSec() - s.at, s.duration);
    const c = smokeCentre(s.pos);
    if (r > 0) inside = Math.max(inside, 1 - Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]) / r);
  }
  $('smokeView').style.opacity = Math.min(0.45, inside * 1.2).toFixed(3); // (light: the cloud's own near puffs thin out, see Smokes)
  renderer.setTrajectory(smokeHeld && !throwUntil && !me.dead ? predictThrow(renderer.smokeInHand()) : null);
}

// Where a smoke bomb thrown now would go (as the host flies it: from the
// eye, not through a wall in front, the same physics), up to where it pops:
// points every 1/60 s. Drawn from the bomb in our hand (from: [x,y,z], or
// null), easing into the real path over its first part (seen from right
// behind it, the path alone was a vertical line).
function predictThrow(from) {
  const eye = myEye();
  const dir = lookDir(me.yaw, me.pitch);
  const out = Math.max(0.1, Math.min(0.5, world.raycast(eye, dir, 0.6) - 0.1));
  const g = { pos: eye.map((v, i) => v + dir[i] * out), vel: dir.map((v, i) => v * SMOKE.speed + (i === 1 ? SMOKE.up : 0)), rest: false };
  const points = [[...g.pos]];
  for (let k = 0; k < SMOKE.fuse * 60 && !g.rest; k++) {
    world.stepGrenade(g, 1 / 60);
    points.push([...g.pos]);
  }
  if (from) {
    const off = from.map((v, i) => v - points[0][i]);
    const ease = Math.min(points.length - 1, 24); // (the first 0.4 s)
    for (let k = 0; k <= ease; k++) {
      const w = (1 - k / ease) ** 2;
      for (let i = 0; i < 3; i++) points[k][i] += off[i] * w;
    }
  }
  return points;
}

// ---- triggerbot ---------------------------------------------------------------
// Is the crosshair (the view's centre, before spread) on an enemy we can see:
// the first thing along it one of their hitboxes, not a wall? With the
// knife, only within its reach.

function crosshairOnEnemy(w) {
  const eye = myEye();
  const dir = lookDir(me.yaw, me.pitch);
  let nearest = world.raycast(eye, dir, MAX_RANGE);
  let onEnemy = false;
  for (const [id, avatar] of renderer.avatars) {
    if (avatar.dead || id === myId || avatar.team === myTeam) continue;
    const seen = apparent(id, avatar); // (a fake-lag player: their afterimage)
    if (!seen) continue;
    const t = rayPlayer(eye, dir, seen.pos, seen.pose).t;
    if (t < nearest) { nearest = t; onEnemy = true; }
  }
  if (onEnemy && smoked(eye, eye.map((v, i) => v + dir[i] * nearest))) return false; // through smoke
  return onEnemy && (!w.melee || nearest <= w.melee.range);
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
    if (me.dead) me.crouched = false;
    me.crouch = me.crouched ? Math.min(1, me.crouch + dt / CROUCH_TIME) : Math.max(0, me.crouch - dt / CROUCH_TIME);
    updateReload(now);
    updateScope(dt, now);
    if (has('aim') && (keys.has('AltLeft') || keys.has('AltRight')) && locked() && !me.dead) aimLock();
    tryShoot(now);
    if (throwUntil && now >= throwUntil) { throwUntil = 0; smokeHeld = false; } // thrown: back to the weapon
    if (me.dead) { smokeHeld = false; throwUntil = 0; }
    for (let i = smokes.length - 1; i >= 0; i--) {
      if (nowSec() - smokes[i].at < smokes[i].duration) continue;
      smokesDone.add(smokes[i].id);
      smokes.splice(i, 1);
    }

    if (!me.dead && now - lastStateSent >= 1000 / STATE_SEND_RATE) {
      lastStateSent = now;
      session.send({ t: 'state', p: me.pos, yaw: me.yaw, pitch: me.pitch, c: me.crouched ? 1 : 0, l: me.climbing ? 1 : 0, s: smokeHeld ? 1 : 0 }, false);
    }

    // Spread eases toward what the current movement allows.
    // (Flying counts as standing on the ground; crouching halves it; the
    // recoil hack cuts it 85%.)
    const speed = Math.hypot(me.vel[0], me.vel[2]) / speedHack();
    const target = spreadFor(weapon(), speed, me.onGround || has('fly'), me.scope > 0.95, me.crouch) * (has('recoil') ? RECOIL_HACK : 1);
    me.spread += (target - me.spread) * (1 - Math.exp(-12 * dt));

    renderRemotePlayers(now, dt);
    updateHud(now);
  } else {
    // Idle camera orbiting the map behind the menu.
    menuAngle += dt * 0.05;
  }

  renderer.gun.visible = !!session && !me.dead && !me.climbing;
  if (session) {
    const eye = myEye();
    renderer.updateViewmodel(dt, {
      pos: me.pos,
      yaw: me.yaw,
      pitch: me.pitch,
      vel: [me.vel[0], me.onGround ? 0 : me.vel[1], me.vel[2]],
      dead: me.dead,
      crouch: me.crouched,
      climbing: me.climbing,
      reloading: !!me.reloadEnd,
      ground: me.onGround ? me.pos[1] : groundBelow(me.pos),
      weapon: me.weapon,
      smoke: smokeHeld,
      fast: has('ammo'),
      hidden: me.scope > 0.85 || me.climbing, // looking through the scope; on a ladder (no gun)
      eye,
    });
    setListener(eye, lookDir(me.yaw, me.pitch));
    // Tracers start at the muzzle as it's drawn this frame, before the recoil
    // kick (applied from the next frame) lifts the rifle: otherwise the line
    // hangs ~5 cm above the muzzle while the rifle drops back.
    if (pendingTracers.length) {
      const muzzle = renderer.localMuzzle();
      for (const shot of pendingTracers) {
        renderer.addTracer(muzzle, shot.end, shot.hit);
        if (shot.wall) renderer.tracers.addImpact(shot.wall);
      }
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
window.hackfps = { renderer, me, world, audioDebug, rtt: () => rtt };

// ---- host / join -----------------------------------------------------------

// A Web Worker drives the host tick: worker timers aren't throttled as hard
// as main-thread timers when the host tab is in the background.
// A steady timer in a Web Worker: unlike timers on the page, it isn't
// slowed down while the tab is in the background.
function startTicker(fn, rate = 60) {
  const src = `setInterval(() => postMessage(0), ${1000 / rate});`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = fn;
  return () => worker.terminate();
}

function playerName() {
  return $('name').value.trim() || 'Player';
}

function setBusy(busy) {
  $('hostBtn').disabled = busy;
  $('joinBtn').disabled = busy;
}

function enterGame(code, isHost) {
  $('menu').hidden = true;
  $('hud').hidden = false;
  setStatus(null);
  room = { code, hosting: isHost };
  showRoomInfo(); // (the host's own welcome has already arrived)
  // The room code in the address bar: the whole URL is the invite.
  history.replaceState(null, '', `${location.pathname}?room=${code}`);
  // No pointer lock yet: the game starts in the buy menu, which needs the
  // mouse pointer; its Start button locks it.
}

function leaveGame(reason) {
  const old = session;
  session = null; // clear first: closing fires 'close' events that call back here
  old?.close();
  if (old?.isHost) history.replaceState(null, '', location.pathname); // (the room is gone)
  myId = null;
  snapshots = [];
  latestPlayers = [];
  teamKills = null;
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
  smokes.length = 0; // (a new room numbers its clouds from 1 again)
  smokesDone.clear();
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
  setStatus(reason ?? null);
}

$('hostBtn').addEventListener('click', async () => {
  unlockAudio(); // (browsers allow audio only after a click)
  setBusy(true);
  setStatus('status.creating');
  let peer;
  let code;
  for (let attempt = 0; attempt < 3 && !peer; attempt++) {
    code = makeRoomCode();
    try {
      peer = await openHostPeer(code);
    } catch (err) {
      if (err.type !== 'unavailable-id') {
        setStatusError(err, 'status.hostFailed');
        setBusy(false);
        return;
      }
    }
  }
  if (!peer) {
    setStatus('status.noCode');
    setBusy(false);
    return;
  }

  const server = new HostServer(peer, onMessage, world, { hackLimit: hostLimit === 'any' ? 0 : HACK_LIMIT, mode: hostMode });
  window.hackfps.server = server; // (dev hook)
  const stopTicker = startTicker(() => server.tick());
  peer.on('error', (err) => console.warn('peer error', err));

  session = {
    isHost: true,
    send: (msg) => server.handleMessage(HOST_ID, msg),
    close: () => { stopTicker(); server.destroy(); },
  };
  server.handleMessage(HOST_ID, { t: 'join', name: playerName() });
  enterGame(code, true);
  server.handleMessage(HOST_ID, { t: 'bots', n: botFill });
  server.handleMessage(HOST_ID, { t: 'botHacks', on: botHacks });
});

$('joinBtn').addEventListener('click', async () => {
  unlockAudio();
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 5) return setStatus('status.enterCode');
  setBusy(true);
  setStatus('status.connecting');

  let conn;
  try {
    conn = await joinRoom(code);
  } catch (err) {
    setStatusError(err);
    setBusy(false);
    return;
  }

  const { peer, rel, state } = conn;
  rel.on('data', onMessage);
  state.on('data', onMessage);
  const onLost = () => { if (session) leaveGame('status.disconnected'); };
  rel.on('close', onLost);
  rel.on('error', onLost);
  // Heartbeat (the host drops silent players) and host watchdog.
  lastHostMessage = performance.now();
  const stopHeartbeat = startTicker(() => {
    if (rel.open) rel.send({ t: 'ping', at: performance.now() });
    if (session && performance.now() - lastHostMessage > HOST_TIMEOUT * 1000) leaveGame('status.lost');
  }, 1);

  session = {
    send: (msg, reliable) => {
      const c = reliable ? rel : state;
      if (c.open) c.send(msg);
    },
    // Leaving on purpose (or closing the tab): tell the host first, so our
    // character goes at once instead of after the timeout.
    close: () => {
      stopHeartbeat();
      if (rel.open) rel.send({ t: 'bye' });
      setTimeout(() => peer.destroy(), 50);
    },
  };
  rel.send({ t: 'join', name: playerName() });
  enterGame(code, false);
});

$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

// Closing the tab / leaving the page: say goodbye (see session.close).
window.addEventListener('pagehide', () => { if (session) leaveGame(); });

// Opened from an invite link (…?room=CODE): fill in the code.
{
  const invited = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
  if (invited && /^[A-Z0-9]{5}$/.test(invited)) {
    $('codeInput').value = invited;
    showMenuTab('join');
    setStatus('status.invited', { code: invited });
  }
}
