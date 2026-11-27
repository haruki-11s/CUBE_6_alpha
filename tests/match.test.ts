import { describe, it, expect } from 'vitest';
import { Match, JOIN_GRACE_MS, LAG_GRACE_MS, SHOW_MS, START_DELAY_MS, type Send } from '../src/core/match';
import { MATE_REVIEW_MS, ONLINE_CLOCK, RECONNECT_MS } from '../src/core/online';
import { parseCubeMove, parseGameIn, parseLobbyIn, parseStep1 } from '../src/core/protocol';
import { initialGameState, toIndex } from '../src/core/board';
import { applyStep1Place, breakingMoves } from '../src/core/rules';
import type { CubeMove, Mark, Step1Action } from '../src/core/types';

const T0 = 1_000_000;
/** The clock of the first move starts after the countdown. */
const T1 = T0 + START_DELAY_MS;
const seats = { O: { id: 'pO', name: 'PLAYER-00001' }, X: { id: 'pX', name: 'PLAYER-00002' } };
const SLIDE: CubeMove = { kind: 'slide', axis: 'X', dir: 'forward' };
const rot = (axis: 'X' | 'Y' | 'Z', layer: 0 | 1 | 2, dir: 'CW' | 'CCW'): CubeMove => ({ kind: 'rotate', axis, layer, dir });
const place = (index: number): Step1Action => ({ kind: 'place', index });

function started(kind: 'random' | 'code' = 'random'): Match {
  const m = Match.create({ room: 'r1', kind, code: kind === 'code' ? '123456' : null, seats, now: T0 });
  m.back('O', T0 + 100);
  m.back('X', T0 + 200);
  return m;
}
const of = (out: Send[], t: string): Send[] => out.filter(s => s.msg.t === t);
const empty = (m: Match): number => m.d.state.board.findIndex(c => c === null);

/** 〇 has two of the centre axis (1,1,z): placing the third is 詰み, as no cube move breaks it. */
function mateReady(): Match {
  const m = started();
  const b: Mark[] = Array(27).fill(null);
  b[toIndex(1, 1, 0)] = 'O';
  b[toIndex(1, 1, 1)] = 'O';
  b[toIndex(0, 0, 0)] = 'X';
  b[toIndex(2, 2, 2)] = 'X';
  m.d.state = { ...initialGameState(), board: b, hand: { O: 4, X: 4 }, ply: 4 };
  return m;
}
const mateTurn = (m: Match, now: number): Send[] => m.turn('O', 4, place(toIndex(1, 1, 2)), rot('Y', 0, 'CW'), now);

