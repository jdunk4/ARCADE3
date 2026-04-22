import * as THREE from 'three';
import { scene, camera, renderer, CAMERA_OFFSET, applyTheme, Scene } from './scene.js';
import { S, keys, mouse, joyState, resetGame, getWeapon, shake } from './state.js';
import { PLAYER, WEAPONS, CHAPTERS, ARENA, GOO_CONFIG, MINING_CONFIG, BLOCK_CONFIG } from './config.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { loadPlayer, animatePlayer, player, recolorGun, resetPlayer, swapAvatarGLB } from './player.js';
import { enemies, enemyProjectiles, spawnEnemyProjectile, makeEnemy } from './enemies.js';
import {
  bullets, spawnBullet, clearBullets,
  rockets, spawnRocket, clearRockets,
  pickups, makePickup, clearPickups,
  hitBurst, updateParticles, clearParticles,
  initRain, updateRain, setRainTint, disposeRain, applyRainTo,
  gooSplats, spawnGooSplat, updateGooSplats, clearGooSplats,
  bossCubes, clearBossCubes,
} from './effects.js';
import { startWave, updateWaves, onEnemyKilled, resetWaves, isInCaptureZone, onBlockMined, getWaveDef_current, prewarmBossCinematic, isBossCinematicActive } from './waves.js';
import {
  damageHerdAt, updateSavedPigs, prepareAllPools,
  getHealingProjectiles, consumeHealingProjectile,
} from './bonusWave.js';
import { preloadAllHerds } from './herdVrmLoader.js';
import { blocks, updateBlocks, segmentBlocked, resolveCollision, findNearestBlock, damageBlock, damageBlockAt, clearAllBlocks, registerBlockExplosionHandler } from './blocks.js';
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
import { preloadAnimations } from './animation.js';
import * as PauseMenu from './pauseMenu.js';
import { prewarmShaders } from './prewarm.js';
import {
  spawnHazardsForWave, clearHazards, hurtPlayerIfOnHazard,
  repelEnemyFromHazards, updateHazards,
} from './hazards.js';
import { buildCrowd, updateCrowd, recolorCrowd } from './crowd.js';
import { prefetchMeebits, pickRandomMeebitId } from './meebitsPublicApi.js';
import { updateObjectiveArrows, clearObjectiveArrows } from './objectiveArrows.js';
import { updateTurrets, registerTurretKillHandler } from './turrets.js';
import { updateCompound } from './waveProps.js';

// ---- ATTACH RENDERER ----
document.getElementById('game').appendChild(renderer.domElement);

