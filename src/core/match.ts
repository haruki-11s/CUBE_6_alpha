/*
 * An online game as the server runs it. Pure: no sockets, storage or timers. The server
 * passes in what the players send and the time, and gets back the messages to send and,
 * once a result is final, what to record. Development builds run the same code in the
 * page, as a stand-in for the server.
 *
 * The rules (docs/online-design.md §2, kept locally):
 *  - 〇 moves first. Each player has 3 minutes, then 30 s 秒読み per turn. The server's
 *    clock decides; a turn that arrives up to LAG_GRACE_MS late still counts (the network).
 *  - 詰み: the mated player has 30 s to check the board and may challenge the call
 *    (誤審の訂正). They then play their turn, which ends like any other.
 *  - 降参 ends the game. Leaving a game in progress is 降参.
 *  - A dropped connection has 60 s to come back; meanwhile the clock keeps running.
 */
import type { GameState, Player, Step1Action, CubeMove, WinReason } from './types';
import { initialGameState } from './board';
import { applyStep1Move, applyStep1Place, legalMoves, legalPlacements, resolveAfterCubeMove } from './rules';
import { mainAfterTurn } from './clock';
import { MATE_REVIEW_MS, ONLINE_CLOCK, RECONNECT_MS } from './online';
import type { ClockSync, GameSnapshot, GameOut, MatchEnd, MatchKind, MatchMsg, Turn } from './protocol';

/** A turn that arrives this long after its deadline still counts: it was sent in time. */
export const LAG_GRACE_MS = 1500;
/**
 * After a turn, the next player's clock starts this much later: the game first shows the
 * move (the piece, then the cube turning), as the clock waits for the CPU's move in CPU games.
 */
export const SHOW_MS = 2500;
/** The countdown before the first move (the game shows "starts in 3"). */
export const START_DELAY_MS = 3000;
/** A player who has not connected yet is reported as missing only after this long. */
export const JOIN_GRACE_MS = 8000;
/** A finished room closes this long after its last game ended. */
export const ROOM_IDLE_MS = 30 * 60_000;

const other = (p: Player): Player => (p === 'O' ? 'X' : 'O');
const SIDES: readonly Player[] = ['O', 'X'];

export interface Seat { id: string; name: string }

/** Everything a room keeps, as plain data (stored as it is). */
export interface MatchData {
  v: 1;
  room: string;
  kind: MatchKind;
  code: string | null;
  seats: Record<Player, Seat>;
  /** 1 for the first game in the room, 2 for the first rematch, … */
  game: number;
  state: GameState;
  turns: Turn[];
  /** Main time left. */
  left: Record<Player, number>;
  /** When the player to move started their turn (0: no clock running). Can be ahead (the countdown). */
  turnStart: number;
  phase: 'play' | 'review' | 'over';
  reviewUntil: number;
  result: MatchEnd | null;
  /** The mated player challenged the call and is playing that turn. */
  challenged: boolean;
  /** When a dropped player loses (0: connected). */
  dropUntil: Record<Player, number>;
  /** Has connected at least once. */
  joined: Record<Player, boolean>;
  /** The other player was told that this one has not arrived yet. */
  waitNotice: Record<Player, boolean>;
  /** Left the room for good (no rematch). */
  gone: Record<Player, boolean>;
  rematch: Record<Player, boolean>;
  createdAt: number;
  startedAt: number;
  endedAt: number;
  /** The final result was handed out for recording. */
  reported: boolean;
}

/** A message to one side or both. */
export interface Send { to: Player | 'both'; msg: GameOut }

/** A finished game, to record (and to count for the rankings). */
export interface MatchReport {
  room: string;
  game: number;
  kind: MatchKind;
  seats: Record<Player, Seat>;
  winner: Player | null;
  reason: WinReason;
  plies: number;
  startedAt: number;
  endedAt: number;
}

/** 誤審の訂正 broke a 詰み, so the judge was wrong: the position is kept to find the bug. */
export interface JudgeReport { room: string; game: number; ply: number; board: GameState['board']; turn: Turn }

function freshState(): GameState {
  return { ...initialGameState(), current: 'O', settings: { turnLimit: null } };
}

function winnerOf(s: GameState): Player | null {
  return s.status === 'win:O' ? 'O' : s.status === 'win:X' ? 'X' : null;
}

export class Match {
  private bug: JudgeReport | null = null;

  constructor(readonly d: MatchData) {}

