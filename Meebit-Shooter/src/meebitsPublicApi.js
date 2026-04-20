// Public Meebits API wrapper with LRU cache.
//
// Unlike meebitsApi.js (which requires the user to sign a wallet message to
// prove ownership before getting a GLB), this module hits the fully public
// metadata endpoint and loads VRM files for ANY Meebit in the 20,000-character
// collection. Used for civilian NPCs that wander the arena.
//
// Endpoint:
//   GET https://meebits.app/meebit/{id}
//   → { image, vrm, sprite_sheet, attributes }
//
// CORS:
//   meebits.app does NOT send Access-Control-Allow-Origin, so direct fetches
//   from github.io (or any non-meebits origin) get blocked by the browser.
//   We route both the JSON metadata and the VRM binary through corsproxy.io,
//   a free public CORS proxy. Note that this proxy can rate-limit aggressively
//   and has no uptime guarantees -- if you see widespread fallback-to-voxel
//   behaviour after heavy play, that's probably the reason. Long-term fix is
//   to host your own thin proxy on the same origin as the game.
//
// VRM is a glTF superset -- we load with GLTFLoader (ignoring spring bones and
// expressions, which don't matter for a shooter). If the fetch fails for any
// reason (CORS, 404, network, proxy rate-limit), we fall back to a voxel
// Meebit so the game always renders something.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Public CORS proxy. Format: https://corsproxy.io/?<url-encoded-target>
// Swap this out for your own proxy if you host one.
const CORS_PROXY = 'https://corsproxy.io/?';
function proxied(url) { return CORS_PROXY + encodeURIComponent(url); }

const MEEBIT_METADATA_URL = (id) => `https://meebits.app/meebit/${id}`;
const TOTAL_MEEBITS = 20000;
const CACHE_SIZE = 100;

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
 */
export function pickRandomMeebitId(exclude = new Set()) {
  let tries = 0;
  while (tries < 50) {
    const id = Math.floor(Math.random() * TOTAL_MEEBITS);
    if (!exclude.has(id)) return id;
    tries++;
  }
  // Fallback: just return something even if it collides
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
    console.warn(`[Meebits] metadata fetch failed for #${id}:`, err.message);
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
 * - Cache hit: returns a clone of the cached mesh (safe to modify independently)
 * - Cache miss: fetches metadata + VRM, caches the result, returns a clone
 * - Failure: returns a voxel fallback tinted to `fallbackTintHex`
 *
 * Always resolves (never rejects) — caller can render the result unconditionally.
 */
export async function getMeebitMesh(id, fallbackTintHex = 0xaabbcc) {
  if (cache.has(id)) {
    touchCache(id);
    return cache.get(id).mesh.clone(true);
  }
  try {
    const mesh = await loadVRMMesh(id);
    cache.set(id, { mesh, lastUsed: performance.now() });
    evictIfNeeded();
    return mesh.clone(true);
  } catch (err) {
    console.warn(`[Meebits] load failed for #${id}, using voxel:`, err.message);
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
  };
}
