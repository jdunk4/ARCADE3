// ============================================================================
// src/waveProps.js — central wave-2 compound layout + dormant prop geometry.
//
// Scope (Stage 3a):
//   - Defines LAYOUT, the single source of truth for WHERE the silo, 3
//     turrets, powerplant, and radio tower sit in the arena.
//   - Exports buildCentralCompound() which spawns the dormant silo,
//     powerplant, and radio tower geometry at chapter start. (Turrets are
//     still built by turrets.js — they just consume LAYOUT.turrets to
//     pick their positions.)
//   - Exports clearCentralCompound() to tear it all down on chapter end.
//
// Not implemented here yet (Stage 3b):
//   - Powerplant "mini city" light-up on POWER completion
//   - Wires from powerplant → turrets + silo
//   - Silo opening / missile raising animation
//   - Generator on the rocket that you shoot
//
// Not implemented here yet (Stage 3c):
//   - Missile launch arc, DOM flash overlay, 20s countdown
//   - Screen darken + shockwave at detonation
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { getCentroidFor, getCenterAngleFor } from './triangles.js';
import { Audio } from './audio.js';

// ---------------------------------------------------------------------------
// LAYOUT — the canonical compound composition.
//
// Stage 3-fix: the silo is no longer fixed at (0,0). It sits at the
// CENTROID of whichever triangle the triangulation system assigned to
// wave 2 for the current chapter. The 3 turrets still form a triangle
// around the silo; the powerplant and radio tower flank it. The whole
// composition rotates so the silo "faces outward" toward the arena wall.
//
// LAYOUT is populated by _recomputeLayout() during buildCentralCompound.
// Consumers (turrets.js, powerupZones.js) read it as a live reference, so
// mutating it in place keeps them in sync without re-exports.
// ---------------------------------------------------------------------------
export const LAYOUT = {
  silo: { x: 0, z: 0 },
  turrets: [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ],
  powerplant: { x: 0, z: 0 },
  radioTower: { x: 0, z: 0 },
};

/**
 * Recompute LAYOUT based on the power-up triangle assignment for the
 * current chapter. Mutates LAYOUT in place so every consumer that
 * imported it as a reference picks up the new coordinates.
 *
 * Coordinate system: the silo sits at the triangle centroid. The three
 * turrets form a triangle of radius 6 around it (tightened from 8 since
 * the wedge is narrower than the full arena). The powerplant and radio
 * tower are offset perpendicular to the wedge's center axis — think of
 * the center axis as a "spine" running from the arena center outward,
 * with the powerplant and radio tower to either side of that spine,
 * slightly closer to the arena wall than the silo.
 */
function _recomputeLayout() {
  const centroid = getCentroidFor('powerup');
  const outward = getCenterAngleFor('powerup');  // away from origin
  const perp = outward + Math.PI / 2;            // perpendicular

  LAYOUT.silo.x = centroid.x;
  LAYOUT.silo.z = centroid.z;

  // 3 turrets 120° apart at r=6 from silo. One points "inward" (back
  // toward arena center) so its firing arc covers the spawn side.
  const turretR = 6;
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3 + outward;
    LAYOUT.turrets[i].x = centroid.x + Math.cos(a) * turretR;
    LAYOUT.turrets[i].z = centroid.z + Math.sin(a) * turretR;
  }

  // Powerplant: offset 10 units along the perpendicular, 4 further out.
  LAYOUT.powerplant.x = centroid.x + Math.cos(perp) * 10 + Math.cos(outward) * 4;
  LAYOUT.powerplant.z = centroid.z + Math.sin(perp) * 10 + Math.sin(outward) * 4;

  // Radio tower: same deal, mirrored perpendicular.
  LAYOUT.radioTower.x = centroid.x - Math.cos(perp) * 10 + Math.cos(outward) * 4;
  LAYOUT.radioTower.z = centroid.z - Math.sin(perp) * 10 + Math.sin(outward) * 4;
}

// ---------------------------------------------------------------------------
// DORMANT GEOMETRY — silo, powerplant, radio tower.
//
// Everything here is intentionally low-cost: cached materials per chapter
// tint, shared geometries across all three props where possible. Every
// mesh is dormant-dim at chapter start; Stage 3b will add "activate"
// helpers that brighten emissives + add moving parts.
// ---------------------------------------------------------------------------

// Shared geometries.
const SILO_BASE_GEO   = new THREE.CylinderGeometry(2.4, 2.6, 0.5, 10);
const SILO_TUBE_GEO   = new THREE.CylinderGeometry(1.8, 1.8, 4.5, 10, 1, true);
const SILO_CAP_GEO    = new THREE.CylinderGeometry(1.85, 1.85, 0.3, 10);
const SILO_RIM_GEO    = new THREE.TorusGeometry(1.85, 0.16, 6, 16);

// v7 silo amp — grain-silo detailing. Inspired by reference photos of
// industrial corrugated grain bins: vertical ribs wrap the full height,
// horizontal banding rings encircle the silo at regular intervals, and
// a conical dome sits on top instead of a flat cap. This reads as a
// real silo silhouette at any angle.
//
// Vertical corrugation ribs — 20 thin vertical strips spaced around the
// tube circumference. Using boxes (not extruded cylinders) keeps draw
// calls cheap. Each rib is tall enough to span the tube and poke out
// slightly so they silhouette against the dome.
const SILO_RIB_GEO    = new THREE.BoxGeometry(0.08, 4.5, 0.18);
// Horizontal banding rings — 3 torus rings wrapping the tube at ~25%,
// 50%, 75% height. Reads as the "bolted section joints" you see on
// real silos.
const SILO_BAND_GEO   = new THREE.TorusGeometry(1.88, 0.08, 6, 20);
// Conical dome cap — a cone seated on top of the tube. Opens (slides
// aside) when the silo launches, same as the old flat cap.
// Silo dome — hemisphere instead of a cone. Two reasons:
//   1. The bottom of a ConeGeometry is a flat capped disc. With the
//      hinged-hatch open animation, that disc rotates up and faces the
//      camera, looking like a giant orange frisbee floating next to
//      the silo. A hemisphere has no flat face — viewed from any angle
//      while open, it just shows the curved underside.
//   2. Visually closer to the reference (real silo blast hatches are
//      domed, not pointed).
//
// SphereGeometry(radius, widthSegs, heightSegs, phiStart, phiLength,
// thetaStart, thetaLength). thetaLength = PI/2 gives the top hemisphere
// only (theta 0..π/2 is north pole down to equator).
const SILO_DOME_GEO   = new THREE.SphereGeometry(1.92, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
// Small sphere finial at the tip of the dome — sells the grain-silo
// silhouette at a glance.
const SILO_FINIAL_GEO = new THREE.SphereGeometry(0.22, 8, 6);
// Dome banding — a single ring at the base of the dome where it meets
// the tube, so the dome-to-tube junction reads as a real seam.
const SILO_DOME_BAND_GEO = new THREE.TorusGeometry(1.92, 0.08, 6, 20);
// Flat disc that closes the hollow underside of the dome hemisphere.
// SILO_DOME_GEO is a half-sphere with no bottom face — without this
// disc, when the cap rotates open during the launch animation, OR at
// certain camera angles even when closed, you can see straight through
// the dome into the silo's empty interior. The disc sits at the dome's
// equator (local y=0 inside the cap group) facing down so it caps off
// the bowl. Material reuses the silo silver mat for visual consistency.
const SILO_DOME_DISC_GEO = new THREE.CircleGeometry(1.92, 20);

// v6 silo detail — structural amp pass.
// Support struts that angle from the base plate up to the tube (4 sides).
const SILO_STRUT_GEO  = new THREE.BoxGeometry(0.25, 2.2, 0.35);
// Riveted armor panels on the tube exterior — 4 vertical strips.
const SILO_PANEL_GEO  = new THREE.BoxGeometry(0.18, 3.8, 0.5);
// Caution stripe ring near the top of the tube (tinted emissive).
const SILO_STRIPE_GEO = new THREE.TorusGeometry(1.87, 0.08, 6, 18);
// Warning light bulbs on top of the struts.
const SILO_LIGHT_GEO  = new THREE.SphereGeometry(0.16, 8, 6);
// Small access hatch near the base (flat box against the tube).
const SILO_HATCH_GEO  = new THREE.BoxGeometry(0.9, 0.7, 0.15);

// Missile geometry — nose cone + body + fins. Sits inside the silo tube
// at rest position (y = -1.8, i.e. fully inside the shaft). During Stage
// 3b it raises to y = +3.8 when the missile is armed. Stage 3c takes
// over and fires it from there.
const MISSILE_BODY_GEO  = new THREE.CylinderGeometry(0.55, 0.55, 3.2, 10);
const MISSILE_NOSE_GEO  = new THREE.ConeGeometry(0.55, 1.1, 10);
const MISSILE_FIN_GEO   = new THREE.BoxGeometry(0.08, 0.8, 0.65);
const MISSILE_LIGHT_GEO = new THREE.SphereGeometry(0.18, 8, 6);

// ----- POWER PLANT (rebuilt) -----
// Modeled after a real industrial cooling-tower power station:
//   - Wide concrete pad
//   - Two cooling towers (tapered "hourglass" cylinders)
//   - Reactor block with bright orange roof
//   - Smaller smokestack with red/white striping
//   - Walk-up control terminal at the front edge
//
// Cooling-tower shape comes from a CylinderGeometry where the top
// radius is smaller than the bottom — gives the classic narrowing
// silhouette. Real cooling towers also have a slight waist; we
// approximate with a 2-segment lathe by using stacked cylinders.
const PP_PAD_GEO      = new THREE.BoxGeometry(7.0, 0.3, 4.5);
const PP_TOWER_LOW_GEO  = new THREE.CylinderGeometry(0.95, 1.20, 1.6, 16);  // bottom flare
const PP_TOWER_MID_GEO  = new THREE.CylinderGeometry(0.78, 0.95, 0.6, 16);  // narrowing waist
const PP_TOWER_TOP_GEO  = new THREE.CylinderGeometry(0.95, 0.78, 1.4, 16);  // re-flaring top
const PP_TOWER_BAND_GEO = new THREE.TorusGeometry(0.95, 0.10, 8, 24);       // orange band at waist
const PP_REACTOR_GEO    = new THREE.BoxGeometry(2.4, 1.4, 1.6);             // reactor block
const PP_REACTOR_ROOF_GEO = new THREE.BoxGeometry(2.5, 0.18, 1.7);          // bright orange roof
const PP_STACK_GEO    = new THREE.CylinderGeometry(0.22, 0.28, 2.6, 10);    // small smokestack
const PP_STACK_BAND_GEO = new THREE.TorusGeometry(0.25, 0.04, 6, 16);       // red striping
const PP_WINDOW_GEO   = new THREE.PlaneGeometry(0.32, 0.32);
// Chimney-tip flame: a small cone that glows when the powerplant is lit.
const PP_FLAME_GEO    = new THREE.ConeGeometry(0.18, 0.5, 6);

// Walk-up terminal — small console + screen on top of a base. Used at
// BOTH the powerplant and radio tower. Single set of geometry shared
// between them since they're the same control-panel concept.
const TERMINAL_BASE_GEO   = new THREE.BoxGeometry(0.7, 0.7, 0.4);
const TERMINAL_SCREEN_GEO = new THREE.BoxGeometry(0.55, 0.45, 0.05);
const TERMINAL_PANEL_GEO  = new THREE.BoxGeometry(0.5, 0.05, 0.3);

// ----- RADIO TOWER (rebuilt) -----
// Modeled after a tall lattice radio mast with a parabolic dish:
//   - Concrete pad
//   - Square truss tower built from 4 corner posts + diagonal X-bracing
//     at multiple levels
//   - Parabolic dish + feed horn at the top
//   - Aircraft-warning beacon at the very tip
//   - Walk-up terminal at the base
const RT_PAD_GEO      = new THREE.BoxGeometry(2.6, 0.3, 2.6);
const RT_LEG_GEO      = new THREE.CylinderGeometry(0.06, 0.06, 7.2, 6);     // 4 corner posts
const RT_BRACE_GEO    = new THREE.BoxGeometry(1.6, 0.04, 0.04);             // diagonal X braces
const RT_PLATFORM_GEO = new THREE.BoxGeometry(1.0, 0.06, 1.0);              // platform below dish
// Parabolic dish: a hollow hemisphere flipped so the open side faces
// outward. We use a SphereGeometry slice (top hemisphere only),
// rotated so its open side points horizontally. Mounted on a short
// boom that extends from the tower top.
const RT_DISH_GEO     = new THREE.SphereGeometry(0.85, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2.4);
const RT_DISH_BOOM_GEO = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 6);
const RT_DISH_FEED_GEO = new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6);    // feed horn
const RT_BEACON_GEO   = new THREE.SphereGeometry(0.16, 8, 6);

