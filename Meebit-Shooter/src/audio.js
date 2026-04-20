// Procedural audio via WebAudio. No sound files.
// Phone ring is handled separately via <audio> element in main.js.

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    this._musicOn = false;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.5;
      this.masterGain.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.7;
      this.sfxGain.connect(this.masterGain);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.18;
      this.musicGain.connect(this.masterGain);
    } catch (e) { console.warn('audio unsupported', e); }
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

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

  shot(weapon = 'pistol') {
    if (weapon === 'shotgun') {
      this._noise(0.15, 600, 0.25);
      this._beep({ type: 'sawtooth', freqStart: 120, freqEnd: 40, dur: 0.15, gainStart: 0.25 });
    } else if (weapon === 'smg') {
      this._beep({ type: 'square', freqStart: 1200, freqEnd: 400, dur: 0.04, gainStart: 0.1 });
    } else if (weapon === 'sniper') {
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

  startMusic() {
    if (!this.ctx || this.muted || this._musicOn) return;
    this._musicOn = true;
    const bass = this.ctx.createOscillator();
    bass.type = 'sawtooth';
    const bassFilt = this.ctx.createBiquadFilter();
    bassFilt.type = 'lowpass';
    bassFilt.frequency.value = 400;
    const bassGain = this.ctx.createGain();
    bassGain.gain.value = 0;
    bass.connect(bassFilt); bassFilt.connect(bassGain); bassGain.connect(this.musicGain);
    bass.start();
    this._bass = bass; this._bassGain = bassGain;

    const pad = this.ctx.createOscillator();
    pad.type = 'sine';
    pad.frequency.value = 220;
    const padGain = this.ctx.createGain();
    padGain.gain.value = 0.08;
    pad.connect(padGain); padGain.connect(this.musicGain);
    pad.start();
    this._pad = pad;

    this._step = 0;
    this._scheduler = setInterval(() => {
      if (!this._musicOn) return;
      const t = this.ctx.currentTime;
      const notes = [55, 55, 82.4, 55, 55, 110, 82.4, 65.4];
      const f = notes[this._step % notes.length];
      bass.frequency.setValueAtTime(f, t);
      bassGain.gain.cancelScheduledValues(t);
      bassGain.gain.setValueAtTime(0.18, t);
      bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      this._step++;
    }, 320);
  }

  stopMusic() {
    this._musicOn = false;
    if (this._scheduler) clearInterval(this._scheduler);
    try { if (this._bass) this._bass.stop(); } catch(e){}
    try { if (this._pad) this._pad.stop(); } catch(e){}
    this._bass = null; this._pad = null;
  }

  setMuted(m) {
    this.muted = m;
    if (this.masterGain) this.masterGain.gain.value = m ? 0 : 0.5;
  }
}

export const Audio = new AudioEngine();
