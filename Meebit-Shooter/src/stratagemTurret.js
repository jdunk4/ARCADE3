// stratagemTurret.js — Player-deployable sentry turrets dropped by
// the SENTRY TURRET stratagem. Distinct from src/turrets.js which is
// the *enemy*-side compound turret tied to chapter waveProps.
//
// Variants — picked AFTER deploy via a floating screen-space picker:
//
//   'mg'        — Rapid hitscan tracers. Good crowd control, modest
//                 per-hit damage. Tint defaults to chapter color.
//   'fire'      — Short-range cone DoT (the old 'flame' variant,
//                 renamed for the picker label). Shreds packed
//                 groups but doesn't reach far.
//   'poison'    — Short-range cone that applies _poisonedUntil to
//                 hit enemies — slows them and ticks DoT through the
//                 existing poison-trail infrastructure (powerups.js).
//   'tesla'     — Chains lightning between nearby enemies. Lower
//                 fire rate but each shot can hit several enemies.
//
// Per playtester redesign: variants are NOT pre-chosen at call-in.
// The turret deploys as a "pending" frame (chassis only, no barrel,
// no firing). A floating HTML picker UI appears above the turret;
// the player clicks one of the 4 icons to commit. The turret then
// builds its barrel mesh, recolors accents, and starts firing.
// While pending, the turret is idle (no aggro, no fire, immune to
// the ammo-zero despawn).
//
// Each turret:
//   • drops from height with a landing impact burst (matches mech)
//   • once committed: acquires the closest enemy within range every
//     0.25s, aims smoothly, fires per-variant cadence
//   • has HP and is destroyed if damaged enough; explodes + leaves
//     a small impact burst.
//
// Public API:
//   spawnTurret(pos, tint)            — drop one pending turret
//   commitTurretVariant(t, variantId) — applies variant after pickup
//   updateTurrets(dt)                 — per-frame tick (called by main.js)
//   clearStratagemTurrets()           — wipe all
//   damageTurret(t, dmg)              — apply damage (optional hook
//                                       for future enemy-attacks-turret
//                                       wiring)

import * as THREE from 'three';
import { scene, camera } from './scene.js';
import { hitBurst } from './effects.js';
import { enemies, applyKnockback } from './enemies.js';
import { Audio } from './audio.js';
import { S } from './state.js';
import { PARADISE_FALLEN_CHAPTER_IDX } from './config.js';
import { player } from './player.js';
import { isPiloting } from './mech.js';
import { segmentBlockedByMazeWall } from './mazeRenderer.js';

// =====================================================================
// TUNING
// =====================================================================
const TURRET_HP_MAX           = 240;
const TURRET_LIFETIME_SEC     = 35.0;     // self-decommission timer
const TURRET_RISE_DEPTH       = 3.0;       // turrets start buried this deep
const TURRET_RISE_DURATION    = 0.85;
// Legacy aliases — code below references DROP_HEIGHT / DROP_DURATION.
const TURRET_DROP_HEIGHT      = TURRET_RISE_DEPTH;
const TURRET_DROP_DURATION    = TURRET_RISE_DURATION;
const TURRET_AIM_LERP         = 8.0;      // higher = snappier
const TURRET_ACQ_INTERVAL     = 0.25;     // re-acquire target this often

// Per-variant config drives geometry + fire behavior.
//
// AMMO MODEL (per playtester request: "add ammo capacity to turrets /
// mech - once used the turrets and mechs disappear instead of
// despawning after a timer"):
//   Each variant has an ammoMax. Each successful fire decrements ammo
//   by 1. When ammo reaches 0 the turret self-destructs. The values
//   are tuned so the turret does meaningful work but is decisively
//   FINITE — players plan around its limit rather than treating it as
//   permanent infrastructure.
//
//   Sample uptime estimates at the listed fireInterval values:
//     mg       - 100 shots × 0.10s = ~10s of sustained fire
//     tesla    -  35 shots × 0.55s = ~19s (chain hits multiple per shot)
//     flame    - 200 ticks × 0.04s = ~8s (DPS stream, ticks fast)
//     antitank -  12 shots × 1.30s = ~16s (heavy single-shots)
const _VARIANT_CONFIG = {
  mg: {
    label: 'MG',
    range: 22,
    fireInterval: 0.10,                   // rapid
    ammoMax: 100,
    barrelGeo: new THREE.CylinderGeometry(0.10, 0.10, 1.40, 10),
    barrelOffset: 0.70,
    bodyHex: 0x4a4d54,
    headHex: 0x2a2c34,
    accentHex: null,                       // null = chapter tint
    fire: (t, target) => _fireMg(t, target),
  },
  tesla: {
    label: 'TESLA',
    range: 14,
    fireInterval: 0.55,
    ammoMax: 35,
    barrelGeo: new THREE.CylinderGeometry(0.18, 0.30, 1.10, 10),
    barrelOffset: 0.55,
    bodyHex: 0x2c2c44,
    headHex: 0x1c1c30,
    accentHex: 0x66ccff,                  // electric blue regardless of chapter
    fire: (t, target) => _fireTesla(t, target),
  },
  fire: {
    label: 'FIRE',                        // renamed from FLAME for the picker UI
    range: 8,
    fireInterval: 0.04,                   // continuous stream
    ammoMax: 200,
    barrelGeo: new THREE.ConeGeometry(0.32, 0.55, 12),
    barrelOffset: 0.45,
    bodyHex: 0x3a1f12,
    headHex: 0x2a1a10,
    accentHex: 0xff7a30,
    fire: (t, target) => _fireFlame(t, target),
  },
  // POISON — replaces antitank in the variant slate. Continuous
  // short-range cone (similar to flame) but instead of high DPS does
  // moderate damage + applies _poisonedUntil to enemies, which the
  // existing poison-trail infrastructure already reads for slow +
  // residual DPS via getEnemySpeedMult and the poison tick. Per
  // playtester: "Fire, Poison, Tesla, or General Machine gun."
  poison: {
    label: 'POISON',
    range: 9,
    fireInterval: 0.06,                   // slower than fire (less spammy)
    ammoMax: 180,
    barrelGeo: new THREE.CylinderGeometry(0.20, 0.28, 0.90, 12),
    barrelOffset: 0.50,
    bodyHex: 0x1f3018,
    headHex: 0x14241a,
    accentHex: 0x66ff44,                  // toxic green regardless of chapter
    fire: (t, target) => _firePoison(t, target),
  },
};

