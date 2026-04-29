// ============================================================================
// src/dormantProps.js — chapter-scoped persistent prop scaffolding.
//
// Problem: the old wave system rebuilt the depot, the hives, and (in the
// new design) the turrets + radio tower + EMP silo on demand at the start
// of whichever wave used them. The new design requires ALL of these
// elements to be VISIBLE (but inert) from the start of the chapter, and
// to progressively "activate" on their designated wave. This gives the
// arena a persistent, worked-on feel — at chapter start you can already
// see the depot you'll mine ore toward (wave 1), the derelict turret
// platforms you'll power up (wave 2), the shielded hives you'll later
// destroy (wave 3), and the herd staging pens (wave 4) — and each wave
// simply flips a few state bits to bring the relevant props to life.
//
// This module doesn't OWN the props (they live in their original modules:
// ores.js for the depot, spawners.js for the hives, a new turrets.js in
// stage 2, etc.) — it's a coordination layer that decides WHEN to hand
// control to each owner.
//
// Lifecycle:
//   onChapterStart(chapterIdx) — called the FIRST TIME a wave in a new
//     chapter begins (localWave === 1). Spawns every dormant prop for
//     the chapter in its "inactive" visual state.
//   onChapterEnd()              — called when the chapter finishes (boss
//     dies, wave 5 complete). Tears down every prop so the next chapter
//     can rebuild from a clean slate. Also called on resetWaves().
//   isChapterPrepared()         — true if onChapterStart has run for the
//     current chapter and the teardown hasn't happened yet. waves.js uses
//     this to decide whether to call onChapterStart on wave 1 entry.
//
// Stage 1 scope: depot + hive shields. Turrets, radio tower, EMP silo,
// and herd pens come in stage 2 / 3.
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS, HIVE_CONFIG, ARENA } from './config.js';
import { spawnDepot, clearDepot } from './ores.js';
import * as OresModule from './ores.js';
import { spawnCrusher, clearCrusher } from './crusher.js';
import { spawnAllPortals, clearAllPortals, spawners } from './spawners.js';
import { spawnAllTurrets, clearAllTurrets } from './turrets.js';
import { spawnPowerupZones, clearPowerupZones } from './powerupZones.js';
import { buildCentralCompound, clearCentralCompound, hideCentralCompound } from './waveProps.js';
import { shuffleTriangleAssignment } from './triangles.js';
import { buildWires, clearWires } from './empWires.js';
import { hitBurst } from './effects.js';
import { spawnCannon, clearCannon, aimCannonAt } from './cannon.js';
import { spawnQueenHive, clearQueenHive, getQueen } from './queenHive.js';
import { spawnServerWarehouse, clearServerWarehouse } from './serverWarehouse.js';
import { clearCockroachBoss } from './cockroachBoss.js';
import { clearHiveLasers } from './hiveLasers.js';
import { setCh2WarehouseSwap } from './waveProps.js';
import { resetGalagaTargetCount, setGalagaOverdrive } from './hazardsGalaga.js';
import { setTetrisOverdrive } from './hazardsTetris.js';
import { resetMinesweeperTargetCount, setMinesweeperOverdrive } from './hazardsMinesweeper.js';
import { setHazardRushMode } from './hazards.js';
import { clearFactionPaint } from './factionPaint.js';
import { clearAllPuddles } from './bossPuddles.js';
import { clearFreeze } from './bossFreeze.js';
import { clearAllFlares } from './bossSolarFlare.js';
import { getCompound } from './waveProps.js';

// Which chapter the current dormant-prop set belongs to. -1 means no set
// is live; when the current chapter changes, the owning props are torn
// down and rebuilt for the new chapter.
let _preparedChapter = -1;

// Shield meshes keyed by hive. Shared geometry; per-hive material so the
// alpha pulse can be independent.
const _hiveShields = new Map();
// Shield sphere wraps the whole hive — from base (y=0) to well above
// the portal ring (y=2). Radius 3.8 covers the 2.2 base + 1.6 torus and
// leaves clear headroom, so shots from any angle collide with the shield
// well before reaching the hive body.
const _SHIELD_GEO = new THREE.SphereGeometry(3.8, 28, 18);

