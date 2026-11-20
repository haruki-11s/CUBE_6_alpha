/**
 * Sound effects, synthesised at runtime with the Web Audio API
 * (no audio files → nothing to download, works offline). No BGM by design.
 */

interface ToneOpts {
  f: number;          // start frequency (Hz)
  f2?: number;        // end frequency (exponential glide)
  type?: OscillatorType;
  at?: number;        // start offset (s)
  dur: number;        // length (s)
  gain?: number;
  attack?: number;
  detune?: number;    // cents
  lp?: number;        // optional low-pass cutoff (Hz)
}

interface NoiseOpts {
  f: number;          // filter frequency
  f2?: number;        // filter sweep target
  type?: BiquadFilterType;
  q?: number;
  at?: number;
  dur: number;
  gain?: number;
  attack?: number;
}

const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5;

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private enabled = true;
  private volume = 0.7;
  private lastHover = 0;

  configure(enabled: boolean, volume: number): void {
    this.enabled = enabled;
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.02);
    }
  }

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -16;
        comp.knee.value = 14;
        comp.ratio.value = 4;
        this.master = this.ctx.createGain();
        this.master.gain.value = this.enabled ? this.volume : 0;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      /* audio unavailable: stay silent */
    }
  }

  private ready(): AudioContext | null {
    if (!this.enabled || !this.ctx || !this.master) return null;
    if (this.ctx.state !== 'running') {
      void this.ctx.resume();
      return null;
    }
    return this.ctx;
  }

  private tone(o: ToneOpts): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.f2 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t0 + o.dur);
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      osc.connect(f);
      f.connect(g);
    } else {
      osc.connect(g);
    }
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.03);
  }

  private noise(o: NoiseOpts): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    if (!this.noiseBuf) {
      const len = ctx.sampleRate;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    const t0 = ctx.currentTime + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = o.type ?? 'bandpass';
    filt.Q.value = o.q ?? 1;
    filt.frequency.setValueAtTime(o.f, t0);
    if (o.f2 !== undefined) filt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.2, t0 + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + o.dur + 0.03);
  }

  // ── UI ────────────────────────────────────────────────────────────────
  click(): void { this.tone({ f: 1500, f2: 1100, type: 'triangle', dur: 0.05, gain: 0.07 }); }
  hover(): void {
    const now = performance.now();
    if (now - this.lastHover < 45) return;
    this.lastHover = now;
    this.tone({ f: 2300, dur: 0.03, gain: 0.022 });
  }
  toggle(on: boolean): void {
    this.tone({ f: on ? 880 : 660, f2: on ? 1320 : 440, type: 'triangle', dur: 0.08, gain: 0.07 });
  }
  open(): void { this.noise({ type: 'bandpass', f: 700, f2: 1800, q: 1.2, dur: 0.16, gain: 0.05, attack: 0.03 }); }
  close(): void { this.noise({ type: 'bandpass', f: 1600, f2: 600, q: 1.2, dur: 0.14, gain: 0.04, attack: 0.02 }); }
  whoosh(): void { this.noise({ type: 'bandpass', f: 300, f2: 1500, q: 0.8, dur: 0.35, gain: 0.08, attack: 0.1 }); }
  invalid(): void {
    this.tone({ f: 150, type: 'square', dur: 0.13, gain: 0.04, lp: 900 });
    this.tone({ f: 158, type: 'square', dur: 0.13, gain: 0.03, lp: 900 });
  }
  start(): void {
    [392, C5, E5, G5].forEach((f, i) => this.tone({ f, at: i * 0.07, dur: 0.3, gain: 0.07, type: 'triangle' }));
  }

  // ── Board ─────────────────────────────────────────────────────────────
  select(): void {
    this.tone({ f: 880, dur: 0.12, gain: 0.09 });
    this.tone({ f: 1320, at: 0.05, dur: 0.16, gain: 0.07 });
  }
  deselect(): void { this.tone({ f: 1100, f2: 700, dur: 0.1, gain: 0.06, type: 'triangle' }); }
  place(player: 'O' | 'X'): void {
    const k = player === 'O' ? 1 : 0.84;
    this.tone({ f: 620 * k, f2: 210 * k, dur: 0.18, gain: 0.3 });
    this.tone({ f: 1240 * k, f2: 900 * k, dur: 0.09, gain: 0.05, type: 'triangle' });
    this.noise({ type: 'highpass', f: 3200, dur: 0.035, gain: 0.07 });
    this.tone({ f: 2093 * k, at: 0.03, dur: 0.28, gain: 0.022 });
  }
  lift(): void { this.noise({ type: 'bandpass', f: 500, f2: 2400, q: 1.4, dur: 0.36, gain: 0.11, attack: 0.08 }); }
  land(): void {
    this.tone({ f: 320, f2: 110, dur: 0.14, gain: 0.26 });
    this.noise({ type: 'lowpass', f: 900, dur: 0.07, gain: 0.11 });
  }
  preview(): void {
    this.tone({ f: 740, dur: 0.06, gain: 0.055, type: 'triangle' });
    this.tone({ f: 988, at: 0.045, dur: 0.08, gain: 0.045, type: 'triangle' });
  }
  confirm(): void {
    this.tone({ f: 660, dur: 0.1, gain: 0.09, type: 'triangle' });
    this.tone({ f: 990, at: 0.08, dur: 0.16, gain: 0.09, type: 'triangle' });
  }
  cancel(): void { this.tone({ f: 540, f2: 360, dur: 0.14, gain: 0.07, type: 'triangle' }); }
  rotate(): void {
    this.tone({ f: 85, f2: 150, type: 'sawtooth', dur: 0.5, gain: 0.05, lp: 700, attack: 0.05 });
    [0, 0.11, 0.22, 0.33].forEach((t, k) =>
      this.noise({ type: 'highpass', f: 2600 + k * 300, at: t, dur: 0.03, gain: 0.085 - k * 0.015 }));
    this.tone({ f: 190, f2: 85, at: 0.48, dur: 0.14, gain: 0.24 });
    this.noise({ type: 'lowpass', f: 700, at: 0.48, dur: 0.09, gain: 0.15 });
  }
  slide(): void {
    this.noise({ type: 'bandpass', f: 1900, f2: 380, q: 0.9, dur: 0.52, gain: 0.15, attack: 0.06 });
    this.tone({ f: 150, f2: 70, at: 0.48, dur: 0.18, gain: 0.24 });
  }
  turn(player: 'O' | 'X'): void {
    const f = player === 'O' ? C6 : 880;
    this.tone({ f, dur: 0.6, gain: 0.06 });
    this.tone({ f: f * 2.01, dur: 0.3, gain: 0.02 });
    this.tone({ f: f * 1.5, at: 0.09, dur: 0.5, gain: 0.035 });
  }
  undo(): void {
    this.tone({ f: 600, f2: 900, dur: 0.07, gain: 0.06, type: 'triangle' });
    this.tone({ f: 900, f2: 520, at: 0.06, dur: 0.12, gain: 0.06, type: 'triangle' });
  }

  // ── Results ───────────────────────────────────────────────────────────
  win(offset = 0): void {
    [C5, E5, G5, C6].forEach((f, i) => this.tone({ f, at: offset + i * 0.12, dur: 0.42, gain: 0.11, type: 'triangle' }));
    [C5, E5, G5].forEach(f => this.tone({ f, at: offset + 0.5, dur: 1.4, gain: 0.05 }));
    this.tone({ f: C6, at: offset + 0.5, dur: 1.4, gain: 0.045, type: 'triangle' });
    this.noise({ type: 'highpass', f: 6000, at: offset + 0.5, dur: 0.9, gain: 0.035, attack: 0.2 });
  }
  selfDestruct(): void {
    this.noise({ type: 'lowpass', f: 1600, f2: 90, dur: 0.75, gain: 0.3 });
    this.tone({ f: 110, f2: 40, dur: 0.6, gain: 0.28 });
    this.win(0.55);
  }
  draw(): void {
    this.tone({ f: C5, dur: 0.7, gain: 0.07, type: 'triangle' });
    this.tone({ f: E5, at: 0.14, dur: 0.7, gain: 0.06, type: 'triangle' });
    this.tone({ f: 587.33, at: 0.4, dur: 1.0, gain: 0.06 });
  }
}

export const sound = new SoundEngine();
