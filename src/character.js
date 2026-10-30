// Animated player character built from the converted model assets.
//
// Every frame, update() poses the model from just the networked state
// (position, yaw, pitch, dead):
//
//   - Locomotion: velocity is estimated from position changes, converted to
//     the body's frame, and used to blend the idle / run forward / run
//     backward / strafe clips. The run clips share one phase so the feet
//     stay in step while blending between directions.
//   - Airborne: jump loop clip.  Death: death clip, played once.
//   - Aim: the spine bends with the player's pitch, so the rifle and head
//     follow where they're looking.
//   - Rifle: attached to the right hand. Its offset is calibrated from the
//     idle pose so it points straight ahead; IK keeps the left hand on the
//     handguard.
//   - Firing: recoil kick and muzzle flash.
//   - Sounds: onSound(name, intensity) reports shots, reload starts, foot
//     contacts (from the run cycle) and landings; the renderer passes them on
//     to the audio, positioned at the character.
//   - Weapons: setWeapon() swaps the gun in the right hand (same holding
//     animations for every long gun; per-gun points in GUNS).
//   - Rifle reload: the reload clip on the upper body only (legs keep
//     running), sped up to the reload time; the left hand leaves the
//     handguard (hand IK blends out and back in) and swaps the magazine,
//     timed to the clip.
//   - Sniper: procedural reload (the left hand follows keyframed points:
//     magazine, pull down, hip pouch, back, insert; the gun tilts) using the
//     model's own Magazine bone, and the bolt (Handle bone) is worked after
//     every shot and at the end of a reload.

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER_HEIGHT, TEAMS, WEAPONS, FAST_CYCLE, MOVE_SPEED } from './shared.js';
import { SKINS, assets } from './assets.js';
import { makeMuzzleFlash } from './effects.js';

const LOCOMOTION = ['run_forward', 'run_backward', 'strafe_left', 'strafe_right'];
const RUN_ANIM_SPEED = 5; // m/s at which the run clips play at normal speed
const SPEED_FALL = 25; // m/s per second: how fast the animation speed may drop (see speedHold)
const AIR_DELAY = 0.1; // seconds above the ground before the jump clip starts

// Upper-body bones (three.js strips the dots: "UpperArm.L" -> "UpperArmL").
const UPPER_BODY = /^(Abdomen|Torso|Neck|Head|Shoulder|UpperArm|LowerArm|Palm|Fingers|Thumb)/;
// The mixer averages actions by weight, so to make the reload win on the
// upper body (over the full-body locomotion clips) it gets a heavy weight.
const RELOAD_WEIGHT = 12;
const upperBodyClips = {}; // gender/clip -> clip with only the upper-body tracks

function upperBodyClip(gender, clip) {
  upperBodyClips[`${gender}/${clip.name}`] ??= new THREE.AnimationClip(
    `${clip.name}_upper`, clip.duration, clip.tracks.filter((t) => UPPER_BODY.test(t.name)),
  );
  return upperBodyClips[`${gender}/${clip.name}`];
}

// Gun-local points (metres; every gun's origin is its trigger, muzzle at -Z),
// measured from the models.
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const RIFLE_GRIP = V(0, -0.07, 0.07); // centre of the right hand on the long guns
const POUCH = V(-0.22, 0.95, -0.05); // left hip, in the body's space (it faces -Z, +X is its right)

// Per gun: where the hands go, the muzzle, and for guns with a procedural
// reload (`reload`) the left hand's path, as fractions of the reload time,
// through these points: 'grip' (where the left hand holds the gun), 'mag'
// (on the magazine), 'down' (magazine pulled out: mag + reload.down),
// 'pouch' (left hip, body space), 'slide' / 'slideBack' (pistol: racking the
// slide), or any name in `extra` (gun-space points).
// part: the bone that moves with the hand (default 'Magazine', plus
// `partAlso`); held: when it's in the hand; hidden: when it's gone;
// hideOutside: only shown while in the hand (the revolver's speedloader, the
// shotgun's shells); slide: slides out of / into the gun at the ends of
// each held window (magazines).
// tilt: how far the gun turns toward the hand (radians, muzzle up / roll).
// set: which animation set holds it ('rifle': the rifle clips, 'pistol').
const GUNS = {
  rifle: {
    set: 'rifle',
    rightGrip: RIFLE_GRIP,
    leftGrip: V(0, -0.03, -0.26), // left hand on the handguard
    // Where shots leave the barrel: the lower part of the barrel's end, below
    // the front sight (sight top ~0.07, barrel ~0.03-0.056). Lower than the
    // barrel's middle on purpose: in first person the tracer climbs toward the
    // crosshair, and starting here it visibly leaves the muzzle rather than
    // appearing over the sight.
    muzzle: V(0, 0.028, -0.635),
  },
  sniper: {
    set: 'rifle',
    rightGrip: RIFLE_GRIP,
    leftGrip: V(0, -0.025, -0.23), // under the forend (close enough for a bent elbow, like the rifle's)
    muzzle: V(0, 0.03, -0.8),
    magGrab: V(-0.03, -0.035, -0.085), // where the left hand takes the magazine (left of it)
    boltAxis: V(0.002, 0.042, 0), // the bolt turns about the bore through here
    reload: {
      path: [[0, 'grip'], [0.1, 'mag'], [0.25, 'down'], [0.4, 'pouch'], [0.5, 'pouch'], [0.65, 'down'], [0.78, 'mag'], [0.86, 'grip']],
      held: [[0.1, 0.38], [0.45, 0.78]],
      hidden: [[0.38, 0.45]],
      slide: true,
      down: V(-0.02, -0.2, 0.03),
      tilt: { pitch: 0.12, roll: 0.45 },
      bolt: [0.82, 0.98], // chambering a round at the end
    },
  },
  pistol: {
    set: 'pistol',
    rightGrip: V(0, -0.035, 0.04), // on the grip, behind the trigger
    leftGrip: V(-0.035, -0.05, 0.035), // supporting hand, left of the grip
    muzzle: V(0, 0.034, -0.136),
    magGrab: V(-0.02, -0.088, 0.045), // the magazine's base, under the grip
    slideGrab: V(-0.02, 0.056, 0.035), // rear of the slide, from the left
    reload: {
      path: [[0, 'grip'], [0.12, 'mag'], [0.25, 'down'], [0.38, 'pouch'], [0.45, 'pouch'], [0.6, 'down'],
        [0.72, 'mag'], [0.8, 'slide'], [0.87, 'slideBack'], [0.95, 'grip']],
      held: [[0.12, 0.32], [0.42, 0.72]],
      hidden: [[0.32, 0.42]],
      slide: true,
      down: V(0, -0.14, 0.03),
      tilt: { pitch: 0.35, roll: 0.5 },
      rack: [0.8, 0.87, 0.9], // slide pulled back (with the hand) then released
    },
  },
  revolver: {
    set: 'pistol',
    rightGrip: V(0, -0.05, 0.075), // the grip, behind and below the trigger
    leftGrip: V(-0.035, -0.06, 0.07),
    muzzle: V(0, 0.045, -0.192),
    magGrab: V(0.044, 0.008, 0.03), // the speedloader (parked beside the gun, hidden)
    extra: {
      drum: V(-0.04, 0.036, -0.024), // left of the drum, swung out
      drumLoad: V(-0.035, 0.036, 0.012), // speedloader at the back of the swung-out drum
    },
    reload: {
      path: [[0, 'grip'], [0.12, 'drum'], [0.3, 'drum'], [0.46, 'pouch'], [0.62, 'drumLoad'], [0.7, 'drumLoad'],
        [0.8, 'drum'], [0.9, 'grip']],
      part: 'Quick', partAlso: ['Bullets_1'],
      held: [[0.44, 0.7]],
      hideOutside: true,
      down: V(0, 0, 0),
      tilt: { pitch: 0.55, roll: 0.35 }, // muzzle up: the empties fall out
      drum: { bone: 'Drum', out: [0.12, 0.2], in: [0.72, 0.8], offset: V(-0.03, -0.004, 0) },
    },
  },
  p90: {
    set: 'rifle',
    rightGrip: V(0, -0.035, 0.05), // bullpup: the grip just behind the trigger
    leftGrip: V(0, -0.045, -0.08), // front grip
    muzzle: V(0, 0.029, -0.24),
    magGrab: V(-0.035, 0.056, 0.03), // left side of the magazine on top
    reload: {
      path: [[0, 'grip'], [0.12, 'mag'], [0.25, 'down'], [0.4, 'pouch'], [0.48, 'pouch'], [0.62, 'down'], [0.75, 'mag'], [0.84, 'grip']],
      held: [[0.12, 0.36], [0.44, 0.75]],
      hidden: [[0.36, 0.44]],
      slide: true,
      down: V(0, 0.12, 0.08), // magazine lifted up and back off the top
      tilt: { pitch: 0.12, roll: -0.35 }, // roll the top toward the left hand
    },
  },
  shotgun: {
    set: 'rifle',
    rightGrip: RIFLE_GRIP,
    leftGrip: V(0, -0.012, -0.24), // under the pump (its back half: close enough for a bent elbow)
    muzzle: V(0, 0.045, -0.64),
    magGrab: V(-0.011, 0.037, -0.1), // a shell (the Bullet bone), shown in the hand while loading
    extra: { port: V(-0.01, -0.035, -0.11) }, // loading port under the receiver
    pump: { bone: 'Reload', travel: 0.08 },
    reload: {
      path: [[0, 'grip'], [0.1, 'pouch'], [0.2, 'port'], [0.3, 'pouch'], [0.4, 'port'], [0.5, 'pouch'], [0.6, 'port'],
        [0.7, 'pouch'], [0.8, 'port'], [0.87, 'grip']],
      part: 'Bullet',
      held: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6], [0.7, 0.8]],
      hideOutside: true,
      down: V(0, 0, 0),
      tilt: { pitch: 0.1, roll: 0.5 },
      pump: [0.88, 0.98], // work the pump to chamber a shell
    },
  },
};
export const MUZZLE = GUNS.rifle.muzzle;

