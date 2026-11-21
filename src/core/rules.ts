import type { Mark, CubeMove, GameState, Player, Step1Action, WinReason } from './types';
import { countOnBoard } from './board';
import { applyCubeMove } from './cube';
export { invertMove } from './cube';
import { checkBothWin, completedLines, type Line } from './lines';

/*
 * 王手 (check) rule
 *
 *  - A line only counts at the end of a turn (after step ②).
 *  - If, at the end of your turn, your opponent has a line on the board, you
 *    lose: you did not break their check, or your cube move completed it.
 *  - If you have a line at the end of your turn, that is 王手 (check): your
 *    opponent must break it with their cube move. When no cube move can break
 *    it, it is 詰み (mate) and you win at once.
 *  - Every one of the 24 cube moves is always legal.
 */

const opponent = (p: Player): Player => (p === 'O' ? 'X' : 'O');

// ---- Step 1 ----

export function canPlace(state: GameState): boolean {
  return countOnBoard(state.board, state.current) <= 5;
}

export function legalPlacements(state: GameState): number[] {
  if (!canPlace(state)) return [];
  return state.board
    .map((m, i) => (m === null ? i : -1))
    .filter(i => i >= 0);
}

export function legalMoves(state: GameState): Array<{ from: number; to: number }> {
  if (canPlace(state)) return [];
  const p = state.current;
  const froms = state.board.map((m, i) => (m === p ? i : -1)).filter(i => i >= 0);
  const tos = state.board.map((m, i) => (m === null ? i : -1)).filter(i => i >= 0);
  const result: Array<{ from: number; to: number }> = [];
  for (const from of froms) {
    for (const to of tos) {
      result.push({ from, to });
    }
  }
  return result;
}

// Apply step 1: place or move. Returns new board (does not validate legality).
export function applyStep1Place(state: GameState, index: number): GameState {
  const board = state.board.slice() as Mark[];
  board[index] = state.current;
  const hand = { ...state.hand };
  hand[state.current]--;
  return { ...state, board, hand };
}

export function applyStep1Move(state: GameState, from: number, to: number): GameState {
  const board = state.board.slice() as Mark[];
  board[to] = board[from];
  board[from] = null;
  return { ...state, board };
}

// ---- Step 2 ----

export function allCubeMoves(): CubeMove[] {
  const moves: CubeMove[] = [];
  for (const axis of ['X', 'Y', 'Z'] as const) {
    for (const layer of [0, 1, 2] as const) {
      moves.push({ kind: 'rotate', axis, layer, dir: 'CW' });
      moves.push({ kind: 'rotate', axis, layer, dir: 'CCW' });
    }
    moves.push({ kind: 'slide', axis, dir: 'forward' });
    moves.push({ kind: 'slide', axis, dir: 'backward' });
  }
  return moves;
}

/** All 24 cube moves are legal on every turn (there is no banned move). */
export function legalCubeMoves(_state?: GameState): CubeMove[] {
  return allCubeMoves();
}

// ---- 王手 / 詰み ----

function hasLine(board: Mark[], p: Player): boolean {
  return checkBothWin(board)[p];
}

/** The lines that put the player to move in check (the opponent's lines on the board). */
export function checkLines(state: GameState): Line[] {
  return completedLines(state.board, opponent(state.current));
}

/** Is the player to move in check (must break the opponent's line this turn)? */
export function inCheck(state: GameState): boolean {
  return hasLine(state.board, opponent(state.current));
}

/** Cube moves after which `attacker` no longer has any line. */
export function breakingMoves(board: Mark[], attacker: Player): CubeMove[] {
  return allCubeMoves().filter(m => !hasLine(applyCubeMove(board, m), attacker));
}

/** 詰み: `attacker` has a line that no cube move can break. */
export function isMate(board: Mark[], attacker: Player): boolean {
  return hasLine(board, attacker) && breakingMoves(board, attacker).length === 0;
}

// ---- Result of a turn (after step 2) ----

export function resolveAfterCubeMove(state: GameState, move: CubeMove): GameState {
  const mover = state.current;
  const opp = opponent(mover);
  const newBoard = applyCubeMove(state.board, move);
  const newState: GameState = {
    ...state,
    board: newBoard,
    lastCubeMove: move,
    ply: state.ply + 1,
    current: opp,
  };

  const lines = checkBothWin(newBoard);
  if (lines[opp]) {
    // the opponent's line is still (or now) on the board at the end of your turn
    const reason: WinReason = hasLine(state.board, opp) ? 'notBroken' : 'selfDestruct';
    return { ...newState, status: `win:${opp}`, winReason: reason };
  }
  if (lines[mover] && isMate(newBoard, mover)) {
    return { ...newState, status: `win:${mover}`, winReason: 'mate' };
  }

  if (state.settings.turnLimit !== null && newState.ply >= state.settings.turnLimit) {
    return { ...newState, status: 'draw', winReason: 'turnLimit' };
  }
  return newState;
}

// ---- Full turn helper ----

export function applyFullTurn(state: GameState, step1: Step1Action, cubeMove: CubeMove): GameState {
  const s = step1.kind === 'place'
    ? applyStep1Place(state, step1.index)
    : applyStep1Move(state, step1.from, step1.to);
  return resolveAfterCubeMove(s, cubeMove);
}
