/*
 * The messages between the game and the online server, shared by both sides.
 * The server checks everything it receives with the parse functions here: nothing a
 * player sends is trusted as it comes (shape, size and values are all checked).
 */
import type { CubeMove, Player, Step1Action, WinReason } from './types';
import { allCubeMoves } from './rules';
import { isRoomCode } from './online';

/** Bumped when the messages change in a way older pages cannot follow ("a new version is out"). */
export const PROTOCOL = 1;
/** The WebSocket subprotocol that carries the version. The credentials travel as a second one. */
export const WS_PROTOCOL = `cube6.v${PROTOCOL}`;
/** The header that carries the version on HTTP requests. */
export const PROTOCOL_HEADER = 'X-Cube6-Protocol';
/** Longest message the server accepts (a turn is about 120 characters). */
export const MAX_MESSAGE = 512;
const CELLS = 27;

export type MatchKind = 'random' | 'code';
/** One full turn: step ① (place or move) and step ② (the cube move). */
export interface Turn { step1: Step1Action; cube: CubeMove }
/**
 * Main time left for each player, and how much the player to move has spent on this turn.
 * A negative `used` means their clock starts in that many ms (the countdown, or a move being shown).
 */
export interface ClockSync { left: Record<Player, number>; used: number }
export interface MatchEnd { winner: Player | null; reason: WinReason }

/** What went wrong, as a short code; the words for it are in the game's dictionaries. */
export type ServerErrorCode = 'outdated' | 'paused' | 'auth' | 'bad' | 'limit';

// ── Lobby: random matches and 合言葉 ──
export type LobbyIn =
  | { t: 'find' }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'cancel' };

export interface MatchMsg {
  t: 'match';
  room: string;
  me: Player;
  opponent: string;
  kind: MatchKind;
  code: string | null;
}

export type LobbyOut =
  | { t: 'queued' }
  | { t: 'code'; code: string; ttl: number }
  | { t: 'expired' }
  | { t: 'nocode' }
  | MatchMsg
  | { t: 'error'; code: ServerErrorCode };

// ── A game room ──
export type GameIn =
  | { t: 'turn'; ply: number; step1: Step1Action; cube: CubeMove }
  | { t: 'resign' }
  | { t: 'playOn' }
  | { t: 'accept' }
  | { t: 'rematch' }
  | { t: 'norematch' }
  | { t: 'leave' }
  | { t: 'sync' }
  | { t: 'ping' };

/** The whole game as the server has it: sent on connecting, and whenever a view must be corrected. */
export interface GameSnapshot {
  t: 'state';
  me: Player;
  opponent: string;
  kind: MatchKind;
  code: string | null;
  /** 1 for the first game in the room, 2 for the first rematch, … */
  game: number;
  /** Every turn so far. 〇 always moves first, so this is the whole game. */
  turns: Turn[];
  /** Turns played. Equal to turns.length on the server (the page's stand-in can start from a set position). */
  ply: number;
  /** play: in progress · review: 詰み, and the mated player may still check the board · over: final */
  phase: 'play' | 'review' | 'over';
  result: MatchEnd | null;
  /** ms left to check the board after 詰み (phase review). */
  review: number | null;
  clock: ClockSync;
  /** ms until the clock starts (the countdown before the first move). */
  startIn: number;
  /** Your opponent's connection is down: ms until they lose by it. */
  drop: number | null;
  /** Your opponent asked for a rematch. */
  rematch: boolean;
  /** Your opponent has left the room (no rematch). */
  left: boolean;
}

export type GameOut =
  | GameSnapshot
  | { t: 'turn'; by: Player; ply: number; step1: Step1Action; cube: CubeMove; clock: ClockSync; review: number | null }
  | { t: 'playOn'; clock: ClockSync }
  | { t: 'end'; winner: Player | null; reason: WinReason; clock: ClockSync }
  | { t: 'drop'; who: Player; ms: number }
  | { t: 'back'; who: Player }
  | { t: 'rematch' }
  | MatchMsg
  | { t: 'left' }
  | { t: 'pong' }
  | { t: 'error'; code: ServerErrorCode };

// ── Checking what arrives ──
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function parseJson(raw: unknown): Obj | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

export function parseStep1(v: unknown): Step1Action | null {
  if (!isObj(v)) return null;
  if (v.kind === 'place' && isInt(v.index, 0, CELLS - 1)) return { kind: 'place', index: v.index };
  if (v.kind === 'move' && isInt(v.from, 0, CELLS - 1) && isInt(v.to, 0, CELLS - 1) && v.from !== v.to) {
    return { kind: 'move', from: v.from, to: v.to };
  }
  return null;
}

/** One of the 24 cube moves, rebuilt from the list (so nothing else rides along). */
export function parseCubeMove(v: unknown): CubeMove | null {
  if (!isObj(v)) return null;
  const m = allCubeMoves().find(c => c.kind === v.kind && c.axis === v.axis && c.dir === v.dir
    && (c.kind === 'slide' || c.layer === v.layer));
  return m ? { ...m } : null;
}

export function parseLobbyIn(raw: unknown): LobbyIn | null {
  const v = parseJson(raw);
  if (!v) return null;
  if (v.t === 'find' || v.t === 'create' || v.t === 'cancel') return { t: v.t };
  if (v.t === 'join' && typeof v.code === 'string' && isRoomCode(v.code)) return { t: 'join', code: v.code };
  return null;
}

export function parseGameIn(raw: unknown): GameIn | null {
  const v = parseJson(raw);
  if (!v) return null;
  switch (v.t) {
    case 'turn': {
      const step1 = parseStep1(v.step1);
      const cube = parseCubeMove(v.cube);
      return step1 && cube && isInt(v.ply, 0, 100_000) ? { t: 'turn', ply: v.ply, step1, cube } : null;
    }
    case 'resign': case 'playOn': case 'accept': case 'rematch': case 'norematch': case 'leave': case 'sync': case 'ping':
      return { t: v.t };
    default:
      return null;
  }
}

/** What the game receives: the server is trusted for the details, but the shape is still checked. */
export function parseServerMessage(raw: unknown): { t: string } & Obj | null {
  if (typeof raw !== 'string') return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) && typeof v.t === 'string' ? (v as { t: string } & Obj) : null;
  } catch {
    return null;
  }
}
