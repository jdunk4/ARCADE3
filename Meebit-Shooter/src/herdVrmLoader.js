// Herd VRM loader — for the BONUS WAVE ("The Stampede").
//
// The bonus wave pours up to 111 themed Meebits into the arena. Each chapter
// has its own herd (pigs, elephants, skeletons, robots, visitors, dissected).
// Assets live under:  assets/civilians/{herdId}/*.vrm
//
// FILENAME DISCOVERY (two modes, tried in order):
//
//   1. MANIFEST MODE — assets/civilians/{herdId}/manifest.json
//      If present, it's a JSON array of filenames in that folder, e.g.
//        ["00045.vrm", "16801.vrm", "00108.vrm", ...]
//      This is the preferred mode. It lets you name files after real Meebit
//      IDs (or anything else) without the game caring about the numbering.
//
//   2. SEQUENTIAL MODE — assets/civilians/{herdId}/00001.vrm, 00002.vrm, ...
//      If no manifest.json, fall back to HEAD-probing 00001.vrm, 00002.vrm,
//      ... until the first 404. Works for folders with files numbered
//      consecutively from 1.
//
// If neither mode finds any VRMs, the wave uses voxel fallbacks (tinted
// placeholder meebits) so the game always renders *something*.
//
// Caching strategy:
//   - Cache parsed gltf.scene meshes across waves, keyed by filename.
//   - Each caller gets a clone(), never the cached mesh directly.
//   - Per-herd filename list cached for the session (one-time discovery cost).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const gltfLoader = new GLTFLoader();

// Cache of loaded meshes, keyed by "herdId::filename" (e.g. "pigs::00045.vrm").
const cache = new Map();

// Dedupe in-flight loads so multiple concurrent requests for the same
// herd+file share a single fetch+parse.
const pendingLoads = new Map();

// Per-herd filename-list cache. Key: herdId, Value: Array<string>.
const herdFilenamesCache = new Map();

// Per-herd in-flight discovery (dedupe).
const pendingDiscovery = new Map();

const MAX_HERD_SIZE = 111;
const PER_PROBE_TIMEOUT_MS = 1500;
const OVERALL_DISCOVERY_DEADLINE_MS = 3000;

function mcacheKey(herdId, filename) { return `${herdId}::${filename}`; }

// ----------------------------------------------------------------------------
// Discovery
// ----------------------------------------------------------------------------

/**
 * Discover the list of VRM filenames available for a given herd.
 * Returns Array<string> of filenames. Empty array means nothing found.
 */
export async function discoverHerd(herdId) {
  if (herdFilenamesCache.has(herdId)) return herdFilenamesCache.get(herdId);
  if (pendingDiscovery.has(herdId)) return pendingDiscovery.get(herdId);

  const promise = (async () => {
    // Mode 1: manifest.json
    const manifestFiles = await _tryManifest(herdId);
    if (manifestFiles && manifestFiles.length > 0) {
      herdFilenamesCache.set(herdId, manifestFiles);
      console.info(`[herdVrm] ${herdId}: manifest found (${manifestFiles.length} files)`);
      return manifestFiles;
    }

    // Mode 2: sequential HEAD probe
    const sequentialFiles = await _trySequential(herdId);
    herdFilenamesCache.set(herdId, sequentialFiles);
    if (sequentialFiles.length === 0) {
      console.warn(
        `[herdVrm] no VRMs found for ${herdId}. ` +
        `Expected either assets/civilians/${herdId}/manifest.json ` +
        `or sequentially-named files starting at 00001.vrm. ` +
        `Herd will use voxel fallbacks.`
      );
    } else {
      console.info(`[herdVrm] ${herdId}: ${sequentialFiles.length} sequential files found`);
    }
    return sequentialFiles;
  })();

  pendingDiscovery.set(herdId, promise);
  try {
    return await promise;
  } finally {
    pendingDiscovery.delete(herdId);
  }
}

