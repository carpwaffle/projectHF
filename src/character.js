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
//   - Reloading: the reload clip on the upper body only (legs keep running),
//     sped up to RELOAD_TIME; the left hand leaves the handguard (hand IK
//     blends out and back in) and swaps the magazine, timed to the clip.

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER_HEIGHT, RELOAD_TIME, TEAMS } from './shared.js';
import { SKINS, assets } from './assets.js';
import { makeMuzzleFlash } from './effects.js';

const LOCOMOTION = ['run_forward', 'run_backward', 'strafe_left', 'strafe_right'];
const RUN_ANIM_SPEED = 5; // m/s at which the run clips play at normal speed

// Upper-body bones (three.js strips the dots: "UpperArm.L" -> "UpperArmL").
const UPPER_BODY = /^(Abdomen|Torso|Neck|Head|Shoulder|UpperArm|LowerArm|Palm|Fingers|Thumb)/;
// The mixer averages actions by weight, so to make the reload win on the
// upper body (over the full-body locomotion clips) it gets a heavy weight.
const RELOAD_WEIGHT = 12;
const upperBodyClips = {}; // gender -> reload clip with only upper-body tracks

function upperBodyClip(gender, clip) {
  upperBodyClips[gender] ??= new THREE.AnimationClip(
    `${clip.name}_upper`, clip.duration, clip.tracks.filter((t) => UPPER_BODY.test(t.name)),
  );
  return upperBodyClips[gender];
}

// Rifle-local points (metres; the rifle's origin is its trigger, muzzle at -Z).
const RIGHT_GRIP = new THREE.Vector3(0, -0.07, 0.07); // centre of the right hand
const LEFT_GRIP = new THREE.Vector3(0, -0.03, -0.26); // left hand on the handguard
// Where shots leave the barrel: the lower part of the barrel's end, below the
// front sight (measured from the model; sight top ~0.07, barrel ~0.03-0.056).
// Lower than the barrel's middle on purpose: in first person the tracer
// climbs toward the crosshair, and starting here it visibly leaves the muzzle
// rather than appearing over the sight.
export const MUZZLE = new THREE.Vector3(0, 0.028, -0.635);
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
const gripOffsets = {}; // gender -> Matrix4, hand space -> rifle space
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

export function makeRifle() {
  const rifle = assets.rifle.clone();
  rifle.userData.flash = makeMuzzleFlash();
  rifle.userData.flash.position.copy(MUZZLE);
  rifle.add(rifle.userData.flash);
  rifle.userData.mag = makeMagazine();
  rifle.add(rifle.userData.mag);
  return rifle;
}

const SHADOW_OPACITY = 0.28;
const SHADOW_FADE_HEIGHT = 4; // metres above the ground at which the blob shadow is gone

export class Character {
  constructor(name, skin, team) {
    const skinName = SKINS[((skin % SKINS.length) + SKINS.length) % SKINS.length];
    this.gender = skinName.startsWith('Female') ? 'female' : 'male';

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
    this.onSound = null; // (name, intensity) => void
    this.airborne = false;
    this.fallSpeed = 0;

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
      rightHand: bone('PalmR'),
      leftUpper: bone('UpperArmL'),
      leftLower: bone('LowerArmL'),
      leftHand: bone('PalmL'),
    };

    // Animation
    this.mixer = new THREE.AnimationMixer(this.model);
    const clips = assets.clips[this.gender];
    this.actions = {};
    for (const name of ['idle', ...LOCOMOTION, 'jump_loop', 'death']) {
      const action = this.mixer.clipAction(clips[name]);
      action.setEffectiveWeight(0).play();
      this.actions[name] = action;
    }
    for (const name of LOCOMOTION) this.actions[name].timeScale = 0; // driven by this.phase
    this.actions.death.setLoop(THREE.LoopOnce, 1);
    this.actions.death.clampWhenFinished = true;
    const reload = this.mixer.clipAction(upperBodyClip(this.gender, clips.reload));
    reload.setLoop(THREE.LoopOnce, 1);
    reload.clampWhenFinished = true;
    reload.timeScale = reload.getClip().duration / RELOAD_TIME;
    reload.setEffectiveWeight(0).play();
    this.actions.reload = reload;
    this.actions.idle.setEffectiveWeight(1);

    // Rifle, held by the right hand.
    this.rifle = makeRifle();
    this.rifleHolder = new THREE.Group();
    this.rifleHolder.add(this.rifle);
    this.bones.rightHand.add(this.rifleHolder);
    this.calibrateGrip();
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

