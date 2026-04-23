// ============================================================================
// src/pixlPals.js — summonable Pixl Pal allies.
//
// DESIGN
//  - Every 3 completed waves, the player earns a "Pixl Pal charge"
//    (stored on S.pixlPalCharges). Pressing E (or the mobile button)
//    while charges are available summons one.
//  - A summoned Pixl Pal is a GLB-loaded ally picked at random from the
//    10 voxlpal-*.glb files in assets/civilians/pixlpal/. It is assigned
//    a random combat weapon (pistol/shotgun/smg/rocket/raygun).
//  - The pal auto-targets the nearest enemy inside range and fires bullets
//    at a max-output cadence so it clears the arena quickly. Its mission:
//    eliminate ~3/4 of the enemies that were alive at the moment of summon,
//    then wave goodbye.
//  - Pal bullets deal max damage vs normal enemies. Vs bosses: ONE-QUARTER
//    damage (boss kills still belong to the player).
//  - Pal bullets DO NOT hit mining blocks, hives (spawners), civilians, or
//    the player. They only hurt enemies and bosses.
//
// INTEGRATION
//  - main.js registers a kill handler at startup (registerPixlPalKillHandler)
//    so kills flow through the existing score/XP/loot pipeline.
//  - main.js calls updatePixlPals(dt) every frame from animate(), and
//    clearAllPixlPals() from the game reset path.
//  - waves.js (or main.js) should call onWaveStarted(waveNum) so we can
//    award a charge every 3rd wave boundary. Charges accumulate up to
//    a cap so the player can stockpile if they want.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { scene } from './scene.js';
import { ARENA, WEAPONS, CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { enemies } from './enemies.js';
import { Audio } from './audio.js';
import { S, shake } from './state.js';
import { UI } from './ui.js';

// -----------------------------------------------------------------------------
// ASSETS / CONSTANTS
// -----------------------------------------------------------------------------

// The 10 GLB files that live in assets/civilians/pixlpal/.
// Add to this list if more pals get added later.
const PIXLPAL_GLB_IDS = [14, 108, 776, 928, 1281, 1394, 1898, 2360, 2609, 2843];

// Which weapons a pal can be assigned. Pickaxe is a mining tool so it's
// excluded; pals need a combat weapon.
const PIXLPAL_WEAPONS = ['pistol', 'shotgun', 'smg', 'rocket', 'raygun'];

// Gate: one charge every this-many completed waves.
const CHARGE_EVERY_N_WAVES = 3;

// Maximum stockpile of charges.
const MAX_CHARGES = 3;

// Boss damage scale — pal bullets only deal this fraction of their
// normal damage to bosses. Pal helps, but can't steal boss kills easily.
const BOSS_DAMAGE_SCALE = 0.25;

// How long a pal may remain on the field before it auto-despawns.
// Prevents a pal sitting forever if the wave empties out on its own.
const PAL_MAX_LIFETIME_SEC = 16;

// Clear-goal: kill this fraction of enemies alive at summon time, then leave.
const CLEAR_FRACTION = 0.75;

// AI / firing tuning — "max output" for quick field clearing.
// Each weapon has its own base fire rate in WEAPONS; we multiply it down so
// the pal is noticeably faster than the player, and its damage is multiplied
// up so it actually melts groups. Bosses still see normal damage * 0.25.
const PAL_DAMAGE_MULT = 1.75;
const PAL_FIRE_RATE_MULT = 0.55;   // lower = faster shots

const PAL_RANGE = 28;
const PAL_MOVE_SPEED = 8.5;        // chases/repositions between shots
const PAL_HITRADIUS_DEFAULT = 1.0;
const PAL_BULLET_LIFE = 1.8;

// Keep pals from bunching up with the player too tightly.
const PAL_KEEP_NEAR_PLAYER = 14;

const PAL_SPAWN_OFFSET = 5.0;      // drop in this far from the player

// -----------------------------------------------------------------------------
// MODULE STATE
// -----------------------------------------------------------------------------

const pals = [];         // currently active Pixl Pals
const palBullets = [];   // bullets fired by pals (separate pipe)

let lastWaveAwarded = 0; // last wave on which we awarded a charge
let _killHandler = null; // registered by main.js — wires kills to score/XP

// GLB loader + cache. Clones meshes per-summon so multiple pals can use
// the same GLB simultaneously without interfering.
const gltfLoader = new GLTFLoader();
const glbCache = new Map();   // id -> Promise<gltf>

// Reusable scratch
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export function registerPixlPalKillHandler(fn) {
  _killHandler = fn;
}

/**
 * Called by waves.js (via main.js) when a new wave starts. Grants a charge
 * every CHARGE_EVERY_N_WAVES waves. Safe to call multiple times for the
 * same wave — the lastWaveAwarded guard prevents double-awarding.
 */
export function onWaveStarted(waveNum) {
  if (waveNum <= lastWaveAwarded) return;
  // Award on the first wave too? No — grant starting at wave 3 so the
  // player earns it. CHARGE_EVERY_N_WAVES=3 → waves 3, 6, 9, 12...
  if (waveNum >= CHARGE_EVERY_N_WAVES && waveNum % CHARGE_EVERY_N_WAVES === 0) {
    S.pixlPalCharges = Math.min(MAX_CHARGES, (S.pixlPalCharges || 0) + 1);
    UI.toast && UI.toast('PIXL PAL READY! [E]', '#00ff66', 2000);
    _syncHUD();
  }
  lastWaveAwarded = waveNum;
}

/**
 * Manually add a charge (for debug or future pickups).
 */
export function addPixlPalCharge(n = 1) {
  S.pixlPalCharges = Math.min(MAX_CHARGES, (S.pixlPalCharges || 0) + n);
  _syncHUD();
}

/**
 * Attempt to summon a pal. Returns true if a pal was actually summoned.
 * No-op if no charges are available or if the game isn't running.
 */
export function trySummonPixlPal(playerPos) {
  if (!S.running || S.paused) return false;
  if ((S.pixlPalCharges || 0) <= 0) return false;
  S.pixlPalCharges -= 1;
  _syncHUD();

  const glbId = PIXLPAL_GLB_IDS[Math.floor(Math.random() * PIXLPAL_GLB_IDS.length)];
  const weaponKey = PIXLPAL_WEAPONS[Math.floor(Math.random() * PIXLPAL_WEAPONS.length)];
  const weapon = WEAPONS[weaponKey];

  // Snapshot the enemy count so we can compute "cleared 75%" later.
  const enemiesAlreadyOnField = enemies.length;

  // Spawn location: just beside the player, offset along their facing so
  // they drop in visibly rather than materializing on top of the player.
  const ang = Math.random() * Math.PI * 2;
  const spawnX = (playerPos ? playerPos.x : 0) + Math.cos(ang) * PAL_SPAWN_OFFSET;
  const spawnZ = (playerPos ? playerPos.z : 0) + Math.sin(ang) * PAL_SPAWN_OFFSET;

  const placeholder = new THREE.Group();
  placeholder.position.set(spawnX, 0, spawnZ);
  scene.add(placeholder);

  // Warp-in flash
  _palSpawnFx(placeholder.position);
  Audio.levelup && Audio.levelup();
  shake(0.2, 0.15);

  const pal = {
    obj: placeholder,
    pos: placeholder.position,
    ready: false,
    weaponKey,
    weapon,
    fireCd: 0.3,           // small delay before first shot
    rescanCd: 0,
    targetEnemy: null,
    life: 0,
    maxLife: PAL_MAX_LIFETIME_SEC,
    killsThisSummon: 0,
    enemiesAtSummon: enemiesAlreadyOnField,
    killsGoal: Math.max(3, Math.ceil(enemiesAlreadyOnField * CLEAR_FRACTION)),
    despawning: false,
    walkPhase: Math.random() * Math.PI * 2,
    glbId,
  };
  pals.push(pal);

  // Tell the player which weapon this pal got.
  const color = '#' + weapon.color.toString(16).padStart(6, '0');
  UI.toast && UI.toast('PIXL PAL · ' + weapon.name, color, 1600);

  // Load GLB (async). Voxel fallback on failure so a pal always renders.
  _loadPalMesh(glbId).then(mesh => {
    if (!pals.includes(pal)) return;        // despawned while loading
    scene.remove(pal.obj);
    mesh.position.copy(pal.pos);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    _applyPalHighlight(mesh, weapon.color);
    scene.add(mesh);
    pal.obj = mesh;
    pal.pos = mesh.position;
    pal.ready = true;
  }).catch(err => {
    console.warn('[PixlPal] GLB load failed for', glbId, err);
    // Fallback: keep the placeholder as a glow cube
    _buildFallbackVoxel(pal.obj, weapon.color);
    pal.ready = true;
  });

  return true;
}

/**
 * Clear all pals + pal bullets. Call from the game-reset path.
 */
export function clearAllPixlPals() {
  for (const p of pals) {
    if (p.obj && p.obj.parent) scene.remove(p.obj);
  }
  pals.length = 0;
  for (const b of palBullets) {
    if (b && b.parent) scene.remove(b);
  }
  palBullets.length = 0;
  lastWaveAwarded = 0;
  S.pixlPalCharges = 0;
  _syncHUD();
}

/**
 * Main per-frame update. Called from main.js animate().
 *
 * @param {number} dt            seconds since last frame
 * @param {THREE.Vector3} playerPos  used to keep pals roughly near player
 */
export function updatePixlPals(dt, playerPos) {
  // --- Pals ---
  for (let i = pals.length - 1; i >= 0; i--) {
    const p = pals[i];
    if (!p.ready) continue;

    p.life += dt;

    // Despawn conditions: lifetime expired, mission complete, or game over.
    if (!p.despawning && (
        p.life >= p.maxLife ||
        p.killsThisSummon >= p.killsGoal
    )) {
      p.despawning = true;
      p.despawnTimer = 0.45;
      UI.toast && UI.toast('PIXL PAL EXTRACT', '#00ff66', 1000);
    }

    if (p.despawning) {
      p.despawnTimer -= dt;
      if (p.obj && p.obj.scale) {
        const s = Math.max(0.01, p.despawnTimer / 0.45);
        p.obj.scale.setScalar(s);
      }
      if (p.despawnTimer <= 0) {
        _palSpawnFx(p.pos);
        scene.remove(p.obj);
        pals.splice(i, 1);
        continue;
      }
    }

    // --- Retarget (cheap periodic rescan) ---
    p.rescanCd -= dt;
    if (p.rescanCd <= 0 || !_enemyAlive(p.targetEnemy)) {
      p.rescanCd = 0.25;
      p.targetEnemy = _findNearestEnemy(p.pos, PAL_RANGE);
    }

    // --- Movement: chase current target, or drift back toward player ---
    let moveTo = null;
    if (p.targetEnemy) {
      moveTo = p.targetEnemy.pos;
    } else if (playerPos) {
      // Idle near the player
      _v.copy(playerPos).sub(p.pos);
      if (_v.lengthSq() > PAL_KEEP_NEAR_PLAYER * PAL_KEEP_NEAR_PLAYER) {
        moveTo = playerPos;
      }
    }

    if (moveTo) {
      _v.copy(moveTo).sub(p.pos);
      _v.y = 0;
      const dist = _v.length();
      if (dist > 0.001) {
        _v.multiplyScalar(1 / dist);
        // Stand off ~6 units from targets so we don't faceplant into them
        const desired = p.targetEnemy ? 6 : 0;
        if (dist > desired) {
          p.pos.x += _v.x * PAL_MOVE_SPEED * dt;
          p.pos.z += _v.z * PAL_MOVE_SPEED * dt;
        }
        // Face the move direction
        if (p.obj) p.obj.rotation.y = Math.atan2(_v.x, _v.z);
      }
      // Clamp inside arena
      const lim = ARENA * 0.95;
      if (p.pos.x > lim) p.pos.x = lim;
      if (p.pos.x < -lim) p.pos.x = -lim;
      if (p.pos.z > lim) p.pos.z = lim;
      if (p.pos.z < -lim) p.pos.z = -lim;
    }

    // Subtle walk bob so the pal doesn't look frozen
    p.walkPhase += dt * 10;
    if (p.obj && !p.despawning) {
      p.obj.position.y = Math.abs(Math.sin(p.walkPhase)) * 0.06;
    }

    // --- Shooting ---
    p.fireCd -= dt;
    if (!p.despawning && p.fireCd <= 0 && p.targetEnemy && _enemyAlive(p.targetEnemy)) {
      _firePalShot(p, p.targetEnemy);
      // Weapon-specific base rate, then global pal speed multiplier
      const baseRate = p.weapon.fireRate || 0.3;
      p.fireCd = Math.max(0.05, baseRate * PAL_FIRE_RATE_MULT);
    }
  }

  // --- Pal bullets ---
  for (let i = palBullets.length - 1; i >= 0; i--) {
    const b = palBullets[i];
    const ud = b.userData;
    // Homing for rockets (same logic as player rockets — just turn toward target)
    if (ud.homing && _enemyAlive(ud.homingTarget)) {
      _v.copy(ud.homingTarget.pos).sub(b.position);
      _v.y = 0;
      if (_v.lengthSq() > 0.001) {
        _v.normalize();
        const cur = ud.vel.clone().normalize();
        // Lerp toward target direction
        const turn = Math.min(1, ud.homingStrength * dt);
        cur.lerp(_v, turn).normalize();
        const spd = ud.vel.length();
        ud.vel.copy(cur).multiplyScalar(spd);
      }
    }
    b.position.addScaledVector(ud.vel, dt);
    ud.life -= dt;
    if (ud.life <= 0 ||
        Math.abs(b.position.x) > ARENA ||
        Math.abs(b.position.z) > ARENA) {
      if (ud.explodes) _palExplosion(b.position, ud);
      scene.remove(b);
      palBullets.splice(i, 1);
      continue;
    }
    // Enemy hit check — THIS IS THE ONLY COLLISION PATH.
    // Pal bullets intentionally skip blocks, hives/spawners, civilians,
    // and the player. Bosses are regular enemies in the `enemies` array
    // except bossRef flag on them.
    let hitIdx = -1;
    let hitRadius = ud.hitRadius;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const r = e.isBoss ? hitRadius * 2.5 : hitRadius;
      const dx = e.pos.x - b.position.x;
      const dz = e.pos.z - b.position.z;
      if (dx * dx + dz * dz < r * r) { hitIdx = j; break; }
    }
    if (hitIdx >= 0) {
      const e = enemies[hitIdx];
      _applyPalDamage(e, ud.damage, hitIdx);
      if (ud.explodes) {
        _palExplosion(b.position, ud);
      } else {
        hitBurst(b.position, ud.color, 5);
      }
      scene.remove(b);
      palBullets.splice(i, 1);
    }
  }
}

