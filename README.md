# Hack FPS

A small browser FPS where any player can click **Create room** and their own tab
becomes the server. Other players join with a 5-character room code. There's
no build step and no game server to deploy. Two teams (Blue and Red), no
friendly fire; each team spawns in its own base.

## Run it

```sh
npm start              # or: python3 -m http.server 8080
```

Open http://localhost:8080, open the **Create a room** tab, pick a game mode
and click **Create room**; then open a second tab or another computer, enter
the room code under **Join a room** (the tab shown first, unless you last
created a room) and click **Join**. Easier: the
host's address bar shows `…/?room=CODE` once the room is up; whoever opens
that link gets the Join tab with the code filled in and just enters a name
and clicks **Join**.
Players who close their tab (or crash, or lose their connection) are removed
within a few seconds.

The game is in English and Korean (한국어): switch on the main menu. The
choice is remembered in the browser; Korean is the default. Each player sees the game in their own language.

ES modules don't load from `file://`, so you need a local server. To play
with friends over the internet, put these static files on any host, such as
GitHub Pages, Netlify or itch.io.

Controls: WASD move · Space jump · Ctrl or Shift (hold) crouch · Mouse aim · Click shoot · R reload · C smoke bomb (then click to throw) · Q / E fly up / down (fly hack) · Alt aim lock (aim hack; the triggerbot fires by itself) · 1-7 / wheel switch weapon (only for the player named "Admin") · Right mouse scope (sniper) · Enter chat (type, Enter to send, Esc to cancel) · M mute · Tab scoreboard · Esc release mouse.

**Smoke bomb.** Everyone spawns with one. C takes it out (or puts it
away): you hold it out, and a red line shows where it'll go and a ring where
it'll pop. A click throws it (an overhand throw, or the running one while
moving); it bounces, pops 1.5 s later into a 7 m cloud that bursts out in a
fraction of a second and lasts 8 s, and you're back on your weapon. It's
ready again 20 s after a throw (the icon above your money and hacks counts down, and
shakes if you press C too early).
Smoke blocks sight: the aim hack and triggerbot won't lock onto or fire at
anyone through it, bots can't see through it, enemy names don't show
through it, and inside it the view is greyed out. It doesn't stop bullets
(spray into it blind), the wall hack or the map hack.

**Hacks.** The core of the game: in the same menu you also buy hacks
(you pay for the weapon and each hack), active until your next death. How
many at once is the host's pick under **Hacks per life** before clicking
**Create room** (shown next to the room code):

- **Default:** up to 2 hacks per life; once 2 are ticked the rest are
  locked until you untick one.
- **No limit:** as many as you can afford (ticked boxes). They combine:
  e.g. fly + no-clip flies up through floors and ceilings; with speed + fly
  the speed hack's 3x applies.

Teammates can see each other's hacks on the scoreboard; the other team can't.

**Game modes** (a card each in the Create tab; shown next to the room code
and in the buy menu):

- **Classic (기본 모드):** every weapon and hack; a team wins the round when
  one of its players buys the Victory hack ($10,000).
- **Melee mode (칼전 모드):** knives only: no guns in the buy menu, weapon spots
  off. Recoil, infinite ammo, rapid-melee, HP, aim and Victory hacks are off.
- **Headshot mode (헤드샷 모드):** everyone has 1 HP and only headshots hurt
  (a body shot is stopped by the body, harmlessly). Everyone spawns with the
  sniper rifle, free; no other guns, weapon spots off. Rapid-melee, wallbang, HP,
  triggerbot, aim and Victory hacks are off.

In melee and headshot mode the first team to **50 kills** wins the round
(the score at the top shows `kills / 50`). Admin's weapon switching is off in
both. Money, heal and money spots, and smoke bombs work as usual.

