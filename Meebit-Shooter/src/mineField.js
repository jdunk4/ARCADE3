// mineField.js — Anti-personnel mines deployed by the MINE FIELD
// stratagem. Three damage kinds, selectable per stratagem code:
//
//   'explosion' — high-burst AoE damage on detonation. Standard
//                 frag mine; reads as the chapter-tinted classic.
//   'fire'      — smaller burst + leaves a fire patch that ticks
//                 DPS for ~3.5s. Color-shifted toward warm orange.
//   'poison'    — green-tinted mine that puffs a toxic cloud on
//                 trigger. Lower burst damage but applies a 4-second
//                 poison DoT to any enemy in cloud radius.
//
// Mines lay flat on the floor, sit dormant until an enemy steps
// within trigger radius, then beep for ~0.45s before firing.
//
// Public API:
//   deployMineField(centerPos, tint, kind)  — scatter mines around
//                                             centerPos. kind defaults
//                                             to 'explosion'.
//   updateMines(dt)                         — per-frame tick (proximity,
//                                             arming, detonation, fire-patch
//                                             ticking, poison-cloud DPS).
//   clearAllMines()                         — wipe all (game reset).

import * as THREE from 'three';
import { scene } from './scene.js';
import { hitBurst } from './effects.js';
import { enemies } from './enemies.js';
import { Audio } from './audio.js';
import { S } from './state.js';
import { player } from './player.js';
import { isPiloting } from './mech.js';

const MINE_COUNT          = 12;
const MINE_SPREAD_RADIUS  = 5.5;
const MINE_TRIGGER_RADIUS = 1.6;
const MINE_BEEP_DUR       = 0.45;          // arming/warning before detonation

// =====================================================================
// PER-KIND TUNING
// =====================================================================
// Each kind is a knob set tuned for a distinct combat role.
const _KIND_CONFIG = {
  explosion: {
    aoeRadius: 3.4,
    aoeDamage: 200,
    bodyColor: 0x2a2c34,                      // dark gunmetal
    lightHex:  null,                          // null = use chapter tint
    burstColor: 0xffaa00,
    secondaryBurstColor: 0xff5520,
    spawnPatch: false,
    spawnPoisonCloud: false,
  },
  fire: {
    aoeRadius: 2.6,
    aoeDamage: 130,
    bodyColor: 0x3a1f12,                      // scorched brown
    lightHex:  0xff7a30,                      // orange override
    burstColor: 0xff5520,
    secondaryBurstColor: 0xffaa00,
    spawnPatch: true,
    patchRadius: 2.6,
    patchDur: 3.5,
    patchDps: 70,
    patchColor: 0xff5520,
    spawnPoisonCloud: false,
  },
  poison: {
    aoeRadius: 3.0,
    aoeDamage: 80,                            // smaller burst
    bodyColor: 0x1f2a14,                      // dark moss
    lightHex:  0x7af797,                      // bright green override
    burstColor: 0x7af797,
    secondaryBurstColor: 0xb3ffd0,
    spawnPatch: false,
    spawnPoisonCloud: true,
    cloudRadius: 3.4,
    cloudDur: 4.0,
    cloudDps: 55,
    cloudColor: 0x7af797,
  },
};

// =====================================================================
// SHARED GEOMETRY
// =====================================================================
const _MINE_BASE_GEO   = new THREE.CylinderGeometry(0.32, 0.36, 0.18, 14);
const _MINE_LIGHT_GEO  = new THREE.SphereGeometry(0.10, 10, 8);
const _PATCH_GEO       = new THREE.CircleGeometry(1.0, 28);
const _CLOUD_PUFF_GEO  = new THREE.SphereGeometry(0.55, 10, 8);

const _activeMines = [];
const _activePatches = [];      // fire patches from 'fire' mines
const _activeClouds = [];       // poison clouds from 'poison' mines

// Active dispenser drones (one per active deployment, despawns once
// it has ejected all its mines and faded out).
const _activeDispensers = [];

// Mines in flight from the dispenser to the ground. These are
// pre-armed (visible mine body) but lack proximity logic until they
// land — at which point they're promoted into _activeMines.
const _airborneMines = [];