// Animation sets: the clips each holding style uses.
const SETS = {
  rifle: { idle: 'idle', loco: LOCOMOTION, jump: 'jump_loop' },
  pistol: { idle: 'pistol_idle', loco: LOCOMOTION.map((n) => `pistol_${n}`), jump: 'pistol_jump_loop' },
};
// Pistol-style firing (run-firing): while shooting, the pistol idle's upright
// two-handed aim on the upper body, over whatever the legs are doing. (Not the
// Mixamo Firing clip: it bends the torso over, drops the hands and pulls them
// back in a big recoil. The kick is procedural, like the long guns'.)
const FIRE_WEIGHT = 12;
const FIRE_HOLD = 0.5; // seconds the aim is held after a shot

const BOLT_TIME = 0.6; // seconds to work the sniper's bolt (done before the next shot: cooldown 1 s)
const BOLT_DELAY = 0.15; // after the shot
const PUMP_TIME = 0.42; // seconds to work the shotgun's pump (cooldown 0.65 s)
const PUMP_DELAY = 0.12;
const SLIDE_KICK = 0.09; // seconds the pistol's slide takes to go back and return
// Magazine centre: under the receiver where the reload clip's left hand
// grabs and inserts it (measured in rifle space), between the trigger and
// the handguard grip.
const MAG_POS = new THREE.Vector3(0, -0.068, -0.16);

// Magazine during the reload clip (fractions of the clip, measured from where
// the left hand is): grabbed and slid out into the palm, gone while the hand
// fetches a new one, new one in the palm, slid in.
const MAG_GRAB = 0.04;
const MAG_DROP = 0.22;
const MAG_NEW = 0.36;
const MAG_IN = 0.56;
const MAG_SLIDE = 0.07; // how long sliding out / in takes
const WRIST_TWIST_TO_FOREARM = 0.5; // share of the left wrist's twist moved into the forearm

const { damp, clamp } = THREE.MathUtils;
const gripRest = {};
// First person: where the camera sits relative to the head bone (metres,
// view-aligned: side, up, forward), per holding style, blended when
// switching. A little left of centre so the gun shows lower right instead of
// covering the crosshair; higher for the pistol, which is held up at eye level.
const VIEW_EYE = {
  rifle: [-0.14, -0.04, 0.18],
  pistol: [-0.13, 0.05, 0.12],
};
const _eyePoint = new THREE.Vector3();
const _eyeOffset = new THREE.Vector3();
const _eyeEuler = new THREE.Euler();

const gripOffsets = {}; // gender -> set -> Matrix4, hand space -> gun space
// gender -> set -> { grip, shoulder, chest, chestYaw }: in the set's idle pose,
// where the gun's grip, the right shoulder and the chest are, and which way
// the chest faces (character space, looking level). While aiming, the grip
// keeps its place relative to the chest (see holdGun).
const magHolds = {}; // gender -> { old, new }: magazine pose in the left hand's space

// The rifle model has no magazine; this box stands in (it comes out during reloads).
function makeMagazine() {
  const mag = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, 0.13, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.55, metalness: 0.35 }),
  );
  mag.position.copy(MAG_POS);
  mag.rotation.x = 0.15; // bottom swept slightly forward
  mag.userData.rest = { position: mag.position.clone(), quaternion: mag.quaternion.clone() };
  return mag;
}

export function makeGun(id) {
  let gun;
  if (id === 'rifle') {
    gun = assets.guns.rifle.clone();
    gun.userData.mag = makeMagazine();
    gun.add(gun.userData.mag);
  } else {
    // Skinned: its Magazine and Handle (bolt) bones get posed during reloads.
    gun = cloneSkinned(assets.guns[id]);
    gun.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
    gun.updateMatrixWorld(true);
    gun.userData.bones = {};
    for (const name of ['Magazine', 'Handle', 'Slide', 'Drum', 'Quick', 'Bullets_1', 'Reload', 'Bullet']) {
      const bone = gun.getObjectByName(name);
      if (!bone) continue;
      bone.userData.rest = {
        position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone(),
        gun: bone.matrixWorld.clone(), // its matrix in the gun's space (the gun is at the origin here)
      };
      gun.userData.bones[name] = bone;
    }
  }
  gun.userData.id = id;
  gun.userData.points = GUNS[id];
  gun.userData.flash = makeMuzzleFlash();
  gun.userData.flash.position.copy(GUNS[id].muzzle);
  gun.add(gun.userData.flash);
  return gun;
}

export function makeRifle() {
  return makeGun('rifle');
}

const SHADOW_OPACITY = 0.28;
const SHADOW_FADE_HEIGHT = 4; // metres above the ground at which the blob shadow is gone