| Hack | Price | Effect |
|---|---|---|
| Map | $300 | Minimap (lower left): every player with their name, every pickup spot and its countdown |
| Speed | $400 | Move 3x faster, jump 2.5x higher |
| Recoil | $500 | 85% less spread |
| Infinite ammo | $500 | No reloads; shotgun and sniper fire twice as fast |
| No-clip | $600 | Walk through walls and ceilings (floors and the boundary still hold) |
| Fly | $700 | Q up, E down, hover otherwise; up to 25 m, inside the boundary; moves 1.3x faster |
| Rapid melee | $800 | Knife: hold the button to swing 10x as fast (0.06 s between swings instead of 0.6 s; normal damage per swing) |
| Wall | $900 | See every player through walls: silhouette in their team colour plus hitboxes |
| HP | $1,000 | 1500 HP (heal packs still heal 100) |
| Wallbang | $1,100 | Your shots (every gun) and knife go through walls and floors, across the whole map, at full damage. The aim hack and triggerbot still ignore enemies behind walls |
| Triggerbot | $1,200 | Fires by itself whenever the crosshair is on a visible enemy (the knife: within its reach) |
| Fake-lag | $1,500 | Invisible to enemies (see-through to you and your team): they see a solid afterimage of you, renewed every second where you are. Attacking removes it and shows you to everyone for 1 s. Enemies' aim hack, triggerbot, wall and map hacks (and bots) go by the afterimage; your real hitbox, footsteps and hit sparks stay where you are |
| Aim | $2,000 | Hold Alt: the view locks onto the head of the visible enemy nearest the crosshair |
| Victory | $10,000 | Your team wins the round: 10 s victory screen, then a new round (money, kills and hacks reset) |

**Money.** Everyone starts with $0 (the player named "Admin" with $999,999, for testing) and earns $16 for every second they stay
alive (paid when they die) and $500 per kill; the scoreboard (Tab) and the
bottom-left of the HUD show it. On joining and after every death a menu lets
you pick the weapon to spawn with: the knife is free, the guns cost money
(pistol $200, revolver $250, P90 / shotgun $400, rifle $500, sniper $650); what you can't
afford is greyed out. Press Start to spawn (after the 2 s respawn delay).

Other weapons are also picked up in the map: ten spots marked with a
white circle (see the map section below) each offer a random weapon (any of
them, the pistol and the knife too). Walk over the circle to take it, with a full magazine; you keep it
until you pick up a different one or die (back to the knife). An emptied spot
shows a countdown and gets a new random weapon after 20 s. (The player named "Admin" can also switch
freely with the keys below.)

Heal packs (green circles) heal you by 100 HP when you walk over one while
hurt. Money spots (yellow circles, a gold coin) give $1,000. Both refill
after 20 s, with the same countdown.

| Key | Weapon | Price | Fire | Damage (body / head) | Rounds | Reload |
|---|---|---|---|---|---|---|
| 1 | Knife | free | swing (hold to keep swinging), 0.6 s; reach 2 m | 50, from behind 100 | – | – |
| 2 | Pistol | $200 | per click, 0.15 s | 30 / 75 | 12 | 1.6 s |
| 3 | Revolver | $250 | per click, 0.35 s | 55 / 110 | 6 | 2.4 s |
| 4 | Rifle | $500 | automatic, 0.15 s | 25 / 50 | 30 | 2.2 s |
| 5 | P90 | $400 | automatic, 0.075 s | 17 / 34 | 50 | 2.5 s |
| 6 | Shotgun | $400 | per click, pumped, 0.65 s | 8 pellets × 13 / 20, less with distance | 6 | 2.6 s |
| 7 | Sniper | $650 | per click, bolt, 1 s; scope | 80 / 200 | 5 | 3 s |

**Knife** (what everyone spawns with): a slash that hits the nearest enemy
within 2 m in front of you (about 35° either side of where you look, not
through walls), 50 damage, 100 from behind (they face away from you). You
run 25% faster holding it. No ammo, no reload.

Switching takes 0.45 s and cancels a reload. Press R to reload, or it reloads by itself
when the magazine runs dry. Spare magazines are unlimited. Weapon stats live in
`WEAPONS` in `src/shared.js`.

Players have 200 HP. Headshots do extra damage (see the table: e.g. the rifle
kills with 4 headshots or 8 body shots). Shots spread more
while moving and most in the air, and half as much crouched; the crosshair
ticks show how much. Crouching (hold Ctrl or Shift) also halves your speed and
lowers you (eyes, hitboxes; you fit under 1.25 m, and stand up again once
there's room). Most
to least accurate: sniper scoped, revolver, pistol and rifle, sniper unscoped
(a little wider than the rifle) and P90, shotgun. After
spawning you're protected for 3 s (a faint shield), until you fire. A red arc
round the crosshair points at whoever hit you. Teammates' names show through
walls; enemies' only when they're in sight.

Players join the team with fewer players. The team score (top centre) is the
team's kills this round (counted by the host; out of 50 in melee and headshot
mode).

## Assets

