// mech.js — Pilotable EXOSUIT mech.
//
// Spawned by the EXOSUIT stratagem. The player walks up to a deployed
// mech and presses INTERACT (E key / gamepad A) to enter. While
// piloted:
//   • Player movement input drives the mech body (slower but heavier)
//   • Aim still tracks the cursor; LMB / right-trigger fires rockets
//     in salvos
//   • Hold SHIFT (or left-trigger) to fire the heavy machine gun (a
//     fast pulsing primary weapon)
//   • SPACE / dash button — short charge dash that crushes a line of
//     enemies in front of the mech
//   • F / B button — STOMP: a downward AoE that damages anything
//     adjacent
// On HP=0 the mech explodes and the player is ejected with full HP
// at the mech's position.
//
// Public API:
//   spawnMech(pos, tint)       — drop a fresh mech at pos
//   updateMechs(dt)            — per-frame tick (drive, weapons, FX)
//   getMechs()                 — iterable for input handlers
//   findEnterableMech(playerPos)
//                              — return nearest mech if within range,
//                                or null
//   enterMech(mech)            — switch player into mech control
//   exitMech()                 — eject player from mech (manual)
//   isPiloting()               — boolean
//   getPilotedMech()           — current mech or null
//   tickPilotedMech(inputs, dt)— main.js calls this every frame while
//                                piloting; passes the WASD vector + button
//                                state. Returns the world-space position
//                                the player.pos should be synced to.
//   damagePilotedMech(dmg)     — damage applied to currently-piloted mech
//   clearMechs()               — wipe all (game reset)

import * as THREE from 'three';
import { scene } from './scene.js';
import { hitBurst } from './effects.js';
import { enemies, applyKnockback } from './enemies.js';
import { Audio } from './audio.js';
import { S } from './state.js';
import { player } from './player.js';

// =====================================================================
// TUNING
// =====================================================================
const MECH_HP_MAX        = 600;
const MECH_SPEED         = 6.0;        // slightly slower than player
const MECH_DASH_SPEED    = 22.0;
const MECH_DASH_DUR      = 0.35;
const MECH_DASH_COOLDOWN = 2.2;
const MECH_STOMP_RADIUS  = 5.5;
const MECH_STOMP_DAMAGE  = 250;
const MECH_STOMP_COOLDOWN= 1.6;
const MECH_ROCKET_SPEED  = 38.0;
const MECH_ROCKET_DAMAGE = 220;
const MECH_ROCKET_RADIUS = 4.0;
const MECH_ROCKET_INTERVAL = 0.20;     // seconds between rockets in a salvo
const MECH_ROCKET_SALVO  = 4;          // rockets per LMB press
const MECH_MG_INTERVAL   = 0.08;       // seconds between MG pulses
const MECH_MG_DAMAGE     = 22;
const MECH_MG_RANGE      = 28.0;
const MECH_ENTER_RANGE   = 2.8;        // walk this close to enter

// AMMO CAPACITY (per playtester request: "add ammo capacity to turrets
// / mech - once used the turrets and mechs disappear instead of
// despawning after a timer or taking damage").
//
// Each mech variant has its own ammo pool. Every fire of the primary
// or secondary weapon decrements ammo by 1. When ammo hits 0 the mech
// auto-destroys (same death path as taking too much damage), which
// re-shows the player avatar and applies the eject splash. HP-based
// destruction still works as a backup for "the mech got swarmed and
// died early," but in normal play players will hit the ammo wall
// before they hit the HP wall.
//
// Counts are tuned so a piloted mech does meaningful work but is
// FINITE. Approximate uptime under sustained primary fire:
//   minigun  - 200 MG pulses   × 0.08s = ~16s
//   rocket   -  35 rockets     × 0.18s = ~6s burst, ~10s with breaks
//   flame    - 250 flame ticks × 0.04s = ~10s
//
// Secondary fire (rocket salvos for minigun, big salvos for rocket,
// napalm grenades for flame) ALSO decrements from this pool, so a
// player who burns secondary fire trades primary uptime for it. This
// mirrors how Helldivers exo-suits work.
const MECH_AMMO_BY_VARIANT = {
  minigun: 200,
  rocket:   35,
  flame:   250,
};
const MECH_PILOT_RADIUS  = 1.8;        // collision radius while piloting
const MECH_RISE_DEPTH    = 7.0;        // mechs start buried this deep (sized for tall MAV-ULB silhouette)
const MECH_RISE_DURATION = 1.20;       // seconds of rise animation
// Legacy aliases — code paths elsewhere reference DROP_HEIGHT /
// DROP_DURATION; keep names in sync so I don't have to rename
// references through the file.
const MECH_DROP_HEIGHT   = MECH_RISE_DEPTH;
const MECH_DROP_DURATION = MECH_RISE_DURATION;

// =====================================================================
// PLAYER FRIENDLY-FIRE HELPER
// =====================================================================
// Stratagem explosions hurt the player too. We respect invuln timer
// so dashes / overdrive still grant safety, AND we skip damage when
// the player is currently piloting a mech (the mech body absorbs).
// dmg falls off linearly with distance from the epicenter.
function _splashDamagePlayer(epicenter, radius, maxDmg) {
  if (!player || !player.pos) return;
  // Piloted? Mech takes the hit instead — and we already model that
  // via MECH_BODY_RADIUS proximity in main.js, so just bail.
  if (_pilotedMech) return;
  // Invulnerable?
  if (S.invulnTimer && S.invulnTimer > 0) return;
  const dx = player.pos.x - epicenter.x;
  const dz = player.pos.z - epicenter.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= radius) return;
  const falloff = 1 - d / radius;
  const dmg = maxDmg * falloff;
  S.hp = Math.max(0, (S.hp || 0) - dmg);
  // Brief invuln + flash hint so a single explosion doesn't double-tap.
  S.invulnTimer = Math.max(S.invulnTimer || 0, 0.20);
  if (typeof window !== 'undefined' && window.__takePlayerDamageVfx) {
    try { window.__takePlayerDamageVfx(0.30, 0.20); } catch (_) {}
  }
}

// =====================================================================
// SHARED GEOMETRY
// =====================================================================
// ---- LEGS (reverse-knee bipedal stance, MAV-ULB style) ----
// Thigh segment (mounts to hip, angled back). Shin segment (angled
// forward from knee). Foot claw at the bottom. Knee bulb covers the
// joint. Reverse-knee silhouette is built by tilting thigh + shin
// the opposite way and offsetting the knee forward of the hip.
const _THIGH_GEO       = new THREE.BoxGeometry(0.55, 1.10, 0.70);
const _THIGH_PLATE_GEO = new THREE.BoxGeometry(0.65, 1.05, 0.20);   // armor plate strapped to thigh face
const _KNEE_GEO        = new THREE.SphereGeometry(0.42, 12, 10);
const _SHIN_GEO        = new THREE.BoxGeometry(0.45, 1.20, 0.50);
const _SHIN_PLATE_GEO  = new THREE.BoxGeometry(0.55, 1.10, 0.18);
const _FOOT_TOE_GEO    = new THREE.BoxGeometry(0.20, 0.30, 0.45);   // clawed toes
// Legacy aliases — old code refers to _LEG_GEO; we leave them in
// place so we can keep the variant builder + walk animation hooks
// working unmodified. New leg group construction uses the segments
// above; legacy is kept as fallback only.
const _LEG_GEO       = new THREE.BoxGeometry(0.6, 1.6, 0.6);
const _FOOT_GEO      = new THREE.BoxGeometry(0.85, 0.20, 1.20);

// ---- HIP / TORSO / COCKPIT ----
// Wide armored hull with side vents and a "sensor" cyclops port up
// front. Cockpit canopy on top.
const _HIP_GEO       = new THREE.BoxGeometry(2.50, 0.55, 1.20);
const _TORSO_GEO     = new THREE.BoxGeometry(2.30, 1.50, 1.80);
const _TORSO_FACE_GEO = new THREE.BoxGeometry(1.60, 0.85, 0.10);    // front-face inset panel
const _SIDE_VENT_GEO = new THREE.BoxGeometry(0.10, 0.16, 0.55);     // rectangle vent slats
const _SENSOR_PORT_GEO = new THREE.CylinderGeometry(0.22, 0.22, 0.08, 16);
const _SENSOR_LENS_GEO = new THREE.CircleGeometry(0.16, 16);
const _COCKPIT_GEO       = new THREE.BoxGeometry(1.40, 0.55, 1.40);
const _COCKPIT_GLASS_GEO = new THREE.BoxGeometry(1.30, 0.32, 0.05);

// ---- SHOULDERS / PAULDRONS ----
// Wide angular pauldron block on each side of the torso. Each has a
// small mounted box on top (read as a sensor / floodlight pod) plus
// a short antenna sticking up. Photo shows pauldrons that are about
// as deep as the torso and slightly taller than the cockpit.
const _PAULDRON_GEO         = new THREE.BoxGeometry(1.10, 1.00, 1.50);
const _PAULDRON_TOP_GEO     = new THREE.BoxGeometry(0.55, 0.30, 0.85);
const _PAULDRON_ANTENNA_GEO = new THREE.CylinderGeometry(0.04, 0.04, 0.55, 6);
const _ARM_GEO       = new THREE.BoxGeometry(0.4, 1.4, 0.4);
const _SHOULDER_GEO  = new THREE.SphereGeometry(0.45, 12, 8);

// ---- TOP MAST + ANTENNA ----
// Tall articulated mast rising from the centerline behind the
// cockpit. Photo shows a base block, vertical pole, and a glowing
// blue strip near the top.
const _MAST_BASE_GEO  = new THREE.BoxGeometry(0.30, 0.30, 0.30);
const _MAST_POLE_GEO  = new THREE.CylinderGeometry(0.05, 0.05, 1.30, 8);
const _MAST_LIGHT_GEO = new THREE.BoxGeometry(0.16, 0.40, 0.06);

