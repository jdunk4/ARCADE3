// pyramidSpawner.js — Cursed pyramid spawner alternative to the wasp-nest
// hive. Same contract as spawnPortal in spawners.js (returns an object
// the existing damageSpawner / updateSpawners / shield system can drive
// without modification) but the visible structure is a stepped stone
// pyramid topped by a glyph obelisk.
//
// Used in chapters 1 and 4 (user-visible "Chapter 2 CURSED" and
// "Chapter 5 CURSED"). Dispatched from spawners.spawnPortal based on
// chapter index.
//
// Visual:
//   - Stepped stone base: 6 levels of square stones, each step smaller
//     than the one below. Cracked dark stone material with a faint
//     warm emissive at the seams (the curse leaking through).
//   - Glyph plates: square inset panels on the faces of each step.
//     Chapter-tinted runes embossed on them. These are the "eggs" —
//     popping them shatters the rune glyph off the face.
//   - Obelisk capstone: tall narrow pyramid sitting on the top step,
//     emissive chapter-tint cap (the cursed eye/sigil). This is the
//     "crown" that pulses faster as HP drops.
//   - Base disc: a circular ground tile under the pyramid suggesting
//     the structure's foundation.
//
// Contract returned (must match wasp-nest spawnPortal):
//   obj, pos, ring, core, orb, base, beam, coreMat, ringMat, baseMat,
//   nestBody, eggs[], eggsAlive, capMat, nestMat, nestOriginalColor,
//   hp, hpMax, hitFlash, spawnCooldown, enemiesAlive, destroyed, tint

import * as THREE from 'three';
import { scene } from './scene.js';
import { SPAWNER_CONFIG, HIVE_CONFIG, CHAPTERS } from './config.js';
import { buildLightningBolt, tickLightningBolts } from './spawnerFx.js';
import { hitBurst } from './effects.js';

// ---- Stone material constants ----
// Dark stone with a faint warm undertone — reads as ancient weathered
// rock. The emissive seam color is the chapter tint (set per spawner)
// so the curse leaks through cracks in the chapter's own palette.
const _STONE_COLOR = 0x4a3e34;
const _STONE_EMISSIVE = 0x180c04;        // dim warm baseline before tint adds
const _STONE_DARK_COLOR = 0x1a1410;       // damage-darkening target

// ---- Shared geometry singletons ----
// Step blocks — square plinths. We allocate ONE BoxGeometry per step
// level since each level has a distinct size; reused across hives.
const _STEP_GEOMS = (() => {
  const out = [];
  // 6 steps; widest at the bottom (3.4u), narrowest near top (1.0u).
  // Heights are 0.5u each for a stout silhouette.
  const widths = [3.4, 2.9, 2.4, 1.9, 1.4, 1.0];
  for (let i = 0; i < widths.length; i++) {
    out.push(new THREE.BoxGeometry(widths[i], 0.5, widths[i]));
  }
  return out;
})();
// Obelisk geometry — narrow tall pyramid (4-sided cone) sitting on
// the top step. Reads as the "spire" of the structure.
const _OBELISK_GEO = new THREE.ConeGeometry(0.5, 1.6, 4);
// Glyph plate — small flat square inset on the step faces.
const _GLYPH_GEO = new THREE.PlaneGeometry(0.40, 0.40);
// Glyph "cap" — slightly raised bump on top of the plate that
// shatters off when the glyph takes damage. Same plate shape, just
// offset outward so it visually peels.
const _GLYPH_CAP_GEO = new THREE.PlaneGeometry(0.44, 0.44);

// Base disc — wider than the bottom step, sits at ground level.
const _BASE_GEO = new THREE.CylinderGeometry(2.2, 2.4, 0.22, 16);

/**
 * Build a pyramid spawner. Same call signature as spawnPortal; same
 * return shape so spawners.js / dormantProps.js / waves.js drive it
 * without knowing the difference.
 */
