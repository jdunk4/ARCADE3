// Herd VRM loader — for the BONUS WAVE ("The Stampede").
//
// The bonus wave pours 111 themed Meebits into the arena. Each chapter has
// its own herd (pigs, elephants, skeletons, robots, visitors, dissected).
// Assets live in:  assets/civilians/{herdId}/00001.vrm ... NNNNN.vrm
//
// If a folder has fewer than 111 VRMs, the bonus wave CYCLES through what
// exists (reuses the same model multiple times) so the stampede stays at
// full herd density. Discovery is done via cheap HEAD requests on wave start
// and cached for the session.
//
// This module is deliberately separate from meebitsPublicApi.js, which hits
// meebits.app/meebit/{id} (public CDN). These local VRMs are offline-safe
// and zero-network, so the bonus wave never gets jammed by a network stall.
//
// Caching strategy:
//   - Cache parsed gltf.scene meshes across waves (same herd played twice
//     reuses the cache — common when grinding chapter 1 repeatedly).
//   - Each caller gets a clone(), never the cached mesh directly.
//   - We fall back to a tinted voxel placeholder on load failure so the wave
//     never renders "missing" civilians — every slot is filled with *something*.
//   - Per-herd size discovery is cached for the session (one-time probe cost).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BONUS_WAVE_CONFIG } from './config.js';

const gltfLoader = new GLTFLoader();

// Cache of loaded meshes, keyed by "herdId:idx" (e.g. "pigs:42").
// Value: THREE.Object3D (the scene root of the loaded VRM).
const cache = new Map();

// Dedupe in-flight loads so multiple concurrent requests for the same
// herd+idx share a single fetch+parse.
const pendingLoads = new Map();

// Per-herd available-count cache. Key: herdId, Value: number (how many
// VRMs actually exist on disk, 1..MAX). Populated by discoverHerdSize().
const herdSizeCache = new Map();

// Per-herd in-flight size discovery (dedupe). Key: herdId, Value: Promise<number>.
const pendingSizeDiscovery = new Map();

const MAX_HERD_SIZE = 111;

function cacheKey(herdId, idx) { return `${herdId}:${idx}`; }

/**
 * Discover how many VRMs are actually present in a herd folder.
 * Sequentially HEAD-probes 00001.vrm, 00002.vrm, ... and stops at the
 * first 404. Returns the count of contiguous files found (1..MAX_HERD_SIZE).
 *
 * If HEAD isn't supported or all probes fail, returns 0 (caller should then
 * treat the whole herd as voxel fallbacks).
 *
 * Result is cached per-session, so subsequent bonus waves for the same herd
 * skip the probe entirely.
 *
 * Hardened against hangs:
 *   - Per-request AbortController with 1500ms timeout
 *   - Overall discovery deadline of 3000ms (bail with whatever count we got so far)
 */
const PER_PROBE_TIMEOUT_MS = 1500;
const OVERALL_DISCOVERY_DEADLINE_MS = 3000;

