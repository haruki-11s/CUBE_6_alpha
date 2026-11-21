import { describe, it, expect } from 'vitest';
import { CLOCK_PRESETS, fmtClock, mainAfterTurn, newClock, parseClock, presetLabel, turnTime } from '../src/core/clock';

const R = CLOCK_PRESETS['3m30s'];

describe('持ち時間', () => {
  it('counts down the main time, then 秒読み, then runs out', () => {
    expect(turnTime(R, 180_000, 0)).toEqual({ phase: 'main', ms: 180_000 });
    expect(turnTime(R, 180_000, 179_000)).toEqual({ phase: 'main', ms: 1000 });
    expect(turnTime(R, 180_000, 180_000)).toEqual({ phase: 'byoyomi', ms: 30_000 });
    expect(turnTime(R, 180_000, 205_000)).toEqual({ phase: 'byoyomi', ms: 5000 });
    expect(turnTime(R, 180_000, 210_000).phase).toBe('out');
  });

  it('gives a full 秒読み every turn once the main time is gone (no carry-over)', () => {
    let left = 20_000;
    left = mainAfterTurn(left, 27_000); // main time ran out 7 s into 秒読み
    expect(left).toBe(0);
    expect(turnTime(R, left, 0)).toEqual({ phase: 'byoyomi', ms: 30_000 });
    expect(turnTime(R, left, 29_900).phase).toBe('byoyomi');
    expect(turnTime(R, left, 30_000).phase).toBe('out');
  });

  it('10-second 秒読み preset', () => {
    const r = CLOCK_PRESETS['3m10s'];
    expect(turnTime(r, 0, 9_999).phase).toBe('byoyomi');
    expect(turnTime(r, 0, 10_000).phase).toBe('out');
    expect(presetLabel('3m10s')).toBe('3分＋秒読み10秒');
    expect(presetLabel('off')).toBe('なし');
  });

  it('formats whole seconds rounded up', () => {
    expect(fmtClock(180_000)).toBe('3:00');
    expect(fmtClock(61_001)).toBe('1:02');
    expect(fmtClock(500)).toBe('0:01');
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(-5)).toBe('0:00');
  });

  it('round-trips a saved clock and rejects broken ones', () => {
    const c = { ...newClock(R), used: 1234 };
    expect(parseClock(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseClock(null)).toBeNull();
    expect(parseClock({ ...c, byoyomiMs: 0 })).toBeNull();
    expect(parseClock({ ...c, left: { O: -1, X: 0 } })).toBeNull();
    expect(parseClock({ ...c, used: Number.NaN })).toBeNull();
    // remaining time can never exceed the main time
    expect(parseClock({ ...c, left: { O: 999_999, X: 1 } })?.left.O).toBe(R.mainMs);
  });
});
