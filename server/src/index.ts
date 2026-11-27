/*
 * CUBE 6 online server: the entry point.
 *
 *   GET    /api/hello            is the server there, and which protocol it speaks
 *   POST   /api/register         a new player: id, key and automatic name
 *   GET    /api/me               the player's name (checks the key)
 *   DELETE /api/me               deletes the player's online data
 *   GET    /api/ranking?kind=    daily / weekly: top 100 and the player's own place
 *   GET    /ws/lobby             WebSocket: random matching and 合言葉
 *   GET    /ws/game/<room>       WebSocket: one game room
 *
 * HTTP requests carry the key as "Authorization: Bearer <id>.<key>"; a WebSocket carries it
 * as a second subprotocol "k.<id>.<key>" (a browser cannot set headers on a WebSocket).
 */
import { PROTOCOL, PROTOCOL_HEADER, WS_PROTOCOL } from '../../src/core/protocol';
import { autoName, rankingPeriod } from '../../src/core/online';
import { authenticate, bearer, parseCredentials, randomInt, randomToken, sha256hex } from './auth';
import { isPaused, limits } from './config';
import { deletePlayer, readRanking } from './records';
import { refusal } from './ws';

export { Lobby } from './lobby';
export { GameRoom } from './room';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** The pages allowed to call the server (CORS). */
function allowedOrigin(env: Env, origin: string | null): string | null {
  if (!origin) return null;
  return env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin) ? origin : null;
}

function withCors(res: Response, origin: string | null): Response {
  const r = new Response(res.body, res);
  r.headers.append('Vary', 'Origin');
  if (origin) {
    r.headers.set('Access-Control-Allow-Origin', origin);
    r.headers.set('Access-Control-Allow-Headers', `Authorization, Content-Type, ${PROTOCOL_HEADER}`);
    r.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    r.headers.set('Access-Control-Max-Age', '86400');
  }
  return r;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const allowed = allowedOrigin(env, origin);
    if (url.pathname.startsWith('/ws/')) return connect(req, env, url, origin !== null && allowed === null);
    if (!url.pathname.startsWith('/api/')) return new Response('CUBE 6 server', { status: 404 });
    if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), allowed);
    let res: Response;
    try {
      res = await api(req, env, url);
    } catch (e) {
      console.error('api', e);
      res = json({ error: 'bad' }, 500);
    }
    return withCors(res, allowed);
  },
} satisfies ExportedHandler<Env>;

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  // a page from before the last protocol change must reload
  if (req.headers.get(PROTOCOL_HEADER) !== String(PROTOCOL)) return json({ error: 'outdated' }, 426);
  if (isPaused(env)) return json({ error: 'paused', resumeAt: rankingPeriod('daily', Date.now()).end }, 503);
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/hello':
      return json({ ok: true, protocol: PROTOCOL });
    case 'POST /api/register':
      return register(req, env);
    case 'GET /api/me': {
      const p = await authenticate(env.DB, bearer(req));
      return p ? json({ name: p.name }) : json({ error: 'auth' }, 401);
    }
    case 'DELETE /api/me': {
      const p = await authenticate(env.DB, bearer(req));
      if (!p) return json({ error: 'auth' }, 401);
      await deletePlayer(env, p.id);
      return new Response(null, { status: 204 });
    }
    case 'GET /api/ranking': {
      const kind = url.searchParams.get('kind');
      if (kind !== 'daily' && kind !== 'weekly') return json({ error: 'bad' }, 400);
      const p = await authenticate(env.DB, bearer(req));
      return json(await readRanking(env, kind, p?.id ?? null));
    }
    default:
      return json({ error: 'bad' }, 404);
  }
}

/** A new player. One address can make only so many per hour (the address is kept only as a salted hash). */
async function register(req: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const bucket = Math.floor(now / 3_600_000);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const ipHash = await sha256hex(`${env.IP_SALT}|${bucket}|${ip}`);
  const count = await env.DB.prepare(
    'INSERT INTO signups (bucket, ip_hash, n) VALUES (?, ?, 1) ON CONFLICT (bucket, ip_hash) DO UPDATE SET n = n + 1 RETURNING n',
  ).bind(bucket, ipHash).first<{ n: number }>();
  if ((count?.n ?? 0) > limits(env).signupsPerHour) return json({ error: 'limit' }, 429);
  if (randomInt(20) === 0) await env.DB.prepare('DELETE FROM signups WHERE bucket < ?').bind(bucket - 24).run();
  const id = randomToken(16);
  const key = randomToken(32);
  const keyHash = await sha256hex(key);
  // the name's number is unique: try another one if it is taken
  for (let i = 0; i < 10; i++) {
    const num = randomInt(100_000);
    const r = await env.DB.prepare('INSERT OR IGNORE INTO players (id, key_hash, num, created_at, seen_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, keyHash, num, now, now).run();
    if (r.meta.changes === 1) return json({ id, key, name: autoName(num) });
  }
  return json({ error: 'limit' }, 503);
}

/** Checks the version and the key, then hands the WebSocket to the lobby or to a game room. */
async function connect(req: Request, env: Env, url: URL, foreign: boolean): Promise<Response> {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
  if (foreign) return new Response('forbidden', { status: 403 });
  const offered = (req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const version = offered.find(p => p.startsWith('cube6.v'));
  if (version !== WS_PROTOCOL) return refusal('outdated', version);
  if (isPaused(env)) return refusal('paused');
  const player = await authenticate(env.DB, parseCredentials(offered.find(p => p.startsWith('k.'))?.slice(2)));
  if (!player) return refusal('auth');
  const headers = new Headers(req.headers);
  headers.set('X-Player-Id', player.id);
  headers.set('X-Player-Name', player.name);
  const fwd = new Request(req, { headers });
  if (url.pathname === '/ws/lobby') return env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch(fwd);
  const m = /^\/ws\/game\/([0-9a-f]{64})$/.exec(url.pathname);
  if (!m) return new Response('not found', { status: 404 });
  let id: DurableObjectId;
  try {
    id = env.ROOMS.idFromString(m[1]);
  } catch {
    return refusal('bad');
  }
  return env.ROOMS.get(id).fetch(fwd);
}
