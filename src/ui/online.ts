import type { GameState, Player } from '../core/types';
import type { CpuLevel } from '../core/ai';
import {
  autoName, newRoomCode, rankByWins, rankingPeriod, RANKING_SIZE, RECONNECT_MS, ROOM_CODE_TTL_MS, type RankingKind,
} from '../core/online';
import { Match, type Seat, type Send } from '../core/match';
import {
  parseServerMessage, PROTOCOL, PROTOCOL_HEADER, WS_PROTOCOL,
  type ClockSync, type GameOut, type GameSnapshot, type MatchEnd, type Turn,
} from '../core/protocol';
import { CpuClient } from './cpu';

/*
 * The game's side of online play.
 *
 * With a server address (VITE_CUBE6_SERVER at build time) the game talks to the server.
 * Without one, development builds use a stand-in that runs the server's own rules in the
 * page (src/core/match.ts) with the CPU as the opponent; released builds show online play
 * as "coming soon".
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
  /** The game room. */
  room: string;
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

/** A turn as the room confirms it: yours (the echo) or your opponent's. */
export interface TurnMsg extends Turn {
  by: Player;
  ply: number;
  clock: ClockSync;
  /** 詰み: the mated player may check the board for this long. */
  review: number | null;
}
export interface EndMsg extends MatchEnd { clock: ClockSync }

/** What the game hears from its room. */
export interface LinkEvents {
  /** The whole game: on connecting, after coming back, and whenever the view must be corrected. */
  state(s: GameSnapshot): void;
  turn(t: TurnMsg): void;
  /** The mated player challenged the call (誤審の訂正): the game goes on. */
  playOn(clock: ClockSync): void;
  /** The result is final. */
  end(e: EndMsg): void;
  /** Your opponent's connection dropped: they lose in `ms` unless it comes back. */
  drop(who: Player, ms: number): void;
  back(who: Player): void;
  /** Your opponent asks for a rematch (合言葉). */
  rematchAsked(): void;
  /** A rematch starts. */
  match(found: MatchFound): void;
  /** Your opponent has left the room. */
  left(): void;
  /** This device's connection to the room dropped (false) or came back (true). */
  connection(up: boolean): void;
  /** The room cannot be reached any more. */
  failed(code: NetErrorCode): void;
}

/** The connection to one game room. */
export interface GameLink {
  /** Replaces the listeners. */
  on(h: Partial<LinkEvents>): void;
  /** Your turn: step ① and the cube move, from position `ply`. */
  turn(ply: number, t: Turn): void;
  resign(): void;
  playOn(): void;
  /** Done checking the board after 詰み. */
  accept(): void;
  rematch(): void;
  /** No longer waiting for a rematch. */
  withdraw(): void;
  /** Asks for the whole game again. */
  sync(): void;
  /** Leaves the room for good. */
  leave(): void;
}

export type JoinResult = MatchFound | 'nocode' | 'limit';

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
  /** 'nocode': no game is waiting under that code · 'limit': too many tries for now. */
  joinRoom(code: string, signal: AbortSignal): Promise<JoinResult>;
  /** Opens the room of a match just made. */
  connect(found: MatchFound): GameLink;
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
const other = (p: Player): Player => (p === 'O' ? 'X' : 'O');
const PING = '{"t":"ping"}';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = (): void => { clearTimeout(id); reject(abortError()); };
    const id = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Hands a room's message to the game. */
function dispatch(h: Partial<LinkEvents>, m: GameOut): void {
  switch (m.t) {
    case 'state': h.state?.(m); break;
    case 'turn': h.turn?.({ by: m.by, ply: m.ply, step1: m.step1, cube: m.cube, clock: m.clock, review: m.review }); break;
    case 'playOn': h.playOn?.(m.clock); break;
    case 'end': h.end?.({ winner: m.winner, reason: m.reason, clock: m.clock }); break;
    case 'drop': h.drop?.(m.who, m.ms); break;
    case 'back': h.back?.(m.who); break;
    case 'rematch': h.rematchAsked?.(); break;
    case 'match': h.match?.({ kind: m.kind, opponent: m.opponent, me: m.me, code: m.code, room: m.room }); break;
    case 'left': h.left?.(); break;
    default: break;
  }
}

