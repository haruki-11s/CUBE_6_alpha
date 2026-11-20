import type { Axis, CubeMove, GameState, Layer, Player } from '../core/types';
import { legalCubeMoves } from '../core/rules';
import { invertMove, moveKey, movesEqual } from '../core/cube';
import { describeMove, shortMove, describeStep1, cellName, layerHint } from '../core/notation';
import type { LogEntry } from '../core/save';
import { PLAYER_COLORS } from './theme';
import { icon } from './icons';

export type Outcome = 'win' | 'self' | 'draw' | 'limit';

export type ControlEvent =
  | { type: 'hoverMove'; move: CubeMove | null }
  | { type: 'selectMove'; move: CubeMove }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'undo' }
  | { type: 'peekLast'; on: boolean }
  | { type: 'deselectPiece' }
  | { type: 'showResult' }
  | { type: 'replay' }
  | { type: 'title' };

export interface ControlsView {
  state: GameState;
  phase: 'step1' | 'step1-move-from' | 'step2';
  selectedFrom: number | null;
  canPlace: boolean;
  /** "配置" or "移動" — what step ① of this turn is / was. */
  step1Label: string;
  canUndo: boolean;
  log: LogEntry[];
  resultText?: string;
}

const AXES: readonly Axis[] = ['X', 'Y', 'Z'];
const OUTCOME_TEXT: Readonly<Record<Outcome, [string, string]>> = {
  win: ['win', '★ この操作で勝利！'],
  self: ['self', '⚠ 相手の列が揃います（自爆負け）'],
  draw: ['draw', '＝ 両者の列が同時成立（引き分け）'],
  limit: ['draw', '＝ 手数上限に達して引き分け'],
};

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

/**
 * Right-hand panel. `render()` rebuilds it on phase changes only; selection,
 * hover preview and busy state are applied in place (no DOM rebuild), so
 * pointer events can never race with a re-render.
 */
export class Controls {
  onEvent?: (e: ControlEvent) => void;

  private readonly moveBtns = new Map<string, { btn: HTMLButtonElement; move: CubeMove }>();
  private selLabel: HTMLElement | null = null;
  private outcomeEl: HTMLElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private undoBtn: HTMLButtonElement | null = null;
  private selected: CubeMove | null = null;
  private busy = false;
  private canUndo = false;
  private logOpen = false;

  constructor(private readonly container: HTMLElement) {}

  private emit(e: ControlEvent): void { this.onEvent?.(e); }

  render(v: ControlsView): void {
    const s = v.state;
    this.container.innerHTML = '';
    this.moveBtns.clear();
    this.selLabel = this.outcomeEl = null;
    this.confirmBtn = this.cancelBtn = this.undoBtn = null;
    this.canUndo = v.canUndo;

    this.container.appendChild(this.turnCard(v));
    if (s.status !== 'playing') {
      this.container.appendChild(this.resultCard(v));
    } else if (v.phase === 'step2') {
      this.container.appendChild(this.opCard(s));
      this.container.appendChild(this.confirmCard());
    } else {
      this.container.appendChild(this.step1Card(v));
    }
    this.container.appendChild(this.footCard(v));
    this.applyBusy();
  }

  // ── Cards ────────────────────────────────────────────────────────────────
  private turnCard(v: ControlsView): HTMLElement {
    const s = v.state;
    const P = PLAYER_COLORS[s.current];
    const over = s.status !== 'playing';
    const step1 = v.phase !== 'step2';
    const el = document.createElement('section');
    el.className = 'card turn-card';
    el.innerHTML = `
      <div class="tc-row">
        <span class="tc-chip ${over ? 'end' : s.current.toLowerCase()}">${over ? icon('trophy') : P.glyph}</span>
        <div class="tc-who">
          <div class="tc-name">${over ? '対局終了' : `${P.label} の番`}</div>
          <div class="tc-sub">手数 ${s.ply}${s.settings.turnLimit ? ` / ${s.settings.turnLimit}` : ''}</div>
        </div>
      </div>
      ${over ? '' : `<ol class="stepper" aria-label="手番の進行">
        <li class="${step1 ? 'on' : 'done'}"><b>1</b>${v.step1Label}</li>
        <li class="${step1 ? '' : 'on'}"><b>2</b>キューブ操作</li>
      </ol>`}
      <div class="hands">${(['O', 'X'] as const).map(p => this.handRow(p, s)).join('')}</div>`;
    return el;
  }

