// Edge-of-screen objective arrows.
//
// Shows a pulsing arrow along the viewport edge for every off-screen
// target that matters this wave. Each arrow is labelled with the
// target type (ORE, HIVE, DEPOT, BOSS) and the distance from the
// player.
//
// Target set per wave type:
//   mining   — nearest grounded blocks (up to 5). While the player is
//              carrying ores, replaced by the depot arrow so the drop-
//              off becomes the next objective.
//   powerup  — stage 1 stub: no arrows (zones are coming in stage 2).
//   hive     — every live hive. Shielded hives are invulnerable but
//              still worth pointing at so the player knows they exist.
//   bonus    — no arrows (herd + proximity catching is self-guiding).
//   boss     — the boss (always panic-styled).
//
// VISUAL THEME
//   Arrows are tinted to the CURRENT CHAPTER's signature color. Targets
//   flagged `panic` (the boss) render in red, overriding the chapter tint.
//
// DOM strategy: pool of 8 arrow elements created once, reused per frame.

import * as THREE from 'three';
import { enemies } from './enemies.js';
import { spawners } from './spawners.js';
import { blocks } from './blocks.js';
import { depot as currentDepot, ores } from './ores.js';
import { CHAPTERS } from './config.js';
import { getActiveZone } from './powerupZones.js';
import { LAYOUT } from './waveProps.js';
import { getTruckPos } from './escortTruck.js';
import { getChargingZonePos } from './serverWarehouse.js';
import { getPodPos } from './safetyPod.js';

const POOL_SIZE = 8;
const PANIC_COLOR = '#ff2e4d';   // always-red override for dangerous targets

const _v3 = new THREE.Vector3();
let _layer = null;
let _pool = [];
let _stylesInjected = false;

// Scratch array for per-frame target collection — reused, no alloc.
const _targets = [];

/** Convert 0xRRGGBB integer to '#rrggbb' CSS string. */
function _hex(n) {
  return '#' + n.toString(16).padStart(6, '0');
}

/** Inject structural CSS once (layout, animations). Per-arrow COLORS
 *  are applied inline in updateObjectiveArrows so chapter tint can
 *  change at runtime without touching the stylesheet. */
function _injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const css = `
    #objective-arrow-layer {
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 13;
    }
    .obj-arrow {
      position: absolute;
      display: none;
      flex-direction: column;
      align-items: center;
      transform-origin: center;
      pointer-events: none;
      /* filter (drop-shadow glow) is set inline per-frame so it
         matches the chapter / panic tint */
    }
    .obj-arrow .obj-arrow-head {
      font-size: 56px;
      line-height: 1;
      font-weight: 900;
      -webkit-text-stroke: 2px rgba(0,0,0,0.85);
      animation: obj-arrow-pulse 0.7s ease-in-out infinite;
      /* color + text-shadow set inline */
    }
    .obj-arrow .obj-arrow-meta {
      font-family: 'Impact', monospace;
      font-weight: 900;
      font-size: 14px;
      letter-spacing: 3px;
      margin-top: 3px;
      padding: 2px 8px;
      background: rgba(0,0,0,0.55);
      border-radius: 3px;
      white-space: nowrap;
      /* color + text-shadow set inline */
    }
    .obj-arrow.panic .obj-arrow-head {
      animation: obj-arrow-panic 0.22s ease-in-out infinite;
    }
    @keyframes obj-arrow-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50%      { transform: scale(1.45); opacity: 0.85; }
    }
    @keyframes obj-arrow-panic {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.6); }
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

/** Lazy-create the pool on first update. */
function _ensurePool() {
  if (_layer) return;
  _injectStyles();
  _layer = document.createElement('div');
  _layer.id = 'objective-arrow-layer';
  document.body.appendChild(_layer);

  for (let i = 0; i < POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'obj-arrow';
    const head = document.createElement('div');
    head.className = 'obj-arrow-head';
    head.textContent = '➤';
    const meta = document.createElement('div');
    meta.className = 'obj-arrow-meta';
    meta.textContent = '';
    el.appendChild(head);
    el.appendChild(meta);
    _layer.appendChild(el);
    _pool.push({ el, head, meta });
  }
}

/** Hide every arrow (wave end, game over, etc). */
export function clearObjectiveArrows() {
  if (!_pool.length) return;
  for (const p of _pool) p.el.style.display = 'none';
}

/**
 * Apply a color to one arrow. Updates the head glyph, the meta
 * label, and the wrapper's drop-shadow glow so the whole unit reads
 * as one tinted object.
 */
function _setArrowColor(p, colorStr) {
  p.head.style.color = colorStr;
  // Stacked shadows produce a much brighter halo than a single shadow —
  // this is what makes the arrow pop against busy backgrounds.
  p.head.style.textShadow = [
    `0 0 4px ${colorStr}`,
    `0 0 14px ${colorStr}`,
    `0 0 26px ${colorStr}`,
    `2px 2px 0 #000`,
  ].join(', ');
  p.meta.style.color = colorStr;
  p.meta.style.textShadow = `0 0 8px ${colorStr}, 1px 1px 0 #000`;
  // Double drop-shadow on the wrapper for an even thicker outer glow.
  p.el.style.filter = `drop-shadow(0 0 10px ${colorStr}) drop-shadow(0 0 18px ${colorStr})`;
}

