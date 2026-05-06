// endlessDissolve.js — Wave-end "walls dissolve into autoglyph" animation
//
// When a wave ends, the maze walls explode into particles, fly to
// positions matching a generated autoglyph, and assemble the glyph
// across the full footprint that the maze just occupied. An
// "ACCESS GRANTED" banner fades in while the glyph is on display,
// then the whole pattern sinks into the floor.
//
// Each filled cell of the autoglyph is rendered as its actual symbol
// shape (square, circle, plus, X, pipe, dash, slash, backslash) — one
// InstancedMesh per base geometry so the whole assembly is still only
// a handful of draw calls regardless of cell count. Compound symbols
// (PLUS, X) write to two instance slots per cell, one for each bar of
// the cross.
//
// API:
//   startDissolve(walls, waveSeed, mazeBounds?)
//     walls       — wall AABBs from getMazeWallEntries(); particle
//                   origins.
//     waveSeed    — seeds the autoglyph (deterministic per wave).
//     mazeBounds  — { x0, x1, z0, z1 } in world units; the autoglyph
//                   patch is mapped onto this rectangle so the glyph
//                   replaces the maze 1:1. If omitted, falls back to
//                   a 30u centered patch (legacy behavior).
//   tickDissolve(dt) → boolean (true while still active).
//   cancelDissolve() — abort + dispose particles + DOM overlay.
//   isDissolveActive() — convenience predicate.

import * as THREE from 'three';
import { scene } from './scene.js';
import { generateAutoglyph, forEachCell, SYMBOLS } from './autoglyph.js';

// =====================================================================
// PHASE TIMINGS
// =====================================================================

const PHASE_EXPLODE_END = 0.3;
const PHASE_FLY_END     = 1.6;
const PHASE_DISPLAY_END = 5.6;     // 4s reward window so the player can read it
const PHASE_SINK_END    = 6.6;

// "ACCESS GRANTED" banner fade window — fades in as particles settle,
// holds through display, fades out into the sink.
const BANNER_FADE_IN_START  = 1.3;
const BANNER_FADE_IN_END    = 1.9;
const BANNER_FADE_OUT_START = 5.2;
const BANNER_FADE_OUT_END   = 5.8;

// Glyph grid resolution — must match autoglyph.js.
const GLYPH_GRID_DIM = 64;
const GLYPH_FLOOR_Y  = 0.06;       // tiny lift so we don't z-fight the floor

// Legacy fallback patch — only used if mazeBounds isn't supplied.
const LEGACY_PATCH_SIZE = 30.0;

// =====================================================================
// SYMBOL GEOMETRY DEFINITIONS
// =====================================================================
//
// Each base geometry is a flat shape lying on the XZ plane (Y is up).
// Sizes are tuned for a glyph cell of ~1.4u (95u arena / 64 cells).
//
//   square — solid filled square (#)
//   circle — flat ring (O)
//   horiz  — short horizontal bar (used by DASH and the cross-bar of +)
//   vert   — short vertical bar   (used by PIPE and the up-bar of +)
//   slash  — diagonal bar /       (used by SLASH and one bar of X)
//   bslash — diagonal bar \       (used by BACKSLASH and one bar of X)

const CELL_BASE = 1.15;           // visual extent of a single symbol
const BAR_THIN  = 0.22;           // thickness of bars
const FLAT_Y    = 0.10;           // extruded height (so they catch light)

function _buildSymbolGeometries() {
  const out = {};

  out.square = new THREE.BoxGeometry(CELL_BASE, FLAT_Y, CELL_BASE);

  // Torus: ring of radius ~0.5, tube ~0.10. Default torus lies in XY
  // plane — bake a -π/2 X rotation so it lies flat on XZ.
  const torus = new THREE.TorusGeometry(CELL_BASE * 0.42, 0.10, 6, 18);
  torus.rotateX(-Math.PI / 2);
  out.circle = torus;

  // Horizontal bar — long along X, thin along Z.
  out.horiz = new THREE.BoxGeometry(CELL_BASE, FLAT_Y, BAR_THIN);

  // Vertical bar — long along Z, thin along X.
  out.vert = new THREE.BoxGeometry(BAR_THIN, FLAT_Y, CELL_BASE);

  // Slash / backslash — start with a horizontal bar, bake a Y rotation
  // so all instances render at the right diagonal orientation.
  const slash = new THREE.BoxGeometry(CELL_BASE * 1.05, FLAT_Y, BAR_THIN);
  slash.rotateY(-Math.PI / 4);
  out.slash = slash;

  const bslash = new THREE.BoxGeometry(CELL_BASE * 1.05, FLAT_Y, BAR_THIN);
  bslash.rotateY(Math.PI / 4);
  out.bslash = bslash;

  return out;
}

