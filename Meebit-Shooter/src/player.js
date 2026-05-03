// Player module — loads real Meebit GLB if available, falls back to voxel avatar.
//
// Two modes:
//   A) GLB mode — when user linked a Meebit via Larva Labs owner-sign flow,
//      we load the rigged GLB and drive its bones procedurally.
//   B) Voxel mode — built-from-boxes placeholder for non-holders.
//
// The voxel fallback ensures non-holders can still play.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { scene, camera } from './scene.js';
import { PLAYER, WEAPONS, GUEST_AVATAR_URL } from './config.js';
import { S } from './state.js';
import { attachMixer, animationsReady, applyGunHoldPose, GUN_HOLD_EXCLUDE_BONES, IDLE_HIP_EXCLUDE_BONES } from './animation.js';

export const player = {
  obj: null,
  pos: new THREE.Vector3(0, 0, 0),
  vel: new THREE.Vector3(0, 0, 0),
  facing: 0,
  ready: false,
  mode: 'voxel', // 'voxel' | 'glb'
  // Shared parts (voxel + approximate GLB refs)
  body: null, head: null,
  legL: null, legR: null, armL: null, armR: null,
  gun: null, gunMat: null, muzzle: null,
  // GLB-specific
  skeleton: null,
  bones: {},
  restQuat: {},
  restPos: {},
  skinnedMeshes: [],
  _walkPhase: 0,
};

// ----------------------------------------------------------------------------
//  PUBLIC API
// ----------------------------------------------------------------------------

/**
 * Loads the player avatar.
 *   opts: {
 *     glbUrl?: string   — signed Meebit GLB URL (priority 1)
 *     tryGuestGlb?: bool — try GUEST_AVATAR_URL before voxel (priority 2)
 *   }
 * Fallback order: opts.glbUrl → guest GLB → voxel
 */
export function loadPlayer(onProgress, onDone, onError, opts = {}) {
  if (opts.glbUrl) {
    // Signed Meebit — user linked their wallet via Larva Labs
    tryLoadGLB(opts.glbUrl, onProgress, onDone, onError, /*isSigned*/true);
    return;
  }
  if (opts.tryGuestGlb !== false) {
    // Try bundled guest meebit — silently fall through to voxel if missing
    tryLoadGLB(GUEST_AVATAR_URL, onProgress, () => {
      console.log('[player] guest avatar GLB loaded');
      onDone && onDone();
    }, () => {
      // Guest GLB not present (404) — fall back to voxel silently
      console.log('[player] guest GLB not found, using voxel');
      buildVoxel(onProgress, onDone, onError);
    }, /*isSigned*/false);
    return;
  }
  buildVoxel(onProgress, onDone, onError);
}

/**
 * Swap the current avatar at runtime (e.g. after the player links their wallet
 * and picks a Meebit). Removes existing avatar, loads new one.
 */
export function swapAvatarGLB(glbUrl, onDone, onError) {
  if (player.obj) {
    scene.remove(player.obj);
    player.obj = null;
  }
  player.ready = false;
  tryLoadGLB(glbUrl, null, onDone, onError, /*isSigned*/true);
}

// ----------------------------------------------------------------------------
//  GLB MODE
// ----------------------------------------------------------------------------

function tryLoadGLB(url, onProgress, onDone, onError, isSigned = true) {
  const loader = new GLTFLoader();
  loader.load(
    url,
    (gltf) => {
      try {
        attachGLB(gltf);
        onDone && onDone();
      } catch (err) {
        console.warn('[player] GLB attach failed', err);
        if (isSigned) {
          // Signed URL attachment failed — fall back to voxel with warning
          buildVoxel(null, onDone, onError);
        } else {
          // Guest GLB attach failed — let caller decide
          onError && onError(err);
        }
      }
    },
    (xhr) => {
      onProgress && onProgress(xhr);
    },
    (err) => {
      if (isSigned) {
        console.warn('[player] signed GLB load failed, falling back to voxel', err);
        buildVoxel(null, onDone, onError);
      } else {
        // Guest GLB missing — let caller handle silently
        onError && onError(err);
      }
    }
  );
}

