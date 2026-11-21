import type { Player } from './types';

/*
 * 持ち時間 (time control) as in online board games: each player has a main
 * time; once it is used up, every turn must be finished within the 秒読み
 * (byoyomi) period. Byoyomi never accumulates: a turn that took 7 s of a
 * 30 s byoyomi leaves the next turn with the full 30 s again.
 */

export interface ClockRule {
  mainMs: number;
  byoyomiMs: number;
}

export type ClockPreset = 'off' | '3m10s' | '3m30s';

export const CLOCK_PRESETS: Readonly<Record<Exclude<ClockPreset, 'off'>, ClockRule>> = {
  '3m10s': { mainMs: 180_000, byoyomiMs: 10_000 },
  '3m30s': { mainMs: 180_000, byoyomiMs: 30_000 },
};

/** A match's clock: the rule, each player's remaining main time, and the time spent in the turn in progress. */
export interface ClockInfo extends ClockRule {
  left: Record<Player, number>;
  used: number;
}

export function newClock(rule: ClockRule): ClockInfo {
  return { mainMs: rule.mainMs, byoyomiMs: rule.byoyomiMs, left: { O: rule.mainMs, X: rule.mainMs }, used: 0 };
}

export interface TurnTime {
  phase: 'main' | 'byoyomi' | 'out';
  /** Time left in that phase (ms). */
  ms: number;
}

/** What the player to move has left after spending `used` ms on this turn. */
export function turnTime(rule: ClockRule, mainLeft: number, used: number): TurnTime {
  if (used < mainLeft) return { phase: 'main', ms: mainLeft - used };
  const b = mainLeft + rule.byoyomiMs - used;
  return b > 0 ? { phase: 'byoyomi', ms: b } : { phase: 'out', ms: 0 };
}

/** Main time left once a turn that took `used` ms is over. */
export function mainAfterTurn(mainLeft: number, used: number): number {
  return Math.max(0, mainLeft - used);
}

/** "2:41" — whole seconds rounded up, so 0:00 only appears when the time is really gone. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function presetLabel(p: ClockPreset): string {
  if (p === 'off') return 'なし';
  return `${CLOCK_PRESETS[p].mainMs / 60000}分＋秒読み${CLOCK_PRESETS[p].byoyomiMs / 1000}秒`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Validates a saved clock (null when absent or broken). */
export function parseClock(v: unknown): ClockInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const left = o.left as Record<string, unknown> | undefined;
  if (!isNum(o.mainMs) || !isNum(o.byoyomiMs) || o.byoyomiMs <= 0 || !isNum(o.used)) return null;
  if (typeof left !== 'object' || left === null || !isNum(left.O) || !isNum(left.X)) return null;
  return {
    mainMs: o.mainMs, byoyomiMs: o.byoyomiMs, used: o.used,
    left: { O: Math.min(left.O, o.mainMs), X: Math.min(left.X, o.mainMs) },
  };
}
