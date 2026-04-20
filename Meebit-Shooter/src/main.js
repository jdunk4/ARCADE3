import * as THREE from 'three';
import { scene, camera, renderer, CAMERA_OFFSET, applyTheme, Scene } from './scene.js';
import { S, keys, mouse, joyState, resetGame, getWeapon, shake } from './state.js';
import { PLAYER, WEAPONS, CHAPTERS, ARENA } from './config.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { loadPlayer, animatePlayer, player, recolorGun, resetPlayer } from './player.js';
import { enemies, enemyProjectiles, spawnEnemyProjectile } from './enemies.js';
import { bullets, spawnBullet, clearBullets, pickups, makePickup, clearPickups, hitBurst, updateParticles, clearParticles } from './effects.js';
import { startWave, updateWaves, onEnemyKilled, resetWaves } from './waves.js';
import { blocks, updateBlocks, segmentBlocked, resolveCollision, findNearestBlock, damageBlock, clearAllBlocks } from './blocks.js';
import { Save } from './save.js';
import { Wallet } from './wallet.js';

// ---- ATTACH RENDERER ----
document.getElementById('game').appendChild(renderer.domElement);

// ---- BUILD MATRIX RAIN ----
function buildMatrixBG(el) {
  if (!el) return;
  const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ01MEEBIT';
  const colCount = Math.floor(window.innerWidth / 16);
  for (let i = 0; i < colCount; i++) {
    const col = document.createElement('div');
    col.className = 'matrix-col';
    col.style.left = (i * 16) + 'px';
    col.style.animationDuration = (3 + Math.random() * 6) + 's';
    col.style.animationDelay = (-Math.random() * 5) + 's';
    let text = '';
    for (let j = 0; j < 30 + Math.random() * 20; j++) {
      text += chars[Math.floor(Math.random() * chars.length)] + '\n';
    }
    col.textContent = text;
    el.appendChild(col);
  }
}
buildMatrixBG(document.getElementById('matrix-bg-load'));
buildMatrixBG(document.getElementById('matrix-bg-title'));
buildMatrixBG(document.getElementById('matrix-rain-persistent'));

// Load saved data and populate title screen stats
const savedData = Save.load();
S.playerMeebitId = savedData.selectedMeebitId || 16801;
UI.populateTitleStats(savedData);

// ---- LOAD MEEBIT ----
const loadBar = document.getElementById('loadbar');
const loadLog = document.getElementById('loadlog');
function setLoad(pct, msg) {
  loadBar.style.width = pct + '%';
  if (msg) loadLog.textContent = msg;
}

setLoad(5, 'BOOTING RENDERER...');
loadPlayer(
  (xhr) => {
    const pct = xhr.total ? (xhr.loaded / xhr.total) * 75 : 40;
    setLoad(Math.max(5, pct), 'LOADING AVATAR... ' + Math.floor(pct) + '%');
  },
  () => {
    setLoad(100, 'READY');
    setTimeout(() => {
      document.getElementById('loading').style.display = 'none';
      showIncomingCall();
    }, 300);
  },
  (err) => {
    console.error(err);
    loadLog.textContent = 'ERROR: ' + (err.message || 'load failed');
  }
);