function attachGLB(gltf) {
  const meebit = gltf.scene;
  meebit.scale.setScalar(PLAYER.scale);

  let skeleton = null;
  const skinnedMeshes = [];
  meebit.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) {
        o.material.roughness = 0.75;
        o.material.metalness = 0.1;
      }
    }
    if (o.isSkinnedMesh) {
      skinnedMeshes.push(o);
      if (!skeleton) skeleton = o.skeleton;
      o.frustumCulled = false;
    }
  });

  if (!skeleton) {
    throw new Error('No skeleton in GLB');
  }

  // Wrap in an outer Group + pre-rotate the VRM 180° on Y. Same pattern as
  // meebitsPublicApi.js / herdVrmLoader.js — VRMs authored for Meebits.app
  // face -Z in their bind pose, but Mixamo walk clips drive motion in +Z,
  // and the game sets `player.obj.rotation.y = atan2(dx,dz)` expecting +Z
  // forward. Without this wrap the player visibly faces (and fires) backward
  // relative to movement direction. The outer Group is what the game
  // rotates; the inner VRM's pre-rotation aligns its animation-forward
  // with the outer Group's forward. Animation mixer still binds to the
  // inner scene's bones so nothing else has to change.
  const wrapper = new THREE.Group();
  meebit.rotation.y = Math.PI;
  wrapper.add(meebit);
  wrapper.position.copy(player.pos);

  // Cache rest pose for procedural animation
  player.bones = {};
  player.restQuat = {};
  player.restPos = {};
  for (const bone of skeleton.bones) {
    player.bones[bone.name] = bone;
    player.restQuat[bone.name] = bone.quaternion.clone();
    player.restPos[bone.name] = bone.position.clone();
    bone.matrixAutoUpdate = true;
  }
  player.skeleton = skeleton;
  player.skinnedMeshes = skinnedMeshes;

  // Attach a gun to the right hand bone if present. Try every naming
  // convention we support: Mixamo/Unreal-style (hand_r), Meebits VRM
  // (RightHandBone), and generic humanoid (RightHand / right_hand).
  const gunGeo = new THREE.BoxGeometry(0.1, 0.1, 0.4);
  const gunMat = new THREE.MeshStandardMaterial({
    // Matrix green — emissive at intensity 1.2 so the gun glows
    // against any chapter palette and matches the rest of the
    // matrix-green UI accents (tutorial-complete, gravestones, etc).
    color: 0x00ff66,
    emissive: 0x00ff66,
    emissiveIntensity: 1.2,
  });
  const gun = new THREE.Mesh(gunGeo, gunMat);
  gun.castShadow = true;
  const handBone = player.bones['hand_r']
               || player.bones['RightHandBone']
               || player.bones['RightHand']
               || player.bones['right_hand'];
  if (handBone) {
    handBone.add(gun);
    // EMPIRICAL FINDING: After diagnostic cycling through all 6
    // axis-aligned rotations and capturing side-view screenshots,
    // index 4 (IDENTITY rotation — no extra rotation applied) was
    // the orientation that put the barrel pointing forward in the
    // meebit's aim direction. So the gun box's local +Z axis
    // (the BoxGeometry's depth) maps directly onto the hand's
    // forward direction once the gun-hold pose has rotated the
    // arm into the shooter stance. Lock that in.
    gun.rotation.set(0, 0, 0);
    // Position seats the gun's grip near the wrist pivot. With
    // identity rotation, the gun's local axes match the hand bone's
    // local axes. Hand-local +Z ends up "forward" after the pose
    // runs; offset along +Z puts the gun forward of the wrist.
    // The 0.4-deep gun centered at z=0.2 means the back end (grip)
    // is at the wrist and the muzzle projects 0.4u forward.
    gun.position.set(0, 0, 0.2);
  } else {
    // Fallback path — no hand bone found. Position+orient relative
    // to the meebit body root (world-aligned axes, +Z is forward).
    gun.position.set(0.4, 1.3, 0.3);
    gun.rotation.set(0, 0, 0);
    meebit.add(gun);
  }
  // Muzzle light — sits at the END of the barrel (gun-local +Z is
  // the barrel-tip direction). Gun box is 0.4 deep, half-extent 0.2,
  // muzzle just past that.
  const muzzle = new THREE.PointLight(0x00ff66, 0, 6, 2);
  gun.add(muzzle);
  muzzle.position.set(0, 0, 0.25);

  scene.add(wrapper);

  // PERMANENT player fill lights — parented to the CAMERA, not the
  // player wrapper. The player rotates to face the mouse, so lights
  // on the wrapper rotate WITH the player — meaning the lit side
  // changes depending on which way the player faces. By parenting
  // to the camera, the lights always illuminate from the camera's
  // viewpoint: whatever the camera sees is lit, regardless of
  // player rotation.
  //
  // Key: offset slightly below camera toward the player (y=-4, z=-6
  //   in camera-local space = closer to the scene, shining down).
  //   Wide range + low decay for soft even wash over the full body.
  // Fill: offset to the side for gentle cross-lighting that adds
  //   dimension without creating harsh shadows.
  const playerFillTop = new THREE.PointLight(0xffffff, 3.0, 35, 0.5);
  playerFillTop.position.set(0, -4, -6);  // camera-local: below + forward
  camera.add(playerFillTop);
  const playerFillRim = new THREE.PointLight(0xffffff, 1.2, 25, 0.7);
  playerFillRim.position.set(3, -2, -8);  // camera-local: right + forward
  camera.add(playerFillRim);

  // player.obj is the WRAPPER (outer group that the game rotates).
  // player._innerMesh is the actual VRM scene — needed by tryAttachPlayerMixer
  // so the animation mixer binds to the real skeleton, not the empty wrapper.
  player.obj = wrapper;
  player._innerMesh = meebit;
  player.gun = gun;
  player.gunMat = gunMat;
  player.muzzle = muzzle;
  player.mode = 'glb';
  player.ready = true;
  // Attach walk mixer if clips already loaded. If not yet loaded, the
  // module-level preloadAnimations() call will finish later and the
  // update tick will no-op until mixer is attached.
  tryAttachPlayerMixer();
}

