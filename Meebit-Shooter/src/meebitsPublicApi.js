// Public Meebits API wrapper with LRU cache + local asset pool.
//
// Civilian NPC sourcing priority, per spawn:
//   1. LOCAL_ASSET_POOL  -- GLB/VRM files committed to this repo. No network,
//                           no CORS, no 403s. Fastest, most reliable, and the
//                           only source that ships with legal certainty (since
//                           YOU chose what goes in the folder).
//   2. meebits.app API   -- fetch metadata + VRM via corsproxy.io. Works when
//                           the Meebits VRM endpoint doesn't 403 (i.e. rarely;
//                           most 3D downloads are gated behind the owner-sign
//                           flow handled by meebitsApi.js, not this module).
//   3. Voxel fallback    -- a plain three.js box-Meebit. Always works.
//
// HOW TO ADD LOCAL ASSETS:
//   - Drop .glb or .vrm files into `Meebit-Shooter/assets/civilians/`
//     (or anywhere you like under the game root).
//   - List them in LOCAL_ASSET_POOL below. The array can be any length.
//     Duplicates are fine -- they'll just appear more often.
//   - YOU are responsible for ensuring you have rights to distribute every
//     file you add. The base Meebits license grants commercial rights to the
//     individual owner of each Meebit -- third-party redistributions do not
//     automatically inherit those rights. See licenseterms.meebits.app.
//
// CORS (for the API fallback path):
//   meebits.app does NOT send Access-Control-Allow-Origin. We route both the
//   JSON metadata and the VRM binary through corsproxy.io (public free proxy).
//   Swap CORS_PROXY below for your own origin-same proxy in production.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ------------------------------------------------------------------
// LOCAL ASSET POOL -- edit this array to use your own GLB/VRM files.
// Paths are resolved relative to the game's index.html.
// Start empty and populate once you've verified rights to each asset.
// ------------------------------------------------------------------
const LOCAL_ASSET_POOL = [
  'assets/civilians/00001.vrm',
  'assets/civilians/00002.vrm',
  'assets/civilians/00003.vrm',
  'assets/civilians/00004.vrm',
  'assets/civilians/00005.vrm',
  'assets/civilians/00006.vrm',
  'assets/civilians/00007.vrm',
  'assets/civilians/00008.vrm',
  'assets/civilians/00009.vrm',
  'assets/civilians/00010.vrm',
  'assets/civilians/00011.vrm',
  'assets/civilians/00012.vrm',
  'assets/civilians/00013.vrm',
  'assets/civilians/00014.vrm',
  'assets/civilians/00015.vrm',
  'assets/civilians/00016.vrm',
  'assets/civilians/00017.vrm',
  'assets/civilians/00018.vrm',
  'assets/civilians/00019.vrm',
  'assets/civilians/00020.vrm',
  'assets/civilians/00021.vrm',
  'assets/civilians/00022.vrm',
  'assets/civilians/00023.vrm',
  'assets/civilians/00024.vrm',
  'assets/civilians/00025.vrm',
];

// Public CORS proxy. Format: https://corsproxy.io/?<url-encoded-target>
// Swap this out for your own proxy if you host one.
const CORS_PROXY = 'https://corsproxy.io/?';
function proxied(url) { return CORS_PROXY + encodeURIComponent(url); }

const MEEBIT_METADATA_URL = (id) => `https://meebits.app/meebit/${id}`;
const TOTAL_MEEBITS = 20000;
const CACHE_SIZE = 100;

// Synthetic IDs for locally-loaded assets. We use negative numbers so they
// can't collide with real Meebit IDs (0..19999) and the active-IDs Set in
// civilians.js still works correctly. LOCAL_ID_BASE - i = id for pool[i].
const LOCAL_ID_BASE = -1000;

// Once-per-session warning flag so repeated 403s don't spam the console.
let _apiWarnedThisSession = false;
let _diagCount = 0;

const gltfLoader = new GLTFLoader();

// LRU cache of loaded meshes.
// Key: meebitId (number), Value: { mesh: THREE.Object3D, lastUsed: number }
const cache = new Map();
const metadataCache = new Map();   // id → { vrm, image, ... } (small, keep everything)
const pendingLoads = new Map();    // id → Promise (dedupe simultaneous requests)

function touchCache(id) {
  const entry = cache.get(id);
  if (entry) entry.lastUsed = performance.now();
}

function evictIfNeeded() {
  if (cache.size <= CACHE_SIZE) return;
  let oldest = null, oldestTime = Infinity;
  for (const [id, entry] of cache.entries()) {
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldest = id;
    }
  }
  if (oldest !== null) {
    const e = cache.get(oldest);
    if (e && e.mesh) {
      e.mesh.traverse(obj => {
        if (obj.isMesh) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
            else obj.material.dispose();
          }
        }
      });
    }
    cache.delete(oldest);
  }
}