Characters, guns and the city kit are low-poly CC0 packs by Quaternius;
animations are Mixamo rifle animations. Sources live in `fbx/`; the game
loads optimised GLBs from `assets/models/`. Rebuild them with:

```sh
npm install            # once: glTF tools, meshoptimizer, KTX2 encoder
npm run build:assets   # Blender stage + optimisation (~1 min)
npm run optimize:assets  # optimisation stage only
```

1. `tools/convert_assets.py` (Blender, headless): scales the characters,
   retargets the Mixamo clips onto their skeletons, bakes material colours
   into vertex colours (one draw call per character), writes to `build/blender/`.
2. `tools/optimize_assets.mjs` (Node): meshopt-compresses geometry and
   animation, strips unused animation channels, merges the city kit into one
   `city_kit.glb` with KTX2 GPU-compressed textures.

To add a character, drop its FBX into `fbx/Character/`, rebuild, and add its
name to `SKINS` in `src/assets.js`. Texture sizes for the kit are set by
`TEXTURE_SIZE` in `tools/optimize_assets.mjs`.

Dev pages: `preview.html` (character animations with every gun, third or first person), `kit.html` (every city kit
piece with names, plus draw calls, triangles and GPU texture memory).

## The map: Clock Tower District

It follows the blueprint in
[`docs/clock-tower-district-blueprint.html`](docs/clock-tower-district-blueprint.html)
(open it in a browser; also at https://claude.ai/artifact/TQAqcKbaK8rvvz1DBCx93G).
That was the original proposal: the map has changed since in places, and
`tools/district_generator.py` is what it is now. In short: a 88 x 120 m
city block, Blue spawning in Central Station (north) and Red in City Hall
(south), mirrored across the middle, three lanes (Canal, Main Street, Market
Alley) with a Subway underneath, rooftops above, and the Clock Tower and the
Crane in the middle. Up in the sky, cover for fly-hack players: in each half
an ad blimp high over Market Alley's crossroads (~17-22 m, the two turned
into a V; Blue's says "HACK SOJU" in blue, Red's "HACK COLA" in red) and a
hot-air balloon in the team's colours by the Canal at Bridge Street (its
crown at 24 m, just under the 25 m fly ceiling; its basket at ~12 m). They're solid and
can't be destroyed; their tops and the basket can be stood on. The buildings are simple boxes with tiling textures,
each landmark in its own colour (white Hospital, grey stone Bank, green
corrugated Warehouse, ...); props from the asset packs make it lived in:
parked cars (police cars at the Police Station, taxis at the bases), trees
and planters, crates, barrels and carts, AC units on the roofs, food on
the market stalls, and furniture inside (hospital and hotel beds, bank and
police desks, station couches, a café, warehouse racks). Cars,
crates, barrels, planters and tree trunks are solid cover (shots pass
through leaves).

- **Chat:** Enter opens a box at the bottom left; Enter sends to everyone
  (both teams), Esc cancels. Names show in their team's colour; lines fade
  after 10 s and all recent ones show while the box is open. Moving and
  shooting pause while you type. The host trims messages to 100 characters
  and drops more than one per 0.6 s per player.
- **Callouts:** the HUD shows where you are under the room line
  ("병원 · 4F", "Hotel · Roof"); the map hack's minimap shows the names too.
- **Footsteps** on metal (the Warehouse / Factory catwalks, the crane's
  cab) and climbing a ladder sound metallic.
- **Ladders:** walk into one to climb (forward goes up, back goes down,
  sideways shuffles, jump lets go); at the top keep pushing forward to step
  off. No shooting and no gun while climbing. Ladders: inside the Clock
  Tower (to its 14 m balcony) and outside it (to the 20 m top), the Crane
  (12 m to the 18 m cab), the Hospital / Hotel fire ladders (to the roof) and
  the Warehouse / Factory roof hatches. Bots use them too.
- Pickups: weapons under the Canal Bridge, in the Subway, Market Hall 2F,
  Construction 3F, Hospital / Hotel 4F, Bank / Police roof, Warehouse /
  Factory catwalk; heal packs in the Hospital / Hotel lobby, Subway and Market
  Hall; money on the Clock Tower top, the Crane cab and the Warehouse /
  Factory roofs.

