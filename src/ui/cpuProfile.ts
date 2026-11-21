import type { CpuLevel } from '../core/ai';

/** Display data for the CPU strengths. Level 6 is hidden until unlocked. */
export const CPU_LEVELS: Readonly<Record<CpuLevel, { name: string; desc: string }>> = {
  1: { name: '初心者', desc: 'ルールを覚えたばかり。気まぐれに打ちます。' },
  2: { name: '準初心者', desc: '王手にはたいてい気づきますが、守りは甘め。' },
  3: { name: '基準', desc: '相手の次の一手をおおむね警戒する、標準の強さ。' },
  4: { name: '中級者', desc: '詰みは見逃さず、目の前の危険は必ず防ぎます。' },
  5: { name: '上級者', desc: '2手先まで読んで王手で追い詰めてきますが、ときどき読み漏らします。' },
  6: { name: '最強', desc: 'さらに深く読み、詰み筋まで狙ってくる最高レベル。' },
};

export const NORMAL_LEVELS: readonly CpuLevel[] = [1, 2, 3, 4, 5];
export const HIDDEN_LEVEL: CpuLevel = 6;

export function levelLabel(l: CpuLevel): string {
  return `Lv.${l} ${CPU_LEVELS[l].name}`;
}

// ── Records & unlock (per browser) ─────────────────────────────────────────
export type GameResult = 'w' | 'l' | 'd';
export interface LevelRecord { w: number; l: number; d: number }
export interface Progress {
  records: Record<CpuLevel, LevelRecord>;
  /** Level 6 appears after beating level 5 without taking a move back. */
  unlocked: boolean;
}

const KEY = 'cube6-cpu';
const LEVELS: readonly CpuLevel[] = [1, 2, 3, 4, 5, 6];

function empty(): Progress {
  const records = {} as Record<CpuLevel, LevelRecord>;
  for (const l of LEVELS) records[l] = { w: 0, l: 0, d: 0 };
  return { records, unlocked: false };
}

export function loadProgress(): Progress {
  const p = empty();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return p;
    const v = JSON.parse(raw) as { records?: Record<string, Partial<LevelRecord>>; unlocked?: unknown };
    const n = (x: unknown): number => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : 0);
    for (const l of LEVELS) {
      const r = v.records?.[l];
      if (r) p.records[l] = { w: n(r.w), l: n(r.l), d: n(r.d) };
    }
    p.unlocked = v.unlocked === true;
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return p;
}

function saveProgress(p: Progress): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

/** Adds (or with `undo`, removes) one result. Returns true when level 6 was just unlocked. */
export function recordResult(level: CpuLevel, result: GameResult, opts: { undos: number; undo?: boolean }): boolean {
  const p = loadProgress();
  const r = p.records[level];
  r[result] = Math.max(0, r[result] + (opts.undo ? -1 : 1));
  let unlockedNow = false;
  if (!opts.undo && !p.unlocked && level === 5 && result === 'w' && opts.undos === 0) {
    p.unlocked = true;
    unlockedNow = true;
  }
  saveProgress(p);
  return unlockedNow;
}
