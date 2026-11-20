import { describe, it, expect } from 'vitest';
import { movePermutation, applyCubeMove, moveKey, layerCells, AXIS_INDEX } from '../src/core/cube';
import { allCubeMoves } from '../src/core/rules';
import { fromIndex, toIndex } from '../src/core/board';
import type { Axis, Mark } from '../src/core/types';

type V3 = [number, number, number];

/** Right-hand rotation of centred coordinates by ±90° about `axis`. */
function rotate90([x, y, z]: V3, axis: Axis, s: 1 | -1): V3 {
  if (axis === 'X') return [x, -s * z, s * y];
  if (axis === 'Y') return [s * z, y, -s * x];
  return [-s * y, s * x, z];
}

const centred = (i: number): V3 => {
  const [x, y, z] = fromIndex(i);
  return [x - 1, y - 1, z - 1];
};
const uncentre = ([x, y, z]: V3): number => toIndex(x + 1, y + 1, z + 1);

describe('rotation convention (shared with the 3D animation)', () => {
  for (const m of allCubeMoves()) {
    if (m.kind !== 'rotate') continue;
    it(`${moveKey(m)}: CCW = +90° right-hand about +axis, CW = −90°`, () => {
      const perm = movePermutation(m);
      const sign = m.dir === 'CCW' ? 1 : -1;
      const a = AXIS_INDEX[m.axis];
      for (let i = 0; i < 27; i++) {
        if (fromIndex(i)[a] === m.layer) {
          expect(perm[i]).toBe(uncentre(rotate90(centred(i), m.axis, sign)));
        } else {
          expect(perm[i]).toBe(i);
        }
      }
    });
  }
});

describe('slide convention', () => {
  for (const m of allCubeMoves()) {
    if (m.kind !== 'slide') continue;
    it(`${moveKey(m)}: forward = −1, backward = +1 along the axis (wrapping)`, () => {
      const perm = movePermutation(m);
      const a = AXIS_INDEX[m.axis];
      const step = m.dir === 'forward' ? -1 : 1;
      for (let i = 0; i < 27; i++) {
        const from = fromIndex(i);
        const to = fromIndex(perm[i]);
        for (let k = 0; k < 3; k++) {
          expect(to[k]).toBe(k === a ? (from[k] + step + 3) % 3 : from[k]);
        }
      }
    });
  }
});

describe('permutations', () => {
  it('every move is a bijection of the 27 cells', () => {
    for (const m of allCubeMoves()) {
      expect(new Set(movePermutation(m)).size).toBe(27);
    }
  });

  it('applyCubeMove moves board[i] to perm[i]', () => {
    const board = Array.from({ length: 27 }, (_, i) => String(i)) as unknown as Mark[];
    for (const m of allCubeMoves()) {
      const perm = movePermutation(m);
      const next = applyCubeMove(board, m);
      for (let i = 0; i < 27; i++) expect(next[perm[i]]).toBe(board[i]);
    }
  });

  it('there are 24 distinct move keys', () => {
    expect(new Set(allCubeMoves().map(moveKey)).size).toBe(24);
  });

  it('layerCells returns the 9 cells of a layer', () => {
    const cells = layerCells('Y', 2);
    expect(cells).toHaveLength(9);
    for (const i of cells) expect(fromIndex(i)[1]).toBe(2);
  });
});
