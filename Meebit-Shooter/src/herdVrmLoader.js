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
// CHAPTER LINE LOGGING — staged clear-and-repaint
// ----------------------------------------------------------------------------
// Each chapter emits three events during preload in a predictable order:
//   1. [herdVrm] manifest found       (fast, ~1s into load)
//   2. [herdVrm] prewarmed N meshes   (medium, once that chapter's VRMs parse)
//   3. [bonusWave] pool ready         (slow, after scene clone + GPU compile)
//
// We display these as a three-stage progress view:
//   - Stage 1 (manifest):  [█░░] 1/3
//   - Stage 2 (prewarmed): [██░] 2/3
//   - Stage 3 (pool):      [███] 3/3
//
// When all 6 chapters have reported the same stage, we wait ~1s (so the
// player can glimpse the prior stage) then:
//   1. console.clear()            — wipes the entire console
//   2. window.__printBootBanner() — reprints the Meebit ASCII banner
//   3. re-prints every chapter header + stage line in chapter order (1→6)
//
// Trade-off: console.clear() is all-or-nothing — it also wipes pixlPal /
// flinger / player lines above the headers and any errors that happened
// mid-load. We re-print what we know about (the chapter events); anything
// else is gone until the next load. If you need those lines preserved while
// debugging, set `window.__keepLogs = true` in DevTools before reload — the
// clear-and-repaint short-circuits and each event prints live.

const CHAPTER_EVENTS_EXPECTED = 3;
const REPAINT_DELAY_MS = 4000;

// Fixed chapter order for the repainted view. Matches _HERD_CHAPTER_MAP
// above — keeps ch 1 at top, ch 6 at bottom regardless of load order.
const _REPAINT_ORDER = ['pigs', 'elephants', 'skeletons', 'robots', 'visitors', 'dissected'];

// herdId → highest stage this chapter has reached (1, 2, or 3), plus the
// latest message string per stage so repaint can re-render exactly what
// each event said.
const _chapterStage = new Map();

let _pendingRepaintTimer = null;
let _lastRepaintedStage = 0;