// -----------------------------------------------------------------------------
// INTERNAL: FIRING
// -----------------------------------------------------------------------------

function _firePalShot(pal, target) {
  const w = pal.weapon;
  // Fire origin: muzzle height over the pal
  const origin = new THREE.Vector3(pal.pos.x, 1.3, pal.pos.z);
  // Aim at target with a small lead
  _v.copy(target.pos).sub(origin);
  _v.y = 0;
  const dist = _v.length();
  if (dist < 0.001) return;
  _v.normalize();

  const baseDmg = (w.damage || 20) * PAL_DAMAGE_MULT;

  if (w.isBeam) {
    // RAYGUN: instant hitscan tick. Damage all enemies inside a narrow cone
    // along the aim ray up to beamRange.
    const beamRange = w.beamRange || 22;
    const beamWidth = (w.beamWidth || 0.35) * 1.4;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const ex = e.pos.x - origin.x;
      const ez = e.pos.z - origin.z;
      const along = ex * _v.x + ez * _v.z;
      if (along < 0 || along > beamRange) continue;
      const perp = Math.abs(ex * _v.z - ez * _v.x);
      const r = e.isBoss ? beamWidth + 1.2 : beamWidth + 0.5;
      if (perp < r) {
        _applyPalDamage(e, baseDmg, j);
      }
    }
    // Visual: a brief line segment shown via particles at segments.
    for (let k = 0; k < 10; k++) {
      const t = k / 9;
      const px = origin.x + _v.x * beamRange * t;
      const pz = origin.z + _v.z * beamRange * t;
      hitBurst(new THREE.Vector3(px, 1.2, pz), w.color, 1);
    }
    return;
  }

  if (w.isHoming) {
    // ROCKET — single homing projectile with AoE at end-of-life.
    _spawnPalBullet(origin, _v, {
      speed: w.speed,
      damage: baseDmg,
      color: w.color,
      hitRadius: 1.1,
      homing: true,
      homingTarget: target,
      homingStrength: w.homingStrength || 5,
      explodes: true,
      explosionRadius: w.explosionRadius || 3.5,
      explosionDamage: (w.explosionDamage || 60) * PAL_DAMAGE_MULT,
      life: 2.4,
    });
    return;
  }

  // PISTOL / SHOTGUN / SMG — straight-line projectile(s).
  const nShots = w.bullets || 1;
  const spread = w.spread || 0;
  for (let k = 0; k < nShots; k++) {
    const ang = Math.atan2(_v.x, _v.z);
    const jitter = (nShots > 1)
      ? (k / (nShots - 1) - 0.5) * spread * 2 + (Math.random() - 0.5) * spread * 0.5
      : (Math.random() - 0.5) * spread;
    const theta = ang + jitter;
    const dir = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
    _spawnPalBullet(origin, dir, {
      speed: w.speed,
      damage: baseDmg / (nShots > 1 ? 1 : 1),    // shotgun pellets already split at weapon-def time
      color: w.color,
      hitRadius: PAL_HITRADIUS_DEFAULT,
      life: PAL_BULLET_LIFE,
    });
  }
}