// Per-symbol render recipe — which mesh slots the cell writes to.
// Compound shapes (PLUS, X) write 2 slots per cell.
const SYMBOL_RECIPE = {
  [SYMBOLS.SQUARE]:    ['square'],
  [SYMBOLS.CIRCLE]:    ['circle'],
  [SYMBOLS.PLUS]:      ['horiz', 'vert'],
  [SYMBOLS.X]:         ['slash', 'bslash'],
  [SYMBOLS.PIPE]:      ['vert'],
  [SYMBOLS.DASH]:      ['horiz'],
  [SYMBOLS.SLASH]:     ['slash'],
  [SYMBOLS.BACKSLASH]: ['bslash'],
};

const MESH_KEYS = ['square', 'circle', 'horiz', 'vert', 'slash', 'bslash'];

// =====================================================================
// STATE
// =====================================================================

let _instancedMeshes = null;       // { square, circle, horiz, vert, slash, bslash }
let _instanceMaterial = null;      // shared across all meshes
let _particles = [];               // CPU-side per-cell state
let _phaseT = 0;
let _active = false;
let _bannerEl = null;

const _scratchMatrix = new THREE.Matrix4();
const _scratchQuat   = new THREE.Quaternion();
const _scratchPos    = new THREE.Vector3();
const _scratchScale  = new THREE.Vector3(1, 1, 1);

// =====================================================================
// PUBLIC API
// =====================================================================

export function startDissolve(walls, waveSeed, mazeBounds) {
  cancelDissolve();

  if (!walls || walls.length === 0) {
    _active = false;
    return;
  }

  // Resolve the patch the glyph will fill.
  let x0, x1, z0, z1;
  if (mazeBounds && Number.isFinite(mazeBounds.x0)) {
    // Inset slightly so the glyph stops just before the arena edge —
    // looks framed instead of bleeding off-screen.
    const inset = 1.5;
    x0 = mazeBounds.x0 + inset; x1 = mazeBounds.x1 - inset;
    z0 = mazeBounds.z0 + inset; z1 = mazeBounds.z1 - inset;
  } else {
    x0 = -LEGACY_PATCH_SIZE / 2; x1 = LEGACY_PATCH_SIZE / 2;
    z0 = -LEGACY_PATCH_SIZE / 2; z1 = LEGACY_PATCH_SIZE / 2;
  }
  const patchW = x1 - x0;
  const patchH = z1 - z0;

  // Generate the autoglyph for this wave.
  const glyph = generateAutoglyph(waveSeed * 2654435761 + 1);

  // Walk every filled cell — no down-sampling. The autoglyph IS the
  // arena now, so honor every symbol.
  const filled = [];
  forEachCell(glyph, (gx, gy, sym) => {
    filled.push({ gx, gy, sym });
  });

  // Per-mesh slot counts: each filled cell consumes 1 or 2 slots
  // depending on its symbol's recipe.
  const slotCounts = {};
  for (const k of MESH_KEYS) slotCounts[k] = 0;
  for (const c of filled) {
    const recipe = SYMBOL_RECIPE[c.sym];
    if (!recipe) continue;
    for (const k of recipe) slotCounts[k]++;
  }

  // Build the InstancedMeshes sized to fit.
  _buildInstancedMeshes(slotCounts);

  // Spawn one particle per filled cell. Each particle remembers which
  // mesh slots it owns so we can write its matrix to all of them per
  // frame.
  const slotCursors = {};
  for (const k of MESH_KEYS) slotCursors[k] = 0;

  _particles.length = 0;
  for (const c of filled) {
    const recipe = SYMBOL_RECIPE[c.sym];
    if (!recipe) continue;

    // Origin: a random point inside a randomly-picked wall AABB.
    const wall = walls[Math.floor(Math.random() * walls.length)];
    const ox = wall.x + (Math.random() - 0.5) * wall.w;
    const oy = 0.4 + Math.random() * 1.2;
    const oz = wall.z + (Math.random() - 0.5) * wall.h;

    // Target — autoglyph cell mapped onto the maze patch.
    const tx = x0 + ((c.gx + 0.5) / GLYPH_GRID_DIM) * patchW;
    const tz = z0 + ((c.gy + 0.5) / GLYPH_GRID_DIM) * patchH;

    // Outward explode velocity.
    const dirX = ox - wall.x;
    const dirZ = oz - wall.z;
    const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
    const speed = 4 + Math.random() * 6;

    // Reserve the slot indices this particle will write to.
    const slots = [];
    for (const meshKey of recipe) {
      slots.push({ meshKey, idx: slotCursors[meshKey]++ });
    }

    _particles.push({
      sym: c.sym,
      slots,
      ox, oy, oz,
      tx, ty: GLYPH_FLOOR_Y, tz,
      px: ox, py: oy, pz: oz,
      vx: (dirX / dirLen) * speed + (Math.random() - 0.5) * 2,
      vy: 2 + Math.random() * 4,
      vz: (dirZ / dirLen) * speed + (Math.random() - 0.5) * 2,
      delay: Math.random() * 0.3,
      pulsePhase: Math.random() * Math.PI * 2,
      _flyOrigCaptured: false,
      _fox: 0, _foy: 0, _foz: 0,
    });
  }

  _ensureBanner();
  _phaseT = 0;
  _active = true;
}