/**
 * Pick a random Meebit ID that hasn't been used recently.
 * `exclude` is a Set of IDs already in the current wave.
 *
 * If LOCAL_ASSET_POOL has entries, we prefer those (returning synthetic
 * negative IDs). Otherwise we pick a real API ID in [0, TOTAL_MEEBITS).
 */
export function pickRandomMeebitId(exclude = new Set()) {
  // Local pool path: synthetic IDs mapped to pool indices.
  if (LOCAL_ASSET_POOL.length > 0) {
    // Build the list of pool IDs not already in `exclude`.
    const available = [];
    for (let i = 0; i < LOCAL_ASSET_POOL.length; i++) {
      const id = LOCAL_ID_BASE - i;
      if (!exclude.has(id)) available.push(id);
    }
    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)];
    }
    // Pool exhausted (more civilians on screen than assets in the pool).
    // Fall through to API selection so we still get a mix -- the caller's
    // dedup set will tolerate duplicates at this point.
    return LOCAL_ID_BASE - Math.floor(Math.random() * LOCAL_ASSET_POOL.length);
  }

  // API path: random ID in the Meebits collection.
  let tries = 0;
  while (tries < 50) {
    const id = Math.floor(Math.random() * TOTAL_MEEBITS);
    if (!exclude.has(id)) return id;
    tries++;
  }
  return Math.floor(Math.random() * TOTAL_MEEBITS);
}

async function fetchMetadata(id) {
  if (metadataCache.has(id)) return metadataCache.get(id);
  try {
    // Route through the public CORS proxy. meebits.app itself won't send
    // Access-Control-Allow-Origin, so the raw URL would be blocked.
    const res = await fetch(proxied(MEEBIT_METADATA_URL(id)));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    metadataCache.set(id, data);
    return data;
  } catch (err) {
    // Metadata failures are usually transient proxy issues -- don't spam.
    // getMeebitMesh() handles the once-per-session user-facing warning.
    metadataCache.set(id, null);
    return null;
  }
}

function buildVoxelFallback(tintHex) {
  // Simple voxel Meebit as last resort. Tinted to the chapter's grid1 so it
  // still reads as "a person" in the arena without a specific visual identity.
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
 * Load a GLB/VRM from the local asset pool. `id` is a synthetic negative
 * number; the actual file path comes from LOCAL_ASSET_POOL[LOCAL_ID_BASE - id].
 *
 * Local loads don't hit the network after the first fetch (browser cache),
 * don't need a proxy, and don't 403. If the file itself is missing or
 * malformed, the caller catches and falls back to voxel.
 */
async function loadLocalAsset(id) {
  if (pendingLoads.has(id)) return pendingLoads.get(id);

  const idx = LOCAL_ID_BASE - id;   // id = -1000 -> idx 0, id = -1001 -> idx 1, ...
  const path = LOCAL_ASSET_POOL[idx];
  if (!path) throw new Error(`No local asset at index ${idx}`);

  const promise = (async () => {
    const gltf = await gltfLoader.loadAsync(path);
    const mesh = gltf.scene;

    // Auto-scale to ~3.2 world units tall so it matches other actors,
    // regardless of the original export scale.
    const bbox = new THREE.Box3().setFromObject(mesh);
    const size = bbox.getSize(new THREE.Vector3());
    const TARGET_HEIGHT = 3.2;
    const scale = size.y > 0.001 ? TARGET_HEIGHT / size.y : 1;
    mesh.scale.setScalar(scale);

    mesh.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = false;
      }
    });

    // ---- DIAG: log the resting position AND parent chain for the first
    // few loads so we can see if gltf.scene has a non-zero .position or
    // is parented to something weird coming out of GLTFLoader.
    if (_diagCount < 3) {
      _diagCount++;
      console.log(`[Meebits POS-DIAG] ${path}`, {
        scenePosition: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
        hasParent: !!mesh.parent,
        parentType: mesh.parent ? mesh.parent.type : 'none',
        childCount: mesh.children.length,
        scaleApplied: scale,
      });
    }

    return mesh;
  })();

  pendingLoads.set(id, promise);
  try {
    return await promise;
  } finally {
    pendingLoads.delete(id);
  }
}

