import type { CubeMove, GameState, Mark, Player, Step1Action } from './types';
import { allCubeMoves } from './rules';
import { movePermutation } from './cube';
import { LINES } from './lines';
import { toIndex } from './board';

/*
 * CPU player (王手 rule).
 *
 * The board is held as two 27-bit masks (side to move / other side) and a
 * whole turn — step ① (place or move) followed by step ② (cube move) — is
 * one node of a negamax search with alpha-beta pruning.
 *
 * A turn that leaves the opponent a line on the board loses on the spot, so
 * it is never searched. A turn that leaves the mover a line is 王手 (check);
 * a check that no cube move can break is 詰み (mate), an immediate win.
 *
 * The key primitive is `canMate`: an *exact* test of whether the side to
 * move can deliver mate this turn. It is used at every node, so even a
 * shallow search never misses a mate and never walks into one it could see.
 *
 * Strength levels differ in search depth, in how reliably they notice
 * mates / checks / dangers, in how much randomness they add, and in how
 * often they read shallower than they could (うっかり).
 */

export type CpuLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface AiDecision {
  /** null when step ① had already been played (only the cube move was chosen). */
  step1: Step1Action | null;
  cube: CubeMove;
  /** Diagnostics: completed search depth, nodes visited, time and score. */
  info: { depth: number; nodes: number; ms: number; score: number };
}

export interface AiOptions {
  seed?: number;
  /** Override the level's thinking-time budget (ms). */
  timeMs?: number;
  /** The side to move has already played step ①; choose the cube move only. */
  step1Done?: boolean;
  /** Cap the search depth (tests / benchmarks). */
  maxDepth?: number;
  /** Always read at full strength: no うっかり (tests / benchmarks). */
  noSlip?: boolean;
  now?: () => number;
}

interface LevelParams {
  /** Search depth in whole turns (0 = judge this turn only). */
  depth: number;
  /** Thinking budget for the deeper iterations (ms). */
  timeMs: number;
  /*
   * Depth-0 levels "see" like a person: each kind of danger or chance is
   * noticed only with some probability.
   */
  /** Chance of noticing a mate this turn. */
  pMate: number;
  /** When in check: chance of choosing a cube move that breaks it. */
  pEscape: number;
  /** Chance of avoiding a cube move that completes the opponent's line (自爆). */
  pAvoidSelf: number;
  /** Chance of not leaving the opponent a mate next turn. */
  pAvoidMate: number;
  /** Chance of going for a check (王手) when one is available. */
  pCheck: number;
  /** ± random noise added to the positional score (depth 0 only). */
  noise: number;
  /** Search levels pick randomly among moves within this score of the best. */
  margin: number;
  /** Depth ≥ 3: re-search only the best N root moves … */
  rootCap: number;
  /** … and only the best N replies at inner nodes. */
  replyCap: number;
  /**
   * Threat search (checks and centre-line threats only), in own turns:
   * look for a forced mate (attack) …
   */
  attack: number;
  /** … and drop candidate moves that allow one (defence); 0 = off. */
  defence: number;
  /**
   * うっかり: per-move chance of reading only 1 turn (slip1) or only 2 turns
   * (slip2) ahead, without the threat search. The rest of the time the CPU
   * reads at full strength.
   */
  slip1: number;
  slip2: number;
  /** Overrides used when the CPU moves first (it already has the first-player advantage). */
  asFirst?: Partial<Pick<LevelParams, 'slip1' | 'slip2' | 'attack' | 'defence'>>;
}

const SURE = { pMate: 1, pEscape: 1, pAvoidSelf: 1, pAvoidMate: 1, pCheck: 0, noise: 0 };
const NO_THREAT = { attack: 0, defence: 0, slip1: 0, slip2: 0 };