  static create(o: { room: string; kind: MatchKind; code: string | null; seats: Record<Player, Seat>; now: number }): Match {
    const start = o.now + START_DELAY_MS;
    return new Match({
      v: 1, room: o.room, kind: o.kind, code: o.code, seats: o.seats, game: 1,
      state: freshState(), turns: [], left: { O: ONLINE_CLOCK.mainMs, X: ONLINE_CLOCK.mainMs },
      turnStart: start, phase: 'play', reviewUntil: 0, result: null, challenged: false,
      // until each player connects, they count as dropped (60 s to arrive)
      dropUntil: { O: o.now + RECONNECT_MS, X: o.now + RECONNECT_MS },
      joined: { O: false, X: false }, waitNotice: { O: false, X: false },
      gone: { O: false, X: false }, rematch: { O: false, X: false },
      createdAt: o.now, startedAt: start, endedAt: 0, reported: false,
    });
  }

  sideOf(playerId: string): Player | null {
    return this.d.seats.O.id === playerId ? 'O' : this.d.seats.X.id === playerId ? 'X' : null;
  }

  /** `used` is negative while the clock has not started yet (the countdown, or a move being shown). */
  clock(now: number): ClockSync {
    const d = this.d;
    return { left: { ...d.left }, used: d.phase === 'play' && d.turnStart ? now - d.turnStart : 0 };
  }

  snapshot(side: Player, now: number): GameSnapshot {
    const d = this.d, opp = other(side);
    const missing = d.dropUntil[opp] > 0 && d.phase !== 'over' && !d.gone[opp]
      && (d.joined[opp] || now >= d.createdAt + JOIN_GRACE_MS);
    return {
      t: 'state', me: side, opponent: d.seats[opp].name, kind: d.kind, code: d.code, game: d.game,
      turns: d.turns.map(x => ({ step1: { ...x.step1 }, cube: { ...x.cube } })),
      ply: d.state.ply,
      phase: d.phase,
      result: d.result ? { ...d.result } : null,
      review: d.phase === 'review' ? Math.max(0, d.reviewUntil - now) : null,
      clock: this.clock(now),
      startIn: d.phase === 'play' && d.turns.length === 0 ? Math.max(0, d.turnStart - now) : 0,
      drop: missing ? Math.max(0, d.dropUntil[opp] - now) : null,
      rematch: d.rematch[opp],
      left: d.gone[opp],
    };
  }

  matchMsg(side: Player): MatchMsg {
    const d = this.d;
    return { t: 'match', room: d.room, me: side, opponent: d.seats[other(side)].name, kind: d.kind, code: d.code };
  }

  // ── What the players send ──

  turn(side: Player, ply: number, step1: Step1Action, cube: CubeMove, now: number): Send[] {
    const d = this.d, g = d.state;
    if (d.phase !== 'play' || g.status !== 'playing' || g.current !== side || ply !== g.ply) return this.resync(side, now);
    let s1: GameState;
    if (step1.kind === 'place') {
      if (!legalPlacements(g).includes(step1.index)) return this.resync(side, now);
      s1 = applyStep1Place(g, step1.index);
    } else {
      if (!legalMoves(g).some(m => m.from === step1.from && m.to === step1.to)) return this.resync(side, now);
      s1 = applyStep1Move(g, step1.from, step1.to);
    }
    const used = Math.max(0, now - d.turnStart);
    if (used > d.left[side] + ONLINE_CLOCK.byoyomiMs + LAG_GRACE_MS) return this.finish(other(side), 'timeout', now);
    d.left[side] = mainAfterTurn(d.left[side], used);
    const next = resolveAfterCubeMove(s1, cube);
    const turn: Turn = { step1, cube };
    if (d.challenged) {
      d.challenged = false;
      // 誤審の訂正 kept the game going: the 詰み call was wrong
      if (next.status === 'playing') this.bug = { room: d.room, game: d.game, ply: g.ply, board: g.board.slice(), turn };
    }
    d.state = next;
    d.turns.push(turn);
    if (next.status === 'playing') {
      d.turnStart = now + SHOW_MS;
    } else if (next.winReason === 'mate') {
      // the result waits while the mated player may check the board
      d.phase = 'review';
      d.reviewUntil = now + MATE_REVIEW_MS;
      d.turnStart = 0;
    }
    const out: Send[] = [{
      to: 'both',
      msg: { t: 'turn', by: side, ply, step1, cube, clock: this.clock(now), review: d.phase === 'review' ? MATE_REVIEW_MS : null },
    }];
    if (next.status !== 'playing' && next.winReason !== 'mate') {
      out.push(...this.finish(winnerOf(next), next.winReason ?? 'notBroken', now));
    }
    return out;
  }

