import * as THREE from 'three';
import { scene, camera, renderer, CAMERA_OFFSET, applyTheme, Scene } from './scene.js';
import { S, keys, mouse, joyState, resetGame, getWeapon, shake } from './state.js';
import { PLAYER, WEAPONS, CHAPTERS, ARENA } from './config.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { loadPlayer, animatePlayer, player, recolorGun, resetPlayer, swapAvatarGLB } from './player.js';
import { enemies, enemyProjectiles, spawnEnemyProjectile } from './enemies.js';
import { bullets, spawnBullet, clearBullets, pickups, makePickup, clearPickups, hitBurst, updateParticles, clearParticles } from './effects.js';
import { startWave, updateWaves, onEnemyKilled, resetWaves, isInCaptureZone } from './waves.js';
import { blocks, updateBlocks, segmentBlocked, resolveCollision, findNearestBlock, damageBlock, clearAllBlocks } from './blocks.js';
import { Save } from './save.js';
import { Wallet } from './wallet.js';
import {
  redirectToAuth, handleAuthCallback, getStoredAuth, clearStoredAuth,
  fetchOwnedMeebits, pickMeebitIdFromList,
} from './meebitsApi.js';

// ---- ATTACH RENDERER ----
document.getElementById('game').appendChild(renderer.domElement);

// ---- MATRIX RAIN ----
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

// ---- BOOT: Handle Meebits API auth callback if present in URL ----
const authCallback = handleAuthCallback();
if (authCallback) {
  console.log('[boot] Meebits auth callback received', authCallback.account);
  // We'll fetch the list once the UI is ready
}

// ---- LOAD SAVED PROFILE ----
const savedData = Save.load();
S.username = savedData.username || 'GUEST';
S.playerMeebitId = savedData.playerMeebitId || (16801); // placeholder until user picks
S.playerMeebitSource = savedData.playerMeebitSource || 'random';
S.walletAddress = savedData.walletAddress || null;
UI.populateTitleStats(savedData);

// ---- LOAD PLAYER AVATAR ----
const loadBar = document.getElementById('loadbar');
const loadLog = document.getElementById('loadlog');
function setLoad(pct, msg) {
  loadBar.style.width = pct + '%';
  if (msg) loadLog.textContent = msg;
}

setLoad(5, 'BOOTING RENDERER...');

// If we have a cached GLB url we could load from it, but those are signed
// per-session. We always start with the voxel fallback; user can LINK MEEBITS
// on the title screen to upgrade to the real rigged model.
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
    // If auth callback came back with an account, try to fetch Meebits and swap avatar
    if (authCallback) {
      tryUpgradeAvatarFromAuth(authCallback);
    }
  },
  (err) => {
    console.error(err);
    loadLog.textContent = 'ERROR: ' + (err.message || 'load failed');
  }
);

// ---- MEEBITS AUTH / AVATAR UPGRADE ----
async function tryUpgradeAvatarFromAuth(auth) {
  try {
    UI.toast('FETCHING YOUR MEEBITS...', '#ffd93d', 1800);
    const meebits = await fetchOwnedMeebits(auth.account, auth.token);
    if (!meebits || meebits.length === 0) {
      UI.toast('NO MEEBITS FOUND IN THAT WALLET', '#ff3cac', 2500);
      return;
    }
    const { id, signedObj } = pickMeebitIdFromList(meebits);
    if (!signedObj || !signedObj.ownerDownloadGLB) {
      UI.toast('GLB URL MISSING · USING VOXEL', '#ff3cac', 2500);
      return;
    }
    S.playerMeebitId = id;
    S.playerMeebitSource = 'owned';
    S.walletAddress = auth.account;
    Save.setSelectedMeebitId(id, 'owned');
    Save.setWalletAddress(auth.account);
    UI.toast('LOADING MEEBIT #' + id + '...', '#00ff66', 2000);
    swapAvatarGLB(signedObj.ownerDownloadGLB,
      () => { UI.toast('PLAYING AS MEEBIT #' + id + ' ✓', '#00ff66', 2500); UI.updateHUD(); },
      (err) => { console.warn('GLB swap failed', err); UI.toast('GLB LOAD FAILED · USING VOXEL', '#ff3cac', 2500); }
    );
    const linkBtn = document.getElementById('link-meebits-btn');
    if (linkBtn) {
      linkBtn.textContent = '✓ MEEBIT #' + id + ' LINKED';
      linkBtn.classList.add('connected');
    }
  } catch (err) {
    console.error('[auth] upgrade failed', err);
    UI.toast('MEEBIT LINK FAILED · ' + (err.message || 'unknown'), '#ff3cac', 2500);
  }
}

