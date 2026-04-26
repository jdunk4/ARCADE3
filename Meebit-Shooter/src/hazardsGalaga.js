// Galaga hazard style — chapter 2 visuals.
//
// Red "bugs" fly in from the sky along a swooping curve, hover over a
// target floor tile for ~0.8s (warning telegraph — same duration as
// Tetris), descend and "tag" the tile, then fly back up and despawn.
// The tagged tile becomes a hazard (identical damage behavior to the
// Tetris tiles).
//
// Design contract (matches hazards.js style interface):
//   - getCellSize()            — grid quantization (2.5u, matches Tetris)
//   - cleanup()                — wipe all in-flight bugs
//   - tickDeliveries(dt)       — advance bug state machines, report any
//                                that finished tagging (hazards.js then
//                                places the damage tile)
//   - tickSpawning(dt, ctx)    — maintain the bug pool: if fewer than
//                                GALAGA_TARGET_COUNT bugs are active,
//                                spawn more after a short respawn delay
//   - managesOwnSpawns = true  — tells hazards.js to skip its own drop
//                                loop since we drive spawn cadence here
//
// Bug state machine (per-bug):
//   SPAWNING   (instant)  — bug appears off-arena edge at y=12
//   SWOOPING   (~1.5s)    — Bezier curve to hover point at y=8
//   HOVERING   (0.8s)     — bob in place over target tile (telegraph)
//   DESCENDING (0.4s)     — drop from y=8 to y=0.5 (touches floor)
//   LANDED     (1.0s)     — sit on tile, bobbing — shootable target
//   ASCENDING  (~1.2s)    — fly straight up and offscreen, despawn
//
// A bug that reaches the ASCENDING phase has already placed its tile
// (reported via tickDeliveries). Tile commitment now happens at the
// DESCENDING → LANDED transition (not LANDED → ASCENDING) so even
// bugs killed during the dwell phase still leave their hazard tile.
// Bugs can be killed at any earlier phase by the Galaga ship's
// bullets (stage 3) — when killed BEFORE LANDED, the tile is NOT
// placed and the bug dies in a burst.
//
// Bug HP system (stage 3): each bug spawns with BUG_MAX_HP=3. Each
// hit reduces HP by 1 and shifts body color toward "damaged":
//   HP 3 (full)   = chapter tint (red for chapter 2)
//   HP 2 (1 hit)  = orange
//   HP 1 (2 hits) = yellow
//   HP 0          = burst, despawn, no tile placed

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA } from './config.js';
import { hitBurst } from './effects.js';
import { Audio } from './audio.js';

const CELL_SIZE = 2.5;

// Tuning knobs.
const GALAGA_TARGET_COUNT = 5;         // keep this many bugs active (stage 3: bumped from 3 to 5)
const RESPAWN_DELAY = 0.6;             // seconds between completions and new spawns
const SWOOP_DURATION = 1.5;
const HOVER_DURATION = 0.8;
const DESCEND_DURATION = 0.4;
const LANDED_DURATION = 1.0;     // bug sits on tile after touchdown, shootable
const ASCEND_DURATION = 1.2;
const HOVER_ALTITUDE = 8.0;            // bug altitude while hovering over target
const SPAWN_ALTITUDE = 12.0;            // y at which bug enters arena
const TOUCH_ALTITUDE = 0.5;            // y at which bug "taps" the floor
const SATURATION_FAIL_LIMIT = 8;       // after N consecutive spawn failures, advance ring

// Bug geometry — an octahedron body + two wing planes. Geometry allocated
// once; each bug instantiates meshes using the shared geo/mat.
const BUG_BODY_GEO = new THREE.OctahedronGeometry(0.35);
const BUG_WING_GEO = new THREE.PlaneGeometry(0.7, 0.3);
const BUG_EYE_GEO = new THREE.SphereGeometry(0.08, 6, 6);
const _eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

// Material cache (one per chapter tint).
const _bugBodyCache = new Map();
const _bugWingCache = new Map();
function getBugBodyMat(tint) {
  let m = _bugBodyCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      // Bumped from 0.9 → 1.8: bugs were appearing too dark against the
      // black/purple arena, especially during their swooping arc when
      // they're at altitude with no ground bounce light.
      emissiveIntensity: 1.8,
      metalness: 0.2,
      roughness: 0.4,
    });
    _bugBodyCache.set(tint, m);
  }
  return m;
}
function getBugWingMat(tint) {
  let m = _bugWingCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      // Bumped from 0.8 → 1.5 alongside the body bump.
      emissiveIntensity: 1.5,
      metalness: 0.1,
      roughness: 0.6,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    _bugWingCache.set(tint, m);
  }
  return m;
}

