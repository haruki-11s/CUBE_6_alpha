/**
 * CUBE 6 sound effects, synthesised in code: no audio files, nothing to download.
 *
 * Every effect is rendered once into a dry stereo buffer by the pure functions in this file
 * (no Web Audio needed, so tests and tools can render them too); sound.ts plays the buffers
 * and sends each through one shared room (a convolution reverb whose impulse is made here too).
 *
 * One small palette, so the whole game sounds like one thing:
 * - motion is air: band-passed noise whose loudness and brightness follow the animation's
 *   speed, so it peaks when the layer moves fastest and is silent at rest (シュッ);
 * - touches are short pops and ticks with a crisp attack (パッ);
 * - a soft glassy tone only where a sound must carry meaning: 王手, 秒読み and the result.
 * Nothing is a plain oscillator beep, and nothing plays a tune.
 */

export type Side = 'O' | 'X';

/** Everything the game can play. `speed` is the animation-duration multiplier (tween.ts). */
export type SfxSpec =
  | { id: 'click' } | { id: 'hover' } | { id: 'toggle'; on: boolean }
  | { id: 'open' } | { id: 'close' } | { id: 'whoosh' } | { id: 'invalid' }
  | { id: 'tick'; urgent: boolean } | { id: 'byoyomi' } | { id: 'start' }
  | { id: 'select' } | { id: 'deselect' } | { id: 'preview' } | { id: 'confirm' } | { id: 'cancel' }
  | { id: 'place'; side: Side } | { id: 'move'; speed: number }
  | { id: 'rotate'; speed: number } | { id: 'slide'; speed: number }
  | { id: 'turn'; side: Side } | { id: 'check' } | { id: 'undo' }
  | { id: 'win' } | { id: 'lose' } | { id: 'draw' } | { id: 'boom' } | { id: 'secret' };

export type Samples = Float32Array<ArrayBuffer>;
export interface Stereo { l: Samples; r: Samples }
/** A rendered effect: the dry sound, and how much of it goes to the shared room. */
export interface Sfx extends Stereo { wet: number }

/** Animation timings the sounds are cut to (ms at normal speed; scene3d.ts). */
export const ANIM = {
  /** a piece's flight; it lands (shockwave) at the end */
  moveFlight: 560,
  /** a layer turn: eases to 103.5 % over the first 80 %, then settles back */
  rotate: 600,
  /** a layer slide, ease-in-out over the whole time */
  slide: 600,
} as const;

/** Where in a turn the click goes: just after the layer passes 90° and slows into its overshoot. */
export const ROTATE_LATCH = 0.68;
/** Where in a slide the layer is visibly at rest. */
export const SLIDE_SETTLE = 0.9;

export function sfxKey(s: SfxSpec): string {
  switch (s.id) {
    case 'toggle': return `toggle:${s.on ? 1 : 0}`;
    case 'tick': return `tick:${s.urgent ? 1 : 0}`;
    case 'place': case 'turn': return `${s.id}:${s.side}`;
    case 'move': case 'rotate': case 'slide': return `${s.id}:${roundSpeed(s.speed)}`;
    default: return s.id;
  }
}

export function roundSpeed(speed: number): number {
  return Math.round(Math.min(3, Math.max(0.1, speed)) * 100) / 100;
}

// ═══════════════════════════════ Building blocks ═══════════════════════════

const TAU = 2 * Math.PI;
const NOTE = {
  A4: 440, C5: 523.25, E5: 659.26, A5: 880, B5: 987.77, E6: 1318.51, B6: 1975.53,
} as const;

/** Small deterministic PRNG (mulberry32): the same sound every time a buffer is rendered. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** 0 → 1 → 0 over x ∈ [0, 1], peaking at `peak`; `tail` > 1 makes the fall quicker at first. */
export function arch(x: number, peak: number, tail = 1): number {
  if (x <= 0 || x >= 1) return 0;
  if (x < peak) return 0.5 - 0.5 * Math.cos(Math.PI * x / peak);
  return Math.pow(0.5 + 0.5 * Math.cos(Math.PI * (x - peak) / (1 - peak)), tail);
}

/** Speed of an ease-in-out-cubic motion (tween.ts) at progress u, scaled to 1 at its fastest. */
export function cubicSpeed(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  const m = Math.min(u, 1 - u);
  return 4 * m * m;
}

/** Exponential glide from a to b as x goes 0 → 1. */
const glide = (a: number, b: number, x: number): number => a * Math.pow(b / a, Math.min(1, Math.max(0, x)));

