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
// CHAPTER LOG FORMATTING
// ----------------------------------------------------------------------------
// Herd id → chapter-number-1-indexed + signature chapter color. The
// chapter's grid1 neon is used as the log color so each chapter's logs
// visually group together in the console.
//
//   Chapter 1 INFERNO    — orange  #ff6a1a  (pigs)
//   Chapter 2 CRIMSON    — red     #ff2e4d  (elephants)
//   Chapter 3 SOLAR      — yellow  #ffd93d  (skeletons)
//   Chapter 4 TOXIC      — green   #00ff66  (robots)
//   Chapter 5 ARCTIC     — cyan    #4ff7ff  (visitors)
//   Chapter 6 PARADISE   — purple  #e63aff  (dissected)
//
// If a herd id doesn't match any chapter (future content, typos, etc.)
// the helper returns a neutral green fallback so the format stays valid.
const _HERD_CHAPTER_MAP = {
  pigs:       { chapter: 1, name: 'INFERNO',  color: '#ff6a1a' },
  elephants:  { chapter: 2, name: 'CRIMSON',  color: '#ff2e4d' },
  skeletons:  { chapter: 3, name: 'SOLAR',    color: '#ffd93d' },
  robots:     { chapter: 4, name: 'TOXIC',    color: '#00ff66' },
  visitors:   { chapter: 5, name: 'ARCTIC',   color: '#4ff7ff' },
  dissected:  { chapter: 6, name: 'PARADISE', color: '#e63aff' },
};
function _chapterTagFor(herdId) {
  return _HERD_CHAPTER_MAP[herdId] || { chapter: null, name: '', color: '#888888' };
}

// ----------------------------------------------------------------------------
// CHAPTER LINE BUFFERING
// ----------------------------------------------------------------------------
// Problem: herdVrm manifest, herdVrm prewarm, and bonusWave pool-ready all
// fire for the same chapter but at unpredictable times (parallel worker-pool
// loads). Historically each printed when it happened, which meant chapter 1's
// three lines were scattered across the console interleaved with chapter 2's,
// 3's, etc.
//
// Solution: per-chapter buffer. Each chapter collects its expected events as
// queued log entries; when all expected events have arrived we flush the
// whole group in one `console.info` call per line so the three lines land
// contiguously under the header. Non-chapter logs (pixlPal manifest, flinger
// manifest, player/anim/etc) are untouched — they print live and therefore
// land at the top of the console right after the boot banner, which is what
// the player wanted.
//
// Zero impact on load performance: we never hold up a load waiting for the
// flush. The flush is cosmetic — we're just rearranging when console.info
// calls happen, not when meshes parse.
//
// Safety net: if some expected event never fires (file missing, load error),
// we flush what we have after FLUSH_GRACE_MS past the last event for that
// chapter so nothing gets stuck in the buffer forever.

// Which 6 herds the buffering applies to, and how many events we expect per
// chapter before flushing (manifest + prewarmed + pool-ready = 3).
const CHAPTER_EVENTS_EXPECTED = 3;
const FLUSH_GRACE_MS = 1500;

// herdId → { lines: Array<{format, styles[]}>, timer, flushed }
const _chapterBuffers = new Map();

function _getBuffer(herdId) {
  let buf = _chapterBuffers.get(herdId);
  if (!buf) {
    buf = { lines: [], timer: null, flushed: false };
    _chapterBuffers.set(herdId, buf);
  }
  return buf;
}

/**
 * Queue a log line under a chapter. If this brings the buffer to the
 * expected count, flush immediately. Otherwise arm a grace-period timer
 * so a never-arriving third event doesn't strand lines in the buffer.
 */
function _bufferChapterLine(herdId, format, styles) {
  const t = _chapterTagFor(herdId);
  // No chapter mapping? Fall through to direct console.info — don't buffer
  // something we can't group (would leak forever).
  if (!t.chapter) {
    console.info(format, ...styles);
    return;
  }
  const buf = _getBuffer(herdId);
  if (buf.flushed) {
    // Chapter already flushed (e.g. late-arriving event after grace timer).
    // Print it live right after the flushed block so nothing is lost.
    console.info(format, ...styles);
    return;
  }
  buf.lines.push({ format, styles });
  // Reset the grace timer every time we get a new event for this chapter.
  if (buf.timer) clearTimeout(buf.timer);
  if (buf.lines.length >= CHAPTER_EVENTS_EXPECTED) {
    _flushChapter(herdId);
  } else {
    buf.timer = setTimeout(() => _flushChapter(herdId), FLUSH_GRACE_MS);
  }
}