// Module state.
const _bugs = [];           // active bugs
let _respawnTimer = 0;      // seconds until next spawn attempt
let _spawnFailCount = 0;    // consecutive failed validator calls

// Public: tells hazards.js we handle our own spawn pacing.
export const managesOwnSpawns = true;

/** Cell size in world units — hazards.js uses for ring math. */
export function getCellSize() {
  return CELL_SIZE;
}

// Bug sprite — pixel-art rendering matching the classic Galaga bug
// enemy. Drawn to a small canvas with NEAREST filtering for crisp
// blocky pixels. The bug shape: compact body with antennae, wings,
// and small leg details. Multi-colored using the chapter's tint
// hex along with secondary accent colors.
//
// Approach: 24x24 logical pixel grid scaled 4x to a 96x96 canvas.
// Cached per tint so all bugs of the same chapter share their texture.

const BUG_SPRITE_SIZE = 1.5;       // world units — ~half a cell
const BUG_PX = 24;                  // logical pixel grid
const BUG_SCALE = 4;                // canvas px per logical px

const _bugTextureCache = new Map();
function _getBugTexture(tint) {
  const cacheKey = String(tint);
  if (_bugTextureCache.has(cacheKey)) return _bugTextureCache.get(cacheKey);

  const canvas = document.createElement('canvas');
  canvas.width = BUG_PX * BUG_SCALE;
  canvas.height = BUG_PX * BUG_SCALE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  function px(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * BUG_SCALE, y * BUG_SCALE, BUG_SCALE, BUG_SCALE);
  }
  function rect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * BUG_SCALE, y * BUG_SCALE, w * BUG_SCALE, h * BUG_SCALE);
  }

  // Convert hex tint to a CSS color string for the main body fill.
  const tintHex = '#' + (tint).toString(16).padStart(6, '0');
  // Compute a darker accent (50%) and a lighter highlight (130%) from the tint.
  const r = (tint >> 16) & 0xff;
  const g = (tint >> 8) & 0xff;
  const b = tint & 0xff;
  const dark = '#' + [Math.floor(r * 0.55), Math.floor(g * 0.55), Math.floor(b * 0.55)]
    .map(v => v.toString(16).padStart(2, '0')).join('');
  const light = '#' + [Math.min(255, Math.floor(r * 1.3)), Math.min(255, Math.floor(g * 1.3)), Math.min(255, Math.floor(b * 1.3))]
    .map(v => v.toString(16).padStart(2, '0')).join('');
  const eye = '#ffffff';
  const pupil = '#000000';
  const accent = '#ffd6a0';     // warm highlight color (cream/yellow)
  const K = '#000000';          // black outline

  // Antennae — two horns at top (pixels 6-7 and 16-17, rows 0-2)
  px(7, 1, K); px(8, 1, K);
  px(7, 2, K); px(8, 2, K);
  px(15, 1, K); px(16, 1, K);
  px(15, 2, K); px(16, 2, K);
  // Antenna tips
  px(6, 0, tintHex); px(7, 0, tintHex);
  px(16, 0, tintHex); px(17, 0, tintHex);

  // Head — top row of body, smaller width
  rect(8, 3, 8, 3, tintHex);
  // Head outline
  for (let x = 8; x <= 15; x++) px(x, 2, K);
  px(7, 3, K); px(7, 4, K); px(7, 5, K);
  px(16, 3, K); px(16, 4, K); px(16, 5, K);
  // Eyes — large white squares with black pupils
  rect(9, 4, 2, 2, eye);
  rect(13, 4, 2, 2, eye);
  px(10, 5, pupil);
  px(13, 5, pupil);

  // Body — main mass (bigger torso, accent stripe down middle)
  rect(7, 6, 10, 5, tintHex);
  // Body outline
  for (let x = 7; x <= 16; x++) px(x, 5, K);
  px(6, 6, K); px(6, 7, K); px(6, 8, K); px(6, 9, K); px(6, 10, K);
  px(17, 6, K); px(17, 7, K); px(17, 8, K); px(17, 9, K); px(17, 10, K);
  // Accent stripe / chest plate down middle
  rect(11, 7, 2, 3, accent);
  // Center pattern detail
  px(11, 7, dark); px(12, 7, dark);
  px(11, 9, dark); px(12, 9, dark);

  // Wings — extended sideways from upper body, lighter color
  rect(2, 7, 5, 3, light);
  rect(17, 7, 5, 3, light);
  // Wing outlines
  for (let x = 2; x <= 6; x++) px(x, 6, K);
  for (let x = 2; x <= 6; x++) px(x, 10, K);
  for (let x = 17; x <= 21; x++) px(x, 6, K);
  for (let x = 17; x <= 21; x++) px(x, 10, K);
  px(1, 7, K); px(1, 8, K); px(1, 9, K);
  px(22, 7, K); px(22, 8, K); px(22, 9, K);
  // Wing detail dots
  px(4, 8, tintHex);
  px(19, 8, tintHex);

  // Lower body — narrower, with leg-like protrusions
  rect(8, 11, 8, 2, dark);
  for (let x = 8; x <= 15; x++) px(x, 13, K);
  px(7, 11, K); px(16, 11, K);
  px(7, 12, K); px(16, 12, K);

  // Legs — three pairs of short pixel legs at bottom
  px(8, 13, dark); px(8, 14, dark);
  px(11, 13, dark); px(11, 14, dark);
  px(14, 13, dark); px(14, 14, dark);
  // Leg outlines
  px(8, 15, K); px(11, 15, K); px(14, 15, K);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  _bugTextureCache.set(cacheKey, tex);
  return tex;
}

