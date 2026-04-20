import * as THREE from 'three';
import { scene, camera, renderer, CAMERA_OFFSET, applyTheme, Scene } from './scene.js';
import { S, keys, mouse, joyState, resetGame, getWeapon, shake } from './state.js';
import { PLAYER, WEAPONS, CHAPTERS, ARENA, GOO_CONFIG } from './config.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { loadPlayer, animatePlayer, player, recolorGun, resetPlayer, swapAvatarGLB } from './player.js';
import { enemies, enemyProjectiles, spawnEnemyProjectile, makeEnemy } from './enemies.js';
import {
  bullets, spawnBullet, clearBullets,
  rockets, spawnRocket, clearRockets,
  pickups, makePickup, clearPickups,
  hitBurst, updateParticles, clearParticles,
  initRain, updateRain, setRainTint, disposeRain,
  gooSplats, spawnGooSplat, updateGooSplats, clearGooSplats,
  bossCubes, clearBossCubes,
} from './effects.js';
import { startWave, updateWaves, onEnemyKilled, resetWaves, isInCaptureZone, onBlockMined } from './waves.js';
import { blocks, updateBlocks, segmentBlocked, resolveCollision, findNearestBlock, damageBlock, clearAllBlocks } from './blocks.js';
import { spawners, damageSpawner } from './spawners.js';
import { Save } from './save.js';
import { Wallet } from './wallet.js';
import {
  redirectToAuth, handleAuthCallback, getStoredAuth, clearStoredAuth,
  fetchOwnedMeebits, pickMeebitIdFromList,
} from './meebitsApi.js';
import {
  civilians, updateCivilians, clearAllCivilians, damageCivilianAt,
} from './civilians.js';
import * as PauseMenu from './pauseMenu.js';

// ---- ATTACH RENDERER ----
document.getElementById('game').appendChild(renderer.domElement);

// ---- MATRIX RAIN (title screen only) ----
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
buildMatrixBG(document.getElementById('matrix-bg-gameover'));

// ---- BEAM WEAPON VISUAL ----
// Persistent line segment that represents the raygun beam while firing.
const beamMat = new THREE.MeshBasicMaterial({
  color: 0x00ff66, transparent: true, opacity: 0.85,
});
let beamMesh = null;
function ensureBeamMesh() {
  if (beamMesh) return;
  // Thin rectangular prism we scale/position along the beam ray
  const geo = new THREE.BoxGeometry(0.25, 0.25, 1);
  beamMesh = new THREE.Mesh(geo, beamMat);
  beamMesh.visible = false;
  scene.add(beamMesh);
}

// ---- AUTH / SAVE INIT (unchanged from original project) ----
const authCallback = handleAuthCallback();
const saved = Save.load();
S.username = saved.username;
S.playerMeebitId = saved.playerMeebitId;
S.playerMeebitSource = saved.playerMeebitSource;
S.walletAddress = saved.walletAddress;
S.rescuedIds = [...(saved.rescuedIds || [])];

// Tracks the last wave we switched music for, so animate() only triggers
// a track change once per wave transition (not every frame).
let _lastMusicWave = 0;

// ---- PLAYER AVATAR LOADING (unchanged) ----
const loadLog = document.getElementById('load-log');
const loadBar = document.getElementById('load-bar-fill');
function setLoad(pct, msg) {
  if (loadBar) loadBar.style.width = pct + '%';
  if (loadLog && msg) loadLog.textContent = msg;
}
loadPlayer(
  (xhr) => {
    const pct = xhr.total ? (xhr.loaded / xhr.total) * 75 : 40;
    setLoad(Math.max(5, pct), 'LOADING AVATAR... ' + Math.floor(pct) + '%');
  },
  () => {
    setLoad(100, 'READY');
    setTimeout(() => {
      document.getElementById('loading').style.display = 'none';
      if (typeof showIncomingCall === 'function') {
        showIncomingCall();
        // Kick off the phone ring when the incoming-call overlay appears.
        // Audio.init() creates the <audio> element if it wasn't already made.
        Audio.init();
        Audio.startPhoneRing();
      } else {
        document.getElementById('title').classList.remove('hidden');
      }
    }, 300);
    if (authCallback) tryUpgradeAvatarFromAuth(authCallback);
    else {
      const stored = getStoredAuth();
      if (stored) tryUpgradeAvatarFromAuth(stored);
    }
  },
  (err) => {
    console.error(err);
    if (loadLog) loadLog.textContent = 'ERROR: ' + (err.message || 'load failed');
  },
  { tryGuestGlb: true }
);

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
    console.warn('auth upgrade failed', err);
    UI.toast('MEEBITS FETCH FAILED', '#ff3cac', 2500);
  }
}