// Right shoulder: missile pod (visible cluster of rocket tubes).
const _MISSILE_POD_GEO = new THREE.BoxGeometry(1.0, 0.7, 1.4);
const _MISSILE_TUBE_GEO = new THREE.CylinderGeometry(0.10, 0.10, 1.2, 8);
// Left arm: heavy MG barrel.
const _MG_BARREL_GEO  = new THREE.CylinderGeometry(0.16, 0.16, 1.6, 12);
const _MG_HOUSING_GEO = new THREE.BoxGeometry(0.6, 0.6, 0.9);
// Rocket projectile.
const _ROCKET_GEO    = new THREE.CylinderGeometry(0.08, 0.12, 0.8, 8);
// MG tracer — beefed-up two-layer cylinder pair. The previous single
// 0.04-radius cylinder was almost invisible against busy backgrounds
// and disappeared in 0.07s. New design: a bright core (0.10 radius)
// for the bullet's body, plus a translucent halo (0.22 radius) layered
// outside for the glow trail. Both share the same length so they
// scale together. Lifetime extended to 0.14s so the eye actually
// catches the streak.
const _TRACER_CORE_GEO  = new THREE.CylinderGeometry(0.10, 0.10, 1.0, 8);
const _TRACER_HALO_GEO  = new THREE.CylinderGeometry(0.22, 0.22, 1.0, 10);
// Round muzzle-flash sprite — kept around so we don't reallocate per
// shot. Spawned at the firing origin for the brief flash that reads
// as "the gun just fired" before the tracer streaks out.
const _MUZZLE_FLASH_GEO = new THREE.SphereGeometry(0.28, 10, 8);
// Legacy alias — preserved so any other code paths that referenced
// _TRACER_GEO compile. Visual mass matches the new core.
const _TRACER_GEO    = _TRACER_CORE_GEO;

const _activeMechs = [];

// Mech variant catalog. Each entry describes which weapons appear on
// the left and right arms and which fire-mode functions are bound to
// the primary/secondary trigger inputs.
//
//   id          — variant id, also displayed in the picker UI
//   label       — short label
//   icon        — single-char shorthand
//   buildLeft   — function(armGroup, mats) — populates left arm
//   buildRight  — function(armGroup, mats) — populates right arm
//   onPrimary   — function(mech, dt)       — called every frame while
//                                             firePrimary input is held
//   onSecondary — function(mech)           — called once on rising
//                                             edge of fireSecondary
const _MECH_VARIANTS = {
  minigun: {
    id: 'minigun',
    label: 'MINIGUN',
    icon: '⚡',
  },
  rocket: {
    id: 'rocket',
    label: 'ROCKET',
    icon: '☄',
  },
  flame: {
    id: 'flame',
    label: 'FLAME',
    icon: '🔥',
  },
};
// Default variant if none specified — minigun (closest to the
// previous "default mech" behavior).
const _DEFAULT_VARIANT = 'minigun';

