// musicVisualizer.js — PS1-era SoundScope / Music Visualizer.
//
// Reads the AnalyserNode exposed by audio.js and renders to a 2D
// canvas in the active chapter's tint. Multiple modes cycle on
// click. No skip / rewind — purely visual companion to the
// soundtrack while the player is in the pause menu.
//
// Modes (in cycle order):
//   1. BARS         — vertical frequency bars across the bottom edge.
//                     Spectrum analyzer bread-and-butter.
//   2. WAVEFORM     — time-domain oscilloscope line traversing left
//                     to right. Reads as the actual audio waveform.
//   3. MATRIX RAIN  — columns of falling katakana / digits, classic
//                     Matrix style. Bass drives column fall speed,
//                     treble brightens the leading head of each
//                     stream, and overall amplitude spikes give the
//                     entire rainfall a downward pulse on every beat.
//
// Public API (returned by createVisualizer):
//   start()      — begins the rAF render loop
//   stop()       — cancels the loop and clears the canvas
//   nextMode()   — advance to next visualization mode
//   getMode()    — returns current mode label (string)
//   getModeIndex() — current mode index 0..N-1
//   destroy()    — stop + remove any references for GC
//
// The visualizer is dormant when stopped — no allocations, no
// frame work. Caller (pause menu) is responsible for start/stop
// based on visibility.

import { Audio } from './audio.js';

const MODES = [
  { id: 'bars',      label: 'BARS' },
  { id: 'waveform',  label: 'WAVEFORM' },
  { id: 'matrix',    label: 'MATRIX RAIN' },
  { id: 'rings',     label: 'SPEAKER' },
];

// Matrix-rain glyph palette — classic katakana half-width + digits +
// a pinch of latin. Picked once and indexed into during render.
const MATRIX_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';

/**
 * Build a visualizer controller bound to a canvas element.
 *
 * Options:
 *   canvas    — HTMLCanvasElement (required)
 *   getTint   — function returning the current chapter tint as a
 *               hex number (e.g. 0xff6a1a). Called every frame so
 *               the tint can change live with the chapter.
 *   getActive — function returning true if the visualizer should
 *               keep rendering. Lets the pause menu skip work
 *               while collapsed without explicitly stop()ing.
 */