// ═══════════════════════════════ The server ═══════════════════════════════

interface Credentials { id: string; key: string; name: string }
type Msg = { t: string } & Record<string, unknown>;

const CRED_KEY = 'cube6-online';

function errorCode(code: unknown): NetErrorCode {
  return code === 'outdated' || code === 'paused' ? code : 'offline';
}

function toFound(m: Msg): MatchFound {
  return {
    kind: m.kind === 'code' ? 'code' : 'random',
    opponent: String(m.opponent),
    me: m.me === 'X' ? 'X' : 'O',
    code: typeof m.code === 'string' ? m.code : null,
    room: String(m.room),
  };
}

/** One connection to the lobby: messages wait in a queue until asked for. */
class LobbyConn {
  private readonly ws: WebSocket;
  private readonly queue: Msg[] = [];
  private waiter: { pick: (m: Msg) => boolean; res: (m: Msg) => void; rej: (e: unknown) => void } | null = null;
  private failure: NetError | null = null;
  private readonly ping: number;

  constructor(base: string, cred: Credentials, first: object) {
    this.ws = new WebSocket(`${base}/ws/lobby`, [WS_PROTOCOL, `k.${cred.id}.${cred.key}`]);
    this.ws.onopen = () => this.ws.send(JSON.stringify(first));
    this.ws.onmessage = ev => {
      const m = parseServerMessage(ev.data);
      if (!m || m.t === 'pong') return;
      if (this.waiter?.pick(m)) {
        const w = this.waiter;
        this.waiter = null;
        w.res(m);
      } else if (m.t === 'error') {
        this.fail(new NetError(errorCode(m.code)));
      } else {
        this.queue.push(m);
      }
    };
    this.ws.onclose = () => this.fail(new NetError('offline'));
    this.ping = window.setInterval(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(PING); }, 20_000);
  }

  /** The next message `pick` accepts. */
  next(pick: (m: Msg) => boolean, signal: AbortSignal): Promise<Msg> {
    const i = this.queue.findIndex(pick);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const onAbort = (): void => { this.waiter = null; reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiter = {
        pick,
        res: m => { signal.removeEventListener('abort', onAbort); resolve(m); },
        rej: e => { signal.removeEventListener('abort', onAbort); reject(e); },
      };
    });
  }

  send(o: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  close(): void {
    window.clearInterval(this.ping);
    this.ws.onclose = null;
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private fail(e: NetError): void {
    if (this.failure) return;
    this.failure = e;
    window.clearInterval(this.ping);
    const w = this.waiter;
    this.waiter = null;
    w?.rej(e);
  }
}

/** The connection to a game room on the server. It comes back by itself after a drop (for up to 60 s). */
class WsLink implements GameLink {
  private h: Partial<LinkEvents> = {};
  private ws: WebSocket | null = null;
  /** Sent while the connection was down; goes once the room answers again. */
  private outbox: string[] = [];
  /** The room has answered since the last (re)connect. */
  private up = false;
  private downSince = 0;
  private attempt = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private lastHeard = 0;
  private closed = false;

  constructor(private readonly svc: ServerService, private readonly room: string) {
    this.open();
  }

  on(h: Partial<LinkEvents>): void {
    this.h = h;
    // new listeners hear at once that the connection is down (it may have dropped during the countdown)
    if (this.downSince && !this.closed) h.connection?.(false);
  }
  turn(ply: number, t: Turn): void { this.send({ t: 'turn', ply, step1: t.step1, cube: t.cube }); }
  resign(): void { this.send({ t: 'resign' }); }
  playOn(): void { this.send({ t: 'playOn' }); }
  accept(): void { this.send({ t: 'accept' }); }
  rematch(): void { this.send({ t: 'rematch' }); }
  withdraw(): void { this.send({ t: 'norematch' }); }
  sync(): void { this.send({ t: 'sync' }); }

  leave(): void {
    if (this.closed) return;
    if (this.up && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'leave' }));
    this.shut();
  }

  /** Development builds: the connection breaks (it comes back by itself). */
  debugBreak(): void {
    try { this.ws?.close(4999, 'test'); } catch { /* gone */ }
  }

  private send(o: object): void {
    if (this.closed) return;
    const text = JSON.stringify(o);
    if (this.up && this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.outbox.push(text);
  }

  private open(): void {
    const cred = this.svc.credentials();
    if (!cred) { this.fail('offline'); return; }
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.svc.wsBase}/ws/game/${this.room}`, [WS_PROTOCOL, `k.${cred.id}.${cred.key}`]);
    } catch {
      this.lost();
      return;
    }
    this.ws = ws;
    this.up = false;
    ws.onopen = () => { this.lastHeard = Date.now(); };
    ws.onmessage = ev => { if (this.ws === ws) this.receive(ev.data); };
    ws.onclose = ev => { if (this.ws === ws) this.closedBy(ev.code); };
  }

  private receive(data: unknown): void {
    this.lastHeard = Date.now();
    const m = parseServerMessage(data);
    if (!m || this.closed || m.t === 'pong') return;
    if (m.t === 'error') { this.fail(errorCode(m.code)); return; }
    if (m.t === 'state') {
      const wasDown = this.downSince > 0;
      this.up = true;
      this.downSince = 0;
      this.attempt = 0;
      this.startPing();
      if (wasDown) this.h.connection?.(true);
      dispatch(this.h, m as unknown as GameOut);
      const queued = this.outbox;
      this.outbox = [];
      for (const text of queued) this.ws?.send(text);
      return;
    }
    dispatch(this.h, m as unknown as GameOut);
  }

  private closedBy(code: number): void {
    this.stopPing();
    this.up = false;
    this.ws = null;
    if (this.closed) return;
    // another tab took this game over (4001), or the room has closed (1000): nothing to come back to
    if (code === 4001 || code === 1000) { this.fail('offline'); return; }
    this.lost();
  }

  /** The connection dropped: try again, more slowly each time, until the server has given up too. */
  private lost(): void {
    if (this.closed) return;
    if (!this.downSince) {
      this.downSince = Date.now();
      this.h.connection?.(false);
    }
    if (Date.now() - this.downSince > RECONNECT_MS + 5000) { this.fail('offline'); return; }
    const delay = Math.min(5000, 500 * 2 ** this.attempt++);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // nothing heard for long: the connection is dead even if the browser has not noticed
      if (Date.now() - this.lastHeard > 45_000) {
        this.ws = null;
        this.up = false;
        this.stopPing();
        try { ws.close(); } catch { /* gone */ }
        this.lost();
        return;
      }
      ws.send(PING);
    }, 15_000);
  }

  private stopPing(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }

  private fail(code: NetErrorCode): void {
    if (this.closed) return;
    this.shut();
    this.h.failed?.(code);
  }

  private shut(): void {
    this.closed = true;
    this.stopPing();
    window.clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000); } catch { /* gone */ } }
  }
}

class ServerService implements OnlineService {
  readonly preview = false;
  readonly wsBase: string;
  private pending: { code: string; conn: LobbyConn } | null = null;

  constructor(private readonly base: string) {
    this.wsBase = base.replace(/^http/, 'ws');
  }

  available(): boolean { return true; }

  credentials(): Credentials | null {
    try {
      const v = JSON.parse(localStorage.getItem(CRED_KEY) ?? 'null') as Partial<Credentials> | null;
      return v && typeof v.id === 'string' && typeof v.key === 'string' && typeof v.name === 'string'
        ? { id: v.id, key: v.key, name: v.name } : null;
    } catch {
      return null;
    }
  }

  profile(): OnlineProfile | null {
    const c = this.credentials();
    return c ? { name: c.name } : null;
  }

  async register(): Promise<OnlineProfile> {
    const c = await this.http<Credentials>('POST', '/api/register', false);
    if (!c || typeof c.id !== 'string' || typeof c.key !== 'string' || typeof c.name !== 'string') throw new NetError('offline');
    try { localStorage.setItem(CRED_KEY, JSON.stringify({ id: c.id, key: c.key, name: c.name })); } catch { throw new NetError('offline'); }
    return { name: c.name };
  }

  async deleteData(): Promise<void> {
    try {
      await this.http('DELETE', '/api/me', true);
    } catch (e) {
      // the server no longer knows this key: there is nothing left to delete
      if (!(e instanceof NetError && e.code === 'offline' && !this.credentials())) throw e;
    }
    this.forget();
  }

  async ranking(kind: RankingKind): Promise<RankingData> {
    const d = await this.http<RankingData>('GET', `/api/ranking?kind=${kind}`, true);
    if (!d || !Array.isArray(d.rows)) throw new NetError('offline');
    return d;
  }

  async findRandom(signal: AbortSignal): Promise<MatchFound> {
    const c = this.lobby({ t: 'find' });
    try {
      return toFound(await c.next(m => m.t === 'match', signal));
    } catch (e) {
      if (isAbort(e)) c.send({ t: 'cancel' });
      throw e;
    } finally {
      c.close();
    }
  }

  async createRoom(signal: AbortSignal): Promise<{ code: string; expiresAt: number }> {
    const c = this.lobby({ t: 'create' });
    try {
      const m = await c.next(x => x.t === 'code', signal);
      const room = { code: String(m.code), expiresAt: Date.now() + Number(m.ttl) };
      this.dropPending();
      this.pending = { code: room.code, conn: c };
      signal.addEventListener('abort', () => this.dropPending(room.code), { once: true });
      return room;
    } catch (e) {
      c.close();
      throw e;
    }
  }

  async waitRoom(code: string, _expiresAt: number, signal: AbortSignal): Promise<MatchFound | null> {
    const p = this.pending;
    if (!p || p.code !== code) throw new NetError('offline');
    try {
      const m = await p.conn.next(x => x.t === 'match' || x.t === 'expired', signal);
      return m.t === 'match' ? toFound(m) : null;
    } catch (e) {
      if (isAbort(e)) p.conn.send({ t: 'cancel' });
      throw e;
    } finally {
      this.dropPending(code);
    }
  }

  async joinRoom(code: string, signal: AbortSignal): Promise<JoinResult> {
    const c = this.lobby({ t: 'join', code });
    try {
      const m = await c.next(x => x.t === 'match' || x.t === 'nocode' || (x.t === 'error' && x.code === 'limit'), signal);
      return m.t === 'match' ? toFound(m) : m.t === 'nocode' ? 'nocode' : 'limit';
    } finally {
      c.close();
    }
  }

  /** The room in play (for the development hooks). */
  current: WsLink | null = null;

  connect(found: MatchFound): GameLink {
    this.current = new WsLink(this, found.room);
    return this.current;
  }

  private lobby(first: object): LobbyConn {
    const cred = this.credentials();
    if (!cred) throw new NetError('offline');
    return new LobbyConn(this.wsBase, cred, first);
  }

  private dropPending(code?: string): void {
    if (!this.pending || (code !== undefined && this.pending.code !== code)) return;
    this.pending.conn.close();
    this.pending = null;
  }

  private forget(): void {
    try { localStorage.removeItem(CRED_KEY); } catch { /* ignore */ }
  }

  private async http<T>(method: string, path: string, auth: boolean): Promise<T | null> {
    const headers: Record<string, string> = { [PROTOCOL_HEADER]: String(PROTOCOL) };
    const cred = auth ? this.credentials() : null;
    if (cred) headers.Authorization = `Bearer ${cred.id}.${cred.key}`;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers });
    } catch {
      throw new NetError('offline');
    }
    if (res.status === 426) throw new NetError('outdated');
    if (res.status === 503) {
      const b = await res.json().catch(() => null) as { error?: string; resumeAt?: number } | null;
      if (b?.error === 'paused') throw new NetError('paused', typeof b.resumeAt === 'number' ? b.resumeAt : null);
    }
    // the server no longer knows this key (its data was deleted): start again from the welcome screen
    if (res.status === 401) this.forget();
    if (!res.ok) throw new NetError('offline');
    return res.status === 204 ? null : await res.json() as T;
  }
}

// ═══════════════════════════════ The stand-in ══════════════════════════════

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

/** The strength the stand-in opponent plays at. */
const STAND_IN_LEVEL: CpuLevel = 3;
const PREVIEW_KEY = 'cube6-online-preview';

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

/**
 * A game room in the page: the server's rules (Match), the CPU as the opponent, and a
 * little delay each way, as over a network. Dev hooks can drop either connection.
 */
class PreviewLink implements GameLink {
  private h: Partial<LinkEvents> = {};
  private readonly m: Match;
  private readonly cpu = new CpuClient();
  private readonly timer: number;
  private thinking = false;
  /** You mated the stand-in: it looks at the board until then, and accepts. */
  private acceptAt = 0;
  private selfDown = false;
  private outbox: Array<(now: number) => Send[]> = [];
  private closed = false;

  constructor(private readonly svc: PreviewService, found: MatchFound) {
    const now = Date.now();
    const seats = { [found.me]: { id: 'me', name: svc.profile()?.name ?? '' }, [other(found.me)]: { id: 'opp', name: found.opponent } } as Record<Player, Seat>;
    this.m = Match.create({ room: found.room, kind: found.kind, code: found.code, seats, now });
    this.deliver(this.m.back(this.opp, now));
    this.deliver(this.m.back(this.me, now));
    this.timer = window.setInterval(() => this.tick(), 200);
  }

  /** Your side now (a rematch swaps them). */
  private get me(): Player { return this.m.sideOf('me') ?? 'O'; }
  private get opp(): Player { return other(this.me); }

  on(h: Partial<LinkEvents>): void {
    this.h = h;
    if (this.selfDown && !this.closed) h.connection?.(false);
  }
  turn(ply: number, t: Turn): void { this.act(now => this.m.turn(this.me, ply, t.step1, t.cube, now)); }
  resign(): void { this.act(now => this.m.resign(this.me, now)); }
  playOn(): void { this.act(now => this.m.playOn(this.me, now)); }
  accept(): void { this.act(now => this.m.accept(this.me, now)); }
  rematch(): void { this.act(now => this.m.rematch(this.me, now)); }
  withdraw(): void { this.act(() => this.m.withdraw(this.me)); }
  sync(): void { this.act(now => [{ to: this.me, msg: this.m.snapshot(this.me, now) }]); }

  leave(): void {
    if (this.closed) return;
    if (!this.selfDown) this.deliver(this.m.leave(this.me, Date.now()));
    this.close();
  }

  // ── dev hooks ──
  /** A connection drops (true) or comes back (false). */
  debugDrop(who: 'opp' | 'self', on: boolean): void {
    if (this.closed) return;
    const now = Date.now();
    if (who === 'opp') { this.deliver(on ? this.m.drop(this.opp, now) : this.m.back(this.opp, now)); return; }
    if (on === this.selfDown) return;
    if (on) {
      this.deliver(this.m.drop(this.me, now));
      this.selfDown = true;
      setTimeout(() => this.h.connection?.(false), 0);
      return;
    }
    this.selfDown = false;
    this.h.connection?.(true);
    this.deliver(this.m.back(this.me, now));
    const queued = this.outbox;
    this.outbox = [];
    for (const f of queued) this.act(f);
  }
  debugResign(): void { if (!this.closed) this.deliver(this.m.resign(this.opp, Date.now())); }
  /** Puts a position into the game (the page shows it itself). */
  debugLoad(state: GameState): void { this.m.d.state = state; this.m.d.turns = []; }

  /** What you send reaches the room a moment later (or after the connection comes back). */
  private act(f: (now: number) => Send[]): void {
    if (this.closed) return;
    if (this.selfDown) { this.outbox.push(f); return; }
    setTimeout(() => { if (!this.closed && !this.selfDown) this.deliver(f(Date.now())); }, 40);
  }

  private deliver(out: Send[]): void {
    for (const s of out) {
      if (s.to !== this.me) this.opponentHears(s.msg);
      if (s.to === this.opp || this.selfDown) continue;
      const msg = s.msg;
      setTimeout(() => { if (!this.closed) dispatch(this.h, msg); }, 40);
    }
    const r = this.m.takeReport();
    if (r?.winner && r.kind === 'random' && r.seats[r.winner].id === 'me') this.svc.addWin();
    this.m.takeJudgeReport();
  }

  private opponentHears(msg: GameOut): void {
    if (msg.t !== 'rematch') return;
    // you asked for a rematch: the stand-in agrees after a moment (or has left)
    setTimeout(() => {
      if (this.closed) return;
      const now = Date.now();
      this.deliver(previewConfig.opponentLeft ? this.m.leave(this.opp, now) : this.m.rematch(this.opp, now));
    }, 1800);
  }

  private tick(): void {
    if (this.closed) return;
    const now = Date.now();
    this.deliver(this.m.tick(now));
    const d = this.m.d;
    if (d.phase === 'play' && d.state.current === this.opp && !this.thinking && !d.dropUntil[this.opp] && now >= d.turnStart) {
      void this.play();
    }
    if (d.phase === 'review' && d.state.current === this.opp) {
      if (!this.acceptAt) this.acceptAt = now + 2500 + Math.random() * 3500;
      else if (now >= this.acceptAt) { this.acceptAt = 0; this.deliver(this.m.accept(this.opp, now)); }
    } else {
      this.acceptAt = 0;
    }
  }

  /** The stand-in's turn, at a person's pace. */
  private async play(): Promise<void> {
    this.thinking = true;
    const g = this.m.d.state;
    const [decision] = await Promise.all([
      this.cpu.think(g, STAND_IN_LEVEL, false),
      sleep(900 + Math.random() * 2200),
    ]);
    this.thinking = false;
    const d = this.m.d;
    // the game moved on meanwhile (降参, time, a dropped connection)
    if (this.closed || !decision?.step1 || d.phase !== 'play' || d.state !== g || d.dropUntil[this.opp]) return;
    this.deliver(this.m.turn(this.opp, g.ply, decision.step1, decision.cube, Date.now()));
  }

  private close(): void {
    this.closed = true;
    window.clearInterval(this.timer);
    this.cpu.dispose();
  }
}

class PreviewService implements OnlineService {
  readonly preview = true;
  /** The room in play (for the dev hooks). */
  current: PreviewLink | null = null;

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
    try { localStorage.removeItem(PREVIEW_KEY); } catch { /* ignore */ }
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

  async joinRoom(code: string, signal: AbortSignal): Promise<JoinResult> {
    await this.request(900, signal);
    return code === '000000' ? 'nocode' : this.found('code', code);
  }

  connect(found: MatchFound): GameLink {
    this.current = new PreviewLink(this, found);
    return this.current;
  }

  /** You won a random match against the stand-in: it counts in the made-up rankings. */
  addWin(): void {
    const s = this.load();
    if (!s) return;
    const now = Date.now();
    for (const kind of ['daily', 'weekly'] as const) {
      const k = `${kind}:${rankingPeriod(kind, now).start}`;
      s.wins[k] = (s.wins[k] ?? 0) + 1;
    }
    this.save(s);
  }

  private found(kind: MatchFound['kind'], code: string | null): MatchFound {
    const me: Player = previewConfig.mySide ?? (Math.random() < 0.5 ? 'O' : 'X');
    return { kind, opponent: autoName(Math.floor(Math.random() * 100_000)), me, code, room: `preview-${Date.now()}` };
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
      const v = JSON.parse(localStorage.getItem(PREVIEW_KEY) ?? 'null') as Partial<Stored> | null;
      if (!v || typeof v.name !== 'string') return null;
      return { name: v.name, wins: typeof v.wins === 'object' && v.wins ? v.wins : {} };
    } catch {
      return null;
    }
  }

  private save(s: Stored): void {
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(s)); } catch { /* quota / private mode */ }
  }
}

const SERVER = (import.meta.env.VITE_CUBE6_SERVER ?? '').replace(/\/+$/, '');

export const online: OnlineService = SERVER ? new ServerService(SERVER) : new PreviewService();

/** The stand-in's room in play (development builds without a server), for the dev hooks. */
export function previewRoom(): PreviewLink | null {
  return online instanceof PreviewService ? online.current : null;
}

/** Development builds with a server: breaks the room's connection (it comes back by itself). */
export function breakServerLink(): void {
  if (online instanceof ServerService) online.current?.debugBreak();
}