export class Character {
  constructor(name, skin, team) {
    const skinName = SKINS[((skin % SKINS.length) + SKINS.length) % SKINS.length];
    this.gender = skinName.startsWith('Female') ? 'female' : 'male';

    this.name = name;
    this.team = team;
    this.dead = false;
    this.velocity = new THREE.Vector3();
    this.lastPos = null;
    this.phase = 0;
    this.move = 0;
    this.dirF = 1;
    this.dirS = 0;
    this.air = 0;
    this.deathBlend = 0;
    this.recoil = 0;
    this.reloading = false;
    this.reloadBlend = 0;
    this.reloadStart = 0; // performance.now() when the current reload began (sniper)
    this.boltStart = -1e9; // performance.now() of the last sniper shot
    this.pumpStart = -1e9; // ... and shotgun shot
    this.pumpBack = 0; // how far the pump is back (0..1); the left hand rides on it
    this.guns = {}; // weapon id -> gun object, made on first use
    this.weaponId = null;
    this.onSound = null; // (name, intensity) => void
    this.airborne = false;
    this.fallSpeed = 0;
    this.speedHold = 0; // speed for the animations: rises at once, falls over ~0.25 s
    this.offGround = 0; // seconds clearly above the ground

    this.object = new THREE.Group(); // feet position, rotated by yaw; faces -Z
    this.model = cloneSkinned(assets.characters[skinName]);
    this.model.rotation.y = Math.PI; // models face +Z
    this.model.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
    this.object.add(this.model);

    const bone = (n) => this.model.getObjectByName(n);
    this.bones = {
      abdomen: bone('Abdomen'),
      torso: bone('Torso'),
      neck: bone('Neck'),
      head: bone('Head'),
      rightUpper: bone('UpperArmR'),
      rightLower: bone('LowerArmR'),
      rightHand: bone('PalmR'),
      leftUpper: bone('UpperArmL'),
      leftLower: bone('LowerArmL'),
      leftHand: bone('PalmL'),
    };

    // Animation
    this.mixer = new THREE.AnimationMixer(this.model);
    const clips = assets.clips[this.gender];
    this.actions = {};
    const setClips = Object.values(SETS).flatMap((set) => [set.idle, ...set.loco, set.jump]);
    for (const name of [...setClips, 'death']) {
      const action = this.mixer.clipAction(clips[name]);
      action.setEffectiveWeight(0).play();
      this.actions[name] = action;
    }
    for (const set of Object.values(SETS)) {
      for (const name of set.loco) this.actions[name].timeScale = 0; // driven by this.phase
    }
    this.actions.death.setLoop(THREE.LoopOnce, 1);
    this.actions.death.clampWhenFinished = true;
    const reload = this.mixer.clipAction(upperBodyClip(this.gender, clips.reload));
    reload.setLoop(THREE.LoopOnce, 1);
    reload.clampWhenFinished = true;
    reload.timeScale = reload.getClip().duration / WEAPONS.find((w) => w.id === 'rifle').reloadTime;
    reload.setEffectiveWeight(0).play();
    this.actions.reload = reload;
    const fire = this.mixer.clipAction(upperBodyClip(this.gender, clips.pistol_idle));
    fire.setEffectiveWeight(0).play();
    this.actions.pistol_fire = fire;
    this.pistolBlend = 0; // 0 = rifle set, 1 = pistol set (cross-faded on switching)
    this.fireAt = -1e9; // performance.now() of the last shot (pistol firing pose)
    this.slideStart = -1e9;

    // The gun, held by the right hand.
    this.chestPos = new THREE.Vector3(); // the chest this frame, character space
    this.rifleHolder = new THREE.Group();
    this.bones.rightHand.add(this.rifleHolder);
    this.calibrateGrip('pistol');
    this.calibrateGrip('rifle'); // (last: leaves the rifle idle pose for the magazine calibration)
    this.setWeapon('rifle');
    this.calibrateMagazine();

    // Blob shadow and name label
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: SHADOW_OPACITY, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.015;
    this.object.add(this.shadow);
    this.label = makeLabel(name, TEAMS[team]?.color ?? '#fff');
    this.object.add(this.label);

    // Spawn protection: a faint pulsing shield in the team colour.
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: TEAMS[team]?.color ?? '#ffffff', transparent: true, opacity: 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    this.shield.scale.set(0.6, 1.05, 0.6);
    this.shield.position.y = 0.95;
    this.shield.visible = false;
    this.object.add(this.shield);
  }

  // Keep the left arm from stretching straight: a straight arm can't bend
  // smoothly (the elbow snaps between bent and locked as the shoulder moves
  // with the run cycle). If the target is further from the shoulder than
  // LEFT_REACH of the arm's length, the hand slides back along the gun
  // (toward the body) until it isn't, up to LEFT_SLIDE. Beyond that (aiming
  // steeply up while running back), the target is softly pulled in toward
  // the shoulder, so the arm still never locks straight (the hand comes a
  // little off the gun instead). Moves `target`.
  withinReach(upper, lower, hand, target) {
    const S = upper.getWorldPosition(_s);
    const length = S.distanceTo(lower.getWorldPosition(_e)) + _e.distanceTo(hand.getWorldPosition(_w));
    const reach = LEFT_REACH * length;
    const d = _t2.subVectors(target, S);
    if (d.lengthSq() <= reach * reach) return;
    const back = _axis.set(0, 0, 1).applyQuaternion(this.gun.getWorldQuaternion(_hq)); // toward the stock
    // Smallest t with |d + t * back| = reach (or the closest the gun line comes).
    const b = d.dot(back);
    const disc = b * b - d.lengthSq() + reach * reach;
    const t = disc > 0 ? -b - Math.sqrt(disc) : -b;
    target.addScaledVector(back, clamp(t, 0, LEFT_SLIDE));
    // Soft limit: distances past `reach` approach (but never get to) LEFT_MAX.
    const dist = d.subVectors(target, S).length();
    if (dist <= reach) return;
    const room = (LEFT_MAX - LEFT_REACH) * length;
    target.copy(S).addScaledVector(d, (reach + room * Math.tanh((dist - reach) / room)) / dist);
  }

  // Swap the gun in the hand (weapon id from WEAPONS); it sits in the hand
  // the way its animation set holds it.
  setWeapon(id) {
    if (id === this.weaponId) return;
    if (this.gun) this.rifleHolder.remove(this.gun);
    this.gun = this.guns[id] ??= makeGun(id);
    this.rifleHolder.add(this.gun);
    this.weaponId = id;
    this.boltStart = -1e9;
    this.slideStart = -1e9;
    this.pumpStart = -1e9;
    this.pumpBack = 0;
    gripOffsets[this.gender][GUNS[id].set].decompose(this.rifleHolder.position, this.rifleHolder.quaternion, this.rifleHolder.scale);
  }

  // (older name)
  get rifle() {
    return this.gun;
  }

