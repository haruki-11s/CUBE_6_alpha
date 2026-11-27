import { WS_PROTOCOL, type ServerErrorCode } from '../../src/core/protocol';

/** The game pings every 20 s; the runtime answers without waking the room. */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';
/** WebSocket readyState OPEN. */
export const OPEN = 1;

/**
 * A browser cannot see why a WebSocket handshake was refused, so a refusal is a connection
 * that says why (a short code) and closes at once.
 */
export function refusal(code: ServerErrorCode, protocol: string | undefined = WS_PROTOCOL): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.send(JSON.stringify({ t: 'error', code }));
  server.close(4000, code);
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {},
  });
}

/** Accepts the upgrade for a Durable Object (with hibernation) and answers with our subprotocol. */
export function upgraded(client: WebSocket): Response {
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': WS_PROTOCOL } });
}
