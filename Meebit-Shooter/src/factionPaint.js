// factionPaint.js — Boss wave-5 floor hazard system. Bosses belong to
// X / Y / Z factions; every faction-themed boss fight gets a giant
// chapter-tinted letter painted across the arena floor as a damaging
// hazard. Per spec:
//   - 4 paints per fight (cadence handled by bossPatterns)
//   - 1.5s telegraph (low-opacity outline pulse) → solid hazard
//   - Persistent until wave 5 ends
//   - Damage on touch (DOT — same rate as standard hazard tiles)
//   - Pulses gently while active to read as "still hot"
//   - Does not move or rotate
//
// Architecture:
//   Each painted letter is a list of axis-aligned (or rotated)
//   rectangular STRIPS in world space. Each strip carries:
//     - A visual mesh (PlaneGeometry rotated flat on the floor)
//     - Collision rect data (cx, cz, halfW, halfL, angleY) used for
//       the per-frame point-in-rect player damage test
//   We keep strips simple rectangles instead of building a fancy
//   bitmap-painted plane because:
//     - Rectangles are cheap to hit-test (transform point to local,
//       AABB compare)
//     - Strips can be rotated independently (X = two diagonals)
//     - Visuals can be tinted by sharing a material across strips
//
// Layered with the existing hazard systems by being checked from
// main.js separately — does NOT live inside hazards.js because that
// module is style-driven (tetris/galaga/pacman) and faction paint
// is boss-driven, not chapter-style-driven.

import * as THREE from 'three';
import { scene } from './scene.js';

// Currently active paints. Each entry is { strips: [...], letter, tint, born, telegraphDone }.
const _active = [];

// Strip dimensions tuned for ARENA = 50:
// - Letter spans roughly ±25u (50% of arena half-width to leave a
//   safe ring around the edges where the player can't be cornered).
// - Strip width 6u — wide enough to read clearly from overhead camera,
//   narrow enough to dodge by side-stepping.
const STRIP_WIDTH = 6.0;
const LETTER_EXTENT = 25.0;

// Telegraph duration in seconds.
const TELEGRAPH_DURATION = 1.5;

// Standard hazard DOT rate — same as the tile-hazard tick in
// hazards.js so faction paint feels like a familiar damage source
// rather than a new mystery threat.
const DOT_PER_SECOND = 10.0;
const DOT_VFX_INTERVAL = 0.4;

// ---- LETTER GEOMETRY HELPERS ----
//
// Each function returns a list of strip specs: { cx, cz, length, width, angleY }
// where (cx, cz) is the strip's CENTER in world space, length is along
// the strip's local +X axis, width is along its local +Z axis, and
// angleY is the strip's rotation about world Y in radians.

function _stripsForX() {
  const len = LETTER_EXTENT * Math.sqrt(2);  // diagonal across the bounding box
  return [
    { cx: 0, cz: 0, length: len, width: STRIP_WIDTH, angleY:  Math.PI / 4 },
    { cx: 0, cz: 0, length: len, width: STRIP_WIDTH, angleY: -Math.PI / 4 },
  ];
}

function _stripsForY() {
  // Stem: vertical strip from origin to bottom of bounding box.
  // Arms: two diagonals from origin going up-and-out to the top corners.
  const armLen = LETTER_EXTENT * Math.sqrt(2);
  const armAngle = Math.PI / 4;     // 45° upward outward
  return [
    // Vertical stem — covers the bottom half. Length = LETTER_EXTENT
    // so it reaches from y=0 down to y=-LETTER_EXTENT.
    {
      cx: 0,
      cz: -LETTER_EXTENT / 2,
      length: LETTER_EXTENT,
      width: STRIP_WIDTH,
      angleY: Math.PI / 2,           // rotate so length runs along Z
    },
    // Right arm — center is halfway along the diagonal from origin to (+LETTER_EXTENT, +LETTER_EXTENT)
    {
      cx: LETTER_EXTENT / 2,
      cz: LETTER_EXTENT / 2,
      length: armLen,
      width: STRIP_WIDTH,
      angleY: -armAngle,
    },
    // Left arm — symmetric on the other side
    {
      cx: -LETTER_EXTENT / 2,
      cz: LETTER_EXTENT / 2,
      length: armLen,
      width: STRIP_WIDTH,
      angleY: armAngle,
    },
  ];
}