// Cached materials keyed by chapter tint.
const _bodyMatCache    = new Map();  // dark metal — same for every chapter
const _accentDimCache  = new Map();  // dim chapter-tint emissive (dormant)
const _rimCache        = new Map();  // small bright accent edges
const _windowDimCache  = new Map();  // powerplant windows when dormant
// NEW for stage 3b:
const _windowLitCache  = new Map();  // bright "mini city" windows (POWER online)
const _flameCache      = new Map();  // chimney flame emissive
const _missileBodyMat  = new Map();  // missile body (metal + tint rim)
const _missileLightCache = new Map();// missile blinker lights (bright tint)

function _getBodyMat() {
  if (_bodyMatCache.has('_')) return _bodyMatCache.get('_');
  const m = new THREE.MeshStandardMaterial({
    color: 0x3e4250,
    roughness: 0.45,
    metalness: 0.78,
    // Added emissive so the body has SOME self-illumination even in
    // dim arena lighting. Without this, the dark gunmetal reads as
    // pure black against the dark floor and the gold/silver/copper
    // trim is the only visible part. Subtle warm-grey emissive at low
    // intensity keeps "metal" feel while preventing "black void."
    emissive: 0x4a4e5a,
    emissiveIntensity: 0.45,
  });
  _bodyMatCache.set('_', m);
  return m;
}

// ----- TRIM MATERIALS -----
// High-tech metallic accents used on power plant + radio tower to break
// up the dark body and read as "advanced engineered hardware" vs raw
// industrial. Three trims:
//   - gold:   warm yellow polished metal — used for piping accents,
//             corner caps, important panels
//   - silver: bright polished silver — used for structural rails,
//             window frames, edge highlights
//   - copper: warm orange-brown metal — used for power conduit
//             accents, riveted bands
// Each is a single shared material (no chapter-tint variants) so all
// chapters read consistently as "real metal." High metalness + low
// roughness gives them a clean specular highlight under the existing
// scene lighting.
function _getGoldMat() {
  if (_bodyMatCache.has('gold')) return _bodyMatCache.get('gold');
  const m = new THREE.MeshStandardMaterial({
    color: 0xd4a440,
    // Bumped emissive from 0x2a1d08 / 0.4 → brighter glow that reads
    // better against the dark gunmetal body in low-light arenas.
    emissive: 0x6b4a14,
    emissiveIntensity: 0.85,
    metalness: 0.95,
    roughness: 0.28,
  });
  _bodyMatCache.set('gold', m);
  return m;
}
function _getSilverTrimMat() {
  if (_bodyMatCache.has('silvertrim')) return _bodyMatCache.get('silvertrim');
  const m = new THREE.MeshStandardMaterial({
    color: 0xc8ccd2,
    // Bumped emissive — silver doesn't naturally emit but a subtle glow
    // helps it pop on the prop instead of fading into the body color.
    emissive: 0x4a5060,
    emissiveIntensity: 0.65,
    metalness: 0.92,
    roughness: 0.22,
  });
  _bodyMatCache.set('silvertrim', m);
  return m;
}
function _getCopperMat() {
  if (_bodyMatCache.has('copper')) return _bodyMatCache.get('copper');
  const m = new THREE.MeshStandardMaterial({
    color: 0xb8743a,
    // Bumped emissive — copper conduits read as "active power lines"
    // when they glow warm orange against the dark body.
    emissive: 0x8a3a14,
    emissiveIntensity: 0.95,
    metalness: 0.92,
    roughness: 0.32,
  });
  _bodyMatCache.set('copper', m);
  return m;
}

// Brushed-silver metal used on the silo tube, cap, and armor panels.
// The default body mat is a very dark blue-grey that reads as near-black
// from the game's low-angle camera, giving the silo a flat black
// silhouette. Silver metal breaks that up and makes the silo look like
// an actual piece of military hardware next to the darker powerplant.
// Emissive tuned bright enough that the silo reads silver even in dim
// chapters (red/purple chapters had the earlier dim emissive washing
// into the environment color).
function _getSiloSilverMat(tint) {
  const key = 'silver:' + tint;
  if (_bodyMatCache.has(key)) return _bodyMatCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    color: 0xcfd4dc,          // brighter brushed silver
    emissive: 0xb8bec8,       // self-lit silver — locked to metal color,
                              // not chapter tint, so the silo reads as a
                              // silver object regardless of arena palette.
    emissiveIntensity: 0.22,  // up from 0.08 — makes the silo visibly pop
    roughness: 0.3,           // glossier than before so highlights bounce
    metalness: 0.9,           // reads as real polished metal
  });
  _bodyMatCache.set(key, m);
  return m;
}

// DoubleSide variant of the silver material — used ONLY for the launch-shaft
// tube. The tube geometry is `openEnded: true` (no caps on top/bottom) so
// the dome can slide off and reveal the shaft. With the default FrontSide
// material, back-face culling hid the tube's inside walls — once the dome
// opened, the camera looking down into the silo saw straight through to
// the far outside wall, making one side of the silo look un-textured.
// DoubleSide makes the interior render too.
function _getSiloSilverTubeMat(tint) {
  const key = 'silver-tube:' + tint;
  if (_bodyMatCache.has(key)) return _bodyMatCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    color: 0xcfd4dc,
    emissive: 0xb8bec8,
    emissiveIntensity: 0.22,
    roughness: 0.3,
    metalness: 0.9,
    side: THREE.DoubleSide,
  });
  _bodyMatCache.set(key, m);
  return m;
}

function _getAccentDim(tint) {
  let m = _accentDimCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x1a1a2a,
      emissive: tint,
      emissiveIntensity: 0.20,
      metalness: 0.4, roughness: 0.55,
    });
    _accentDimCache.set(tint, m);
  }
  return m;
}

function _getRimMat(tint) {
  let m = _rimCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x2a2a40,
      emissive: tint,
      emissiveIntensity: 0.6,
      metalness: 0.7, roughness: 0.35,
    });
    _rimCache.set(tint, m);
  }
  return m;
}

function _getWindowDim(tint) {
  let m = _windowDimCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    });
    _windowDimCache.set(tint, m);
  }
  return m;
}

// Stage 3b: once POWER completes, every powerplant window swaps to this
// material — bright, fully opaque, "mini city" feel.
function _getWindowLit(tint) {
  let m = _windowLitCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: false,
      opacity: 1.0,
      side: THREE.DoubleSide,
    });
    _windowLitCache.set(tint, m);
  }
  return m;
}

function _getFlameMat(tint) {
  let m = _flameCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.0,        // invisible while dormant; the updater bumps
                            // this up when the powerplant is lit
    });
    _flameCache.set(tint, m);
  }
  return m;
}