// Canonical pickable order — drives the icon row in the picker UI.
// Per playtester: "Fire, Poison, Tesla, or General Machine gun."
// Icons + labels also drive what the picker displays.
const VARIANT_PICKER_ORDER = [
  { id: 'mg',     label: 'MG',     icon: '🔫', desc: 'Rapid fire' },
  { id: 'fire',   label: 'FIRE',   icon: '🔥', desc: 'Flame cone' },
  { id: 'poison', label: 'POISON', icon: '☣',  desc: 'Slow + DoT' },
  { id: 'tesla',  label: 'TESLA',  icon: '⚡', desc: 'Chain lightning' },
];

// =====================================================================
// SHARED GEOMETRY
// =====================================================================
// Layout (matches the reference photo):
//   • 4-armed star base — octagonal central hub with 4 long
//     triangular foot pads at 90° intervals (front/back/left/right).
//   • Stepped pyramidal plinth — two octagonal tiers of progressively
//     smaller radius stacked on top of the base hub.
//   • Cylindrical swivel post sitting on the top tier.
//   • Box-shaped armored head with vertical louver vents on its
//     sides + a small sensor housing on top with a red lens.
//   • Twin parallel cannon barrels emerging from a yoke at the front.
const _BASE_HUB_GEO     = new THREE.CylinderGeometry(0.72, 0.78, 0.32, 8);
const _BASE_FOOT_GEO    = new THREE.BoxGeometry(0.65, 0.16, 1.30);
const _BASE_FOOT_PAD_GEO = new THREE.BoxGeometry(0.85, 0.10, 0.55);
const _PLINTH_LO_GEO    = new THREE.CylinderGeometry(0.62, 0.72, 0.20, 8);
const _PLINTH_HI_GEO    = new THREE.CylinderGeometry(0.50, 0.58, 0.18, 8);
const _PILLAR_GEO       = new THREE.CylinderGeometry(0.30, 0.32, 0.34, 12);
const _HEAD_GEO         = new THREE.BoxGeometry(0.95, 0.80, 1.05);
// Sensor housing on top — small protruding nub.
const _SENSOR_HOUSING_GEO = new THREE.BoxGeometry(0.36, 0.18, 0.50);
const _SENSOR_LENS_GEO    = new THREE.CircleGeometry(0.10, 16);
// Side louver vent — thin vertical strip applied to side of head.
const _HEAD_LOUVER_GEO  = new THREE.BoxGeometry(0.04, 0.55, 0.04);
// Yoke that holds the twin barrels — short box at the front of the head.
const _YOKE_GEO         = new THREE.BoxGeometry(0.55, 0.42, 0.30);

// MG / antitank variants want twin barrels; tesla and flame stay
// single-barrel for visual identity. We build twin barrels for those
// that opt in via barrelStyle === 'twin'.

const _activeTurrets = [];
const _activeTracers = [];                 // mg + tesla visuals
const _activeRockets = [];                 // antitank
const _activeFlames  = [];                 // flame turret particles

// =====================================================================
// SPAWN
// =====================================================================
/**
 * Spawn a turret. Per playtester redesign: variants are no longer
 * pre-selected at call-in time. The turret drops as a NEUTRAL frame
 * (chassis + base + head + sensor lens, but NO BARREL and no variant
 * coloring). A floating picker UI appears above the turret; the
 * player clicks one of {MG, FIRE, POISON, TESLA} to commit the
 * variant. Until then the turret idles — no firing.
 *
 * The picker is implemented in HTML/CSS (see _ensurePickerEl) and
 * tracks the turret's screen-projected position each frame via
 * _tickVariantPicker.
 */