function _stripsForZ() {
  // Top horizontal bar, bottom horizontal bar, diagonal connecting them.
  const horizontal = LETTER_EXTENT * 2;
  const diagonalLen = Math.sqrt((horizontal * horizontal) + (LETTER_EXTENT * 2) * (LETTER_EXTENT * 2));
  // Diagonal angle — connects (-LETTER_EXTENT, -LETTER_EXTENT) to (+LETTER_EXTENT, +LETTER_EXTENT)
  // is +45°; we want it inverted (top-right to bottom-left): -45°
  return [
    // Top bar
    {
      cx: 0,
      cz: -LETTER_EXTENT,
      length: horizontal,
      width: STRIP_WIDTH,
      angleY: 0,
    },
    // Bottom bar
    {
      cx: 0,
      cz: +LETTER_EXTENT,
      length: horizontal,
      width: STRIP_WIDTH,
      angleY: 0,
    },
    // Diagonal — top-right to bottom-left
    {
      cx: 0,
      cz: 0,
      length: diagonalLen,
      width: STRIP_WIDTH,
      angleY: Math.PI / 4,
    },
  ];
}

function _stripsForLetter(letter) {
  if (letter === 'X') return _stripsForX();
  if (letter === 'Y') return _stripsForY();
  if (letter === 'Z') return _stripsForZ();
  return [];
}

// ---- VISUAL CONSTRUCTION ----
//
// Per-strip mesh: a flat PlaneGeometry positioned at y=0.04 (just
// above the floor — clears tile hazards' y=0.02 layer but stays well
// below props). additive material with chapter tint. We also create
// an OUTLINE-only mesh used during the telegraph phase.