export function spawnPyramidPortal(x, z, chapterIdx) {
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.lamp;
  const tintColor = new THREE.Color(tint);
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Base disc — same role as wasp-nest base. Dark dried-out stone
  // foundation tinted by the chapter tint just enough to read.
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x2c2218, emissive: 0x100804, emissiveIntensity: 0.5,
    roughness: 0.95, metalness: 0.05,
  });
  const base = new THREE.Mesh(_BASE_GEO, baseMat);
  base.position.y = 0.11;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // Pyramid body — stepped stone stack. We put it inside its own
  // group ("pyramidBody") so the per-frame sway code in spawners.js
  // updateSpawners can rotate this group on its own axis without
  // dragging the base disc with it. This mirrors the wasp-nest
  // nestBody convention exactly.
  const pyramidBody = new THREE.Group();
  pyramidBody.position.y = 0.22;
  group.add(pyramidBody);

  // Stone material — chapter-tinted emissive seams. We share ONE
  // material across all six steps so per-hit damage darkening lerps
  // them uniformly (matching the wasp-nest behavior where one shared
  // nestMat darkens the whole body on damage).
  const stoneMat = new THREE.MeshStandardMaterial({
    color: _STONE_COLOR,
    emissive: tint,
    emissiveIntensity: 0.20,           // subtle — too high reads as neon
    roughness: 0.95,
    metalness: 0.05,
  });

  // Glyph plate material — bright chapter-tinted runes. Shared across
  // all glyphs on this hive so a single material color update covers
  // them all if needed.
  const glyphMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tint,
    emissiveIntensity: 2.4,
    transparent: true,
    opacity: 0.92,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });

  // Glyph cap material — slightly cooler tone so when the cap is
  // present (intact rune) and then shatters, the underlying glyph
  // plate (also visible after shatter) feels slightly brighter and
  // more raw. Mirrors wasp-nest cap-then-egg progression.
  const capMat = new THREE.MeshStandardMaterial({
    color: 0x6a5a44,                   // pale weathered cap stone
    emissive: tint,
    emissiveIntensity: 0.6,
    roughness: 0.85,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  // Build 6 steps stacked. Each step's Y center is half its height
  // above the top of the previous step.
  const STEP_HEIGHT = 0.5;
  const eggs = [];   // glyph-plate "eggs" — see contract docs
  for (let i = 0; i < _STEP_GEOMS.length; i++) {
    const step = new THREE.Mesh(_STEP_GEOMS[i], stoneMat);
    const y = STEP_HEIGHT * i + STEP_HEIGHT * 0.5;
    step.position.y = y;
    step.castShadow = true;
    step.receiveShadow = true;
    pyramidBody.add(step);

    // Add a glyph plate on each of the 4 faces of this step. Top step
    // (i=5) skips glyph plates — its faces are too narrow and the
    // obelisk takes that real estate.
    if (i >= _STEP_GEOMS.length - 1) continue;
    // Step width — read off the geometry parameters. Width.x === width.z.
    const width = _STEP_GEOMS[i].parameters.width;
    const half = width / 2;
    // 4 cardinal faces. outX/outZ point outward from center.
    const FACES = [
      { outX:  0, outZ:  1, rotY: 0 },          // +Z face
      { outX:  0, outZ: -1, rotY: Math.PI },    // -Z face
      { outX:  1, outZ:  0, rotY: Math.PI / 2 },// +X face
      { outX: -1, outZ:  0, rotY: -Math.PI / 2 },// -X face
    ];
    for (const f of FACES) {
      // Plate sits flush against the face, slightly offset outward so
      // it doesn't z-fight with the stone surface.
      const plate = new THREE.Mesh(_GLYPH_GEO, glyphMat);
      plate.position.set(
        f.outX * (half + 0.01),
        y,
        f.outZ * (half + 0.01),
      );
      plate.rotation.y = f.rotY;
      plate.userData.pulsePhase = Math.random() * Math.PI * 2;
      plate.userData.outward = new THREE.Vector3(f.outX, 0, f.outZ);
      pyramidBody.add(plate);
      eggs.push(plate);

      // Add a cap (intact-rune cover) on top of the plate. Same
      // mechanic as wasp-nest egg caps — first hit shatters the cap
      // revealing the brighter glyph beneath, second hit pops the
      // glyph itself. Slight outward offset so the cap is the
      // outermost visible layer.
      const cap = new THREE.Mesh(_GLYPH_CAP_GEO, capMat);
      cap.position.set(
        f.outX * (half + 0.025),
        y,
        f.outZ * (half + 0.025),
      );
      cap.rotation.y = f.rotY;
      cap.userData.isCap = true;
      cap.userData.eggRef = plate;
      pyramidBody.add(cap);
      plate.userData.cap = cap;
      // Capped plates are hidden from the "which to pop" pool until
      // the cap shatters. Same semantics as wasp-nest covered eggs.
      plate.userData.covered = true;
    }
  }

  // Obelisk capstone — sits centered on top of the highest step. The
  // emissive material is keyed by the chapter tint so this is the
  // brightest visual element on the structure. Doubles as the
  // "crown" the per-frame update code pulses on hit and as HP drops.
  const obeliskMat = new THREE.MeshStandardMaterial({
    color: _STONE_COLOR,
    emissive: tint,
    emissiveIntensity: 2.0,
    roughness: 0.55,
    metalness: 0.10,
  });
  const obelisk = new THREE.Mesh(_OBELISK_GEO, obeliskMat);
  // Top of step 5 is at y = 5 * 0.5 + 0.5 = 3.0. Cone height is 1.6
  // so center at 3.0 + 0.8 = 3.8. Add a small inset so the cone base
  // sinks slightly into the top step (reads as planted, not glued).
  obelisk.position.y = 3.0 + 1.6 * 0.5 - 0.05;
  pyramidBody.add(obelisk);

  // Entry ring — flush at the base, tinted glow. Same lore as the
  // wasp-nest entry ring: the spawn point for emerging enemies. A
  // simple glowing torus sitting in front of the bottom step.
  const entryRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.12, 6, 14),
    new THREE.MeshStandardMaterial({
      color: 0x1a0f05,
      emissive: tint,
      emissiveIntensity: 1.8,
      roughness: 0.6,
    })
  );
  entryRing.position.y = 0.26;
  entryRing.rotation.x = Math.PI / 2;
  group.add(entryRing);

  scene.add(group);

  return {
    obj: group,
    pos: group.position,
    // Compatibility aliases — existing update code expects these
    // names. Point them at pyramid equivalents so the per-frame pulse
    // / hit-flash code drives the obelisk emissive without any
    // change to spawners.js updateSpawners().
    ring: obelisk,
    core: obelisk,
    orb: obelisk,
    base,
    beam: entryRing,
    coreMat: obelisk.material,
    ringMat: obelisk.material,
    baseMat: base.material,
    // The key alias — spawners.js tests `s.nestBody` to apply sway,
    // and reads `s.eggs[]` to drive pop animations. We reuse the
    // exact same field names so the existing animation loop drives
    // pyramids identically to wasp nests.
    nestBody: pyramidBody,
    eggs,
    eggsAlive: eggs.length,
    capMat,
    // Pyramids skip the "darken on damage" path (they BRIGHTEN
    // instead) — null nestOriginalColor causes _updateHiveDamageColor
    // to early-return, and tickPyramidDamage handles emissive ramp.
    nestMat: stoneMat,
    nestOriginalColor: null,
    // Pyramid-specific FX state — read by tickPyramidDamage and
    // launchPyramid in spawners.js.
    stoneMat,
    obelisk,
    obeliskMat,
    glyphMat,
    lightningBolts: [],             // active lightning bolts (caller-owned)
    lightningTimer: 0,              // seconds until next sky-strike
    launching: false,               // true after destroy: pyramid is taking off
    launchT: 0,                     // seconds since launch began
    thrusterMeshes: [],              // populated by launchPyramid
    hp: SPAWNER_CONFIG.spawnerHp || 180,
    hpMax: SPAWNER_CONFIG.spawnerHp || 180,
    hitFlash: 0,
    spawnCooldown: 0.5 + Math.random() * HIVE_CONFIG.spawnIntervalSec,
    enemiesAlive: 0,
    destroyed: false,
    tint,
    // Tag so debug tooling / future per-style logic can branch on
    // structure type. spawners.js doesn't read this; it's purely
    // informational.
    structureType: 'pyramid',
  };
}

