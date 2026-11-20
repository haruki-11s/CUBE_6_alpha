export type Mark = 'O' | 'X' | null;
export type Player = 'O' | 'X';
export type Axis = 'X' | 'Y' | 'Z';
export type Layer = 0 | 1 | 2;

export type CubeMove =
  | { kind: 'rotate'; axis: Axis; layer: Layer; dir: 'CW' | 'CCW' }
  | { kind: 'slide';  axis: Axis; dir: 'forward' | 'backward' };

export type GameStatus = 'playing' | 'win:O' | 'win:X' | 'draw';
export type WinReason = 'line' | 'selfDestruct' | 'simultaneous' | 'turnLimit';

export interface GameState {
  board: Mark[];
  current: Player;
  hand: { O: number; X: number };
  lastCubeMove: CubeMove | null;
  status: GameStatus;
  winReason?: WinReason;
  ply: number;
  settings: { turnLimit: number | null };
}

/** Step ① of a turn: place a new piece or move one of your own pieces. */
export type Step1Action =
  | { kind: 'place'; index: number }
  | { kind: 'move'; from: number; to: number };