export const LEVEL_PARAMS: Readonly<Record<CpuLevel, LevelParams>> = {
  1: { depth: 0, timeMs: 0, pMate: 0.6, pEscape: 0.8, pAvoidSelf: 0.6, pAvoidMate: 0.35, pCheck: 0.5, noise: 1e6, margin: 0, rootCap: 0, replyCap: 0, ...NO_THREAT },
  2: { depth: 0, timeMs: 0, pMate: 0.85, pEscape: 0.92, pAvoidSelf: 0.85, pAvoidMate: 0.55, pCheck: 0.5, noise: 40, margin: 0, rootCap: 0, replyCap: 0, ...NO_THREAT },
  3: { depth: 0, timeMs: 0, pMate: 1, pEscape: 1, pAvoidSelf: 0.97, pAvoidMate: 0.9, pCheck: 0.3, noise: 14, margin: 0, rootCap: 0, replyCap: 0, ...NO_THREAT },
  4: { depth: 1, timeMs: 0, ...SURE, margin: 6, rootCap: 0, replyCap: 0, ...NO_THREAT },
  5: { depth: 2, timeMs: 2200, ...SURE, margin: 2, rootCap: 0, replyCap: 0, ...NO_THREAT, slip1: 0.6 },
  6: {
    depth: 3, timeMs: 6000, ...SURE, margin: 0, rootCap: 0, replyCap: 0, ...NO_THREAT,
    attack: 3, slip1: 0.15, slip2: 0.3, asFirst: { slip1: 0.25, slip2: 0.45 },
  },
};

// ═══════════════════════════════ Tables ════════════════════════════════════

const MOVES: readonly CubeMove[] = allCubeMoves();
const NM = MOVES.length;
const FULL = (1 << 27) - 1;
const WIN = 1_000_000;
const INF = 2_000_000_000;

/** PERM[c*27+i] = where the piece on cell i goes; IPERM is the inverse. */
const PERM = new Int8Array(NM * 27);
const IPERM = new Int8Array(NM * 27);
/** Mask permutation in three 9-bit chunks: apply(c, m) = T0|T1|T2 lookups. */
const T0 = new Int32Array(NM << 9);
const T1 = new Int32Array(NM << 9);
const T2 = new Int32Array(NM << 9);

for (let c = 0; c < NM; c++) {
  const p = movePermutation(MOVES[c]);
  for (let i = 0; i < 27; i++) {
    PERM[c * 27 + i] = p[i];
    IPERM[c * 27 + p[i]] = i;
  }
  for (let v = 0; v < 512; v++) {
    let a = 0, b = 0, d = 0;
    for (let k = 0; k < 9; k++) {
      if ((v >> k) & 1) {
        a |= 1 << p[k];
        b |= 1 << p[9 + k];
        d |= 1 << p[18 + k];
      }
    }
    T0[(c << 9) | v] = a;
    T1[(c << 9) | v] = b;
    T2[(c << 9) | v] = d;
  }
}

const NL = LINES.length;
const LA = new Int8Array(NL), LB = new Int8Array(NL), LC = new Int8Array(NL);
/** THIRD[a*27+b] = the cell completing the line through a and b (−1: none). */
const THIRD = new Int8Array(27 * 27).fill(-1);
LINES.forEach(([a, b, c], k) => {
  LA[k] = a; LB[k] = b; LC[k] = c;
  THIRD[a * 27 + b] = c; THIRD[b * 27 + a] = c;
  THIRD[a * 27 + c] = b; THIRD[c * 27 + a] = b;
  THIRD[b * 27 + c] = a; THIRD[c * 27 + b] = a;
});

/** The three lines through the centre along an axis: no cube move can break them. */
const AXIS_LINES = [
  [toIndex(1, 1, 0), toIndex(1, 1, 1), toIndex(1, 1, 2)],
  [toIndex(1, 0, 1), toIndex(1, 1, 1), toIndex(1, 2, 1)],
  [toIndex(0, 1, 1), toIndex(1, 1, 1), toIndex(2, 1, 1)],
].map(l => l.reduce((m, i) => m | (1 << i), 0));
const CENTER = toIndex(1, 1, 1);
/** Per line: 1 when it is one of the unbreakable centre-axis lines. */
const IS_AXIS = new Uint8Array(NL);
LINES.forEach(([a, b, c], k) => {
  const m = (1 << a) | (1 << b) | (1 << c);
  IS_AXIS[k] = AXIS_LINES.includes(m) ? 1 : 0;
});

/**
 * PTH[(a*27+b)*NM + c] = the cell whose piece completes a line with the
 * pieces on a and b once cube move c is played (−1: they never line up).
 * PL_CELL[PL_OFF[a*27+b] ..] lists those cells over all cube moves (a < b).
 */
