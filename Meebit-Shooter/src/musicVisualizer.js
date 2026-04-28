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