export function tickDissolve(dt) {
  if (!_active) return false;
  _phaseT += dt;

  for (let i = 0; i < _particles.length; i++) {
    _stepParticle(_particles[i], _phaseT, dt);
  }
  _writeInstanceMatrices();

  _updateBanner(_phaseT);

  // Material breathing during the display phase, fade during sink.
  if (_instanceMaterial) {
    if (_phaseT > PHASE_FLY_END && _phaseT < PHASE_DISPLAY_END) {
      const t = (_phaseT - PHASE_FLY_END) / (PHASE_DISPLAY_END - PHASE_FLY_END);
      const pulse = Math.sin(t * Math.PI);
      _instanceMaterial.emissiveIntensity = 0.30 + pulse * 0.55;
      _instanceMaterial.opacity = 1;
    } else if (_phaseT >= PHASE_DISPLAY_END) {
      const t = Math.min(1, (_phaseT - PHASE_DISPLAY_END) /
                        (PHASE_SINK_END - PHASE_DISPLAY_END));
      _instanceMaterial.emissiveIntensity = 0.30 * (1 - t);
      _instanceMaterial.opacity = 1 - t;
    } else {
      _instanceMaterial.emissiveIntensity = 0.20;
      _instanceMaterial.opacity = 1;
    }
  }

  if (_phaseT >= PHASE_SINK_END) {
    cancelDissolve();
    return false;
  }
  return true;
}

export function cancelDissolve() {
  if (_instancedMeshes) {
    for (const k of MESH_KEYS) {
      const mesh = _instancedMeshes[k];
      if (!mesh) continue;
      if (mesh.parent) mesh.parent.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
    }
  }
  if (_instanceMaterial) _instanceMaterial.dispose();
  _instancedMeshes = null;
  _instanceMaterial = null;
  _particles.length = 0;
  _phaseT = 0;
  _active = false;
  _disposeBanner();
}

export function isDissolveActive() {
  return _active;
}

// =====================================================================
// PARTICLE STEP — same phase model as before, just symbol-aware.
// =====================================================================

function _stepParticle(p, phaseT, dt) {
  const effT = phaseT - p.delay;

  if (effT < 0) {
    p.px = p.ox; p.py = p.oy; p.pz = p.oz;
    return;
  }

  if (effT < PHASE_EXPLODE_END) {
    p.vy -= 9.8 * dt;
    const drag = Math.pow(0.92, dt * 60);
    p.vx *= drag; p.vy *= drag; p.vz *= drag;
    p.px += p.vx * dt;
    p.py += p.vy * dt;
    p.pz += p.vz * dt;
    if (p.py < GLYPH_FLOOR_Y) p.py = GLYPH_FLOOR_Y;
  } else if (effT < PHASE_FLY_END) {
    if (!p._flyOrigCaptured) {
      p._fox = p.px; p._foy = p.py; p._foz = p.pz;
      p._flyOrigCaptured = true;
    }
    const t01 = (effT - PHASE_EXPLODE_END) /
                (PHASE_FLY_END - PHASE_EXPLODE_END);
    const e = t01 * t01 * (3 - 2 * t01);
    p.px = p._fox + (p.tx - p._fox) * e;
    const arcY = p._foy + (p.ty - p._foy) * e + Math.sin(t01 * Math.PI) * 1.5;
    p.py = arcY;
    p.pz = p._foz + (p.tz - p._foz) * e;
  } else if (effT < PHASE_DISPLAY_END) {
    p.px = p.tx;
    p.pz = p.tz;
    const wobble = Math.sin(phaseT * 3 + p.pulsePhase) * 0.012;
    p.py = GLYPH_FLOOR_Y + wobble;
  } else {
    const t01 = Math.min(1, (effT - PHASE_DISPLAY_END) /
                         (PHASE_SINK_END - PHASE_DISPLAY_END));
    p.px = p.tx;
    p.pz = p.tz;
    p.py = GLYPH_FLOOR_Y - t01 * 1.0;
  }
}