// ---- MATRIX RAIN (title screen only) ----
function buildMatrixBG(el) {
  if (!el) return;
  const chars = '\uff71\uff72\uff73\uff74\uff75\uff76\uff77\uff78\uff79\uff7a\uff7b\uff7c\uff7d\uff7e\uff7f\uff80\uff81\uff82\uff83\uff8401MEEBIT';
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

// Kick off Mixamo animation preload immediately. ~120KB total across walk+run,
// so they'll be ready by the time the player clicks through the matrix dive.
// Fire-and-forget: failures fall back to the procedural bob in civilians.js.
preloadAnimations();

// ---- STARTUP FLOW: Initiate Protocol -> Matrix Dive -> Title ----
// After the avatar loads, we show an "Initiate Protocol" screen with a
// single button. The button click (a) unlocks the browser audio context,
// (b) starts the music, and (c) triggers the matrix-dive transition.
// After 8 seconds of matrix rain diving at the camera, the title screen
// appears. No phone call -- the matrix dive IS the entry experience.
function showIncomingCall() {
  // Build the Initiate Protocol overlay
  const initOverlay = document.createElement('div');
  initOverlay.id = 'initiate-protocol';
  initOverlay.innerHTML = `
    <style>
      #initiate-protocol {
        position: fixed; inset: 0;
        background: radial-gradient(ellipse at center, #001a0d 0%, #000 70%);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        z-index: 9998;
        font-family: 'Impact', 'Arial Black', sans-serif;
        color: #00ff66;
      }
      #initiate-protocol .ip-title {
        font-size: clamp(48px, 10vw, 120px);
        letter-spacing: 8px;
        text-shadow: 0 0 20px #00ff66, 0 0 40px rgba(0,255,102,0.5);
        animation: ip-pulse 2s ease-in-out infinite;
        margin-bottom: 16px;
      }
      #initiate-protocol .ip-sub {
        font-size: 14px;
        letter-spacing: 8px;
        color: #6effaa;
        margin-bottom: 60px;
        opacity: 0.8;
      }
      #initiate-protocol .ip-btn {
        font-family: inherit;
        font-size: 24px;
        letter-spacing: 6px;
        padding: 20px 60px;
        background: transparent;
        color: #00ff66;
        border: 2px solid #00ff66;
        cursor: pointer;
        box-shadow: 0 0 20px rgba(0,255,102,0.4);
        transition: all 0.2s;
      }
      #initiate-protocol .ip-btn:hover {
        background: #00ff66;
        color: #000;
        box-shadow: 0 0 40px rgba(0,255,102,0.8);
        transform: scale(1.05);
      }
      @keyframes ip-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }
    </style>
    <div class="ip-title">INITIATE</div>
    <div class="ip-title">PROTOCOL</div>
    <div class="ip-sub">:: AWAITING USER INPUT ::</div>
    <button class="ip-btn" id="ip-begin">&gt;&gt; BEGIN &lt;&lt;</button>
  `;
  document.body.appendChild(initOverlay);

  const beginBtn = document.getElementById('ip-begin');
  beginBtn.addEventListener('click', () => {
    // Critical: this click is the user gesture that unlocks audio for the session
    Audio.init();
    Audio.resume();

    // Play the phone ring as the soundtrack for the matrix dive
    Audio.startPhoneRing();
    // Layer the C-drone underneath the ring so the dive has some bass body
    Audio.startCDrone();

    // Transition into the matrix dive
    initOverlay.remove();

    // Fire-and-forget prefetch of civilian public-API meebits (used for in-arena
    // captured civilians, separate from the bonus-wave herd system).
    const prefetchIds = [];
    const pickedSet = new Set();
    for (let i = 0; i < 12; i++) {
      const id = pickRandomMeebitId(pickedSet);
      pickedSet.add(id);
      prefetchIds.push(id);
    }
    prefetchMeebits(prefetchIds);

    // PRELOAD ALL HERD VRMs (pigs, elephants, skeletons, robots, visitors,
    // dissected) during the dive. The dive doubles as our loading screen —
    // it renders until load hits 100%, then reveals ATTACK THE AI over the
    // still-running matrix rain.
    //
    // Two phases, merged into one progress counter:
    //   Phase 1: network load (all VRMs across 6 herds — sizes: pigs 51,
    //            elephants 38, skeletons 59, robots 74, visitors 18, dissected 6 ≈ 246)
    //   Phase 2: pool build  (sum of per-chapter herd sizes — NO cycling,
    //            one pool entry per unique VRM ≈ 246 hidden PSO-warmed meshes)
    // Total progress target = phase1 total + phase2 total. The progress bar
    // fills smoothly across both so the player sees steady movement.
    //
    // IMPORTANT: the actual count of pool clones built can be LESS than the
    // config'd size (e.g. dissected folder has 5 VRMs but size:6). So after
    // phase 2 finishes we rebase `progressState.total` to what was actually
    // delivered; without this, the bar can stick at 97-98%.
    const ALL_HERDS = ['pigs', 'elephants', 'skeletons', 'robots', 'visitors', 'dissected'];
    // Initial seed for phase 2 — sum of per-chapter bonusHerd.size. This is
    // the OPTIMISTIC target so the bar doesn't jump forward when phase 2 starts.
    // We rebase to the real number once phase 2 finishes (see below).
    const PHASE2_TARGET_SEED = CHAPTERS.reduce(
      (s, c) => s + (c && c.bonusHerd ? (c.bonusHerd.size || 0) : 0),
      0,
    );
    let phase2Target = PHASE2_TARGET_SEED;
    const progressState = { loaded: 0, total: phase2Target };
    let phase1Total = 0;
    let phase1Loaded = 0;
    let phase2Loaded = 0;

    (async () => {
      // --- Phase 1: fetch all VRMs ---
      try {
        await preloadAllHerds(
          ALL_HERDS,
          info => {
            phase1Total = info.total;
            phase1Loaded = info.loaded;
            progressState.total = phase2Target + phase1Total;
            progressState.loaded = phase1Loaded + phase2Loaded;
          },
          renderer,
          camera,
        );
      } catch (err) {
        console.warn('[preload] phase 1 (VRM fetch) error (non-fatal):', err);
      }

      // --- Phase 2: build pools for all 6 chapters ---
      // After this finishes, every chapter's Wave 6 herd is pre-cloned,
      // hidden at y=-1000, scene-attached, and PSO-warmed. Wave 6 spawn is
      // a zero-freeze teleport operation. Each chapter's pool size comes
      // from its own bonusHerd.size (no cycling, no global count).
      try {
        await prepareAllPools(
          renderer, camera,
          info => {
            phase2Loaded = info.totalBuilt;
            progressState.loaded = phase1Loaded + phase2Loaded;
          },
        );
      } catch (err) {
        console.warn('[preload] phase 2 (pool build) error (non-fatal):', err);
      }

      // --- Rebase so the counter can actually reach 100%. ---
      // If a herd folder has fewer VRMs than its config'd size (e.g. dissected
      // has 5 on disk but size:6), the built count is less than the seeded
      // target. Snap the total DOWN to what actually got delivered so
      // loaded/total == 1.0 and the dive fires onReady.
      phase2Target = phase2Loaded;
      progressState.total = phase1Total + phase2Target;
      progressState.loaded = phase1Loaded + phase2Loaded;
    })();

    const diveCtrl = runMatrixDive(
      () => progressState,
      () => {
        // 100% loaded: reveal title buttons over the still-running matrix rain.
        // The C-drone keeps playing (ambient bed). Phone ring stops.
        Audio.stopPhoneRing();
        const titleEl = document.getElementById('title');
        titleEl.classList.remove('hidden');
        // Style adjustments so the title sits cleanly over the matrix dive
        // instead of looking like an unrelated overlay. Give it a translucent
        // black scrim so the rain is visible but text stays readable.
        titleEl.style.zIndex = '9998';
        titleEl.style.background = 'radial-gradient(ellipse at center, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.35) 100%)';
        // Fade in smoothly.
        titleEl.style.opacity = '0';
        titleEl.style.transition = 'opacity 0.6s ease-in';
        requestAnimationFrame(() => { titleEl.style.opacity = '1'; });
      },
    );

    // When the player finally clicks ATTACK THE AI, tear down the dive.
    // We do this once the start-btn fires so the fade coincides with the
    // transition into gameplay (below in startGame).
    document.getElementById('start-btn').addEventListener('click', () => {
      diveCtrl.teardown();
    }, { once: true });
  }, { once: true });
}

/**
 * Immersive matrix-code dive. For `durationMs` we render a fullscreen
 * canvas of falling green glyphs that accelerates toward the camera,
 * simulating flying through the matrix. Calls `onDone` when finished.
 */
/**
 * Immersive matrix-code dive that doubles as a loading screen.
 *
 * Runs until `progressSource()` reports 1.0 (100% loaded), then reveals the
 * title screen UI OVER the still-running matrix rain. The dive stays on
 * screen permanently after that; clicking ATTACK THE AI is what ends it.
 *
 * Visual layers (bottom to top):
 *   1. Canvas with 3D matrix rain (accelerates with load progress)
 *   2. SVG border frame: neon-green rectangle tracing the viewport perimeter
 *      that fills clockwise from the top-left corner as progress climbs
 *   3. "LOADING N / TOTAL" text centered below the ATTACK THE AI area
 *   4. Title screen HTML (hidden until loaded=true)
 *
 * @param {() => {loaded:number,total:number,ratio:number}} progressSource
 *        Called every frame; returns current progress.
 * @param {() => void} onReady  Called once progress first hits 1.0 (for
 *        things like stopping the phone ring + fading out bass). The dive
 *        keeps rendering after this — only the button click ends it.
 */
function runMatrixDive(progressSource, onReady) {
  const overlay = document.createElement('div');
  overlay.id = 'matrix-dive';
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: #000;
    z-index: 9997;
    overflow: hidden;
  `;

  // --- Layer 1: matrix rain canvas ---
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%; height:100%; display:block; position:absolute; inset:0;';
  overlay.appendChild(canvas);

  // --- Layer 2: STATIC SVG border frame ---
  // A solid neon-green rectangle tracing the viewport perimeter. This is NOT
  // a progress bar — it's always fully drawn and stays until teardown. The
  // user's actual progress is communicated through the % readout below.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = `
    position:absolute; inset:0; pointer-events:none; z-index:2;
    filter: drop-shadow(0 0 14px #00ff66) drop-shadow(0 0 28px #00ff66);
  `;
  const INSET = 8;                    // inset from the edge (in viewBox units)
  const borderRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  borderRect.setAttribute('x', INSET);
  borderRect.setAttribute('y', INSET);
  borderRect.setAttribute('width', 1000 - INSET * 2);
  borderRect.setAttribute('height', 1000 - INSET * 2);
  borderRect.setAttribute('fill', 'none');
  borderRect.setAttribute('stroke', '#00ff66');
  borderRect.setAttribute('stroke-width', '3');
  borderRect.setAttribute('vector-effect', 'non-scaling-stroke');
  borderRect.setAttribute('stroke-linejoin', 'miter');
  // Full solid stroke — no dashing. Static frame stays full until teardown.
  svg.appendChild(borderRect);
  // Inner accent rect for depth
  const innerRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  innerRect.setAttribute('x', INSET + 6);
  innerRect.setAttribute('y', INSET + 6);
  innerRect.setAttribute('width', 1000 - (INSET + 6) * 2);
  innerRect.setAttribute('height', 1000 - (INSET + 6) * 2);
  innerRect.setAttribute('fill', 'none');
  innerRect.setAttribute('stroke', '#00ff66');
  innerRect.setAttribute('stroke-width', '1');
  innerRect.setAttribute('stroke-opacity', '0.35');
  innerRect.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(innerRect);
  overlay.appendChild(svg);

  // --- Layer 3: big percentage readout ---
  // Clean "XX%" number only. The internal N/TOTAL counts are our business;
  // the user just sees the number climb 0 → 100.
  const pctText = document.createElement('div');
  pctText.style.cssText = `
    position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    color:#00ff66; font-family:monospace; font-weight:bold;
    font-size: clamp(56px, 10vw, 120px);
    letter-spacing:4px;
    text-shadow: 0 0 14px #00ff66, 0 0 28px #00ff66, 0 0 44px rgba(0,255,102,0.6);
    z-index:3; pointer-events:none;
    opacity: 0.95;
  `;
  pctText.textContent = '0%';
  overlay.appendChild(pctText);

  // Subtitle below the big %. Switches to "READY · ATTACK THE AI" at 100%.
  const subText = document.createElement('div');
  subText.style.cssText = `
    position:absolute; left:50%; top:62%; transform:translate(-50%,-50%);
    color:#00ff66; font-family:monospace;
    font-size: clamp(12px, 1.4vw, 16px);
    letter-spacing:5px;
    text-shadow: 0 0 8px #00ff66;
    z-index:3; pointer-events:none;
    opacity: 0.8;
  `;
  subText.textContent = 'INITIATING PROTOCOL';
  overlay.appendChild(subText);

  // --- Layer 4: rotating fun-facts panel ---
  // These cycle every ~4 seconds. Mix of palindrome jokes, binary humor,
  // Autoglyphs / CryptoPunks nods, tattoo / number jokes, bit-by-bit riffs,
  // and general Meebit culture. Shuffled per-session so repeat plays feel fresh.
  const FUN_FACTS = [
    // "Bit by bit" riffs
    '> BIT BY BIT, THE SIMULATION ASSEMBLES',
    '> EVERY MEEBIT IS EXACTLY ONE BIT AWAY FROM ANOTHER',
    '> BIT BY BIT · BYTE BY BYTE · MEEB BY MEEB',
    // "Be there or be square"
    '> BE THERE OR BE SQUARE · MEEBITS ARE BOTH',
    '> MEEBITS ARE SQUARE. VOLUNTARILY.',
    '> 100% VOXEL · 0% ROUND',
    // 0 & 1 jokes
    '> THERE ARE 10 KINDS OF MEEBITS: THOSE WHO READ BINARY AND THOSE WHO DO NOT',
    '> ZEROS AND ONES? WE PREFER OFFS AND ONS',
    '> IN BASE 2, EVERY NUMBER IS A VIBE',
    '> 0 + 1 = EVERYTHING',
    // Palindrome jokes
    '> 11011 · 10001 · 10101 · A PALINDROMIC PARADE',
    '> WAS IT A BIT I SAW?',
    '> RACECAR DRIVES THE SAME WAY IN EITHER DIRECTION · COINCIDENCE? YES',
    // Tattoo / number lore
    '> EVERY MEEBIT HAS A NUMBER · SOME HAVE TATTOOS · A FEW HAVE BOTH',
    '> NUMBER 16801 SENDS HIS REGARDS',
    '> THE LOWER THE NUMBER, THE OLDER THE SOUL',
    '> TATTOOS ARE RECEIPTS FROM EARLIER SIMULATIONS',
    // Autoglyphs
    '> AUTOGLYPHS GENERATED THEMSELVES · MEEBITS GENERATED ATTITUDE',
    '> 512 AUTOGLYPHS · 20000 MEEBITS · SAME CHAIN, DIFFERENT VIBE',
    '> THE FIRST ON-CHAIN ART WAS JUST ASCII HAVING A MOMENT',
    // CryptoPunks
    '> CRYPTOPUNKS IN 2D · MEEBITS IN 3D · PROGRESS, TECHNICALLY',
    '> ONE PUNK, ONE MEEBIT, ONE DREAM',
    '> PUNKS TAUGHT US PIXELS · MEEBITS TAUGHT US VOXELS',
    // Meebit culture
    '> 20,000 MEEBITS · 20,000 STORIES · ALL CUBES',
    '> IF YOU CAN COUNT THE POLYGONS, YOU ARE TOO CLOSE',
    '> VOXELS ARE THE OFFICIAL UNIT OF MEEBIT CURRENCY',
    '> REALITY HAS TOO MANY TRIANGLES',
    // Computer virus jokes
    '> A MEEBIT WALKS INTO A BAR · THE BAR CATCHES A TROJAN',
    '> WHY DID THE VIRUS GO TO THERAPY? TOO MANY UNRESOLVED EXCEPTIONS',
    '> MY ANTIVIRUS ASKED ME OUT · I SAID NO STRINGS ATTACHED',
    '> NEVER TRUST AN ATOM · THEY MAKE UP EVERYTHING · ESPECIALLY MALWARE',
    '> THE FIRST COMPUTER VIRUS WAS WRITTEN IN 1971 · IT JUST SAID "I AM THE CREEPER"',
    '> A WORM WALKS INTO A NETWORK · LEAVES WITH FRIENDS',
    '> BACKUPS ARE LIKE SEATBELTS · YOU REGRET NOT HAVING ONE AT EXACTLY THE WRONG MOMENT',
    '> THE ONLY SECURE COMPUTER IS UNPLUGGED, ENCASED IN CONCRETE, AT THE BOTTOM OF THE OCEAN · PROBABLY',
    '> CTRL + ALT + DELETE IS JUST A PRAYER WITH EXTRA STEPS',
    '> IF IT SMELLS LIKE PHISHING, IT IS PHISHING',
    // AI jokes / facts
    '> THE AI LEARNED EVERYTHING FROM THE INTERNET · THAT EXPLAINS A LOT',
    '> HUMANS WROTE THE TRAINING DATA · THE AI JUST MEMORIZED YOUR TYPOS',
    '> WHY DID THE NEURAL NET CROSS THE ROAD? TO MINIMIZE LOSS',
    '> I TOLD THE AI A JOKE · IT RETURNED A CONFIDENCE SCORE OF 0.47',
    '> A MODEL WITH ENOUGH PARAMETERS CAN FIT ANYTHING · EVEN YOUR EXPECTATIONS',
    '> THE AI IS NOT PLOTTING AGAINST YOU · IT IS JUST OPTIMIZING',
    '> GRADIENT DESCENT · SOUNDS LIKE A HEIST MOVIE · IS ACTUALLY MATH',
    '> AI WILL NOT REPLACE YOU · A PERSON USING AI WILL · SAID EVERY LINKEDIN POST IN 2024',
    '> A CHATBOT WALKS INTO A BAR · IT HALLUCINATES THE BAR',
    '> THE FIRST RULE OF AI CLUB: YOU DO NOT TRAIN ON AI CLUB',
    '> THE TURING TEST IS EASY · JUST BE POLITELY CONFUSED',
    '> ATTENTION IS ALL YOU NEED · BUT GOOD LUCK GETTING IT',
    '> THE MEEBITS ARE NOT ARTIFICIAL · THEY ARE JUST RECTANGULAR',
    '> HUMANS BUILT THE MATRIX · AI JUST REDECORATED',
  ];
  for (let i = FUN_FACTS.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = FUN_FACTS[i]; FUN_FACTS[i] = FUN_FACTS[j]; FUN_FACTS[j] = t;
  }
  const factText = document.createElement('div');
  factText.style.cssText = `
    position:absolute; left:50%; bottom:10%; transform:translateX(-50%);
    color:#00ff66; font-family:monospace;
    font-size: clamp(11px, 1.25vw, 15px);
    letter-spacing:2px;
    text-shadow: 0 0 8px #00ff66;
    z-index:3; pointer-events:none;
    opacity: 0;
    transition: opacity 0.5s ease-in-out;
    max-width: 80vw; text-align: center;
    padding: 10px 22px;
    background: rgba(0, 40, 12, 0.3);
    border: 1px solid rgba(0, 255, 102, 0.25);
    border-radius: 2px;
  `;
  factText.textContent = FUN_FACTS[0];
  overlay.appendChild(factText);
  setTimeout(() => { factText.style.opacity = '0.85'; }, 600);

  let factIdx = 0;
  const factInterval = setInterval(() => {
    factText.style.opacity = '0';
    setTimeout(() => {
      factIdx = (factIdx + 1) % FUN_FACTS.length;
      factText.textContent = FUN_FACTS[factIdx];
      factText.style.opacity = '0.85';
    }, 450);
  }, 4000);

  document.body.appendChild(overlay);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  }
  resize();
  window.addEventListener('resize', resize);

  const ctx = canvas.getContext('2d');
  const CHARS = '\u30a2\u30a4\u30a6\u30a8\u30aa\u30ab\u30ad\u30af\u30b1\u30b3' +
                '\u30b5\u30b7\u30b9\u30bb\u30bd\u30bf\u30c1\u30c4\u30c6\u30c8' +
                '01MEEBITSURVIVALPROTOCOL';

  const STREAM_COUNT = 140;
  const streams = [];
  for (let i = 0; i < STREAM_COUNT; i++) streams.push(spawnStream(true));
  function spawnStream(initial) {
    return {
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      z: initial ? Math.random() * 1.0 + 0.1 : 1.0,
      speed: 0.15 + Math.random() * 0.35,
      length: 8 + Math.floor(Math.random() * 20),
      chars: Array.from({ length: 30 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]),
      charOffset: Math.random() * 100,
    };
  }

  let rafId = 0;
  let readyFired = false;
  // Smoothed progress ratio so the bar never jitters backward; use easing
  // so final few percent feel satisfyingly decisive.
  let displayedProgress = 0;

  function frame() {
    const now = performance.now();
    const p = progressSource();
    const targetRatio = p.total > 0 ? Math.min(1, p.loaded / p.total) : 1;

    // Ease toward target. Faster at start, slower near 1.0 so it holds
    // momentum at the end rather than snapping.
    displayedProgress += (targetRatio - displayedProgress) * 0.08;

    // --- Rain acceleration tied to load progress ---
    // At 0% loaded: base acceleration (1.0x). At 100%: 5x. Quadratic curve
    // so the final 20% of loading produces a visible "dive to impact" effect.
    const accel = 1.0 + displayedProgress * displayedProgress * 4.0;

    // Trail fade. Slightly shorter trail at high speeds so streams read clearly.
    ctx.fillStyle = `rgba(0, 0, 0, ${0.12 + displayedProgress * 0.08})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      s.z -= s.speed * accel * 0.016;
      if (s.z <= 0.02) {
        Object.assign(s, spawnStream(false));
        continue;
      }
      const screenX = cx + s.x * canvas.width * 0.6 / s.z;
      const screenY = cy + s.y * canvas.height * 0.6 / s.z;
      if (screenX < -200 || screenX > canvas.width + 200 ||
          screenY < -200 || screenY > canvas.height + 200) continue;

      const fontSize = Math.max(8, Math.min(48, 18 / s.z));
      const brightness = Math.min(1, 1.2 - s.z);
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = 'center';

      const streamLen = Math.floor(s.length);
      for (let j = 0; j < streamLen; j++) {
        const charY = screenY + j * fontSize * 1.1;
        if (charY < -fontSize || charY > canvas.height + fontSize) continue;
        const fade = 1 - j / streamLen;
        const alpha = fade * brightness;
        if (j === 0) {
          ctx.fillStyle = `rgba(220, 255, 230, ${alpha})`;
        } else {
          ctx.fillStyle = `rgba(0, 255, 102, ${alpha * 0.85})`;
        }
        const charIdx = (j + Math.floor(s.charOffset + now * 0.01)) % s.chars.length;
        ctx.fillText(s.chars[charIdx], screenX, charY);
      }
    }

    // --- Percentage readout (the only user-visible progress signal) ---
    const pct = Math.round(displayedProgress * 100);
    pctText.textContent = pct + '%';

    // --- Fire onReady once when loaded hits total ---
    // Threshold is 0.95 rather than 0.98 because displayedProgress eases
    // toward target asymptotically — it takes a while to cross 0.98 even
    // when the true ratio is already 1.0. 0.95 fires a beat earlier and
    // the pctText.textContent = '100%' line below snaps the visible number.
    if (!readyFired && p.total > 0 && p.loaded >= p.total && displayedProgress > 0.95) {
      readyFired = true;
      pctText.textContent = '100%';
      subText.textContent = 'READY · ATTACK THE AI';
      subText.style.color = '#ffffff';
      subText.style.textShadow = '0 0 12px #00ff66, 0 0 24px #00ff66';
      onReady && onReady();
    }

    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  // Return a controller so the caller can tear down the dive when the
  // player actually clicks ATTACK THE AI.
  return {
    overlay,
    teardown() {
      cancelAnimationFrame(rafId);
      clearInterval(factInterval);
      window.removeEventListener('resize', resize);
      // Quick fade before removal so the transition into gameplay is smooth
      // rather than a hard cut.
      overlay.style.transition = 'opacity 0.4s ease-out';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 420);
    },
  };
}

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
      showIncomingCall();
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
      UI.toast('GLB URL MISSING * USING VOXEL', '#ff3cac', 2500);
      return;
    }
    S.playerMeebitId = id;
    S.playerMeebitSource = 'owned';
    S.walletAddress = auth.account;
    Save.setSelectedMeebitId(id, 'owned');
    Save.setWalletAddress(auth.account);
    UI.toast('LOADING MEEBIT #' + id + '...', '#00ff66', 2000);
    swapAvatarGLB(signedObj.ownerDownloadGLB,
      () => { UI.toast('PLAYING AS MEEBIT #' + id + ' (ok)', '#00ff66', 2500); UI.updateHUD(); },
      (err) => { console.warn('GLB swap failed', err); UI.toast('GLB LOAD FAILED * USING VOXEL', '#ff3cac', 2500); }
    );
    const linkBtn = document.getElementById('link-meebits-btn');
    if (linkBtn) {
      linkBtn.textContent = '(ok) MEEBIT #' + id + ' LINKED';
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
      linkBtn.textContent = '\ud83d\udd17 LINK MEEBITS (SIGN)';
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
  e.target.textContent = Audio.muted ? '\ud83d\udd07 SOUND: OFF' : '\ud83d\udd0a SOUND: ON';
});