/** Equal-power pan gains (−1 left … 1 right); the centre keeps full level on both sides. */
function panGains(p: number): [number, number] {
  if (p === 0) return [1, 1];
  const a = (Math.max(-1, Math.min(1, p)) + 1) * Math.PI / 4;
  return [Math.SQRT2 * Math.cos(a), Math.SQRT2 * Math.sin(a)];
}

/** Per-sample decay factor for an exponential with time constant `tau` seconds. */
const decayStep = (tau: number, sr: number): number => Math.exp(-1 / (tau * sr));

/** Raised-cosine fade over the last 12 % of a voice, so nothing is cut off with a click. */
function tailFade(i: number, n: number): number {
  const s = n * 0.88;
  return i < s ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (i - s) / (n - s));
}

interface Coef { k: number; a1: number; a2: number; a3: number }
function coef(fc: number, q: number, sr: number): Coef {
  const g = Math.tan(Math.PI * Math.min(fc, sr * 0.45) / sr), k = 1 / q, a1 = 1 / (1 + g * (g + k));
  return { k, a1, a2: g * a1, a3: g * g * a1 };
}

/** Topology-preserving state-variable filter (Simper / Zavalishin): stays clean under fast sweeps. */
class Svf {
  private s1 = 0;
  private s2 = 0;
  lp = 0;
  /** band-pass with unity gain at the centre */
  bp = 0;
  hp = 0;
  tick(x: number, c: Coef): void {
    const v3 = x - this.s2;
    const v1 = c.a1 * this.s1 + c.a2 * v3;
    const v2 = this.s2 + c.a2 * this.s1 + c.a3 * v3;
    this.s1 = 2 * v1 - this.s1;
    this.s2 = 2 * v2 - this.s2;
    this.lp = v2;
    this.bp = c.k * v1;
    this.hp = x - c.k * v1 - v2;
  }
}

class Mix {
  readonly l: Samples;
  readonly r: Samples;
  /** send level to the shared room (sound.ts) */
  wet = 0;
  constructor(readonly sr: number, seconds: number) {
    const n = Math.ceil(seconds * this.sr);
    this.l = new Float32Array(n);
    this.r = new Float32Array(n);
  }

  add(i: number, vl: number, vr: number): void {
    if (i >= 0 && i < this.l.length) {
      this.l[i] += vl;
      this.r[i] += vr;
    }
  }

  /** Removes DC, trims the silent end, and scales the sound so its peak is `peakDb` dBFS. */
  done(peakDb: number): Sfx {
    const n = this.l.length, sr = this.sr;
    const hl = new Svf(), hr = new Svf(), c = coef(25, 0.7, sr);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      hl.tick(this.l[i], c);
      hr.tick(this.r[i], c);
      this.l[i] = hl.hp;
      this.r[i] = hr.hp;
      peak = Math.max(peak, Math.abs(hl.hp), Math.abs(hr.hp));
    }
    if (peak <= 0) return { l: new Float32Array(1), r: new Float32Array(1), wet: 0 };
    const k = Math.pow(10, peakDb / 20) / peak;
    const floor = peak * Math.pow(10, -76 / 20);
    let end = n;
    while (end > 1 && Math.abs(this.l[end - 1]) < floor && Math.abs(this.r[end - 1]) < floor) end--;
    end = Math.min(n, end + Math.round(0.004 * sr));
    const fade = Math.min(end, Math.round(0.008 * sr));
    const l = this.l.slice(0, end), r = this.r.slice(0, end);
    for (let i = 0; i < end; i++) {
      const f = i < end - fade ? 1 : (end - i) / fade;
      l[i] *= k * f;
      r[i] *= k * f;
    }
    return { l, r, wet: this.wet };
  }
}

interface AirOpts {
  dur: number;
  /** loudness over x = t / dur; 0 at both ends */
  env: (x: number) => number;
  /** band centre (Hz) at x, given the loudness e there */
  freq: (x: number, e: number) => number;
  q: number;
  gain: number;
  pan?: (x: number) => number;
  /** 0: the same noise on both sides … 1: independent (wide) */
  width?: number;
  /** high-pass corner under the band (Hz) */
  low?: number;
  seed?: number;
}