const _bugPlaneGeo = new THREE.PlaneGeometry(BUG_SPRITE_SIZE, BUG_SPRITE_SIZE);

/**
 * Build a bug visual group. Returns { group, wings, eye, bodyMat }
 * where:
 *   group   — Three.js group with the sprite mesh inside
 *   wings   — array of placeholder objects so the wing-flap animation
 *             code in updateBugs() doesn't need to change. The flap
 *             is now baked into the static sprite art instead.
 *   eye     — placeholder reference (not used since pixel art has eyes)
 *   bodyMat — THE MATERIAL on the sprite plane, used for damage color
 *             shifts via material.color tinting (white = full color,
 *             red = full red tint, etc.)
 */
function _buildBugMesh(tint) {
  const group = new THREE.Group();
  // Get a per-tint cached texture but clone the material so each bug
  // can independently tint its color on damage.
  const tex = _getBugTexture(tint);
  const bodyMat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    color: 0xffffff,        // white = no tint, multiplies the texture as-is
  });
  const sprite = new THREE.Mesh(_bugPlaneGeo, bodyMat);
  // Lay the sprite flat (face up) so the top-down camera sees it.
  sprite.rotation.x = -Math.PI / 2;
  group.add(sprite);

  // Stub wings — empty groups that satisfy the b.wings[0].rotation.z
  // assignments in updateBugs() without doing anything visible. Wing
  // flap animation is baked into the static sprite art instead.
  const wingL = new THREE.Group();
  const wingR = new THREE.Group();
  group.add(wingL);
  group.add(wingR);
  // Stub eye reference — not visible (pixel art has eyes drawn in).
  const eye = new THREE.Group();
  group.add(eye);
  return { group, wings: [wingL, wingR], eye, bodyMat };
}

/**
 * Pick a target tile cell inside the active ring. Returns
 * { cells, originX, originZ } if a valid spot is found, else null.
 *
 * For Galaga, each bug places a SINGLE CELL (not a tetromino). This
 * is a deliberate choice: simpler visuals, and the outside-in fill
 * naturally happens as bugs pick spots within the current ring band.
 */