// =====================================================================
// INSTANCED MESHES — one per base geometry, sized per slot count.
// =====================================================================

function _buildInstancedMeshes(slotCounts) {
  const geos = _buildSymbolGeometries();

  _instanceMaterial = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0x223355,
    emissiveIntensity: 0.20,
    roughness: 0.85,
    metalness: 0.10,
    transparent: true,
    opacity: 1.0,
  });

  _instancedMeshes = {};
  for (const k of MESH_KEYS) {
    const count = slotCounts[k] || 0;
    if (count === 0) {
      // Still dispose the unused geometry — it was built but won't be
      // rendered. Saves a tiny bit of GPU memory.
      geos[k].dispose();
      continue;
    }
    const mesh = new THREE.InstancedMesh(geos[k], _instanceMaterial, count);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    // Hide all instances initially (zero scale) — they'll be written
    // to real positions on the first tick. This avoids a single-frame
    // flash where every instance sits at the origin.
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, zero);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    _instancedMeshes[k] = mesh;
  }
}

function _writeInstanceMatrices() {
  if (!_instancedMeshes) return;
  for (let i = 0; i < _particles.length; i++) {
    const p = _particles[i];
    _scratchPos.set(p.px, p.py, p.pz);
    _scratchQuat.set(0, 0, 0, 1);
    _scratchMatrix.compose(_scratchPos, _scratchQuat, _scratchScale);
    for (const slot of p.slots) {
      const mesh = _instancedMeshes[slot.meshKey];
      if (mesh) mesh.setMatrixAt(slot.idx, _scratchMatrix);
    }
  }
  for (const k of MESH_KEYS) {
    const mesh = _instancedMeshes[k];
    if (mesh) mesh.instanceMatrix.needsUpdate = true;
  }
}

// =====================================================================
// "ACCESS GRANTED" BANNER
// =====================================================================

function _ensureBanner() {
  _disposeBanner();
  const root = document.createElement('div');
  root.id = 'endless-access-banner';
  root.style.cssText = [
    'position:fixed',
    'top:42%', 'left:50%',
    'transform:translate(-50%, -50%)',
    'padding:18px 36px',
    'background:rgba(0,0,0,0.78)',
    'border:2px solid #4ff7ff',
    'border-radius:10px',
    'box-shadow:0 0 28px rgba(79,247,255,0.55), inset 0 0 18px rgba(79,247,255,0.25)',
    'color:#4ff7ff',
    'font-family:"Courier New",monospace',
    'font-size:34px',
    'font-weight:bold',
    'letter-spacing:6px',
    'text-shadow:0 0 12px rgba(79,247,255,0.85)',
    'z-index:99997',
    'opacity:0',
    'pointer-events:none',
    'text-align:center',
  ].join(';');
  root.textContent = 'ACCESS GRANTED';
  document.body.appendChild(root);
  _bannerEl = root;
}

function _updateBanner(t) {
  if (!_bannerEl) return;
  let opacity = 0;
  if (t >= BANNER_FADE_IN_START && t < BANNER_FADE_IN_END) {
    const u = (t - BANNER_FADE_IN_START) / (BANNER_FADE_IN_END - BANNER_FADE_IN_START);
    opacity = u * u * (3 - 2 * u);
  } else if (t >= BANNER_FADE_IN_END && t < BANNER_FADE_OUT_START) {
    opacity = 1;
  } else if (t >= BANNER_FADE_OUT_START && t < BANNER_FADE_OUT_END) {
    const u = (t - BANNER_FADE_OUT_START) / (BANNER_FADE_OUT_END - BANNER_FADE_OUT_START);
    opacity = 1 - u * u * (3 - 2 * u);
  } else if (t >= BANNER_FADE_OUT_END) {
    opacity = 0;
  }
  _bannerEl.style.opacity = String(opacity);
}

function _disposeBanner() {
  if (_bannerEl && _bannerEl.parentNode) {
    _bannerEl.parentNode.removeChild(_bannerEl);
  }
  _bannerEl = null;
}
