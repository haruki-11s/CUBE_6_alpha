/*
 * A game room: one Durable Object per pair of players. It runs the game with the shared
 * rules (src/core/match.ts), keeps it in its storage after every change, and wakes on an
 * alarm for the next deadline (a clock running out, a dropped player's 60 s, the 30 s
 * after 詰み). Finished games go to the database.
 */
import { DurableObject } from 'cloudflare:workers';
import { Match, type MatchData, type Seat, type Send } from '../../src/core/match';
import { parseGameIn, type MatchKind } from '../../src/core/protocol';
import type { Player } from '../../src/core/types';
import { FloodGate, limits } from './config';
import { recordJudge, recordResult } from './records';
import { OPEN, PING, PONG, refusal, upgraded } from './ws';

interface Tag {
  pid: string;
  /** A newer connection of the same player took over. */
  replaced: boolean;
}

export class GameRoom extends DurableObject<Env> {
  private m: Match | null = null;
  private readonly gate: FloodGate;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.gate = new FloodGate(limits(env).messagesPer10s);
  }

  /** Called by the lobby once it has paired two players. */
  async init(o: { room: string; kind: MatchKind; code: string | null; seats: Record<Player, Seat> }): Promise<void> {
    this.m = Match.create({ ...o, now: Date.now() });
    await this.commit([]);
  }

  async fetch(req: Request): Promise<Response> {
    const pid = req.headers.get('X-Player-Id') ?? '';
    const m = await this.load();
    const side = m?.sideOf(pid) ?? null;
    // not one of this room's players, or the room has closed
    if (!m || !side) return refusal('bad');
    // a newer connection of the same player (they reconnected) takes over from the old one
    for (const old of this.ctx.getWebSockets(pid)) {
      old.serializeAttachment({ pid, replaced: true } satisfies Tag);
      try { old.close(4001, 'replaced'); } catch { /* gone */ }
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [pid]);
    server.serializeAttachment({ pid, replaced: false } satisfies Tag);
    await this.commit(m.back(side, Date.now()));
    return upgraded(client);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    if (!this.gate.allow(ws, now)) { ws.close(4008, 'too many messages'); return; }
    const tag = ws.deserializeAttachment() as Tag | null;
    const m = await this.load();
    const side = m && tag && !tag.replaced ? m.sideOf(tag.pid) : null;
    if (!m || !side) return;
    const msg = parseGameIn(typeof data === 'string' ? data : null);
    if (!msg) { ws.send(JSON.stringify({ t: 'error', code: 'bad' })); return; }
    let out: Send[] = [];
    switch (msg.t) {
      case 'turn': out = m.turn(side, msg.ply, msg.step1, msg.cube, now); break;
      case 'resign': out = m.resign(side, now); break;
      case 'playOn': out = m.playOn(side, now); break;
      case 'accept': out = m.accept(side, now); break;
      case 'rematch': out = m.rematch(side, now); break;
      case 'norematch': out = m.withdraw(side); break;
      case 'leave': out = m.leave(side, now); break;
      case 'sync': out = [{ to: side, msg: m.snapshot(side, now) }]; break;
      case 'ping': ws.send(PONG); return;
    }
    await this.commit(out);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(); } catch { /* already closed */ }
    await this.lost(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.lost(ws);
  }

  async alarm(): Promise<void> {
    const m = await this.load();
    if (m) await this.commit(m.tick(Date.now()));
  }

  /** A connection closed without leaving: the player has 60 s to come back. */
  private async lost(ws: WebSocket): Promise<void> {
    const tag = ws.deserializeAttachment() as Tag | null;
    if (!tag || tag.replaced) return;
    const m = await this.load();
    const side = m?.sideOf(tag.pid) ?? null;
    if (!m || !side) return;
    if (this.ctx.getWebSockets(tag.pid).some(w => w !== ws && w.readyState === OPEN)) return;
    await this.commit(m.drop(side, Date.now()));
  }

  private async load(): Promise<Match | null> {
    if (!this.m) {
      const d = await this.ctx.storage.get<MatchData>('m');
      if (d) this.m = new Match(d);
    }
    return this.m;
  }

  /** Sends the messages, keeps the game, sets the next alarm, then records a finished game. */
  private async commit(out: Send[]): Promise<void> {
    const m = this.m;
    if (!m) return;
    for (const s of out) this.deliver(m, s);
    const report = m.takeReport();
    const bug = m.takeJudgeReport();
    const now = Date.now();
    await this.ctx.storage.put('m', m.d);
    const next = m.nextDeadline();
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + 20));
    else await this.ctx.storage.deleteAlarm();
    // the room's own state is safe first; the database comes after
    if (report) await recordResult(this.env, report).catch(e => console.error('room: could not record a result', e));
    if (bug) await recordJudge(this.env, bug).catch(e => console.error('room: could not record a judge report', e));
    if (m.closed(now)) await this.shut();
  }

  private deliver(m: Match, s: Send): void {
    const text = JSON.stringify(s.msg);
    const sockets = s.to === 'both' ? this.ctx.getWebSockets() : this.ctx.getWebSockets(m.d.seats[s.to].id);
    for (const ws of sockets) {
      const tag = ws.deserializeAttachment() as Tag | null;
      if (!tag || tag.replaced) continue;
      try { ws.send(text); } catch { /* closing */ }
    }
  }

  /** Nobody is left (or the room sat finished for long): everything is removed. */
  private async shut(): Promise<void> {
    this.m = null;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, 'room closed'); } catch { /* gone */ }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