// =====================================================================
// PYRAMID-SPECIFIC DAMAGE FX
// =====================================================================
// Called every frame from spawners.js updateSpawners() for any spawner
// with structureType === 'pyramid'. Drives:
//   - Brightness ramp: stone emissive intensity climbs from 0.20 (full
//     HP) toward ~3.0 (near death). Obelisk's already-bright emissive
//     climbs even further. The pyramid doesn't darken on damage; it
//     glows hotter and hotter until it self-destructs.
//   - Periodic sky lightning: every few seconds when below 70% HP, a
//     bolt strikes the obelisk tip from straight up. Frequency scales
//     with damage so it crackles constantly near death.
//   - Lightning bolt list tick: fades + removes expired bolts.
// =====================================================================
const _SKY_STRIKE_HEIGHT = 28;     // bolt origin Y in world space (above pyramid)

export function tickPyramidDamage(s, dt, ratio) {
  if (!s) return;

  // Brightness ramp. Damage dmg in [0..1].
  const dmg = 1 - ratio;
  // Stone seam emissive: 0.20 (calm) → 3.0 (overloaded).
  if (s.stoneMat) {
    s.stoneMat.emissiveIntensity = 0.20 + dmg * 2.80;
  }
  // Obelisk capstone — already bright; pump higher. The existing
  // pulse code in spawners.js drives ringMat (= obeliskMat) on hit
  // flashes; we add a steady-state ramp on top of that.
  if (s.obeliskMat && s.hitFlash <= 0) {
    s.obeliskMat.emissiveIntensity = 2.0 + dmg * 4.0;
  }
  // Glyph plates — also push brighter so the runes blaze near death.
  // (The per-egg pulse code in spawners.js sets emissiveIntensity
  // based on ratio; we additionally bump the SHARED glyphMat which
  // the still-capped plates use.)
  if (s.glyphMat) {
    s.glyphMat.emissiveIntensity = 2.4 + dmg * 2.0;
  }

  // Sky-strike lightning. Frequency ramps with damage. Below 70% HP
  // we start striking; near 0 HP they fire every ~0.4s.
  if (s.launching) return;            // launchPyramid handles its own bolts
  if (dmg > 0.30) {
    s.lightningTimer = (s.lightningTimer || 0) - dt;
    if (s.lightningTimer <= 0) {
      _spawnSkyStrike(s);
      // Interval: 2.5s at 70% damage → 0.4s at 100% damage.
      s.lightningTimer = 2.5 - (dmg - 0.30) * 3.0;
    }
  }

  // Tick active bolts.
  if (s.lightningBolts && s.lightningBolts.length) {
    tickLightningBolts(dt, s.lightningBolts);
  }
}

