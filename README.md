# Hack FPS

A small browser FPS where any player can click **Host Game** and their own tab
becomes the server. Other players join with a 5-character room code. There's
no build step and no game server to deploy. Two teams (Blue and Red), no
friendly fire; each team spawns in its own base.

## Run it

```sh
npm start              # or: python3 -m http.server 8080
```

Open http://localhost:8080, click **Host Game**, then open a second tab or
another computer, enter the room code, and click **Join**.

ES modules don't load from `file://`, so you need a local server. To play
with friends over the internet, put these static files on any host, such as
GitHub Pages, Netlify or itch.io.

Controls: WASD move · Space jump · Mouse aim · Click shoot · R reload · Q / E fly up / down (fly hack) · Shift aim lock (aim hack) · 1-6 / wheel switch weapon (only for the player named "Admin") · Right mouse scope (sniper) · M mute · Tab scoreboard · Esc release mouse.

**Hacks.** The core of the game: in the same menu you also buy one hack
(separately from the weapon: you pay for both), active until your next death.
Teammates can see each other's hacks on the scoreboard; the other team can't.

| Hack | Price | Effect |
|---|---|---|
| Map | $300 | Minimap (lower left): every player, every pickup spot and its countdown |
| Speed | $400 | Move 3x faster |
| Recoil | $400 | 85% less spread |
| Infinite ammo | $500 | No reloads; shotgun and sniper fire twice as fast |
| Wall | $600 | See every player through walls: silhouette in their team colour plus hitboxes |
| Fly | $700 | Q up, E down, hover otherwise; up to 25 m, inside the boundary; moves 1.3x faster |
| No-clip | $800 | Walk through walls and ceilings (floors and the boundary still hold) |
| HP | $800 | 1500 HP (heal packs still heal 100) |
| Aim | $900 | Hold Shift: the view locks onto the head of the visible enemy nearest the crosshair |
| Victory | $10,000 | Your team wins the round: 10 s victory screen, then a new round (money, kills and hacks reset) |

**Money.** Everyone starts with $0 (the player named "Admin" with $999,999, for testing) and earns $4 for every second they stay
alive (paid when they die) and $250 per kill; the scoreboard (Tab) and the
bottom-left of the HUD show it. On joining and after every death a menu lets
you pick the weapon to spawn with: the pistol is free, the others cost money
(revolver $250, P90 / shotgun $400, rifle $500, sniper $650); what you can't
afford is greyed out. Press Start to spawn (after the 2 s respawn delay).

Other weapons are also picked up in the map: ten spots
marked with a white circle (House04, House12, the east and west ends of the
road, four on House08's 5th floor, and the middle of the House01 / House09
bridges) each
offer a random weapon (not the pistol). Walk over the circle to take it, with a full magazine; you keep it
until you pick up a different one or die (back to the pistol). An emptied spot
shows a countdown and gets a new random weapon after 20 s. (The player named "Admin" can also switch
freely with the keys below.)

