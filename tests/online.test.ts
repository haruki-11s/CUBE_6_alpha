import { describe, it, expect } from 'vitest';
import {
  autoName, formatRoomCode, isRoomCode, newRoomCode, normalizeRoomCode, rankByWins, rankingPeriod, timeUntil,
} from '../src/core/online';

const jst = (s: string): number => Date.parse(`${s}+09:00`);

describe('ranking periods', () => {
  it('a day runs from 09:00 JST to 09:00 JST the next day', () => {
    const p = rankingPeriod('daily', jst('2026-11-26T15:30:00'));
    expect(p.start).toBe(jst('2026-11-26T09:00:00'));
    expect(p.end).toBe(jst('2026-11-27T09:00:00'));
  });

  it('08:59 JST still belongs to the previous day', () => {
    expect(rankingPeriod('daily', jst('2026-11-26T08:59:59')).start).toBe(jst('2026-11-25T09:00:00'));
    expect(rankingPeriod('daily', jst('2026-11-26T09:00:00')).start).toBe(jst('2026-11-26T09:00:00'));
  });

  it('a week runs from Monday 09:00 JST to the next Monday 09:00 JST', () => {
    // 2026-11-23 is a Monday
    const wed = rankingPeriod('weekly', jst('2026-11-25T20:00:00'));
    expect(wed.start).toBe(jst('2026-11-23T09:00:00'));
    expect(wed.end).toBe(jst('2026-11-30T09:00:00'));
    // Monday 08:59 JST is still the week before
    expect(rankingPeriod('weekly', jst('2026-11-30T08:59:00')).start).toBe(jst('2026-11-23T09:00:00'));
    expect(rankingPeriod('weekly', jst('2026-11-30T09:00:00')).start).toBe(jst('2026-11-30T09:00:00'));
    // Sunday evening
    expect(rankingPeriod('weekly', jst('2026-11-29T23:00:00')).start).toBe(jst('2026-11-23T09:00:00'));
  });

  it('counts the time to the next reset in hours and minutes', () => {
    const now = jst('2026-11-26T03:47:30');
    expect(timeUntil(rankingPeriod('daily', now).end, now)).toEqual({ h: 5, m: 13 });
    expect(timeUntil(now - 1000, now)).toEqual({ h: 0, m: 0 });
  });
});

describe('ranking order', () => {
  it('sorts by wins, and equal wins share a rank', () => {
    const rows = rankByWins([
      { name: 'A', wins: 3 }, { name: 'B', wins: 9 }, { name: 'C', wins: 5 }, { name: 'D', wins: 5 }, { name: 'E', wins: 1 },
    ]);
    expect(rows.map(r => `${r.rank}:${r.name}`)).toEqual(['1:B', '2:C', '2:D', '4:A', '5:E']);
  });
});

describe('合言葉 (room codes)', () => {
  it('accepts six digits, typed in any width, with spaces or dashes', () => {
    expect(normalizeRoomCode('482 913')).toBe('482913');
    expect(normalizeRoomCode('４８２９１３')).toBe('482913');
    expect(normalizeRoomCode('482-913')).toBe('482913');
    expect(isRoomCode(normalizeRoomCode('４８２　９１３'))).toBe(true);
    expect(isRoomCode('48291')).toBe(false);
    expect(isRoomCode('4829134')).toBe(false);
    expect(isRoomCode('48a913')).toBe(false);
  });

  it('shows a code in two halves', () => {
    expect(formatRoomCode('482913')).toBe('482 913');
  });

  it('makes six-digit codes that never start with 0', () => {
    expect(newRoomCode(() => 0)).toBe('100000');
    expect(newRoomCode(() => 0.999999999)).toBe('999999');
    for (let i = 0; i < 200; i++) expect(isRoomCode(newRoomCode())).toBe(true);
  });
});

describe('automatic names', () => {
  it('are PLAYER- and five digits', () => {
    expect(autoName(48213)).toBe('PLAYER-48213');
    expect(autoName(7)).toBe('PLAYER-00007');
    expect(autoName(123456)).toBe('PLAYER-23456');
  });
});