/** Air: band-passed noise, swept and shaped (シュッ). Band and pan move at a 16-sample control rate. */
function air(m: Mix, at: number, o: AirOpts): void {
  // (options are read into locals once: the option objects differ in shape, and reading them per sample is slow)
  const sr = m.sr, n = Math.round(o.dur * sr), i0 = Math.round(at * sr);
  const { env, freq, pan, q, gain } = o;
  const rnd = rng(o.seed ?? 11);
  const w = o.width ?? 0.5, wc = Math.sqrt(1 - w), wi = Math.sqrt(w);
  const bl = new Svf(), br = new Svf(), hl = new Svf(), hr = new Svf();
  const hc = coef(o.low ?? 250, 0.7, sr);
  let c = hc, gl = 1, gr = 1;
  for (let i = 0; i < n; i++) {
    const x = i / n, e = env(x);
    if (i % 16 === 0) {
      c = coef(freq(x, e), q, sr);
      if (pan) [gl, gr] = panGains(pan(x));
    }
    const common = rnd() * 2 - 1;
    bl.tick(wc * common + wi * (rnd() * 2 - 1), c);
    br.tick(wc * common + wi * (rnd() * 2 - 1), c);
    hl.tick(bl.bp, hc);
    hr.tick(br.bp, hc);
    const g = e * gain;
    m.add(i0 + i, hl.hp * g * gl, hr.hp * g * gr);
  }
}

interface PopOpts {
  f0: number;
  f1: number;
  /** time constant of the pitch drop f0 → f1 (s) */
  bend: number;
  /** amplitude time constant (s) */
  decay: number;
  gain: number;
  attack?: number;
  /** amount of the 2nd harmonic */
  harm?: number;
}

/** A pitched pop: a sine that drops fast and dies away (パッ, ポッ, トッ). */
function pop(m: Mix, at: number, o: PopOpts): void {
  const sr = m.sr, nAtt = (o.attack ?? 0.0006) * sr;
  const n = Math.round(o.decay * 6.5 * sr + nAtt), i0 = Math.round(at * sr);
  const dA = decayStep(o.decay, sr), dB = decayStep(o.bend, sr), h = o.harm ?? 0, f1 = o.f1;
  let ph = 0, a = o.gain, df = o.f0 - f1;
  for (let i = 0; i < n; i++) {
    ph += TAU * (f1 + df) / sr;
    df *= dB;
    const v = (Math.sin(ph) + h * Math.sin(2 * ph)) * a * Math.min(1, i / nAtt) * tailFade(i, n);
    a *= dA;
    m.add(i0 + i, v, v);
  }
}

interface BurstOpts {
  /** length of the noise burst (s); it is Hann-windowed, so the edge is crisp but not digital */
  len: number;
  f: number;
  q?: number;
  type?: 'bp' | 'lp';
  gain: number;
  seed?: number;
}

/** A tiny noise transient: the edge of a touch. */
function burst(m: Mix, at: number, o: BurstOpts): void {
  const sr = m.sr, n = Math.max(2, Math.round(o.len * sr)), tail = Math.round(0.006 * sr);
  const i0 = Math.round(at * sr), rnd = rng(o.seed ?? 5), lp = o.type === 'lp', gain = o.gain;
  const f = new Svf(), c = coef(o.f, o.q ?? 0.8, sr);
  for (let i = 0; i < n + tail; i++) {
    const x = i < n ? (rnd() * 2 - 1) * (0.5 - 0.5 * Math.cos(TAU * i / (n - 1))) : 0;
    f.tick(x, c);
    const v = (lp ? f.lp : f.bp) * gain * (i < n ? 1 : tailFade(i - n + tail, 2 * tail));
    m.add(i0 + i, v, v);
  }
}

interface SnapOpts { f: number; q: number; decay: number; gain: number; seed?: number }

/** A snap: noise through a band, gone in a few ms: the crisp "パ" of パッ (a pop alone is "ポ"). */
function snap(m: Mix, at: number, o: SnapOpts): void {
  const sr = m.sr, nAtt = 0.0004 * sr, n = Math.round(o.decay * 6 * sr + nAtt), i0 = Math.round(at * sr);
  const rnd = rng(o.seed ?? 17), f = new Svf(), c = coef(o.f, o.q, sr), dA = decayStep(o.decay, sr);
  let a = o.gain;
  for (let i = 0; i < n; i++) {
    f.tick(rnd() * 2 - 1, c);
    const v = f.bp * a * Math.min(1, i / nAtt) * tailFade(i, n);
    a *= dA;
    m.add(i0 + i, v, v);
  }
}