// Impact pulse infrastructure ----------------------------------------
//
// When a bullet/rocket/beam hits a shield, we spawn an expanding flat
// glow disc at the impact point on the sphere surface. The disc's
// plane is tangent to the sphere (its normal points outward from the
// sphere center), so it appears glued to the shield's curve. Over
// ~0.45s the disc scales from 0.4u → 1.6u radius and fades from 1.0 →
// 0.0 opacity, producing a sci-fi "force field absorbs hit" pulse.
//
// The disc's texture is a simple radial gradient — bright at the
// center, fading to transparent at the edges — so the pulse reads as
// a clean energy ripple. (Earlier iterations tried a hex burst pattern
// here; user feedback said the hex didn't read at all so we dropped
// it in favor of the cleaner glow.)
let _pulseGlowCache = null;
function _getPulseGlowTexture() {
  if (_pulseGlowCache) return _pulseGlowCache;
  const SIZE = 128;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  // Radial gradient: solid white core, fading to transparent at the
  // outer edge. The caller's tint .color multiplies this so the disc
  // comes out in the chapter color.
  const cx = SIZE / 2, cy = SIZE / 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE / 2);
  grad.addColorStop(0.00, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.45, 'rgba(255, 255, 255, 0.55)');
  grad.addColorStop(0.85, 'rgba(255, 255, 255, 0.10)');
  grad.addColorStop(1.00, 'rgba(255, 255, 255, 0.00)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  _pulseGlowCache = tex;
  return tex;
}
// Shared geometry for every pulse — PlaneGeometry of size 2 (centered
// at origin, -1..+1 in both axes). Standard quad UVs (0..1) match the
// glow texture's centered radial gradient. Pulses scale this plane up
// over their lifetime to grow the apparent ripple radius.
const _PULSE_RING_GEO = new THREE.PlaneGeometry(2.0, 2.0);
// Active pulses — array of { mesh, t, lifetime, maxRadius, mat }.
// Updated each frame; mesh removed and pushed to scene removal when
// t >= lifetime.
const _hexPulses = [];
const _PULSE_LIFETIME = 0.45;        // seconds for ring to expand + fade
const _PULSE_MAX_RADIUS = 1.6;       // world units (shield radius is 3.8)
const _PULSE_START_RADIUS = 0.4;

// Shield sphere radius + center Y — kept as module-level constants so
// bullet collision code in main.js can import and use them without
// inspecting mesh geometry directly. MUST stay in sync with the
// _SHIELD_GEO radius and the shield.position.y assignment in
// addShieldToHive (see ~40 lines below).
export const SHIELD_RADIUS = 3.8;
export const SHIELD_CENTER_Y = 1.9;

/**
 * Test whether a point (x, y, z) is INSIDE any intact hive shield. Called
 * from main.js's bullet update loop BEFORE the existing spawner-hit
 * check so bullets deflect off the larger shield sphere instead of
 * flying through it to the small inner hive collision.
 *
 * Returns the hive whose shield was hit (truthy), or null if no shield
 * contains the point. Skips hives where shielded=false or whose shield
 * is already dropping — those should let bullets through to damage
 * the hive beneath.
 *
 * Cheap per-call: squared-distance check per hive, no allocations.
 * At 4 hives per chapter × 60fps × ~40 bullets in flight = ~10k
 * checks/sec which is trivial.
 */
export function getShieldedHiveAt(x, y, z) {
  for (const [hive, shield] of _hiveShields) {
    if (!hive.shielded) continue;
    if (shield.userData._dropping) continue;
    // Shield sphere test. Note: hive.pos.y is 0 at the ground plane,
    // but the shield sits at y=1.9 (SHIELD_CENTER_Y). Offset the
    // y comparison accordingly.
    const dx = x - hive.pos.x;
    const dy = y - SHIELD_CENTER_Y;
    const dz = z - hive.pos.z;
    if (dx * dx + dy * dy + dz * dz < SHIELD_RADIUS * SHIELD_RADIUS) {
      return hive;
    }
  }
  return null;
}

/**
 * Yield [hive, shield] pairs for every intact shield, for iteration by
 * callers that need to run their own geometry tests (e.g. the raygun
 * beam, which checks hives inside its beam corridor rather than a
 * point-inside-sphere test). Returns the underlying Map so callers get
 * live state; don't mutate it. Callers should also filter out shields
 * whose _dropping flag is set since those are no longer active.
 */
export function hiveShieldsIter() {
  return _hiveShields;
}

/**
 * Play the visual shield-hit effect at a specific point on the shield
 * surface. Called by main.js bullet/rocket/beam hit handlers when they
 * detect an impact with a shielded hive. Produces:
 *
 *   - A brief opacity/scale pulse on the shield mesh (emitter absorbing
 *     the hit)
 *   - A small soft glow ring centered at the impact point, lying
 *     tangent to the shield surface — chapter-tinted, expands and
 *     fades over ~0.45s
 *   - A burst of bright-white + tint-colored sparks deflecting outward
 *
 * Does NOT play the sound — that's main.js's job (needs the Audio
 * import from there, not here).
 */
