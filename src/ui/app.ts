import { Scene3D, type ViewPreset } from './scene3d';
import { Schematic, type SchematicState } from './schematic';
import { Controls, type ControlEvent, type Outcome } from './controls';
import {
  initialGameState, legalPlacements, legalCubeMoves, allCubeMoves,
  applyStep1Place, applyStep1Move, resolveAfterCubeMove, checkStep1Win,
  applyCubeMove, movePermutation, movesEqual, completedLines,
} from '../core/game';
import { parseSave, type LogEntry, type SaveData, type SavedPhase, type Snapshot } from '../core/save';
import type { Line } from '../core/lines';
import type { CubeMove, GameState, Mark, Player } from '../core/types';
import { sound } from './sound';
import { loadSettings, saveSettings, SPEED_MULT, TURN_LIMITS, type Settings, type AnimSpeed, type FirstPlayer } from './settings';
import { setAnimSpeed, wait } from './tween';
import { openModal, isModalOpen, type ModalHandle } from './modal';
import { icon } from './icons';
import { rulesHTML } from './rules';
import { APP_VERSION, PLAYER_COLORS, other } from './theme';

type Phase = SavedPhase;

interface GameUI {
  el: HTMLElement;
  scene: Scene3D;
  schematic: Schematic;
  controls: Controls;
  hint: HTMLElement;
  banner: HTMLElement;
  toasts: HTMLElement;
  live: HTMLElement;
  pill: HTMLElement;
  topRO: ResizeObserver;
}

// ── App state ──────────────────────────────────────────────────────────────
let root: HTMLElement;
let settings: Settings = loadSettings();
let ui: GameUI | null = null;
let title: { stop: () => void } | null = null;

let gs: GameState = initialGameState();
let phase: Phase = 'step1';
let selectedFrom: number | null = null;
let lastMoved: number | null = null;
let log: LogEntry[] = [];
let history: Snapshot[] = [];
let busy = false;
let hoverMove: CubeMove | null = null;
let selectedMove: CubeMove | null = null;
let peekLast = false;
let resultModal: ModalHandle | null = null;

let elapsed = 0;
let clockStart = 0;
let clockRunning = false;

const SAVE_KEY = 'cube6-save';
const HISTORY_MAX = 80;

// ── Persistence ────────────────────────────────────────────────────────────
function snapshot(): Snapshot {
  return structuredClone({ gameState: gs, phase, selectedFrom, lastMoved, log });
}

function persist(): void {
  if (gs.status !== 'playing') { clearSave(); return; }
  const data: SaveData = { v: 2, ...snapshot(), history: history.slice(-HISTORY_MAX), elapsed: currentElapsed() };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* quota / private mode */ }
}

function readSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? parseSave(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function clearSave(): void {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

// ── Clock (active play time only) ──────────────────────────────────────────
function clockOn(): void {
  if (!clockRunning && gs.status === 'playing') { clockStart = performance.now(); clockRunning = true; }
}
function clockOff(): void {
  if (clockRunning) { elapsed += performance.now() - clockStart; clockRunning = false; }
}
function currentElapsed(): number {
  return elapsed + (clockRunning ? performance.now() - clockStart : 0);
}
function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Settings ───────────────────────────────────────────────────────────────
function applySettings(): void {
  sound.configure(settings.sound, settings.volume);
  setAnimSpeed(SPEED_MULT[settings.animSpeed]);
  if (ui) {
    ui.scene.setShowSymbols(settings.showSymbols);
    ui.scene.setExplode(settings.explode);
    syncTopButtons();
    updatePreview();
  }
}

function setSetting<K extends keyof Settings>(k: K, v: Settings[K]): void {
  settings = { ...settings, [k]: v };
  saveSettings(settings);
  applySettings();
}

// ═══════════════════════════════ Title screen ══════════════════════════════

function renderTitle(): void {
  teardownGame();
  teardownTitle();
  const save = readSave();
  const resumeInfo = save
    ? `${PLAYER_COLORS[save.gameState.current].symbol}の番・${save.gameState.ply + 1}手目`
    : '';
  root.innerHTML = `
    <div class="title">
      <div class="title-stage" id="title-stage"></div>
      <div class="title-vignette"></div>
      <div class="title-ui">
        <div class="logo-wrap">
          <h1 class="logo" aria-label="CUBE 6"><span class="logo-word">CUBE</span><span class="logo-six">6</span></h1>
          <p class="subtitle">可変式立体マルバツゲーム</p>
        </div>
        <nav class="menu" aria-label="メニュー">
          <button type="button" class="menu-btn primary" data-act="start"><span>${icon('play')}ゲーム開始</span><small>NEW GAME</small></button>
          ${save ? `<button type="button" class="menu-btn resume" data-act="resume"><span>${icon('resume')}続きから</span><small>${resumeInfo}</small></button>` : ''}
          <button type="button" class="menu-btn" data-act="rules"><span>${icon('help')}ルール説明</span><small>HOW TO PLAY</small></button>
          <button type="button" class="menu-btn" data-act="settings"><span>${icon('sliders')}設定</span><small>SETTINGS</small></button>
        </nav>
      </div>
      <footer class="title-foot">alpha ver.${APP_VERSION} ・ ローカル2人対戦 ・ 3×3×3 / 49ライン</footer>
    </div>`;

  root.querySelectorAll<HTMLButtonElement>('.menu-btn').forEach(b => {
    b.addEventListener('pointerenter', () => sound.hover());
    b.addEventListener('click', () => {
      sound.click();
      const act = b.dataset['act'];
      if (act === 'start') requestNewGame();
      else if (act === 'resume') resumeGame();
      else if (act === 'rules') showRules();
      else if (act === 'settings') showSettings();
    });
  });
  startTitleDemo(root.querySelector('#title-stage') as HTMLElement);
}

/** Attract mode: a real Scene3D playing random placements and cube moves. */
function startTitleDemo(host: HTMLElement): void {
  let scene: Scene3D;
  try {
    scene = new Scene3D(host, { demo: true });
  } catch {
    host.classList.add('no-webgl');
    return;
  }
  let stopped = false;
  title = { stop: () => { stopped = true; scene.dispose(); } };
  void (async () => {
    let board: Mark[] = Array<Mark>(27).fill(null);
    let cur: Player = 'O';
    let pieces = 0;
    await wait(500);
    while (!stopped) {
      const empties = board.map((m, i) => (m === null ? i : -1)).filter(i => i >= 0);
      if (pieces < 9 && (pieces < 4 || Math.random() < 0.55)) {
        const i = empties[Math.floor(Math.random() * empties.length)];
        board = board.slice();
        board[i] = cur;
        await scene.animatePlace(i, cur);
        cur = other(cur);
        pieces++;
      } else {
        const moves = allCubeMoves();
        const m = moves[Math.floor(Math.random() * moves.length)];
        const next = applyCubeMove(board, m);
        if (m.kind === 'rotate') await scene.animateRotate(m, next);
        else await scene.animateSlide(m, next);
        board = next;
      }
      if (stopped) break;
      if (pieces >= 9 && Math.random() < 0.2) {
        await wait(600);
        if (stopped) break;
        await scene.clearBoardAnimated();
        board = Array<Mark>(27).fill(null);
        pieces = 0;
      }
      await wait(650 + Math.random() * 450);
    }
  })().catch(() => { /* disposed mid-animation */ });
}

function teardownTitle(): void {
  title?.stop();
  title = null;
}

// ═══════════════════════════════ Game screen ═══════════════════════════════

function requestNewGame(): void {
  if (readSave()) {
    openModal({
      title: '新しいゲーム',
      content: '<p>保存されている対局があります。<br>新しく始めると上書きされます。</p>',
      actions: [
        { label: 'キャンセル', kind: 'ghost' },
        { label: '新しく始める', kind: 'primary', onClick: () => { startGame(); } },
      ],
    });
  } else {
    startGame();
  }
}

function startGame(): void {
  const first: Player = settings.firstPlayer === 'random' ? (Math.random() < 0.5 ? 'O' : 'X') : settings.firstPlayer;
  gs = { ...initialGameState(), current: first, settings: { turnLimit: settings.turnLimit } };
  phase = 'step1';
  selectedFrom = null;
  lastMoved = null;
  log = [];
  history = [];
  elapsed = 0;
  clockRunning = false;
  clearSave();
  if (!renderGame()) return;
  clockOn();
  sound.start();
  setTimeout(() => announceTurn(), 300);
}

function resumeGame(): void {
  const s = readSave();
  if (!s) { startGame(); return; }
  gs = s.gameState;
  phase = s.phase;
  selectedFrom = s.selectedFrom;
  lastMoved = s.lastMoved;
  log = s.log;
  history = s.history;
  elapsed = s.elapsed;
  clockRunning = false;
  if (!renderGame()) return;
  clockOn();
  setTimeout(() => announceTurn(), 250);
}

function renderGame(): boolean {
  teardownTitle();
  teardownGame();
  busy = false;
  hoverMove = null;
  selectedMove = null;
  peekLast = false;

  root.innerHTML = `
    <div class="game" data-turn="${gs.current}">
      <header class="topbar">
        <button type="button" class="brand" data-act="home" title="タイトルへ">CUBE<b>6</b></button>
        <div class="turn-pill" id="turn-pill"></div>
        <div class="top-actions">
          <button type="button" class="icon-btn" data-act="symbols" title="刻印表示：球に ○× を表示 (S)">${icon('symbols')}</button>
          <button type="button" class="icon-btn" data-act="sound" title="サウンド (M)"></button>
          <button type="button" class="icon-btn" data-act="settings" title="設定">${icon('sliders')}</button>
          <button type="button" class="icon-btn" data-act="help" title="ルール (H)">${icon('help')}</button>
          <button type="button" class="icon-btn" data-act="pause" title="中断してタイトルへ">${icon('pause')}</button>
        </div>
      </header>
      <aside class="side schematic-panel" id="schematic" aria-label="見取り図"></aside>
      <main class="stage" id="stage">
        <div class="stage-hint" id="hint" role="status"></div>
        <div class="toast-host" id="toasts" aria-live="polite"></div>
        <div class="turn-banner" id="banner" aria-hidden="true"></div>
        <div class="stage-tools" role="toolbar" aria-label="視点">
          <div class="seg-tools">
            <button type="button" class="tool-btn" data-view="iso" title="斜め (1 / R)">斜め</button>
            <button type="button" class="tool-btn" data-view="front" title="正面 (2)">正面</button>
            <button type="button" class="tool-btn" data-view="top" title="真上 (3)">真上</button>
            <button type="button" class="tool-btn" data-view="side" title="側面 (4)">側面</button>
          </div>
          <div class="seg-tools">
            <button type="button" class="tool-btn icon" data-act="explode" title="展開表示：層の間隔を広げる (V)">${icon('expand')}</button>
            <button type="button" class="tool-btn icon" data-act="zoom-in" title="ズームイン (+)">${icon('zoomIn')}</button>
            <button type="button" class="tool-btn icon" data-act="zoom-out" title="ズームアウト (−)">${icon('zoomOut')}</button>
          </div>
        </div>
        <div class="stage-help">ドラッグ：視点回転　ホイール／ピンチ：ズーム</div>
      </main>
      <aside class="side controls-panel" id="controls" aria-label="操作パネル"></aside>
      <div class="sr-only" id="live" aria-live="polite"></div>
    </div>`;

  const el = root.querySelector('.game') as HTMLElement;
  const stage = el.querySelector('#stage') as HTMLElement;
  let scene: Scene3D;
  try {
    scene = new Scene3D(stage);
  } catch (e) {
    console.error(e);
    stage.innerHTML = `<div class="no-webgl-msg">WebGL を利用できないため 3D 表示を開始できませんでした。<br>ブラウザの設定（ハードウェアアクセラレーション）をご確認ください。<br><button type="button" class="btn primary">${icon('home')}タイトルへ</button></div>`;
    stage.querySelector('button')?.addEventListener('click', () => renderTitle());
    return false;
  }
  const schematic = new Schematic(el.querySelector('#schematic') as HTMLElement);
  const controls = new Controls(el.querySelector('#controls') as HTMLElement);
  // mobile: the pinned board sits right under the (wrapping) top bar
  const topbar = el.querySelector('.topbar') as HTMLElement;
  const topRO = new ResizeObserver(() => el.style.setProperty('--top-h', `${topbar.offsetHeight}px`));
  topRO.observe(topbar);
  ui = {
    el, scene, schematic, controls, topRO,
    hint: el.querySelector('#hint') as HTMLElement,
    banner: el.querySelector('#banner') as HTMLElement,
    toasts: el.querySelector('#toasts') as HTMLElement,
    live: el.querySelector('#live') as HTMLElement,
    pill: el.querySelector('#turn-pill') as HTMLElement,
  };

  scene.onCellClick = (i, raw) => onCellClick(i, raw);
  scene.onCellHover = i => onCellHover(i);
  scene.pickFilter = i => isPickable(i);
  schematic.onCellClick = i => {
    sound.unlock();
    if (isPickable(i)) onCellClick(i, i);
    else onCellClick(null, i);
  };
  schematic.onCellHover = i => onCellHover(i !== null && isPickable(i) ? i : null);
  controls.onEvent = e => onControlEvent(e);

  el.querySelectorAll<HTMLButtonElement>('.top-actions .icon-btn, .brand').forEach(b => {
    b.addEventListener('click', () => {
      const act = b.dataset['act'];
      if (act === 'symbols') toggleSymbols();
      else if (act === 'sound') toggleSound();
      else if (act === 'settings') { sound.click(); showSettings(); }
      else if (act === 'help') { sound.click(); showRules(); }
      else if (act === 'pause' || act === 'home') { sound.click(); confirmQuit(); }
    });
  });
  el.querySelectorAll<HTMLButtonElement>('.stage-tools .tool-btn').forEach(b => {
    b.addEventListener('click', () => {
      sound.click();
      const view = b.dataset['view'] as ViewPreset | undefined;
      if (view) scene.setView(view);
      const act = b.dataset['act'];
      if (act === 'explode') toggleExplode();
      else if (act === 'zoom-in') scene.zoomBy(0.85);
      else if (act === 'zoom-out') scene.zoomBy(1 / 0.85);
    });
  });

  applySettings();
  refresh();
  return true;
}

function teardownGame(): void {
  if (!ui) return;
  clockOff();
  persist();
  resultModal?.close();
  resultModal = null;
  ui.topRO.disconnect();
  ui.scene.dispose();
  ui = null;
}

function syncTopButtons(): void {
  if (!ui) return;
  const sym = ui.el.querySelector<HTMLButtonElement>('[data-act="symbols"]');
  sym?.setAttribute('aria-pressed', String(settings.showSymbols));
  const snd = ui.el.querySelector<HTMLButtonElement>('[data-act="sound"]');
  if (snd) {
    snd.innerHTML = icon(settings.sound ? 'soundOn' : 'soundOff');
    snd.setAttribute('aria-pressed', String(settings.sound));
    snd.setAttribute('aria-label', settings.sound ? 'サウンド：オン' : 'サウンド：オフ');
  }
  ui.el.querySelector('[data-act="explode"]')?.setAttribute('aria-pressed', String(settings.explode));
}

// ── Derived state ──────────────────────────────────────────────────────────
function canPlaceNow(): boolean { return legalPlacements(gs).length > 0; }

/** Label of step ① for the current turn ("配置" or "移動"). */
function step1Label(): string {
  if (phase === 'step2') {
    const last = log[log.length - 1];
    return last && last.step1.kind === 'move' ? '移動' : '配置';
  }
  return canPlaceNow() ? '配置' : '移動';
}

function targetsNow(): number[] {
  if (gs.status !== 'playing' || busy) return [];
  if (phase === 'step1') {
    return canPlaceNow()
      ? legalPlacements(gs)
      : gs.board.map((m, i) => (m === gs.current ? i : -1)).filter(i => i >= 0);
  }
  if (phase === 'step1-move-from' && selectedFrom !== null) {
    return gs.board.map((m, i) => (m === null ? i : -1)).filter(i => i >= 0);
  }
  return [];
}

function isPickable(i: number): boolean {
  if (busy || gs.status !== 'playing') return false;
  if (phase === 'step1') return canPlaceNow() ? gs.board[i] === null : gs.board[i] === gs.current;
  if (phase === 'step1-move-from') return gs.board[i] === null || gs.board[i] === gs.current;
  return false;
}

function winEntries(state: GameState): { line: Line; player: Player }[] {
  if (state.status === 'win:O' || state.status === 'win:X') {
    const p: Player = state.status === 'win:O' ? 'O' : 'X';
    return completedLines(state.board, p).map(line => ({ line, player: p }));
  }
  if (state.status === 'draw' && state.winReason === 'simultaneous') {
    return completedLines(state.board).map(line => ({ line, player: state.board[line[0]] as Player }));
  }
  return [];
}

function resultText(state: GameState): { title: string; reason: string; color: string } {
  if (state.status === 'win:O' || state.status === 'win:X') {
    const w: Player = state.status === 'win:O' ? 'O' : 'X';
    const reason = state.winReason === 'selfDestruct'
      ? `${PLAYER_COLORS[other(w)].label} のキューブ操作で相手の列が揃いました（自爆）`
      : `${PLAYER_COLORS[w].label} が一直線に3つ揃えました`;
    return { title: `${PLAYER_COLORS[w].label} の勝利！`, reason, color: PLAYER_COLORS[w].css };
  }
  const reason = state.winReason === 'simultaneous'
    ? '両者の列が同時に成立しました'
    : `手数上限（${state.settings.turnLimit ?? '-'}手）に達しました`;
  return { title: '引き分け', reason, color: '#ffcc4d' };
}

// ── Refresh (phase changes) ────────────────────────────────────────────────
function refresh(): void {
  if (!ui) return;
  const { scene, controls, el } = ui;
  // the panel is rebuilt below, so elements under the pointer won't fire "leave"
  hoverMove = null;
  peekLast = false;
  el.dataset['turn'] = gs.current;
  el.classList.toggle('over', gs.status !== 'playing');
  scene.setTurn(gs.current);
  scene.setBoard(gs.board);
  scene.setLastMoved(lastMoved);
  scene.setSelected(phase === 'step1-move-from' ? selectedFrom : null);
  scene.setTargets(targetsNow(), gs.current);
  scene.setLabelsVisible(phase === 'step2' && gs.status === 'playing');
  scene.setHover(null, null);
  if (gs.status === 'playing') scene.clearWin();
  controls.render({
    state: gs, phase, selectedFrom, canPlace: canPlaceNow(), step1Label: step1Label(), canUndo: history.length > 0, log,
    resultText: gs.status !== 'playing' ? resultText(gs).title : undefined,
  });
  controls.setBusy(busy);
  updatePreview();
  updateHint();
  updatePill();
  persist();
}

function schematicState(preview: SchematicState['preview'], guide: CubeMove | null): SchematicState {
  const win = gs.status !== 'playing' ? [...new Set(winEntries(gs).flatMap(e => e.line))] : [];
  return {
    board: gs.board,
    targets: targetsNow(),
    selected: phase === 'step1-move-from' ? selectedFrom : null,
    lastMoved,
    win,
    preview,
    guide,
  };
}

/** Cheap in-place update for hover / selection / peek changes. */
function updatePreview(): void {
  if (!ui) return;
  const { scene, schematic, controls } = ui;
  let move: CubeMove | null = null;
  let candidate = false;
  if (phase === 'step2' && gs.status === 'playing' && !busy) {
    move = hoverMove ?? selectedMove;
    candidate = move !== null;
  } else if (peekLast && gs.lastCubeMove && gs.status === 'playing' && !busy) {
    move = gs.lastCubeMove;
  }

  let outcome: Outcome | null = null;
  let lines: { line: Line; player: Player }[] = [];
  let after: Mark[] | null = null;
  if (candidate && move) {
    const res = resolveAfterCubeMove(gs, move);
    after = res.board;
    if (settings.showHints) {
      outcome = outcomeOf(res, gs.current);
      lines = completedLines(res.board).map(line => ({ line, player: res.board[line[0]] as Player }));
    }
  }
  scene.setCubeMovePreview(move, { lines, ghosts: candidate, muted: !candidate });
  schematic.update(schematicState(candidate && move && after ? { move, after } : null, move));
  controls.setSelected(selectedMove);
  controls.setPreviewInfo(candidate ? move : null, outcome);
}

function outcomeOf(res: GameState, mover: Player): Outcome | null {
  if (res.status === 'playing') return null;
  if (res.status === 'draw') return res.winReason === 'turnLimit' ? 'limit' : 'draw';
  return res.status === `win:${mover}` ? 'win' : 'self';
}

function updateHint(): void {
  if (!ui) return;
  const P = PLAYER_COLORS[gs.current];
  let text: string;
  if (gs.status !== 'playing') text = resultText(gs).title;
  else if (phase === 'step1') text = canPlaceNow() ? `${P.label}：光っている空きマスに駒を置く` : `${P.label}：動かす自分の駒を選ぶ`;
  else if (phase === 'step1-move-from') text = '移動先の空きマスを選ぶ（Esc で選び直し）';
  else text = `${P.label}：キューブ操作を選んで「確定」`;
  ui.hint.innerHTML = `<span class="dot"></span><span>${text}</span>`;
  ui.hint.classList.remove('pop');
  void ui.hint.offsetWidth;
  ui.hint.classList.add('pop');
}

function updatePill(): void {
  if (!ui) return;
  const P = PLAYER_COLORS[gs.current];
  if (gs.status !== 'playing') {
    const r = resultText(gs);
    ui.pill.innerHTML = `<span class="chip end">${icon('trophy')}</span><span class="who" style="color:${r.color}">${r.title}</span>`;
    return;
  }
  const s1 = phase !== 'step2';
  ui.pill.innerHTML = `<span class="chip">${P.glyph}</span><span class="who">${P.label} の番</span>
    <span class="steps"><span class="${s1 ? 'on' : 'done'}">①${step1Label()}</span><span class="${s1 ? '' : 'on'}">②操作</span></span>`;
}

function announceTurn(): void {
  if (!ui || gs.status !== 'playing') return;
  const P = PLAYER_COLORS[gs.current];
  const sub = canPlaceNow() ? `手駒 残り${gs.hand[gs.current]}` : '移動フェーズ';
  ui.banner.innerHTML = `<div class="banner-inner ${gs.current.toLowerCase()}"><span class="b-chip">${P.glyph}</span><span class="b-main">${P.label} の番</span><span class="b-sub">${sub}</span></div>`;
  ui.banner.classList.remove('show');
  void ui.banner.offsetWidth;
  ui.banner.classList.add('show');
  ui.live.textContent = `${P.label} の番です。`;
  sound.turn(gs.current);
}

function toast(msg: string, kind: 'info' | 'warn' = 'info'): void {
  if (!ui) return;
  const host = ui.toasts;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 2000);
}

// ── Board interaction ──────────────────────────────────────────────────────
function onCellHover(i: number | null): void {
  if (!ui) return;
  let ghost: Player | null = null;
  if (i !== null && !busy && gs.status === 'playing' && gs.board[i] === null
    && ((phase === 'step1' && canPlaceNow()) || (phase === 'step1-move-from' && selectedFrom !== null))) {
    ghost = gs.current;
  }
  ui.scene.setHover(i, ghost);
  ui.schematic.setHover(i);
}

function onCellClick(i: number | null, raw: number | null): void {
  sound.unlock();
  if (!ui || busy || gs.status !== 'playing') return;
  if (phase === 'step2') {
    if (raw !== null) {
      sound.invalid();
      toast('キューブ操作を選んで「確定」してください', 'info');
    }
    return;
  }
  if (i === null) {
    if (raw !== null) explainInvalid(raw);
    return;
  }
  if (phase === 'step1') {
    if (canPlaceNow()) { void doPlace(i); return; }
    selectedFrom = i;
    phase = 'step1-move-from';
    sound.select();
    refresh();
    return;
  }
  // step1-move-from
  if (i === selectedFrom) { deselectPiece(); return; }
  if (gs.board[i] === gs.current) {
    selectedFrom = i;
    sound.select();
    refresh();
    return;
  }
  if (selectedFrom !== null && gs.board[i] === null) void doMove(selectedFrom, i);
}

function deselectPiece(): void {
  if (phase !== 'step1-move-from') return;
  selectedFrom = null;
  phase = 'step1';
  sound.deselect();
  refresh();
}

function explainInvalid(raw: number): void {
  if (!ui) return;
  sound.invalid();
  ui.scene.flashInvalid(raw);
  const m = gs.board[raw];
  if (canPlaceNow()) toast(m ? 'そのマスには既に駒があります' : 'そのマスには置けません', 'warn');
  else if (m && m !== gs.current) toast('相手の駒は動かせません', 'warn');
  else if (!m && phase === 'step1') toast('先に動かす自分の駒を選んでください', 'warn');
  else toast('そのマスは選べません', 'warn');
}

function pushHistory(): void {
  history.push(snapshot());
  if (history.length > HISTORY_MAX) history.shift();
}

function setBusy(b: boolean): void {
  busy = b;
  if (!ui) return;
  ui.el.classList.toggle('busy', b);
  ui.controls.setBusy(b);
  if (b) {
    ui.scene.setTargets([], gs.current);
    ui.scene.setHover(null, null);
    ui.schematic.setHover(null);
  }
}

async function doPlace(i: number): Promise<void> {
  const u = ui;
  if (!u) return;
  const mark = gs.current;
  pushHistory();
  setBusy(true);
  sound.place(mark);
  const next = applyStep1Place(gs, i);
  log = [...log, { ply: gs.ply + 1, player: mark, step1: { kind: 'place', index: i }, cube: null }];
  await u.scene.animatePlace(i, mark).catch(() => undefined);
  if (ui !== u) return;
  gs = next;
  lastMoved = i;
  if (checkStep1Win(next)) {
    gs = { ...next, status: `win:${mark}`, winReason: 'line' };
    finishLog();
    await finishGame();
    return;
  }
  phase = 'step2';
  selectedMove = null;
  setBusy(false);
  refresh();
}

async function doMove(from: number, to: number): Promise<void> {
  const u = ui;
  if (!u) return;
  const mark = gs.current;
  pushHistory();
  setBusy(true);
  sound.lift();
  const next = applyStep1Move(gs, from, to);
  log = [...log, { ply: gs.ply + 1, player: mark, step1: { kind: 'move', from, to }, cube: null }];
  u.scene.setSelected(null);
  await u.scene.animateMove(from, to, mark).catch(() => undefined);
  if (ui !== u) return;
  sound.land();
  gs = next;
  lastMoved = to;
  selectedFrom = null;
  if (checkStep1Win(next)) {
    gs = { ...next, status: `win:${mark}`, winReason: 'line' };
    finishLog();
    await finishGame();
    return;
  }
  phase = 'step2';
  selectedMove = null;
  setBusy(false);
  refresh();
}

async function doCubeMove(move: CubeMove): Promise<void> {
  const u = ui;
  if (!u || busy || phase !== 'step2' || gs.status !== 'playing') return;
  if (!legalCubeMoves(gs).some(m => movesEqual(m, move))) { sound.invalid(); return; }
  pushHistory();
  sound.confirm();
  selectedMove = null;
  hoverMove = null;
  setBusy(true);
  u.scene.setLabelsVisible(false);
  updatePreview();
  const next = resolveAfterCubeMove(gs, move);
  const perm = movePermutation(move);
  const lastEntry = log[log.length - 1];
  if (lastEntry && lastEntry.cube === null) log = [...log.slice(0, -1), { ...lastEntry, cube: move }];

  await wait(80);
  if (ui !== u) return;
  if (move.kind === 'rotate') {
    sound.rotate();
    await u.scene.animateRotate(move, next.board).catch(() => undefined);
  } else {
    sound.slide();
    await u.scene.animateSlide(move, next.board).catch(() => undefined);
  }
  if (ui !== u) return;
  gs = next;
  lastMoved = lastMoved !== null ? perm[lastMoved] : null;
  phase = 'step1';
  selectedFrom = null;
  if (gs.status !== 'playing') {
    finishLog();
    await finishGame();
    return;
  }
  setBusy(false);
  refresh();
  announceTurn();
}

function finishLog(): void {
  const lastEntry = log[log.length - 1];
  if (lastEntry) log = [...log.slice(0, -1), { ...lastEntry, result: gs.status }];
}

async function finishGame(): Promise<void> {
  const u = ui;
  if (!u) return;
  clockOff();
  clearSave();
  setBusy(true);
  refresh();
  u.scene.showWin(winEntries(gs));
  if (gs.status === 'draw') sound.draw();
  else if (gs.winReason === 'selfDestruct') sound.selfDestruct();
  else sound.win();
  u.live.textContent = `${resultText(gs).title} ${resultText(gs).reason}`;
  await wait(gs.winReason === 'selfDestruct' ? 1500 : 1100);
  if (ui !== u) return;
  setBusy(false);
  refresh();
  showResult();
}

function undo(): void {
  if (!ui) return;
  if (busy || history.length === 0) { sound.invalid(); return; }
  const snap = history.pop() as Snapshot;
  const wasOver = gs.status !== 'playing';
  gs = snap.gameState;
  phase = snap.phase;
  selectedFrom = snap.selectedFrom;
  lastMoved = snap.lastMoved;
  log = snap.log;
  selectedMove = null;
  hoverMove = null;
  resultModal?.close();
  resultModal = null;
  ui.scene.clearWin();
  if (wasOver) clockOn();
  sound.undo();
  toast('一手戻しました');
  refresh();
}

// ── Controls panel events ──────────────────────────────────────────────────
function onControlEvent(e: ControlEvent): void {
  sound.unlock();
  switch (e.type) {
    case 'hoverMove':
      if (e.move && (!hoverMove || !movesEqual(e.move, hoverMove))) sound.hover();
      hoverMove = e.move;
      updatePreview();
      break;
    case 'selectMove':
      if (!selectedMove || !movesEqual(selectedMove, e.move)) sound.preview();
      selectedMove = e.move;
      updatePreview();
      break;
    case 'confirm':
      if (selectedMove) void doCubeMove(selectedMove);
      break;
    case 'cancel':
      cancelMove();
      break;
    case 'undo':
      undo();
      break;
    case 'peekLast':
      peekLast = e.on;
      updatePreview();
      break;
    case 'deselectPiece':
      deselectPiece();
      break;
    case 'showResult':
      sound.click();
      showResult();
      break;
    case 'replay':
      sound.click();
      startGame();
      break;
    case 'title':
      sound.click();
      renderTitle();
      break;
  }
}

function cancelMove(): void {
  if (!selectedMove) return;
  selectedMove = null;
  sound.cancel();
  updatePreview();
}

// ── Toggles ────────────────────────────────────────────────────────────────
function toggleSound(): void {
  setSetting('sound', !settings.sound);
  sound.unlock();
  sound.toggle(settings.sound);
  toast(settings.sound ? 'サウンド：オン' : 'サウンド：オフ');
}
function toggleSymbols(): void {
  setSetting('showSymbols', !settings.showSymbols);
  sound.toggle(settings.showSymbols);
  toast(settings.showSymbols ? '刻印表示：オン（球に ○×）' : '刻印表示：オフ');
}
function toggleExplode(): void {
  setSetting('explode', !settings.explode);
  sound.whoosh();
}

// ── Keyboard ───────────────────────────────────────────────────────────────
function onKey(e: KeyboardEvent): void {
  if (!ui || e.defaultPrevented || isModalOpen()) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const scene = ui.scene;
  switch (k) {
    case 'Escape':
      if (phase === 'step2') cancelMove();
      else deselectPiece();
      break;
    case 'Enter': {
      // Plain buttons keep their native Enter; on the move grid Enter means "confirm".
      const onButton = t?.tagName === 'BUTTON' && !t.classList.contains('op-btn');
      if (onButton) return;
      if (phase === 'step2' && selectedMove && !busy) {
        e.preventDefault();
        void doCubeMove(selectedMove);
      }
      break;
    }
    case 'u': case 'U': undo(); break;
    case 'm': case 'M': toggleSound(); break;
    case 's': case 'S': toggleSymbols(); break;
    case 'v': case 'V': toggleExplode(); break;
    case 'h': case 'H': case '?': showRules(); break;
    case 'r': case 'R': case '1': scene.setView('iso'); break;
    case '2': scene.setView('front'); break;
    case '3': scene.setView('top'); break;
    case '4': scene.setView('side'); break;
    case 'ArrowLeft': e.preventDefault(); scene.orbit(0.2, 0); break;
    case 'ArrowRight': e.preventDefault(); scene.orbit(-0.2, 0); break;
    case 'ArrowUp': e.preventDefault(); scene.orbit(0, -0.15); break;
    case 'ArrowDown': e.preventDefault(); scene.orbit(0, 0.15); break;
    case '+': case '=': case ';': scene.zoomBy(0.88); break;
    case '-': case '_': scene.zoomBy(1 / 0.88); break;
    default: break;
  }
}

// ═══════════════════════════════ Modals ════════════════════════════════════

function showRules(): void {
  openModal({ title: 'ルール説明', content: rulesHTML(), className: 'wide', actions: [{ label: '閉じる', kind: 'primary' }] });
}

function showResult(): void {
  if (!ui || gs.status === 'playing') return;
  resultModal?.close();
  const r = resultText(gs);
  const winner: Player | null = gs.status === 'win:O' ? 'O' : gs.status === 'win:X' ? 'X' : null;
  const placed = log.filter(e => e.step1.kind === 'place').length;
  const moved = log.length - placed;
  const body = `
    <div class="result" style="--rc:${r.color}">
      <div class="result-icon">${winner ? `<span class="rchip ${winner.toLowerCase()}">${PLAYER_COLORS[winner].glyph}</span>` : '<span class="rchip draw">＝</span>'}</div>
      <div class="result-title">${r.title}</div>
      <div class="result-reason">${r.reason}</div>
      <dl class="stats">
        <div><dt>手数</dt><dd>${gs.ply}</dd></div>
        <div><dt>配置／移動</dt><dd>${placed}／${moved}</dd></div>
        <div><dt>経過時間</dt><dd>${fmtTime(currentElapsed())}</dd></div>
      </dl>
    </div>`;
  resultModal = openModal({
    content: body,
    className: 'result-modal',
    actions: [
      { label: 'タイトルへ', kind: 'ghost', onClick: () => { renderTitle(); } },
      { label: '盤面を見る', kind: 'ghost' },
      { label: 'もう一度', kind: 'primary', autofocus: true, onClick: () => { startGame(); } },
    ],
    onClose: () => { resultModal = null; },
  });
}

function confirmQuit(): void {
  if (gs.status !== 'playing') { renderTitle(); return; }
  openModal({
    title: 'タイトルへ戻る',
    content: '<p>対局を中断してタイトルに戻りますか？<br><small>進行状況は自動保存され、「続きから」で再開できます。</small></p>',
    actions: [
      { label: '続ける', kind: 'ghost' },
      { label: 'タイトルへ', kind: 'primary', onClick: () => { renderTitle(); } },
    ],
  });
}

function showSettings(): void {
  const body = document.createElement('div');
  body.className = 'settings';
  const seg = <T extends string>(name: string, opts: [T, string][], cur: T): string =>
    `<div class="seg" role="radiogroup" data-seg="${name}">${opts.map(([v, l]) =>
      `<button type="button" role="radio" data-v="${v}" aria-checked="${v === cur}">${l}</button>`).join('')}</div>`;
  body.innerHTML = `
    <section>
      <h3>サウンド</h3>
      <label class="row"><span>効果音</span><input type="checkbox" class="switch" data-k="sound" ${settings.sound ? 'checked' : ''}></label>
      <label class="row"><span>音量</span><input type="range" min="0" max="100" step="5" data-k="volume" value="${Math.round(settings.volume * 100)}"></label>
    </section>
    <section>
      <h3>表示</h3>
      <div class="row"><span>アニメーション速度</span>${seg<AnimSpeed>('animSpeed', [['slow', 'ゆっくり'], ['normal', '標準'], ['fast', '速い']], settings.animSpeed)}</div>
      <label class="row"><span>刻印表示<small>3Dの球に ○× を表示</small></span><input type="checkbox" class="switch" data-k="showSymbols" ${settings.showSymbols ? 'checked' : ''}></label>
      <label class="row"><span>ヒント<small>操作の結果予告と成立ラインを表示</small></span><input type="checkbox" class="switch" data-k="showHints" ${settings.showHints ? 'checked' : ''}></label>
      <label class="row"><span>展開表示<small>層の間隔を広げて内側を見やすく</small></span><input type="checkbox" class="switch" data-k="explode" ${settings.explode ? 'checked' : ''}></label>
    </section>
    <section>
      <h3>対局ルール <small>（次の新しいゲームから適用）</small></h3>
      <div class="row"><span>先手</span>${seg<FirstPlayer>('firstPlayer', [['O', '〇 青'], ['X', '× 赤'], ['random', 'ランダム']], settings.firstPlayer)}</div>
      <label class="row"><span>手数上限<small>到達すると引き分け</small></span>
        <select data-k="turnLimit">${TURN_LIMITS.map(v => `<option value="${v ?? ''}" ${v === settings.turnLimit ? 'selected' : ''}>${v ? `${v}手` : 'なし'}</option>`).join('')}</select>
      </label>
    </section>`;

  body.querySelectorAll<HTMLInputElement>('input.switch').forEach(inp => {
    inp.addEventListener('change', () => {
      const k = inp.dataset['k'] as 'sound' | 'showSymbols' | 'showHints' | 'explode';
      setSetting(k, inp.checked);
      sound.unlock();
      sound.toggle(inp.checked);
    });
  });
  const vol = body.querySelector<HTMLInputElement>('input[data-k="volume"]');
  vol?.addEventListener('input', () => setSetting('volume', Number(vol.value) / 100));
  vol?.addEventListener('change', () => { sound.unlock(); sound.place('O'); });
  body.querySelectorAll<HTMLElement>('.seg').forEach(g => {
    g.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      b.addEventListener('click', () => {
        g.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
        const v = b.dataset['v'];
        if (g.dataset['seg'] === 'animSpeed') setSetting('animSpeed', v as AnimSpeed);
        else setSetting('firstPlayer', v as FirstPlayer);
        sound.click();
      });
    });
  });
  const sel = body.querySelector<HTMLSelectElement>('select[data-k="turnLimit"]');
  sel?.addEventListener('change', () => { setSetting('turnLimit', sel.value ? Number(sel.value) : null); sound.click(); });

  openModal({ title: '設定', content: body, actions: [{ label: '閉じる', kind: 'primary' }] });
}

// ═══════════════════════════════ Entry ═════════════════════════════════════

export function initApp(el: HTMLElement): void {
  root = el;
  applySettings();
  const unlock = (): void => sound.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (!ui) return;
    if (document.hidden) { clockOff(); persist(); }
    else clockOn();
  });
  window.addEventListener('pagehide', () => { if (ui) { clockOff(); persist(); } });
  renderTitle();
}

