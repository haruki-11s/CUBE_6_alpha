import type { Player } from '../core/types';
import {
  autoName, newRoomCode, rankByWins, rankingPeriod, RANKING_SIZE, ROOM_CODE_TTL_MS, type RankingKind,
} from '../core/online';

/*
 * The game's side of online play. Until the server exists, a stand-in answers instead
 * (made-up opponents and rankings), and only in development builds: a released build
 * still shows online play as "coming soon".
 */

export interface OnlineProfile {
  /** The automatic name, e.g. PLAYER-48213. */
  name: string;
}

export interface MatchFound {
  kind: 'random' | 'code';
  /** The other player's automatic name. */
  opponent: string;
  /** Your side. 〇 always moves first, so this also says who starts. */
  me: Player;
  /** The 合言葉 of a code game. */
  code: string | null;
}

export interface RankingRow {
  rank: number;
  name: string;
  wins: number;
  me: boolean;
}

export interface RankingData {
  kind: RankingKind;
  start: number;
  end: number;
  /** The top places (equal wins share a rank). */
  rows: RankingRow[];
  /** Your own place, also when it is below the list; null before your first win. */
  mine: { rank: number; wins: number } | null;
}

/** offline: the server cannot be reached · paused: online play is stopped for now · outdated: reload the page */
export type NetErrorCode = 'offline' | 'paused' | 'outdated';

export class NetError extends Error {
  constructor(readonly code: NetErrorCode, readonly resumeAt: number | null = null) {
    super(code);
    this.name = 'NetError';
  }
}

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

export interface OnlineService {
  /** True while a stand-in answers instead of a real server. */
  readonly preview: boolean;
  /** Whether online play can be used in this build. */
  available(): boolean;
  profile(): OnlineProfile | null;
  /** First time: the player agreed to the terms and gets an automatic name. */
  register(): Promise<OnlineProfile>;
  /** Deletes the online data: the name and the ranking records. */
  deleteData(): Promise<void>;
  ranking(kind: RankingKind): Promise<RankingData>;
  findRandom(signal: AbortSignal): Promise<MatchFound>;
  createRoom(signal: AbortSignal): Promise<{ code: string; expiresAt: number }>;
  /** Waits until someone enters the code; null once it expires. */
  waitRoom(code: string, expiresAt: number, signal: AbortSignal): Promise<MatchFound | null>;
  /** null: no game is waiting under that code. */
  joinRoom(code: string, signal: AbortSignal): Promise<MatchFound | null>;
  /** 合言葉: another game with the same opponent; null if they have left. */
  rematch(prev: MatchFound, signal: AbortSignal): Promise<MatchFound | null>;
  /** A finished game (the server will count ranked wins; the stand-in keeps a tally). */
  reportResult(found: MatchFound, won: boolean): void;
}

/** Knobs for trying the screens without a server (dev builds: `window.__cube6.net`). */
export const previewConfig = {
  /** How long a random match takes to find someone. */
  matchDelayMs: 3200,
  /** How long until someone enters a code you made. */
  joinDelayMs: 7000,
  /** false: nobody enters your code (to look at the waiting screen). */
  autoJoin: true,
  /** The next request fails like this (then it is cleared). */
  failNext: null as NetErrorCode | null,
  /** Your opponent has left: a rematch is refused. */
  opponentLeft: false,
  /** Your side in the next match (null: drawn at random, as on the server). */
  mySide: null as Player | null,
};

const KEY = 'cube6-online-preview';
const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = (): void => { clearTimeout(id); reject(abortError()); };
    const id = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A small seeded generator, so a stand-in ranking stays the same for the whole period. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stored {
  name: string;
  /** Ranked wins per period ("daily:<start>" / "weekly:<start>"). */
  wins: Record<string, number>;
}

class PreviewService implements OnlineService {
  readonly preview = true;

  available(): boolean {
    return import.meta.env.DEV;
  }

  profile(): OnlineProfile | null {
    const s = this.load();
    return s ? { name: s.name } : null;
  }