export function createVisualizer({ canvas, getTint, getActive }) {
  if (!canvas) throw new Error('createVisualizer: canvas is required');
  const ctx2d = canvas.getContext('2d');
  let rafId = null;
  let modeIdx = 0;
  // Lazy — fetched when the visualizer first starts so audio.js
  // had a chance to init AudioContext via a user gesture.
  let analyser = null;
  let freqBuf = null;        // Uint8Array — frequency-domain bins
  let timeBuf = null;        // Uint8Array — time-domain samples

  // Hot scratch for tint color string. Recomputed each frame
  // since the chapter can change (and we don't want to allocate
  // a new string every draw call when the value hasn't changed).
  let _lastTintHex = -1;
  let _tintCss = '#ff6a1a';
  let _tintRgb = { r: 0xff, g: 0x6a, b: 0x1a };
  function _refreshTint() {
    const t = (typeof getTint === 'function') ? (getTint() | 0) : 0xff6a1a;
    if (t !== _lastTintHex) {
      _lastTintHex = t;
      _tintRgb = { r: (t >> 16) & 0xff, g: (t >> 8) & 0xff, b: t & 0xff };
      _tintCss = '#' + t.toString(16).padStart(6, '0');
    }
  }

  function _ensureAnalyser() {
    if (analyser) return analyser;
    analyser = Audio.getOrCreateAnalyser();
    if (!analyser) return null;
    freqBuf = new Uint8Array(analyser.frequencyBinCount);
    timeBuf = new Uint8Array(analyser.frequencyBinCount);
    return analyser;
  }

  // ---------- Render modes ----------

  // Vertical frequency bars, classic spectrum analyzer. Bars rise
  // from the bottom edge. Bin count is reduced from analyser
  // resolution (typically 512) to ~64 visible bars by averaging
  // adjacent bins so the bars feel chunky / readable rather than
  // hair-thin.
  function drawBars(w, h) {
    if (!analyser) return;
    analyser.getByteFrequencyData(freqBuf);
    const BAR_COUNT = 64;
    const binsPerBar = Math.max(1, Math.floor(freqBuf.length / BAR_COUNT));
    const gap = 2;
    const barW = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    ctx2d.fillStyle = _tintCss;
    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      for (let j = 0; j < binsPerBar; j++) sum += freqBuf[i * binsPerBar + j];
      const v = sum / binsPerBar / 255;          // 0..1
      const barH = Math.max(1, v * v * h);       // squared for punchier dynamic range
      const x = i * (barW + gap);
      const y = h - barH;
      // Top sliver gets the full tint; bar body fades down to
      // ~50% to add gradient depth without a real linearGradient.
      ctx2d.globalAlpha = 1.0;
      ctx2d.fillRect(x, y, barW, 2);
      ctx2d.globalAlpha = 0.55;
      ctx2d.fillRect(x, y + 2, barW, barH - 2);
    }
    ctx2d.globalAlpha = 1.0;
  }

  // Time-domain oscilloscope. Reads samples in [-128..128] mapped
  // to bytes 0..255 (128 = silence). We trace a polyline across
  // the canvas at the average of two adjacent samples so the line
  // is smoother than the raw FFT bin count would give.
  function drawWaveform(w, h) {
    if (!analyser) return;
    analyser.getByteTimeDomainData(timeBuf);
    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = _tintCss;
    ctx2d.shadowColor = _tintCss;
    ctx2d.shadowBlur = 8;
    ctx2d.beginPath();
    const step = w / timeBuf.length;
    for (let i = 0; i < timeBuf.length; i++) {
      const v = timeBuf[i] / 128.0 - 1.0;        // -1..1
      const x = i * step;
      const y = h * 0.5 + v * (h * 0.45);
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;
  }

  // MATRIX RAIN — columns of falling katakana / digits driven by
  // audio data. Per-column state is lazily initialized on first
  // call and persists across frames so the streams flow smoothly
  // even as data updates.
  //
  // Audio mapping:
  //   - Each column's index maps to a frequency band. Loud bands
  //     accelerate that column; quiet bands slow it almost to a
  //     stop. Result: bass-heavy songs make the LEFT side of the
  //     rain (low-frequency columns) cascade faster; treble-heavy
  //     songs animate the RIGHT side.
  //   - Treble RMS controls the leading-glyph brightness: more
  //     high frequencies = whiter / hotter heads.
  //   - A beat pulse — overall amplitude RMS, smoothed — gives
  //     every column a temporary speed boost when drums hit, so
  //     the whole rainfall pulses in time with the song.
  //
  // Visual:
  //   - Column width matches the monospace font glyph width.
  //   - Each column shows a vertical trail of glyphs above the
  //     "head" position, fading from chapter tint down to black.
  //   - The leading glyph is brighter (near-white) and shifts to
  //     a fresh random glyph every frame for the iconic shimmer.
  //   - Glyphs in the trail rotate to a new random char only
  //     periodically per cell, not every frame, so the column
  //     reads as falling text rather than a noise field.
  let _matrixCols = null;
  let _matrixFontPx = 14;
  let _matrixLastW = -1;
  function drawMatrix(w, h) {
    if (!analyser) return;
    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(timeBuf);

    // Lazy column setup — rebuild whenever the canvas width changes
    // (rare) so the column count adapts to the rendered area.
    if (_matrixCols === null || _matrixLastW !== w) {
      _matrixLastW = w;
      const cellW = _matrixFontPx;
      const colCount = Math.max(8, Math.floor(w / cellW));
      _matrixCols = new Array(colCount);
      for (let i = 0; i < colCount; i++) {
        _matrixCols[i] = {
          // Start each column at a random vertical position so the
          // rain doesn't visually "begin" the moment the visualizer
          // opens — looks like it's been falling forever.
          y: Math.random() * h,
          speed: 30 + Math.random() * 40,    // base px/sec, modulated by audio
          trailLen: 8 + Math.floor(Math.random() * 14),
          // Glyph sequence — one glyph per row in the trail. Updated
          // intermittently per cell so the text shimmers without
          // becoming pure static.
          glyphs: new Array(24).fill(0).map(
            () => MATRIX_GLYPHS[(Math.random() * MATRIX_GLYPHS.length) | 0]
          ),
          // Per-cell glyph swap timer — when this counts to 0 the
          // cell at index gets a new random glyph. Each column's
          // cells refresh independently for the shimmer effect.
          swapTimer: Math.random() * 0.3,
        };
      }
    }

    // Compute audio drivers.
    //   bassRms  — average of the bottom 1/8 of the spectrum
    //   trebleRms — average of the top 1/4 of the spectrum
    //   amplitudeRms — overall energy (used as beat pulse)
    const totalBins = freqBuf.length;
    const bassEnd = Math.max(2, totalBins >> 3);
    const trebleStart = totalBins - (totalBins >> 2);
    let bassSum = 0, trebleSum = 0, allSum = 0;
    for (let i = 0; i < bassEnd; i++) bassSum += freqBuf[i];
    for (let i = trebleStart; i < totalBins; i++) trebleSum += freqBuf[i];
    for (let i = 0; i < totalBins; i++) allSum += freqBuf[i];
    const bassRms   = (bassSum / bassEnd) / 255;
    const trebleRms = (trebleSum / (totalBins - trebleStart)) / 255;
    const amplitudeRms = (allSum / totalBins) / 255;

    // Frame delta. AnalyserNode doesn't give us dt so we approximate
    // 60fps. Rain is forgiving — exact dt isn't critical.
    const dt = 1 / 60;

    // Set up the font once per frame.
    ctx2d.font = `${_matrixFontPx}px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
    ctx2d.textBaseline = 'top';

    const cellH = _matrixFontPx + 2;
    const cellW = _matrixFontPx;
    const colCount = _matrixCols.length;
    // Beat pulse — a 0..1 value that briefly spikes when amplitude
    // is high. Multiplies into per-column speed for the whole-rain
    // downward surge effect.
    const beatBoost = 1 + amplitudeRms * 1.6;

    for (let c = 0; c < colCount; c++) {
      const col = _matrixCols[c];
      // Map column index to a frequency bin so each column's
      // amplitude differs based on the song's spectral content.
      const binIdx = Math.floor((c / colCount) * totalBins);
      const colAmp = freqBuf[binIdx] / 255;     // 0..1

      // Per-column fall speed: base + amplitude-driven boost +
      // beat pulse. Quiet columns drift; loud columns sprint.
      const localSpeed = col.speed * (0.4 + colAmp * 1.4) * beatBoost;
      col.y += localSpeed * dt;
      // Wrap when head goes off bottom — restart slightly above
      // the canvas with a fresh random delay so columns don't all
      // wrap on the same frame (which would look like a flicker).
      if (col.y > h + col.trailLen * cellH) {
        col.y = -Math.random() * cellH * 8;
        col.trailLen = 8 + Math.floor(Math.random() * 14);
      }

      // Glyph swap timer — refresh ONE random cell in this column
      // each time the timer expires. Timer interval depends on
      // amplitude so loud columns shimmer faster.
      col.swapTimer -= dt * (1 + colAmp * 4);
      if (col.swapTimer <= 0) {
        col.swapTimer = 0.05 + Math.random() * 0.25;
        const idx = (Math.random() * col.glyphs.length) | 0;
        col.glyphs[idx] = MATRIX_GLYPHS[(Math.random() * MATRIX_GLYPHS.length) | 0];
      }

      // Draw the trail. Cell 0 is the leading head (brightest +
      // re-randomized every frame for shimmer), then trail extends
      // upward fading toward black.
      const x = c * cellW;
      // Leading head glyph — rerolled every frame. Treble drives
      // its brightness toward white for the iconic "hot head."
      const headGlyph = MATRIX_GLYPHS[(Math.random() * MATRIX_GLYPHS.length) | 0];
      const headWhite = Math.min(1, 0.55 + trebleRms * 0.9);
      // Mix between chapter tint and white based on headWhite.
      const hr = Math.round(_tintRgb.r + (255 - _tintRgb.r) * headWhite);
      const hg = Math.round(_tintRgb.g + (255 - _tintRgb.g) * headWhite);
      const hb = Math.round(_tintRgb.b + (255 - _tintRgb.b) * headWhite);
      ctx2d.fillStyle = `rgb(${hr}, ${hg}, ${hb})`;
      ctx2d.shadowColor = _tintCss;
      ctx2d.shadowBlur = 6;
      ctx2d.fillText(headGlyph, x, col.y);
      ctx2d.shadowBlur = 0;
      // Trail
      for (let t = 1; t < col.trailLen; t++) {
        const ty = col.y - t * cellH;
        if (ty < -cellH) break;
        // Glyph picked from the persistent buffer for this row —
        // cycles through the column's stable shimmer pool rather
        // than all-random per frame.
        const g = col.glyphs[(t * 17 + c * 11) % col.glyphs.length];
        // Fade alpha from 1.0 just behind the head down to ~0.05
        // at the tip of the trail.
        const a = Math.max(0, 1 - t / col.trailLen);
        ctx2d.fillStyle = `rgba(${_tintRgb.r}, ${_tintRgb.g}, ${_tintRgb.b}, ${a * 0.85})`;
        ctx2d.fillText(g, x, ty);
      }
    }
  }

  // -------- SPEAKER — cinematic subwoofer cone visualization --------
  //
  // Reference: user provided red-orange ember screenshots showing
  // tilted concentric rings on the ground with sparks lifting off,
  // then asked to upgrade them into a cinematic "SPEAKER" — a
  // pumping subwoofer cone framed by reactive rings + light beams
  // + atmospheric haze + edge vignette.
  //
  // Layer stack (back to front):
  //   1. Atmospheric haze — drifting radial gradient breathes with
  //      bass (sub-bass band drives the haze brightness).
  //   2. Volumetric light beams — long thin rays from center,
  //      pulse brighter on bass hits, slow rotation for life.
  //   3. Rings — concentric circles AROUND the cone, beat-reactive
  //      per-band (same logic as before but tinted as the cone's
  //      surround).
  //   4. Subwoofer cone — central dome with radial gradient.
  //      Scales (z-axis fake) on bass hits — pumps in/out.
  //   5. Center dust cap — small bright disc at the very center
  //      of the cone.
  //   6. Sparks — emitted from cone perimeter on bass hits.
  //   7. Vignette — radial dark-edge gradient on top, gives the
  //      "looking through a lens" cinematic frame.

  const RING_COUNT = 6;
  let _rings = null;
  let _sparks = [];
  let _ringsLastT = 0;
  // Cone scale tracking — independent breath so the cone always has
  // some life even when no beat is hitting. Driven by sub-bass EMA.
  let _conePump = 0;          // 0..1 — recent bass impulse
  let _coneIdle = 0;          // continuous oscillation phase
  // Beam state — slow rotation around the center.
  let _beamRot = 0;
  // Haze state — phase for drift animation.
  let _hazePhase = 0;

  function _ensureRings() {
    if (_rings) return;
    _rings = new Array(RING_COUNT);
    const ranges = [
      [1, 4],      // ring 0 (outermost) — sub-bass / kick (~43-172Hz)
      [4, 10],     // ring 1 — bass (~172-430Hz)
      [10, 22],    // ring 2 — low-mid (~430-946Hz)
      [22, 50],    // ring 3 — mid (~946-2150Hz)
      [50, 110],   // ring 4 — high-mid (~2.1-4.7kHz)
      [110, 240],  // ring 5 (innermost) — treble (~4.7-10.3kHz)
    ];
    for (let i = 0; i < RING_COUNT; i++) {
      _rings[i] = {
        binLo: ranges[i][0],
        binHi: ranges[i][1],
        emaEnergy: 0,
        pulseT: 0,
        lastEnergy: 0,
      };
    }
  }

  // Spark emission — now from the cone perimeter rather than ring
  // circumference, since the cone is the focal element. The user
  // perceives sparks as flying off the speaker driver itself.
  function _spawnSparks(ringIdx, ringRadiusX, ringRadiusY, cx, cy, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const px = cx + Math.cos(a) * ringRadiusX;
      const py = cy + Math.sin(a) * ringRadiusY;
      const ox = Math.cos(a);
      const oy = Math.sin(a);
      const speed = 80 + Math.random() * 90;
      _sparks.push({
        x: px,
        y: py,
        vx: ox * speed * 0.4,
        vy: oy * speed * 0.4 - 90 - Math.random() * 60,
        life: 0,
        maxLife: 1.2 + Math.random() * 0.4,
        hueOffset: (Math.random() - 0.5) * 2,
        size: 1.5 + Math.random() * 2,
      });
    }
  }

  let _tintHsl = { h: 22, s: 100, l: 55 };
  let _tintHslHex = -1;
  function _refreshTintHsl() {
    if (_tintHslHex === _lastTintHex) return;
    _tintHslHex = _lastTintHex;
    const r = _tintRgb.r / 255, g = _tintRgb.g / 255, b = _tintRgb.b / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      switch (mx) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    _tintHsl = { h, s: s * 100, l: l * 100 };
  }

  function drawRings(w, h) {
    if (!analyser) return;
    analyser.getByteFrequencyData(freqBuf);
    _ensureRings();
    _refreshTintHsl();

    const now = performance.now();
    const dt = _ringsLastT === 0 ? 0.016 : Math.min(0.05, (now - _ringsLastT) * 0.001);
    _ringsLastT = now;
    _coneIdle += dt;
    _beamRot += dt * 0.18;          // very slow drift, ~10°/sec
    _hazePhase += dt * 0.4;

    const cx = w * 0.5;
    const cy = h * 0.58;             // slightly above center
    const ASPECT = 0.32;              // slightly less squashed than before
    const maxRingW = Math.min(w * 0.46, h * 0.85);

    // --- Per-band energy update + activation (unchanged logic) ---
    for (let i = 0; i < RING_COUNT; i++) {
      const ring = _rings[i];
      let sum = 0, count = 0;
      const lo = Math.min(ring.binLo, freqBuf.length - 1);
      const hi = Math.min(ring.binHi, freqBuf.length);
      for (let b = lo; b < hi; b++) { sum += freqBuf[b]; count++; }
      const energy = (count > 0) ? (sum / count) / 255 : 0;
      ring.lastEnergy = energy;
      const emaAlpha = Math.min(1, dt * 1.8);
      ring.emaEnergy = ring.emaEnergy * (1 - emaAlpha) + energy * emaAlpha;
      const ACTIV_MULT = 1.4;
      const ACTIV_FLOOR = 0.18;
      if (energy > ring.emaEnergy * ACTIV_MULT && energy > ACTIV_FLOOR) {
        if (ring.pulseT < 0.55) {
          ring.pulseT = 1.0;
          const baseCount = 14 - i * 1.5;
          const bonusFromEnergy = Math.floor(energy * 8);
          const sparkCount = Math.max(4, Math.floor(baseCount + bonusFromEnergy));
          // Spawn sparks from the OUTER cone perimeter so they read
          // as flying off the speaker, not from arbitrary rings.
          const coneR = maxRingW * 0.30;
          _spawnSparks(i, coneR, coneR * ASPECT, cx, cy, sparkCount);
        }
      }
      if (ring.pulseT > 0) {
        ring.pulseT -= dt * 1.8;
        if (ring.pulseT < 0) ring.pulseT = 0;
      }
    }

    // Bass-driven cone pump — exponential approach to sub-bass energy
    // so the cone "breathes" with the kick. _rings[0] is sub-bass.
    const bassEma = _rings[0].emaEnergy;
    const bassPulse = _rings[0].pulseT;
    const targetPump = Math.min(1, bassEma * 1.4 + bassPulse * 0.7);
    _conePump = _conePump + (targetPump - _conePump) * Math.min(1, dt * 8);

    // --- LAYER 1: ATMOSPHERIC HAZE ---
    // Big drifting radial gradient that breathes with bass. Two
    // overlapping clouds offset by hazePhase so they drift past each
    // other slowly, giving the impression of fog rolling through the
    // scene. Tinted toward chapter hue but kept low-saturation.
    ctx2d.save();
    {
      const hazeIntensity = 0.18 + bassEma * 0.32 + bassPulse * 0.18;
      // Cloud A
      const cax = cx + Math.cos(_hazePhase * 0.7) * w * 0.08;
      const cay = cy + Math.sin(_hazePhase * 0.5) * h * 0.05;
      const gA = ctx2d.createRadialGradient(cax, cay, 0, cax, cay, maxRingW * 1.6);
      gA.addColorStop(0, `hsla(${_tintHsl.h}, 60%, 22%, ${hazeIntensity})`);
      gA.addColorStop(0.5, `hsla(${_tintHsl.h - 10}, 50%, 14%, ${hazeIntensity * 0.5})`);
      gA.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      ctx2d.fillStyle = gA;
      ctx2d.fillRect(0, 0, w, h);
      // Cloud B — offset, mirrored phase
      const cbx = cx + Math.cos(_hazePhase * 0.5 + 2.1) * w * 0.10;
      const cby = cy + Math.sin(_hazePhase * 0.7 + 1.3) * h * 0.07;
      const gB = ctx2d.createRadialGradient(cbx, cby, 0, cbx, cby, maxRingW * 1.4);
      gB.addColorStop(0, `hsla(${_tintHsl.h + 12}, 55%, 18%, ${hazeIntensity * 0.7})`);
      gB.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      ctx2d.fillStyle = gB;
      ctx2d.fillRect(0, 0, w, h);
    }
    ctx2d.restore();

    // --- LAYER 2: VOLUMETRIC LIGHT BEAMS ---
    // Long thin radial rays from center. Slowly rotating set of
    // 12 beams; brightness scales with bass + ring activations.
    // Drawn additively so they bloom into the haze.
    ctx2d.save();
    ctx2d.globalCompositeOperation = 'lighter';
    {
      const BEAM_COUNT = 12;
      const beamLen = maxRingW * 1.4;
      const beamGlow = 0.10 + bassEma * 0.20 + bassPulse * 0.50;
      // Average mid-band pulse adds a treble shimmer.
      const trebleKick = (_rings[4].pulseT + _rings[5].pulseT) * 0.5;
      for (let i = 0; i < BEAM_COUNT; i++) {
        const a = _beamRot + (i / BEAM_COUNT) * Math.PI * 2;
        // Per-beam jitter from treble — subtle wobble in length.
        const lenMul = 0.85 + Math.sin(_coneIdle * 4 + i) * 0.05 + trebleKick * 0.25;
        const ex = cx + Math.cos(a) * beamLen * lenMul;
        const ey = cy + Math.sin(a) * beamLen * lenMul * ASPECT * 1.4;
        const grad = ctx2d.createLinearGradient(cx, cy, ex, ey);
        grad.addColorStop(0, `hsla(${_tintHsl.h}, ${_tintHsl.s}%, ${Math.min(72, _tintHsl.l + 18)}%, ${beamGlow})`);
        grad.addColorStop(0.6, `hsla(${_tintHsl.h - 6}, ${_tintHsl.s}%, ${_tintHsl.l}%, ${beamGlow * 0.4})`);
        grad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
        ctx2d.strokeStyle = grad;
        ctx2d.lineWidth = 1.5 + bassPulse * 1.5;
        ctx2d.beginPath();
        ctx2d.moveTo(cx, cy);
        ctx2d.lineTo(ex, ey);
        ctx2d.stroke();
      }
    }
    ctx2d.restore();

    // --- LAYER 3: RINGS (the cone's surround / suspension) ---
    // Same per-ring activation logic as before, but the rings now
    // visually frame the cone — they're the speaker's surround.
    ctx2d.save();
    ctx2d.lineCap = 'round';
    for (let i = 0; i < RING_COUNT; i++) {
      const ring = _rings[i];
      const tNorm = i / (RING_COUNT - 1);
      const ringW = maxRingW * (0.45 + (1 - tNorm) * 0.55);
      const ringH = ringW * ASPECT;
      const base = 0.32 + ring.emaEnergy * 0.22;
      const pulse = ring.pulseT * 0.55;
      const alpha = Math.min(1, base + pulse);
      const strokeW = 1.5 + ring.pulseT * 3.0;
      const hShift = (tNorm - 0.5) * 12;
      ctx2d.strokeStyle = `hsla(${_tintHsl.h + hShift}, ${_tintHsl.s}%, ${_tintHsl.l + ring.pulseT * 18}%, ${alpha})`;
      ctx2d.lineWidth = strokeW;
      ctx2d.beginPath();
      ctx2d.ellipse(cx, cy, ringW, ringH, 0, 0, Math.PI * 2);
      ctx2d.stroke();
      if (ring.pulseT > 0.15) {
        ctx2d.strokeStyle = `hsla(${_tintHsl.h + hShift}, 100%, ${Math.min(85, _tintHsl.l + 30)}%, ${ring.pulseT * 0.35})`;
        ctx2d.lineWidth = strokeW * 3;
        ctx2d.beginPath();
        ctx2d.ellipse(cx, cy, ringW, ringH, 0, 0, Math.PI * 2);
        ctx2d.stroke();
      }
    }
    ctx2d.restore();

    // --- LAYER 4: SUBWOOFER CONE ---
    // The pumping driver at center. Scales (radial pump) on bass hits
    // — fakes z-axis displacement. Drawn as concentric layers:
    //   • outer rim ring (the gasket bolting it to the surround)
    //   • cone body (radial gradient, dark to mid-tone)
    //   • subtle highlight ring (suggests light catching the curve)
    //   • dust cap (small disc at very center, brightest)
    // The cone idle-oscillates ~3% scale at 0.6Hz so even silence
    // looks alive.
    ctx2d.save();
    {
      const idleOsc = 1 + Math.sin(_coneIdle * 0.6 * Math.PI * 2) * 0.01;
      const pumpScale = 1 - _conePump * 0.18;     // pumps INWARD on hit
      const coneScale = idleOsc * pumpScale;
      const coneR = maxRingW * 0.30 * coneScale;
      const coneInnerR = maxRingW * 0.05 * coneScale;
      // Outer rim — dark thick ring around the cone, suggests the
      // bolted gasket.
      ctx2d.strokeStyle = `hsla(${_tintHsl.h}, ${_tintHsl.s * 0.4}%, 8%, 0.95)`;
      ctx2d.lineWidth = 8;
      ctx2d.beginPath();
      ctx2d.ellipse(cx, cy, coneR * 1.05, coneR * 1.05 * ASPECT, 0, 0, Math.PI * 2);
      ctx2d.stroke();
      // Cone body — radial gradient from dark center to slightly less
      // dark edge; pumping cone feels lit-from-edge on hit.
      const cgrad = ctx2d.createRadialGradient(cx, cy, coneInnerR, cx, cy, coneR);
      const coneLight = 6 + _conePump * 8;
      cgrad.addColorStop(0, `hsla(${_tintHsl.h}, 30%, ${coneLight + 4}%, 1)`);
      cgrad.addColorStop(0.7, `hsla(${_tintHsl.h - 5}, 25%, ${coneLight}%, 1)`);
      cgrad.addColorStop(1, `hsla(${_tintHsl.h - 10}, 20%, ${coneLight - 3}%, 1)`);
      ctx2d.fillStyle = cgrad;
      ctx2d.beginPath();
      ctx2d.ellipse(cx, cy, coneR, coneR * ASPECT, 0, 0, Math.PI * 2);
      ctx2d.fill();
      // Highlight crescent at the top of the cone — fakes light
      // catching the curved surface, sells the 3D form.
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.ellipse(cx, cy, coneR, coneR * ASPECT, 0, 0, Math.PI * 2);
      ctx2d.clip();
      const hlGrad = ctx2d.createLinearGradient(cx, cy - coneR * ASPECT, cx, cy);
      hlGrad.addColorStop(0, `hsla(${_tintHsl.h}, 60%, ${30 + _conePump * 20}%, 0.45)`);
      hlGrad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      ctx2d.fillStyle = hlGrad;
      ctx2d.fillRect(cx - coneR, cy - coneR * ASPECT, coneR * 2, coneR * ASPECT);
      ctx2d.restore();
      // Dust cap — small brighter disc at center. Pumps WITH cone
      // so it reads as part of the assembly, not independent.
      const dustR = coneR * 0.25;
      const dgrad = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, dustR);
      const dustLight = 18 + _conePump * 22;
      dgrad.addColorStop(0, `hsla(${_tintHsl.h}, 70%, ${dustLight + 12}%, 1)`);
      dgrad.addColorStop(1, `hsla(${_tintHsl.h}, 55%, ${dustLight - 6}%, 1)`);
      ctx2d.fillStyle = dgrad;
      ctx2d.beginPath();
      ctx2d.ellipse(cx, cy, dustR, dustR * ASPECT, 0, 0, Math.PI * 2);
      ctx2d.fill();
      // Bright pop on heavy bass — small flash bloom around the
      // dust cap when _conePump is high.
      if (_conePump > 0.5) {
        const popAlpha = (_conePump - 0.5) * 0.8;
        ctx2d.globalCompositeOperation = 'lighter';
        const pgrad = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, coneR * 0.7);
        pgrad.addColorStop(0, `hsla(${_tintHsl.h}, 100%, 60%, ${popAlpha})`);
        pgrad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
        ctx2d.fillStyle = pgrad;
        ctx2d.beginPath();
        ctx2d.ellipse(cx, cy, coneR * 0.7, coneR * 0.7 * ASPECT, 0, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.globalCompositeOperation = 'source-over';
      }
    }
    ctx2d.restore();

    // --- LAYER 6: SPARKS (drawn after cone so they read in front) ---
    ctx2d.save();
    for (let i = _sparks.length - 1; i >= 0; i--) {
      const s = _sparks[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        _sparks.splice(i, 1);
        continue;
      }
      s.vy += 60 * dt;
      s.vx *= 0.98;
      s.vy *= 0.99;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const t01 = s.life / s.maxLife;
      const fade = 1 - t01;
      const sparkH = _tintHsl.h + s.hueOffset * 15;
      const sparkL = _tintHsl.l + 25 - t01 * 30;
      ctx2d.fillStyle = `hsla(${sparkH}, ${_tintHsl.s}%, ${sparkL}%, ${fade})`;
      ctx2d.beginPath();
      ctx2d.arc(s.x, s.y, s.size * (1 + fade * 0.5), 0, Math.PI * 2);
      ctx2d.fill();
    }
    ctx2d.restore();

    const SPARK_CAP = 200;
    if (_sparks.length > SPARK_CAP) {
      _sparks.splice(0, _sparks.length - SPARK_CAP);
    }

    // --- LAYER 7: VIGNETTE ---
    // Radial dark-edge gradient on top — gives the "looking through
    // a lens" cinematic frame and forces eye to center. Pulses very
    // subtly with bass so the whole image feels like it's breathing.
    ctx2d.save();
    {
      const vgrad = ctx2d.createRadialGradient(cx, cy, maxRingW * 0.6, cx, cy, Math.max(w, h) * 0.85);
      vgrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vgrad.addColorStop(0.5, `rgba(0, 0, 0, ${0.2 + bassEma * 0.05})`);
      vgrad.addColorStop(1, `rgba(0, 0, 0, ${0.85 - bassPulse * 0.1})`);
      ctx2d.fillStyle = vgrad;
      ctx2d.fillRect(0, 0, w, h);
    }
    ctx2d.restore();
  }

  // ---------- Loop ----------

  function _frame() {
    rafId = requestAnimationFrame(_frame);
    if (typeof getActive === 'function' && !getActive()) return;

    _ensureAnalyser();
    _refreshTint();

    // Resize canvas to its CSS size with devicePixelRatio so the
    // bars stay crisp on hidpi displays. Cheap to check each frame.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || 100;
    const targetW = Math.floor(cssW * dpr);
    const targetH = Math.floor(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      // Force matrix-rain column rebuild on resize so the new
      // width is honored by the next drawMatrix call.
      _matrixLastW = -1;
    }

    // Trail-clear: paint a translucent black rect over the canvas
    // each frame instead of full clear. This gives the bars a
    // gentle motion blur trail (PS1-era CRT phosphor look) without
    // any real blur filter. Trail strength tuned per mode — bars
    // want a snappier reset, waveform a ghosty trail, matrix the
    // longest trail since the rain itself IS a trail effect.
    const mode = MODES[modeIdx];
    let trailAlpha;
    if (mode.id === 'bars') trailAlpha = 0.45;
    else if (mode.id === 'waveform') trailAlpha = 0.25;
    else if (mode.id === 'matrix') trailAlpha = 0.12;     // long persistence for rain trails
    else if (mode.id === 'rings') trailAlpha = 0.85;      // SPEAKER — near full redraw, layers handle trails
    else trailAlpha = 0.35;
    ctx2d.fillStyle = `rgba(0, 0, 0, ${trailAlpha})`;
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);

    // Scale the drawing context so all draw functions can work
    // in CSS pixel units instead of device pixels.
    ctx2d.save();
    ctx2d.scale(dpr, dpr);
    if (mode.id === 'bars') drawBars(cssW, cssH);
    else if (mode.id === 'waveform') drawWaveform(cssW, cssH);
    else if (mode.id === 'matrix') drawMatrix(cssW, cssH);
    else if (mode.id === 'rings') drawRings(cssW, cssH);
    ctx2d.restore();
  }

  // ---------- Public API ----------

  function start() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(_frame);
  }
  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    // Clear canvas to fully transparent — safer than leaving a
    // partial frame on screen if the menu reopens later.
    if (ctx2d) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  }
  function nextMode() {
    modeIdx = (modeIdx + 1) % MODES.length;
    return MODES[modeIdx];
  }
  function getMode() { return MODES[modeIdx].label; }
  function getModeIndex() { return modeIdx; }
  function destroy() {
    stop();
    analyser = null;
    freqBuf = null;
    timeBuf = null;
  }

  return { start, stop, nextMode, getMode, getModeIndex, destroy };
}