// =====================================================================
// SPAWN
// =====================================================================
export function spawnMech(pos, tint, variantId) {
  const variant = _MECH_VARIANTS[variantId] || _MECH_VARIANTS[_DEFAULT_VARIANT];
  const root = new THREE.Group();
  // Spawn buried below the ground; tickMechRise animates Y up to 0
  // over MECH_RISE_DURATION. Reads as the mech busting up through
  // the floor, like a Helldivers-style underground deployment pod.
  root.position.set(pos.x, -MECH_RISE_DEPTH, pos.z);

  const tintColor = new THREE.Color(tint || 0xff5520);
  // MAV-ULB military palette — darker olive-grey hull with steel
  // trim. We keep an emissive tint hint so chapter color still bleeds
  // through (matches the rest of the stratagem suite's light-tint
  // policy) but the body itself is uniformly military, not chapter-
  // tinted hull paint.
  const HULL_COLOR  = 0x4d534b;        // dark olive-grey
  const TRIM_COLOR  = 0x2c2e30;        // near-black trim
  const STEEL_COLOR = 0x6b6e71;        // raised armor highlight
  const hullMat = new THREE.MeshStandardMaterial({
    color: HULL_COLOR,
    emissive: tintColor,
    emissiveIntensity: 0.10,
    roughness: 0.55,
    metalness: 0.70,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: TRIM_COLOR,
    emissive: tintColor,
    emissiveIntensity: 0.20,
    roughness: 0.60,
    metalness: 0.55,
  });
  const steelMat = new THREE.MeshStandardMaterial({
    color: STEEL_COLOR,
    roughness: 0.45,
    metalness: 0.85,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tintColor,
    emissiveIntensity: 1.6,
    transparent: true,
    opacity: 0.75,
    roughness: 0.20,
  });
  const accentMat = new THREE.MeshBasicMaterial({
    color: tintColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  // Bright red sensor lens (always red on the MAV-ULB regardless of
  // chapter tint — reads as the cyclops eye).
  const lensMat = new THREE.MeshBasicMaterial({
    color: 0xff3030,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  // Mast indicator strip — chapter-tinted blue-ish glow.
  const mastLightMat = new THREE.MeshBasicMaterial({
    color: 0x60c8ff,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  // ---- LEGS (reverse-knee bipedal) ----
  // Each leg is a Group rotating from the hip joint. Inside the
  // group: thigh segment (angled back) → knee bulb → shin segment
  // (angled forward) → foot plate + toe claw. The walk-cycle code
  // rotates legL.rotation.x and legR.rotation.x; that hinges the
  // entire leg from the hip, which still reads correctly with the
  // new segmented build.
  function _buildLeg(side) {
    const leg = new THREE.Group();
    // Thigh — angled slightly back (negative pitch). Position the
    // mesh so the rotation pivot is the top of the thigh.
    const thigh = new THREE.Mesh(_THIGH_GEO, hullMat);
    thigh.position.y = -0.55;
    thigh.rotation.x = -0.20;       // angled back from hip
    leg.add(thigh);
    // Thigh side-armor plate, with chapter-tinted accent strip on
    // top edge for MAV-ULB caution-stripe feel.
    const thighPlate = new THREE.Mesh(_THIGH_PLATE_GEO, steelMat);
    thighPlate.position.set(side * 0.30, -0.55, 0.05);
    thighPlate.rotation.x = -0.20;
    leg.add(thighPlate);
    // Knee bulb — sits at the bend point. Offset forward so the bend
    // is visibly in front of the hip line (reverse-knee silhouette).
    const knee = new THREE.Mesh(_KNEE_GEO, trimMat);
    knee.position.set(0, -1.10, 0.30);
    leg.add(knee);
    // Shin — angled forward (positive pitch) so it leans back
    // toward the foot, matching the bird-leg stance.
    const shin = new THREE.Mesh(_SHIN_GEO, hullMat);
    shin.position.set(0, -1.78, 0.10);
    shin.rotation.x = 0.18;
    leg.add(shin);
    const shinPlate = new THREE.Mesh(_SHIN_PLATE_GEO, steelMat);
    shinPlate.position.set(side * 0.22, -1.78, 0.22);
    shinPlate.rotation.x = 0.18;
    leg.add(shinPlate);
    // Foot — flat plate the mech stands on.
    const foot = new THREE.Mesh(_FOOT_GEO, trimMat);
    foot.position.set(0, -2.30, 0.20);
    leg.add(foot);
    // Toe claws — three small boxes at the front of the foot.
    for (const offX of [-0.30, 0, 0.30]) {
      const toe = new THREE.Mesh(_FOOT_TOE_GEO, trimMat);
      toe.position.set(offX, -2.32, 0.55);
      leg.add(toe);
    }
    return leg;
  }
  const legL = _buildLeg(-1);
  legL.position.set(-0.65, 2.30, 0);
  root.add(legL);
  const legR = _buildLeg(1);
  legR.position.set(0.65, 2.30, 0);
  root.add(legR);

  // ---- HIP ----
  // Wide angular block sitting between the legs.
  const hip = new THREE.Mesh(_HIP_GEO, trimMat);
  hip.position.y = 2.45;
  root.add(hip);
  // Hip armor lip (small step on top of the hip).
  const hipLip = new THREE.Mesh(
    new THREE.BoxGeometry(2.30, 0.20, 1.05),
    steelMat,
  );
  hipLip.position.y = 2.78;
  root.add(hipLip);

  // ---- TORSO ----
  // Torso sits above the hip and rotates independently (aim group).
  const torso = new THREE.Group();
  torso.position.y = 3.70;
  root.add(torso);

  const torsoMesh = new THREE.Mesh(_TORSO_GEO, hullMat);
  torso.add(torsoMesh);

  // Front-face inset panel — recessed plate that reads as the
  // "MARINES 524" badge on the photo. Just visual; no text.
  const torsoFace = new THREE.Mesh(_TORSO_FACE_GEO, trimMat);
  torsoFace.position.set(0, 0.10, 0.91);
  torso.add(torsoFace);

  // Cyclops sensor port on the front-center of the torso.
  const sensorRing = new THREE.Mesh(_SENSOR_PORT_GEO, steelMat);
  sensorRing.rotation.x = Math.PI / 2;     // face forward
  sensorRing.position.set(0, 0.10, 0.93);
  torso.add(sensorRing);
  const sensorLens = new THREE.Mesh(_SENSOR_LENS_GEO, lensMat);
  sensorLens.position.set(0, 0.10, 0.97);
  torso.add(sensorLens);

  // Side cooling vents — 3 horizontal slats per side.
  for (const sx of [-1.16, 1.16]) {
    for (let j = 0; j < 3; j++) {
      const vent = new THREE.Mesh(_SIDE_VENT_GEO, trimMat);
      vent.position.set(sx, 0.10 + (j - 1) * 0.22, 0.45);
      torso.add(vent);
    }
  }

  // Cockpit canopy (smaller now — pauldrons make the silhouette).
  const cockpit = new THREE.Mesh(_COCKPIT_GEO, trimMat);
  cockpit.position.set(0, 1.05, 0.0);
  torso.add(cockpit);
  const glass = new THREE.Mesh(_COCKPIT_GLASS_GEO, glassMat);
  glass.position.set(0, 1.10, 0.71);
  torso.add(glass);

  // ---- TOP MAST ----
  // Tall vertical pole rising from the back-center of the torso roof.
  const mastBase = new THREE.Mesh(_MAST_BASE_GEO, trimMat);
  mastBase.position.set(0, 1.35, -0.40);
  torso.add(mastBase);
  const mastPole = new THREE.Mesh(_MAST_POLE_GEO, steelMat);
  mastPole.position.set(0, 2.15, -0.40);
  torso.add(mastPole);
  const mastLight = new THREE.Mesh(_MAST_LIGHT_GEO, mastLightMat);
  mastLight.position.set(0, 2.65, -0.40);
  torso.add(mastLight);

  // ---- PAULDRONS (wide angular shoulder blocks) ----
  // Photo shows pauldrons sitting outboard of the torso, taller than
  // the cockpit but slightly forward-set. Each has a sensor / light
  // box mounted on top + a small antenna.
  function _buildPauldron(side) {
    const pauldron = new THREE.Group();
    const block = new THREE.Mesh(_PAULDRON_GEO, hullMat);
    pauldron.add(block);
    // Top-mounted sensor / floodlight box.
    const top = new THREE.Mesh(_PAULDRON_TOP_GEO, trimMat);
    top.position.set(0, 0.65, 0);
    pauldron.add(top);
    // Front-facing flood lens on the top box.
    const flood = new THREE.Mesh(
      new THREE.CircleGeometry(0.10, 12),
      mastLightMat,
    );
    flood.position.set(0, 0.65, 0.43);
    pauldron.add(flood);
    // Short antenna sticking up from the back-inner corner.
    const ant = new THREE.Mesh(_PAULDRON_ANTENNA_GEO, steelMat);
    ant.position.set(side * -0.18, 1.05, -0.30);
    pauldron.add(ant);
    // Side armor plate facing outward.
    const sidePlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.85, 1.20),
      steelMat,
    );
    sidePlate.position.set(side * 0.58, -0.10, 0);
    pauldron.add(sidePlate);
    return pauldron;
  }
  const pauldronL = _buildPauldron(-1);
  pauldronL.position.set(-1.30, 0.20, 0);
  torso.add(pauldronL);
  const pauldronR = _buildPauldron(1);
  pauldronR.position.set(1.30, 0.20, 0);
  torso.add(pauldronR);

  // ---- ARMS ----
  // Arms hang off the bottom-outer corners of the pauldrons. Variant
  // builders attach the variant-specific weapon / hand under the arm
  // group.
  const armL = new THREE.Group();
  armL.position.set(-1.55, -0.20, 0);
  torso.add(armL);
  const armLMesh = new THREE.Mesh(_ARM_GEO, trimMat);
  armL.add(armLMesh);

  const armR = new THREE.Group();
  armR.position.set(1.55, -0.20, 0);
  torso.add(armR);
  const armRMesh = new THREE.Mesh(_ARM_GEO, trimMat);
  armR.add(armRMesh);

  // Build variant-specific arm content. Each builder returns
  // { primaryMuzzle, secondaryMuzzle } — Groups whose getWorldPosition
  // gives the world-space fire origin for primary/secondary weapons.
  const armBuild = _buildArmsForVariant(variant, armL, armR, hullMat, trimMat, tintColor);
  const mgMuzzle = armBuild.primaryMuzzle;
  const rocketMuzzle = armBuild.secondaryMuzzle;
  // Spinning minigun barrel cluster (only the minigun variant uses
  // this; null for others). Updated every frame while firing.
  const minigunBarrels = armBuild.minigunBarrels || null;

  // ---- ENTER PROMPT ----
  // Floating sprite above the mech that says "PRESS E TO ENTER" when
  // the player is in range. Hidden by default.
  const promptCanvas = document.createElement('canvas');
  promptCanvas.width = 256; promptCanvas.height = 64;
  const promptCtx = promptCanvas.getContext('2d');
  promptCtx.font = 'bold 22px Impact, monospace';
  promptCtx.textAlign = 'center';
  promptCtx.textBaseline = 'middle';
  promptCtx.fillStyle = '#ffd93d';
  promptCtx.shadowColor = '#000';
  promptCtx.shadowBlur = 8;
  promptCtx.fillText('▶ PRESS E TO ENTER', 128, 32);
  const promptTex = new THREE.CanvasTexture(promptCanvas);
  const promptMat = new THREE.SpriteMaterial({
    map: promptTex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
  });
  const prompt = new THREE.Sprite(promptMat);
  prompt.scale.set(3.6, 0.9, 1);
  prompt.position.y = 7.4;
  prompt.visible = false;
  root.add(prompt);

  scene.add(root);

  const mech = {
    root, torso,
    legL, legR,
    armL, armR,
    mgMuzzle, rocketMuzzle,
    minigunBarrels,
    glass, glassMat,
    hullMat, trimMat, accentMat,
    prompt,
    tint, tintColor,
    variant: variant.id,
    hp: MECH_HP_MAX, hpMax: MECH_HP_MAX,
    // Ammo — drained by every primary or secondary fire. When 0 the
    // mech auto-destroys via _destroyMech, which ejects the pilot
    // and re-shows the player avatar. Per-variant pool selected from
    // MECH_AMMO_BY_VARIANT; flame and minigun get larger pools to
    // match their shorter per-shot cost.
    ammo: MECH_AMMO_BY_VARIANT[variant.id] || 100,
    ammoMax: MECH_AMMO_BY_VARIANT[variant.id] || 100,
    pos: new THREE.Vector3(pos.x, 0, pos.z),
    facing: 0,
    // Aim target — set by tickPilotedMech every frame from the cursor
    // direction. m.facing rotates toward this at MECH_TORSO_TURN_SPEED.
    // null while the mech is unpiloted (idles facing forward).
    aimTargetAng: null,
    walkPhase: 0,
    // Drop animation
    dropping: true,
    dropT: 0,
    // Combat state
    rocketSalvoLeft: 0,
    rocketSalvoTimer: 0,
    rocketTargetWorld: new THREE.Vector3(),
    mgFiring: false,
    mgTimer: 0,
    dashLeft: 0, dashCooldown: 0, dashDir: new THREE.Vector3(),
    stompCooldown: 0,
    // Active rocket projectiles
    rockets: [],
    // Active MG tracers
    tracers: [],
    // Flame state — only used by 'flame' variant
    flameParticles: [],
    flameLastFireT: 0,
    napalmCooldown: 0,
    minigunSpinAngle: 0,
    destroyed: false,
    deathT: 0,
  };
  _activeMechs.push(mech);
  return mech;
}

// =====================================================================
// VARIANT ARM BUILDERS
// =====================================================================
// Each builder mounts arm content under armL / armR and returns
// { primaryMuzzle, secondaryMuzzle, [minigunBarrels] }.
//
// MINIGUN: 6-barrel rotating cluster on the LEFT arm (replaces single
// MG barrel). Right arm keeps the missile pod for secondary fire.
//
// ROCKET: BOTH arms get missile pods. Primary = single rocket from
// alternating arms; secondary = full salvo from both pods.
//
// FLAME: Left arm gets a flame nozzle (continuous DoT cone). Right
// arm gets a fuel tank + napalm grenade launcher (secondary).

function _buildArmsForVariant(variant, armL, armR, hullMat, trimMat, tintColor) {
  if (variant.id === 'minigun') {
    return _buildArmsMinigun(armL, armR, hullMat, trimMat, tintColor);
  }
  if (variant.id === 'rocket') {
    return _buildArmsRocket(armL, armR, hullMat, trimMat, tintColor);
  }
  if (variant.id === 'flame') {
    return _buildArmsFlame(armL, armR, hullMat, trimMat, tintColor);
  }
  // Fallback: minigun.
  return _buildArmsMinigun(armL, armR, hullMat, trimMat, tintColor);
}

// ----- MINIGUN VARIANT -----
// Left arm: 6-barrel rotating cluster. Right arm: missile pod (kept
// for secondary fire).
const _MINIGUN_BARREL_GEO = new THREE.CylinderGeometry(0.07, 0.07, 1.4, 8);
const _MINIGUN_HUB_GEO    = new THREE.CylinderGeometry(0.32, 0.32, 0.20, 12);
function _buildArmsMinigun(armL, armR, hullMat, trimMat, tintColor) {
  // Left: minigun cluster.
  const housing = new THREE.Mesh(_MG_HOUSING_GEO, trimMat);
  housing.position.set(0, -1.0, 0.2);
  armL.add(housing);
  // Hub at the front of the housing — barrels rotate around it.
  const hub = new THREE.Group();
  hub.position.set(0, -1.0, 1.0);
  armL.add(hub);
  const hubMesh = new THREE.Mesh(_MINIGUN_HUB_GEO, trimMat);
  hubMesh.rotation.x = Math.PI / 2;
  hub.add(hubMesh);
  // 6 barrels around the hub at radius 0.18.
  const barrelCluster = new THREE.Group();
  hub.add(barrelCluster);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const barrel = new THREE.Mesh(_MINIGUN_BARREL_GEO, trimMat);
    barrel.position.set(Math.cos(a) * 0.18, Math.sin(a) * 0.18, 0.7);
    barrel.rotation.x = Math.PI / 2;
    barrelCluster.add(barrel);
  }
  const muzzle = new THREE.Group();
  muzzle.position.set(0, -1.0, 1.9);
  armL.add(muzzle);

  // Hanging ammo belt — chain of small linked boxes drooping from
  // the housing rear-bottom toward the floor, then curving back up
  // into a feed slot on the housing. 8 links along a sag curve.
  // Matches the conspicuous brass-belt detail on the MAV-ULB photo.
  {
    const beltMat = new THREE.MeshStandardMaterial({
      color: 0xb29548,        // brass / dark gold
      roughness: 0.55,
      metalness: 0.85,
    });
    const linkGeo = new THREE.BoxGeometry(0.08, 0.10, 0.05);
    const N = 8;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);          // 0..1
      // Sag curve: starts at housing rear (z=-0.20, y=-1.0), drops
      // to bottom of the sag at (z=0.0, y=-1.85), curves back to a
      // feed inlet on the side (z=0.20, y=-1.05).
      const z = -0.20 + t * 0.40;
      const sag = -Math.sin(t * Math.PI) * 0.85;
      const y = -1.05 + sag;
      const x = 0.32;                // outboard side of the housing
      const link = new THREE.Mesh(linkGeo, beltMat);
      link.position.set(x, y, z);
      // Rotate link so it tilts along the curve direction.
      const ang = -Math.cos(t * Math.PI) * 0.45;
      link.rotation.x = ang;
      armL.add(link);
    }
  }

  // Right: same missile pod as before.
  const pod = new THREE.Mesh(_MISSILE_POD_GEO, trimMat);
  pod.position.set(0, -1.0, 0.3);
  armR.add(pod);
  const tubeOffsets = [
    [-0.25,  0.18], [ 0.25,  0.18],
    [-0.25, -0.18], [ 0.25, -0.18],
  ];
  for (const [tx, ty] of tubeOffsets) {
    const tube = new THREE.Mesh(_MISSILE_TUBE_GEO, hullMat);
    tube.position.set(tx, -1.0 + ty, 1.0);
    tube.rotation.x = Math.PI / 2;
    armR.add(tube);
  }
  const rMuzzle = new THREE.Group();
  rMuzzle.position.set(0, -1.0, 1.6);
  armR.add(rMuzzle);

  return { primaryMuzzle: muzzle, secondaryMuzzle: rMuzzle, minigunBarrels: barrelCluster };
}

// ----- ROCKET VARIANT -----
// Both arms have missile pods. Primary = single rocket, alternating
// arms; secondary = full 8-rocket salvo from both pods.
function _buildArmsRocket(armL, armR, hullMat, trimMat, tintColor) {
  const tubeOffsets = [
    [-0.25,  0.18], [ 0.25,  0.18],
    [-0.25, -0.18], [ 0.25, -0.18],
  ];
  for (const arm of [armL, armR]) {
    const pod = new THREE.Mesh(_MISSILE_POD_GEO, trimMat);
    pod.position.set(0, -1.0, 0.3);
    arm.add(pod);
    for (const [tx, ty] of tubeOffsets) {
      const tube = new THREE.Mesh(_MISSILE_TUBE_GEO, hullMat);
      tube.position.set(tx, -1.0 + ty, 1.0);
      tube.rotation.x = Math.PI / 2;
      arm.add(tube);
    }
  }
  const lMuz = new THREE.Group(); lMuz.position.set(0, -1.0, 1.6); armL.add(lMuz);
  const rMuz = new THREE.Group(); rMuz.position.set(0, -1.0, 1.6); armR.add(rMuz);
  // Primary uses lMuz; secondary uses both (we pass rMuz; salvo code
  // alternates internally). Keep both refs accessible via mech.armL/armR.
  return { primaryMuzzle: lMuz, secondaryMuzzle: rMuz };
}

// ----- FLAME VARIANT -----
// Left arm: flame nozzle. Right arm: fuel tank + napalm launcher.
const _FLAME_NOZZLE_GEO  = new THREE.ConeGeometry(0.30, 0.55, 12);
const _FUEL_TANK_GEO     = new THREE.CylinderGeometry(0.40, 0.40, 1.10, 14);
const _NAPALM_TUBE_GEO   = new THREE.CylinderGeometry(0.18, 0.20, 0.85, 10);
function _buildArmsFlame(armL, armR, hullMat, trimMat, tintColor) {
  // Left: nozzle.
  const housing = new THREE.Mesh(_MG_HOUSING_GEO, trimMat);
  housing.position.set(0, -1.0, 0.2);
  armL.add(housing);
  const nozzle = new THREE.Mesh(_FLAME_NOZZLE_GEO, trimMat);
  nozzle.position.set(0, -1.0, 1.0);
  nozzle.rotation.x = Math.PI / 2;
  armL.add(nozzle);
  // Glowing tip — additive sphere at the nozzle exit so the flame
  // arm reads as "always lit pilot light" even when not firing.
  const pilot = new THREE.Mesh(new THREE.SphereGeometry(0.10, 10, 8), new THREE.MeshBasicMaterial({
    color: 0xff5520, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  pilot.position.set(0, -1.0, 1.4);
  armL.add(pilot);
  const muzzle = new THREE.Group();
  muzzle.position.set(0, -1.0, 1.4);
  armL.add(muzzle);

  // Right: fuel tank + napalm tube.
  const tank = new THREE.Mesh(_FUEL_TANK_GEO, trimMat);
  tank.position.set(0, -1.0, 0.0);
  tank.rotation.x = Math.PI / 2;
  armR.add(tank);
  const napalmTube = new THREE.Mesh(_NAPALM_TUBE_GEO, hullMat);
  napalmTube.position.set(0, -1.0, 0.9);
  napalmTube.rotation.x = Math.PI / 2;
  armR.add(napalmTube);
  const rMuzzle = new THREE.Group();
  rMuzzle.position.set(0, -1.0, 1.4);
  armR.add(rMuzzle);

  return { primaryMuzzle: muzzle, secondaryMuzzle: rMuzzle };
}

// =====================================================================
// PER-FRAME UPDATE
// =====================================================================
export function updateMechs(dt) {
  for (let i = _activeMechs.length - 1; i >= 0; i--) {
    const m = _activeMechs[i];

    // Rise animation — Y ascends from -MECH_RISE_DEPTH to 0 over
    // MECH_RISE_DURATION with an ease-out so the mech feels like
    // it's bursting out of the ground rather than levitating up.
    // Plays a deep servo whir on start and a heavy thud + dust ring
    // on landing.
    if (m.dropping) {
      if (!m._riseAudioFired) {
        m._riseAudioFired = true;
        try { Audio.mechRise(); } catch (_) {}
        // Initial dirt burst at ground level.
        const gp = new THREE.Vector3(m.pos.x, 0, m.pos.z);
        hitBurst(gp, 0x8a6a44, 22);
        hitBurst(gp, 0x4a3422, 14);
        _spawnRiseDustRing(m);
      }
      m.dropT += dt;
      const f = Math.min(1, m.dropT / MECH_RISE_DURATION);
      // Ease-out: starts fast then settles. Looks more like emerging
      // through dirt with weight to it.
      const eased = 1 - Math.pow(1 - f, 2.4);
      m.root.position.y = -MECH_RISE_DEPTH * (1 - eased);
      // Periodic dust puffs as the mech rises through the floor.
      m._dustT = (m._dustT || 0) + dt;
      if (m._dustT > 0.10 && f < 0.85) {
        m._dustT = 0;
        const gp = new THREE.Vector3(m.pos.x, 0.05, m.pos.z);
        hitBurst(gp, 0x8a6a44, 6);
      }
      if (f >= 1) {
        m.dropping = false;
        m.root.position.y = 0;
        // Landing impact burst + heavy thud.
        hitBurst(m.root.position.clone(), m.tint, 30);
        hitBurst(m.root.position.clone(), 0xffffff, 18);
        try { Audio.mechLand(); } catch (_) {}
      }
    }

    // Rocket projectile tick (always — even when piloted).
    _tickMechRockets(m, dt);
    _tickMechTracers(m, dt);
    _tickMechFlame(m, dt);

    // Cooldown countdowns.
    if (m.dashCooldown > 0) m.dashCooldown -= dt;
    if (m.stompCooldown > 0) m.stompCooldown -= dt;
    if (m.dashLeft > 0) m.dashLeft = Math.max(0, m.dashLeft - dt);
    if (m.napalmCooldown > 0) m.napalmCooldown -= dt;

    // Salvo timer — fires queued rockets on interval (whether piloted
    // or not; we'll just stop queueing when not piloted). Each rocket
    // recomputes the firing target from the LIVE m.facing — without
    // this, the salvo locks in the angle at request time and rockets
    // 2/3/4 fly toward where the mech WAS pointing, even as the
    // player has already started turning. Refreshing per-shot keeps
    // the salvo fanning out forward of the current torso heading.
    if (m.rocketSalvoLeft > 0) {
      m.rocketSalvoTimer -= dt;
      if (m.rocketSalvoTimer <= 0) {
        const ang = m.facing;
        m.rocketTargetWorld.set(
          m.pos.x + Math.sin(ang) * 50,
          1.5,
          m.pos.z + Math.cos(ang) * 50,
        );
        if (_consumeMechAmmo(m)) {
          _fireMechRocket(m, m.rocketTargetWorld);
        } else {
          // Out of ammo — abort the rest of the salvo. _destroyMech
          // already fired from the helper.
          m.rocketSalvoLeft = 0;
        }
        m.rocketSalvoLeft -= 1;
        m.rocketSalvoTimer = MECH_ROCKET_INTERVAL;
      }
    }

    // MG continuous fire — fires while flag is on (piloted ticks set it).
    // Each pulse consumes one ammo; running dry triggers _destroyMech
    // via the helper. The interval reset still happens so a brief
    // out-of-ammo window doesn't dump a frame-buffer of pulses on
    // refill (there's no refill, but defensive).
    if (m.mgFiring) {
      m.mgTimer -= dt;
      if (m.mgTimer <= 0) {
        if (_consumeMechAmmo(m)) {
          _fireMechMG(m);
        }
        m.mgTimer = MECH_MG_INTERVAL;
      }
      // Spin minigun barrels visibly while firing.
      if (m.minigunBarrels) {
        m.minigunSpinAngle += dt * 30;
        m.minigunBarrels.rotation.z = m.minigunSpinAngle;
      }
    } else if (m.minigunBarrels) {
      // Decelerate spin when not firing.
      m.minigunBarrels.rotation.z += dt * 4;
    }

    // Death sequence.
    if (m.destroyed) {
      m.deathT += dt;
      // Sink + spin for 1.0s then remove.
      m.root.rotation.y += dt * 4;
      m.root.position.y -= dt * 1.5;
      if (m.deathT > 1.0) {
        _disposeMech(m);
        _activeMechs.splice(i, 1);
      }
      continue;
    }
  }
  // Fire patches outlive their mech — tick globally after the
  // per-mech loop. Cheap when no patches exist.
  _tickFirePatches(dt);
}

// =====================================================================
// PILOTING
// =====================================================================
let _pilotedMech = null;

export function isPiloting() { return !!_pilotedMech; }
export function getPilotedMech() { return _pilotedMech; }
export function getMechs() { return _activeMechs.slice(); }

/**
 * Find the closest enterable mech within MECH_ENTER_RANGE of the
 * given player position. Returns null if none in range.
 */
export function findEnterableMech(playerPos) {
  let best = null;
  let bestD2 = MECH_ENTER_RANGE * MECH_ENTER_RANGE;
  for (const m of _activeMechs) {
    if (m.destroyed || m.dropping) continue;
    const dx = m.pos.x - playerPos.x;
    const dz = m.pos.z - playerPos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = m; }
  }
  return best;
}

/**
 * Update each mech's enter-prompt visibility based on player range.
 * Called from main.js once per frame so the prompts respond to player
 * position. We accept playerPos rather than reading it directly to
 * keep mech.js free of player.js dependency.
 */
export function updateMechPrompts(playerPos) {
  for (const m of _activeMechs) {
    if (m.destroyed || m.dropping) {
      m.prompt.visible = false;
      continue;
    }
    if (_pilotedMech === m) {
      m.prompt.visible = false;
      continue;
    }
    const dx = m.pos.x - playerPos.x;
    const dz = m.pos.z - playerPos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    m.prompt.visible = d <= MECH_ENTER_RANGE * 1.4;     // slightly larger than enter range so prompt fades in early
  }
}

export function enterMech(mech) {
  if (!mech || mech.destroyed) return;
  _pilotedMech = mech;
  mech.prompt.visible = false;
  // Flag read by player.js to keep the player avatar + gun hidden
  // while piloting (mech body replaces the silhouette). Without this,
  // player.js's per-frame visibility tick flipped the avatar back on
  // every frame, causing the gun to show through the mech and read
  // to playtesters as "primary weapon is still firing".
  S.pilotingMech = true;
}

export function exitMech() {
  if (!_pilotedMech) return null;
  const mp = _pilotedMech.pos.clone();
  _pilotedMech = null;
  S.pilotingMech = false;
  return mp;
}

/**
 * Per-frame piloted-mech update. Returns the position that the
 * player.pos should be synced to (so player.js + camera follow keep
 * working without modification). Called from main.js.
 *
 * inputs object:
 *   mx, mz   — normalized movement vector (-1..1)
 *   aimAng   — radians, where the mech should face (atan2 of
 *              cursor world-space delta from mech)
 *   firePrimary  — bool: shoot MG
 *   fireSecondary — bool: launch rocket salvo
 *   stomp    — bool: stomp request
 *   dash     — bool: dash request
 */
export function tickPilotedMech(inputs, dt) {
  if (!_pilotedMech) return null;
  const m = _pilotedMech;
  if (m.destroyed) return m.pos.clone();

  // Movement.
  let speed = MECH_SPEED;
  if (m.dashLeft > 0) {
    speed = MECH_DASH_SPEED;
    // While dashing, travel direction is locked (set when dash began).
    m.pos.x += m.dashDir.x * speed * dt;
    m.pos.z += m.dashDir.z * speed * dt;
  } else {
    m.pos.x += (inputs.mx || 0) * speed * dt;
    m.pos.z += (inputs.mz || 0) * speed * dt;
  }
  // Soft arena clamp — same wall buffer as player.
  // (We don't have ARENA imported here to keep deps clean; the value
  // is propagated through inputs.arenaHalf if the host wants to clamp.)
  if (typeof inputs.arenaHalf === 'number') {
    const ah = inputs.arenaHalf - 2.0;
    m.pos.x = Math.max(-ah, Math.min(ah, m.pos.x));
    m.pos.z = Math.max(-ah, Math.min(ah, m.pos.z));
  }
  m.root.position.x = m.pos.x;
  m.root.position.z = m.pos.z;

  // Walk-cycle leg animation when moving.
  const moving = (inputs.mx || 0) !== 0 || (inputs.mz || 0) !== 0 || m.dashLeft > 0;
  if (moving) {
    m.walkPhase += dt * (m.dashLeft > 0 ? 12 : 6);
    m.legL.rotation.x = Math.sin(m.walkPhase) * 0.45;
    m.legR.rotation.x = -Math.sin(m.walkPhase) * 0.45;
    // Body bob.
    const bob = Math.abs(Math.sin(m.walkPhase * 2)) * 0.08;
    m.torso.position.y = 3.05 + bob;
  } else {
    // Settle legs back to 0.
    m.legL.rotation.x *= 0.85;
    m.legR.rotation.x *= 0.85;
    m.torso.position.y = 3.05;
  }

  // Aim — the requested aim angle (cursor direction) is treated as a
  // TARGET, and the torso rotates toward it at a fixed angular speed.
  // Firing functions read m.facing (the actual current torso angle), so
  // bullets always come out the front of the mech where it's pointing
  // RIGHT NOW — never sideways at the cursor while the body lags. This
  // matches the user's note: "mech should shoot in the direction it's
  // facing but always slowly turn toward the crosshair."
  //
  // TURN_SPEED is the max torso rotation rate in radians/second. At
  // ~2.5 rad/s (≈143°/s) the mech feels weighty without being sluggish:
  // a 180° about-face takes ~1.25s, a 90° track ~0.6s.
  const MECH_TORSO_TURN_SPEED = 2.5;
  if (typeof inputs.aimAng === 'number') {
    m.aimTargetAng = inputs.aimAng;
  }
  if (typeof m.aimTargetAng === 'number') {
    // Shortest-arc delta from current facing to target.
    let delta = m.aimTargetAng - m.facing;
    while (delta >  Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxStep = MECH_TORSO_TURN_SPEED * dt;
    const step = Math.max(-maxStep, Math.min(maxStep, delta));
    m.facing += step;
    // Wrap to [-PI, PI] for cleanliness.
    while (m.facing >  Math.PI) m.facing -= Math.PI * 2;
    while (m.facing < -Math.PI) m.facing += Math.PI * 2;
    m.torso.rotation.y = m.facing;
  }
  if (m.dashLeft > 0) {
    const dashAng = Math.atan2(m.dashDir.x, m.dashDir.z);
    m.root.rotation.y = dashAng;
  } else if (moving) {
    const moveAng = Math.atan2(inputs.mx, inputs.mz);
    // Smooth body yaw toward movement direction.
    const cur = m.root.rotation.y;
    let dy = moveAng - cur;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    m.root.rotation.y = cur + dy * Math.min(1, dt * 8);
  }

  // Weapons — dispatch by variant.
  // Primary (held LMB):
  //   minigun → continuous MG pulses (mgFiring flag → tickMechMG)
  //   rocket  → rapid single rockets, alternating arms
  //   flame   → continuous flame stream particles + DoT cone
  // Secondary (SHIFT tap or hold):
  //   minigun → 4-rocket salvo from right-arm pod
  //   rocket  → 8-rocket salvo from BOTH pods
  //   flame   → napalm grenade (lobbed AoE that leaves a fire patch)
  if (m.variant === 'minigun') {
    m.mgFiring = !!inputs.firePrimary;
    m.flameFiring = false;
    if (inputs.fireSecondary) _requestRocketSalvo(m, 4);
  } else if (m.variant === 'rocket') {
    m.mgFiring = false;
    m.flameFiring = false;
    // Primary held: fire single rockets at MG-like cadence.
    if (inputs.firePrimary) _requestRocketSingle(m, dt);
    if (inputs.fireSecondary) _requestRocketSalvo(m, 8);
  } else if (m.variant === 'flame') {
    m.mgFiring = false;
    m.flameFiring = !!inputs.firePrimary;
    if (inputs.fireSecondary) _fireNapalm(m);
  }
  if (inputs.stomp) _doStomp(m);
  if (inputs.dash) _startDash(m, inputs.mx, inputs.mz);

  return m.pos.clone();
}

// =====================================================================
// WEAPONS
// =====================================================================
// Rocket salvo — queue `count` rockets to fire on interval. Defaults
// to MECH_ROCKET_SALVO for back-compat.
function _requestRocketSalvo(m, count) {
  if (m.rocketSalvoLeft > 0) return;       // already firing
  m.rocketSalvoLeft = count || MECH_ROCKET_SALVO;
  m.rocketSalvoTimer = 0;     // first rocket fires immediately
  const ang = m.facing;
  m.rocketTargetWorld.set(
    m.pos.x + Math.sin(ang) * 50,
    1.5,
    m.pos.z + Math.cos(ang) * 50,
  );
}

// Rocket primary fire (rocket variant) — single rocket from
// alternating arms at MG-like cadence (faster than salvo).
const _ROCKET_SINGLE_INTERVAL = 0.18;
function _requestRocketSingle(m, dt) {
  m.singleRocketTimer = (m.singleRocketTimer || 0) - dt;
  if (m.singleRocketTimer > 0) return;
  m.singleRocketTimer = _ROCKET_SINGLE_INTERVAL;
  // Each single rocket consumes one ammo. If the helper says we're
  // out, _destroyMech has already been called and we skip the shot.
  if (!_consumeMechAmmo(m)) return;
  // Aim point.
  const ang = m.facing;
  const target = new THREE.Vector3(
    m.pos.x + Math.sin(ang) * 50,
    1.5,
    m.pos.z + Math.cos(ang) * 50,
  );
  // Alternate left/right arm muzzles. We tagged primaryMuzzle as
  // left-arm in the ROCKET variant builder; secondaryMuzzle is
  // right-arm. Toggle each shot.
  m._altArm = !m._altArm;
  const muz = m._altArm ? m.mgMuzzle : m.rocketMuzzle;
  _fireMechRocket(m, target, muz);
}

// Napalm grenade (flame variant secondary). Lobs an arcing projectile
// that explodes on impact, leaving a fire patch that damages enemies
// who walk through it.
const _NAPALM_GEO = new THREE.SphereGeometry(0.30, 12, 8);
const _NAPALM_COOLDOWN_DUR = 0.70;
function _fireNapalm(m) {
  if (m.napalmCooldown > 0) return;
  // Napalm consumes one ammo. Most ammo-expensive choice in the
  // flame variant since it's a heavy AoE+DoT combo.
  if (!_consumeMechAmmo(m)) return;
  m.napalmCooldown = _NAPALM_COOLDOWN_DUR;
  const muzzleWorld = new THREE.Vector3();
  m.rocketMuzzle.getWorldPosition(muzzleWorld);
  const ang = m.facing;
  // Arcing trajectory: forward velocity + upward kick. Lands ~14u away.
  const vx = Math.sin(ang) * 16;
  const vz = Math.cos(ang) * 16;
  const vy = 8.0;
  const mat = new THREE.MeshStandardMaterial({
    color: 0x331100, emissive: 0xff5520, emissiveIntensity: 2.0, roughness: 0.6,
  });
  const mesh = new THREE.Mesh(_NAPALM_GEO, mat);
  mesh.position.copy(muzzleWorld);
  scene.add(mesh);
  m.rockets.push({
    mesh, mat,
    pos: muzzleWorld.clone(),
    vel: new THREE.Vector3(vx, vy, vz),
    life: 0,
    maxLife: 3.0,
    isNapalm: true,
  });
  hitBurst(muzzleWorld, 0xff5520, 4);
  try { Audio.mechRocket(); } catch (_) {}
}

function _fireMechRocket(m, target, muzzleOverride) {
  // Spawn a rocket at the muzzle world position, velocity along
  // (target - muzzle). muzzleOverride lets the rocket variant
  // alternate between left and right pods; default uses the right-arm
  // muzzle (the missile pod for the minigun variant).
  const muzzleWorld = new THREE.Vector3();
  const muz = muzzleOverride || m.rocketMuzzle;
  muz.getWorldPosition(muzzleWorld);

  const rocketMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: m.tintColor,
    emissiveIntensity: 2.5,
    roughness: 0.30,
  });
  const mesh = new THREE.Mesh(_ROCKET_GEO, rocketMat);
  mesh.position.copy(muzzleWorld);
  // Orient rocket along its velocity direction.
  const dir = new THREE.Vector3().subVectors(target, muzzleWorld).normalize();
  const ang = Math.atan2(dir.x, dir.z);
  mesh.rotation.y = ang;
  mesh.rotation.x = Math.PI / 2;       // align cylinder with travel direction
  scene.add(mesh);

  m.rockets.push({
    mesh, mat: rocketMat,
    pos: muzzleWorld.clone(),
    vel: dir.multiplyScalar(MECH_ROCKET_SPEED),
    life: 0,
    maxLife: 2.0,
  });

  // Muzzle flash burst.
  hitBurst(muzzleWorld, m.tint, 6);
  hitBurst(muzzleWorld, 0xffffff, 4);
  try { Audio.mechRocket(); } catch (_) {}
}

function _tickMechRockets(m, dt) {
  for (let i = m.rockets.length - 1; i >= 0; i--) {
    const r = m.rockets[i];
    // Napalm grenades obey gravity; rockets fly straight.
    if (r.isNapalm) {
      r.vel.y -= 18 * dt;
      // Tumble for visual flair.
      r.mesh.rotation.x += dt * 6;
      r.mesh.rotation.z += dt * 4;
    }
    r.pos.x += r.vel.x * dt;
    r.pos.y += r.vel.y * dt;
    r.pos.z += r.vel.z * dt;
    r.mesh.position.copy(r.pos);
    r.life += dt;

    // Hit-test against enemies. Simple radius check against rocket
    // tip; on hit, AoE-damage everything in MECH_ROCKET_RADIUS.
    let hitTarget = null;
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying) continue;
      const dx = e.pos.x - r.pos.x;
      const dz = e.pos.z - r.pos.z;
      if (dx * dx + dz * dz < 1.4 * 1.4) {
        hitTarget = e;
        break;
      }
    }
    // Detonate on hit, on lifetime expiry, or on ground impact.
    const groundHit = r.pos.y < 0.4;
    if (hitTarget || groundHit || r.life >= r.maxLife) {
      if (r.isNapalm) {
        _detonateNapalm(m, r.pos);
      } else {
        _detonateMechRocket(m, r.pos);
      }
      _disposeRocket(r);
      m.rockets.splice(i, 1);
    }
  }
}

