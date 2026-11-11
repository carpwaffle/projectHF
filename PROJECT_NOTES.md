# Hack FPS: Project Notes

A record of the project so far: the idea, design decisions, what was built,
what was tested, the connection problems we hit and how they were solved,
and what's next.

_Last updated: 2026-10-22_

---

## 1. The goal

A simple first-person shooter that runs in a web browser, where **a player can
host the game from inside the browser**. One player clicks "Host Game", their
tab becomes the server, and friends join with a room code. No dedicated game
server to deploy.

## 2. Key decision: how can a browser "host"?

**Problem:** browser JavaScript can't open a listening TCP/UDP port, so a tab
can't run a normal game server.

**Solution:** **WebRTC peer-to-peer.**

- WebRTC lets browsers connect directly to each other.
- Its **data channels** can be unreliable and unordered (UDP-like), which
  suits fast-paced game state.
- The host's tab runs the authoritative game logic; the other players are
  clients connected to it.

**What WebRTC still needs from outside:**

| Piece | Purpose | What we use |
|---|---|---|
| Signaling server | Introduces peers (swaps connection offers) before the direct link exists | PeerJS's free public broker (`0.peerjs.com`) |
| STUN | Lets a browser find its public address | Google public STUN |
| TURN | Relays traffic when a direct connection is impossible | **None yet** (see §7) |

**Trade-offs we accepted** (fine for playing with friends):

- The host has zero ping (host advantage).
- The game ends if the host leaves (no host migration).
- Host upload bandwidth limits games to about 4–8 players.
- The host, or a modified client, can cheat.

**Alternative for later:** a dedicated server (Node.js + WebSockets or
WebTransport, e.g. Colyseus) for public matchmaking, more players and
anti-cheat.

## 3. Tech stack

- **Three.js 0.170** for 3D rendering
- **PeerJS 1.5.4** for host/join and WebRTC data channels
- **No build step:** plain ES modules; both libraries load from jsdelivr via
  an import map in `index.html`
- Served as static files (`npm start` or `python3 -m http.server 8080`)

## 4. What was built

### Files

| File | Purpose |
|---|---|
| `index.html` | Page, import map, menu, HUD markup |
| `style.css` | Menu and HUD styling |
| `src/shared.js` | Constants, map layout, movement physics, collision, raycasts (shared by host and clients) |
| `src/net.js` | PeerJS wrapper: room codes, host/join, failure explanations, localhost `.local` workaround |
| `src/config.js` | ICE servers (STUN/TURN) |
| `src/host.js` | `HostServer`: the game server running in the host's tab |
| `src/main.js` | Menu, input, local movement, interpolation, shooting, HUD, game loop |
| `src/i18n.js` | Interface text (English, Korean), `t(key, params)`, the language setting |
| `src/render.js` | Three.js scene, arena, first-person rifle (bob, sway, recoil, flash), tracers |
| `src/character.js` | Animated player character from the model assets (see §11) |
| `src/assets.js` | GLB loader and the list of character skins |
| `tools/convert_assets.py` | Blender conversion + retargeting script (see §11) |
| `preview.html`, `src/preview.js` | Animation preview/tuning page |
| `README.md` | Run instructions, architecture, limitations, troubleshooting |
| `package.json` | `npm start` script |

### Gameplay

- Arena about 50×50 units with outer walls and cover (pillars, crates, low walls)
- WASD move · Space jump · mouse aim (pointer lock) · click to shoot (hold for auto-fire) · Tab for the scoreboard · Esc to release the mouse
- Hitscan gun: 25 damage, 0.15 s fire rate, so 4 hits kill
- Respawn after 2 s at the spawn point furthest from other living players
- HUD: health, crosshair, hit marker, red damage flash, kill/join feed, room code, scoreboard

### How hosting and joining work

1. **Host** clicks "Host Game". A random 5-character room code (e.g. `QW4F2`)
   is registered with the signaling broker as peer ID `hackfps-v1-<CODE>`.
   If the code is taken, it retries with a new one.
2. **Joiner** enters the code. PeerJS performs the WebRTC handshake.
3. The joiner opens **two data channels** to the host:
   - `rel`: reliable and ordered. Used for join, shots, hits, respawns and the feed.
   - `state`: unreliable and unordered (UDP-like). Used for positions and snapshots.
4. After that, all game traffic goes browser-to-browser.

The host's own player is a normal player with id `"host"`. Its messages are
passed by direct function call instead of over the network, so the client
code is identical for host and joiners.

### Netcode model

| Concern | Who decides | Detail |
|---|---|---|
| Own movement | Each client | Simulated locally for instant response and sent to the host 30×/s. The host only clamps it to the arena. |
| Hits, damage, kills, respawns | Host | The host raycasts from the shooter's stored position against map boxes and player hitboxes |
| World state | Host | Snapshots of all players broadcast 20×/s |
| Remote players' motion | Each client | Rendered 100 ms in the past, interpolated between snapshots |
| Own tracers | Each client | Drawn instantly for feel; the host's result is what counts |

**Host tick in a Web Worker:** the host's server loop is driven by a Web
Worker timer, which browsers throttle less than main-thread timers in
background tabs. The host can switch tabs without freezing the game.

### Message types

| Direction | Message | Channel |
|---|---|---|
| client → host | `join {name}` | rel |
| client → host | `state {p, yaw, pitch}` | state |
| client → host | `shoot {yaw, pitch}` | rel |
| host → client | `welcome {id, pos}` | rel |
| host → client | `snap {players[]}` | state |
| host → client | `shot {from, o, e}` · `hit {attacker, victim, hp}` · `respawn {pos}` · `leave {id}` · `feed {text}` | rel |

## 5. Testing done

| Test | Result |
|---|---|
| Syntax check of all JS files (`node --check`) | ✅ |
| Physics in Node: walking into the centre box stops at its edge; jump peaks about 1.2 units and lands | ✅ |
| Host logic in Node: shot blocked by a cover wall (correct); 4 hits in line of sight → victim dead, shooter +1 kill, feed entry | ✅ |
| Chrome: Host Game → room code issued | ✅ |
| Chrome: second tab joins via code | ❌ at first → ✅ after the fixes in §6 |
| Chrome: both tabs' scoreboards list both players; console shows `ICE connected` | ✅ |
| Safari, Firefox, two different computers | ⚠️ Not tested yet |

## 6. Connection troubleshooting log

Joining initially failed with "Could not connect to host". The investigation:

1. **Signaling worked:** the host received the joiner's connection request.
   The WebRTC link stalled in ICE state `checking`.
2. **Even a WebRTC connection from one tab to itself failed.** That path uses
   no internet and no router, so the cause was local to this machine.
3. **Tried the macOS Local Network permission** (System Settings → Privacy &
   Security → Local Network). The user enabled it; **still failed**.
4. **Free public TURN relays are dead:** both PeerJS's default
   (`eu-0.turn.peerjs.com`) and Open Relay (`openrelay.metered.ca`) gave no
   relay route.
5. **Found the real environment:** the Mac runs **Cisco Secure Client
   (AnyConnect) VPN** with all traffic routed through the tunnel, plus
   **SentinelOne** network monitoring. It's a managed machine.
6. **Pinpointed the failure:** a direct WebRTC connection **worked** on every
   real address (`127.0.0.1`, Wi-Fi IP, VPN IP). Only Chrome's privacy
   **`.local` (mDNS) host names** failed. Chrome hides local IPs behind
   random `<uuid>.local` names, and the VPN or security software blocks the
   multicast DNS lookup needed to resolve them.

### Fixes applied

- **Localhost `.local` workaround** (`src/net.js`): when the page is served
  from `localhost`, every `.local` ICE candidate is also tried as
  `127.0.0.1`. This connects browsers on the same computer even when mDNS is
  blocked. It only helps players on one computer and does nothing
  elsewhere. **This fixed joining.**
- **Clear failure messages:** the joiner's error now says whether the host
  didn't respond at all, or was found but a direct connection couldn't be
  made, with next steps (use `http://localhost:8080` in both browsers, VPN
  or firewall, TURN).
- **`[net]` console logs** show ICE candidates and state changes for
  debugging.
- **`src/config.js`** holds the ICE server list. Setting it replaced
  PeerJS's defaults, so the dead PeerJS TURN entry is gone.
- **Pointer-lock fix:** requesting pointer lock without a click no longer
  throws an error. The "Click to play" prompt covers that case.

### Current ICE config

```js
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
```

STUN only, **no TURN server**.

## 7. Current status

*(Updated 2026-10-25.)*

✅ **Working:** hosting, joining by room code, and both players seeing each
other, on one machine in Chrome via `http://localhost:8080`.

✅ **Game:** two teams (Blue north base House01, Red south base House09),
no friendly fire, team scores; animated Quaternius characters with
retargeted rifle animations.

✅ **Map:** the v2 Downtown layout from the user's blueprint (§14):
symmetric, ring of facades, 8 enterable buildings (all stairs verified to
their top floors, roofs reachable on House02/05/08 and twins), windows per
the user's specs (jump-through rule), baked lightmap lighting (§15).
The repo is on GitHub: https://github.com/rkdgkssmreo/projectHF

**Testing locally:** open `http://localhost:8080` (not `127.0.0.1` or the LAN
IP) in both browsers and reload them after code changes.

## 8. Known limitations

- **Cheating:** clients report their own positions, and the host controls the
  simulation.
- **No lag compensation:** shots are checked against players' current
  positions on the host, so high-ping players must lead targets.
- **Host leaves → game ends** (no host migration).
- **No TURN relay:** players on strict NATs, mobile networks or corporate
  networks (including this machine's Cisco VPN) may fail to connect across
  computers.
- **No leave button** (reload to leave), no sound, no weapon variety, no
  touch controls.
- Room codes rely on PeerJS's free public broker (no uptime guarantee).

## 9. Next steps

**To play across computers:**

1. Test from a second computer, or with the VPN off, to see whether direct
   connections work.
2. Add a TURN server to `src/config.js` (Cloudflare Realtime TURN or
   Metered.ca free tiers, or self-hosted coturn). For a public release,
   issue short-lived TURN credentials from a small backend.
3. Deploy the static files (GitHub Pages, Netlify, itch.io) so friends can
   open them.
4. Optionally self-host the signaling server (`peerjs-server`).

**Map / visuals:**

- Remaining enterable-building details: House04/12 (the user was going
  through the buildings one by one); which other roofs are reachable
- Characters don't darken indoors (tint by the lightmap under them)
- Stair railings on upper floors; interior restyle (brick interiors, dark
  ceilings); sidewalk kerb stripes
- Real mouse/keyboard play-test of the new map
- Lightmap: 4096 for sharper shadows if wanted

**Gameplay and netcode:**

- Leave-game button and a "host left" screen
- Sound effects, muzzle flash, hit feedback on avatars
- More weapons, ammo and reloads
- Server-side movement with client prediction and reconciliation (anti-cheat)
- Lag compensation (rewind hitboxes to the shooter's view time)
- Host migration
- Mobile/touch controls

**Housekeeping:**

- Test in Safari and Firefox

## 10. Procedural character animation (2026-10-22, since replaced by §11)

The box avatars were replaced with a **procedurally built and animated
soldier** (`src/character.js`). There are no model files: the body is a
hierarchy of box and capsule parts, posed every frame from the networked
state only (position, yaw, pitch, dead). No new network messages were needed.

| Feature | How |
|---|---|
| Run cycle (forward, backpedal, strafe, diagonal) | Velocity estimated from interpolated positions, converted to the body's frame; legs swing along the movement direction with knee bend, hip bob, torso lean and counter-twist |
| Holding the rifle | The rifle hangs off an "aim" joint that always points along the player's view (pitch); **two-bone IK** keeps both hands on the grips. Rifle stance twists the torso (left shoulder forward) |
| Aim up/down | Split between spine (30%) and the aim joint; the head follows |
| Idle | Breathing sway |
| Jump | Leg tuck when vertical speed is high |
| Firing | Recoil kick and muzzle flash, triggered by the host's `shot` message |
| Death | Falls backward with a small bounce; rifle and head go limp; body stays until respawn |
| Respawn | Teleport detection stops interpolation sliding across the map |
| Extras | Per-player colors (shirt, vest, helmet), name label, blob shadow |

**First-person rifle:** the same rifle model, with running bob, idle sway,
recoil and muzzle flash.

**Preview page:** `http://localhost:8080/preview.html` has buttons for each
movement, jump, auto-fire, die/respawn, turntable, aim-pitch and speed
sliders, and drag-to-orbit. The character runs on a "treadmill" with the
floor scrolling underneath.

**Verified in Chrome:** every animation on the preview page; a host/join
game with the new characters and no console errors.

**Known rough edges:** legs can cross slightly when strafing; the
first-person rifle can clip into walls; the hitbox is still the original box
(intentional, keeps hit detection simple).

## 11. Model characters with retargeted rifle animations (2026-10-24)

The procedural soldier (§10) was replaced with real models.

**Assets** (all CC0, plus Mixamo animations):

- `fbx/Character/`: 8 low-poly characters (4 male, 4 female). The 8
  "Smooth_" variants were removed (moved to the macOS Trash under
  `hackfps_smooth_characters`).
- `fbx/Gun/`: Rifle, Pistol, SniperRifle, P90, Shotgun, Revolver. Only
  **Rifle** is used so far.
- `fbx/Character Animation/`: 13 Mixamo rifle clips (idle, run forward and
  backward, strafe left and right, jump up/loop/down, death, firing, run
  firing, reload, run reload), downloaded "In Place" on Mixamo's default rig.

**Conversion** (`tools/convert_assets.py`, run in Blender in the background):

- Characters → `assets/models/characters/*.glb`, scaled to about 1.8 m,
  materials forced opaque (the source FBXs store alpha 0, which made the
  characters invisible at first).
- **Retargeting:** the Mixamo clips are on a different 65-bone rig. Both rigs
  rest in a T-pose, so each mapped bone copies the Mixamo bone's world
  rotation relative to its rest pose. The character rig's feet hang off the
  root bone (an IK setup), so they're positioned explicitly from the shins.
  Baked once per gender (the skeletons match within a gender) →
  `anims_male.glb` and `anims_female.glb`.
- Rifle → `rifle.glb`: static mesh, origin at the trigger, muzzle along −Z,
  0.9 m.

**Runtime** (`src/character.js`):

| Feature | How |
|---|---|
| Random character per player | The host picks an unused skin index at join and sends `skin` in snapshots, so every client shows the same model |
| Locomotion | Idle / run forward / run backward / strafe left / strafe right blended by body-frame velocity; run clips share one phase so the feet stay in step; playback speed follows movement speed |
| Jump, death | Jump loop while airborne; death clip played once |
| Aim pitch | Split across abdomen, torso, right upper arm (carries the rifle), neck and head |
| Rifle | Attached to the right hand; the offset is calibrated from the idle pose so the rifle points straight ahead |
| Left hand | Two-bone IK onto the rifle's handguard |
| Firing | Recoil kick and muzzle flash |
| First person | Same rifle model, with bob, sway and recoil |

**Preview page:** has a ◀ ▶ character picker.

**Verified in Chrome:** all 8 characters load; every clip checked on the
preview page (idle, run, backpedal, strafe, jump, aim up/down, fire, death)
on male and female models; in a host/join game, the joiner sees the host's
model (random skin) holding the rifle, with no console errors.

**Not used yet:** the firing, run_firing, reload and run_reload clips are
converted but not wired in (no reload mechanic yet). The other 5 guns are not
converted.

**Known rough edges:** the rifle stays in the dead player's hand and pokes
into the floor; the first-person rifle is fairly large on screen; the
animation files (~0.8 MB each) could be shrunk by dropping unanimated bones.
`window.hackfps` and `window.preview` are developer console hooks.

## 12. Asset optimisation (2026-10-24)

Goal: performance first, leaving room for baked lighting later.
One command rebuilds everything: `npm run build:assets` (Blender stage →
`build/blender/`, then Node stage `tools/optimize_assets.mjs` →
`assets/models/`).

### Results

| Asset | Before | After |
|---|---|---|
| 8 characters | 1.8 MB | 0.5 MB |
| Animations (male + female) | 1.7 MB | 0.33 MB |
| Rifle | 96 KB | 26 KB |
| **Game total** | **3.5 MB** | **0.86 MB** |
| City kit (153 pieces) | 89 MB (as 336 separate files) | 7.1 MB (one file) |
| City kit GPU texture memory | ~90 MB uncompressed | ~20 MB |

### What was done

- **Characters:** 6–9 flat-colour materials each, baked into vertex colours with one
  shared material → **1 draw call per character** (was 6–9). Meshopt
  compression + quantization.
- **Rifle:** same, but the gun FBXs have no colours at all (every material
  is default grey), so they're coloured by material name (wood, gunmetal,
  brass).
- **Animations:** the animation files no longer include a mesh; 1,261 of
  1,638 channels never move from the rest pose and were removed; rotations
  are stored as 16-bit; meshopt compression. Keyframe resampling was
  rejected: it gave every channel its own timeline, and the per-accessor JSON
  then outweighed the data (257 KB JSON vs 110 KB of keyframes). Keeping every
  frame lets all channels in a clip share one timeline.
- **City kit:** 153 piece files merged into `city_kit.glb` (shared textures
  and materials stored once: 21 → 15 materials, 29 textures). Textures
  resized (colour 1024 px, normal 512, ORM 512) and **KTX2-compressed**:
  ETC1S for colour, UASTC + Zstandard for normal/ORM data. KTX2 stays
  compressed in GPU memory, unlike PNG/JPG/WebP. Geometry: meshopt +
  quantization.
- **Removed from the kit:** `COLOR_0` and `TEXCOORD_1/2`. These are masks and data for
  Quaternius's custom engine shaders (wear, fake interiors); `COLOR_0`
  rendered as a red tint. **Correction:** `TEXCOORD_1` is *not* a lightmap UV
  set, because it overlaps heavily (e.g. a plain wall maps to a single point).
  Lightmap UVs will be generated for the assembled map at bake time.
- **Runtime:** `GLTFLoader` with `MeshoptDecoder` and `KTX2Loader` (Basis
  transcoder from the three.js CDN). The renderer is created before loading,
  because the KTX2 loader has to know the GPU's supported formats.
- **Tooling:** `package.json` devDependencies (`@gltf-transform/*`,
  `meshoptimizer`, `sharp`, `ktx2-encoder`, a WebAssembly Basis encoder, so
  no system install is needed); `.gitignore` for `node_modules/` and `build/`.
- The kit's glTF export was copied to `fbx/Map/DowntownCity/` (source, 89 MB).

### Verified in Chrome

The kit viewer loads all 153 pieces in about 1 s with correct textures and
no red tint. The character preview shows correct colours and animations
(male and female). In a host/join game: no console errors, 9 draw calls for
the whole scene.

### Notes for later (map + baked lighting)

- The kit viewer draws 153 pieces in 517 draw calls. The real map must merge
  static geometry by material (or use instancing) to keep draw calls low.
- On desktop GPUs, the KTX2 transcoder turns ETC1S colour textures into
  BC7 (8 bits/pixel). If GPU memory gets tight, drop `TEXTURE_SIZE.baseColor`
  to 512 (¼ of the memory).
- Lightmaps: generate UV2 on the merged map in Blender, bake, then compress
  the lightmap (KTX2 UASTC or a half-resolution HDR-ish encoding).

## 13. The Downtown map (2026-10-24)

Approach: "method 3". A script generated the first layout from the Downtown
City kit into an editable Blender file; the user refines it in Blender from
here on.

### Layout (circular, ~100 m across)

| Feature | Details |
|---|---|
| Boundary | Ring of 26 inward-facing 2–3 storey facades (radius ~49.5 m), with a tall invisible collision wall behind |
| Centre building | 16×16 m, 3 storeys, enterable. Doors on all 4 sides, open windows on every floor, a partition wall with a doorway, low brick cover walls. Two switchback staircases (east wall: ground→1st; west wall: 1st→2nd). No roof access (per spec) |
| Quadrant building | L-shaped, 2 storeys, enterable, ~620 m² footprint. Two wings around an enclosed courtyard (planters as cover) in the north-east quarter. 11 doors (street, courtyard, wing ends), interior rooms with doorways, a staircase per wing. The courtyard is also reachable via 2 narrow alleys at the wing ends |
| Houses | 21 random 1–2 storey houses (4–10 m) at random angles (±35°, plus 0/90°), so streets are irregular, from 3 m alleys to wide roads. 3 single-storey houses have outside stairs to a rooftop with low walls. Not enterable |
| Ground | Asphalt streets; raised sidewalks (0.15 m) around every building; manholes/drains; AC units on roofs |
| Spawns | 16, on streets and in the courtyard, at least 9 m apart |

### Pipeline

- `tools/map_generator.py` (Blender): builds `maps/downtown.blend`. Kit
  pieces are linked duplicates parented to one Empty per building. Window
  and door pieces in enterable buildings get "open" variants (glass + fake
  interior removed); each opening is measured by raycasting through the
  piece, and the collision gets a matching hole, so **you can shoot through
  open windows and walk through doors**. Stairs are generated (concrete
  steps visually, a ramp for collision). Refuses to overwrite without
  `--force`. Seed: 7.
- `tools/export_map.py` (Blender) → `build/blender/map_visual.glb`,
  `map_collision.glb`, and `assets/models/map_meta.json` (spawns, play radius).
- `tools/optimize_assets.mjs --map-only` → `assets/models/map.glb`:
  flattened and joined by material, so the **whole map is ~15 draw calls,
  163k triangles, 6.9 MB**, with textures as KTX2 like the kit.
  `map_collision.glb` holds positions only (38 KB).
- `npm run build:map` runs the export and optimisation.

### Physics rewrite (`src/world.js`)

- The old axis-aligned box physics was replaced with a **capsule vs.
  triangle-mesh** controller using **three-mesh-bvh** (CDN, 0.9.16): 1/120 s
  sub-steps (no tunnelling through 0.2 m walls); walkable surfaces
  (normal.y > 0.6) push straight up, so stairs and ramps don't slide; a small
  downward "stick" velocity keeps players on ramps; ceilings stop jumps.
  Curbs (0.15 m) are climbed automatically.
- Bullets: BVH `raycastFirst` against the same collision mesh (host hit
  detection and local tracers).
- Spawns come from the map (`pickSpawn` picks randomly among the 3 furthest
  from living players). The host clamps positions to the circular play radius.

### Verified in Chrome

- Scripted walk on the real collision mesh: street → curb → centre building
  south door → up flight 1 to the 1st floor (y 3.15) → across → up flight 2 to
  the top floor (y 6.15). Jump peak 1.2 m, clean landing.
- Rays: from the top floor, one passes out an open window to the ring (49 m),
  others hit walls; a street ray hits the centre building's wall at the right
  distance.
- Screenshots: street, centre interior (stairs, partition, cover), top floor
  (open windows), courtyard, spawn view.
- Host/join game on the new map: no console errors, joiner spawned on
  ground in the courtyard.

### Known issues / ideas for the Blender pass

- Interior walls use the kit's brick interior; ceilings are dark. Restyle
  if wanted.
- `Brick_Window_Trim_Single` openings are small (0.5 × 1.3 m): shootable,
  not climbable.
- No railings around stair openings on upper floors (you can fall in).
- Houses are solid (not enterable) except the 3 rooftops.
- Collision is separate from visuals: when you move individual walls in
  Blender, move their collision too (moving a whole building's Empty
  handles both).
- Only desktop movement tested via scripts; real mouse/keyboard play-test
  still to do.

## 14. Map v2 from the user's blueprint, and team mode (2026-10-25)

The user drew `maps/blueprint_base_2.png` over the base image; the generator
was rewritten to build exactly that layout (the v1 map is kept in
`maps/downtown_v1.blend`, the v1 generator in git history).

### Layout (point-symmetric: every building has a twin rotated 180°)

| Feature | Details |
|---|---|
| Roads | Cross of 16 m roads (asphalt) with 4 m raised sidewalks; the four blocks between them are raised to sidewalk height (0.15 m) |
| Boundary | No wall. Players are clamped to r = 48.5 m (client physics and host); the game draws a transparent white ring over the ground that fades from clear at the boundary to white 16 m beyond (1 draw call) |
| House08 (centre) | Octagon, 6 m sides (14.5 m across, adjusted from 12 m to fit the 2 m pieces), 5F, enterable, doors NW + SE. Switchback stairwell in the middle (two 2 m lanes, landings at both ends) up to the top floor (12.15 m). Low cover on each floor |
| House01 / House09 | Team bases. West wing 2F, **2nd-floor bridge over the road** (no ground floor; 2.65 m headroom over the road: a 0.5 m slab), east wing 2F, east end 1F, annex 1F. Doors, interior walls with doorways, cover on the bridge. 4 team spawns upstairs in the east wing |
| House02 / House10 | 3F + 2F halves, enterable; switchback stairs to the 3rd floor |
| House05 / House13 | 4F, 8 m square at 45°, enterable; switchback stairs to the top floor |
| House04 / House12 | 1F, 8 m square at 45° (squared off), enterable, 2 doors |
| 03/11, 06/14, 07/15 | Solid 1–2F |
| Cover | 8 chest-high (1.2 m) concrete walls, 4 × 1 m, on the roads |

Roofs are not reachable yet (the user will choose which ones later).

### Generator changes (`tools/map_generator.py`)

- `Building` takes `parts`: per-cell base/top floors, so one building can mix
  1F, 2F and 3F parts and bridges. Walls, corners and parapets are worked
  out per floor; bridges get a concrete underside.
- `twin()` makes the 180° copy with the same random window choices (per-building RNG).
- `Octagon` class for House08.
- Stair rule learned in testing: a flight needs a **free cell in front of
  its bottom** (ramp sides are too tall to step onto), and every flight
  ends with a **1 m flat top step**, so players reach full height even when the
  flight ends at a wall. Tops are exited sideways onto the floor beside them.
- Ground: block/sidewalk polygons are clipped to the circle (Sutherland-Hodgman).
- Empties carry `floors` / `enterable`; spawns carry `team`.
  `export_map.py` writes `teamSpawns` to `map_meta.json`; `make_blueprint.py`
  uses the properties (and colours spawns by team).

Result: 14 draw calls, 140k triangles, 5.9 MB map; collision 76 KB.

### Team mode

- `TEAMS` in `shared.js` (0 Blue, 1 Red). The host puts each joiner on the
  smaller team, spawns them at their team's spawns (`world.teamSpawns`, the one
  furthest from other players), and ignores teammates in hit detection
  (bullets pass through them). Snapshots and `welcome` carry `team`.