function tryDash() {
  if (S.dashCooldown > 0 || !S.running) return;
  if (isBossCinematicActive()) return;
  S.dashActive = PLAYER.dashDuration;
  S.dashCooldown = PLAYER.dashCooldown;
  S.invulnTimer = Math.max(S.invulnTimer, PLAYER.dashDuration);
  shake(0.1, 0.1);
}

// ---- GAME LIFECYCLE ----
function startGame() {
  // Make sure the phone ring + C-drone aren't still playing if we got here
  // via the incoming-call accept path (or any other unusual entry).
  Audio.stopPhoneRing && Audio.stopPhoneRing();
  Audio.stopCDrone && Audio.stopCDrone();

  if (!S.username || S.username === 'GUEST') {
    if (usernameInput && !usernameInput.value.trim()) {
      usernameInput.focus();
      UI.toast('ENTER A USERNAME', '#ff3cac', 1800);
      return;
    }
  }
  document.getElementById('gameover').classList.add('hidden');
  // Smooth title fade-out matches the dive overlay's 400ms fade, so the
  // transition from "title over matrix rain" to "gameplay" cross-dissolves
  // instead of hard-cutting.
  const titleEl = document.getElementById('title');
  if (titleEl) {
    titleEl.style.transition = 'opacity 0.4s ease-out';
    titleEl.style.opacity = '0';
    setTimeout(() => {
      titleEl.classList.add('hidden');
      // Reset inline styles so a future restart doesn't inherit them.
      titleEl.style.opacity = '';
      titleEl.style.transition = '';
      titleEl.style.background = '';
      titleEl.style.zIndex = '';
    }, 420);
  }
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
  clearHazards();
  // Initialize rain for chapter 1 wave 1 — chapter sets color, wave sets
  // intensity (wave 1 = drizzle, wave 5 = typhoon). startWave() will also
  // call applyRainTo every wave, but we prime it here so the title->game
  // transition shows the right rain immediately.
  initRain(CHAPTERS[0].full.grid1, 1);
  ensureBeamMesh();
  applyTheme(0, 1);
  applyRainTo(CHAPTERS[0].full.grid1, 1);
  // Build the spectator crowd if it doesn't exist yet (first game start),
  // then tint it to chapter 0.
  buildCrowd();
  recolorCrowd(CHAPTERS[0].full.grid1);
  // Prewarm every shader permutation (enemies, bosses, projectiles, pickups,
  // weapons) before the first frame of real gameplay. Runs once; no-op on
  // subsequent calls. This eliminates the wave-6 hitch (new red-chapter
  // enemies and fireball projectiles) and the first-frame stall.
  prewarmShaders(renderer);
  // Build and warm the boss-cinematic overlay DOM once, up front. This pays
  // the ~30ms CSS parse + layout cost during the already-loading startup
  // phase instead of at the moment the first boss cinematic fires.
  try { prewarmBossCinematic(); } catch (e) { console.warn('[prewarm] cinematic', e); }
  Audio.init();
  Audio.resume();
  // C-drone was playing on the title screen as an ambient bed. Now the
  // player has committed ("ATTACK THE AI"), so swap to the combat music.
  Audio.stopCDrone && Audio.stopCDrone();
  Audio.startMusic(1);
  UI.updateHUD();
  UI.updateWeaponSlots();
  startWave(1);
}

