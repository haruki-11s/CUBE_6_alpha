/*
 * Settings that stay out of the code. The anti-abuse limits come from the LIMITS secret
 * (JSON); the values below only apply when it is missing (local development).
 */
export interface Limits {
  /** New players from one address per hour. */
  signupsPerHour: number;
  /** Ranked wins over the same opponent per day. */
  sameOpponentPerDay: number;
  /** A win counts for the rankings only after this many turns (both players' together). */
  minRankedPlies: number;
  /** 合言葉 tries per connection per minute (so codes cannot be guessed). */
  joinTriesPerMinute: number;
  /** Messages one connection may send per 10 s. */
  messagesPer10s: number;
}

const DEFAULTS: Limits = {
  signupsPerHour: 10,
  sameOpponentPerDay: 3,
  minRankedPlies: 6,
  joinTriesPerMinute: 10,
  messagesPer10s: 40,
};

export function limits(env: Env): Limits {
  let raw: unknown = {};
  try {
    raw = JSON.parse(env.LIMITS || '{}');
  } catch { /* keep the defaults */ }
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULTS) as Array<keyof Limits>) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
    }
  }
  return out;
}

/**
 * Online play is stopped for now: PAUSED is 1, or the server is not set up yet
 * (a deploy without the IP_SALT secret stays closed instead of hashing with no salt).
 */
export const isPaused = (env: Env): boolean => env.PAUSED === '1' || !env.IP_SALT;

/** Counts messages per connection; false once one sends too many. */
export class FloodGate {
  private seen = new WeakMap<WebSocket, number[]>();
  constructor(private readonly per10s: number) {}
  allow(ws: WebSocket, now: number): boolean {
    const recent = (this.seen.get(ws) ?? []).filter(t => now - t < 10_000);
    recent.push(now);
    this.seen.set(ws, recent);
    return recent.length <= this.per10s;
  }
}