function _getMissileBodyMat(tint) {
  let m = _missileBodyMat.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      emissive: tint,
      emissiveIntensity: 0.35,
      metalness: 0.75,
      roughness: 0.30,
    });
    _missileBodyMat.set(tint, m);
  }
  return m;
}

function _getMissileLightMat(tint) {
  let m = _missileLightCache.get(tint);
  if (!m) {
    // MeshBasic so it stays bright regardless of scene lighting; we pulse
    // the opacity each frame once the missile is up.
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.9,
    });
    _missileLightCache.set(tint, m);
  }
  return m;
}

/** Prewarm every chapter's materials so the wave-2 prop spawn is free. */
export function prewarmWavePropsMats(tint) {
  _getBodyMat();
  _getAccentDim(tint);
  _getRimMat(tint);
  _getWindowDim(tint);
  _getWindowLit(tint);
  _getFlameMat(tint);
  _getMissileBodyMat(tint);
  _getMissileLightMat(tint);
}

// ---------------------------------------------------------------------------
// BUILDERS — return a group positioned at the layout coord. All returned
// groups are parented to the scene inside buildCentralCompound().
// ---------------------------------------------------------------------------

function _buildSilo(tint) {
  const g = new THREE.Group();
  g.position.set(LAYOUT.silo.x, 0, LAYOUT.silo.z);

  // --- BASE PLATE ---
  const base = new THREE.Mesh(SILO_BASE_GEO, _getAccentDim(tint));
  base.position.y = 0.25;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // --- OPEN TUBE (launch shaft) ---
  // Uses the DoubleSide silver variant so the interior walls render when
  // the dome is open and the camera can see down into the shaft.
  const tube = new THREE.Mesh(SILO_TUBE_GEO, _getSiloSilverTubeMat(tint));
  tube.position.y = 2.75;
  g.add(tube);

  // --- v6 DETAIL: 4 SUPPORT STRUTS ---
  // Angled vertical braces running from the base plate up the side of
  // the tube. One on each cardinal direction. These read as structural
  // reinforcement and break up the plain tube silhouette.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;   // 45° offset
    const strut = new THREE.Mesh(SILO_STRUT_GEO, _getAccentDim(tint));
    strut.position.set(Math.cos(a) * 2.1, 1.4, Math.sin(a) * 2.1);
    strut.rotation.y = -a;
    strut.castShadow = true;
    g.add(strut);

    // Warning light on top of each strut, chapter-tinted.
    const light = new THREE.Mesh(SILO_LIGHT_GEO, _getRimMat(tint));
    light.position.set(Math.cos(a) * 2.1, 2.55, Math.sin(a) * 2.1);
    g.add(light);
  }

  // --- v7 DETAIL: VERTICAL CORRUGATION RIBS ---
  // 20 thin silver ribs wrapping the full circumference at r ≈ 1.85. Each
  // rib is silver material so it picks up highlights separately from the
  // tube, giving the real corrugated-grain-silo texture you see on every
  // industrial bin. Replaces the old 4 armor panels (which were widely
  // spaced and read as "sci-fi bunker", not "grain silo").
  const RIB_COUNT = 20;
  const ribMat = _getSiloSilverMat(tint);
  for (let i = 0; i < RIB_COUNT; i++) {
    const a = (i / RIB_COUNT) * Math.PI * 2;
    const rib = new THREE.Mesh(SILO_RIB_GEO, ribMat);
    rib.position.set(Math.cos(a) * 1.85, 2.75, Math.sin(a) * 1.85);
    rib.rotation.y = -a;
    g.add(rib);
  }

  // --- v7 DETAIL: HORIZONTAL BANDING RINGS ---
  // Three wrapping bands at ~25%, 50%, 75% of the tube height. These
  // read as the bolted section seams on a real silo.
  const bandMat = _getSiloSilverMat(tint);
  for (let i = 0; i < 3; i++) {
    const band = new THREE.Mesh(SILO_BAND_GEO, bandMat);
    // Tube spans y = 0.5..5.0; place bands within that range.
    band.position.y = 1.6 + i * 1.2;
    band.rotation.x = Math.PI / 2;
    g.add(band);
  }

  // --- v6 DETAIL: CAUTION STRIPE near the top ---
  // Emissive chapter-tinted ring hugging the tube's upper portion.
  const stripe = new THREE.Mesh(SILO_STRIPE_GEO, _getRimMat(tint));
  stripe.position.y = 4.3;
  stripe.rotation.x = Math.PI / 2;
  g.add(stripe);

  // --- v6 DETAIL: ACCESS HATCH at the base ---
  const hatch = new THREE.Mesh(SILO_HATCH_GEO, _getAccentDim(tint));
  hatch.position.set(0, 1.1, 1.85);
  g.add(hatch);
  // Small emissive door indicator on the hatch.
  const hatchIndicator = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.08, 0.03),
    _getRimMat(tint),
  );
  hatchIndicator.position.set(0, 1.35, 1.93);
  g.add(hatchIndicator);

  // --- v7 DETAIL: CONICAL DOME + FINIAL ---
  // Replaces the old flat cap. The dome is a cone whose base sits flush
  // with the top of the tube; a small spherical finial crowns it. Named
  // CAP — hinged hatch design. Modeled after a missile-silo blast hatch:
  // hinged on one edge of the rim, swings up and back when opening
  // instead of sliding off horizontally. The hinge axis is the silo's
  // -Z edge of the rim, and opening rotates the cap around that hinge
  // by ~110° (top tilts up and slightly past vertical).
  //
  // Implementation: an outer Group `cap` is positioned AT the hinge
  // point (silo top, at -Z rim edge). All cap geometry lives inside an
  // inner offset that puts the pieces back over the silo center. When
  // we apply rotation.x to `cap`, the whole hatch rotates around the
  // hinge edge.
  //
  // Backward-compat note: the launch-open animation in updateCompound
  // previously mutated cap.position.x / position.y / rotation.z. With
  // the hatch redesign, the animation drives ONLY cap.rotation.x, and
  // the per-frame "force snap to closed" code now resets only that.
  // See updateCompound's cap branch.
  const cap = new THREE.Group();
  // Hinge sits on the back edge of the rim at silo top (x=0, y=5.1,
  // z=-tubeRadius). SILO_TUBE_GEO is built with radius 1.6 (matches
  // the dome's outer radius below).
  const HINGE_Z = -1.55;       // back edge of the silo rim
  cap.position.set(0, 5.1, HINGE_Z);
  // Inner offset group: shifts every cap piece back into +Z so it sits
  // centered over the silo when the hatch is closed.
  const capInner = new THREE.Group();
  capInner.position.z = -HINGE_Z;   // = +1.55, restoring center
  cap.add(capInner);
  const dome = new THREE.Mesh(SILO_DOME_GEO, _getSiloSilverMat(tint));
  // Hemisphere base sits at local y=0 (equator), curving up to y=1.92
  // (the radius). With the cap origin on the silo rim, this puts the
  // dome's equator right at the rim — matching the look of a missile-
  // silo blast hatch sitting flush on top.
  dome.position.y = 0;
  dome.castShadow = true;
  capInner.add(dome);
  const domeBand = new THREE.Mesh(SILO_DOME_BAND_GEO, _getSiloSilverMat(tint));
  // Band ring sits at the equator (was 0.05 above the cone's base —
  // now flush with the dome's base).
  domeBand.position.y = 0;
  domeBand.rotation.x = Math.PI / 2;
  capInner.add(domeBand);
  const finial = new THREE.Mesh(SILO_FINIAL_GEO, _getSiloSilverMat(tint));
  // Finial sits at the dome's apex. Hemisphere radius is 1.92, so the
  // top of the dome is at local y=1.92. Drop the finial slightly below
  // the apex so it nests cleanly without floating.
  finial.position.y = 1.92;
  capInner.add(finial);
  // Bottom-cap disc — closes the open underside of the dome hemisphere.
  // Without this, the SphereGeometry(0..PI/2) leaves the bottom face
  // hollow, and the SILO_TUBE_GEO is also open-ended (last param
  // `true`), so during the launch cinematic OR at certain camera
  // angles the player sees through the dome into the empty silo
  // interior. The disc sits flush at the dome's equator (local y=0)
  // facing DOWN so its visible surface is what you see when looking
  // up at the cap from below.
  const domeDisc = new THREE.Mesh(SILO_DOME_DISC_GEO, _getSiloSilverMat(tint));
  domeDisc.position.y = 0;
  domeDisc.rotation.x = Math.PI / 2;     // lay flat, normal pointing DOWN
  capInner.add(domeDisc);
  g.add(cap);

  // Chapter-tinted rim around the opening — easy readable accent
  const rim = new THREE.Mesh(SILO_RIM_GEO, _getRimMat(tint));
  rim.position.y = 5.25;
  rim.rotation.x = Math.PI / 2;
  g.add(rim);

  // --- MISSILE (stage 3b: hidden inside the tube at rest; raises up
  //     above the silo when RADIO completes) ---
  const missile = new THREE.Group();
  // Rest Y = 1.8, below the silo top so it's invisible inside the shaft.
  // Stage 3b updater lerps this up to 6.5 over ~1.5s after RADIO.
  missile.position.y = 1.8;

  const missileBodyMat = _getMissileBodyMat(tint);
  const bodyMesh = new THREE.Mesh(MISSILE_BODY_GEO, missileBodyMat);
  bodyMesh.position.y = 0;
  bodyMesh.castShadow = true;
  missile.add(bodyMesh);

  const noseMesh = new THREE.Mesh(MISSILE_NOSE_GEO, missileBodyMat);
  noseMesh.position.y = 2.15;
  noseMesh.castShadow = true;
  missile.add(noseMesh);

  // Four fins in a cross pattern at the base of the missile body.
  for (let f = 0; f < 4; f++) {
    const fin = new THREE.Mesh(MISSILE_FIN_GEO, missileBodyMat);
    const a = f * (Math.PI / 2);
    fin.position.set(Math.sin(a) * 0.6, -1.3, Math.cos(a) * 0.6);
    fin.rotation.y = a;
    missile.add(fin);
  }

  // Blinker lights on all 4 sides of the missile body — 3 vertical
  // positions × 4 cardinal directions = 12 total. Stage 3b pulses their
  // opacity once the missile is raised. Having them on every side means
  // the player can see the blink no matter which way they're looking.
  // Each blinker clones the cached material so its opacity can be tweened
  // individually — otherwise all 12 would pulse in unison.
  const blinkerLights = [];
  const blinkMatShared = _getMissileLightMat(tint);
  for (let side = 0; side < 4; side++) {
    const a = side * (Math.PI / 2);
    const bx = Math.sin(a) * 0.58;
    const bz = Math.cos(a) * 0.58;
    for (let i = 0; i < 3; i++) {
      const perLightMat = blinkMatShared.clone();
      const light = new THREE.Mesh(MISSILE_LIGHT_GEO, perLightMat);
      light.position.set(bx, -0.8 + i * 0.9, bz);
      // Tag with side/index so the update loop can drive a rolling pattern.
      light.userData.side = side;
      light.userData.ring = i;     // 0 = bottom, 2 = top
      missile.add(light);
      blinkerLights.push(light);
    }
  }

  g.add(missile);
  // Hide the missile visually until stage 3b's activation fires.
  missile.visible = false;

  scene.add(g);
  return {
    obj: g, cap, tube, rim,
    missile,                // group reference for raise animation
    blinkerLights,          // for the blinker pulse
    // Animation state (driven by updateCompound)
    capOpenT: 0,            // 0 = closed, 1 = fully open
    capOpenTarget: 0,       // where capOpenT is heading
    missileRaiseT: 0,       // 0 = at rest (inside); 1 = fully up
    missileRaiseTarget: 0,  // where missileRaiseT is heading
  };
}