  // Work out where a gun sits in the right hand for an animation set: in
  // that set's idle pose, the gun points straight ahead with its rightGrip in
  // the palm. The same for every character of a gender, so it's cached.
  calibrateGrip(set) {
    gripOffsets[this.gender] ??= {};
    if (gripOffsets[this.gender][set]) return;
    for (const [name, action] of Object.entries(this.actions)) action.setEffectiveWeight(name === SETS[set].idle ? 1 : 0);
    this.mixer.update(0);
    this.object.updateMatrixWorld(true);
    const hand = this.bones.rightHand;
    const palm = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld);
    const fingers = hand.children.find((c) => c.isBone);
    const centre = fingers ? palm.lerp(new THREE.Vector3().setFromMatrixPosition(fingers.matrixWorld), 0.5) : palm;
    const grip = Object.values(GUNS).find((g) => g.set === set).rightGrip;
    const gunWorld = new THREE.Matrix4().makeTranslation(centre.sub(grip)); // facing -Z, upright
    gripOffsets[this.gender][set] = hand.matrixWorld.clone().invert().multiply(gunWorld);
    gripRest[this.gender] ??= {};
    // The idle's wrists are the natural ones: how each forearm runs into its
    // hand (the forearm's direction in the hand's space), and how the left
    // hand is turned on the gun (in the gun's space: the gun faces -Z,
    // upright, like the character here).
    const forearm = (lower, hand) => new THREE.Vector3().subVectors(hand.getWorldPosition(new THREE.Vector3()), lower.getWorldPosition(new THREE.Vector3()))
      .normalize().applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()).invert());
    gripRest[this.gender][set] = {
      grip: this.object.worldToLocal(centre.add(grip)),
      shoulder: this.object.worldToLocal(this.bones.rightUpper.getWorldPosition(new THREE.Vector3())),
      chest: this.object.worldToLocal(this.bones.torso.getWorldPosition(new THREE.Vector3())),
      chestYaw: this.chestYaw(),
      forearmR: forearm(this.bones.rightLower, this.bones.rightHand),
      forearmL: forearm(this.bones.leftLower, this.bones.leftHand),
      leftInGun: this.bones.leftHand.getWorldQuaternion(new THREE.Quaternion()),
    };
  }

  // How the magazine sits in the left hand: in the palm (between the hand
  // and finger joints), turned the way it was in the rifle at the moment the
  // hand takes it out / puts it in (sampled from the reload clip). Cached per gender.
  calibrateMagazine() {
    if (!magHolds[this.gender]) {
      const action = this.actions.reload;
      const mag = this.guns.rifle.userData.mag;
      const hand = this.bones.leftHand;
      const fingers = hand.children.find((c) => c.isBone);
      const palm = fingers ? fingers.position.clone().multiplyScalar(0.55) : new THREE.Vector3();
      const at = (progress) => {
        action.time = progress * action.getClip().duration;
        this.mixer.update(0);
        this.object.updateMatrixWorld(true);
        const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
        return { position: palm, quaternion: handQ.invert().multiply(mag.getWorldQuaternion(new THREE.Quaternion())) };
      };
      action.setEffectiveWeight(RELOAD_WEIGHT);
      magHolds[this.gender] = { old: at(MAG_GRAB), new: at(MAG_IN) };
      action.setEffectiveWeight(0);
      action.time = 0;
      this.mixer.update(0);
    }
  }

  // Pose the magazine for this point of the reload (progress 0..1; 1 when
  // not reloading). It stays a child of the rifle; in the hand, its pose is
  // worked out in world space and converted back.
  updateMagazine(progress) {
    const mag = this.gun.userData.mag;
    const { position: restPos, quaternion: restQ } = mag.userData.rest;
    let held = 0; // 0 = in the rifle, 1 = in the hand
    if (progress >= MAG_GRAB && progress < MAG_IN) {
      held = Math.min(1, (progress - MAG_GRAB) / MAG_SLIDE, (MAG_IN - progress) / MAG_SLIDE);
    }
    mag.visible = !(progress >= MAG_DROP && progress < MAG_NEW);
    if (held <= 0 || !mag.visible) {
      mag.position.copy(restPos);
      mag.quaternion.copy(restQ);
      return;
    }
    const hold = magHolds[this.gender][progress < MAG_DROP ? 'old' : 'new'];
    const hand = this.bones.leftHand;
    // Hand pose (world) -> the rifle's space.
    _invRifle.copy(this.gun.matrixWorld).invert();
    _m.multiplyMatrices(_invRifle, hand.matrixWorld);
    _m.decompose(_hp, _hq, _hs);
    const inHandPos = hold.position.clone().multiply(_hs).applyQuaternion(_hq).add(_hp);
    const inHandQ = _hq.multiply(hold.quaternion);
    mag.position.lerpVectors(restPos, inHandPos, held);
    mag.quaternion.slerpQuaternions(restQ, inHandQ, held);
  }

  // World position of the rifle's muzzle (where tracers start).
  // First person: shift the whole body so its eyes (just above and in front
  // of the head bone, turned with the view) sit exactly at the camera (eye).
  // After update().
  placeEyes(eye, yaw, pitch) {
    this.bones.head.getWorldPosition(_eyePoint);
    const k = this.pistolBlend;
    const [side, up, forward] = VIEW_EYE.rifle.map((r, i) => r + (VIEW_EYE.pistol[i] - r) * k);
    _eyePoint.add(_eyeOffset.set(side, up, -forward).applyEuler(_eyeEuler.set(pitch, yaw, 0, 'YXZ')));
    this.object.position.add(_eyeOffset.set(...eye).sub(_eyePoint));
    this.object.updateMatrixWorld(true);
  }

  muzzleWorld(target = new THREE.Vector3()) {
    return this.gun.localToWorld(target.copy(this.gun.userData.points.muzzle));
  }

  fire() {
    this.recoil = 1;
    this.gun.userData.flash.userData.fire();
    if (this.weaponId === 'sniper') this.boltStart = performance.now();
    if (this.weaponId === 'shotgun') this.pumpStart = performance.now();
    if (this.weaponId === 'pistol') this.slideStart = performance.now();
    if (GUNS[this.weaponId].set === 'pistol') this.fireAt = performance.now();
    this.onSound?.('shot', 1, this.fastCycle ? `${this.weaponId}_fast` : this.weaponId);
  }

  // state: { pos:[x,y,z], yaw, pitch, dead, vel?:[x,y,z], ground?, reloading?,
  //   protected?, weapon? (index into WEAPONS) }
  // Pass vel to drive the animation directly (the preview page does);
  // otherwise it's estimated from successive positions. ground: height of
  // the surface under the player (keeps the blob shadow there while they're
  // in the air); defaults to their feet.
  update(dt, state) {
    if (dt <= 0) return;
    const pos = state.pos;
    if (state.weapon !== undefined) this.setWeapon(WEAPONS[state.weapon]?.id ?? 'rifle');
    this.fastCycle = !!state.fast; // infinite ammo hack (known for us and teammates)
    const now = performance.now();

    // ---- velocity ----------------------------------------------------------
    // state.vel if given (remote players: from the snapshots, steadier than
    // frame-to-frame position changes), else from the position; smoothed.
    const k = 1 - Math.exp(-15 * dt);
    if (this.lastPos && Math.hypot(...[0, 1, 2].map((i) => pos[i] - this.lastPos[i])) > 3) {
      this.velocity.set(0, 0, 0); // teleport (respawn)
    } else if (state.vel) {
      this.velocity.x += (state.vel[0] - this.velocity.x) * k;
      this.velocity.y += (state.vel[1] - this.velocity.y) * k;
      this.velocity.z += (state.vel[2] - this.velocity.z) * k;
    } else if (this.lastPos) {
      this.velocity.x += ((pos[0] - this.lastPos[0]) / dt - this.velocity.x) * k;
      this.velocity.y += ((pos[1] - this.lastPos[1]) / dt - this.velocity.y) * k;
      this.velocity.z += ((pos[2] - this.lastPos[2]) / dt - this.velocity.z) * k;
    }
    this.lastPos = [...pos];
    this.object.position.set(pos[0], pos[1], pos[2]);
    this.object.rotation.y = state.yaw;

    // ---- state -------------------------------------------------------------
    if (state.dead && !this.dead) this.actions.death.reset().play();
    this.dead = state.dead;
    this.deathBlend = this.dead ? damp(this.deathBlend, 1, 12, dt) : 0;
    this.label.visible = !this.dead;
    this.shield.visible = !!state.protected && !this.dead;
    if (this.shield.visible) this.shield.material.opacity = 0.1 + 0.07 * Math.sin(performance.now() / 120);
    const reloading = !!state.reloading && !this.dead;
    if (reloading && !this.reloading) {
      if (this.weaponId === 'rifle') this.actions.reload.reset().play();
      this.reloadStart = now;
      this.onSound?.('reload', 1, this.weaponId);
    }
    this.reloading = reloading;
    this.reloadBlend = damp(this.reloadBlend, reloading ? 1 : 0, 10, dt);

    const sin = Math.sin(state.yaw);
    const cos = Math.cos(state.yaw);
    const v = this.velocity;
    const fwd = -v.x * sin - v.z * cos;
    const right = v.x * cos - v.z * sin;
    // Brief stops (a network hiccup, a bot pausing for a moment) shouldn't
    // flash the idle pose between runs: the speed the clips see falls slowly.
    const actual = Math.hypot(fwd, right);
    this.speedHold = Math.max(actual, this.speedHold - SPEED_FALL * dt);
    const speed = this.speedHold;
    const alive = this.dead ? 0 : 1;

    this.move = damp(this.move, clamp(speed / 2, 0, 1) * alive, 10, dt);
    if (actual > 0.5) { // (the direction: only while really moving)
      this.dirF = damp(this.dirF, fwd / actual, 10, dt);
      this.dirS = damp(this.dirS, right / actual, 10, dt);
    }
    // Airborne = clearly above the surface below (state.ground; without it,
    // judged from vertical speed). Not from vertical speed alone: going up or
    // down stairs is ~4 m/s vertically, which flickered the jump clip in and out.
    // Only after AIR_DELAY up (or clearly high): small drops off kerbs and
    // steps don't flash the jump pose.
    const above = state.ground === undefined ? (Math.abs(v.y) > 2.5 ? 1 : 0) : pos[1] - state.ground;
    this.offGround = above > 0.3 ? this.offGround + dt : 0;
    if (!this.dead && (this.offGround > AIR_DELAY || above > 0.8)) {
      this.airborne = true;
      this.fallSpeed = Math.max(this.fallSpeed, -v.y);
    } else if (this.airborne && above < 0.08) {
      this.airborne = false;
      if (!this.dead && this.fallSpeed > 2) this.onSound?.('land', clamp(this.fallSpeed / 9, 0.5, 1.5));
      this.fallSpeed = 0;
    }
    this.air = damp(this.air, this.airborne && alive ? 1 : 0, 10, dt);
    this.recoil = damp(this.recoil, 0, 16, dt);
    this.gun.userData.flash.userData.update(dt);

    // ---- clip weights ------------------------------------------------------
    const living = 1 - this.deathBlend;
    const ground = (1 - this.air) * living;
    const loco = this.move * ground;
    const f = this.dirF;
    const s = this.dirS;
    const total = Math.abs(f) + Math.abs(s) || 1;
    const base = {
      idle: (1 - this.move) * ground,
      run_forward: loco * Math.max(0, f) / total,
      run_backward: loco * Math.max(0, -f) / total,
      strafe_left: loco * Math.max(0, -s) / total,
      strafe_right: loco * Math.max(0, s) / total,
      jump: this.air * living,
    };
    // The holding style's set, cross-faded when switching between styles.
    this.pistolBlend = damp(this.pistolBlend, GUNS[this.weaponId].set === 'pistol' ? 1 : 0, 12, dt);
    const firing = clamp(1 - ((now - this.fireAt) / 1000 - FIRE_HOLD) / 0.25, 0, 1); // held, then fades
    const w = {
      death: this.deathBlend,
      reload: this.weaponId === 'rifle' ? RELOAD_WEIGHT * this.reloadBlend * living : 0,
      pistol_fire: FIRE_WEIGHT * firing * this.pistolBlend * living,
    };
    for (const [setName, set] of Object.entries(SETS)) {
      const k = setName === 'pistol' ? this.pistolBlend : 1 - this.pistolBlend;
      w[set.idle] = base.idle * k;
      w[set.jump] = base.jump * k;
      set.loco.forEach((name, i) => { w[name] = base[LOCOMOTION[i]] * k; });
    }
    for (const [name, weight] of Object.entries(w)) this.actions[name].setEffectiveWeight(weight);

    // Shared run phase: one cycle per weighted-average clip length, sped up
    // or slowed down to match the actual movement speed.
    const allLoco = Object.values(SETS).flatMap((set) => set.loco);
    let cycle = 0;
    let weightSum = 0;
    for (const name of allLoco) {
      cycle += w[name] * this.actions[name].getClip().duration;
      weightSum += w[name];
    }
    const lastPhase = this.phase;
    if (weightSum > 0.001) {
      cycle /= weightSum;
      this.phase = (this.phase + (dt / cycle) * clamp(speed / RUN_ANIM_SPEED, 0.6, 1.6)) % 1;
    }

    // ---- sounds: footsteps (landings: see airborne above) --------------------
    // A foot lands twice per run cycle (phase 0 and 0.5).
    const stepped = this.phase < lastPhase || (lastPhase < 0.5 && this.phase >= 0.5);
    if (stepped && !this.airborne && !this.dead && this.move > 0.3 && weightSum > 0.001) {
      this.onSound?.('step', clamp(speed / MOVE_SPEED, 0.4, 1));
    }
    for (const name of allLoco) {
      this.actions[name].time = this.phase * this.actions[name].getClip().duration;
    }

    this.mixer.update(dt);
    this.object.updateMatrixWorld(true);
    // Where the clips put the chest (before aiming bends the spine): the gun follows it.
    this.object.worldToLocal(this.bones.torso.getWorldPosition(this.chestPos));
    const chestYaw = this.chestYaw();

    // ---- aim: split the view pitch (+ recoil) between spine, rifle arm and
    // head, so the rifle and eyes both end up at the full pitch.
    if (living > 0.01) {
      const pitch = (state.pitch + this.recoil * 0.08) * living;
      const axis = new THREE.Vector3(cos, 0, -sin); // character's right
      rotateBoneWorld(this.bones.abdomen, axis, pitch * 0.2);
      rotateBoneWorld(this.bones.torso, axis, pitch * 0.25);
      rotateBoneWorld(this.bones.rightUpper, axis, pitch * 0.55); // carries the rifle
      rotateBoneWorld(this.bones.neck, axis, pitch * 0.2);
      rotateBoneWorld(this.bones.head, axis, pitch * 0.35);
    }
    this.gun.position.set(0, 0, 0);
    this.gun.rotation.set(0, 0, 0);
    // (Neither while the rifle's reload clip moves the rifle in the hand.)
    const clipReload = this.weaponId === 'rifle' ? this.reloadBlend : 0;
    this.holdGun(state.yaw, (state.pitch + this.recoil * 0.08) * living, chestYaw, living * (1 - clipReload));
    this.gun.updateMatrixWorld(true);
    // Guns with a procedural reload: gun tilt, bolt / slide; null otherwise.
    const proc = this.gun.userData.points.reload ? this.poseGun(now) : null;
    this.aimGun(state.yaw, state.pitch + this.recoil * 0.08, living * (1 - clipReload));
    this.gun.updateMatrixWorld(true);

    // ---- left hand IK onto the gun (rifle: blended out while the reload clip
    // moves the hand; blending instead of switching, so the hand doesn't jump
    // when the reload ends). Procedural reloads: onto the reload path.
    // On the gun (blended out while a procedural reload moves the hand), the
    // hand is also turned the way the idle holds it on the gun, with the
    // elbow swung round to keep the wrist as straight as there.
    const ik = living > 0.5 ? (proc ? 1 : 1 - this.reloadBlend) : 0;
    const onGun = !proc || proc.progress < 0 || proc.progress >= this.gun.userData.points.reload.path.at(-1)[0];
    this.leftLock = damp(this.leftLock ?? 1, onGun ? 1 : 0, 10, dt);
    if (ik > 0.001) {
      const { leftUpper: upper, leftLower: lower, leftHand: hand } = this.bones;
      _upperQ.copy(upper.quaternion);
      _lowerQ.copy(lower.quaternion);
      _handQ.copy(hand.quaternion);
      const target = proc ? this.handTarget(proc.progress) : this.gun.localToWorld(this.gun.userData.points.leftGrip.clone());
      this.withinReach(upper, lower, hand, target);
      solveTwoBone(upper, lower, hand, target);
      if (this.leftLock > 0.001) {
        const rest = gripRest[this.gender];
        _wantQ.slerpQuaternions(rest.rifle.leftInGun, rest.pistol.leftInGun, this.pistolBlend)
          .premultiply(this.gun.getWorldQuaternion(_hq));
        const forearm = _v.lerpVectors(rest.rifle.forearmL, rest.pistol.forearmL, this.pistolBlend).normalize().applyQuaternion(_wantQ);
        swivelElbow(upper, lower, hand, forearm, ELBOW_SWIVEL * this.leftLock);
        hand.getWorldQuaternion(_hq);
        setBoneWorldQuaternion(hand, _hq.slerp(_wantQ, this.leftLock));
      }
      if (ik < 0.999) {
        upper.quaternion.copy(_upperQ.slerp(upper.quaternion, ik));
        lower.quaternion.copy(_lowerQ.slerp(lower.quaternion, ik));
        hand.quaternion.copy(_handQ.slerp(hand.quaternion, ik));
        upper.updateMatrixWorld(true);
      }
    }
    relaxWristTwist(this.bones.leftLower, this.bones.leftHand, WRIST_TWIST_TO_FOREARM);

    // ---- magazine ----------------------------------------------------------
    if (proc) {
      this.updateGunMagazine(proc.progress);
    } else {
      const reload = this.actions.reload;
      this.updateMagazine(this.reloading ? reload.time / reload.getClip().duration : 1);
    }

    // Blob shadow stays on the surface below, fading and shrinking with height.
    const height = Math.max(0, pos[1] - (state.ground ?? pos[1]));
    const fade = Math.max(0, 1 - height / SHADOW_FADE_HEIGHT);
    this.shadow.position.y = 0.015 - height;
    this.shadow.scale.setScalar(0.6 + 0.4 * fade);
    this.shadow.material.opacity = SHADOW_OPACITY * fade;
    this.shadow.visible = this.deathBlend < 0.5 && fade > 0;
  }

  // Which way the chest faces in character space (radians about up).
  chestYaw() {
    _v.set(0, 0, 1).applyQuaternion(this.bones.torso.getWorldQuaternion(_hq))
      .applyQuaternion(_holderQ.copy(this.object.quaternion).invert());
    return Math.atan2(_v.x, _v.z);
  }

  // Hold the gun's grip where the idle stance holds it relative to the chest
  // (turned up / down with the aim, about the shoulder), with IK on the right
  // arm. The clips' own hand positions vary a lot with direction (lower
  // running backward, off to the left with the pistol aim over running);
  // following the chest keeps the gun in the same place on the body: its
  // position fully, its twist half (fully, the arms swing side to side).
  // The hand itself turns with the aim (yaw, pitch), so the gun sits in it
  // the same way as in the idle, and the elbow swings round to where the
  // wrist stays as straight as in the idle (rather than the gun turning in
  // a hand still posed by the clip: that looked like a broken wrist).
  // weight: 0..1.
  holdGun(yaw, pitch, chestYaw, weight) {
    if (weight < 0.001) return;
    const rest = gripRest[this.gender];
    const k = this.pistolBlend;
    _target.lerpVectors(rest.rifle.grip, rest.pistol.grip, k);
    _pivot.lerpVectors(rest.rifle.shoulder, rest.pistol.shoulder, k);
    _target.sub(_pivot).applyAxisAngle(_xAxis, pitch).add(_pivot);
    _pivot.lerpVectors(rest.rifle.chest, rest.pistol.chest, k);
    const restYaw = rest.rifle.chestYaw + (rest.pistol.chestYaw - rest.rifle.chestYaw) * k;
    const twist = Math.atan2(Math.sin(chestYaw - restYaw), Math.cos(chestYaw - restYaw)) * CHEST_TWIST_FOLLOW;
    _target.sub(_pivot).applyAxisAngle(_yAxis, twist).add(this.chestPos);
    this.object.localToWorld(_target);
    const { rightUpper: upper, rightLower: lower, rightHand: hand } = this.bones;
    _upperQ.copy(upper.quaternion);
    _lowerQ.copy(lower.quaternion);
    _handQ.copy(hand.quaternion);
    // The hand's turn: the gun (unturned in its holder) along the aim.
    _aimQ.setFromEuler(_euler.set(pitch, yaw, 0, 'YXZ'));
    _wantQ.copy(_aimQ).multiply(_holderQ.copy(this.rifleHolder.quaternion).invert());
    // The grip's offset from the palm, turned with the hand: palm = target - offset.
    const grip = this.gun.userData.points.rightGrip;
    this.rifleHolder.localToWorld(_v.copy(grip)).sub(hand.getWorldPosition(_hp))
      .applyQuaternion(hand.getWorldQuaternion(_hq).invert()).applyQuaternion(_wantQ);
    solveTwoBone(upper, lower, hand, _hp.copy(_target).sub(_v));
    const forearm = _v.lerpVectors(rest.rifle.forearmR, rest.pistol.forearmR, k).normalize().applyQuaternion(_wantQ);
    swivelElbow(upper, lower, hand, forearm, ELBOW_SWIVEL);
    setBoneWorldQuaternion(hand, _wantQ);
    if (weight < 0.999) {
      upper.quaternion.copy(_upperQ.slerp(upper.quaternion, weight));
      lower.quaternion.copy(_lowerQ.slerp(lower.quaternion, weight));
      hand.quaternion.copy(_handQ.slerp(hand.quaternion, weight));
      upper.updateMatrixWorld(true);
    }
  }

  // Point the gun where the player aims (yaw, pitch), turning it about the
  // grip in the hand, whatever angle the animation holds the hand at (e.g.
  // the run-backward clips tip the hand back, which pointed the gun up). Any
  // tilt already on the gun (reloads, bolt) is kept on top; the kick pushes it
  // back along its barrel. Fades out with `living` (death).
  aimGun(yaw, pitch, living) {
    const gun = this.gun;
    const grip = gun.userData.points.rightGrip;
    _tiltQ.copy(gun.quaternion); // local tilt from poseGun (or identity)
    _aimQ.setFromEuler(_euler.set(pitch, yaw, 0, 'YXZ')); // gun forward is -Z, like the camera
    this.rifleHolder.getWorldQuaternion(_holderQ);
    _aimQ.premultiply(_holderQ.invert()).multiply(_tiltQ); // in the holder's space, tilt on top
    gun.quaternion.copy(_tiltQ).slerp(_aimQ, clamp(living, 0, 1));
    // Keep the grip where it was: position = grip - q * grip, plus the kick.
    const kick = this.recoil * (GUNS[this.weaponId].set === 'pistol' ? 0.03 : 0.05);
    gun.position.copy(grip).sub(_v.copy(grip).applyQuaternion(gun.quaternion))
      .add(_v.set(0, 0, kick).applyQuaternion(gun.quaternion));
  }

  // ---- procedural reloads, bolt and slide (sniper, pistol) -----------------

  // Gun tilt, bolt and slide for this frame; returns the reload progress
  // (-1 when not reloading) for the hand and the magazine.
  poseGun(now) {
    const cfg = this.gun.userData.points.reload;
    const reloadTime = WEAPONS.find((w) => w.id === this.weaponId).reloadTime * 1000;
    const progress = this.reloading ? clamp((now - this.reloadStart) / reloadTime, 0, 1) : -1;
    const end = cfg.path[cfg.path.length - 1][0];
    // Tilt (muzzle up and roll) while reloading, so the magazine faces the hand.
    const tilt = progress < 0 ? 0 : Math.sin(Math.PI * clamp((progress - 0.02) / (end - 0.02), 0, 1));
    let roll = cfg.tilt.roll * tilt;
    let pitch = cfg.tilt.pitch * tilt;
    const bones = this.gun.userData.bones;
    if (bones.Handle) {
      // Sniper bolt: after each shot, and to chamber a round at the end of a reload.
      const k = this.fastCycle ? FAST_CYCLE : 1; // infinite ammo hack: worked faster
      let bolt = (now - this.boltStart) / 1000 - BOLT_DELAY * k;
      bolt = bolt >= 0 && bolt <= BOLT_TIME * k ? bolt / (BOLT_TIME * k) : -1;
      const [b0, b1] = cfg.bolt;
      if (progress >= b0 && progress <= b1) bolt = (progress - b0) / (b1 - b0);
      const boltRoll = bolt < 0 ? 0 : Math.sin(Math.PI * bolt);
      roll += 0.15 * boltRoll;
      pitch += 0.04 * boltRoll;
      this.gun.rotation.set(pitch, 0, roll);
      this.gun.updateMatrixWorld(true);
      this.poseBolt(bolt);
    }
    if (bones.Drum && cfg.drum) {
      // Revolver drum swings out to the left, and back.
      const { out: [o0, o1], in: [i0, i1], offset } = cfg.drum;
      const k = progress < o0 || progress >= i1 ? 0 : progress < o1 ? (progress - o0) / (o1 - o0)
        : progress < i0 ? 1 : 1 - (progress - i0) / (i1 - i0);
      this.gun.rotation.set(pitch, 0, roll);
      this.gun.updateMatrixWorld(true);
      _m.makeTranslation(offset.x * k, offset.y * k, offset.z * k).multiply(bones.Drum.userData.rest.gun);
      setBoneGunPose(bones.Drum, this.gun, _m);
    }
    const pumpCfg = this.gun.userData.points.pump;
    if (pumpCfg && bones[pumpCfg.bone]) {
      // Shotgun pump: back and forward after each shot, and at the end of a reload.
      const k = this.fastCycle ? FAST_CYCLE : 1;
      let p = (now - this.pumpStart) / 1000 - PUMP_DELAY * k;
      p = p >= 0 && p <= PUMP_TIME * k ? p / (PUMP_TIME * k) : -1;
      if (progress >= cfg.pump[0] && progress <= cfg.pump[1]) p = (progress - cfg.pump[0]) / (cfg.pump[1] - cfg.pump[0]);
      this.pumpBack = p < 0 ? 0 : Math.sin(Math.PI * p);
      this.gun.rotation.set(pitch, 0, roll);
      this.gun.updateMatrixWorld(true);
      const bone = bones[pumpCfg.bone];
      _m.makeTranslation(0, 0, pumpCfg.travel * this.pumpBack).multiply(bone.userData.rest.gun);
      setBoneGunPose(bone, this.gun, _m);
    }
    if (bones.Slide) {
      // Pistol slide: kicks back with each shot; racked by the left hand at
      // the end of a reload (back with the hand, then released).
      const t = (now - this.slideStart) / 1000;
      let back = t >= 0 && t < SLIDE_KICK ? (t < 0.025 ? t / 0.025 : 1 - (t - 0.025) / (SLIDE_KICK - 0.025)) : 0;
      const [r0, r1, r2] = cfg.rack;
      if (progress >= r0 && progress < r1) back = (progress - r0) / (r1 - r0);
      else if (progress >= r1 && progress < r2) back = 1 - (progress - r1) / (r2 - r1);
      this.gun.rotation.set(pitch, 0, roll);
      this.gun.updateMatrixWorld(true);
      const slide = bones.Slide;
      _m.makeTranslation(0, 0, 0.03 * back).multiply(slide.userData.rest.gun); // back toward the shooter
      setBoneGunPose(slide, this.gun, _m);
    }
    this.gun.rotation.set(pitch, 0, roll); // (tilt for guns without bolt / slide too)
    this.gun.updateMatrixWorld(true);
    return { progress };
  }

  // Bolt cycle (b 0..1, -1 = closed): lift the handle, pull back, push
  // forward, turn down. The Handle bone is turned about the bore.
  poseBolt(b) {
    const handle = this.gun.userData.bones.Handle;
    const rest = handle.userData.rest;
    if (b < 0) {
      handle.position.copy(rest.position);
      handle.quaternion.copy(rest.quaternion);
      return;
    }
    const smooth = (x) => x * x * (3 - 2 * x);
    const lift = b < 0.25 ? smooth(b / 0.25) : b > 0.75 ? smooth((1 - b) / 0.25) : 1;
    const pull = b < 0.25 || b > 0.75 ? 0 : b < 0.5 ? smooth((b - 0.25) / 0.25) : smooth((0.75 - b) / 0.25);
    const axis = this.gun.userData.points.boltAxis;
    _m.makeTranslation(axis.x, axis.y, axis.z + 0.05 * pull) // pull back toward the shooter (+Z)
      .multiply(_m2.makeRotationZ(1.2 * lift)) // handle up
      .multiply(_m3.makeTranslation(-axis.x, -axis.y, -axis.z))
      .multiply(rest.gun);
    setBoneGunPose(handle, this.gun, _m);
  }

  // Where the left hand goes at this point of the reload (world space).
  handTarget(progress) {
    const pts = this.gun.userData.points;
    const cfg = pts.reload;
    const point = (name) => {
      if (name === 'grip') {
        const grip = pts.leftGrip.clone();
        if (pts.pump) grip.z += pts.pump.travel * this.pumpBack; // the hand works the pump
        return this.gun.localToWorld(grip);
      }
      if (pts.extra?.[name]) return this.gun.localToWorld(pts.extra[name].clone());
      if (name === 'mag') return this.gun.localToWorld(pts.magGrab.clone());
      if (name === 'down') return this.gun.localToWorld(pts.magGrab.clone().add(cfg.down));
      if (name === 'slide') return this.gun.localToWorld(pts.slideGrab.clone());
      if (name === 'slideBack') return this.gun.localToWorld(pts.slideGrab.clone().add(_slideBack));
      return this.object.localToWorld(POUCH.clone());
    };
    if (progress < 0) return point('grip');
    const path = cfg.path;
    for (let i = 0; i < path.length - 1; i++) {
      const [t0, a] = path[i];
      const [t1, b] = path[i + 1];
      if (progress <= t1) {
        const k = (progress - t0) / (t1 - t0);
        return point(a).lerp(point(b), k * k * (3 - 2 * k));
      }
    }
    return point('grip');
  }

  // The part the left hand handles (a magazine, the speedloader, a shell):
  // in the gun, in the hand (magazines slide out / in over 0.07), or gone.
  updateGunMagazine(progress) {
    const cfg = this.gun.userData.points.reload;
    const bones = [cfg.part ?? 'Magazine', ...(cfg.partAlso ?? [])].map((n) => this.gun.userData.bones[n]).filter(Boolean);
    if (!bones.length) return;
    const inRange = ([a, b]) => progress >= a && progress < b;
    const window = cfg.held.find(inRange);
    const hidden = cfg.hidden?.some(inRange) || (cfg.hideOutside && !window);
    for (const bone of bones) {
      const rest = bone.userData.rest;
      bone.position.copy(rest.position);
      bone.quaternion.copy(rest.quaternion);
      bone.scale.copy(rest.scale);
      if (hidden) bone.scale.setScalar(1e-4);
    }
    if (hidden || !window) return;
    // Keep its orientation in the gun; move it so the grab point sits in the palm.
    const [a, b] = window;
    const slide = cfg.slide ? Math.min(1, (progress - a) / 0.07, (b - progress) / 0.07) : 1;
    const hand = this.bones.leftHand;
    const fingers = hand.children.find((c) => c.isBone);
    hand.getWorldPosition(_hp);
    if (fingers) _hp.lerp(fingers.getWorldPosition(_t), 0.55);
    this.gun.worldToLocal(_hp); // palm in gun space
    _hp.sub(this.gun.userData.points.magGrab).multiplyScalar(slide);
    for (const bone of bones) {
      _m.makeTranslation(_hp.x, _hp.y, _hp.z).multiply(bone.userData.rest.gun);
      setBoneGunPose(bone, this.gun, _m);
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    // Geometry and materials are shared with the loaded assets; only the
    // per-character extras are ours to free.
    for (const o of [this.shadow, this.label, this.shield, this.guns.rifle?.userData.mag].filter(Boolean)) {
      o.traverse((c) => {
        c.geometry?.dispose();
        c.material?.map?.dispose();
        c.material?.dispose();
      });
    }
    // (the flash's geometry and textures are shared by all flashes)
    for (const gun of Object.values(this.guns)) gun.userData.flash.traverse((c) => c.material?.dispose());
  }
}