function _flushChapter(herdId) {
  const buf = _chapterBuffers.get(herdId);
  if (!buf || buf.flushed) return;
  buf.flushed = true;
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  // Print the header first, then every buffered line under it. Each line
  // gets a small progress bar showing its position in the chapter's load
  // sequence — [█░░] 1/3 → [██░] 2/3 → [███] 3/3. Flushed synchronously
  // so the three lines land as one contiguous block.
  _emitChapterHeader(herdId);
  for (let i = 0; i < buf.lines.length; i++) {
    const line = buf.lines[i];
    const bar = _progressBar(i + 1, CHAPTER_EVENTS_EXPECTED);
    // Inject the bar token between the tag and the chapter prefix. Every
    // buffered format string is shaped `%c[tag]%c PREFIX · MESSAGE` — we
    // rebuild it as `%c[tag]%c BAR · PREFIX · MESSAGE` so the bar sits in
    // a consistent column next to the tag.
    const withBar = line.format.replace(/^(%c\[[^\]]+\]%c) /, `$1 ${bar} `);
    console.info(withBar, ...line.styles);
  }
  buf.lines.length = 0;
}

/**
 * Build a simple black-and-white progress bar. `filled` of `total` slots
 * rendered as filled (█) vs empty (░) with a slot-count suffix.
 *   _progressBar(1, 3) → "[█░░] 1/3"
 *   _progressBar(2, 3) → "[██░] 2/3"
 *   _progressBar(3, 3) → "[███] 3/3"
 * Unicode block chars render reliably in every browser console — no CSS
 * styling needed, stays black-and-white in light and dark themes.
 */
function _progressBar(filled, total) {
  const f = Math.max(0, Math.min(total, filled));
  return '[' + '█'.repeat(f) + '░'.repeat(total - f) + '] ' + f + '/' + total;
}

function _emitChapterHeader(herdId) {
  const t = _chapterTagFor(herdId);
  if (!t.chapter) return;
  // Header format — blank line above for separation between chapter blocks,
  // label in default color (bold), colored swatch square, hex code in mono.
  //
  //   ── Ch 1 · INFERNO · pigs · [■] #ff6a1a ──
  //
  // Four %c segments:
  //   1) rule + label (default text color, bold)
  //   2) colored square — 2 space chars with background-color as the swatch
  //   3) hex code in mono font, default color
  //   4) closing rule
  console.info(
    '\n%c── Ch ' + t.chapter + ' · ' + t.name + ' · ' + herdId + ' · %c  %c ' + t.color + '%c ──',
    'font-weight:bold; font-size:13px;',
    `background-color:${t.color}; border-radius:2px; padding:0 2px;`,
    'font-family:ui-monospace,Menlo,Consolas,monospace; font-weight:normal;',
    'font-weight:bold; font-size:13px;',
  );
}

/**
 * Backwards-compat shim for anything outside this file that used to call
 * printChapterHeaderOnce. The buffered system prints the header as part of
 * the flush, so this is now a no-op for mapped chapters — the header will
 * arrive automatically when the chapter's events are all in. Still exported
 * so bonusWave.js's existing import doesn't break.
 */
export function printChapterHeaderOnce(/* herdId */) {
  // intentionally empty — see _flushChapter / _emitChapterHeader
}

function _logHerdLine(herdId, message) {
  const t = _chapterTagFor(herdId);
  const prefix = t.chapter
    ? `Chapter ${t.chapter} · ${t.name} · ${herdId}`
    : herdId;
  // Plain-text prefix now that the header carries the color cue. Only the
  // [herdVrm] tag itself keeps a muted grey to distinguish it from bare log.
  _bufferChapterLine(
    herdId,
    `%c[herdVrm]%c ${prefix} · ${message}`,
    ['color:#888', 'color:inherit'],
  );
}

/**
 * External entry point for bonusWave.js to log its per-chapter pool-ready
 * line through the buffer so it lands under the chapter header alongside
 * the manifest + prewarmed lines.
 */