  private handRow(p: Player, s: GameState): string {
    const n = s.hand[p];
    const P = PLAYER_COLORS[p];
    const dots = Array.from({ length: 6 }, (_, i) => `<i class="${i < n ? 'in' : ''}"></i>`).join('');
    const cur = s.current === p && s.status === 'playing';
    return `<div class="hand ${p.toLowerCase()}${cur ? ' cur' : ''}" title="${P.label} 手駒 ${n}／6">
      <span class="hand-sym">${P.glyph}</span><span class="dots">${dots}</span>
      <span class="hand-n">${n > 0 ? `手駒 ${n}` : '移動フェーズ'}</span></div>`;
  }

  private step1Card(v: ControlsView): HTMLElement {
    const s = v.state;
    const el = document.createElement('section');
    el.className = 'card info-card';
    let html: string;
    if (v.canPlace) {
      html = '<p class="lead">光っている<b>空きマス</b>を選んで駒を置きます。<br><small>3D・見取り図のどちらでも選べます。</small></p>';
    } else if (v.selectedFrom === null) {
      html = '<p class="lead">手駒を使い切りました。<b>動かす自分の駒</b>を選んでください。</p>';
    } else {
      html = `<p class="lead">移動先の<b>空きマス</b>を選んでください。</p>
        <div class="sel-piece"><span>選択中 <b>${cellName(v.selectedFrom)}</b></span>
        <button type="button" class="btn sm ghost" data-act="deselect">選び直す<kbd>Esc</kbd></button></div>`;
    }
    if (s.lastCubeMove) {
      const lm = s.lastCubeMove;
      html += `<div class="last-move" tabindex="0" role="note" aria-label="相手の直前の操作">
        <div class="lm-row"><span class="lm-k">相手の直前の操作</span><span class="chip ax-${lm.axis.toLowerCase()}">${shortMove(lm)}</span></div>
        <div class="lm-desc">${describeMove(lm)}</div>
        <div class="lm-ban">次の②では <span class="chip ban">${shortMove(invertMove(lm))}</span> が禁止（逆操作）</div>
        <div class="lm-tip">${icon('eye')}ポイントすると3Dに表示</div>
      </div>`;
    }
    el.innerHTML = html;
    el.querySelector('[data-act="deselect"]')?.addEventListener('click', () => this.emit({ type: 'deselectPiece' }));
    const lmEl = el.querySelector<HTMLElement>('.last-move');
    if (lmEl) {
      const on = (): void => this.emit({ type: 'peekLast', on: true });
      const off = (): void => this.emit({ type: 'peekLast', on: false });
      lmEl.addEventListener('pointerenter', on);
      lmEl.addEventListener('pointerleave', off);
      lmEl.addEventListener('focus', on);
      lmEl.addEventListener('blur', off);
    }
    return el;
  }

