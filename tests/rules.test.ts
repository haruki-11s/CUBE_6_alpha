import { describe, it, expect } from 'vitest';
import {
  legalPlacements, legalMoves, legalCubeMoves,
  applyStep1Place, applyFullTurn,
  resolveAfterCubeMove,
  isReverseCubeMove,
} from '../src/core/rules';
import { checkBothWin } from '../src/core/lines';
import { initialGameState, toIndex } from '../src/core/board';
import type { GameState, CubeMove, Mark } from '../src/core/types';

function boardWith(cells: Array<[number, number, number, 'O' | 'X']>): Mark[] {
  const b: Mark[] = Array(27).fill(null);
  for (const [x, y, z, m] of cells) b[toIndex(x, y, z)] = m;
  return b;
}

// ---- Placement / movement legality ----

describe('step1 legality', () => {
  it('O can place when hand > 0 (<=5 on board)', () => {
    const s = initialGameState();
    expect(legalPlacements(s)).toHaveLength(27);
    expect(legalMoves(s)).toHaveLength(0);
  });

  it('O must move when all 6 pieces on board', () => {
    let s = initialGameState();
    for (let i = 0; i < 6; i++) {
      s = applyStep1Place(s, i);
      s = { ...s, current: 'O' }; // keep same player for test
    }
    expect(s.hand.O).toBe(0);
    expect(legalPlacements(s)).toHaveLength(0);
    const moves = legalMoves(s);
    expect(moves.length).toBeGreaterThan(0);
    const oPositions = new Set(s.board.map((m, i) => m === 'O' ? i : -1).filter(i => i >= 0));
    expect(oPositions.size).toBe(6);
    for (const mv of moves) {
      expect(oPositions.has(mv.from)).toBe(true);
      expect(s.board[mv.to]).toBeNull();
    }
  });

  it('cannot move to the same cell (from !== to enforced by legalMoves)', () => {
    let s = initialGameState();
    for (let i = 0; i < 6; i++) s = { ...applyStep1Place(s, i), current: 'O' };
    for (const mv of legalMoves(s)) expect(mv.from).not.toBe(mv.to);
  });
});

// ---- Reverse move prohibition ----

describe('legalCubeMoves', () => {
  it('all 24 moves legal on first turn (no lastCubeMove)', () => {
    expect(legalCubeMoves(initialGameState())).toHaveLength(24);
  });

  it('exactly 23 moves legal when last move exists (reverse is banned)', () => {
    const s: GameState = {
      ...initialGameState(),
      lastCubeMove: { kind: 'rotate', axis: 'Z', layer: 0, dir: 'CW' },
    };
    const legal = legalCubeMoves(s);
    expect(legal).toHaveLength(23);
    const forbidden: CubeMove = { kind: 'rotate', axis: 'Z', layer: 0, dir: 'CCW' };
    expect(legal.some(m => JSON.stringify(m) === JSON.stringify(forbidden))).toBe(false);
  });

  it('slide forward is banned only when last was slide backward (same axis)', () => {
    const s: GameState = {
      ...initialGameState(),
      lastCubeMove: { kind: 'slide', axis: 'X', dir: 'backward' },
    };
    const legal = legalCubeMoves(s);
    expect(legal).toHaveLength(23);
    expect(legal.some(m => m.kind === 'slide' && m.axis === 'X' && m.dir === 'forward')).toBe(false);
  });

  it('isReverseCubeMove correctly identifies inverse', () => {
    expect(isReverseCubeMove(
      { kind: 'rotate', axis: 'X', layer: 1, dir: 'CW' },
      { kind: 'rotate', axis: 'X', layer: 1, dir: 'CCW' },
    )).toBe(true);
    expect(isReverseCubeMove(
      { kind: 'slide', axis: 'Y', dir: 'forward' },
      { kind: 'slide', axis: 'Y', dir: 'backward' },
    )).toBe(true);
    expect(isReverseCubeMove(
      { kind: 'rotate', axis: 'X', layer: 1, dir: 'CW' },
      { kind: 'rotate', axis: 'X', layer: 1, dir: 'CW' },
    )).toBe(false);
  });
});

// ---- Step 1 immediate win ----

describe('step1 immediate win', () => {
  it('placing the winning piece ends game before step2', () => {
    const s: GameState = {
      ...initialGameState(),
      board: boardWith([[0, 0, 0, 'O'], [1, 0, 0, 'O']]),
      hand: { O: 4, X: 6 },
    };
    const cubeMove: CubeMove = { kind: 'slide', axis: 'X', dir: 'forward' };
    const result = applyFullTurn(s, { kind: 'place', index: toIndex(2, 0, 0) }, cubeMove);
    expect(result.status).toBe('win:O');
    expect(result.winReason).toBe('line');
    // step2 skipped: the board only reflects step1
    expect(result.board[toIndex(2, 0, 0)]).toBe('O');
  });
});

// ---- Self-destruct ----

