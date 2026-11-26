/*
 * Online play: the rules shared by the game and (later) the server. No UI here.
 * See docs/online-design.md (kept locally) for the decisions behind them.
 */

export type RankingKind = 'daily' | 'weekly';

const DAY = 86_400_000;

/**
 * The ranking period that contains `now`. Days start at 00:00 UTC, which is 09:00 JST;
 * weeks start on Monday at 00:00 UTC (Monday 09:00 JST).
 */
export function rankingPeriod(kind: RankingKind, now: number): { start: number; end: number } {
  const dayStart = Math.floor(now / DAY) * DAY;
  if (kind === 'daily') return { start: dayStart, end: dayStart + DAY };
  const sinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  const start = dayStart - sinceMonday * DAY;
  return { start, end: start + 7 * DAY };
}

/** Hours and minutes until `end` (rounded up to the minute; never negative). */
export function timeUntil(end: number, now: number): { h: number; m: number } {
  const mins = Math.max(0, Math.ceil((end - now) / 60_000));
  return { h: Math.floor(mins / 60), m: mins % 60 };
}

/**
 * Competition ranking ("1, 2, 2, 4"): more wins first, and equal wins share a rank.
 * Within a tie the given order is kept.
 */
export function rankByWins<T extends { wins: number }>(entries: readonly T[]): Array<T & { rank: number }> {
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.wins - a.e.wins || a.i - b.i).map(x => x.e);
  let rank = 0;
  return sorted.map((e, i) => {
    if (i === 0 || e.wins !== sorted[i - 1].wins) rank = i + 1;
    return { ...e, rank };
  });
}

/** How many places a ranking lists (your own place is shown even below them). */
export const RANKING_SIZE = 100;

// ── 合言葉: a 6-digit number one player makes and the other types in ──
export const ROOM_CODE_LENGTH = 6;
/** How long a code waits for the second player. */
export const ROOM_CODE_TTL_MS = 10 * 60_000;

/** What a player typed, as a code: full-width digits become ASCII; spaces and dashes are dropped. */
export function normalizeRoomCode(raw: string): string {
  return raw
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-‐－ー]/g, '');
}

export function isRoomCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** "482913" → "482 913", easier to read out. */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** A new code. It never starts with 0, so no app can drop a leading zero. */
export function newRoomCode(rand: () => number = Math.random): string {
  return String(100_000 + Math.min(899_999, Math.floor(rand() * 900_000)));
}

/** Players get an automatic name, such as PLAYER-48213. */
export function autoName(n: number): string {
  return `PLAYER-${String(Math.abs(Math.trunc(n)) % 100_000).padStart(5, '0')}`;
}

// ── The online game itself ──
/** 3 minutes each, then 30 seconds per turn (秒読み). */
export const ONLINE_CLOCK = { mainMs: 180_000, byoyomiMs: 30_000 } as const;
/** After 詰み the loser may check the board (and challenge the call) for this long. */
export const MATE_REVIEW_MS = 30_000;
/** A player whose connection drops has this long to come back before losing. */
export const RECONNECT_MS = 60_000;