export function spawnTurret(pos, tint) {
  // No variant config until commit. Starting cfg is a placeholder
  // ("mg" defaults) used only for the chassis defaults (range, ammo
  // baselines) — overwritten on commit.
  const cfg = _VARIANT_CONFIG.mg;
  const OLIVE_BODY = 0x55624a;        // olive military green
  const OLIVE_TRIM = 0x6c7861;        // slightly lighter green for raised trim
  const STEEL_TRIM = 0x8c8e90;        // brushed-steel grey for foot pads + barrels
  // Pre-commit accent — neutral steel grey. Recolored on commit.
  const accentHex = STEEL_TRIM;
  const accentColor = new THREE.Color(accentHex);
  const tintColor = new THREE.Color(tint);

  const root = new THREE.Group();
  // Spawn buried; ticked up to ground level over TURRET_RISE_DURATION.
  // Reads as the turret deploying out of the floor.
  root.position.set(pos.x, -TURRET_RISE_DEPTH, pos.z);

  // Materials.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: OLIVE_BODY,
    roughness: 0.65,
    metalness: 0.45,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: OLIVE_TRIM,
    roughness: 0.55,
    metalness: 0.55,
  });
  const steelMat = new THREE.MeshStandardMaterial({
    color: STEEL_TRIM,
    roughness: 0.40,
    metalness: 0.85,
  });
  const louverMat = new THREE.MeshStandardMaterial({
    color: 0x2a2c34,
    roughness: 0.55,
    metalness: 0.65,
  });
  // Barrel material is built on commit (color depends on variant accent).
  // Pre-commit we use a neutral grey for any temporary visuals.
  const barrelMat = new THREE.MeshStandardMaterial({
    color: 0x2a2c34,
    emissive: 0x000000,
    emissiveIntensity: 0,
    roughness: 0.50,
    metalness: 0.90,
  });
  const lensMat = new THREE.MeshBasicMaterial({
    color: 0xff3030,                  // bright red sensor (matches photo)
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  // Variant-color highlight on the eye. Faint pre-commit grey;
  // recolored to the variant accent on commit.
  const eyeMat = new THREE.MeshBasicMaterial({
    color: accentColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  // ---- 4-ARMED STAR BASE ----
  // Hub.
  const hub = new THREE.Mesh(_BASE_HUB_GEO, bodyMat);
  hub.position.y = 0.16;
  root.add(hub);
  // Foot arms — 4 of them at cardinal angles.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    // Foot beam.
    const foot = new THREE.Mesh(_BASE_FOOT_GEO, bodyMat);
    foot.position.set(Math.cos(a) * 0.95, 0.10, Math.sin(a) * 0.95);
    foot.rotation.y = -a + Math.PI / 2;
    root.add(foot);
    // Foot pad cap (steel) at the far end.
    const pad = new THREE.Mesh(_BASE_FOOT_PAD_GEO, steelMat);
    pad.position.set(Math.cos(a) * 1.65, 0.08, Math.sin(a) * 1.65);
    pad.rotation.y = -a + Math.PI / 2;
    root.add(pad);
  }

  // ---- STEPPED PLINTH ----
  // Two octagonal tiers stacked on top of the hub.
  const plinthLo = new THREE.Mesh(_PLINTH_LO_GEO, bodyMat);
  plinthLo.position.y = 0.42;
  root.add(plinthLo);
  const plinthHi = new THREE.Mesh(_PLINTH_HI_GEO, trimMat);
  plinthHi.position.y = 0.61;
  root.add(plinthHi);

  // ---- SWIVEL POST (rotates with the head) ----
  // Post is tall enough to put the head's pivot point above the plinth.
  const pillar = new THREE.Mesh(_PILLAR_GEO, steelMat);
  pillar.position.y = 0.87;
  root.add(pillar);

  // ---- HEAD (swivel group) ----
  const head = new THREE.Group();
  head.position.y = 1.20;
  root.add(head);

  // Main head box.
  const headMesh = new THREE.Mesh(_HEAD_GEO, bodyMat);
  head.add(headMesh);
  // Trim plate on top of the head (slightly raised lid).
  const lidGeo = new THREE.BoxGeometry(0.85, 0.06, 0.95);
  const lid = new THREE.Mesh(lidGeo, trimMat);
  lid.position.y = 0.43;
  head.add(lid);

  // ---- SIDE LOUVER VENTS ----
  // 4 vertical louver strips on each side of the head. Cheap visual
  // detail — small dark slats inset against the body color.
  for (const sx of [-0.49, 0.49]) {
    for (let j = 0; j < 4; j++) {
      const louver = new THREE.Mesh(_HEAD_LOUVER_GEO, louverMat);
      louver.position.set(sx, -0.06, -0.32 + j * 0.18);
      head.add(louver);
    }
  }

  // ---- SENSOR HOUSING + RED LENS (top of head) ----
  // Small protruding nub on top with a red sensor lens facing
  // forward. Reads as a target-acquisition optic.
  const sensorHousing = new THREE.Mesh(_SENSOR_HOUSING_GEO, trimMat);
  sensorHousing.position.set(0, 0.50, 0.20);
  head.add(sensorHousing);
  const lensFrame = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.13, 16),
    new THREE.MeshStandardMaterial({ color: 0x1c1d22, roughness: 0.35, metalness: 0.85, side: THREE.DoubleSide }),
  );
  lensFrame.position.set(0, 0.50, 0.46);
  head.add(lensFrame);
  const lens = new THREE.Mesh(_SENSOR_LENS_GEO, lensMat);
  lens.position.set(0, 0.50, 0.461);
  head.add(lens);

  // ---- VARIANT-COLOR HINT EYE ----
  // Small additive sphere on the front face of the head (below the
  // sensor) tinted to the variant accent color so each variant still
  // has a faint tell.
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), eyeMat);
  eye.position.set(0, 0.10, 0.54);
  head.add(eye);

  // ---- BARREL YOKE ----
  // The yoke is a small box at the front-bottom of the head; barrels
  // emerge from it once the variant is committed. Pre-commit: yoke
  // is mounted but no barrels yet — the picker UI will make it clear
  // the player needs to choose.
  const yoke = new THREE.Mesh(_YOKE_GEO, steelMat);
  yoke.position.set(0, -0.18, 0.55);
  head.add(yoke);

  // Muzzle anchor — placeholder until commit attaches the variant
  // barrel. Position chosen to roughly match the average variant
  // muzzle so any pre-commit visuals (e.g. the picker's fly-up
  // animation origin) look correct.
  const muzzle = new THREE.Group();
  muzzle.position.set(0, -0.18, 1.30);
  head.add(muzzle);

  scene.add(root);

  const t = {
    root,
    head,
    eye, eyeMat,
    muzzle,
    yoke,                              // refer back to attach barrels on commit
    bodyMat, trimMat, steelMat, louverMat, barrelMat, lensMat,
    // Variant slot is null until the player picks. Picker UI is
    // surfaced for any turret with `pending: true && !destroyed`.
    variant: null,
    cfg,                               // baseline cfg, replaced on commit
    pending: true,                     // picker UI shows for this turret
    barrels: [],                       // barrel meshes, populated on commit
    teslaCoilMesh: null,               // tesla-only ornament, populated on commit
    tint,
    accentHex,
    accentColor,
    tintColor,
    pos: new THREE.Vector3(pos.x, 0, pos.z),
    aimYaw: 0,
    target: null,
    targetT: 0,
    fireT: 0,
    hp: TURRET_HP_MAX,
    hpMax: TURRET_HP_MAX,
    life: 0,
    lifetime: TURRET_LIFETIME_SEC,
    // Ammo capacity — drains by 1 per fire. When zero, the turret
    // self-destroys (replaces the old lifetime-based despawn). The
    // lifetime field above is now an upper-bound safety only — kept
    // so any external code still referencing it doesn't break, but
    // the active despawn condition is ammo === 0.
    //
    // Initialized at variant commit, NOT here — pre-commit there's
    // no ammo to track since the turret can't fire. Defaults below
    // prevent NaN if anything reads early.
    ammo: 0,
    ammoMax: 0,
    fireIntervalMul: (S.chapter === PARADISE_FALLEN_CHAPTER_IDX) ? 2.5 : 1.0,
    dropping: true,
    dropT: 0,
    destroyed: false,
    deathT: 0,
    flameLastFireT: 0,
  };
  _activeTurrets.push(t);
  return t;
}

/**
 * Commit a variant choice to a pending turret. Called by the picker
 * UI when the player clicks one of the icons. Builds the barrel
 * mesh(es), the variant-specific accent color recoloring, the tesla
 * coil ornament if applicable, sets up ammo, and clears the pending
 * flag so the per-frame fire loop starts running.
 */
