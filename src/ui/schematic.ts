import type { CubeMove, Mark } from '../core/types';
import { toIndex, fromIndex } from '../core/board';
import { AXIS_INDEX } from '../core/cube';
import { cellName } from '../core/notation';
import { AXIS_COLORS } from './theme';

export interface SchematicState {
  board: Mark[];
  targets: number[];
  selected: number | null;
  lastMoved: number | null;
  win: number[];
  /** Candidate cube move: the schematic shows the board *after* it. */
  preview: { move: CubeMove; after: Mark[] } | null;
  /** Move whose layer / slice should be outlined (candidate or opponent's last move). */
  guide: CubeMove | null;
}

const LAYER_NAMES = ['下層', '中層', '上層'];

/**
 * 見取り図 — top view of the three horizontal layers (y = 2 / 1 / 0),
 * columns = x (→), rows = z (↓). Clicking / hovering is mirrored in 3D.
 */
export class Schematic {
  onCellClick?: (index: number) => void;
  onCellHover?: (index: number | null) => void;

  private readonly cells: HTMLButtonElement[] = [];
  private readonly layers: HTMLElement[] = [];
  private readonly layerTags: HTMLElement[] = [];
  private readonly badge: HTMLElement;
  private readonly legendX: HTMLElement;
  private readonly legendZ: HTMLElement;
  private readonly note: HTMLElement;
  private hover: number | null = null;

  constructor(container: HTMLElement) {
    container.innerHTML = `
      <div class="sch">
        <div class="sch-head">
          <span class="sch-title">見取り図</span>
          <span class="sch-badge" hidden>操作後</span>
        </div>
        <div class="sch-legend">
          <span class="lg ax-x" data-ax="x">x →</span>
          <span class="lg ax-z" data-ax="z">z ↓</span>
          <span class="sch-note">上から見た図</span>
        </div>
        <div class="sch-layers"></div>
      </div>`;
    this.badge = container.querySelector('.sch-badge') as HTMLElement;
    this.legendX = container.querySelector('[data-ax="x"]') as HTMLElement;
    this.legendZ = container.querySelector('[data-ax="z"]') as HTMLElement;
    this.note = container.querySelector('.sch-note') as HTMLElement;
    const layersEl = container.querySelector('.sch-layers') as HTMLElement;

    for (const y of [2, 1, 0]) {
      const layer = document.createElement('div');
      layer.className = 'sch-layer';
      const label = document.createElement('div');
      label.className = 'sch-layer-label';
      label.innerHTML = `<span class="ax-y">Y${y}</span><span>${LAYER_NAMES[y]}</span>`;
      const tag = document.createElement('span');
      tag.className = 'sch-tag';
      label.appendChild(tag);
      const grid = document.createElement('div');
      grid.className = 'sch-grid';
      for (let z = 0; z < 3; z++) {
        for (let x = 0; x < 3; x++) {
          const idx = toIndex(x, y, z);
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sch-cell';
          b.innerHTML = '<span class="sym" aria-hidden="true"></span>';
          b.addEventListener('click', () => this.onCellClick?.(idx));
          b.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') this.onCellHover?.(idx); });
          b.addEventListener('pointerleave', () => this.onCellHover?.(null));
          b.addEventListener('focus', () => this.onCellHover?.(idx));
          b.addEventListener('blur', () => this.onCellHover?.(null));
          grid.appendChild(b);
          this.cells[idx] = b;
        }
      }
      layer.append(label, grid);
      layersEl.appendChild(layer);
      this.layers[y] = layer;
      this.layerTags[y] = tag;
    }
  }

  update(s: SchematicState): void {
    const shown = s.preview ? s.preview.after : s.board;
    const targets = new Set(s.targets);
    const win = new Set(s.win);
    const affected = new Set<number>();
    const entering = new Set<number>();
    const g = s.guide;
    const hl = g ? AXIS_COLORS[g.axis].css : '';

    if (g) {
      const a = AXIS_INDEX[g.axis];
      for (let i = 0; i < 27; i++) {
        const c = fromIndex(i)[a];
        if (g.kind === 'rotate' && c === g.layer) affected.add(i);
        // after a slide, the slice on the far side received the wrapped pieces
        if (g.kind === 'slide' && c === (g.dir === 'forward' ? 2 : 0)) entering.add(i);
      }
    }

    for (let i = 0; i < 27; i++) {
      const b = this.cells[i];
      const m = shown[i];
      const cl = b.classList;
      cl.toggle('o', m === 'O');
      cl.toggle('x', m === 'X');
      cl.toggle('target', targets.has(i));
      cl.toggle('sel', s.selected === i);
      cl.toggle('last', s.lastMoved === i && !s.preview && !win.size);
      cl.toggle('win', win.has(i));
      cl.toggle('affected', affected.has(i));
      cl.toggle('entering', entering.has(i));
      cl.toggle('changed', !!s.preview && m !== s.board[i]);
      b.style.setProperty('--hl', hl);
      (b.firstElementChild as HTMLElement).textContent = m === 'O' ? '○' : m === 'X' ? '×' : '';
      const state = m === 'O' ? '〇' : m === 'X' ? '×' : '空き';
      b.setAttribute('aria-label', `${cellName(i)} ${state}${targets.has(i) ? '（選択可）' : ''}`);
    }

    // per-layer decoration (Y rotations rotate a whole grid; Y slides move grids up/down)
    for (let y = 0; y < 3; y++) {
      const L = this.layers[y];
      L.style.setProperty('--hl', hl);
      let tag = '';
      if (g?.axis === 'Y' && g.kind === 'rotate' && g.layer === y) tag = g.dir === 'CCW' ? '↺ 回転' : '↻ 回転';
      if (g?.axis === 'Y' && g.kind === 'slide') tag = g.dir === 'forward' ? '↓ 1層下へ' : '↑ 1層上へ';
      L.classList.toggle('affected', !!tag);
      this.layerTags[y].textContent = tag;
    }

    // legend: direction of X / Z slides, highlight the axis in use
    this.legendX.textContent = g?.axis === 'X' && g.kind === 'slide' ? (g.dir === 'forward' ? 'x ← 繰越' : 'x → 繰越') : 'x →';
    this.legendZ.textContent = g?.axis === 'Z' && g.kind === 'slide' ? (g.dir === 'forward' ? 'z ↑ 繰越' : 'z ↓ 繰越') : 'z ↓';
    this.legendX.classList.toggle('on', g?.axis === 'X');
    this.legendZ.classList.toggle('on', g?.axis === 'Z');
    this.note.textContent = s.preview ? '確定後の配置' : '上から見た図';
    this.badge.hidden = !s.preview;
  }

  setHover(i: number | null): void {
    if (this.hover === i) return;
    if (this.hover !== null) this.cells[this.hover]?.classList.remove('hover');
    this.hover = i;
    if (i !== null) this.cells[i]?.classList.add('hover');
  }
}