// ---- INCOMING CALL FLOW ----
function showIncomingCall() {
  const overlay = document.getElementById('incoming-call');
  const ring = document.getElementById('phone-ring');
  ring.volume = 0.6;
  S.phase = 'call';

  const gate = document.createElement('div');
  gate.id = 'audio-gate';
  gate.style.cssText = `
    position: fixed; inset: 0; background: linear-gradient(180deg,#000,#0a0612);
    z-index: 150; display: flex; flex-direction: column; align-items: center; justify-content: center;
    cursor: pointer; font-family: 'Courier New', monospace; color: #00ff66;
    text-align: center; padding: 40px;
  `;
  gate.innerHTML = `
    <div class="matrix-bg" id="matrix-bg-gate" style="position:absolute; inset:0; opacity:0.2; overflow:hidden;"></div>
    <div style="font-family: 'Impact', monospace; font-size: 64px; letter-spacing: 8px; color: #00ff66; text-shadow: 0 0 20px #00ff66; margin-bottom: 20px;">MEEBIT</div>
    <div style="font-size: 14px; letter-spacing: 3px; opacity: 0.8; margin-bottom: 40px;">SURVIVAL PROTOCOL</div>
    <div style="font-size: 18px; letter-spacing: 4px; color: #fff; animation: gate-blink 1.2s infinite;">[ CLICK TO RECEIVE TRANSMISSION ]</div>
    <style>@keyframes gate-blink {0%,100%{opacity:0.5}50%{opacity:1}}</style>
  `;
  document.body.appendChild(gate);
  buildMatrixBG(document.getElementById('matrix-bg-gate'));

  gate.addEventListener('click', () => {
    gate.remove();
    overlay.classList.remove('hidden');
    ring.play().catch(err => console.warn('Ring play failed:', err));

    let seconds = 0;
    const timerEl = document.getElementById('call-timer');
    const timerInt = setInterval(() => {
      seconds++;
      const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
      const ss = (seconds % 60).toString().padStart(2, '0');
      timerEl.textContent = `${mm}:${ss}`;
    }, 1000);

    const end = () => {
      clearInterval(timerInt);
      ring.pause();
      ring.currentTime = 0;
      overlay.classList.add('hidden');
    };

    document.getElementById('call-accept').onclick = () => {
      end();
      document.getElementById('title').classList.remove('hidden');
      S.phase = 'title';
    };
    document.getElementById('call-decline').onclick = () => {
      end();
      document.getElementById('title').classList.remove('hidden');
      S.phase = 'title';
      UI.toast("Can't ignore the Source forever...", '#ff3cac', 2500);
    };
  }, { once: true });
}

// ---- WALLET BUTTON ----
const connectBtn = document.getElementById('connect-wallet-btn');
if (connectBtn) {
  connectBtn.addEventListener('click', async () => {
    connectBtn.textContent = 'CONNECTING...';
    connectBtn.disabled = true;
    try {
      const address = await Wallet.connect();
      connectBtn.textContent = 'LOADING MEEBITS...';
      const owned = await Wallet.getOwnedMeebits(address);
      if (owned.length === 0) {
        connectBtn.textContent = 'NO MEEBITS FOUND';
        UI.toast('No Meebits in wallet ' + address.slice(0, 6) + '...', '#ff3cac', 3000);
        setTimeout(() => {
          connectBtn.textContent = '🦊 CONNECT WALLET';
          connectBtn.disabled = false;
        }, 2500);
        return;
      }
      // Use first owned meebit
      const id = owned[0];
      S.playerMeebitId = id;
      S.playerMeebitOwned = true;
      Save.setSelectedMeebitId(id);
      connectBtn.textContent = '✓ MEEBIT #' + id + ' (x' + owned.length + ')';
      connectBtn.classList.add('connected');
      UI.toast('CONNECTED · Playing as Meebit #' + id, '#00ff66', 3000);
    } catch (err) {
      console.warn('[wallet]', err);
      connectBtn.textContent = '🦊 CONNECT WALLET';
      connectBtn.disabled = false;
      UI.toast('Wallet connection failed: ' + (err.message || 'unknown'), '#ff3cac', 2800);
    }
  });
}

// ---- INPUT ----
window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.code === 'Space') { e.preventDefault(); tryDash(); }
  if (e.key === 'Escape' && S.running) S.paused = !S.paused;

  // Weapon switching 1-4
  if (['1','2','3','4'].includes(e.key)) {
    const map = { '1': 'pistol', '2': 'shotgun', '3': 'smg', '4': 'sniper' };
    const w = map[e.key];
    if (S.ownedWeapons.has(w)) {
      S.currentWeapon = w;
      S.previousCombatWeapon = w;
      UI.updateWeaponSlots();
      recolorGun(WEAPONS[w].color);
      UI.toast(WEAPONS[w].name, '#' + WEAPONS[w].color.toString(16).padStart(6,'0'));
    }
  }
  // Q = toggle pickaxe
  if (e.key.toLowerCase() === 'q') {
    if (S.currentWeapon === 'pickaxe') {
      S.currentWeapon = S.previousCombatWeapon || 'pistol';
    } else {
      S.previousCombatWeapon = S.currentWeapon;
      S.currentWeapon = 'pickaxe';
    }
    UI.updateWeaponSlots();
    recolorGun(WEAPONS[S.currentWeapon].color);
    UI.toast(WEAPONS[S.currentWeapon].name, '#' + WEAPONS[S.currentWeapon].color.toString(16).padStart(6,'0'));
  }
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const mouseNDC = new THREE.Vector2();
window.addEventListener('mousemove', e => {
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(aimPlane, hit);
  if (hit) { mouse.worldX = hit.x; mouse.worldZ = hit.z; }
});
window.addEventListener('mousedown', e => {
  if (e.button === 0) { mouse.down = true; Audio.resume(); }
});
window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });
window.addEventListener('contextmenu', e => e.preventDefault());