function _spawnPalBullet(origin, dir, opts) {
  const geo = opts.explodes
    ? new THREE.SphereGeometry(0.35, 8, 8)
    : new THREE.BoxGeometry(0.22, 0.22, 0.55);
  const mat = new THREE.MeshBasicMaterial({
    color: opts.color,
    transparent: true,
    opacity: 0.95,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(origin);
  if (!opts.explodes) {
    m.lookAt(origin.x + dir.x, origin.y, origin.z + dir.z);
  }
  m.userData = {
    vel: dir.clone().multiplyScalar(opts.speed),
    life: opts.life,
    damage: opts.damage,
    color: opts.color,
    hitRadius: opts.hitRadius,
    homing: !!opts.homing,
    homingTarget: opts.homingTarget || null,
    homingStrength: opts.homingStrength || 0,
    explodes: !!opts.explodes,
    explosionRadius: opts.explosionRadius || 0,
    explosionDamage: opts.explosionDamage || 0,
  };
  scene.add(m);
  palBullets.push(m);
}

function _palExplosion(pos, ud) {
  hitBurst(pos, ud.color, 24);
  shake(0.15, 0.12);
  const r = ud.explosionRadius;
  const dmg = ud.explosionDamage;
  for (let j = enemies.length - 1; j >= 0; j--) {
    const e = enemies[j];
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    if (dx * dx + dz * dz < r * r) {
      _applyPalDamage(e, dmg, j);
    }
  }
}

// -----------------------------------------------------------------------------
// INTERNAL: DAMAGE
// -----------------------------------------------------------------------------

function _applyPalDamage(enemy, dmg, enemyIdx) {
  if (!enemy) return;
  // Bosses take only a quarter of the pal's damage so the player still
  // has to do the real work.
  if (enemy.isBoss) dmg *= BOSS_DAMAGE_SCALE;
  enemy.hp -= dmg;
  enemy.hitFlash = 0.18;
  if (enemy.hp <= 0) {
    // Locate the enemy's current index (may have shifted if other bullets
    // were processed in the same frame).
    let idx = enemyIdx;
    if (idx == null || idx < 0 || enemies[idx] !== enemy) {
      idx = enemies.indexOf(enemy);
    }
    if (idx >= 0 && _killHandler) {
      // Attribute the kill to the pal's summoner.
      _onPalKill();
      _killHandler(idx);
    }
  }
}

function _onPalKill() {
  // Credit the most-recent still-alive pal. If multiple pals are up,
  // crediting the first one is fine — they're all expendable.
  for (const p of pals) {
    if (!p.despawning) {
      p.killsThisSummon++;
      break;
    }
  }
}

function _enemyAlive(e) {
  return !!e && e.hp > 0 && enemies.indexOf(e) >= 0;
}

function _findNearestEnemy(fromPos, maxRange) {
  let best = null;
  let bestDsq = maxRange * maxRange;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const dx = e.pos.x - fromPos.x;
    const dz = e.pos.z - fromPos.z;
    const dsq = dx * dx + dz * dz;
    if (dsq < bestDsq) { bestDsq = dsq; best = e; }
  }
  return best;
}

// -----------------------------------------------------------------------------
// INTERNAL: GLB LOAD / CACHE
// -----------------------------------------------------------------------------

function _loadPalMesh(id) {
  if (!glbCache.has(id)) {
    const url = `assets/civilians/pixlpal/voxlpal-${id}.glb`;
    glbCache.set(id, new Promise((resolve, reject) => {
      gltfLoader.load(url, resolve, undefined, reject);
    }));
  }
  return glbCache.get(id).then(gltf => {
    // CRITICAL: these GLBs are rigged (SkinnedMesh + Skin + 80-bone rig).
    // THREE.Object3D.clone() does NOT properly clone rigs — the cloned
    // SkinnedMeshes still reference the original scene graph's bones,
    // so when the clone is inserted into our scene they render at the
    // identity transform (collapsed / invisible).
    //
    // SkeletonUtils.clone is the standard Three.js fix — it rebinds the
    // skeleton to the cloned bones so the mesh renders correctly.
    const clone = skeletonClone(gltf.scene);

    // Pal avatars import with Z-up or mis-scaled; normalize to ~2.2 units tall.
    // setFromObject can return an invalid box on SkinnedMeshes because
    // their geometry's bounding volumes are relative to bind pose. We
    // still ask for one and accept whatever we get — it's close enough
    // for a rough scale normalization.
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.y > 0.01 && isFinite(size.y)) {
      const s = 2.2 / size.y;
      clone.scale.setScalar(s);
      clone.updateMatrixWorld(true);
    }

    // Drop them feet-on-ground. Recompute box after rescale.
    const box2 = new THREE.Box3().setFromObject(clone);
    if (isFinite(box2.min.y)) {
      clone.position.y -= box2.min.y;
    }

    // Disable frustum culling for skinned meshes. Their bounding volume
    // is bind-pose based and often sits offset from the rendered pose,
    // causing sporadic invisibility at glancing camera angles.
    clone.traverse(obj => {
      if (obj.isMesh || obj.isSkinnedMesh) {
        obj.frustumCulled = false;
        obj.castShadow = true;
      }
    });

    return clone;
  });
}

