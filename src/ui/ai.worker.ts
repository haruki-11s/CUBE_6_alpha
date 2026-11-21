// Runs the CPU search off the main thread so the 3D view stays smooth.
import { chooseMove, type AiOptions, type CpuLevel } from '../core/ai';
import type { GameState } from '../core/types';

interface Request { id: number; state: GameState; level: CpuLevel; opts: AiOptions }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

ctx.onmessage = e => {
  const { id, state, level, opts } = e.data;
  try {
    ctx.postMessage({ id, decision: chooseMove(state, level, opts) });
  } catch (err) {
    ctx.postMessage({ id, error: String(err) });
  }
};
