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