/**
 * Attach the player's animation mixer ONLY when:
 *   - player is in GLB mode
 *   - clips are loaded
 *   - the player's skeleton uses VRM-spec bone names (our Mixamo retarget
 *     targets "HipsBone", "LeftUpperLegBone", etc.)
 *
 * Two Meebit skeletons share these bone names in this project:
 *
 *   A) Meebits.app VRMs (civilians, herds): rest pose is identity T-pose.
 *      Mixamo rotations apply directly.
 *
 *   B) Larva-Labs wallet-signed GLBs (player's own Meebit): rest pose is
 *      NOT a T-pose. HipsBone is rotated 180° around Y, legs 180° around
 *      Z/X, shoulders around diagonals. Applying Mixamo rotations here
 *      without compensation produces the "balled up" look — the character
 *      folds in on itself because every Mixamo rotation overlays onto a
 *      pre-rotated bone.
 *
 * We detect case (B) by checking whether any of the key limb/hip bones
 * has a non-identity rest quaternion. If so, we turn on rest-pose
 * compensation when attaching the mixer; the animation module then
 * pre-multiplies every rotation keyframe by the target bone's rest
 * quaternion so the motion plays "on top of" the bind pose.
 */
function tryAttachPlayerMixer() {
  if (player.mixer) return true;
  if (!player.obj || player.mode !== 'glb') return false;
  if (!animationsReady()) return false;

  // Traverse the INNER mesh (the actual VRM scene), not the outer wrapper
  // Group. The wrapper exists only to absorb the game's rotation.y setter
  // so bone lookups find nothing on it. player._innerMesh is set in
  // attachGLB before this is called.
  const meshForBones = player._innerMesh || player.obj;

  // VRM-named-skeleton detection: look for HipsBone anywhere in the tree.
  let hipsBone = null;
  const keyBones = {};
  meshForBones.traverse(o => {
    if (!o.isBone) return;
    if (o.name === 'HipsBone') hipsBone = o;
    // Sample a few bones likely to expose a Larva-Labs bind pose.
    if (o.name === 'HipsBone'          ||
        o.name === 'LeftUpperLegBone'  ||
        o.name === 'RightUpperLegBone' ||
        o.name === 'LeftShoulderBone'  ||
        o.name === 'RightShoulderBone') {
      keyBones[o.name] = o;
    }
  });

  if (!hipsBone) {
    // Rig uses different bone names entirely (e.g. an Unreal "pelvis/thigh_l"
    // rig). Mixamo retarget would drive zero bones — fall through to the
    // procedural animateGLB path.
    player._mixerSkipped = true;
    return false;
  }

  // Decide whether we need rest-pose compensation. A true T-pose rig has
  // all-identity rest quaternions on these bones; the Larva-Labs rig has
  // components close to ±1.0. We use 0.1 as the "clearly non-identity"
  // threshold — more than floating-point noise, less than a 15° deviation.
  let needsCompensation = false;
  for (const name in keyBones) {
    const q = keyBones[name].quaternion;
    if (Math.abs(q.x) > 0.1 || Math.abs(q.y) > 0.1 || Math.abs(q.z) > 0.1 ||
        Math.abs(1 - q.w) > 0.1) {
      needsCompensation = true;
      break;
    }
  }

  if (needsCompensation) {
    console.info('[player] Larva-Labs bind pose detected — enabling rest-pose compensation');
  }

  // Bones we DON'T want the walk/run clips to animate. Imported from
  // animation.js so the player, followers, and pixl pals all use the
  // exact same exclusion list (they all share the Meebit VRM rig).
  //
  // We use the per-clip excludeBones shape: arms are excluded on EVERY
  // clip (gun-hold pose takes over each frame), and the idle clips
  // additionally exclude hip/spine/chest because the Mixamo Standing
  // Idles bake in a 60°+ hip cock that tips Meebit VRMs sideways.
  //
  // Mixer binds to the INNER mesh because that's where the SkinnedMesh
  // and Skeleton live — the wrapper Group has nothing for the mixer to
  // animate.
  player.mixer = attachMixer(meshForBones, {
    restPoseCompensation: needsCompensation,
    excludeBones: {
      default: GUN_HOLD_EXCLUDE_BONES,
      idle2:   IDLE_HIP_EXCLUDE_BONES,
      idle3:   IDLE_HIP_EXCLUDE_BONES,
      idle4:   IDLE_HIP_EXCLUDE_BONES,
    },
  });
  player.mixer.playIdle(2);   // start in a still idle; update loop flips to walk when moving
  return true;
}