/** Collect (x, z, label, panic) entries for the current wave. */
function _collectTargets(S, waveDef, playerPos) {
  _targets.length = 0;
  if (!waveDef) return;

  const px = playerPos ? playerPos.x : 0;
  const pz = playerPos ? playerPos.z : 0;

  switch (waveDef.type) {
    case 'mining': {
      // CHAPTER 2 ESCORT — arrow tracks the truck so player can find
      // it while moving. Truck is the only target during the escort.
      if (waveDef.isEscortWave) {
        const tp = getTruckPos();
        if (tp) {
          _targets.push({
            x: tp.x, z: tp.z,
            label: 'TRUCK', panic: false,
          });
        }
        break;
      }
      // CHAPTER 1 EGG-WAVE OVERRIDE — phase-aware arrow:
      //   Phase 1: eggs alive → point at nearest egg (treated as block)
      //   Phase 2: eggs broken, cubes spawned → point at crusher position
      //            (cubes cluster on the crusher pad)
      //   Phase 3: all 4 cubes collected → no arrow (wave-end imminent)
      if (waveDef.isEggWave) {
        const eggsLive = blocks.filter(b => b.kind === 'egg' && !b.destroyed).length;
        if (eggsLive === 0 && S._chargeCubesSpawned && (S.chargesCarried || 0) < 4) {
          // Cubes phase — single arrow at the crusher (cluster center)
          if (currentDepot) {
            _targets.push({
              x: currentDepot.pos.x, z: currentDepot.pos.z,
              label: 'CHARGES', panic: false,
            });
          }
          break;
        }
        // Phase 1 — point at remaining eggs (use blocks array — eggs
        // are stored there with kind='egg').
        const eggCandidates = [];
        for (const b of blocks) {
          if (b.kind !== 'egg' || b.destroyed) continue;
          const dx = b.pos.x - px;
          const dz = b.pos.z - pz;
          eggCandidates.push({ x: b.pos.x, z: b.pos.z, label: 'EGG', d2: dx * dx + dz * dz });
        }
        eggCandidates.sort((a, b) => a.d2 - b.d2);
        const eggLimit = Math.min(POOL_SIZE, eggCandidates.length);
        for (let i = 0; i < eggLimit; i++) {
          const c = eggCandidates[i];
          _targets.push({ x: c.x, z: c.z, label: c.label, panic: false });
        }
        break;
      }

      // Mining arrow flow (strict, intentional):
      //   PHASE 1: The player still needs to collect ores. Point only at
      //            mining BLOCKS — not at loose ores on the floor, not at
      //            the depot. The player's job in this phase is unambiguous:
      //            break blocks. Ore pickup happens organically when they
      //            walk over what falls, and the carried-ore HUD chip is
      //            already on screen telling them how many they have.
      //   PHASE 2: The player has collected 5 ores (carrying + deposited).
      //            Clear every block arrow and point ONLY at the depot.
      //            No competing arrows — the objective is to walk here.
      //
      // This replaces the old behavior which drew both blocks AND loose
      // ores as arrows in phase 1, and which waited on `deposited >= 5`
      // to flip to depot. The new rule flips as soon as the player HAS
      // 5 ores (in hand or deposited), which matches the HUD's
      // "DELIVER ORES · N/5 (carrying M)" messaging.
      // NOTE on counting: each pickup increments BOTH S.oresCarried AND
      // depot.deposited in the same frame — the ore gets a +1 carried
      // tally on pickup, then immediately starts flying to a depot
      // orbit slot, which makes depot.deposited also count it as
      // "in-transit to depot". Summing them double-counts each pickup,
      // which used to cause the arrows to flip after the player had
      // collected only 3 ores (3+3=6 ≥ 5). `S.oresCarried` alone is the
      // accurate cumulative count — it's incremented once per pickup
      // and only resets to 0 when the mega-ore merges after all 5 are
      // collected.
      const required = currentDepot ? currentDepot.required : 5;
      const carried = S.oresCarried || 0;
      const collected = carried;
      const haveEnough = collected >= required;

      if (haveEnough && currentDepot) {
        _targets.push({
          x: currentDepot.pos.x, z: currentDepot.pos.z,
          label: 'DEPOT', panic: false,
        });
        break;
      }

      // PHASE 1 — point only at grounded blocks, nearest first.
      const candidates = [];
      for (const b of blocks) {
        if (b.falling || b.destroyed) continue;
        const dx = b.pos.x - px;
        const dz = b.pos.z - pz;
        candidates.push({ x: b.pos.x, z: b.pos.z, label: 'BLOCK', d2: dx * dx + dz * dz });
      }
      candidates.sort((a, b) => a.d2 - b.d2);
      const limit = Math.min(POOL_SIZE, candidates.length);
      for (let i = 0; i < limit; i++) {
        const c = candidates[i];
        _targets.push({ x: c.x, z: c.z, label: c.label, panic: false });
      }
      // Safety fallback — blocks are mid-air (falling) and none grounded
      // yet. Rather than show no objective at all, point at the depot so
      // the player isn't adrift. Rare edge case; gracefully degrades.
      if (candidates.length === 0 && currentDepot) {
        _targets.push({
          x: currentDepot.pos.x, z: currentDepot.pos.z,
          label: 'DEPOT', panic: false,
        });
      }
      break;
    }
    case 'capture': {
      // Legacy wave type, no longer in the default flow. If a save ever
      // references it, just skip — no targets to draw.
      break;
    }
    case 'cannon-load': {
      // Chapter 1 wave 2 — arrow points at the cannon for the entire
      // wave. Player walks to it, charges it, then watches the
      // barrage. No reason to ever flip back to the crusher (the
      // crusher is already gone — sunk into the ground at wave 1 end).
      _targets.push({
        x: LAYOUT.silo.x, z: LAYOUT.silo.z,
        label: 'CANNON', panic: false,
      });
      break;
    }
    case 'datacenter': {
      // Chapter 2 wave 2 — phase-aware arrow (Turn 7 phase names).
      //   warehouse-charging → point at warehouse charging zone
      //   pod-descending → point at incoming pod (orange "INCOMING")
      //   pod-charging → point at landed pod ("CHARGE POD")
      //   hive-lasers / finale-laser → point at pod with panic (red, "POD")
      const phase = S.dcPhase || 'warehouse-charging';
      if (phase === 'warehouse-charging') {
        const cz = getChargingZonePos();
        if (cz) {
          _targets.push({
            x: cz.x, z: cz.z,
            label: 'CHARGE', panic: false,
          });
        }
      } else if (phase === 'pod-descending') {
        const pp = getPodPos();
        if (pp) {
          _targets.push({
            x: pp.x, z: pp.z,
            label: 'INCOMING', panic: false,
          });
        }
      } else if (phase === 'pod-charging') {
        const pp = getPodPos();
        if (pp) {
          _targets.push({
            x: pp.x, z: pp.z,
            label: 'CHARGE POD', panic: false,
          });
        }
      } else if (phase === 'hive-lasers' || phase === 'finale-laser') {
        const pp = getPodPos();
        if (pp) {
          _targets.push({
            x: pp.x, z: pp.z,
            label: 'POD', panic: true,         // panic = red flashing
          });
        }
      }
      break;
    }
    case 'queen-cleanup': {
      // Chapter 1 wave 3 — point at every surviving hive in the cluster.
      for (const s of spawners) {
        if (s.destroyed) continue;
        _targets.push({
          x: s.pos.x, z: s.pos.z,
          label: 'HIVE', panic: false,
        });
      }
      break;
    }
    case 'powerup': {
      // Point at the currently-active power-up zone so the player knows
      // where to run. getActiveZone returns null once every zone has
      // completed (right before the EMP fires the wave to its end).
      const az = getActiveZone();
      if (az && az.pos) {
        _targets.push({
          x: az.pos.x, z: az.pos.z,
          label: az.id || 'ZONE',
          panic: false,
        });
      }
      break;
    }
    case 'hive':
    case 'spawners':
    case 'twinhive': {
      for (const s of spawners) {
        if (s.destroyed) continue;
        _targets.push({
          x: s.pos.x, z: s.pos.z,
          label: s.shielded ? 'SHIELDED HIVE' : 'HIVE',
          panic: false,
        });
      }
      break;
    }
    case 'bonus': {
      // Herd is self-guiding — no edge arrows.
      break;
    }
    case 'boss': {
      for (const e of enemies) {
        if (e.isBoss) {
          // Project the arrow at HEAD HEIGHT instead of floor level.
          // Boss humanoid head local y = 2.6, body group scaled by
          // 0.55 * spec.scale. Result is ~4.5-5.5 world units up
          // depending on which boss. Use the live e.obj scale if
          // we have it, otherwise fall back to a conservative
          // mid-height. Crown is at local y=3.5 (above the head),
          // so projecting at 2.6 in local terms keeps the arrow
          // near the head without covering the crown above.
          let headY = 4.5;
          if (e.obj && e.obj.scale) {
            // 2.6 (head local y) × group scale = world head Y
            headY = 2.6 * (e.obj.scale.y || 1);
          }
          _targets.push({
            x: e.pos.x, z: e.pos.z, targetY: headY,
            label: 'BOSS', panic: true,
          });
          break;
        }
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Per-frame update.
 *
 * @param {object} S       state module
 * @param {THREE.Camera} camera
 * @param {object} waveDef current wave definition (null OK, arrows hide)
 * @param {{x:number,z:number}} playerPos player world position
 */
export function updateObjectiveArrows(S, camera, waveDef, playerPos) {
  _ensurePool();

  // Resolve the chapter tint once per frame — used for every non-panic arrow.
  const chapter = CHAPTERS[(S.chapter || 0) % CHAPTERS.length];
  const chapterColor = _hex(chapter.full.grid1);

  _collectTargets(S, waveDef, playerPos);

  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const margin = 0.88;

  const limit = Math.min(_targets.length, POOL_SIZE);
  for (let i = 0; i < limit; i++) {
    const t = _targets[i];
    const p = _pool[i];

    // Distance from player to objective in world units.
    const ddx = t.x - (playerPos ? playerPos.x : 0);
    const ddz = t.z - (playerPos ? playerPos.z : 0);
    const worldDist = Math.sqrt(ddx * ddx + ddz * ddz);

    // Hide only when the player is RIGHT NEXT TO the objective. Everywhere
    // else the arrow stays visible — if the target is on-screen the arrow
    // floats just above it (edge-clamped when off-screen).
    // Panic targets (the boss) use a wider threshold so the player never
    // loses the boss arrow even when they're in melee range.
    const NEAR_HIDE_DIST = t.panic ? 3 : 5;
    if (worldDist < NEAR_HIDE_DIST) {
      p.el.style.display = 'none';
      continue;
    }

    _v3.set(t.x, t.targetY != null ? t.targetY : 1.5, t.z);
    _v3.project(camera);
    let x = _v3.x;
    let y = _v3.y;
    const behind = _v3.z > 1;
    const onScreen = !behind && Math.abs(x) < 0.85 && Math.abs(y) < 0.85;

    // Behind camera — mirror so the arrow points the right way.
    if (behind) { x = -x; y = -y; }

    let sx, sy, angle;
    if (onScreen) {
      // Target is visible — float the arrow above it. Panic targets
      // (the boss) use a smaller upward offset so the arrow sits AT
      // head height rather than far above the boss (which would
      // overlap the crown). Non-panic targets get the original 60px
      // offset so the arrow clearly floats above the marker.
      const yOffset = t.panic ? 24 : 60;
      sx = (x + 1) * 0.5 * vpW;
      sy = (-y + 1) * 0.5 * vpH - yOffset;
      angle = Math.PI / 2;              // point down (screen Y+ is downward)
    } else {
      // Target off-screen — clamp to screen edge and rotate toward it.
      const max = Math.max(Math.abs(x), Math.abs(y));
      if (max > margin) {
        x = (x / max) * margin;
        y = (y / max) * margin;
      }
      sx = (x + 1) * 0.5 * vpW;
      sy = (-y + 1) * 0.5 * vpH;
      angle = Math.atan2(-y, x);
    }

    const dist = Math.round(worldDist);

    p.el.style.display = 'flex';
    p.el.style.left = sx + 'px';
    p.el.style.top = sy + 'px';
    p.el.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    p.meta.textContent = `${t.label} · ${dist}m`;
    p.meta.style.transform = `rotate(${-angle}rad)`;

    // Color: panic targets are always red (universally readable as
    // danger). Everything else is chapter-tinted.
    const color = t.panic ? PANIC_COLOR : chapterColor;
    _setArrowColor(p, color);
    p.el.classList.toggle('panic', !!t.panic);
  }

  for (let i = limit; i < POOL_SIZE; i++) {
    _pool[i].el.style.display = 'none';
  }
}
