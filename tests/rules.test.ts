import { describe, it, expect } from 'vitest';
import {
  legalPlacements, legalMoves, legalCubeMoves,
  applyStep1Place, applyFullTurn,
  resolveAfterCubeMove,
  inCheck, checkLines, breakingMoves, isMate,
} from '../src/core/rules';
import { applyCubeMove } from '../src/core/cube';
import { checkBothWin } from '../src/core/lines';
import { initialGameState, toIndex } from '../src/core/board';
import type { GameState, CubeMove, Mark } from '../src/core/types';

function boardWith(cells: Array<[number, number, number, 'O' | 'X']>): Mark[] {
  const b: Mark[] = Array(27).fill(null);
  for (const [x, y, z, m] of cells) b[toIndex(x, y, z)] = m;
  return b;
}

const rot = (axis: 'X' | 'Y' | 'Z', layer: 0 | 1 | 2, dir: 'CW' | 'CCW'): CubeMove => ({ kind: 'rotate', axis, layer, dir });

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

// ---- Cube moves: no banned move ----

describe('legalCubeMoves', () => {
  it('all 24 moves are legal, even right after the opponent played the inverse', () => {
    expect(legalCubeMoves(initialGameState())).toHaveLength(24);
    const s: GameState = { ...initialGameState(), lastCubeMove: rot('Z', 0, 'CW') };
    expect(legalCubeMoves(s)).toHaveLength(24);
    expect(legalCubeMoves(s).some(m => JSON.stringify(m) === JSON.stringify(rot('Z', 0, 'CCW')))).toBe(true);
  });
});

// ---- 王手 rule ----

// O's line along x at y = 0, z = 0 once (2,0,0) is placed
const nearLine = (): GameState => ({
  ...initialGameState(),
  board: boardWith([[0, 0, 0, 'O'], [1, 0, 0, 'O'], [1, 1, 2, 'X'], [2, 2, 2, 'X']]),
  hand: { O: 4, X: 4 },
});

describe('王手 (check)', () => {
  it('completing a line in step ① is not a win by itself', () => {
    // Z-layer 2 does not touch the line: it survives the cube move → check
    const t = applyFullTurn(nearLine(), { kind: 'place', index: toIndex(2, 0, 0) }, rot('Z', 2, 'CW'));
    expect(t.status).toBe('playing');
    expect(t.current).toBe('X');
    expect(inCheck(t)).toBe(true);
    expect(checkLines(t)).toHaveLength(1);
  });

  it('a line broken by your own cube move is nothing', () => {
    // X-layer 0 moves (0,0,0) out of the line
    const t = applyFullTurn(nearLine(), { kind: 'place', index: toIndex(2, 0, 0) }, rot('X', 0, 'CCW'));
    expect(t.status).toBe('playing');
    expect(inCheck(t)).toBe(false);
  });

  it('breaking the check keeps the game going; leaving it loses', () => {
    const checked = applyFullTurn(nearLine(), { kind: 'place', index: toIndex(2, 0, 0) }, rot('Z', 2, 'CW'));
    const escapes = breakingMoves(checked.board, 'O');
    expect(escapes.length).toBeGreaterThan(0);
    expect(escapes.length).toBeLessThan(24);

    const broke = applyFullTurn(checked, { kind: 'place', index: toIndex(0, 2, 0) }, escapes[0]);
    expect(broke.status).toBe('playing');
    expect(checkBothWin(broke.board).O).toBe(false);

    const kept = legalCubeMoves(checked).find(m => !escapes.some(e => JSON.stringify(e) === JSON.stringify(m))) as CubeMove;
    const lost = applyFullTurn(checked, { kind: 'place', index: toIndex(0, 2, 0) }, kept);
    expect(lost.status).toBe('win:O');
    expect(lost.winReason).toBe('notBroken');
  });

  it('a cube move that completes the opponent\'s line loses (自爆)', () => {
    // X: (2,0,0), (2,2,1), (2,2,2). Rotating Z-layer 0 CCW moves (2,0,0) → (2,2,0).
    const s: GameState = {
      ...initialGameState(),
      board: boardWith([[2, 0, 0, 'X'], [2, 2, 1, 'X'], [2, 2, 2, 'X'], [0, 0, 1, 'O']]),
      hand: { O: 5, X: 3 },
      current: 'O',
    };
    expect(checkBothWin(s.board)).toEqual({ O: false, X: false });
    const result = resolveAfterCubeMove(s, rot('Z', 0, 'CCW'));
    expect(result.status).toBe('win:X');
    expect(result.winReason).toBe('selfDestruct');
  });

  it('when one cube move completes both lines, the mover loses', () => {
    // Z-layer 0 CCW: O (0,2,0) → (0,0,0) and X (2,0,0) → (2,2,0) both complete
    const s: GameState = {
      ...initialGameState(),
      board: boardWith([
        [0, 2, 0, 'O'], [0, 0, 1, 'O'], [0, 0, 2, 'O'],
        [2, 0, 0, 'X'], [2, 2, 1, 'X'], [2, 2, 2, 'X'],
      ]),
      hand: { O: 3, X: 3 },
      current: 'O',
    };
    const result = resolveAfterCubeMove(s, rot('Z', 0, 'CCW'));
    expect(checkBothWin(result.board)).toEqual({ O: true, X: true });
    expect(result.status).toBe('win:X');
  });
});

describe('詰み (mate)', () => {
  it('the three centre-axis lines survive every cube move', () => {
    const axisLines = [
      [[1, 1, 0], [1, 1, 1], [1, 1, 2]],
      [[1, 0, 1], [1, 1, 1], [1, 2, 1]],
      [[0, 1, 1], [1, 1, 1], [2, 1, 1]],
    ] as const;
    for (const line of axisLines) {
      const b = boardWith(line.map(([x, y, z]) => [x, y, z, 'O'] as [number, number, number, 'O']));
      for (const m of legalCubeMoves()) expect(checkBothWin(applyCubeMove(b, m)).O).toBe(true);
      expect(isMate(b, 'O')).toBe(true);
      expect(breakingMoves(b, 'O')).toHaveLength(0);
    }
  });

  it('an unbreakable line wins at once', () => {
    const s: GameState = {
      ...initialGameState(),
      board: boardWith([[1, 1, 0, 'O'], [1, 1, 1, 'O'], [0, 0, 0, 'X'], [2, 2, 2, 'X']]),
      hand: { O: 4, X: 4 },
    };
    const t = applyFullTurn(s, { kind: 'place', index: toIndex(1, 1, 2) }, rot('Y', 0, 'CW'));
    expect(t.status).toBe('win:O');
    expect(t.winReason).toBe('mate');
  });

  it('an ordinary edge line is not mate', () => {
    const b = boardWith([[0, 0, 0, 'O'], [1, 0, 0, 'O'], [2, 0, 0, 'O']]);
    expect(isMate(b, 'O')).toBe(false);
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
