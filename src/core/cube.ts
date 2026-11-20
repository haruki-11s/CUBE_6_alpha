import type { Mark, CubeMove, Axis } from './types';
import { toIndex, fromIndex } from './board';

/*
 * Geometry conventions — shared by the game logic AND the 3D renderer.
 *
 *  rotate  'CCW' = +90° right-hand rotation about the positive axis, i.e.
 *          counter-clockwise when viewed from the + end of the axis looking
 *          toward the centre. 'CW' is the opposite. Identical for X, Y and Z.
 *  slide   'forward'  shifts every cell by −1 along the axis (0 wraps to 2),
 *          'backward' shifts every cell by +1 along the axis (2 wraps to 0).
 *
 * tests/geometry.test.ts verifies these conventions against rotation matrices,
 * so the animation and the rules can never drift apart again.
 */

export const AXIS_INDEX: Readonly<Record<Axis, 0 | 1 | 2>> = { X: 0, Y: 1, Z: 2 };

export function moveKey(m: CubeMove): string {
  return m.kind === 'rotate' ? `r${m.axis}${m.layer}${m.dir}` : `s${m.axis}${m.dir}`;
}

const permCache = new Map<string, readonly number[]>();

/** perm[i] = destination index of the piece currently on cell i. */
export function movePermutation(move: CubeMove): readonly number[] {
  const key = moveKey(move);
  const hit = permCache.get(key);
  if (hit) return hit;

  const perm: number[] = [];
  for (let i = 0; i < 27; i++) {
    const [x, y, z] = fromIndex(i);
    let nx = x, ny = y, nz = z;
    if (move.kind === 'rotate') {
      const c = [x, y, z][AXIS_INDEX[move.axis]];
      if (c === move.layer) {
        const ccw = move.dir === 'CCW';
        if (move.axis === 'X') {        // (y, z) → CCW: (2 − z, y)
          ny = ccw ? 2 - z : z;
          nz = ccw ? y : 2 - y;
        } else if (move.axis === 'Y') { // (z, x) → CCW: (x, z) ↦ (z, 2 − x)
          nx = ccw ? z : 2 - z;
          nz = ccw ? 2 - x : x;
        } else {                        // (x, y) → CCW: (2 − y, x)
          nx = ccw ? 2 - y : y;
          ny = ccw ? x : 2 - x;
        }
      }
    } else {
      const step = move.dir === 'forward' ? 2 : 1; // −1 or +1 (mod 3)
      if (move.axis === 'X') nx = (x + step) % 3;
      else if (move.axis === 'Y') ny = (y + step) % 3;
      else nz = (z + step) % 3;
    }
    perm.push(toIndex(nx, ny, nz));
  }
  const frozen = Object.freeze(perm);
  permCache.set(key, frozen);
  return frozen;
}

export function applyCubeMove(board: Mark[], move: CubeMove): Mark[] {
  const perm = movePermutation(move);
  const next = board.slice();
  for (let i = 0; i < 27; i++) next[perm[i]] = board[i];
  return next;
}

/** Indices of the 9 cells whose coordinate on `axis` equals `layer`. */
export function layerCells(axis: Axis, layer: number): number[] {
  const out: number[] = [];
  const a = AXIS_INDEX[axis];
  for (let i = 0; i < 27; i++) if (fromIndex(i)[a] === layer) out.push(i);
  return out;
}

export function invertMove(move: CubeMove): CubeMove {
  if (move.kind === 'rotate') {
    return { kind: 'rotate', axis: move.axis, layer: move.layer, dir: move.dir === 'CW' ? 'CCW' : 'CW' };
  }
  return { kind: 'slide', axis: move.axis, dir: move.dir === 'forward' ? 'backward' : 'forward' };
}

export function movesEqual(a: CubeMove, b: CubeMove): boolean {
  return moveKey(a) === moveKey(b);
}