  private opCard(s: GameState): HTMLElement {
    const legal = new Set(legalCubeMoves(s).map(moveKey));
    const el = document.createElement('section');
    el.className = 'card op-card';
    el.innerHTML = '<div class="card-title">キューブ操作 <span class="req">必須</span></div>';
    const grid = div('op-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'キューブ操作の選択');
    grid.appendChild(div('op-corner'));
    for (const a of AXES) grid.appendChild(div(`op-head ax-${a.toLowerCase()}`, `${a}軸`));
    for (const layer of [0, 1, 2] as const) {
      grid.appendChild(div('op-row', `層${layer}`));
      for (const a of AXES) {
        const cell = div(`op-cell ax-${a.toLowerCase()}`);
        cell.title = `${a}軸・層${layer}（${layerHint(a, layer)}）`;
        cell.append(this.moveBtn(rot(a, layer, 'CCW'), legal), this.moveBtn(rot(a, layer, 'CW'), legal));
        grid.appendChild(cell);
      }
    }
    grid.appendChild(div('op-row', '繰越'));
    for (const a of AXES) {
      const cell = div(`op-cell ax-${a.toLowerCase()}`);
      cell.title = `${a}軸方向へ盤全体を1マスずらす`;
      cell.append(
        this.moveBtn({ kind: 'slide', axis: a, dir: 'forward' }, legal),
        this.moveBtn({ kind: 'slide', axis: a, dir: 'backward' }, legal),
      );
      grid.appendChild(cell);
    }
    el.appendChild(grid);
    el.insertAdjacentHTML('beforeend', `<div class="op-legend">
      <span>${icon('rotCCW')}${icon('rotCW')}＋側から見た回転</span><span><b>−</b><b>＋</b>繰越の向き</span></div>`);
    if (s.lastCubeMove) {
      el.insertAdjacentHTML('beforeend', `<div class="op-ban"><span class="chip ban">${shortMove(invertMove(s.lastCubeMove))}</span>
        は禁止（相手の直前 <b>${shortMove(s.lastCubeMove)}</b> の逆操作）</div>`);
    }
    return el;
  }

  private moveBtn(m: CubeMove, legal: ReadonlySet<string>): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-btn';
    const ok = legal.has(moveKey(m));
    b.innerHTML = m.kind === 'rotate'
      ? icon(m.dir === 'CCW' ? 'rotCCW' : 'rotCW')
      : `<span class="op-sl">${m.dir === 'forward' ? '−' : '＋'}</span>`;
    const desc = describeMove(m);
    b.title = ok ? desc : `${desc}\n（直前の操作の逆操作のため禁止）`;
    b.setAttribute('aria-label', ok ? desc : `${desc}（禁止）`);
    b.setAttribute('aria-pressed', 'false');
    if (!ok) {
      b.disabled = true;
      b.classList.add('forbidden');
    } else {
      b.addEventListener('pointerenter', e => { if (!this.busy && e.pointerType !== 'touch') this.emit({ type: 'hoverMove', move: m }); });
      b.addEventListener('pointerleave', () => this.emit({ type: 'hoverMove', move: null }));
      b.addEventListener('focus', () => { if (!this.busy) this.emit({ type: 'hoverMove', move: m }); });
      b.addEventListener('blur', () => this.emit({ type: 'hoverMove', move: null }));
      b.addEventListener('click', () => { if (!this.busy) this.emit({ type: 'selectMove', move: m }); });
    }
    this.moveBtns.set(moveKey(m), { btn: b, move: m });
    return b;
  }

  private confirmCard(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'card confirm-card';
    el.innerHTML = `
      <div class="sel-label empty">↑ 操作を選んでください</div>
      <div class="outcome" hidden></div>
      <div class="confirm-row">
        <button type="button" class="btn ok big" data-act="confirm">${icon('check')}確定<kbd>Enter</kbd></button>
        <button type="button" class="btn ghost" data-act="cancel">取消<kbd>Esc</kbd></button>
      </div>`;
    this.selLabel = el.querySelector<HTMLElement>('.sel-label');
    this.outcomeEl = el.querySelector<HTMLElement>('.outcome');
    this.confirmBtn = el.querySelector<HTMLButtonElement>('[data-act="confirm"]');
    this.cancelBtn = el.querySelector<HTMLButtonElement>('[data-act="cancel"]');
    this.confirmBtn?.addEventListener('click', () => { if (!this.busy && this.selected) this.emit({ type: 'confirm' }); });
    this.cancelBtn?.addEventListener('click', () => { if (!this.busy) this.emit({ type: 'cancel' }); });
    return el;
  }

  private resultCard(v: ControlsView): HTMLElement {
    const el = document.createElement('section');
    el.className = 'card result-card';
    el.innerHTML = `<p class="lead">${v.resultText ?? '対局終了'}</p>
      <div class="col-btns">
        <button type="button" class="btn primary" data-act="result">${icon('trophy')}結果を表示</button>
        <button type="button" class="btn" data-act="replay">${icon('refresh')}もう一度</button>
        <button type="button" class="btn ghost" data-act="title">${icon('home')}タイトルへ</button>
      </div>`;
    el.querySelector('[data-act="result"]')?.addEventListener('click', () => this.emit({ type: 'showResult' }));
    el.querySelector('[data-act="replay"]')?.addEventListener('click', () => this.emit({ type: 'replay' }));
    el.querySelector('[data-act="title"]')?.addEventListener('click', () => this.emit({ type: 'title' }));
    return el;
  }