// Napalm detonation — smaller AoE than a rocket, but spawns a fire
// patch that lingers for ~4s and damages anything that walks through.
const _NAPALM_RADIUS = 3.5;
const _NAPALM_DAMAGE = 110;
const _NAPALM_PATCH_DUR = 4.0;
const _NAPALM_PATCH_DPS = 60;
function _detonateNapalm(m, pos) {
  const r2 = _NAPALM_RADIUS * _NAPALM_RADIUS;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r2) {
      const falloff = 1 - Math.sqrt(d2) / _NAPALM_RADIUS;
      e.hp -= _NAPALM_DAMAGE * falloff;
      e.hitFlash = 0.18;
      // Universal knockback — radial blast, scaled by falloff.
      applyKnockback(e, pos, 0.3 * (0.5 + 2 * falloff));
      if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
        try { window.__killEnemyAtIdx(e); } catch (_) {}
      }
    }
  }
  hitBurst(pos, 0xff5520, 18);
  hitBurst(pos, 0xffaa00, 14);
  try { Audio.mechRocketImpact(); } catch (_) {}
  // Fire patch — flat disc + rising flame puffs that tick DPS.
  _spawnFirePatch(pos);
  // Friendly fire — napalm splash + the patch still hurts you if you
  // walk through it.
  _splashDamagePlayer(pos, _NAPALM_RADIUS, 25);
}