// Drop a lightning bolt from sky onto the obelisk tip.
function _spawnSkyStrike(s) {
  // Obelisk world position. Tip is at the top of the cone — local
  // y at obelisk.position.y + obelisk geometry's height/2.
  const tipLocal = new THREE.Vector3();
  s.obelisk.getWorldPosition(tipLocal);
  // Obelisk geometry is a 1.6u tall cone; world tip is +0.8 above
  // its center on Y.
  tipLocal.y += 0.8;
  const skyTop = new THREE.Vector3(
    tipLocal.x + (Math.random() - 0.5) * 1.2,
    tipLocal.y + _SKY_STRIKE_HEIGHT,
    tipLocal.z + (Math.random() - 0.5) * 1.2,
  );
  const bolt = buildLightningBolt(skyTop, tipLocal, s.tint, 2);
  scene.add(bolt.mesh);
  s.lightningBolts.push(bolt);
  // Brief impact flash + small spark on the obelisk tip.
  hitBurst(tipLocal, s.tint, 5);
  hitBurst(tipLocal, 0xffffff, 3);
  // Pump obelisk hitFlash so its emissive spikes — reuses the existing
  // ringMat hit-flash machinery in spawners.js updateSpawners.
  s.hitFlash = Math.max(s.hitFlash, 0.18);
}

// =====================================================================
// PYRAMID DESTRUCTION — instead of collapsing, the pyramid grows
// thrusters at its base, charges with lightning, then blasts off into
// the sky. Returns truthy so the caller skips the standard scale-down
// collapse.
// =====================================================================
const _THRUSTER_GEO = new THREE.ConeGeometry(0.55, 1.4, 14, 1, true);

