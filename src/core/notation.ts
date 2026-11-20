import type { Axis, CubeMove, Player, Step1Action } from './types';
import { fromIndex } from './board';

export function playerSymbol(p: Player): string {
  return p === 'O' ? '〇' : '×';
}

export function cellName(i: number): string {
  const [x, y, z] = fromIndex(i);
  return `(${x},${y},${z})`;
}

const LAYER_HINT: Record<Axis, readonly [string, string, string]> = {
  X: ['x=0 側', 'x 中央', 'x=2 側'],
  Y: ['下層', '中層', '上層'],
  Z: ['z=0 側', 'z 中央', 'z=2 側'],
};

export function layerHint(axis: Axis, layer: number): string {
  return LAYER_HINT[axis][layer] ?? '';
}

/** Long, human readable description (used in the panel and tooltips). */
export function describeMove(m: CubeMove): string {
  if (m.kind === 'rotate') {
    const d = m.dir === 'CCW' ? '↺ 左回り' : '↻ 右回り';
    return `回転 ${m.axis}軸・層${m.layer}（${layerHint(m.axis, m.layer)}）${d}`;
  }
  return `繰越 ${m.axis}軸 ${m.dir === 'forward' ? '−方向' : '＋方向'}へ1マス`;
}

/** Compact notation for the move log, e.g. "X1↺" or "Z+". */
export function shortMove(m: CubeMove): string {
  if (m.kind === 'rotate') return `${m.axis}${m.layer}${m.dir === 'CCW' ? '↺' : '↻'}`;
  return `${m.axis}${m.dir === 'forward' ? '−' : '+'}`;
}

export function describeStep1(a: Step1Action): string {
  return a.kind === 'place'
    ? `配置 ${cellName(a.index)}`
    : `移動 ${cellName(a.from)}→${cellName(a.to)}`;
}
