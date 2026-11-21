import { chooseMove, type AiDecision, type CpuLevel } from '../core/ai';
import type { GameState } from '../core/types';

interface Pending {
  state: GameState;
  level: CpuLevel;
  step1Done: boolean;
  timeMs?: number;
  resolve: (d: AiDecision | null) => void;
}

/**
 * Asks the CPU for a move. Uses a Web Worker when available (falls back to
 * the main thread). `cancel()` drops pending answers and stops a long search.
 */
export class CpuClient {
  private worker: Worker | null = null;
  private broken = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  /** `timeMs` caps the thinking time (e.g. when the CPU's clock runs low). */
  think(state: GameState, level: CpuLevel, step1Done: boolean, timeMs?: number): Promise<AiDecision | null> {
    const id = ++this.seq;
    return new Promise(resolve => {
      const req: Pending = { state, level, step1Done, timeMs, resolve };
      const w = this.getWorker();
      if (!w) {
        this.runLocal(id, req);
        return;
      }
      this.pending.set(id, req);
      w.postMessage({ id, state, level, opts: { step1Done, timeMs } });
    });
  }

  cancel(): void {
    this.seq++;
    const busy = this.pending.size > 0;
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
    if (busy && this.worker) {
      this.worker.terminate(); // a deep search could run for seconds
      this.worker = null;
    }
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private runLocal(id: number, req: Pending): void {
    // let the "thinking" UI paint first
    setTimeout(() => {
      if (id !== this.seq) { req.resolve(null); return; }
      try {
        req.resolve(chooseMove(req.state, req.level, { step1Done: req.step1Done, timeMs: req.timeMs }));
      } catch {
        req.resolve(null);
      }
    }, 30);
  }

  private getWorker(): Worker | null {
    if (this.broken || typeof Worker === 'undefined') return null;
    if (this.worker) return this.worker;
    try {
      const w = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; decision?: AiDecision }>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.decision) p.resolve(e.data.decision);
        else this.runLocal(e.data.id, p);
      };
      w.onerror = ev => {
        ev.preventDefault();
        this.broken = true;
        w.terminate();
        this.worker = null;
        const waiting = [...this.pending.entries()];
        this.pending.clear();
        for (const [id, p] of waiting) this.runLocal(id, p);
      };
      this.worker = w;
      return w;
    } catch {
      this.broken = true;
      return null;
    }
  }
}