function _applyPalHighlight(mesh, weaponColor) {
  // Subtle emissive lift in the pal's weapon color so it reads as an
  // ally from across the arena.
  const tint = new THREE.Color(weaponColor);
  mesh.traverse(obj => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.emissive) {
          m.emissive = m.emissive.clone().add(tint.clone().multiplyScalar(0.2));
          m.emissiveIntensity = Math.max(0.25, m.emissiveIntensity || 0.25);
          m.needsUpdate = true;
        }
      }
    }
  });
  // Aura ring at the feet
  const auraGeo = new THREE.RingGeometry(0.9, 1.3, 24);
  const auraMat = new THREE.MeshBasicMaterial({
    color: weaponColor,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.55,
  });
  const aura = new THREE.Mesh(auraGeo, auraMat);
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.05;
  mesh.add(aura);
}

function _buildFallbackVoxel(placeholder, weaponColor) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: weaponColor,
    emissiveIntensity: 0.8,
    roughness: 0.4,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.6), mat);
  body.position.y = 1.0;
  placeholder.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat);
  head.position.y = 2.2;
  placeholder.add(head);
}

function _palSpawnFx(pos) {
  // Bright burst + quick shake for the arrival / departure warp
  hitBurst(pos, 0x00ff66, 30);
  hitBurst(pos, 0xffffff, 12);
}

