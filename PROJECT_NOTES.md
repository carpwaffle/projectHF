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
| House01 / House09 | Team bases. West wing 2F, **2nd-floor bridge over the road** (no ground floor; 3 m headroom), east wing 2F, east end 1F, annex 1F. Doors, interior walls with doorways, cover on the bridge. 4 team spawns upstairs in the east wing |
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

The game's core: one hack per life, bought in the buy menu next to the
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
- **Aim** (main.js `aimLock`, Shift held): nearest enemy head (headAABB
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
