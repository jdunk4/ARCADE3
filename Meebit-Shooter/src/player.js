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
import { scene } from './scene.js';
import { PLAYER, WEAPONS, GUEST_AVATAR_URL } from './config.js';
import { S } from './state.js';
import { attachMixer, animationsReady } from './animation.js';

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
  meebit.position.copy(player.pos);

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

  // Attach a gun to the right hand bone if present
  const gunGeo = new THREE.BoxGeometry(0.1, 0.1, 0.4);
  const gunMat = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: 0x4ff7ff, emissiveIntensity: 0.6,
  });
  const gun = new THREE.Mesh(gunGeo, gunMat);
  gun.position.set(0, -0.05, 0.2);
  gun.castShadow = true;
  const handBone = player.bones['hand_r'] || player.bones['RightHand'] || player.bones['right_hand'];
  if (handBone) {
    handBone.add(gun);
  } else {
    gun.position.set(0.4, 1.3, 0.3);
    meebit.add(gun);
  }
  const muzzle = new THREE.PointLight(0x4ff7ff, 0, 6, 2);
  gun.add(muzzle);
  muzzle.position.set(0, 0, 0.3);

  scene.add(meebit);
  player.obj = meebit;
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
 * Attach (or re-attach) the player's animation mixer once both the player
 * mesh AND the retargeted clips are loaded. Called after player load and
 * also tried periodically by the update tick.
 */
function tryAttachPlayerMixer() {
  if (player.mixer) return true;
  if (!player.obj || player.mode !== 'glb') return false;
  if (!animationsReady()) return false;
  player.mixer = attachMixer(player.obj);
  player.mixer.playWalk();
  return true;
}

// ----------------------------------------------------------------------------
//  VOXEL FALLBACK MODE
// ----------------------------------------------------------------------------

const PALETTE = {
  skin: 0xd9b08c, hat: 0x1a1a1a, shirt: 0x2c2c2c, pants: 0x1a1a24,
  boots: 0x0a0a0a, glasses: 0xff3cac, skull: 0xffffff, gun: 0x4ff7ff,
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
    const muzzle = new THREE.PointLight(0xffd93d, 0, 5, 2);
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

  // Try to attach mixer if clips have become available since load.
  if (player.mode === 'glb' && !player.mixer) tryAttachPlayerMixer();

  if (player.mode === 'glb' && player.mixer) {
    // Real Mixamo-retargeted walk via mixer. Slow down when idle.
    player.mixer.setSpeed(moving ? 1.0 : 0.25);
    player.mixer.update(dt);
  } else if (player.mode === 'glb' && player.skeleton) {
    // Fallback: the old procedural-bone version for skeletons we couldn't
    // mix (e.g. Larva-Labs-signed Meebits with different bone names).
    animateGLB(dt, moving, timeElapsed);
  } else {
    animateVoxel(dt, moving, timeElapsed);
  }

  // Invuln flicker
  if (S.invulnTimer > 0) {
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

function animateVoxel(dt, moving, timeElapsed) {
  if (moving) {
    player._walkPhase += dt * 10;
    const sw = Math.sin(player._walkPhase) * 0.5;
    player.legL.rotation.x = sw;
    player.legR.rotation.x = -sw;
    player.armL.rotation.x = -sw * 0.5;
    player.armR.rotation.x = sw * 0.2;
    player.obj.position.y = player.pos.y + Math.abs(Math.sin(player._walkPhase)) * 0.08;
  } else {
    const t = timeElapsed * 2;
    player.legL.rotation.x *= 0.85;
    player.legR.rotation.x *= 0.85;
    player.armL.rotation.x *= 0.85;
    player.armR.rotation.x = Math.sin(t) * 0.03;
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
    // Warm-white spotlight-like fill. Stronger + wider than civilians'
    // so the player's immediate area reads well even when moving through
    // dense sections of the arena.
    const fill = new THREE.PointLight(0xfff4d6, 5.0, 9.0, 2);
    fill.position.set(0, 3.2, 0);
    player.obj.add(fill);
    player._glowFill = fill;
  }
  if (!player._glowAccent) {
    const accent = new THREE.PointLight(hex, 1.8, 5.5, 2);
    accent.position.set(0, 1.4, 0);
    player.obj.add(accent);
    player._glowAccent = accent;
  } else {
    player._glowAccent.color.setHex(hex);
  }
}