// Dispenser drone geometry. Built once.
const _DISP_BODY_GEO   = new THREE.SphereGeometry(0.85, 16, 12);
const _DISP_DISC_GEO   = new THREE.CylinderGeometry(1.20, 1.20, 0.12, 24);
const _DISP_BLADE_GEO  = new THREE.BoxGeometry(0.10, 0.04, 1.00);
const _DISP_ANT_GEO    = new THREE.CylinderGeometry(0.04, 0.04, 0.85, 6);

const DISPENSER_HOVER_HEIGHT = 7.0;
const DISPENSER_ARRIVAL_DUR  = 0.55;       // seconds to fly in
const DISPENSER_EJECT_DELAY  = 0.18;       // seconds between mine ejects
const DISPENSER_DEPART_DUR   = 0.85;       // seconds to fly out

// =====================================================================
// DEPLOY
// =====================================================================
// Spawns a hovering dispenser drone above centerPos. The drone
// rotates a bladed disc and flings one mine per DISPENSER_EJECT_DELAY
// in a wide spread. Each mine is a small airborne body that arcs
// outward and downward, lands, plays an arming click, and joins the
// proximity-armed pool.
export function deployMineField(centerPos, tint, kind) {
  const k = (kind && _KIND_CONFIG[kind]) ? kind : 'explosion';
  const cfg = _KIND_CONFIG[k];
  const lightHex = cfg.lightHex != null ? cfg.lightHex : tint;
  const lightColor = new THREE.Color(lightHex);

  // ---- BUILD DRONE BODY ----
  const root = new THREE.Group();
  // Drones arrive from off-screen high; they fly in over
  // DISPENSER_ARRIVAL_DUR to a position right above the beacon.
  // Pick an entry point biased to the perimeter so they read as
  // "called in from outside the arena".
  const entryAngle = Math.random() * Math.PI * 2;
  const entryDist = 18.0;
  root.position.set(
    centerPos.x + Math.cos(entryAngle) * entryDist,
    DISPENSER_HOVER_HEIGHT + 5,
    centerPos.z + Math.sin(entryAngle) * entryDist,
  );

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2a2c34,
    emissive: lightColor,
    emissiveIntensity: 0.45,
    roughness: 0.45,
    metalness: 0.85,
  });
  const discMat = new THREE.MeshStandardMaterial({
    color: 0x1f2128,
    emissive: lightColor,
    emissiveIntensity: 0.30,
    roughness: 0.55,
    metalness: 0.85,
  });
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0x4a4d54,
    roughness: 0.40,
    metalness: 0.90,
  });
  const lensMat = new THREE.MeshBasicMaterial({
    color: lightColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  // Orb body — central capsule.
  const body = new THREE.Mesh(_DISP_BODY_GEO, bodyMat);
  root.add(body);
  // Underside lens — visible chapter-tinted aperture.
  const lens = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), lensMat);
  lens.position.y = -0.55;
  root.add(lens);
  // Top antenna with blinking emitter.
  const ant = new THREE.Mesh(_DISP_ANT_GEO, bodyMat);
  ant.position.y = 0.95;
  root.add(ant);
  const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6), lensMat);
  antTip.position.y = 1.40;
  root.add(antTip);

  // Spinning disc (under the orb) — this is what flings the mines.
  // Group rotates as a unit; blades sit on its surface.
  const spinner = new THREE.Group();
  spinner.position.y = -0.30;
  root.add(spinner);
  const disc = new THREE.Mesh(_DISP_DISC_GEO, discMat);
  spinner.add(disc);
  // 4 blades pointing radially outward.
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(_DISP_BLADE_GEO, bladeMat);
    const a = (i / 4) * Math.PI * 2;
    blade.position.set(Math.cos(a) * 0.55, 0.10, Math.sin(a) * 0.55);
    blade.rotation.y = a;
    spinner.add(blade);
  }

  scene.add(root);

  const dispenser = {
    root, bodyMat, discMat, bladeMat, lensMat,
    spinner,
    centerPos: new THREE.Vector3(centerPos.x, 0, centerPos.z),
    entryAngle,
    entryDist,
    tint,
    lightColor,
    cfg,
    kind: k,
    phase: 'arriving',     // arriving → ejecting → departing → done
    phaseT: 0,
    ejectIdx: 0,
    ejectTimer: 0,
    spinAngle: 0,
    minesToEject: MINE_COUNT,
    departStart: null,     // captured at start of departing
  };
  _activeDispensers.push(dispenser);
}