/** Struck resonances: short decaying sines with an instant (0.25 ms) attack. */
function ring(m: Mix, at: number, modes: { f: number; decay: number; amp: number }[]): void {
  const sr = m.sr, i0 = Math.round(at * sr), nAtt = 0.00025 * sr;
  for (const md of modes) {
    const n = Math.round(md.decay * 7 * sr + nAtt), w = TAU * md.f / sr, c = 2 * Math.cos(w), dA = decayStep(md.decay, sr);
    let y1 = 0, y2 = -Math.sin(w), a = md.amp;
    for (let i = 0; i < n; i++) {
      const y = c * y1 - y2; // sin(w·(i+1)), by recursion
      y2 = y1;
      y1 = y;
      const v = y * a * Math.min(1, i / nAtt) * tailFade(i, n);
      a *= dA;
      m.add(i0 + i, v, v);
    }
  }
}

interface BellOpts {
  f: number;
  decay: number;
  gain: number;
  attack?: number;
  /** FM: modulator ratio and brightness (index), which fades with indexDecay */
  ratio?: number;
  index?: number;
  indexDecay?: number;
  /** a faint inharmonic partial at the strike, for a glassy edge */
  glass?: number;
  /** pitch change over the first ~0.3 s, e.g. −0.03 */
  bend?: number;
  pan?: number;
}

/** A soft glassy tone (FM): bright at the strike, then close to a pure sine. */
function bell(m: Mix, at: number, o: BellOpts): void {
  const sr = m.sr, nAtt = (o.attack ?? 0.002) * sr;
  const n = Math.round(o.decay * 5.5 * sr + nAtt), i0 = Math.round(at * sr);
  const ratio = o.ratio ?? 1, bend = o.bend ?? 0, w0 = TAU * o.f / sr;
  const dA = decayStep(o.decay, sr), dI = decayStep(o.indexDecay ?? 0.02, sr), dG = decayStep(0.012, sr), dB = decayStep(0.12, sr);
  const [gl, gr] = panGains(o.pan ?? 0);
  let pc = 0, pm = 0, pg = 0, a = o.gain, idx = o.index ?? 1, gls = o.glass ?? 0, b = 1;
  for (let i = 0; i < n; i++) {
    const w = w0 * (1 + bend * (1 - b));
    b *= dB;
    pc += w;
    pm += w * ratio;
    let s = Math.sin(pc + idx * Math.sin(pm));
    idx *= dI;
    if (gls > 1e-4) {
      pg += w * 3.53;
      s += gls * Math.sin(pg);
      gls *= dG;
    }
    const v = s * a * (i < nAtt ? Math.sin(Math.PI / 2 * i / nAtt) ** 2 : 1) * tailFade(i, n);
    a *= dA;
    m.add(i0 + i, v * gl, v * gr);
  }
}

/**
 * The room every sound shares (a convolution reverb in sound.ts): 10 ms of pre-delay, then a
 * smooth noise tail that falls 60 dB over `rt60` seconds and darkens as it goes. The two sides
 * are independent (width); each has unit energy, so a send level of x returns a steady sound at
 * about x of its level.
 */
export function roomImpulse(sr: number, rt60 = 0.8): Stereo {
  const pre = Math.round(0.01 * sr), n = pre + Math.round(rt60 * 1.1 * sr);
  const side = (seed: number): Samples => {
    const h = new Float32Array(n), rnd = rng(seed);
    const lp = new Svf(), hp = new Svf(), hc = coef(220, 0.7, sr);
    const step = Math.pow(10, -3 / (rt60 * sr)); // −60 dB over rt60
    let c = hc, energy = 0, env = 1;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      if ((i - pre) % 32 === 0) c = coef(glide(9000, 1800, t / rt60), 0.6, sr);
      lp.tick(rnd() * 2 - 1, c);
      hp.tick(lp.lp, hc);
      h[i] = hp.hp * env * Math.min(1, t / 0.004) * tailFade(i - pre, n - pre);
      env *= step;
      energy += h[i] * h[i];
    }
    const k = 1 / Math.sqrt(energy);
    for (let i = pre; i < n; i++) h[i] *= k;
    return h;
  };
  return { l: side(101), r: side(202) };
}

// ═══════════════════════════════ The sounds ════════════════════════════════

/** The banner sliding in from the left (turn and 王手). */
const bannerAir = (gain: number): AirOpts => ({
  dur: 0.2, env: x => arch(x, 0.32, 1.6), freq: x => glide(1400, 3900, smooth(x / 0.5)),
  q: 0.9, gain, width: 0.35, pan: x => -0.45 + 0.5 * x,
});