export function commitTurretVariant(t, variantId) {
  if (!t || t.destroyed || !t.pending) return;
  const cfg = _VARIANT_CONFIG[variantId];
  if (!cfg) return;
  // Resolve accent (variant's fixed hex, or chapter tint fallback).
  const accentHex = cfg.accentHex != null ? cfg.accentHex : t.tint;
  const accentColor = new THREE.Color(accentHex);
  // Recolor the eye + barrel emissive to the variant accent.
  if (t.eyeMat && t.eyeMat.color) t.eyeMat.color.copy(accentColor);
  if (t.barrelMat) {
    if (t.barrelMat.emissive) t.barrelMat.emissive.copy(accentColor);
    t.barrelMat.emissiveIntensity = 0.15;
  }

  // Build barrels. MG gets twin barrels; tesla / fire / poison are single.
  const isTwin = (variantId === 'mg');
  const yPos = -0.18;
  if (isTwin) {
    const offsets = [-0.13, 0.13];
    let i = 0;
    for (const ox of offsets) {
      const b = new THREE.Mesh(cfg.barrelGeo, t.barrelMat);
      b.rotation.x = Math.PI / 2;
      const zJitter = i === 0 ? 0.05 : -0.02;
      b.position.set(ox, yPos, cfg.barrelOffset + zJitter);
      t.head.add(b);
      t.barrels.push(b);
      i++;
    }
    // Re-anchor muzzle to barrel tip.
    t.muzzle.position.set(0, yPos, cfg.barrelOffset + 0.92);
  } else {
    const b = new THREE.Mesh(cfg.barrelGeo, t.barrelMat);
    b.rotation.x = Math.PI / 2;
    b.position.set(0, yPos, cfg.barrelOffset);
    t.head.add(b);
    t.barrels.push(b);
    t.muzzle.position.set(0, yPos, cfg.barrelOffset + 0.85);
  }

  // Tesla ornament — additive sphere atop head.
  if (variantId === 'tesla') {
    const coilMat = new THREE.MeshBasicMaterial({
      color: accentColor,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const coil = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), coilMat);
    coil.position.set(0, 0.78, 0);
    t.head.add(coil);
    t.teslaCoilMesh = coil;
  }

  // Apply variant config + ammo. Chapter 7 still gets the 20× ammo
  // override per the existing rule.
  t.variant = variantId;
  t.cfg = cfg;
  t.accentHex = accentHex;
  t.accentColor = accentColor;
  t.ammo = (S.chapter === PARADISE_FALLEN_CHAPTER_IDX) ? cfg.ammoMax * 20 : cfg.ammoMax;
  t.ammoMax = t.ammo;
  t.pending = false;

  // Audio cue — small confirm chirp so the player feels the click landed.
  try { Audio.pickup && Audio.pickup(); } catch (_) {}
}

// =====================================================================
// PER-FRAME TICK
// =====================================================================
export function updateTurrets(dt) {
  // --- TURRETS ---
  for (let i = _activeTurrets.length - 1; i >= 0; i--) {
    const t = _activeTurrets[i];

    // Rise animation — emerges from the floor, with deploy click +
    // dirt burst on landing.
    if (t.dropping) {
      if (!t._riseAudioFired) {
        t._riseAudioFired = true;
        try { Audio.turretDeploy(); } catch (_) {}
        // Initial dirt burst at ground level.
        const gp = new THREE.Vector3(t.pos.x, 0, t.pos.z);
        hitBurst(gp, 0x8a6a44, 16);
      }
      t.dropT += dt;
      const f = Math.min(1, t.dropT / TURRET_RISE_DURATION);
      const eased = 1 - Math.pow(1 - f, 2.4);
      t.root.position.y = -TURRET_RISE_DEPTH * (1 - eased);
      if (f >= 1) {
        t.dropping = false;
        t.root.position.y = 0;
        hitBurst(t.pos.clone(), t.accentHex, 22);
        hitBurst(t.pos.clone(), 0xffffff, 14);
      }
      continue;
    }

    // Death sequence.
    if (t.destroyed) {
      t.deathT += dt;
      t.root.rotation.y += dt * 4;
      t.root.position.y -= dt * 1.5;
      if (t.deathT > 0.9) {
        _disposeTurret(t);
        _activeTurrets.splice(i, 1);
      }
      continue;
    }

    // Self-decommission. We still tick t.life so any external code
    // that reads it for FX timing keeps working, but the natural
    // despawn condition is now AMMO REACHING ZERO. The original
    // lifetime check was switched off per playtester request: turrets
    // should disappear from running out of ammo, not from a clock.
    // (We still keep a hard upper-bound on lifetime as a runaway
    // safety so a turret that somehow can't find any targets ever
    // doesn't sit on the field forever — at 3× the original value.)
    t.life += dt;
    if (t.life >= t.lifetime * 3) {
      _destroyTurret(t);
      continue;
    }
    // Pending turret — variant not yet committed by the player.
    // Skip target acquisition + fire loop entirely; the turret
    // sits idle while the picker UI is up. Per playtester:
    // "The player will deploy the turret and then when the turret
    // is ready they can select from several options Fire, Poison,
    // Tesla, or General Machine gun." Idle forever — no auto-default.
    if (t.pending) continue;
    if (t.ammo <= 0) {
      _destroyTurret(t);
      continue;
    }

    // Re-acquire target periodically.
    t.targetT -= dt;
    if (t.targetT <= 0) {
      t.targetT = TURRET_ACQ_INTERVAL;
      t.target = _findClosestEnemy(t.pos, t.cfg.range);
    }
    // Stale target check — clear if target died, despawned, or
    // wandered past range. The fire path also bails on dead targets.
    if (t.target) {
      if (!t.target.pos || t.target.dying) {
        t.target = null;
      } else {
        const dx = t.target.pos.x - t.pos.x;
        const dz = t.target.pos.z - t.pos.z;
        if (dx * dx + dz * dz > t.cfg.range * t.cfg.range) {
          t.target = null;
        } else if (S.endlessGlyphs &&
                   segmentBlockedByMazeWall(t.pos.x, t.pos.z,
                                        t.target.pos.x, t.target.pos.z)) {
          // Endless Glyphs — target ducked behind a wall since lock-on.
          // Drop the target so the turret stops streaming shots into
          // geometry. Re-acquire fires on the next TURRET_ACQ_INTERVAL.
          t.target = null;
        }
      }
    }

    // Aim head toward target (smooth lerp).
    if (t.target && t.target.pos) {
      const dx = t.target.pos.x - t.pos.x;
      const dz = t.target.pos.z - t.pos.z;
      const desired = Math.atan2(dx, dz);
      let dy = desired - t.aimYaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      t.aimYaw += dy * Math.min(1, dt * TURRET_AIM_LERP);
      t.head.rotation.y = t.aimYaw;
    }

    // Fire — decrements ammo on each successful shot. Tesla's chain
    // counts as one shot regardless of how many enemies it hits.
    t.fireT -= dt;
    if (t.target && t.fireT <= 0 && t.ammo > 0) {
      // fireIntervalMul is set per-turret at deploy time. 1.0 in
      // chapters 1-6, 2.5 in chapter 7 (slower fire rate).
      t.fireT = t.cfg.fireInterval * (t.fireIntervalMul || 1.0);
      t.ammo -= 1;
      try { t.cfg.fire(t, t.target); }
      catch (e) { console.warn('[turret fire]', e); }
    }

    // Tesla coil flicker — keep the eye pulsing even when not firing.
    if (t.variant === 'tesla') {
      t.eyeMat.opacity = 0.6 + 0.35 * Math.sin(t.life * 8);
    }
  }

  // --- TRACERS (mg + tesla visuals) ---
  _tickTracers(dt);
  // --- ROCKETS (legacy antitank — array stays empty after removal) ---
  _tickRockets(dt);
  // --- FLAME PARTICLES (fire turret) ---
  _tickFlames(dt);
  // --- POISON PARTICLES (poison turret) ---
  _tickPoisonParticles(dt);
  // --- PICKER UI (pending turrets) ---
  _tickVariantPicker();
}

