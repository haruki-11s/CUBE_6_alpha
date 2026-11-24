/**
 * CUBE 6 sound effects, synthesised in code: no audio files, nothing to download.
 *
 * Every effect is rendered once into a dry stereo buffer by the pure functions in this file
 * (no Web Audio needed, so tests and tools can render them too); sound.ts plays the buffers
 * and sends each through one shared room (a convolution reverb whose impulse is made here too).
 *
 * The board is made of light and glass (glowing nodes, glass cubes, a holographic stage), so the
 * sounds are one small palette of clean, exact parts:
 * - motion is air with a faint tuned edge; its loudness and brightness follow the animation's
 *   speed, so it peaks when the layer moves fastest and is silent at rest (シュッ, シュイン);
 * - touches are exact digital clicks with a short glint of glass; where a piece or a layer locks
 *   into place there is a tight, solid body and a short low lock under it (パッ, カチッ);
 * - tones are glassy, struck and tuned to one key (E, with A and B): 王手, 秒読み, whose turn it
 *   is and the result.
 * Nothing slides in pitch like a toy, nothing booms on, and nothing plays a tune.
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

/** When a moving piece touches down (s after its flight starts): sound.ts plays the place sound there. */
export function moveLanding(speed: number): number {
  return ANIM.moveFlight / 1000 * roundSpeed(speed);
}

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
/** The tones all come from one key: E, with A and B (and a minor third for a loss). */
const NOTE = {
  A4: 440, C5: 523.25, E5: 659.26, A5: 880, B5: 987.77, E6: 1318.51, Fs6: 1479.98, A6: 1760,
  B6: 1975.53, E7: 2637.02, Fs7: 2959.96, A7: 3520,
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
  /** a faint tuned edge (シュイン): the same noise through a narrow band (sheenQ) at the band's centre, at this level */
  sheen?: number;
  sheenQ?: number;
  seed?: number;
}

/** Air: band-passed noise, swept and shaped (シュッ). Band and pan move at a 16-sample control rate. */
function air(m: Mix, at: number, o: AirOpts): void {
  // (options are read into locals once: the option objects differ in shape, and reading them per sample is slow)
  const sr = m.sr, n = Math.round(o.dur * sr), i0 = Math.round(at * sr);
  const { env, freq, pan, q, gain } = o;
  const sheen = o.sheen ?? 0, sq = o.sheenQ ?? 12;
  const rnd = rng(o.seed ?? 11);
  const w = o.width ?? 0.5, wc = Math.sqrt(1 - w), wi = Math.sqrt(w);
  const bl = new Svf(), br = new Svf(), tl = new Svf(), tr = new Svf(), hl = new Svf(), hr = new Svf();
  const hc = coef(o.low ?? 250, 0.7, sr);
  let c = hc, cs = hc, gl = 1, gr = 1;
  for (let i = 0; i < n; i++) {
    const x = i / n, e = env(x);
    if (i % 16 === 0) {
      const f = freq(x, e);
      c = coef(f, q, sr);
      if (sheen) cs = coef(f, sq, sr);
      if (pan) [gl, gr] = panGains(pan(x));
    }
    const common = rnd() * 2 - 1;
    const nl = wc * common + wi * (rnd() * 2 - 1), nr = wc * common + wi * (rnd() * 2 - 1);
    bl.tick(nl, c);
    br.tick(nr, c);
    let vl = bl.bp, vr = br.bp;
    if (sheen) {
      tl.tick(nl, cs);
      tr.tick(nr, cs);
      vl += sheen * tl.bp;
      vr += sheen * tr.bp;
    }
    hl.tick(vl, hc);
    hr.tick(vr, hc);
    const g = e * gain;
    m.add(i0 + i, hl.hp * g * gl, hr.hp * g * gr);
  }
}

interface TickOpts { f: number; q: number; gain: number; pan?: number }

/**
 * An exact digital click: a 3-sample pulse rung through one resonant band, with no noise in it
 * (the clean edge of パッ). `gain` is its peak. It starts 2 samples in, so no buffer starts on a step.
 */