const PTH = new Int8Array(27 * 27 * NM).fill(-1);
const PL_OFF = new Int32Array(27 * 27 + 1);
const plCells: number[] = [];
for (let a = 0; a < 27; a++) {
  for (let b = 0; b < 27; b++) {
    PL_OFF[a * 27 + b] = plCells.length;
    if (a === b) continue;
    for (let c = 0; c < NM; c++) {
      const base = c * 27;
      const t = THIRD[PERM[base + a] * 27 + PERM[base + b]];
      if (t < 0) continue;
      PTH[(a * 27 + b) * NM + c] = IPERM[base + t];
      if (a < b) plCells.push(IPERM[base + t]);
    }
  }
}
PL_OFF[27 * 27] = plCells.length;
const PL_CELL = Int8Array.from(plCells);

// ═══════════════════════════════ Bit helpers ═══════════════════════════════

function apply(c: number, m: number): number {
  const o = c << 9;
  return T0[o | (m & 511)] | T1[o | ((m >>> 9) & 511)] | T2[o | (m >>> 18)];
}

function bitsOf(m: number, out: Int8Array): number {
  let n = 0;
  while (m !== 0) {
    const low = m & -m;
    out[n++] = 31 - Math.clz32(low);
    m ^= low;
  }
  return n;
}

/** Does `mask` (pieces listed in l[0..n)) contain a complete line? */
function lineIn(l: Int8Array, n: number, mask: number): boolean {
  for (let i = 0; i < n - 2; i++) {
    const a = l[i] * 27;
    for (let j = i + 1; j < n; j++) {
      const t = THIRD[a + l[j]];
      if (t >= 0 && ((mask >>> t) & 1) !== 0) return true;
    }
  }
  return false;
}

/** Would `mask` (pieces listed in l[0..n)) contain a complete line after cube move c? */
function lineUnder(c: number, l: Int8Array, n: number, mask: number): boolean {
  for (let i = 0; i < n - 2; i++) {
    const row = l[i] * 27;
    for (let j = i + 1; j < n; j++) {
      const t = PTH[(row + l[j]) * NM + c];
      if (t >= 0 && ((mask >>> t) & 1) !== 0) return true;
    }
  }
  return false;
}

const MT = new Int8Array(8);
/** 詰み test for a mask that has a line: does every cube move leave it a line? */
function unbreakable(A: number): boolean {
  for (let k = 0; k < 3; k++) if ((A & AXIS_LINES[k]) === AXIS_LINES[k]) return true;
  const n = bitsOf(A, MT);
  for (let d = 0; d < NM; d++) if (!lineUnder(d, MT, n, A)) return false;
  return true;
}

/** oln[c] = 1 when cube move c leaves `mask` (pieces l[0..n)) a line. Returns how many moves don't. */
function lineMoves(l: Int8Array, n: number, mask: number, oln: Uint8Array): number {
  let free = 0;
  for (let c = 0; c < NM; c++) {
    const v = n >= 3 && lineUnder(c, l, n, mask) ? 1 : 0;
    oln[c] = v;
    free += 1 - v;
  }
  return free;
}

const ML = new Int8Array(8);
/**
 * Exact: can S deliver mate this turn? `oln[c]` marks the cube moves that
 * leave O a line (those lose instead). Step ① adds one piece to `B` (S
 * itself when placing, S minus the moved piece when moving).
 */
function canMate(S: number, O: number, hS: number, oln: Uint8Array): boolean {
  const empty = ~(S | O) & FULL;
  if (hS > 0) return mateFrom(S, empty, oln);
  for (let r = S; r !== 0; r &= r - 1) {
    if (mateFrom(S ^ (r & -r), empty, oln)) return true;
  }
  return false;
}

function mateFrom(B: number, empty: number, oln: Uint8Array): boolean {
  const nb = bitsOf(B, ML);
  if (nb < 2) return false;
  for (let c = 0; c < NM; c++) {
    if (oln[c] !== 0) continue;
    if (nb >= 3 && lineUnder(c, ML, nb, B)) {
      // B already lines up under c: any placement keeps a line (rare)
      for (let e = empty; e !== 0; e &= e - 1) if (unbreakable(apply(c, B | (e & -e)))) return true;
      continue;
    }
    for (let i = 0; i < nb - 1; i++) {
      const row = ML[i] * 27;
      for (let j = i + 1; j < nb; j++) {
        const q = PTH[(row + ML[j]) * NM + c];
        if (q >= 0 && ((empty >>> q) & 1) !== 0 && unbreakable(apply(c, B | (1 << q)))) return true;
      }
    }
  }
  return false;
}