// Active fire patches — global list, ticked per frame inside
// updateMechs. We don't attach them to a specific mech because the
// patch outlives any specific mech instance + the player can stomp
// or dash and leave patches behind that should keep ticking.
const _activeFirePatches = [];
const _FIRE_PATCH_GEO = new THREE.CircleGeometry(_NAPALM_RADIUS, 28);
function _spawnFirePatch(pos) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff5520,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const disc = new THREE.Mesh(_FIRE_PATCH_GEO, mat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(pos.x, 0.06, pos.z);
  scene.add(disc);
  _activeFirePatches.push({
    disc, mat,
    pos: pos.clone(),
    life: 0,
    ttl: _NAPALM_PATCH_DUR,
  });
}
function _tickFirePatches(dt) {
  for (let i = _activeFirePatches.length - 1; i >= 0; i--) {
    const p = _activeFirePatches[i];
    p.life += dt;
    const f = p.life / p.ttl;
    if (f >= 1) {
      if (p.disc.parent) p.disc.parent.remove(p.disc);
      if (p.mat) p.mat.dispose();
      _activeFirePatches.splice(i, 1);
      continue;
    }
    // Pulse + fade.
    const pulse = 0.5 + 0.5 * Math.sin(p.life * 7);
    p.mat.opacity = (0.55 + pulse * 0.20) * (1 - f * 0.6);
    // Damage enemies inside the patch.
    const r2 = _NAPALM_RADIUS * _NAPALM_RADIUS;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying) continue;
      const dx = e.pos.x - p.pos.x;
      const dz = e.pos.z - p.pos.z;
      if (dx * dx + dz * dz < r2) {
        e.hp -= _NAPALM_PATCH_DPS * dt;
        if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
          try { window.__killEnemyAtIdx(e); } catch (_) {}
        }
      }
    }
  }
}
function _clearFirePatches() {
  for (const p of _activeFirePatches) {
    if (p.disc.parent) p.disc.parent.remove(p.disc);
    if (p.mat) p.mat.dispose();
  }
  _activeFirePatches.length = 0;
}