function _buildPowerplant(tint) {
  const g = new THREE.Group();
  g.position.set(LAYOUT.powerplant.x, 0, LAYOUT.powerplant.z);

  // Concrete pad — wider footprint than the previous design to fit
  // the cooling towers + reactor + stack arrangement.
  const pad = new THREE.Mesh(PP_PAD_GEO, _getBodyMat());
  pad.position.y = 0.15;
  pad.castShadow = true;
  pad.receiveShadow = true;
  g.add(pad);

  // Two cooling towers, side by side. Each tower is built from three
  // stacked cylinders (bottom flare, narrowing waist, re-flaring top)
  // to approximate the iconic hourglass shape, plus a chapter-tinted
  // band at the waist to read as the orange ring in the reference.
  const flames = [];
  const flameMat = _getFlameMat(tint);
  const bandMat = _getRimMat(tint);
  for (const tx of [-2.0, 0]) {        // tower X offsets along pad
    const towerZ = -0.8;                // pushed back on the pad
    // Bottom flare
    const tLow = new THREE.Mesh(PP_TOWER_LOW_GEO, _getBodyMat());
    tLow.position.set(tx, 0.30 + 0.8, towerZ);
    tLow.castShadow = true;
    g.add(tLow);
    // Mid waist (narrower)
    const tMid = new THREE.Mesh(PP_TOWER_MID_GEO, _getBodyMat());
    tMid.position.set(tx, 0.30 + 1.6 + 0.3, towerZ);
    tMid.castShadow = true;
    g.add(tMid);
    // Re-flaring top
    const tTop = new THREE.Mesh(PP_TOWER_TOP_GEO, _getBodyMat());
    tTop.position.set(tx, 0.30 + 2.2 + 0.7, towerZ);
    tTop.castShadow = true;
    g.add(tTop);
    // Orange waist band — sits at the narrow waist of the tower
    const band = new THREE.Mesh(PP_TOWER_BAND_GEO, bandMat);
    band.position.set(tx, 0.30 + 1.9, towerZ);
    band.rotation.x = Math.PI / 2;
    g.add(band);
    // Faint flame puff at top — driven by lit-state animation; reuses
    // the flame mat the old code expected so updateCompound can still
    // animate ramp-up.
    const flame = new THREE.Mesh(PP_FLAME_GEO, flameMat);
    flame.position.set(tx, 0.30 + 3.7, towerZ);
    g.add(flame);
    flames.push(flame);
  }

  // Reactor block — sits in front of the cooling towers. The roof is
  // a separate bright orange slab so the reactor looks crowned with
  // chapter color even before lighting up.
  const reactor = new THREE.Mesh(PP_REACTOR_GEO, _getAccentDim(tint));
  reactor.position.set(1.6, 0.30 + 0.7, 1.2);
  reactor.castShadow = true;
  g.add(reactor);
  const reactorRoof = new THREE.Mesh(PP_REACTOR_ROOF_GEO, _getRimMat(tint));
  reactorRoof.position.set(1.6, 0.30 + 1.4 + 0.09, 1.2);
  g.add(reactorRoof);

  // Window grid on the reactor — same lit/dim swap behavior as before,
  // just relocated onto the new reactor block face. Six windows on the
  // front (+Z) face: 2 rows x 3 columns.
  const windows = [];
  const windowMat = _getWindowDim(tint);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const w = new THREE.Mesh(PP_WINDOW_GEO, windowMat);
      // Reactor center is at (1.6, 1.0, 1.2). Front face is at z=1.2+0.81.
      // Window grid centered on that face.
      w.position.set(1.0 + col * 0.6, 0.65 + row * 0.55, 1.2 + 0.81);
      g.add(w);
      windows.push(w);
    }
  }

  // Small smokestack — short red-and-white striped chimney for variety.
  const stack = new THREE.Mesh(PP_STACK_GEO, _getBodyMat());
  stack.position.set(2.8, 0.30 + 1.3, -0.5);
  stack.castShadow = true;
  g.add(stack);
  // Two tinted bands along the stack
  for (const sy of [0.30 + 1.0, 0.30 + 2.0]) {
    const sb = new THREE.Mesh(PP_STACK_BAND_GEO, bandMat);
    sb.position.set(2.8, sy, -0.5);
    sb.rotation.x = Math.PI / 2;
    g.add(sb);
  }

  // Walk-up control terminal. Sits at the front edge of the pad facing
  // outward (+Z) so the player approaches it from arena center.
  // Three-piece: dark base box, slanted control panel, glowing screen.
  const terminalGroup = new THREE.Group();
  terminalGroup.position.set(-2.6, 0.30, 1.7);
  const tBase = new THREE.Mesh(TERMINAL_BASE_GEO, _getBodyMat());
  tBase.position.y = 0.35;
  terminalGroup.add(tBase);
  const tPanel = new THREE.Mesh(TERMINAL_PANEL_GEO, _getBodyMat());
  tPanel.position.set(0, 0.7, 0.06);
  tPanel.rotation.x = -0.4;   // slanted toward the player
  terminalGroup.add(tPanel);
  const tScreen = new THREE.Mesh(TERMINAL_SCREEN_GEO, _getRimMat(tint));
  tScreen.position.set(0, 0.78, 0.20);
  tScreen.rotation.x = -0.4;
  terminalGroup.add(tScreen);
  g.add(terminalGroup);

  // ----- HIGH-TECH TRIM ACCENTS -----
  // Small metallic detail meshes layered on top of the existing body
  // geometry to break up the dark base and read as "engineered hardware"
  // not "concrete bunker." Three palettes used: GOLD for important
  // accents, SILVER for structural rails, COPPER for power conduits.
  // All pieces are lightweight (boxes, thin tori) so the per-prop cost
  // stays under ~10 extra meshes.
  //
  // Pad rim — gold band that wraps the front-facing edge of the
  // concrete pad. Reads as "polished trim" against the dark pad.
  const padRimFront = new THREE.Mesh(
    new THREE.BoxGeometry(7.0, 0.08, 0.08),
    _getGoldMat(),
  );
  padRimFront.position.set(0, 0.32, 2.21);
  g.add(padRimFront);
  // Two corner caps at the front of the pad — silver squares.
  for (const cx of [-3.4, 3.4]) {
    const corner = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.4, 0.25),
      _getSilverTrimMat(),
    );
    corner.position.set(cx, 0.30, 2.10);
    g.add(corner);
  }
  // Copper power-conduit pipe running along the bottom-back of the pad
  // — connects the cooling towers to the reactor visually.
  const conduitGeo = new THREE.CylinderGeometry(0.10, 0.10, 4.5, 10);
  const conduit = new THREE.Mesh(conduitGeo, _getCopperMat());
  conduit.position.set(-0.5, 0.55, -1.95);
  conduit.rotation.z = Math.PI / 2;
  g.add(conduit);
  // Two copper rivets along the conduit
  for (const rx of [-2.2, 1.2]) {
    const rivet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 0.18, 8),
      _getCopperMat(),
    );
    rivet.position.set(rx, 0.55, -1.95);
    rivet.rotation.z = Math.PI / 2;
    g.add(rivet);
  }
  // Gold rim around the reactor block — frames the orange roof
  // accent into a more "important machinery" silhouette.
  const reactorTrim = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.10, 1.8),
    _getGoldMat(),
  );
  reactorTrim.position.set(1.6, 0.30 + 1.4 - 0.05, 1.2);
  g.add(reactorTrim);

  // ============================================================================
  // DETAIL LAYERS — bunker/mech-style accents on top of the existing
  // body geometry. All ADDITIVE — no existing meshes removed. Reads as
  // "industrial heavy-armor power plant" instead of just "concrete box
  // with cylinders." Geometry is intentionally simple (boxes, thin tori,
  // small cylinders) so the per-prop budget stays modest.
  // ============================================================================

  // ---- TIER 2 + TIER 3 REACTOR ROOF ----
  // Existing: a single PP_REACTOR_ROOF_GEO slab at y ~= 0.30 + 1.4 + 0.09.
  // Layered ON TOP: a smaller stepped tier (tier 2), then an even smaller
  // central cap (tier 3), like the stacked bunker in the reference.
  // Reactor center is (1.6, _, 1.2). Existing roof is 2.4 wide × 1.6 deep.
  const reactorRoofTier2 = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.18, 1.0),
    _getRimMat(tint),
  );
  reactorRoofTier2.position.set(1.6, 0.30 + 1.4 + 0.18 + 0.09, 1.2);
  g.add(reactorRoofTier2);
  const reactorRoofTier3 = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.16, 0.55),
    _getGoldMat(),
  );
  reactorRoofTier3.position.set(1.6, 0.30 + 1.4 + 0.18 + 0.18 + 0.16, 1.2);
  g.add(reactorRoofTier3);
  // Antenna spike — thin cylinder + small ball finial on top of tier 3
  const antennaShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.06, 0.9, 8),
    _getSilverTrimMat(),
  );
  antennaShaft.position.set(1.6, 0.30 + 1.4 + 0.18 + 0.18 + 0.16 + 0.45, 1.2);
  g.add(antennaShaft);
  const antennaBulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.10, 8, 6),
    _getRimMat(tint),
  );
  antennaBulb.position.set(1.6, 0.30 + 1.4 + 0.18 + 0.18 + 0.16 + 0.92, 1.2);
  g.add(antennaBulb);

  // ---- SIDE VENT GRILLES ----
  // Three thin horizontal slats stacked vertically on each side of the
  // reactor block. Reads as "cooling vents." Reactor block is 2.4 wide
  // × 1.4 tall × 1.6 deep, centered at (1.6, 0.30+0.7, 1.2). Side faces
  // are at x = 1.6 ± 1.2.
  const slatMat = _getCopperMat();
  for (const sideX of [-1.21, +1.21]) {
    for (let row = 0; row < 3; row++) {
      const slat = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.10, 1.05),
        slatMat,
      );
      slat.position.set(1.6 + sideX, 0.30 + 0.45 + row * 0.30, 1.2);
      g.add(slat);
    }
  }

  // ---- HAZARD STRIPE BASES ----
  // Thin tinted rings (use orange band material) wrapped around the
  // bottom flare of each cooling tower — reads as a warning band.
  // Towers at (tx, 0.30 + 0.8, -0.8) with TOWER_LOW radius ≈ 0.85.
  for (const tx of [-2.0, 0]) {
    const hazardBand = new THREE.Mesh(
      new THREE.TorusGeometry(0.88, 0.07, 6, 16),
      bandMat,                          // chapter-tinted band material from earlier
    );
    hazardBand.position.set(tx, 0.30 + 0.40, -0.8);
    hazardBand.rotation.x = Math.PI / 2;
    g.add(hazardBand);
  }

  // ---- VERTICAL ARMOR PANELS on cooling towers ----
  // Four thin vertical strips on each tower's lower flare, evenly
  // spaced around the cylinder. Reads as "riveted plating."
  for (const tx of [-2.0, 0]) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, 1.4, 0.08),
        _getSilverTrimMat(),
      );
      panel.position.set(
        tx + Math.cos(a) * 0.85,
        0.30 + 0.80,
        -0.8 + Math.sin(a) * 0.85,
      );
      // Rotate panel so its FACE faces outward from the cylinder axis
      panel.rotation.y = -a + Math.PI / 2;
      g.add(panel);
    }
  }

  // ---- WINDOW FRAMES ----
  // Thin gold L-frames around each of the 6 windows. Each window is
  // already at (1.0 + col*0.6, 0.65 + row*0.55, 1.2 + 0.81). Frame is
  // a flat plus-sign shape (top + left edges of each window) for a
  // cheap "industrial trim" read.
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const wx = 1.0 + col * 0.6;
      const wy = 0.65 + row * 0.55;
      const wz = 1.2 + 0.82;          // 0.01u in front of the windows
      // Top edge of frame
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.04, 0.02),
        _getGoldMat(),
      );
      top.position.set(wx, wy + 0.20, wz);
      g.add(top);
      // Left edge of frame
      const left = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.42, 0.02),
        _getGoldMat(),
      );
      left.position.set(wx - 0.20, wy, wz);
      g.add(left);
    }
  }

  // ---- ADDITIONAL RIVETS along pad edges ----
  // Six small bolt heads spread along the pad's front edge for the
  // "heavy plating" read. Pad rim is at z=2.21; rivets sit just below.
  for (let i = 0; i < 6; i++) {
    const rx = -3.0 + i * 1.2;
    const rivet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.10, 0.10, 0.10, 8),
      _getSilverTrimMat(),
    );
    rivet.position.set(rx, 0.30, 2.10);
    rivet.rotation.x = Math.PI / 2;
    g.add(rivet);
  }
  // Four rivets along the back edge as well
  for (let i = 0; i < 4; i++) {
    const rx = -2.4 + i * 1.6;
    const rivet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.10, 8),
      _getCopperMat(),
    );
    rivet.position.set(rx, 0.30, -2.10);
    rivet.rotation.x = Math.PI / 2;
    g.add(rivet);
  }

  scene.add(g);
  return { obj: g, reactor, windows, flames, tint, lit: false, terminal: terminalGroup, terminalScreen: tScreen };
}