describe('self-destruct (自爆)', () => {
  it('an opponent-only line after step ② is scored as self-destruct', () => {
    // A slide translates the whole board, so X's face diagonal survives it.
    // (Contrived — in real play X could not already own a line — but it isolates the scoring.)
    const s: GameState = {
      ...initialGameState(),
      board: boardWith([[0, 0, 0, 'X'], [0, 1, 1, 'X'], [0, 2, 2, 'X'], [2, 2, 2, 'O']]),
      hand: { O: 5, X: 3 },
      current: 'O',
    };
    const result = resolveAfterCubeMove(s, { kind: 'slide', axis: 'X', dir: 'backward' });
    expect(result.status).toBe('win:X');
    expect(result.winReason).toBe('selfDestruct');
  });

  it('layer rotation that creates an opponent line → self-destruct', () => {
    // X: (2,0,0), (2,2,1), (2,2,2) — no line. Rotating Z-layer 0 CCW moves (2,0,0) → (2,2,0),
    // completing X's z-line (2,2,*).
    const s: GameState = {
      ...initialGameState(),
      board: boardWith([[2, 0, 0, 'X'], [2, 2, 1, 'X'], [2, 2, 2, 'X'], [0, 0, 1, 'O']]),
      hand: { O: 5, X: 3 },
      current: 'O',
    };
    expect(checkBothWin(s.board)).toEqual({ O: false, X: false });
    const result = resolveAfterCubeMove(s, { kind: 'rotate', axis: 'Z', layer: 0, dir: 'CCW' });
    expect(result.status).toBe('win:X');
    expect(result.winReason).toBe('selfDestruct');
  });
});

// ---- Simultaneous win = draw ----

describe('simultaneous completion = draw', () => {
  it('checkBothWin correctly detects simultaneous completion', () => {
    const b = boardWith([
      [0, 0, 0, 'O'], [1, 0, 0, 'O'], [2, 0, 0, 'O'],
      [0, 1, 0, 'X'], [1, 1, 0, 'X'], [2, 1, 0, 'X'],
    ]);
    expect(checkBothWin(b)).toEqual({ O: true, X: true });
  });

  it('a single layer rotation can complete lines for BOTH players → draw', () => {
    // Before: no lines.  Z-layer 0 CCW maps (x,y) → (2−y, x):
    //   O (0,2,0) → (0,0,0) completes O's z-line (0,0,*)
    //   X (2,0,0) → (2,2,0) completes X's z-line (2,2,*)
    const s: GameState = {
      ...initialGameState(),
      board: boardWith([
        [0, 2, 0, 'O'], [0, 0, 1, 'O'], [0, 0, 2, 'O'],
        [2, 0, 0, 'X'], [2, 2, 1, 'X'], [2, 2, 2, 'X'],
      ]),
      hand: { O: 3, X: 3 },
      current: 'O',
    };
    expect(checkBothWin(s.board)).toEqual({ O: false, X: false });
    const result = resolveAfterCubeMove(s, { kind: 'rotate', axis: 'Z', layer: 0, dir: 'CCW' });
    expect(result.status).toBe('draw');
    expect(result.winReason).toBe('simultaneous');
  });
});

// ---- Turn limit ----

describe('turn limit', () => {
  it('returns draw with turnLimit reason when ply reaches limit', () => {
    const s: GameState = { ...initialGameState(), ply: 99, settings: { turnLimit: 100 } };
    const after1 = applyStep1Place(s, 0);
    const result = resolveAfterCubeMove(after1, { kind: 'slide', axis: 'X', dir: 'forward' });
    expect(result.status).toBe('draw');
    expect(result.winReason).toBe('turnLimit');
  });

  it('does not draw before limit', () => {
    const s: GameState = { ...initialGameState(), ply: 5, settings: { turnLimit: 100 } };
    const after1 = applyStep1Place(s, 0);
    const result = resolveAfterCubeMove(after1, { kind: 'slide', axis: 'X', dir: 'forward' });
    expect(result.status).toBe('playing');
  });
});

// ---- Full game progression ----

describe('full game state transitions', () => {
  it('hand decrements on placement', () => {
    const s1 = applyStep1Place(initialGameState(), 0);
    expect(s1.hand.O).toBe(5);
    expect(s1.hand.X).toBe(6);
  });

  it('turn switches after applyFullTurn', () => {
    const result = applyFullTurn(initialGameState(), { kind: 'place', index: 0 }, { kind: 'slide', axis: 'X', dir: 'forward' });
    expect(result.current).toBe('X');
    expect(result.ply).toBe(1);
  });

  it('lastCubeMove is recorded', () => {
    const move: CubeMove = { kind: 'rotate', axis: 'Y', layer: 1, dir: 'CW' };
    const result = applyFullTurn(initialGameState(), { kind: 'place', index: 0 }, move);
    expect(result.lastCubeMove).toEqual(move);
  });
});
