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

// Animation sources (committed to repo).
// Note: spaces in filenames are fine as long as the GLB loader encodes them
// for the HTTP request. Three.js's GLTFLoader URL-encodes by default.
const ANIM_PATHS = {
  walk:      'assets/animations/Walking-a.glb',
  run:       'assets/animations/Running-a.glb',
  idle2:     'assets/animations/Standing Idle 02.glb',
  idle3:     'assets/animations/Standing Idle 03.glb',
  idle4:     'assets/animations/Standing Idle 04.glb',
  // Combat clips — used by the player, follower meebits, and pixl pals.
  // Filenames match the GLBs that already ship in assets/animations/.
  rifleRun:  'assets/animations/rifle run.glb',
  rifleAim:  'assets/animations/rifle aiming idle.glb',
};

// Mixamo bone name -> VRM bone name. Mixamo source files have bones named
// "mixamorig:Hips" etc., but three.js's GLTFLoader runs every track name
// through PropertyBinding.sanitizeNodeName() which strips non-word chars
// (including the colon). By the time we see the tracks, they've already
// been rewritten to "mixamorigHips.quaternion". So our map keys must match
// the POST-sanitize form (no colon).
const BONE_MAP = {
  'mixamorigHips':           'HipsBone',
  'mixamorigSpine':          'SpineBone',
  'mixamorigSpine2':         'ChestBone',
  'mixamorigNeck':           'NeckBone',
  'mixamorigHead':           'HeadBone',
  'mixamorigLeftShoulder':   'LeftShoulderBone',
  'mixamorigLeftArm':        'LeftUpperArmBone',
  'mixamorigLeftForeArm':    'LeftLowerArmBone',
  'mixamorigLeftHand':       'LeftHandBone',
  'mixamorigRightShoulder':  'RightShoulderBone',
  'mixamorigRightArm':       'RightUpperArmBone',
  'mixamorigRightForeArm':   'RightLowerArmBone',
  'mixamorigRightHand':      'RightHandBone',
  'mixamorigLeftUpLeg':      'LeftUpperLegBone',
  'mixamorigLeftLeg':        'LeftLowerLegBone',
  'mixamorigLeftFoot':       'LeftFootBone',
  'mixamorigRightUpLeg':     'RightUpperLegBone',
  'mixamorigRightLeg':       'RightLowerLegBone',
  'mixamorigRightFoot':      'RightFootBone',
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
 * `opts.restPoseCompensation` — set to `true` for rigs whose rest (bind)
 * pose is NOT a straight T-pose. The Larva-Labs Meebit GLB is the main
 * example: it ships with HipsBone pre-rotated 180° around Y, legs and
 * shoulders pre-rotated 180° around other axes. Mixamo animation data
 * assumes rest = identity everywhere, so applying it directly to these
 * bones folds the character into a ball. When this option is on, every
 * rotation track gets remapped so the final bone rotation is
 *
 *     final = restQuaternion * (firstKeyframeInverse * currentKeyframe)
 *
 * i.e. at frame 0 the bone sits exactly at its rest pose, and at later
 * frames the DELTA-from-frame-0 motion is applied on top of rest. The
 * delta subtraction is what keeps Mixamo's baked-in runner-lean (a
 * constant ~13° forward tilt on the Hips track) from composing with
 * the Meebit rest and producing a permanent sideways body lean.
 * `opts.excludeBones` — array of bone names whose tracks should be dropped
 * from every clip this mixer plays. Bones matching any name in the list
 * stay at whatever rotation the caller writes to them AFTER the mixer
 * update runs. The player uses this to drop the arm tracks from walk/run
 * clips (so the full-body walk doesn't swing the arms) and then applies
 * a static gun-hold pose to the arm bones in its own update tick.
 *
 * Returns:
 *   {
 *     update(dt),            // call every frame
 *     setSpeed(speedScale),  // 1.0 = nominal walk tempo, higher = faster
 *     playWalk(), playRun(), stop(),
 *     ready: true|false      // false if no clips are loaded yet
 *   }
 */
export function attachMixer(mesh, opts = {}) {
  const mixer = new THREE.AnimationMixer(mesh);
  const actions = {};
  let current = null;

  // Cache of rest quaternions, keyed by bone name. Only populated when
  // restPoseCompensation is requested.
  const restByBone = opts.restPoseCompensation ? _collectRestPose(mesh) : null;

  // Bones whose tracks should be stripped from every clip on this mixer.
  // Stored as a Set for O(1) lookup during filtering.
  const excludeSet = (opts.excludeBones && opts.excludeBones.length)
    ? new Set(opts.excludeBones)
    : null;

  function getAction(key) {
    if (actions[key]) return actions[key];
    const clip = _clipCache[key];
    if (!clip) return null;

    // Apply transforms in order: rest-pose comp first, then bone exclusion.
    // Both return the same clip reference when no transform is needed, so
    // a mixer with neither option set pays zero cost.
    let effectiveClip = clip;
    if (restByBone)  effectiveClip = _buildCompensatedClip(effectiveClip, restByBone);
    if (excludeSet)  effectiveClip = _buildFilteredClip(effectiveClip, excludeSet);

    const action = mixer.clipAction(effectiveClip);
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
    // Combat clips — used by the player, follower meebits, and pixl pals.
    // Silently falls through to walk if the rifle clip hasn't loaded yet
    // (e.g. first frame of a run before preloadAnimations resolves).
    playRifleRun() {
      if (_clipCache.rifleRun) playClip('rifleRun');
      else playClip('run');
    },
    playRifleAim() {
      if (_clipCache.rifleAim) playClip('rifleAim');
      else if (_clipCache.idle2) playClip('idle2');
    },
    // Idle playback. Pass a number 2/3/4 to pick a specific clip, or omit
    // to get a deterministic-but-varied pick based on whatever's available.
    // Returns the clip key that actually played (or null if no idles loaded).
    playIdle(variant) {
      const keys = ['idle2', 'idle3', 'idle4'].filter(k => _clipCache[k]);
      if (keys.length === 0) return null;
      let key;
      if (variant === 2 || variant === 3 || variant === 4) {
        key = 'idle' + variant;
        if (!_clipCache[key]) key = keys[0];
      } else {
        key = keys[Math.floor(Math.random() * keys.length)];
      }
      playClip(key);
      return key;
    },
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

// ============================================================================
// GUN-HOLD POSE
// ============================================================================
// Meebit VRMs ship in T-pose (arms extending sideways along +X/-X). For a
// shooter we want the arms tucked forward with forearms bent so the hands
// are in front of the chest — a rifle-grip stance. This is applied as a
// static per-frame override on the arm bones, keyed by bone name, on top
// of each bone's rest quaternion.
//
// The player, follower meebits, and pixl pals all share one Meebits-style
// rig (HipsBone / LeftUpperArmBone / ...) so a single pose table drives
// all three. To use it:
//
//   1. At attachMixer time, pass `excludeBones: GUN_HOLD_EXCLUDE_BONES`
//      so walk/run clips don't write to arm bones.
//   2. Every frame, after `mixer.update(dt)`, call `applyGunHoldPose(mesh)`.
//
// The Euler values come from pose-sketching against the Meebit rig's
// axis conventions:
//   +X extends outward along the arm's length in rest
//   negative Y rotation on UpperArm → arm swings forward
//   negative Z rotation on UpperArm → arm drops from horizontal
//   negative X rotation on LowerArm → elbow bends
// ============================================================================

export const GUN_HOLD_EXCLUDE_BONES = [
  'LeftShoulderBone',  'LeftUpperArmBone',  'LeftLowerArmBone',  'LeftHandBone',
  'RightShoulderBone', 'RightUpperArmBone', 'RightLowerArmBone', 'RightHandBone',
];

const GUN_HOLD_POSE = {
  // RIGHT ARM — primary grip (weapon hand)
  RightShoulderBone: { x:  0,     y:  0,     z:  0    },
  RightUpperArmBone: { x:  0,     y: -1.30,  z: -1.20 },  // forward + down
  RightLowerArmBone: { x: -0.40,  y: -0.60,  z:  0    },  // bend elbow
  RightHandBone:     { x:  0,     y:  0,     z: -0.20 },
  // LEFT ARM — support grip
  LeftShoulderBone:  { x:  0,     y:  0,     z:  0    },
  LeftUpperArmBone:  { x:  0,     y:  1.30,  z:  1.20 },  // mirrored
  LeftLowerArmBone:  { x: -0.40,  y:  0.60,  z:  0    },
  LeftHandBone:      { x:  0,     y:  0,     z:  0.20 },
};

// Reusable scratch quaternions/euler — allocation-free per-frame path.
const _ghEuler  = new THREE.Euler();
const _ghDelta  = new THREE.Quaternion();
// Per-mesh rest-quaternion cache. Looking up bones by name every frame
// is cheap (Three.js already does a name→index lookup on the skeleton),
// but caching the rest quaternions avoids repeat clone() allocations.
const _restCache = new WeakMap();  // mesh -> { boneName: { bone, rest } }

function _getArmRestCache(mesh) {
  let cache = _restCache.get(mesh);
  if (cache) return cache;
  cache = {};
  mesh.traverse(o => {
    if (o.isBone && GUN_HOLD_POSE[o.name]) {
      cache[o.name] = { bone: o, rest: o.quaternion.clone() };
    }
  });
  _restCache.set(mesh, cache);
  return cache;
}

/**
 * Apply the shooter arm pose to a Meebit-rigged mesh. Safe to call every
 * frame — allocation-free after the first call. If the mesh doesn't have
 * the expected arm bones (wrong rig naming), this is a no-op.
 */
export function applyGunHoldPose(mesh) {
  const cache = _getArmRestCache(mesh);
  for (const name in GUN_HOLD_POSE) {
    const entry = cache[name];
    if (!entry) continue;
    const p = GUN_HOLD_POSE[name];
    _ghEuler.set(p.x, p.y, p.z, 'XYZ');
    _ghDelta.setFromEuler(_ghEuler);
    entry.bone.quaternion.copy(entry.rest).multiply(_ghDelta);
  }
}

// ============================================================================
// REST-POSE COMPENSATION HELPERS
// ============================================================================
// The Larva-Labs Meebit GLB ships with a bind (rest) pose that is NOT a
// T-pose: its HipsBone is rotated 180° around Y, legs are pre-rotated 180°
// around their roll axes, shoulders have custom pre-rotations, etc. When
// you apply a Mixamo-sourced rotation track (which assumes rest = identity)
// directly to these bones, the motion "replaces" the rest rotation and the
// character folds into a ball.
//
// Fix (two-part):
//   1. DELTA: subtract Mixamo's own first keyframe from every keyframe on
//      that track. Mixamo run clips bake in a permanent "runner's lean"
//      on the Hips track (~13° forward) and smaller residuals on the spine
//      and limbs. Composing those offsets with the Meebit rest produces a
//      permanent sideways body tilt at frame 0. Delta subtraction ensures
//      frame 0 = identity motion.
//
//   2. COMPOSE: multiply the delta by the target bone's rest quaternion
//      so the motion plays on top of the bind pose:
//          final = rest * (firstInv * current)
//
// We build a bespoke AnimationClip per (clip, bone-set) so the rest of
// the mixer code doesn't need to know about compensation.
// ============================================================================

/**
 * Walk the mesh tree and collect rest-pose quaternions keyed by bone name.
 * Called once per attachMixer() when compensation is requested.
 */
function _collectRestPose(mesh) {
  const map = {};
  mesh.traverse(o => {
    if (o.isBone && o.name) {
      // First occurrence wins — if there are duplicate bone names we
      // wouldn't be able to disambiguate anyway (three.js tracks match
      // by name only).
      if (!map[o.name]) map[o.name] = o.quaternion.clone();
    }
  });
  return map;
}

// Small per-clip cache so repeated play of the same clip on the same rig
// doesn't rebuild the compensated clip each time. Keyed by the raw clip
// object identity.
const _compensatedClipCache = new WeakMap();  // WeakMap<clip, WeakMap<restMap, compensatedClip>>

function _buildCompensatedClip(rawClip, restByBone) {
  // Second-level cache — the restByBone object is unique per mixer, so it
  // suffices as the inner key. WeakMap avoids leaking when the mesh is GC'd.
  let inner = _compensatedClipCache.get(rawClip);
  if (!inner) {
    inner = new WeakMap();
    _compensatedClipCache.set(rawClip, inner);
  }
  const cached = inner.get(restByBone);
  if (cached) return cached;

  const tracks = [];
  const _q = new THREE.Quaternion();
  const _qFirstInv = new THREE.Quaternion();
  const _qDelta = new THREE.Quaternion();
  const _qOut = new THREE.Quaternion();

  for (const track of rawClip.tracks) {
    // Only rotation tracks need compensation. Position/scale tracks pass
    // through unchanged (we already stripped hip position upstream).
    const dot = track.name.indexOf('.');
    const boneName = dot >= 0 ? track.name.slice(0, dot) : track.name;
    const property = dot >= 0 ? track.name.slice(dot + 1) : '';
    const rest = restByBone[boneName];

    if (!rest || property !== 'quaternion') {
      tracks.push(track);
      continue;
    }

    // track.values is a flat Float32Array of [x,y,z,w, x,y,z,w, ...].
    // For each keyframe we want:
    //   final = rest * (firstInv * current)
    //
    // `firstInv * current` is the DELTA from Mixamo's own first keyframe —
    // this strips Mixamo's baked offset (e.g. the 13° forward "runner's
    // lean" baked into the hip rotation) so at frame 0 the bone sits at
    // the Meebit rest exactly (no initial tilt), and later frames add
    // only the per-frame motion relative to Mixamo's opening pose.
    //
    // Without the delta step, Mixamo's hip "runner lean" composes with
    // the Meebit's 180°-around-Y hip rest and the entire body shows up
    // permanently tilted sideways.
    const values = track.values.slice(0);  // typed-array copy

    if (values.length < 4) {
      // No keyframes — just push an empty pass-through
      tracks.push(track);
      continue;
    }

    // Extract the first keyframe and invert it (conjugate == inverse for unit quaternions)
    _qFirstInv.set(-values[0], -values[1], -values[2], values[3]);

    for (let i = 0; i < values.length; i += 4) {
      _q.set(values[i], values[i+1], values[i+2], values[i+3]);
      // delta = firstInv * current
      _qDelta.copy(_qFirstInv).multiply(_q);
      // final = rest * delta
      _qOut.copy(rest).multiply(_qDelta);
      values[i]   = _qOut.x;
      values[i+1] = _qOut.y;
      values[i+2] = _qOut.z;
      values[i+3] = _qOut.w;
    }

    const compTrack = new THREE.QuaternionKeyframeTrack(
      track.name,
      track.times,   // shared — immutable usage pattern
      values,
    );
    tracks.push(compTrack);
  }

  const clip = new THREE.AnimationClip(
    rawClip.name + '-restComp',
    rawClip.duration,
    tracks,
  );
  inner.set(restByBone, clip);
  return clip;
}

// ============================================================================
// BONE EXCLUSION
// ============================================================================
// Strip tracks targeting specific bones from a clip. Used by the player to
// drop the arm tracks from walk/run clips — the legs/hip/spine animate
// normally while the arm bones stay at whatever local rotation the caller
// writes to them in its own update tick (for the player: a static gun-hold
// pose).
//
// Cached per-(raw-clip, exclude-set) so multiple mixers using the same
// exclusion list share one filtered clip.
// ============================================================================

const _filteredClipCache = new WeakMap();   // WeakMap<rawClip, Map<string, filteredClip>>

function _buildFilteredClip(rawClip, excludeSet) {
  // Use a stable string key derived from the exclude set so mixers with
  // the same exclusion list share the same filtered clip.
  const sortedKey = [...excludeSet].sort().join('|');
  let inner = _filteredClipCache.get(rawClip);
  if (!inner) {
    inner = new Map();
    _filteredClipCache.set(rawClip, inner);
  }
  const cached = inner.get(sortedKey);
  if (cached) return cached;

  const tracks = [];
  let droppedCount = 0;
  for (const track of rawClip.tracks) {
    const dot = track.name.indexOf('.');
    const boneName = dot >= 0 ? track.name.slice(0, dot) : track.name;
    if (excludeSet.has(boneName)) {
      droppedCount++;
      continue;
    }
    tracks.push(track);
  }

  const clip = new THREE.AnimationClip(
    rawClip.name + '-filtered',
    rawClip.duration,
    tracks,
  );
  inner.set(sortedKey, clip);
  if (droppedCount > 0) {
    console.info(`[anim] filtered clip "${rawClip.name}": dropped ${droppedCount} tracks for ${sortedKey}`);
  }
  return clip;
}