// =====================================================================
// TARGETING
// =====================================================================
function _findClosestEnemy(pos, range) {
  let best = null;
  let bestD2 = range * range;
  // ENDLESS GLYPHS — skip enemies hidden behind walls. Per
  // playtester: "Turrets do not lock on an enemy unless the
  // bullets can hit them." All turret variants (MG, Tesla, Fire,
  // Poison) are hitscan or short cone — no projectile travel —
  // so a clear segment from turret to enemy is sufficient. We
  // gate on S.endlessGlyphs so the regular game (where walls
  // don't exist) skips the LOS cost entirely.
  const checkLOS = !!S.endlessGlyphs;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      // Range gate passed; verify the shot can actually land.
      // Without this, a turret on one side of a wall would lock
      // onto an enemy on the other side and stream shots into
      // the wall.
      if (checkLOS &&
          segmentBlockedByMazeWall(pos.x, pos.z, e.pos.x, e.pos.z)) {
        continue;
      }
      bestD2 = d2;
      best = e;
    }
  }
  return best;
}

// =====================================================================
// VARIANT FIRE FUNCTIONS
// =====================================================================
// MG tracer geometry — beefed up from the original 0.04 radius. Same
// approach as the mech MG: a thicker visible streak so player + turret
// fire reads at a glance against busy backgrounds. _spawnTracer below
// also paints an additional halo cylinder for the glow trail.
const _MG_TRACER_GEO = new THREE.CylinderGeometry(0.10, 0.10, 1.0, 8);
function _fireMg(t, target) {
  // Hitscan: damage target instantly + spawn a tracer for visual.
  const dmg = 16;
  target.hp -= dmg;
  target.hitFlash = 0.10;
  const muzzleWorld = new THREE.Vector3();
  t.muzzle.getWorldPosition(muzzleWorld);
  // Universal knockback — push the target away from the turret muzzle.
  applyKnockback(target, muzzleWorld);
  _spawnTracer(muzzleWorld, target.pos.clone(), t.accentColor, 0.06);
  // Small muzzle puff.
  hitBurst(muzzleWorld, t.accentHex, 4);
  try { Audio.turretMg(); } catch (_) {}
  // Finish the kill — turrets used to damage but never trigger the
  // standard score/loot/splice pipeline; enemies could end up at
  // negative hp and keep walking.
  if (target.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
    try { window.__killEnemyAtIdx(target); } catch (_) {}
  }
}

function _fireTesla(t, target) {
  // Chain lightning — hits the primary target, then jumps to the
  // closest enemy within JUMP_RADIUS, up to MAX_CHAIN times.
  const PRIMARY_DAMAGE = 60;
  const FALLOFF = 0.65;            // each successive jump deals this fraction
  const JUMP_RADIUS = 5.0;
  const MAX_CHAIN = 4;
  const visited = new Set();
  visited.add(target);
  // Collect any enemy that the chain drops below 0 hp; we run the
  // kill pipeline AFTER the chain finishes so the splice inside
  // killEnemy doesn't perturb the in-progress jump-target search.
  const kills = [];
  // Start point is the muzzle.
  const muzzleWorld = new THREE.Vector3();
  t.muzzle.getWorldPosition(muzzleWorld);
  let from = muzzleWorld;
  let cur = target;
  let dmg = PRIMARY_DAMAGE;
  for (let i = 0; i < MAX_CHAIN; i++) {
    if (!cur || !cur.pos) break;
    cur.hp -= dmg;
    cur.hitFlash = 0.16;
    // Universal knockback — chain bolts push targets away from the
    // PREVIOUS link (`from` is the muzzle for hop 0, then the prior
    // enemy's pos for subsequent hops). Reads as the bolt arcing
    // through the line and shoving each one back.
    applyKnockback(cur, from);
    if (cur.hp <= 0) kills.push(cur);
    const to = cur.pos.clone();
    to.y = 1.0;
    _spawnTracer(from, to, t.accentColor, 0.18);
    hitBurst(to, t.accentHex, 4);
    // Find next chain target.
    let next = null;
    let bestD2 = JUMP_RADIUS * JUMP_RADIUS;
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying || visited.has(e)) continue;
      const dx = e.pos.x - cur.pos.x;
      const dz = e.pos.z - cur.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; next = e; }
    }
    if (!next) break;
    visited.add(next);
    from = cur.pos.clone(); from.y = 1.0;
    cur = next;
    dmg *= FALLOFF;
  }
  // Now finish kills — chain logic is done so splices are safe.
  if (kills.length && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
    for (const e of kills) {
      try { window.__killEnemyAtIdx(e); } catch (_) {}
    }
  }
  try { Audio.turretTesla(); } catch (_) {}
}

function _fireFlame(t, target) {
  // Small forward cone — apply DPS and spawn a particle each call.
  const RANGE = t.cfg.range;
  const CONE_HALF = 0.40;
  const DPS_BURST = 40;            // damage per call (called every cfg.fireInterval)
  const ang = t.aimYaw;
  const dirX = Math.sin(ang), dirZ = Math.cos(ang);
  // Apply damage once per call to anything in cone. Backwards
  // iteration so the killEnemy splice doesn't shift indices.
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const ex = e.pos.x - t.pos.x;
    const ez = e.pos.z - t.pos.z;
    const along = ex * dirX + ez * dirZ;
    if (along < 0 || along > RANGE) continue;
    const perp = Math.sqrt(Math.max(0, (ex * ex + ez * ez) - along * along));
    if (perp / Math.max(0.5, along) > CONE_HALF) continue;
    e.hp -= DPS_BURST;
    e.hitFlash = 0.06;
    if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
      try { window.__killEnemyAtIdx(e); } catch (_) {}
    }
  }
  // Particle.
  const muzzleWorld = new THREE.Vector3();
  t.muzzle.getWorldPosition(muzzleWorld);
  _spawnFlameParticle(muzzleWorld, ang, t.accentColor);
  // Throttle audio — flame fires every 0.04s, but we only want a
  // hiss every ~6 calls so the whoosh layers softly.
  t._flameAudioCount = (t._flameAudioCount || 0) + 1;
  if (t._flameAudioCount >= 6) {
    t._flameAudioCount = 0;
    try { Audio.turretFlame(); } catch (_) {}
  }
}