function _detonateMechRocket(m, pos) {
  // AoE damage in MECH_ROCKET_RADIUS. Iterate BACKWARDS because
  // window.__killEnemyAtIdx splices the live enemies array — going
  // forward would skip enemies as the array shrinks behind us.
  const r2 = MECH_ROCKET_RADIUS * MECH_ROCKET_RADIUS;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r2) {
      const falloff = 1 - Math.sqrt(d2) / MECH_ROCKET_RADIUS;
      e.hp -= MECH_ROCKET_DAMAGE * falloff;
      e.hitFlash = 0.18;
      // Universal knockback — radial blast.
      applyKnockback(e, pos, 0.3 * (0.5 + 2 * falloff));
      // Finish the kill — without this the enemy walks around at
      // negative HP because mech damage paths previously skipped the
      // game's killEnemy pipeline (which handles score, drops, splice).
      if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
        try { window.__killEnemyAtIdx(e); } catch (_) {}
      }
    }
  }
  // FX.
  hitBurst(pos, 0xffffff, 26);
  hitBurst(pos, m.tint, 22);
  setTimeout(() => hitBurst(pos, 0xffaa00, 18), 60);
  setTimeout(() => hitBurst(pos, 0xff5520, 14), 130);
  // Audio.
  try { Audio.mechRocketImpact(); } catch (_) {}
  // Friendly fire — mech rockets hurt the (un-piloted) player too.
  // This is the cost of stupid placement, not a constant nuisance:
  // dmg falloff makes near-edge hits trivial.
  _splashDamagePlayer(pos, MECH_ROCKET_RADIUS, 35);
}