  resign(side: Player, now: number): Send[] {
    const d = this.d;
    if (d.phase === 'play') return this.finish(other(side), 'resign', now);
    // the mated player gives up checking the board
    if (d.phase === 'review' && d.state.current === side) return this.finish(other(side), 'mate', now);
    return [];
  }

  /** 誤審の訂正: the mated player plays their turn after all. */
  playOn(side: Player, now: number): Send[] {
    const d = this.d;
    if (d.phase !== 'review' || d.state.current !== side || now > d.reviewUntil + LAG_GRACE_MS) return this.resync(side, now);
    const s: GameState = { ...d.state, status: 'playing' };
    delete s.winReason;
    d.state = s;
    d.phase = 'play';
    d.reviewUntil = 0;
    d.challenged = true;
    d.turnStart = now;
    return [{ to: 'both', msg: { t: 'playOn', clock: this.clock(now) } }];
  }

  /** The mated player is done checking the board: the result is final. */
  accept(side: Player, now: number): Send[] {
    const d = this.d;
    if (d.phase !== 'review' || d.state.current !== side) return [];
    return this.finish(other(side), 'mate', now);
  }

  /** 合言葉 games: another game with the same opponent once both ask. The turn order changes hands. */
  rematch(side: Player, now: number): Send[] {
    const d = this.d, opp = other(side);
    if (d.phase !== 'over' || d.kind !== 'code') return [];
    if (d.gone[opp]) return [{ to: side, msg: { t: 'left' } }];
    d.rematch[side] = true;
    if (!d.rematch[opp]) return [{ to: opp, msg: { t: 'rematch' } }];
    d.seats = { O: d.seats.X, X: d.seats.O };
    d.game += 1;
    d.state = freshState();
    d.turns = [];
    d.left = { O: ONLINE_CLOCK.mainMs, X: ONLINE_CLOCK.mainMs };
    d.turnStart = now + START_DELAY_MS;
    d.startedAt = d.turnStart;
    d.phase = 'play';
    d.reviewUntil = 0;
    d.result = null;
    d.challenged = false;
    d.rematch = { O: false, X: false };
    d.endedAt = 0;
    d.reported = false;
    return SIDES.map(s => ({ to: s, msg: this.matchMsg(s) }));
  }

  /** The player stopped waiting for a rematch. */
  withdraw(side: Player): Send[] {
    if (this.d.phase === 'over') this.d.rematch[side] = false;
    return [];
  }

  /** Leaving for good (to the title). During a game it is 降参. */
  leave(side: Player, now: number): Send[] {
    const d = this.d;
    if (d.phase === 'play') return [...this.finish(other(side), 'resign', now), ...this.markGone(side)];
    if (d.phase === 'review') {
      if (d.state.current === side) return [...this.finish(other(side), 'mate', now), ...this.markGone(side)];
      // the winner left while the other player checks the board: if the game goes on, they must come back
      d.dropUntil[side] = now + RECONNECT_MS;
    }
    return this.markGone(side);
  }

  // ── Connections ──

  /** A player's connection closed without leaving. */
  drop(side: Player, now: number): Send[] {
    const d = this.d;
    if (d.gone[side] || d.dropUntil[side]) return [];
    d.dropUntil[side] = now + RECONNECT_MS;
    return d.phase === 'over' ? [] : [{ to: other(side), msg: { t: 'drop', who: side, ms: RECONNECT_MS } }];
  }

  /** A player connected (for the first time, or again): they get the whole game. */
  back(side: Player, now: number): Send[] {
    const d = this.d;
    const wasMissing = d.dropUntil[side] > 0;
    // the other player may have been shown them as missing (not before the first short wait)
    const shown = d.joined[side] || d.waitNotice[side] || now >= d.createdAt + JOIN_GRACE_MS;
    d.joined[side] = true;
    d.dropUntil[side] = 0;
    d.gone[side] = false;
    const out: Send[] = [{ to: side, msg: this.snapshot(side, now) }];
    if (wasMissing && shown && d.phase !== 'over') out.push({ to: other(side), msg: { t: 'back', who: side } });
    return out;
  }

  // ── Time ──

  /** Called when a deadline may have passed: the earliest one that has decides. */
  tick(now: number): Send[] {
    const d = this.d;
    const out: Send[] = [];
    if (d.phase === 'play') {
      for (const s of SIDES) {
        if (!d.joined[s] && !d.waitNotice[s] && d.dropUntil[s] && now >= d.createdAt + JOIN_GRACE_MS) {
          d.waitNotice[s] = true;
          if (d.joined[other(s)]) out.push({ to: other(s), msg: { t: 'drop', who: s, ms: Math.max(0, d.dropUntil[s] - now) } });
        }
      }
    }
    for (let guard = 0; guard < 4; guard++) {
      const due = this.dueEvents(now);
      if (!due.length) break;
      out.push(...due[0].run());
    }
    return out;
  }

