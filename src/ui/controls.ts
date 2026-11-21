import type { Axis, CubeMove, GameState, Layer, Player } from '../core/types';
import { moveKey, movesEqual } from '../core/cube';
import { describeMove, shortMove, describeStep1, cellName, layerHint } from '../core/notation';
import type { LogEntry } from '../core/save';
import { PLAYER_COLORS } from './theme';
import { icon } from './icons';

/** What a previewed cube move would do, from the mover's side. */
export type Outcome = 'mate' | 'check' | 'escape' | 'notBroken' | 'self' | 'limit';

/** One player's clock as shown: running / low / on 秒読み / waiting. */
export interface ClockFace { text: string; state: 'idle' | 'run' | 'low' | 'byo' }

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
  /** Display names ("〇（青）" / "あなた" / "CPU"). */
  names: Readonly<Record<Player, string>>;
  /** CPU games: the CPU's side, its strength label and whether it is acting now. */
  cpu: { side: Player; label: string; acting: boolean } | null;
  /** Games on a clock: each player's clock (kept live with setClocks). */
  clock: Readonly<Record<Player, ClockFace>> | null;
  /** Why 待った is unavailable in this game (button tooltip). */
  undoNote?: string;
  /** The player to move is in check (王手): who checks, and (hints on) how many cube moves break it. */
  check: { by: Player; escapes: number | null } | null;
}