// -----------------------------------------------------------------------------
// HUD INDICATOR
// -----------------------------------------------------------------------------

// Lightweight DOM indicator — we keep it self-contained here so ui.js
// doesn't need to know about pals.
function _syncHUD() {
  let el = document.getElementById('pixlpal-indicator');
  const charges = S.pixlPalCharges || 0;
  if (!el) {
    el = document.createElement('div');
    el.id = 'pixlpal-indicator';
    el.style.cssText = [
      'position:fixed',
      'top:80px',
      'right:16px',
      'z-index:15',
      'padding:8px 12px',
      'border:2px solid #00ff66',
      'border-radius:6px',
      'background:rgba(0,20,10,0.7)',
      'color:#00ff66',
      "font-family:'Impact',monospace",
      'font-size:14px',
      'letter-spacing:2px',
      'box-shadow:0 0 14px rgba(0,255,102,0.4)',
      'pointer-events:none',
      'user-select:none',
      'transition:opacity 0.2s',
    ].join(';');
    document.body.appendChild(el);
  }
  if (charges <= 0) {
    el.style.opacity = '0.35';
    el.innerHTML = 'PIXL PAL · <b>0</b>';
  } else {
    el.style.opacity = '1';
    el.innerHTML = 'PIXL PAL [E] · <b style="color:#fff">' + charges + '</b>';
  }
}

// Initialize the HUD once the DOM is ready. Safe to call multiple times.
export function initPixlPalHUD() {
  _syncHUD();
}