// ----------------------------------------------------------------------------
//  VOXEL FALLBACK MODE
// ----------------------------------------------------------------------------

const PALETTE = {
  skin: 0xd9b08c, hat: 0x1a1a1a, shirt: 0x2c2c2c, pants: 0x1a1a24,
  boots: 0x0a0a0a, glasses: 0xff3cac, skull: 0xffffff, gun: 0x00ff66,
};

function buildVoxel(onProgress, onDone, onError) {
  try {
    const root = new THREE.Group();
    root.position.copy(player.pos);

    // Head assembly
    const head = new THREE.Group();
    head.position.y = 2.7;
    const hat = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.55, 0.95),
      new THREE.MeshStandardMaterial({ color: PALETTE.hat, roughness: 0.8 })
    );
    hat.position.y = 0.55; hat.castShadow = true; head.add(hat);
    const brim = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 0.1, 1.15),
      new THREE.MeshStandardMaterial({ color: PALETTE.hat, roughness: 0.7 })
    );
    brim.position.y = 0.28; head.add(brim);
    const face = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.6, 0.85),
      new THREE.MeshStandardMaterial({ color: PALETTE.skin, roughness: 0.9 })
    );
    face.position.y = -0.05; face.castShadow = true; head.add(face);
    const glasses = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.12, 0.05),
      new THREE.MeshStandardMaterial({
        color: PALETTE.glasses, emissive: PALETTE.glasses, emissiveIntensity: 1.8,
      })
    );
    glasses.position.set(0, -0.02, 0.44); head.add(glasses);
    root.add(head);

    // Torso
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.05, 1.2, 0.7),
      new THREE.MeshStandardMaterial({ color: PALETTE.shirt, roughness: 0.8 })
    );
    body.position.y = 1.75; body.castShadow = true; root.add(body);
    const skull = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.05),
      new THREE.MeshStandardMaterial({ color: PALETTE.skull, emissive: 0x888888, emissiveIntensity: 0.4 })
    );
    skull.position.set(0, 1.75, 0.36); root.add(skull);

    // Arms
    const armGeo = new THREE.BoxGeometry(0.32, 1.0, 0.32);
    const armMat = new THREE.MeshStandardMaterial({ color: PALETTE.shirt, roughness: 0.8 });
    const armL = new THREE.Group();
    const armLMesh = new THREE.Mesh(armGeo, armMat);
    armLMesh.position.y = -0.5; armLMesh.castShadow = true; armL.add(armLMesh);
    armL.position.set(-0.68, 2.3, 0); root.add(armL);
    const armR = new THREE.Group();
    const armRMesh = new THREE.Mesh(armGeo, armMat);
    armRMesh.position.y = -0.5; armRMesh.castShadow = true; armR.add(armRMesh);
    armR.position.set(0.68, 2.3, 0); root.add(armR);

    // Gun
    const gunMat = new THREE.MeshStandardMaterial({
      color: PALETTE.gun, emissive: PALETTE.gun, emissiveIntensity: 0.9,
      metalness: 0.6, roughness: 0.3,
    });
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.6), gunMat);
    gun.position.set(0, -0.9, 0.2); gun.castShadow = true; armR.add(gun);
    const barrelTip = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.2), gunMat);
    barrelTip.position.set(0, 0, 0.4); gun.add(barrelTip);
    const muzzle = new THREE.PointLight(0x00ff66, 0, 5, 2);
    muzzle.position.set(0, 0, 0.6); gun.add(muzzle);

    // Legs
    const legGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
    const legMat = new THREE.MeshStandardMaterial({ color: PALETTE.pants, roughness: 0.85 });
    const legL = new THREE.Group();
    const legLMesh = new THREE.Mesh(legGeo, legMat);
    legLMesh.position.y = -0.5; legLMesh.castShadow = true; legL.add(legLMesh);
    const bootL = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.25, 0.55),
      new THREE.MeshStandardMaterial({ color: PALETTE.boots, roughness: 0.6 })
    );
    bootL.position.set(0, -1.05, 0.05); legL.add(bootL);
    legL.position.set(-0.28, 1.1, 0); root.add(legL);
    const legR = new THREE.Group();
    const legRMesh = new THREE.Mesh(legGeo, legMat);
    legRMesh.position.y = -0.5; legRMesh.castShadow = true; legR.add(legRMesh);
    const bootR = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.25, 0.55),
      new THREE.MeshStandardMaterial({ color: PALETTE.boots, roughness: 0.6 })
    );
    bootR.position.set(0, -1.05, 0.05); legR.add(bootR);
    legR.position.set(0.28, 1.1, 0); root.add(legR);

    root.scale.setScalar(0.55 * (PLAYER.scale / 1.8));
    scene.add(root);

    // Permanent fill lights — same as the GLB path, mirrored here so
    // the legacy/voxel mode also gets clear visibility in moody chapter
    // lighting. See the GLB-path version for the rationale.
    const playerFillTop = new THREE.PointLight(0xffffff, 3.0, 35, 0.5);
    playerFillTop.position.set(0, -4, -6);
    camera.add(playerFillTop);
    const playerFillRim = new THREE.PointLight(0xffffff, 1.2, 25, 0.7);
    playerFillRim.position.set(3, -2, -8);
    camera.add(playerFillRim);

    player.obj = root;
    player.head = head; player.body = body;
    player.legL = legL; player.legR = legR;
    player.armL = armL; player.armR = armR;
    player.gun = gun; player.gunMat = gunMat; player.muzzle = muzzle;
    player.mode = 'voxel';
    player.ready = true;

    // Fake load progress so loading screen still animates
    let pct = 0;
    const tick = setInterval(() => {
      pct += 25 + Math.random() * 20;
      if (pct >= 100) {
        clearInterval(tick);
        onProgress && onProgress({ loaded: 100, total: 100 });
        onDone && onDone();
      } else {
        onProgress && onProgress({ loaded: pct, total: 100 });
      }
    }, 60);
  } catch (err) {
    onError && onError(err);
  }
}

