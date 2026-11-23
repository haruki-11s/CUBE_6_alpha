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
  /** 取消: take back this turn's step ① (placement or move) and do it again. */
  | { type: 'cancel' }
  | { type: 'peekLast'; on: boolean }
  | { type: 'deselectPiece' }
  | { type: 'showResult' }
  /** 「盤面を確認する」 after 詰み. */
  | { type: 'review' }
  /** 「誤審の訂正」: play on from the 詰み position. */
  | { type: 'playOn' }
  | { type: 'nextLevel' }
  | { type: 'replay' }
  | { type: 'title' };

export interface ControlsView {
  state: GameState;
  phase: 'step1' | 'step1-move-from' | 'step2';
  selectedFrom: number | null;
  canPlace: boolean;
  /** "配置" or "移動" — what step ① of this turn is / was. */
  step1Label: string;
  log: LogEntry[];
  resultText?: string;
  /** Lost to 詰み: the final board can be reviewed (「盤面を確認する」). */
  canReview?: boolean;
  /** The board is being reviewed: cube moves are previewed only, with 「誤審の訂正」. */
  reviewing?: boolean;
  /** CPU games: there is a stronger level to go on to. */
  nextLevel?: boolean;
  /** Display names ("PLAYER 1" / "あなた" / "CPU"). */
  names: Readonly<Record<Player, string>>;
  /** CPU games: the CPU's side, its strength label and whether it is acting now. */
  cpu: { side: Player; label: string; acting: boolean } | null;
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
 * (Whose turn it is, the hands and the clocks are in the top bar.)
 */
export class Controls {
  onEvent?: (e: ControlEvent) => void;

  private readonly moveBtns = new Map<string, { btn: HTMLButtonElement; move: CubeMove }>();
  private selLabel: HTMLElement | null = null;
  private outcomeEl: HTMLElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private selected: CubeMove | null = null;
  private busy = false;
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
    this.confirmBtn = this.cancelBtn = null;
    this.cpuActing = !!v.cpu?.acting && s.status === 'playing';
    this.cpuSide = v.cpu?.side ?? null;
    this.container.classList.toggle('cpu-acting', this.cpuActing);

    if (s.status !== 'playing') {
      this.container.appendChild(v.reviewing ? this.reviewCard() : this.resultCard(v));
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
    let html = `<div class="card-title"><span class="step-no">1</span>${v.step1Label}</div>`;
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
    el.innerHTML = '<div class="card-title"><span class="step-no">2</span>キューブ操作</div>';
    el.appendChild(this.opGrid());
    if (v.check) {
      const n = v.check.escapes;
      el.querySelector('.card-title')?.insertAdjacentHTML('afterend', `<div class="check-note" role="alert"><b>王手！</b>${v.names[v.check.by]}の列を崩す操作を選んでください。${n !== null ? `<span class="check-n">崩せる操作 ${n}通り</span>` : ''}</div>`);
    }
    return el;
  }

  /** The 24 cube moves: 3 axes × (3 layers × 2 directions + 2 slides), with the legend. */
  private opGrid(): HTMLElement {
    const wrap = div('op-wrap');
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
    wrap.appendChild(grid);
    wrap.insertAdjacentHTML('beforeend', `<div class="op-legend">
      <span>${icon('rotCCW')}${icon('rotCW')}＋側から見た回転</span><span><b>−</b><b>＋</b>繰越の向き</span></div>`);
    return wrap;
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
        <button type="button" class="btn ghost" data-act="cancel" title="①の配置／移動を取り消して、やり直します">${icon('undo')}取消<kbd>Esc</kbd></button>
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
    el.innerHTML = `<p class="result-lead">${v.resultText ?? '対局終了'}</p>
      <div class="col-btns">
        <button type="button" class="btn primary" data-act="result">${icon('trophy')}結果を表示</button>
        ${v.canReview ? `<button type="button" class="btn ok" data-act="review">${icon('eye')}盤面を確認する</button>` : ''}
        <button type="button" class="btn" data-act="replay">${icon('refresh')}もう一度</button>
        ${v.nextLevel ? `<button type="button" class="btn" data-act="next">${icon('next')}次のレベル</button>` : ''}
        <button type="button" class="btn ghost" data-act="title">${icon('home')}タイトルへ</button>
      </div>`;
    el.querySelector('[data-act="result"]')?.addEventListener('click', () => this.emit({ type: 'showResult' }));
    el.querySelector('[data-act="review"]')?.addEventListener('click', () => this.emit({ type: 'review' }));
    el.querySelector('[data-act="replay"]')?.addEventListener('click', () => this.emit({ type: 'replay' }));
    el.querySelector('[data-act="next"]')?.addEventListener('click', () => this.emit({ type: 'nextLevel' }));
    el.querySelector('[data-act="title"]')?.addEventListener('click', () => this.emit({ type: 'title' }));
    return el;
  }

  /** 「盤面を確認する」: preview any cube move on the final board; 「誤審の訂正」 plays on. */
  private reviewCard(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'card review-card';
    el.innerHTML = `<div class="card-title">${icon('eye')}盤面を確認中</div>
      <p class="lead">操作を選ぶと、その操作のあとの盤面を確認できます。<small>対局は進みません。</small></p>`;
    el.appendChild(this.opGrid());
    el.insertAdjacentHTML('beforeend', `
      <div class="sel-label empty">↑ 操作を選んでください</div>
      <div class="outcome" hidden></div>
      <div class="misjudge">
        <button type="button" class="btn ok" data-act="play-on">${icon('flag')}誤審の訂正</button>
        <p>誤審である場合は、このボタンを押すことでゲームを続行できます。</p>
      </div>
      <button type="button" class="btn ghost" data-act="result">${icon('trophy')}結果に戻る</button>`);
    this.selLabel = el.querySelector<HTMLElement>('.sel-label');
    this.outcomeEl = el.querySelector<HTMLElement>('.outcome');
    el.querySelector('[data-act="play-on"]')?.addEventListener('click', () => this.emit({ type: 'playOn' }));
    el.querySelector('[data-act="result"]')?.addEventListener('click', () => this.emit({ type: 'showResult' }));
    return el;
  }

  private footCard(v: ControlsView): HTMLElement {
    const el = document.createElement('section');
    el.className = 'card foot-card';
    const items = v.log.length
      ? v.log.map(e => this.logItem(e)).join('')
      : '<li class="empty">まだ記録はありません</li>';
    el.innerHTML = `
      <details class="log"${this.logOpen ? ' open' : ''}>
        <summary>${icon('list')}棋譜<span class="n">${v.log.length}</span></summary>
        <ol>${items}</ol>
      </details>`;
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
    // 取消 goes back to step ①, so it works whether or not a move is picked
    if (this.cancelBtn) this.cancelBtn.disabled = this.busy;
  }

  private applyBusy(): void {
    this.container.classList.toggle('busy', this.busy);
    for (const { btn } of this.moveBtns.values()) btn.disabled = this.busy;
    this.applySelected();
  }
}

function rot(axis: Axis, layer: Layer, dir: 'CW' | 'CCW'): CubeMove {
  return { kind: 'rotate', axis, layer, dir };
}
