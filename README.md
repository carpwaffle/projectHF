# Hack FPS

A small browser FPS where any player can click **Host Game** and their own tab
becomes the server. Other players join with a 5-character room code. There's
no build step and no game server to deploy.

## Run it

```sh
npm start              # or: python3 -m http.server 8080
```

Open http://localhost:8080, click **Host Game**, then open a second tab or
another computer, enter the room code, and click **Join**.

ES modules don't load from `file://`, so you need a local server. To play
with friends over the internet, put these static files on any host, such as
GitHub Pages, Netlify or itch.io.

Controls: WASD move · Space jump · Mouse aim · Click shoot · Tab scoreboard · Esc release mouse.

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
generated once by `tools/map_generator.py` (Downtown City kit pieces), and is
now yours to refine.

**Editing in Blender**

| Collection | What it is |
|---|---|
| `Buildings` | One Empty per building (plus `Ring`, `Props`). Move or rotate it to move the whole building, collision included. |
| `Visual` | Everything drawn: kit pieces (linked duplicates), generated stairs/walls, ground, sidewalks. |
| `Collision` | Simple shapes the game uses for movement and bullets (wireframe in Blender, invisible in game). **If you add, remove or move walls, update these too.** |
| `Spawns` | Empties named `Spawn_XX`; players spawn at them. |

Units are metres; walls are 2 m wide and 3 m per storey. After editing:

```sh
npm run build:map      # export the .blend + optimise → assets/models/map*.glb, map_meta.json
```

Then reload the game. `npm run blueprint` renders `maps/blueprint_base.png`, a
top-down image of the current map with a 2 m grid, for sketching changes on.
To start over from a fresh random layout (this
**discards** your edits): `Blender -b --python tools/map_generator.py -- --force --seed 8`.

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
| `fbx/` | Source FBX assets (characters, guns, Mixamo animations), all CC0 / Mixamo |
| `tools/convert_assets.py` | Blender stage of the asset build (see Assets) |
| `tools/optimize_assets.mjs` | Optimisation stage of the asset build (see Assets) |
| `tools/map_generator.py` | Generates `maps/downtown.blend` (run once) |
| `tools/export_map.py` | Exports the `.blend` for the game (`npm run build:map`) |
| `maps/downtown.blend` | The map (edit in Blender) |
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

- **Cheating:** clients report their own positions, and the host can change
  anything. That's fine among friends. Fix it with server-side movement plus
  client prediction and reconciliation.
- **No lag compensation:** shots are checked against where players are on the
  host *now*. High-ping players have to lead their targets.
- **Host leaves → game ends.** Host migration would fix this.
- **Connections:** see "Can't join?" below.
- No leave button yet: reload the page to leave a game.
- No sound, no weapon switching, no mobile/touch controls.

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