function _buildRadioTower(tint) {
  const g = new THREE.Group();
  g.position.set(LAYOUT.radioTower.x, 0, LAYOUT.radioTower.z);

  // Concrete pad
  const pad = new THREE.Mesh(RT_PAD_GEO, _getAccentDim(tint));
  pad.position.y = 0.15;
  pad.castShadow = true;
  pad.receiveShadow = true;
  g.add(pad);

  // Square lattice tower — 4 corner posts + diagonal cross-bracing at
  // multiple levels. Posts are 7.2u tall, footprint 1.0u square at the
  // base tapering slightly. Bracing alternates X-pattern between
  // levels so the tower reads as a real truss from any angle.
  const LEG_SPREAD = 0.45;             // half-width of square base
  const LEG_HEIGHT = 7.2;
  const TOWER_BASE_Y = 0.30;
  const legPositions = [
    [+LEG_SPREAD, +LEG_SPREAD],
    [-LEG_SPREAD, +LEG_SPREAD],
    [+LEG_SPREAD, -LEG_SPREAD],
    [-LEG_SPREAD, -LEG_SPREAD],
  ];
  for (const [lx, lz] of legPositions) {
    const leg = new THREE.Mesh(RT_LEG_GEO, _getBodyMat());
    leg.position.set(lx, TOWER_BASE_Y + LEG_HEIGHT / 2, lz);
    leg.castShadow = true;
    g.add(leg);
  }
  // X-bracing on each of 4 faces, repeated at 5 vertical levels. Each
  // X is two diagonals between adjacent legs.
  const BRACE_LEVELS = 5;
  const BRACE_SPACING = LEG_HEIGHT / (BRACE_LEVELS + 1);
  for (let level = 0; level < BRACE_LEVELS; level++) {
    const yMid = TOWER_BASE_Y + (level + 1) * BRACE_SPACING;
    // Four faces of the tower — front, back, left, right
    const faces = [
      { axis: 'x', sign: +1 },   // +X face
      { axis: 'x', sign: -1 },   // -X face
      { axis: 'z', sign: +1 },   // +Z face
      { axis: 'z', sign: -1 },   // -Z face
    ];
    for (const face of faces) {
      // Two diagonals per face making an X. The brace geometry is a
      // long thin box; we rotate and position it to span between leg
      // pairs.
      for (const dir of [+1, -1]) {
        const brace = new THREE.Mesh(RT_BRACE_GEO, _getBodyMat());
        if (face.axis === 'x') {
          brace.position.set(face.sign * LEG_SPREAD, yMid, 0);
          brace.rotation.x = dir * Math.atan2(BRACE_SPACING, LEG_SPREAD * 2);
          // brace's local +X is its length; rotate so it spans the Z dimension
          brace.rotation.y = Math.PI / 2;
        } else {
          brace.position.set(0, yMid, face.sign * LEG_SPREAD);
          brace.rotation.z = dir * Math.atan2(BRACE_SPACING, LEG_SPREAD * 2);
        }
        // Scale the brace's X length to span the diagonal precisely.
        const diagLen = Math.sqrt((LEG_SPREAD * 2) ** 2 + BRACE_SPACING ** 2);
        brace.scale.x = diagLen / 1.6;   // 1.6 is the geometry's nominal length
        g.add(brace);
      }
    }
  }

  // Platform at the top of the tower — small flat square the dish sits on
  const platform = new THREE.Mesh(RT_PLATFORM_GEO, _getAccentDim(tint));
  platform.position.y = TOWER_BASE_Y + LEG_HEIGHT + 0.03;
  g.add(platform);

  // Parabolic dish — mounted on a short boom that holds it AT AN ANGLE
  // so it points outward and slightly upward like real microwave/radar
  // dishes. The dish itself is a Group so we can rotate it (yaw) during
  // the charging animation without disturbing the boom or feed horn.
  const dishMount = new THREE.Group();
  dishMount.position.y = TOWER_BASE_Y + LEG_HEIGHT + 0.4;
  g.add(dishMount);

  // Vertical boom holding the dish away from the tower top
  const boom = new THREE.Mesh(RT_DISH_BOOM_GEO, _getBodyMat());
  boom.position.y = 0;
  dishMount.add(boom);

  // Dish group — this is what we rotate during charging. Contains the
  // dish bowl + feed horn + tinted accent ring around the rim.
  const dishGroup = new THREE.Group();
  dishGroup.position.y = 0.25;
  dishMount.add(dishGroup);

  // Dish bowl — hemisphere section, rotated so its open face points
  // at +Z (forward). Three.js SphereGeometry with thetaLength < π gives
  // a partial sphere; we want a shallow bowl, hence thetaLength = π/2.4.
  // Default orientation is open-at-bottom; rotate -90° around X to
  // open toward +Z.
  const dish = new THREE.Mesh(RT_DISH_GEO, _getAccentDim(tint));
  dish.rotation.x = -Math.PI / 2;
  dishGroup.add(dish);

  // Feed horn — small stick poking out from the dish center toward
  // its open face. Real radio dishes have one of these.
  const feed = new THREE.Mesh(RT_DISH_FEED_GEO, _getBodyMat());
  feed.position.z = 0.45;
  feed.rotation.x = Math.PI / 2;
  dishGroup.add(feed);

  // Aircraft warning beacon at the very tip — bright bulb above the dish
  const beacon = new THREE.Mesh(RT_BEACON_GEO, _getRimMat(tint));
  beacon.position.y = TOWER_BASE_Y + LEG_HEIGHT + 1.4;
  g.add(beacon);

  // Walk-up control terminal at the base of the tower. Same design as
  // the powerplant terminal so they read as part of the same control
  // system.
  const terminalGroup = new THREE.Group();
  terminalGroup.position.set(0, TOWER_BASE_Y, 1.4);
  const tBase = new THREE.Mesh(TERMINAL_BASE_GEO, _getBodyMat());
  tBase.position.y = 0.35;
  terminalGroup.add(tBase);
  const tPanel = new THREE.Mesh(TERMINAL_PANEL_GEO, _getBodyMat());
  tPanel.position.set(0, 0.7, 0.06);
  tPanel.rotation.x = -0.4;
  terminalGroup.add(tPanel);
  const tScreen = new THREE.Mesh(TERMINAL_SCREEN_GEO, _getRimMat(tint));
  tScreen.position.set(0, 0.78, 0.20);
  tScreen.rotation.x = -0.4;
  terminalGroup.add(tScreen);
  g.add(terminalGroup);

  // ----- HIGH-TECH TRIM ACCENTS -----
  // Same trim palette as the powerplant for visual consistency.
  // Pad rim — gold band on the front edge of the pad.
  const padRim = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.08, 0.08),
    _getGoldMat(),
  );
  padRim.position.set(0, 0.32, 1.31);
  g.add(padRim);
  // Four silver corner caps at the base of the lattice tower legs —
  // sit underneath each leg's lowest point and read as "anchor bolts."
  for (const [cx, cz] of [[+0.45, +0.45], [-0.45, +0.45], [+0.45, -0.45], [-0.45, -0.45]]) {
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(0.20, 0.18, 0.20),
      _getSilverTrimMat(),
    );
    cap.position.set(cx, 0.40, cz);
    g.add(cap);
  }
  // Copper power conduit at the base — square ring around the four
  // legs at low height, simulating the "feed cable" connecting the
  // tower to the ground network. Built from 4 short copper segments.
  const cuLen = 0.9;       // segment length matches leg-to-leg dist (~0.9)
  const cuY = 0.65;
  const cuRadius = 0.04;
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(cuRadius, cuRadius, cuLen, 6),
      _getCopperMat(),
    );
    if (i === 0) {           // +X side
      seg.position.set(0.45, cuY, 0); seg.rotation.x = Math.PI / 2;
    } else if (i === 1) {    // -X side
      seg.position.set(-0.45, cuY, 0); seg.rotation.x = Math.PI / 2;
    } else if (i === 2) {    // +Z side
      seg.position.set(0, cuY, 0.45); seg.rotation.z = Math.PI / 2;
    } else {                 // -Z side
      seg.position.set(0, cuY, -0.45); seg.rotation.z = Math.PI / 2;
    }
    g.add(seg);
  }
  // Gold rim around the platform at the top — frames the dish base.
  const platformTrim = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.04, 1.1),
    _getGoldMat(),
  );
  platformTrim.position.y = TOWER_BASE_Y + LEG_HEIGHT + 0.07;
  g.add(platformTrim);

  scene.add(g);
  // Return the dishGroup as `bulb` for backward-compat with old code
  // that mutates `radioTower.bulb` for the lit state, plus expose
  // dishGroup explicitly for the rotation animation. The aircraft
  // beacon is exposed too in case future code wants to flash it.
  return {
    obj: g,
    bulb: beacon,           // back-compat: old code lit a "bulb"; map to beacon
    dish: dishGroup,        // for charging-state rotation in updateCompound
    beacon,
    terminal: terminalGroup,
    terminalScreen: tScreen,
  };
}