export function logBonusWaveLine(herdId, chapterLabel, message) {
  _bufferChapterLine(
    herdId,
    `%c[bonusWave]%c ${chapterLabel} · ${message}`,
    ['color:#888', 'color:inherit'],
  );
}

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
      _logHerdLine(herdId, `manifest found (${manifestFiles.length} files)`);
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
      _logHerdLine(herdId, `${sequentialFiles.length} sequential files found`);
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
  // Abort only the initial fetch — NOT the JSON-body read. Previously the
  // timer was active through `await res.json()`, which meant a slow parse
  // (or six simultaneous parses during preloadAllHerds) could fire the abort
  // AFTER the response headers came back OK, killing the read mid-stream.
  // The `catch` then silently returned null, dropping us into the sequential
  // probe that 404s on 00001.vrm. Now: headers-only timeout, then unconditional
  // parse.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_PROBE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[herdVrm] ${herdId}/manifest.json fetch failed:`, err.message || err);
    return null;
  }
  clearTimeout(timer);   // headers are back, don't abort the body read
  if (!res.ok) {
    // 404 here means "no manifest, try sequential" — quiet path, no warn.
    return null;
  }
  try {
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
    console.warn(`[herdVrm] ${herdId}/manifest.json parse failed:`, err.message || err);
    return null;
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

  // NORMALIZED SIZING.
  // Previously we applied a blanket `scale.setScalar(1.8)` to match the
  // player. But different herds have different rest-pose heights — the
  // dissected VRMs in particular are intrinsically larger than the pigs/
  // robots/etc. After a blanket multiply they rendered noticeably
  // oversized next to the other saved meebits.
  //
  // Fix: measure the current world-space height and rescale to a fixed
  // target of 2.6 units (matches the player's ~2.6u on-screen height =
  // raw Meebit VRM ~1.44u × PLAYER.scale 1.8). Now every herd, regardless
  // of rest pose, ends up looking the same size as every other saved
  // meebit. This is the single source of truth — the bonus-wave pool
  // clones inherit this scale automatically.
  vrmScene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrmScene);
  const sizeV = new THREE.Vector3();
  box.getSize(sizeV);
  if (sizeV.y > 0.01 && isFinite(sizeV.y)) {
    vrmScene.scale.multiplyScalar(2.6 / sizeV.y);
  } else {
    // Fallback if bounding box is invalid — apply the legacy multiplier so
    // we at least render something recognizable.
    vrmScene.scale.setScalar(1.8);
  }
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
 * Safe clone for skinned meshes with MATERIAL SHARING.
 *
 * Plain Object3D.clone() for a mesh containing SkinnedMesh produces a clone
 * whose SkinnedMesh instances still reference the ORIGINAL skeleton. Every
 * cloned herd meebit then renders at the original's world position regardless
 * of the clone's .position. They look invisible / clumped.
 *
 * SkeletonUtils.clone walks the hierarchy, clones the bones, and rebinds
 * each SkinnedMesh to the cloned skeleton — producing an independently
 * positionable copy that actually renders where we put it.
 *
 * MATERIAL SHARING (perf win):
 * SkeletonUtils.clone clones material instances too. Each cloned material is a
 * new object as far as the GPU driver is concerned → triggers a fresh shader
 * program compile on first render. For a herd of 111 with 8-10 materials each,
 * that's 800-1100 compiles = seconds of freeze on Wave 6 start.
 *
 * Fix: after cloning, walk each cloned mesh and replace its `.material` with
 * the CORRESPONDING material reference from the original. Materials are
 * read-only at runtime (color/roughness/etc. never change for herd meebits),
 * so sharing them is safe. Three.js & the GPU driver recognize shared material
 * references and reuse the same compiled shader program → one compile per
 * unique material across the ENTIRE herd.
 *
 * For non-skinned meshes (voxel fallback), plain clone() is fine and faster.
 */
