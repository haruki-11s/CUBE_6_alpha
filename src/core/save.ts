import type { CubeMove, GameState, GameStatus, Player, Step1Action } from './types';
import type { CpuLevel } from './ai';
import { parseClock, type ClockInfo } from './clock';

export type SavedPhase = 'step1' | 'step1-move-from' | 'step2';

/** Who is playing: two people on one device, or a person against the CPU (optionally on a clock). */
export type MatchInfo =
  | { mode: 'local'; undos: number }
  | { mode: 'cpu'; level: CpuLevel; human: Player; undos: number; clock: ClockInfo | null };

export interface LogEntry {
  ply: number;
  player: Player;
  step1: Step1Action;
  cube: CubeMove | null;
  result?: GameStatus;
}

export interface Snapshot {
  gameState: GameState;
  phase: SavedPhase;
  selectedFrom: number | null;
  lastMoved: number | null;
  log: LogEntry[];
}

export interface SaveData extends Snapshot {
  v: 2;
  history: Snapshot[];
  elapsed: number;
  match: MatchInfo;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isIdx = (v: unknown): v is number => isInt(v) && v >= 0 && v < 27;
const isPlayer = (v: unknown): v is Player => v === 'O' || v === 'X';
const STATUSES: readonly string[] = ['playing', 'win:O', 'win:X', 'draw'];
const REASONS: readonly string[] = ['mate', 'notBroken', 'selfDestruct', 'turnLimit', 'timeout'];
const PHASES: readonly string[] = ['step1', 'step1-move-from', 'step2'];

export function isCubeMove(v: unknown): v is CubeMove {
  if (!isObj(v) || !(v.axis === 'X' || v.axis === 'Y' || v.axis === 'Z')) return false;
  if (v.kind === 'rotate') {
    return (v.layer === 0 || v.layer === 1 || v.layer === 2) && (v.dir === 'CW' || v.dir === 'CCW');
  }
  if (v.kind === 'slide') return v.dir === 'forward' || v.dir === 'backward';
  return false;
}

export function isGameState(v: unknown): v is GameState {
  if (!isObj(v)) return false;
  const b = v.board;
  if (!Array.isArray(b) || b.length !== 27 || !b.every(m => m === null || isPlayer(m))) return false;
  if (!isPlayer(v.current)) return false;
  const h = v.hand;
  if (!isObj(h) || !isInt(h.O) || !isInt(h.X)) return false;
  for (const p of ['O', 'X'] as const) {
    const n = h[p] as number;
    if (n < 0 || n > 6) return false;
    // pieces on board + pieces in hand must always equal 6
    if (b.filter(m => m === p).length + n !== 6) return false;
  }
  if (v.lastCubeMove !== null && !isCubeMove(v.lastCubeMove)) return false;
  if (typeof v.status !== 'string' || !STATUSES.includes(v.status)) return false;
  if (v.winReason !== undefined && (typeof v.winReason !== 'string' || !REASONS.includes(v.winReason))) return false;
  if (!isInt(v.ply) || v.ply < 0) return false;
  const s = v.settings;
  if (!isObj(s) || !(s.turnLimit === null || (isInt(s.turnLimit) && s.turnLimit > 0))) return false;
  return true;
}

function isStep1(v: unknown): v is Step1Action {
  if (!isObj(v)) return false;
  if (v.kind === 'place') return isIdx(v.index);
  if (v.kind === 'move') return isIdx(v.from) && isIdx(v.to);
  return false;
}

function isLogEntry(v: unknown): v is LogEntry {
  return isObj(v) && isInt(v.ply) && isPlayer(v.player) && isStep1(v.step1)
    && (v.cube === null || isCubeMove(v.cube))
    && (v.result === undefined || (typeof v.result === 'string' && STATUSES.includes(v.result)));
}

/**
 * Saves written before v2 used the old naming for Y-axis rotations
 * (CW/CCW were swapped for Y only). Flip them so the stored move keeps
 * describing the same physical permutation.
 */
function migrateLegacy(gs: GameState): GameState {
  const m = gs.lastCubeMove;
  if (m && m.kind === 'rotate' && m.axis === 'Y') {
    return { ...gs, lastCubeMove: { ...m, dir: m.dir === 'CW' ? 'CCW' : 'CW' } };
  }
  return gs;
}

function parseSnapshot(v: unknown, legacy: boolean): Snapshot | null {
  if (!isObj(v) || !isGameState(v.gameState)) return null;
  const gameState = legacy ? migrateLegacy(v.gameState) : v.gameState;
  const phase = typeof v.phase === 'string' && PHASES.includes(v.phase) ? (v.phase as SavedPhase) : 'step1';
  let selectedFrom = isIdx(v.selectedFrom) ? v.selectedFrom : null;
  if (phase !== 'step1-move-from' || (selectedFrom !== null && gameState.board[selectedFrom] !== gameState.current)) {
    selectedFrom = null;
  }
  return {
    gameState,
    phase: phase === 'step1-move-from' && selectedFrom === null ? 'step1' : phase,
    selectedFrom,
    lastMoved: isIdx(v.lastMoved) ? v.lastMoved : null,
    log: Array.isArray(v.log) ? v.log.filter(isLogEntry) : [],
  };
}

/** Saves from before the CPU mode have no `match`: they are local games (and older CPU saves have no clock). */
export function parseMatch(v: unknown): MatchInfo {
  const undos = isObj(v) && isInt(v.undos) && v.undos >= 0 ? v.undos : 0;
  if (isObj(v) && v.mode === 'cpu' && isInt(v.level) && v.level >= 1 && v.level <= 6 && isPlayer(v.human)) {
    return { mode: 'cpu', level: v.level as CpuLevel, human: v.human, undos, clock: parseClock(v.clock) };
  }
  return { mode: 'local', undos };
}

/** Validates (and migrates) raw JSON from localStorage. Returns null if unusable. */
export function parseSave(raw: unknown): SaveData | null {
  if (!isObj(raw)) return null;
  const legacy = raw.v === undefined;
  const snap = parseSnapshot(raw, legacy);
  if (!snap || snap.gameState.status !== 'playing') return null;
  const history = !legacy && Array.isArray(raw.history)
    ? raw.history.map(h => parseSnapshot(h, false)).filter((s): s is Snapshot => s !== null)
    : [];
  const elapsed = typeof raw.elapsed === 'number' && Number.isFinite(raw.elapsed) && raw.elapsed >= 0 ? raw.elapsed : 0;
  return { v: 2, ...snap, history, elapsed, match: parseMatch(raw.match) };
}