  async register(): Promise<OnlineProfile> {
    await this.request(700);
    const s: Stored = { name: autoName(Math.floor(Math.random() * 100_000)), wins: {} };
    this.save(s);
    return { name: s.name };
  }

  async deleteData(): Promise<void> {
    await this.request(500);
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }

  async ranking(kind: RankingKind): Promise<RankingData> {
    await this.request(450);
    const { start, end } = rankingPeriod(kind, Date.now());
    const rand = seeded(Math.floor(start / 60_000) + (kind === 'weekly' ? 7 : 1));
    const daily = kind === 'daily';
    const others = Array.from({ length: daily ? 46 : 160 }, () => ({
      name: autoName(Math.floor(rand() * 100_000)),
      wins: 1 + Math.floor(Math.pow(rand(), 2.2) * (daily ? 16 : 64)),
      me: false,
    }));
    const s = this.load();
    // made-up wins so far this period, plus the stand-in games you won
    const myWins = s ? (daily ? 11 : 2) + (s.wins[`${kind}:${start}`] ?? 0) : 0;
    const all = s && myWins > 0 ? [...others, { name: s.name, wins: myWins, me: true }] : others;
    const ranked = rankByWins(all);
    const mine = ranked.find(r => r.me);
    return {
      kind, start, end,
      rows: ranked.slice(0, RANKING_SIZE),
      mine: mine ? { rank: mine.rank, wins: mine.wins } : null,
    };
  }

  async findRandom(signal: AbortSignal): Promise<MatchFound> {
    await this.request(previewConfig.matchDelayMs, signal);
    return this.found('random', null);
  }

  async createRoom(signal: AbortSignal): Promise<{ code: string; expiresAt: number }> {
    await this.request(400, signal);
    return { code: newRoomCode(), expiresAt: Date.now() + ROOM_CODE_TTL_MS };
  }

  async waitRoom(code: string, expiresAt: number, signal: AbortSignal): Promise<MatchFound | null> {
    const left = expiresAt - Date.now();
    if (!previewConfig.autoJoin || previewConfig.joinDelayMs >= left) {
      await sleep(left, signal);
      return null;
    }
    await sleep(previewConfig.joinDelayMs, signal);
    return this.found('code', code);
  }

  async joinRoom(code: string, signal: AbortSignal): Promise<MatchFound | null> {
    await this.request(900, signal);
    return code === '000000' ? null : this.found('code', code);
  }

  async rematch(prev: MatchFound, signal: AbortSignal): Promise<MatchFound | null> {
    await this.request(1800, signal);
    if (previewConfig.opponentLeft) return null;
    // the turn order changes hands
    return { ...prev, me: prev.me === 'O' ? 'X' : 'O' };
  }

  reportResult(found: MatchFound, won: boolean): void {
    const s = this.load();
    if (!s || !won || found.kind !== 'random') return;
    const now = Date.now();
    for (const kind of ['daily', 'weekly'] as const) {
      const k = `${kind}:${rankingPeriod(kind, now).start}`;
      s.wins[k] = (s.wins[k] ?? 0) + 1;
    }
    this.save(s);
  }

  private found(kind: MatchFound['kind'], code: string | null): MatchFound {
    const me: Player = previewConfig.mySide ?? (Math.random() < 0.5 ? 'O' : 'X');
    return { kind, opponent: autoName(Math.floor(Math.random() * 100_000)), me, code };
  }

  /** A round trip to the "server", which can be told to fail once. */
  private async request(ms: number, signal?: AbortSignal): Promise<void> {
    const fail = previewConfig.failNext;
    if (fail) {
      previewConfig.failNext = null;
      await sleep(600, signal);
      throw new NetError(fail, fail === 'paused' ? rankingPeriod('daily', Date.now()).end : null);
    }
    await sleep(ms, signal);
  }

  private load(): Stored | null {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Stored> | null;
      if (!v || typeof v.name !== 'string') return null;
      return { name: v.name, wins: typeof v.wins === 'object' && v.wins ? v.wins : {} };
    } catch {
      return null;
    }
  }

  private save(s: Stored): void {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota / private mode */ }
  }
}

export const online: OnlineService = new PreviewService();