  // Work out where the rifle sits in the right hand: in the idle pose, the
  // rifle should point straight ahead with RIGHT_GRIP in the palm. The result
  // is the same for every character of a gender, so it's cached.
  calibrateGrip() {
    if (!gripOffsets[this.gender]) {
      this.mixer.update(0);
      this.object.updateMatrixWorld(true);
      const hand = this.bones.rightHand;
      const palm = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld);
      const fingers = hand.children.find((c) => c.isBone);
      const centre = fingers ? palm.lerp(new THREE.Vector3().setFromMatrixPosition(fingers.matrixWorld), 0.5) : palm;
      const rifleWorld = new THREE.Matrix4().makeTranslation(centre.sub(RIGHT_GRIP)); // facing -Z, upright
      gripOffsets[this.gender] = hand.matrixWorld.clone().invert().multiply(rifleWorld);
    }
    gripOffsets[this.gender].decompose(this.rifleHolder.position, this.rifleHolder.quaternion, this.rifleHolder.scale);
  }

  // How the magazine sits in the left hand: in the palm (between the hand
  // and finger joints), turned the way it was in the rifle at the moment the
  // hand takes it out / puts it in (sampled from the reload clip). Cached per gender.
  calibrateMagazine() {
    if (!magHolds[this.gender]) {
      const action = this.actions.reload;
      const mag = this.rifle.userData.mag;
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
    const mag = this.rifle.userData.mag;
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
    _invRifle.copy(this.rifle.matrixWorld).invert();
    _m.multiplyMatrices(_invRifle, hand.matrixWorld);
    _m.decompose(_hp, _hq, _hs);
    const inHandPos = hold.position.clone().multiply(_hs).applyQuaternion(_hq).add(_hp);
    const inHandQ = _hq.multiply(hold.quaternion);
    mag.position.lerpVectors(restPos, inHandPos, held);
    mag.quaternion.slerpQuaternions(restQ, inHandQ, held);
  }

  // World position of the rifle's muzzle (where tracers start).
  muzzleWorld(target = new THREE.Vector3()) {
    return this.rifle.localToWorld(target.copy(MUZZLE));
  }

  fire() {
    this.recoil = 1;
    this.rifle.userData.flash.userData.fire();
    this.onSound?.('shot', 1);
  }

  // state: { pos:[x,y,z], yaw, pitch, dead, vel?:[x,y,z], ground?, reloading?, protected? }
  // Pass vel to drive the animation directly (the preview page does);
  // otherwise it's estimated from successive positions. ground: height of
  // the surface under the player (keeps the blob shadow there while they're
  // in the air); defaults to their feet.
  update(dt, state) {
    if (dt <= 0) return;
    const pos = state.pos;

    // ---- velocity ----------------------------------------------------------
    if (state.vel) {
      this.velocity.set(...state.vel);
    } else if (this.lastPos) {
      const d = [0, 1, 2].map((i) => pos[i] - this.lastPos[i]);
      if (Math.hypot(...d) > 3) {
        this.velocity.set(0, 0, 0); // teleport (respawn)
      } else {
        const k = 1 - Math.exp(-15 * dt);
        this.velocity.x += (d[0] / dt - this.velocity.x) * k;
        this.velocity.y += (d[1] / dt - this.velocity.y) * k;
        this.velocity.z += (d[2] / dt - this.velocity.z) * k;
      }
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
      this.actions.reload.reset().play();
      this.onSound?.('reload', 1);
    }
    this.reloading = reloading;
    this.reloadBlend = damp(this.reloadBlend, reloading ? 1 : 0, 10, dt);

    const sin = Math.sin(state.yaw);
    const cos = Math.cos(state.yaw);
    const v = this.velocity;
    const fwd = -v.x * sin - v.z * cos;
    const right = v.x * cos - v.z * sin;
    const speed = Math.hypot(fwd, right);
    const alive = this.dead ? 0 : 1;

    this.move = damp(this.move, clamp(speed / 2, 0, 1) * alive, 10, dt);
    if (speed > 0.5) {
      this.dirF = damp(this.dirF, fwd / speed, 10, dt);
      this.dirS = damp(this.dirS, right / speed, 10, dt);
    }
    this.air = damp(this.air, Math.abs(v.y) > 1.2 && alive ? 1 : 0, 10, dt);
    this.recoil = damp(this.recoil, 0, 16, dt);
    this.rifle.userData.flash.userData.update(dt);

    // ---- clip weights ------------------------------------------------------
    const living = 1 - this.deathBlend;
    const ground = (1 - this.air) * living;
    const loco = this.move * ground;
    const f = this.dirF;
    const s = this.dirS;
    const total = Math.abs(f) + Math.abs(s) || 1;
    const w = {
      idle: (1 - this.move) * ground,
      run_forward: loco * Math.max(0, f) / total,
      run_backward: loco * Math.max(0, -f) / total,
      strafe_left: loco * Math.max(0, -s) / total,
      strafe_right: loco * Math.max(0, s) / total,
      jump_loop: this.air * living,
      death: this.deathBlend,
      reload: RELOAD_WEIGHT * this.reloadBlend * living,
    };
    for (const [name, weight] of Object.entries(w)) this.actions[name].setEffectiveWeight(weight);

    // Shared run phase: one cycle per weighted-average clip length, sped up
    // or slowed down to match the actual movement speed.
    let cycle = 0;
    let weightSum = 0;
    for (const name of LOCOMOTION) {
      cycle += w[name] * this.actions[name].getClip().duration;
      weightSum += w[name];
    }
    const lastPhase = this.phase;
    if (weightSum > 0.001) {
      cycle /= weightSum;
      this.phase = (this.phase + (dt / cycle) * clamp(speed / RUN_ANIM_SPEED, 0.6, 1.6)) % 1;
    }

    // ---- sounds: landings and footsteps -------------------------------------
    // Airborne = clearly above the surface below (state.ground; without it,
    // judged from vertical speed).
    const above = state.ground === undefined ? (Math.abs(v.y) > 2.5 ? 1 : 0) : pos[1] - state.ground;
    if (!this.dead && above > 0.3) {
      this.airborne = true;
      this.fallSpeed = Math.max(this.fallSpeed, -v.y);
    } else if (this.airborne && above < 0.08) {
      this.airborne = false;
      if (!this.dead && this.fallSpeed > 2) this.onSound?.('land', clamp(this.fallSpeed / 9, 0.5, 1.5));
      this.fallSpeed = 0;
    }
    // A foot lands twice per run cycle (phase 0 and 0.5).
    const stepped = this.phase < lastPhase || (lastPhase < 0.5 && this.phase >= 0.5);
    if (stepped && !this.airborne && !this.dead && this.move > 0.3 && weightSum > 0.001) {
      this.onSound?.('step', clamp(speed / 7, 0.4, 1));
    }
    for (const name of LOCOMOTION) {
      this.actions[name].time = this.phase * this.actions[name].getClip().duration;
    }

    this.mixer.update(dt);
    this.object.updateMatrixWorld(true);

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
    this.rifle.position.z = this.recoil * 0.05;
    this.rifle.updateMatrixWorld(true);

    // ---- left hand IK onto the handguard, blended out while reloading -----
    // (blending instead of switching, so the hand doesn't jump when the
    // reload ends and the IK takes over again).
    const ik = living > 0.5 ? 1 - this.reloadBlend : 0;
    if (ik > 0.001) {
      const { leftUpper: upper, leftLower: lower } = this.bones;
      _upperQ.copy(upper.quaternion);
      _lowerQ.copy(lower.quaternion);
      const target = this.rifle.localToWorld(LEFT_GRIP.clone());
      solveTwoBone(upper, lower, this.bones.leftHand, target);
      if (ik < 0.999) {
        upper.quaternion.copy(_upperQ.slerp(upper.quaternion, ik));
        lower.quaternion.copy(_lowerQ.slerp(lower.quaternion, ik));
        upper.updateMatrixWorld(true);
      }
    }
    relaxWristTwist(this.bones.leftLower, this.bones.leftHand, WRIST_TWIST_TO_FOREARM);

    // ---- magazine ----------------------------------------------------------
    const reload = this.actions.reload;
    const progress = this.reloading ? reload.time / reload.getClip().duration : 1;
    this.updateMagazine(progress);

    // Blob shadow stays on the surface below, fading and shrinking with height.
    const height = Math.max(0, pos[1] - (state.ground ?? pos[1]));
    const fade = Math.max(0, 1 - height / SHADOW_FADE_HEIGHT);
    this.shadow.position.y = 0.015 - height;
    this.shadow.scale.setScalar(0.6 + 0.4 * fade);
    this.shadow.material.opacity = SHADOW_OPACITY * fade;
    this.shadow.visible = this.deathBlend < 0.5 && fade > 0;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    // Geometry and materials are shared with the loaded assets; only the
    // per-character extras are ours to free.
    for (const o of [this.shadow, this.label, this.shield, this.rifle.userData.mag]) {
      o.traverse((c) => {
        c.geometry?.dispose();
        c.material?.map?.dispose();
        c.material?.dispose();
      });
    }
    // (the flash's geometry and textures are shared by all flashes)
    this.rifle.userData.flash.traverse((c) => c.material?.dispose());
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
const _upperQ = new THREE.Quaternion();
const _lowerQ = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _twist = new THREE.Quaternion();
const _part = new THREE.Quaternion();

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