export function launchPyramid(s) {
  if (!s) return;
  s.launching = true;
  s.launchT = 0;

  // Spawn 4 thruster cones under the base, pointing downward, with
  // additive blending for a flame-jet look. We attach them to the
  // outer group (not nestBody) so they don't inherit the body sway.
  const thrusterMat = new THREE.MeshBasicMaterial({
    color: s.tint,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  // White-hot core inside each thruster.
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const positions = [
    [ 0.9, 0,  0.9],
    [-0.9, 0,  0.9],
    [ 0.9, 0, -0.9],
    [-0.9, 0, -0.9],
  ];
  for (const [x, _y, z] of positions) {
    const t = new THREE.Mesh(_THRUSTER_GEO, thrusterMat);
    t.position.set(x, -0.3, z);
    t.rotation.x = Math.PI;          // flip cone tip down
    s.obj.add(t);
    s.thrusterMeshes.push(t);
    // Inner white core, smaller cone.
    const c = new THREE.Mesh(_THRUSTER_GEO, coreMat);
    c.position.set(x, -0.2, z);
    c.scale.setScalar(0.6);
    c.rotation.x = Math.PI;
    s.obj.add(c);
    s.thrusterMeshes.push(c);
  }

  // Charge burst — a few rapid lightning bolts striking the obelisk
  // from all directions to telegraph the launch.
  const tipPos = new THREE.Vector3();
  s.obelisk.getWorldPosition(tipPos);
  tipPos.y += 0.8;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const start = new THREE.Vector3(
      tipPos.x + Math.cos(a) * 6,
      tipPos.y + 4 + Math.random() * 3,
      tipPos.z + Math.sin(a) * 6,
    );
    const b = buildLightningBolt(start, tipPos, s.tint, 3);
    scene.add(b.mesh);
    s.lightningBolts.push(b);
  }

  // Ignition burst at the base.
  hitBurst(new THREE.Vector3(s.pos.x, 0.4, s.pos.z), s.tint, 24);
  hitBurst(new THREE.Vector3(s.pos.x, 0.4, s.pos.z), 0xffffff, 16);
}

// Per-frame tick during the pyramid's launch sequence. Returns true
// once the pyramid has fully cleared the arena and should be removed
// from the scene.
//
// Phases (approx, in seconds since launch start):
//   0.00 – 0.50   CHARGE: stationary, additional lightning bolts +
//                 hitBursts; thrusters pulse.
//   0.50 – 1.00   IGNITION: starts moving up slowly with a wobble.
//   1.00 – 3.00   ASCENT: accelerates upward until offscreen.
//   3.00          DESPAWN: caller removes from scene.
//
export function tickPyramidLaunch(s, dt) {
  if (!s.launching) return false;
  s.launchT += dt;
  const t = s.launchT;

  // Update bolts list every phase.
  if (s.lightningBolts && s.lightningBolts.length) {
    tickLightningBolts(dt, s.lightningBolts);
  }

  if (t < 0.5) {
    // CHARGE — fire occasional bolts, shake the body.
    if (Math.random() < 0.35) {
      const tip = new THREE.Vector3();
      s.obelisk.getWorldPosition(tip);
      tip.y += 0.8;
      const start = new THREE.Vector3(
        tip.x + (Math.random() - 0.5) * 8,
        tip.y + 4 + Math.random() * 4,
        tip.z + (Math.random() - 0.5) * 8,
      );
      const b = buildLightningBolt(start, tip, s.tint, 2);
      scene.add(b.mesh);
      s.lightningBolts.push(b);
    }
    // Tremble.
    if (s.nestBody) {
      s.nestBody.position.x = (Math.random() - 0.5) * 0.06;
      s.nestBody.position.z = (Math.random() - 0.5) * 0.06;
    }
    // Thruster flicker.
    for (const tm of s.thrusterMeshes) {
      tm.scale.y = 1.0 + (Math.random() - 0.5) * 0.4;
    }
  } else if (t < 1.0) {
    // IGNITION — start lifting + thrusters at full burn.
    const f = (t - 0.5) / 0.5;        // 0..1
    s.obj.position.y = f * f * 1.0;    // gentle parabolic start
    if (s.nestBody) {
      s.nestBody.position.x = (Math.random() - 0.5) * 0.04 * (1 - f);
      s.nestBody.position.z = (Math.random() - 0.5) * 0.04 * (1 - f);
    }
    // Lengthen thrusters as they "ramp up".
    for (let i = 0; i < s.thrusterMeshes.length; i++) {
      s.thrusterMeshes[i].scale.y = 1.0 + f * 1.5 + (Math.random() - 0.5) * 0.2;
    }
  } else {
    // ASCENT — rapid acceleration upward.
    const ascentT = t - 1.0;
    // y = 1.0 (from ignition) + integrated acceleration over time.
    // Use a quadratic so the takeoff reads as accelerating.
    s.obj.position.y = 1.0 + ascentT * ascentT * 30;
    // Slight roll for visual flair.
    s.obj.rotation.y += dt * 1.2;
    // Continued thruster flicker.
    for (const tm of s.thrusterMeshes) {
      tm.scale.y = 2.0 + (Math.random() - 0.5) * 0.5;
    }
    // Occasional plume burst as it rises.
    if (Math.random() < 0.25) {
      hitBurst(
        new THREE.Vector3(s.pos.x, s.obj.position.y - 1.0, s.pos.z),
        s.tint, 4
      );
    }
  }

  // Done flag — by t=3.0 the pyramid is high enough that we can
  // safely despawn.
  return t >= 3.0;
}