// ---- bone helpers --------------------------------------------------------------

const _pq = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _invRifle = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _hp = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _hs = new THREE.Vector3();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _slideBack = new THREE.Vector3(0, 0, 0.03); // how far the hand pulls the pistol's slide
const _tiltQ = new THREE.Quaternion();
const _aimQ = new THREE.Quaternion();
const _holderQ = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _v = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const CHEST_TWIST_FOLLOW = 0.5;
const LEFT_REACH = 0.94; // most of the left arm's length the hand may need (the rifle's idle: 0.94)
const LEFT_SLIDE = 0.2; // metres the left hand may slide back along the gun to stay within reach
const LEFT_MAX = 0.985; // ... and past that, the arm's softly limited stretch (still a little bent)
const _t2 = new THREE.Vector3();
const ELBOW_SWIVEL = 1.2; // radians the elbow may swing round from the clip's (keeping the wrist natural)
const _handQ = new THREE.Quaternion();
const _wantQ = new THREE.Quaternion();
const _e = new THREE.Vector3();
const _s = new THREE.Vector3();
const _w = new THREE.Vector3();
const _upperQ = new THREE.Quaternion();
const _lowerQ = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _twist = new THREE.Quaternion();
const _part = new THREE.Quaternion();

// Pose a bone so its matrix in the gun's space is `gunMatrix`.
function setBoneGunPose(bone, gun, gunMatrix) {
  const world = new THREE.Matrix4().multiplyMatrices(gun.matrixWorld, gunMatrix);
  const local = new THREE.Matrix4().copy(bone.parent.matrixWorld).invert().multiply(world);
  local.decompose(bone.position, bone.quaternion, bone.scale);
  bone.updateMatrixWorld(true);
}