function safeClone(mesh) {
  let hasSkin = false;
  mesh.traverse(obj => { if (obj.isSkinnedMesh) hasSkin = true; });
  if (!hasSkin) {
    return mesh.clone(true);
  }

  const cloned = SkeletonUtils.clone(mesh);
  cloned.userData = Object.assign({}, mesh.userData);

  // Walk original & clone in parallel, rebinding clone materials to original.
  // Relies on SkeletonUtils.clone preserving child order (it does — traversal
  // is deterministic).
  const origMeshes = [];
  mesh.traverse(obj => { if (obj.isMesh || obj.isSkinnedMesh) origMeshes.push(obj); });
  let meshIdx = 0;
  cloned.traverse(obj => {
    if (obj.isMesh || obj.isSkinnedMesh) {
      const origObj = origMeshes[meshIdx++];
      if (origObj && origObj.material) {
        obj.material = origObj.material;
      }
    }
  });

  return cloned;
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

/**
 * PRELOAD EVERY HERD — fetches + parses + caches every VRM across all 6
 * chapters before gameplay begins. Called during the matrix dive so the
 * player's dramatic intro doubles as the loading screen.
 *
 * Parallelism: up to CONCURRENT_LOADS in flight at once. Browsers cap
 * ~6 concurrent connections per origin anyway, so 6 saturates the pipe
 * without thrashing.
 *
 * Progress: calls onProgress({ loaded, total, herdId, filename }) as each
 * VRM finishes. Caller uses this to drive the perimeter progress bar.
 *
 * Non-rejecting: failed VRMs fall back to voxel placeholders in the loader;
 * caller can rely on preloadAllHerds resolving even if every file 404s.
 *
 * @param {string[]} herdIds  — which herds to load. Pass every chapter id.
 * @param {(info:{loaded:number,total:number,herdId:string,filename:string})=>void} onProgress
 * @param {THREE.WebGLRenderer} [renderer]  — optional; interleave shader compile
 * @param {THREE.Camera} [camera]  — optional; required alongside renderer
 */
export async function preloadAllHerds(herdIds, onProgress, renderer, camera) {
  const CONCURRENT_LOADS = 6;

  // Phase 1: discover all manifests in parallel. Cheap — each is a single
  // JSON fetch, ~2KB.
  const discoveries = await Promise.all(
    herdIds.map(async h => ({ herdId: h, files: await discoverHerd(h).catch(() => []) }))
  );

  // Build a flat work queue: [{ herdId, filename }, ...]
  const queue = [];
  for (const { herdId, files } of discoveries) {
    for (const fname of files) {
      queue.push({ herdId, filename: fname });
    }
  }
  const total = queue.length;

  if (total === 0) {
    // Nothing to load (e.g., no manifests exist yet). Still fire a final
    // progress event so callers can advance UI.
    if (onProgress) onProgress({ loaded: 0, total: 0, herdId: null, filename: null });
    return { total: 0, loaded: 0 };
  }

  let loaded = 0;
  let cursor = 0;

  // Worker coroutine: pulls from the shared queue until empty.
  async function _worker() {
    while (cursor < queue.length) {
      const task = queue[cursor++];
      try {
        // awaits fetch + parse. Already cached? Resolves immediately.
        await getHerdMeshByFilename(task.herdId, task.filename);
      } catch (e) {
        // Voxel-fallback path inside getHerdMeshByFilename already handled it.
      }
      loaded++;
      if (onProgress) {
        onProgress({ loaded, total, herdId: task.herdId, filename: task.filename });
      }
    }
  }

  // Launch CONCURRENT_LOADS workers racing the queue.
  const workers = [];
  for (let i = 0; i < CONCURRENT_LOADS; i++) workers.push(_worker());
  await Promise.all(workers);

  // Phase 2: after all fetches done, pre-compile shaders per herd. This is
  // the "second half" of the loading cost (GPU work vs network). We do it
  // after all fetches so the compile never contends with fetches for CPU.
  if (renderer && camera) {
    for (const herdId of herdIds) {
      prewarmHerd(herdId, renderer, camera);
      // Yield between herds so one huge compile doesn't spike frame time.
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return { total, loaded };
}

/**
 * Prefetch the full list of herd files so the fetch+parse cost is paid BEFORE
 * the bonus wave starts. Non-blocking — fires off all loads in parallel
 * (dedup'd by the load cache). Errors suppressed.
 *
 * If a discovery hasn't happened yet for this herd, trigger one first.
 */
export async function prefetchHerd(herdId /* ignores old indices arg */) {
  let files = herdFilenamesCache.get(herdId);
  if (!files) {
    try {
      files = await discoverHerd(herdId);
    } catch (e) {
      return;
    }
  }
  if (!files || files.length === 0) return;
  // Fire all loads in parallel. getHerdMeshByFilename dedups concurrent loads
  // and caches results, so this is idempotent.
  for (const fname of files) {
    getHerdMeshByFilename(herdId, fname).catch(() => {});
  }
}

// Per-herd state for the slow-drip prefetcher. Tracks how many files have
// been loaded so we can resume from the same index on the next wave.
const _slowDripCursor = new Map();
const _slowDripRunning = new Set();

/**
 * SLOW-DRIP PREFETCH — load up to `budget` VRMs from this herd with yields
 * between each so the render loop keeps its 16ms/frame budget.
 *
 * Called once per wave during waves 1-5 to smear the herd-load cost across
 * ~2 minutes of combat rather than cramming it into the boss fight or
 * (worse) the Wave 6 spawn burst.
 *
 * Non-blocking. Idempotent — safe to call multiple times; each call continues
 * from where the previous one left off. If the herd is already fully loaded,
 * returns immediately.
 *
 * @param {string} herdId
 * @param {number} budget  — max VRMs to load this call (default 10)
 */
export async function prefetchHerdSlow(herdId, budget = 10) {
  if (_slowDripRunning.has(herdId)) return;   // another call already in progress
  _slowDripRunning.add(herdId);

  try {
    let files = herdFilenamesCache.get(herdId);
    if (!files) {
      try {
        files = await discoverHerd(herdId);
      } catch (e) {
        return;
      }
    }
    if (!files || files.length === 0) return;

    let cursor = _slowDripCursor.get(herdId) || 0;
    const end = Math.min(cursor + budget, files.length);

    for (; cursor < end; cursor++) {
      const fname = files[cursor];
      const key = mcacheKey(herdId, fname);
      // Skip if already cached (idempotent).
      if (cache.has(key) || pendingLoads.has(key)) continue;

      try {
        // Start the load and wait for it. We don't parallelize here —
        // serializing keeps per-frame cost tiny (one GLTF parse ~ 10-30ms).
        await getHerdMeshByFilename(herdId, fname);
      } catch (e) {
        // Suppressed — load errors are already voxel-fallbacked in the loader.
      }

      // Yield to the browser so we don't block a frame.
      await _yieldToBrowser();
    }

    _slowDripCursor.set(herdId, cursor);
  } finally {
    _slowDripRunning.delete(herdId);
  }
}

// Cross-browser yield primitive. requestIdleCallback is best (runs when the
// browser is idle) but Safari doesn't support it as of writing. Fall back to
// setTimeout(0) which still yields the main thread but fires sooner.
function _yieldToBrowser() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(resolve, { timeout: 100 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * How many of the herd's files are already in cache. Used by callers who
 * want to know if the slow-drip is complete before moving on.
 */
export function getHerdLoadedCount(herdId) {
  const files = herdFilenamesCache.get(herdId);
  if (!files) return 0;
  let count = 0;
  for (const fname of files) {
    if (cache.has(mcacheKey(herdId, fname))) count++;
  }
  return count;
}

/**
 * Reset the slow-drip cursor so prefetchHerdSlow starts from the beginning.
 * Call on full game reset so a new run restarts the slow-drip fresh.
 */
export function resetSlowDripState() {
  _slowDripCursor.clear();
  _slowDripRunning.clear();
}

/**
 * PRE-WARM SHADER COMPILATION for a herd.
 *
 * Three.js compiles shaders lazily — the first frame a material becomes
 * visible in the render tree, the GPU driver compiles its shader program.
 * With 49 pigs × 8 materials each = 400+ compiles, doing them all at once
 * on Wave 6 spawn locks the main thread for 2-4 seconds.
 *
 * Workaround: `renderer.compile(scene, camera)` forces eager compilation of
 * every material in a scene without actually drawing a frame. We create a
 * temporary off-screen scene, park each cached herd mesh in it, run compile,
 * then drop the scene reference. The mesh stays cached; only the temp scene
 * + materials need to garbage-collect.
 *
 * Call this during the boss fight (when the player is distracted). The
 * compile still costs time, but it's spread across the player's engagement
 * with the boss rather than clumped at Wave 6 start.
 *
 * Safe to call multiple times — only compiles what's already fetched.
 * Non-blocking; any error falls through (compilation is a nice-to-have).
 *
 * @param {string} herdId
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Camera} camera
 */
export function prewarmHerd(herdId, renderer, camera) {
  if (!renderer || !renderer.compile || !camera) return;

  const files = herdFilenamesCache.get(herdId);
  if (!files || files.length === 0) return;

  // Collect every already-loaded mesh for this herd.
  const tempScene = new THREE.Scene();
  let compiledCount = 0;
  for (const fname of files) {
    const key = mcacheKey(herdId, fname);
    const cached = cache.get(key);
    if (!cached) continue;        // not fetched yet — skip, will compile on demand
    if (cached.userData && cached.userData.isFallback) continue;  // voxel, no compile needed
    // Add to temp scene. We don't clone — original is fine, compile walks
    // materials regardless of position, and we remove before anyone else sees.
    tempScene.add(cached);
    compiledCount++;
  }

  if (compiledCount === 0) return;

  try {
    renderer.compile(tempScene, camera);
  } catch (err) {
    // Driver quirks can throw on specific hardware. Not fatal.
    console.warn('[herdVrm] prewarm compile failed (non-fatal):', err);
  }

  // Detach all the cached meshes from the temp scene. The cache still holds
  // its reference, so they won't be GC'd. tempScene will be GC'd once this
  // function returns. (Three.js supports scene.remove without disposing.)
  while (tempScene.children.length > 0) {
    tempScene.remove(tempScene.children[0]);
  }

  _logHerdLine(herdId, `prewarmed ${compiledCount} meshes`);
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