// ----------------------------------------------------------------------------
//  ANIMATION (works for both modes)
// ----------------------------------------------------------------------------

const _qDelta = new THREE.Quaternion();
const _euler = new THREE.Euler();

function rotateBone(name, dx, dy, dz) {
  const b = player.bones[name];
  if (!b) return;
  const rest = player.restQuat[name];
  _euler.set(dx, dy, dz, 'XYZ');
  _qDelta.setFromEuler(_euler);
  b.quaternion.copy(rest).multiply(_qDelta);
}

export function animatePlayer(dt, moving, timeElapsed) {
  if (!player.ready) return;

  if (player.mode === 'glb') {
    // Attempt to attach the mixer once anims are loaded. Only works on
    // VRM rigs (HipsBone etc). Non-VRM rigs (Larva-Labs Meebit) fall
    // through to the procedural animateGLB path.
    if (!player.mixer && !player._mixerSkipped) {
      tryAttachPlayerMixer();
    }

    if (player.mixer) {
      // VRM rig with mixer: drive walk/idle based on whether the player is
      // moving this frame. Walk is the same clip civilians use and has only
      // trivial baked offsets (2.7° hip twist, 5° forward spine), so no
      // sideways tilt. The arm tracks are excluded at attach time, so only
      // the legs/hip/spine/head cycle from the clip; the arms stay in T-pose
      // until the gun-hold pose below overrides them.
      if (moving) {
        player.mixer.playWalk();
        player.mixer.setSpeed(1.2);   // slight bump so stride matches ground speed
      } else {
        player.mixer.playIdle(2);     // one of the standing idles (civilians don't use idle, so this is fine)
        player.mixer.setSpeed(1.0);
      }
      player.mixer.update(dt);

      // Static shooter pose on the arm bones — the mixer excluded them so
      // the walk/idle cycle doesn't fight this write. Target the inner
      // mesh where the actual bones live (player.obj is the outer
      // wrapper Group that carries no bones).
      applyGunHoldPose(player._innerMesh || player.obj);
    } else {
      // Larva-Labs rig (or anims not yet loaded): use procedural walk.
      animateGLB(dt, moving, timeElapsed);
    }
  } else {
    animateVoxel(dt, moving, timeElapsed);
  }

  // Invuln flicker — keep this so damage feedback still works.
  // While piloting a mech, however, the player avatar must stay
  // hidden (the mech body replaces it). main.js sets player.obj.visible
  // = false on enterMech, but without the S.pilotingMech guard below,
  // this every-frame block would flip visibility back on every tick —
  // showing the player + their gun INSIDE the mech, which read to
  // playtesters as "the primary weapon is still firing." Gate on the
  // pilot flag set by enterMech / exitMech in mech.js.
  if (S.pilotingMech) {
    player.obj.visible = false;
  } else if (S.invulnTimer > 0) {
    player.obj.visible = Math.floor(S.invulnTimer * 20) % 2 === 0;
  } else {
    player.obj.visible = true;
  }
}

