/*
 * The lobby: one Durable Object for everyone. ランダム対戦 pairs the two players who have
 * waited longest; 合言葉 pairs the player who made a code with the one who enters it.
 * Each pair gets a new game room, and both players are told where it is.
 *
 * What the lobby knows about a connection is kept on the socket itself, so it survives
 * the object hibernating between messages.
 */
import { DurableObject } from 'cloudflare:workers';
import { parseLobbyIn, type LobbyOut, type MatchKind } from '../../src/core/protocol';
import { newRoomCode, ROOM_CODE_TTL_MS } from '../../src/core/online';
import type { Player } from '../../src/core/types';
import { randomInt } from './auth';
import { FloodGate, limits } from './config';
import { OPEN, PING, PONG, upgraded } from './ws';

interface Tag {
  pid: string;
  name: string;
  mode: 'idle' | 'find' | 'code' | 'done';
  code: string | null;
  expires: number;
  /** When it connected or started searching. */
  since: number;
  /** Recent 合言葉 tries. */
  tries: number[];
}
interface Conn { ws: WebSocket; tag: Tag }

/** A connection that has not pinged for this long is taken to be gone (a sleeping device, a lost network). */
const STALE_MS = 50_000;

function send(ws: WebSocket, msg: LobbyOut): void {
  try { ws.send(JSON.stringify(msg)); } catch { /* closed meanwhile */ }
}

const rand = (): number => randomInt(1_000_000) / 1_000_000;

export class Lobby extends DurableObject<Env> {
  private readonly gate: FloodGate;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.gate = new FloodGate(limits(env).messagesPer10s);
  }

  async fetch(req: Request): Promise<Response> {
    const pid = req.headers.get('X-Player-Id');
    const name = req.headers.get('X-Player-Name');
    if (!pid || !name || req.headers.get('Upgrade') !== 'websocket') return new Response('bad request', { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid, name, mode: 'idle', code: null, expires: 0, since: Date.now(), tries: [] } satisfies Tag);
    return upgraded(client);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    if (!this.gate.allow(ws, now)) { ws.close(4008, 'too many messages'); return; }
    const tag = ws.deserializeAttachment() as Tag | null;
    if (!tag) return;
    const msg = parseLobbyIn(typeof data === 'string' ? data : null);
    if (!msg) { send(ws, { t: 'error', code: 'bad' }); return; }
    switch (msg.t) {
      case 'find': await this.find(ws, tag, now); break;
      case 'create': await this.create(ws, tag, now); break;
      case 'join': await this.join(ws, tag, msg.code, now); break;
      case 'cancel':
        if (tag.mode === 'find' || tag.mode === 'code') this.set(ws, { ...tag, mode: 'idle', code: null, expires: 0 });
        await this.schedule();
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(); } catch { /* already closed */ }
    await this.schedule();
  }

  /** A code ran out: its maker is told, and can make another. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const c of this.live(now)) {
      if (c.tag.mode === 'code' && c.tag.expires <= now) {
        this.set(c.ws, { ...c.tag, mode: 'idle', code: null, expires: 0 });
        send(c.ws, { t: 'expired' });
      }
    }
    await this.schedule();
  }

  private async find(ws: WebSocket, tag: Tag, now: number): Promise<void> {
    if (tag.mode !== 'idle') return;
    const waiting = this.live(now)
      .filter(c => c.ws !== ws && c.tag.mode === 'find' && c.tag.pid !== tag.pid)
      .sort((a, b) => a.tag.since - b.tag.since);
    if (waiting.length) { await this.pair(waiting[0], { ws, tag }, 'random', null); return; }
    this.set(ws, { ...tag, mode: 'find', since: now });
    send(ws, { t: 'queued' });
  }

  private async create(ws: WebSocket, tag: Tag, now: number): Promise<void> {
    if (tag.mode !== 'idle') return;
    const taken = new Set(this.live(now).filter(c => c.tag.mode === 'code').map(c => c.tag.code));
    let code = newRoomCode(rand);
    for (let i = 0; i < 50 && taken.has(code); i++) code = newRoomCode(rand);
    if (taken.has(code)) { send(ws, { t: 'error', code: 'limit' }); return; }
    this.set(ws, { ...tag, mode: 'code', code, expires: now + ROOM_CODE_TTL_MS });
    send(ws, { t: 'code', code, ttl: ROOM_CODE_TTL_MS });
    await this.schedule();
  }

  private async join(ws: WebSocket, tag: Tag, code: string, now: number): Promise<void> {
    if (tag.mode !== 'idle') return;
    const tries = tag.tries.filter(t => now - t < 60_000);
    if (tries.length >= limits(this.env).joinTriesPerMinute) { send(ws, { t: 'error', code: 'limit' }); return; }
    tries.push(now);
    const me: Tag = { ...tag, tries };
    this.set(ws, me);
    const host = this.live(now).find(c => c.tag.mode === 'code' && c.tag.code === code && c.tag.expires > now && c.tag.pid !== tag.pid);
    if (!host) { send(ws, { t: 'nocode' }); return; }
    await this.pair(host, { ws, tag: me }, 'code', code);
  }

  /** Two players found each other: a new room, a random turn order, and both are told. */
  private async pair(a: Conn, b: Conn, kind: MatchKind, code: string | null): Promise<void> {
    // both are taken at once, so nobody else is paired with them while the room is made
    this.set(a.ws, { ...a.tag, mode: 'done' });
    this.set(b.ws, { ...b.tag, mode: 'done' });
    const id = this.env.ROOMS.newUniqueId();
    const room = id.toString();
    const [o, x] = randomInt(2) === 0 ? [a, b] : [b, a];
    const seats: Record<Player, { id: string; name: string }> = {
      O: { id: o.tag.pid, name: o.tag.name },
      X: { id: x.tag.pid, name: x.tag.name },
    };
    try {
      await this.env.ROOMS.get(id).init({ room, kind, code, seats });
    } catch (e) {
      console.error('lobby: could not open a room', e);
      for (const c of [a, b]) { send(c.ws, { t: 'error', code: 'bad' }); this.set(c.ws, { ...c.tag, mode: 'idle' }); }
      return;
    }
    for (const [c, me] of [[o, 'O'], [x, 'X']] as const) {
      send(c.ws, { t: 'match', room, me, opponent: seats[me === 'O' ? 'X' : 'O'].name, kind, code });
      try { c.ws.close(1000, 'matched'); } catch { /* gone */ }
    }
    await this.schedule();
  }

  private set(ws: WebSocket, tag: Tag): void {
    ws.serializeAttachment(tag);
  }

  /** Open connections that pinged recently; silent ones are closed. */
  private live(now: number): Conn[] {
    const out: Conn[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== OPEN) continue;
      const tag = ws.deserializeAttachment() as Tag | null;
      if (!tag) continue;
      const last = Math.max(tag.since, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
      if (now - last > STALE_MS) {
        try { ws.close(4002, 'stale'); } catch { /* gone */ }
        continue;
      }
      out.push({ ws, tag });
    }
    return out;
  }

  /** The alarm rings when the next code runs out. */
  private async schedule(): Promise<void> {
    const times = this.live(Date.now()).filter(c => c.tag.mode === 'code').map(c => c.tag.expires);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
}