describe('online game (server rules)', () => {
  it('starts with 〇 to move after the countdown, both clocks full', () => {
    const m = started();
    const s = m.snapshot('X', T0 + 1000);
    expect(s).toMatchObject({ t: 'state', me: 'X', opponent: 'PLAYER-00001', phase: 'play', turns: [], drop: null });
    expect(s.startIn).toBe(START_DELAY_MS - 1000);
    // during the countdown the clock has not started: a negative "used"
    expect(s.clock).toEqual({ left: { O: ONLINE_CLOCK.mainMs, X: ONLINE_CLOCK.mainMs }, used: -(START_DELAY_MS - 1000) });
  });

  it('checks a turn, plays it, tells both players and charges the clock', () => {
    const m = started();
    const out = m.turn('O', 0, place(13), SLIDE, T1 + 5000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ to: 'both', msg: { t: 'turn', by: 'O', ply: 0, step1: place(13), cube: SLIDE, review: null } });
    // ×'s clock starts once the move has been shown
    expect(out[0].msg).toMatchObject({ clock: { left: { O: ONLINE_CLOCK.mainMs - 5000, X: ONLINE_CLOCK.mainMs }, used: -SHOW_MS } });
    expect(m.d.state.current).toBe('X');
    expect(m.snapshot('O', T1 + 7000).clock.used).toBe(2000 - SHOW_MS);
    expect(m.snapshot('O', T1 + 9000).clock.used).toBe(4000 - SHOW_MS);
  });

  it('counts a turn played while the last move is still shown as taking no time', () => {
    const m = started();
    m.turn('O', 0, place(13), SLIDE, T1);
    m.turn('X', 1, place(empty(m)), SLIDE, T1 + 1000);
    expect(m.d.left.X).toBe(ONLINE_CLOCK.mainMs);
  });

  it('refuses a turn out of order or against the rules, and sends the whole game back', () => {
    const m = started();
    expect(m.turn('X', 0, place(0), SLIDE, T1)[0]).toMatchObject({ to: 'X', msg: { t: 'state' } });
    expect(m.turn('O', 1, place(0), SLIDE, T1)[0].msg.t).toBe('state');
    m.turn('O', 0, place(13), SLIDE, T1);
    const taken = m.d.state.board.findIndex(c => c !== null);
    expect(m.turn('X', 1, place(taken), SLIDE, T1 + 10)[0].msg.t).toBe('state');
    // X still has pieces in hand, so it cannot move one (and that piece is 〇's)
    expect(m.turn('X', 1, { kind: 'move', from: taken, to: empty(m) }, SLIDE, T1 + 10)[0].msg.t).toBe('state');
    expect(m.d.turns).toHaveLength(1);
  });

  it('秒読み: with the main time gone a turn has 30 s, plus a little for the network', () => {
    const m = started();
    m.d.left.O = 0;
    const t1 = T1 + ONLINE_CLOCK.byoyomiMs + LAG_GRACE_MS - 1;
    expect(m.turn('O', 0, place(0), SLIDE, t1)[0].msg.t).toBe('turn');
    m.d.left.X = 0;
    const late = m.turn('X', 1, place(empty(m)), SLIDE, t1 + SHOW_MS + ONLINE_CLOCK.byoyomiMs + LAG_GRACE_MS + 1);
    expect(late).toEqual([{ to: 'both', msg: { t: 'end', winner: 'O', reason: 'timeout', clock: { left: { O: 0, X: 0 }, used: 0 } } }]);
  });

  it('runs out the clock on its own, and reports the result once', () => {
    const m = started();
    const deadline = T1 + ONLINE_CLOCK.mainMs + ONLINE_CLOCK.byoyomiMs + LAG_GRACE_MS;
    expect(m.nextDeadline()).toBe(deadline);
    expect(m.tick(deadline - 1)).toEqual([]);
    expect(m.tick(deadline)[0].msg).toMatchObject({ t: 'end', winner: 'X', reason: 'timeout' });
    expect(m.takeReport()).toMatchObject({ kind: 'random', winner: 'X', reason: 'timeout', plies: 0, game: 1 });
    expect(m.takeReport()).toBeNull();
  });

  it('降参 ends the game; leaving a game in progress is 降参', () => {
    expect(started().resign('X', T1 + 1000)[0].msg).toMatchObject({ t: 'end', winner: 'O', reason: 'resign' });
    const m = started();
    const out = m.leave('O', T1 + 1000);
    expect(of(out, 'end')[0].msg).toMatchObject({ winner: 'X', reason: 'resign' });
    expect(of(out, 'left')).toEqual([{ to: 'X', msg: { t: 'left' } }]);
  });

  it('詰み waits while the mated player may check the board (30 s), then is final', () => {
    const m = mateReady();
    const out = mateTurn(m, T1 + 2000);
    expect(out).toHaveLength(1);
    expect(out[0].msg).toMatchObject({ t: 'turn', by: 'O', review: MATE_REVIEW_MS });
    expect(m.d.phase).toBe('review');
    expect(m.snapshot('X', T1 + 12_000).review).toBe(MATE_REVIEW_MS - 10_000);
    expect(m.takeReport()).toBeNull();
    expect(m.tick(T1 + 2000 + MATE_REVIEW_MS - 1)).toEqual([]);
    expect(m.tick(T1 + 2000 + MATE_REVIEW_MS)[0].msg).toMatchObject({ t: 'end', winner: 'O', reason: 'mate' });
  });

  it('the mated player can end the wait early (and only they can)', () => {
    const m = mateReady();
    mateTurn(m, T1);
    expect(m.accept('O', T1 + 10)).toEqual([]);
    expect(m.accept('X', T1 + 10)[0].msg).toMatchObject({ t: 'end', winner: 'O', reason: 'mate' });
  });

  it('誤審の訂正: the mated player plays the turn, which ends like any other', () => {
    const m = mateReady();
    mateTurn(m, T1);
    expect(m.playOn('O', T1 + 5000)[0].msg.t).toBe('state');
    expect(m.playOn('X', T1 + 5000)[0]).toMatchObject({ to: 'both', msg: { t: 'playOn' } });
    expect(m.d.phase).toBe('play');
    const out = m.turn('X', 5, place(empty(m)), SLIDE, T1 + 9000);
    expect(of(out, 'end')[0].msg).toMatchObject({ winner: 'O', reason: 'notBroken' });
    expect(m.takeJudgeReport()).toBeNull();
  });

  it('refuses 誤審の訂正 once the 30 s are over', () => {
    const m = mateReady();
    mateTurn(m, T1);
    expect(m.playOn('X', T1 + MATE_REVIEW_MS + LAG_GRACE_MS + 1)[0].msg.t).toBe('state');
  });

  it('keeps the position when 誤審の訂正 breaks a 詰み (the judge was wrong)', () => {
    const m = started();
    const b: Mark[] = Array(27).fill(null);
    b[toIndex(0, 0, 0)] = 'O';
    b[toIndex(1, 0, 0)] = 'O';
    b[toIndex(2, 0, 0)] = 'O';
    b[toIndex(2, 2, 2)] = 'X';
    // an ordinary edge line, called 詰み by mistake
    m.d.state = { ...initialGameState(), board: b, current: 'X', hand: { O: 3, X: 5 }, ply: 3, status: 'win:O', winReason: 'mate' };
    m.d.phase = 'review';
    m.d.reviewUntil = T1 + MATE_REVIEW_MS;
    m.d.turnStart = 0;
    m.playOn('X', T1 + 1000);
    const step1 = place(toIndex(1, 1, 1));
    const cube = breakingMoves(applyStep1Place(m.d.state, toIndex(1, 1, 1)).board, 'O')[0];
    const out = m.turn('X', 3, step1, cube, T1 + 2000);
    expect(out).toHaveLength(1);
    expect(m.d.state.status).toBe('playing');
    expect(m.takeJudgeReport()).toMatchObject({ room: 'r1', game: 1, ply: 3, board: b, turn: { step1, cube } });
  });

  it('gives a dropped player 60 s to come back, with the clock running', () => {
    const m = started();
    expect(m.drop('X', T1 + 1000)).toEqual([{ to: 'O', msg: { t: 'drop', who: 'X', ms: RECONNECT_MS } }]);
    expect(m.snapshot('O', T1 + 11_000).drop).toBe(RECONNECT_MS - 10_000);
    const back = m.back('X', T1 + 20_000);
    expect(back[0]).toMatchObject({ to: 'X', msg: { t: 'state', me: 'X' } });
    expect(back[1]).toEqual({ to: 'O', msg: { t: 'back', who: 'X' } });
    expect(m.tick(T1 + 1000 + RECONNECT_MS)).toEqual([]);
    expect(m.snapshot('O', T1 + 21_000).clock.used).toBe(21_000);
  });

  it('a player who does not come back in time loses', () => {
    const m = started();
    m.drop('X', T1 + 1000);
    const out = m.tick(T1 + 1000 + RECONNECT_MS);
    expect(of(out, 'end')[0].msg).toMatchObject({ winner: 'O', reason: 'disconnect' });
    expect(of(out, 'left')).toEqual([{ to: 'O', msg: { t: 'left' } }]);
  });

  it('reports a player who never arrives after a short wait; they lose after 60 s', () => {
    const m = Match.create({ room: 'r1', kind: 'random', code: null, seats, now: T0 });
    m.back('O', T0 + 100);
    expect(m.tick(T0 + JOIN_GRACE_MS)).toEqual([{ to: 'O', msg: { t: 'drop', who: 'X', ms: RECONNECT_MS - JOIN_GRACE_MS } }]);
    expect(of(m.tick(T0 + RECONNECT_MS), 'end')[0].msg).toMatchObject({ winner: 'O', reason: 'disconnect' });
  });

  it('calls a game off without a winner when nobody arrives', () => {
    const m = Match.create({ room: 'r1', kind: 'random', code: null, seats, now: T0 });
    expect(of(m.tick(T0 + RECONNECT_MS), 'end')[0].msg).toMatchObject({ winner: null, reason: 'disconnect' });
  });

  it('合言葉: a rematch once both ask, with the turn order changing hands', () => {
    const m = started('code');
    m.resign('X', T1);
    m.takeReport();
    expect(m.rematch('O', T1 + 100)).toEqual([{ to: 'X', msg: { t: 'rematch' } }]);
    expect(m.rematch('X', T1 + 200)).toEqual([
      { to: 'O', msg: { t: 'match', room: 'r1', me: 'O', opponent: 'PLAYER-00001', kind: 'code', code: '123456' } },
      { to: 'X', msg: { t: 'match', room: 'r1', me: 'X', opponent: 'PLAYER-00002', kind: 'code', code: '123456' } },
    ]);
    expect(m.sideOf('pO')).toBe('X');
    expect(m.d).toMatchObject({ game: 2, phase: 'play', turns: [], result: null, reported: false });
    expect(m.snapshot('O', T1 + 1200).startIn).toBe(START_DELAY_MS - 1000);
  });

  it('forgets a rematch request once the player stops waiting', () => {
    const m = started('code');
    m.resign('X', T1);
    m.rematch('O', T1 + 100);
    m.withdraw('O');
    expect(m.rematch('X', T1 + 200)).toEqual([{ to: 'O', msg: { t: 'rematch' } }]);
    expect(m.d.game).toBe(1);
  });

  it('has no rematch for random matches, nor with a player who has left', () => {
    const r = started('random');
    r.resign('X', T1);
    expect(r.rematch('O', T1 + 1)).toEqual([]);
    const m = started('code');
    m.resign('X', T1);
    expect(m.leave('X', T1 + 10)).toEqual([{ to: 'O', msg: { t: 'left' } }]);
    expect(m.rematch('O', T1 + 20)).toEqual([{ to: 'O', msg: { t: 'left' } }]);
    expect(m.closed(T1 + 30)).toBe(false); // the result is not recorded yet
    m.takeReport();
    m.leave('O', T1 + 40);
    expect(m.closed(T1 + 50)).toBe(true);
  });
});