async function _tryManifest(herdId) {
  const url = `assets/civilians/${herdId}/manifest.json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.warn(`[herdVrm] ${herdId}/manifest.json is not an array, ignoring`);
      return null;
    }
    // Sanitize: only accept strings ending in .vrm that don't try to escape the folder.
    const cleaned = data.filter(x =>
      typeof x === 'string' &&
      /\.vrm$/i.test(x) &&
      !x.includes('/') && !x.includes('\\') && !x.includes('..')
    );
    return cleaned.slice(0, MAX_HERD_SIZE);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function _trySequential(herdId) {
  const startedAt = performance.now();
  const files = [];
  for (let i = 1; i <= MAX_HERD_SIZE; i++) {
    if (performance.now() - startedAt > OVERALL_DISCOVERY_DEADLINE_MS) {
      console.warn(`[herdVrm] ${herdId}: sequential discovery deadline hit at ${files.length} files`);
      break;
    }
    const padded = String(i).padStart(5, '0') + '.vrm';
    const url = `assets/civilians/${herdId}/${padded}`;
    const ok = await _probeOne(url);
    if (!ok) break;
    files.push(padded);
  }
  return files;
}

async function _probeOne(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    return res.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Backwards-compat shim: older code imported discoverHerdSize (returns count).
export async function discoverHerdSize(herdId) {
  const files = await discoverHerd(herdId);
  return files.length;
}

export function getHerdFilenamesSync(herdId) {
  return herdFilenamesCache.has(herdId) ? herdFilenamesCache.get(herdId) : null;
}

// ----------------------------------------------------------------------------
// Mesh loading
// ----------------------------------------------------------------------------

async function _loadVRM(herdId, filename) {
  const url = `assets/civilians/${herdId}/${filename}`;
  const gltf = await gltfLoader.loadAsync(url);
  const vrmScene = gltf.scene;

  // Match civilian VRM sizing.
  vrmScene.scale.setScalar(1.8);
  vrmScene.traverse(obj => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = false;
    }
  });

  // MOONWALK FIX — mirror the wrapper pattern from meebitsPublicApi.js.
  //
  // VRM neutral forward is -Z, but Mixamo walk/run animations drive the
  // character in +Z. With the game's movement code setting
  // obj.rotation.y = atan2(dx, dz) to face direction of travel, the VRM's
  // mesh visibly faces away from its motion — the infamous moonwalk.
  //
  // Fix: wrap the VRM in an outer Group. The outer Group is what the game
  // rotates; the inner VRM is pre-rotated 180° on Y so its animation-forward
  // aligns with the outer Group's forward. The AnimationMixer still binds to
  // the inner VRM's bones; nothing about animation wiring changes.
  const wrapper = new THREE.Group();
  vrmScene.rotation.y = Math.PI;
  wrapper.add(vrmScene);
  // Tag so attachMixer() (or anything that inspects this) can find the real
  // skinned-mesh root.
  wrapper.userData.vrmRoot = vrmScene;

  return wrapper;
}

function _voxelFallback(tintHex) {
  const group = new THREE.Group();
  const col = new THREE.Color(tintHex);
  const skin = col.clone().lerp(new THREE.Color(0xddccbb), 0.6);
  const cloth = col.clone().multiplyScalar(0.5);

  const headMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 });
  const clothMat = new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.85 });

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), headMat);
  head.position.y = 2.5; head.castShadow = true; group.add(head);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.1, 0.55), clothMat);
  body.position.y = 1.55; body.castShadow = true; group.add(body);

  const armGeo = new THREE.BoxGeometry(0.22, 0.85, 0.22);
  const armL = new THREE.Mesh(armGeo, clothMat);
  armL.position.set(-0.55, 1.6, 0); armL.castShadow = true; group.add(armL);
  const armR = new THREE.Mesh(armGeo, clothMat);
  armR.position.set(0.55, 1.6, 0); armR.castShadow = true; group.add(armR);

  const legGeo = new THREE.BoxGeometry(0.32, 0.9, 0.32);
  const legL = new THREE.Mesh(legGeo, clothMat);
  legL.position.set(-0.22, 0.55, 0); legL.castShadow = true; group.add(legL);
  const legR = new THREE.Mesh(legGeo, clothMat);
  legR.position.set(0.22, 0.55, 0); legR.castShadow = true; group.add(legR);

  group.userData.isFallback = true;
  group.userData.animRefs = { armL, armR, legL, legR };
  return group;
}

/**
 * Safe clone for skinned meshes.
 *
 * Plain Object3D.clone() for a mesh containing SkinnedMesh produces a clone
 * whose SkinnedMesh instances still reference the ORIGINAL skeleton. Every
 * cloned herd meebit then renders at the original's world position (or on
 * top of each other, or at world origin) regardless of the clone's
 * .position. They look invisible / clumped.
 *
 * SkeletonUtils.clone walks the hierarchy, clones the bones, and rebinds
 * each SkinnedMesh to the cloned skeleton — producing an independently
 * positionable copy that actually renders where we put it.
 *
 * For non-skinned meshes (voxel fallback), plain clone() is fine and faster.
 */
function safeClone(mesh) {
  let hasSkin = false;
  mesh.traverse(obj => { if (obj.isSkinnedMesh) hasSkin = true; });
  if (hasSkin) {
    const cloned = SkeletonUtils.clone(mesh);
    // Preserve userData so fallback flags survive the clone.
    cloned.userData = Object.assign({}, mesh.userData);
    return cloned;
  }
  return mesh.clone(true);
}

/**
 * Get a herd Meebit mesh by filename. Always resolves — returns a voxel
 * fallback if the VRM can't be loaded or parsed.
 */
export async function getHerdMeshByFilename(herdId, filename, fallbackTintHex = 0xaabbcc) {
  const key = mcacheKey(herdId, filename);

  if (cache.has(key)) {
    return safeClone(cache.get(key));
  }
  if (pendingLoads.has(key)) {
    const mesh = await pendingLoads.get(key);
    return safeClone(mesh);
  }

  const promise = _loadVRM(herdId, filename)
    .then(mesh => {
      cache.set(key, mesh);
      return mesh;
    })
    .catch(() => {
      // Silent voxel fallback — browser already logs the 404 so the dev
      // can diagnose. We don't need to double-log.
      const fb = _voxelFallback(fallbackTintHex);
      cache.set(key, fb);
      return fb;
    })
    .finally(() => {
      pendingLoads.delete(key);
    });

  pendingLoads.set(key, promise);
  const mesh = await promise;
  return safeClone(mesh);
}

/**
 * Get a voxel fallback mesh directly — used when discovery found zero files
 * and bonusWave.js wants to spawn placeholders without attempting any network.
 */
export function getHerdVoxelFallback(tintHex) {
  return _voxelFallback(tintHex);
}

// Legacy shim — prefetchHerd takes indices; convert to filenames if known.
export function prefetchHerd(herdId, indices) {
  const files = herdFilenamesCache.get(herdId);
  if (!files || files.length === 0) return;
  for (const idx of indices) {
    const fname = files[(idx - 1) % files.length];
    if (fname) getHerdMeshByFilename(herdId, fname).catch(() => {});
  }
}

export function clearHerdCache() {
  for (const [, mesh] of cache) {
    if (mesh && mesh.traverse) {
      mesh.traverse(obj => {
        if (obj.isMesh) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
            else obj.material.dispose();
          }
        }
      });
    }
  }
  cache.clear();
  pendingLoads.clear();
}

export function getHerdCacheStats() {
  return {
    size: cache.size,
    pending: pendingLoads.size,
    herdsKnown: herdFilenamesCache.size,
  };
}