// Mobile
const joystick = document.getElementById('joystick');
const knob = document.getElementById('knob');
function startJoy(e) {
  const r = joystick.getBoundingClientRect();
  joyState.active = true;
  joyState.cx = r.left + r.width / 2;
  joyState.cy = r.top + r.height / 2;
  moveJoy(e);
  e.preventDefault();
}
function moveJoy(e) {
  if (!joyState.active) return;
  const t = e.touches[0];
  let dx = t.clientX - joyState.cx;
  let dy = t.clientY - joyState.cy;
  const m = Math.sqrt(dx*dx + dy*dy);
  const max = 50;
  if (m > max) { dx = dx / m * max; dy = dy / m * max; }
  joyState.dx = dx / max;
  joyState.dy = dy / max;
  knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  e.preventDefault();
}
function endJoy() {
  joyState.active = false;
  joyState.dx = 0; joyState.dy = 0;
  knob.style.transform = 'translate(-50%, -50%)';
}
joystick.addEventListener('touchstart', startJoy, { passive: false });
joystick.addEventListener('touchmove', moveJoy, { passive: false });
joystick.addEventListener('touchend', endJoy);
const fireBtn = document.getElementById('fire-btn');
fireBtn.addEventListener('touchstart', e => { mouse.down = true; Audio.resume(); e.preventDefault(); });
fireBtn.addEventListener('touchend', e => { mouse.down = false; });

// Mobile pickaxe toggle button
const pickBtn = document.getElementById('pick-btn');
if (pickBtn) {
  pickBtn.addEventListener('touchstart', e => {
    e.preventDefault();
    if (S.currentWeapon === 'pickaxe') S.currentWeapon = S.previousCombatWeapon || 'pistol';
    else { S.previousCombatWeapon = S.currentWeapon; S.currentWeapon = 'pickaxe'; }
    UI.updateWeaponSlots();
    recolorGun(WEAPONS[S.currentWeapon].color);
  });
}

document.getElementById('sound-toggle').addEventListener('click', (e) => {
  Audio.setMuted(!Audio.muted);
  e.target.textContent = Audio.muted ? '🔇 SOUND: OFF' : '🔊 SOUND: ON';
});

function tryDash() {
  if (S.dashCooldown > 0 || !S.running) return;
  S.dashActive = PLAYER.dashDuration;
  S.dashCooldown = PLAYER.dashCooldown;
  S.invulnTimer = Math.max(S.invulnTimer, PLAYER.dashDuration);
  shake(0.1, 0.1);
}

// ---- GAME LIFECYCLE ----
function startGame() {
  document.getElementById('title').classList.add('hidden');
  document.getElementById('gameover').classList.add('hidden');
  document.querySelectorAll('.hidden-ui').forEach(el => el.style.display = '');
  resetGame();
  resetPlayer();
  resetWaves();
  clearBullets();
  clearPickups();
  clearParticles();
  clearAllBlocks();
  applyTheme(0, 1); // chapter 0, wave 1
  Audio.init();
  Audio.resume();
  Audio.startMusic();
  UI.updateHUD();
  UI.updateWeaponSlots();
  startWave(1);
}