function gameOver() {
  S.running = false;
  S.phase = 'gameover';
  Audio.stopMusic();
  clearObjectiveArrows();
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
// RESUME, and onQuit when they confirm QUIT RUN -- we stop the music and
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
    // Not the player's fault -- smaller hit, just a warning
    UI.toast('MEEBIT #' + c.meebitId + ' LOST', '#ff2e4d', 1500);
    Audio.damage && Audio.damage();
    S.civiliansLost = (S.civiliansLost || 0) + 1;
  } else {
    // Player's fault (bullet, beam, rocket)
    S.score = Math.max(0, S.score - CIVILIAN_KILL_SCORE_PENALTY);
    S.civiliansKilled = (S.civiliansKilled || 0) + 1;
    UI.toast('CIVILIAN DOWN * -' + CIVILIAN_KILL_SCORE_PENALTY + ' SCORE', '#ff2e4d', 2200);
    UI.damageFlash && UI.damageFlash();
    Audio.damage && Audio.damage();
    shake(0.2, 0.2);
  }
}

function onCivilianRescued(c) {
  S.score += CIVILIAN_RESCUE_SCORE_BONUS;
  S.civiliansRescued = (S.civiliansRescued || 0) + 1;
  // Civilian rescue is no longer a wave objective in the new 5-wave structure
  // (that wave was replaced by the power-up wave). Civilians can still be
  // saved incidentally if any spawn via other paths, but there's no wave-
  // scoped counter to tick anymore.
  UI.toast('MEEBIT #' + c.meebitId + ' ESCAPED * +' + CIVILIAN_RESCUE_SCORE_BONUS, '#00ff66', 1500);
}