- Clients: name labels in team colour, "You are Blue/Red" in the room info,
  team score (sum of kills) at the top centre, scoreboard grouped by team, no
  local hit tracers on teammates.

### Verified in Chrome

- Scripted walks on the collision mesh, through every enterable building:
  octagon to 12.15 m; House05/13 to 9.15 m; House02/10 to 6.15 m; House01/09
  door → stairs → across the bridge → spawn room → down the other stairs →
  out; House04 through both doors; the road under both bridges; the boundary clamp
  (stops at exactly 48.5 m).
- Host + joiner in two tabs: host Blue in the north base, joiner Red in the
  south base, both see the other's team.
- Screenshots: bridge from the road, white fade at the boundary, octagon
  top floor, overview.

### Ideas / known issues

- Roof access: to be specified per building.
- Still no stair railings; sidewalk kerbs show the trim sheet's stripes from above.
- Real mouse/keyboard play-test still to do.

### Variant tried right after (2026-10-25)

To see how it plays, three changes:
1. The 8 road cover walls are **3 m tall** (one storey), no longer chest-high.
2. The white boundary fade was **removed** and the **ring of facades is back**
   (26 segments, r ~49.5 m, tall collision behind). Opposite segments are
   built the same, so the ring is symmetric too.
3. **Enterable buildings have no windows**, only doors (solid buildings still
   have glass windows). Triangles dropped to 105k (the window pieces were the
   detailed ones), 14 draw calls, 5.3 MB.

Re-verified with the scripted walks (all stairs to the top floors, both
bases, House04 doors) and screenshots.

### House08 changes + window rule (2026-10-25)

- **Entrances** (NW, SE): concrete frames 5 m wide × 2.6 m tall, filling
  almost the whole 6 m side (the kit's doors are only 2 m).
- **Roof access**: a 5th flight continues the switchback through the roof
  (15.15 m). The roof has 1 m railings round the opening (open on the arrival
  side), and the parapet now has collision.
- **Windows on the 4th and 5th floors**, all 8 sides: concrete frames with a
  5 m wide opening from a 0.8 m sill up to the ceiling (2.8 m).
- **Window rule** (`WINDOW_SILL` 0.8 m, `WINDOW_MIN_WIDTH` 0.9 m): players
  can't walk over anything above ~0.15 m, and indoors the ceiling caps a
  jump at ~1.0 m, so a 0.8 m sill means "jump through". Kit window
  openings (if used in enterable buildings again) that are too narrow, or
  whose sill is lower, get **player-only collision** (`COLP_*` objects). The
  optimiser tags them with a `PlayerOnly` material and `world.js` builds two
  BVHs: movement uses everything, bullets ignore `PlayerOnly`. (The earlier
  fall-through was kit windows with near-floor sills.)
- Verified: scripted walk to the roof; walking through the entrance 2 m
  off-centre; walking into a 4F window stops at the sill, jumping goes
  through (and drops to the road); the roof railing blocks from the side; a
  ray from the 4F passes out the window to the ring (49 m); a synthetic
  `PlayerOnly` wall stops a player but not a ray. Screenshots of all three.

### House02 / House10 changes (2026-10-25)

- Stairwell moved to the middle rows of the 3F half (rows 7/8), leaving the
  north and south rows free for windows.
- 3rd-floor door (east wall of the 3F half) onto the 2F half's roof; an
  outside stair (4 cells, 0.8 m half-width) along the roof's north edge climbs
  to the 3F roof (gap left in that roof's parapet).
- Wide windows (concrete frames across 2 wall cells, 0.8 m sill to the
  ceiling), as the user specified them **for House10**: 2F half: north on
  both floors and south on the 2nd floor. 3F half: north on the 2nd and 3rd
  floors, south on the 3rd floor. House02 is the 180° twin, so its windows
  are the other way round (in the generator they're written for House02,
  with N and S swapped). Note for future requests: check which twin the
  user's directions refer to.
- Generator: `Building` gained `windows`, per-floor doors `(i, j, side,
  floor)`, `roof_gaps`, optional stair half-width; enterable buildings'
  parapets now have collision (their roofs are walkable). `wall_frame()` is
  shared with House08.
- Verified: scripted route ground → 3rd floor → roof door → 2F roof → roof
  stair → 3F roof (9.15 m), for both twins; walking into each window kind stops at
  the sill, jumping goes through; the parapet stops a walk off the 2F roof.

### House02/10 windows narrower; House05/13 windows + roof (2026-10-25)

- House02/10 wide windows: posts 0.3 → 0.6 m, so the opening is 2.8 m wide
  instead of 3.4 m (height unchanged: anything below the ceiling would stop a
  1.8 m player jumping through).
- House05/13: two medium windows (1-cell frames, 1.5 m openings, in the end
  cells) on every wall except the one facing the ring (local N: NW for
  House05, SE for House13), on the 2nd-4th floors.
- House05/13 roof: a 4th flight continues the switchback through the roof
  (12.15 m); 1 m railings round the roof opening, open at the west end where
  the stairs arrive. Roof tiles are now skipped over stair holes.
- Generator: windows take an optional post width (default 0.6); `railings`
  parameter.
- Verified for both twins: route door → roof; rays show windows exactly on
  floors 2-4 of the three inner walls; the ring-facing wall and the 1st
  floor are solid; window sill stop + jump-through; the railing stops a walk into the
  opening.

### House01 / House09 windows (2026-10-25, directions given for House01)

- West wing, 2nd floor, west wall: 2-cell window (3.4 m opening) with a
  **0.6 m sill** (easy to jump out). Windows can now take their own sill.
- Bridge: 4 medium windows (1.5 m) on each of the north and south walls, at
  x = -9, -3, 3, 9.
- East 2F wing: medium window west on the 1st floor (y 28-30, onto the road
  under the bridge) and south on the 2nd floor (x 20-22, by the stair landing).
- Far east 1F: medium window south (x 30-32).
- Verified on both twins with rays (windows exactly there, walls between),
  sill stop/jump through on the west window, jumping out of a bridge window
  down to the road, and the full base route (door → stairs → bridge → spawn
  room → stairs → out).

### Spawns moved to the ground floor (2026-10-25)

- Team spawns are on the **ground floor** of the base's east wing (same x/y
  as before, clear of the stairs along the south wall).
- Spawns now have a **facing**: the empty's rotation about Z (players face
  its local +Y). `export_map.py` writes `[x, y, z, yaw]`; the host sends `yaw`
  with `welcome`/`respawn`; spawns without one still face the centre. The
  base spawns face the window onto the road under the bridge (west for Blue,
  east for Red), because facing the centre meant staring at the back of the stairs.
- Verified: all 8 spawns settle on the floor (h 0.15) without being pushed;
  host (Red) and joiner (Blue) both spawn downstairs facing the window.

## 15. Lighting: tone mapping + baked lightmap (2026-10-25)

### Step 1: runtime light tune (`src/render.js`)

Neutral tone mapping (exposure 1.15), brighter/warmer hemisphere + sun,
lighter sky and fog (0xb7d6f2, 80-190 m). These dynamic lights now light the
characters and rifle (and the map only when it isn't baked).

### Step 2: baked lightmap

Pipeline (`npm run build:map`, ~1.5 min on an M1 Max; `build:map:fast` skips it):
1. `tools/export_map.py`, in memory (the .blend is untouched): copy every
   Visual mesh into world space, strip extra UVs/colours, join into one
   mesh `Map`.
2. Lightmap UVs: Smart UV Project + `pack_islands`. ~35,000 islands (kit
   pieces split into many), so padding is 1 px (8 px overflowed the 0-1
   square: UVs reached 12 and almost nothing baked); a 4 px bake margin
   fills the gaps. Ground outside the ring at 1/10 resolution. The ground
   was split in the generator into the road cross (`Ground`) and the outside
   annulus (`GroundOuter`), since a 130 m disc mostly hidden under blocks
   wasted the atlas.
3. Cycles DIFFUSE bake (direct + indirect, no colour), 2048², 256 samples,
   sun from the same direction as the game's sun (strength 8, 1.5° soft
   edge) + sky (1.8). **Every face gets one plain grey material for the
   bake**: the kit's materials baked black (side walls 100% zero:
   packed ORM, glass, fake-interior shaders); lighting-only is what a
   lightmap should hold anyway.
4. Post: auto-exposure (98th percentile → 1.9), 3x3 blur against noise
   (stays inside the island margins), +0.16 ambient, stored sRGB-encoded as
   value / 2.5 (`LM_MAX`) → `build/blender/lightmap.png`.
5. `optimize_assets.mjs`: keeps TEXCOORD_1 (needs `prune({keepAttributes})`,
   otherwise it's dropped as unused), drops normal/ORM textures (unused
   unlit), encodes `map_lightmap.ktx2` (UASTC + zstd, mipmaps).
6. Game: `loadMap` loads the KTX2 (sRGB, channel 1); `Renderer.setMap`
   swaps the map's materials for `MeshBasicMaterial` (texture × lightmap ×
   LM_MAX × π; basic divides lightmaps by π).

Result: map 3.4 MB + lightmap 3.6 MB (was 5.3 MB total; the normal/ORM
textures are gone), map 9 draw calls (was 14), ~4-16 MB GPU for the
lightmap depending on the transcode target. Unlit materials are cheaper per
pixel than the old lit ones.

### Known limits / knobs

- Characters aren't affected by the bake (no darkening indoors). Cheap fix
  for later: tint characters by the lightmap value under their feet.
- ~7-8 texels/m: soft shadows. `LM_SIZE = 4096` for sharper (4x GPU memory,
  ~4x bake time).
- Enclosed rooms (e.g. the spawn room) are dim: raise `LM_AMBIENT`, or add
  windows.
- Every layout change needs a re-bake (`npm run build:map`).

### Brighter closed rooms (2026-10-26)

- **Dark lift** (post-process): adds `DARK_LIFT * DARK_KNEE / (light +
  DARK_KNEE)` (0.35, 0.3): the darkest spots gain +0.35, outdoor shade about
  +0.09, sunlit surfaces almost nothing, so rooms brighten without flattening
  the outdoors. `LM_AMBIENT` lowered to 0.08 (the lift does most of the work).
- **More bounce**: bake material grey 0.5 → 0.7 (`BOUNCE_ALBEDO`) and 6
  diffuse bounces (Cycles default 4) carry window light deeper into rooms.
- **Fast re-tone**: a full bake saves the raw result
  (`build/blender/lightmap_raw.npy`, 50 MB, git-ignored). `npm run
  build:lightmap` (`export_map.py --retone` + `optimize_assets.mjs
  --lightmap-only`) redoes exposure/lift/ambient in ~20 s instead of ~1.7 min.
  The raw cache is deleted by `build:map:fast` (it would no longer match the map).
- Verified with screenshots: spawn room, bridge interior and octagon floors
  clearly lit; outdoor sun/shade contrast unchanged.

### Blob shadow stays on the ground (2026-10-26)

The players' blob shadow was a child of the character, so it rose with
jumps. Now `main.js` casts a short ray (10 m) down from each remote player
against the map collision (`groundBelow`) and passes `ground` to
`Character.update`, which keeps the shadow on that surface, fading and
shrinking it with height (gone at 4 m; hidden if nothing is below within
10 m). Verified with a joiner jumping: on the road the feet went 0 → 1.19 m
while the shadow stayed at 0.014 m (opacity 0.28 → 0.20); upstairs in a base it
stayed on the 2nd floor (3.165 m) while the feet reached 4.14 m.

## 16. Ammo and reloading (2026-10-26)

- `MAG_SIZE` 30, `RELOAD_TIME` 2.2 s (`shared.js`); spare magazines are
  unlimited. R reloads; pulling the trigger on an empty magazine reloads,
  and so does firing the last round.
- **Host-authoritative:** each player has `ammo` and `reloadEnd`; shots
  while reloading or empty are ignored; `{t:'reload'}` starts a reload
  (finishes 0.2 s early on the host, `RELOAD_GRACE`, because the client
  started its timer half a round trip earlier); death cancels it, respawn
  refills. Snapshots carry `rl` (reloading) for the animation.
- **Client prediction:** `me.ammo` / `me.reloadEnd` for an instant HUD
  (ammo bottom right, red at 0, "Reloading…" under the crosshair).
- **Third person:** the Mixamo `reload` clip filtered to upper-body tracks,
  sped up to 2.2 s, weighted x12 (the mixer averages by weight, so this makes
  it win over the full-body locomotion on the upper body while legs keep
  running); left-hand IK off during the reload.
- **First person:** the rifle drops a little, tilts up and rolls towards the
  camera, then comes back.
- Dev hook: `window.hackfps.server` (the host's `HostServer`).
- Verified: host accepted exactly 30 of 32 rapid shots, rejected shots
  mid-reload, refilled after 2.2 s; with input events (pointer lock faked;
  automation can't get a real lock): burst 30 → 22 on HUD and host alike, R →
  reloading, no shots during it, back to 30; holding the trigger emptied the
  magazine, auto-reloaded and resumed firing; a joiner's reload played on
  their avatar in the host's view.

## 17. First-person body: your own hands and rifle (2026-10-26)

- The floating view-model rifle is replaced by the local player's own
  `Character` (their skin, from the snapshot), seen from its eyes:
  `Renderer.setViewmodel / updateViewmodel / clearViewmodel`. Same model
  and animations others see: the hands on the rifle, the reload clip (left
  hand to the magazine), the run cycle, recoil and muzzle flash.
- The head bone is scaled to ~0 so it can't block the view; the label and blob
  shadow are hidden. Each frame the body is shifted so a point on the head
  (view-aligned offsets `VIEW_EYE_SIDE` -0.14, `VIEW_EYE_UP` -0.04,
  `VIEW_EYE_FORWARD` 0.18) sits at the camera. Those offsets frame the rifle
  lower right with both arms in view (the rifle clip holds it at the hip,
  centred); tune them in `src/render.js`.
- Drawn in a second pass (`viewScene` with its own lights, depth cleared),
  so arms and rifle never clip into walls. Hidden while dead.
- Local tracers now start at the real muzzle (`Character.muzzleWorld()`).
- The old procedural gun (`buildGun`, reload dip) remains as a fallback
  only when no viewmodel exists.
- Verified with screenshots: idle (both arms on the rifle), mid-reload (left
  arm up to the rifle), looking down/up.

### Reload polish: magazine, hand blend, wrist (2026-10-26)

- **Magazine**: the rifle model has none, so `makeRifle()` adds a dark box
  under the receiver at `MAG_POS` (0, -0.068, -0.16): where the reload clip's
  left palm actually grabs/inserts it, measured in rifle space (the first
  guess, right ahead of the trigger, was ~8 cm behind). During the reload,
  `updateMagazine(progress)`:
  slides into the palm (0.04-0.11 of the clip), held, hidden while the hand
  fetches a new one (0.22-0.36), new one in the palm, slides back in
  (0.49-0.56). It stays a child of the rifle; the in-hand pose is computed
  from the hand's world matrix (palm centre, orientation sampled from the
  clip per gender in `calibrateMagazine`).
- **Hand snap after a reload**: hand IK used to switch on abruptly when the
  reload faded below 30%; now the IK result is slerped with the animated
  pose by `1 - reloadBlend`. Measured: at most 1.0 cm of hand movement per
  frame (120 fps) as it settles, no single-frame jump.
- **Left wrist distortion**: the left hand was twisted ~120° around the
  forearm (right hand ~55°); with no forearm twist bone the skin pinched.
  `relaxWristTwist` moves half the twist into the forearm (the hand's world
  pose is unchanged): now ~64°.
- Testing tip: freeze a reload at an exact point with
  `view.actions.reload.timeScale = 0` and set `.time`.

## 18. Gunfire effects (2026-10-26)

New `src/effects.js` (generated canvas textures, additive blending, no assets):
- **Muzzle flash** (`makeMuzzleFlash`): a head-on star (hot core, glow,
  spikes) plus two crossed flame tongues along the barrel; random size,
  length and roll per shot; blooms and fades over 60 ms (was two flat cards
  switched on/off). Exposes `brightness`, which drives a warm `PointLight` on
  your own arms/rifle in the first-person pass (the world isn't lit by it:
  the baked map is unlit).
- **Tracers** (`Tracers`): camera-facing glowing ribbons (WebGL lines are
  always 1 px), slightly wider with distance so far shots stay visible; the
  tail runs toward the target as it fades (160 ms), so it reads as a bullet.
  Small impact spark where a shot hits.
- **Where tracers start**, three fixes:
  1. `MUZZLE` was 12 cm inside the barrel and 2 cm low; now at the barrel's
     end, (0, 0.028, -0.635): the lower part of the barrel, below the front
     sight (y 0.042 looked like shots left the sight, because in first
     person the tracer climbs toward the crosshair past the top of the barrel).
  2. Other players' tracers started at their *eye* (that's what the host's
     `shot` message carries); now at their rifle's muzzle as drawn
     (`Renderer.remoteShot`).
  3. Our own tracers used last frame's rifle pose; now queued and drawn
     after `updateViewmodel` (`Renderer.localMuzzle()`), and the recoil kick
     is applied only after the tracer is placed: the kick lifts the rifle
     ~5 cm, and the tracer used to start from that lifted muzzle and hang
     above the gun (at the front sight) while the rifle dropped back.
- Verified: tracer start = muzzle within ~5 cm (own and remote); screenshots of the
  flash (frozen: effects only last 60-160 ms) and a remote player's tracer
  from the side.

## 19. Sound effects (2026-10-26)

`src/audio.js`: everything is synthesised with Web Audio when the game
starts (no files to download; recorded CC0 samples can replace any sound by
putting decoded AudioBuffers into `buffers[name]`).
- **Gunshot** (3 variants): high-passed noise crack + low-passed noise body +
  a thump sweeping 155→45 Hz + an echo tail, lightly saturated.
- **Reload**: magazine out (release click + slide), magazine in (thunk +
  clack + latch), bolt back and forward, scheduled at 0.08 / 1.22 / 1.52 /
  1.66 s to match the clip (magazine out at 4%, in at 56% of 2.2 s).
- **Footsteps** (4 variants): thud + grit, heel and toe, on the run cycle's
  foot contacts (phase 0 and 0.5), louder with speed.
- **Landing** (2 variants): heavier thud + gear rattle, louder for longer falls.
- Other players' sounds are positional (`PannerNode`, inverse distance:
  gunshots carry, footsteps fade by ~25 m); distant gunshots are low-passed.
  Ours play unpanned. A compressor on the master output prevents clipping.
- Events come from `Character.onSound` (shot, reload start, foot contact,
  landing judged from the height above `state.ground`), so remote avatars
  and our own first-person body share the logic; `Renderer.onSound` adds the
  position. The listener follows the camera.