export function shieldHitVisual(hive, impactPos) {
  const shield = _hiveShields.get(hive);
  if (!shield) return;
  // Pulse the shield briefly — a short flash that compounds with the
  // per-frame pulse animation in updateHiveShields. We use userData
  // state so updateHiveShields can see and honor it.
  shield.userData._hitFlash = 0.18;   // seconds remaining of flash
  // Particle burst at the impact point — small white-hot core + larger
  // chapter-tinted halo deflecting outward. Consumer look: bright
  // plasma sizzle rather than a rocket explosion.
  const tint = shield.userData.tint || 0x4ff7ff;
  hitBurst(impactPos, 0xffffff, 8);
  hitBurst(impactPos, tint, 10);

  // TSL shield: route the impact directly into the shader's impact
  // uniform array. The TSL shader renders an in-surface 3D ripple
  // from the impact point — better and cleaner than the separate
  // flat-disc-ring spawn we do on the fallback path.
  if (shield.userData.tslHandle) {
    shield.userData.tslHandle.impacts.add(impactPos, 1.0);
    return;
  }

  // Fallback path: spawn a soft glow pulse ring at the impact point.
  // The ring is a flat disc tangent to the shield sphere (its normal
  // points outward from the sphere center), so it reads as glued to
  // the curved shield surface rather than floating in space. It
  // expands and fades over ~0.45s; multiple concurrent pulses are
  // fine — each one is independent and updateHiveShields walks the
  // list every frame. Each pulse has its own material clone so the
  // fade doesn't bleed across hits.
  const pulseMat = new THREE.MeshBasicMaterial({
    map: _getPulseGlowTexture(),
    color: tint,
    transparent: true,
    opacity: 1.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const pulse = new THREE.Mesh(_PULSE_RING_GEO, pulseMat);
  // Position at the impact point.
  pulse.position.copy(impactPos);
  // Orient the ring's normal to point AWAY from the shield's center.
  // Default RingGeometry has its normal on +Z; we rotate so +Z points
  // outward from the shield center, which lays the ring tangent to
  // the sphere's surface at the impact point.
  const shieldCenter = new THREE.Vector3(
    shield.position.x, shield.position.y, shield.position.z
  );
  const outward = new THREE.Vector3()
    .subVectors(impactPos, shieldCenter)
    .normalize();
  // Compute a quaternion that rotates +Z onto `outward`.
  const q = new THREE.Quaternion();
  q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
  pulse.quaternion.copy(q);
  // Lift the ring just slightly off the shield surface so it doesn't
  // z-fight with the translucent shield — 0.04 world units outward.
  pulse.position.addScaledVector(outward, 0.04);
  // Initial scale = start radius; grown to max radius by the update.
  pulse.scale.setScalar(_PULSE_START_RADIUS);
  scene.add(pulse);
  _hexPulses.push({
    mesh: pulse,
    mat: pulseMat,
    t: 0,
    lifetime: _PULSE_LIFETIME,
    startR: _PULSE_START_RADIUS,
    maxR: _PULSE_MAX_RADIUS,
  });
}

/**
 * Call this whenever a wave is about to start and you're not sure if the
 * chapter scaffolding is already up. Idempotent — bails out if the current
 * chapter is already prepared.
 *
 *  - Builds the depot (visible but only accepts ore during wave 1)
 *  - Spawns the hives in SHIELDED dormant form (invulnerable; emit nothing
 *    until wave 3 starts and removeHiveShields() fires)
 *  - TODO stage 2: spawns 3 dormant turret platforms
 *  - TODO stage 2: spawns the power/radio/EMP silo zone markers
 *  - TODO stage 3: herd staging pens
 */
export function prepareChapter(chapterIdx) {
  if (_preparedChapter === chapterIdx) return;
  // Clean any leftover state from a previous chapter before building anew.
  teardownChapter();

  // --- TRIANGLE SHUFFLE (must run FIRST).
  // Randomly assigns mining / power-up / hive waves to the three arena
  // wedges for this chapter. Every prop builder below reads the current
  // assignment to place props inside their assigned wedge, so this call
  // MUST come before any of them. Shuffling here means two runs of the
  // same chapter can have dramatically different spatial layouts.
  shuffleTriangleAssignment();

  // --- Depot (wave 1 target; spawns inside the mining triangle) ---
  spawnDepot(chapterIdx);

  // ===== CHAPTER 1 REFLOW BRANCH =====
  // Chapter 1 uses the egg→cannon→queen-hive flow instead of the
  // standard mining→powerup→hive flow. We skip the 4-hive cluster,
  // skip the silo/powerplant/radio compound (no powerup zones in
  // chapter 1's wave 2), and instead spawn:
  //   - A queen hive at the hive-triangle centroid with 4 shield domes
  //   - A cannon prop at the silo position (which still anchors the
  //     LAYOUT, just gets a different mesh on top of it)
  //   - 3 turrets ringed around the cannon (auto-fire defense during
  //     wave 2's barrage). Activated by waves.js when wave 2 begins.
  // CHAPTER 1 + CHAPTER 4 REFLOW (chapterIdx 0 = Inferno, 3 = Toxic):
  // Skip the silo/powerplant/radio compound (no powerup zones in
  // wave 2 for these chapters), and instead spawn:
  //   - A queen hive at the hive-triangle centroid with 4 shield domes
  //   - A cannon prop at the silo position (which still anchors the
  //     LAYOUT, just gets a different mesh on top of it)
  //   - 3 turrets ringed around the cannon (auto-fire defense during
  //     wave 2's barrage). Activated by waves.js when wave 2 begins.
  //   - A crusher prop on top of the depot for wave 1's egg-shatter
  //     finisher.
  if (chapterIdx === 0 || chapterIdx === 3) {
    buildCentralCompound(chapterIdx);
    if (typeof hideCentralCompound === 'function') {
      try { hideCentralCompound(); } catch (e) { /* defensive */ }
    }
    // Spawn the queen hive (replaces the 4-hive cluster) + cannon
    spawnQueenHive(chapterIdx);
    spawnCannon(chapterIdx);
    // Aim the cannon at the queen from the moment the chapter begins.
    // updateCannon re-applies this every frame so it stays locked on.
    try {
      const q = getQueen && getQueen();
      if (q && q.pos) aimCannonAt(q.pos);
    } catch (e) { /* defensive */ }
    // Spawn turrets too — they sit at LAYOUT.turrets which is the
    // ring around the cannon. Stay dormant until wave 2 starts;
    // waves.js calls activateTurretsUpTo(3) in the cannon-load init.
    spawnAllTurrets(chapterIdx);
    // CRUSHER — replaces the depot's visual. Depot game logic still
    // runs (deposit tracking, beacon proximity); we just hide the
    // depot mesh so the crusher takes its place. Crusher sits at the
    // depot's world position. Ores still fly to the depot beacon and
    // crusher slams trigger from waves.js when deposits land.
    const depotObj = OresModule.depot;
    if (depotObj && depotObj.pos) {
      spawnCrusher(chapterIdx, depotObj.pos.x, depotObj.pos.z);
      if (depotObj.obj) depotObj.obj.visible = false;
    }
    _preparedChapter = chapterIdx;
    console.info('[dormantProps] prepared chapter', chapterIdx, '(egg/cannon/queen/crusher reflow)');
    return;
  }

  // ===== CHAPTERS 2-7 STANDARD FLOW =====

  // --- Hives (wave 3 target; spawn inside the hive triangle, shielded) ---
  spawnAllPortals(chapterIdx);
  _applyShieldsToAllHives(chapterIdx);

  // --- Central compound: silo + powerplant + radio tower all placed
  //     relative to the power-up triangle centroid. The turrets and
  //     power-up zones below sit INSIDE this compound.
  buildCentralCompound(chapterIdx);

  // CHAPTER 2 + CHAPTER 5 REFLOW — replace silo with server warehouse
  // + hide the rest of the compound props. Silo mesh hidden, powerplant
  // + radio tower also hidden + collision-disabled — these chapters'
  // visual is the warehouse and the truck route, not the standard
  // compound. Turrets stay (wave 2 uses them for onslaught defense).
  if (chapterIdx === 1 || chapterIdx === 4) {
    const compound = getCompound();
    if (compound) {
      if (compound.silo && compound.silo.obj) {
        compound.silo.obj.visible = false;
        compound.silo._collideHidden = true;
      }
      if (compound.powerplant && compound.powerplant.obj) {
        compound.powerplant.obj.visible = false;
        compound.powerplant._collideHidden = true;
      }
      if (compound.radioTower && compound.radioTower.obj) {
        compound.radioTower.obj.visible = false;
        compound.radioTower._collideHidden = true;
      }
    }
    spawnServerWarehouse(chapterIdx);
    // Tell waveProps that the silo + powerplant + radio are gone for
    // this chapter — disables their collision in the prop helpers.
    setCh2WarehouseSwap(true);
  }

  // --- Turrets (wave 2 target; positions come from LAYOUT.turrets
  //     which buildCentralCompound just recomputed) ---
  spawnAllTurrets(chapterIdx);

  // --- Wires from powerplant to each turret + silo. Dormant (dim lines,
  //     no pulses) until POWER zone completes; waves.js calls setWiresLit
  //     at that point to energize them.
  buildWires(chapterIdx);

  // Power-up zones are NOT spawned here — they're wave-2 scoped. waves.js
  // calls spawnPowerupZones at the start of wave 2 and clearPowerupZones
  // when wave 2 ends, so the floor disks aren't cluttering the arena
  // during mining, hive, herd, or boss phases.

  _preparedChapter = chapterIdx;
  console.info('[dormantProps] prepared chapter', chapterIdx);
}

/**
 * Called when the chapter ends (boss dies or a hard reset happens). Clears
 * every prop the chapter owned so the next chapter can lay down fresh ones.
 */
export function teardownChapter() {
  if (_preparedChapter === -1) return;
  _clearHiveShields();
  clearAllPortals();
  clearDepot();
  clearAllTurrets();
  // Zones are wave-2 scoped now, but a defensive clear here covers the
  // edge case where the player dies mid-wave-2 and we reset the chapter
  // without wave 2's endWave having run.
  clearPowerupZones();
  clearWires();
  clearCentralCompound();
  // Chapter 1 reflow props (no-op for other chapters)
  clearCannon();
  clearQueenHive();
  clearCrusher();
  // Chapter 2 reflow props
  clearServerWarehouse();
  clearCockroachBoss();
  clearHiveLasers();
  // Faction paint hazards (boss wave-5 X/Y/Z floor letters). Cleared
  // on boss death already; this is a defensive sweep for the case
  // where the player dies mid-boss-fight or retreats from the chapter.
  try { clearFactionPaint(); } catch (e) {}
  try { clearAllPuddles(); } catch (e) {}
  try { clearFreeze(); } catch (e) {}
  try { clearAllFlares(); } catch (e) {}
  // Reset galaga active-bug count back to default (chapter 2 wave 3
  // bumps it; restore for clean state on chapter switch).
  resetGalagaTargetCount();
  // Also reset wave-3 overdrive bias — back to default 70% targeting
  // so other chapters/waves get standard galaga behavior.
  setGalagaOverdrive(false);
  // Same resets for the other hazard styles' wave-3 hive-wave overdrive.
  // Without these, an overdrive flag set by chapter 1's wave-3 (tetris)
  // or chapter 3's wave-3 (minesweeper) would persist into the next
  // chapter and aggressively bias all hazard drops toward the player.
  setTetrisOverdrive(false);
  setMinesweeperOverdrive(false);
  resetMinesweeperTargetCount();
  // Reset hazard rush mode (Turn 9) — ensures next chapter gets
  // default drop rate + no auto-shrink.
  setHazardRushMode(false);
  _preparedChapter = -1;
}

export function isChapterPrepared(chapterIdx) {
  return _preparedChapter === chapterIdx;
}

export function currentPreparedChapter() {
  return _preparedChapter;
}

// ----------------------------------------------------------------------------
// HIVE SHIELDS
//
// Wave 1 and 2 hives are decorative — they exist so the arena doesn't feel
// like pieces are teleporting in, and so the player can see "that's what
// we'll destroy in wave 3". A faint shield sphere wraps each hive, marked
// with the chapter color, and a `shielded` flag is stored on the hive
// object. The damage path in spawners.js should check this flag and skip
// all damage while true (done below in the shield helper).
// ----------------------------------------------------------------------------

function _applyShieldsToAllHives(chapterIdx) {
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  for (const h of spawners) {
    if (h.destroyed) continue;
    addShieldToHive(h, tint);
  }
}

/**
 * Build a shield material set tinted to the given chapter color.
 *
 * Returns two materials:
 *   - core: MeshBasicMaterial chapter-tinted via .color, additive
 *     blended. This is the main shield surface — what the player
 *     sees when looking at the dome. A clean glowing sphere; the
 *     hex texture treatment was dropped per playtester feedback
 *     (didn't read at distance + made the shield look noisy).
 *   - halo: MeshBasicMaterial for an overlay sphere (slightly larger,
 *     rendered BackSide only). From the camera this back-face-only
 *     overlay reads as an outer glow halo extending past the core
 *     shield's silhouette. No Fresnel shader needed — back-side
 *     rendering with additive blending produces the same visual
 *     in a fully debuggable way.
 *
 * Both materials own their own .opacity which the JS animation driver
 * (updateHiveShields) modulates each frame for breathing pulse + hit
 * flash effects.
 *
 * Used by:
 *   - hive (spawner) shields — addShieldToHive in this file
 *   - the NIGHT_HERALD boss summon shield in waves.js
 */
export function buildShieldMaterials(tint) {
  const core = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const halo = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.35,
    side: THREE.BackSide,         // only render the BACK face — looks like an outer glow
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  return { core, halo };
}

// Backward-compatible single-material helper. Some callers want one
// material; they use this. New callers should use buildShieldMaterials
// to get the halo overlay too.
export function buildShieldMaterial(tint) {
  return buildShieldMaterials(tint).core;
}

// Larger geometry for the halo overlay — same sphere shape but scaled
// up 10% so its silhouette extends past the core shield. Shared so we
// don't allocate per-shield.
const _SHIELD_HALO_GEO = new THREE.SphereGeometry(3.8 * 1.10, 28, 18);

// Lazy import of the new TSL-based shield. The shield asset uses
// three/tsl nodes which require WebGPURenderer (we run it with
// forceWebGL: true to use the WebGL2 backend). The hex-pattern
// texture loads asynchronously — until it's ready we fall back to
// the simpler additive-glow shield in buildShieldMaterials below.
import { buildShield as buildTslShield, isShieldTextureLoaded, disposeShield as disposeTslShield, updateShieldsTick } from './shieldShader.js';

export function addShieldToHive(hive, tint) {
  // Prefer the TSL-based shield (animated hex pattern + Fresnel rim +
  // proper 3D impact ripples) if the hex texture is loaded. Otherwise
  // fall back to the simpler glow + halo two-mesh approach.
  const tslReady = isShieldTextureLoaded();
  if (tslReady) {
    try {
      const handle = buildTslShield(tint, { radius: 3.8, strength: 7 });
      if (handle) {
        const shield = handle.mesh;
        shield.position.copy(hive.pos);
        shield.position.y = 1.9;
        shield.userData.pulseSeed = Math.random() * Math.PI * 2;
        shield.userData.tint = tint;
        shield.userData.tslHandle = handle;     // exposes .impacts.add for shieldHitVisual
        scene.add(shield);
        hive.shielded = true;
        hive.shieldMesh = shield;
        _hiveShields.set(hive, shield);
        console.log('[shield] TSL path — built shield with hex pattern');
        return;
      } else {
        console.warn('[shield] TSL builder returned null, falling back');
      }
    } catch (e) {
      console.warn('[shield] TSL build threw, falling back:', e);
    }
  } else {
    console.log('[shield] texture not ready yet, using fallback glow');
  }

  // ---- Fallback path (texture not yet loaded) ----
  // Two-mesh shield: core (chapter-tinted glow) + halo (outer glow).
  // Both meshes share the same animation timeline so the breathing
  // pulse + hit flash modulate them together.
  const { core, halo } = buildShieldMaterials(tint);
  const shield = new THREE.Mesh(_SHIELD_GEO, core);
  shield.position.copy(hive.pos);
  // Center at y=1.9 so the 3.8-radius sphere spans roughly 0..3.8 in Y —
  // covering base (0..0.3) + portal ring (2.0) + a little headroom. The
  // top of the shield is above the portal so shots don't slip over.
  shield.position.y = 1.9;
  shield.userData.pulseSeed = Math.random() * Math.PI * 2;
  shield.userData.tint = tint;

  // Halo overlay — slightly larger sphere, parented to the core shield
  // so it inherits position + rotation. Renders only the back face of
  // its larger sphere, producing a soft outer glow.
  const haloMesh = new THREE.Mesh(_SHIELD_HALO_GEO, halo);
  shield.add(haloMesh);              // child of core shield (relative pos = 0)
  shield.userData.haloMat = halo;    // updateHiveShields drives halo opacity too

  scene.add(shield);

  hive.shielded = true;
  hive.shieldMesh = shield;
  _hiveShields.set(hive, shield);
}

/**
 * Drop ONE hive's shield with an optional delay before the animation
 * starts. `delaySec` defaults to 0 (drops immediately). The delay lets
 * empLaunch stagger all shield drops from the explosion center outward
 * so the visual reads as a cascade-through-the-arena instead of a
 * single simultaneous blink.
 *
 * Animation is three phases (see updateHiveShields for details):
 *   Phase 1 (0.15s): FLASH-UP. Shield brightens and slightly expands —
 *                    the emitter's last gasp before power fails.
 *   Phase 2 (instant): BURST. Electric particles fire off the shield
 *                      surface at the flash → collapse transition.
 *   Phase 3 (0.35s): COLLAPSE. Shield shrinks and fades to nothing.
 *
 * Returns true if the shield was scheduled to drop, false if the hive
 * had no shield or was already dropping.
 */
export function dropHiveShield(hive, delaySec) {
  const shield = _hiveShields.get(hive);
  if (!shield) return false;
  if (shield.userData._dropping || shield.userData._dropPending) return false;
  hive.shielded = false;   // damage lands immediately — the drop is purely visual
  if (delaySec && delaySec > 0) {
    // Scheduled drop — don't kick off the animation yet. Track the
    // countdown in userData; updateHiveShields will start the real
    // animation once the timer expires. Meanwhile the shield keeps
    // pulsing as if intact, which telegraphs "shield's about to go."
    shield.userData._dropPending = true;
    shield.userData._dropPendingT = delaySec;
  } else {
    shield.userData._dropping = true;
    shield.userData._dropT = 0;
    shield.userData._sparksFired = false;
  }
  return true;
}

/**
 * Call this when wave 2 ends (EMP fires). Drops every hive shield with
 * the same cascade-style powering-down animation used by dropHiveShield,
 * just without the per-hive delay. Used as a safety net if the explicit
 * cascade in empLaunch missed any shields (e.g. a hive not in the
 * spawners array anymore, or the game was in a weird state).
 */
export function removeHiveShields() {
  for (const [hive, shield] of _hiveShields) {
    if (shield.userData._dropping || shield.userData._dropPending) continue;
    hive.shielded = false;
    shield.userData._dropping = true;
    shield.userData._dropT = 0;
    shield.userData._sparksFired = false;
  }
}

function _clearHiveShields() {
  for (const [hive, shield] of _hiveShields) {
    if (shield.parent) scene.remove(shield);
    if (hive) {
      hive.shielded = false;
      hive.shieldMesh = null;
    }
  }
  _hiveShields.clear();
}

/**
 * Per-frame shield update. Pulses intact shields, counts down pending
 * drops, and drives the three-phase powering-down animation for shields
 * whose drop timer has fired.
 *
 * Safe to call every frame regardless of wave type. If no shields exist
 * the loop is a single Map lookup and exits.
 */
export function updateHiveShields(dt, time) {
  // Tick the TSL shield impact animations FIRST so impact uniforms
  // are up-to-date before the renderer reads them. Cheap; only walks
  // active impact slots across all live TSL shields.
  try { updateShieldsTick(dt); } catch (e) {}

  if (!_hiveShields.size) return;
  const toRemove = [];
  for (const [hive, shield] of _hiveShields) {
    // Follow the hive in case its position ever drifts (it doesn't today,
    // but cheap safety).
    shield.position.x = hive.pos.x;
    shield.position.z = hive.pos.z;

    // Pending-drop timer — counts down until the real drop animation
    // starts. Shield keeps pulsing as intact during this window, so the
    // player doesn't see a pre-animation freeze between "shockwave
    // detonated" and "shield starts falling."
    if (shield.userData._dropPending) {
      shield.userData._dropPendingT -= dt;
      if (shield.userData._dropPendingT <= 0) {
        shield.userData._dropPending = false;
        shield.userData._dropping = true;
        shield.userData._dropT = 0;
        shield.userData._sparksFired = false;
      }
      // Still intact visually — fall through to the pulse path below.
    }

    if (shield.userData._dropping) {
      // Three-phase powering-down animation. Total 0.30s — tuned so the
      // entire cascade (nearest hive drop start → farthest hive drop
      // finish) fits inside the 1.2s shockwave-ring lifetime.
      //
      //   Phase 1 (0.08s): FLASH-UP.
      //     Shield briefly brightens to near-full opacity and expands by
      //     12% — reads as "emitter surges just before failing."
      //
      //   Phase 2 (instant, at flash → collapse boundary): BURST.
      //     Electric particles fire off the surface. `_sparksFired` flag
      //     gates this so the burst only happens once, at the transition.
      //
      //   Phase 3 (0.22s): COLLAPSE.
      //     Shield shrinks from 1.12 → 0 and fades to 0 opacity.
      shield.userData._dropT += dt;
      const t = shield.userData._dropT;
      const haloMat = shield.userData.haloMat;
      const tslHandle = shield.userData.tslHandle;

      if (t < 0.08) {
        // FLASH-UP phase. Linear-in opacity/strength + scale ramp.
        const f = t / 0.08;
        if (tslHandle) {
          // TSL shield: modulate the shader's `strength` uniform.
          // Going 7 → 14 boosts the emissive output for that flash.
          tslHandle.strength.value = 7 + f * 7;
        } else {
          const op = 0.55 + f * 0.40;                // 0.55 → 0.95
          shield.material.opacity = op;
          if (haloMat) haloMat.opacity = op * 0.60;
        }
        shield.scale.setScalar(1 + f * 0.12);      // 1.0 → 1.12
      } else {
        // BURST (once) + COLLAPSE phase.
        if (!shield.userData._sparksFired) {
          shield.userData._sparksFired = true;
          // Bright white spark core + chapter-tinted halo at the shield's
          // center. Small count so 4 hives exploding simultaneously don't
          // flood the particle system.
          const pos = new THREE.Vector3(
            shield.position.x,
            shield.position.y,
            shield.position.z,
          );
          const tint = shield.userData.tint || 0xffffff;
          hitBurst(pos, 0xffffff, 14);
          hitBurst(pos, tint, 20);
        }
        // COLLAPSE phase — 0.22s shrink + fade.
        const f = Math.min(1, (t - 0.08) / 0.22);
        const eased = f * f;   // ease-in, starts slow then accelerates
        shield.scale.setScalar(1.12 * (1 - eased));
        if (tslHandle) {
          // Drop strength toward 0 — the shader's emissive output
          // multiplies by strength so this fades the entire shield.
          tslHandle.strength.value = 14 * (1 - eased);
        } else {
          const op = 0.95 * (1 - eased);
          shield.material.opacity = op;
          if (haloMat) haloMat.opacity = op * 0.60;
        }
        if (f >= 1) {
          // TSL shields use disposeTslShield to also unregister the
          // shield from the impact-tick active list.
          if (tslHandle) {
            try { disposeTslShield(tslHandle); } catch (e) {}
          } else if (shield.parent) {
            scene.remove(shield);
          }
          toRemove.push(hive);
        }
      }
    } else {
      // Bright neon pulse while intact — 0.40..0.60 opacity range.
      // Seeded per-shield so the 4 hives breathe out of phase (avoids the
      // synthetic all-blink-together look).
      const phase = (time || 0) * 1.6 + (shield.userData.pulseSeed || 0);
      let opacity = 0.40 + (Math.sin(phase) + 1) * 0.5 * 0.20;
      // Bullet-hit flash: shieldHitVisual() sets _hitFlash to ~0.18.
      // We decay it here and bump opacity proportionally so the shield
      // visibly brightens each time it takes a hit, then settles back
      // into its normal breathing pulse.
      if (shield.userData._hitFlash > 0) {
        shield.userData._hitFlash = Math.max(0, shield.userData._hitFlash - dt);
        const flashStrength = shield.userData._hitFlash / 0.18;  // 1→0
        opacity = Math.min(0.95, opacity + flashStrength * 0.55);
      }
      const tslHandle = shield.userData.tslHandle;
      if (tslHandle) {
        // TSL shield: drive the shader's `strength` uniform with the
        // breathing pulse + hit-flash bump. Baseline 7, breath ±1.5,
        // hit-flash adds up to +6 during impact decay.
        const phaseN = (Math.sin(phase) + 1) * 0.5;       // 0..1
        let strengthVal = 7 + phaseN * 1.5;
        if (shield.userData._hitFlash > 0) {
          const flashStrength = shield.userData._hitFlash / 0.18;
          strengthVal += flashStrength * 6;
        }
        tslHandle.strength.value = strengthVal;
      } else {
        shield.material.opacity = opacity;
        const haloMat = shield.userData.haloMat;
        if (haloMat) haloMat.opacity = opacity * 0.60;
      }
      // Slow rotation for a subtle "active field" feel.
      shield.rotation.y += dt * 0.25;
    }
  }
  for (const hive of toRemove) {
    _hiveShields.delete(hive);
    if (hive) hive.shieldMesh = null;
  }

  // Glow pulse rings — expand + fade every active pulse. Walk the
  // array backwards so we can splice expired entries safely. Pulses
  // are independent of specific shields; if a shield is being torn
  // down mid-pulse the pulse continues to its natural end.
  for (let i = _hexPulses.length - 1; i >= 0; i--) {
    const p = _hexPulses[i];
    p.t += dt;
    const u = Math.min(1, p.t / p.lifetime);
    // Ease-out for radius (fast start, slow end) — feels like a shock
    // wave decelerating as it dissipates.
    const radiusU = 1 - Math.pow(1 - u, 2.4);
    const r = p.startR + (p.maxR - p.startR) * radiusU;
    p.mesh.scale.setScalar(r);
    // Opacity: linear fade with a slight curve so it stays bright
    // longer at the start of the pulse.
    p.mat.opacity = Math.max(0, 1 - Math.pow(u, 1.6));
    if (p.t >= p.lifetime) {
      if (p.mesh.parent) scene.remove(p.mesh);
      // Each pulse owns its material clone — dispose to avoid leak.
      p.mat.dispose();
      _hexPulses.splice(i, 1);
    }
  }
}