function _chooseTargetCell(ctx) {
  const ringInner = ctx.ringInner;
  const ringOuter = ctx.ringOuter;
  // Bias toward the player's current quadrant so action stays onscreen
  // — but not 100% so the arena still fills evenly over time. With a
  // player position, 70% of spawns target the same quadrant the player
  // is in. The other 30% pick freely so the opposite side eventually
  // gets covered too.
  const px = ctx.playerPos ? ctx.playerPos.x : 0;
  const pz = ctx.playerPos ? ctx.playerPos.z : 0;
  const biasNearPlayer = Math.random() < 0.70;
  const cheb = ringInner + Math.random() * (ringOuter - ringInner);
  let edge;
  if (biasNearPlayer && (Math.abs(px) > 1 || Math.abs(pz) > 1)) {
    // Pick the edge that's on the player's side of the arena. The four
    // edges are: 0=+Z (north top), 1=-Z (south bottom), 2=+X (east right),
    // 3=-X (west left). The player's "side" is whichever component has
    // the larger absolute value.
    if (Math.abs(pz) >= Math.abs(px)) {
      edge = pz > 0 ? 0 : 1;
    } else {
      edge = px > 0 ? 2 : 3;
    }
  } else {
    edge = Math.floor(Math.random() * 4);
  }
  // For the chosen edge, pick a position along it. Bias the "along"
  // axis toward the player's coordinate on that axis so the bug
  // appears in the player's general view, not at the far end of the
  // edge.
  let along;
  if (biasNearPlayer && ctx.playerPos) {
    const playerAlong = (edge === 0 || edge === 1) ? px : pz;
    // Spread of ±10u around the player's along-axis position, clamped
    // to the cheb bounds.
    along = Math.max(-cheb, Math.min(cheb, playerAlong + (Math.random() - 0.5) * 20));
  } else {
    along = (Math.random() * 2 - 1) * cheb;
  }
  let rawX, rawZ;
  if (edge === 0) { rawX = along;  rawZ = cheb; }
  else if (edge === 1) { rawX = along;  rawZ = -cheb; }
  else if (edge === 2) { rawX = cheb;   rawZ = along; }
  else { rawX = -cheb;  rawZ = along; }
  // Snap to grid.
  const x = Math.round(rawX / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
  const z = Math.round(rawZ / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
  const cells = [{ x, z }];
  if (!ctx.validate(cells, x, z)) return null;
  return { cells, originX: x, originZ: z };
}

/**
 * Pick a spawn point on the arena edge — a random side, at altitude.
 * This is where the bug appears before its swoop.
 */
function _pickSpawnPoint() {
  const side = Math.floor(Math.random() * 4);
  const along = (Math.random() * 2 - 1) * ARENA * 0.8;
  const edge = ARENA + 4;  // just outside the arena
  let x, z;
  if (side === 0) { x = along;  z = edge; }
  else if (side === 1) { x = along;  z = -edge; }
  else if (side === 2) { x = edge;   z = along; }
  else { x = -edge;  z = along; }
  return { x, y: SPAWN_ALTITUDE, z };
}

// HP color states — applied to bug bodyMat as bug takes damage. The
// "full" color is the chapter tint passed in at spawn; subsequent
// states are damage indicators. Order: full → 1 hit → 2 hits → die.
const BUG_DAMAGE_COLORS = [
  null,        // full HP — keep chapter tint
  0xff8833,    // 1 hit  — orange
  0xffcc33,    // 2 hits — yellow
];
const BUG_MAX_HP = 3;

/**
 * Spawn a new bug targeting the given cell.
 */
function _spawnBug(target, tint) {
  const { group, wings, eye, bodyMat } = _buildBugMesh(tint);
  const spawn = _pickSpawnPoint();
  group.position.set(spawn.x, spawn.y, spawn.z);
  scene.add(group);

  // Bezier control point for the swoop curve — sits "above and halfway"
  // between spawn and hover point, giving a graceful arc descent.
  const hoverX = target.originX;
  const hoverZ = target.originZ;
  const ctrlX = (spawn.x + hoverX) * 0.5 + (Math.random() - 0.5) * 4;
  const ctrlZ = (spawn.z + hoverZ) * 0.5 + (Math.random() - 0.5) * 4;
  const ctrlY = SPAWN_ALTITUDE + 2;  // slight arc up before descending

  _bugs.push({
    group,
    wings,
    eye,
    bodyMat,            // ref so _takeHit can swap the bug's color
    tint,
    hp: BUG_MAX_HP,     // damage system: 3 hits and the bug bursts
    phase: 'SWOOPING',
    t: 0,
    // Trajectory data:
    spawnX: spawn.x, spawnY: spawn.y, spawnZ: spawn.z,
    ctrlX, ctrlY, ctrlZ,
    hoverX, hoverZ,
    target,
    // Hover bob phase — random offset so bugs don't bob in sync.
    bobPhase: Math.random() * Math.PI * 2,
  });
  // Bug spawn whir — quiet but adds presence.
  try { Audio.bugWhir && Audio.bugWhir(); } catch (e) {}
}

/**
 * Public: hazards.js calls this every frame. For Galaga, we use the
 * context to validate spawns and drive our own bug pool.
 */
export function tickSpawning(dt, ctx) {
  // Clean up any bugs that finished ascending (they despawn in tickDeliveries
  // but we do a safety sweep here too in case they escaped).
  // Maintain the target bug count: if under, respawn after a cooldown.
  if (_bugs.length < GALAGA_TARGET_COUNT) {
    _respawnTimer -= dt;
    if (_respawnTimer <= 0) {
      // Try to find a valid target cell. If validator rejects, count
      // failures so we can tell hazards.js the ring is saturated.
      const target = _chooseTargetCell(ctx);
      if (target) {
        _spawnBug(target, ctx.tint);
        _respawnTimer = RESPAWN_DELAY;
        _spawnFailCount = 0;
      } else {
        _spawnFailCount++;
        if (_spawnFailCount >= SATURATION_FAIL_LIMIT) {
          ctx.onRingSaturated && ctx.onRingSaturated();
          _spawnFailCount = 0;
        }
        // Re-try soon — short delay, not full respawn delay.
        _respawnTimer = 0.15;
      }
    }
  }
}

/**
 * Public: advance bug state machines. Returns array of completed
 * deliveries for hazards.js to convert into damage tiles.
 */
export function tickDeliveries(dt) {
  const completed = [];
  for (let i = _bugs.length - 1; i >= 0; i--) {
    const b = _bugs[i];
    b.t += dt;

    // Wing flap — ~20 Hz flapping, visible across all phases.
    const flap = Math.sin(b.t * 30) * 0.4;
    b.wings[0].rotation.z = 0.3 + flap;
    b.wings[1].rotation.z = -0.3 - flap;

    if (b.phase === 'SWOOPING') {
      // Quadratic Bezier from spawn → ctrl → hover point.
      const p = Math.min(1, b.t / SWOOP_DURATION);
      const ep = 1 - p;
      const x = ep * ep * b.spawnX + 2 * ep * p * b.ctrlX + p * p * b.hoverX;
      const y = ep * ep * b.spawnY + 2 * ep * p * b.ctrlY + p * p * HOVER_ALTITUDE;
      const z = ep * ep * b.spawnZ + 2 * ep * p * b.ctrlZ + p * p * b.hoverZ;
      b.group.position.set(x, y, z);
      // Face the direction of motion (approximate — use derivative).
      const dx = b.hoverX - x, dz = b.hoverZ - z;
      if (dx * dx + dz * dz > 0.01) b.group.rotation.y = Math.atan2(dx, dz);
      if (p >= 1) {
        b.phase = 'HOVERING';
        b.t = 0;
      }
    } else if (b.phase === 'HOVERING') {
      // Bob up and down gently; pulse wings slightly (already flapping).
      const bob = Math.sin(b.t * 8 + b.bobPhase) * 0.25;
      b.group.position.set(b.hoverX, HOVER_ALTITUDE + bob, b.hoverZ);
      if (b.t >= HOVER_DURATION) {
        b.phase = 'DESCENDING';
        b.t = 0;
      }
    } else if (b.phase === 'DESCENDING') {
      const p = Math.min(1, b.t / DESCEND_DURATION);
      const eased = p * p;  // ease-in (gravity-like)
      const y = HOVER_ALTITUDE * (1 - eased) + TOUCH_ALTITUDE * eased;
      b.group.position.set(b.hoverX, y, b.hoverZ);
      if (p >= 1) {
        // TOUCH — report tile placement, then LAND for 1s. Tile is
        // committed here so even if the bug gets shot during the
        // dwell phase, the floor hazard stays. The dwell gives the
        // player a fair window to shoot the bug at point-blank
        // range — without it, bugs blip in and out too fast to be
        // a meaningful target.
        completed.push({
          cells: b.target.cells,
          tintHex: b.tint,
        });
        try { hitBurst({ x: b.hoverX, y: 0.3, z: b.hoverZ }, b.tint, 6); } catch (e) {}
        b.phase = 'LANDED';
        b.t = 0;
      }
    } else if (b.phase === 'LANDED') {
      // 1-second dwell at floor level. Bug bobs gently in place and
      // is shootable. After the dwell, transitions to ASCENDING.
      const bob = Math.sin(b.t * 8 + b.bobPhase) * 0.08;
      b.group.position.set(b.hoverX, TOUCH_ALTITUDE + bob, b.hoverZ);
      if (b.t >= LANDED_DURATION) {
        b.phase = 'ASCENDING';
        b.t = 0;
      }
    } else if (b.phase === 'ASCENDING') {
      // Fly straight up and accelerate. Despawn when high enough.
      const p = Math.min(1, b.t / ASCEND_DURATION);
      const eased = p * p;
      const y = TOUCH_ALTITUDE + (SPAWN_ALTITUDE + 4 - TOUCH_ALTITUDE) * eased;
      b.group.position.set(b.hoverX, y, b.hoverZ);
      if (p >= 1) {
        if (b.group.parent) scene.remove(b.group);
        _bugs.splice(i, 1);
      }
    }
  }
  return completed;
}

/** Wipe all in-flight bugs. Called on chapter change / reset. */
export function cleanup() {
  for (const b of _bugs) {
    if (b.group.parent) scene.remove(b.group);
  }
  _bugs.length = 0;
  _respawnTimer = 0;
  _spawnFailCount = 0;
}

/**
 * Stub — Galaga's spawn logic is driven by tickSpawning, not by this.
 * Present for style interface compatibility.
 */
export function chooseSpawnLocation(ringInner, ringOuter, validate) {
  return null;
}

/** Stub — spawn is handled in tickSpawning, not spawnDelivery. */
export function spawnDelivery(spot, tintHex) {
  // no-op
}

/** Diagnostic — active bug count. */
export function getInFlightCount() {
  return _bugs.length;
}

/** Expose bugs list for stage 3/4 (bullet collision). Read-only view
 *  for callers that want to iterate. */
export function getBugs() {
  return _bugs;
}

/**
 * Apply damage to a bug. Called by the Galaga ship's bullet collision.
 * Returns true if the bug was killed by this hit, false otherwise.
 *
 * On hit: HP decrements, body color shifts toward "damaged" (orange
 * at 1 hit, yellow at 2 hits). On kill: bug bursts with particles
 * and is removed from the active pool — does NOT place a hazard tile.
 *
 * Bullets pass through bugs in the ASCENDING phase since those have
 * already placed their tile and are about to despawn anyway.
 */
export function applyBugDamage(bug, amount) {
  if (!bug || bug.hp <= 0) return false;
  if (bug.phase === 'ASCENDING') return false;  // already done its damage
  bug.hp -= amount;
  if (bug.hp <= 0) {
    // KILL — burst, despawn, no tile placed
    try {
      hitBurst(bug.group.position, bug.tint, 12);
      Audio.bugDeath && Audio.bugDeath();
    } catch (e) {}
    if (bug.group.parent) scene.remove(bug.group);
    const idx = _bugs.indexOf(bug);
    if (idx >= 0) _bugs.splice(idx, 1);
    return true;
  }
  // Damage flicker + color shift. With the new pixel-art sprite, the
  // material is MeshBasicMaterial (no emissive property). The .color
  // serves as a multiplier on the texture — setting it to a damage
  // hex tints the entire bug toward that color, simulating "wounded"
  // visual without the old emissive change.
  try { Audio.bugHit && Audio.bugHit(); } catch (e) {}
  const colorIdx = BUG_MAX_HP - bug.hp;  // 1 hit → idx 1, 2 hits → idx 2
  const damageColor = BUG_DAMAGE_COLORS[colorIdx];
  if (damageColor != null && bug.bodyMat) {
    bug.bodyMat.color.setHex(damageColor);
  }
  // Brief flash burst on impact
  try { hitBurst(bug.group.position, 0xffffff, 4); } catch (e) {}
  return false;
}

/**
 * Get the center world-space position of a bug. Used by the Galaga
 * ship for targeting. Wraps the underlying group.position so callers
 * don't have to know the bug data structure.
 */
export function getBugPos(bug) {
  return bug && bug.group ? bug.group.position : null;
}