function gameOver() {
  S.running = false;
  S.phase = 'gameover';
  Audio.stopMusic();
  // Save run stats
  Save.onGameOver({
    score: S.score, wave: S.wave, chapter: S.chapter, rescuedIds: S.rescuedIds,
  });
  document.getElementById('final-score').textContent = S.score.toLocaleString();
  document.getElementById('final-wave').textContent = S.wave;
  document.getElementById('final-kills').textContent = S.kills;
  const fr = document.getElementById('final-rescues');
  if (fr) fr.textContent = S.rescuedCount;
  // Update title stats for next try
  UI.populateTitleStats(Save.load());
  document.getElementById('gameover').classList.remove('hidden');
}

document.getElementById('start-btn').addEventListener('click', () => { Audio.init(); startGame(); });
document.getElementById('restart-btn').addEventListener('click', startGame);

// ---- UPGRADES ON LEVEL UP ----
const UPGRADES = [
  { name: 'DAMAGE ++',    apply: () => { S.damageBoost = (S.damageBoost || 1) * 1.2; } },
  { name: 'SPEED ++',     apply: () => { S.playerSpeed = Math.min(13, S.playerSpeed * 1.1); } },
  { name: 'MAX HP ++',    apply: () => { S.hpMax += 25; S.hp = Math.min(S.hpMax, S.hp + 25); } },
  { name: 'FIRE RATE ++', apply: () => { S.fireRateBoost = (S.fireRateBoost || 1) * 0.85; } },
];

function levelUp() {
  S.level++;
  S.xp = 0;
  S.xpNext = Math.floor(S.xpNext * 1.55 + 4);
  const up = UPGRADES[Math.floor(Math.random() * UPGRADES.length)];
  up.apply();
  UI.flashLevelUp();
  UI.toast(up.name, '#00ff66');
  Audio.levelup();
  shake(0.3, 0.3);
}

// ---- MAIN LOOP ----
const clock = new THREE.Clock();
const _tmpV = new THREE.Vector3();
const camAnchor = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (S.running && !S.paused) {
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateEnemyProjectiles(dt);
    updatePickups(dt);
    updateBlocks(dt);
    updateWaves(dt);
    updateParticles(dt);
    updateTimers(dt);
    S.timeElapsed += dt;
    if (S.bossRef) UI.updateBossBar(S.bossRef.hp / S.bossRef.hpMax);
    updateCamera(dt);
    UI.updateHUD();
  }

  renderer.render(scene, camera);
}

function updateTimers(dt) {
  if (S.invulnTimer > 0) S.invulnTimer -= dt;
  if (S.dashCooldown > 0) S.dashCooldown -= dt;
  if (S.dashActive > 0) S.dashActive -= dt;
  if (S.fireCooldown > 0) S.fireCooldown -= dt;
  if (S.muzzleTimer > 0) {
    S.muzzleTimer -= dt;
    if (player.muzzle) player.muzzle.intensity = S.muzzleTimer > 0 ? 4 : 0;
  } else if (player.muzzle) {
    player.muzzle.intensity = 0;
  }
  if (S.recoilTimer > 0) {
    S.recoilTimer -= dt;
    if (player.gun) player.gun.position.z = 0.1;
  } else if (player.gun) {
    player.gun.position.z = 0.2;
  }
  if (S.shakeTime > 0) {
    S.shakeTime -= dt;
    if (S.shakeTime <= 0) S.shakeAmt = 0;
  }
}