// Rotate a bone by `angle` around a world-space axis.
function rotateBoneWorld(bone, axis, angle) {
  _q.setFromAxisAngle(axis, angle);
  rotateBoneByWorldQuat(bone, _q);
}

function rotateBoneByWorldQuat(bone, q) {
  bone.parent.getWorldQuaternion(_pq);
  const local = _pq.clone().invert().multiply(q).multiply(_pq);
  bone.quaternion.premultiply(local);
  bone.updateMatrixWorld(true);
}

// Two-bone IK in world space. Keeps the animation's elbow plane: first bends
// the elbow to the right angle, then swings the upper arm onto the target.
// The left hand's pose twists it ~120 degrees around the forearm, and with no
// forearm twist bone the skin at the wrist pinches ("candy wrapper"). Move
// part of that twist into the forearm: the hand ends up exactly where and how
// it was, with the twist spread over wrist and elbow.
function relaxWristTwist(lower, hand, amount) {
  const axis = _axis.copy(hand.position).normalize(); // forearm direction, in the forearm's space
  const q = hand.quaternion;
  const d = axis.x * q.x + axis.y * q.y + axis.z * q.z;
  _twist.set(axis.x * d, axis.y * d, axis.z * d, q.w).normalize(); // twist part of q about the axis
  _part.identity().slerp(_twist, amount);
  lower.quaternion.multiply(_part);
  hand.quaternion.premultiply(_part.invert());
  lower.updateMatrixWorld(true);
}