async function _probeOne(url) {
  // Fetch with a timeout. Works across browsers that don't yet support
  // AbortSignal.timeout() by using a manual AbortController.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    return res.ok;
  } catch (err) {
    // Aborts, network errors, CORS, file:// — all treated as "not there".
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverHerdSize(herdId) {
  if (herdSizeCache.has(herdId)) return herdSizeCache.get(herdId);
  if (pendingSizeDiscovery.has(herdId)) return pendingSizeDiscovery.get(herdId);

  const promise = (async () => {
    const startedAt = performance.now();
    let count = 0;
    for (let i = 1; i <= MAX_HERD_SIZE; i++) {
      // Overall deadline: if we've been probing for too long, bail with
      // whatever we've confirmed so far. Protects against dozens of slow
      // HEADs stacking up on a misbehaving host.
      if (performance.now() - startedAt > OVERALL_DISCOVERY_DEADLINE_MS) {
        console.warn(`[herdVrm] ${herdId}: discovery deadline hit at ${count} files — using what we've got`);
        break;
      }
      const url = BONUS_WAVE_CONFIG.assetPathFor(herdId, i);
      const ok = await _probeOne(url);
      if (!ok) break;
      count = i;
    }
    herdSizeCache.set(herdId, count);
    if (count === 0) {
      console.warn(`[herdVrm] no VRMs found in assets/civilians/${herdId}/ — herd will use voxel fallbacks`);
    } else if (count < MAX_HERD_SIZE) {
      console.info(`[herdVrm] ${herdId}: ${count} VRMs found, stampede will cycle through them`);
    } else {
      console.info(`[herdVrm] ${herdId}: full herd of ${count} VRMs available`);
    }
    return count;
  })();

  pendingSizeDiscovery.set(herdId, promise);
  try {
    return await promise;
  } finally {
    pendingSizeDiscovery.delete(herdId);
  }
}

/**
 * Synchronous lookup of a herd's discovered size. Returns null if discovery
 * hasn't finished yet. Use this from bonusWave.js once startup is past the
 * await — fast path, no promise.
 */
export function getHerdSizeSync(herdId) {
  return herdSizeCache.has(herdId) ? herdSizeCache.get(herdId) : null;
}

async function _loadVRM(herdId, idx) {
  const url = BONUS_WAVE_CONFIG.assetPathFor(herdId, idx);
  const gltf = await gltfLoader.loadAsync(url);
  const mesh = gltf.scene;
  // Match civilian VRM sizing from meebitsPublicApi.js so the herd reads at
  // the same scale as normal civilians.
  mesh.scale.setScalar(1.8);
  mesh.traverse(obj => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = false;
    }
  });
  return mesh;
}

function _voxelFallback(tintHex) {
  // Same shape as meebitsPublicApi.js's fallback so the aesthetics match
  // if a specific VRM fails to load mid-herd.
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
 * Get a herd Meebit mesh. Always resolves, never rejects — returns a voxel
 * fallback if the local VRM isn't available or can't be parsed.
 *
 * @param {string} herdId  — 'pigs' | 'elephants' | 'skeletons' | 'robots' | 'visitors' | 'dissected'
 * @param {number} idx     — 1..111 (matches the filename's 5-digit zero-padded index)
 * @param {number} fallbackTintHex — tint applied only if the VRM fails to load
 * @returns {Promise<THREE.Object3D>}
 */
export async function getHerdMesh(herdId, idx, fallbackTintHex = 0xaabbcc) {
  const key = cacheKey(herdId, idx);

  if (cache.has(key)) {
    return cache.get(key).clone(true);
  }

  if (pendingLoads.has(key)) {
    const mesh = await pendingLoads.get(key);
    return mesh.clone(true);
  }

  const promise = _loadVRM(herdId, idx)
    .then(mesh => {
      cache.set(key, mesh);
      return mesh;
    })
    .catch(err => {
      console.warn(`[herdVrm] load failed for ${herdId}/${idx}:`, err.message);
      const fb = _voxelFallback(fallbackTintHex);
      cache.set(key, fb);
      return fb;
    })
    .finally(() => {
      pendingLoads.delete(key);
    });

  pendingLoads.set(key, promise);
  const mesh = await promise;
  return mesh.clone(true);
}

/**
 * Opportunistic prefetch — warm the herd cache for the next bonus wave while
 * the player is fighting the boss. Non-blocking, errors suppressed.
 */
export function prefetchHerd(herdId, indices) {
  indices.forEach(idx => {
    // Fire and forget; getHerdMesh handles its own errors.
    getHerdMesh(herdId, idx).catch(() => {});
  });
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
  // Note: we deliberately do NOT clear herdSizeCache here. Folder contents
  // don't change during a play session, so the discovery result stays valid
  // and saves re-probing cost on every restart.
}

export function getHerdCacheStats() {
  return { size: cache.size, pending: pendingLoads.size };
}
