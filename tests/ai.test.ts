import { describe, it, expect } from 'vitest';
import { chooseMove, hasMateInOne, type CpuLevel } from '../src/core/ai';
import { initialGameState, toIndex } from '../src/core/board';
import {
  applyFullTurn, legalCubeMoves, legalMoves, legalPlacements, applyStep1Place, inCheck,
} from '../src/core/rules';
import { movesEqual } from '../src/core/cube';
import { checkBothWin } from '../src/core/lines';
import type { CubeMove, GameState, Mark, Step1Action } from '../src/core/types';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function step1Options(s: GameState): Step1Action[] {
  const p = legalPlacements(s);
  if (p.length > 0) return p.map(index => ({ kind: 'place', index }));
  return legalMoves(s).map(({ from, to }) => ({ kind: 'move', from, to }));
}

function* turns(s: GameState): Generator<{ a: Step1Action; c: CubeMove; t: GameState }> {
  const cubes = legalCubeMoves(s);
  for (const a of step1Options(s)) for (const c of cubes) yield { a, c, t: applyFullTurn(s, a, c) };
}

/** Brute force: does the side to move have a turn that wins on the spot (詰み)? */
function bruteMate(s: GameState): boolean {
  for (const { t } of turns(s)) if (t.status === `win:${s.current}`) return true;
  return false;
}

/** Random, still-running positions; random turns that lose at once are mostly avoided. */
function positions(seed: number, count: number, maxPly = 30): GameState[] {
  const r = rng(seed);
  const out: GameState[] = [];
  while (out.length < count) {
    let s = initialGameState();
    const target = Math.floor(r() * maxPly);
    while (s.status === 'playing' && s.ply < target) {
      const opts = step1Options(s), cubes = legalCubeMoves(s);
      let t = s;
      for (let k = 0; k < 20; k++) {
        t = applyFullTurn(s, opts[Math.floor(r() * opts.length)], cubes[Math.floor(r() * cubes.length)]);
        if (t.status === 'playing') break;
      }
      s = t;
    }
    if (s.status === 'playing') out.push(s);
  }
  return out;
}

function boardOf(str: string): Mark[] {
  return [...str].map(ch => (ch === 'O' || ch === 'X' ? ch : null));
}

function isLegal(s: GameState, a: Step1Action | null, c: CubeMove): boolean {
  if (a && !step1Options(s).some(o => JSON.stringify(o) === JSON.stringify(a))) return false;
  return legalCubeMoves(s).some(m => movesEqual(m, c));
}

const play = (s: GameState, d: { step1: Step1Action | null; cube: CubeMove }): GameState =>
  applyFullTurn(s, d.step1 as Step1Action, d.cube);

describe('CPU: mate-in-one test', () => {
  it('agrees with brute force (placement and movement phases)', () => {
    const ps = positions(3, 160);
    expect(ps.some(s => s.hand[s.current] === 0)).toBe(true);
    expect(ps.some(bruteMate)).toBe(true);
    for (const s of ps) expect(hasMateInOne(s)).toBe(bruteMate(s));
  });
});

describe('CPU: chooseMove', () => {
  const levels: CpuLevel[] = [1, 2, 3, 4, 5, 6];

  it('always returns a legal turn, at every level', () => {
    const ps = positions(11, 12);
    for (const lv of levels) {
      for (const s of ps) {
        const d = chooseMove(s, lv, { seed: 7, timeMs: 150 });
        expect(isLegal(s, d.step1, d.cube)).toBe(true);
      }
    }
  });

  it('chooses only a cube move when step ① is already done', () => {
    const s = applyStep1Place(initialGameState(), 13);
    const d = chooseMove(s, 4, { seed: 1, step1Done: true });
    expect(d.step1).toBeNull();
    expect(isLegal(s, null, d.cube)).toBe(true);
  });

  it('levels 3–6 always complete an unbreakable centre line', () => {
    // O has (1,1,0) and the centre: placing (1,1,2) is mate whatever the cube move
    const s: GameState = {
      ...initialGameState(),
      board: (() => {
        const b: Mark[] = Array(27).fill(null);
        b[toIndex(1, 1, 0)] = 'O'; b[toIndex(1, 1, 1)] = 'O';
        b[toIndex(0, 0, 0)] = 'X'; b[toIndex(2, 0, 2)] = 'X';
        return b;
      })(),
      hand: { O: 4, X: 4 },
    };
    for (const lv of [3, 4, 5, 6] as CpuLevel[]) {
      for (let seed = 0; seed < 5; seed++) {
        const t = play(s, chooseMove(s, lv, { seed, timeMs: 200 }));
        expect(t.status).toBe('win:O');
        expect(t.winReason).toBe('mate');
      }
    }
  });

  it('levels 4–6 never miss a mate', () => {
    const ps = positions(17, 80).filter(hasMateInOne).slice(0, 10);
    expect(ps.length).toBeGreaterThan(5);
    for (const lv of [4, 5, 6] as CpuLevel[]) {
      for (const s of ps) expect(play(s, chooseMove(s, lv, { seed: 2, timeMs: 200 })).status).toBe(`win:${s.current}`);
    }
  });

  it('levels 4–6 break a check and never allow a mate when a safe turn exists', () => {
    const ps = positions(23, 60).filter(s => !hasMateInOne(s)).slice(0, 12);
    expect(ps.some(inCheck)).toBe(true);
    for (const lv of [4, 5] as CpuLevel[]) {
      for (const s of ps) {
        const safeExists = [...turns(s)].some(x => x.t.status === 'playing' && !hasMateInOne(x.t));
        if (!safeExists) continue;
        const t = play(s, chooseMove(s, lv, { seed: 4, timeMs: 400 }));
        expect(t.status).toBe('playing');
        expect(checkBothWin(t.board)[s.current === 'O' ? 'X' : 'O']).toBe(false);
        expect(hasMateInOne(t)).toBe(false);
      }
    }
  });

  // found by self-play: O to move has no mate now, but can force one next turn
  const mateInTwo: GameState = {
    ...initialGameState(),
    board: boardOf('..XOXOX.O...O........X.....'),
    hand: { O: 2, X: 2 },
    ply: 8,
  };

  it('level 5 at full strength plays a forced mate in two when one exists', () => {
    const s = mateInTwo;
    expect(hasMateInOne(s)).toBe(false);
    const t = play(s, chooseMove(s, 5, { seed: 9, timeMs: 5000, noSlip: true }));
    expect(t.status).toBe('playing');
    for (const { t: u } of turns(t)) {
      if (u.status === 'win:O') continue; // the reply loses at once
      expect(u.status).toBe('playing');
      expect(hasMateInOne(u)).toBe(true);
    }
  });

  it('levels 5 and 6 sometimes read shallower (うっかり), level 4 never reads deeper', () => {
    for (const lv of [5, 6] as CpuLevel[]) {
      const depths = new Set<number>();
      for (let seed = 0; seed < 20; seed++) depths.add(chooseMove(mateInTwo, lv, { seed, timeMs: 3000 }).info.depth);
      expect(depths.has(1)).toBe(true);
      expect(Math.max(...depths)).toBeGreaterThanOrEqual(2);
    }
    for (let seed = 0; seed < 10; seed++) expect(chooseMove(mateInTwo, 4, { seed }).info.depth).toBe(1);
  });
});