// Give a bone this world rotation.
function setBoneWorldQuaternion(bone, q) {
  bone.parent.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

// Swing the arm round the shoulder-wrist line (the hand stays where it is)
// so the forearm runs as close as it can to `dir` (world, unit, elbow to
// wrist), by at most maxAngle.
function swivelElbow(upper, lower, hand, dir, maxAngle) {
  const S = upper.getWorldPosition(_s);
  const E = lower.getWorldPosition(_e);
  const H = hand.getWorldPosition(_w);
  const axis = _axis.subVectors(H, S);
  if (axis.lengthSq() < 1e-8) return;
  axis.normalize();
  const want = _t.copy(H).addScaledVector(dir, -E.distanceTo(H)).sub(S); // where the elbow would be
  const cur = E.sub(S);
  want.addScaledVector(axis, -want.dot(axis)); // (both across the axis)
  cur.addScaledVector(axis, -cur.dot(axis));
  if (want.lengthSq() < 1e-8 || cur.lengthSq() < 1e-8) return;
  let angle = cur.angleTo(want);
  if (_c.crossVectors(cur, want).dot(axis) < 0) angle = -angle;
  rotateBoneByWorldQuat(upper, _q.setFromAxisAngle(axis, clamp(angle, -maxAngle, maxAngle)));
}

function solveTwoBone(upper, lower, end, target) {
  const S = upper.getWorldPosition(_a);
  const E = lower.getWorldPosition(_b);
  const H = end.getWorldPosition(_c);
  const la = S.distanceTo(E);
  const lb = E.distanceTo(H);
  const dist = clamp(S.distanceTo(target), Math.abs(la - lb) + 1e-4, la + lb - 1e-4);

  const u = E.clone().sub(S);
  const v = H.clone().sub(E);
  const axis = u.clone().cross(v);
  if (axis.lengthSq() > 1e-10) {
    axis.normalize();
    const bend = u.angleTo(v);
    const wanted = Math.PI - Math.acos(clamp((la * la + lb * lb - dist * dist) / (2 * la * lb), -1, 1));
    rotateBoneByWorldQuat(lower, _q.setFromAxisAngle(axis, wanted - bend));
  }

  end.getWorldPosition(_c);
  upper.getWorldPosition(_a);
  _t.copy(target).sub(_a).normalize();
  _c.sub(_a).normalize();
  rotateBoneByWorldQuat(upper, new THREE.Quaternion().setFromUnitVectors(_c, _t));
}

function makeLabel(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(text, 256, 32);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(3.2, 0.4, 1);
  sprite.position.y = PLAYER_HEIGHT + 0.35;
  return sprite;
}