- The AudioContext starts on the Host/Join click (browsers require a user
  gesture). **M** toggles mute.
- Verified: all 18 buffers valid (`hackfps.audioDebug()`), context running
  after a real click; with input events, 3 shots → 3 shot sounds, R → one
  reload, 1.5 s run → 5 steps ~0.26 s apart, jump → 1 landing; a driven
  remote avatar produced positioned shot/reload/steps/landing. (Whether
  they *sound* good needs a human ear.)

### Recorded sounds (2026-10-26)

The user supplied one MP3 per sound in `sounds/` (gunshot, reload,
footsteps, landing). `audio.js` loads them when audio starts (`SOUND_FILES`):
mixed to mono (for correct 3D panning), leading silence trimmed (the gunshot
had 80 ms), normalised; each play varies pitch/volume slightly since there's
one file per sound. The reload recording (1.5 s: a click/slide peaking at
0.3 s, a clack peaking at 1.05 s) is split into two parts, each scheduled so
its loudest moment lands on the animation: magazine out ~0.17 s, magazine in
1.23 s (56% of 2.2 s). The synthesised sounds remain as the fallback while
loading or if a file fails (console warning `[audio]`).
Knobs: `VOLUME`, `RANGE` (how far each carries), `PITCH_SPREAD`, the reload
`parts`. Licence/source of the sound files: to be recorded by the user.

## 20. Basics: spawn protection, labels, damage feedback, headshots, spread (2026-10-26)

- **Spawn protection** (`SPAWN_PROTECTION` 3 s, host-enforced): set on join
  and respawn, cleared when the player fires; hits on a protected player do no
  damage (`hit` with `blocked`, grey hit marker). Snapshot flag `sp` → a
  faint pulsing team-coloured shield on the avatar; "Spawn protection 2.4"
  on your HUD.
- **Name labels**: teammates' labels have `depthTest` off (through walls),
  are drawn last (`renderOrder` 999: the map's window glass, sorted as one
  object at the map centre, was covering them) and grow with distance past
  12 m so they stay readable; enemies' labels are hidden by walls
  (`Renderer.setLocalTeam` / `applyLabelRule`). Previously every label showed
  through walls (an accidental wallhack).
- **Damage feedback**: `hit` messages carry the shooter's eye position →
  a red arc around the crosshair pointing at the shooter, kept pointing
  there as you turn, fading over 1.5 s. Death screen "Killed by NAME ·
  headshot / Respawning in 1.4". The killer sees "Eliminated NAME" and a big
  red hit marker; headshot hits show a gold marker; the kill feed notes
  headshots.
- **Headshots**: separate head box (y 1.45-1.82 m, 0.32 m wide) and body box
  (below 1.45 m); `HEAD_DAMAGE` 50 vs `DAMAGE` 25 (2 vs 4 to kill). Boxes don't
  follow the animation (approximate).
- **Movement spread**: `spreadFor(speed, onGround)`: 0.17° still, up to 2° at
  full run, 4° in the air, eased; the shooter applies it (`spreadDir`) and
  sends the direction `d` (the host normalises it); crosshair ticks spread
  with it. Trust model: a modified client could skip spread, like it could
  fake movement.
- Also: the fallback rifle no longer shows while dead.
- Verified with a server-side bot (`server.addPlayer('bot', ...)`): protected
  bot took 0 damage; then body -25, head -50; firing ended the shooter's
  protection; bot shot me from the north while I faced east → arc at -90°
  (left); two headshots → "Killed by Bot · headshot / Respawning in 1.4", feed
  + score; my kill → "Eliminated Bot · headshot", kill marker; respawned bot
  protected 3 s with the shield visible; labels: enemy hidden behind the
  octagon, teammate readable through it; spread 0.17° → 2° running → ~4°
  airborne, crosshair gap 5.7 → 23.7 → 43 px.

## 21. Weapon system + sniper (2026-10-26)

- **`WEAPONS`** (`shared.js`): per-weapon damage/headDamage, cooldown, auto
  vs one-shot-per-click, magSize, reloadTime, spread (still/move/air; and
  `scoped`), zoomFov, scopeTime. Rifle unchanged; sniper: 80 / 200 (headshot
  kills), 1.3 s between shots (bolt), 5 rounds, 3 s reload, 1.7° hip-fire
  spread, 0 scoped and still. `SWITCH_TIME` 0.45 s.
- **Host**: per-player `weapon`, `ammo[]` per weapon, `switchEnd`; messages
  `weapon {w}`, `shoot {w, d, ...}` (ignored if `w` isn't the current weapon:
  fired before the switch arrived); snapshots carry `w`; `shot` carries `w`.
- **Client**: 1 / 2 / Q (last weapon) / mouse wheel; semi-auto weapons fire
  once per click; hold right mouse to scope (FOV 75° → 18° over 0.22 s, mouse
  sensitivity scaled by FOV, arms/gun hidden, CSS scope overlay; not while
  reloading, switching or for 0.9 s after a sniper shot = working the bolt);
  HUD shows weapon slots and per-weapon ammo.
- **Sniper model**: `convert_assets.py build_sniper()` keeps its skeleton
  (Magazine, Handle = bolt). Gotchas fixed on the way: object transforms
  didn't survive the glTF export, armature transforms must be applied in
  object mode (edit mode overwrites them on exit), the FBX keys the armature
  object (clear `animation_data`) and the pose must be refreshed
  (`view_layer.update()`) before export. `npm run build:guns` (Blender
  `-- --guns` + optimiser `--guns`); 27 KB.
- **Character**: `setWeapon(id)` swaps the gun (per-gun points in `GUNS`:
  leftGrip, muzzle, magGrab, boltAxis; measured from the model). Same holding
  animations for both. Sniper **procedural reload**: the left hand follows
  keyframed points (grip → magazine → pulled down → left-hip pouch → back →
  insert → grip) via the existing two-bone IK, the gun tilts, the Magazine
  bone follows the palm (hidden while the hand fetches a new one), then the
  bolt is worked. **Bolt**: the Handle bone turns ~70° about the bore, slides
  back 5 cm and returns, 0.15 s after each shot over 0.75 s.
- **Audio**: sniper shot = the recorded gunshot at 0.78 pitch, louder,
  carrying further, + synthesised bolt back/forward; reload timings per
  weapon (`RELOAD_TIMING`).
- Verified: switching (client, host, HUD), sniper first person, scope (FOV 18,
  overlay, arms hidden), shot → ammo 4/5 both sides; bolt handle moves (1.2
  rad, 3.4 cm); procedural reload frames from both sides (magazine out in
  the hand, hand at the hip pouch, inserting) with IK hitting every target
  (< 3 mm); host: sniper body 100→20, shot inside the bolt cycle ignored,
  headshot kills, rifle shot during the draw ignored, wrong-weapon shot
  ignored; rifle reload still the clip version; both weapons reload
  independently; preview page fine.
- Not done: scope glint for other players; picture-in-picture scope (would
  need a second render).

## 22. Pistol (2026-10-26)

Mixamo pistol clips from the user (`fbx/Character Animation/Pistol`: Idle,
Run Forward/Backward, Strafe Left/Right, Firing, Jump, Death = the rifle's).
- **Conversion** (`convert_assets.py`, `PISTOL_CLIPS` → `pistol_*` clips in
  `anims_*.glb`): the single **Jump** clip is split by frame range into
  `pistol_jump_up` (1-8), `pistol_jump_loop` (8-10, the apex) and
  `pistol_jump_down` (17-25) with the hips' vertical movement removed
  (`retarget(frames=, lock_height=)`; the physics moves the body).
  `npm run build:anims` = animations + guns, without the characters.
- **Model**: `Pistol.fbx` keeps its skeleton (Slide, Magazine, Trigger);
  modelled along +X, so `build_skinned_gun(..., turn)` rotates it. 0.21 m,
  23 KB.
- **Weapon**: 30 / 75 damage (4 body / 2 head to kill), one shot per click,
  0.2 s, 12 rounds, 1.6 s reload, spread 0.23° still / 1° moving / 2.9° air;
  key 3. Shot sound: the recorded gunshot at 1.3 pitch, quieter, shorter range.
- **Animation sets** (`SETS`): the rifle set (long guns) and the pistol set;
  `pistolBlend` cross-fades them on switching; the grip is calibrated per set
  from that set's idle (`gripOffsets[gender][set]`, per-gun `rightGrip`).
- **Run-firing (made)**: the pistol Firing clip on the upper body only
  (`pistol_fire`, weight 12), restarted each shot and held 0.5 s: adds the
  kick standing, and raises the arms into the firing pose while running.
- **Reload / run-reload (made, procedural)**: the sniper's reload code became
  generic (`GUNS[id].reload`: path, magOld/magNew, down, tilt, bolt or
  rack). Pistol path: magazine out of the grip, hip pouch, new magazine in,
  then the left hand racks the slide (Slide bone back 3 cm with the hand,
  released). Upper body only, so it's the same while running.
- **Slide** kicks back 3 cm and returns over 0.09 s with every shot.
- First person: per-style camera offsets (`VIEW_EYE.rifle / pistol`, blended).
- Verified: switching (HUD `[3] Pistol 12/12`), third-person stance
  (two-handed, level), jogging vs jogging + firing, reload frames (magazine
  out 20%, hand at the pouch 41%, slide racked 86% = 2.6 cm), host: body −30,
  shot inside 0.2 s ignored, headshot −75; per-weapon ammo across all three
  on client and host; no console errors.

## 23. All six guns: revolver, P90, shotgun; keys 1-6 (2026-10-26)

- **Order = keys = network index**: 1 pistol, 2 revolver, 3 rifle, 4 P90,
  5 shotgun, 6 sniper (`WEAPONS`); everyone spawns with the rifle
  (`DEFAULT_WEAPON`). Nothing indexes weapons by number any more
  (`weaponIndex(id)`).
- **Models** (`build_skinned_gun`): revolver 0.3 m (Drum, Hammer, Trigger,
  and a speedloader `Quick` + `Bullets_1` parked beside the gun), P90 0.52 m
  (Magazine on top; its materials are just Material.00x, renamed to
  P90Body/Metal/Mag for colours), shotgun 1.0 m (`Reload` = the pump,
  `Bullet` = a shell).
- **Stats**: revolver 55/110, 0.5 s, 6, 2.4 s; P90 17/34 automatic 0.075 s,
  50, 2.5 s; shotgun 8 pellets × 13/20 in a 4° cone (+ movement spread),
  damage falling from 8 m to 30% at 30 m (`shotDamage`), pumped 0.9 s, 6,
  2.6 s (full reload).
- **Pellets**: the shooter sends `ds` (one direction per pellet; the host
  rejects the wrong count), the host traces each, adds damage per victim
  (`applyHit`), broadcasts one `shot` with `es` (all ends); every pellet
  draws a tracer.
- **Procedural reloads** generalised: per gun, `part` (+`partAlso`) bones
  held in the hand in `held` windows, `hidden` windows, `hideOutside`
  (shown only in the hand), `slide` (magazines slide out/in), `extra`
  named points. Revolver: drum swings out 3 cm, gun tips up (empties out),
  speedloader from the hip into the drum, drum closes. P90: magazine lifted up
  and back off the top, new one on. Shotgun: four hip → loading-port trips
  with a shell in the hand, then the pump. **Shotgun pump** after every shot
  (`Reload` bone 8 cm back; the left hand rides on it).
- **Sounds**: per-weapon shot table (`SHOTS`: pitch, loudness, range, bolt /
  pump sounds after) and reload timings.
- Verified: keys 1-6 switch (client, host, HUD, ammo 12/6/30/50/6/5); the
  three new guns held correctly in third person; reload mechanics measured
  frozen (revolver drum 3 cm, speedloader at the hip pouch and at the drum,
  P90 magazine 13-16 cm off, shotgun shell in hand / pump 8 cm; IK within
  2 cm); shotgun damage averages 100 at 4 m, 53 at 10 m, 39 at 15 m, 2 at
  28 m; wrong pellet count rejected.

## 24. Shooting animation fixes (2026-10-27)

- **Pistol firing bent the character over and yanked the hands back**: the
  upper-body overlay used the Mixamo pistol Firing clip, which itself leans
  the torso, drops the hands and has a big recoil. The overlay is now the
  pistol idle's upright two-handed aim (held 0.5 s after a shot, fading),
  for the pistol and revolver; the kick is the small procedural one.
- **Gun tipped up when moving backward** (all guns): the gun followed the
  right hand's angle in each clip, and the run-backward clips tip the hand
  back. `aimGun` now turns the gun about its grip so it points exactly along
  the view (yaw, pitch + recoil); reload tilts / bolt stay on top; fades
  with death; skipped while the rifle's reload clip turns the rifle.
- Verified on a bot: gun vs aim direction 0.0° still / running backward,
  firing or not, pistol and rifle; pistol hands move 3 cm when firing
  (was a big pull-back); torso upright while firing.
- **Follow-up: hands drifted left (pistol run-firing) and guns dropped when
  moving backward.** The upright aim overlay only sets the upper body's
  rotations, which over the running hips turned the arms to the left; the
  run-backward clips hold the hands lower. `holdGun`: right-arm two-bone IK
  holds the gun's grip where each set's idle stance holds it (`gripRest`,
  measured with the grip calibration), turned up/down with the aim about the
  right shoulder; blended with pistol/rifle, off when dead or during the
  rifle's reload clip. Then `aimGun` points the gun. Measured: grip height and
  side within 2 mm standing / forward / backward / strafing, firing or not
  (pistol 141 cm, 4 cm right; rifle and shotgun 134 cm, 14.5 cm right).
  Side effect: the running clips no longer bob the gun.
- **Follow-up 2: the gun shifted on the body with movement direction.**
  Pinned to the character root, but the clips move the chest (up to 7 cm
  lower, 9 cm forward, 25° twist depending on direction), so the gun slid
  around the body. `holdGun` now keeps the idle-stance grip relative to the
  chest: follows the chest's position (sampled after the clips, before the
  aim bends the spine) fully and its twist half (`CHEST_TWIST_FOLLOW`).
  Measured grip-from-chest: height and depth within 1-3 cm in all
  directions; side 11-18 cm (rifle, from the half twist); pistol 7-9 cm.

## 25. Spawn with the pistol; faster semi-automatics (2026-10-27)