// =====================================================================
// DISPENSER TICK
// =====================================================================
function _tickDispensers(dt) {
  for (let i = _activeDispensers.length - 1; i >= 0; i--) {
    const d = _activeDispensers[i];
    d.phaseT += dt;
    // Continuous spin — speeds up while ejecting.
    const spinRate = d.phase === 'ejecting' ? 24.0 : 9.0;
    d.spinAngle += dt * spinRate;
    d.spinner.rotation.y = d.spinAngle;
    // Antenna lens blinks at ~3Hz.
    d.lensMat.opacity = 0.65 + 0.30 * Math.sin(d.phaseT * 18);

    if (d.phase === 'arriving') {
      // Lerp from entry point to hover spot above centerPos.
      const f = Math.min(1, d.phaseT / DISPENSER_ARRIVAL_DUR);
      // Ease-out for a "swooping in and braking" feel.
      const eased = 1 - Math.pow(1 - f, 2);
      const startX = d.centerPos.x + Math.cos(d.entryAngle) * d.entryDist;
      const startZ = d.centerPos.z + Math.sin(d.entryAngle) * d.entryDist;
      const startY = DISPENSER_HOVER_HEIGHT + 5;
      d.root.position.x = startX + (d.centerPos.x - startX) * eased;
      d.root.position.z = startZ + (d.centerPos.z - startZ) * eased;
      d.root.position.y = startY + (DISPENSER_HOVER_HEIGHT - startY) * eased;
      // Tilt slightly toward direction of travel.
      const dx = d.centerPos.x - startX;
      const dz = d.centerPos.z - startZ;
      const tilt = (1 - eased) * 0.35;
      d.root.rotation.x = -dz * 0 + tilt * Math.sin(d.entryAngle + Math.PI / 2) * 0.5;
      d.root.rotation.z = tilt * Math.cos(d.entryAngle + Math.PI / 2) * 0.5;
      if (f >= 1) {
        d.phase = 'ejecting';
        d.phaseT = 0;
        d.root.rotation.x = 0;
        d.root.rotation.z = 0;
      }
    } else if (d.phase === 'ejecting') {
      // Light hover bobble.
      const bob = Math.sin(d.phaseT * 6) * 0.12;
      d.root.position.y = DISPENSER_HOVER_HEIGHT + bob;
      // Fling mines on interval.
      d.ejectTimer -= dt;
      if (d.ejectTimer <= 0 && d.ejectIdx < d.minesToEject) {
        d.ejectTimer = DISPENSER_EJECT_DELAY;
        _ejectMineFromDispenser(d);
        d.ejectIdx++;
        try { Audio.mineDispenserWhir(); } catch (_) {}
      }
      if (d.ejectIdx >= d.minesToEject) {
        d.phase = 'departing';
        d.phaseT = 0;
        d.departStart = d.root.position.clone();
      }
    } else if (d.phase === 'departing') {
      // Climb + fade away. Material opacity ramps down.
      const f = Math.min(1, d.phaseT / DISPENSER_DEPART_DUR);
      d.root.position.y = d.departStart.y + f * 12;
      // Slight forward drift away from the eject area.
      d.root.position.x = d.departStart.x + Math.cos(d.entryAngle) * f * 4;
      d.root.position.z = d.departStart.z + Math.sin(d.entryAngle) * f * 4;
      // Fade.
      const op = 1 - f;
      d.bodyMat.opacity = op; d.bodyMat.transparent = true;
      d.discMat.opacity = op; d.discMat.transparent = true;
      d.bladeMat.opacity = op; d.bladeMat.transparent = true;
      d.lensMat.opacity = 0.95 * op;
      if (f >= 1) {
        d.phase = 'done';
      }
    } else if (d.phase === 'done') {
      _disposeDispenser(d);
      _activeDispensers.splice(i, 1);
    }
  }
}

