// Mixamo-to-VRM animation retargeting.
//
// Mixamo ships walk/run animations with:
//   - "mixamorig:Hips", "mixamorig:LeftUpLeg", ... bone names
//   - centimeter scale (hips at y=104 instead of y=1)
//   - root motion baked in (hip translates ~170 units forward per clip)
//
// Our Meebit VRMs use:
//   - "HipsBone", "LeftUpperLegBone", ... bone names
//   - meter scale (hips at y=0.5)
//   - no root motion (game code moves the mesh)
//
// The approach:
//   1. Load the animation GLB once at startup. Extract its AnimationClip.
//   2. Rewrite every track name from mixamorig:X -> VRM equivalent.
//   3. Strip the hip translation track so civilians don't slide.
//   4. Cache the rewritten clip for reuse.
//   5. Per-character: build a THREE.AnimationMixer bound to the character's
//      actual mesh/skeleton. The mixer will apply rotations to bones that
//      match by name, silently skip bones that don't (like fingers).
//
// One shared clip, one mixer per character. Each mixer has its own playback
// time, so civilians can all animate independently.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Animation sources (committed to repo)
const ANIM_PATHS = {
  walk: 'assets/animations/Walking-a.glb',
  run:  'assets/animations/Running-a.glb',
};

// Mixamo bone name -> VRM bone name. Mixamo uses "mixamorig:" prefix and
// slightly different anatomy terms. We only map bones VRMs actually have.
// Mixamo's 3-level spine (Spine/Spine1/Spine2) collapses into VRM's 2-level
// (SpineBone/ChestBone); the middle Spine1 channels simply fail to find a
// target bone and are ignored by three.js, which is fine visually.
const BONE_MAP = {
  'mixamorig:Hips':           'HipsBone',
  'mixamorig:Spine':          'SpineBone',
  'mixamorig:Spine2':         'ChestBone',
  'mixamorig:Neck':           'NeckBone',
  'mixamorig:Head':           'HeadBone',
  'mixamorig:LeftShoulder':   'LeftShoulderBone',
  'mixamorig:LeftArm':        'LeftUpperArmBone',
  'mixamorig:LeftForeArm':    'LeftLowerArmBone',
  'mixamorig:LeftHand':       'LeftHandBone',
  'mixamorig:RightShoulder':  'RightShoulderBone',
  'mixamorig:RightArm':       'RightUpperArmBone',
  'mixamorig:RightForeArm':   'RightLowerArmBone',
  'mixamorig:RightHand':      'RightHandBone',
  'mixamorig:LeftUpLeg':      'LeftUpperLegBone',
  'mixamorig:LeftLeg':        'LeftLowerLegBone',
  'mixamorig:LeftFoot':       'LeftFootBone',
  'mixamorig:RightUpLeg':     'RightUpperLegBone',
  'mixamorig:RightLeg':       'RightLowerLegBone',
  'mixamorig:RightFoot':      'RightFootBone',
};

const gltfLoader = new GLTFLoader();

// Cached remapped clips, keyed by clip name.
const _clipCache = {};

// Module-level loading promise so callers can await "are animations ready?"
let _loadingPromise = null;

/**
 * Start loading all animations in the background. Returns a promise that
 * resolves when all clips are loaded and remapped (or failed -- never rejects).
 * Safe to call multiple times; only loads once.
 */
export function preloadAnimations() {
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = Promise.all(
    Object.entries(ANIM_PATHS).map(async ([key, path]) => {
      try {
        const gltf = await gltfLoader.loadAsync(path);
        if (!gltf.animations || gltf.animations.length === 0) {
          console.warn(`[anim] ${path} loaded but has no animation clips`);
          return;
        }
        const raw = gltf.animations[0];
        const clip = remapMixamoClip(raw, key);
        _clipCache[key] = clip;
      } catch (err) {
        console.warn(`[anim] failed to load ${path}:`, err.message);
      }
    })
  );
  return _loadingPromise;
}

/**
 * Build a fresh AnimationClip whose tracks target VRM bones instead of
 * Mixamo bones, and strip the hip translation (root motion).
 */
function remapMixamoClip(rawClip, label) {
  const remappedTracks = [];
  let droppedCount = 0;
  let mappedCount = 0;

  for (const track of rawClip.tracks) {
    // Track names look like: "mixamorig:LeftArm.quaternion"
    const dotIdx = track.name.indexOf('.');
    if (dotIdx < 0) { remappedTracks.push(track); continue; }

    const boneName = track.name.slice(0, dotIdx);
    const property = track.name.slice(dotIdx + 1);

    const mappedBone = BONE_MAP[boneName];
    if (!mappedBone) {
      // Bone not in our map (e.g. fingers, Spine1). Drop the track;
      // three.js would silently skip it anyway but dropping is cleaner.
      droppedCount++;
      continue;
    }

    // STRIP HIP TRANSLATION: Mixamo bakes forward motion into hip.position.
    // Keeping it would teleport civilians forward every cycle. We keep the
    // hip ROTATION track though -- the character still needs to bob/rotate.
    if (mappedBone === 'HipsBone' && property === 'position') {
      droppedCount++;
      continue;
    }

    // Clone the track with the new name. Track classes (QuaternionKeyframeTrack,
    // VectorKeyframeTrack) all expose `.clone()` in recent three.js.
    const cloned = track.clone();
    cloned.name = `${mappedBone}.${property}`;
    remappedTracks.push(cloned);
    mappedCount++;
  }

  const clip = new THREE.AnimationClip(
    `${rawClip.name || label}-retargeted`,
    rawClip.duration,
    remappedTracks,
  );
  console.info(`[anim] ${label}: ${mappedCount} tracks kept, ${droppedCount} dropped`);
  return clip;
}

/**
 * Attach an AnimationMixer to a character's mesh and return a controller
 * the caller can drive each frame.
 *
 * `mesh` must be the scene root returned by SkeletonUtils.clone (civilians)
 * or the player's loaded avatar root.
 *
 * Returns:
 *   {
 *     update(dt),            // call every frame
 *     setSpeed(speedScale),  // 1.0 = nominal walk tempo, higher = faster
 *     playWalk(), playRun(), stop(),
 *     ready: true|false      // false if no clips are loaded yet
 *   }
 */
export function attachMixer(mesh) {
  const mixer = new THREE.AnimationMixer(mesh);
  const actions = {};
  let current = null;

  function getAction(key) {
    if (actions[key]) return actions[key];
    const clip = _clipCache[key];
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    actions[key] = action;
    return action;
  }

  function playClip(key, fadeSec = 0.2) {
    const next = getAction(key);
    if (!next) return;
    if (current === next) return;
    if (current) current.fadeOut(fadeSec);
    next.reset().fadeIn(fadeSec).play();
    current = next;
  }

  return {
    get ready() { return Object.keys(_clipCache).length > 0; },
    update(dt) { mixer.update(dt); },
    setSpeed(scale) { mixer.timeScale = scale; },
    playWalk() { playClip('walk'); },
    playRun()  { playClip('run');  },
    stop() {
      if (current) current.fadeOut(0.1);
      current = null;
    },
    _mixer: mixer,
  };
}

export function animationsReady() {
  return Object.keys(_clipCache).length > 0;
}
