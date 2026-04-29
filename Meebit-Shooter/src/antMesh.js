// antMesh.js — chapter-1 ant mesh loader.
//
// Loads assets/enemies/ant.glb once at startup. The GLB is the
// TRELLIS-generated ant figurine, sliced into 7 sub-meshes:
//   - body (head + thorax + abdomen + antennae fused together)
//   - Leg_FL, Leg_FR, Leg_RL, Leg_RR — 4 corner legs
//   - Leg_FC, Leg_RC — 2 axial appendages (front/rear)
//
// Each leg mesh has its origin at its hip joint, so rotating the
// leg group on its X axis pivots the leg from the hip — matches
// the spider-leg walk-anim path in main.js.
//
// Public API:
//   loadAntMesh()      — kicks off async load, called at startup
//   hasAntLoaded()     — true once the GLB has parsed successfully
//   makeAntFromGLB(scale) — clones the cached scene and returns
//                           the same shape makeSpider/makeHumanoid do.
//                           Returns null if loading hasn't finished
//                           or failed; caller should fall back.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const GLB_PATH = 'assets/enemies/ant.glb';

// Names of the 6 leg meshes we expect inside the GLB. Order MATTERS —
// the spider-leg walk anim in main.js applies a phase offset of 0.8
// per leg index, so the 4 corner legs go first (so opposite corners
// alternate naturally) and the 2 axial appendages come last.
const LEG_NAMES = ['Leg_FL', 'Leg_FR', 'Leg_RL', 'Leg_RR', 'Leg_FC', 'Leg_RC'];

// Cached parsed GLB scene root. Cloned per spawn (cheap — Three.js
// SkinnedMesh.clone() / Mesh.clone() share geometry + material).
let _cachedScene = null;
let _loadPromise = null;
let _loadFailed = false;

export function loadAntMesh() {
  if (_loadPromise) return _loadPromise;
  const loader = new GLTFLoader();
  _loadPromise = new Promise((resolve) => {
    loader.load(
      GLB_PATH,
      (gltf) => {
        // Cache the scene root. The scene is a Group containing one
        // child node "ant" which contains the body + 6 legs.
        _cachedScene = gltf.scene;
        // Sanity check — make sure all expected meshes are findable.
        const missing = [];
        if (!_cachedScene.getObjectByName('body')) missing.push('body');
        for (const n of LEG_NAMES) {
          if (!_cachedScene.getObjectByName(n)) missing.push(n);
        }
        if (missing.length > 0) {
          console.warn('[antMesh] GLB loaded but missing meshes:', missing.join(', '));
          _loadFailed = true;
        } else {
          console.log('[antMesh] loaded ant.glb — body + 6 legs ready');
        }
        resolve();
      },
      undefined,
      (err) => {
        console.warn('[antMesh] failed to load ant.glb:', err);
        _loadFailed = true;
        resolve();    // resolve anyway so callers don't hang
      }
    );
  });
  return _loadPromise;
}

export function hasAntLoaded() {
  return !!_cachedScene && !_loadFailed;
}

/**
 * Clone the cached ant scene and return it shaped like makeSpider's
 * output so makeEnemy can consume it without changes.
 *
 * The returned `group` is the new clone. Each leg is a child of the
 * group, accessible by name. spiderLegs[] orders them as defined by
 * LEG_NAMES so the per-leg phase offsets in main.js produce a
 * coherent scuttle pattern (opposite corners alternate).
 *
 * scale is applied to the group via group.scale.setScalar(scale) —
 * this matches how the procedural makeSpider returns its mesh.
 *
 * Returns null if the GLB hasn't loaded yet — caller falls back.
 */
export function makeAntFromGLB(scale) {
  if (!_cachedScene) return null;
  // Clone the entire scene tree. Three.js's clone() shares geometry
  // and materials by default, so this is cheap — a few hundred bytes
  // per clone, not a few hundred kilobytes.
  const cloned = _cachedScene.clone(true);

  // The GLB's structure is: scene Group → "ant" node → [body + legs].
  // We want a single Group at the spawn point holding the body and
  // legs as direct children, matching how makeSpider returns. Pull
  // the "ant" node out of the scene root and use IT as the group.
  let antRoot = cloned.getObjectByName('ant');
  if (!antRoot) {
    // Fallback: if the scene wraps differently, just use the cloned
    // scene root.
    antRoot = cloned;
  }

  // Find the body mesh and the 6 leg meshes by name.
  const body = antRoot.getObjectByName('body');
  const legs = LEG_NAMES.map(n => antRoot.getObjectByName(n)).filter(Boolean);

  // The TRELLIS-generated mesh is normalized to roughly 1 unit
  // tall (Y range -0.5 to +0.5). The procedural enemies in the game
  // use a scale where the humanoid is about 2.5 units tall at scale
  // = 1.0 (which is then multiplied by spec.scale * 0.55 in makeEnemy).
  // To make the GLB ant land at the same visible size as the
  // procedural ant did, we apply a base multiplier here. 2.5 lifts
  // the 1u-tall normalized mesh to 2.5u tall — same ballpark as the
  // procedural humanoid silhouette.
  const NORMALIZED_SCALE = 2.5;
  // The TRELLIS mesh is centered vertically (y from -0.5 to +0.5)
  // but the game expects the enemy's feet at y=0. Lift the antRoot
  // so the lowest point of the mesh sits at y=0.
  const FEET_LIFT = 0.5 * NORMALIZED_SCALE;     // half-height before scale, times scale

  // Wrap antRoot in a fresh Group so we own the transform without
  // disturbing the GLB's internal hierarchy. This matches how the
  // other makeX functions return.
  const group = new THREE.Group();
  antRoot.position.y = FEET_LIFT;
  group.add(antRoot);
  group.scale.setScalar(scale * NORMALIZED_SCALE);

  // Cast shadows on body + legs.
  if (body) body.castShadow = true;
  for (const leg of legs) leg.castShadow = true;

  // Cache the body's material so flash-on-hit etc. can mutate it.
  // Three.js shared the material across clones, so we clone it here
  // to give each enemy instance its own material — otherwise hitting
  // ONE ant would flash ALL ants white.
  let bodyMat = null;
  if (body && body.material) {
    bodyMat = body.material.clone();
    body.material = bodyMat;
  }

  // Return shape mirrors makeSpider's. The walk-anim path in main.js
  // reads spiderLegs[] when isSpider=true, so the corner + axial legs
  // all animate. armL/armR/legL/legR aliases are defensive defaults.
  return {
    group,
    body,
    bodyMat,
    armL: legs[0],
    armR: legs[1],
    legL: legs[2],
    legR: legs[3],
    head: body,           // no separate head mesh — body is the head+thorax+abdomen fused
    spiderLegs: legs,
  };
}