function _disposeDispenser(d) {
  if (d.root.parent) scene.remove(d.root);
  if (d.bodyMat) d.bodyMat.dispose();
  if (d.discMat) d.discMat.dispose();
  if (d.bladeMat) d.bladeMat.dispose();
  if (d.lensMat) d.lensMat.dispose();
}

// =====================================================================
// MINE EJECT (from dispenser)
// =====================================================================
// Build the mine body, attach it as an airborne projectile that arcs
// outward + down with gravity. On ground impact it converts into a
// proper proximity-armed mine.
function _ejectMineFromDispenser(d) {
  const cfg = d.cfg;
  const lightHex = cfg.lightHex != null ? cfg.lightHex : d.tint;
  const lightColor = new THREE.Color(lightHex);

  const baseMat = new THREE.MeshStandardMaterial({
    color: cfg.bodyColor,
    emissive: lightColor,
    emissiveIntensity: 0.4,
    roughness: 0.55,
    metalness: 0.70,
  });
  const lightMat = new THREE.MeshBasicMaterial({
    color: lightColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  const root = new THREE.Group();
  root.position.copy(d.root.position);
  // Spawn slightly below the disc so the mine appears to fly off the
  // bladed underside, not out of the orb.
  root.position.y -= 0.40;
  const base = new THREE.Mesh(_MINE_BASE_GEO, baseMat);
  root.add(base);
  const light = new THREE.Mesh(_MINE_LIGHT_GEO, lightMat);
  light.position.y = 0.12;
  root.add(light);
  scene.add(root);

  // Eject vector — outward angle that walks around the dispenser as
  // the disc spins. We use d.spinAngle + indexed offset so the spread
  // is even and visually tied to the spinner.
  const a = d.spinAngle + (d.ejectIdx * 0.41);   // golden-ratio-ish offset
  const r = MINE_SPREAD_RADIUS * (0.55 + Math.random() * 0.55);
  const targetX = d.centerPos.x + Math.cos(a) * r;
  const targetZ = d.centerPos.z + Math.sin(a) * r;

  // Outbound velocity. Horizontal component = (target - dispenser);
  // vertical component is a small upward kick so the mines arc
  // visibly before falling.
  const dx = targetX - d.root.position.x;
  const dz = targetZ - d.root.position.z;
  // Time-of-flight ~0.55s — choose vy so the parabola lands at y=0.
  const T = 0.55;
  const G = 18;
  const vx = dx / T;
  const vz = dz / T;
  // Solve from y0 = (DISPENSER_HOVER_HEIGHT - 0.4) for vy:
  //   0 = y0 + vy * T - 0.5 * G * T^2
  //   vy = (0.5 * G * T^2 - y0) / T
  const y0 = root.position.y;
  const vy = (0.5 * G * T * T - y0) / T;

  _airborneMines.push({
    root, base, baseMat,
    light, lightMat,
    pos: new THREE.Vector3(root.position.x, root.position.y, root.position.z),
    vel: new THREE.Vector3(vx, vy, vz),
    spin: new THREE.Vector3(
      (Math.random() - 0.5) * 12,
      Math.random() * 8,
      (Math.random() - 0.5) * 12,
    ),
    tint: d.tint,
    cfg, kind: d.kind,
  });
}

function _tickAirborneMines(dt) {
  const G = 18;
  for (let i = _airborneMines.length - 1; i >= 0; i--) {
    const a = _airborneMines[i];
    a.vel.y -= G * dt;
    a.pos.x += a.vel.x * dt;
    a.pos.y += a.vel.y * dt;
    a.pos.z += a.vel.z * dt;
    a.root.position.copy(a.pos);
    // Tumble.
    a.root.rotation.x += a.spin.x * dt;
    a.root.rotation.y += a.spin.y * dt;
    a.root.rotation.z += a.spin.z * dt;
    if (a.pos.y <= 0.09) {
      // Land — settle flat, promote to active mine.
      a.pos.y = 0.09;
      a.root.position.y = 0.09;
      a.root.rotation.set(0, 0, 0);
      try { Audio.mineArm(); } catch (_) {}
      // Tiny dirt puff.
      hitBurst(new THREE.Vector3(a.pos.x, 0.06, a.pos.z), 0x8a6a44, 4);
      _activeMines.push({
        root: a.root,
        base: a.base, baseMat: a.baseMat,
        light: a.light, lightMat: a.lightMat,
        kind: a.kind,
        cfg: a.cfg,
        tint: a.tint,
        pos: new THREE.Vector3(a.pos.x, 0, a.pos.z),
        armed: true,
        beeping: false,
        beepT: 0,
        detonated: false,
        detonateT: 0,
        pulsePhase: Math.random() * Math.PI * 2,
      });
      _airborneMines.splice(i, 1);
    }
  }
}

// =====================================================================
// PER-FRAME TICK
// =====================================================================
export function updateMines(dt) {
  // --- Dispenser drones (must tick FIRST since they spawn airborne
  // mines this frame which the airborne tick then advances). ---
  _tickDispensers(dt);
  _tickAirborneMines(dt);

  // --- Mines ---
  for (let i = _activeMines.length - 1; i >= 0; i--) {
    const m = _activeMines[i];
    if (!m.beeping && !m.detonated) {
      // Idle pulse on the light.
      m.pulsePhase += dt * 1.5;
      m.lightMat.opacity = 0.6 + 0.35 * Math.sin(m.pulsePhase);
      // Proximity check.
      const r2 = MINE_TRIGGER_RADIUS * MINE_TRIGGER_RADIUS;
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (!e || !e.pos || e.dying) continue;
        const dx = e.pos.x - m.pos.x;
        const dz = e.pos.z - m.pos.z;
        if (dx * dx + dz * dz < r2) {
          m.beeping = true;
          m.beepT = 0;
          try { Audio.mineBeep(); } catch (_) {}
          break;
        }
      }
    } else if (m.beeping && !m.detonated) {
      const wasT = m.beepT;
      m.beepT += dt;
      // Mid-beep secondary chirp at the halfway mark for an audible
      // "winding up" — adds urgency to the warning window.
      if (wasT < MINE_BEEP_DUR * 0.55 && m.beepT >= MINE_BEEP_DUR * 0.55) {
        try { Audio.mineBeep(); } catch (_) {}
      }
      // Fast pulse during the beep window.
      const pulse = 0.5 + 0.5 * Math.sin(m.beepT * 28);
      m.lightMat.opacity = 0.4 + pulse * 0.6;
      m.baseMat.emissiveIntensity = 0.4 + pulse * 1.0;
      if (m.beepT >= MINE_BEEP_DUR) {
        _detonateMine(m);
      }
    } else if (m.detonated) {
      // Brief lingering smoke — disposed at end.
      m.detonateT += dt;
      if (m.detonateT > 0.6) {
        _disposeMine(m);
        _activeMines.splice(i, 1);
      }
    }
  }

  // --- Fire patches (from 'fire' mines) ---
  for (let i = _activePatches.length - 1; i >= 0; i--) {
    const p = _activePatches[i];
    p.life += dt;
    const f = p.life / p.ttl;
    if (f >= 1) {
      if (p.disc.parent) p.disc.parent.remove(p.disc);
      if (p.mat) p.mat.dispose();
      _activePatches.splice(i, 1);
      continue;
    }
    // Pulse + fade.
    const pulse = 0.5 + 0.5 * Math.sin(p.life * 7);
    p.mat.opacity = (0.55 + pulse * 0.20) * (1 - f * 0.6);
    // Damage enemies inside the patch.
    const r2 = p.radius * p.radius;
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying) continue;
      const dx = e.pos.x - p.pos.x;
      const dz = e.pos.z - p.pos.z;
      if (dx * dx + dz * dz < r2) {
        e.hp -= p.dps * dt;
      }
    }
    // Damage player if they walk through it too. Lower DPS than the
    // enemy figure, no invuln blanket — the player's expected to step
    // out, not stand in it.
    if (player && player.pos && !isPiloting()) {
      const dx = player.pos.x - p.pos.x;
      const dz = player.pos.z - p.pos.z;
      if (dx * dx + dz * dz < r2) {
        const PLAYER_PATCH_DPS = p.dps * 0.40;
        S.hp = Math.max(0, S.hp - PLAYER_PATCH_DPS * dt);
      }
    }
  }

  // --- Poison clouds (from 'poison' mines) ---
  for (let i = _activeClouds.length - 1; i >= 0; i--) {
    const c = _activeClouds[i];
    c.life += dt;
    const f = c.life / c.ttl;
    if (f >= 1) {
      for (const puff of c.puffs) {
        if (puff.mesh.parent) puff.mesh.parent.remove(puff.mesh);
        if (puff.mat) puff.mat.dispose();
      }
      _activeClouds.splice(i, 1);
      continue;
    }
    // Drift + dissipate puffs.
    for (const puff of c.puffs) {
      puff.pos.x += puff.vel.x * dt;
      puff.pos.y += puff.vel.y * dt;
      puff.pos.z += puff.vel.z * dt;
      puff.mesh.position.copy(puff.pos);
      // Slow the drift over time so puffs settle.
      puff.vel.multiplyScalar(0.985);
      // Grow + fade.
      const localF = (c.life - puff.delay) / Math.max(0.001, puff.ttl);
      const lf = Math.max(0, Math.min(1, localF));
      const s = 1.0 + lf * 1.6;
      puff.mesh.scale.setScalar(s);
      puff.mat.opacity = (0.45 + 0.15 * Math.sin(c.life * 4 + puff.phase)) * (1 - f);
    }
    // Damage enemies inside the cloud.
    const r2 = c.radius * c.radius;
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying) continue;
      const dx = e.pos.x - c.pos.x;
      const dz = e.pos.z - c.pos.z;
      if (dx * dx + dz * dz < r2) {
        e.hp -= c.dps * dt;
      }
    }
    // Player DoT if standing in the cloud.
    if (player && player.pos && !isPiloting()) {
      const dx = player.pos.x - c.pos.x;
      const dz = player.pos.z - c.pos.z;
      if (dx * dx + dz * dz < r2) {
        S.hp = Math.max(0, S.hp - c.dps * 0.40 * dt);
      }
    }
  }
}