// ---------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------

let _current = null;

// Radio-charging state. Flipped true by powerupZones.js when the RADIO
// zone is the currently active charging step, false when it stops or
// completes. Drives the dish rotation + beep audio in updateCompound.
//
// Why a module-level setter instead of querying powerupZones directly:
// powerupZones imports LAYOUT from this module, so a reverse import
// would create a circular dep. The setter pattern keeps the data flow
// one-way (powerupZones tells waveProps about charging state).
let _radioCharging = false;

/** Called from powerupZones when the RADIO zone activates / deactivates. */
export function setRadioChargingState(active) {
  _radioCharging = !!active;
  // Reset the beep timer on state change so the dish doesn't fire a
  // beep half-stuck-on or skip the first one.
  _radioBeepTimer = 0;
}

// Beep timer — counts down each frame in updateCompound; when it hits
// zero we play a beep and reset to BEEP_INTERVAL.
let _radioBeepTimer = 0;
const RADIO_BEEP_INTERVAL = 0.6;       // seconds between beeps while charging
const RADIO_DISH_RPS = 0.3;             // dish rotation speed (radians/sec)

/**
 * Build the silo, powerplant, and radio tower for the given chapter.
 * Idempotent — a second call tears down the previous compound first.
 * Returns handles to every mesh so stage 3b/3c can animate them.
 */
export function buildCentralCompound(chapterIdx) {
  clearCentralCompound();
  // Recompute LAYOUT based on which triangle got assigned to wave 2
  // this chapter. Must happen BEFORE the builders run since they read
  // LAYOUT to place their props.
  _recomputeLayout();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  _current = {
    silo: _buildSilo(tint),
    powerplant: _buildPowerplant(tint),
    radioTower: _buildRadioTower(tint),
  };
  return _current;
}

export function clearCentralCompound() {
  if (!_current) return;
  // Dispose per-blinker cloned materials before removing the silo group.
  // Each blinker owns its own material clone (so the rolling-pattern
  // updater can tweak opacity individually); shared cached materials
  // stay warm for the next chapter.
  if (_current.silo && _current.silo.blinkerLights) {
    for (const light of _current.silo.blinkerLights) {
      if (light.material && light.material.dispose) light.material.dispose();
    }
  }
  for (const part of [_current.silo, _current.powerplant, _current.radioTower]) {
    if (part && part.obj && part.obj.parent) scene.remove(part.obj);
  }
  _current = null;
}

/** Handle lookup for future stages (3b will light up the powerplant, etc). */
export function getCompound() { return _current; }

// ---------------------------------------------------------------------------
// STAGE 3B ACTIVATION API
// ---------------------------------------------------------------------------
//
// These helpers are called from waves.js as power-up zones complete. They
// flip the compound's animation-target flags; the actual tweens run
// per-frame inside updateCompound().
//
// Each helper is idempotent + safe to call with no compound built (no-op).

/**
 * POWER completed. Powerplant windows go bright, reactor block emissive
 * jumps, chimney flames start burning. Visual only — no mechanical side
 * effects live here.
 */
export function setPowerplantLit(isLit) {
  if (!_current || !_current.powerplant) return;
  const pp = _current.powerplant;
  if (pp.lit === !!isLit) return;
  pp.lit = !!isLit;

  // Swap the window material for every window mesh in one go. Because we
  // share the material, this is a cheap reference swap — no per-mesh
  // material mutation, and we don't leak dormant materials.
  const nextMat = isLit ? _getWindowLit(pp.tint) : _getWindowDim(pp.tint);
  for (const w of pp.windows) w.material = nextMat;

  // Reactor block emissive: clone-and-swap the shared accent material so
  // we don't bump other dormant users' brightness.
  if (isLit) {
    const reactorMat = pp.reactor.material.clone();
    reactorMat.emissiveIntensity = 2.5;
    pp.reactor.material = reactorMat;
  } else {
    pp.reactor.material = _getAccentDim(pp.tint);
  }
  // Flames: updater ramps opacity toward target based on pp.lit.
}

/**
 * RADIO completed. Cap slides open (rotates about its Y axis + tilts up)
 * and the missile raises from inside the silo over ~1.5s.
 */
export function openSiloAndRaiseMissile() {
  if (!_current || !_current.silo) return;
  const silo = _current.silo;
  silo.capOpenTarget = 1;
  silo.missileRaiseTarget = 1;
  if (silo.missile) silo.missile.visible = true;
}

/**
 * Wave-2 ended (EMP fired). Reset every animation target so the next
 * wave 2 in a new chapter starts from a clean dormant state. The
 * compound itself is torn down by clearCentralCompound on chapter end,
 * but this call is what flips the visuals back mid-chapter if the EMP
 * has already detonated.
 */
export function resetCompoundAnimations() {
  if (!_current) return;
  if (_current.silo) {
    _current.silo.capOpenTarget = 0;
    _current.silo.missileRaiseTarget = 0;
  }
  if (_current.powerplant) {
    setPowerplantLit(false);
  }
}