/** Renders one effect at the given sample rate. */
export function renderSfx(s: SfxSpec, sr: number): Sfx {
  switch (s.id) {
    // ── UI ───────────────────────────────────────────────────────────────
    case 'click': {
      // buttons: a soft, short tap: a crisp edge with a little body, no ring
      const m = new Mix(sr, 0.08);
      burst(m, 0, { len: 0.0012, f: 4500, gain: 0.55 });
      pop(m, 0, { f0: 1700, f1: 900, bend: 0.0025, decay: 0.011, gain: 1, harm: 0.08 });
      ring(m, 0, [{ f: 2800, decay: 0.005, amp: 0.3 }]);
      return m.done(-20);
    }
    case 'hover': {
      const m = new Mix(sr, 0.03);
      burst(m, 0, { len: 0.0007, f: 5500, q: 1.1, gain: 1 });
      ring(m, 0, [{ f: 4600, decay: 0.0025, amp: 0.45 }]);
      return m.done(-26);
    }
    case 'toggle': {
      const k = s.on ? 1.25 : 0.85;
      const m = new Mix(sr, 0.1);
      burst(m, 0, { len: 0.001, f: 4000 * k, gain: 0.5 });
      pop(m, 0, { f0: 1500 * k, f1: 850 * k, bend: 0.003, decay: 0.014, gain: 1 });
      ring(m, 0, [{ f: 2300 * k, decay: 0.008, amp: 0.4 }]);
      return m.done(s.on ? -20.6 : -21.2);
    }
    case 'open': {
      const m = new Mix(sr, 0.15);
      air(m, 0, { dur: 0.14, env: x => arch(x, 0.32, 1.5), freq: x => glide(1500, 5400, x / 0.7), q: 0.85, gain: 1, width: 0.45 });
      m.wet = 0.12;
      return m.done(-28);
    }
    case 'close': {
      const m = new Mix(sr, 0.13);
      air(m, 0, { dur: 0.12, env: x => arch(x, 0.2, 1.8), freq: x => glide(5000, 1600, x), q: 0.85, gain: 1, width: 0.45 });
      m.wet = 0.1;
      return m.done(-30.5);
    }
    case 'whoosh': {
      // 展開表示: the layers spread apart
      const m = new Mix(sr, 0.31);
      air(m, 0, {
        dur: 0.3, env: x => arch(x, 0.38, 1.3),
        freq: x => (x < 0.38 ? glide(600, 3000, x / 0.38) : glide(3000, 1500, (x - 0.38) / 0.62)),
        q: 0.7, gain: 1, width: 0.85, pan: x => -0.2 + 0.4 * x,
      });
      m.wet = 0.15;
      return m.done(-25);
    }
    case 'invalid': {
      // a dull double knock instead of a buzzer
      const m = new Mix(sr, 0.26);
      [[0, 1, 210], [0.075, 0.8, 190]].forEach(([at, k, f]) => {
        pop(m, at, { f0: 420, f1: f, bend: 0.004, decay: 0.026, gain: k, harm: 0.15 });
        burst(m, at, { len: 0.0015, f: 1100, type: 'lp', gain: 0.35 * k });
      });
      return m.done(-19);
    }

    // ── Clock ────────────────────────────────────────────────────────────
    case 'tick': {
      const m = new Mix(sr, 0.07);
      if (s.urgent) {
        burst(m, 0, { len: 0.0008, f: 4200, gain: 0.5 });
        ring(m, 0, [{ f: 3300, decay: 0.009, amp: 1 }, { f: 5100, decay: 0.004, amp: 0.4 }]);
        pop(m, 0, { f0: 1300, f1: 900, bend: 0.002, decay: 0.007, gain: 0.4 });
        return m.done(-14.4);
      }
      burst(m, 0, { len: 0.0008, f: 3500, gain: 0.5 });
      ring(m, 0, [{ f: 2500, decay: 0.006, amp: 1 }, { f: 3900, decay: 0.003, amp: 0.35 }]);
      pop(m, 0, { f0: 1000, f1: 700, bend: 0.002, decay: 0.006, gain: 0.35 });
      return m.done(-20);
    }
    case 'byoyomi': {
      // main time used up: two quick soft pings
      const m = new Mix(sr, 0.75);
      for (const at of [0, 0.13]) bell(m, at, { f: NOTE.E6, decay: 0.11, gain: 1, index: 1.1, indexDecay: 0.012, ratio: 2, glass: 0.25, attack: 0.0015 });
      m.wet = 0.18;
      return m.done(-21.5);
    }
    case 'start': {
      // the board appears: a soft low swell of air
      const m = new Mix(sr, 0.35);
      air(m, 0, {
        dur: 0.34, env: x => arch(x, 0.62, 1.2),
        freq: x => (x < 0.62 ? glide(260, 1600, x / 0.62) : glide(1600, 1100, (x - 0.62) / 0.38)),
        q: 0.6, gain: 1, width: 0.8, low: 120,
      });
      m.wet = 0.2;
      return m.done(-18.1);
    }

    // ── Board ────────────────────────────────────────────────────────────
    case 'select': {
      // a light, high パチッ
      const m = new Mix(sr, 0.08);
      snap(m, 0, { f: 3000, q: 1.4, decay: 0.007, gain: 1.5 });
      pop(m, 0, { f0: 2300, f1: 1300, bend: 0.0025, decay: 0.011, gain: 0.7, harm: 0.05 });
      return m.done(-14.9);
    }
    case 'deselect': {
      const m = new Mix(sr, 0.12);
      burst(m, 0, { len: 0.001, f: 3500, gain: 0.3 });
      pop(m, 0, { f0: 1300, f1: 780, bend: 0.003, decay: 0.018, gain: 1 });
      return m.done(-22.4);
    }
    case 'preview': {
      const m = new Mix(sr, 0.045);
      burst(m, 0, { len: 0.0008, f: 4000, gain: 0.5 });
      ring(m, 0, [{ f: 2900, decay: 0.005, amp: 1 }, { f: 4400, decay: 0.003, amp: 0.4 }]);
      pop(m, 0, { f0: 1400, f1: 1000, bend: 0.002, decay: 0.006, gain: 0.3 });
      return m.done(-19.8);
    }
    case 'confirm': {
      // a firm パッ; the layer's own sound follows 80 ms later
      const m = new Mix(sr, 0.2);
      snap(m, 0, { f: 1600, q: 1.1, decay: 0.01, gain: 1.4 });
      burst(m, 0, { len: 0.0012, f: 4500, gain: 0.5 });
      pop(m, 0, { f0: 1900, f1: 720, bend: 0.004, decay: 0.02, gain: 0.8, harm: 0.08 });
      pop(m, 0, { f0: 240, f1: 150, bend: 0.01, decay: 0.03, gain: 0.3 });
      return m.done(-15.8);
    }
    case 'cancel': {
      const m = new Mix(sr, 0.15);
      burst(m, 0, { len: 0.001, f: 2500, gain: 0.2 });
      pop(m, 0, { f0: 900, f1: 520, bend: 0.004, decay: 0.022, gain: 1 });
      return m.done(-22.4);
    }
    case 'place': {
      // the main touch (パッ): a snap, a short bright body, a little weight, a spark of air
      const k = s.side === 'O' ? 1 : 0.89;
      const m = new Mix(sr, 0.3);
      snap(m, 0, { f: 1900 * k, q: 1.1, decay: 0.012, gain: 1.6 });
      burst(m, 0, { len: 0.0012, f: 5500, q: 0.7, gain: 0.5 });
      pop(m, 0, { f0: 2200 * k, f1: 820 * k, bend: 0.003, decay: 0.02, gain: 0.7, harm: 0.05 });
      pop(m, 0, { f0: 230 * k, f1: 140 * k, bend: 0.012, decay: 0.045, gain: 0.35 });
      air(m, 0, { dur: 0.09, env: x => arch(x, 0.06, 2.2), freq: () => 7000, q: 0.7, gain: 0.5, width: 0.9, low: 3000 });
      m.wet = 0.1;
      return m.done(s.side === 'O' ? -5.3 : -4.3);
    }
    case 'move': {
      // the piece's flight is air that follows its speed; it lands with a soft touch
      const d = ANIM.moveFlight / 1000 * roundSpeed(s.speed);
      const m = new Mix(sr, d + 0.3);
      air(m, 0, {
        dur: d, env: x => Math.pow(cubicSpeed(x), 1.6), freq: (_x, e) => glide(800, 3600, Math.pow(e, 0.8)),
        q: 0.8, gain: 1.3, width: 0.5,
      });
      burst(m, d, { len: 0.0015, f: 2600, q: 0.7, gain: 0.5 });
      pop(m, d, { f0: 1100, f1: 330, bend: 0.005, decay: 0.03, gain: 1.4, harm: 0.05 });
      pop(m, d, { f0: 180, f1: 120, bend: 0.012, decay: 0.045, gain: 0.5 });
      m.wet = 0.08;
      return m.done(-11);
    }
    case 'rotate': {
      // air while the layer turns, then one solid click as it snaps into place (シュッ…カチッ)
      const d = ANIM.rotate / 1000 * roundSpeed(s.speed);
      const m = new Mix(sr, d + 0.2);
      air(m, 0, {
        dur: 0.8 * d, env: x => Math.pow(cubicSpeed(x), 1.5), freq: (_x, e) => glide(650, 3400, Math.pow(e, 0.8)),
        q: 0.75, gain: 1.4, width: 0.6, pan: x => -0.15 + 0.3 * x,
      });
      const at = ROTATE_LATCH * d;
      burst(m, at, { len: 0.0012, f: 3800, gain: 0.7 });
      ring(m, at, [{ f: 1850, decay: 0.009, amp: 0.6 }, { f: 3050, decay: 0.005, amp: 0.35 }]);
      pop(m, at, { f0: 900, f1: 260, bend: 0.004, decay: 0.03, gain: 1, harm: 0.05 });
      m.wet = 0.08;
      return m.done(-10.8);
    }
    case 'slide': {
      // a broader, darker air for the slide, and a soft stop
      const d = ANIM.slide / 1000 * roundSpeed(s.speed);
      const m = new Mix(sr, d + 0.3);
      air(m, 0, {
        dur: d, env: x => Math.pow(cubicSpeed(x), 1.3), freq: (_x, e) => glide(420, 2300, Math.pow(e, 0.8)),
        q: 0.6, gain: 1.4, width: 0.8,
      });
      const at = SLIDE_SETTLE * d;
      burst(m, at, { len: 0.0018, f: 1400, q: 0.7, gain: 0.4 });
      pop(m, at, { f0: 520, f1: 170, bend: 0.006, decay: 0.04, gain: 1 });
      m.wet = 0.1;
      return m.done(-14.9);
    }
    case 'turn': {
      // the banner slides in from the left; a soft ping says whose turn it is
      const m = new Mix(sr, 0.6);
      air(m, 0, bannerAir(0.8));
      bell(m, 0.07, { f: s.side === 'O' ? NOTE.E6 : NOTE.B5, decay: 0.09, gain: 0.55, index: 0.9, indexDecay: 0.01, attack: 0.002 });
      m.wet = 0.14;
      return m.done(s.side === 'O' ? -18.4 : -17.3);
    }
    case 'check': {
      // 王手: the banner's air, a sharp edge and a bright struck fourth
      const m = new Mix(sr, 0.95);
      air(m, 0, bannerAir(0.8));
      burst(m, 0.06, { len: 0.0014, f: 4800, gain: 0.9 });
      bell(m, 0.06, { f: NOTE.B5, decay: 0.16, gain: 0.7, index: 1.3, indexDecay: 0.015, glass: 0.35, attack: 0.0015, pan: -0.15 });
      bell(m, 0.06, { f: NOTE.E6, decay: 0.14, gain: 0.6, index: 1.2, indexDecay: 0.012, glass: 0.3, attack: 0.0015, pan: 0.15 });
      m.wet = 0.18;
      return m.done(-11.9);
    }
    case 'undo': {
      // a reversed swish (it swells and stops short), moving back to the left
      const m = new Mix(sr, 0.26);
      air(m, 0, {
        dur: 0.17, env: x => (x < 0.88 ? smooth(x / 0.88) ** 2 : Math.max(0, 1 - (x - 0.88) / 0.12)),
        freq: x => glide(3600, 1300, x), q: 0.8, gain: 1, width: 0.4, pan: x => 0.25 - 0.5 * x,
      });
      pop(m, 0.16, { f0: 1100, f1: 650, bend: 0.003, decay: 0.014, gain: 0.5 });
      m.wet = 0.1;
      return m.done(-18.5);
    }

    // ── Results ──────────────────────────────────────────────────────────
    case 'win': {
      // a rising swish into one struck, open chord (A–E–B): bright, short, no fanfare
      const m = new Mix(sr, 2.0);
      air(m, 0, { dur: 0.24, env: x => arch(x, 0.72, 1.4), freq: x => glide(900, 5600, smooth(x)), q: 0.8, gain: 0.55, width: 0.6 });
      const at = 0.17;
      burst(m, at, { len: 0.0015, f: 6000, q: 0.7, gain: 0.5 });
      [NOTE.A5, NOTE.E6, NOTE.B6].forEach((f, k) => bell(m, at + k * 0.01, {
        f, decay: [0.32, 0.28, 0.24][k], gain: [1, 0.8, 0.6][k], index: 1.1, indexDecay: 0.03, glass: 0.2,
        attack: 0.003, pan: [-0.25, 0, 0.25][k],
      }));
      m.wet = 0.26;
      return m.done(-12.7);
    }
    case 'lose': {
      // muted and short: a soft minor third that sinks a little
      const m = new Mix(sr, 1.95);
      air(m, 0, { dur: 0.3, env: x => arch(x, 0.25, 1.4), freq: x => glide(2600, 700, x), q: 0.7, gain: 0.35, width: 0.6 });
      bell(m, 0.04, { f: NOTE.C5, decay: 0.3, gain: 0.8, index: 0.55, indexDecay: 0.05, attack: 0.008, bend: -0.035, pan: 0.15 });
      bell(m, 0.06, { f: NOTE.A4, decay: 0.34, gain: 0.9, index: 0.5, indexDecay: 0.05, attack: 0.008, bend: -0.035, pan: -0.15 });
      m.wet = 0.22;
      return m.done(-16);
    }
    case 'draw': {
      const m = new Mix(sr, 1.6);
      bell(m, 0, { f: NOTE.E5, decay: 0.28, gain: 0.9, index: 0.7, indexDecay: 0.03, attack: 0.004, pan: -0.15 });
      bell(m, 0.012, { f: NOTE.A5, decay: 0.25, gain: 0.75, index: 0.7, indexDecay: 0.03, attack: 0.004, pan: 0.15 });
      m.wet = 0.22;
      return m.done(-18.1);
    }
    case 'boom': {
      // 自爆: a short, muffled low hit (the result follows separately)
      const m = new Mix(sr, 1.45);
      pop(m, 0, { f0: 110, f1: 42, bend: 0.05, decay: 0.22, gain: 1, harm: 0.25 });
      air(m, 0, { dur: 0.55, env: x => arch(x, 0.03, 2.5), freq: x => glide(1400, 160, Math.sqrt(x)), q: 0.6, gain: 0.9, width: 0.7, low: 50 });
      burst(m, 0, { len: 0.003, f: 900, type: 'lp', gain: 0.6 });
      m.wet = 0.2;
      return m.done(-4.1);
    }
    case 'secret': {
      // hidden level unlocked: two glassy pings a fifth apart and a breath of high air
      const m = new Mix(sr, 1.65);
      bell(m, 0, { f: NOTE.E6, decay: 0.26, gain: 0.8, index: 0.9, indexDecay: 0.02, glass: 0.5, attack: 0.002, pan: -0.15 });
      bell(m, 0.075, { f: NOTE.B6, decay: 0.28, gain: 0.75, index: 0.9, indexDecay: 0.02, glass: 0.5, attack: 0.002, pan: 0.15 });
      air(m, 0.05, { dur: 0.45, env: x => arch(x, 0.25, 1.5), freq: () => 8000, q: 0.7, gain: 0.25, width: 0.95, low: 4000 });
      m.wet = 0.3;
      return m.done(-15.9);
    }
  }
}

/** One of each sound (all speeds and sides), for tests and previews. */
export const ALL_SFX: readonly SfxSpec[] = [
  { id: 'click' }, { id: 'hover' }, { id: 'toggle', on: true }, { id: 'toggle', on: false },
  { id: 'open' }, { id: 'close' }, { id: 'whoosh' }, { id: 'invalid' },
  { id: 'tick', urgent: false }, { id: 'tick', urgent: true }, { id: 'byoyomi' }, { id: 'start' },
  { id: 'select' }, { id: 'deselect' }, { id: 'preview' }, { id: 'confirm' }, { id: 'cancel' },
  { id: 'place', side: 'O' }, { id: 'place', side: 'X' },
  ...[0.55, 1, 1.5].flatMap(speed => [
    { id: 'move', speed } as const, { id: 'rotate', speed } as const, { id: 'slide', speed } as const,
  ]),
  { id: 'turn', side: 'O' }, { id: 'turn', side: 'X' }, { id: 'check' }, { id: 'undo' },
  { id: 'win' }, { id: 'lose' }, { id: 'draw' }, { id: 'boom' }, { id: 'secret' },
];