function _disposeRocket(r) {
  if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
  if (r.mat) r.mat.dispose();
}

// MG — fast pulsing weapon, single-shot hitscan. Each pulse applies
// damage to the first enemy along the aim ray within MECH_MG_RANGE.
function _fireMechMG(m) {
  const muzzleWorld = new THREE.Vector3();
  m.mgMuzzle.getWorldPosition(muzzleWorld);
  // Aim along torso facing.
  const ang = m.facing;
  const dir = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));

  // Find first enemy along the ray.
  let hit = null;
  let bestT = MECH_MG_RANGE;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const dx = e.pos.x - muzzleWorld.x;
    const dz = e.pos.z - muzzleWorld.z;
    const t = dx * dir.x + dz * dir.z;             // projection length
    if (t < 0 || t > bestT) continue;
    // Perpendicular distance from ray.
    const px = muzzleWorld.x + dir.x * t;
    const pz = muzzleWorld.z + dir.z * t;
    const ddx = e.pos.x - px;
    const ddz = e.pos.z - pz;
    const dperp2 = ddx * ddx + ddz * ddz;
    if (dperp2 < 0.9 * 0.9) {                       // ~enemy width
      hit = e; bestT = t;
    }
  }
  // Tracer FX — visible cylinder from muzzle to hit (or max range).
  const tracerEnd = muzzleWorld.clone().add(dir.clone().multiplyScalar(bestT));
  _spawnTracer(m, muzzleWorld, tracerEnd);
  try { Audio.mechMg(); } catch (_) {}

  if (hit) {
    hit.hp -= MECH_MG_DAMAGE;
    hit.hitFlash = 0.10;
    // Universal knockback — push hit from the muzzle.
    applyKnockback(hit, muzzleWorld);
    hitBurst(tracerEnd, 0xffffff, 5);
    hitBurst(tracerEnd, m.tint, 4);
    // Finish the kill — same fix as the rocket detonation.
    if (hit.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
      try { window.__killEnemyAtIdx(hit); } catch (_) {}
    }
  }
}

function _spawnTracer(m, from, to) {
  const len = from.distanceTo(to);
  if (len < 0.1) return;

  // ----- BRIGHT CORE -----
  // Solid color, near-opaque, slim cylinder. This is the bullet body
  // the eye reads as the actual projectile streak.
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const core = new THREE.Mesh(_TRACER_CORE_GEO, coreMat);
  core.scale.set(1, len, 1);

  // ----- GLOW HALO -----
  // Wider, lower-opacity, chapter-tinted cylinder layered around the
  // core. Provides the soft outer glow trail. Additive blending makes
  // overlapping tracers stack into a brighter beam, classic arcade feel.
  const haloMat = new THREE.MeshBasicMaterial({
    color: m.tintColor,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const halo = new THREE.Mesh(_TRACER_HALO_GEO, haloMat);
  halo.scale.set(1, len, 1);

  // Position both halfway, oriented along (to - from).
  const mid = from.clone().lerp(to, 0.5);
  core.position.copy(mid);
  halo.position.copy(mid);
  // Rotate so the cylinder's Y axis aligns with the from→to direction.
  const dir = to.clone().sub(from).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
  core.quaternion.copy(quat);
  halo.quaternion.copy(quat);
  scene.add(core);
  scene.add(halo);
  // Lifetime: 0.14s — twice the previous 0.07s. Long enough that the
  // eye latches onto the streak even at 60+ fps; short enough that
  // tracers don't clutter the scene during sustained fire.
  m.tracers.push({ mesh: core, mat: coreMat, life: 0, ttl: 0.14, peakOpacity: 1.0 });
  m.tracers.push({ mesh: halo, mat: haloMat, life: 0, ttl: 0.14, peakOpacity: 0.55 });

  // ----- MUZZLE FLASH -----
  // Bright sphere at the firing origin that lives for a third of the
  // tracer ttl, giving the gun a "punch" frame as the bullet leaves.
  // Sphere geometry instead of a cylinder so it reads as a burst of
  // light, not a tracer of its own.
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const flash = new THREE.Mesh(_MUZZLE_FLASH_GEO, flashMat);
  flash.position.copy(from);
  // Scale up briefly so the flash punches outward visually.
  flash.scale.set(1.4, 1.4, 1.4);
  scene.add(flash);
  m.tracers.push({ mesh: flash, mat: flashMat, life: 0, ttl: 0.06, peakOpacity: 0.95 });
}

function _tickMechTracers(m, dt) {
  for (let i = m.tracers.length - 1; i >= 0; i--) {
    const t = m.tracers[i];
    t.life += dt;
    const f = t.life / t.ttl;
    if (f >= 1) {
      if (t.mesh.parent) t.mesh.parent.remove(t.mesh);
      if (t.mat) t.mat.dispose();
      m.tracers.splice(i, 1);
      continue;
    }
    // Each tracer element (core / halo / muzzle flash) was spawned with
    // its own peakOpacity. Fade from peak → 0 across its ttl so the
    // bright core, soft halo, and short flash each fade independently.
    // Falls back to 0.85 if something pushed an old-style entry without
    // the peakOpacity field.
    const peak = (typeof t.peakOpacity === 'number') ? t.peakOpacity : 0.85;
    t.mat.opacity = peak * (1 - f);
  }
}

// Stomp — AoE around the mech's feet.
function _doStomp(m) {
  if (m.stompCooldown > 0) return;
  m.stompCooldown = MECH_STOMP_COOLDOWN;
  const r2 = MECH_STOMP_RADIUS * MECH_STOMP_RADIUS;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const dx = e.pos.x - m.pos.x;
    const dz = e.pos.z - m.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r2) {
      const falloff = 1 - Math.sqrt(d2) / MECH_STOMP_RADIUS;
      e.hp -= MECH_STOMP_DAMAGE * falloff;
      e.hitFlash = 0.20;
      if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
        try { window.__killEnemyAtIdx(e); } catch (_) {}
      }
    }
  }
  // Visual: shockwave ring + dust burst.
  hitBurst(m.pos.clone(), 0xffffff, 24);
  hitBurst(m.pos.clone(), m.tint, 18);
  // Ground impact ring.
  _spawnStompRing(m);
  try { Audio.mechLand(); } catch (_) {}
}

// Brown dust ring spawned at the foot of a rising mech. Mirrors the
// stomp-ring shape but uses an earthy color and grows more slowly.
function _spawnRiseDustRing(m) {
  const ringGeo = new THREE.RingGeometry(0.7, 1.05, 36);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x8a6a44,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(m.pos.x, 0.05, m.pos.z);
  scene.add(ring);
  const tStart = performance.now();
  function tick() {
    const t = (performance.now() - tStart) / 1000;
    const f = Math.min(1, t / 1.10);
    const s = 1 + f * 4.0;
    ring.scale.set(s, s, 1);
    ringMat.opacity = 0.85 * (1 - f);
    if (f < 1) requestAnimationFrame(tick);
    else {
      if (ring.parent) ring.parent.remove(ring);
      ringMat.dispose();
      ringGeo.dispose();
    }
  }
  requestAnimationFrame(tick);
}