function updatePlayer(dt) {
  if (!player.ready) return;

  let mx = 0, mz = 0;
  if (keys['w'] || keys['arrowup'])    mz -= 1;
  if (keys['s'] || keys['arrowdown'])  mz += 1;
  if (keys['a'] || keys['arrowleft'])  mx -= 1;
  if (keys['d'] || keys['arrowright']) mx += 1;
  if (joyState.active) { mx += joyState.dx; mz += joyState.dy; }
  const len = Math.sqrt(mx*mx + mz*mz);
  if (len > 0) { mx /= len; mz /= len; }

  const speed = S.playerSpeed * (S.dashActive > 0 ? PLAYER.dashSpeed : 1);
  player.vel.set(mx * speed, 0, mz * speed);
  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  player.pos.x = Math.max(-ARENA + 1.5, Math.min(ARENA - 1.5, player.pos.x));
  player.pos.z = Math.max(-ARENA + 1.5, Math.min(ARENA - 1.5, player.pos.z));
  // Resolve block collisions for player
  resolveCollision(player.pos, 0.8);
  player.obj.position.copy(player.pos);

  // Aim
  let targetX = mouse.worldX, targetZ = mouse.worldZ;
  if (joyState.active || ('ontouchstart' in window && !mouse.down)) {
    let best = null, bestD = Infinity;
    for (const e of enemies) {
      const dx = e.pos.x - player.pos.x;
      const dz = e.pos.z - player.pos.z;
      const d = dx*dx + dz*dz;
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) { targetX = best.pos.x; targetZ = best.pos.z; }
  }
  const dx = targetX - player.pos.x;
  const dz = targetZ - player.pos.z;
  player.facing = Math.atan2(dx, dz);
  player.obj.rotation.y = player.facing;

  animatePlayer(dt, len > 0.05, S.timeElapsed);

  // Fire / mine
  if (mouse.down || ('ontouchstart' in window && mouse.down)) {
    if (S.fireCooldown <= 0) {
      if (S.currentWeapon === 'pickaxe') {
        tryMine();
      } else {
        fireWeapon();
      }
    }
  }

  Scene.rimLight.position.set(player.pos.x, 3.5, player.pos.z + 2);
}

function fireWeapon() {
  const w = getWeapon();
  const rate = w.fireRate * (S.fireRateBoost || 1);
  const dmgBoost = S.damageBoost || 1;

  const origin = new THREE.Vector3(player.pos.x, 1.3, player.pos.z);
  const boostedWeapon = { ...w, damage: w.damage * dmgBoost };
  spawnBullet(origin, player.facing, boostedWeapon);

  S.fireCooldown = rate;
  S.muzzleTimer = 0.05;
  S.recoilTimer = 0.06;

  const shakeAmt = w.name === 'SHOTGUN' ? 0.18 : w.name === 'SNIPER' ? 0.25 : 0.08;
  shake(shakeAmt, 0.1);
  Audio.shot(S.currentWeapon);
}

function tryMine() {
  const w = WEAPONS.pickaxe;
  // Pickaxe reaches forward from player
  const ax = player.pos.x + Math.sin(player.facing) * 0.8;
  const az = player.pos.z + Math.cos(player.facing) * 0.8;
  const target = findNearestBlock(ax, az, w.reach);
  S.fireCooldown = w.fireRate;
  S.recoilTimer = 0.08;
  shake(0.1, 0.08);
  Audio.hit();
  if (target) {
    damageBlock(target, w.damage * (S.damageBoost || 1));
  }
}

function updateCamera(dt) {
  camAnchor.set(player.pos.x + CAMERA_OFFSET.x, CAMERA_OFFSET.y, player.pos.z + CAMERA_OFFSET.z);
  camera.position.lerp(camAnchor, Math.min(1, dt * 5));
  if (S.shakeAmt > 0) {
    camera.position.x += (Math.random() - 0.5) * S.shakeAmt;
    camera.position.y += (Math.random() - 0.5) * S.shakeAmt * 0.5;
    camera.position.z += (Math.random() - 0.5) * S.shakeAmt;
  }
  camera.lookAt(player.pos.x, 0.8, player.pos.z);
}