function animateGLB(dt, moving, timeElapsed) {
  player._walkPhase += dt * (moving ? 10 : 3);
  const target = moving ? 1 : 0;
  const swing = Math.sin(player._walkPhase);
  const legSwing = swing * target * 1.1;
  const armSwing = swing * target * 0.5;

  // Try common bone name conventions (Meebits + generic humanoid)
  rotateBone('thigh_l', legSwing, 0, 0);
  rotateBone('thigh_r', -legSwing, 0, 0);
  rotateBone('calf_l', Math.max(0, -legSwing) * 1.1, 0, 0);
  rotateBone('calf_r', Math.max(0, legSwing) * 1.1, 0, 0);
  rotateBone('foot_l', legSwing * 0.3, 0, 0);
  rotateBone('foot_r', -legSwing * 0.3, 0, 0);
  rotateBone('upperarm_l', -armSwing, 0, 0);
  rotateBone('lowerarm_l', Math.abs(armSwing) * 0.8, 0, 0);
  // Right arm in shooting stance
  rotateBone('upperarm_r', -1.35, 0, 0);
  rotateBone('lowerarm_r', 0.15, 0, 0);
  rotateBone('spine_03', 0, 0, Math.sin(timeElapsed * 2) * 0.04);
  rotateBone('spine_01', 0, Math.sin(player._walkPhase) * target * 0.08, 0);
  rotateBone('head', 0, Math.sin(timeElapsed * 1.2) * 0.08, 0);

  for (const skin of player.skinnedMeshes) skin.skeleton.update();
}