const AXES: readonly Axis[] = ['X', 'Y', 'Z'];
const OUTCOME_TEXT: Readonly<Record<Outcome, [string, string]>> = {
  mate: ['win', '★ 詰み！ 相手はこの列を崩せません（勝利）'],
  check: ['check', '◆ 王手！ 相手はこの列を崩す必要があります'],
  escape: ['escape', '✓ 相手の列を崩せます'],
  notBroken: ['self', '⚠ 相手の列が残ります（負け）'],
  self: ['self', '⚠ 相手の列が揃います（自爆負け）'],
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
  private cpuActing = false;
  private cpuSide: Player | null = null;

  constructor(private readonly container: HTMLElement) {}

  private emit(e: ControlEvent): void { this.onEvent?.(e); }

  render(v: ControlsView): void {
    const s = v.state;
    this.container.innerHTML = '';
    this.moveBtns.clear();
    this.selLabel = this.outcomeEl = null;
    this.confirmBtn = this.cancelBtn = this.undoBtn = null;
    this.canUndo = v.canUndo;
    this.cpuActing = !!v.cpu?.acting && s.status === 'playing';
    this.cpuSide = v.cpu?.side ?? null;
    this.container.classList.toggle('cpu-acting', this.cpuActing);

    this.container.appendChild(this.turnCard(v));
    if (s.status !== 'playing') {
      this.container.appendChild(this.resultCard(v));
    } else if (v.phase === 'step2') {
      this.container.appendChild(this.opCard(v));
      this.container.appendChild(this.cpuActing ? this.cpuMoveCard() : this.confirmCard());
    } else if (this.cpuActing && v.cpu) {
      this.container.appendChild(this.cpuThinkCard(v.cpu.label));
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
    const thinking = this.cpuActing && step1;
    const el = document.createElement('section');
    el.className = `card turn-card${this.cpuActing ? ' cpu' : ''}`;
    el.innerHTML = `
      <div class="tc-row">
        <span class="tc-chip ${over ? 'end' : s.current.toLowerCase()}">${over ? icon('trophy') : P.glyph}</span>
        <div class="tc-who">
          <div class="tc-name">${over ? '対局終了' : `${v.names[s.current]}の番`}${v.check && !over ? '<span class="tc-check">王手</span>' : ''}${thinking ? '<span class="think-dots" aria-label="考え中"><i></i><i></i><i></i></span>' : ''}</div>
          <div class="tc-sub">手数 ${s.ply}${s.settings.turnLimit ? ` / ${s.settings.turnLimit}` : ''}${v.cpu ? `<span class="tc-vs">VS ${v.cpu.label}</span>` : ''}</div>
        </div>
      </div>
      ${over ? '' : `<ol class="stepper" aria-label="手番の進行">
        <li class="${step1 ? 'on' : 'done'}"><b>1</b>${v.step1Label}</li>
        <li class="${step1 ? '' : 'on'}"><b>2</b>キューブ操作</li>
      </ol>`}
      <div class="hands">${(['O', 'X'] as const).map(p => this.handRow(p, s, v.cpu ? v.names[p] : '', v.clock?.[p] ?? null)).join('')}</div>`;
    return el;
  }

  private handRow(p: Player, s: GameState, name: string, clock: ClockFace | null): string {
    const n = s.hand[p];
    const P = PLAYER_COLORS[p];
    const dots = Array.from({ length: 6 }, (_, i) => `<i class="${i < n ? 'in' : ''}"></i>`).join('');
    const cur = s.current === p && s.status === 'playing';
    return `<div class="hand ${p.toLowerCase()}${cur ? ' cur' : ''}" title="${name || P.label} 手駒 ${n}／6">
      <span class="hand-sym">${P.glyph}</span>${name ? `<span class="hand-name">${name}</span>` : ''}<span class="dots">${dots}</span>
      <span class="hand-n">${n > 0 ? `手駒 ${n}` : '移動フェーズ'}</span>${clock
        ? `<span class="hand-clock ${clock.state}" data-clock="${p}" title="持ち時間">${icon('timer')}<b>${clock.text}</b></span>`
        : ''}</div>`;
  }

  private cpuThinkCard(label: string): HTMLElement {
    const el = document.createElement('section');
    el.className = 'card info-card cpu-card';
    el.innerHTML = `<div class="cpu-think"><span class="cpu-orb" aria-hidden="true"></span>
      <div><b>CPU が考えています</b><span class="think-dots"><i></i><i></i><i></i></span>
      <small>${label}</small></div></div>`;
    return el;
  }

  private cpuMoveCard(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'card confirm-card cpu-move';
    el.innerHTML = `
      <div class="sel-label empty">CPU が操作を選んでいます<span class="think-dots"><i></i><i></i><i></i></span></div>
      <div class="outcome" hidden></div>`;
    this.selLabel = el.querySelector<HTMLElement>('.sel-label');
    this.outcomeEl = el.querySelector<HTMLElement>('.outcome');
    return el;
  }

  private step1Card(v: ControlsView): HTMLElement {
    const s = v.state;
    const el = document.createElement('section');
    el.className = 'card info-card';
    let html = '';
    if (v.check) {
      html += `<div class="check-note" role="alert"><b>王手！</b>${v.names[v.check.by]}の列が揃っています。①のあと、②の操作でこの列を崩してください。</div>`;
    }
    if (v.canPlace) {
      html += '<p class="lead">光っている<b>空きマス</b>を選んで駒を置きます。<br><small>3D・見取り図のどちらでも選べます。</small></p>';
    } else if (v.selectedFrom === null) {
      html += '<p class="lead">手駒を使い切りました。<b>動かす自分の駒</b>を選んでください。</p>';
    } else {
      html += `<p class="lead">移動先の<b>空きマス</b>を選んでください。</p>
        <div class="sel-piece"><span>選択中 <b>${cellName(v.selectedFrom)}</b></span>
        <button type="button" class="btn sm ghost" data-act="deselect">選び直す<kbd>Esc</kbd></button></div>`;
    }
    if (s.lastCubeMove) {
      const lm = s.lastCubeMove;
      html += `<div class="last-move" tabindex="0" role="note" aria-label="相手の直前の操作">
        <div class="lm-row"><span class="lm-k">相手の直前の操作</span><span class="chip ax-${lm.axis.toLowerCase()}">${shortMove(lm)}</span></div>
        <div class="lm-desc">${describeMove(lm)}</div>
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

  private opCard(v: ControlsView): HTMLElement {
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
        cell.append(this.moveBtn(rot(a, layer, 'CCW')), this.moveBtn(rot(a, layer, 'CW')));
        grid.appendChild(cell);
      }
    }
    grid.appendChild(div('op-row', '繰越'));
    for (const a of AXES) {
      const cell = div(`op-cell ax-${a.toLowerCase()}`);
      cell.title = `${a}軸方向へ盤全体を1マスずらす`;
      cell.append(
        this.moveBtn({ kind: 'slide', axis: a, dir: 'forward' }),
        this.moveBtn({ kind: 'slide', axis: a, dir: 'backward' }),
      );
      grid.appendChild(cell);
    }
    el.appendChild(grid);
    el.insertAdjacentHTML('beforeend', `<div class="op-legend">
      <span>${icon('rotCCW')}${icon('rotCW')}＋側から見た回転</span><span><b>−</b><b>＋</b>繰越の向き</span></div>`);
    if (v.check) {
      const n = v.check.escapes;
      el.insertAdjacentHTML('afterbegin', `<div class="check-note" role="alert"><b>王手！</b>${v.names[v.check.by]}の列を崩す操作を選んでください。${n !== null ? `<span class="check-n">崩せる操作 ${n}通り</span>` : ''}</div>`);
    }
    return el;
  }

  private moveBtn(m: CubeMove): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-btn';
    b.innerHTML = m.kind === 'rotate'
      ? icon(m.dir === 'CCW' ? 'rotCCW' : 'rotCW')
      : `<span class="op-sl">${m.dir === 'forward' ? '−' : '＋'}</span>`;
    const desc = describeMove(m);
    b.title = desc;
    b.setAttribute('aria-label', desc);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('pointerenter', e => { if (!this.busy && e.pointerType !== 'touch') this.emit({ type: 'hoverMove', move: m }); });
    b.addEventListener('pointerleave', () => this.emit({ type: 'hoverMove', move: null }));
    b.addEventListener('focus', () => { if (!this.busy) this.emit({ type: 'hoverMove', move: m }); });
    b.addEventListener('blur', () => this.emit({ type: 'hoverMove', move: null }));
    b.addEventListener('click', () => { if (!this.busy) this.emit({ type: 'selectMove', move: m }); });
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
      <button type="button" class="btn" data-act="undo" title="${v.undoNote ?? (this.cpuSide ? 'CPUの手も含めて、自分の直前の操作まで戻します' : '直前の操作を取り消します')}">${icon('undo')}${this.cpuSide ? '待った' : '一手戻す'}<kbd>U</kbd></button>
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
    const who = this.cpuSide ? `<span class="lg-who">${e.player === this.cpuSide ? 'CPU' : 'あなた'}</span>` : '';
    const res = e.result && e.result !== 'playing'
      ? `<span class="lg-res">${e.result === 'draw' ? '引分' : '決着'}</span>` : '';
    const cube = e.cube ? `<span class="chip ax-${e.cube.axis.toLowerCase()}">${shortMove(e.cube)}</span>` : '';
    return `<li><span class="lg-n">${e.ply}</span><span class="lg-p ${e.player.toLowerCase()}">${P.glyph}</span>${who}`
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
      if (this.cpuActing) return; // keep "CPU が操作を選んでいます…"
      L.className = 'sel-label empty';
      L.textContent = '↑ 操作を選んでください';
      O.hidden = true;
      return;
    }
    const isSel = !!this.selected && movesEqual(move, this.selected);
    const tag = this.cpuActing ? 'CPU の操作' : isSel ? '選択中' : 'プレビュー';
    L.className = `sel-label ax-${move.axis.toLowerCase()}`;
    L.innerHTML = `<span class="sel-tag">${tag}</span><span class="sel-desc">${describeMove(move)}</span>`;
    if (outcome) {
      const [cls, text] = OUTCOME_TEXT[outcome];
      O.hidden = false;
      O.className = `outcome ${cls}`;
      O.textContent = text;
    } else {
      O.hidden = true;
    }
  }

  /** Live clock update without rebuilding the panel. */
  setClocks(faces: Readonly<Record<Player, ClockFace>>): void {
    for (const p of ['O', 'X'] as const) {
      const el = this.container.querySelector<HTMLElement>(`[data-clock="${p}"]`);
      if (!el) continue;
      const f = faces[p];
      const cls = `hand-clock ${f.state}`;
      if (el.className !== cls) el.className = cls;
      const b = el.querySelector('b');
      if (b && b.textContent !== f.text) b.textContent = f.text;
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
    for (const { btn } of this.moveBtns.values()) btn.disabled = this.busy;
    if (this.undoBtn) this.undoBtn.disabled = this.busy || !this.canUndo;
    this.applySelected();
  }
}

function rot(axis: Axis, layer: Layer, dir: 'CW' | 'CCW'): CubeMove {
  return { kind: 'rotate', axis, layer, dir };
}