  private footCard(v: ControlsView): HTMLElement {
    const el = document.createElement('section');
    el.className = 'card foot-card';
    const items = v.log.length
      ? v.log.map(e => this.logItem(e)).join('')
      : '<li class="empty">まだ記録はありません</li>';
    el.innerHTML = `
      <button type="button" class="btn" data-act="undo">${icon('undo')}一手戻す<kbd>U</kbd></button>
      <details class="log"${this.logOpen ? ' open' : ''}>
        <summary>${icon('list')}棋譜<span class="n">${v.log.length}</span></summary>
        <ol>${items}</ol>
      </details>`;
    this.undoBtn = el.querySelector<HTMLButtonElement>('[data-act="undo"]');
    this.undoBtn?.addEventListener('click', () => { if (!this.busy) this.emit({ type: 'undo' }); });
    const det = el.querySelector('details');
    const ol = el.querySelector('ol');
    const toBottom = (): void => { if (ol) ol.scrollTop = ol.scrollHeight; };
    det?.addEventListener('toggle', () => {
      this.logOpen = det.open;
      if (det.open) toBottom();
    });
    if (this.logOpen) requestAnimationFrame(toBottom);
    return el;
  }

  private logItem(e: LogEntry): string {
    const P = PLAYER_COLORS[e.player];
    const res = e.result && e.result !== 'playing'
      ? `<span class="lg-res">${e.result === 'draw' ? '引分' : '決着'}</span>` : '';
    const cube = e.cube ? `<span class="chip ax-${e.cube.axis.toLowerCase()}">${shortMove(e.cube)}</span>` : '';
    return `<li><span class="lg-n">${e.ply}</span><span class="lg-p ${e.player.toLowerCase()}">${P.glyph}</span>`
      + `<span class="lg-s">${describeStep1(e.step1)}</span>${cube}${res}</li>`;
  }

  // ── In-place updates ─────────────────────────────────────────────────────
  setSelected(m: CubeMove | null): void {
    this.selected = m;
    this.applySelected();
  }

  /** Text under the grid: which move is previewed/selected and (optionally) its outcome. */
  setPreviewInfo(move: CubeMove | null, outcome: Outcome | null): void {
    const L = this.selLabel, O = this.outcomeEl;
    if (!L || !O) return;
    if (!move) {
      L.className = 'sel-label empty';
      L.textContent = '↑ 操作を選んでください';
      O.hidden = true;
      return;
    }
    const isSel = !!this.selected && movesEqual(move, this.selected);
    L.className = `sel-label ax-${move.axis.toLowerCase()}`;
    L.innerHTML = `<span class="sel-tag">${isSel ? '選択中' : 'プレビュー'}</span><span class="sel-desc">${describeMove(move)}</span>`;
    if (outcome) {
      const [cls, text] = OUTCOME_TEXT[outcome];
      O.hidden = false;
      O.className = `outcome ${cls}`;
      O.textContent = text;
    } else {
      O.hidden = true;
    }
  }

  setBusy(b: boolean): void {
    this.busy = b;
    this.applyBusy();
  }

  private applySelected(): void {
    for (const { btn, move } of this.moveBtns.values()) {
      const on = !!this.selected && movesEqual(this.selected, move);
      btn.classList.toggle('selected', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    if (this.confirmBtn) this.confirmBtn.disabled = !this.selected || this.busy;
    if (this.cancelBtn) this.cancelBtn.disabled = !this.selected || this.busy;
  }

  private applyBusy(): void {
    this.container.classList.toggle('busy', this.busy);
    for (const { btn } of this.moveBtns.values()) {
      if (!btn.classList.contains('forbidden')) btn.disabled = this.busy;
    }
    if (this.undoBtn) this.undoBtn.disabled = this.busy || !this.canUndo;
    this.applySelected();
  }
}

function rot(axis: Axis, layer: Layer, dir: 'CW' | 'CCW'): CubeMove {
  return { kind: 'rotate', axis, layer, dir };
}