function updateEnemies(dt) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const dx = player.pos.x - e.pos.x;
    const dz = player.pos.z - e.pos.z;
    const dist = Math.sqrt(dx*dx + dz*dz);

    if (e.phases) {
      e.phaseTimer -= dt;
      if (e.phaseTimer <= 0) {
        e.phaseTimer = 2 + Math.random() * 2;
        e.body.visible = !e.body.visible;
      }
    }

    let shouldMove = true;
    if (e.ranged && dist < e.range) shouldMove = false;
    if (shouldMove && dist > 0.01) {
      e.pos.x += (dx / dist) * e.speed * dt;
      e.pos.z += (dz / dist) * e.speed * dt;
    }
    // Block collision — enemies path around blocks automatically via push-out
    if (!e.isBoss) resolveCollision(e.pos, 0.5);
    e.obj.rotation.y = Math.atan2(dx, dz);

    if (shouldMove) {
      e.walkPhase += dt * (e.isBoss ? 4 : 6);
      const sw = Math.sin(e.walkPhase) * (e.isBoss ? 0.3 : 0.5);
      e.legL.rotation.x = sw;
      e.legR.rotation.x = -sw;
      e.armL.rotation.x = -sw * 0.6;
      e.armR.rotation.x = sw * 0.6;
    }

    if (e.hitFlash > 0) {
      e.hitFlash -= dt;
      e.bodyMat.emissive.setHex(0xffffff);
      e.bodyMat.emissiveIntensity = e.hitFlash * 3;
    } else {
      e.bodyMat.emissiveIntensity = e.isBoss ? 0.15 : 0;
    }

    if (e.ranged) {
      e.rangedCooldown -= dt;
      if (e.rangedCooldown <= 0 && dist < e.range) {
        // Don't shoot through blocks
        if (!segmentBlocked(e.pos.x, e.pos.z, player.pos.x, player.pos.z)) {
          e.rangedCooldown = e.isBoss ? 1.2 : 2.5;
          spawnEnemyProjectile(e.pos, player.pos, e.isBoss ? 20 : 15, e.damage, e.isBoss ? 0xff2e4d : 0x00ff66);
        } else {
          e.rangedCooldown = 0.5; // check again soon
        }
      }
    }

    if (e.touchCooldown > 0) e.touchCooldown -= dt;

    if (!e.isBoss) {
      for (let j = i - 1; j >= 0 && j > i - 6; j--) {
        const o = enemies[j];
        if (o.isBoss) continue;
        const ex = o.pos.x - e.pos.x;
        const ez = o.pos.z - e.pos.z;
        const ed = ex*ex + ez*ez;
        if (ed < 1.4 && ed > 0.001) {
          const push = 0.04;
          e.pos.x -= ex * push; e.pos.z -= ez * push;
          o.pos.x += ex * push; o.pos.z += ez * push;
        }
      }
    }

    const touchRange = e.isBoss ? 2.5 : 1.3;
    if (dist < touchRange && e.touchCooldown <= 0) {
      if (S.invulnTimer <= 0) {
        if (S.shields > 0) {
          S.shields -= 1;
          UI.toast('SHIELD ABSORBED', '#e63aff');
        } else {
          S.hp -= e.damage;
          UI.damageFlash();
          Audio.damage();
          shake(0.25, 0.2);
        }
        S.invulnTimer = 0.6;
        e.touchCooldown = 0.8;
        if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); return; }
      }
    }
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const prevX = b.position.x, prevZ = b.position.z;
    b.position.addScaledVector(b.userData.vel, dt);
    b.userData.life -= dt;
    b.lookAt(b.position.x + b.userData.vel.x, b.position.y, b.position.z + b.userData.vel.z);

    // Block collision: check if the bullet's path this frame crossed a block.
    if (segmentBlocked(prevX, prevZ, b.position.x, b.position.z)) {
      hitBurst(b.position, 0xffffff, 3);
      scene.remove(b);
      bullets.splice(i, 1);
      continue;
    }

    if (b.userData.life <= 0 || Math.abs(b.position.x) > ARENA || Math.abs(b.position.z) > ARENA) {
      scene.remove(b);
      bullets.splice(i, 1);
      continue;
    }
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const hitRange = e.isBoss ? 2.2 : 0.95;
      const dx = e.pos.x - b.position.x;
      const dz = e.pos.z - b.position.z;
      if (dx*dx + dz*dz < hitRange) {
        e.hp -= b.userData.damage;
        e.hitFlash = 0.15;
        hitBurst(b.position, 0xffffff, 4);
        Audio.hit();
        scene.remove(b);
        bullets.splice(i, 1);
        if (e.hp <= 0) killEnemy(j);
        break;
      }
    }
  }
}