  /** The deadlines that have passed, earliest first. */
  private dueEvents(now: number): Array<{ at: number; run: () => Send[] }> {
    const d = this.d;
    const ev: Array<{ at: number; run: () => Send[] }> = [];
    if (d.phase === 'play') {
      const mover = d.state.current;
      if (d.turnStart) ev.push({ at: this.timeoutAt(), run: () => this.finish(other(mover), 'timeout', now) });
      for (const s of SIDES) {
        if (!d.dropUntil[s]) continue;
        // nobody ever came: the game is called off without a winner
        const abandoned = !d.joined.O && !d.joined.X;
        ev.push({ at: d.dropUntil[s], run: () => this.finish(abandoned ? null : other(s), 'disconnect', now) });
      }
    } else if (d.phase === 'review') {
      ev.push({ at: d.reviewUntil, run: () => this.finish(other(d.state.current), 'mate', now) });
    } else {
      for (const s of SIDES) {
        if (d.dropUntil[s]) ev.push({ at: d.dropUntil[s], run: () => { d.dropUntil[s] = 0; return this.markGone(s); } });
      }
    }
    return ev.filter(e => e.at <= now).sort((a, b) => a.at - b.at);
  }

  private timeoutAt(): number {
    const d = this.d;
    return d.turnStart + d.left[d.state.current] + ONLINE_CLOCK.byoyomiMs + LAG_GRACE_MS;
  }

  /** When tick() must next be called (null: nothing pending). */
  nextDeadline(): number | null {
    const d = this.d;
    const at: number[] = [];
    if (d.phase === 'play') {
      if (d.turnStart) at.push(this.timeoutAt());
      for (const s of SIDES) {
        if (d.dropUntil[s]) at.push(d.dropUntil[s]);
        if (!d.joined[s] && !d.waitNotice[s]) at.push(d.createdAt + JOIN_GRACE_MS);
      }
    } else if (d.phase === 'review') {
      at.push(d.reviewUntil);
    } else {
      for (const s of SIDES) if (d.dropUntil[s]) at.push(d.dropUntil[s]);
      at.push(d.endedAt + ROOM_IDLE_MS);
    }
    return at.length ? Math.min(...at) : null;
  }

  /** Nothing is left to do: both players have gone, or the room has sat finished for too long. */
  closed(now: number): boolean {
    const d = this.d;
    return d.phase === 'over' && d.reported && ((d.gone.O && d.gone.X) || now >= d.endedAt + ROOM_IDLE_MS);
  }

  /** The final result, once (to record). */
  takeReport(): MatchReport | null {
    const d = this.d;
    if (d.phase !== 'over' || d.reported || !d.result) return null;
    d.reported = true;
    return {
      room: d.room, game: d.game, kind: d.kind, seats: { O: { ...d.seats.O }, X: { ...d.seats.X } },
      winner: d.result.winner, reason: d.result.reason, plies: d.state.ply, startedAt: d.startedAt, endedAt: d.endedAt,
    };
  }

  takeJudgeReport(): JudgeReport | null {
    const b = this.bug;
    this.bug = null;
    return b;
  }

  // ── Inside ──

  private resync(side: Player, now: number): Send[] {
    return [{ to: side, msg: this.snapshot(side, now) }];
  }

  private finish(winner: Player | null, reason: WinReason, now: number): Send[] {
    const d = this.d;
    if (d.phase === 'over') return [];
    if (d.state.status === 'playing') {
      // the game ends without a move (降参, time, a lost connection): that turn's time is spent
      const mover = d.state.current;
      const used = d.turnStart ? Math.max(0, now - d.turnStart) : 0;
      d.left[mover] = reason === 'timeout' ? 0 : mainAfterTurn(d.left[mover], used);
      d.state = { ...d.state, status: winner ? `win:${winner}` : 'draw', winReason: reason };
    }
    d.phase = 'over';
    d.turnStart = 0;
    d.reviewUntil = 0;
    d.challenged = false;
    d.result = { winner, reason };
    d.endedAt = now;
    d.rematch = { O: false, X: false };
    return [{ to: 'both', msg: { t: 'end', winner, reason, clock: this.clock(now) } }];
  }

  private markGone(side: Player): Send[] {
    const d = this.d;
    if (d.gone[side]) return [];
    d.gone[side] = true;
    d.rematch[side] = false;
    return d.gone[other(side)] ? [] : [{ to: other(side), msg: { t: 'left' } }];
  }
}