// ---- LINK BUTTON ----
const linkBtn = document.getElementById('link-meebits-btn');
if (linkBtn) {
  linkBtn.addEventListener('click', () => {
    if (getStoredAuth()) {
      if (!confirm('Unlink your Meebits? You will need to sign again to re-link.')) return;
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

// ---- USERNAME INPUT ----
const usernameInput = document.getElementById('username-input');
if (usernameInput) {
  usernameInput.value = S.username || '';
  usernameInput.addEventListener('change', () => {
    const v = usernameInput.value.trim().toUpperCase().slice(0, 12);
    S.username = v || 'GUEST';
    Save.setUsername(S.username);
  });
}

// ---- INPUT ----
window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.code === 'Space') { e.preventDefault(); tryDash(); }
  if (e.key === 'Escape' && S.running) {
    S.paused = !S.paused;
    if (S.paused) PauseMenu.show();
    else PauseMenu.hide();
  }

  if (['1', '2', '3', '4', '5'].includes(e.key)) {
    const map = { '1': 'pistol', '2': 'shotgun', '3': 'smg', '4': 'raygun', '5': 'rocket' };
    const w = map[e.key];
    if (S.ownedWeapons.has(w)) {
      S.currentWeapon = w;
      S.previousCombatWeapon = w;
      UI.updateWeaponSlots();
      recolorGun(WEAPONS[w].color);
      UI.toast(WEAPONS[w].name, '#' + WEAPONS[w].color.toString(16).padStart(6, '0'));
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
    UI.toast(WEAPONS[S.currentWeapon].name, '#' + WEAPONS[S.currentWeapon].color.toString(16).padStart(6, '0'));
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

// Mobile controls (unchanged)
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
  const m = Math.sqrt(dx * dx + dy * dy);
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
  // Make sure the phone ring isn't still playing if we got here via the
  // incoming-call accept path (or any other unusual entry).
  Audio.stopPhoneRing && Audio.stopPhoneRing();

  if (!S.username || S.username === 'GUEST') {
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
  const rec = Save.load();
  S.username = rec.username;
  S.playerMeebitId = rec.playerMeebitId || S.playerMeebitId;
  S.playerMeebitSource = rec.playerMeebitSource || S.playerMeebitSource;
  S.walletAddress = rec.walletAddress;
  // Migrate old saves that may still reference the sniper
  if (S.ownedWeapons.has('sniper')) {
    S.ownedWeapons.delete('sniper');
    S.ownedWeapons.add('raygun');
    if (S.currentWeapon === 'sniper') S.currentWeapon = 'raygun';
    if (S.previousCombatWeapon === 'sniper') S.previousCombatWeapon = 'raygun';
  }
  resetPlayer();
  resetWaves();
  clearBullets();
  clearRockets();
  clearPickups();
  clearParticles();
  clearAllBlocks();
  clearGooSplats();
  // Initialize rain with orange theme tint for chapter 1
  initRain(CHAPTERS[0].full.grid1);
  ensureBeamMesh();
  applyTheme(0, 1);
  // Re-tint rain to match initial theme
  setRainTint(CHAPTERS[0].full.grid1);
  Audio.init();
  Audio.resume();
  Audio.startMusic(1);        // wave 1 → Arena I
  _lastMusicWave = 1;         // sync tracker so animate() doesn't re-trigger
  UI.updateHUD();
  UI.updateWeaponSlots();
  startWave(1);
}

function gameOver() {
  S.running = false;
  S.phase = 'gameover';
  Audio.stopMusic();
  _lastMusicWave = 0;          // reset so next run starts music fresh
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

// ---- PAUSE MENU HANDLERS ----
// Registered once. The pause menu calls onResume when the user clicks
// RESUME, and onQuit when they confirm QUIT RUN — we stop the music and
// return them to the title screen.
PauseMenu.setHandlers({
  onResume: () => { S.paused = false; },
  onQuit: () => {
    S.paused = false;
    S.running = false;
    Audio.stopMusic();
    document.querySelectorAll('.hidden-ui').forEach(el => el.style.display = 'none');
    document.getElementById('gameover').classList.add('hidden');
    document.getElementById('title').classList.remove('hidden');
  },
});

// Re-tint rain whenever the theme changes
const _origApplyTheme = applyTheme;
window.__setRainTintOnThemeChange = (chapterIdx, localWave) => {
  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  setRainTint(chapter.full.grid1);
};

// ---- CIVILIAN CALLBACKS ----
// Tuning: killing a civilian is a meaningful penalty but not run-ending.
// Rescuing one (they reach the edge) is a small reward.
const CIVILIAN_KILL_SCORE_PENALTY = 500;
const CIVILIAN_RESCUE_SCORE_BONUS = 200;

function onCivilianKilled(c, cause) {
  if (cause === 'enemy') {
    // Not the player's fault — smaller hit, just a warning
    UI.toast('MEEBIT #' + c.meebitId + ' LOST', '#ff2e4d', 1500);
    Audio.damage && Audio.damage();
    S.civiliansLost = (S.civiliansLost || 0) + 1;
  } else {
    // Player's fault (bullet, beam, rocket)
    S.score = Math.max(0, S.score - CIVILIAN_KILL_SCORE_PENALTY);
    S.civiliansKilled = (S.civiliansKilled || 0) + 1;
    UI.toast('CIVILIAN DOWN · -' + CIVILIAN_KILL_SCORE_PENALTY + ' SCORE', '#ff2e4d', 2200);
    UI.damageFlash && UI.damageFlash();
    Audio.damage && Audio.damage();
    shake(0.2, 0.2);
  }
}

function onCivilianRescued(c) {
  S.score += CIVILIAN_RESCUE_SCORE_BONUS;
  S.civiliansRescued = (S.civiliansRescued || 0) + 1;
  UI.toast('MEEBIT #' + c.meebitId + ' ESCAPED · +' + CIVILIAN_RESCUE_SCORE_BONUS, '#00ff66', 1500);
}

// ---- UPGRADES ON LEVEL UP ----
const UPGRADES = [
  { name: 'DAMAGE ++', apply: () => { S.damageBoost = (S.damageBoost || 1) * 1.2; } },
  { name: 'SPEED ++', apply: () => { S.playerSpeed = Math.min(13, S.playerSpeed * 1.1); } },
  { name: 'MAX HP ++', apply: () => { S.hpMax += 25; S.hp = Math.min(S.hpMax, S.hp + 25); } },
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
    // Switch arena track when a new wave starts.
    // Waves 1→Arena I, 2→Arena II, 3→Arena III, 4→Arena IV, then cycle.
    if (S.waveActive && S.wave !== _lastMusicWave) {
      _lastMusicWave = S.wave;
      Audio.startMusic(S.wave);
    }
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateRockets(dt);
    updateEnemyProjectiles(dt);
    updatePickups(dt);
    updateBlocks(dt);
    updateBossCubes(dt);
    updateCivilians(dt, enemies, player, onCivilianKilled, onCivilianRescued);
    updateWaves(dt);
    updateParticles(dt);
    updateRain(dt, player.pos);
    updateGooSplats(dt);
    updateTimers(dt);
    updateBeam();
    S.timeElapsed += dt;
    if (S.bossRef) UI.updateBossBar(S.bossRef.hp / S.bossRef.hpMax);
    updateCamera(dt);
    UI.updateHUD();
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
  // Re-apply rain tint when chapter changes (cheap)
  if (S._lastTintedChapter !== S.chapter) {
    S._lastTintedChapter = S.chapter;
    const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
    setRainTint(chapter.full.grid1);
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
  const len = Math.sqrt(mx * mx + mz * mz);
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
      const d = dx * dx + dz * dz;
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

  if (w.isBeam) {
    // RAY GUN — tick damage every fireRate seconds; beam rendered continuously
    // (visual handled in updateBeam); damage applied here in the tick
    applyBeamDamage(w, dmgBoost);
    S.fireCooldown = rate;
    S.muzzleTimer = 0.04;
    Audio.shot('smg'); // reuse smg click for ticks
    return;
  }
  if (w.isHoming) {
    // ROCKET LAUNCHER
    const boosted = { ...w, damage: w.damage * dmgBoost };
    // Try to acquire the nearest enemy in front of the player
    const target = pickHomingTarget();
    spawnRocket(origin, player.facing, boosted, target);
    S.fireCooldown = rate;
    S.muzzleTimer = 0.08;
    S.recoilTimer = 0.12;
    shake(0.22, 0.15);
    Audio.shot('shotgun');
    return;
  }

  const boostedWeapon = { ...w, damage: w.damage * dmgBoost };
  spawnBullet(origin, player.facing, boostedWeapon);
  S.fireCooldown = rate;
  S.muzzleTimer = 0.05;
  S.recoilTimer = 0.06;
  const shakeAmt = w.name === 'SHOTGUN' ? 0.18 : 0.08;
  shake(shakeAmt, 0.1);
  Audio.shot(S.currentWeapon);
}

// ============================================================================
// BEAM WEAPON (Ray Gun)
// ============================================================================
function updateBeam() {
  if (!beamMesh) return;
  const w = WEAPONS[S.currentWeapon];
  const firing = (mouse.down || ('ontouchstart' in window && mouse.down)) && w && w.isBeam && player.ready;
  if (!firing) {
    beamMesh.visible = false;
    return;
  }
  // Beam visual: a scaled box from the player's gun to the beam endpoint (wall or first enemy)
  const origin = new THREE.Vector3(player.pos.x, 1.3, player.pos.z);
  const dirX = Math.sin(player.facing);
  const dirZ = Math.cos(player.facing);
  let length = w.beamRange;
  // Find nearest enemy along the beam (for visual length only — damage is in fire tick)
  for (const e of enemies) {
    // Project enemy onto beam
    const dx = e.pos.x - origin.x;
    const dz = e.pos.z - origin.z;
    const along = dx * dirX + dz * dirZ;
    if (along < 0 || along > length) continue;
    const perp = Math.abs(dx * dirZ - dz * dirX);
    const hitRadius = e.isBoss ? 1.6 : 0.9;
    if (perp < hitRadius + w.beamWidth) {
      length = Math.min(length, along);
    }
  }
  // Also clamp to blocked segment
  const endX = origin.x + dirX * length;
  const endZ = origin.z + dirZ * length;
  if (segmentBlocked(origin.x, origin.z, endX, endZ)) {
    // step through to find block point (cheap)
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * length;
      const tx = origin.x + dirX * t;
      const tz = origin.z + dirZ * t;
      if (segmentBlocked(origin.x, origin.z, tx, tz)) {
        length = Math.max(0.5, t - 0.3);
        break;
      }
    }
  }
  beamMesh.visible = true;
  const midX = origin.x + dirX * (length / 2);
  const midZ = origin.z + dirZ * (length / 2);
  beamMesh.position.set(midX, 1.3, midZ);
  beamMesh.scale.set(1, 1, length);
  beamMesh.lookAt(origin.x + dirX, 1.3, origin.z + dirZ);
  beamMat.color.setHex(w.color);
  // Pulse
  beamMat.opacity = 0.65 + Math.sin(S.timeElapsed * 30) * 0.15;
}

function applyBeamDamage(w, dmgBoost) {
  const origin = new THREE.Vector3(player.pos.x, 1.3, player.pos.z);
  const dirX = Math.sin(player.facing);
  const dirZ = Math.cos(player.facing);
  const dmg = w.damage * dmgBoost;
  // Damage every enemy whose projection on the beam is within range AND perp < width
  // (can penetrate multiple enemies — it's a beam)
  for (let j = enemies.length - 1; j >= 0; j--) {
    const e = enemies[j];
    const dx = e.pos.x - origin.x;
    const dz = e.pos.z - origin.z;
    const along = dx * dirX + dz * dirZ;
    if (along < 0 || along > w.beamRange) continue;
    const perp = Math.abs(dx * dirZ - dz * dirX);
    const hitRadius = e.isBoss ? 1.6 : 0.9;
    if (perp < hitRadius + w.beamWidth) {
      e.hp -= dmg;
      e.hitFlash = 0.15;
      if (Math.random() < 0.4) {
        const hitPos = new THREE.Vector3(
          origin.x + dirX * along, 1.3, origin.z + dirZ * along
        );
        hitBurst(hitPos, w.color, 2);
      }
      if (e.hp <= 0) {
        killEnemy(j);
      }
    }
  }
  // Civilian hit (beam penetrates everything, so a sweep CAN cost you)
  for (let k = civilians.length - 1; k >= 0; k--) {
    const c = civilians[k];
    if (c.dead) continue;
    const dx = c.pos.x - origin.x;
    const dz = c.pos.z - origin.z;
    const along = dx * dirX + dz * dirZ;
    if (along < 0 || along > w.beamRange) continue;
    const perp = Math.abs(dx * dirZ - dz * dirX);
    if (perp < 0.7 + w.beamWidth) {
      // Beam touched a civilian — instant kill + penalty
      damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
    }
  }
  // Also damage portals along the beam (for spawner waves)
  if (S.spawnerWaveActive) {
    for (const s of spawners) {
      if (s.destroyed) continue;
      const dx = s.pos.x - origin.x;
      const dz = s.pos.z - origin.z;
      const along = dx * dirX + dz * dirZ;
      if (along < 0 || along > w.beamRange) continue;
      const perp = Math.abs(dx * dirZ - dz * dirX);
      if (perp < 2.0) {
        damageSpawner(s, dmg * 0.8);
      }
    }
  }
}

function pickHomingTarget() {
  // Nearest enemy in front of the player (within 90° cone)
  const dirX = Math.sin(player.facing);
  const dirZ = Math.cos(player.facing);
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    const dx = e.pos.x - player.pos.x;
    const dz = e.pos.z - player.pos.z;
    const d = dx * dx + dz * dz;
    if (d > 900) continue;
    const along = dx * dirX + dz * dirZ;
    if (along < 0) continue;
    // 90° cone: perp <= along
    const perp = Math.abs(dx * dirZ - dz * dirX);
    if (perp > along) continue;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// ============================================================================
// ROCKETS — homing + explosion
// ============================================================================
function updateRockets(dt) {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    const ud = r.userData;
    ud.life -= dt;

    // Re-acquire target if current one is gone
    if (!ud.target || enemies.indexOf(ud.target) === -1) {
      // Find nearest
      let best = null, bestD = Infinity;
      for (const e of enemies) {
        const dx = e.pos.x - r.position.x;
        const dz = e.pos.z - r.position.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = e; }
      }
      ud.target = best;
    }

    // Steer toward target
    if (ud.target) {
      const desiredX = ud.target.pos.x - r.position.x;
      const desiredZ = ud.target.pos.z - r.position.z;
      const dLen = Math.sqrt(desiredX * desiredX + desiredZ * desiredZ) || 1;
      const desiredVX = (desiredX / dLen) * ud.speed;
      const desiredVZ = (desiredZ / dLen) * ud.speed;
      // Lerp velocity toward desired
      const t = Math.min(1, ud.homingStrength * dt);
      ud.vel.x += (desiredVX - ud.vel.x) * t;
      ud.vel.z += (desiredVZ - ud.vel.z) * t;
      // Normalize to speed
      const vlen = Math.sqrt(ud.vel.x * ud.vel.x + ud.vel.z * ud.vel.z) || 1;
      ud.vel.x = (ud.vel.x / vlen) * ud.speed;
      ud.vel.z = (ud.vel.z / vlen) * ud.speed;
    }

    const prevX = r.position.x, prevZ = r.position.z;
    r.position.x += ud.vel.x * dt;
    r.position.z += ud.vel.z * dt;
    // Face travel direction
    r.lookAt(r.position.x + ud.vel.x, r.position.y, r.position.z + ud.vel.z);

    // Trail puffs
    ud.trailTimer -= dt;
    if (ud.trailTimer <= 0) {
      ud.trailTimer = 0.03;
      hitBurst(new THREE.Vector3(r.position.x, r.position.y, r.position.z), ud.color, 2);
    }

    // Wall/edge/block hit
    if (segmentBlocked(prevX, prevZ, r.position.x, r.position.z) ||
        ud.life <= 0 ||
        Math.abs(r.position.x) > ARENA || Math.abs(r.position.z) > ARENA) {
      explodeRocket(r);
      scene.remove(r);
      rockets.splice(i, 1);
      continue;
    }

    // Civilian direct hit — a homing rocket at a civilian is on you, not on physics
    let hit = false;
    for (let k = civilians.length - 1; k >= 0; k--) {
      const c = civilians[k];
      if (c.dead) continue;
      const dx = c.pos.x - r.position.x;
      const dz = c.pos.z - r.position.z;
      if (dx * dx + dz * dz < 1.4) {
        damageCivilianAt(c.pos.x, c.pos.z, 0.9, 'player', onCivilianKilled);
        explodeRocket(r);
        scene.remove(r);
        rockets.splice(i, 1);
        hit = true;
        break;
      }
    }
    if (hit) continue;

    // Enemy hit
    let hitEnemy = false;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const dx = e.pos.x - r.position.x;
      const dz = e.pos.z - r.position.z;
      const hitRange = e.isBoss ? 2.2 : 1.1;
      if (dx * dx + dz * dz < hitRange) {
        // Direct damage
        e.hp -= ud.damage;
        e.hitFlash = 0.18;
        explodeRocket(r);
        scene.remove(r);
        rockets.splice(i, 1);
        if (e.hp <= 0) killEnemy(j);
        hitEnemy = true;
        break;
      }
    }
    if (hitEnemy) continue;
  }
}

function explodeRocket(r) {
  const ud = r.userData;
  const pos = r.position.clone();
  hitBurst(pos, 0xffffff, 18);
  setTimeout(() => hitBurst(pos, ud.color, 20), 40);
  setTimeout(() => hitBurst(pos, 0xff8800, 14), 100);
  shake(0.3, 0.25);
  Audio.bigBoom && Audio.bigBoom();
  // AoE
  const radius = ud.explosionRadius;
  for (let j = enemies.length - 1; j >= 0; j--) {
    const e = enemies[j];
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius) {
      e.hp -= ud.explosionDamage * (1 - Math.sqrt(d2) / radius);
      e.hitFlash = 0.15;
      if (e.hp <= 0) killEnemy(j);
    }
  }
  // AoE catches civilians too — this is the big "watch your blast radius" moment
  for (let k = civilians.length - 1; k >= 0; k--) {
    const c = civilians[k];
    if (c.dead) continue;
    const dx = c.pos.x - pos.x;
    const dz = c.pos.z - pos.z;
    if (dx * dx + dz * dz < radius * radius) {
      damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
    }
  }
  // AoE can hurt portals too
  if (S.spawnerWaveActive) {
    for (const s of spawners) {
      if (s.destroyed) continue;
      const dx = s.pos.x - pos.x;
      const dz = s.pos.z - pos.z;
      if (dx * dx + dz * dz < radius * radius) {
        damageSpawner(s, ud.explosionDamage * 0.6);
      }
    }
  }
}

// ============================================================================
// MINING
// ============================================================================
function tryMine() {
  const w = WEAPONS.pickaxe;
  const ax = player.pos.x + Math.sin(player.facing) * 0.8;
  const az = player.pos.z + Math.cos(player.facing) * 0.8;
  const target = findNearestBlock(ax, az, w.reach);
  S.fireCooldown = w.fireRate;
  S.recoilTimer = 0.08;
  shake(0.1, 0.08);
  Audio.shot('pickaxe');
  if (target) {
    const destroyed = damageBlock(target, w.damage * (S.damageBoost || 1));
    if (destroyed) onBlockMined();
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

// ============================================================================
// ENEMIES — includes vampire blink, wizard triangle proj, goo spitter etc.
// ============================================================================
function updateEnemies(dt) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const dx = player.pos.x - e.pos.x;
    const dz = player.pos.z - e.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Phasing (ghost/phantom)
    if (e.phases) {
      e.phaseTimer -= dt;
      if (e.phaseTimer <= 0) {
        e.phaseTimer = 2 + Math.random() * 2;
        if (e.body) e.body.visible = !e.body.visible;
      }
    }

    // Vampire blink — teleport closer to the player
    if (e.blinks) {
      e.blinkTimer -= dt;
      if (e.blinkTimer <= 0 && dist > 5) {
        e.blinkTimer = e.blinkInterval + Math.random() * 1.5;
        // Pick a point closer to the player
        const ang = Math.atan2(dx, dz) + (Math.random() - 0.5) * 0.8;
        const targetDist = Math.max(4, dist - e.blinkRange);
        const newX = player.pos.x - Math.sin(ang) * targetDist;
        const newZ = player.pos.z - Math.cos(ang) * targetDist;
        // Fade-out burst at old position
        hitBurst(new THREE.Vector3(e.pos.x, 1.8, e.pos.z), 0xff2e4d, 12);
        // Move
        e.pos.x = Math.max(-46, Math.min(46, newX));
        e.pos.z = Math.max(-46, Math.min(46, newZ));
        // Fade-in burst at new position
        hitBurst(new THREE.Vector3(e.pos.x, 1.8, e.pos.z), 0xff2e4d, 12);
      }
    }

    if (e.isFloater) {
      e.floatPhase = (e.floatPhase || 0) + dt * 2.5;
      e.obj.position.y = Math.sin(e.floatPhase) * 0.25;
      if (e.ghostTail) {
        for (let k = 0; k < e.ghostTail.length; k++) {
          e.ghostTail[k].position.x = Math.sin(e.floatPhase + k * 0.7) * 0.15;
        }
      }
    }

    if (e.isSpider && e.spiderLegs) {
      e.walkPhase = (e.walkPhase || 0) + dt * 18;
      for (let k = 0; k < e.spiderLegs.length; k++) {
        const leg = e.spiderLegs[k];
        leg.rotation.x = Math.sin(e.walkPhase + k * 0.8) * 0.5;
      }
    }

    let moveTargetX = player.pos.x, moveTargetZ = player.pos.z;
    if (S.rescueMeebit && !S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      const cx = S.rescueMeebit.pos.x, cz = S.rescueMeebit.pos.z;
      const cdx = cx - e.pos.x, cdz = cz - e.pos.z;
      const cd2 = cdx * cdx + cdz * cdz;
      if (cd2 < dist * dist * 0.9) {
        moveTargetX = cx; moveTargetZ = cz;
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

    // Ranged attacks
    if (e.ranged) {
      e.rangedCooldown -= dt;
      if (e.rangedCooldown <= 0 && dist < e.range) {
        if (!segmentBlocked(e.pos.x, e.pos.z, player.pos.x, player.pos.z)) {
          e.rangedCooldown = e.isBoss ? 1.2 : 2.2;
          const projColor = e.fireballColor || (e.isBoss ? 0xff2e4d : 0x00ff66);
          let projType = 'box';
          if (e.projType === 'triangle') projType = 'triangle';
          else if (e.type === 'red_devil' || e.type === 'goospitter') projType = 'fireball';
          const speed = e.isBoss ? 20 : 15;
          spawnEnemyProjectile(e.pos, player.pos, speed, e.damage, projColor, projType);
        } else {
          e.rangedCooldown = 0.5;
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
        const ed = ex * ex + ez * ez;
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

// ============================================================================
// BULLETS
// ============================================================================
function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const prevX = b.position.x, prevZ = b.position.z;
    b.position.addScaledVector(b.userData.vel, dt);
    b.userData.life -= dt;
    b.lookAt(b.position.x + b.userData.vel.x, b.position.y, b.position.z + b.userData.vel.z);

    if (segmentBlocked(prevX, prevZ, b.position.x, b.position.z)) {
      hitBurst(b.position, 0xffffff, 3);
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    if (b.userData.life <= 0 || Math.abs(b.position.x) > ARENA || Math.abs(b.position.z) > ARENA) {
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    if (S.spawnerWaveActive) {
      let portalHit = null;
      for (const s of spawners) {
        if (s.destroyed) continue;
        const dx = s.pos.x - b.position.x;
        const dz = s.pos.z - b.position.z;
        if (dx * dx + dz * dz < 3.5) { portalHit = s; break; }
      }
      if (portalHit) {
        damageSpawner(portalHit, b.userData.damage);
        Audio.hit();
        scene.remove(b); bullets.splice(i, 1); continue;
      }
    }
    // Civilian hit — checked BEFORE enemies so stray bullets don't pass through
    if (damageCivilianAt(b.position.x, b.position.z, 0.9, 'player', onCivilianKilled)) {
      hitBurst(b.position, 0xff2e4d, 6);
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    for (let j = enemies.length - 1; j >= 0; j--) {

// ============================================================================
// BOSS CUBES — fall, land, hatch or explode
// ============================================================================
function updateBossCubes(dt) {
  for (let i = bossCubes.length - 1; i >= 0; i--) {
    const c = bossCubes[i];
    if (!c.landed) {
      c.pos.y -= c.fallSpeed * dt;
      c.mesh.rotation.x += dt * 3;
      c.mesh.rotation.y += dt * 2;
      // Pulse ring as the cube approaches
      const h = c.pos.y;
      const s = 1 + Math.sin(S.timeElapsed * 12) * 0.12;
      c.ring.scale.setScalar(s);
      if (h <= 0.9) {
        c.pos.y = 0.9;
        c.landed = true;
        c.mesh.rotation.x = 0;
        shake(0.22, 0.2);
        hitBurst(new THREE.Vector3(c.pos.x, 0.5, c.pos.z), c.tintHex, 14);
      }
    } else {
      c.fuseTimer -= dt;
      // Flash before activating
      const flash = c.fuseTimer < 0.4 ? (Math.sin(S.timeElapsed * 30) > 0 ? 1 : 0.2) : 1;
      c.ringMat.opacity = 0.7 * flash;
      if (c.fuseTimer <= 0) {
        if (c.mode === 'explode') {
          // Damage player if within radius
          const pos = new THREE.Vector3(c.pos.x, 1, c.pos.z);
          const dx = player.pos.x - c.pos.x;
          const dz = player.pos.z - c.pos.z;
          const r = 2.5;
          if (dx * dx + dz * dz < r * r) {
            if (S.invulnTimer <= 0) {
              if (S.shields > 0) { S.shields -= 1; UI.toast('SHIELD ABSORBED', '#e63aff'); }
              else { S.hp -= 25; UI.damageFlash(); Audio.damage(); shake(0.3, 0.25); }
              S.invulnTimer = 0.5;
              if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); return; }
            }
          }
          hitBurst(pos, 0xff2e4d, 24);
          setTimeout(() => hitBurst(pos, 0xffee00, 18), 60);
          shake(0.4, 0.3);
          Audio.bigBoom && Audio.bigBoom();
          // AoE can damage enemies too (friendly fire from the boss's own cubes!)
          for (let j = enemies.length - 1; j >= 0; j--) {
            const e = enemies[j];
            if (e.isBoss) continue;
            const edx = e.pos.x - c.pos.x;
            const edz = e.pos.z - c.pos.z;
            if (edx * edx + edz * edz < r * r) {
              e.hp -= 40; e.hitFlash = 0.2;
              if (e.hp <= 0) killEnemy(j);
            }
          }
        } else {
          // HATCH — spawn an enemy
          hitBurst(new THREE.Vector3(c.pos.x, 1.2, c.pos.z), c.tintHex, 18);
          const chapterIdx = S.chapter % CHAPTERS.length;
          let type = 'zomeeb';
          if (chapterIdx === 0) type = Math.random() < 0.5 ? 'pumpkin' : 'sprinter';
          else if (chapterIdx === 1) type = Math.random() < 0.5 ? 'vampire' : 'red_devil';
          else if (chapterIdx === 2) type = Math.random() < 0.6 ? 'wizard' : 'sprinter';
          else if (chapterIdx === 3) type = Math.random() < 0.6 ? 'goospitter' : 'sprinter';
          else type = 'sprinter';
          makeEnemy(type, c.tintHex, new THREE.Vector3(c.pos.x, 0, c.pos.z));
        }
        scene.remove(c.mesh);
        scene.remove(c.ring);
        bossCubes.splice(i, 1);
      }
    }
  }
}

// ============================================================================
// KILL ENEMY — handles pumpkin AoE, goo splat drop
// ============================================================================
function killEnemy(idx) {
  const e = enemies[idx];
  _tmpV.copy(e.pos); _tmpV.y = 1;
  const inZone = isInCaptureZone(e.pos);
  hitBurst(_tmpV, 0xff3cac, e.isBoss ? 20 : 8);
  Audio.kill();
  shake(e.isBoss ? 0.5 : 0.15, e.isBoss ? 0.4 : 0.15);

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

  // GOO SPLAT — themed color based on current chapter
  const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  const themeColor = chapter.full.grid1;
  if (e.leavesGoo) {
    // Goo spitters always leave a splat
    spawnGooSplat(e.pos.x, e.pos.z, themeColor);
  } else if (!e.isBoss && Math.random() < GOO_CONFIG.spawnChance) {
    // Random chance for other enemies
    spawnGooSplat(e.pos.x, e.pos.z, themeColor);
  } else if (e.isBoss) {
    // Bosses always drop a big splat
    spawnGooSplat(e.pos.x, e.pos.z, themeColor);
    spawnGooSplat(e.pos.x + 1.2, e.pos.z, themeColor);
    spawnGooSplat(e.pos.x - 1.2, e.pos.z, themeColor);
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

// ============================================================================
// ENEMY PROJECTILES — triangle rotation handled here
// ============================================================================
function updateEnemyProjectiles(dt) {
  for (let i = enemyProjectiles.length - 1; i >= 0; i--) {
    const p = enemyProjectiles[i];
    const prevX = p.position.x, prevZ = p.position.z;
    p.position.addScaledVector(p.userData.vel, dt);
    p.userData.life -= dt;
    // Rotation based on type
    if (p.userData.projType === 'triangle') {
      // Spin the triangle around its travel axis
      p.rotation.y += dt * 12;
    } else {
      p.rotation.x += dt * 5;
      p.rotation.y += dt * 3;
    }

    if (segmentBlocked(prevX, prevZ, p.position.x, p.position.z)) {
      hitBurst(p.position, p.userData.color || 0x00ff66, 4);
      scene.remove(p); enemyProjectiles.splice(i, 1); continue;
    }
    if (p.userData.life <= 0 || Math.abs(p.position.x) > ARENA || Math.abs(p.position.z) > ARENA) {
      scene.remove(p); enemyProjectiles.splice(i, 1); continue;
    }
    const dx = player.pos.x - p.position.x;
    const dz = player.pos.z - p.position.z;
    if (dx * dx + dz * dz < 1.0) {
      if (S.invulnTimer <= 0) {
        if (S.shields > 0) { S.shields -= 1; UI.toast('SHIELD ABSORBED', '#e63aff'); }
        else { S.hp -= p.userData.damage; UI.damageFlash(); Audio.damage(); shake(0.2, 0.15); }
        S.invulnTimer = 0.4;
        if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); }
      }
      // Goo spitter projectile leaves a splat on hit
      if (p.userData.color === 0x00ff44 || p.userData.color === 0x00ff66) {
        spawnGooSplat(p.position.x, p.position.z, p.userData.color);
      }
      scene.remove(p); enemyProjectiles.splice(i, 1);
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
    const d2 = dx * dx + dz * dz;
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
console.log('%c>>> MEEBIT SURVIVAL PROTOCOL v6 — RAIN, GOO, RAYGUN, ROCKETS <<<', 'color:#00ff66; font-size:14px; font-weight:bold;');
