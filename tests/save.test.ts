import { describe, it, expect } from 'vitest';
import { parseSave, isGameState, type SaveData } from '../src/core/save';
import { initialGameState } from '../src/core/board';
import { applyStep1Place } from '../src/core/rules';
import type { GameState } from '../src/core/types';

function sample(): SaveData {
  const gs = applyStep1Place(initialGameState(), 4);
  return {
    v: 2,
    gameState: gs,
    phase: 'step2',
    selectedFrom: null,
    lastMoved: 4,
    log: [{ ply: 1, player: 'O', step1: { kind: 'place', index: 4 }, cube: null }],
    history: [{ gameState: initialGameState(), phase: 'step1', selectedFrom: null, lastMoved: null, log: [] }],
    elapsed: 1234,
    match: {
      mode: 'cpu', level: 4, human: 'O', undos: 2,
      clock: { mainMs: 180_000, byoyomiMs: 30_000, left: { O: 120_000, X: 175_500 }, used: 4200 },
    },
  };
}

describe('parseSave', () => {
  it('round-trips a valid save', () => {
    const data = sample();
    const parsed = parseSave(JSON.parse(JSON.stringify(data)));
    expect(parsed).toEqual(data);
  });

  it('rejects garbage', () => {
    expect(parseSave(null)).toBeNull();
    expect(parseSave('x')).toBeNull();
    expect(parseSave({ gameState: { board: [] } })).toBeNull();
  });

  it('rejects inconsistent hands', () => {
    const data = sample();
    data.gameState = { ...data.gameState, hand: { O: 6, X: 6 } }; // one O already on board
    expect(parseSave(JSON.parse(JSON.stringify(data)))).toBeNull();
  });

  it('rejects finished games', () => {
    const data = sample();
    data.gameState = { ...data.gameState, status: 'win:O', winReason: 'mate' };
    expect(parseSave(JSON.parse(JSON.stringify(data)))).toBeNull();
  });

  it('drops invalid history / log entries but keeps the game', () => {
    const raw = JSON.parse(JSON.stringify(sample()));
    raw.history.push({ nope: true });
    raw.log.push({ ply: 'bad' });
    const parsed = parseSave(raw);
    expect(parsed?.history).toHaveLength(1);
    expect(parsed?.log).toHaveLength(1);
  });

  it('migrates legacy (v1) saves: Y-axis rotation names are flipped', () => {
    const gs: GameState = {
      ...applyStep1Place(initialGameState(), 0),
      lastCubeMove: { kind: 'rotate', axis: 'Y', layer: 1, dir: 'CW' },
    };
    const parsed = parseSave({ gameState: gs, phase: 'step2', selectedFrom: null });
    expect(parsed?.gameState.lastCubeMove).toEqual({ kind: 'rotate', axis: 'Y', layer: 1, dir: 'CCW' });
    expect(parsed?.history).toEqual([]);
    expect(parsed?.log).toEqual([]);
  });

  it('treats saves without match info as local games and rejects bad CPU levels', () => {
    const raw = JSON.parse(JSON.stringify(sample()));
    delete raw.match;
    expect(parseSave(raw)?.match).toEqual({ mode: 'local', undos: 0 });
    raw.match = { mode: 'cpu', level: 9, human: 'O', undos: 0 };
    expect(parseSave(raw)?.match.mode).toBe('local');
    raw.match = { mode: 'cpu', level: 6, human: 'X', undos: -3 };
    expect(parseSave(raw)?.match).toEqual({ mode: 'cpu', level: 6, human: 'X', undos: 0, clock: null });
    raw.match = { mode: 'cpu', level: 3, human: 'O', undos: 0, clock: { mainMs: 180_000, byoyomiMs: 0, left: { O: 1, X: 1 }, used: 0 } };
    expect(parseSave(raw)?.match).toEqual({ mode: 'cpu', level: 3, human: 'O', undos: 0, clock: null }); // broken clock dropped
  });

  it('clears selectedFrom when it does not point at the current player', () => {
    const raw = JSON.parse(JSON.stringify(sample()));
    raw.phase = 'step1-move-from';
    raw.selectedFrom = 10; // empty cell
    const parsed = parseSave(raw);
    expect(parsed?.selectedFrom).toBeNull();
    expect(parsed?.phase).toBe('step1');
  });
});

describe('isGameState', () => {
  it('accepts the initial state', () => {
    expect(isGameState(initialGameState())).toBe(true);
  });
});