// POISON — short-range cone, like flame but greener and slower-paced.
// Damage per call is moderate, but it APPLIES `_poisonedUntil` to hit
// enemies. The poison-trail infrastructure already reads this field
// in two places: getEnemySpeedMult (slows enemies) and the per-frame
// poison tick in powerups.js (residual DoT). So this turret variant
// is effectively "chip damage + persistent slow" rather than burst.
function _firePoison(t, target) {
  const RANGE = t.cfg.range;
  const CONE_HALF = 0.45;
  const PER_CALL_DAMAGE = 12;       // direct hit damage per fire tick
  const POISON_DURATION = 3.0;      // seconds of slow + DoT after spray
  const ang = t.aimYaw;
  const dirX = Math.sin(ang), dirZ = Math.cos(ang);
  const nowSec = (typeof performance !== 'undefined') ? performance.now() / 1000 : Date.now() / 1000;
  // Apply damage + poison stamp once per call to anything in cone.
  // Backwards iteration — splice safety.
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const ex = e.pos.x - t.pos.x;
    const ez = e.pos.z - t.pos.z;
    const along = ex * dirX + ez * dirZ;
    if (along < 0 || along > RANGE) continue;
    const perp = Math.sqrt(Math.max(0, (ex * ex + ez * ez) - along * along));
    if (perp / Math.max(0.5, along) > CONE_HALF) continue;
    e.hp -= PER_CALL_DAMAGE;
    e.hitFlash = 0.06;
    // Stamp poison expiry — refreshes existing poison if already
    // applied. The slow + DoT pipeline reads this field via
    // getEnemySpeedMult (powerups.js) and the poison tick.
    e._poisonedUntil = nowSec + POISON_DURATION;
    if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
      try { window.__killEnemyAtIdx(e); } catch (_) {}
    }
  }
  // Particle — green vapor cloud puff.
  const muzzleWorld = new THREE.Vector3();
  t.muzzle.getWorldPosition(muzzleWorld);
  _spawnPoisonParticle(muzzleWorld, ang, t.accentColor);
  // Throttle audio — poison fires every 0.06s, hiss every ~5 calls.
  t._poisonAudioCount = (t._poisonAudioCount || 0) + 1;
  if (t._poisonAudioCount >= 5) {
    t._poisonAudioCount = 0;
    try { Audio.turretFlame && Audio.turretFlame(); } catch (_) {}    // reuse flame hiss for now
  }
}

// Poison particle — small green cloud puff that drifts forward and
// fades. Visually distinct from the bright orange flame particle.
const _POISON_PARTICLE_GEO = new THREE.SphereGeometry(0.18, 8, 6);
function _spawnPoisonParticle(originWorld, ang, accentColor) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xaaffaa,
    emissive: accentColor,
    emissiveIntensity: 1.4,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(_POISON_PARTICLE_GEO, mat);
  mesh.position.copy(originWorld);
  scene.add(mesh);
  // Drift forward + slight rise + outward jitter, expand as it goes.
  const dirX = Math.sin(ang), dirZ = Math.cos(ang);
  const SPEED = 8 + Math.random() * 2;
  const SPREAD = (Math.random() - 0.5) * 0.6;
  const px = dirX + Math.cos(ang + Math.PI / 2) * SPREAD;
  const pz = dirZ + Math.sin(ang + Math.PI / 2) * SPREAD;
  _poisonParticles.push({
    mesh, mat,
    pos: originWorld.clone(),
    vel: new THREE.Vector3(px * SPEED, 0.6, pz * SPEED),
    life: 0,
    maxLife: 0.55 + Math.random() * 0.2,
  });
}

const _poisonParticles = [];

// =====================================================================
// TRACER FX (mg + tesla)
// =====================================================================
// Two-layer tracer: a bright white core for the bullet body and a
// chapter-tinted halo cylinder for the glow trail. Matches the mech MG
// look so player + turret fire reads as a coherent visual language.
// _MG_TRACER_GEO above provides the core geometry (0.10 radius, beefed
// up from the original 0.04). The halo geometry is allocated once here
// at module scope; both meshes share it.
const _MG_TRACER_HALO_GEO = new THREE.CylinderGeometry(0.22, 0.22, 1.0, 10);
function _spawnTracer(from, to, color, ttl) {
  const len = from.distanceTo(to);
  if (len < 0.1) return;

  // Bright white core — opaque, the visible bullet streak.
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const core = new THREE.Mesh(_MG_TRACER_GEO, coreMat);
  core.scale.set(1, len, 1);

  // Tinted halo — wider, additive, gives the soft glow trail.
  const haloMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const halo = new THREE.Mesh(_MG_TRACER_HALO_GEO, haloMat);
  halo.scale.set(1, len, 1);

  // Position both halfway between from and to, oriented along the ray.
  const mid = from.clone().lerp(to, 0.5);
  core.position.copy(mid);
  halo.position.copy(mid);
  const dir = to.clone().sub(from).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
  core.quaternion.copy(quat);
  halo.quaternion.copy(quat);
  scene.add(core);
  scene.add(halo);
  // Extend ttl slightly so the streak reads at 60fps. Original 0.06s
  // was too short — the eye barely caught it.
  const TTL = Math.max(ttl || 0.06, 0.12);
  _activeTracers.push({ mesh: core, mat: coreMat, life: 0, ttl: TTL, peakOpacity: 1.0 });
  _activeTracers.push({ mesh: halo, mat: haloMat, life: 0, ttl: TTL, peakOpacity: 0.55 });
}

function _tickTracers(dt) {
  for (let i = _activeTracers.length - 1; i >= 0; i--) {
    const t = _activeTracers[i];
    t.life += dt;
    const f = t.life / t.ttl;
    if (f >= 1) {
      if (t.mesh.parent) t.mesh.parent.remove(t.mesh);
      if (t.mat) t.mat.dispose();
      _activeTracers.splice(i, 1);
      continue;
    }
    // Each layer fades from its peakOpacity (set on push) down to 0.
    const peak = (typeof t.peakOpacity === 'number') ? t.peakOpacity : 0.85;
    t.mat.opacity = peak * (1 - f);
  }
}

// =====================================================================
// ROCKETS (antitank)
// =====================================================================
const _AT_BLAST_RADIUS = 4.0;
const _AT_BLAST_DAMAGE = 320;
const _AT_PLAYER_DAMAGE = 45;     // max player splash; falloff w/ distance