// ---- INCOMING CALL ----
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
      ring.pause(); ring.currentTime = 0;
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

// ---- USERNAME INPUT ----
const usernameInput = document.getElementById('username-input');
if (usernameInput) {
  usernameInput.value = S.username;
  usernameInput.addEventListener('input', () => {
    const name = usernameInput.value.toUpperCase().slice(0, 16).replace(/[^A-Z0-9_]/g, '');
    usernameInput.value = name;
  });
  usernameInput.addEventListener('blur', () => {
    const name = (usernameInput.value || 'GUEST').trim() || 'GUEST';
    const rec = Save.setUsername(name);
    S.username = rec.username;
    UI.populateTitleStats(rec);
    UI.setUsernameDisplay(rec.username);
  });
}

// ---- WALLET BUTTON (simple balance read — no GLB, just ID) ----
const connectBtn = document.getElementById('connect-wallet-btn');
if (connectBtn) {
  connectBtn.addEventListener('click', async () => {
    connectBtn.textContent = 'CONNECTING...';
    connectBtn.disabled = true;
    try {
      const address = await Wallet.connect();
      connectBtn.textContent = 'CHECKING MEEBITS + DELEGATIONS...';
      const accessible = await Wallet.getAccessibleMeebits(address);
      if (accessible.length === 0) {
        // Assign random Meebit — user can still play, just with a random ID
        const randomId = Math.floor(Math.random() * 20000);
        S.playerMeebitId = randomId;
        S.playerMeebitSource = 'random';
        S.walletAddress = address;
        Save.setSelectedMeebitId(randomId, 'random');
        Save.setWalletAddress(address);
        connectBtn.textContent = '✓ ' + address.slice(0, 6) + '... (random Meebit)';
        connectBtn.classList.add('connected');
        UI.toast('NO MEEBITS · ASSIGNED #' + randomId, '#ff3cac', 3000);
      } else {
        const first = accessible[0];
        S.playerMeebitId = first.id;
        S.playerMeebitSource = first.source; // 'owned' | 'delegated'
        S.walletAddress = address;
        Save.setSelectedMeebitId(first.id, first.source);
        Save.setWalletAddress(address);
        const ownedCount = accessible.filter(m => m.source === 'owned').length;
        const delegatedCount = accessible.filter(m => m.source === 'delegated').length;
        const parts = [];
        if (ownedCount) parts.push(ownedCount + ' OWNED');
        if (delegatedCount) parts.push(delegatedCount + ' DELEGATED');
        connectBtn.textContent = '✓ #' + first.id + ' (' + parts.join(' + ') + ')';
        connectBtn.classList.add('connected');
        UI.toast('CONNECTED · Meebit #' + first.id + (first.source === 'delegated' ? ' (delegated)' : ''), '#00ff66', 3000);
      }
      UI.updateHUD();
    } catch (err) {
      console.warn('[wallet]', err);
      connectBtn.textContent = '🦊 CONNECT WALLET';
      connectBtn.disabled = false;
      UI.toast('Wallet connection failed: ' + (err.message || 'unknown'), '#ff3cac', 2800);
    }
  });
}

// ---- LINK MEEBITS BUTTON (Larva Labs owner-signed GLB flow) ----
const linkBtn = document.getElementById('link-meebits-btn');
if (linkBtn) {
  // If we already have a stored auth, show that state
  const stored = getStoredAuth();
  if (stored) {
    linkBtn.textContent = '✓ LINKED';
    linkBtn.classList.add('connected');
  }
  linkBtn.addEventListener('click', () => {
    // Optional: let user clear existing link
    if (linkBtn.classList.contains('connected')) {
      if (!confirm('Unlink Meebits? You will need to sign again to re-link.')) return;
      clearStoredAuth();
      linkBtn.textContent = '🔗 LINK MEEBITS (SIGN)';
      linkBtn.classList.remove('connected');
      return;
    }
    const confirmMsg =
      'This will redirect you to meebits.larvalabs.com to sign a message proving you own a Meebit. ' +
      'After signing, you will be redirected back to the game and your real Meebit 3D model will load. ' +
      'Continue?';
    if (!confirm(confirmMsg)) return;
    redirectToAuth(window.location.href);
  });
}