/** Count pairs of `l` that some cube move lines up with an empty third cell. */
function pairThreats(l: Int8Array, n: number, occ: number): number {
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const row = l[i] * 27;
    for (let j = i + 1; j < n; j++) {
      const p = row + l[j];
      for (let q = PL_OFF[p], e = PL_OFF[p + 1]; q < e; q++) if (((occ >>> PL_CELL[q]) & 1) === 0) k++;
    }
  }
  return k;
}

// Positional weights (side to move = S). Tuned by self-play.
const W_OPEN1 = 2;      // own piece on a line free of the opponent
const W_OPEN2_S = 10;   // two of ours, third empty: we can check (or mate) now
const W_OPEN2_O = 14;   // two of theirs, third empty: they can check next turn
const W_AXIS2_O = 40;   // … on a centre-axis line: they threaten mate
const W_CHECKED = 50;   // their line is on the board: we are in check
const W_PAIR_S = 2;     // a cube move would line up two of ours
const W_PAIR_O = 3;
const W_CENTER = 6;     // the centre cell lies on all three unbreakable lines

/** Static score for S to move, assuming S has no mate this turn. */
function evaluate(S: number, sl: Int8Array, ns: number, O: number, ol: Int8Array, no: number): number {
  let score = 0;
  for (let k = 0; k < NL; k++) {
    const a = LA[k], b = LB[k], c = LC[k];
    const s = ((S >>> a) & 1) + ((S >>> b) & 1) + ((S >>> c) & 1);
    const o = ((O >>> a) & 1) + ((O >>> b) & 1) + ((O >>> c) & 1);
    if (o === 0) {
      if (s === 1) score += W_OPEN1;
      else if (s === 2) score += W_OPEN2_S;
    } else if (s === 0) {
      if (o === 1) score -= W_OPEN1;
      else if (o === 2) score -= IS_AXIS[k] ? W_AXIS2_O : W_OPEN2_O;
      else score -= W_CHECKED;
    }
  }
  const occ = S | O;
  score += W_PAIR_S * pairThreats(sl, ns, occ) - W_PAIR_O * pairThreats(ol, no, occ);
  if ((S >>> CENTER) & 1) score += W_CENTER;
  if ((O >>> CENTER) & 1) score -= W_CENTER;
  return score;
}

// ═══════════════════════════════ Search ════════════════════════════════════

const MAXPLY = 8;
const MAXCH = 2304; // max children of one node: 6 pieces × 16 empties × 24 cube moves
const SL: Int8Array[] = [], OL: Int8Array[] = [], TL: Int8Array[] = [];
const O2S: Int32Array[] = [], OLN: Uint8Array[] = [], S1S: Int32Array[] = [];
const CS: Int32Array[] = [], CO: Int32Array[] = [];
const KEYS: Float64Array[] = [];
for (let i = 0; i <= MAXPLY; i++) {
  SL.push(new Int8Array(8)); OL.push(new Int8Array(8)); TL.push(new Int8Array(8));
  O2S.push(new Int32Array(NM)); OLN.push(new Uint8Array(NM)); S1S.push(new Int32Array(128));
  CS.push(new Int32Array(MAXCH)); CO.push(new Int32Array(MAXCH));
  KEYS.push(new Float64Array(MAXCH));
}

let nodes = 0;
let aborted = false;
let deadline = Infinity;
let clock: () => number = () => Date.now();
let turnLimit = 0;
let widthCap = 0;

/** Static score of a child position, from the point of view of its side to move. */
function quickEval(S: number, O: number, sply: number): number {
  const sl = TL[sply], ol = OL[sply + 1];
  return evaluate(S, sl, bitsOf(S, sl), O, ol, bitsOf(O, ol));
}

/**
 * All non-losing whole turns of S (cube moves marked in `oln` leave O a line):
 * children go to CS[sply] (O after the move, to move next) and CO[sply] (S).
 */
function genChildren(S: number, O: number, hS: number, oln: Uint8Array, sply: number): number {
  const o2 = O2S[sply];
  for (let c = 0; c < NM; c++) if (oln[c] === 0) o2[c] = apply(c, O);
  const s1s = S1S[sply];
  let n1 = 0;
  const empty = ~(S | O) & FULL;
  if (hS > 0) {
    for (let e = empty; e !== 0; e &= e - 1) s1s[n1++] = S | (e & -e);
  } else {
    for (let r = S; r !== 0; r &= r - 1) {
      const rest = S ^ (r & -r);
      for (let e = empty; e !== 0; e &= e - 1) s1s[n1++] = rest | (e & -e);
    }
  }
  const cs = CS[sply], co = CO[sply];
  let n = 0;
  for (let k = 0; k < n1; k++) {
    const S1 = s1s[k];
    for (let c = 0; c < NM; c++) {
      if (oln[c] !== 0) continue;
      cs[n] = o2[c];
      co[n] = apply(c, S1);
      n++;
    }
  }
  return n;
}