`tools/district_generator.py` writes `maps/district.blend` (everything in
it: geometry, props, spawns, ladders, pickups, callout zones and metal floors
as a `map_meta` scene property). It reads the textures and models from the
asset packs in `map_resource/` (not in git: the Quaternius Downtown City,
Medieval Village, Modular SciFi and Stylized Nature MegaKits, Realistic Car
Pack, Platformer Pack, Ultimate Food Pack and Ultimate House Interior Pack,
all CC0) and saves what it uses to
`maps/textures/` (in git), so only regenerating needs the packs:

```sh
npm run gen:map         # regenerate maps/district.blend from the script
npm run build:map       # bake the lighting (~4 min on the GPU), export + optimise → assets/models/district*
npm run build:map:fast  # no bake (dynamic lighting in game), a few seconds: for layout iterations
npm run build:lightmap  # ~20 s: redo only the brightness settings (LM_*, DARK_*) from the last bake
```

Props (`district_props.glb`) are lit in real time like the characters; the
buildings' lighting is baked into a lightmap (`assets/models/district_lightmap.ktx2`):
sun + sky with shadows, bounced light and ambient occlusion, done by Cycles
in `tools/export_map.py` (settings at the top). The game draws the baked map
unlit (colour × lightmap), which is cheaper than real-time lights;
characters still use dynamic lights. Characters are fully matte (Lambert,
no highlights) with a faint fuzz at the edges (`softShading` in `src/assets.js`).
Boundary blocks close the play area; the game also keeps players inside it.

## How it works

```
 Host tab                                  Joiner tab
 ┌─────────────────────────┐   WebRTC     ┌──────────────┐
 │ HostServer (host.js)    │◄────────────►│ client       │
 │  · health / hits / kills│ data channels│ (main.js)    │
 │  · respawns / snapshots │              └──────────────┘
 │ + local client (main.js)│
 └─────────────────────────┘
        ▲  only for the initial handshake
        └── PeerJS public signaling broker (0.peerjs.com)
```

