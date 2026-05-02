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
//   TheOtherSide.mp3 — penultimate track, slots in just before Underworld
//   Underworld.mp3 — closing track (chapter 7 / late-game)
//   PHONE RINGS.mp3
//   C-drone.mp3   (ambient drone layered UNDER the phone ring during the
//                  matrix-dive so the ring doesn't feel naked)
//
// Playlist sections (indexes into SOUNDTRACK_FILES below):
//   • 'main' — chapters 1-6 rotation:
//     AwakenArena → Arena I → II → III → IV → XIAN → YOMI → ZION → loop back
//   • 'paradise_fallen' — chapter 7 rotation (revealed only after the
//     player completes chapter 6 and steps into chapter 7):
//     TheOtherSide → Underworld → loop back
//
// The MAIN section deliberately stops short at ZION; TheOtherSide and
// Underworld are saved as a "second-half-of-the-game" reward so that
// stepping into chapter 7 brings a fresh sound palette the player
// hasn't heard yet. main.js calls Audio.setMusicSection('paradise_fallen')
// from the chapter-7-entry block; startGame resets back to 'main'.

const SOUNDTRACK_FILES = [
  'assets/AwakenArena.mp3',     // 0
  'assets/Arena I.mp3',         // 1
  'assets/Arena II.mp3',        // 2
  'assets/Arena III.mp3',       // 3
  'assets/Arena IV.mp3',        // 4
  'assets/XIAN.mp3',            // 5
  'assets/YOMI.mp3',            // 6
  'assets/ZION.mp3',            // 7
  'assets/TheOtherSide.mp3',    // 8 — chapter-7 only
  'assets/Underworld.mp3',      // 9 — chapter-7 only
];