- `DEFAULT_WEAPON` = pistol (Q's "last weapon" starts as the rifle).
- Cooldowns: pistol 0.2 → 0.15 s, revolver 0.5 → 0.35, shotgun 0.9 → 0.65,
  sniper 1.3 → 1.0. To fit: sniper bolt 0.6 s (+0.15 delay; scope blocked
  0.75 s), shotgun pump 0.42 s (+0.12), their bolt / pump sounds earlier.

## 26. Revolver parts; House02/10 stairs (2026-10-27)

- **Revolver speedloader floating beside the gun**: the model weights every
  part half to the root bone (`Control`) and half to its own bone, so
  hiding the speedloader (bone scaled to zero) left a half-size copy, and the
  drum only swung half as far. `rigid_parts` (convert_assets.py) makes each
  vertex follow only its part when the part's weight is at least the root's
  (applied to all skinned guns; the others had a few such vertices too).
  The speedloader now only shows in the hand during the reload.
- **House02/10 ground-floor stair** moved from the middle row (it rose right
  behind the south door) to the north wall (row 9, half width 0.75 to clear
  the wall), then the same switchback in row 8 (twin: mirrored).
- **Stairs poking out of outside walls**: flights ran to the building
  outline, but the wall slab is `WALL_T` (0.2 m) inside it. A flight ending
  at an outside wall now stops at the wall's inner face (all buildings).

## 27. Accuracy order (2026-10-27)

Spread (cone half-angle, radians; standing / running / in the air), most to
least accurate: sniper 0.001 / 0.015 / 0.04 (scoped 0 / 0.008 / 0.04; was
0.03 unscoped, i.e. only accurate scoped), revolver 0.002 / 0.02 / 0.045,
pistol = rifle 0.01 / 0.03 / 0.07 (the P90's old values), P90 0.014 / 0.04 /
0.08, shotgun unchanged (0 / 0.02 / 0.05 plus its 0.07 pellet cone). At 30 m
standing: sniper within 3 cm, revolver 6 cm, pistol / rifle 30 cm, P90 42 cm.

## 28. Weapon switching for "Admin" only (2026-10-27)

- Keys 1-6, Q and the mouse wheel switch weapon only for the player whose
  name (as the host registered it) is exactly `Admin` (`ADMIN_NAME`,
  `isAdmin()`, main.js); everyone else keeps the spawn weapon (pistol).
  Client-side only, and anyone can type the name "Admin".

## 29. Weapon pickups (2026-10-27)

- `PICKUP_SPOTS` (shared.js, game coordinates incl. floor height, checked
  with collision raycasts: >= 1.4 m from walls): House04 / House12 centre,
  east / west road ends (x = +-45), House08 5th floor x4 (point-symmetric).
- Host-authoritative (`updatePickups` in the tick): a spot holds a weapon
  index or -1; a living player within `PICKUP_RADIUS` (1 m, horizontal;
  1.2 m vertically) holding a different weapon gets it (`giveWeapon`: switch
  time, reload cancelled, full magazine) and a `pickup` message; the spot
  refills after `PICKUP_RESPAWN` (20 s) with `randomPickupWeapon()` (any but
  the pistol). Same weapon: not taken (spare ammo is unlimited anyway).
  Spot contents ride along in snapshots (`pk`). Respawn resets the weapon to
  the pistol (`respawn` carries `w`).
- The host now also rejects `weapon` messages from anyone not named
  `ADMIN_NAME` (moved to shared.js). Non-admin HUD shows just the weapon name.
- Client: white ring (RingGeometry 0.84-1.0 m, unlit, polygon offset) per
  spot; the weapon floats 1 m up, spinning and bobbing, scaled up (x2.2
  handguns, x1.4 long guns); reload-only parts hidden. Pickup feed line and a
  bolt clack sound.
- **Countdown**: while a spot is empty, a white number (seconds until the
  next weapon, counting down) floats where the weapon would be. Snapshots
  carry `pt` (seconds left per spot, from the host's clock, so client clocks
  don't matter); the client counts down locally between snapshots. Canvas
  sprite, redrawn only when the number changes.

## 30. Heal packs; two more weapon spots (2026-10-27)

- Weapon spots +2: House03 / House11 roofs (10 total). Random weapon still
  never the pistol (checked: 5000 rolls, all five others ~equally).
- `HEAL_SPOTS` (8): House05 / House13 4th floor (rows 0-1, clear of the
  stairs), House07 / House15 roofs, House01's north annex / House09's south
  annex (ground floor), House08 roof (x = +-4.5, beside the stair opening).
  All checked with raycasts: flat, >= 1.8 m from walls.
- Host pickups list = weapon spots then heal spots (`item`: weapon index /
  1, -1 = empty); a heal pack is only taken by a hurt player: hp to MAX_HP,
  `heal` message (green screen-edge flash, "Healed", clack), refills after
  `HEAL_RESPAWN` (20 s) with the countdown.
- Client: green ring; a white box with red crosses (canvas texture, shared
  geometry/material) spinning above it.

## 31. Billboards on House07/15; bridge weapon spots (2026-10-27)

- Billboards (map_generator.py `build_props`, `BILLBOARD_ROOFS`): on House07 /
  House15's roofs, 1.8 m from the heal pack towards House08 (building-local
  -Y; the twin matches): two posts + a 4.4 x 3.1 m panel from 0.3 m up, with
  collision (blocks players and bullets). Checked with rays from House08's
  4F / 5F windows and its roof to a player's chest and head (+-0.6 m) on the
  heal pack: all blocked, both houses. Panel uses MI_Trim_Green (shows as a
  cream trim band), frame MI_Trim_Dark.
- AC units on solid roofs keep 2.5 m from roof pickup spots (`ROOF_SPOTS`).
- Weapon spots +2: middle of the House01 / House09 bridges (2nd floor,
  y 3.15): 12 weapon spots.

## 32. Money and the buy menu (2026-10-27)

- `WEAPONS[].price` (pistol 0, revolver 250, P90 / shotgun 400, rifle 500,
  sniper 650), `SURVIVAL_RATE` ($3 per second alive, paid on death),
  `KILL_REWARD` ($150). Host-owned (`player.money`), sent in snapshots (`m`)
  for the scoreboard's Money column and the HUD.
- Spawning goes through the buy menu: players join dead (`joining`), get
  `buy` {money, wait, earned?, alive?}; after a kill the victim gets `buy`
  (wait = RESPAWN_TIME), the killer `earn`. The client's Start sends
  `spawn` {w}; the host stores `spawnWeapon` (rejected if unaffordable) and
  the tick spawns them once `respawnAt` passes, charging the price then;
  `respawn` carries the weapon and money. No more automatic respawn.
- Players in the menu (joining, or dead longer than RESPAWN_TIME) are
  flagged `gone` in snapshots and not drawn.
- Menu: radio list (name, price; unaffordable greyed / disabled), last
  choice remembered (falls back to the pistol), "Start in x.x" countdown,
  releases the mouse while open; Start re-locks it.
- **Fix: buy menu had no mouse pointer on joining.** Host / Join locked the
  pointer (`enterGame`) right after the host's own `buy` message had opened
  the menu, so the camera turned and there was no cursor. Now nothing locks
  the pointer until Start; while the menu is open (before Start) any lock
  is released and mouse look / firing are ignored.

## 33. Hacks (2026-10-28)

The game's core: one hack per life (since section 38: any number), bought in the buy menu next to the
weapon (both paid for), active until death. `HACKS` in shared.js (index =
network number): none, map 300, speed 400, recoil 400, ammo 500, wall 600,
fly 700, noclip 800, aim 900, hp 1200, victory 10000.

- **Host**: `spawn` {w, h}; both prices charged at the spawn; `hack`,
  `maxHp` (HP hack: `HACK_HP` 9999) set then, cleared on death. Heal packs
  heal `HEAL_AMOUNT` (100) up to maxHp, only if hurt. Infinite ammo: shots
  don't use ammo, reloads refused, `fireCooldown()` halves the shotgun and
  sniper cooldown (`FAST_CYCLE`). Snapshots are per team (`sendSnapshots`):
  `h` (hack) only on that team's players, so enemies' hacks stay secret
  (scoreboard Hack column: teammates and us).
- **Victory**: buying it ends the round (`victory`): everyone out of the
  world, `victory` message, 10 s (`VICTORY_SCREEN`), then `newRound`: money,
  kills, hacks reset, pickups refilled, everyone gets `buy` {round: true}.
- **Movement** (world.js `stepPlayer` input): `speed` multiplier
  (`SPEED_HACK` 1.8); `fly` (-1..1 from Q / E: vertical speed `FLY_SPEED` 6,
  no gravity, hovers, capped at `FLY_MAX_Y` 20 m, normal collision);
  `noclip` (`substepNoclip`: no wall / ceiling collision; floors from a
  downward ray up to 0.5 m above the feet (stairs), following floors down
  while grounded; gravity; `keepInside` boundary). Movement is client-side
  and trusted, like before.
- **Recoil**: spread x `RECOIL_HACK` (0.15); flying counts as on the ground
  for spread; speed hack doesn't add movement spread beyond normal running.
- **Aim** (main.js `aimLock`, Alt held): nearest enemy head (headAABB
  centre of the drawn avatar) by angle from the view, on screen, with a
  clear line (world raycast); sets yaw / pitch exactly.
- **Wall** (render.js `renderWallHack`): avatars' skinned meshes on layer
  1 / 2 by team; extra passes with an override material (team colour, 38%,
  no depth test) and an `xrayScene` of hitbox edge boxes (headAABB /
  bodyAABB); scene background / fog hidden for those passes so nothing is
  cleared.
- **Map** (minimap.js): 220 px canvas lower left, north-up, 30 fps; the
  background is a 160x160 height raycast of the collision map (made once);
  pickup dots (white / green) or their countdown when empty; players as team
  dots, us as an arrow. HP / money / hack name moved to the right.
- **Infinite ammo visuals**: `fast` state halves the bolt / pump animation
  and sound timings (us and teammates; enemies' hacks are unknown).
- Q no longer switches weapons (Admin: number keys / wheel).
- Verified in the browser: speed 12.6 vs 7.0 m/s; fly 6 m/s, ceiling 20 m,
  hover, landing, boundary 48.5; no-clip through solid House03 at floor
  height (normally stopped at its wall); HP 9999, -5000, heal +100; sniper
  7 shots in 3 s, ammo unchanged, reload refused, HUD "∞"; spread 0.0015
  vs 0.0100; teammate hack shown / enemy hidden; wall hack silhouette and
  hitboxes through House02's wall; aim lock 0.000° off the head and a host
  headshot, none behind a cover wall or without the hack; minimap; victory
  screen, new round with $0 / 0 kills / pickups refilled.
- (Testing) the player named `Admin` starts with `ADMIN_MONEY` ($999,999)
  on joining and at every new round (`startMoney` in host.js).
- Retuned (2026-10-28): speed hack 1.8 -> 2.5x (`SPEED_HACK`); fly hack
  moves 1.3x faster (`FLY_HACK_SPEED`) with its ceiling at 25 m
  (`FLY_MAX_Y`); HP hack 9999 -> 1500 HP (`HACK_HP`), $1,200 -> $800 (listed
  after no-clip). Measured: 7.0 / 17.5 / 9.1 m in 1 s (none / speed / fly),
  fly stops at 25.0 m, HP hack 1500.
- Speed hack 2.5 -> 3.0x (2026-10-28).
- Speed hack also jumps 2.5x higher, 1.2 -> 3.1 m (`SPEED_HACK_JUMP`, a
  height multiplier: the input's `jumpHeight`, jump speed x sqrt) (2026-11-05).

## 34. Money spots (2026-10-28)

- The House03 / House11 roof weapon spots and the House07 / House15 roof heal
  spots became money spots (`MONEY_SPOTS`, $800 `MONEY_AMOUNT`, 20 s
  `MONEY_RESPAWN`): 10 weapon, 6 heal, 4 money spots. Anyone alive takes
  money (no condition). `cash` message: yellow screen-edge flash, "+$800".
- Spots are now one list with kinds, `ALL_SPOTS` (weapon, heal, money; the
  order host and clients share). Host pickups carry `kind` (`refill(kind)`);
  renderer rings white / green / yellow, a gold "$" coin (canvas texture on
  a cylinder) over money spots; minimap dots in the same colours.
- Fixed while at it: a spot's refill time mixed `+` and `??` without
  brackets (weapon spots would have got NaN).
- Money spot amount $800 -> $1,000 (2026-10-28).
- Default HP 100 -> 200 (`MAX_HP`, 2026-10-28): rifle 8 body / 4 head shots, sniper 3 body / 1 head; heal packs still +100.
- Rewards up with the HP (2026-10-28): survival $3 -> $4 per second, kill $150 -> $250.
- Controls help moved from the host / join menu to the bottom of the buy menu, trimmed to: WASD, Space, mouse, click, R, M, Tab, Esc (fly / aim keys are in the hack descriptions; the scope is intuitive; Admin keys omitted). README keeps the full list. (2026-10-28)

## 35. Horizon: no visible map edge (2026-10-28)

The ground used to end ~5 m past the facade ring (at ~55 m) with flat sky
colour behind it; the fog only started at 80 m. Now (render.js
`buildHorizon`, runtime only: no map rebuild / re-bake):
- **Gradient sky**: a dome (r 150, follows the camera, drawn first with no
  depth) from `HORIZON` (#c9dcec, also the fog colour) at and below the
  horizon to `ZENITH` (#6f9fd8) overhead; tone-mapped in its shader like the
  fogged scene so they meet without a seam.
- **Ground**: an unlit asphalt ring from 52 to 320 m, just under the map's.
- **Skyline**: 3 rings of plain towers (r ~80 / 115 / 155 m, taller further
  out, point-symmetric, seeded), one InstancedMesh, unlit flat colours
  pre-hazed towards `HORIZON` with distance, then fogged.
- Fog 70-185 m (was 80-190; camera far plane 200), so everything is fully
  haze before the far plane. No measurable frame-time change (8.3 ms median).
- **Boundary as blocks** (map_generator.py `build_ring`): the inward-facing
  kit facades (2-3 storeys) replaced by plain blocks in the skyline's style:
  each 12 m segment is 2-3 blocks (7-15 m tall, 5-11 m deep) built
  OUTWARD from the ring line (where the facades stood; `rot_for_normal`
  puts local +y away from the centre), a taller 3.2 m block just outside
  each joint. (First version had the sign wrong: blocks reached up to 11 m
  into the arena, covering the road-end weapon spots and cutting into
  buildings. Checked now: closest block vertex 49.4 m from the centre, play
  radius 48.5; road-end spots 4.4 m clear and picked up by walking in.)
  three flat materials (`plain_material`: grey / warm / dark; dark-ish base
  colours because the unlit map multiplies them by the bright lightmap: the
  first try at ~0.3 linear rendered almost white). Point-symmetric like
  before. Map 107k -> 49k triangles, 3.4 -> 1.9 MB; 9 -> 12 draw calls.
- Boundary blocks lightened to sit with the skyline (base colours ~0.13-0.21 linear, bluish grey). (2026-10-28)

## 36. Invite links; removing players who quit (2026-10-28)

- **Room code in the URL**: hosting or joining sets `?room=CODE`
  (`history.replaceState`); opening such a link fills in the join code
  ("Invited to room …"). The host leaving clears it (the room is gone).
- **Quitting players stayed in the game**: WebRTC often doesn't report a
  closed tab / crash / lost connection, so the host never removed them.
  Now: clients send `ping` every second (a Web Worker timer, so background
  tabs keep it up; also from the buy menu, when no `state` is sent); the
  host stamps `lastSeen` on any message and drops players silent for
  `PLAYER_TIMEOUT` (6 s). On `pagehide` the client leaves on purpose and
  sends `bye` (removed at once). Clients leave ("Lost connection to host")
  when the host has been silent for `HOST_TIMEOUT` (8 s).
- `removePlayer` forgets the player before closing their connections
  (closing fires 'close', which called it again: "left" was announced twice).
- Verified with two tabs: invite link pre-fills and joins; closing the
  joiner's tab removed them within 1.5 s (one "left" message); a silent
  player was dropped after 6.1 s.

## 37. Bots (AI players) (2026-10-29)

- Host-only setting in the buy menu: "Bots (AI players): fill teams to
  Off / 1 vs 1 … 4 vs 4" (`localStorage` `hackfps.bots`; message
  `{t:'bots', n}` accepted from the host only). `BotManager.balance` adds or
  removes one bot per tick so each team has `fill` players; people count
  first (`pickTeam` now picks the team with fewer *people*, then fewer
  players), so a joiner replaces a bot. Bots are named `[BOT] Alex` and so on,
  ids `bot-N`. They have no connection: `sendTo` hands their messages to
  `Bot.onMessage`, and they act through `onSpawn` / `onShoot` / `onReload`,
  so damage, money, pickups and victory work as for people. They're exempt
  from the heartbeat timeout.
- **Navigation** (`nav-worker.js`): a 0.5 m grid. Each column is
  raycast down (all hits) for upward-facing floors with headroom, and each
  floor is kept if a 0.42 m capsule fits. Edges go to the 8 neighbours:
  walk if the step up is at most 0.4 m and the midpoint fits; a drop of up
  to 3.5 m is one-way, with open air checked. Only the largest connected
  area is kept: 39k nodes, 33.6k usable, 285k edges. The graph is built
  in a module worker (CDN URLs, since workers have no import map) in
  about 1.8 s; on the main thread it took 6 s and froze the host.
  `nav.js` does A* with a binary heap: 0–30 ms across the map, and one
  search per host tick.
  - Bug found: storing `g` in a Float32Array made A* reopen nodes forever,
    because rounding up made the same path look cheaper. It now uses Float64.
  - Bug found: the one-way edge direction was inverted, so bots tried to
    drop *up* onto the landing.
  - Bug found: a waypoint counted as reached when the floor above was
    within 0.6 m horizontally, which made bots walk down the stairs again.
    It now needs a height difference under 0.5 m.
- **Brain** ("normal"):
  - Perception every 0.1 s: enemies within 70 m that are in a 150° view
    cone (all around within 6 m, or the one that hit them), with a line of
    sight to the head or chest, and not spawn-protected.
  - Reaction time 0.3–0.55 s.
  - Aim turns at up to 7 rad/s. The aim error starts at 0.05–0.11 rad and
    settles by 1/e every 0.6 s down to a jitter. 20% of engagements aim at
    the head.
  - Shots: semi-auto weapons add 0.08–0.22 s between shots; automatic
    weapons fire in bursts beyond 15 m. Weapon spread is applied the same
    way as for people.
  - Fights: strafe, close in or back off to a per-weapon range, and never
    step off a ledge (`safeStep` checks the graph).
  - Goals: a heal spot when below 50% HP, a weapon spot while holding the
    pistol, sometimes money, otherwise somewhere near a random enemy or a
    random node. A lost enemy is chased to where it was last seen (4 s).
  - When stuck: jump, then pick a new goal.
  - Buying: one of the 3 most expensive weapons they can afford (15% of
    the time the pistol), and never a hack.
- Measured with 7 bots: 0.35 ms per host tick on average.
  - Bots crossed the map, climbed House08 to the 3rd floor, took weapon
    spots and fought: 8 kills in 25 s.
  - A fake joiner replaced a bot, which came back when the joiner timed out.
  - Off removes all the bots.
  - No console errors.

## 38. Several hacks at once (2026-10-29)

- Replaces "one hack per life": the buy menu's hack column is checkboxes
  (heading "Hacks (any number)"), and the total is the weapon plus every
  ticked hack.
  - An unticked option is locked when it doesn't fit in the money left.
    Ticked ones can always be unticked.
  - Last life's picks are kept if they're affordable. If not, the priciest
    hacks are dropped first.
- **Data:** a player's hacks are a bit mask: bit i is `HACKS[i]`, and 0 means
  none. The `'none'` entry was removed from `HACKS`.
  - New helpers in `shared.js`: `hasHack(mask, id)`, `hackList`, `hacksPrice`,
    `hackBit` and `ALL_HACKS`. These replace `hackId` and `hackIndex`.
  - The mask is sent in `spawn.h`, `respawn.h` and the snapshot `h`, which
    teammates only receive, as before.
  - The host validates `0 <= h <= ALL_HACKS` and charges `hacksPrice`.
  - Victory in the mask still ends the round at spawn.
- **Combinations:**
  - Speed + fly moves at 3x (the speed hack wins over the fly hack's 1.3x).
  - Fly + no-clip: `substepNoclip(player, h, flying)` turns gravity off and
    caps the height at `FLY_MAX_Y`. You fly up through ceilings and land on
    floors when descending. Tested at House08: up to 18.2 m, then down onto
    the 15 m roof. Fly alone is still stopped by the ceiling.
- HUD lists every active hack ("Map hack · Speed hack · …"); the scoreboard's
  "Hacks" column lists teammates' as "Map, Speed, Wall, …".
- Verified as Admin with map + speed + wall + fly + HP:
  - Charged $2,800, max HP 1500.
  - The minimap and the wall hack were both on.
  - The HUD and scoreboard listed all five.

## 39. Aim hack leads moving targets (2026-10-29)

- **Why it missed moving targets:** other players are drawn `INTERP_DELAY`
  (100 ms) in the past. The shot then reaches the host half a round trip
  later, and the host checks it against where the target is at that moment.
  A target running at 7 m/s was about 0.6–1 m ahead of the head the hack
  locked onto. The head hitbox is 0.32 m wide.
- **Fix:**
  - `aimLock` aims at the drawn head plus the target's velocity ×
    (`INTERP_DELAY` + `rtt`).
  - `velocityOf(id)` takes the latest snapshot against the one two before it
    (about 100 ms apart, less jitter). It is zeroed above 30 m/s, which means
    a respawn.
  - Vertical velocity is included, for jumps and falls.
- **RTT:** the heartbeat `ping` now carries `at`; the host answers
  `{t:'pong', at}`, and the client keeps a smoothed `rtt` (0 for the host's
  own client, which gets snapshots directly).
- **Measured on the host, with moving bots over 15 s (2,482 samples):** the
  distance from the aim point to the target's real position on the host fell
  from 0.59 m to 0.10 m on average.
  - The maximum is still about 0.7 m, at the moment a target reverses
    direction.
  - A joining tab measured an RTT of 1.1 ms (same machine).

## 40. Money rewards doubled (2026-10-29)

- `SURVIVAL_RATE` 4 -> 8 dollars per second alive, `KILL_REWARD` 250 -> 500.

## 41. Toy-town look; solid roof parapets (2026-10-29)

Aiming for a look like Party Animals: bright, saturated, clean colours,
soft warm light, rounded edges. The user picked options 1–4 of the
suggestions (repaint, lighting, bevels, character shading). Post-processing,
"juice" and new characters were not done.

- **Guardrail bug:**
  - The roof parapets were the kit's `Brick_Plain_1` / `Metal_Plain_1`:
    two vertical sheets 0.2 m apart with no top face.
  - They only had collision on enterable buildings or ones with roof stairs.
    Walking off the House03/11 roofs (money spots) dropped you to the street,
    and the same happened on House07/15 except where the billboard blocks.
  - Now `parapet()` generates them: a solid 0.2 m wall plus a capping that
    overhangs 0.05 m (top at `PARAPET_H` 1.05 m), with collision on every
    building, House08 included.
  - Cell edges in a straight line are merged into one run per edge, which
    means no 2 m grooves and fewer triangles.
  - Verified: walking off any roof is blocked in all 8 directions. Jumping
    over (about 1.22 m) is still possible, as before.
- **Repaint** (`export_map.py` `paint()`): every face of the merged map gets a
  `Col` colour attribute, exported as `COLOR_0`. `optimize_assets.mjs` now
  keeps the map's COLOR_0.
  - The role is decided per face:
    - Kit faces are classified by their own base-colour texture at the face's
      UV centre (64×64 downsampled): luminance below 0.22 means accent,
      saturation below 0.13 means trim, anything else is wall.
    - Generated geometry and ground objects are classified by material and
      object name: roof (`MI_Asphalt` on a building), glass, interior walls,
      floors and ceilings, road, sidewalk, cover (`#ffc46b`), billboard, and
      the ring blocks.
  - `BUILDING_PALETTE` holds wall / accent / roof per building. Twins share
    colours, except the team bases: House01 is blue (`#7fb0ff`) and House09
    is red (`#ff8a7a`).
  - Wall pieces vary by ±1.5% (4% looked patchy).
  - The whole map is now one `MapPaint` material: 12 draw calls down to 1,
    and no textures.
  - `render.js` `setMap` uses `vertexColors` (no map) when the geometry has
    colours.
- **Bevels** (`MeshBuilder(bevel)`, `bmesh.ops.bevel`, at most 40% of the
  thinnest side):
  - `BEVEL` 0.05 m on generated building and billboard boxes, 0.12 m on the
    road cover walls, and 0.25 m with a single segment on the boundary blocks.
  - None on stair steps, interior partitions or bridge undersides
    (`rounded=False`).
  - Triangles: 49k before. Bevelling everything gave 123k; skipping the steps
    and partitions and merging the parapet runs brings it to 72k.
- **Lighting:**
  - Warm sun (`SUN_COLOUR` 1, .93, .82), soft shadows (`SUN_ANGLE` 5°).
  - Sun 8 → 12, sky 1.8 → 1.5, which gives more shadow contrast.
  - The bake material's albedo is now the paint × `BOUNCE_ALBEDO`, so a little
    colour bleeds onto neighbouring surfaces.
  - `LM_EXPOSURE` 1.9 → 1.4: bright paint times bright light had washed
    everything to white. `LM_AMBIENT` 0.08 → 0.04, `DARK_LIFT` 0.35 → 0.45.
  - `LM_SAMPLES` 256 → 1024: flat colours showed blotchy bake noise that the
    textures used to hide. The build now takes about 2.5 min.
- **Characters** (`assets.js` `softShading`):
  - Matte materials: roughness at least 0.85, metalness 0.
  - A view-space fresnel rim added via `onBeforeCompile`: warm white × 0.55,
    power 2.5.
  - Hemisphere fill 2.0 → 2.5 so characters aren't dark against the bright map.
- **Not changed:**
  - The horizon skyline and sky (`render.js`), which still match well enough.
  - The window glass, which is now flat light blue.
- **Notes:**
  - Re-running `map_generator.py --force` discards Blender edits, as before.
  - Faint lightmap texel and UV-seam patterns are visible only when pressed
    against a flat wall.

## 42. Textures back (pastel), interior shading, seamless walls (2026-10-29)

User feedback on section 41: flat colours looked too childish (they want
textures but keep the pastel look); interiors were hard to read (room
corners, stair steps); walls (especially House08) looked patched together
from rectangles.

- **Pastel textures:**
  - The export keeps the kit materials and textures again: 12 draw calls,
    7 textures, 71k triangles. The paint (`Col` -> COLOR_0) stays, and the
    single `MapPaint` material and the per-piece jitter are removed.
  - `render.js` `paintedDetail` replaces `<map_fragment>`. It multiplies the
    paint by the texture's brightness relative to its local average (the
    same texture sampled with mip bias +5, i.e. 32-texel blur). That is mixed
    with 25% of the texture's own colour ratio (`TEXTURE_HUE`), at strength
    `TEXTURE_DETAIL` 0.7.
  - The result: brick shows as brick, but in the building's pastel colour.
  - `DETAIL_BY_MATERIAL`: `MI_Trim` is set to 0. Its plaster wall pieces
    (e.g. `Trim_Plain_3`) are flat but split into strips mapped to different
    bands of the trim sheet, so any detail made a grid of patches.
- **Seams:** `merged_visual` welds vertices closer than 2 mm
  (`remove_doubles`; 78k -> 39k vertices) before the lightmap UVs. Coplanar
  wall pieces become one Smart-UV island, so the baked light no longer steps
  at every 2 m piece. Combined with the zero jitter and zero `MI_Trim`
  detail, House08's wall is one clean surface.
- **Interiors:**
  - A second Cycles bake of type `AO` (`AO_DISTANCE` 1 m) is saved as
    `build/blender/ao_raw.npy` (retone works with it).
  - It is multiplied in after the lift:
    `light × (1 − AO_STRENGTH·occlusion^AO_CURVE)`, with 0.85 and 0.5.
  - `DARK_LIFT` 0.45 -> 0.3: the flat lift had washed out the occlusion
    indoors.
  - Room corners, floor/wall joins, doorway edges and stair steps now read
    clearly.
  - First tries (strength 0.55 and 0.7, lift 0.45) were invisible in game.
    Viewing the lightmap alone (map and paint off) showed the AO was there
    but drowned by the lift.
- **Browser cache gotcha:** `map_lightmap.ktx2` keeps its name, so after
  `npm run build:lightmap` the browser can keep the old file. Reload it with
  `fetch(url, {cache: 'reload'})` or a hard reload.
- The green buildings' metal siding (`MI_Trim_MetalConcrete`) shows bold
  horizontal bands from the corrugated texture. This can be tuned in
  `DETAIL_BY_MATERIAL` if wanted.

## 43. Pastel removed; House02/10 brick (2026-10-29)

- The user asked to drop the pastel entirely. Removed:
  - `paint()`, the palette and the role classification from `export_map.py`.
  - `paintedDetail` from `render.js`.
  - Keeping COLOR_0 in `optimize_assets.mjs`.
  - The paint as bake albedo; the bake material is grey `BOUNCE_ALBEDO`
    again.
- The map is the kit's textures × lightmap again: 12 draw calls, 69k
  triangles.
- Kept from 41–42: solid parapets with collision, bevels, welded pieces (no
  lighting seams), the AO pass, warm sun and soft shadows, `LM_SAMPLES` 1024,
  and character rim and matte shading.
- Exposure back to the textured values: `LM_EXPOSURE` 1.9, `LM_AMBIENT` 0.08.
  `DARK_LIFT` is 0.42 (0.3 looked dim with the darker real textures),
  `AO_STRENGTH` 0.85, `AO_CURVE` 0.5.
- **House02/10 striped walls:** the 'metal' style's `Metal_Plain_3` pieces
  use the corrugated, rusty half of `T_MetalConcrete`. They are now 'brick'
  (plain red brick). 'pale' was tried first, but its `Brick_TopTrim` pieces
  have a bold beige band at every floor, which is also horizontal stripes.
  - House06/14 (solid, no entry) still use 'metal'.
- House08's plaster shows the texture's faint stone-block lines, but no
  patches.

## 44. Character animation: flicker and wrists (2026-10-29)

Reported: characters sometimes flicker between animations; arms bend
unrealistically (wrists) while holding guns. Measured with 7 bots (counters
per avatar per frame) and in `preview.html`, driven from the console: weapon,
reload, all moves, pitch ±1.2.

- **Flicker 1: the jump clip on stairs.**
  - `air` came from `|v.y| > 1.2`, but running up or down stairs is about
    4 m/s vertically, so every bot blended into the jump clip on stairs.
  - Now `airborne` comes from the height above the surface below
    (`state.ground`, the shadow raycast):
    - It needs to be over 0.3 m for `AIR_DELAY` 0.1 s, or over 0.8 m at once,
      so kerbs and step edges don't trigger it.
    - It ends below 0.08 m (the same logic now also drives landing sounds).
- **Flicker 2: idle/run flips on short stops.**
  - The speed the clips see (`speedHold`) rises at once but falls at most
    `SPEED_FALL` 25 m/s².
  - The movement direction is only updated from the real speed.
  - Remote players pass `vel` from the two bracketing snapshots
    (`main.js`), smoothed like the position-based estimate. It was previously
    differentiated per frame from interpolated positions.
- **Bots** caused much of the stopping:
  - While waiting for the next A* search they stood still; they now coast in
    their last direction for `COAST` 0.4 s (if `safeStep` allows).
  - The steering lookahead (`path[step+1]`) could be the node just below the
    bot after a drop edge. The direction to it was then arbitrary, and bots
    pushed into walls at the House01 stair landing, jumping to get unstuck.
    They now steer at `path[step]` when the lookahead is on another level or
    within 0.4 m.
- **Results** (7 bots, 30 s):
  - Idle/run flips under 0.3 s: up to 43 (77 for the stuck bot), now 1–6.
  - Airborne flashes under 0.25 s: up to 12, now 0–4 (real small drops and
    jumps).
- **Wrists:**
  - `aimGun` used to rotate the gun *inside* the hand to the aim, while the
    hand kept the clip's pose. That was up to 38° when backpedalling with the
    long guns or aiming at ±1.2 rad, and 35° when strafing with the revolver.
    It read as a broken wrist.
  - Now `holdGun(yaw, pitch, …)` turns the right hand itself so that the gun,
    unturned in its holder, points along the aim:
    `hand = aimQ × holderQ⁻¹`.
  - The palm target accounts for the grip offset turned with the hand.
  - `swivelElbow` then swings the arm about the shoulder–wrist line (by at
    most `ELBOW_SWIVEL` 1.2 rad) so the forearm meets the hand as in the idle
    (`gripRest[…].forearmR`, calibrated in hand space).
  - Left hand, when not in a procedural reload: turned on the gun as in the
    idle (`leftInGun`), with the elbow swivelled to `forearmL`. The IK weight
    now blends the hand bone too.
  - Measured: the gun's turn in the hand is 0° in every state (was up to 38°).
    Wrist bends stay within about ±15° of the idle's.
  - Checked visually: rifle backpedal, aiming ±1.1 rad, pistol strafe and run,
    sniper (female) strafe, revolver backpedal while firing, sniper and rifle
    reloads.

## 45. Matte characters; preview with every gun and first person (2026-10-29)

- The characters looked too glossy (the user compared them with Party
  Animals). `softShading` in `src/assets.js` now swaps each character
  material (MeshStandardMaterial, vertex colours, roughness 0.85) for a
  `MeshLambertMaterial`: diffuse only, no specular highlights at all.
  - The warm white fresnel rim (×0.55) read as reflected light. It is
    replaced by a faint "fuzz" in the surface's own colour
    (`FUZZ_STRENGTH` 0.22, `FUZZ_POWER` 3), like a plush toy's edges.
  - Guns are unchanged (separate materials, not passed through softShading).
- Preview page (`preview.html`, `src/preview.js`):
  - Same tone mapping (Neutral, 1.15) and lights (hemisphere 2.5, sun 2.6)
    as the game, so characters look as they do in play.
  - Buttons for all six guns, a Reload button (runs for the gun's
    reloadTime), auto-fire at each gun's own cooldown.
  - Third person / First person. First person is the game's view: fov 75,
    head collapsed, eyes at `EYE_HEIGHT`; drag to look (moves the pitch
    slider too), crosshair shown.
- The eye placement moved from `Renderer.updateViewmodel` into
  `Character.placeEyes(eye, yaw, pitch)` (with `VIEW_EYE`), shared by the
  game and the preview.

## 46. Left arm: shotgun / sniper wrist, and left-arm flicker (2026-10-29)

- **Bug in section 44's wrist fix:** the left hand's lock onto the gun (idle
  wrist, elbow swivel) ran only `if (!proc)`. `poseGun` returns an object
  for every gun with a procedural reload (all but the rifle), even when not
  reloading (progress -1), so the lock only ever applied to the rifle. The
  other guns' left hands kept the clip's wrist rotation: wobbling on the gun
  (up to 5.5° per frame) and bent down on the long guns.
  - Now: `leftLock` (damped, rate 10) is 1 whenever the hand is on the gun
    (no procedural reload, or past the reload path's last point) and 0 while
    the reload path moves the hand. The swivel and the hand's turn are
    weighted by it.
- **Over-stretching:** the left arm's flicker came from the hand target
  being out of reach. At 100% of the arm's length the elbow locks straight,
  and the bend snaps on and off as the run cycle moves the shoulder.
  - Shotgun grip at -0.30 needed 100% reach at idle (elbow 2°, fingers 22°
    down); sniper -0.27: 97%. Rifle -0.26: 94% (elbow 40°).
  - Grips moved: shotgun -0.24 (back half of the pump), sniper -0.23.
  - The rifle went straight running backwards and strafing left (shoulder
    pulled back by those clips).
  - New `withinReach()` before `solveTwoBone`:
    - Past `LEFT_REACH` (0.94 of the arm's length), the target slides back
      along the gun toward the stock, up to `LEFT_SLIDE` (0.2 m).
    - Past that, a soft tanh limit toward `LEFT_MAX` (0.985), so the arm
      never quite locks (the hand may come up to ~1 cm off the gun).
  - Slides: 3–8 cm at level aim when running back or strafing; up to ~20 cm
    aiming almost straight up (the hand pulls back toward the receiver).
- **Measured** (preview harness, 6 guns × 7 moves × {level, firing, pitch
  ±1.1}, male and female):
  - Elbow jolts beyond the hand's own motion: worst 0.6 cm (were up to
    5.3 cm, with 60+ pops per 4 s).
  - Straight-arm frames: 0 (were 100–240).
  - Hand rotation on the gun: at most 0.6° per frame.
  - Reload hand-overs are smooth. The remaining quick turns mid-reload are
    the reload motions themselves.
- Preview: `window.preview.orbit(yaw, pitch, distance)` for setting the
  camera from the console.

## 47. Hitboxes follow the drawn character; lag compensation (2026-10-29)

The user reported that shots slightly off the centre of the head didn't land.
There were two causes.

**1. The head box wasn't where the head is drawn.**
- Old head box: ±0.16 m straight over the feet, y 1.45–1.82.
- The aiming animations lean into the gun:
  - rifle standing: the drawn head is 0.19 m forward and 0.14 m right;
  - running: 0.34 m forward;
  - aiming down (-1 rad): 0.47 m forward and 0.17 m lower.
- In random poses only ~25% of the drawn head was inside the old box.

**Fix: `headCenter(pos, pose)` in shared.js.**
- pose is `{ yaw, pitch, weapon, vel, skin }`.
- The head swings about a pivot near the hips: (fwd -0.02, up 0.92), arm
  0.71 m. Its angle is `0.30 - 0.46 * pitch` from upright (fitted within
  ~3 cm over the pitch range -1.4..1.4).
- Per hold style (`PISTOL_HOLD`: pistol, revolver):
  - a sideways offset (rifle style: 0.14 m right);
  - a lean when moving at full speed forward, back, left and right, scaled by
    the velocity in the player's frame.
- Female skins (index >= 4) are scaled by 0.955.
- `HEAD_HALF` [0.15, 0.18]: the head is ~0.23 × 0.29 × 0.24 m, plus ~4 cm for
  the run cycle's bob.
- Body: `bodyAABBs` returns legs (0–0.95) over the feet and a chest
  (0.95–1.45) centred halfway between the feet and the head (it leans with
  the upper body).
- `rayPlayer(o, d, pos, pose)` gives `{ t, headshot }`.
- Users of these boxes:
  - host hit test;
  - client tracer stop;
  - wall-hack boxes (3 now);
  - aim hack (`avatar.pose`, set in `Renderer.updateAvatar`);
  - bots' head aim.
- Measured over random poses (all guns, pitch ±1.3, random moves):

  | | Male | Female |
  |---|---|---|
  | Drawn head inside head box | 97% (was 24%) | 94% (was 25%) |
  | Drawn torso and legs inside body boxes | 95% (was 92.5%) | 96% (was 94%) |

  The worst leftovers are steep pitch plus diagonal backward moves (5–14 cm
  off). The head's centre stays inside the box.

**2. No lag compensation.**
- Clients draw others INTERP_DELAY (100 ms) in the past, plus the trip from
  the host, but the host tested shots against current positions: about
  0.7 m off at full run, more than the head's width.
- Now:
  - Snapshots carry `n`. The host keeps the last `HISTORY` (12, 0.6 s) as
    `{ n, players: id -> { pos, yaw, pitch, weapon } }`.
  - Clients remember `viewing = [n before, n after, fraction]` in
    `renderRemotePlayers` and send it as `v` with each shot.
  - `HostServer.seenBy(v)` interpolates each player exactly as the client
    drew them (the same 3 m respawn rule), with velocity from the two
    snapshots.
  - Missing or old `v` (bots, junk) uses current positions.
- Unit-tested:
  - rewind gives the drawn position and velocity;
  - a shot at the drawn head of a running target hits with rewind and missed
    without it.
- Trade-off (in the README): you can be hit just after reaching cover; a
  cheater could claim a view up to 0.6 s old.

**Preview:** a Hitboxes button draws the three boxes live (yellow head, red
body), with the preview's pose.

## 48. Survival money doubled; aim hack and shot origin fixed (2026-10-30)

- **Money:** `SURVIVAL_RATE` 8 → 16 dollars per second alive.
- **Aim hack missed moving targets (most visibly up close):** the lead from
  section 39 was still on after section 47's lag compensation. The host now
  checks shots against what the shooter saw (`seenBy`), so leading by
  velocity × (`INTERP_DELAY` + `rtt`) put the aim ~0.7–1 m ahead of the
  head, a fixed distance in metres. That's a few degrees far away, but about
  20° at 2 m, so it looked worst up close. The aim angle itself was always
  from the eye to the head's centre, so distance was already accounted for.
  - `aimLock` now aims at the drawn head; `velocityOf` is removed. `rtt`
    and ping/pong stay (debug: `hackfps.rtt()`).
- **Shot origin:** the host fired from its copy of the shooter's position,
  one `state` message (up to 33 ms) plus the trip behind. Running at 7 m/s
  that's ~0.25 m sideways, enough to miss the head even with a perfect aim.
  Shots now carry `o` (the client's eye), used when within
  `MAX_SHOT_ORIGIN_OFFSET` (1.5 m) of the last reported eye; bots send none.
- Checked with `shared.js`'s hitboxes, a target strafing at 7 m/s at
  2–50 m: old lead missed at every distance; the new aim hits the head; the
  new aim from a 0.25 m-stale origin missed (now avoided by `o`).

## 49. Hack modes: one hack (default) or no limit (2026-10-30)

- The host picks the mode on the main menu (**Mode (when hosting)**, a
  select above Host Game; remembered in `localStorage` as `hackfps.mode`):
  - **One hack** (default): one hack per life, as before section 38.
  - **No limit:** any number at once (section 38's behaviour).
- `HostServer` takes `{ oneHack }`; `welcome` carries `oneHack` to every
  client. `onSpawn` rejects a mask with more than one bit in one-hack mode
  (`atMostOneHack` in `shared.js`).
- Buy menu: still checkboxes, but in one-hack mode ticking a hack unticks
  the rest, and a hack is only locked if it plus the weapon is too
  expensive (it replaces the picked one). The header says "(one at a time)"
  or "(any number)". Remembered picks from a no-limit game keep only the
  priciest hack.
- The room info line (top of the HUD) shows "One hack" or "No limit".
- Checked in Chrome as host (Admin): one-hack mode keeps only the last
  ticked hack and the host refuses a forged `h: 3`; no-limit mode takes
  three hacks (`h: 11`).

## 50. Slower movement (2026-10-30)

- `MOVE_SPEED` 7 → 5.5 m/s (about 20% slower). Everything else follows
  it: the speed hack (3x: 16.5 m/s), fly hack (1.3x), bots, spread while
  moving, the hitbox lean and the run animation. Footstep volume now uses
  `MOVE_SPEED` instead of a hard-coded 7.
- A running jump now covers ~3.9 m instead of ~4.9 m (0.7 s in the air);
  no route in the map needed the longer jump.

## 51. Low sill on the window under the House01 / House09 bridge (2026-10-30)

- User: jumping in and out of the window under the bridge (east wing,
  ground floor, facing the road) got harder.
- Cause: the map hadn't changed (collision identical across the last
  commits); the slower `MOVE_SPEED` (section 50) did it. The bridge's 0.5 m
  slab hangs over the window outside: its underside is 2.5 m above the
  sidewalk, so a jump there bumps the slab (feet top out ~0.85 m), and the
  0.8 m sill (top 0.95) left a 1.7 m gap for a 1.8 m player. Simulated
  run-and-jump in from the road (`world.stepPlayer`, jump pressed 0-2.5 m
  before the wall): worked from up to 1.65 m out at 7 m/s, 1.2 m at 5.5.
- Fix: that window's sill 0.8 → 0.4 m (`map_generator.py`, House01
  `windows`; House09 is its twin). Map regenerated (`--force`) and rebaked.
  Collision diff against the previous map: only the two sills (top 0.95 →
  0.55). Now: jumping in works from up to 1.75 m out at 5.5 m/s (2.5 m at
  7); out works from anywhere; walking into it without jumping still stops.
  Sill 0.6 was tried first: only 1.45 m.

## 52. Stepping onto kerbs without jumping (2026-10-30)

- User: after the slowdown (section 50), going from the road up onto the
  sidewalk (a 0.15 m kerb) often needed a jump.
- Cause: there was no step-up. The capsule's round bottom rode up an edge
  only when pushed into it hard enough, which depended on speed, angle and
  spot. Measured on 24 road-to-sidewalk spots, walking straight at the kerb:
  all 24 at 7 m/s, 6 at 5.5 m/s; at 30° only 6 even at 7 m/s. The same
  effect let the speed hack walk over the new 0.4 m window sill (section 51).
- Fix (`world.js`): movement now collides through `collide(x, y, z, ref)`.
  - `STEP_HEIGHT` = 0.25 m. Floors, and level or gently sloped edges (a
    kerb's top, a ramp's side; under ~45°), up to `STEP_HEIGHT` above
    `ref` are stood on (pushed up, onto an edge no higher than the edge).
    Higher edges and floors push back level, never partly up.
  - `ref` is `player.groundY`: the height of the floor face last stood on,
    kept while standing on an edge (so you can't climb one step at a time),
    taken from the feet in the air and when unknown or far from the feet
    (respawn, teleport).
  - Edges shared by two triangles in the same plane (a wall quad's
    diagonal, `flatEdges` built at load: ~18k) are ignored: they read as
    sloped edges and lifted players walking along walls (the old code was
    pushed partly up by them too).
- Checked in Chrome against the previous `world.js` (same map):
  - Kerb, 24 spots: 24/24 at 0°, 30° and 60°, at 30/60/144 fps and with
    the speed hack (old: 6/24 at 5.5 m/s).
  - Window under the bridge: never walked in without jumping (old: the
    speed hack walked in); jumping in from up to 2 m out; out from anywhere.
  - ~3,000 random 2 s walks from random floors: none end lower than the old
    code; the few that climb higher step onto a staircase's low end from
    the side.
  - Bots (4 vs 4, 30 s): moving 40-140 m each, using stairs; no errors.
    `nav-worker.js` still plans steps up to 0.4 m; bots jump when stuck.
  - Same cost per step as before.

## 53. Default mode: up to 2 hacks; recoil $500, aim $2,000 (2026-10-31)

- Prices: recoil hack $400 → $500, aim hack $1,500 → $2,000 (`HACKS`
  order unchanged: still by price; recoil before infinite ammo at $500).
- The default mode allows up to `HACK_LIMIT` (2) hacks per life instead of
  one (section 49). The mode is now a number, `hackLimit` (2, or 0 for no
  limit), passed to `HostServer` and sent in `welcome`; `onSpawn` checks
  `withinHackLimit`. Buy menu: at the limit the unticked hacks are locked
  (no more replacing); remembered picks drop the priciest until within the
  limit and affordable. The room info line shows "Up to 2 hacks" or
  "No limit". The Mode select's value is `limit` / `any` (a remembered
  `one` falls back to the default).

## 54. Bigger minimap with player names (2026-10-31)

- Minimap 220 → 300 px (CSS; the canvas is 600 x 600 and drawn at 2x so
  text stays sharp; `SIZE` in `minimap.js`). Same `RANGE` (the whole map).
- Each player's dot has their name above it (bold 10 px, team colour,
  black outline; below the dot near the top edge, kept inside the map
  horizontally). `Character` now keeps its `name`.
- Checked in Chrome with 7 bots: names readable; players standing together
  overlap.

## 55. Crouching (2026-10-31)

- Hold Ctrl or Shift (left or right) to crouch. Ctrl key combos are swallowed
  while the mouse is captured (`preventDefault`), so e.g. Ctrl+D doesn't
  bookmark. Browsers don't let a page block Ctrl+W on Windows/Linux, so
  Ctrl crouch + W there closes the tab (on macOS Ctrl+W does nothing).
  Hence Shift (and Alt for the aim hack, moved off Shift; Alt keyup is
  swallowed too so Windows doesn't focus the browser menu), and a `beforeunload` "Leave site?" prompt while in a
  match so an accidental Ctrl+W can be cancelled.
- Animations: 5 new Mixamo rifle clips in `fbx/Character Animation/`
  (Crouch Idle, Crouch Walk Forward / Backward / Left / Right) converted
  as `crouch_idle`, `crouch_forward` ... (`convert_assets.py` CLIPS;
  `npm run build:anims`). One set for every gun: with the pistol the
  pistol idle's upper body goes over them (the `pistol_fire` overlay at
  full weight while crouched). `Character` eases `crouch` 0..1 and
  cross-fades the standing and crouch sets; the crouch walks share the run
  phase, at `CROUCH_ANIM_SPEED` 2.0 m/s (feet measured within ~5% of the
  ground at 2.75 m/s). No footsteps while crouched. Name label 0.5 m lower.
- Upright upper body (`straightenSpine`): the crouch clips lean the spine
  18-44 degrees forward and 9-41 to the side (with the pistol's standing
  aim over the rifle-turned crouch hips too). After the clips, the chest
  (Torso to Neck) gets its direction in the gun set's standing idle
  (`gripRest.chest`) plus `CROUCH_CHEST_LEAN` (6 degrees) forward: ~21
  degrees for the rifle. Below it, the spine bends evenly from the pelvis's
  up (where the crouch tilts it: back ~20 degrees kneeling, forward ~15
  crouch-walking; `gripRest.pelvisUp`) to the chest: a third of the turn at
  each of Hips, Abdomen, Torso, bottom up, shortest turns (no twist). The
  back curves smoothly and rounds outward.
  - The models skin the buttocks partly to Abdomen and Hips (bones above
    and in front of them): the more the spine turns back from the clip,
    the more the buttocks swing in and the shirt's hem hangs over them
    (they looked flat). The 6 degrees of extra lean keep them round.
  - Tried and dropped: turning only the abdomen and chest to the standing
    waist-to-neck line (all the bend at one joint: arched back, flattened
    belly); each segment to its standing direction (the standing lower
    back leans back: a sharp bend at the pelvis, arched in); moving the
    hip vertices' spine weights onto the pelvis (the shorts' waistband
    then parted from the shirt's hem); tilting the pelvis back about the
    hip joints with the thighs turned back (dragged the hem further down).
- Feet on the shins (all movement, not just crouching): the rig's feet
  hang off the root bone (its IK setup), each clip placing them at its own
  shins' ends. Blending two clips (changing direction, starting, stopping)
  mixes the feet's positions and the legs' turns separately, so they
  parted for a moment: up to 23 cm (forward to strafe), the ankles
  stretching. After the mixer, each foot is put at its shin's end
  (`LowerLegL_end`); its turn stays as blended. Measured in the preview:
  0 gap through every transition; a foot may dip up to ~3 cm below the
  ground for a moment in crouched transitions.
- Gameplay (`shared.js`): `CROUCH_SPEED` 0.5 (2.75 m/s), `CROUCH_SPREAD`
  0.5 (on the ground), eyes `CROUCH_EYE` 1.25 m (head: 1.2 kneeling, 1.4 walking) (eased over `CROUCH_TIME`
  0.15 s; `eyeHeight(crouch)`), capsule `CROUCH_HEIGHT` 1.25 m.
  `World.stepPlayer` takes `input.crouch`; `player.crouched` stays true
  after release until `canStand` (nothing in the standing capsule above
  the crouched one).
- Network: `state` carries `c` (crouched); the host keeps `player.crouch`,
  sends it in snapshots (`c`) and history; `seenBy` interpolates it, so
  lag-compensated shots use the crouched hitboxes. Shot-origin fallback and
  bots' eyes use `eyeHeight`.
- Hitboxes: `headCenter` blends a crouched version of the head model
  (`CROUCH_HEAD`, `CROUCH_STYLE`: pivot, arm, tilt and per-direction leans
  fitted to the straightened crouch in the preview, within 1.5 cm over
  pitch ±0.8 and every direction). Crouched, the legs box tops out at 0.5 m and the
  chest box goes up to the head. Checked in a second tab: the drawn head of
  a crouched player was 2 cm from the hitbox centre.
- Preview page: a Crouch button.
- Fix found on the way (`flatEdges`, section 52): an edge counted as flat
  (ignored by collision) when its first two triangles were coplanar, even
  if a third met it at an angle. At wall corners whose end face continues
  the plane of the next wall (e.g. (12, 24)), the corner was ignored and
  players cut ~0.17 m into it (they couldn't stand up from a crouch
  there). Now flat means all exposed faces on the edge are coplanar
  (back-to-back hidden faces, where wall boxes meet end to end, are
  skipped). 1,500 seeded 2 s walks vs the old rule: 96% identical, none
  higher or lower, a few steered round corners they used to cut; kerb
  step-up unchanged (same 24 spots at 0/30/60°, identical results).

## 56. Gun holding regression; pistol firing on the move (2026-10-31)

- Regression from section 55 (not committed): `gripRest[set].chest` (the
  chest bone's position, `holdGun`'s pivot) was overwritten by the crouch
  straightening's chest direction. Every gun was placed about the wrong
  point: long guns at the left shoulder, the pistol's left arm strained.
  The direction is now `chestDir`. Checked against the last commit with
  identical inputs (every gun, 5 directions, pitch -0.6/0/0.6, idle and
  firing, standing): muzzle, both hands and the left elbow 0 mm apart.
- Pistol and revolver firing on the move (an older problem): the firing
  overlay (the pistol idle's upper body over the run) included the spine,
  turning the chest away from the run's; the gun follows the chest
  (`holdGun`), so it jumped 13-19 cm sideways in view (toward the middle)
  whenever you fired while moving. The overlay is now the arms only
  (`ARMS`; the crouch's straightening handles the spine). Grip relative to
  the head, firing vs not, same frames: under 1 cm on average (2.3 cm at
  most), crouched or standing; left elbow frame-to-frame movement as
  before (no snapping).
- Why the crouched back looked arched in again after the fix: the spine
  hadn't changed (same segment angles), but with the bug the arms held the
  gun ~35 cm too high, which hunched the shoulders and rounded the upper
  back. With the arms right, the shoulders were square. Now the chest
  alone turns a further `CROUCH_HUNCH` (10 degrees) forward after the
  straightening (shoulders rounded over the gun). The gun is held from the
  chest bone, which the hunch doesn't move, but the head comes forward ~8
  cm; `holdGun` adds that shift (`hunchShift`), so the gun keeps its place
  relative to the eyes (within ~1 cm of before the hunch). Crouched head
  hitboxes refitted per holding style (`CROUCH_STYLE` now carries arm,
  tilt and follow; within 0.9 cm); `CROUCH_EYE` 1.2 m.
- Long guns crouched leaned too far forward (~30 degrees at the chest vs
  ~18 with the pistol): the straightening used each gun set's standing
  chest, and the long guns' standing chest leans ~13 degrees into the gun.
  Now every gun takes the pistol's forward lean; the sideways lean stays
  the gun set's own (long guns: ~11 degrees right, the head over the
  stock). Spine segments now the same for every gun; the long guns' gun
  relative to the head within ~1-3 cm sideways and ~5 cm of standing.
  Long-gun crouched head hitboxes refitted (within 0.8 cm).

## 57. Korean translation (2026-10-31)

- Every piece of interface text is in `src/i18n.js` (`STRINGS.en`,
  `STRINGS.ko`); `t(key, params)` fills `{name}` placeholders, falling back
  to English, then the key. Weapon, hack and team names come from there too
  (`weaponName`, `hackName`, `hackShort` for the scoreboard, `hackDesc`,
  `teamName`); `shared.js` keeps the English names (README, preview, kit).
- Language: an English / 한국어 switch on the main menu (`#langSwitch`),
  saved as `hackfps.lang`; without one, Korean (the default). Fixed page text is marked `data-i18n` / `data-i18n-placeholder`
  (`applyPageText`); the rest is written from code each time it's shown.
  The menu's status line is kept as a key (and error), so it re-translates
  when the language is switched.
- The host's feed messages are sent as `{ t: 'feed', key, ...values }`
  (joined, left, kill, victory, noBots) and put into words by each client
  (`feedText`), so every player reads them in their own language. net.js
  errors carry an `i18n` key (`gameError`).
- Checked in Chrome: the menu, buy menu (weapons, hacks with descriptions,
  limits, total, Start countdown), HUD (room line, team scores, weapon,
  spawn protection, click to play), scoreboard, a bot's join message, the
  status line and a "room not found" error in both languages; switching
  language re-translates the menu and its status line; the choice survives
  a reload.

## 58. Clock Tower District grey box; ladders; callouts (2026-11-06)

Tester feedback: buildings you can name, and real sniping spots. Blueprint
(published page): https://claude.ai/artifact/TQAqcKbaK8rvvz1DBCx93G; a copy is in
docs/clock-tower-district-blueprint.html. Built
as a grey box first, as a second map next to Downtown.

### Map

- `tools/district_generator.py` (Blender, no kit pieces): boxes written in
  game coordinates (converted to Blender's), one mesh per landmark colour
  over a generated 1 m grid texture (`maps/district_grid.png`; colour as the
  glTF base colour factor through a Mix/Multiply node). North half recorded
  and replayed mirrored (z -> -z) with the south twins' colours
  (`Recorder` / `mirror_call`); the centre row is built symmetric. Helpers:
  `shell` (walls with door / window openings), `slab` (with holes), `flight`
  (steps drawn, a ramp wedge for collision), `rail` (players-only),
  `ladder`, `zone`, `pickup`, `spawn`. Convex solids' faces are wound
  outwards (`orient`): three.js draws front faces only and the bots'
  navigation reads floor normals.
- 23 draw calls, 18k triangles, ~380 KB (+ collision 27 KB).
- `export_map.py --name district` / `optimize_assets.mjs --name district`:
  every output named `district_*` (Downtown keeps `map*`); the scene's
  `map_meta` JSON (playBounds, pickups, ladders, zones) is merged into
  `district_meta.json`.
- Stair rule as before (free cell before the bottom, 1 m flat at the top);
  switchback stairwells alternate two lanes per storey with a hole in each
  floor over the flight below it.

### Game

- Maps: `shared.js MAPS` (id -> file prefix). `?map=` or the menu's Map
  select (saved as `hackfps.map`) picks the page's map; changing it reloads.
  The host's `welcome` carries `map`; a joiner on another map reloads with
  it (`sessionStorage hackfps.rejoin`) and joins again by itself.
- Per-map pickups: `ALL_SPOTS` is now set from the meta (`useMapSpots`)
  before the host or renderer use it; Downtown keeps its constants.
- Rectangular play area (`playBounds`): `World.clampXZ` / `inside` / `extent`
  used by movement, the host's clamp (now down to -6 m: the subway is at
  -4.5), the bots' nav grid and the minimap. The horizon's outer ground is a
  plane with a rectangular hole (a ring would cover the canal) and the
  skyline rings move out past the corners. `renderer.setMap` now builds the
  pickup spots and the horizon (they need the map).
- Callouts: `meta.zones` ({ id, rect, y?, floor?, roof? }); `World.zoneAt`
  picks height-limited zones first, then the smallest. HUD `#location`
  shows the name (+ "4F" / "Roof"); minimap draws the names faintly.
  Names in `i18n.js` (`zone.*`).

### Ladders

- `meta.ladders`: { p (on its plane), n (towards the climber), w, y0, y1 }.
  In front of one (`LADDER_REACH`), `stepPlayer` climbs instead of walking:
  moving towards it = up (`CLIMB_SPEED` 3.5 m/s, x speed hack), away = down,
  sideways shuffles; no gravity; held `LADDER_STANDOFF` off the plane
  unless pushing in (coming down from a roof, the edge at the top was
  otherwise stepped back up onto); at the top, pushing in steps onto the
  floor; at the foot climbing down ends (counts as standing); jump lets go
  (not re-grabbed for 0.4 s). Free-standing ladders (tower inside, roof
  hatches) have a players-only backing plate.
- `me.climbing` -> state `l` -> snapshots `l`; no shooting, no first-person
  gun. Others: the `climb` clip (Mixamo "Climbing Ladder", added to
  `convert_assets.py` CLIPS; `CENTERED`: its hips sat ~1 m to the side and
  0.8 m up, moved to the rest position on average), speed following the
  vertical speed (backwards going down); the gun hidden; the body turned to
  face the ladder (main.js, from `world.ladderAt`).
- Bots: nav edges both ways between each ladder's foot and top node
  (`nav.ladder` marks them); `followPath` doesn't treat the top as "fell
  off the path" while climbing; no stuck-jump while climbing.

### Verified

- Scripted movement in Chrome: every ladder up (tower inside 0 -> 14 and
  outside 14 -> 20, crane 6 -> 18, Hospital / Hotel 0 -> 15, Warehouse /
  Factory 4.5 -> 9.25) and down, walking away at the foot, hanging,
  climbing back up. The crane's mast top first blocked the cab (raised
  above head height).
- Bots' navigation graph (2.4 s to build): Hospital / Hotel roof and 4F,
  Bank / Police roof, tower balcony and top, crane cab, Construction 3F,
  Warehouse catwalk and roof, Factory roof, Subway, canal bed, Market Hall
  2F, skybridge and the Red spawn all reachable from the Blue spawn.
- Screenshots: overview, the Hospital-roof view down the Canal, the climb
  animation on the Hospital ladder; HUD location (e.g. "병원 · 옥상").

## 59. Downtown removed (2026-11-06)

The Clock Tower District is the only map. Removed: `maps/downtown*.blend`,
the blueprint images and `tools/map_generator.py` / `make_blueprint.*`,
`assets/models/map*`, Downtown's pickup constants, the menu's map select and
the reload-to-the-host's-map code, and the round play area (`playRadius`;
`playBounds` only). `npm run gen:map` / `build:map` / `build:map:fast` /
`build:lightmap` now work on `maps/district.blend` (files stay
`district_*`). The Downtown City kit (`fbx/Map/DowntownCity`, `city_kit.glb`,
kit.html) stays: textures for the next phase.

## 60. Textures, props, ladder models, metal footsteps (2026-11-06)

- Textures: each map material is (texture, metres per tile, sRGB tint)
  (`SURFACES`): asphalt, concrete, marble and red brick from the Downtown
  kit, the Medieval kit's stone blocks and plaster made greyscale (evened
  to a light grey) so tints give each landmark its colour, a generated
  corrugated metal (Warehouse) and the grid (Subway tiles). Made once from
  `map_resource/` into `maps/textures/` at 1024 px.
- Props (`PROPS`, `prop()`, mirrored like the rest: the twin turned
  180 - rot so its front mirrors): cars (Realistic Car Pack; police cars
  only at the Police Station, other cars at the Bank), trees, bushes in
  planters, bollards, crates, barrels, carts, AC units. Imported once into
  hidden library objects (`load_prop`: joined, world space, lifted onto the
  floor), placed as linked copies. Collision: a box round each (oriented
  with it); trees only their trunk (bullets pass the leaves); bushes none.
- Prop textures: only base colour (the map is drawn unlit with baked
  light), at most 1024 px, saved to `maps/textures/props/` and unpacked
  from the .blend (the glTF importer packs them; the .blend went 11 MB ->
  1 MB). Some SciFi models look for textures next to them: found in the
  pack. Plain-coloured materials (the cars' ~15) become cells of one
  palette texture (`palette_flat_materials`): 44 -> 32 draw calls.
- Ladders: the Platformer Pack's ladder models in the map's dark metal
  colour, stacked and stretched a little to each height (`place_ladders`).
- Metal footsteps: `meta.metal` floors (catwalks, crane deck);
  `World.onMetal`; main.js swaps 'step' for 'stepMetal'
  (`sounds/footsteps/metallic_footstep.mp3`); characters on a ladder make a
  'climb' sound (also metal) every 0.6 m.
- Lightmap fixes (the first bake with props used ~1% of the lightmap, all
  islands in a thin strip): (1) projected object by object
  (`project_lightmap`) then joined, scaled by area and packed: projecting
  the whole joined map put some walls edge-on (no UV area), which set the
  packing's scale; (2) no welding any more, and the generator cuts every
  visual mesh at a 12 m grid (`LIGHTMAP_PIECE`, split edges) so the long
  canal / boundary strips become 12 m islands; (3) faces pressed back to
  back against another (walls against the boundary blocks) are removed.
  Bake ~2.5 min, lightmap 2.7 MB.
- Known: small curved props (the cars) get few lightmap pixels per face;
  the sports car shows faint dark stripes.
- 94 props, ~125k triangles, 32 draw calls; map ~3.4 MB + lightmap 2.7 MB.
- Checked: walking into a car, a crate stack, a tree trunk stops you;
  shots hit cars and pass through leaves; the bots' navigation still
  reaches every roof, ladder top, the subway, canal and both bases.

## 61. Furniture and food; props lit in real time (2026-11-06)

- New packs (CC0): Ultimate House Interior Pack, Ultimate Food Pack
  (Quaternius). Modelled ~2x (furniture) and ~4-10x (food) too big:
  `PROPS` entries take a scale (`FURNITURE` 0.55) and a lift (None: stand
  on the lowest point). Food is decimated to a third (tiny on screen).
- `furnish_north()`: station waiting couches / plants / bins; Hospital
  (Hotel) lobby desk and couch, wards with beds and nightstands on 2F-4F,
  sinks, a meeting table on 5F; Bank (Police) counters, desks and chairs,
  bookshelves upstairs; Warehouse (Factory) racks; bins on the street;
  a café upstairs in the Market Hall. `food_on()`: rows of fruit, veg, fish,
  bread on every stall counter (Market Alley, Market Hall; the Market Hall's
  stalls made symmetric). Beds, tables, couches, shelves, counters are
  solid; chairs, plants, lamps, bins, food aren't.
- Ground floors get a visual floor 1 cm over the ground (`shell(floor=)`):
  they showed the street's asphalt.
- Props moved out of the lightmap: the `Props` collection is exported as
  `district_props.glb` (lit in real time and matte, like the characters;
  they still cast shadows into the bake). With ~130k prop faces the
  lightmap packing failed again (1-4% used), and small curved props got
  stripes anyway. The map's own lightmap UVs are now a box projection per
  face (`project_lightmap`: no more smart projection, which turned some
  faces edge-on): 80% of the lightmap used.
- 404 props. Map 22 draw calls / 20k triangles (1.2 MB) + lightmap 2.9 MB +
  props 11 draw calls / 181k triangles (3.3 MB). Bake ~4 min.
- Checked: beds block movement; the bots' navigation still reaches every
  roof, ladder top, the subway, the heal packs and both bases; screenshots
  of the street, a ward and the Market Hall.

## 62. Knife (2026-11-07)

- `WEAPONS[0]` = knife (keys 1-7 now): the spawn weapon (`DEFAULT_WEAPON`)
  and free; the pistol now costs $200. Weapon spots can offer any weapon,
  the pistol and knife included. `melee: { range: 2, backDamage: 100 }`,
  damage 50, cooldown 0.6 s (hold to keep swinging), `moveSpeed` 1.12 (main.js
  input speed; bots too). No ammo (`magSize` 0: reloads are no-ops), HUD
  ammo hidden.
- Host `onSwing`: the nearest enemy (as the swinger saw them, lag
  compensated) within range + capsule radius, within 0.6 rad (~35°) of the
  look direction horizontally and 1.4 m vertically, with a clear line to
  their chest. From behind (the victim's facing within ~60° of the swing's
  direction): backDamage. The 'shot' broadcast has no tracers (`es: []`):
  others play the swing and the swish.
- Animation: Mixamo "Boxing Idle" (`knife_idle`) and "Boxing Swing"
  (`knife_swing`, frames 4-44: wind-up, the hook fastest at frame 16, back to
  the guard) in `convert_assets.py` CLIPS. The knife set's legs are the
  rifle's; the guard is an upper-body overlay (KNIFE_GUARD weight 12), the
  swing another (24) played once per attack, sped up to 0.6 s. No aiming IK,
  no left hand on it: the knife stays as the fist holds it.
- The knife in the fist (`knifeInFist`): blade straight out of the knuckles
  (a push-dagger grip), flat to the thumb / little-finger sides. Tried
  first: pointing forward from the guard (the hook then pointed it down) and
  out of the thumb side (in a boxing guard the thumbs face the boxer: it
  pointed back at the face). Now forward-up in the guard, broadside to the
  first-person camera, and swept sideways by the hook.
- First person: `VIEW_EYE.knife` puts the eye left / above so the guard's
  fists sit lower right.
- Model: Quaternius Survival Pack `Knife.fbx` (CC0) copied to `fbx/Gun/`,
  `build_knife()`: blade forward, origin mid-handle, 0.32 m; colours by
  material name.
- Sound: 'swing' (synthesised swish, loudest ~0.16 s in, with the hand).
- Bots: RANGE.knife 1.2 m; with the knife they run straight at the target,
  and if something's in the way (a car), follow the navigation graph to them
  (re-planned every second); swing only within reach.
- Checked: from behind 100, face to face 50, 2.8 m away nothing, aimed 90°
  away nothing; a knife bot behind a car went round it and killed (100, 50,
  50); preview: guard (third / first person) and the swing frozen at
  frames 11-18.
- Known: headshot hitboxes use the rifle stance's head position (the guard's
  head is close); during the swing the right arm crosses the first-person
  view for ~0.2 s.

## 63. Knife animation fixes (2026-11-07)

Feedback: the left fist showed in first person, the knife looked stuck to
the wrist, the swing was hard to see (not at all running or crouched), and
crouched it went off to the right.

- Left fist: IK'd down by `KNIFE_LEFT_DROP` from the guard's place (following
  the chest), out of the first-person view.
- Icepick grip (`knifeInFist`): the handle in the curled fingers (between the
  knuckles, the fingertips and the palm; the old spot, half way along the
  hand bones, was mid-palm, by the wrist) and the blade out of the
  little-finger side.
- Right arm: no longer the clip's. `holdKnife` IKs the fist along
  `KNIFE_PATH`, keys relative to the eyes and turned with the view (position,
  and the knife's tip / edge directions): the guard low right with the blade
  across the view; a wind-up to the upper right, a diagonal slash out in
  front to the lower left, back to the guard by 0.75 of the swing. The clip
  version swung at about chin height, ~0.2-0.4 m from the eyes, mostly
  below the screen.
- Running / crouched: the boxing clips' upper body sat on the legs' pelvis,
  which leans forward running and turns aside crouching (the crouch clips
  hold a rifle). `uprightSpine` turns the lowest spine bone as in the knife's
  standing idle, so the body faces forward; the rifle's crouch straightening
  is skipped for the knife.
- `VIEW_EYE.knife` [-0.15, -0.02, 0.05].
- Preview: `preview.paused` freezes the animation (for looking at single
  swing frames); `preview.renderer` is exposed.
- Checked in the preview (both genders): guard and wind-up / mid / end of the
  slash visible in first person standing, running, strafing and crouched,
  at pitches -1.2 to 1.2 (same place on screen); third person crouched, the
  slash goes out in front.

Follow-up feedback: the left fist was too stiff, and the keyed slash read as
a stab; keep the original swing, just reach out a little further.

- `KNIFE_PATH` / `holdKnife` removed: the right arm is the boxing clips'
  again. `extendKnife` pushes the fist out along the view by up to
  `KNIFE_REACH` (0.18 m, a sine out and back over the first 70% of the
  swing), IK'd, the hand turned as the clip turns it.
- Left fist: lowered from where the clips put it each frame (not a fixed
  place), so it keeps the guard's bob and the swing's pull-back, plus
  `KNIFE_LEFT_SWAY` (6 cm) forward / back with the run cycle. Measured
  ranges: 5-17 cm; never in the first-person view (lowest edge -0.77, the
  fist's top at most -1.7).
- `VIEW_EYE.knife` [-0.25, 0.03, 0.05]: the guard fist lower right, off the
  crosshair; the swing's fist stays on screen standing, running and crouched
  (the tip dips just below the edge for a moment at the wind-up).

Then: turn the right hand to the right (show the back of the hand and the
blade), which should also make the hook read as a right-to-left slash.

- `KNIFE_TURN`: the fist turned from the clips' about axes in the hand's own
  terms (along it / toward the thumb / out of the back, so the same for both
  skeletons), applied every frame on top of the clip (its motion kept). The
  guard: 1.3 rad, the back of the hand toward the view, the blade out to the
  right. Mid-swing (blended by the same out-and-back curve as the reach):
  0.86 rad about another axis, the blade trailing out to the right,
  broadside, as the fist sweeps left. (Solved from the wanted knife
  direction in camera space at a frozen frame; keeping the guard's turn
  through the hook pointed the blade up and away.) A turn to show the back
  of the hand with the blade down-left would have needed ~160° at the
  wrist.
- `KNIFE_REACH` [up 0.1, out 0.18] m: lifted a little too, the hook's end
  was low.

Then: the wrist was at a harsh angle to the forearm (KNIFE_TURN turned the
hand ~75° at the wrist), and mid-swing the extra turn looked like the wrist
bending down; wanted the knife ~45° to the front and the original sideways
swipe.

- `KNIFE_TURN` replaced by `KNIFE_TWIST`: the forearm is turned about its own
  length (pronation), so the hand keeps the clips' wrist (measured: the
  guard's is only 1-7° off straight). Guard -0.8 rad: the back of the hand
  toward the view, the tip ~45° front right (view space 0.64 right, 0.15
  up, 0.76 forward). Swing -0.2 rad (blended by the reach's out-and-back): the
  blade trails right and a little down, flat toward the view (face 0.45-0.6
  vs ~0.2 keeping -0.8, where it was edge-on).
- `KNIFE_STRAIGHTEN` 0.3: the hook bends the wrist ~48° mid-swing; 30% of
  that taken out (~33°). More (0.6) turned the blade edge-on.
- Reach no longer keeps the hand's world turn (it rides on the forearm, so
  the wrist doesn't change when the arm extends).
- `VIEW_EYE.knife` [-0.25, 0.05, -0.05]: further back, so the fist (very
  close before) doesn't hide the blade.

## 64. Ladder climb facing (2026-11-07)

Climbers faced away from the ladder. main.js already turns a remote avatar
to face it (yaw from the ladder's normal, which points at the climber), but
the Mixamo climb clip itself faces +Z where every other clip faces -Z
(checked in the preview: running forward the body faces -Z; climbing at the
same yaw it faced +Z, hands reaching backward). `convert_assets.py`: TURNED
clips are turned 180° about up when retargeted (bone turns and the hips'
movement). Now the hands reach 0.29-0.43 m forward, onto the rungs (the
climber is held 0.45 m off the ladder's plane). `npm run build:anims`.

## 65. Clock hands (2026-11-07)

The Clock Tower's three faces (N, S, W; the east side has the ladder) get
12 hour ticks (longer at 12/3/6/9), an hour and a minute hand showing 10:10,
and a hub, in a new dark `ClockHand` material (tinted concrete). Built from
`face_bar()` (a bar standing off a vertical face at any angle, visual only)
via `clock(centre, normal, hour, minute)` in district_generator.py. Checked
from outside each face: all read 10:10 the right way round. Rebuilt with
`npm run gen:map && npm run build:map`.

## 66. Central Station / City Hall 2nd floor: staff lounge, windows (2026-11-08)

- `station_lounge()` (district_generator.py, mirrored into City Hall): all
  along the north wall (City Hall: south), z -59.7 .. -54.8, x -22 .. 19, so
  the other half of the floor and both stair heads stay open. Middle: a
  fireplace, rug, coffee table, a sofa facing the fire (its back to the
  room), two armchairs, bookshelves, floor lamps and plants. West: a sofa
  corner (sofa against the wall, rug, coffee table, two armchairs facing
  it), a sideboard. Between: a second sofa. East: a pantry (four counters, a
  fridge, a bin) and two café tables with chairs on round rugs. New PROPS:
  fireplace, sofa (Couch_Large2), armchair (Couch_Small2), rug / rug2 /
  rug_round, coffee_table (Table_RoundSmall2), floor_lamp (Light_Stand1),
  sideboard (Drawer_1). Sofas, armchairs, tables, shelves, fireplace and
  counters are solid; rugs, lamps, plants, chairs aren't.
- Prop turns (rot): 0 faces south, 180 north, 90 east, -90 west (sofas,
  armchairs, chairs, fireplace alike).
- The 2nd floor spawns moved from z -55 to -51.5 / -49.5 (the armchairs
  reach -55.2).
- Windows on the 2nd floor: east and west walls (z -57.3 .. -55.7), and in
  the south wall only in line with the Hospital (x -19.8 .. -18.2) and the
  Bank (17.2 .. 18.8), so the buildings between block any line of fire to
  City Hall's twins (which face the Hotel and the Police Station). Checked
  from inside: the Hospital, the Bank and the Police Station fill them.

Then: windows 5x as wide; two stairs down from the middle of the south wall
(City Hall: north), facing away from each other.

- Windows 8 m wide: east / west z -59.3 .. -51.3 (over the side stairs'
  heads, away from the lounge), south x -23 .. -15 (Hospital) and 14 .. 22
  (Bank). Line of fire re-checked numerically (scratchpad los.py: lines
  between every pair of points across both windows' faces, in plan,
  against the Hospital / Bank / Hotel / Police footprints): none get
  through; the nearest pass the Bank's and Hotel's corners. Those buildings'
  faces toward the bases have no openings at that height.
- Middle stairs: a landing at x -1.4 .. 0.6 on the south wall (z -47.9 ..
  -46.3); flights x -6.2 .. -1.4 down to the west and 0.6 .. 5.4 down to the
  east (4.8 m for 3 m, like the side stairs), in holes in the 2nd floor with
  rails along their open sides. Coming down you face that side's exits
  (the south door, the end door).

Then: east / west windows moved to the walls' middles (z -57 .. -49); the
rugs flickered through the floor in their middles: the House Interior
rugs are mostly flat at their base (Carpet_Round: 70 of 78 vertices at
y 0), level with the floor, so they z-fought. `RUG_LIFT` 1.5 cm on all
rug keys (rug, rug2, rug_round, carpet).

## 67. Hotel (and Hospital): lobby, lounges, guest rooms (2026-11-08)

Built as the Hospital and mirrored, so the Hospital gets the same; the
Hotel's north (canal side) is the Hospital's z -16 side.

- `hotel()` (district_generator.py) replaces the wards (beds, nightstands,
  sinks) and the top floor office.
- Ground floor (lobby): a reception desk of two drawer units (rot 90, 4.6 m
  along the east side by the canal-side entrance), a shelf and the clerk's
  chair behind; a fireplace lounge against the west wall (rug, coffee
  table, sofa facing the fire, two armchairs, lamps); a second sofa group at
  the far end; plants either side of the entrance.
- Upper floors (all four): at the far end a lounge (sofa against the wall,
  rug, coffee table, two armchairs, lamps, sideboard, bookshelf, plants),
  clear of the stairs' ends, the windows and the 3rd floor skybridge door.
  On the canal side two guest rooms (z -20.3 .. -16.3; partition at
  x -19.2 .. -18.9; doors x -25 .. -23.6 and -15 .. -13.6 in a wall at
  z -20.6 .. -20.3, leaving a 1.4 m corridor past the stairs' ends), each
  with a bed, rug, table, chair and bookshelf kept off the paths from the
  door to its windows. The west wall's last window moved from z -21 .. -19.4
  (it would have crossed the room wall) to -19.6 .. -18, inside the room.

Then: bigger plants. `plant` (the cactus, Houseplant_3) scale 0.77 -> 1.7
(~1.4 m); `plant2` Houseplant_1 (0.55 m) -> Houseplant_6 at 1.15 (a big
leafy plant, ~1.1 m tall and wide). Compared the pack's plants side by side
in the game first: Houseplant_8, the tallest, is a sparse bare-twig plant;
2 and 5 are tabletop size; 4 a snake plant. Every plant on the map uses
these two keys, so all of them grew.

## 68. Police Station (and Bank): front desk, waiting area, offices (2026-11-08)

`police()` and `office()` in tools/district_generator.py (built as the Bank, mirrored to the Police Station like every north/south pair).

- **Ground floor:** a front desk of three drawer units along the canal-side wall, with monitors (map boxes, facing the officers), officers' chairs, shelves and a sideboard behind it. Five waiting sofas against the walls, clear of the three doors and the stairs' foot, with a coffee table and plants. An interview table with two chairs beside the stairs.
- **Upper floors (2F, 3F):** five cubicle pods (14 desks, 28 seats per floor). Desks, partitions (1.25 m outside, 1.1 m between desks) and monitors/keyboards are map geometry (`Desk`, `Partition`, `Monitor` surfaces), so they're baked into the lightmap; partitions and desktops collide (cover), monitors don't. Aisles are kept to the windows, the stairs' landings (2F north end, 3F south end) and the 3F skybridge door. A meeting table, filing drawers, shelves and plants along the walls.
- Follow-up: too crowded, so the office was cut to three pods (one of three desks a side, two of two: 14 seats per floor) with 2.5–4.5 m aisles between them.

## 69. Construction site: modern drums and blocks (2026-11-08)

The barrels ('barrel', the SciFi kit's Prop_Barrel_Large) and the blocks ('crate2', Prop_Crate4) wore the kit's sci-fi trim sheet. PROPS entries now take an optional 4th field, a SURFACES material: `retexture()` in tools/district_generator.py box-projects UVs onto the model (a tile per the surface's metres per tile) and swaps in that one material. 'barrel' uses `Drum` (concrete, painted orange) and 'crate2' uses `Block` (plain concrete). Every barrel on the map uses the same key, so the Warehouse's and the canal's changed too.

## 70. Subway entrance: room round the stairs' head (2026-11-08)

The entrance building's stairs start at its west end, and the west wall stood right against their head, so from the north and south doors the stairs' low walls blocked the way in (you had to jump them). The building's west wall moved 2 m out (x -24 → -26: the shell, the roof slab and the zone), leaving a 2.5 m walkway between the stairs' head and the wall's door.

## 71. Police cars by the Police Station; first-aid case heal pack (2026-11-08)

- The SUV and the orange sports car parked beside the Police Station (on Main Street) are police cars now; their spots beside the Bank keep the SUV and the sports car (props_north places each pair unmirrored).
- Heal packs: the Survival Pack's white first-aid case (`FirstAidKit_Hard.obj`) instead of the canvas-textured box. `build_medkit()` in tools/convert_assets.py writes medkit.glb (0.6 m wide, MEDKIT_WIDTH, origin at its middle, colours baked to vertex colours); it's built with the weapons (`npm run build:guns`), loaded as `assets.medkit` and cloned by `makeHealPack()` in render.js.

## 72. Hospital and Bank get their own furniture (2026-11-08)

Until now the Hotel's furniture was mirrored into the Hospital and the Police Station's into the Bank. Now only the plan is shared: walls (incl. the guest/patient room walls), doors, windows, stairs, the office cubicles and the counter's monitors (map geometry, still mirrored). The furniture is placed per building:

- `south()` / `north()` place a prop on one side only (south() takes north-half coordinates and mirrors them). `hotel()` and `police()` now use south(); the new `hospital()` and `bank()` use north().
- **Hospital:** the reception desk where the Hotel's is, two rows of waiting chairs, an examination corner (two beds between curtains, sink, medicine shelf and drawers). Upper floors: a ward of four beds along the north wall with curtains and nightstands, a nurses' desk; the canal-side rooms are patient rooms (two beds / one bed, sinks, visitors' chairs), clear of door-to-window paths.
- **Bank:** a teller counter in the police desk's place (tellers' chairs, sideboards behind), benches (`couch2`) against the walls, two writing tables in front of the queue, an advisor's table. Upper floors: filing drawers, a client sofa corner between the canal-side windows, a bookshelf, plants.
- New PROPS key: `curtain` (Curtains_Single).
- Cover differs a little between the twins now (the solid furniture isn't in identical spots).

### 73. Hospital waiting area, reception monitors
- Hospital ground floor: the exam corner and the waiting chairs are gone; it's a patients' waiting area of sofas (four along the north wall, three on each side wall clear of the doors, two back-to-back pairs in the middle), with plants and a bin. The reception desk keeps its two chairs and the shelf behind it.
- Reception monitors: two `r.box` monitors on the reception desk (x −14.15, z −19.9 / −21.2, facing the clerks) in north_half, so the Hotel's front desk gets them too.

### 74. Warehouse north door
- The rack at x 37.3 stood in the Warehouse's north door (x 35 .. 39) and, mirrored, the Factory's south door; removed. The one at x 33.5 stays.
- (Follow-up) The last rack (x 33.5) removed too: the Warehouse and the Factory have no shelves.

### 75. Market stalls
- Counters ('Stall'): wood, from the top (plank) band of the Medieval kit's T_WoodTrim sheet, repeated 4x into maps/textures/wood.png (texture('wood')). The Market Hall's counters share the material, so they're wooden too.
- Awnings: ten 0.4 m strips alternating 'AwningRed' / 'AwningWhite', each a `tilted()` slab (new primitive, mirrored in mirror_call) sloping from 2.95 m at the wall to 2.5 m at the alley edge.
- Produce: one category per counter (alley: fruit / fish / vegetables; hall: vegetables / bread downstairs, fruit / fish upstairs). food_on() gives each kind a share of the counter and places a loose patch at a random size and spot in it, random turns, seeded per counter (same every build); round fruit (PILED) heaps up in up to 3 layers, each one above resting on two below. Hall food is now mirrored=False (it was placed twice over, mixing the two counters' kinds).
- Props went from 339k to 401k triangles (still 11 draw calls).

### 76. More Market Hall stalls
- Six more counters per floor (1 m high, wooden, own produce), clear of the doors, stairs, windows and the café. Ground floor: along the north/south walls west of the doors (x 31.6..34.2), either side of the aisle from the west door (x 33.5..36.5, z ±1.4..2.4), by the stairs (x 38.8..40.8, z ±4.8..6). Upstairs: either side of the middle (x 33..35.5) and by the stair heads (x 38.6..40.6) at z ±1.4..2.4, along the north/south walls (x 35.2..38.2). The Market Hall now has 8 counters per floor.

### 77. Pickup spots
- Weapon: Hospital/Hotel 4F -> their ground floor (-14.5, ∓29.5, clear of the sofas in both).
- Warehouse/Factory: the catwalk weapon is a heal pack now; the roof money is gone.
- Money round the centre (unmirrored): subway concourse (-7, -4.5, 2.5, between the pillars), Clock Tower ground floor (1.2, 0, 0), on the fountain platform (-6, 0.9, 0), on the plaza between the two subway stairs (6, 0, 0). With the tower top and crane cab: 6 money spots, all in the centre row.

### 78. Gun hold point regression (P90 sat back)
- calibrateGrip's rest grip point (gripRest[...].grip: where holdGun puts the gun's grip point) used to be the hand's centre: `centre.sub(grip)` changed centre in place and the later `centre.add(grip)` undid it. The knife work made the first a clone (knifeInFist needs the centre), so the second moved the point by the set's rightGrip: 7 cm down and back for the rifle set (most visible on the bullpup P90), 3.5/4 cm for the pistols. Now `centre.clone()`, as before.

### 79. Landmark signs, Clock Tower ladder, Subway roof money
- signs() (called from centre_row, not mirrored): the Hospital's red cross and the Hotel's "HOTEL" in the window-free column above their canal-side doors (x -23.4 .. -16), the Bank's gold "$" in the column x 16.6 .. 20 of its south wall, "★ POLICE" (gold star, white letters) along the Police Station's north wall below its first windows (y 1.3 .. 3.3). All on the walls facing the centre.
- New primitives: face_poly (a convex shape standing off a wall), arc, GLYPHS (stroke letters H O T E L P I C $ in a unit box), stroke (a polyline as mitred pieces sharing edges), sign_text, star. Overlapping pieces in one plane bake dark (each shades the other): the first version, bars with overlapping caps, came out with dark curves and a dark centre in the cross. Strokes are now non-overlapping strips; strokes that cross stand 2 cm further out each; the cross is one upright bar plus two arms that touch it.
- Clock Tower: the ladder is on the west wall (plane x -2.2, facing +x) under the balcony opening; at the top you step on through the opening onto the balcony. The free-standing ladder and its backing plate are gone; a rail closes the hole's east side at 14 m.
- Money: the Clock Tower ground floor spot moved to the Subway entrance roof (-20, 4.3, 0).

### 80. Boundary top, skyline gaps
- Players could stand on the boundary blocks' top edge (their radius overlapping it at the play-bounds clamp). Each block now has an invisible players-only box (COLP, like the rails) from its top to 80 m, so there's no edge to stand on; bullets are unaffected.
- Skyline (render.js): the rings (nearest ~94 m out) left the rectangle's long sides open. Added a seeded row of blocks 9-17 m beyond each side's boundary blocks (every ~13 m, 13-24 m tall, point-symmetric like the rings).

### 81. Wider knife swing, bigger hit area
- Animation (character.js extendKnife): on top of the hook clip and KNIFE_REACH's push out, the fist's IK target sweeps sideways by KNIFE_SWEEP (0.28 m) * sin(2πu): out to the right in the first half of the swing, across to the left in the second, 0 at both ends (no pop out of / back into the guard). KNIFE_REACH [0.1, 0.18] -> [0.12, 0.3] (up, forward).
- (Follow-up) To the left edge of the view by turning the upper body, not by reaching: KNIFE_TURN [right, left] = [0.25, 1.1] rad about up (the same sin(2πu) curve: right on the wind-up, left on the follow-through), 40% in the abdomen and 60% in the torso, the neck turned back the whole amount so the head keeps looking ahead. Done first in extendKnife, so the forearm twist and the reach IK ride along. The sideways push is back to 0.28 m each way. (A first try pushed the fist 0.8 m left and pulled it back toward the camera: the arm, straight there, looked stretched across the view.)
- (Follow-up 2) Less far out front, no stretch: KNIFE_REACH [up, forward] = [0.2, 0.12] (was [0.12, 0.3]); the reach IK target is kept within KNIFE_ARM_MAX (90%) of the arm's length from the shoulder, so the elbow never locks straight; KNIFE_TURN left 1.1 -> 0.8 (the closer fist needs less turn to reach the left edge; with 1.1 the forearm swept low across the camera). Knife range back to 2.0 m, then 1.6 m (SWING_ANGLE stays 0.9 rad).
- Hit area: knife melee.range 2.0 -> 2.5 m (shared.js; bots close to this range before swinging); host SWING_ANGLE 0.6 -> 0.9 rad (~35° -> ~52° either side of the aim). SWING_HEIGHT (1.4 m) unchanged.

### 82. Scope ring, Overwatch-style hit markers, hit sounds
- Sniper scope: a red ring (3.6vmin, 2px) in the middle (#scope .ring); the scope's black cross lines are gradients that stop 3.2vmin from the centre, so nothing crosses into the ring.
- Hit markers (#hitmarker: two inline SVGs, shown by class): body = small white X (four diagonal wedges, sharp toward an empty middle, 22px), head = bigger red X (34px), kill = red skull (30px, pops in from 1.6x), blocked (spawn-protected) = grey X. Shown 140 / 200 / 500 ms. (Was a diamond: red / gold / bigger red.)
- Hit sounds (audio.js, synthesised, our own hits only, not positioned), built on knock(): a tuned "tok" (two tones, ~14 ms, e.g. 1.05 / 1.58 kHz) with a tiny 4.2 kHz click on its attack, over a low thud dropping in pitch (300 -> 110 Hz). hitHead: a higher tok plus a metallic tink (3.2 / 4.48 / 5.76 kHz, 50 ms); hitKill: a heavier thud, an 85 -> 45 Hz boom and a short ring. No noise anywhere (a noise smack sounded like the gunshot; before that, plain sine ticks didn't sound like a hit). Volumes 0.3 / 0.36 / 0.45 (tried 0.95 / 1.05 / 1.15, 0.6 / 0.68 / 0.78, 0.5 / 0.57 / 0.65; back to these, now with the longer tok), the tok ~24 ms, pitch spread 0.1 / 0.06 / 0.04. Not for blocked hits. Played from main.js's 'hit' handler with the marker.

### 83. Knife head hitbox
- headCenter (shared.js) had two holding styles, rifle and pistol; the knife fell back to the rifle's (head to the right, cheek on the stock), so its head box sat ~17 cm right of and up to ~19 cm in front of the drawn head (36 cm off strafing): headshots mostly missed the knife, which everyone spawns with. Added a knife style (HEAD_STYLE.knife, CROUCH_STYLE.knife) with its own arc (arm, tilt, follow, pivot) and leans, fitted to the knife guard measured in the browser (head = midpoint of the Head and Head_end bones, over pitch -0.9..0.9 and the four move directions): within ~3 cm standing and moving, <1 cm crouched. The gun styles measured within ~5 cm (unchanged).

### 84. Hit sparks
- On every 'hit' (not blocked, not when we're the victim), main.js calls renderer.hitSparks(victim, from, hs): at the avatar's head (headshot) or torso, pushed 10-15 cm toward the shooter (msg.from: the shot's origin, already in the message), Tracers.addHitSparks draws a flash (80 ms) and 9 (body) / 14 (head) spark sprites thrown out round the direction to the shooter, a little upward, 1.5-4.5 m/s, falling (9.8 m/s²), shrinking and fading over 0.16-0.3 s. Additive star sprites like the impact spark; flash and sparks grow with distance (1 + 0.06 per m) so they still read far off; depth-tested (not seen through walls). Everyone sees them, the knife's hits too.

### 85. No-clip: boundary distance, underground walls
- No-clip clamped the player to the play bounds, which are the boundary blocks' inner faces: the camera got into the blocks. keepInside / clampXZ take a margin; no-clip keeps NOCLIP_EDGE (0.8 m) inside. (Walking normally, collision already keeps the radius off them.)
- Below ground level (feet < -0.05: the canal, the subway), a no-clip step is only taken where there's a floor within NOCLIP_FLOOR_SEARCH (8 m) below (World.floorBelow: the first surface hit going down must face up, so not the underside of a wall block we're inside); else it slides (x only, then z only) or stops. Before, walking through the canal's / concourse's walls left the player over solid earth with no floor: they fell to -8 and were put back at y 1. Tested: the canal stops at its walls' inner faces (x -31 / -40), the concourse at its walls, the canal ramps and the subway stairs to Construction still climb, walking through buildings above ground unchanged.

### 86. Triggerbot hack
- HACKS gets { id: 'trigger', price: 1200 } between HP ($1,000) and Aim ($2,000) (the list is by price; the mask's bits after it moved up one, fine since host and clients share the list). i18n en "Triggerbot", ko "트리거봇"; README table.
- Client only (main.js): tryShoot's trigger counts as pulled while has('trigger') and crosshairOnEnemy(w): the view's centre ray (before spread) reaches an enemy's hitbox (rayPlayer, head or body) before any wall (world.raycast); with the knife, only within melee.range. Everything else in tryShoot still applies (cooldown, ammo, reload, weapon switch, mouse captured). Semi-automatic guns fire at their cooldown while on target. The host needs nothing (hacks are just a bought mask).
- Tested in a match with a frozen enemy bot: aimed above it, no shots; crosshair on it, 4 rifle shots and a headshot kill; behind a wall, no shots. (Firing needs pointer lock, which the browser automation can't get: the test overrode document.pointerLockElement in the page.)

### 87. Rapid-melee hack
- HACKS gets { id: 'melee', price: 800 } between Fly ($700) and Wall ($900) (the later bits moved up one again). i18n en "Rapid-melee hack", ko "연속 근접 핵"; README table.
- fireCooldown: a melee weapon with the hack cools down RAPID_MELEE as long: 0.1, the knife 0.6 s -> 0.06 s (~16 swings/s, normal damage each: 50, 100 from behind; ~800 damage/s; first 0.15, made 10x on request). The client's tryShoot and the host's onShoot both use fireCooldown, so the host accepts the faster swings. The knife is already auto (swings while the button is held).
- Animation (character.js): enemies' hacks aren't sent, so a swing that starts sooner than SWING_TIME after the last plays in the time since it (swingTime, at least SWING_TIME_MIN 0.05 s): the clip's timeScale, the swing blend and extendKnife's reach / sweep / torso turn all use swingTime. Normal swings are unchanged.
- Tested (frozen enemy bot 1.2 m away, 200 HP, button held): normal knife 4 swings, killed in 1.84 s; rapid-melee 4 swings, killed in 0.30 s.

### 88. Fake-lag hack
- HACKS gets { id: 'fakelag', price: 1500 } between Triggerbot ($1,200) and Aim ($2,000) (the later bits moved up one again). i18n en "Fake-lag hack", ko "페이크 랙 핵"; README table. shared.js: FAKE_LAG_GHOST = 1 s, FAKE_LAG_REVEAL = 1 s.
- Host: per player ghost / ghostAt / revealUntil. updateFakeLag (each tick): a live fake-lag player not revealed gets an afterimage of their pose ({ pos, yaw, pitch, crouch, weapon }) every FAKE_LAG_GHOST s; anyone else none. revealFakeLag (onShoot: a knife swing, or a shot actually fired): the afterimage goes, revealUntil = now + 1 s, the next afterimage when it ends. Snapshots carry, for a fake-lag player, fl: 1, rv (revealed), g (the afterimage) to everyone. apparent(q): where others see q, { pos, pose } (the afterimage while hidden; null with none yet). The real hitbox is unchanged: shots at the real (invisible) player still hit, shots at the afterimage do nothing.
- Bots (bots.js) see, chase, aim at and judge range by apparent(): fooled like the hacks.
- Client: Character.setFade(alpha) / applyFade: 0 hides the model, shadow, label and shield; in between draws with per-character transparent copies of the (shared) materials, made the first time each mesh is seen (guns are made later: setWeapon re-applies). renderRemotePlayers: hidden (fl and not rv): enemies fade 0 (avatar.fakeHidden = true), teammates 0.5; revealed 1. Renderer.updateGhost / removeGhost: the afterimage is a second Character (isGhost), solid, its name shown to enemies only; removeAvatar / clearAvatars remove it. Our own: the first-person body at 0.5 while hidden, our afterimage drawn too.
- Hacks go by the afterimage (apparent(id, avatar) in main.js): the aim hack's head target, the triggerbot's ray, the wall hack (fakeHidden avatars off its layers, enemy afterimages on, own team's off) and the map hack's dot. Footsteps, gunshots and hit sparks stay at the real player.
- Tested (enemy bot with fake-lag, afterimage frozen 2.4 m beside it): real body hidden, afterimage solid with the name; triggerbot on the invisible real body 0 shots, on the afterimage 3 shots and no damage; the bot attacks: real body shown, afterimage gone; triggerbot on it then fires and hits. Teammate view: real body half see-through. Own view: arms and gun half see-through, own afterimage drawn.
- (While adding setFade, a script edit cut out every Character method between update() and dispose() (straightenSpine .. updateGunMagazine, incl. this session's uprightSpine / extendKnife / lowerLeftHand). Restored from an open tab's in-memory module (Function toString), with their comments from HEAD and this session's transcript; every method's source hash then matched the pre-break module except the intended changes.)
- (Follow-up) See-through to self and team: 0.5 standing down to 0.2 at full speed (seeThrough(speed) in main.js, rounded to 0.05 so the materials aren't redone every frame; teammates by their drawn velocity, us by me.vel over the speed hack). Our own afterimage isn't drawn within OWN_GHOST_HIDE (1.5 m) of us: standing still it covered the camera. Enemies still see it.
- (Follow-up 2) OWN_GHOST_HIDE 1.5 -> 0.5 m. Knife moveSpeed 1.12 -> 1.25 (the host doesn't cap speed; bots use it too).

### 89. Wallbang hack
- HACKS gets { id: 'wallbang', price: 1100 } between HP ($1,000) and Triggerbot ($1,200) (the later bits moved up one again). i18n en "Wallbang hack", ko "월뱅 핵"; README table.
- Host onShoot: with the hack each shot (pellet) is traced against players out to MAX_RANGE, walls ignored, full damage; a miss still ends at the first wall (the tracer stops there). onSwing: the knife's wall check is skipped. Every gun and the knife.
- Our client: the instant tracer goes through to the player it hits, with an impact spark where it enters the wall (Tracers.addImpact, split out of add). Others see the host's end point (through the wall), no entry spark.
- The aim hack and triggerbot still need a clear line of sight (unchanged).
- Tested (enemy bot 2 m behind the spawn room wall, rifle held 0.5 s): no hack 4 shots, 0 damage; wallbang 4 shots, 100 damage; wallbang + triggerbot with the crosshair on it: no shots. (The knife through a wall wasn't tested.)

### 90. Smoke bomb
- Animations: Mixamo "Throw Grenade" and "Run And Throw Grenade" (fbx/Character Animation), converted as throw (frames 35-70) and throw_run (33-62): just the throw (the hand fastest at 57 / 52), the pin and aim before and the settling after dropped. npm run build:anims.
- shared.js: SMOKE (cooldown 20 s, fuse 1.5 s, radius 4 m, duration 8 s, grow 1 s, fadeOut 0.6 s, rise 1.2 m (the cloud's centre above the bomb), throw 13 m/s + 2.5 m/s up, bounce 0.4 / friction 0.6, size 0.06 m), THROW_TIME 0.7 s, THROW_RELEASE 0.63; smokeRadius(age), smokeCentre(pos), smokeBlocks(smokes, a, b, now) (segment within a cloud's radius).
- World.stepGrenade(g, dt): gravity, BVH ray along the velocity, reflect off the hit face (bounce across, friction along), rest on a floor once slow; host and clients run it alike.
- Host: smokeAt per player (0 on spawn: everyone spawns with one), holdingSmoke from the 'state' message (s). onThrow ('throw' {yaw, pitch, m}): if ready, cooldown starts, broadcast 'throw' (others play the throw), a grenade released THROW_TIME * THROW_RELEASE later from the eye (not through a wall in front) -> 'nade' {id, p, v}; updateGrenades steps it and after SMOKE.fuse -> 'smoke' {id, p, d}; clouds kept for their duration, in snapshots as sk [{id, p, age, d}] (late joiners), players' sm (holding) and sc (seconds to ready). Bots: canSee fails through smoke (HostServer.smokeBlocks). Cleared on a new round.
- Character: GUNS.smoke (set 'knife': held in the fist like the knife, its guard pose), makeGun('smoke') = effects.makeSmokeBomb (grey canister, dark cap and ring); state.smoke shows it instead of the weapon; throwSmoke(moving) plays throw / throw_run on the upper body (THROW_WEIGHT), easing off the knife guard, extendKnife and lowerLeftHand meanwhile; the bomb is hidden from the release.
- Effects: Smokes (renderer.smokes, made in setMap): bombs in flight (stepGrenade, spinning, bounce sounds) and clouds: 36 lumpy grey puff sprites spread through a flattened sphere, swelling over SMOKE.grow, thinning with smokeRadius at the end.
- Client (main.js): C toggles smokeHeld (on cooldown: the icon shakes, the weapon stays); a click while held throws it (not the triggerbot), back to the weapon after THROW_TIME; switching weapons or dying puts it away. Cooldown from the snapshot's sc (our own throw counts at once). smoked(a, b): the aim hack skips heads through smoke, the triggerbot doesn't fire through it, enemy (and their afterimage's) names hidden through it. HUD: #smokeIcon left of the ammo (ready / held: gold / cooling: shaded conic sweep and seconds; .shake), #smokeView greys the view by how deep the eye is in a cloud. Sounds: the throw (swing), bounces (boltBack, higher), a synthesised hiss when it pops. i18n weapon.smoke (Smoke bomb / 연막탄); README.
- Tested: C takes it out (canister in the fist, HUD "연막탄", icon gold); a click throws (throw clip, the bomb flies, bounces, pops into a cloud 1.5 s later; back on the knife; icon counts down from 20); C while cooling shakes the icon; triggerbot on an enemy 10 m away through a cloud: no shots, and a bot there can't see through it; in clear air 4 shots, 100 damage.
- (Follow-up) Icon moved above the money (bottom 170px). SMOKE.radius 4 -> 6, grow 1 -> 0.3 s with an ease-out-cubic burst (puffs from 10% out, 25% size; puff size scales with the radius; 48 puffs), throw speed 13 -> 18 m/s. Cloud grey given in sRGB (as a linear colour it came out near white).
- Holding: a new clip throw_hold ("Throw Grenade" frames 19-25: the grenade held in front of the chest before the pin) replaces the knife guard while the smoke bomb is out (smokeHold blend; the knife's extendKnife / lowerLeftHand off meanwhile); the canister drawn 1.25x. First person: holdSmokeInView IKs the right hand to SMOKE_IN_VIEW (0.19 right, 0.13 down, 0.34 ahead of the camera), else the chest-height hold was out of view.
- Trajectory: while held, main.js predictThrow() runs the host's release (eye, not through a wall in front, the same velocity) through World.stepGrenade at 1/60 s up to the fuse; drawn from the bomb in hand easing into that path over its first 0.4 s (seen from behind, the path alone was a vertical line). Renderer.setTrajectory: a camera-facing red ribbon (wider with distance) and a red ring where it pops.
- (Follow-up 2) Icon above the hack names too (bottom 192px; #hackName at 166px covered it). SMOKE.radius 6 -> 7. throw_hold held still on its first frame (timeScale 0): looped, its 7 frames jolted (measured after: the first-person hand moves 0 mm per frame standing). The trajectory ribbon and ring draw over everything (depthTest off, renderOrder 20): after a bounce the path runs along the floor, which hid it (the prediction went on through the bounces all along; the path itself stops at walls).
- (Follow-up 3) Triggerbot fired through a fading cloud: smokeRadius shrank over the last fadeOut while the cloud still looked solid. Now it blocks at full size until the moment it's gone (7.99 s yes, 8.0 s no); only the look fades (effects: opacity by (duration - age) / fadeOut).
- Facing left while holding: throw_hold's spine is already turned into the throw. Now only its right arm (RIGHT_ARM mask) is used, with an IK (holdSmoke) putting the right hand at SMOKE_HOLD (0.17 right, 0.08 up, 0.32 ahead of the chest, character space; the clip's arm on an upright body put the hand across the face) and the left fist down by the chest (lowerLeftHand, as with the knife). The upper body stays upright and forward.
- (Follow-up 4) A cloud stayed in view ~2 s after it stopped blocking (another player's screen): the clouds aged by frame dt (capped at 0.05 s per frame, and nothing while a tab's in the background) while blocking (main.js smokes) goes by the clock. Clouds now age by the clock too (born time), so the look and the blocking end together everywhere.
  Cleared clouds' ids are remembered (smokesDone) so the host's next snapshot, which may still list one for a few ms, doesn't add it back; both lists are emptied on leaving a room.

(Follow-up 5) Teammates' name labels were drawn last (renderOrder 999, no depth test) so they showed on top of smoke; they now draw at renderOrder 4, after the window glass but before the smoke puffs (5), and labels no longer write depth. Holding the smoke bomb, the throw_hold clip's wind-up left the right elbow at shoulder height; after the hand IK, `swingElbow` turns the upper arm around the shoulder–hand line so the elbow points toward SMOKE_ELBOW (down and out from the chest), hand unchanged (elbow ~0.24 m below the shoulder instead of ~0.01 m).

(Follow-up 6) The throw clips turn the upper body ~40-58 degrees left through the whole throw (shoulder line vs the facing; a side-on thrower), so throwing looked like facing left: `squareThrow` turns the abdomen/torso back right by THROW_TURN (32 degrees, × throwBlend), neck countered so the head stays forward; now ~8-26 degrees standing, and the running throw winds up right (+14) and follows through left (-24). Inside a smoke cloud only players right up close showed (each puff at 0.95 opacity filled the view, plus a 0.9 grey tint): the puffs near the eye now thin out (distance / puff size from SMOKE_NEAR [0.35, 1.3], down to SMOKE_NEAR_MIN 0.06), only while the eye is inside the cloud (outside, by the edge, it stays solid), and the tint is at most 0.3. A player 4 m away shows; 7 m away is lost in the smoke. (Visual only: hacks still go by smokeBlocks.)

(Follow-up 7) Seeing inside smoke shortened: SMOKE_NEAR [0.28, 1.0], SMOKE_NEAR_MIN 0.08, tint up to 0.38. A player 3 m away shows through haze; 4.5 m away is lost.

(Follow-up 8) Shortened again: SMOKE_NEAR [0.22, 0.8], SMOKE_NEAR_MIN 0.1, tint up to 0.45. A player 2 m away shows through haze; at 3 m only a faint silhouette.

(Follow-up 9) Korean: 칼질핵 (rapid-melee), 월샷 (wallbang). Buy menu 980 px wide, hacks in two CSS columns (price order down the first, then the second), all in view without scrolling. The host's bot setting moved up under the money as a highlighted row of buttons (Off / 1 vs 1 ... 4 vs 4, `#botFill` buttons with data-n, `showBotFill`) with a one-line hint, instead of a small select at the bottom.

(Follow-up 10) The victory hack is marked as the game's goal in the buy menu: label[data-id="victory"] in gold (border, gradient, slow glow), a 🏆 and a "GOAL" / "게임 목표" tag (buy.goal), less dimmed while unaffordable; its description now says to save up for it.

(Follow-up 11) Sky cover for the fly hack (district_generator.py `balloons()`, after centre_row; not via the Recorder, each half placed directly): per half an ad blimp (`blimp`: 21 m capsule along x at (0, 17.5, ∓26), flat sides carrying "HACK COLA" (new glyphs A, K, space), red tail fins at +x, dark gondola) and a hot-air balloon (`hot_air_balloon`: envelope R 3.6 at (-35.5, 18.2, ∓28), 16 gores, North blue/white, South red/white; flat crown at 21.68; wooden basket floor at 9.6 with 1.1 m walls; ropes and burner visual only). `solid()` winds a convex solid's faces and puts them in COL. Verified: standing on the blimp top (20.6), the crown (21.68) and in the basket (9.6), both halves; raycasts stop at the hull / envelope / basket walls (so the aim hack and triggerbot don't see through them).

(Follow-up 12) Blimps reworked: an ellipsoid 15 x 5 x 4.8 m (rounder, smaller), built in local space and turned (`yaw`), at (28, 20, ∓14) over Market Alley where the cross street meets it, turned ±18° (a V, not side to side); the ad's letters are placed one by one flat on the hull's equator, facing its normal. Hot-air balloons moved together to (-30.5, ∓11.5), by the canal at the Bridge Street planters. Verified: standing on the blimp tops (22.4), crown (21.68), basket (9.6); raycasts stop at both.

(Follow-up 13) Blue's blimp: "HACK SOJU" with text and fins in SignBlue (new glyphs S, J, U; `blimp(..., text, mat)`); Red's stays "HACK COLA" in red. Hot-air balloons raised: envelope centre 20.5, crown 23.98 (the fly ceiling is 25 m for the feet: you can fly over it and land), basket floor 11.9. Verified landing on both crowns and in the basket.

(Follow-up 14) The gun shook in the air with the pistol and revolver (the pistol set): their mid-air clip, pistol_jump_loop, is the Jump clip's apex, frames 8-10, only 0.067 s long; looped, it flicked between two different poses ~15 times a second (the gun jumped up to 21 mm a frame), all the time while flying. Now held on its first frame (timeScale 0, as throw_hold). Measured hovering with the fly hack, before and after 5 shots: 0.0 mm. (The rifle set's jump_loop is a real 1 s loop: steady.)

(Follow-up 15) The real cause of the gun shaking in flight: three.js's PropertyMixer only writes a bone when its blended value differs from the previous frame's. In the air the jump loop holds still for stretches (and the pistol's is frozen), so the mixer skipped the bones and last frame's procedural changes (the aim's spine split by pitch, IK, the feet fix) stayed and were applied again on top: looking up or down while flying, the abdomen curled further every frame (head 1.45 -> ~0.7 m above the body), placeEyes pushed the body to keep the eye on the camera, and the gun swung up to ~50 cm a frame, then snapped back when the clip moved. Shooting made it likelier only because you aim while shooting. Fix in Character.update: every bone's local quaternion/position is restored to the clips' last output (`cleanPose`, saved right after mixer.update) before the mixer runs. Measured hovering at pitch -1.2..1.2 with the pistol, revolver, rifle, P90 and sniper: 0-0.3 mm per frame (was up to 530 mm). On the ground the aimed gun moves ~2 cm compared with before at small pitches (the old pose had small leftovers there too).

(Follow-up 16) The crane's neck: the mast top (20-21.5 m) floated 2 m over the cab deck. Now a lattice between them: four 0.12 m corner posts (x 22.46 / 23.54, z ±0.54), top beams above head height, X braces (face_bar, visual) on the two z sides with players-only walls behind them; open toward the ladder (+x) and the far side, in line with the ladder's landing, so you walk from the ladder straight through it onto the deck (0.96 m between posts, 2 m clear). Verified: walking from the landing (x 23.8) to the deck's far rail (20.4); sideways stops at the braced sides.

(Follow-up 17) Bots use hacks (bots.js): after the weapon, `pickHacks` buys random hacks that suit it (GUN_HACKS / KNIFE_HACKS: no fly, no-clip or victory) with the money left, up to the room's limit (HACK_SLOTS 3 with none), each slot filled with HACK_CHANCE 0.6. HP, infinite ammo, rapid melee, wallbang and fake-lag work through the host as for players; the bot code adds speed (stepPlayer speed / jumpHeight), recoil (spread x RECOIL_HACK), aim (always the head, AIM_HACK_ERROR 0.3, AIM_HACK_SETTLE 0.2 s), triggerbot (TRIGGER_REACTION 0.06-0.14 s), wall (ignores facing and smoke; fights through walls with wallbang, else hunts the nearest enemy, as with the map hack) and wallbang (keeps firing WALLBANG_MEMORY 1.5 s at a target gone behind cover). The host's toggle "Bots use hacks" (#botHacks in #botRow, localStorage hackfps.botHacks, message {t:'botHacks', on}, BotManager.setHacks): off also strips the bots' current hacks. Verified in Chrome, 4v4: bots bought hacks within the 2-hack limit over three respawns at $3,000, no errors in 40 s of play with speed / wall+wallbang / aim+trigger / map bots (none stuck), toggle off cleared hacks and HP 1500 -> 200 and kept respawns hack-free.

(Follow-up 18) Game modes and the main menu. shared.js `MODES` (normal / melee / headshot: weapons, hacksOff, killTarget 50, headshotOnly, hp 1) with helpers weaponAllowed, weaponPrice (set weapons are free), startWeapon, hacksOffMask. The host gets `mode` (HostServer option; sent in 'welcome'): onSpawn rejects other weapons and off hacks; weapon spots refill to -2 (off: the renderer hides the ring, the minimap skips it); onWeapon (Admin) only allowed weapons; headshot mode: a hit only counts when it's a headshot, everyone's maxHp is mode.hp; `teamKills` per round (snapshot `tk`, reset by newRound) and teamWins() at the target (victory message with `kills` instead of `by`; feed 'teamWins'); victory() and teamWins() share endRound(). Bots: the mode's weapon, its hacks minus the off ones, always at the head in headshot mode. Client: buy menu shows off weapons / hacks greyed with "Off in this mode" (Victory without its gold), a yellow rules line, `kills / 50` scores, the mode in the room info; Admin switching only in normal mode. Main menu: Join / Create tabs (#menuTabs; Join first, and always from an invite link; last tab remembered: hackfps.tab), the Create tab has mode cards (#modeCards: icon, name, description, hacks off; hackfps.gameMode) and Hacks per life (#hackLimitPick, hackfps.mode as before), the panel widens for it. Verified in Chrome: menu both tabs; melee 4v4 (weapon spots off, bots knife-only with allowed hacks, buy menu), win at 50 kills and the reset next round; headshot 4v4 (body and leg shots absorbed with no damage, 20 s of bot play: 6 hits and 6 kills, all headshots, everyone 1/1 HP; HUD HP 1, rifle); a second tab from the invite link opens on Join and gets the mode, rifle and rules.

(Follow-up 19) Spawns turned 45°: from straight ahead (Blue south, Red north: the hall's middle wall 5.2 m away) to the more open diagonal, the middle two towards the centre (`spawn(x, y, z, turn)`, turn + = towards +x; the empty's rotation pi + turn for Blue, -turn for Red). Clear view ahead at eye height now 42.4 / 7.4 / 7.4 / 25.5 / 43.8 / 41.0 m (x -14 / -5 / 4 / 13 / -20 / 18), the same for Red. district_meta.json patched to the same yaws without a map rebuild; the next `npm run gen:map && npm run build:map` writes them from the generator.

(Follow-up 20) Cars collide along their shape: each car was one box as tall as its highest point, and the SUV's (1.55 m) was above the jump (1.22 m, plus the air step-up), though its bonnet is at ~1.0 m. Now `car_profile` (load_prop, Realistic Car Pack models) takes the highest point in each of CAR_SLICES 20 slices along the length (each cut: the higher of the two slices beside it), and `place` builds a prism per slice with a sloped top between the cuts (bonnet, windscreen, roof, boot; steepest ~42°, walkable). The map was rebuilt (collision 57 -> 64 KB). Verified with World.stepPlayer: both SUVs: jump onto the bonnet (0.96), stand, walk up onto the roof (1.50) without jumping; from the boot end a jump lands on the rear slope (1.37) and walks up; walking without a jump stays blocked. Normal car, taxi, police car, sports car: jumped onto from both ends (1.14-1.31).

(Follow-up 21) Jump pads. Generator: `jumppad(x, y, z, h, r=0.9)` (mirrored): a 0.08 m disc (Rail rim, collision) with a cyan 'Pad' top (visual), and map_meta `jumppads` [{p: top centre, r, h}]. Placed at (8.5, 0, ∓23), h 12 (Main Street by the Bank / Police Station west wall; the parapet top is 10 m) and (-32.2, -2.5, ∓12), h 4.3 (canal bed by its east wall). World.stepPlayer: grounded within r of a pad (feet -0.1..0.3 m from its top), not climbing or flying: vel.y = sqrt(2 g h), and `player.launches` counts up. Client: on its own launch plays 'pad' (synthesised `launch`: a falling thump under a brightening whoosh) and sends {t:'pad'}; the host checks they're near a pad and broadcasts {t:'pad', from, p} for the others' positional sound; bots' launches too (Bot.update). Renderer: three additive cyan rings per pad rising 2 m every 1.2 s. Verified (stepPlayer): Main Street pads reach 12.0 m, steering east lands on the roof (9) both halves; canal pads reach 1.83 m above the street, steering east lands on it; nothing overhead. In play: the launch sound message reached the host; 4v4 bots crossed pads 6 times in 40 s, none stuck bouncing. Standing still on a pad bounces you again and again (steer off). Falling down the Bank's wall steering into it can land you on a 2F window sill (z -23 .. -21.4).

(Follow-up 22) Sniper: unscoped spread 0.001 / 0.015 / 0.04 -> 0.015 / 0.04 / 0.08 (still / moving / air: a little wider than the rifle's 0.01 / 0.03 / 0.07; 0.03 / 0.06 / 0.09 was tried and too wide); scoped unchanged. Bots shoot with scoped spread (spreadFor(..., true)), so their sniper is as before.

(Follow-up 23) Jump pads removed again (they didn't suit the game for now): the generator, World, host / bots / client relay, sound, rings and README are back as before Follow-up 21; the map was rebuilt (same sizes as before them). Follow-up 21 above describes how they worked, should they come back.

(Follow-up 24) Headshot mode is sniper-only (MODES.headshot.weapons ['sniper'], was the rifle); descriptions updated (en / ko). Verified: mode card, buy menu (sniper, free), all 7 bots spawn with the sniper and score kills.

(Follow-up 25) Bots stood still when their way was due north: Bot.update passed `forward: move ? 1 : 0`, and a heading of exactly 0 (north; common, as the navigation grid is axis-aligned) is falsy, so they stopped and jump-unstuck instead (now `move !== null`). It showed on ladders: the Hospital's and Warehouse's way down and the Hotel's and Factory's way up (each approached heading north) failed. Verified by driving a bot along the graph with simulated time: all 7 ladders up and down (Hospital / Hotel 0-15, Warehouse / Factory 4.5-9.25, Clock Tower 0-14 and 14-20, Crane 6-18: 1.3-3.8 s each), and street -> Clock Tower top (two ladders) 7.6 s and back 14.8 s.