describe('online messages', () => {
  const rotX: CubeMove = { kind: 'rotate', axis: 'X', layer: 1, dir: 'CW' };
  it('accepts well-formed messages only', () => {
    const turn = { t: 'turn', ply: 3, step1: { kind: 'place', index: 5 }, cube: rotX };
    expect(parseGameIn(JSON.stringify(turn))).toEqual(turn);
    expect(parseGameIn(JSON.stringify({ ...turn, step1: { kind: 'place', index: 27 } }))).toBeNull();
    expect(parseGameIn(JSON.stringify({ ...turn, ply: -1 }))).toBeNull();
    expect(parseGameIn(JSON.stringify({ t: 'resign', extra: 'x' }))).toEqual({ t: 'resign' });
    expect(parseGameIn(JSON.stringify({ t: 'resign', pad: 'x'.repeat(600) }))).toBeNull();
    expect(parseGameIn('[1,2]')).toBeNull();
    expect(parseGameIn('{"t":"hack"}')).toBeNull();
    expect(parseLobbyIn('{"t":"join","code":"123456"}')).toEqual({ t: 'join', code: '123456' });
    expect(parseLobbyIn('{"t":"join","code":"12345"}')).toBeNull();
  });

  it('rebuilds moves from the known lists, so nothing else rides along', () => {
    expect(parseCubeMove({ kind: 'slide', axis: 'Y', dir: 'backward', layer: 9, x: 1 })).toEqual({ kind: 'slide', axis: 'Y', dir: 'backward' });
    expect(parseCubeMove({ kind: 'rotate', axis: 'Y', layer: 3, dir: 'CW' })).toBeNull();
    expect(parseStep1({ kind: 'move', from: 3, to: 3 })).toBeNull();
    expect(parseStep1({ kind: 'move', from: 3, to: 4, more: true })).toEqual({ kind: 'move', from: 3, to: 4 });
  });
});
