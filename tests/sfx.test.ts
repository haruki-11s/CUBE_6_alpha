import { describe, expect, it } from 'vitest';
import {
  ALL_SFX, ANIM, ROTATE_LATCH, SLIDE_SETTLE, arch, cubicSpeed, moveLanding, renderSfx, roomImpulse, sfxKey,
  type SfxSpec, type Stereo,
} from '../src/ui/sfx';

const SR = 48000;
const rendered = ALL_SFX.map(s => ({ s, key: sfxKey(s), out: renderSfx(s, SR) }));

function peakOf({ l, r }: Stereo): { peak: number; at: number } {
  let peak = 0, at = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    if (a > peak) { peak = a; at = i / SR; }
  }
  return { peak, at };
}

/** Loudest 50 ms RMS (both channels). */
function loudest({ l, r }: Stereo): number {
  const w = Math.round(0.05 * SR);
  let acc = 0, best = 0;
  for (let i = 0; i < l.length; i++) {
    acc += (l[i] * l[i] + r[i] * r[i]) / 2;
    if (i >= w) acc -= (l[i - w] * l[i - w] + r[i - w] * r[i - w]) / 2;
    best = Math.max(best, acc / w);
  }
  return Math.sqrt(best);
}

describe('sound effects', () => {
  it('every effect has its own cache key', () => {
    expect(new Set(rendered.map(x => x.key)).size).toBe(ALL_SFX.length);
  });

  it.each(rendered.map(x => [x.key, x.out] as const))('%s is clean: finite, no clipping, no DC, silent at both ends', (_key, out) => {
    const { l, r, wet } = out;
    expect(l.length).toBe(r.length);
    expect(l.length / SR).toBeGreaterThan(0.015);
    expect(l.length / SR).toBeLessThan(2.5);
    let sum = 0, finite = true;
    for (let i = 0; i < l.length; i++) {
      finite &&= Number.isFinite(l[i]) && Number.isFinite(r[i]);
      sum += l[i] + r[i];
    }
    expect(finite).toBe(true);
    const { peak } = peakOf(out);
    expect(peak).toBeLessThan(0.7); // ≤ −3 dBFS before the volume setting
    expect(peak).toBeGreaterThan(0.01);
    expect(Math.abs(sum / (2 * l.length))).toBeLessThan(1e-3);
    expect(Math.max(Math.abs(l[0]), Math.abs(r[0]))).toBeLessThan(0.02 * peak); // no click at the start
    expect(Math.max(Math.abs(l[l.length - 1]), Math.abs(r[r.length - 1]))).toBeLessThan(1e-3 * peak); // nor at the end
    expect(wet).toBeGreaterThanOrEqual(0);
    expect(wet).toBeLessThanOrEqual(0.5);
  });

  it('renders the same sound every time', () => {
    for (const s of [{ id: 'place', side: 'O' }, { id: 'rotate', speed: 1 }, { id: 'win' }] as SfxSpec[]) {
      const a = renderSfx(s, SR), b = renderSfx(s, SR);
      expect(a.l).toEqual(b.l);
      expect(a.r).toEqual(b.r);
    }
  });

  it.each([0.55, 1, 1.5])('hits land with the animation at speed ×%s', speed => {
    // each sound's touch starts at the animation's contact point: quiet just before, a sharp attack right there
    const cases: [SfxSpec, number][] = [
      [{ id: 'rotate', speed }, ROTATE_LATCH * ANIM.rotate / 1000 * speed],
      [{ id: 'slide', speed }, SLIDE_SETTLE * ANIM.slide / 1000 * speed],
    ];
    for (const [s, t] of cases) {
      const { l, r } = renderSfx(s, SR);
      const abs = (i: number): number => Math.max(Math.abs(l[i]), Math.abs(r[i]));
      const i0 = Math.round(t * SR), win = Math.round(0.015 * SR);
      let hit = 0, before = 0;
      for (let i = i0; i < i0 + win; i++) hit = Math.max(hit, abs(i));
      for (let i = i0 - Math.round(0.02 * SR); i < i0 - Math.round(0.002 * SR); i++) before = Math.max(before, abs(i));
      let onset = i0 - win;
      while (abs(onset) < hit / 2) onset++;
      expect(before, sfxKey(s)).toBeLessThan(hit / 4);
      expect(onset / SR, sfxKey(s)).toBeGreaterThanOrEqual(t - 0.001);
      expect(onset / SR, sfxKey(s)).toBeLessThan(t + 0.01);
      expect(hit, sfxKey(s)).toBeGreaterThan(peakOf({ l, r }).peak / 3); // and it is a real hit, not a tick
    }
  });

  it.each([0.55, 1, 1.5])('a moving piece flies on air and lands with the place sound at speed ×%s', speed => {
    // sound.ts plays the place sound at moveLanding(): the flight must be done by then, and the
    // place sound must hit at once
    const t = moveLanding(speed);
    expect(t).toBeCloseTo(ANIM.moveFlight / 1000 * speed, 6);
    const flight = renderSfx({ id: 'move', speed }, SR);
    const { peak, at } = peakOf(flight);
    expect(at).toBeGreaterThan(0.25 * t); // loudest in mid-flight
    expect(at).toBeLessThan(0.75 * t);
    let tail = 0;
    for (let i = Math.round((t - 0.01) * SR); i < flight.l.length; i++) {
      tail = Math.max(tail, Math.abs(flight.l[i]), Math.abs(flight.r[i]));
    }
    expect(tail).toBeLessThan(0.05 * peak);
    for (const side of ['O', 'X'] as const) expect(peakOf(renderSfx({ id: 'place', side }, SR)).at, side).toBeLessThan(0.003);
  });

  it('keeps the quiet sounds quiet, and a placed piece in line with the other board sounds', () => {
    const level = (s: SfxSpec): number => loudest(renderSfx(s, SR));
    const hover = level({ id: 'hover' }), click = level({ id: 'click' });
    const confirm = level({ id: 'confirm' }), check = level({ id: 'check' });
    expect(hover).toBeLessThan(click / 2);
    for (const side of ['O', 'X'] as const) {
      const place = level({ id: 'place', side });
      expect(click, side).toBeLessThan(place / 2);
      for (const s of [{ id: 'turn', side: 'O' }, { id: 'select' }, { id: 'confirm' }] as SfxSpec[]) {
        expect(level(s), `${sfxKey(s)} vs place:${side}`).toBeLessThan(place);
      }
      // the main touch, but quieter than 王手 and within 6 dB of a confirm
      expect(place, side).toBeLessThan(check);
      expect(place, side).toBeLessThan(2 * confirm);
    }
  });

  it('sets a piece down with a short, dry knock: nothing left booming', () => {
    for (const side of ['O', 'X'] as const) {
      const { l, r } = renderSfx({ id: 'place', side }, SR);
      // 2 ms RMS: from its loudest point, the sound is 30 dB down within 60 ms
      const w = Math.round(0.002 * SR), lv: number[] = [];
      let acc = 0, best = 0, at = 0;
      for (let i = 0; i < l.length; i++) {
        acc += (l[i] * l[i] + r[i] * r[i]) / 2;
        if (i >= w) acc -= (l[i - w] * l[i - w] + r[i - w] * r[i - w]) / 2;
        lv.push(acc / w);
        if (acc / w > best) { best = acc / w; at = i; }
      }
      let end = at;
      while (end < lv.length && lv[end] >= best / 1000) end++;
      expect((end - at) / SR, side).toBeLessThan(0.06);
    }
  });

  it('shapes motion by the animation speed: silent at rest, loudest mid-way', () => {
    expect(cubicSpeed(0)).toBe(0);
    expect(cubicSpeed(1)).toBe(0);
    expect(cubicSpeed(0.5)).toBe(1);
    expect(cubicSpeed(0.25)).toBeCloseTo(0.25);
    expect(arch(0, 0.3)).toBe(0);
    expect(arch(1, 0.3)).toBe(0);
    expect(arch(0.3, 0.3)).toBeCloseTo(1);
  });

  it('makes a room that starts after a short gap and dies away', () => {
    const { l, r } = roomImpulse(SR);
    const pre = Math.round(0.01 * SR);
    for (const h of [l, r]) {
      let energy = 0, head = 0, tail = 0;
      for (let i = 0; i < h.length; i++) {
        energy += h[i] * h[i];
        if (i < pre) head += Math.abs(h[i]);
        if (i > h.length * 0.9) tail += h[i] * h[i];
      }
      expect(energy).toBeCloseTo(1, 5);
      expect(head).toBe(0);
      expect(tail).toBeLessThan(1e-5);
    }
    // the two sides are different noise (width), not one copy
    let dot = 0;
    for (let i = 0; i < l.length; i++) dot += l[i] * r[i];
    expect(Math.abs(dot)).toBeLessThan(0.1);
  });
});