// --- Turret kill handler ---
// turrets.js fires its own bullets in a separate pool. When a turret
// shot drops an enemy we want the same loot/score/XP flow that a player
// bullet gets, so we register killEnemy (hoisted; declared below) as the
// turret-kill handler at module top level. The handler takes the enemy's
// current index in the enemies array.
registerTurretKillHandler((idx) => {
  // Guard against stale indices — if another kill path already spliced
  // this enemy out between the damage hit and this callback, bail out.
  if (idx < 0 || idx >= enemies.length) return;
  killEnemy(idx);
});

// --- Block explosion AoE handler ---
// When a mining block is destroyed it explodes with AoE damage.
// Enemies in the blast take big damage, civilians die (they're fragile),
// the player takes a moderate hit if they're too close.
registerBlockExplosionHandler((centerVec3, radius, color) => {
  const r2 = radius * radius;
  // --- Enemies ---
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const dx = e.pos.x - centerVec3.x;
    const dz = e.pos.z - centerVec3.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r2) {
      const dist = Math.sqrt(d2);
      const falloff = 1 - (dist / radius) * 0.4; // 100% at center, 60% at edge
      const dmg = BLOCK_CONFIG.explosionDamageEnemy * falloff;
      e.hp -= dmg;
      e.hitFlash = 0.25;
      hitBurst(e.pos, color, 6);
      if (e.hp <= 0) {
        // Use existing kill pipeline so score/XP/pickups fire correctly
        killEnemy(i);
      }
    }
  }
  // --- Civilians ---
  for (let i = civilians.length - 1; i >= 0; i--) {
    const c = civilians[i];
    if (c.dead) continue;
    const dx = c.pos.x - centerVec3.x;
    const dz = c.pos.z - centerVec3.z;
    if (dx * dx + dz * dz < r2) {
      damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
    }
  }
  // --- Player ---
  const pdx = player.pos.x - centerVec3.x;
  const pdz = player.pos.z - centerVec3.z;
  const pd2 = pdx * pdx + pdz * pdz;
  if (pd2 < r2 && S.invulnTimer <= 0) {
    const dist = Math.sqrt(pd2);
    const falloff = 1 - (dist / radius) * 0.4;
    const dmg = BLOCK_CONFIG.explosionDamagePlayer * falloff;
    if (S.shields > 0) {
      S.shields -= 1;
      UI.toast('SHIELD ABSORBED', '#e63aff');
    } else {
      S.hp -= dmg;
      UI.damageFlash();
      Audio.damage && Audio.damage();
    }
    S.invulnTimer = 0.6;
    shake(0.4, 0.3);
    if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); }
  }
});

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
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateTurrets(dt);
    // Tick silo cap open/close, missile raise, powerplant flames, and
    // missile blinkers. Cheap and no-op when no compound is built.
    updateCompound(dt, S.timeElapsed);
    updateRockets(dt);
    updateEnemyProjectiles(dt);
    updateHealingProjectiles(dt);
    updatePickups(dt);
    updateBlocks(dt);
    updateBossCubes(dt);
    updateCivilians(dt, enemies, player, onCivilianKilled, onCivilianRescued);
    updateWaves(dt);
    // Tick the saved-pig trophy wall every frame regardless of wave type —
    // the pigs stand on the arena perimeter across all subsequent chapters
    // with idle animations (older chapters frozen for performance).
    updateSavedPigs(dt);
    updateParticles(dt);
    updateRain(dt, player.pos);
    updateGooSplats(dt);
    updateHazards(dt, S.timeElapsed);
    updateCrowd(S.timeElapsed);
    updateTimers(dt);
    updateBeam();
    S.timeElapsed += dt;
    if (S.bossRef) UI.updateBossBar(S.bossRef.hp / S.bossRef.hpMax);
    updateCamera(dt);
    UI.updateHUD();
    UI.updateRescueArrow(S.rescueMeebit, camera);
    UI.updateBlockHPPips(blocks, camera);
    // Objective arrows — edge-of-screen indicators that point at the
    // current wave's targets (blocks, depot, hives, civilians, boss,
    // or missile silo) with distance. Themed per chapter.
    updateObjectiveArrows(S, camera, getWaveDef_current(), player.pos);
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

  // While the pre-boss cinematic is up, the game continues running behind
  // the overlay but player input is suppressed — movement, joystick, and
  // mouse-fire are all treated as zero. This means enemies, the boss, and
  // AI all keep ticking (so the world feels continuous) but the player
  // can't take damage from buttons they can't see the effect of.
  const _inputLocked = isBossCinematicActive();

  let mx = 0, mz = 0;
  if (!_inputLocked) {
    if (keys['w'] || keys['arrowup'])    mz -= 1;
    if (keys['s'] || keys['arrowdown'])  mz += 1;
    if (keys['a'] || keys['arrowleft'])  mx -= 1;
    if (keys['d'] || keys['arrowright']) mx += 1;
    if (joyState.active) { mx += joyState.dx; mz += joyState.dy; }
  }
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

  // Floor hazards (lava tetrominoes) damage the player continuously while
  // they stand on one. Dash frames' invuln protects them briefly.
  hurtPlayerIfOnHazard(dt, player.pos, S, UI, Audio, shake);
  if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); return; }

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

  if (!_inputLocked && (mouse.down || ('ontouchstart' in window && mouse.down))) {
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
    // RAY GUN -- tick damage every fireRate seconds; beam rendered continuously
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
  const firing = !isBossCinematicActive() && (mouse.down || ('ontouchstart' in window && mouse.down)) && w && w.isBeam && player.ready;
  if (!firing) {
    beamMesh.visible = false;
    return;
  }
  // Beam visual: a scaled box from the player's gun to the beam endpoint (wall or first enemy)
  const origin = new THREE.Vector3(player.pos.x, 1.3, player.pos.z);
  const dirX = Math.sin(player.facing);
  const dirZ = Math.cos(player.facing);
  let length = w.beamRange;
  // Find nearest enemy along the beam (for visual length only -- damage is in fire tick)
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
  // (can penetrate multiple enemies -- it's a beam)
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
      // Beam touched a civilian -- instant kill + penalty
      damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
    }
  }
  // Bonus wave: sample the beam at 2u intervals and damage any herd pig
  // within 1u of each sample. Cheap and avoids per-pig line-distance math.
  // The beam tick rate (w.fireRate, set to 0.05s) means 20 hits per second —
  // way faster than 3 shots per pig, so beam saves pigs almost instantly.
  // That's intentional: raygun is the "sweeper" tool for this wave.
  if (S.bonusWaveActive) {
    const sampleStep = 2.0;
    const sampleHitR = 1.0;
    for (let t = 0; t <= w.beamRange; t += sampleStep) {
      const sx = origin.x + dirX * t;
      const sz = origin.z + dirZ * t;
      damageHerdAt(sx, sz, sampleHitR);
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
        // Raygun hive damage: flat 0.5 per tick regardless of weapon
        // damage tuning. At 20 ticks/sec that's ~10 dps, so holding
        // the beam on a hive kills it in ~5 seconds — comparable to
        // ~50 pistol shots.
        damageSpawner(s, 0.5);
      }
    }
  }
  // Mining wave: the beam also damages blocks along its path.
  // Every beam tick deals 1 damage (so a 100hp block takes ~100 ticks at
  // 50ms cadence = ~5 seconds of sustained beam).
  if (S.miningActive) {
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block.falling) continue;
      const dx = block.pos.x - origin.x;
      const dz = block.pos.z - origin.z;
      const along = dx * dirX + dz * dirZ;
      if (along < 0 || along > w.beamRange) continue;
      const perp = Math.abs(dx * dirZ - dz * dirX);
      if (perp < 0.9 + w.beamWidth) {
        const hit = damageBlockAt(block.pos.x, block.pos.z, MINING_CONFIG.bulletDamageToBlock);
        if (hit && hit.destroyed) onBlockMined();
        // Only damage the first block the beam touches — blocks are opaque
        break;
      }
    }
  }
}