// =====================================================================
// DETONATION
// =====================================================================
function _detonateMine(m) {
  m.detonated = true;
  m.detonateT = 0;
  // Hide the mine body but leave the group for the linger window so
  // the FX has somewhere reasonable to anchor (though hitBurst is
  // pos-based and doesn't actually need it).
  if (m.base.parent) m.base.visible = false;
  if (m.light.parent) m.light.visible = false;

  const cfg = m.cfg;
  // Burst-style AoE damage in the configured radius.
  const r2 = cfg.aoeRadius * cfg.aoeRadius;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const dx = e.pos.x - m.pos.x;
    const dz = e.pos.z - m.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r2) {
      const falloff = 1 - Math.sqrt(d2) / cfg.aoeRadius;
      e.hp -= cfg.aoeDamage * falloff;
      e.hitFlash = 0.18;
    }
  }

  // FX — burst plume colored to the mine kind.
  const pos = m.pos.clone();
  pos.y = 0.5;
  hitBurst(pos, 0xffffff, 14);
  hitBurst(pos, cfg.burstColor, 18);
  setTimeout(() => hitBurst(pos, cfg.secondaryBurstColor, 12), 50);

  // Audio per-kind.
  try { Audio.mineDetonate(m.kind); } catch (_) {}

  // Splash damage to the player. Falloff with distance, smaller max
  // damage than the kind's anti-enemy figure (mines are tactical, not
  // a player nuke). Kept consistent across kinds; the per-kind patch
  // / cloud aftermath is what makes you regret standing on the field
  // afterward, and those are damage-tick based (handled in the patch
  // / cloud ticks below).
  _splashDamagePlayerLocal(m.pos, cfg.aoeRadius, 30);

  // Per-kind aftermath.
  if (cfg.spawnPatch) {
    _spawnFirePatch(m.pos, cfg);
  }
  if (cfg.spawnPoisonCloud) {
    _spawnPoisonCloud(m.pos, cfg);
  }

  // Notify any tutorial observer that a mine fired. We pass the kind
  // so the lesson can branch if it ever wants to (the current bonus
  // lesson watches for any detonation, kind-agnostic).
  if (typeof window !== 'undefined' && window.__bonusObserve && window.__bonusObserve.onMineDetonate) {
    try { window.__bonusObserve.onMineDetonate(m.kind); } catch (e) {}
  }
}

