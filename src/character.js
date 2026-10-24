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

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER_HEIGHT, TEAMS } from './shared.js';
import { SKINS, assets } from './assets.js';

const LOCOMOTION = ['run_forward', 'run_backward', 'strafe_left', 'strafe_right'];
const RUN_ANIM_SPEED = 5; // m/s at which the run clips play at normal speed

// Rifle-local points (metres; the rifle's origin is its trigger, muzzle at -Z).
const RIGHT_GRIP = new THREE.Vector3(0, -0.07, 0.07); // centre of the right hand
const LEFT_GRIP = new THREE.Vector3(0, -0.03, -0.26); // left hand on the handguard
const MUZZLE = new THREE.Vector3(0, 0.02, -0.5);

const { damp, clamp } = THREE.MathUtils;
const gripOffsets = {}; // gender -> Matrix4, hand space -> rifle space

export function makeMuzzleFlash() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffd36b, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const flash = new THREE.Group();
  for (const rz of [0, Math.PI / 2]) {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.28), mat);
    quad.rotation.set(Math.PI / 2, 0, rz);
    quad.position.z = -0.1;
    flash.add(quad);
  }
  flash.position.copy(MUZZLE);
  flash.visible = false;
  return flash;
}

export function makeRifle() {
  const rifle = assets.rifle.clone();
  rifle.userData.flash = makeMuzzleFlash();
  rifle.add(rifle.userData.flash);
  return rifle;
}

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
    this.flashTime = 0;

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
    this.actions.idle.setEffectiveWeight(1);

    // Rifle, held by the right hand.
    this.rifle = makeRifle();
    this.rifleHolder = new THREE.Group();
    this.rifleHolder.add(this.rifle);
    this.bones.rightHand.add(this.rifleHolder);
    this.calibrateGrip();

    // Blob shadow and name label
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.015;
    this.object.add(this.shadow);
    this.label = makeLabel(name, TEAMS[team]?.color ?? '#fff');
    this.object.add(this.label);
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

  fire() {
    this.recoil = 1;
    this.flashTime = 0.05;
    this.rifle.userData.flash.rotation.z = Math.random() * Math.PI;
  }

  // state: { pos:[x,y,z], yaw, pitch, dead, vel?:[x,y,z] }
  // Pass vel to drive the animation directly (the preview page does);
  // otherwise it's estimated from successive positions.
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
    this.flashTime -= dt;
    this.rifle.userData.flash.visible = this.flashTime > 0;

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
    if (weightSum > 0.001) {
      cycle /= weightSum;
      this.phase = (this.phase + (dt / cycle) * clamp(speed / RUN_ANIM_SPEED, 0.6, 1.6)) % 1;
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

    // ---- left hand IK onto the handguard ----------------------------------
    if (living > 0.5) {
      const target = this.rifle.localToWorld(LEFT_GRIP.clone());
      solveTwoBone(this.bones.leftUpper, this.bones.leftLower, this.bones.leftHand, target);
    }

    this.shadow.visible = this.deathBlend < 0.5;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    // Geometry and materials are shared with the loaded assets; only the
    // per-character extras are ours to free.
    for (const o of [this.shadow, this.label, this.rifle.userData.flash]) {
      o.traverse((c) => {
        c.geometry?.dispose();
        c.material?.map?.dispose();
        c.material?.dispose();
      });
    }
  }
}

// ---- bone helpers --------------------------------------------------------------

const _pq = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();

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