// Section → ordered list of indexes into SOUNDTRACK_FILES. Auto-advance
// walks within the active section's list and loops back to its first
// entry, so playing chapters 1-6 will never spill into the chapter-7
// tracks even if the player camps on a single chapter for a long time.
const MUSIC_SECTIONS = {
  main:             [0, 1, 2, 3, 4, 5, 6, 7],
  paradise_fallen:  [8, 9],
  // Endless Glyphs cycles the boss-faction tracks (XIAN, YOMI, ZION)
  // — high-energy combat loops that match the mode's escalating
  // wave structure. Per playtester: "For the endless glyphs
  // soundtrack can we cycle xian, yomi, and zion music queues?"
  endless_glyphs:   [5, 6, 7],
};
const DEFAULT_MUSIC_SECTION = 'main';

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
    // Active playlist section. Defines which subset of SOUNDTRACK_FILES
    // is in rotation right now and therefore what the auto-advance
    // ('ended' handler on each track) walks through. Switched via
    // setMusicSection(); see MUSIC_SECTIONS table at module top. Default
    // is the main chapter-1-to-6 rotation.
    this._currentSection = DEFAULT_MUSIC_SECTION;

    // Phone ring
    this._phoneRingEl = null;

    // C-drone (ambient bed under the phone ring)
    this._cDroneEl = null;
    this._cDronePending = false;

    // Music visualizer plumbing — lazily wired only when something
    // (pause-menu visualizer) requests an analyser. Connecting an
    // HTMLAudioElement to a MediaElementSourceNode silences its
    // direct output and routes audio through Web Audio instead, so
    // this is a one-way switch we only flip if we have to.
    //   _analyser        — shared AnalyserNode, FFT 1024
    //   _trackSources    — Map<HTMLAudioElement, MediaElementAudioSourceNode>
    //                      so we never double-connect (a second source
    //                      on the same element throws InvalidStateError)
    //   _analyserEnabled — true once at least one source has been hooked
    this._analyser = null;
    this._trackSources = new Map();
    this._analyserEnabled = false;
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
        // When this track ends, advance to the next track in the
        // CURRENT SECTION, not the global playlist. This is how
        // TheOtherSide + Underworld stay locked behind chapter 7 even
        // when the chapter-1-6 playlist rolls around its end —
        // looping the 'main' section sends us back to AwakenArena
        // rather than spilling into the chapter-7-exclusive tracks.
        el.addEventListener('ended', () => {
          // Only auto-advance if music is still enabled and this is the active track
          if (!this._musicOn) return;
          if (this._currentTrackIdx !== i) return;
          const section = MUSIC_SECTIONS[this._currentSection] || MUSIC_SECTIONS[DEFAULT_MUSIC_SECTION];
          if (!section || !section.length) return;
          // Find this track's position in the section list. If it's
          // not in the current section (e.g. section was just changed
          // mid-track), bail to the section's first entry rather than
          // trying to compute a "next" relative to a non-member.
          const posInSection = section.indexOf(i);
          let nextIdx;
          if (posInSection < 0) {
            nextIdx = section[0];
          } else {
            nextIdx = section[(posInSection + 1) % section.length];
          }
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
   * Start the soundtrack in playlist mode within the active section.
   * Sections (set via setMusicSection):
   *   • 'main'            — chapters 1-6: AwakenArena → ... → ZION → loop
   *   • 'paradise_fallen' — chapter 7:    TheOtherSide → Underworld → loop
   *
   * The `wave` argument is kept for backward compatibility. When given,
   * it picks an entry within the active section (modulo the section
   * length), so `startMusic(1)` always plays the section's first track.
   * Calling with no args resumes the current track (or starts the
   * section's first track if nothing's been played yet).
   */
  startMusic(wave) {
    if (!this.ctx) this.init();
    if (this._trackEls.length === 0) return;
    const section = MUSIC_SECTIONS[this._currentSection] || MUSIC_SECTIONS[DEFAULT_MUSIC_SECTION];
    if (!section || !section.length) return;

    let idx;
    if (typeof wave === 'number' && wave > 0) {
      // Pick the (wave-1)th entry of the active section. So
      // startMusic(1) always plays the section's opener — for 'main'
      // that's AwakenArena; for 'paradise_fallen' that's TheOtherSide.
      idx = section[(wave - 1) % section.length];
    } else if (this._currentTrackIdx >= 0 && section.indexOf(this._currentTrackIdx) >= 0) {
      // Resume current track only if it's a member of the active
      // section. If we just switched sections (e.g. into chapter 7),
      // _currentTrackIdx still points at the previous section's track
      // and we want to start fresh on the new section's opener
      // instead.
      idx = this._currentTrackIdx;
    } else {
      idx = section[0];
    }

    this._musicOn = true;
    this._playTrackAt(idx, /*fadeIn*/ true);
  }

  /**
   * Switch the active playlist section. Called from main.js's
   * chapter-7-entry block to unlock the chapter-7 soundtrack
   * (TheOtherSide + Underworld), and called again at start-of-run
   * to reset back to the main section. If the currently playing
   * track is not a member of the new section, we fade out and
   * start the new section's opener; if it IS a member (or no track
   * is playing) we leave playback alone — auto-advance will pick
   * up the new section on the next 'ended' event.
   */
  setMusicSection(name) {
    if (!MUSIC_SECTIONS[name]) {
      console.warn('[audio] unknown music section:', name);
      return;
    }
    if (this._currentSection === name) return;       // no-op
    this._currentSection = name;
    if (!this._musicOn) return;                      // nothing to swap right now
    const section = MUSIC_SECTIONS[name];
    if (!section.length) return;
    // Is the active track still appropriate for the new section?
    if (this._currentTrackIdx >= 0 && section.indexOf(this._currentTrackIdx) >= 0) {
      // The current track is a member of the new section — let it
      // finish; auto-advance will then walk the new section.
      return;
    }
    // Otherwise swap to the new section's opener with a smooth
    // crossfade. _playTrackAt fades out the old element internally.
    this._playTrackAt(section[0], /*fadeIn*/ true);
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
        // If the analyser already exists (e.g. the player paused once
        // already, which lazy-builds the analyser on first show), hook
        // this newly-created tutorial element into it now so the
        // pause-screen visualizer responds in tutorial mode. The
        // analyser-creation path also hooks _tutorialMusicEl if it
        // exists at THAT time, so the two paths cover both init orders.
        if (this._analyser) this._hookTrackToAnalyser(el);
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

  // ---------------------------------------------------------------
  // DEATH MUSIC — independent track that plays on the SIGNAL LOST
  // (game-over) screen and the tutorial-respawn moment of failure.
  // Uses Beyond.mp3, lazy-loaded on first call. Mirrors the
  // tutorial-music pattern: dedicated HTMLAudioElement so it can
  // run independent of the chapter playlist, and the playlist is
  // stopped on entry so the death track plays alone. Loops while
  // the death screen is up — the user explicitly wants the song to
  // continue until the player either restarts or returns to title.
  // ---------------------------------------------------------------
  startDeathMusic() {
    if (!this.ctx) this.init();
    // Lazy-load on first call — same pattern as TeachingWar.mp3 above.
    if (!this._deathMusicEl) {
      try {
        const el = new HTMLAudio('assets/Beyond.mp3');
        el.preload = 'auto';
        el.loop = true;             // loop indefinitely while the death screen is up
        el.volume = this._effectiveMusicVolume();
        this._deathMusicEl = el;
        // Hook into the analyser if it already exists. Same reasoning
        // as the tutorial-music path — covers the case where the
        // pause/visualizer was opened before death-music ever loaded.
        if (this._analyser) this._hookTrackToAnalyser(el);
      } catch (e) {
        console.warn('[audio] Beyond.mp3 failed to load', e);
        return;
      }
    }
    // Stop other music streams so the death track plays cleanly. We
    // explicitly stop both the chapter playlist AND the tutorial loop
    // — death can happen during the tutorial too (the tutorial does
    // not currently route to game-over, but we defend the case anyway
    // so this method is safe to call from any path).
    this.stopMusic();
    this.stopTutorialMusic();
    this._musicOn = true;
    const el = this._deathMusicEl;
    try {
      el.currentTime = 0;
      el.volume = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    this._fadeIn(el, this._effectiveMusicVolume(), 0.8);
  }

  stopDeathMusic() {
    if (!this._deathMusicEl) return;
    this._fadeOutAndPause(this._deathMusicEl);
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

  // Blueprint pickup snap — a quick percussive "click" plus a short
  // electronic ping on top, like a tablet locking in a new schematic.
  // Two layers: a noise burst with a band-pass filter (the snap), and
  // a short high-frequency tonal beep (the lock-in confirm).
  blueprintSnap() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    // -- Layer 1: noise click (the snap) --
    // 30ms of band-passed noise at ~3kHz. Sharp, percussive, no tail.
    const SNAP_DUR = 0.04;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * SNAP_DUR, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 3200;
    filt.Q.value = 5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.20, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + SNAP_DUR);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
    src.stop(t + SNAP_DUR + 0.02);
    // -- Layer 2: lock-in ping --
    // Brief sine sweep from 1.6kHz to 2.4kHz for the digital "got it"
    // confirmation, slightly delayed so it sits just behind the snap.
    this._beep({
      type: 'sine',
      freqStart: 1600, freqEnd: 2400,
      dur: 0.10, gainStart: 0.14,
      delay: 0.02,
    });
  }

  levelup() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      this._beep({ type: 'triangle', freqStart: f, dur: 0.25, gainStart: 0.15, delay: i * 0.08 })
    );
  }

  damage() { this._beep({ type: 'square', freqStart: 180, freqEnd: 40, dur: 0.2, gainStart: 0.22 }); }

  // Tutorial task-complete chime. Two ascending sine notes —
  // first an E5 (659 Hz), then a B5 (988 Hz) layered with a
  // brighter sine partial an octave up. The intent is the
  // "payment went through" / Apple Pay confirmation feel —
  // pleasant, brief, unmistakably positive. Uses sine waves
  // (not triangle) so the timbre is clean rather than buzzy
  // against the existing pickup/levelup palette. Total
  // duration ~280 ms so it lands cleanly between lessons
  // without dragging the pacing.
  taskComplete() {
    // First note — E5
    this._beep({ type: 'sine', freqStart: 659.25, dur: 0.12, gainStart: 0.18 });
    // Second note — B5, slightly delayed so the two register as
    // a deliberate two-step rather than a chord
    this._beep({ type: 'sine', freqStart: 987.77, dur: 0.18, gainStart: 0.18, delay: 0.10 });
    // Sparkle layer — a quieter octave above the second note for
    // brightness, makes it read as a "ding" rather than a "boop"
    this._beep({ type: 'sine', freqStart: 1975.53, dur: 0.14, gainStart: 0.07, delay: 0.10 });
  }

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

  // Truck startup — used to play an ignition crank when the truck
  // spawned, but per playtester request the cue was too noisy. Now
  // a no-op; the engine rumble (truckEngine) carries the audio
  // presence on its own once the truck starts moving.
  truckStart() {
    // Intentionally empty — see comment above.
  }

  // Truck engine rumble — a low, sustained diesel chug. Called every
  // ~0.5s by escortTruck.js's update tick while travelling.
  //
  // The previous implementation was two oscillators with steep gain
  // decay (`exponentialRampToValueAtTime` 0.20 → 0.001 over 0.55s) and
  // pitch ramps — a combination that lands as a percussive "boing"
  // envelope on a tone, repeating like a bouncing ball. Per playtester
  // feedback that's exactly how it sounded.
  //
  // The replacement uses LOW-CUT FILTERED NOISE (real diesel idle is
  // broadband rumble, not pure tones) with a flat-sustain envelope
  // (slow attack, flat middle, slow release) so it reads as a chuggy
  // engine rather than a discrete musical event. Volume is dropped
  // significantly so it sits well under combat audio.
  truckEngine(moving = true) {
    if (!moving) return;
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const DUR = 0.55;
    // Low-passed noise burst — this is the engine "body". Cutoff at
    // 180 Hz keeps it strictly in the rumble band; anything brighter
    // and it would compete with combat sfx. Buffer is filled with
    // amplitude-decaying noise but the real envelope shape comes from
    // the gain node below.
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * DUR, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 180;       // strictly low rumble; no tonal "boing"
    filt.Q.value = 0.4;
    const g = this.ctx.createGain();
    // Slow attack (120ms), flat sustain (~0.20s at peak), slow release
    // (230ms). Linear ramps — exponential ramps were what made the
    // previous version read as percussive. Peak gain 0.06 — about
    // 1/3 the previous level, so it sits unobtrusively in the mix.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.12);
    g.gain.setValueAtTime(0.06, t + 0.32);
    g.gain.linearRampToValueAtTime(0.0001, t + DUR);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
    src.stop(t + DUR + 0.05);
    // A whisper of mid-range body so the rumble has SHAPE, not just
    // bottom-end mush. Single sawtooth at 90 Hz with a gentle envelope
    // of its own — just enough to give the noise a sense of pitch
    // without becoming the dominant tone.
    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(90, t);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.025, t + 0.14);
    og.gain.setValueAtTime(0.025, t + 0.30);
    og.gain.linearRampToValueAtTime(0.0001, t + DUR);
    osc.connect(og);
    og.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + DUR + 0.05);
  }

  // Truck arrival — cork pop. Sharp pitch-dropping "THOCK" + tiny
  // fizz tail, reads as a champagne or soda bottle being uncorked.
  // Replaces the old multi-layer "industrial decompression + fanfare"
  // cue per playtester request — the player wanted something small
  // and satisfying, not a big celebration.
  truckDecompression() {
    // The pop itself — very fast pitch drop on a sine, plus a triangle
    // overtone for body. 80ms total so it reads as a single percussive
    // event, not a tone.
    this._beep({ type: 'sine',     freqStart: 800, freqEnd: 200, dur: 0.08, gainStart: 0.45 });
    this._beep({ type: 'triangle', freqStart: 1600, freqEnd: 400, dur: 0.06, gainStart: 0.20 });
    // Fizz tail — short bright noise burst, delayed via setTimeout
    // since _noise doesn't accept a delay arg. Reads as pressure
    // escaping / carbonation hiss after the cork releases.
    const self = this;
    setTimeout(() => { self._noise(0.18, 6500, 0.10); }, 60);
  }

  // Truck rolling start — used to play a gear-shift cue when the
  // truck transitioned from blocked to rolling. Per playtester
  // request the cue was too noisy and the engine rumble alone is
  // enough. Now a no-op.
  truckRollStart() {
    // Intentionally empty — see comment above.
  }

  // Cannon firing — the big chapter 2 wave 3 cannon's discharge.
  // Reads as a heavy energy weapon: low boom, mid-frequency punch,
  // high zap on top, all layered into one chunky shot. Loud enough
  // to register over combat sfx without dominating; the cannon is
  // a once-per-corner-charge event so we can afford something big.
  cannonFire() {
    // Big cannon shot — ENERGY-BEAM punch with heavy sub, mid bite,
    // and high-end sizzle. Volume bumped this pass: the cannon is a
    // once-per-corner-charge event so it can afford to be loud
    // without fatiguing the mix. Without the bump the shot was
    // landing under combat audio and reading as "did it fire?".
    //
    // Layered structure:
    //   - Sub-bass thump (sawtooth 110→25 Hz) — body of the shot
    //   - Mid-range punch (square 320→70 Hz) — gives it teeth
    //   - High zap (sawtooth 2200→500 Hz) — sells "energy weapon"
    //   - Front noise burst — explosive transient
    //   - Tail decay (triangle 480→160 Hz) — short zap fading out
    //   - Late thunder layer — extends the boom so the shot has
    //     real PRESENCE in the moment, not just a transient
    this._beep({ type: 'sawtooth', freqStart: 110, freqEnd: 25,  dur: 0.70, gainStart: 0.62 });
    this._beep({ type: 'square',   freqStart: 320, freqEnd: 70,  dur: 0.50, gainStart: 0.32 });
    this._beep({ type: 'sawtooth', freqStart: 2200, freqEnd: 500, dur: 0.22, gainStart: 0.28 });
    this._noise(0.20, 2400, 0.45);
    this._beep({ type: 'triangle', freqStart: 480, freqEnd: 160, dur: 0.40, gainStart: 0.18, delay: 0.14 });
    // Late thunder — a slow rumble layered under the tail to give
    // the shot a "rolling" feel rather than a sharp punch alone.
    this._beep({ type: 'sawtooth', freqStart: 80,  freqEnd: 28,  dur: 0.85, gainStart: 0.30, delay: 0.18 });
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

  // ----------------------------------------------------------------
  // VISUALIZER ANALYSER (pause-menu music visualizer)
  // ----------------------------------------------------------------

  /**
   * Lazily build (or return the existing) AnalyserNode hooked into
   * the soundtrack output. Caller passes nothing; gets back the
   * analyser ready to read getByteFrequencyData / getByteTimeDomainData.
   *
   * Wiring on first call:
   *   1. Build a single shared AnalyserNode (FFT 1024 → 512 bins)
   *   2. Create a MediaElementAudioSourceNode for every track that
   *      has been built so far, route source → analyser → masterGain
   *   3. Mark the engine as analyser-enabled so any future track
   *      (built by init() if it runs again) gets the same routing
   *
   * Connecting a MediaElementSource to an HTMLAudioElement silences
   * the element's direct output — audio now flows through Web Audio
   * instead. We connect the analyser to masterGain so playback
   * continues at the user-controlled volume.
   *
   * Returns null if the AudioContext failed to initialize (browser
   * doesn't support Web Audio).
   */
  // ---------------------------------------------------------------
  // STRATAGEM SFX
  // ---------------------------------------------------------------
  // All stratagem sounds are layered _beep + _noise calls so they
  // share the same procedural pipeline as the rest of the game.
  // Volumes are tuned slightly louder than the base SFX since these
  // are "moments" the player should feel.

  // Throwing the beacon — a thrown-grenade arc swoosh + soft thud.
  beaconThrow() {
    this._noise(0.18, 1200, 0.15);
    this._beep({ type: 'sawtooth', freqStart: 220, freqEnd: 90, dur: 0.18, gainStart: 0.10 });
  }

  // Beacon landing — heavier thud + electronic ping locking on.
  beaconLand() {
    this._noise(0.10, 400, 0.25);
    this._beep({ type: 'square', freqStart: 1320, freqEnd: 880, dur: 0.10, gainStart: 0.18 });
  }

  // Countdown beep — fired by the beacon every 1s as it ticks toward
  // payload deploy. Pitch rises with urgency (urgency 0..1).
  beaconCountdown(urgency = 0) {
    const f = 540 + urgency * 460;
    this._beep({ type: 'square', freqStart: f, dur: 0.06, gainStart: 0.12 });
  }

  // ---- THERMONUCLEAR ----
  // Massive low-end whoosh + tearing noise sweep, layered.
  nukeBlast() {
    this._noise(0.55, 250, 0.45);
    this._beep({ type: 'sawtooth', freqStart: 90, freqEnd: 28, dur: 0.55, gainStart: 0.36 });
    // Secondary "rolling" boom layer.
    setTimeout(() => {
      this._noise(0.40, 420, 0.30);
      this._beep({ type: 'sawtooth', freqStart: 60, freqEnd: 40, dur: 0.40, gainStart: 0.22 });
    }, 120);
  }

  // ---- MECH ----
  // Pop-out-of-ground rise — ascending whoosh + servo whir.
  mechRise() {
    this._beep({ type: 'sawtooth', freqStart: 120, freqEnd: 600, dur: 0.55, gainStart: 0.18 });
    this._noise(0.30, 800, 0.18);
  }

  // Heavy mech footfall + ground impact when the mech finishes its
  // rise animation. Used for landing the rise.
  mechLand() {
    this._noise(0.22, 350, 0.45);
    this._beep({ type: 'sawtooth', freqStart: 70, freqEnd: 30, dur: 0.22, gainStart: 0.32 });
  }

  // Mech minigun — short percussive pulse, called per shot.
  mechMg() {
    this._beep({ type: 'square', freqStart: 1100, freqEnd: 700, dur: 0.04, gainStart: 0.10 });
  }

  // Mech rocket launch — woosh + thump.
  mechRocket() {
    this._noise(0.12, 1000, 0.18);
    this._beep({ type: 'sawtooth', freqStart: 200, freqEnd: 60, dur: 0.12, gainStart: 0.16 });
  }

  // Mech flame — soft hissing whoosh, called per particle batch (the
  // flame variant calls this once per ~6 particles to avoid stacking).
  mechFlame() {
    this._noise(0.08, 1400, 0.10);
  }

  // Mech rocket / napalm impact (also reused for nuke rolling layer).
  mechRocketImpact() {
    this._noise(0.18, 600, 0.30);
    this._beep({ type: 'sawtooth', freqStart: 110, freqEnd: 40, dur: 0.18, gainStart: 0.20 });
  }

  // Mech destroyed — same pattern as nukeBlast but smaller.
  mechDestroyed() {
    this._noise(0.40, 400, 0.36);
    this._beep({ type: 'sawtooth', freqStart: 80, freqEnd: 30, dur: 0.40, gainStart: 0.28 });
  }

  // ---- TURRET ----
  turretDeploy() {
    // Mechanical clack + servo settle.
    this._noise(0.10, 1800, 0.18);
    this._beep({ type: 'square', freqStart: 600, freqEnd: 1200, dur: 0.10, gainStart: 0.14 });
    setTimeout(() => {
      this._beep({ type: 'square', freqStart: 1200, freqEnd: 800, dur: 0.06, gainStart: 0.12 });
    }, 120);
  }
  turretMg() {
    this._beep({ type: 'square', freqStart: 1500, freqEnd: 900, dur: 0.04, gainStart: 0.09 });
  }
  turretTesla() {
    // Crackling zap — brief sharp peak followed by buzzing tail.
    this._beep({ type: 'square', freqStart: 2400, freqEnd: 600, dur: 0.18, gainStart: 0.16 });
    this._noise(0.12, 3000, 0.10);
  }
  turretFlame() {
    this._noise(0.06, 1400, 0.08);
  }
  turretAntitank() {
    // Heavy tube launch — louder than mech rocket.
    this._noise(0.20, 600, 0.30);
    this._beep({ type: 'sawtooth', freqStart: 160, freqEnd: 40, dur: 0.20, gainStart: 0.26 });
  }
  turretDestroyed() {
    this._noise(0.20, 500, 0.25);
    this._beep({ type: 'sawtooth', freqStart: 130, freqEnd: 50, dur: 0.20, gainStart: 0.20 });
  }

  // ---- MINES ----
  // Drone whir — flying carrier that drops the mines. Looping-ish
  // whir sound; called once per mine drop with slight pitch jitter.
  mineDispenserWhir() {
    this._beep({ type: 'sawtooth', freqStart: 700 + Math.random() * 200, freqEnd: 500, dur: 0.10, gainStart: 0.06 });
  }
  // Mine arming click when it lands.
  mineArm() {
    this._beep({ type: 'square', freqStart: 1500, dur: 0.04, gainStart: 0.10 });
  }
  // Triggered beep — fast pulse during the warning window.
  mineBeep() {
    this._beep({ type: 'square', freqStart: 1800, dur: 0.04, gainStart: 0.14 });
  }
  // Detonation by kind — explosion is loud burst, fire is whooshier,
  // poison is a wet thump + hiss.
  mineDetonate(kind) {
    if (kind === 'fire') {
      this._noise(0.20, 900, 0.28);
      this._beep({ type: 'sawtooth', freqStart: 200, freqEnd: 60, dur: 0.20, gainStart: 0.22 });
    } else if (kind === 'poison') {
      this._noise(0.30, 1600, 0.22);
      this._beep({ type: 'sawtooth', freqStart: 320, freqEnd: 120, dur: 0.18, gainStart: 0.16 });
    } else {
      this._noise(0.18, 500, 0.32);
      this._beep({ type: 'sawtooth', freqStart: 150, freqEnd: 50, dur: 0.18, gainStart: 0.26 });
    }
  }

  // ---------------------------------------------------------------
  // RELOAD SFX
  // ---------------------------------------------------------------
  // Two-stage reload audio: reloadStart fires when the player begins
  // reloading (mag eject), reloadEnd fires when the reload completes
  // (mag slap / charging handle). Profiles vary per weapon so each
  // gun's rhythm reads differently — pistol is a quick click, shotgun
  // is a heavier ratchet, rocket has the deepest tube clunk, etc.
  reloadStart(weaponId) {
    switch (weaponId) {
      case 'pistol':
        this._beep({ type: 'square', freqStart: 360, freqEnd: 220, dur: 0.06, gainStart: 0.12 });
        this._noise(0.04, 1800, 0.10);
        break;
      case 'shotgun':
        // Pump action — first click of the slide.
        this._beep({ type: 'sawtooth', freqStart: 240, freqEnd: 140, dur: 0.10, gainStart: 0.14 });
        this._noise(0.08, 600, 0.18);
        break;
      case 'smg':
        // Quick mag drop.
        this._beep({ type: 'square', freqStart: 420, freqEnd: 200, dur: 0.07, gainStart: 0.12 });
        this._noise(0.06, 1500, 0.12);
        break;
      case 'rocket':
        // Heavy mechanical clunk.
        this._beep({ type: 'sawtooth', freqStart: 130, freqEnd: 60, dur: 0.16, gainStart: 0.20 });
        this._noise(0.12, 400, 0.20);
        break;
      case 'raygun':
        // Power-down hum.
        this._beep({ type: 'sine', freqStart: 880, freqEnd: 220, dur: 0.20, gainStart: 0.14 });
        break;
      case 'flamethrower':
        // Pressure release hiss.
        this._noise(0.18, 2400, 0.18);
        break;
      default:
        this._beep({ type: 'square', freqStart: 320, dur: 0.05, gainStart: 0.10 });
    }
  }
  reloadEnd(weaponId) {
    switch (weaponId) {
      case 'pistol':
        this._beep({ type: 'square', freqStart: 540, freqEnd: 720, dur: 0.06, gainStart: 0.14 });
        this._noise(0.04, 2200, 0.12);
        break;
      case 'shotgun':
        // Pump return — heavy slap.
        this._noise(0.10, 500, 0.30);
        this._beep({ type: 'sawtooth', freqStart: 160, freqEnd: 220, dur: 0.10, gainStart: 0.20 });
        break;
      case 'smg':
        // Mag slap + bolt release click.
        this._noise(0.05, 800, 0.20);
        this._beep({ type: 'square', freqStart: 800, freqEnd: 600, dur: 0.05, gainStart: 0.12 });
        break;
      case 'rocket':
        // Tube lock — heavy thunk.
        this._noise(0.14, 350, 0.30);
        this._beep({ type: 'sawtooth', freqStart: 100, freqEnd: 180, dur: 0.14, gainStart: 0.20 });
        break;
      case 'raygun':
        // Power-up whine, ascending.
        this._beep({ type: 'sine', freqStart: 220, freqEnd: 1200, dur: 0.32, gainStart: 0.16 });
        break;
      case 'flamethrower':
        // Pilot light ignition click + low whoosh.
        this._beep({ type: 'square', freqStart: 1400, dur: 0.04, gainStart: 0.14 });
        this._noise(0.10, 900, 0.15);
        break;
      default:
        this._beep({ type: 'square', freqStart: 540, dur: 0.05, gainStart: 0.12 });
    }
  }

  getOrCreateAnalyser() {
    if (this._analyser) return this._analyser;
    if (!this.ctx) this.init();
    if (!this.ctx) return null;
    try {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;       // 512 frequency bins, smooth at 60fps
      analyser.smoothingTimeConstant = 0.8;
      this._analyser = analyser;
      this._analyserEnabled = true;
      // Hook every existing track into the analyser. Subsequent tracks
      // (if init runs again) hit the same hook in _hookTrackToAnalyser.
      for (const el of this._trackEls) this._hookTrackToAnalyser(el);
      // Also hook the phone ring + C-drone if they exist — they're not
      // music but the visualizer is harmless on them.
      if (this._phoneRingEl) this._hookTrackToAnalyser(this._phoneRingEl);
      if (this._cDroneEl) this._hookTrackToAnalyser(this._cDroneEl);
      // Tutorial music + death music are lazy-loaded HTMLAudio elements
      // that may not exist yet when the analyser is first created.
      // Hook whichever already exists; the start* methods below also
      // call _hookTrackToAnalyser on first lazy-load so the visualizer
      // works regardless of which order these things initialize in.
      if (this._tutorialMusicEl) this._hookTrackToAnalyser(this._tutorialMusicEl);
      if (this._deathMusicEl) this._hookTrackToAnalyser(this._deathMusicEl);
      return analyser;
    } catch (e) {
      console.warn('[audio] analyser setup failed', e);
      return null;
    }
  }

  /**
   * Connect one HTMLAudioElement to the shared analyser via a
   * MediaElementAudioSourceNode. Idempotent — if this element has
   * already been wrapped in a source we skip (the browser would
   * otherwise throw InvalidStateError).
   *
   * Routing: element → MediaElementSource → AnalyserNode → masterGain
   * masterGain is then connected to ctx.destination by init().
   */
  _hookTrackToAnalyser(el) {
    if (!this._analyser || !el) return;
    if (this._trackSources.has(el)) return;
    try {
      const source = this.ctx.createMediaElementSource(el);
      source.connect(this._analyser);
      this._analyser.connect(this.masterGain);
      this._trackSources.set(el, source);
    } catch (e) {
      // Most common cause: this element was already wrapped in a
      // source somewhere else, or CORS / cross-origin issues on a
      // file:// load. Visualizer just won't show data for this track.
      console.warn('[audio] could not hook track to analyser', e);
    }
  }

  /**
   * Snapshot of the currently-playing soundtrack track. Returns
   * { name, currentTime, duration } or null if no track is active.
   * The visualizer reads this every frame to drive the progress
   * bar and track-name label.
   *
   * `name` is derived from the file path — strips path + extension
   * and pretty-prints common patterns (e.g. "Arena I" stays as is,
   * "TheOtherSide" → "The Other Side"). Pure presentation.
   */
  getCurrentTrackInfo() {
    // Primary path: an entry from the chapter playlist is active.
    if (this._currentTrackIdx >= 0) {
      const el = this._trackEls[this._currentTrackIdx];
      if (el) {
        const path = SOUNDTRACK_FILES[this._currentTrackIdx] || '';
        const filename = path.split('/').pop().replace(/\.mp3$/i, '');
        return {
          name: this._prettyTrackName(filename),
          currentTime: el.currentTime || 0,
          duration: el.duration || 0,
          paused: !!el.paused,
        };
      }
    }
    // Fallback: tutorial loop or death-screen loop. Both are dedicated
    // HTMLAudioElements outside the chapter-playlist array, so the
    // primary path above misses them — without this branch the pause
    // menu's track-name + time readout (and the visualizer spectrum)
    // would silently show nothing while these tracks are playing.
    if (this._tutorialMusicEl && !this._tutorialMusicEl.paused) {
      const el = this._tutorialMusicEl;
      return {
        name: this._prettyTrackName('TeachingWar'),
        currentTime: el.currentTime || 0,
        duration: el.duration || 0,
        paused: !!el.paused,
      };
    }
    if (this._deathMusicEl && !this._deathMusicEl.paused) {
      const el = this._deathMusicEl;
      return {
        name: this._prettyTrackName('Beyond'),
        currentTime: el.currentTime || 0,
        duration: el.duration || 0,
        paused: !!el.paused,
      };
    }
    return null;
  }

  /**
   * Pretty-print a track filename. Inserts spaces before camelCase
   * boundaries ("TheOtherSide" → "The Other Side") and trims runs
   * of whitespace. Filenames already containing spaces or numerals
   * (e.g. "Arena I") pass through unchanged.
   */
  _prettyTrackName(s) {
    if (!s) return '';
    if (/\s/.test(s)) return s;     // already spaced — leave it
    return s
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

export const Audio = new AudioEngine();
