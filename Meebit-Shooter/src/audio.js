// Procedural SFX via WebAudio + streamed MP3 soundtrack and phone ring.
//
// Three independent gain buses:
//   masterGain   ? master volume (mute affects this)
//   sfxGain      ? all procedural sound effects (shots, hits, pickups...)
//   musicGain    ? reserved for WebAudio music (legacy). Kept at 0.
//
// For the soundtrack we use HTMLAudioElements so we can stream MP3s from
// the assets folder without decoding them into memory. Each element has
// its own .volume, which we drive from user settings persisted in
// localStorage.
//
// Tracks on disk (Meebit-Shooter/assets/):
//   AwakenArena.mp3 — opening track (intro / first wave start)
//   Arena I.mp3, Arena II.mp3, Arena III.mp3, Arena IV.mp3 — core arena loop
//   XIAN.mp3, YOMI.mp3, ZION.mp3 — boss faction tracks
//   Underworld.mp3 — closing track (chapter 7 / late-game)
//   PHONE RINGS.mp3
//   C-drone.mp3   (ambient drone layered UNDER the phone ring during the
//                  matrix-dive so the ring doesn't feel naked)
//
// Playlist order (loops indefinitely):
//   AwakenArena → Arena I → II → III → IV → XIAN → YOMI → ZION → Underworld → AwakenArena → ...

const SOUNDTRACK_FILES = [
  'assets/AwakenArena.mp3',
  'assets/Arena I.mp3',
  'assets/Arena II.mp3',
  'assets/Arena III.mp3',
  'assets/Arena IV.mp3',
  'assets/XIAN.mp3',
  'assets/YOMI.mp3',
  'assets/ZION.mp3',
  'assets/Underworld.mp3',
];
// The phone-ring asset has shipped under several names in this project.
// We try them in order until one loads; whichever works becomes the source.
const PHONE_RING_CANDIDATES = [
  'assets/PHONE RINGS.mp3',
  'assets/phone_ring.mp3',
  'assets/Phone Ring.mp3',
  'assets/phone-ring.mp3',
];
// C-drone candidate paths (same defensive pattern as phone ring).
// Only the first one is currently committed, but list a few likely variants
// so a future rename doesn't break the load silently.
const CDRONE_CANDIDATES = [
  'assets/C-drone.mp3',
  'assets/c-drone.mp3',
  'assets/C_drone.mp3',
  'assets/cdrone.mp3',
];

const LS_KEY = 'meebit_audio_prefs_v1';

