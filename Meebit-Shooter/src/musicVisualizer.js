// musicVisualizer.js — PS1-era SoundScope / Music Visualizer.
//
// Reads the AnalyserNode exposed by audio.js and renders to a 2D
// canvas in the active chapter's tint. Multiple modes cycle on
// click. No skip / rewind — purely visual companion to the
// soundtrack while the player is in the pause menu.
//
// Modes (in cycle order):
//   1. BARS       — vertical frequency bars across the bottom edge.
//                   Spectrum analyzer bread-and-butter.
//   2. WAVEFORM   — time-domain oscilloscope line traversing left
//                   to right. Reads as the actual audio waveform.
//   3. RADIAL     — bars projected outward from the canvas center
//                   in a ring. Bass on the inside, treble on the
//                   rim. PS1 SoundScope's trademark look.
//   4. HEX GRID   — a 6×4 grid of hexagonal cells whose brightness
//                   tracks frequency band amplitude. PS1-Tron vibe.
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
  { id: 'radial',    label: 'RADIAL' },
  { id: 'hex',       label: 'HEX GRID' },
];

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

  // PS1-era radial — bars project from a center ring outward, one
  // bar per band, color tracks frequency. The ring closes a circle
  // so bass and treble bands meet across the top.
  function drawRadial(w, h) {
    if (!analyser) return;
    analyser.getByteFrequencyData(freqBuf);
    const cx = w * 0.5;
    const cy = h * 0.5;
    const innerR = Math.min(w, h) * 0.18;
    const maxR = Math.min(w, h) * 0.46;
    const BAR_COUNT = 96;
    const binsPerBar = Math.max(1, Math.floor(freqBuf.length / BAR_COUNT));
    ctx2d.lineWidth = 2;
    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      for (let j = 0; j < binsPerBar; j++) sum += freqBuf[i * binsPerBar + j];
      const v = sum / binsPerBar / 255;          // 0..1
      const a = (i / BAR_COUNT) * Math.PI * 2 - Math.PI * 0.5;
      const len = (maxR - innerR) * v;
      const x1 = cx + Math.cos(a) * innerR;
      const y1 = cy + Math.sin(a) * innerR;
      const x2 = cx + Math.cos(a) * (innerR + len);
      const y2 = cy + Math.sin(a) * (innerR + len);
      ctx2d.strokeStyle = _tintCss;
      ctx2d.globalAlpha = 0.35 + v * 0.65;
      ctx2d.beginPath();
      ctx2d.moveTo(x1, y1);
      ctx2d.lineTo(x2, y2);
      ctx2d.stroke();
    }
    ctx2d.globalAlpha = 1.0;
    // Center disc — solid tint at faint alpha so the ring's negative
    // space reads as a focal point.
    ctx2d.fillStyle = _tintCss;
    ctx2d.globalAlpha = 0.08;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, innerR - 4, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.globalAlpha = 1.0;
  }

  // Hex grid — 6×4 cells of flat-top hexagons whose fill alpha
  // tracks frequency band amplitude for that cell. Bands are
  // partitioned linearly across the spectrum (cell 0 = bass, cell
  // 23 = treble). PS1-Tron / Rez vibe.
  function drawHex(w, h) {
    if (!analyser) return;
    analyser.getByteFrequencyData(freqBuf);
    const COLS = 8;
    const ROWS = 4;
    const TOTAL = COLS * ROWS;
    // Hex sizing — flat-top cell width = w / cols, height ≈ width * 0.866.
    const hexW = (w - 12) / COLS;
    const hexH = hexW * 0.866;
    const startX = 6 + hexW * 0.5;
    const startY = (h - hexH * ROWS - hexH * 0.4) * 0.5 + hexH * 0.5;
    const binsPerCell = Math.max(1, Math.floor(freqBuf.length / TOTAL));
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const cellIdx = row * COLS + col;
        let sum = 0;
        for (let j = 0; j < binsPerCell; j++) sum += freqBuf[cellIdx * binsPerCell + j];
        const v = sum / binsPerCell / 255;       // 0..1
        // Stagger every other row by half a cell width — honeycomb.
        const cx = startX + col * hexW + (row & 1 ? hexW * 0.5 : 0);
        const cy = startY + row * hexH * 0.95;
        // Hex outline (always visible at low alpha)
        ctx2d.strokeStyle = _tintCss;
        ctx2d.globalAlpha = 0.18;
        ctx2d.lineWidth = 1.2;
        _hexPath(cx, cy, hexW * 0.42);
        ctx2d.stroke();
        // Hex fill (alpha = amplitude)
        if (v > 0.02) {
          ctx2d.fillStyle = _tintCss;
          ctx2d.globalAlpha = Math.min(1.0, v * 1.4);
          _hexPath(cx, cy, hexW * 0.40);
          ctx2d.fill();
        }
      }
    }
    ctx2d.globalAlpha = 1.0;
  }

  function _hexPath(cx, cy, r) {
    ctx2d.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.closePath();
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
    }

    // Trail-clear: paint a translucent black rect over the canvas
    // each frame instead of full clear. This gives the bars a
    // gentle motion blur trail (PS1-era CRT phosphor look) without
    // any real blur filter. Trail strength tuned per mode — radial
    // benefits from a longer trail, bars want a snappier reset.
    const mode = MODES[modeIdx];
    let trailAlpha;
    if (mode.id === 'bars') trailAlpha = 0.45;
    else if (mode.id === 'waveform') trailAlpha = 0.25;
    else if (mode.id === 'radial') trailAlpha = 0.18;
    else trailAlpha = 0.35;
    ctx2d.fillStyle = `rgba(0, 0, 0, ${trailAlpha})`;
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);

    // Scale the drawing context so all draw functions can work
    // in CSS pixel units instead of device pixels.
    ctx2d.save();
    ctx2d.scale(dpr, dpr);
    if (mode.id === 'bars') drawBars(cssW, cssH);
    else if (mode.id === 'waveform') drawWaveform(cssW, cssH);
    else if (mode.id === 'radial') drawRadial(cssW, cssH);
    else if (mode.id === 'hex') drawHex(cssW, cssH);
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