// ---- INPUT ----
window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.code === 'Space') { e.preventDefault(); tryDash(); }
  if (e.key === 'Escape' && S.running) S.paused = !S.paused;

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
  moveJoy(e); e.preventDefault();
}
function moveJoy(e) {
  if (!joyState.active) return;
  const t = e.touches[0];
  let dx = t.clientX - joyState.cx;
  let dy = t.clientY - joyState.cy;
  const m = Math.sqrt(dx*dx + dy*dy);
  const max = 50;
  if (m > max) { dx = dx / m * max; dy = dy / m * max; }
  joyState.dx = dx / max; joyState.dy = dy / max;
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
  // Require a username
  if (!S.username || S.username === 'GUEST') {
    // Accept GUEST but nudge the player
    if (usernameInput && !usernameInput.value.trim()) {
      usernameInput.focus();
      UI.toast('ENTER A USERNAME', '#ff3cac', 1800);
      return;
    }
  }
  document.getElementById('title').classList.add('hidden');
  document.getElementById('gameover').classList.add('hidden');
  document.querySelectorAll('.hidden-ui').forEach(el => el.style.display = '');
  resetGame();
  // Re-apply identity from save after reset
  const rec = Save.load();
  S.username = rec.username;
  S.playerMeebitId = rec.playerMeebitId || S.playerMeebitId;
  S.playerMeebitSource = rec.playerMeebitSource || S.playerMeebitSource;
  S.walletAddress = rec.walletAddress;
  resetPlayer();
  resetWaves();
  clearBullets();
  clearPickups();
  clearParticles();
  clearAllBlocks();
  applyTheme(0, 1);
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
  Save.onGameOver({
    score: S.score, wave: S.wave, chapter: S.chapter, rescuedIds: S.rescuedIds,
  });
  document.getElementById('final-score').textContent = S.score.toLocaleString();
  document.getElementById('final-wave').textContent = S.wave;
  document.getElementById('final-kills').textContent = S.kills;
  const fr = document.getElementById('final-rescues');
  if (fr) fr.textContent = S.rescuedCount;
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
    // Off-screen rescue arrow + block HP overlays
    UI.updateRescueArrow(S.rescueMeebit, camera);
    UI.updateBlockHPPips(blocks, camera);
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
  resolveCollision(player.pos, 0.8);
  player.obj.position.copy(player.pos);

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

  if (mouse.down || ('ontouchstart' in window && mouse.down)) {
    if (S.fireCooldown <= 0) {
      if (S.currentWeapon === 'pickaxe') tryMine();
      else fireWeapon();
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
  const ax = player.pos.x + Math.sin(player.facing) * 0.8;
  const az = player.pos.z + Math.cos(player.facing) * 0.8;
  const target = findNearestBlock(ax, az, w.reach);
  S.fireCooldown = w.fireRate;
  S.recoilTimer = 0.08;
  shake(0.1, 0.08);
  Audio.shot('pickaxe');
  if (target) damageBlock(target, w.damage * (S.damageBoost || 1));
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

    // Ghost phase (fade in/out)
    if (e.phases) {
      e.phaseTimer -= dt;
      if (e.phaseTimer <= 0) {
        e.phaseTimer = 2 + Math.random() * 2;
        if (e.body) e.body.visible = !e.body.visible;
      }
    }

    // Ghosts float instead of walking
    if (e.isFloater) {
      e.floatPhase = (e.floatPhase || 0) + dt * 2.5;
      e.obj.position.y = Math.sin(e.floatPhase) * 0.25;
      // Wavy tail
      if (e.ghostTail) {
        for (let k = 0; k < e.ghostTail.length; k++) {
          e.ghostTail[k].position.x = Math.sin(e.floatPhase + k * 0.7) * 0.15;
        }
      }
    }

    // Spider leg skitter
    if (e.isSpider && e.spiderLegs) {
      e.walkPhase = (e.walkPhase || 0) + dt * 18;
      for (let k = 0; k < e.spiderLegs.length; k++) {
        const leg = e.spiderLegs[k];
        leg.rotation.x = Math.sin(e.walkPhase + k * 0.8) * 0.5;
      }
    }

    // Target rescue cage if a rescue is active and cage is closer than player
    let moveTargetX = player.pos.x, moveTargetZ = player.pos.z;
    if (S.rescueMeebit && !S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      const cx = S.rescueMeebit.pos.x, cz = S.rescueMeebit.pos.z;
      const cdx = cx - e.pos.x, cdz = cz - e.pos.z;
      const cd2 = cdx*cdx + cdz*cdz;
      if (cd2 < dist * dist * 0.9) { // closer to cage — attack it
        moveTargetX = cx;
        moveTargetZ = cz;
      }
    }
    const mdx = moveTargetX - e.pos.x;
    const mdz = moveTargetZ - e.pos.z;
    const mdist = Math.sqrt(mdx * mdx + mdz * mdz) || 0.01;

    let shouldMove = true;
    if (e.ranged && dist < e.range) shouldMove = false;
    if (shouldMove) {
      e.pos.x += (mdx / mdist) * e.speed * dt;
      e.pos.z += (mdz / mdist) * e.speed * dt;
    }
    if (!e.isBoss) resolveCollision(e.pos, 0.5);
    e.obj.rotation.y = Math.atan2(mdx, mdz);

    if (shouldMove && !e.isFloater && !e.isSpider) {
      e.walkPhase += dt * (e.isBoss ? 4 : 6);
      const sw = Math.sin(e.walkPhase) * (e.isBoss ? 0.3 : 0.5);
      if (e.legL) e.legL.rotation.x = sw;
      if (e.legR) e.legR.rotation.x = -sw;
      if (e.armL) e.armL.rotation.x = -sw * 0.6;
      if (e.armR) e.armR.rotation.x = sw * 0.6;
    }

    if (e.hitFlash > 0) {
      e.hitFlash -= dt;
      if (e.bodyMat) {
        e.bodyMat.emissive && e.bodyMat.emissive.setHex(0xffffff);
        e.bodyMat.emissiveIntensity = e.hitFlash * 3;
      }
    } else if (e.bodyMat) {
      e.bodyMat.emissiveIntensity = e.isBoss ? 0.15 : (e.bodyMat.userData?.baseEmissive || 0);
    }

    if (e.ranged) {
      e.rangedCooldown -= dt;
      if (e.rangedCooldown <= 0 && dist < e.range) {
        if (!segmentBlocked(e.pos.x, e.pos.z, player.pos.x, player.pos.z)) {
          e.rangedCooldown = e.isBoss ? 1.2 : 2.5;
          spawnEnemyProjectile(e.pos, player.pos, e.isBoss ? 20 : 15, e.damage, e.isBoss ? 0xff2e4d : 0x00ff66);
        } else {
          e.rangedCooldown = 0.5;
        }
      }
    }

    if (e.touchCooldown > 0) e.touchCooldown -= dt;

    // Separation
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

    // Touch damage
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
  const inZone = isInCaptureZone(e.pos);
  hitBurst(_tmpV, 0xff3cac, e.isBoss ? 20 : 8);
  Audio.kill();
  shake(e.isBoss ? 0.5 : 0.15, e.isBoss ? 0.4 : 0.15);

  // Pumpkin explosion — AoE damage to other nearby enemies
  if (e.isExplosive) {
    const epos = e.pos.clone();
    hitBurst(epos, 0xff8800, 24);
    setTimeout(() => hitBurst(epos, 0xffee00, 16), 50);
    shake(0.3, 0.2);
    const AOE = 3.5;
    for (let k = enemies.length - 1; k >= 0; k--) {
      if (k === idx) continue;
      const other = enemies[k];
      const odx = other.pos.x - epos.x;
      const odz = other.pos.z - epos.z;
      if (odx * odx + odz * odz < AOE * AOE) {
        other.hp -= 40;
        other.hitFlash = 0.2;
        if (other.hp <= 0 && k > idx) {
          // Defer kill of earlier indices to avoid array mess
          // Simplest approach: just mark it for death this frame
          const otherPos = other.pos.clone(); otherPos.y = 1;
          hitBurst(otherPos, 0xff3cac, 6);
          scene.remove(other.obj);
          enemies.splice(k, 1);
          S.kills++;
          S.score += other.scoreVal;
        }
      }
    }
  }

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

  onEnemyKilled(e, inZone);
}

function updateEnemyProjectiles(dt) {
  for (let i = enemyProjectiles.length - 1; i >= 0; i--) {
    const p = enemyProjectiles[i];
    const prevX = p.position.x, prevZ = p.position.z;
    p.position.addScaledVector(p.userData.vel, dt);
    p.userData.life -= dt;
    p.rotation.x += dt * 5;
    p.rotation.y += dt * 3;

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
console.log('%c>>> MEEBIT SURVIVAL PROTOCOL v5 LOADED <<<', 'color:#00ff66; font-size:14px; font-weight:bold;');