function _spawnStompRing(m) {
  const ringGeo = new THREE.RingGeometry(0.5, 0.7, 36);
  const ringMat = new THREE.MeshBasicMaterial({
    color: m.tintColor,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(m.pos.x, 0.05, m.pos.z);
  scene.add(ring);
  // Animate via a one-off self-scheduled tick. Cheap; rings are rare.
  const tStart = performance.now();
  function tick() {
    const t = (performance.now() - tStart) / 1000;
    const f = Math.min(1, t / 0.45);
    const s = 1 + f * (MECH_STOMP_RADIUS / 0.6);
    ring.scale.set(s, s, 1);
    ringMat.opacity = 0.85 * (1 - f);
    if (f < 1) requestAnimationFrame(tick);
    else {
      if (ring.parent) ring.parent.remove(ring);
      ringMat.dispose();
      ringGeo.dispose();
    }
  }
  requestAnimationFrame(tick);
}

// Dash — short fast slide that crushes enemies along its line.
function _startDash(m, mx, mz) {
  if (m.dashCooldown > 0 || m.dashLeft > 0) return;
  // Direction defaults to facing if no movement input.
  let dx = mx, dz = mz;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) {
    dx = Math.sin(m.facing);
    dz = Math.cos(m.facing);
  } else {
    dx /= len; dz /= len;
  }
  m.dashDir.set(dx, 0, dz);
  m.dashLeft = MECH_DASH_DUR;
  m.dashCooldown = MECH_DASH_COOLDOWN;
  // Damage line — anything inside a thin rectangle in front of the
  // mech for the dash distance gets squished.
  const dashLen = MECH_DASH_DUR * MECH_DASH_SPEED;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const ex = e.pos.x - m.pos.x;
    const ez = e.pos.z - m.pos.z;
    // Project onto dash axis.
    const along = ex * dx + ez * dz;
    if (along < 0 || along > dashLen) continue;
    // Perpendicular distance.
    const perpX = ex - dx * along;
    const perpZ = ez - dz * along;
    const perp2 = perpX * perpX + perpZ * perpZ;
    if (perp2 < 1.6 * 1.6) {
      e.hp -= 400;
      e.hitFlash = 0.20;
    }
  }
  hitBurst(m.pos.clone(), 0xffffff, 16);
}

// =====================================================================
// FLAME STREAM (flame variant primary fire)
// =====================================================================
// Continuous particle stream from the nozzle muzzle. Each particle is
// a small additive-blended sphere with a randomized lifetime; the
// stream applies DPS damage to any enemy within a forward cone.
const _FLAME_PARTICLE_GEO = new THREE.SphereGeometry(0.20, 8, 6);
const FLAME_RANGE         = 9.0;
const FLAME_CONE_HALF     = 0.40;
const FLAME_DPS           = 220;
const FLAME_PARTICLE_RATE = 80;
const FLAME_PARTICLE_TTL  = 0.35;
function _tickMechFlame(m, dt) {
  if (m.flameFiring) {
    // Out-of-ammo guard — if the mech ran dry mid-stream we stop
    // emitting flame. The auto-destroy from _consumeMechAmmo below
    // handles the death path.
    if (m.ammo <= 0) {
      m.flameLastFireT = 0;
      m.flameAudioCounter = 0;
      // Fall through to particle tick so existing flame motes still
      // animate out.
    } else {
      const ang = m.facing;
      const dirX = Math.sin(ang), dirZ = Math.cos(ang);
      // Backwards iteration so killEnemy splices don't shift indices.
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        if (!e || !e.pos || e.dying) continue;
        const ex = e.pos.x - m.pos.x;
        const ez = e.pos.z - m.pos.z;
        const along = ex * dirX + ez * dirZ;
        if (along < 0 || along > FLAME_RANGE) continue;
        const perp = Math.sqrt(Math.max(0, (ex * ex + ez * ez) - along * along));
        if (perp / Math.max(0.5, along) > FLAME_CONE_HALF) continue;
        const falloff = 1 - 0.7 * (along / FLAME_RANGE);
        e.hp -= FLAME_DPS * falloff * dt;
        e.hitFlash = 0.10;
        // Finish the kill — without this enemies sat at -hp instead
        // of dying. Same bug the rest of the stratagem damage paths
        // had; fixed here for parity.
        if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
          try { window.__killEnemyAtIdx(e); } catch (_) {}
        }
      }
      m.flameLastFireT = (m.flameLastFireT || 0) + dt;
      const interval = 1 / FLAME_PARTICLE_RATE;
      let spawned = 0;
      while (m.flameLastFireT >= interval) {
        m.flameLastFireT -= interval;
        // Consume ammo per particle. If we run out mid-burst the
        // helper auto-destroys the mech and we stop spawning.
        if (!_consumeMechAmmo(m)) break;
        _spawnFlameParticle(m);
        spawned++;
      }
      // One audio puff per ~6 spawned particles so the hiss layers
      // softly without stacking into a wall of noise.
      m.flameAudioCounter = (m.flameAudioCounter || 0) + spawned;
      if (m.flameAudioCounter >= 6) {
        m.flameAudioCounter = 0;
        try { Audio.mechFlame(); } catch (_) {}
      }
    }
  } else {
    m.flameLastFireT = 0;
    m.flameAudioCounter = 0;
  }
  for (let i = m.flameParticles.length - 1; i >= 0; i--) {
    const p = m.flameParticles[i];
    p.life += dt;
    const f = p.life / FLAME_PARTICLE_TTL;
    if (f >= 1) {
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
      if (p.mat) p.mat.dispose();
      m.flameParticles.splice(i, 1);
      continue;
    }
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.pos.z += p.vel.z * dt;
    p.mesh.position.copy(p.pos);
    const s = 0.5 + f * 1.4;
    p.mesh.scale.setScalar(s);
    if (f < 0.3) p.mat.color.setHex(0xfff3a0);
    else if (f < 0.6) p.mat.color.setHex(0xffaa30);
    else p.mat.color.setHex(0xff5520);
    p.mat.opacity = 0.95 * (1 - f);
  }
}
function _spawnFlameParticle(m) {
  const muzzleWorld = new THREE.Vector3();
  m.mgMuzzle.getWorldPosition(muzzleWorld);
  const ang = m.facing;
  const dirX = Math.sin(ang), dirZ = Math.cos(ang);
  const speed = 16 + Math.random() * 6;
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
  const mesh = new THREE.Mesh(_FLAME_PARTICLE_GEO, mat);
  mesh.position.copy(muzzleWorld);
  scene.add(mesh);
  m.flameParticles.push({
    mesh, mat,
    pos: muzzleWorld.clone(),
    vel: new THREE.Vector3(sx * speed, (Math.random() - 0.5) * 1.2, sz * speed),
    life: 0,
  });
}

// =====================================================================
// AMMO
// =====================================================================
// Single helper called from every fire entry point. Returns true if
// the mech still has ammo to fire (and decrements it); returns false
// if empty. When the decrement brings ammo to 0 the mech auto-
// destroys via _destroyMech — which ejects the pilot, re-shows the
// player avatar, plays the explosion FX, and applies the splash.
// Same death path as taking too much HP damage so the player gets a
// consistent "your tool is gone" cue regardless of cause.
function _consumeMechAmmo(m) {
  if (!m || m.destroyed) return false;
  if (m.ammo <= 0) {
    // Defensive — should already have been caught the previous shot,
    // but if anything ever fires while empty (e.g. queued salvo
    // ticks), still bail cleanly.
    _destroyMech(m);
    return false;
  }
  m.ammo -= 1;
  if (m.ammo <= 0) {
    // Mark for destruction this frame. Don't return false yet — the
    // current shot is still allowed (we already decremented for it),
    // so the player feels their LAST shot connect rather than just
    // "gun stops working." _destroyMech is idempotent via the
    // m.destroyed guard above.
    _destroyMech(m);
  }
  return true;
}

// =====================================================================
// DAMAGE
// =====================================================================
export function damagePilotedMech(dmg) {
  if (!_pilotedMech || _pilotedMech.destroyed) return;
  _pilotedMech.hp -= dmg;
  if (_pilotedMech.hp <= 0) {
    _destroyMech(_pilotedMech);
  }
}

function _destroyMech(m) {
  m.destroyed = true;
  m.hp = 0;
  // Eject pilot.
  if (_pilotedMech === m) {
    _pilotedMech = null;
    // CRITICAL — clear S.pilotingMech so player.js's per-frame
    // visibility tick stops forcing the avatar to invisible. Without
    // this, when the mech gets destroyed the player remains hidden
    // forever (a playtester report). The visibility logic in player.js
    // is: "if S.pilotingMech then hidden, else respect invuln flicker
    // / fully visible". So flipping the flag here is what brings the
    // avatar back.
    S.pilotingMech = false;
    // Surface the eject so main.js can re-show the player mesh and
    // restore player.pos to mech.pos.
    if (typeof window !== 'undefined' && window.__mechEjected) {
      window.__mechEjected(m.pos.clone());
    }
  }
  // Big explosion.
  const pos = m.pos.clone();
  pos.y = 1.5;
  hitBurst(pos, 0xffffff, 50);
  hitBurst(pos, m.tint, 40);
  setTimeout(() => hitBurst(pos, 0xffaa00, 30), 60);
  setTimeout(() => hitBurst(pos, 0xff5520, 22), 140);
  try { Audio.mechDestroyed(); } catch (_) {}
  // Splash damage to player — a destroyed mech is a fuel-cell rupture,
  // it should hurt to be standing right next to it. Pilot already got
  // ejected (just above) which clears _pilotedMech, so the helper's
  // piloting bail won't trigger here.
  _splashDamagePlayer(m.pos, 4.5, 60);
}

function _disposeMech(m) {
  if (m.root.parent) scene.remove(m.root);
  if (m.hullMat) m.hullMat.dispose();
  if (m.trimMat) m.trimMat.dispose();
  if (m.glassMat) m.glassMat.dispose();
  if (m.accentMat) m.accentMat.dispose();
  // Dispose any in-flight projectiles + tracers.
  for (const r of m.rockets) _disposeRocket(r);
  m.rockets.length = 0;
  for (const t of m.tracers) {
    if (t.mesh.parent) t.mesh.parent.remove(t.mesh);
    if (t.mat) t.mat.dispose();
  }
  m.tracers.length = 0;
  // Flame particles too.
  for (const p of m.flameParticles || []) {
    if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    if (p.mat) p.mat.dispose();
  }
  if (m.flameParticles) m.flameParticles.length = 0;
}

export function clearMechs() {
  _pilotedMech = null;
  for (const m of _activeMechs) _disposeMech(m);
  _activeMechs.length = 0;
  // Fire patches outlive their mech, but on game reset we want
  // everything gone.
  _clearFirePatches();
}