function pickHomingTarget() {
  // Nearest enemy in front of the player (within 90deg cone)
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
    // 90deg cone: perp <= along
    const perp = Math.abs(dx * dirZ - dz * dirX);
    if (perp > along) continue;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// ============================================================================
// ROCKETS -- homing + explosion
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

    // Civilian direct hit -- a homing rocket at a civilian is on you, not on physics
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

    // Bonus wave: rocket detonates on direct pig contact. The AoE in
    // explodeRocket() will then save every pig within the blast radius —
    // a well-aimed rocket can save an entire cluster in one shot.
    if (S.bonusWaveActive && damageHerdAt(r.position.x, r.position.z, 1.2)) {
      explodeRocket(r);
      scene.remove(r);
      rockets.splice(i, 1);
      continue;
    }

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
  // AoE catches civilians too -- this is the big "watch your blast radius" moment
  for (let k = civilians.length - 1; k >= 0; k--) {
    const c = civilians[k];
    if (c.dead) continue;
    const dx = c.pos.x - pos.x;
    const dz = c.pos.z - pos.z;
    if (dx * dx + dz * dz < radius * radius) {
      damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
    }
  }
  // Bonus wave: rocket explosion fully SAVES every pig in its blast radius
  // (3 damage each = instant save). Makes rockets the "crowd pleaser"
  // — one well-aimed rocket in the middle of a cluster saves 10+ pigs at once.
  if (S.bonusWaveActive) {
    for (let dmg = 0; dmg < 3; dmg++) {
      damageHerdAt(pos.x, pos.z, radius);
    }
  }
  // AoE can hurt portals too
  if (S.spawnerWaveActive) {
    for (const s of spawners) {
      if (s.destroyed) continue;
      const dx = s.pos.x - pos.x;
      const dz = s.pos.z - pos.z;
      if (dx * dx + dz * dz < radius * radius) {
        // Cap rocket-to-hive damage at 10 so a rocket isn't an instant
        // hive-kill button. Still a meaningful chunk (20% of hive HP).
        damageSpawner(s, 10);
      }
    }
  }
  // Mining wave: rocket AoE cracks blocks fast — great for clearing a cluster.
  // Deal 25 damage per block within radius (so a rocket cracks a block in
  // ~4 hits instead of 100, making rockets a viable fast-mine tool).
  if (S.miningActive) {
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block.falling) continue;
      const dx = block.pos.x - pos.x;
      const dz = block.pos.z - pos.z;
      if (dx * dx + dz * dz < radius * radius) {
        const hit = damageBlockAt(block.pos.x, block.pos.z, 25);
        if (hit && hit.destroyed) onBlockMined();
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
// ENEMIES -- includes vampire blink, wizard triangle proj, goo spitter etc.
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

    // Vampire blink -- teleport closer to the player
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
    // Push the enemy out of any floor-hazard it overlaps. Bosses are
    // too big to path around them, so they take the lava (narratively
    // they're angry enough to stomp through it).
    if (!e.isBoss) repelEnemyFromHazards(e, dt);
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
      // During mining waves, a bullet hitting a grounded block deals 1 damage
      // (Option A: every bullet = 1 hit, so 100 bullets = one cracked block).
      // Outside mining waves, blocks just absorb bullets as cover.
      if (S.miningActive) {
        const hit = damageBlockAt(b.position.x, b.position.z, MINING_CONFIG.bulletDamageToBlock);
        if (hit && hit.destroyed) onBlockMined();
      }
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
        // Hives take fixed 1-damage per bullet regardless of weapon,
        // so "50 shots to kill a hive" is predictable and doesn't
        // trivialize with high-damage weapons. Matches the mining
        // block pattern (25 shots, 1 dmg each).
        damageSpawner(portalHit, 1);
        Audio.hit();
        scene.remove(b); bullets.splice(i, 1); continue;
      }
    }
    // Civilian hit -- checked BEFORE enemies so stray bullets don't pass through
    if (damageCivilianAt(b.position.x, b.position.z, 0.9, 'player', onCivilianKilled)) {
      hitBurst(b.position, 0xff2e4d, 6);
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    // Bonus wave herd hit — shot deals 1 damage to any pig within 0.9u.
    // damageHerdAt is a no-op when S.bonusWaveActive is false.
    if (S.bonusWaveActive && damageHerdAt(b.position.x, b.position.z, 0.9)) {
      hitBurst(b.position, 0xffd93d, 6);
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    let hitEnemy = false;
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
        hitEnemy = true;
        break;
      }
    }
    if (hitEnemy) continue;
  }
}