// Local player-splash helper. Mirrors mech's _splashDamagePlayer:
// gated on isPiloting + invuln, falloff with distance from epicenter.
function _splashDamagePlayerAT(epicenter, radius, maxDmg) {
  if (!player || !player.pos) return;
  if (isPiloting()) return;
  if (S.invulnTimer && S.invulnTimer > 0) return;
  const dx = player.pos.x - epicenter.x;
  const dz = player.pos.z - epicenter.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= radius) return;
  const falloff = 1 - d / radius;
  S.hp = Math.max(0, (S.hp || 0) - maxDmg * falloff);
  S.invulnTimer = Math.max(S.invulnTimer || 0, 0.20);
  if (typeof window !== 'undefined' && window.__takePlayerDamageVfx) {
    try { window.__takePlayerDamageVfx(0.30, 0.20); } catch (_) {}
  }
}

function _tickRockets(dt) {
  for (let i = _activeRockets.length - 1; i >= 0; i--) {
    const r = _activeRockets[i];
    r.pos.x += r.vel.x * dt;
    r.pos.z += r.vel.z * dt;
    r.mesh.position.copy(r.pos);
    r.life += dt;

    // Hit-test.
    let hit = null;
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying) continue;
      const dx = e.pos.x - r.pos.x;
      const dz = e.pos.z - r.pos.z;
      if (dx * dx + dz * dz < 1.4 * 1.4) {
        hit = e;
        break;
      }
    }
    if (hit || r.life >= r.maxLife) {
      // AoE detonation. Backwards iteration so the killEnemy splice
      // doesn't shift indices we haven't visited yet.
      const r2 = _AT_BLAST_RADIUS * _AT_BLAST_RADIUS;
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        if (!e || !e.pos || e.dying) continue;
        const dx = e.pos.x - r.pos.x;
        const dz = e.pos.z - r.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < r2) {
          const falloff = 1 - Math.sqrt(d2) / _AT_BLAST_RADIUS;
          e.hp -= _AT_BLAST_DAMAGE * falloff;
          e.hitFlash = 0.20;
          if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
            try { window.__killEnemyAtIdx(e); } catch (_) {}
          }
        }
      }
      // Friendly fire — player too if standing in the blast.
      _splashDamagePlayerAT(r.pos.clone(), _AT_BLAST_RADIUS, _AT_PLAYER_DAMAGE);
      hitBurst(r.pos.clone(), 0xffffff, 24);
      hitBurst(r.pos.clone(), r.accentHex, 18);
      setTimeout(() => hitBurst(r.pos.clone(), 0xffaa00, 14), 60);
      // Audio — reuse the mech rocket impact (same heavy thump
      // profile fits the AT shell).
      try { Audio.mechRocketImpact(); } catch (_) {}
      if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
      if (r.mat) r.mat.dispose();
      _activeRockets.splice(i, 1);
    }
  }
}

// =====================================================================
// FLAME PARTICLES (flame turret)
// =====================================================================
const _FLAME_PUFF_GEO = new THREE.SphereGeometry(0.18, 8, 6);
const _FLAME_TTL = 0.30;
function _spawnFlameParticle(muzzleWorld, aimYaw, accentColor) {
  const dirX = Math.sin(aimYaw), dirZ = Math.cos(aimYaw);
  const speed = 14 + Math.random() * 5;
  const spread = (Math.random() - 0.5) * 0.55;
  const sx = dirX * Math.cos(spread) - dirZ * Math.sin(spread);
  const sz = dirX * Math.sin(spread) + dirZ * Math.cos(spread);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff3a0,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(_FLAME_PUFF_GEO, mat);
  mesh.position.copy(muzzleWorld);
  scene.add(mesh);
  _activeFlames.push({
    mesh, mat,
    pos: muzzleWorld.clone(),
    vel: new THREE.Vector3(sx * speed, (Math.random() - 0.5) * 1.2, sz * speed),
    life: 0,
    accent: accentColor,
  });
}

function _tickFlames(dt) {
  for (let i = _activeFlames.length - 1; i >= 0; i--) {
    const p = _activeFlames[i];
    p.life += dt;
    const f = p.life / _FLAME_TTL;
    if (f >= 1) {
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
      if (p.mat) p.mat.dispose();
      _activeFlames.splice(i, 1);
      continue;
    }
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.pos.z += p.vel.z * dt;
    p.mesh.position.copy(p.pos);
    p.mesh.scale.setScalar(0.5 + f * 1.4);
    if (f < 0.3) p.mat.color.setHex(0xfff3a0);
    else if (f < 0.6) p.mat.color.setHex(0xffaa30);
    else p.mat.color.setHex(0xff5520);
    p.mat.opacity = 0.95 * (1 - f);
  }
}

// Poison particles — green vapor cloud puffs that drift, expand,
// and fade. Visually distinct from the orange flame particle:
// constant green tint, larger end scale, slower fade.
function _tickPoisonParticles(dt) {
  for (let i = _poisonParticles.length - 1; i >= 0; i--) {
    const p = _poisonParticles[i];
    p.life += dt;
    const f = p.life / p.maxLife;
    if (f >= 1) {
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
      if (p.mat) p.mat.dispose();
      _poisonParticles.splice(i, 1);
      continue;
    }
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt * 0.4;     // less rise than flame, hangs low
    p.pos.z += p.vel.z * dt;
    p.vel.x *= 0.92; p.vel.z *= 0.92;  // drag — clouds settle quickly
    p.mesh.position.copy(p.pos);
    // Expand from 0.5x → 1.8x as it disperses.
    p.mesh.scale.setScalar(0.5 + f * 1.3);
    // Two-stage tint: bright green start, mossy fade.
    if (f < 0.4) p.mat.color.setHex(0xaaffaa);
    else p.mat.color.setHex(0x66cc66);
    p.mat.opacity = 0.65 * (1 - f);
  }
}

// =====================================================================
// DAMAGE / DESTRUCTION
// =====================================================================
export function damageTurret(t, dmg) {
  if (!t || t.destroyed) return;
  t.hp -= dmg;
  if (t.hp <= 0) _destroyTurret(t);
}

function _destroyTurret(t) {
  t.destroyed = true;
  t.deathT = 0;
  // Big burst.
  const pos = t.pos.clone();
  pos.y = 0.8;
  hitBurst(pos, 0xffffff, 28);
  hitBurst(pos, t.accentHex, 22);
  setTimeout(() => hitBurst(pos, 0xffaa00, 18), 60);
  try { Audio.turretDestroyed(); } catch (_) {}
}

