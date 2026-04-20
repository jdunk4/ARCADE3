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
//   Arena I.mp3, Arena II.mp3, Arena III.mp3, Arena IV.mp3
//   PHONE RINGS.mp3

const SOUNDTRACK_FILES = [
  'assets/Arena I.mp3',
  'assets/Arena II.mp3',
  'assets/Arena III.mp3',
  'assets/Arena IV.mp3',
];
// The phone-ring asset has shipped under several names in this project.
// We try them in order until one loads; whichever works becomes the source.
const PHONE_RING_CANDIDATES = [
  'assets/PHONE RINGS.mp3',
  'assets/phone_ring.mp3',
  'assets/Phone Ring.mp3',
  'assets/phone-ring.mp3',
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
    this._persist();
  }
  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    for (const el of this._trackEls) el.volume = this._effectiveMusicVolume();
    this._persist();
  }
  setMuted(m) {
    this.muted = !!m;
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : 1;
    for (const el of this._trackEls) el.volume = this._effectiveMusicVolume();
    if (this._phoneRingEl) this._phoneRingEl.volume = this._effectiveSfxVolume();
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
   * Arena I -> II -> III -> IV -> I -> ... indefinitely.
   * The `wave` argument is kept for backward compatibility but no longer
   * tied to gameplay -- calling with no args (or wave=1) starts from Arena I.
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

  /** True if a music track is currently active (for callers that want to
   *  avoid restarting music mid-session). */
  isPlaying() {
    if (!this._musicOn) return false;
    if (this._currentTrackIdx < 0) return false;
    const el = this._trackEls[this._currentTrackIdx];
    if (!el) return false;
    return !el.paused;
  }

  /** Explicitly switch to a track by index (0..3), cycling. */
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

  bigBoom() {
    this._noise(0.6, 200, 0.5);
    this._beep({ type: 'sawtooth', freqStart: 80, freqEnd: 20, dur: 0.5, gainStart: 0.4 });
    this._beep({ type: 'sawtooth', freqStart: 150, freqEnd: 30, dur: 0.6, gainStart: 0.3, delay: 0.05 });
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
}

export const Audio = new AudioEngine();
