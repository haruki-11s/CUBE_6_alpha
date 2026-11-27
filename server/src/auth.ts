/*
 * Players without accounts: the server gives each one a random id and key, and keeps
 * only a hash of the key. The game sends "<id>.<key>" back with every request.
 */
import { autoName } from '../../src/core/online';

export interface Player { id: string; num: number; name: string }

const enc = new TextEncoder();
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const DAY = 86_400_000;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A random whole number below `n`. */
export function randomInt(n: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

export async function sha256hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** "<id>.<key>" → its parts, or null when it is not in that shape. */
export function parseCredentials(s: string | null | undefined): { id: string; key: string } | null {
  if (!s) return null;
  const parts = s.split('.');
  if (parts.length !== 2 || !TOKEN.test(parts[0]) || !TOKEN.test(parts[1])) return null;
  return { id: parts[0], key: parts[1] };
}

/** From "Authorization: Bearer <id>.<key>". */
export function bearer(req: Request): { id: string; key: string } | null {
  const h = req.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? parseCredentials(h.slice(7)) : null;
}

export async function authenticate(db: D1Database, cred: { id: string; key: string } | null): Promise<Player | null> {
  if (!cred) return null;
  const row = await db.prepare('SELECT key_hash, num, seen_at FROM players WHERE id = ?')
    .bind(cred.id).first<{ key_hash: string; num: number; seen_at: number }>();
  if (!row || !sameText(await sha256hex(cred.key), row.key_hash)) return null;
  const now = Date.now();
  // "last seen" at most once a day, to keep the writes down
  if (now - row.seen_at > DAY) await db.prepare('UPDATE players SET seen_at = ? WHERE id = ?').bind(now, cred.id).run();
  return { id: cred.id, num: row.num, name: autoName(row.num) };
}