/**
 * Negamax over whole turns. S is the side to move, hS / hO the pieces in hand.
 * A score of WIN − ply means S mates; a cube move that leaves O a line is
 * never played (it loses at once).
 */
function negamax(
  S: number, O: number, hS: number, hO: number,
  gply: number, sply: number, depth: number, alpha: number, beta: number,
): number {
  if ((++nodes & 1023) === 0 && clock() > deadline) aborted = true;
  if (aborted) return 0;
  const sl = SL[sply], ol = OL[sply];
  const ns = bitsOf(S, sl), no = bitsOf(O, ol);
  const oln = OLN[sply];
  if (lineMoves(ol, no, O, oln) === 0) return sply - WIN; // every cube move leaves O a line
  if (canMate(S, O, hS, oln)) return WIN - sply;
  if (turnLimit > 0 && gply + 1 >= turnLimit) return 0;  // this turn ends the game in a draw
  if (depth <= 0) return evaluate(S, sl, ns, O, ol, no);

  const hS1 = hS > 0 ? hS - 1 : 0;
  const n = genChildren(S, O, hS, oln, sply);
  const cs = CS[sply], co = CO[sply];

  // best-first by a static look (pack score + index, sort numerically)
  const keys = KEYS[sply];
  for (let i = 0; i < n; i++) keys[i] = (3 * WIN + quickEval(cs[i], co[i], sply)) * 4096 + i;
  const order = keys.subarray(0, n);
  order.sort();

  if (depth === 1 && !(turnLimit > 0 && gply + 2 >= turnLimit)) {
    // The children are leaves and their static score is the sort key; only
    // the opponent's mate-in-one can override it. So test that lazily, best
    // candidate first: the first reply-safe child is the best one.
    const nl = OL[sply + 1], noln = OLN[sply + 1];
    for (let r = 0; r < n; r++) {
      if ((++nodes & 1023) === 0 && clock() > deadline) aborted = true;
      if (aborted) return 0;
      const i = order[r] % 4096;
      const cO = co[i];
      lineMoves(nl, bitsOf(cO, nl), cO, noln);
      if (canMate(cs[i], cO, hO, noln)) continue; // that turn lets the opponent mate
      return -(Math.floor(order[r] / 4096) - 3 * WIN);
    }
    return sply + 1 - WIN; // every turn lets the opponent mate
  }

  const lim = depth >= 2 && widthCap > 0 ? Math.min(n, widthCap) : n;
  let best = -INF;
  for (let r = 0; r < lim; r++) {
    const i = order[r] % 4096;
    const v = -negamax(cs[i], co[i], hO, hS1, gply + 1, sply + 1, depth - 1, -beta, -alpha);
    if (aborted) return 0;
    if (v > best) {
      best = v;
      if (v > alpha) { alpha = v; if (alpha >= beta) return best; }
    }
  }
  return best;
}

// ═══════════════════════════════ Threat search ═════════════════════════════

const FT = new Int8Array(8);
/** A forcing turn leaves A a line (check) or two of a centre-axis line with the third cell free (mate threat). */
function forcing(A: number, D: number): boolean {
  if (lineIn(FT, bitsOf(A, FT), A)) return true;
  for (let k = 0; k < 3; k++) {
    const L = AXIS_LINES[k];
    if ((D & L) !== 0) continue;
    const a = A & L;
    if (a !== 0 && (a & (a - 1)) !== 0) return true;
  }
  return false;
}

/**
 * Can A (to move) force mate within k of its own turns, playing only forcing
 * turns? A quiet turn would hand the defender a free move, so it is not tried.
 */
function forceWin(A: number, D: number, hA: number, hD: number, k: number, sply: number): boolean {
  if ((++nodes & 1023) === 0 && clock() > deadline) aborted = true;
  if (aborted) return false;
  const dl = OL[sply], oln = OLN[sply];
  if (lineMoves(dl, bitsOf(D, dl), D, oln) === 0) return false; // A is mated
  if (canMate(A, D, hA, oln)) return true;
  if (k <= 1) return false;
  const n = genChildren(A, D, hA, oln, sply);
  const cs = CS[sply], co = CO[sply];
  const hA1 = hA > 0 ? hA - 1 : 0;
  for (let i = 0; i < n; i++) {
    if (!forcing(co[i], cs[i])) continue;
    if (!defends(cs[i], co[i], hD, hA1, k, sply + 1)) return true;
    if (aborted) return false;
  }
  return false;
}