// ---------------------------------------------------------------------------
// PER-FRAME TICK
// ---------------------------------------------------------------------------
/**
 * Advance compound animations by dt.  Called unconditionally from the
 * main render loop; no-ops when no compound is built.
 *
 * Covers:
 *   - Silo cap sliding open/closed (rotation + Y offset)
 *   - Missile raising out of silo (Y position lerp)
 *   - Missile blinker lights pulsing once raised
 *   - Powerplant chimney flames ramping on/off + flicker
 */
export function updateCompound(dt, time) {
  if (!_current) return;

  // --- Radio dish: rotate while charging, beep periodically ---
  // Dish rotates around its mount Y axis at ~17°/sec — slow, deliberate,
  // looks like a real microwave dish scanning. Beep every 0.6 seconds.
  // Both effects are gated by _radioCharging which powerupZones flips
  // when the player enters/leaves the active RADIO zone.
  if (_current.radioTower && _current.radioTower.dish) {
    if (_radioCharging) {
      _current.radioTower.dish.rotation.y += dt * RADIO_DISH_RPS;
      _radioBeepTimer -= dt;
      if (_radioBeepTimer <= 0) {
        _radioBeepTimer = RADIO_BEEP_INTERVAL;
        try { Audio.radioBeep && Audio.radioBeep(); } catch (e) {}
      }
    }
    // When NOT charging, leave whatever rotation the dish has — don't
    // snap back to 0 (would look like a bug). It just stops where the
    // charge ended.
  }

  // --- Silo cap + missile raise ---
  if (_current.silo) {
    const silo = _current.silo;

    // Cap: animate capOpenT toward capOpenTarget at ~1/s.
    {
      const target = silo.capOpenTarget;
      const cur = silo.capOpenT;
      const next = cur + (target - cur) * Math.min(1, dt * 2.5);
      silo.capOpenT = next;
      // Hinged-hatch transform: rotation.x rotates the whole cap group
      // around the hinge edge (silo's -Z rim). At capOpenT=0 the hatch
      // sits flat over the silo. At capOpenT=1 it has rotated -110°
      // (top tilts up and slightly past vertical, falling open
      // backward). Negative angle because the hinge is on -Z and the
      // hatch needs to rotate "up and over" toward +Z (math: positive
      // X-rotation tilts +Y → +Z, but we want top → -Z. With the hinge
      // BEHIND center, negative X-rotation gives the visually correct
      // backward fall.)
      if (silo.cap) {
        silo.cap.rotation.x = -next * (110 * Math.PI / 180);
        // Position stays pinned to the hinge — no horizontal slide,
        // no vertical lift. Set explicitly each frame so any old
        // animation residue can't bleed through.
        silo.cap.position.set(0, 5.1, -1.55);
        silo.cap.rotation.z = 0;
      }
    }

    // Missile raise: 0 → 1 over ~1.5s.
    if (silo.missile && silo.missile.visible) {
      const target = silo.missileRaiseTarget;
      const cur = silo.missileRaiseT;
      const next = cur + (target - cur) * Math.min(1, dt * 1.2);
      silo.missileRaiseT = next;
      // Y lerp from 1.8 (inside tube) to 6.5 (fully above silo top).
      silo.missile.position.y = 1.8 + next * 4.7;

      // Blink the lights once the missile is mostly up. Each light's
      // opacity is driven by its side/ring so the pattern reads as a
      // rolling beacon spiraling up the missile — much cooler than all
      // 12 pulsing in unison.
      if (next > 0.6 && silo.blinkerLights && silo.blinkerLights.length) {
        const phase = time * 4.5;
        for (let i = 0; i < silo.blinkerLights.length; i++) {
          const light = silo.blinkerLights[i];
          const side = light.userData.side || 0;   // 0..3
          const ring = light.userData.ring || 0;   // 0..2
          // Rolling: each side is offset in phase, and higher rings lag
          // behind lower ones so the pattern climbs.
          const local = Math.sin(phase - side * (Math.PI / 2) - ring * 0.6);
          light.material.opacity = local > 0.2 ? 1.0 : 0.12;
        }
      }

      // When fully raised + past target, hold (target stays at 1).
      // Stage 3c will flip missileRaiseTarget to fire the launch.
    }
  }

  // --- Powerplant flames ---
  if (_current.powerplant) {
    const pp = _current.powerplant;
    // Flame opacity ramps to 0.85 when lit, flickers with a small sin.
    if (pp.flames && pp.flames.length) {
      const baseMat = pp.flames[0].material;
      const targetOpacity = pp.lit ? 0.85 : 0.0;
      const cur = baseMat.opacity;
      const eased = cur + (targetOpacity - cur) * Math.min(1, dt * 3);
      // Flicker — keep same shared material so all flames share it.
      baseMat.opacity = eased * (0.85 + 0.15 * Math.sin(time * 14));
      // Scale Y slightly to simulate flicker height.
      if (pp.lit) {
        for (const f of pp.flames) {
          const s = 0.9 + 0.15 * Math.sin(time * 11 + f.position.x * 2);
          f.scale.set(1, s, 1);
        }
      }
    }
  }

  // --- Retraction ---
  if (_retractActive) {
    _retractT = Math.min(RETRACT_DURATION, _retractT + dt);
    const f = _retractT / RETRACT_DURATION;
    const eased = f * f;  // ease-in — starts slow, speeds up as it descends
    const sinkY = -eased * 6;  // 0 → -6
    if (_current.silo && _current.silo.obj) _current.silo.obj.position.y = sinkY;
    if (_current.powerplant && _current.powerplant.obj) _current.powerplant.obj.position.y = sinkY;
    if (_current.radioTower && _current.radioTower.obj) _current.radioTower.obj.position.y = sinkY;
    // Turrets too — read their group objs through the getter.
    if (_turretsGetter) {
      const turrets = _turretsGetter();
      if (turrets) {
        for (const t of turrets) {
          if (t && t.obj) t.obj.position.y = sinkY;
        }
      }
    }
    if (f >= 1) {
      _retractActive = false;
      // Force-snap the silo cap and missile to fully closed rest positions.
      // resetCompoundAnimations() flipped the targets to 0 but the per-frame
      // lerp may not have fully converged by retraction end — meaning the
      // cap could be parked slightly off-center / tilted, with its open
      // x-offset (+2.4u) carrying into wave 3. At y=-6 that x-offset would
      // leave the cap peeking up out of the ground to the side of the buried
      // silo. Snap it so no matter what state the lerp was in, the cap is
      // exactly where a closed silo would want it.
      if (_current.silo) {
        const silo = _current.silo;
        silo.capOpenT = 0;
        silo.capOpenTarget = 0;
        if (silo.cap) {
          // Snap to hinged-closed position: pinned at the hinge edge
          // (-Z rim) with zero rotation. With the new hatch design,
          // these are the values that make the cap sit flat over the
          // silo. The old position.set(0, 5.1, 0) + rotation.z = 0
          // would have left the cap floating slightly forward and
          // tilted because the cap's pivot is no longer at its center.
          silo.cap.position.set(0, 5.1, -1.55);
          silo.cap.rotation.set(0, 0, 0);
        }
        silo.missileRaiseT = 0;
        silo.missileRaiseTarget = 0;
        if (silo.missile) {
          silo.missile.position.y = 1.8;
          silo.missile.visible = false;
        }
      }

      // BULLETPROOF CLEANUP — once the sink animation is done, toggle every
      // retracted group invisible. Sinking to y=-6 only buries them ~0.9m
      // below ground (silo is 4.5m tall, cap sits 5.1m up in local space),
      // which can leave the very top peeking through if the camera angle
      // is shallow. Flipping `.visible = false` guarantees nothing from
      // the wave-2 compound can bleed into wave 3.
      if (_current.silo && _current.silo.obj) _current.silo.obj.visible = false;
      if (_current.powerplant && _current.powerplant.obj) _current.powerplant.obj.visible = false;
      if (_current.radioTower && _current.radioTower.obj) _current.radioTower.obj.visible = false;
      if (_turretsGetter) {
        const turrets = _turretsGetter();
        if (turrets) {
          for (const t of turrets) {
            if (t && t.obj) t.obj.visible = false;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LAUNCH TRIGGER + CINEMATIC HANDLES
// ---------------------------------------------------------------------------
//
// The launch trigger is now driven by the LAUNCH power-up zone (see
// powerupZones.js stage 3) — the player stands at the base of the raised
// missile and holds the zone for a few seconds, which calls the
// registered launch handler. waves.js registers startLaunch() here at
// module load.
//
// hideSiloMissile + getSiloLaunchOrigin are called by empLaunch.js when
// the cinematic takes over.

let _launchHandler = null;

/** Register the callback fired when the LAUNCH zone completes. */
export function registerLaunchHandler(fn) {
  _launchHandler = fn;
}

/** Fire the registered launch handler, if any. Called from waves.js on
 *  the LAUNCH zone completion event. Idempotent — callers protect
 *  against re-entry via S.powerupEmpFired. */
export function triggerLaunch() {
  if (_launchHandler) {
    try { _launchHandler(); }
    catch (err) { console.warn('[waveProps] launch handler threw:', err); }
  }
}

/** Hide the missile's in-silo copy once the launch cinematic has taken
 *  over. empLaunch.js swaps in its own moving missile mesh so the
 *  static one can go away. */
export function hideSiloMissile() {
  if (!_current || !_current.silo) return;
  const silo = _current.silo;
  if (silo.missile) silo.missile.visible = false;
}

/** World position of the silo top — used by empLaunch to spawn the
 *  flight-missile copy at the right place. */
export function getSiloLaunchOrigin() {
  if (!_current || !_current.silo) return null;
  const base = _current.silo.obj.position;
  // Silo cap y was 5.1; missile peak sits around 6.5 when raised.
  return new THREE.Vector3(base.x, 6.5, base.z);
}

// ---------------------------------------------------------------------------
// COMPOUND RETRACTION (Stage 3+ polish)
// ---------------------------------------------------------------------------
//
// After the EMP detonation, the whole compound (silo, powerplant, radio
// tower, turrets — the turrets live in turrets.js but we animate them
// via the same timer here) retracts into the ground over ~2s. Lore:
// "safety mechanisms retract when systems fail." Visually: every group's
// Y position lerps from 0 → -6 and then everything clears.
//
// Usage:
//   startCompoundRetraction()  — called from waves.js _fireEmp epilogue
//                                 after resetCompoundAnimations/wire reset
//   Per-frame tick happens inside updateCompound() which is already
//   called every frame from main.js.
//
// When retraction completes, the meshes remain at y=-6 (invisible under
// the floor). The next chapter's prepareChapter() tears everything down
// and rebuilds at y=0, so there's no leaked state between chapters.

let _retractT = 0;
let _retractActive = false;
const RETRACT_DURATION = 2.0;

/** Begin retracting the whole compound into the ground. Idempotent. */
export function startCompoundRetraction() {
  if (_retractActive) return;
  if (!_current) return;
  _retractActive = true;
  _retractT = 0;
}

/** Is a retraction currently in progress? (waves.js polls this to know
 *  when it can trigger chapter-end cleanup.) */
export function isRetracting() {
  return _retractActive;
}

/** Cached import — we need the turret array from turrets.js to animate
 *  them alongside the silo/powerplant/radio. We can't import at the top
 *  of this file without risking a circular import (turrets.js imports
 *  LAYOUT from us), so we read the group positions lazily from the
 *  object returned by getTurrets(). */
let _turretsGetter = null;
export function _setTurretsGetter(fn) { _turretsGetter = fn; }

// ---------------------------------------------------------------------------
// COLLISION — silo + turrets as solid obstacles.
//
// The silo is a cylinder ~2.4u radius at its base. Each turret is a cylinder
// of ~1.0u radius at its base. Neither should be walkable through by the
// player or enemies once they're standing in the arena. We expose a single
// push-out helper that resolves both in one pass so callers don't have to
// duplicate loops.
//
// NOTE: we only collide during waves where these props are present. The
// compound is built by prepareChapter (via buildCentralCompound) at chapter
// start and cleared by teardownChapter at chapter end — but until retraction
// finishes the meshes remain visible and must remain solid. A caller can
// always safely call this every frame; if the compound isn't present we
// early-out.
// ---------------------------------------------------------------------------
const _SILO_COLLIDE_R = 2.6;    // slightly > the SILO_BASE_GEO radius
const _TURRET_COLLIDE_R = 1.2;  // slightly > the TURRET base disk
const _DEPOT_COLLIDE_R = 2.2;   // depot ORBIT_RADIUS (2.4) - small inner allowance
const _POWERPLANT_COLLIDE_R = 4.0;  // pad is 7u wide → half 3.5 + 0.5 buffer
const _RADIO_COLLIDE_R = 1.8;   // radio tower base footprint

// Live binding for the depot — imported lazily so we don't create a
// circular import (ores.js imports from waveProps.js too in some
// chains). Filled in via an explicit setter from main.js at startup,
// or by a direct import if we can be sure it's safe.
let _depotGetter = null;
export function registerDepotGetter(fn) { _depotGetter = fn; }

/**
 * Push `pos` out of the silo + turret + depot + powerplant + radio
 * obstacles. `entityRadius` is the caller's own radius (player ~0.8u,
 * enemy ~0.5u). Mutates `pos` in place. Safe to call unconditionally —
 * no-ops when the compound isn't built or when props have retracted.
 */
export function resolveCompoundCollision(pos, entityRadius) {
  if (!_current) return;

  // Silo — only solid while its group is at normal y (retraction sinks it).
  if (_current.silo && _current.silo.obj && _current.silo.obj.parent) {
    if (_current.silo.obj.position.y > -0.5) {
      _pushOutCircle(pos, entityRadius, LAYOUT.silo.x, LAYOUT.silo.z, _SILO_COLLIDE_R);
    }
  }

  // Turrets. Use live turret objects (from turrets.js) so we respect any
  // retraction their groups perform — but fall back to LAYOUT positions
  // when the getter isn't wired yet (init race).
  const liveTurrets = _turretsGetter ? _turretsGetter() : null;
  if (liveTurrets && liveTurrets.length) {
    for (const t of liveTurrets) {
      if (!t || !t.obj || !t.obj.parent) continue;
      if (t.obj.position.y < -0.5) continue;   // already sunk
      _pushOutCircle(pos, entityRadius, t.pos.x, t.pos.z, _TURRET_COLLIDE_R);
    }
  } else {
    for (const tp of LAYOUT.turrets) {
      _pushOutCircle(pos, entityRadius, tp.x, tp.z, _TURRET_COLLIDE_R);
    }
  }

  // Power plant — large pad in front of the silo. Always solid as long
  // as the compound exists; uses LAYOUT position rather than tracking
  // a live mesh because the powerplant doesn't retract.
  if (_current.powerplant && _current.powerplant.obj && _current.powerplant.obj.parent) {
    if (_current.powerplant.obj.position.y > -0.5) {
      _pushOutCircle(pos, entityRadius, LAYOUT.powerplant.x, LAYOUT.powerplant.z, _POWERPLANT_COLLIDE_R);
    }
  }

  // Radio tower — narrower footprint, lattice base.
  if (_current.radioTower && _current.radioTower.obj && _current.radioTower.obj.parent) {
    if (_current.radioTower.obj.position.y > -0.5) {
      _pushOutCircle(pos, entityRadius, LAYOUT.radioTower.x, LAYOUT.radioTower.z, _RADIO_COLLIDE_R);
    }
  }

  // Depot — central drop-off where ores converge. Lazy-resolved via
  // getter so this module doesn't have to import ores.js (avoiding any
  // circular-import risk). Skip if no getter wired or depot null.
  if (_depotGetter) {
    const d = _depotGetter();
    if (d && d.pos) {
      _pushOutCircle(pos, entityRadius, d.pos.x, d.pos.z, _DEPOT_COLLIDE_R);
    }
  }
}

/**
 * Returns true if a segment from (ax,az) to (bx,bz) intersects ANY
 * blocking prop (silo, turrets, powerplant, radio tower, depot).
 * Used by projectile movement to despawn bullets/rockets when they
 * hit a prop. Cheap segment-circle intersection: project the prop
 * center onto the segment, find perpendicular distance, compare to
 * the prop's collide radius. If the closest point on the segment is
 * within radius, the segment intersects the circle.
 */
export function segmentBlockedByProp(ax, az, bx, bz) {
  if (!_current) return false;
  // Build a small per-call list of (cx, cz, r) circles to check. Cheap
  // because the count is small (≤ 1 silo + ≤3 turrets + 1 powerplant +
  // 1 radio + 1 depot = 7 max circles).
  const dx = bx - ax;
  const dz = bz - az;
  const segLen2 = dx * dx + dz * dz;
  if (segLen2 < 0.0001) return false;     // degenerate segment

  function _segCircleHit(cx, cz, r) {
    // Project (cx-ax, cz-az) onto the segment direction; clamp to [0,1].
    const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / segLen2));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const ddx = cx - px;
    const ddz = cz - pz;
    return (ddx * ddx + ddz * ddz) < r * r;
  }

  if (_current.silo && _current.silo.obj && _current.silo.obj.parent
      && _current.silo.obj.position.y > -0.5) {
    if (_segCircleHit(LAYOUT.silo.x, LAYOUT.silo.z, _SILO_COLLIDE_R)) return true;
  }
  const liveTurrets = _turretsGetter ? _turretsGetter() : null;
  if (liveTurrets && liveTurrets.length) {
    for (const t of liveTurrets) {
      if (!t || !t.obj || !t.obj.parent) continue;
      if (t.obj.position.y < -0.5) continue;
      if (_segCircleHit(t.pos.x, t.pos.z, _TURRET_COLLIDE_R)) return true;
    }
  } else {
    for (const tp of LAYOUT.turrets) {
      if (_segCircleHit(tp.x, tp.z, _TURRET_COLLIDE_R)) return true;
    }
  }
  if (_current.powerplant && _current.powerplant.obj && _current.powerplant.obj.parent
      && _current.powerplant.obj.position.y > -0.5) {
    if (_segCircleHit(LAYOUT.powerplant.x, LAYOUT.powerplant.z, _POWERPLANT_COLLIDE_R)) return true;
  }
  if (_current.radioTower && _current.radioTower.obj && _current.radioTower.obj.parent
      && _current.radioTower.obj.position.y > -0.5) {
    if (_segCircleHit(LAYOUT.radioTower.x, LAYOUT.radioTower.z, _RADIO_COLLIDE_R)) return true;
  }
  if (_depotGetter) {
    const d = _depotGetter();
    if (d && d.pos) {
      if (_segCircleHit(d.pos.x, d.pos.z, _DEPOT_COLLIDE_R)) return true;
    }
  }
  return false;
}

function _pushOutCircle(pos, entityR, cx, cz, obstacleR) {
  const dx = pos.x - cx;
  const dz = pos.z - cz;
  const minD = entityR + obstacleR;
  const d2 = dx * dx + dz * dz;
  if (d2 >= minD * minD) return;
  const d = Math.sqrt(d2) || 0.0001;
  const overlap = minD - d;
  pos.x += (dx / d) * overlap;
  pos.z += (dz / d) * overlap;
}