// Shooting stance — the right arm extends forward holding the gun
// instead of hanging at the side. Without this offset the gun rests
// at the player's hip; with it, the arm sticks out toward where the
// player is aiming. Matches the skinned-rig stance (rotateBone of
// upperarm_r at -1.35 in animateSkinned).
const SHOOTING_STANCE_X = -1.35;

function animateVoxel(dt, moving, timeElapsed) {
  if (moving) {
    player._walkPhase += dt * 10;
    const sw = Math.sin(player._walkPhase) * 0.5;
    player.legL.rotation.x = sw;
    player.legR.rotation.x = -sw;
    // Left arm — natural arm-swing
    player.armL.rotation.x = -sw * 0.5;
    // Right arm — held forward in shooting stance with reduced sway
    // so the gun doesn't bob wildly while the player runs.
    player.armR.rotation.x = SHOOTING_STANCE_X + sw * 0.08;
    player.obj.position.y = player.pos.y + Math.abs(Math.sin(player._walkPhase)) * 0.08;
  } else {
    const t = timeElapsed * 2;
    player.legL.rotation.x *= 0.85;
    player.legR.rotation.x *= 0.85;
    player.armL.rotation.x *= 0.85;
    // Right arm holds the shooting stance with a small idle breathing
    // wobble — the gun doesn't drift back to a relaxed hip position.
    player.armR.rotation.x = SHOOTING_STANCE_X + Math.sin(t) * 0.03;
    player.obj.position.y = player.pos.y + Math.sin(t) * 0.03;
  }
}

export function recolorGun(hexColor) {
  if (!player.gunMat) return;
  player.gunMat.color.setHex(hexColor);
  player.gunMat.emissive.setHex(hexColor);
  if (player.muzzle) player.muzzle.color.setHex(hexColor);
}

export function resetPlayer() {
  player.pos.set(0, 0, 0);
  player.vel.set(0, 0, 0);
  player.facing = 0;
  if (player.obj) player.obj.position.copy(player.pos);
  if (player.gunMat) {
    const c = WEAPONS[S.currentWeapon]?.color ?? 0x4ff7ff;
    player.gunMat.color.setHex(c);
    player.gunMat.emissive.setHex(c);
  }
}

/**
 * Player "aura" -- warm white fill light that actually illuminates the
 * ground around the player + a chapter-tinted accent light for visual
 * identity. The fill provides real illumination in the dark arena; the
 * accent sets the theme mood.
 *
 * Separate from the existing `player.muzzle` light (which fires only
 * during shots).
 */
export function setPlayerGlowColor(hex) {
  if (!player.obj) return;
  if (!player._glowFill) {
    // Warm-white fill — bright enough to keep the player legible against
    // dark floor sections, dim enough that the glow doesn't wash out the
    // surrounding environment. Previous tuning had the fill at intensity
    // 5.0 / range 9, which pushed a big wash of light onto the floor
    // around the player; halving both restores a "local pool of light"
    // feel without losing legibility.
    const fill = new THREE.PointLight(0xfff4d6, 2.2, 6.0, 2);
    fill.position.set(0, 3.2, 0);
    player.obj.add(fill);
    player._glowFill = fill;
  }
  if (!player._glowAccent) {
    // Chapter-tinted accent — subtle, just a hint of mood color at the
    // player's torso. Was 1.8 / 5.5, now 0.8 / 4.0 so the tint reads
    // more like body-lighting than ambient dye on the surrounding floor.
    const accent = new THREE.PointLight(hex, 0.8, 4.0, 2);
    accent.position.set(0, 1.4, 0);
    player.obj.add(accent);
    player._glowAccent = accent;
  } else {
    player._glowAccent.color.setHex(hex);
  }
}