function _disposeTurret(t) {
  if (t.root.parent) scene.remove(t.root);
  // New field set introduced when the turret was rebuilt to match
  // the reference photo. Dispose every material we created on spawn.
  if (t.bodyMat) t.bodyMat.dispose();
  if (t.trimMat) t.trimMat.dispose();
  if (t.steelMat) t.steelMat.dispose();
  if (t.louverMat) t.louverMat.dispose();
  if (t.barrelMat) t.barrelMat.dispose();
  if (t.lensMat) t.lensMat.dispose();
  if (t.eyeMat) t.eyeMat.dispose();
}

// =====================================================================
// TEARDOWN
// =====================================================================
export function clearStratagemTurrets() {
  for (const t of _activeTurrets) _disposeTurret(t);
  _activeTurrets.length = 0;
  for (const tr of _activeTracers) {
    if (tr.mesh.parent) tr.mesh.parent.remove(tr.mesh);
    if (tr.mat) tr.mat.dispose();
  }
  _activeTracers.length = 0;
  for (const r of _activeRockets) {
    if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
    if (r.mat) r.mat.dispose();
  }
  _activeRockets.length = 0;
  for (const p of _activeFlames) {
    if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    if (p.mat) p.mat.dispose();
  }
  _activeFlames.length = 0;
  for (const p of _poisonParticles) {
    if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    if (p.mat) p.mat.dispose();
  }
  _poisonParticles.length = 0;
  // Hide + reset picker UI on full teardown.
  _hidePicker();
}

// =====================================================================
// VARIANT PICKER UI
// =====================================================================
// HTML/CSS panel that floats above a deployed-but-not-yet-committed
// turret. Player clicks one of MG/FIRE/POISON/TESLA to commit. Per
// playtester: "Floating 3D-ish HTML/CSS panel pinned in screen-space
// above the turret's projected position (4 icons in a row)."
//
// Strategy:
//   - Single shared DOM element (built once, lazy on first show).
//   - Each frame, find the FIRST pending turret (we only show the
//     picker for one at a time — if multiple pending turrets exist,
//     the most-recently-deployed gets focus).
//   - Project that turret's world position to screen space via
//     camera.project(); convert NDC → CSS pixel coordinates.
//   - Position the picker just above the turret's screen position.
//   - When no pending turret exists, hide the picker.
//
// Click handlers are bound once on element creation. They look up the
// currently-tracked turret and call commitTurretVariant.

let _pickerEl = null;
let _pickerForTurret = null;        // the turret the picker is currently showing for

function _ensurePickerEl() {
  if (_pickerEl) return _pickerEl;
  const el = document.createElement('div');
  el.id = 'stratagem-turret-picker';
  el.style.cssText = [
    'position: fixed',
    'left: 0', 'top: 0',                    // overridden each frame
    'transform: translate(-50%, -100%)',     // anchor = bottom-center → above turret
    'z-index: 60',                           // above HUD (~20-50), below pause (~9000)
    'display: none',
    'flex-direction: row',
    'gap: 6px',
    'padding: 8px 10px',
    'background: rgba(8, 8, 8, 0.85)',
    'border: 2px solid #ffffff',
    'border-radius: 6px',
    'box-shadow: 0 0 16px rgba(255, 255, 255, 0.2)',
    "font-family: 'Impact', 'Arial Black', sans-serif",
    'pointer-events: auto',
    'user-select: none',
    '-webkit-user-select: none',
  ].join(';');

  // Build one button per variant, in canonical pickable order.
  for (const v of VARIANT_PICKER_ORDER) {
    const btn = document.createElement('button');
    btn.dataset.variant = v.id;
    btn.title = v.label + ' — ' + v.desc;
    btn.style.cssText = [
      'min-width: 56px',
      'padding: 8px 4px',
      'background: rgba(40, 40, 40, 0.7)',
      'border: 1.5px solid #888',
      'border-radius: 4px',
      'color: #fff',
      'cursor: pointer',
      'transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'gap: 2px',
    ].join(';');
    btn.innerHTML = `
      <div style="font-size:18px;line-height:1;">${v.icon}</div>
      <div style="font-size:10px;letter-spacing:1px;">${v.label}</div>
    `;
    // Hover feedback.
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(80, 80, 80, 0.9)';
      btn.style.borderColor = '#fff';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(40, 40, 40, 0.7)';
      btn.style.borderColor = '#888';
    });
    // Commit handler — both click and touchstart so mobile responds
    // immediately without the 300ms tap delay.
    const onPick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!_pickerForTurret) return;
      try {
        commitTurretVariant(_pickerForTurret, v.id);
      } catch (err) { console.warn('[turret] commit failed', err); }
      // Hide immediately; the next frame's _tickVariantPicker will
      // search for the next pending turret and re-show if found.
      _hidePicker();
    };
    btn.addEventListener('click', onPick);
    btn.addEventListener('touchstart', onPick, { passive: false });
    el.appendChild(btn);
  }
  document.body.appendChild(el);
  _pickerEl = el;
  return el;
}

function _hidePicker() {
  if (_pickerEl) _pickerEl.style.display = 'none';
  _pickerForTurret = null;
}

function _tickVariantPicker() {
  // Find a pending turret to show the picker for. Prefer the latest
  // deployed (last in the array) since it's most likely the one the
  // player just dropped. Skip dropping-state turrets — wait until
  // they've finished their rise animation so the picker doesn't
  // pop in mid-deploy.
  let target = null;
  for (let i = _activeTurrets.length - 1; i >= 0; i--) {
    const t = _activeTurrets[i];
    if (t.pending && !t.destroyed && !t.dropping) {
      target = t;
      break;
    }
  }
  if (!target) {
    if (_pickerForTurret) _hidePicker();
    return;
  }
  const el = _ensurePickerEl();
  _pickerForTurret = target;

  // Project turret head world-pos to screen NDC. Anchor the picker
  // at head-top (~y=2.4) so it floats clearly above the turret.
  const worldPos = new THREE.Vector3(target.pos.x, 2.4, target.pos.z);
  worldPos.project(camera);
  // Behind camera? Hide.
  if (worldPos.z > 1) {
    el.style.display = 'none';
    return;
  }
  // NDC → CSS pixels.
  const screenX = (worldPos.x * 0.5 + 0.5) * window.innerWidth;
  const screenY = (-worldPos.y * 0.5 + 0.5) * window.innerHeight;
  el.style.left = screenX + 'px';
  el.style.top = (screenY - 18) + 'px';      // small gap above the head
  el.style.display = 'flex';
}