/** D to move after A's forcing turn: is there a reply after which A cannot force mate within k − 1 turns? */
function defends(D: number, A: number, hD: number, hA: number, k: number, sply: number): boolean {
  if (aborted) return true;
  const al = OL[sply], oln = OLN[sply];
  if (lineMoves(al, bitsOf(A, al), A, oln) === 0) return false; // D is mated
  if (canMate(D, A, hD, oln)) return true;                       // D mates first
  const n = genChildren(D, A, hD, oln, sply);
  const cs = CS[sply], co = CO[sply];
  const hD1 = hD > 0 ? hD - 1 : 0;
  // counter-checks and counter-threats first: they often turn the tables
  const keys = KEYS[sply];
  for (let i = 0; i < n; i++) keys[i] = (forcing(co[i], cs[i]) ? 0 : 1) * 4096 + i;
  const order = keys.subarray(0, n);
  order.sort();
  for (let r = 0; r < n; r++) {
    const i = order[r] % 4096;
    if (!forceWin(cs[i], co[i], hA, hD1, k - 1, sply + 1)) return true;
    if (aborted) return true;
  }
  return false;
}

// ═══════════════════════════════ Root ══════════════════════════════════════

const enum Kind { Cont, Check, Mate, Loss, Draw }

interface RootMove {
  step1: Step1Action | null;
  c: number;
  kind: Kind;
  opp: number;        // child position: opponent's mask (side to move)
  mine: number;       // child position: our mask
  hMine: number;      // our pieces in hand after step ①
  blunder: boolean;   // the opponent can mate right after this move
  quiet: number;      // positional score of the child, from our side
  value: number;      // search score (deepest completed iteration)
}

function maskOf(board: readonly Mark[], p: Player): number {
  let m = 0;
  for (let i = 0; i < 27; i++) if (board[i] === p) m |= 1 << i;
  return m;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(a: T[], rng: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
}

const RL = new Int8Array(8);
function rootMoves(S: number, O: number, hS: number, gply: number, step1Done: boolean): RootMove[] {
  const opts: { S1: number; step1: Step1Action | null; h: number }[] = [];
  if (step1Done) {
    opts.push({ S1: S, step1: null, h: hS });
  } else {
    const empty = ~(S | O) & FULL;
    if (hS > 0) {
      for (let p = 0; p < 27; p++) {
        if ((empty >>> p) & 1) opts.push({ S1: S | (1 << p), step1: { kind: 'place', index: p }, h: hS - 1 });
      }
    } else {
      for (let q = 0; q < 27; q++) {
        if (!((S >>> q) & 1)) continue;
        for (let p = 0; p < 27; p++) {
          if ((empty >>> p) & 1) {
            opts.push({ S1: (S & ~(1 << q)) | (1 << p), step1: { kind: 'move', from: q, to: p }, h: 0 });
          }
        }
      }
    }
  }
  const oln = new Uint8Array(NM);
  lineMoves(RL, bitsOf(O, RL), O, oln);
  const limitHit = turnLimit > 0 && gply + 1 >= turnLimit;
  const out: RootMove[] = [];
  const base = { blunder: false, quiet: 0, value: 0 };
  for (const o of opts) {
    for (let c = 0; c < NM; c++) {
      const mine = apply(c, o.S1), opp = apply(c, O);
      let kind: Kind;
      if (oln[c] !== 0) kind = Kind.Loss;
      else if (lineIn(RL, bitsOf(mine, RL), mine)) kind = unbreakable(mine) ? Kind.Mate : limitHit ? Kind.Draw : Kind.Check;
      else kind = limitHit ? Kind.Draw : Kind.Cont;
      const value = kind === Kind.Mate ? WIN : kind === Kind.Loss ? -WIN : 0;
      out.push({ ...base, step1: o.step1, c, kind, opp, mine, hMine: o.h, value });
    }
  }
  return out;
}

function pick<T>(list: T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)];
}