Heal packs (green circles: 4th floor of House05 / House13, the north annex
of House01 / south annex of House09, two on House08's roof) heal you by 100
HP when you walk over one while hurt. Money spots (yellow circles, a gold
coin: the roofs of House03 / House11 and House07 / House15, the latter behind
a billboard that hides them from House08) give $1,000. Both refill after 20 s,
with the same countdown.

| Key | Weapon | Price | Fire | Damage (body / head) | Rounds | Reload |
|---|---|---|---|---|---|---|
| 1 | Pistol | free | per click, 0.15 s | 30 / 75 | 12 | 1.6 s |
| 2 | Revolver | $250 | per click, 0.35 s | 55 / 110 | 6 | 2.4 s |
| 3 | Rifle | $500 | automatic, 0.15 s | 25 / 50 | 30 | 2.2 s |
| 4 | P90 | $400 | automatic, 0.075 s | 17 / 34 | 50 | 2.5 s |
| 5 | Shotgun | $400 | per click, pumped, 0.65 s | 8 pellets × 13 / 20, less with distance | 6 | 2.6 s |
| 6 | Sniper | $650 | per click, bolt, 1 s; scope | 80 / 200 | 5 | 3 s |

Switching takes 0.45 s and cancels a reload. Press R to reload, or it reloads by itself
when the magazine runs dry. Spare magazines are unlimited. Weapon stats live in
`WEAPONS` in `src/shared.js`.

Players have 200 HP. Headshots do extra damage (see the table: e.g. the rifle
kills with 4 headshots or 8 body shots). Shots spread more
while moving and most in the air; the crosshair ticks show how much. Most
to least accurate: sniper (a little more so scoped), revolver, pistol and
rifle, P90, shotgun. After
spawning you're protected for 3 s (a faint shield), until you fire. A red arc
round the crosshair points at whoever hit you. Teammates' names show through
walls; enemies' only when they're in sight.

Players join the team with fewer players. The team score (top centre) is the
team's total kills.

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

Dev pages: `preview.html` (character animations), `kit.html` (every city kit
piece with names, plus draw calls, triangles and GPU texture memory).

## The map

`maps/downtown.blend` is the map's master copy; edit it in Blender. It was
generated by `tools/map_generator.py` (Downtown City kit pieces) from the
blueprint `maps/blueprint_base_2.png`, and is now yours to refine. The
previous layout is kept in `maps/downtown_v1.blend`.

**Editing in Blender**

| Collection | What it is |
|---|---|
| `Buildings` | One Empty per building (plus `Ring`: the outer facades, and `Props`: cover walls, AC units, manholes). Move or rotate it to move the whole building, collision included. Custom properties `floors`, `enterable`. |
| `Visual` | Everything drawn: kit pieces (linked duplicates), generated stairs/walls, ground, sidewalks. |
| `Collision` | Simple shapes the game uses for movement and bullets (wireframe in Blender, invisible in game). **If you add, remove or move walls, update these too.** |
| `Spawns` | Empties named `Spawn_A_XX` / `Spawn_B_XX` with a `team` property (0 = Blue, north base; 1 = Red, south base). Players face the empty's green (local +Y) axis: rotate it about Z to aim it. |

Units are metres; walls are 2 m wide and 3 m per storey. After editing:

```sh
npm run build:map       # bake the lighting (~1.5 min on the GPU), export + optimise → assets/models/map*
npm run build:map:fast  # no bake (dynamic lighting in game), a few seconds: for layout iterations
npm run build:lightmap  # ~20 s: redo only the brightness settings (LM_*, DARK_*) from the last bake
```

The map's lighting is baked into a lightmap (`assets/models/map_lightmap.ktx2`):
sun + sky with shadows and bounced light, done by Cycles in
`tools/export_map.py` (settings at the top: sun direction/strength, sky,
exposure, dark lift, ambient). The game draws the baked map unlit (texture × lightmap),
which is cheaper than real-time lights; characters still use dynamic lights.

Then reload the game. `npm run blueprint` renders `maps/blueprint_base.png`, a
top-down image of the current map with a 2 m grid, for sketching changes on.
To regenerate the map from the script (this **discards** your Blender
edits): `Blender -b --factory-startup --python tools/map_generator.py -- --force`.

A ring of facades closes the arena; the game also keeps players inside the
48.5 m play radius.

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
| `src/main.js` | Menu, input, local movement, interpolation, HUD |
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
| `tools/map_generator.py` | Generates `maps/downtown.blend` from the layout in the script (`-- --force` overwrites) |
| `tools/export_map.py` | Bakes the lighting and exports the `.blend` for the game (`npm run build:map`) |
| `tools/make_blueprint.py`, `.mjs` | Top-down map image with a grid (`npm run blueprint`) |
| `maps/downtown.blend` | The map (edit in Blender); `downtown_v1.blend` is the first layout |
| `maps/blueprint_base.png` | Blueprint of the current map; `blueprint_base_2.png` is the user's drawing the v2 map was built from |
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

## Known limitations / next steps

- **Cheating:** clients report their own positions and apply their own shot
  spread (so their tracer shows where the shot really went), and the host can
  change anything. That's fine among friends. Fix it with server-side movement plus
  client prediction and reconciliation.
- **No lag compensation:** shots are checked against where players are on the
  host *now*. High-ping players have to lead their targets.
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
  Try with the VPN off, or add a TURN relay
  server to `ICE_SERVERS` in `src/config.js`. The free public relays have
  shut down, so use your own credentials, for example from Cloudflare
  Realtime TURN or Metered.ca (both have free tiers).

Lines starting with `[net]` in the browser console show connection progress.