function tick(m: Mix, at: number, o: TickOpts): void {
  const sr = m.sr, f = new Svf(), c = coef(o.f, o.q, sr);
  const n = Math.max(24, Math.round(9 * o.q / (Math.PI * o.f) * sr)), out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    f.tick(i === 3 ? 0.5 : i === 2 || i === 4 ? 0.25 : 0, c);
    out[i] = f.bp * tailFade(i, n);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const [gl, gr] = panGains(o.pan ?? 0), g = o.gain / peak, i0 = Math.round(at * sr);
  for (let i = 0; i < n; i++) m.add(i0 + i, out[i] * g * gl, out[i] * g * gr);
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

/** A low hit whose pitch drops as it dies: only for the self-destruct boom. */
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

interface BodyMode { f: number; q: number; decay: number; amp: number }

/**
 * A struck body: noise through narrow bands, each dying away at its own rate. Noise rather than
 * sines, so it sounds like a solid thing, not a note. Each band is scaled so that `amp` is about as
 * loud as a ring() mode of the same amp; `width` makes the two sides a little different.
 */
function body(m: Mix, at: number, modes: readonly BodyMode[], width = 0.25, seed = 23): void {
  const sr = m.sr, i0 = Math.round(at * sr), nAtt = 0.0004 * sr;
  const wc = Math.sqrt(1 - width), wi = Math.sqrt(width);
  for (const md of modes) {
    const n = Math.round(md.decay * 7 * sr + nAtt), rnd = rng(seed++);
    const fl = new Svf(), fr = new Svf(), c = coef(md.f, md.q, sr), dA = decayStep(md.decay, sr);
    // white noise (RMS 1/√3) through a band f/q wide, brought to the RMS of a sine of amplitude amp
    let a = md.amp * Math.sqrt(1.5 * md.q * sr / (Math.PI * md.f));
    for (let i = 0; i < n; i++) {
      const common = rnd() * 2 - 1;
      fl.tick(wc * common + wi * (rnd() * 2 - 1), c);
      fr.tick(wc * common + wi * (rnd() * 2 - 1), c);
      const g = a * Math.min(1, i / nAtt) * tailFade(i, n);
      a *= dA;
      m.add(i0 + i, fl.bp * g, fr.bp * g);
    }
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

/** A short glint of glass: an FM tone at an inharmonic ratio, bright for an instant, then nearly pure. */
function glint(m: Mix, at: number, f: number, decay: number, gain: number, pan = 0): void {
  bell(m, at, { f, decay, gain, attack: 0.0004, ratio: 1.41, index: 1.6, indexDecay: 0.003, glass: 0.15, pan });
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
      if ((i - pre) % 32 === 0) c = coef(glide(11000, 2400, t / rt60), 0.6, sr);
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

/**
 * Peak level (dBFS) of each sound, set so that its loudness (A-weighted, loudest 50 ms, at the
 * default volume, room included) sits where it should next to the others.
 */
const PEAK = {
  click: -14.5, hover: -24, 'toggle:1': -15.1, 'toggle:0': -17, open: -29.9, close: -30.5, whoosh: -25.3,
  invalid: -15.4, 'tick:0': -14.5, 'tick:1': -14.9, byoyomi: -18.8, start: -17.9,
  select: -13.9, deselect: -16.4, preview: -16.2, confirm: -11.5, cancel: -16.4,
  'place:O': -7.4, 'place:X': -7.6, move: -16.3, rotate: -13.3, slide: -15.6,
  'turn:O': -17.7, 'turn:X': -16.6, check: -10.6, undo: -18.1,
  win: -12.1, lose: -15.9, draw: -18.2, boom: -4.2, secret: -15.9,
} as const;

/** The banner sliding in from the left (turn and 王手). */
const bannerAir = (gain: number): AirOpts => ({
  dur: 0.2, env: x => arch(x, 0.32, 1.6), freq: x => glide(1400, 3900, smooth(x / 0.5)),
  q: 0.9, gain, width: 0.35, pan: x => -0.45 + 0.5 * x, sheen: 1.2,
});

/**
 * A piece docking into its cell, placed or landing after a move: an exact click, a tight solid
 * body, a short low lock under it, and a glint that says whose piece it is (O high, X a fourth lower).
 */
function dock(m: Mix, at: number, side: Side): void {
  const k = side === 'O' ? 1 : 0.94;
  tick(m, at, { f: 2800, q: 1.2, gain: 0.7 });
  body(m, at, [
    { f: 620 * k, q: 2.5, decay: 0.008, amp: 0.34 }, { f: 1100 * k, q: 3.5, decay: 0.006, amp: 0.26 },
    { f: 1800 * k, q: 4, decay: 0.004, amp: 0.14 },
  ]);
  ring(m, at, [{ f: 86 * k, decay: 0.013, amp: 0.28 }]);
  glint(m, at, side === 'O' ? NOTE.E7 : NOTE.B6, 0.016, 0.18);
}

/** A layer locking in after a turn (カチッ): two exact clicks 9 ms apart, a solid body, a low lock, a glint. */
function latch(m: Mix, at: number): void {
  tick(m, at, { f: 2600, q: 1.3, gain: 0.7 });
  tick(m, at + 0.009, { f: 3900, q: 1.8, gain: 0.35 });
  body(m, at, [{ f: 1200, q: 3, decay: 0.005, amp: 0.3 }, { f: 700, q: 2.5, decay: 0.007, amp: 0.24 }]);
  ring(m, at, [{ f: 78, decay: 0.014, amp: 0.3 }]);
  glint(m, at, NOTE.A6, 0.012, 0.18);
}

/** Renders one effect at the given sample rate. */
export function renderSfx(s: SfxSpec, sr: number): Sfx {
  switch (s.id) {
    // ── UI ───────────────────────────────────────────────────────────────
    case 'click': {
      // a button: an exact click, a little body and a glint (カチ)
      const m = new Mix(sr, 0.06);
      tick(m, 0, { f: 3000, q: 1.3, gain: 0.5 });
      body(m, 0, [{ f: 1250, q: 2.5, decay: 0.005, amp: 0.3 }, { f: 2600, q: 3, decay: 0.003, amp: 0.15 }], 0.1);
      glint(m, 0, NOTE.E7, 0.006, 0.14);
      return m.done(PEAK.click);
    }
    case 'hover': {
      // a pixel of light
      const m = new Mix(sr, 0.03);
      tick(m, 0, { f: 5200, q: 1.6, gain: 0.6 });
      glint(m, 0, NOTE.Fs7, 0.005, 0.18);
      return m.done(PEAK.hover);
    }
    case 'toggle': {
      // a two-step switch (チ・チン): the second, longer glint rises for on and falls for off
      const [a, b] = s.on ? [NOTE.B6, NOTE.E7] : [NOTE.E7, NOTE.B6];
      const m = new Mix(sr, 0.1);
      tick(m, 0, { f: 2600, q: 1.4, gain: 0.4 });
      glint(m, 0, a, 0.005, 0.12);
      tick(m, 0.018, { f: 3400, q: 1.4, gain: 0.55 });
      body(m, 0.018, [{ f: 1400, q: 2.5, decay: 0.004, amp: 0.22 }], 0.1);
      glint(m, 0.018, b, 0.012, 0.24);
      return m.done(PEAK[s.on ? 'toggle:1' : 'toggle:0']);
    }
    case 'open': {
      // a window opens: a rising シュイン
      const m = new Mix(sr, 0.17);
      air(m, 0, { dur: 0.16, env: x => arch(x, 0.35, 1.5), freq: x => glide(1300, 5200, x / 0.75), q: 0.85, gain: 1, width: 0.5, sheen: 1.6 });
      m.wet = 0.14;
      return m.done(PEAK.open);
    }
    case 'close': {
      const m = new Mix(sr, 0.14);
      air(m, 0, { dur: 0.13, env: x => arch(x, 0.22, 1.8), freq: x => glide(5000, 1500, x), q: 0.85, gain: 1, width: 0.5, sheen: 1.4 });
      m.wet = 0.12;
      return m.done(PEAK.close);
    }
    case 'whoosh': {
      // 展開表示: the layers spread apart
      const m = new Mix(sr, 0.31);
      air(m, 0, {
        dur: 0.3, env: x => arch(x, 0.38, 1.3),
        freq: x => (x < 0.38 ? glide(600, 3000, x / 0.38) : glide(3000, 1500, (x - 0.38) / 0.62)),
        q: 0.7, gain: 1, width: 0.85, pan: x => -0.2 + 0.4 * x, sheen: 1.2, sheenQ: 10,
      });
      m.wet = 0.15;
      return m.done(PEAK.whoosh);
    }
    case 'invalid': {
      // no: two short, muted low knocks at a fixed pitch (ドゥッ・ドゥッ)
      const m = new Mix(sr, 0.2);
      for (const [at, k, f] of [[0, 1, 165], [0.075, 0.8, 150]]) {
        ring(m, at, [{ f, decay: 0.012, amp: 0.55 * k }]);
        body(m, at, [{ f: 2.3 * f, q: 2, decay: 0.008, amp: 0.55 * k }], 0.1);
        tick(m, at, { f: 900, q: 1.5, gain: 0.3 * k });
      }
      return m.done(PEAK.invalid);
    }

    // ── Clock ────────────────────────────────────────────────────────────
    case 'tick': {
      // 秒読み: the tick of a precise clock; the last seconds are brighter
      const m = new Mix(sr, 0.06);
      if (s.urgent) {
        tick(m, 0, { f: 4600, q: 1.8, gain: 0.6 });
        glint(m, 0, NOTE.E7, 0.01, 0.4);
        return m.done(PEAK['tick:1']);
      }
      tick(m, 0, { f: 4200, q: 2, gain: 0.6 });
      glint(m, 0, NOTE.A7, 0.005, 0.22);
      return m.done(PEAK['tick:0']);
    }
    case 'byoyomi': {
      // main time used up: two quick glass pings, left then right
      const m = new Mix(sr, 0.75);
      for (const [at, pan] of [[0, -0.3], [0.13, 0.3]]) {
        bell(m, at, { f: NOTE.E6, decay: 0.11, gain: 1, index: 1.2, indexDecay: 0.01, ratio: 1.41, glass: 0.2, attack: 0.0015, pan });
      }
      m.wet = 0.18;
      return m.done(PEAK.byoyomi);
    }
    case 'start': {
      // the board appears: a soft, low swell of air with a tuned edge
      const m = new Mix(sr, 0.35);
      air(m, 0, {
        dur: 0.34, env: x => arch(x, 0.62, 1.2),
        freq: x => (x < 0.62 ? glide(260, 1600, x / 0.62) : glide(1600, 1100, (x - 0.62) / 0.38)),
        q: 0.6, gain: 1, width: 0.8, low: 120, sheen: 1.4, sheenQ: 14,
      });
      m.wet = 0.2;
      return m.done(PEAK.start);
    }

    // ── Board ────────────────────────────────────────────────────────────
    case 'select': {
      // a piece picked up: a light click and a clear glint (ティン)
      const m = new Mix(sr, 0.08);
      tick(m, 0, { f: 3300, q: 1.4, gain: 0.5 });
      body(m, 0, [{ f: 1500, q: 3, decay: 0.004, amp: 0.28 }], 0.1);
      glint(m, 0, NOTE.B6, 0.012, 0.26);
      return m.done(PEAK.select);
    }
    case 'deselect': {
      const m = new Mix(sr, 0.07);
      tick(m, 0, { f: 2400, q: 1.4, gain: 0.45 });
      body(m, 0, [{ f: 1100, q: 2.5, decay: 0.004, amp: 0.2 }], 0.1);
      glint(m, 0, NOTE.Fs6, 0.009, 0.26);
      return m.done(PEAK.deselect);
    }
    case 'preview': {
      const m = new Mix(sr, 0.04);
      tick(m, 0, { f: 3800, q: 1.8, gain: 0.5 });
      body(m, 0, [{ f: 1700, q: 3, decay: 0.003, amp: 0.15 }], 0.1);
      glint(m, 0, NOTE.E7, 0.005, 0.22);
      return m.done(PEAK.preview);
    }
    case 'confirm': {
      // a firm タンッ: click, solid body, a short low lock and a glint; the layer's own sound follows
      const m = new Mix(sr, 0.12);
      tick(m, 0, { f: 2200, q: 1.1, gain: 0.6 });
      body(m, 0, [{ f: 900, q: 2.5, decay: 0.007, amp: 0.36 }, { f: 1700, q: 3, decay: 0.005, amp: 0.2 }]);
      ring(m, 0, [{ f: 92, decay: 0.014, amp: 0.35 }]);
      glint(m, 0, NOTE.B6, 0.014, 0.22);
      m.wet = 0.08;
      return m.done(PEAK.confirm);
    }
    case 'cancel': {
      const m = new Mix(sr, 0.07);
      tick(m, 0, { f: 1700, q: 1.6, gain: 0.5 });
      body(m, 0, [{ f: 600, q: 2, decay: 0.006, amp: 0.26 }], 0.1);
      glint(m, 0, NOTE.E6, 0.007, 0.22);
      return m.done(PEAK.cancel);
    }
    case 'place': {
      // a piece docks into its cell; a moved piece lands with this same sound (sound.ts)
      const m = new Mix(sr, 0.16);
      dock(m, 0, s.side);
      m.wet = 0.1;
      return m.done(PEAK[`place:${s.side}`]);
    }
    case 'move': {
      // the flight only: air that follows the piece's speed and is silent as it touches down,
      // where sound.ts plays the place sound
      const d = moveLanding(s.speed);
      const m = new Mix(sr, d + 0.01);
      air(m, 0, {
        dur: d, env: x => Math.pow(cubicSpeed(x), 1.6), freq: (_x, e) => glide(800, 3600, Math.pow(e, 0.8)),
        q: 0.8, gain: 1, width: 0.5, sheen: 1.5,
      });
      m.wet = 0.08;
      return m.done(PEAK.move);
    }
    case 'rotate': {
      // air while the layer turns, then it locks in (シュイン…カチッ)
      const d = ANIM.rotate / 1000 * roundSpeed(s.speed);
      const m = new Mix(sr, d + 0.15);
      air(m, 0, {
        dur: 0.8 * d, env: x => Math.pow(cubicSpeed(x), 1.5), freq: (_x, e) => glide(650, 3400, Math.pow(e, 0.8)),
        q: 0.75, gain: 0.55, width: 0.6, pan: x => -0.15 + 0.3 * x, sheen: 1.4,
      });
      latch(m, ROTATE_LATCH * d);
      m.wet = 0.08;
      return m.done(PEAK.rotate);
    }
    case 'slide': {
      // a broader, darker air along the rail, and a soft magnetic stop
      const d = ANIM.slide / 1000 * roundSpeed(s.speed);
      const m = new Mix(sr, d + 0.15);
      air(m, 0, {
        dur: d, env: x => Math.pow(cubicSpeed(x), 1.3), freq: (_x, e) => glide(420, 2300, Math.pow(e, 0.8)),
        q: 0.6, gain: 0.8, width: 0.8, sheen: 1, sheenQ: 10,
      });
      const at = SLIDE_SETTLE * d;
      tick(m, at, { f: 1500, q: 1.4, gain: 0.45 });
      body(m, at, [{ f: 520, q: 2, decay: 0.009, amp: 0.34 }]);
      ring(m, at, [{ f: 70, decay: 0.015, amp: 0.35 }]);
      glint(m, at, NOTE.E6, 0.01, 0.12);
      m.wet = 0.1;
      return m.done(PEAK.slide);
    }
    case 'turn': {
      // the banner slides in from the left; a glass ping says whose turn it is, with one soft echo
      const m = new Mix(sr, 0.6);
      air(m, 0, bannerAir(0.8));
      const f = s.side === 'O' ? NOTE.E6 : NOTE.B5;
      bell(m, 0.07, { f, decay: 0.09, gain: 0.55, index: 1.2, indexDecay: 0.008, ratio: 1.41, glass: 0.15, attack: 0.0015, pan: 0.15 });
      bell(m, 0.18, { f, decay: 0.07, gain: 0.16, index: 0.8, indexDecay: 0.008, ratio: 1.41, attack: 0.0015, pan: -0.35 });
      m.wet = 0.14;
      return m.done(PEAK[`turn:${s.side}`]);
    }
    case 'check': {
      // 王手: the banner's air, then a bright struck fourth, twice (an alert, not a tune)
      const m = new Mix(sr, 0.95);
      air(m, 0, bannerAir(0.8));
      for (const [at, k] of [[0.06, 1], [0.145, 0.45]]) {
        tick(m, at, { f: 3600, q: 1.2, gain: 0.7 * k });
        bell(m, at, { f: NOTE.B5, decay: 0.14, gain: 0.7 * k, index: 1.3, indexDecay: 0.012, ratio: 1.41, glass: 0.3, attack: 0.0015, pan: -0.15 });
        bell(m, at, { f: NOTE.E6, decay: 0.12, gain: 0.6 * k, index: 1.2, indexDecay: 0.01, ratio: 1.41, glass: 0.25, attack: 0.0015, pan: 0.15 });
      }
      m.wet = 0.18;
      return m.done(PEAK.check);
    }
    case 'undo': {
      // rewind: a reversed swish moving back to the left, ending on a small click and glint
      const m = new Mix(sr, 0.24);
      air(m, 0, {
        dur: 0.17, env: x => (x < 0.88 ? smooth(x / 0.88) ** 2 : Math.max(0, 1 - (x - 0.88) / 0.12)),
        freq: x => glide(3600, 1300, x), q: 0.8, gain: 1, width: 0.4, pan: x => 0.25 - 0.5 * x, sheen: 1.4,
      });
      tick(m, 0.165, { f: 2200, q: 1.4, gain: 0.35 });
      glint(m, 0.165, NOTE.Fs6, 0.012, 0.16, -0.2);
      m.wet = 0.1;
      return m.done(PEAK.undo);
    }

    // ── Results ──────────────────────────────────────────────────────────
    case 'win': {
      // a rising swish into one struck, open chord (A–E–B) over a short low lock: no fanfare
      const m = new Mix(sr, 2.0);
      air(m, 0, { dur: 0.24, env: x => arch(x, 0.72, 1.4), freq: x => glide(900, 5600, smooth(x)), q: 0.8, gain: 0.55, width: 0.6, sheen: 1.2 });
      const at = 0.17;
      tick(m, at, { f: 4200, q: 1.2, gain: 0.5 });
      ring(m, at, [{ f: 55, decay: 0.05, amp: 0.25 }]);
      [NOTE.A5, NOTE.E6, NOTE.B6].forEach((f, k) => bell(m, at + k * 0.01, {
        f, decay: [0.32, 0.28, 0.24][k], gain: [1, 0.8, 0.6][k], index: 1.1, indexDecay: 0.03, glass: 0.2,
        attack: 0.003, pan: [-0.25, 0, 0.25][k],
      }));
      m.wet = 0.26;
      return m.done(PEAK.win);
    }
    case 'lose': {
      // muted and short: a soft minor third that sinks a little, like power running down
      const m = new Mix(sr, 1.95);
      air(m, 0, { dur: 0.3, env: x => arch(x, 0.25, 1.4), freq: x => glide(2600, 700, x), q: 0.7, gain: 0.35, width: 0.6, sheen: 1 });
      bell(m, 0.04, { f: NOTE.C5, decay: 0.3, gain: 0.8, index: 0.55, indexDecay: 0.05, attack: 0.008, bend: -0.035, pan: 0.15 });
      bell(m, 0.06, { f: NOTE.A4, decay: 0.34, gain: 0.9, index: 0.5, indexDecay: 0.05, attack: 0.008, bend: -0.035, pan: -0.15 });
      m.wet = 0.22;
      return m.done(PEAK.lose);
    }
    case 'draw': {
      // an open fifth (E–B), neither bright nor dark
      const m = new Mix(sr, 1.6);
      bell(m, 0, { f: NOTE.E5, decay: 0.28, gain: 0.9, index: 0.7, indexDecay: 0.03, attack: 0.004, glass: 0.1, pan: -0.15 });
      bell(m, 0.012, { f: NOTE.B5, decay: 0.25, gain: 0.75, index: 0.7, indexDecay: 0.03, attack: 0.004, glass: 0.1, pan: 0.15 });
      m.wet = 0.22;
      return m.done(PEAK.draw);
    }
    case 'boom': {
      // 自爆: a short, muffled low hit (the result follows separately)
      const m = new Mix(sr, 1.45);
      pop(m, 0, { f0: 90, f1: 45, bend: 0.05, decay: 0.2, gain: 1, harm: 0.2 });
      air(m, 0, { dur: 0.55, env: x => arch(x, 0.03, 2.5), freq: x => glide(1400, 160, Math.sqrt(x)), q: 0.6, gain: 0.9, width: 0.7, low: 50 });
      tick(m, 0, { f: 700, q: 0.8, gain: 0.6 });
      m.wet = 0.2;
      return m.done(PEAK.boom);
    }
    case 'secret': {
      // hidden level unlocked: two glass pings a fifth apart and a breath of high air
      const m = new Mix(sr, 1.65);
      bell(m, 0, { f: NOTE.E6, decay: 0.26, gain: 0.8, index: 1, indexDecay: 0.02, ratio: 1.41, glass: 0.4, attack: 0.002, pan: -0.15 });
      bell(m, 0.075, { f: NOTE.B6, decay: 0.28, gain: 0.75, index: 1, indexDecay: 0.02, ratio: 1.41, glass: 0.4, attack: 0.002, pan: 0.15 });
      air(m, 0.05, { dur: 0.45, env: x => arch(x, 0.25, 1.5), freq: () => 8000, q: 0.7, gain: 0.25, width: 0.95, low: 4000 });
      m.wet = 0.3;
      return m.done(PEAK.secret);
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