function killEnemy(idx) {
  const e = enemies[idx];
  _tmpV.copy(e.pos); _tmpV.y = 1;
  hitBurst(_tmpV, 0xff3cac, e.isBoss ? 20 : 8);
  Audio.kill();
  shake(e.isBoss ? 0.5 : 0.15, e.isBoss ? 0.4 : 0.15);
  scene.remove(e.obj);
  enemies.splice(idx, 1);
  S.kills++;
  S.score += e.scoreVal;

  for (let i = 0; i < e.xpVal; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * 0.6;
    makePickup('xp', e.pos.x + Math.cos(a) * d, e.pos.z + Math.sin(a) * d);
  }
  const roll = Math.random();
  if (roll < 0.04) makePickup('health', e.pos.x, e.pos.z);
  else if (roll < 0.07) makePickup('speed', e.pos.x, e.pos.z);
  else if (roll < 0.09) makePickup('shield', e.pos.x, e.pos.z);

  onEnemyKilled(e);
}

function updateEnemyProjectiles(dt) {
  for (let i = enemyProjectiles.length - 1; i >= 0; i--) {
    const p = enemyProjectiles[i];
    const prevX = p.position.x, prevZ = p.position.z;
    p.position.addScaledVector(p.userData.vel, dt);
    p.userData.life -= dt;
    p.rotation.x += dt * 5;
    p.rotation.y += dt * 3;

    // Blocks stop enemy projectiles too
    if (segmentBlocked(prevX, prevZ, p.position.x, p.position.z)) {
      hitBurst(p.position, 0x00ff66, 4);
      scene.remove(p);
      enemyProjectiles.splice(i, 1);
      continue;
    }

    if (p.userData.life <= 0 || Math.abs(p.position.x) > ARENA || Math.abs(p.position.z) > ARENA) {
      scene.remove(p);
      enemyProjectiles.splice(i, 1);
      continue;
    }
    const dx = player.pos.x - p.position.x;
    const dz = player.pos.z - p.position.z;
    if (dx*dx + dz*dz < 1.0) {
      if (S.invulnTimer <= 0) {
        if (S.shields > 0) {
          S.shields -= 1;
          UI.toast('SHIELD ABSORBED', '#e63aff');
        } else {
          S.hp -= p.userData.damage;
          UI.damageFlash();
          Audio.damage();
          shake(0.2, 0.15);
        }
        S.invulnTimer = 0.4;
        if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); }
      }
      scene.remove(p);
      enemyProjectiles.splice(i, 1);
    }
  }
}

function updatePickups(dt) {
  const MAG = 3.5, PICKUP_RANGE = 1.2;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.mesh.rotation.y += dt * 2;
    p.mesh.rotation.x += dt * 0.5;
    p.mesh.position.y = 0.6 + Math.sin(S.timeElapsed * 3 + i) * 0.12;
    p.life -= dt;

    const dx = player.pos.x - p.obj.position.x;
    const dz = player.pos.z - p.obj.position.z;
    const d2 = dx*dx + dz*dz;
    if (d2 < MAG * MAG) {
      const d = Math.sqrt(d2);
      const pull = Math.max(0, (MAG - d) / MAG) * 18 * dt;
      p.obj.position.x += (dx / d) * pull;
      p.obj.position.z += (dz / d) * pull;
    }
    if (d2 < PICKUP_RANGE * PICKUP_RANGE) {
      collectPickup(p);
      scene.remove(p.obj);
      pickups.splice(i, 1);
      continue;
    }
    if (p.life <= 0) {
      scene.remove(p.obj);
      pickups.splice(i, 1);
    }
  }
}

function collectPickup(p) {
  Audio.pickup();
  switch (p.type) {
    case 'xp':
      S.xp += p.value;
      S.score += 50;
      S.xpSinceWave += p.value;
      if (S.xp >= S.xpNext) levelUp();
      break;
    case 'health':
      S.hp = Math.min(S.hpMax, S.hp + 35);
      UI.toast('+35 HP', '#00ff66');
      break;
    case 'speed':
      S.playerSpeed = Math.min(14, S.playerSpeed + 0.8);
      UI.toast('SPEED BOOST', '#4ff7ff');
      break;
    case 'shield':
      S.shields += 1;
      UI.toast('+SHIELD', '#e63aff');
      break;
  }
}

animate();
console.log('%c>>> MEEBIT SURVIVAL PROTOCOL v4 LOADED <<<', 'color:#00ff66; font-size:14px; font-weight:bold;');
