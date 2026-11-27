/*
 * The database side: finished games, the ranking tallies and judge reports.
 */
import type { Player } from '../../src/core/types';
import type { JudgeReport, MatchReport } from '../../src/core/match';
import { autoName, rankByWins, rankingPeriod, RANKING_SIZE, type RankingKind } from '../../src/core/online';
import { limits } from './config';

const other = (p: Player): Player => (p === 'O' ? 'X' : 'O');
const KINDS: readonly RankingKind[] = ['daily', 'weekly'];

/**
 * Keeps a finished game. A random match's win counts for the rankings unless the game
 * was very short or the same opponent has already given that many wins today.
 */
export async function recordResult(env: Env, r: MatchReport): Promise<void> {
  const L = limits(env);
  let ranked = false;
  let winnerId = '';
  if (r.kind === 'random' && r.winner && r.plies >= L.minRankedPlies) {
    winnerId = r.seats[r.winner].id;
    const loserId = r.seats[other(r.winner)].id;
    const since = rankingPeriod('daily', r.endedAt).start;
    const same = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM games WHERE ranked = 1 AND ended_at >= ?1
         AND ((winner = 'O' AND player_o = ?2 AND player_x = ?3) OR (winner = 'X' AND player_x = ?2 AND player_o = ?3))`,
    ).bind(since, winnerId, loserId).first<{ n: number }>();
    ranked = (same?.n ?? 0) < L.sameOpponentPerDay;
  }
  const stmts = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO games (id, kind, player_o, player_x, winner, reason, plies, started_at, ended_at, ranked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`${r.room}:${r.game}`, r.kind, r.seats.O.id, r.seats.X.id, r.winner, r.reason, r.plies, r.startedAt, r.endedAt, ranked ? 1 : 0),
  ];
  if (ranked) {
    for (const kind of KINDS) {
      const { start } = rankingPeriod(kind, r.endedAt);
      stmts.push(env.DB.prepare(
        `INSERT INTO wins (period, player_id, wins, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (period, player_id) DO UPDATE SET wins = wins + 1, updated_at = excluded.updated_at`,
      ).bind(`${kind}:${start}`, winnerId, r.endedAt));
    }
  }
  await env.DB.batch(stmts);
}

export async function recordJudge(env: Env, j: JudgeReport): Promise<void> {
  console.warn('judge: 誤審の訂正 broke a 詰み', JSON.stringify(j));
  await env.DB.prepare('INSERT INTO judge_reports (game_id, ply, board, turn, at) VALUES (?, ?, ?, ?, ?)')
    .bind(`${j.room}:${j.game}`, j.ply, JSON.stringify(j.board), JSON.stringify(j.turn), Date.now()).run();
}

export interface RankingReply {
  kind: RankingKind;
  start: number;
  end: number;
  rows: Array<{ rank: number; name: string; wins: number; me: boolean }>;
  mine: { rank: number; wins: number } | null;
}

/** The top places of the period now running, and the asking player's own place. */
export async function readRanking(env: Env, kind: RankingKind, meId: string | null): Promise<RankingReply> {
  const { start, end } = rankingPeriod(kind, Date.now());
  const period = `${kind}:${start}`;
  const { results } = await env.DB.prepare(
    `SELECT w.player_id AS id, w.wins AS wins, p.num AS num FROM wins w JOIN players p ON p.id = w.player_id
     WHERE w.period = ? ORDER BY w.wins DESC, w.updated_at ASC LIMIT ?`,
  ).bind(period, RANKING_SIZE).all<{ id: string; wins: number; num: number }>();
  const rows = rankByWins(results.map(r => ({ name: autoName(r.num), wins: r.wins, me: r.id === meId })))
    .map(r => ({ rank: r.rank, name: r.name, wins: r.wins, me: r.me }));
  let mine: RankingReply['mine'] = null;
  if (meId) {
    const w = await env.DB.prepare('SELECT wins FROM wins WHERE period = ? AND player_id = ?').bind(period, meId).first<{ wins: number }>();
    if (w) {
      const above = await env.DB.prepare('SELECT COUNT(*) AS n FROM wins WHERE period = ? AND wins > ?').bind(period, w.wins).first<{ n: number }>();
      mine = { rank: (above?.n ?? 0) + 1, wins: w.wins };
    }
  }
  return { kind, start, end, rows, mine };
}

/** 設定 → オンラインのデータを削除: the player, their ranking tallies, and their name on past games. */
export async function deletePlayer(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM wins WHERE player_id = ?').bind(id),
    env.DB.prepare('UPDATE games SET player_o = NULL WHERE player_o = ?').bind(id),
    env.DB.prepare('UPDATE games SET player_x = NULL WHERE player_x = ?').bind(id),
    env.DB.prepare('DELETE FROM players WHERE id = ?').bind(id),
  ]);
}