function _makeStripMeshes(spec, tintHex) {
  const geom = new THREE.PlaneGeometry(spec.length, spec.width);
  // Solid filled mesh — what the hazard looks like when active.
  const fillMat = new THREE.MeshBasicMaterial({
    color: tintHex,
    transparent: true,
    opacity: 0.0,                  // animated up during telegraph→solid
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const fill = new THREE.Mesh(geom, fillMat);
  fill.rotation.x = -Math.PI / 2;           // lay flat
  fill.rotation.z = spec.angleY;            // strip's world rotation maps to local Z after the X-flat rotation
  fill.position.set(spec.cx, 0.04, spec.cz);
  scene.add(fill);

  // Outline mesh — same geometry but slightly larger and emissive-only.
  // During telegraph, fade THIS in/out as a pulse so the player sees
  // exactly where the paint is about to land.
  const outlineGeom = new THREE.PlaneGeometry(spec.length + 0.6, spec.width + 0.6);
  const outlineMat = new THREE.MeshBasicMaterial({
    color: tintHex,
    transparent: true,
    opacity: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const outline = new THREE.Mesh(outlineGeom, outlineMat);
  outline.rotation.x = -Math.PI / 2;
  outline.rotation.z = spec.angleY;
  outline.position.set(spec.cx, 0.035, spec.cz);   // slightly under fill so it reads as a halo
  scene.add(outline);

  return { spec, fill, fillMat, outline, outlineMat, geom, outlineGeom };
}

// ---- COLLISION ----
//
// Point-in-strip test: transform the player position into the strip's
// local frame (origin at strip center, +X along strip length, +Z along
// strip width), then compare to half-extents.

function _pointInStrip(strip, px, pz) {
  const dx = px - strip.spec.cx;
  const dz = pz - strip.spec.cz;
  // Inverse rotation: rotate point by -angleY around Y axis
  const c = Math.cos(-strip.spec.angleY);
  const s = Math.sin(-strip.spec.angleY);
  const localX = c * dx - s * dz;
  const localZ = s * dx + c * dz;
  return (Math.abs(localX) <= strip.spec.length / 2)
      && (Math.abs(localZ) <= strip.spec.width / 2);
}

// ---- PUBLIC API ----

/**
 * Paint a faction-letter hazard on the floor. Telegraphs for 1.5s,
 * then becomes a damaging hazard until cleared. Multiple calls layer
 * — bosses fire 4 of these per fight.
 *
 * @param {string} letter   - 'X' | 'Y' | 'Z'
 * @param {number} tintHex  - chapter color (hex int, e.g. 0xff6a1a)
 */
export function paintFactionHazard(letter, tintHex) {
  const specs = _stripsForLetter(letter);
  if (specs.length === 0) return;
  const strips = specs.map(s => _makeStripMeshes(s, tintHex));
  _active.push({
    strips,
    letter,
    tint: tintHex,
    born: performance.now() / 1000,
    telegraphDone: false,
  });
}

/**
 * Wipe every active faction paint. Call on boss death + wave-5 end.
 */
export function clearFactionPaint() {
  for (const paint of _active) {
    for (const s of paint.strips) {
      if (s.fill && s.fill.parent) s.fill.parent.remove(s.fill);
      if (s.outline && s.outline.parent) s.outline.parent.remove(s.outline);
      if (s.geom) s.geom.dispose();
      if (s.outlineGeom) s.outlineGeom.dispose();
      if (s.fillMat) s.fillMat.dispose();
      if (s.outlineMat) s.outlineMat.dispose();
    }
  }
  _active.length = 0;
}

/**
 * Per-frame update: animate telegraph→solid + active pulse, plus
 * apply player DOT damage when standing on a strip. Mirrors the
 * hazards.js hurtPlayerIfOnHazard pattern (same dt-scaled HP drain
 * with periodic VFX flash + audio).
 */
export function updateFactionPaint(dt, playerPos, S, UI, Audio, shake) {
  if (_active.length === 0) return false;
  const tNow = performance.now() / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(tNow * 2.5);

  let damaged = false;

  for (const paint of _active) {
    const age = tNow - paint.born;

    if (age < TELEGRAPH_DURATION) {
      // TELEGRAPH PHASE: outline fades in to a strong pulse, fill
      // stays barely visible. No damage yet — the warning IS the
      // mechanic ("get out of the X about to land").
      const t = age / TELEGRAPH_DURATION;
      const outlineOpacity = 0.20 + 0.40 * t * pulse;
      const fillOpacity = 0.05 * t;
      for (const s of paint.strips) {
        s.outlineMat.opacity = outlineOpacity;
        s.fillMat.opacity = fillOpacity;
      }
      continue;
    }

    if (!paint.telegraphDone) {
      paint.telegraphDone = true;
      if (Audio && Audio.damage) {
        try { Audio.damage(); } catch (e) {}
      }
    }

    // ACTIVE: solid fill with gentle pulse, outline dim halo.
    for (const s of paint.strips) {
      s.fillMat.opacity = 0.55 + 0.20 * pulse;
      s.outlineMat.opacity = 0.20 + 0.10 * pulse;
    }

    // Damage check — is the player standing on any of this paint's strips?
    if (S.invulnTimer > 0) continue;
    let onStrip = false;
    for (const s of paint.strips) {
      if (_pointInStrip(s, playerPos.x, playerPos.z)) { onStrip = true; break; }
    }
    if (onStrip) {
      S.hp -= DOT_PER_SECOND * dt;
      damaged = true;
      S._factionPaintTickTimer = (S._factionPaintTickTimer || 0) - dt;
      if (S._factionPaintTickTimer <= 0) {
        S._factionPaintTickTimer = DOT_VFX_INTERVAL;
        if (UI && UI.damageFlash) UI.damageFlash();
        if (Audio && Audio.damage) try { Audio.damage(); } catch (e) {}
        if (shake) shake(0.10, 0.08);
      }
      if (S.hp <= 0) S.hp = 0;
    }
  }

  return damaged;
}

/** Diagnostic — count active paints. Used by boss patterns to enforce
 *  the 4-paints-per-fight cap. */
export function getActivePaintCount() {
  return _active.length;
}