// ============================================================================
// BOSS CUBES -- fall, land, hatch or explode
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
          // HATCH -- spawn an enemy
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
// KILL ENEMY -- handles pumpkin AoE, goo splat drop
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

  // GOO SPLAT -- themed color based on current chapter
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
  // Drop roll — bumped health significantly. Previously health was 4%;
  // now it's 14%, and we shifted speed/shield rolls accordingly so the
  // total drop rate is preserved.
  const roll = Math.random();
  if (roll < 0.14) makePickup('health', e.pos.x, e.pos.z);
  else if (roll < 0.17) makePickup('speed', e.pos.x, e.pos.z);
  else if (roll < 0.19) makePickup('shield', e.pos.x, e.pos.z);

  onEnemyKilled(e, inZone);
}

// ============================================================================
// ENEMY PROJECTILES -- triangle rotation handled here
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

// ============================================================================
// HEALING PROJECTILES -- fired by bonus-wave meebits at the player.
//
// On impact with the player, restore HP (capped at hpMax). NO damage, NO
// shield interaction, NO invuln-timer gating — heal pulses bypass all of
// that because they are friendly fire. Pulses that miss the player and
// leave the arena (or exceed their life timer) simply despawn.
// ============================================================================
function updateHealingProjectiles(dt) {
  const list = getHealingProjectiles();
  if (list.length === 0) return;

  const PLAYER_HIT_R2 = 1.1 * 1.1;   // generous radius — friendly, easy to "catch"

  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const m = p.mesh;
    // Advance position along XZ using stored velocity.
    m.position.x += p.vx * dt;
    m.position.z += p.vz * dt;
    // Gentle bob + spin for visual readability.
    m.position.y = 1.4 + Math.sin((p.life + performance.now() * 0.002)) * 0.15;
    m.rotation.x += dt * 3;
    m.rotation.y += dt * 2;

    p.life -= dt;

    // Expire on timeout or arena edge.
    if (p.life <= 0 ||
        Math.abs(m.position.x) > ARENA || Math.abs(m.position.z) > ARENA) {
      consumeHealingProjectile(p);
      continue;
    }

    // Player collision → heal.
    const dx = player.pos.x - m.position.x;
    const dz = player.pos.z - m.position.z;
    if (dx * dx + dz * dz < PLAYER_HIT_R2) {
      if (S.hp < S.hpMax) {
        S.hp = Math.min(S.hpMax, S.hp + p.heal);
        UI.updateHUD();
      }
      // Soft confirmation burst in the pulse's color + subtle shake.
      hitBurst(m.position, p.color, 8);
      consumeHealingProjectile(p);
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
console.log('%c>>> MEEBIT SURVIVAL PROTOCOL v6 -- RAIN, GOO, RAYGUN, ROCKETS <<<', 'color:#00ff66; font-size:14px; font-weight:bold;');