function keep(list: RootMove[], pred: (m: RootMove) => boolean): RootMove[] {
  const f = list.filter(pred);
  return f.length > 0 ? f : list;
}

const live = (m: RootMove): boolean => m.kind === Kind.Cont || m.kind === Kind.Check;

/** Depth-0 levels: judge this turn only, with level-dependent care and noise. */
function choosePlain(roots: RootMove[], P: LevelParams, rng: () => number, checked: boolean): RootMove {
  const mates = roots.filter(m => m.kind === Kind.Mate);
  if (mates.length > 0 && rng() < P.pMate) return pick(mates, rng);
  let cand = roots;
  if (rng() < (checked ? P.pEscape : P.pAvoidSelf)) cand = keep(cand, m => m.kind !== Kind.Loss);
  if (rng() < P.pAvoidMate) cand = keep(cand, m => !m.blunder);
  if (rng() < P.pCheck) cand = keep(cand, m => m.kind === Kind.Check);
  let best = cand[0];
  let bestScore = -Infinity;
  for (const m of cand) {
    const s = (live(m) ? m.quiet : 0) + (rng() * 2 - 1) * P.noise;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/** Search levels: iterative deepening, random pick among near-best moves. */
function chooseSearch(
  roots: RootMove[], P: LevelParams, rng: () => number, gply: number, hOpp: number, maxDepth: number,
  threatAt: number,
): { move: RootMove; depth: number } {
  const mates = roots.filter(m => m.kind === Kind.Mate);
  if (mates.length > 0) return { move: pick(mates, rng), depth: 1 };

  const safe = roots.filter(m => live(m) && !m.blunder);
  for (const m of safe) m.value = m.quiet;
  shuffle(safe, rng);
  safe.sort((a, b) => b.value - a.value);
  let pool = safe;
  let depthDone = 1;

  for (let d = 2; d <= maxDepth && safe.length > 0; d++) {
    const list = d >= 3 && P.rootCap > 0 ? safe.slice(0, P.rootCap) : safe.slice();
    widthCap = d >= 3 ? P.replyCap : 0;
    const fresh: { m: RootMove; v: number }[] = [];
    let best = -INF;
    for (const m of list) {
      const alpha = best === -INF ? -INF : best - P.margin - 1;
      const v = -negamax(m.opp, m.mine, hOpp, m.hMine, gply + 1, 1, d - 1, -INF, -alpha);
      if (aborted) break;
      fresh.push({ m, v });
      if (v > best) best = v;
    }
    if (aborted) {
      // keep a partial iteration only if it re-examined the previous best move
      if (fresh.length > 0 && fresh[0].m === list[0]) {
        for (const f of fresh) f.m.value = f.v;
        pool = fresh.map(f => f.m);
        depthDone = d;
      }
      break;
    }
    for (const f of fresh) f.m.value = f.v;
    list.sort((a, b) => b.value - a.value);
    pool = list;
    depthDone = d;
    // the rest of `safe` keeps its shallower scores; reorder for the next pass
    safe.sort((a, b) => b.value - a.value);
    if (best >= WIN - MAXPLY) break; // forced mate found
  }

  if ((P.attack > 0 || P.defence > 0) && pool.length > 0) {
    // the main search had its share of the time; the threat search gets the rest
    aborted = false;
    deadline = threatAt;
    const ranked = pool.slice().sort((a, b) => b.value - a.value);
    if (ranked[0].value < WIN - MAXPLY) {
      // attack: a forcing turn that no reply answers
      if (P.attack > 0) {
        for (const m of ranked) {
          if (!forcing(m.mine, m.opp)) continue;
          const held = defends(m.opp, m.mine, hOpp, m.hMine, P.attack, 1);
          if (aborted) break;
          if (!held) return { move: m, depth: depthDone };
        }
      }
      // defence: the best move after which the opponent has no forced mate
      if (P.defence > 0) {
        aborted = false;
        for (const m of ranked.slice(0, 8)) {
          const lost = forceWin(m.opp, m.mine, hOpp, m.hMine, P.defence, 1);
          if (aborted) break;
          if (!lost) return { move: m, depth: depthDone };
        }
      }
    }
    aborted = false;
  }

  if (pool.length > 0) {
    let top = -INF;
    for (const m of pool) if (m.value > top) top = m.value;
    const draws = roots.filter(m => m.kind === Kind.Draw);
    // a certain loss: settle for a draw on the board if there is one
    if (top <= -(WIN - MAXPLY) && draws.length > 0) return { move: pick(draws, rng), depth: depthDone };
    const near = pool.filter(m => m.value >= top - P.margin);
    return { move: pick(near, rng), depth: depthDone };
  }
  // every move loses: prefer a draw, then a move the opponent must still find
  const fallback = roots.slice().sort((a, b) => rank(b) - rank(a));
  return { move: fallback[0], depth: depthDone };
}

function rank(m: RootMove): number {
  if (m.kind === Kind.Mate) return 4;
  if (m.kind === Kind.Draw) return 3;
  if (live(m)) return 1 + m.quiet / (10 * WIN); // allows a mate: still better than losing now
  return 0;
}

/**
 * The parameters for this one move: the first player's overrides, then
 * うっかり — with chance slip1 (slip2) the CPU reads only 1 (2) turns ahead
 * and skips the threat search. `u` is a uniform draw in [0, 1).
 */
function levelFor(base: LevelParams, first: boolean, u: number): LevelParams {
  const P = first && base.asFirst ? { ...base, ...base.asFirst } : base;
  if (P.depth === 0) return P;
  if (u < P.slip1) return { ...P, depth: 1, attack: 0, defence: 0 };
  if (u < P.slip1 + P.slip2) return { ...P, depth: Math.min(P.depth, 2), attack: 0, defence: 0 };
  return P;
}

/** Choose the CPU's whole turn (or only its cube move, see `step1Done`). */
export function chooseMove(state: GameState, level: CpuLevel, opts: AiOptions = {}): AiDecision {
  clock = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const t0 = clock();
  const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 4294967296));
  const base = LEVEL_PARAMS[level];
  const P = levelFor(base, state.ply % 2 === 0, base.depth > 0 && opts.noSlip !== true ? rng() : 1);
  const me = state.current;
  const op: Player = me === 'O' ? 'X' : 'O';
  const S = maskOf(state.board, me), O = maskOf(state.board, op);
  turnLimit = state.settings.turnLimit ?? 0;
  nodes = 0;
  aborted = false;
  widthCap = 0;
  const budget = opts.timeMs ?? P.timeMs;
  deadline = budget > 0 ? t0 + budget : Infinity;
  // with a threat search, the main search leaves 40 % of the time for it
  const threatAt = deadline;
  if ((P.attack > 0 || P.defence > 0) && budget > 0) deadline = t0 + budget * 0.6;

  const roots = rootMoves(S, O, state.hand[me], state.ply, opts.step1Done === true);
  const hOpp = state.hand[op];
  // one-turn look for every continuing move: can the opponent mate at once?
  const ol = SL[1], ml = OL[1];
  const oln = OLN[1];
  for (const m of roots) {
    if (!live(m)) continue;
    const no = bitsOf(m.opp, ol), nm = bitsOf(m.mine, ml);
    m.blunder = lineMoves(ml, nm, m.mine, oln) === 0 || canMate(m.opp, m.mine, hOpp, oln);
    m.quiet = -evaluate(m.opp, ol, no, m.mine, ml, nm);
  }

  let chosen: RootMove;
  let depth = 0;
  if (P.depth === 0) {
    const checked = lineIn(ml, bitsOf(O, ml), O);
    chosen = choosePlain(roots, P, rng, checked);
  } else {
    // the first two plies hold too few pieces for any mate: reading deeper only costs time
    const depthCap = state.ply <= 1 ? 2 : P.depth;
    const r = chooseSearch(roots, P, rng, state.ply, hOpp, Math.min(depthCap, opts.maxDepth ?? P.depth), threatAt);
    chosen = r.move;
    depth = r.depth;
  }
  return {
    step1: chosen.step1,
    cube: MOVES[chosen.c],
    info: { depth, nodes, ms: Math.round(clock() - t0), score: live(chosen) ? chosen.value : chosen.kind === Kind.Mate ? WIN : chosen.kind === Kind.Loss ? -WIN : 0 },
  };
}

/** Exact test used by tests and hints: can the side to move deliver mate this turn? */
export function hasMateInOne(state: GameState): boolean {
  const me = state.current;
  const op: Player = me === 'O' ? 'X' : 'O';
  const S = maskOf(state.board, me), O = maskOf(state.board, op);
  const l = new Int8Array(8), oln = new Uint8Array(NM);
  if (lineMoves(l, bitsOf(O, l), O, oln) === 0) return false;
  return canMate(S, O, state.hand[me], oln);
}

