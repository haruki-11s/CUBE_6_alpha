import type { Axis, CubeMove, Lang, Player, Step1Action } from './types';
import { fromIndex } from './board';

export function playerSymbol(p: Player): string {
  return p === 'O' ? '〇' : '×';
}

export function cellName(i: number): string {
  const [x, y, z] = fromIndex(i);
  return `(${x},${y},${z})`;
}

const LAYER_HINT: Record<Lang, Record<Axis, readonly [string, string, string]>> = {
  ja: {
    X: ['x=0 側', 'x 中央', 'x=2 側'],
    Y: ['下層', '中層', '上層'],
    Z: ['z=0 側', 'z 中央', 'z=2 側'],
  },
  en: {
    X: ['x=0 side', 'x middle', 'x=2 side'],
    Y: ['bottom', 'middle', 'top'],
    Z: ['z=0 side', 'z middle', 'z=2 side'],
  },
};

export function layerHint(axis: Axis, layer: number, lang: Lang = 'ja'): string {
  return LAYER_HINT[lang][axis][layer] ?? '';
}

/** Long, human readable description (used in the panel and tooltips). */
export function describeMove(m: CubeMove, lang: Lang = 'ja'): string {
  const hint = m.kind === 'rotate' ? layerHint(m.axis, m.layer, lang) : '';
  if (lang === 'en') {
    if (m.kind === 'rotate') {
      return `Rotate ${m.axis} layer ${m.layer} (${hint}) ${m.dir === 'CCW' ? '↺ counterclockwise' : '↻ clockwise'}`;
    }
    return `Slide along ${m.axis}, one cell in the ${m.dir === 'forward' ? '−' : '+'} direction`;
  }
  if (m.kind === 'rotate') {
    const d = m.dir === 'CCW' ? '↺ 左回り' : '↻ 右回り';
    return `回転 ${m.axis}軸・層${m.layer}（${hint}）${d}`;
  }
  return `繰越 ${m.axis}軸 ${m.dir === 'forward' ? '−方向' : '＋方向'}へ1マス`;
}

/** Compact notation for the move log, e.g. "X1↺" or "Z+". */
export function shortMove(m: CubeMove): string {
  if (m.kind === 'rotate') return `${m.axis}${m.layer}${m.dir === 'CCW' ? '↺' : '↻'}`;
  return `${m.axis}${m.dir === 'forward' ? '−' : '+'}`;
}

export function describeStep1(a: Step1Action, lang: Lang = 'ja'): string {
  const [place, move] = lang === 'en' ? ['Place', 'Move'] : ['配置', '移動'];
  return a.kind === 'place'
    ? `${place} ${cellName(a.index)}`
    : `${move} ${cellName(a.from)}→${cellName(a.to)}`;
}