function _chapterStateFor(herdId) {
  let s = _chapterStage.get(herdId);
  if (!s) {
    s = {
      stage: 0,
      messages: { 1: null, 2: null, 3: null },
      tagForStage: { 1: null, 2: null, 3: null },
      liveHeaderPrinted: false,
    };
    _chapterStage.set(herdId, s);
  }
  return s;
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
 * Build a simple black-and-white progress bar. `filled` of `total` slots
 * rendered as filled (█) vs empty (░) with a slot-count suffix.
 *   _progressBar(1, 3) → "[█░░] 1/3"
 *   _progressBar(2, 3) → "[██░] 2/3"
 *   _progressBar(3, 3) → "[███] 3/3"
 */
function _progressBar(filled, total) {
  const f = Math.max(0, Math.min(total, filled));
  return '[' + '█'.repeat(f) + '░'.repeat(total - f) + '] ' + f + '/' + total;
}

function _printChapterLineLive(tag, herdId, stage, message) {
  const t = _chapterTagFor(herdId);
  const state = _chapterStateFor(herdId);
  if (!state.liveHeaderPrinted) {
    _emitChapterHeader(herdId);
    state.liveHeaderPrinted = true;
  }
  const bar = _progressBar(stage, CHAPTER_EVENTS_EXPECTED);
  const prefix = `Chapter ${t.chapter} · ${t.name} · ${herdId}`;
  console.info(
    `%c${tag}%c ${bar} ${prefix} · ${message}`,
    'color:#888',
    'color:inherit',
  );
}

/**
 * Record a chapter event. Once all 6 chapters have reported this same
 * stage, schedule a 1s-delayed clear-and-repaint.
 */
function _emitChapterEvent(tag, herdId, stage, message) {
  const t = _chapterTagFor(herdId);
  // Unknown herd — print plain and skip the staged machinery.
  if (!t.chapter) {
    console.info(`%c${tag}%c ${herdId} · ${message}`, 'color:#888', 'color:inherit');
    return;
  }

  const state = _chapterStateFor(herdId);
  state.stage = Math.max(state.stage, stage);
  state.messages[stage] = message;
  state.tagForStage[stage] = tag;

  // Developer override — skip the clear-and-repaint dance and just print
  // live so errors/warnings stay visible for debugging.
  if (typeof window !== 'undefined' && window.__keepLogs === true) {
    _printChapterLineLive(tag, herdId, stage, message);
    return;
  }

  // Before the FIRST repaint, print each event live so the player sees
  // activity immediately. Once we've done the first repaint (stage 1 all
  // caught up), subsequent events are silent until the next repaint.
  if (_lastRepaintedStage === 0) {
    _printChapterLineLive(tag, herdId, stage, message);
  }

  _maybeScheduleRepaint();
}

/**
 * If all 6 chapters have reached at least the next stage, arm a timer.
 */
function _maybeScheduleRepaint() {
  let minStage = CHAPTER_EVENTS_EXPECTED;
  for (const herdId of _REPAINT_ORDER) {
    const s = _chapterStage.get(herdId);
    const stage = s ? s.stage : 0;
    if (stage < minStage) minStage = stage;
  }
  if (minStage <= _lastRepaintedStage) return;

  if (_pendingRepaintTimer) return;   // coalesce — already armed
  _pendingRepaintTimer = setTimeout(() => {
    _pendingRepaintTimer = null;
    _doRepaint();
  }, REPAINT_DELAY_MS);
}

function _doRepaint() {
  // Re-evaluate at fire time — more events may have arrived during the
  // 1s wait.
  let minStage = CHAPTER_EVENTS_EXPECTED;
  for (const herdId of _REPAINT_ORDER) {
    const s = _chapterStage.get(herdId);
    const stage = s ? s.stage : 0;
    if (stage < minStage) minStage = stage;
  }
  if (minStage <= _lastRepaintedStage) return;

  console.clear();
  if (typeof window !== 'undefined' && typeof window.__printBootBanner === 'function') {
    window.__printBootBanner();
  }

  // Walk every chapter in fixed 1→6 order. Print the header, then every
  // line from stage 1 up to the current stage — so at stage 2, each chapter
  // shows both its 1/3 manifest line and its 2/3 prewarmed line.
  for (const herdId of _REPAINT_ORDER) {
    const state = _chapterStateFor(herdId);
    _emitChapterHeader(herdId);
    for (let stage = 1; stage <= minStage; stage++) {
      const msg = state.messages[stage];
      const tag = state.tagForStage[stage];
      if (!msg || !tag) continue;
      const bar = _progressBar(stage, CHAPTER_EVENTS_EXPECTED);
      const t = _chapterTagFor(herdId);
      const prefix = `Chapter ${t.chapter} · ${t.name} · ${herdId}`;
      console.info(
        `%c${tag}%c ${bar} ${prefix} · ${msg}`,
        'color:#888',
        'color:inherit',
      );
    }
  }

  _lastRepaintedStage = minStage;

  // Final stage — print the credits signoff once all six chapters are
  // fully loaded. See _printSignoff for style details.
  if (minStage >= CHAPTER_EVENTS_EXPECTED) {
    _printSignoff();
  }

  // If loading was fast enough that we already have data for the next
  // stage too, chain another repaint.
  _maybeScheduleRepaint();
}

// ----------------------------------------------------------------------------
// SIGNOFF — "MADE BY JDUNK WITH CLAUDE AI"
// ----------------------------------------------------------------------------
// Prints once after the final stage-3 repaint. "JDUNK" uses stacked
// text-shadows as a faux outline so it stays readable on any console
// background. "CLAUDE AI" uses Anthropic's brand coral (#cc785c) with
// a soft glow.

let _signoffPrinted = false;

function _printSignoff() {
  if (_signoffPrinted) return;
  _signoffPrinted = true;

  const CLAUDE_CORAL = '#cc785c';

  // Print the header/divider. Two blank lines above for breathing room
  // after the last chapter block.
  console.log('\n\n%c' + '─'.repeat(60),
    `color:${CLAUDE_CORAL}; text-shadow:0 0 4px ${CLAUDE_CORAL};`,
  );

  // Main signoff line. "JDUNK" reads bright-white-bold with a chunky black
  // text-shadow halo so it pops against light AND dark console themes
  // (without the outline it was getting lost on Chrome's default light
  // background). "CLAUDE AI" reads in brand coral with a soft glow.
  // The ✦ sparkles frame the line.
  console.log(
    '%c  ✦ %cMADE BY %cJDUNK%c WITH %cCLAUDE AI%c ✦',
    `color:${CLAUDE_CORAL}; font-size:16px; text-shadow:0 0 8px ${CLAUDE_CORAL};`,  // leading sparkle
    'color:#888; font-size:13px;',                                                   // "MADE BY"
    // "JDUNK" — white core + thick black halo via multi-offset text-shadow
    // so the letters stay readable on any background. Consoles don't
    // support -webkit-text-stroke reliably, but stacked text-shadows at
    // four cardinal + four diagonal offsets emulate a true outline well.
    'color:#ffffff; font-weight:900; font-size:14px; letter-spacing:2px; ' +
      'text-shadow:-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, ' +
      '-2px 0 0 #000, 2px 0 0 #000, 0 -2px 0 #000, 0 2px 0 #000;',
    'color:#888; font-size:13px;',                                                   // "WITH"
    `color:${CLAUDE_CORAL}; font-weight:900; font-size:14px; letter-spacing:2px; text-shadow:0 0 6px ${CLAUDE_CORAL};`,  // "CLAUDE AI"
    `color:${CLAUDE_CORAL}; font-size:16px; text-shadow:0 0 8px ${CLAUDE_CORAL};`,  // trailing sparkle
  );

  // Closing divider.
  console.log('%c' + '─'.repeat(60) + '\n',
    `color:${CLAUDE_CORAL}; text-shadow:0 0 4px ${CLAUDE_CORAL};`,
  );
}

/**
 * Backwards-compat shim. The old design had this as an explicit header-print
 * hook; the new design prints headers automatically during repaint. Kept as
 * a no-op so existing imports don't break.
 */
export function printChapterHeaderOnce(/* herdId */) {
  // intentionally empty
}

function _logHerdLine(herdId, message) {
  // Map the two herdVrm messages to stages. Stage 1 = manifest; stage 2 =
  // prewarmed. Substring check avoids threading a stage arg through every
  // call site.
  const stage = message.startsWith('prewarmed') ? 2 : 1;
  _emitChapterEvent('[herdVrm]', herdId, stage, message);
}

/**
 * External entry point for bonusWave.js to log its per-chapter pool-ready
 * line (stage 3) through the same staged-repaint machinery.
 */
export function logBonusWaveLine(herdId, _chapterLabel, message) {
  _emitChapterEvent('[bonusWave]', herdId, 3, message);
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