| File | Purpose |
|---|---|
| `src/shared.js` | Constants and small helpers (used by both sides) |
| `src/world.js` | Map collision: player movement (capsule vs. mesh) and bullet raycasts, via three-mesh-bvh |
| `src/net.js` | PeerJS host/join; room code → peer ID |
| `src/config.js` | STUN/TURN servers used to connect players |
| `src/host.js` | The in-browser game server |
| `src/bots.js` | AI players (bots), run by the host |
| `src/nav.js`, `src/nav-worker.js` | The bots' navigation graph (built from the map's collision in a worker) and A* paths |
| `src/main.js` | Menu, input, local movement, interpolation, HUD |
| `src/i18n.js` | Interface text in English and Korean, the language switch |
| `src/render.js` | three.js scene, first-person rifle, tracers |
| `src/character.js` | Animated player character: clip blending, aim, rifle in hand, left-hand IK |
| `src/assets.js` | Loads the GLB models; list of character skins |
| `assets/models/` | Game-ready models (generated; don't edit by hand) |
| `sounds/` | Sound effects (gunshot, reload, footsteps, landing), loaded by `src/audio.js` |
| `src/audio.js` | Sound playback (3D for other players), processing of the recordings, synthesised fallbacks |
| `src/effects.js` | Muzzle flash, tracers, impact sparks |
| `fbx/` | Source FBX assets (characters, guns, Mixamo animations), all CC0 / Mixamo |
| `tools/convert_assets.py` | Blender stage of the asset build (see Assets) |
| `tools/optimize_assets.mjs` | Optimisation stage of the asset build (see Assets) |
| `npm run build:guns` | Rebuild just the weapon models (all six) |
| `npm run build:anims` | Rebuild the animations (rifle + pistol clips) and the weapons, not the characters |
| `tools/district_generator.py` | Generates `maps/district.blend` (geometry, spawns, ladders, pickups, callout zones) from the layout in the script (`npm run gen:map`) |
| `tools/export_map.py` | Bakes the lighting and exports the `.blend` for the game (`npm run build:map`) |
| `maps/district.blend` | The map |
| `kit.html`, `src/kit.js` | City kit catalogue / asset check page |
| `preview.html`, `src/preview.js` | Animation preview page (http://localhost:8080/preview.html) |

- **Two channels per client:** `rel` is reliable and ordered, for joins,
  shots and respawns. `state` is unreliable and unordered (UDP-like), for
  positions and snapshots.
- **Movement** is simulated on each client and sent to the host 30×/s, so it
  feels instant.
- **Combat** is decided by the host: hit detection, damage, kills and
  respawns. The host sends world snapshots 20×/s.
- **Remote players** are drawn 100 ms in the past and interpolated between
  snapshots, so they move smoothly.
- **The host tick** runs from a Web Worker timer, so the game keeps running
  when the host switches tabs.
- **Bots** (AI players): the host picks a team size under "Add AI bots", near
  the top of the buy menu (remembered in that browser). Bots fill each team up to that size
  and leave as people join. They're named `[BOT] …`, run on the host only
  (about 0.05 ms per bot per tick; nothing extra for other players), buy
  weapons with their money, and climb ladders like everyone else. With
  "Bots use hacks" ticked (next to the team size; on by default, remembered)
  they also buy up to the room's hack limit (3 with no limit) with what's
  left, suited to their weapon: HP, wall, map, speed, recoil, infinite ammo,
  rapid melee, wallbang, triggerbot, aim and fake-lag; never fly, no-clip or
  victory. The wall hack sees everyone in range through smoke (and through
  walls with wallbang too; without it, it hunts them, like the map hack), the
  aim hack is a weaker lock (head, 30% of the usual aim error, settling
  fast), the triggerbot reacts in about 0.1 s. Unticking it takes the bots'
  hacks away at once. The first time, the host builds a navigation graph from
  the map's collision in a background worker (about 2 s).

## Known limitations / next steps

- **Cheating:** clients report their own positions and apply their own shot
  spread (so their tracer shows where the shot really went), and the host can
  change anything. That's fine among friends. Fix it with server-side movement plus
  client prediction and reconciliation.
- **Lag compensation** (up to 0.6 s back): each shot says which snapshots the
  shooter was seeing, and the host checks it against the players there. So a
  target can still be hit just after ducking behind a wall, and a cheating
  client could claim an older view, within that 0.6 s.
- **Host leaves → game ends.** Host migration would fix this.
- **Connections:** see "Can't join?" below.
- No leave button yet: reload the page to leave a game.
- No sound, no weapon switching, no mobile/touch controls.
- Characters use dynamic lights, so they don't get darker indoors like the
  baked map does.

## Can't join?

If the joiner's error says **"Found the host, but the browsers couldn't open a
direct connection"**:

- **Both players on one computer:** open the game at `http://localhost:8080`
  in both browsers. Browsers hide local addresses behind random `.local`
  names, and VPNs or security software often block the lookup (multicast
  DNS). On localhost, `src/net.js` also tries each `.local` address as
  `127.0.0.1`, which works around this. On macOS, also check **System
  Settings → Privacy & Security → Local Network**.
- **Different computers:** VPNs (e.g. corporate Cisco/AnyConnect), some
  routers and some networks (mobile, school, office) block direct connections.
  With the relay set up (below), players join through it automatically
  instead; without it, try with the VPN off.

Lines starting with `[net]` in the browser console show connection progress.

## Relay (for VPNs and strict networks)

Players normally connect straight to the host's browser (WebRTC through
PeerJS). When that fails, or PeerJS's server can't be reached, the game falls
back to a small relay on Cloudflare (`relay/`): a Worker with one Durable
Object per room. The host opens the room on PeerJS and on the relay; a
player tries the direct way first (up to 8 s) and then joins through the
relay ("No direct connection: connecting through the relay…"). It's ordinary
secure WebSocket traffic on port 443, which VPNs and firewalls let through.
The relay only passes messages between the host and the players (the host's
browser still runs the game), stores nothing, and only accepts the game's
own site (`https://carpwaffle.github.io`) and localhost. A room can mix
direct and relayed players.

- **Local testing:** `cd relay && npm install && npm run dev` (port 8787).
  On localhost the game uses it automatically (`RELAY_URL` in
  `src/config.js`); add `&relay` to the page address to join through it
  without trying the direct way first.
- **Deployed** at `wss://hackfps-relay.hamburgler.workers.dev` (`RELAY_URL`
  in `src/config.js`). To update it: `cd relay`, `npx wrangler login` once,
  then `npm run deploy`. Wrangler 3 is used because Wrangler 4 needs Node
  22.12+.
- **Lag:** from Korea, Cloudflare's free plan routes through Singapore, so a
  relayed player's round trip to the host is about 200-300 ms (direct: 10-30
  ms within Korea). That's why it's only a fallback.
- **Cost:** the free Workers plan includes Durable Objects (about 100,000
  requests a day; going over makes the relay refuse until the next day, it
  never bills). Only relayed players count, and the host sends each team's
  snapshot to the relay once for all its relayed players.