async function loadVRMMesh(id) {
  if (pendingLoads.has(id)) return pendingLoads.get(id);

  const promise = (async () => {
    const meta = await fetchMetadata(id);
    if (!meta || !meta.vrm) {
      throw new Error(`No VRM URL for #${id}`);
    }
    // meta.vrm might be absolute (https://...) or a relative path. Resolve
    // against the meebits.app origin so we have a full URL before proxying.
    let vrmUrl = meta.vrm;
    if (!/^https?:\/\//i.test(vrmUrl)) {
      vrmUrl = new URL(vrmUrl, 'https://meebits.app').toString();
    }
    // GLTFLoader will also fetch any external buffer/texture refs relative
    // to this URL -- those would hit meebits.app directly and fail CORS. The
    // meebits VRMs ship as single self-contained .vrm blobs, so external
    // refs shouldn't be an issue in practice, but watch for that if VRMs
    // start coming in as multi-file glTF in the future.
    const gltf = await gltfLoader.loadAsync(proxied(vrmUrl));
    const mesh = gltf.scene;
    // VRMs often come in facing +Z — our game's forward is also +Z so no rotation.
    // Scale to roughly match other enemy heights (~3 units tall).
    // Meebits VRMs are typically ~1.6-1.8 units tall. Scale up.
    mesh.scale.setScalar(1.8);
    mesh.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = false;
      }
    });
    return mesh;
  })();

  pendingLoads.set(id, promise);
  try {
    const mesh = await promise;
    return mesh;
  } finally {
    pendingLoads.delete(id);
  }
}

/**
 * Get a Meebit mesh for the given ID. Returns a Promise<Object3D>.
 *
 * - Cache hit: returns a clone of the cached mesh.
 * - Negative ID: loads from LOCAL_ASSET_POOL.
 * - Positive ID: loads via the meebits.app API through the CORS proxy.
 * - Failure: returns a voxel fallback tinted to `fallbackTintHex`.
 *
 * Always resolves (never rejects) — caller can render the result unconditionally.
 */
export async function getMeebitMesh(id, fallbackTintHex = 0xaabbcc) {
  if (cache.has(id)) {
    touchCache(id);
    return cache.get(id).mesh.clone(true);
  }
  try {
    const mesh = id < 0 ? await loadLocalAsset(id) : await loadVRMMesh(id);
    cache.set(id, { mesh, lastUsed: performance.now() });
    evictIfNeeded();
    return mesh.clone(true);
  } catch (err) {
    if (id < 0) {
      // Local asset failure is always worth logging -- it means a committed
      // file is missing or corrupted, which is a real bug the dev should see.
      console.warn(`[Meebits] local asset load failed for id ${id}, using voxel:`, err.message);
    } else if (!_apiWarnedThisSession) {
      // API 403s happen because meebits.app gates VRMs behind owner signatures.
      // That's expected, not a bug. Warn once per session, then silently
      // fall back so the console isn't flooded with 12+ errors per wave.
      _apiWarnedThisSession = true;
      console.info(
        '[Meebits] API VRM load failed (first occurrence only -- subsequent ' +
        'failures will be silent). Meebits 3D assets are owner-gated; add ' +
        'your own GLB/VRM files to LOCAL_ASSET_POOL in meebitsPublicApi.js ' +
        'to render real Meebits for civilians.'
      );
    }
    return buildVoxelFallback(fallbackTintHex);
  }
}

/**
 * Prefetch a batch of Meebit IDs in the background. Useful at game start to
 * warm the cache while the player is on the title screen.
 */
export function prefetchMeebits(ids, onProgress) {
  let done = 0;
  ids.forEach(id => {
    getMeebitMesh(id).finally(() => {
      done++;
      if (onProgress) onProgress(done, ids.length);
    });
  });
}

/**
 * Get the portrait image URL (no auth needed, works for all 20K).
 * Used for UI elements like the HUD avatar panel for dead civilians.
 *
 * Routed through the CORS proxy so the URL is safe to use in <canvas> /
 * CanvasRenderingContext2D.drawImage without tainting the canvas. For
 * plain <img> display a direct URL would work too, but going through the
 * proxy keeps behaviour consistent with the VRM loader.
 */
export async function getMeebitPortraitUrl(id) {
  const meta = await fetchMetadata(id);
  if (!meta || !meta.image) return null;
  let url = meta.image;
  if (!/^https?:\/\//i.test(url)) {
    url = new URL(url, 'https://meebits.app').toString();
  }
  return proxied(url);
}

export function getCacheStats() {
  return {
    size: cache.size,
    maxSize: CACHE_SIZE,
    metadataKnown: metadataCache.size,
    localPoolSize: LOCAL_ASSET_POOL.length,
    sourcePriority: LOCAL_ASSET_POOL.length > 0 ? 'local' : 'api',
  };
}