// Player-splash helper for mineField.js. Mirrors mech.js's
// _splashDamagePlayer but lives here too so we don't bridge through
// window. Bails when piloting (mech absorbs) or invuln.
function _splashDamagePlayerLocal(epicenter, radius, maxDmg) {
  if (!player || !player.pos) return;
  if (isPiloting()) return;           // mech absorbs the hit
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

// =====================================================================
// FIRE PATCH (fire mine aftermath)
// =====================================================================
function _spawnFirePatch(pos, cfg) {
  const mat = new THREE.MeshBasicMaterial({
    color: cfg.patchColor,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const disc = new THREE.Mesh(_PATCH_GEO, mat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(pos.x, 0.06, pos.z);
  disc.scale.set(cfg.patchRadius, cfg.patchRadius, 1);
  scene.add(disc);
  _activePatches.push({
    disc, mat,
    pos: pos.clone(),
    radius: cfg.patchRadius,
    dps: cfg.patchDps,
    life: 0,
    ttl: cfg.patchDur,
  });
}

// =====================================================================
// POISON CLOUD (poison mine aftermath)
// =====================================================================
// A cloud is several drifting additive puffs covering an area — they
// share a damage region (radius around cloud.pos) but each renders
// independently for visual variety.
function _spawnPoisonCloud(pos, cfg) {
  const cloudColor = new THREE.Color(cfg.cloudColor);
  const puffs = [];
  const PUFF_COUNT = 7;
  for (let i = 0; i < PUFF_COUNT; i++) {
    const a = (i / PUFF_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const r = cfg.cloudRadius * (0.2 + Math.random() * 0.7);
    const px = pos.x + Math.cos(a) * r;
    const pz = pos.z + Math.sin(a) * r;
    const py = 0.35 + Math.random() * 0.4;
    const mat = new THREE.MeshBasicMaterial({
      color: cloudColor,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(_CLOUD_PUFF_GEO, mat);
    mesh.position.set(px, py, pz);
    scene.add(mesh);
    puffs.push({
      mesh, mat,
      pos: new THREE.Vector3(px, py, pz),
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 0.6,
        0.15 + Math.random() * 0.25,
        (Math.random() - 0.5) * 0.6,
      ),
      delay: i * 0.05,
      ttl: cfg.cloudDur,
      phase: Math.random() * Math.PI * 2,
    });
  }
  _activeClouds.push({
    puffs,
    pos: pos.clone(),
    radius: cfg.cloudRadius,
    dps: cfg.cloudDps,
    life: 0,
    ttl: cfg.cloudDur,
  });
}

// =====================================================================
// DISPOSAL
// =====================================================================
function _disposeMine(m) {
  if (m.root.parent) scene.remove(m.root);
  if (m.baseMat) m.baseMat.dispose();
  if (m.lightMat) m.lightMat.dispose();
}

export function clearAllMines() {
  for (const m of _activeMines) _disposeMine(m);
  _activeMines.length = 0;
  for (const p of _activePatches) {
    if (p.disc.parent) p.disc.parent.remove(p.disc);
    if (p.mat) p.mat.dispose();
  }
  _activePatches.length = 0;
  for (const c of _activeClouds) {
    for (const puff of c.puffs) {
      if (puff.mesh.parent) puff.mesh.parent.remove(puff.mesh);
      if (puff.mat) puff.mat.dispose();
    }
  }
  _activeClouds.length = 0;
  // Airborne mines (mid-flight from a dispenser) — dispose just like
  // a regular mine since the inner THREE objects are the same.
  for (const a of _airborneMines) {
    if (a.root.parent) scene.remove(a.root);
    if (a.baseMat) a.baseMat.dispose();
    if (a.lightMat) a.lightMat.dispose();
  }
  _airborneMines.length = 0;
  // Dispensers.
  for (const d of _activeDispensers) _disposeDispenser(d);
  _activeDispensers.length = 0;
}