// We export an instance named `Audio`, which shadows the global `Audio`
// (the HTMLAudioElement constructor) inside this module's scope. Cache the
// real constructor under a different name before the shadow takes effect.
const HTMLAudio = window.Audio;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return {
      sfxVolume: typeof o.sfxVolume === 'number' ? o.sfxVolume : 0.7,
      musicVolume: typeof o.musicVolume === 'number' ? o.musicVolume : 0.5,
      muted: !!o.muted,
    };
  } catch (e) { return null; }
}
function savePrefs(prefs) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (e) {}
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;

    // User-controlled volumes (0..1)
    const prefs = loadPrefs() || { sfxVolume: 0.7, musicVolume: 0.5, muted: false };
    this.sfxVolume = prefs.sfxVolume;
    this.musicVolume = prefs.musicVolume;
    this.muted = prefs.muted;

    // Soundtrack
    this._trackEls = [];          // HTMLAudioElement[]
    this._currentTrackIdx = -1;   // which track is currently assigned
    this._musicOn = false;

    // Phone ring
    this._phoneRingEl = null;

    // C-drone (ambient bed under the phone ring)
    this._cDroneEl = null;
    this._cDronePending = false;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 1;
      this.masterGain.connect(this.ctx.destination);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxVolume;
      this.sfxGain.connect(this.masterGain);

      // Legacy music bus (kept for any lingering procedural music). MP3
      // soundtrack uses HTMLAudioElement volume, not this node.
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.masterGain);
    } catch (e) { console.warn('audio unsupported', e); }

    // Build HTMLAudio elements lazily (browsers are fine with this in init)
    if (this._trackEls.length === 0) {
      for (let i = 0; i < SOUNDTRACK_FILES.length; i++) {
        const src = SOUNDTRACK_FILES[i];
        const el = new HTMLAudio(src);
        el.preload = 'auto';
        el.loop = false;    // playlist mode: advance to next track when this ends
        el.volume = this._effectiveMusicVolume();
        // When this track ends, advance to the next one in the playlist.
        el.addEventListener('ended', () => {
          // Only auto-advance if music is still enabled and this is the active track
          if (!this._musicOn) return;
          if (this._currentTrackIdx !== i) return;
          const nextIdx = (i + 1) % this._trackEls.length;
          this._playTrackAt(nextIdx, /*fadeIn*/ true);
        });
        this._trackEls.push(el);
      }
    }
    if (!this._phoneRingEl) {
      // Try each candidate path. Whichever can load becomes our phone ring.
      // If none load, the ring is silently disabled (game still works).
      this._tryLoadPhoneRing(0);
    }
    if (!this._cDroneEl) {
      // Same defensive pattern for the C-drone bed.
      this._tryLoadCDrone(0);
    }
  }

  _tryLoadPhoneRing(idx) {
    if (idx >= PHONE_RING_CANDIDATES.length) {
      console.warn('[audio] no phone ring asset found at any known path');
      return;
    }
    const src = PHONE_RING_CANDIDATES[idx];
    const el = new HTMLAudio(src);
    el.preload = 'auto';
    el.loop = true;
    el.volume = this._effectiveSfxVolume();
    el.addEventListener('canplaythrough', () => {
      // This candidate loaded; lock it in as our phone ring.
      if (!this._phoneRingEl) this._phoneRingEl = el;
    }, { once: true });
    el.addEventListener('error', () => {
      // Move to the next candidate silently
      this._tryLoadPhoneRing(idx + 1);
    }, { once: true });
  }

  _tryLoadCDrone(idx) {
    if (idx >= CDRONE_CANDIDATES.length) {
      console.warn('[audio] no C-drone asset found at any known path');
      return;
    }
    const src = CDRONE_CANDIDATES[idx];
    const el = new HTMLAudio(src);
    el.preload = 'auto';
    el.loop = true;
    el.volume = this._effectiveSfxVolume();
    el.addEventListener('canplaythrough', () => {
      if (!this._cDroneEl) {
        this._cDroneEl = el;
        // If someone called startCDrone() before the asset was ready,
        // honour that request now.
        if (this._cDronePending) this.startCDrone();
      }
    }, { once: true });
    el.addEventListener('error', () => {
      this._tryLoadCDrone(idx + 1);
    }, { once: true });
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // ---------------------------------------------------------------
  // VOLUME
  // ---------------------------------------------------------------
  _effectiveSfxVolume() { return this.muted ? 0 : this.sfxVolume; }
  _effectiveMusicVolume() { return this.muted ? 0 : this.musicVolume; }

  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume;
    if (this._phoneRingEl) this._phoneRingEl.volume = this._effectiveSfxVolume();
    if (this._cDroneEl) this._cDroneEl.volume = this._effectiveSfxVolume();
    this._persist();
  }
  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    for (const el of this._trackEls) el.volume = this._effectiveMusicVolume();
    if (this._tutorialMusicEl) this._tutorialMusicEl.volume = this._effectiveMusicVolume();
    this._persist();
  }
  setMuted(m) {
    this.muted = !!m;
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : 1;
    for (const el of this._trackEls) el.volume = this._effectiveMusicVolume();
    if (this._tutorialMusicEl) this._tutorialMusicEl.volume = this._effectiveMusicVolume();
    if (this._phoneRingEl) this._phoneRingEl.volume = this._effectiveSfxVolume();
    if (this._cDroneEl) this._cDroneEl.volume = this._effectiveSfxVolume();
    this._persist();
  }
  _persist() {
    savePrefs({
      sfxVolume: this.sfxVolume,
      musicVolume: this.musicVolume,
      muted: this.muted,
    });
  }

  // ---------------------------------------------------------------
  // SOUNDTRACK (MP3)
  // ---------------------------------------------------------------

  /**
   * Start the soundtrack in playlist mode. Tracks advance automatically:
   *   AwakenArena → Arena I → II → III → IV → XIAN → YOMI → ZION → Underworld
   *   → AwakenArena → ... (loops indefinitely)
   * The `wave` argument is kept for backward compatibility but no longer
   * tied to gameplay -- calling with no args (or wave=1) starts from
   * AwakenArena (the opening track).
   */
  startMusic(wave) {
    if (!this.ctx) this.init();
    if (this._trackEls.length === 0) return;

    let idx;
    if (typeof wave === 'number' && wave > 0) {
      idx = (wave - 1) % this._trackEls.length;
    } else {
      idx = this._currentTrackIdx >= 0 ? this._currentTrackIdx : 0;
    }

    this._musicOn = true;
    this._playTrackAt(idx, /*fadeIn*/ true);
  }

  /** Internal: play a specific track index, fading out any currently active one. */
  _playTrackAt(idx, fadeIn) {
    if (this._currentTrackIdx !== idx && this._currentTrackIdx >= 0) {
      const oldEl = this._trackEls[this._currentTrackIdx];
      this._fadeOutAndPause(oldEl);
    }
    this._currentTrackIdx = idx;
    const el = this._trackEls[idx];
    try {
      el.currentTime = 0;
      el.volume = fadeIn ? 0 : this._effectiveMusicVolume();
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    if (fadeIn) this._fadeIn(el, this._effectiveMusicVolume(), 0.8);
  }

  /** Stop the currently playing track (with a quick fade). */
  stopMusic() {
    this._musicOn = false;
    if (this._currentTrackIdx < 0) return;
    const el = this._trackEls[this._currentTrackIdx];
    this._fadeOutAndPause(el);
  }

  // ---------------------------------------------------------------
  // TUTORIAL MUSIC — independent of the playlist soundtrack.
  // Single looping track loaded from assets/TeachingWar.mp3. Has its
  // own HTMLAudioElement so it can play simultaneously with (or
  // exclusively from) the main soundtrack — though in practice we
  // call stopMusic() before starting it, since tutorial mode replaces
  // the main music entirely.
  // ---------------------------------------------------------------
  startTutorialMusic() {
    if (!this.ctx) this.init();
    // Lazy-load on first call.
    if (!this._tutorialMusicEl) {
      try {
        const el = new HTMLAudio('assets/TeachingWar.mp3');
        el.preload = 'auto';
        el.loop = true;             // loop indefinitely while tutorial runs
        el.volume = this._effectiveMusicVolume();
        this._tutorialMusicEl = el;
      } catch (e) {
        console.warn('[audio] TeachingWar.mp3 failed to load', e);
        return;
      }
    }
    // Stop the playlist soundtrack if it's running so the tutorial
    // track plays alone.
    this.stopMusic();
    this._musicOn = true;
    const el = this._tutorialMusicEl;
    try {
      el.currentTime = 0;
      el.volume = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    this._fadeIn(el, this._effectiveMusicVolume(), 0.8);
  }

  stopTutorialMusic() {
    this._musicOn = false;
    if (!this._tutorialMusicEl) return;
    this._fadeOutAndPause(this._tutorialMusicEl);
  }

  /** True if a music track is currently active (for callers that want to
   *  avoid restarting music mid-session). */
  isPlaying() {
    if (!this._musicOn) return false;
    if (this._currentTrackIdx < 0) return false;
    const el = this._trackEls[this._currentTrackIdx];
    if (!el) return false;
    return !el.paused;
  }

  /** Explicitly switch to a track by index (0..8), cycling. */
  setTrack(idx) {
    if (!this._trackEls.length) return;
    const n = ((idx % this._trackEls.length) + this._trackEls.length) % this._trackEls.length;
    this.startMusic(n + 1);
  }

  _fadeIn(el, target, durSec) {
    const steps = 20;
    const stepMs = (durSec * 1000) / steps;
    let i = 0;
    const iv = setInterval(() => {
      i++;
      const v = target * (i / steps);
      try { el.volume = Math.max(0, Math.min(1, v)); } catch (e) {}
      if (i >= steps) clearInterval(iv);
    }, stepMs);
  }
  _fadeOutAndPause(el) {
    const startVol = el.volume;
    const steps = 16;
    const stepMs = 30;
    let i = 0;
    const iv = setInterval(() => {
      i++;
      try { el.volume = Math.max(0, startVol * (1 - i / steps)); } catch (e) {}
      if (i >= steps) {
        clearInterval(iv);
        try { el.pause(); el.currentTime = 0; } catch (e) {}
      }
    }, stepMs);
  }

  // ---------------------------------------------------------------
  // PHONE RING (MP3)
  // ---------------------------------------------------------------

  /** Start the phone-ringing loop (for the incoming call screen). */
  startPhoneRing() {
    if (!this.ctx) this.init();
    if (!this._phoneRingEl) {
      // Loader hasn't found a valid candidate yet -- queue the start so
      // it fires as soon as one does.
      this._phoneRingPending = true;
      // Poll briefly in case init() completes shortly
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        if (this._phoneRingEl) {
          clearInterval(iv);
          if (this._phoneRingPending) this.startPhoneRing();
        } else if (tries > 30) {
          clearInterval(iv);   // ~3s -- give up, no asset available
        }
      }, 100);
      return;
    }
    this._phoneRingPending = false;
    this._phoneRingEl.volume = this._effectiveSfxVolume();
    try {
      this._phoneRingEl.currentTime = 0;
      const p = this._phoneRingEl.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  /** Stop the phone ring (accepted/declined or call timed out). */
  stopPhoneRing() {
    this._phoneRingPending = false;
    if (!this._phoneRingEl) return;
    try {
      this._phoneRingEl.pause();
      this._phoneRingEl.currentTime = 0;
    } catch (e) {}
  }

  // ---------------------------------------------------------------
  // C-DRONE (MP3)   - ambient bed layered with the phone ring
  // ---------------------------------------------------------------

  /** Start the looping C-drone. Safe to call before the asset has loaded;
   *  the play will be queued and fire on `canplaythrough`. */
  startCDrone() {
    if (!this.ctx) this.init();
    if (!this._cDroneEl) {
      this._cDronePending = true;
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        if (this._cDroneEl) {
          clearInterval(iv);
          if (this._cDronePending) this.startCDrone();
        } else if (tries > 30) {
          clearInterval(iv);   // ~3s -- give up, no asset available
        }
      }, 100);
      return;
    }
    this._cDronePending = false;
    this._cDroneEl.volume = this._effectiveSfxVolume();
    try {
      this._cDroneEl.currentTime = 0;
      const p = this._cDroneEl.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  /** Stop the C-drone. Mirrors stopPhoneRing() semantics. */
  stopCDrone() {
    this._cDronePending = false;
    if (!this._cDroneEl) return;
    try {
      this._cDroneEl.pause();
      this._cDroneEl.currentTime = 0;
    } catch (e) {}
  }

  // ---------------------------------------------------------------
  // PROCEDURAL SFX (unchanged from the original audio engine)
  // ---------------------------------------------------------------

  _beep(opts) {
    if (!this.ctx || this.muted) return;
    const { type = 'square', freqStart, freqEnd, dur = 0.1, gainStart = 0.15, delay = 0 } = opts;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    gain.gain.setValueAtTime(gainStart, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain); gain.connect(this.sfxGain);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  _noise(dur, cutoff, gain) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    const filt = this.ctx.createBiquadFilter();
    src.buffer = buf;
    filt.type = 'lowpass';
    filt.frequency.value = cutoff;
    g.gain.value = gain;
    src.connect(filt); filt.connect(g); g.connect(this.sfxGain);
    src.start(t);
  }

  shot(weapon = 'pistol') {
    if (weapon === 'shotgun') {
      this._noise(0.15, 600, 0.25);
      this._beep({ type: 'sawtooth', freqStart: 120, freqEnd: 40, dur: 0.15, gainStart: 0.25 });
    } else if (weapon === 'smg') {
      this._beep({ type: 'square', freqStart: 1200, freqEnd: 400, dur: 0.04, gainStart: 0.1 });
    } else if (weapon === 'sniper' || weapon === 'raygun') {
      this._beep({ type: 'sawtooth', freqStart: 300, freqEnd: 80, dur: 0.3, gainStart: 0.3 });
      this._noise(0.08, 2000, 0.2);
    } else if (weapon === 'pickaxe') {
      this._beep({ type: 'triangle', freqStart: 180, freqEnd: 90, dur: 0.12, gainStart: 0.2 });
      this._noise(0.06, 500, 0.15);
    } else {
      this._beep({ type: 'square', freqStart: 880, freqEnd: 110, dur: 0.08, gainStart: 0.15 });
    }
  }

  hit() { this._noise(0.08, 1800, 0.2); }

  kill() {
    this._beep({ type: 'sawtooth', freqStart: 200, freqEnd: 40, dur: 0.25, gainStart: 0.18 });
    this._noise(0.12, 300, 0.15);
  }

  pickup() { this._beep({ type: 'triangle', freqStart: 660, freqEnd: 1320, dur: 0.08, gainStart: 0.12 }); }

  levelup() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      this._beep({ type: 'triangle', freqStart: f, dur: 0.25, gainStart: 0.15, delay: i * 0.08 })
    );
  }

  damage() { this._beep({ type: 'square', freqStart: 180, freqEnd: 40, dur: 0.2, gainStart: 0.22 }); }

  // Shield deflect — played every time a bullet or rocket hits an intact
  // hive shield. Three layers:
  //   1. A quick high-to-low sine sweep (the "bwoop" of energy being
  //      absorbed by the field).
  //   2. A short filtered noise burst for the electric sizzle.
  //   3. A brief ringing square tone an octave up, delayed by 20ms,
  //      that gives the deflect a metallic "clink" on top of the sizzle.
  // Low overall gain (0.10-0.14) so rapid bullet fire stays pleasant
  // and doesn't drown out combat sounds. Short duration (~110ms total)
  // so it sits cleanly over pistol/SMG fire rates.
  shieldHit() {
    this._beep({ type: 'sine', freqStart: 900, freqEnd: 420, dur: 0.09, gainStart: 0.14 });
    this._noise(0.06, 3000, 0.08);
    this._beep({ type: 'square', freqStart: 1600, freqEnd: 1200, dur: 0.06, gainStart: 0.06, delay: 0.02 });
  }

  // Radio-tower charging beep — plays once per dish rotation while the
  // RADIO power-up zone is active. Single short pure-tone blip — the
  // classic "transmitting carrier wave" sound. Two-tone (a short low
  // pulse followed by a higher pulse) so consecutive beeps don't sound
  // monotonous if the player is parked in the zone for a while.
  radioBeep() {
    this._beep({ type: 'sine', freqStart: 760, dur: 0.06, gainStart: 0.08 });
    this._beep({ type: 'sine', freqStart: 1180, dur: 0.06, gainStart: 0.06, delay: 0.08 });
  }

  // ---- GALAGA / CHAPTER 2 SFX ----
  // Bug spawn whir — quiet ascending tone, plays each time a new bug
  // enters the arena. Kept very short and low-volume so 5 bugs
  // spawning in succession doesn't drown out other sounds.
  bugWhir() {
    this._beep({ type: 'sine', freqStart: 220, freqEnd: 380, dur: 0.10, gainStart: 0.04 });
  }

  // Bug damaged but not killed — sharp pop, used for ship-bullet hits.
  bugHit() {
    this._beep({ type: 'square', freqStart: 1400, freqEnd: 800, dur: 0.05, gainStart: 0.06 });
  }

  // Bug killed — burst sound, two-layer (noise + low pop) for impact.
  bugDeath() {
    this._noise(0.12, 1200, 0.18);
    this._beep({ type: 'sawtooth', freqStart: 280, freqEnd: 80, dur: 0.14, gainStart: 0.15 });
  }

  // Galaga ship fires — quick chirp, classic arcade pew. Slightly
  // higher pitch than the player's pistol so they're distinguishable.
  galagaShipFire() {
    this._beep({ type: 'square', freqStart: 1800, freqEnd: 2400, dur: 0.05, gainStart: 0.07 });
  }

  // ---- MINESWEEPER / CHAPTER 3 SFX ----
  // Pointer descending — thin metallic whoosh, plays when a new pointer
  // begins extending from the sky. Sine sweep from low to mid creates
  // the "telescoping pole" sensation.
  pointerDescend() {
    this._beep({ type: 'sine', freqStart: 200, freqEnd: 380, dur: 0.20, gainStart: 0.05 });
    this._noise(0.08, 1800, 0.04);
  }

  // Cell revealed (safe) — soft mechanical click, low volume.
  // Multiple cells revealing in succession should feel "snappy" not noisy.
  cellRevealed() {
    this._beep({ type: 'square', freqStart: 1200, freqEnd: 1800, dur: 0.04, gainStart: 0.04 });
  }

  // Bomb flag planted — heavier thunk + low boom hint, signals "danger here."
  // Distinct from cellRevealed so the player can audibly distinguish the
  // bad reveal from a safe reveal even without looking.
  bombFlagPlanted() {
    this._beep({ type: 'sawtooth', freqStart: 90, freqEnd: 50, dur: 0.18, gainStart: 0.12 });
    this._noise(0.10, 700, 0.08);
    this._beep({ type: 'square', freqStart: 320, freqEnd: 220, dur: 0.10, gainStart: 0.06, delay: 0.04 });
  }

  // ---- PAC-MAN / CHAPTER 4 SFX ----
  // Power pellet eaten — classic Pac-Man "bwoop" rising/falling tone.
  // Triggers when Pac-Man walks over a pellet; signals ghosts going blue.
  pelletEaten() {
    this._beep({ type: 'square', freqStart: 320, freqEnd: 880, dur: 0.10, gainStart: 0.10 });
    this._beep({ type: 'sine',  freqStart: 660, freqEnd: 440, dur: 0.12, gainStart: 0.08, delay: 0.05 });
  }

  // Ghost eaten — ascending arpeggio, "bonus points" feel.
  ghostEaten() {
    this._beep({ type: 'square', freqStart: 480, dur: 0.06, gainStart: 0.10 });
    this._beep({ type: 'square', freqStart: 720, dur: 0.06, gainStart: 0.10, delay: 0.06 });
    this._beep({ type: 'square', freqStart: 1080, dur: 0.08, gainStart: 0.10, delay: 0.12 });
  }

  bigBoom() {
    this._noise(0.6, 200, 0.5);
    this._beep({ type: 'sawtooth', freqStart: 80, freqEnd: 20, dur: 0.5, gainStart: 0.4 });
    this._beep({ type: 'sawtooth', freqStart: 150, freqEnd: 30, dur: 0.6, gainStart: 0.3, delay: 0.05 });
  }

  // ---- CHAPTER 1 REFLOW SFX ----

  // Egg hit — light tap on the gobstopper shell, plays on every
  // bullet that lands. Audible above the gun stack so the player
  // knows their shots are connecting (was 0.05 originally — too
  // quiet to hear during a 20-shot break).
  eggHit() {
    this._noise(0.06, 2400, 0.20);
    this._beep({ type: 'triangle', freqStart: 880, freqEnd: 660, dur: 0.06, gainStart: 0.18 });
  }

  // Egg shatter — the gobstopper finally cracks open. Bigger than
  // eggHit but smaller than a block explosion. Mid-frequency noise
  // burst + tonal sweep down for a "glassy crack" feel.
  eggShatter() {
    this._noise(0.18, 1400, 0.22);
    this._beep({ type: 'triangle', freqStart: 1200, freqEnd: 220, dur: 0.18, gainStart: 0.18 });
    this._beep({ type: 'sawtooth', freqStart: 320, freqEnd: 80, dur: 0.20, gainStart: 0.10, delay: 0.04 });
  }

  // Crusher slam — heavy mechanical impact. Low-end thunk + metallic
  // clang on top. Reads as "industrial press" not "explosion."
  // Per-deposit slam in chapter 1 wave 1.
  crusherSlam() {
    // Low boom — the impact body
    this._noise(0.20, 220, 0.32);
    this._beep({ type: 'sawtooth', freqStart: 90, freqEnd: 35, dur: 0.22, gainStart: 0.30 });
    // Metallic clang on top — short bright tone
    this._beep({ type: 'square', freqStart: 1800, freqEnd: 1200, dur: 0.06, gainStart: 0.10, delay: 0.02 });
    this._beep({ type: 'square', freqStart: 1100, freqEnd: 700, dur: 0.10, gainStart: 0.08, delay: 0.04 });
  }

  // Cannon fire — chunky barrage shot. Bigger than a rocket, smaller
  // than bigBoom. Each chapter-1 wave-2 shot at the queen.
  cannonFire() {
    // Initial crack — short bright noise to read as "muzzle"
    this._noise(0.08, 1200, 0.30);
    // Body — sawtooth descending hit
    this._beep({ type: 'sawtooth', freqStart: 180, freqEnd: 50, dur: 0.35, gainStart: 0.35 });
    // Low tail — rolling thunder
    this._beep({ type: 'sawtooth', freqStart: 100, freqEnd: 30, dur: 0.45, gainStart: 0.22, delay: 0.04 });
    // Mid-range punch
    this._beep({ type: 'square', freqStart: 380, freqEnd: 120, dur: 0.18, gainStart: 0.14, delay: 0.02 });
  }

  // Cannon charging tick — short ascending hum, played periodically
  // (every ~0.4s) by waves.js while the cannon charge is climbing.
  // Pitch ramps with progress so the player audibly hears the charge
  // building. Quiet so it stacks under combat sounds but distinct.
  cannonChargingTick(progress = 0) {
    const p = Math.max(0, Math.min(1, progress));
    const f0 = 180 + p * 400;       // 180..580 Hz
    const f1 = 240 + p * 600;       // 240..840 Hz
    this._beep({ type: 'sine', freqStart: f0, freqEnd: f1, dur: 0.18, gainStart: 0.10 });
    this._beep({ type: 'triangle', freqStart: f0 * 2, freqEnd: f1 * 2, dur: 0.10, gainStart: 0.05, delay: 0.04 });
  }

  // Truck decompression — pneumatic hiss + heavy settle thud, played
  // when the chapter 2 escort truck arrives at the silo. Reads as
  // "industrial vehicle docking + air brakes releasing."
  truckDecompression() {
    // Long airy hiss (pneumatic release)
    this._noise(0.55, 4200, 0.30);
    // Mid-pitch settle whine descending
    this._beep({ type: 'sawtooth', freqStart: 220, freqEnd: 80, dur: 0.50, gainStart: 0.18 });
    // Heavy chassis thud landing
    this._beep({ type: 'sawtooth', freqStart: 70, freqEnd: 30, dur: 0.40, gainStart: 0.30, delay: 0.10 });
    // Secondary metallic clank — the dock connector seating
    this._beep({ type: 'square', freqStart: 1400, freqEnd: 800, dur: 0.08, gainStart: 0.12, delay: 0.20 });
  }

  // Server online — cluster of soft beeps as system squares light up.
  // Triggered when the player completes the charge zone in chapter 2 wave 2.
  serverOnline() {
    // Layered ascending beeps — reads as "system booting"
    this._beep({ type: 'square', freqStart: 660, dur: 0.06, gainStart: 0.12 });
    this._beep({ type: 'square', freqStart: 880, dur: 0.06, gainStart: 0.12, delay: 0.08 });
    this._beep({ type: 'square', freqStart: 1320, dur: 0.06, gainStart: 0.12, delay: 0.16 });
    this._beep({ type: 'triangle', freqStart: 1760, dur: 0.10, gainStart: 0.14, delay: 0.24 });
  }

  // Laser charging — long ominous rising hum that builds during the
  // 3s telegraph. Tells the player "something big is about to fire."
  laserCharging() {
    // Single long rising tone, quiet at start escalating to bright
    this._beep({ type: 'sawtooth', freqStart: 60, freqEnd: 220, dur: 2.8, gainStart: 0.12 });
    this._beep({ type: 'square', freqStart: 90, freqEnd: 320, dur: 2.8, gainStart: 0.10, delay: 0.05 });
    // Subtle noise crackle for "energy build-up" feel
    this._noise(2.6, 1800, 0.06);
  }

  // Laser blast — huge electric crackle when the beam fires.
  // Loud, percussive, distinct from regular bigBoom.
  laserBlast() {
    // Massive noise burst — the column-of-light arriving
    this._noise(0.7, 800, 0.55);
    // High-pitched zap on top
    this._beep({ type: 'sawtooth', freqStart: 1800, freqEnd: 600, dur: 0.18, gainStart: 0.40 });
    // Mid-range body
    this._beep({ type: 'square', freqStart: 600, freqEnd: 200, dur: 0.40, gainStart: 0.32, delay: 0.04 });
    // Low rumbling tail
    this._beep({ type: 'sawtooth', freqStart: 120, freqEnd: 35, dur: 0.80, gainStart: 0.30, delay: 0.10 });
  }

  countdown() { this._beep({ type: 'square', freqStart: 440, dur: 0.12, gainStart: 0.18 }); }
  waveStart() {
    [523, 659, 784, 1047, 1319].forEach((f, i) =>
      this._beep({ type: 'square', freqStart: f, dur: 0.15, gainStart: 0.18, delay: i * 0.05 })
    );
  }

  weaponGet() {
    [440, 554, 659, 880].forEach((f, i) =>
      this._beep({ type: 'triangle', freqStart: f, dur: 0.2, gainStart: 0.18, delay: i * 0.06 })
    );
  }

  // Bonus wave: each time a herd meebit is caught. A fun, quick 3-note
  // rising arpeggio (Mario-coin style) plus a subtle high "sparkle" chirp
  // so rapid catches feel rewarding without becoming fatiguing.
  // Kept short (~160ms total) and at modest gain so catching 10 in a row
  // stacks musically instead of into noise.
  bonusCatch() {
    // 3-note rising arpeggio — G5, C6, E6
    [783.99, 1046.5, 1318.5].forEach((f, i) =>
      this._beep({ type: 'triangle', freqStart: f, dur: 0.07, gainStart: 0.13, delay: i * 0.04 })
    );
    // Sparkle on top
    this._beep({ type: 'sine', freqStart: 2093, freqEnd: 2637, dur: 0.12, gainStart: 0.06, delay: 0.08 });
  }

  // Hyperdrive RAIN — plays when the player clicks ATTACK THE AI and the
  // rain-splat overlay takes over the screen.
  //
  // Instead of the old spaceship-engine sweep, this produces a pattering
  // rain sound that matches the intensifying-splats visual. Built from
  // many small filtered noise bursts spawned at an increasing rate:
  //
  //   t=0.0–2.0s   Gentle patter — ~15 drops/sec, quiet, bright filter
  //                so each drop reads as an individual tick.
  //   t=2.0–4.5s   Moderate rain — ~45/sec, slightly louder.
  //   t=4.5–6.5s   Heavy downpour — ~100/sec, lower filter (muffled,
  //                thicker body).
  //   t=6.5–7.5s   Torrential — ~200/sec.
  //   t=7.5s       Punch transient — lightning-crack style noise hit
  //                + low thud + high click. Lines up with the visual
  //                white flash.
  //
  // Underneath the whole thing runs a low 60Hz sine drone that swells
  // gently so the rain has a bass bed to sit on.
  hyperdriveRain() {
    if (!this.ctx || this.muted) return;

    // LAYER 1 — sub-bass drone, 3s. Gentle swell to match the shorter
    // visual sequence (was 7.5s).
    this._beep({ type: 'sine', freqStart: 55, freqEnd: 75, dur: 3.0, gainStart: 0.08 });

    // LAYER 2 — rain drops. We schedule individual noise bursts across
    // the 3s timeline. Drop rates are pushed up so the rain density per
    // second is higher than before — short window, dense audio.
    //
    // Each "drop" is a 20-40ms lowpass-filtered noise burst. Lower
    // cutoff = muffled (thicker rain), higher cutoff = sharp (individual
    // ticks). We vary cutoff randomly each drop so no two sound the same.
    const scheduleDrops = (startMs, endMs, dropsPerSec, baseGain, minCut, maxCut) => {
      const totalDrops = Math.round(((endMs - startMs) / 1000) * dropsPerSec);
      for (let i = 0; i < totalDrops; i++) {
        const dly = startMs + (i / totalDrops) * (endMs - startMs);
        setTimeout(() => {
          if (!this.ctx || this.muted) return;
          const cut = minCut + Math.random() * (maxCut - minCut);
          const gain = baseGain * (0.6 + Math.random() * 0.4);
          const dur = 0.025 + Math.random() * 0.035;
          this._noise(dur, cut, gain);
        }, dly);
      }
    };

    // Phase rates retimed to fit the 3s window. Phase widths roughly
    // match the visual splat curve: ~25% gentle / ~32% moderate /
    // ~25% heavy / ~12% torrential, ending at the punch (2800ms).
    scheduleDrops(0,    750,  30,  0.08, 1800, 6000);   // gentle patter
    scheduleDrops(750,  1700, 90,  0.10, 1400, 5000);   // moderate
    scheduleDrops(1700, 2450, 200, 0.12, 900,  4000);   // heavy
    scheduleDrops(2450, 2800, 400, 0.14, 500,  3000);   // torrential

    // LAYER 3 — PUNCH at t=2.8s. Thunder-crack transient that cues the
    // white flash. Same intensity as before, just earlier.
    setTimeout(() => {
      this._noise(0.2, 2500, 0.55);                    // crack
      this._beep({ type: 'sawtooth', freqStart: 180, freqEnd: 40, dur: 0.35, gainStart: 0.5 });  // thud
      this._beep({ type: 'square', freqStart: 2800, freqEnd: 600, dur: 0.08, gainStart: 0.18 }); // high click
    }, 2800);
  }
}

export const Audio = new AudioEngine();
