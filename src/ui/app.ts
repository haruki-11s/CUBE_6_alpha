import { Scene3D, type ViewPreset } from './scene3d';
import { Schematic, type SchematicState } from './schematic';
import { Controls, type ClockFace, type ControlEvent, type Outcome } from './controls';
import {
  initialGameState, legalPlacements, legalCubeMoves, allCubeMoves,
  applyStep1Place, applyStep1Move, resolveAfterCubeMove,
  applyCubeMove, movePermutation, movesEqual, completedLines,
  inCheck, checkLines, breakingMoves, isMate,
} from '../core/game';
import { parseSave, type LogEntry, type MatchInfo, type SaveData, type SavedPhase, type Snapshot } from '../core/save';
import type { Line } from '../core/lines';
import type { CubeMove, GameState, Mark, Player } from '../core/types';
import { LEVEL_PARAMS, type CpuLevel } from '../core/ai';
import { describeMove, describeStep1 } from '../core/notation';
import {
  CLOCK_PRESETS, fmtClock, mainAfterTurn, newClock, presetLabel, turnTime,
  type ClockInfo, type ClockPreset,
} from '../core/clock';
import { sound } from './sound';
import {
  loadSettings, saveSettings, SPEED_MULT, TURN_LIMITS,
  type Settings, type AnimSpeed, type FirstPlayer, type CpuOrder,
} from './settings';
import { setAnimSpeed, wait } from './tween';
import { openModal, isModalOpen, type ModalAction, type ModalHandle } from './modal';
import { icon, type IconName } from './icons';
import { rulesHTML } from './rules';
import { getLang, isLang, LANGS, setLang, t, type Lang } from './i18n';
import { APP_VERSION, PLAYER_COLORS, other } from './theme';
import { CpuClient } from './cpu';
import {
  NORMAL_LEVELS, HIDDEN_LEVEL, levelLabel, loadProgress, recordResult, type GameResult,
} from './cpuProfile';

type Phase = SavedPhase;

interface GameUI {
  el: HTMLElement;
  scene: Scene3D;
  schematic: Schematic;
  controls: Controls;
  /** Top bar: each player's hand and clock left and right, the turn status in between. */
  hud: HTMLElement;
  banner: HTMLElement;
  toasts: HTMLElement;
  live: HTMLElement;
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

// ── Opponent: a second person on this device, or the CPU ─────────────────────
let match: MatchInfo = { mode: 'local', undos: 0 };
let cpu: CpuClient | null = null;
/** The CPU's turn is in progress (thinking or showing its move): the human can only watch / take back. */
let cpuActing = false;
/** Bumped to abandon a CPU turn (待った, quitting, new game). */
let cpuToken = 0;
/** The finished game's result as counted in the records (reverted by 待った). */
let recorded: { level: CpuLevel; result: GameResult } | null = null;
let justUnlocked = false;
let lastBusyToast = 0;
/** 「盤面を確認する」: after 詰み the final board is open for previewing cube moves. */
let reviewing = false;
/** Removes the title screen's document listeners (its two menus and Esc). */
let titleUiCleanup: (() => void) | null = null;

let elapsed = 0;
let clockStart = 0;
let clockRunning = false;

// ── 持ち時間 (CPU games on a clock) ──
let tcRunning = false;
let tcSince = 0;
let tcTicker = 0;
/** The CPU's turn is waiting for a dialog to close: its clock is held. */
let tcHold = false;
/** Last 秒読み second that was announced (tick sound). */
let tcAnnounced = -1;
/** The "main time used up" alert was given this turn. */
let tcByoShown = false;

const SAVE_KEY = 'cube6-save';
const HISTORY_MAX = 80;

// ── Persistence ────────────────────────────────────────────────────────────
function snapshot(): Snapshot {
  return structuredClone({ gameState: gs, phase, selectedFrom, lastMoved, log });
}

function persist(): void {
  if (gs.status !== 'playing') { clearSave(); return; }
  // the clock in the save includes the time already spent on the turn in progress
  const m: MatchInfo = match.mode === 'cpu' && match.clock
    ? { ...match, clock: { ...match.clock, left: { ...match.clock.left }, used: tcUsed(match.clock) } }
    : match;
  const data: SaveData = { v: 2, ...snapshot(), history: history.slice(-HISTORY_MAX), elapsed: currentElapsed(), match: m };
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

// ── 持ち時間: main time, then 秒読み for every turn; running out loses ──────
function gameClock(): ClockInfo | null {
  return match.mode === 'cpu' ? match.clock : null;
}
function tcUsed(c: ClockInfo): number {
  return c.used + (tcRunning ? performance.now() - tcSince : 0);
}
/** Start / resume the clock of the player to move. */
function tcStart(): void {
  if (!gameClock() || !ui || tcRunning || tcHold || gs.status !== 'playing' || document.hidden) return;
  tcSince = performance.now();
  tcRunning = true;
}
function tcPause(): void {
  const c = gameClock();
  if (!c || !tcRunning) return;
  c.used += performance.now() - tcSince;
  tcRunning = false;
}
/** `p` confirmed its cube move: charge the turn to its main time. */
function tcEndTurn(p: Player): void {
  const c = gameClock();
  if (!c) return;
  tcPause();
  c.left[p] = mainAfterTurn(c.left[p], c.used);
  c.used = 0;
  tcAnnounced = -1;
  tcByoShown = false;
}
function clockFaces(): Record<Player, ClockFace> | null {
  const c = gameClock();
  if (!c) return null;
  const used = tcUsed(c);
  const face = (p: Player): ClockFace => {
    const active = gs.status === 'playing' && gs.current === p;
    const tt = turnTime(c, c.left[p], active ? used : 0);
    if (tt.phase === 'main') return { text: fmtClock(tt.ms), state: !active ? 'idle' : tt.ms <= 30_000 ? 'low' : 'run' };
    return { text: t().hud.byoyomi(Math.ceil(tt.ms / 1000)), state: active ? 'byo' : 'idle' };
  };
  return { O: face('O'), X: face('X') };
}
/** Live clock update in the top bar, without rebuilding it. */
function renderClocks(): void {
  if (!ui) return;
  const f = clockFaces();
  if (!f) return;
  for (const p of ['O', 'X'] as const) {
    const el = ui.hud.querySelector<HTMLElement>(`[data-clock="${p}"]`);
    if (!el) continue;
    const cls = `hud-clock ${f[p].state}`;
    if (el.className !== cls) el.className = cls;
    const b = el.querySelector('b');
    if (b && b.textContent !== f[p].text) b.textContent = f[p].text;
  }
}
function tcTick(): void {
  const c = gameClock();
  if (!c || !ui) return;
  renderClocks();
  if (!tcRunning || gs.status !== 'playing' || match.mode !== 'cpu') return;
  const p = gs.current;
  const tt = turnTime(c, c.left[p], tcUsed(c));
  if (tt.phase === 'out') {
    if (!busy) timeOut(p); // an animation in progress finishes first
    return;
  }
  if (tt.phase !== 'byoyomi' || p !== match.human) return;
  if (!tcByoShown) {
    tcByoShown = true;
    if (c.left[p] > 0) {
      sound.byoyomi();
      toast(t().toast.byoyomi(c.byoyomiMs / 1000), 'warn');
    }
  }
  const sec = Math.ceil(tt.ms / 1000);
  if (sec !== tcAnnounced) {
    tcAnnounced = sec;
    if (sec <= 5) sound.tick(true);
    else if (sec % 10 === 0 && sec * 1000 < c.byoyomiMs) sound.tick(false);
  }
}
function timeOut(p: Player): void {
  if (!ui || gs.status !== 'playing') return;
  cancelCpu();
  tcPause();
  const c = gameClock();
  if (c) { c.left[p] = 0; c.used = 0; }
  gs = { ...gs, status: `win:${other(p)}`, winReason: 'timeout' };
  if (phase === 'step1-move-from') phase = 'step1';
  selectedFrom = null;
  selectedMove = null;
  hoverMove = null;
  void finishGame();
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

/** Which list the title menu shows: the two modes, or the choices inside one of them. */
type TitleView = 'main' | 'local' | 'online';
let titleView: TitleView = 'main';

/** A small English label beside a Japanese one ("SETTINGS"); the English UI has none. */
const tag = (s: string): string => (s ? `<small>${s}</small>` : '');

function renderTitle(): void {
  teardownGame();
  teardownTitle();
  titleView = 'main';
  root.innerHTML = `
    <div class="title">
      <div class="title-stage" id="title-stage"></div>
      <div class="title-vignette"></div>
    </div>`;
  mountTitleUI(false);
  startTitleDemo(root.querySelector('#title-stage') as HTMLElement);
}

/**
 * Everything on the title screen but the 3D demo: the language button (top left), the ≡ menu
 * (top right), the logo with the menu, and the footer. A language change rebuilds it
 * without replaying the intro.
 */
function mountTitleUI(settled: boolean): void {
  const host = root.querySelector<HTMLElement>('.title');
  if (!host) return;
  titleUiCleanup?.();
  titleUiCleanup = null;
  host.querySelectorAll('[data-title-ui]').forEach(el => el.remove());
  host.classList.toggle('settled', settled);
  const T = t().title;
  const cur = LANGS.find(l => l.id === getLang()) ?? LANGS[0];
  host.insertAdjacentHTML('beforeend', `
    <div class="title-lang" data-title-ui>
      <button type="button" class="corner-toggle lang-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="lang-menu" aria-label="Language / 言語" title="Language / 言語">${icon('globe')}<span>${cur.name}</span></button>
      <div class="corner-menu lang-menu" id="lang-menu" role="menu" aria-label="Language / 言語" hidden>
        ${LANGS.map(l => `<button type="button" role="menuitemradio" aria-checked="${l.id === cur.id}" data-lang="${l.id}" lang="${l.id}"><span>${l.name}</span>${l.id === cur.id ? icon('check') : ''}</button>`).join('')}
      </div>
    </div>
    <div class="title-corner" data-title-ui>
      <button type="button" class="corner-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="corner-menu" aria-label="${T.menu}" title="${T.menu}">${icon('menu')}</button>
      <div class="corner-menu" id="corner-menu" role="menu" aria-label="${T.menu}" hidden>
        <button type="button" role="menuitem" data-act="settings">${icon('sliders')}<span>${T.settings}</span>${tag(T.settingsTag)}</button>
        <button type="button" role="menuitem" data-act="records">${icon('chart')}<span>${T.records}</span>${tag(T.recordsTag)}</button>
        <div class="corner-sep" role="separator"></div>
        <button type="button" role="menuitem" data-act="exit" class="exit">${icon('power')}<span>${T.exit}</span>${tag(T.exitTag)}</button>
      </div>
    </div>
    <div class="title-ui" data-title-ui>
      <div class="logo-wrap">
        <h1 class="logo" aria-label="CUBE 6"><span class="logo-word">CUBE</span><span class="logo-six">6</span></h1>
        <p class="subtitle">${T.subtitle}</p>
      </div>
      <nav class="menu" aria-label="${T.modesAria}"></nav>
    </div>
    <footer class="title-foot" data-title-ui>${T.foot(APP_VERSION)}</footer>`);
  renderTitleMenu(settled);

  const cleanups = [
    setupDropdown(host.querySelector('.title-corner') as HTMLElement, b => {
      const act = b.dataset['act'];
      if (act === 'settings') showSettings();
      else if (act === 'records') showRecords();
      else if (act === 'exit') confirmExit();
    }),
    setupDropdown(host.querySelector('.title-lang') as HTMLElement, b => {
      const l = b.dataset['lang'];
      if (isLang(l) && l !== getLang()) changeLang(l);
    }),
  ];
  // Esc inside ローカル / インターネット goes back to the two modes
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented || isModalOpen() || titleView === 'main') return;
    e.preventDefault();
    sound.click();
    openTitleView('main');
  };
  document.addEventListener('keydown', onEsc);
  titleUiCleanup = () => {
    cleanups.forEach(c => c());
    document.removeEventListener('keydown', onEsc);
  };
}

/** The menu: ローカル / インターネット (with 続きから and ルール説明), or the two choices inside one. */
function renderTitleMenu(quick: boolean): void {
  const nav = root.querySelector<HTMLElement>('.title .menu');
  if (!nav) return;
  const T = t().title;
  const btn = (act: string, ico: IconName, label: string, tagText: string, cls = ''): string =>
    `<button type="button" class="menu-btn${cls ? ` ${cls}` : ''}" data-act="${act}"><span>${icon(ico)}${label}</span>${tag(tagText)}</button>`;
  let html: string;
  if (titleView === 'main') {
    const save = readSave();
    const resumeInfo = !save ? ''
      : save.match.mode === 'cpu'
        ? T.resumeCpu(levelLabel(save.match.level), save.gameState.ply + 1)
        : T.resumeTwo(PLAYER_COLORS[save.gameState.current].symbol, save.gameState.ply + 1);
    html = btn('local', 'device', T.local, T.localTag, 'primary')
      + btn('online', 'globe', T.online, T.onlineTag)
      + (save ? `<button type="button" class="menu-btn resume" data-act="resume"><span>${icon('resume')}${T.resume}</span><small>${resumeInfo}</small></button>` : '')
      + btn('rules', 'help', T.rules, T.rulesTag);
  } else {
    const local = titleView === 'local';
    html = `<div class="menu-head"><span>${local ? T.local : T.online}</span>${tag(local ? T.localTag : T.onlineTag)}</div>`
      + (local
        ? btn('cpu', 'cpu', T.cpu, T.cpuTag, 'primary') + btn('two', 'users', T.two, T.twoTag)
        : btn('random', 'shuffle', T.random, T.soonTag, 'soon') + btn('code', 'key', T.code, T.soonTag, 'soon'))
      + `<button type="button" class="menu-back" data-act="back">${icon('back')}<span>${T.back}</span></button>`;
  }
  nav.dataset['view'] = titleView;
  nav.classList.toggle('quick', quick);
  nav.innerHTML = html;
  nav.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
    b.addEventListener('pointerenter', () => sound.hover());
    b.addEventListener('click', () => {
      sound.click();
      const act = b.dataset['act'];
      if (act === 'local' || act === 'online') openTitleView(act);
      else if (act === 'back') openTitleView('main');
      else if (act === 'cpu') openCpuSetup();
      else if (act === 'two') requestNewGame({ mode: 'local', undos: 0 });
      else if (act === 'random') showOnline(T.random);
      else if (act === 'code') showOnline(T.code);
      else if (act === 'resume') resumeGame();
      else if (act === 'rules') showRules();
    });
  });
}

/** Switches the menu list; focus moves into the new list, or back to the button that opened it. */
function openTitleView(v: TitleView): void {
  const from = titleView;
  titleView = v;
  renderTitleMenu(true);
  const nav = root.querySelector<HTMLElement>('.title .menu');
  const target = v === 'main'
    ? nav?.querySelector<HTMLElement>(`[data-act="${from}"]`)
    : nav?.querySelector<HTMLElement>('.menu-btn');
  target?.focus({ preventScroll: true });
}

/** The language chosen on the title screen: everything is shown in it from now on. */
function changeLang(l: Lang): void {
  setSetting('lang', l);
  setLang(l);
  mountTitleUI(true);
  root.querySelector<HTMLElement>('.lang-toggle')?.focus({ preventScroll: true });
}

/** A button that opens a small menu (≡: 設定・戦績・EXIT, or the languages). Returns its cleanup. */
function setupDropdown(box: HTMLElement, onPick: (item: HTMLButtonElement) => void): () => void {
  const toggle = box.querySelector('.corner-toggle') as HTMLButtonElement;
  const menu = box.querySelector('.corner-menu') as HTMLElement;
  const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
  const setOpen = (open: boolean, focus = false): void => {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && focus) (items.find(b => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  };
  toggle.addEventListener('click', () => {
    sound.click();
    setOpen(menu.hidden, true);
  });
  items.forEach((b, i) => {
    b.addEventListener('pointerenter', () => sound.hover());
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    });
    b.addEventListener('click', () => {
      sound.click();
      setOpen(false);
      onPick(b);
    });
  });
  const outside = (e: PointerEvent): void => {
    if (!menu.hidden && !box.contains(e.target as Node)) setOpen(false);
  };
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !menu.hidden && !isModalOpen()) {
      e.preventDefault();
      setOpen(false);
      toggle.focus();
    }
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onEsc);
  return () => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onEsc);
  };
}

/** ランダム対戦 / 合言葉で遊ぶ: not built yet. */
function showOnline(name: string): void {
  openModal({
    title: name, subtitle: t().title.onlineTag,
    content: t().online.soon,
    actions: [{ label: t().common.close, kind: 'primary' }],
  });
}

/** 戦績: wins / losses / draws against each CPU level (kept in this browser). */
function showRecords(): void {
  const R = t().records;
  const prog = loadProgress();
  const levels: CpuLevel[] = prog.unlocked ? [...NORMAL_LEVELS, HIDDEN_LEVEL] : [...NORMAL_LEVELS];
  const rate = (w: number, n: number): string => (n ? `${Math.round((w / n) * 100)}%` : '—');
  let tw = 0, tl = 0, td = 0;
  const rows = levels.map(l => {
    const r = prog.records[l];
    tw += r.w; tl += r.l; td += r.d;
    const bars = Array.from({ length: 6 }, (_, i) => `<i class="${i < l ? 'on' : ''}"></i>`).join('');
    return `<tr class="${l === HIDDEN_LEVEL ? 'secret' : ''}">
      <th scope="row"><span class="rec-lv"><span class="lv-num">Lv.${l}</span><span class="lv-meter" aria-hidden="true">${bars}</span></span></th>
      <td>${r.w}</td><td>${r.l}</td><td>${r.d}</td><td class="rate">${rate(r.w, r.w + r.l + r.d)}</td></tr>`;
  }).join('');
  openModal({
    title: R.title, subtitle: R.tag, className: 'records-modal',
    content: `<table class="records">
        <thead><tr><th scope="col">CPU</th><th scope="col">${R.win}</th><th scope="col">${R.loss}</th><th scope="col">${R.draw}</th><th scope="col">${R.rate}</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th scope="row">${R.total}</th><td>${tw}</td><td>${tl}</td><td>${td}</td><td class="rate">${rate(tw, tw + tl + td)}</td></tr></tfoot>
      </table>
      <p class="records-note">${R.note}</p>`,
    actions: [{ label: t().common.close, kind: 'primary' }],
  });
}

function confirmExit(): void {
  const X = t().exit;
  openModal({
    title: X.title, subtitle: X.tag,
    content: `<p>${X.ask}</p>`,
    actions: [
      { label: t().common.cancel, kind: 'ghost', autofocus: true },
      { label: X.quit, kind: 'danger', onClick: () => { setTimeout(exitGame, 0); } },
    ],
  });
}

/** A page can only close a window it opened itself, so otherwise this leaves an end screen. */
function exitGame(): void {
  teardownGame();
  teardownTitle();
  try { window.close(); } catch { /* not allowed for this tab */ }
  const X = t().exit;
  root.innerHTML = `
    <div class="exit-screen">
      <h1 class="logo" aria-label="CUBE 6"><span class="logo-word">CUBE</span><span class="logo-six">6</span></h1>
      <p>${X.done}</p>
      <p><small>${X.closeTab}</small></p>
      <button type="button" class="btn ghost" data-act="back">${icon('home')}${X.back}</button>
    </div>`;
  root.querySelector('[data-act="back"]')?.addEventListener('click', () => { sound.click(); renderTitle(); });
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
  titleUiCleanup?.();
  titleUiCleanup = null;
}

// ═══════════════════════════════ Game screen ═══════════════════════════════

function requestNewGame(m: MatchInfo): void {
  if (readSave()) {
    const N = t().newGame;
    openModal({
      title: N.title, subtitle: N.tag,
      content: `<p>${N.body}</p>`,
      actions: [
        { label: t().common.cancel, kind: 'ghost' },
        { label: N.start, kind: 'primary', onClick: () => { startGame(m); } },
      ],
    });
  } else {
    startGame(m);
  }
}

/** CPU game setup: strength (level 6 only once unlocked), who moves first and the clock. */
function openCpuSetup(): void {
  const S = t().cpuSetup;
  const prog = loadProgress();
  const levels: CpuLevel[] = prog.unlocked ? [...NORMAL_LEVELS, HIDDEN_LEVEL] : [...NORMAL_LEVELS];
  let level: CpuLevel = levels.includes(settings.cpuLevel) ? settings.cpuLevel : 1;
  let order: CpuOrder = settings.cpuOrder;
  let clockSel: ClockPreset = settings.cpuClock;
  // the level and its bar are all a card shows
  const card = (l: CpuLevel): string => {
    const bars = Array.from({ length: 6 }, (_, i) => `<i class="${i < l ? 'on' : ''}"></i>`).join('');
    return `<button type="button" role="radio" class="lv-card${l === HIDDEN_LEVEL ? ' secret' : ''}" data-lv="${l}" aria-checked="${l === level}">
      <span class="lv-num">Lv.${l}</span><span class="lv-meter" aria-hidden="true">${bars}</span>
    </button>`;
  };
  const body = document.createElement('div');
  body.className = 'cpu-setup';
  body.innerHTML = `
    <section>
      <h3>${S.strength}</h3>
      <div class="lv-grid" role="radiogroup" aria-label="${S.strengthAria}">${levels.map(card).join('')}</div>
    </section>
    <section>
      <h3>${S.order}</h3>
      <div class="seg full order" role="radiogroup" aria-label="${S.orderAria}" data-seg="order">
        ${([['human', S.first], ['cpu', S.second], ['random', t().common.random]] as [CpuOrder, string][])
          .map(([v, l]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === order}">${l}</button>`).join('')}
      </div>
      <p class="setup-note">${S.sides}</p>
    </section>
    <section>
      <h3>${S.clock}</h3>
      <div class="seg full" role="radiogroup" aria-label="${S.clock}" data-seg="clock">
        ${(['3m30s', '3m10s', 'off'] as ClockPreset[])
          .map(v => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === clockSel}">${v === 'off' ? S.clockOff : presetLabel(v, getLang())}</button>`).join('')}
      </div>
      <p class="setup-note" data-clock-note></p>
    </section>`;
  const clockNote = body.querySelector<HTMLElement>('[data-clock-note]');
  const syncClockNote = (): void => {
    if (!clockNote) return;
    clockNote.textContent = clockSel === 'off'
      ? S.clockOffNote
      : S.clockNote(CLOCK_PRESETS[clockSel].mainMs / 60000, CLOCK_PRESETS[clockSel].byoyomiMs / 1000);
  };
  syncClockNote();
  body.querySelectorAll<HTMLButtonElement>('.lv-card').forEach(b => {
    b.addEventListener('pointerenter', () => sound.hover());
    b.addEventListener('click', () => {
      level = Number(b.dataset['lv']) as CpuLevel;
      body.querySelectorAll('.lv-card').forEach(x => x.setAttribute('aria-checked', String(x === b)));
      sound.select();
    });
  });
  body.querySelectorAll<HTMLElement>('.seg').forEach(g => {
    g.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      b.addEventListener('click', () => {
        if (g.dataset['seg'] === 'clock') { clockSel = b.dataset['v'] as ClockPreset; syncClockNote(); }
        else order = b.dataset['v'] as CpuOrder;
        g.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
        sound.click();
      });
    });
  });
  openModal({
    title: S.title, subtitle: S.tag,
    content: body,
    className: 'setup-modal',
    actions: [
      { label: t().common.cancel, kind: 'ghost' },
      {
        label: S.start, kind: 'primary', onClick: () => {
          setSetting('cpuLevel', level);
          setSetting('cpuOrder', order);
          setSetting('cpuClock', clockSel);
          const clock = clockSel === 'off' ? null : newClock(CLOCK_PRESETS[clockSel]);
          // let this dialog close before a possible "overwrite?" dialog opens
          setTimeout(() => requestNewGame({ mode: 'cpu', level, human: 'O', undos: 0, clock }), 0);
        },
      },
    ],
  });
}

function startGame(m: MatchInfo = match): void {
  tcPause(); // (charges nothing: the old game's clock is already stopped)
  // a rematch keeps the time control but starts from full clocks
  match = m.mode === 'cpu' ? { ...m, undos: 0, clock: m.clock ? newClock(m.clock) : null } : { mode: 'local', undos: 0 };
  let first: Player;
  if (match.mode === 'cpu') {
    const o = settings.cpuOrder;
    const humanFirst = o === 'human' || (o === 'random' && Math.random() < 0.5);
    first = humanFirst ? match.human : other(match.human);
  } else {
    first = settings.firstPlayer === 'random' ? (Math.random() < 0.5 ? 'O' : 'X') : settings.firstPlayer;
  }
  gs = { ...initialGameState(), current: first, settings: { turnLimit: settings.turnLimit } };
  phase = 'step1';
  selectedFrom = null;
  lastMoved = null;
  log = [];
  history = [];
  elapsed = 0;
  clockRunning = false;
  recorded = null;
  justUnlocked = false;
  reviewing = false;
  clearSave();
  if (!renderGame()) return;
  clockOn();
  tcStart();
  sound.start();
  setTimeout(() => announceTurn(), 300);
}

function resumeGame(): void {
  tcPause();
  const s = readSave();
  if (!s) { startGame({ mode: 'local', undos: 0 }); return; }
  gs = s.gameState;
  phase = s.phase;
  selectedFrom = s.selectedFrom;
  lastMoved = s.lastMoved;
  log = s.log;
  history = s.history;
  elapsed = s.elapsed;
  match = s.match;
  recorded = null;
  justUnlocked = false;
  reviewing = false;
  clockRunning = false;
  if (!renderGame()) return;
  clockOn();
  tcStart();
  setTimeout(() => announceTurn(), 250);
}

function renderGame(): boolean {
  teardownTitle();
  teardownGame();
  busy = false;
  hoverMove = null;
  selectedMove = null;
  peekLast = false;
  cpuActing = false;
  cpuToken++;
  cpu = match.mode === 'cpu' ? new CpuClient() : null;
  tcRunning = false;
  tcHold = false;
  tcAnnounced = -1;
  tcByoShown = false;

  const G = t().game;
  root.innerHTML = `
    <div class="game" data-turn="${gs.current}">
      <header class="topbar">
        <button type="button" class="brand" data-act="home" title="${G.toTitleTip}">CUBE<b>6</b></button>
        <div class="hud" id="hud">
          <div class="hud-side o" data-side="O"></div>
          <div class="hud-status" role="status"></div>
          <div class="hud-side x" data-side="X"></div>
        </div>
        <div class="top-actions">
          <button type="button" class="icon-btn" data-act="symbols" title="${G.symbolsTip}">${icon('symbols')}</button>
          <button type="button" class="icon-btn" data-act="sound" title="${G.soundTip}"></button>
          <button type="button" class="icon-btn" data-act="settings" title="${G.settingsTip}">${icon('sliders')}</button>
          <button type="button" class="icon-btn" data-act="help" title="${G.rulesTip}">${icon('help')}</button>
          <button type="button" class="icon-btn" data-act="pause" title="${G.pauseTip}">${icon('pause')}</button>
        </div>
      </header>
      <aside class="side schematic-panel" id="schematic" aria-label="${G.mapAria}"></aside>
      <main class="stage" id="stage">
        <div class="toast-host" id="toasts" aria-live="polite"></div>
        <div class="turn-banner" id="banner" aria-hidden="true"></div>
        <div class="stage-tools" role="toolbar" aria-label="${G.viewAria}">
          <div class="seg-tools">
            <button type="button" class="tool-btn" data-view="iso" title="${G.viewIsoTip}">${G.viewIso}</button>
            <button type="button" class="tool-btn" data-view="front" title="${G.viewFrontTip}">${G.viewFront}</button>
            <button type="button" class="tool-btn" data-view="top" title="${G.viewTopTip}">${G.viewTop}</button>
            <button type="button" class="tool-btn" data-view="side" title="${G.viewSideTip}">${G.viewSide}</button>
          </div>
          <div class="seg-tools">
            <button type="button" class="tool-btn icon" data-act="explode" title="${G.explodeTip}">${icon('expand')}</button>
            <button type="button" class="tool-btn icon" data-act="zoom-in" title="${G.zoomInTip}">${icon('zoomIn')}</button>
            <button type="button" class="tool-btn icon" data-act="zoom-out" title="${G.zoomOutTip}">${icon('zoomOut')}</button>
          </div>
        </div>
        <div class="stage-help">${G.stageHelp}</div>
      </main>
      <aside class="side controls-panel" id="controls" aria-label="${G.controlsAria}"></aside>
      <div class="sr-only" id="live" aria-live="polite"></div>
    </div>`;

  const el = root.querySelector('.game') as HTMLElement;
  const stage = el.querySelector('#stage') as HTMLElement;
  let scene: Scene3D;
  try {
    scene = new Scene3D(stage);
  } catch (e) {
    console.error(e);
    stage.innerHTML = `<div class="no-webgl-msg">${G.noWebgl}<br><button type="button" class="btn primary">${icon('home')}${t().common.toTitle}</button></div>`;
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
    hud: el.querySelector('#hud') as HTMLElement,
    banner: el.querySelector('#banner') as HTMLElement,
    toasts: el.querySelector('#toasts') as HTMLElement,
    live: el.querySelector('#live') as HTMLElement,
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
  if (gameClock()) tcTicker = window.setInterval(tcTick, 100);
  return true;
}

function teardownGame(): void {
  cancelCpu();
  cpu?.dispose();
  cpu = null;
  window.clearInterval(tcTicker);
  tcTicker = 0;
  if (!ui) return;
  clockOff();
  tcPause();
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
    snd.setAttribute('aria-label', settings.sound ? t().game.soundOn : t().game.soundOff);
  }
  ui.el.querySelector('[data-act="explode"]')?.setAttribute('aria-pressed', String(settings.explode));
}

// ── Derived state ──────────────────────────────────────────────────────────
function canPlaceNow(): boolean { return legalPlacements(gs).length > 0; }

function isCpuTurn(): boolean {
  return match.mode === 'cpu' && gs.status === 'playing' && gs.current !== match.human;
}
/** "PLAYER 1" (〇) / "PLAYER 2" (×) for two people; "あなた" / "CPU" against the CPU. */
function nameOf(p: Player): string {
  if (match.mode === 'cpu') return p === match.human ? t().common.you : 'CPU';
  return p === 'O' ? 'PLAYER 1' : 'PLAYER 2';
}
/** Human input is blocked during animations and while the CPU plays its turn. */
function locked(): boolean { return busy || cpuActing; }

/** Label of step ① for the current turn ("配置" or "移動"). */
function step1Label(): string {
  if (phase === 'step2') {
    const last = log[log.length - 1];
    return last && last.step1.kind === 'move' ? t().hud.move : t().hud.place;
  }
  return canPlaceNow() ? t().hud.place : t().hud.move;
}

function targetsNow(): number[] {
  if (gs.status !== 'playing' || locked()) return [];
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
  if (locked() || gs.status !== 'playing') return false;
  if (phase === 'step1') return canPlaceNow() ? gs.board[i] === null : gs.board[i] === gs.current;
  if (phase === 'step1-move-from') return gs.board[i] === null || gs.board[i] === gs.current;
  return false;
}

function winEntries(state: GameState): { line: Line; player: Player }[] {
  if (state.status === 'win:O' || state.status === 'win:X') {
    const p: Player = state.status === 'win:O' ? 'O' : 'X';
    return completedLines(state.board, p).map(line => ({ line, player: p }));
  }
  return [];
}

/** 王手: the opponent's lines that the player to move has to break this turn. */
function checkEntries(): { line: Line; player: Player }[] {
  if (gs.status !== 'playing') return [];
  const by = other(gs.current);
  return checkLines(gs).map(line => ({ line, player: by }));
}

/**
 * 詰み ends the game before the loser moves. A person who lost that way may look at the
 * final board (「盤面を確認する」) and, if they think it was misjudged, still play that turn
 * (「誤審の訂正」): it ends like any other turn.
 */
function canPlayOn(): boolean {
  return gs.status === `win:${other(gs.current)}` && gs.winReason === 'mate'
    && (match.mode !== 'cpu' || gs.current === match.human);
}
/** Only that turn can face the player to move with a line no cube move breaks (in normal play it would be over). */
function playingOn(): boolean {
  return gs.status === 'playing' && isMate(gs.board, other(gs.current));
}
/** Outcome hints: as set, and always on the turn played after 詰み, since that turn is for checking. */
function hintsOn(): boolean {
  return settings.showHints || playingOn();
}
/** The next stronger CPU level (level 6 once unlocked), if there is one. */
function nextLevelOf(): CpuLevel | null {
  if (match.mode !== 'cpu') return null;
  const levels: CpuLevel[] = loadProgress().unlocked ? [...NORMAL_LEVELS, HIDDEN_LEVEL] : [...NORMAL_LEVELS];
  const i = levels.indexOf(match.level);
  return i >= 0 && i < levels.length - 1 ? levels[i + 1] : null;
}
/** "YOUR TURN" / "CPU TURN" / "PLAYER 1 TURN". */
function turnName(p: Player): string {
  if (match.mode === 'cpu') return p === match.human ? 'YOUR TURN' : 'CPU TURN';
  return `${nameOf(p)} TURN`;
}

/** "YOU WIN" / "CPU WIN" / "PLAYER 1 WIN" / "DRAW", with a short note only for the unusual endings. */
function resultText(state: GameState): { title: string; reason: string; color: string } {
  if (state.status === 'win:O' || state.status === 'win:X') {
    const w: Player = state.status === 'win:O' ? 'O' : 'X';
    const title = match.mode === 'cpu' ? (w === match.human ? 'YOU WIN' : 'CPU WIN') : `${nameOf(w)} WIN`;
    const reason = state.winReason === 'timeout' ? t().result.timeout : state.winReason === 'selfDestruct' ? t().result.selfDestruct : '';
    return { title, reason, color: PLAYER_COLORS[w].css };
  }
  return { title: 'DRAW', reason: t().result.limit(state.settings.turnLimit), color: '#ffcc4d' };
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
  el.classList.toggle('reviewing', reviewing);
  el.classList.toggle('cpu-turn', cpuActing);
  scene.setTurn(gs.current);
  scene.setBoard(gs.board);
  scene.setLastMoved(lastMoved);
  scene.setSelected(phase === 'step1-move-from' ? selectedFrom : null);
  scene.setTargets(targetsNow(), gs.current);
  scene.setLabelsVisible((phase === 'step2' && gs.status === 'playing') || reviewing);
  scene.setHover(null, null);
  ui.schematic.setHover(null);
  if (gs.status === 'playing') scene.clearWin();
  scene.setCheck(checkEntries());
  const checked = gs.status === 'playing' && inCheck(gs);
  controls.render({
    state: gs, phase, selectedFrom, canPlace: canPlaceNow(), step1Label: step1Label(), log,
    resultText: gs.status !== 'playing' ? resultText(gs).title : undefined,
    canReview: canPlayOn(),
    reviewing,
    nextLevel: nextLevelOf() !== null,
    names: { O: nameOf('O'), X: nameOf('X') },
    cpu: match.mode === 'cpu' ? { side: other(match.human), label: levelLabel(match.level), acting: cpuActing } : null,
    check: checked
      ? { by: other(gs.current), escapes: hintsOn() ? breakingMoves(gs.board, other(gs.current)).length : null }
      : null,
  });
  controls.setBusy(locked());
  updatePreview();
  updateHud();
  persist();
  maybeStartCpu();
}

function schematicState(preview: SchematicState['preview'], guide: CubeMove | null): SchematicState {
  // a preview shows another board, where the winning cells are elsewhere
  const win = gs.status !== 'playing' && !preview ? [...new Set(winEntries(gs).flatMap(e => e.line))] : [];
  return {
    board: gs.board,
    targets: targetsNow(),
    selected: phase === 'step1-move-from' ? selectedFrom : null,
    lastMoved,
    win,
    check: checkEntries().flatMap(e => e.line),
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
    // during the CPU's turn only its own choice is shown
    move = cpuActing ? selectedMove : (hoverMove ?? selectedMove);
    candidate = move !== null;
  } else if (reviewing && !busy) {
    move = hoverMove ?? selectedMove;
    candidate = move !== null;
  } else if (peekLast && gs.lastCubeMove && gs.status === 'playing' && !locked()) {
    move = gs.lastCubeMove;
  }

  let outcome: Outcome | null = null;
  let lines: { line: Line; player: Player }[] = [];
  let after: Mark[] | null = null;
  if (candidate && move) {
    // reviewing: the finished game is tried as if the mated player were still to move
    const base: GameState = reviewing ? { ...gs, status: 'playing' } : gs;
    const res = resolveAfterCubeMove(base, move);
    after = res.board;
    if (hintsOn() || reviewing) {
      // the outcome text speaks to the mover, so it is only shown for your own moves
      if (!cpuActing) outcome = outcomeOf(res, base.current, inCheck(base));
      lines = completedLines(res.board).map(line => ({ line, player: res.board[line[0]] as Player }));
    }
  }
  scene.setCubeMovePreview(move, { lines, ghosts: candidate, muted: !candidate });
  schematic.update(schematicState(candidate && move && after ? { move, after } : null, move));
  controls.setSelected(selectedMove);
  controls.setPreviewInfo(candidate ? move : null, outcome);
}

function outcomeOf(res: GameState, mover: Player, checked: boolean): Outcome | null {
  if (res.status === `win:${mover}`) return 'mate';
  if (res.status === 'win:O' || res.status === 'win:X') return res.winReason === 'notBroken' ? 'notBroken' : 'self';
  if (res.status === 'draw') return 'limit';
  if (completedLines(res.board, mover).length > 0) return 'check';
  return checked ? 'escape' : null;
}

/**
 * Top bar: 〇 on the left and × on the right (name, hand, clock), the turn status in between.
 * Only 王手 is highlighted; otherwise it simply reads YOUR TURN / CPU TURN / PLAYER n TURN.
 */
function updateHud(): void {
  if (!ui) return;
  const H = t().hud;
  const playing = gs.status === 'playing';
  const clock = gameClock();
  for (const p of ['O', 'X'] as const) {
    const el = ui.hud.querySelector<HTMLElement>(`[data-side="${p}"]`);
    if (!el) continue;
    const n = gs.hand[p];
    const dots = Array.from({ length: 6 }, (_, i) => `<i class="${i < n ? 'in' : ''}"></i>`).join('');
    const lv = match.mode === 'cpu' && p !== match.human ? `<small>${levelLabel(match.level)}</small>` : '';
    el.className = `hud-side ${p.toLowerCase()}${playing && !reviewing && gs.current === p ? ' cur' : ''}`;
    el.innerHTML = `<span class="hud-chip">${PLAYER_COLORS[p].glyph}</span>
      <span class="hud-info"><span class="hud-name">${nameOf(p)}${lv}</span>
        <span class="hud-hand" title="${H.handTip(n)}"><span class="dots">${dots}</span><span class="hud-hand-n">${n > 0 ? H.hand(n) : H.movePhase}</span></span></span>
      ${clock ? `<span class="hud-clock" data-clock="${p}" title="${H.clockTip}">${icon('timer')}<b></b></span>` : ''}`;
  }
  const st = ui.hud.querySelector<HTMLElement>('.hud-status');
  if (st) {
    const s = hudStatus();
    st.className = `hud-status ${s.cls}`;
    st.innerHTML = `<span class="hud-main">${s.main}</span><span class="hud-sub">${s.sub}</span>`;
  }
  renderClocks();
}

function hudStatus(): { main: string; sub: string; cls: string } {
  const H = t().hud;
  const ply = `<span class="hud-ply">${H.ply(gs.ply, gs.settings.turnLimit)}</span>`;
  if (reviewing) return { main: H.reviewing, sub: `<span>${H.reviewingSub}</span>`, cls: 'review' };
  if (gs.status !== 'playing') return { main: resultText(gs).title, sub: ply, cls: 'over' };
  const s1 = phase !== 'step2';
  const steps = `<span class="st ${s1 ? 'on' : 'done'}">①${step1Label()}</span><span class="st ${s1 ? '' : 'on'}">②${H.cube}</span>`;
  const checked = inCheck(gs);
  if (isCpuTurn()) {
    const dots = cpuActing && s1 ? '<span class="think-dots"><i></i><i></i><i></i></span>' : '';
    // the CPU being in check is your 王手: a small mark, not the highlight
    return { main: `CPU TURN${dots}${checked ? `<span class="hud-badge">${H.checkBadge}</span>` : ''}`, sub: steps + ply, cls: 'cpu' };
  }
  if (checked) {
    const who = match.mode === 'local' ? `<span class="hud-who">${nameOf(gs.current)}</span>` : '';
    return { main: H.check, sub: who + steps + ply, cls: 'check' };
  }
  return { main: turnName(gs.current), sub: steps + ply, cls: 'turn' };
}

function announceTurn(): void {
  if (!ui || gs.status !== 'playing') return;
  const P = PLAYER_COLORS[gs.current];
  const checked = inCheck(gs);
  const H = t().hud;
  const sub = checked ? H.bannerCheck : canPlaceNow() ? H.bannerHand(gs.hand[gs.current]) : H.movePhase;
  ui.banner.innerHTML = `<div class="banner-inner ${gs.current.toLowerCase()}${checked ? ' check' : ''}"><span class="b-chip">${P.glyph}</span><span class="b-main">${turnName(gs.current)}</span><span class="b-sub">${sub}</span></div>`;
  ui.banner.classList.remove('show');
  void ui.banner.offsetWidth;
  ui.banner.classList.add('show');
  ui.live.textContent = checked
    ? H.liveCheck(nameOf(gs.current), nameOf(other(gs.current)))
    : H.liveTurn(nameOf(gs.current));
  if (checked) sound.check();
  else sound.turn(gs.current);
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
  if (cpuActing) return; // the CPU's own hover marker is showing
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
  if (!ui || gs.status !== 'playing') return;
  if (cpuActing) {
    if (raw !== null && performance.now() - lastBusyToast > 2500) {
      lastBusyToast = performance.now();
      toast(t().toast.cpuTurn);
    }
    return;
  }
  if (busy) return;
  if (phase === 'step2') {
    if (raw !== null) {
      sound.invalid();
      toast(t().toast.pickCube, 'info');
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
  const T = t().toast;
  if (canPlaceNow()) toast(m ? T.occupied : T.cantPlace, 'warn');
  else if (m && m !== gs.current) toast(T.notYours, 'warn');
  else if (!m && phase === 'step1') toast(T.pickOwn, 'warn');
  else toast(T.cantPick, 'warn');
}

function pushHistory(): void {
  history.push(snapshot());
  if (history.length > HISTORY_MAX) history.shift();
}

function setBusy(b: boolean): void {
  busy = b;
  if (!ui) return;
  ui.el.classList.toggle('busy', b);
  ui.controls.setBusy(locked());
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
  noteOwnLine(mark);
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
  sound.move(mark); // it lands with the place sound, timed to the animation's touchdown
  const next = applyStep1Move(gs, from, to);
  log = [...log, { ply: gs.ply + 1, player: mark, step1: { kind: 'move', from, to }, cube: null }];
  u.scene.setSelected(null);
  await u.scene.animateMove(from, to, mark).catch(() => undefined);
  if (ui !== u) return;
  gs = next;
  lastMoved = to;
  selectedFrom = null;
  noteOwnLine(mark);
  phase = 'step2';
  selectedMove = null;
  setBusy(false);
  refresh();
}

/** Step ① completed your own line: it only counts if it survives your cube move (then it is 王手). */
function noteOwnLine(mark: Player): void {
  if (gs.status !== 'playing' || cpuActing || completedLines(gs.board, mark).length === 0) return;
  toast(isMate(gs.board, mark) ? t().toast.unbreakable : t().toast.ownLine);
}

async function doCubeMove(move: CubeMove): Promise<void> {
  const u = ui;
  if (!u || busy || phase !== 'step2' || gs.status !== 'playing') return;
  if (!legalCubeMoves(gs).some(m => movesEqual(m, move))) { sound.invalid(); return; }
  tcEndTurn(gs.current); // the turn is over once the cube move is confirmed
  pushHistory();
  sound.confirm();
  selectedMove = null;
  hoverMove = null;
  setBusy(true);
  u.scene.setLabelsVisible(false);
  u.scene.setCheck([]); // the pieces are about to move
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
  tcStart();
}

function finishLog(): void {
  const lastEntry = log[log.length - 1];
  if (lastEntry) log = [...log.slice(0, -1), { ...lastEntry, result: gs.status }];
}

async function finishGame(): Promise<void> {
  const u = ui;
  if (!u) return;
  cpuActing = false;
  clockOff();
  tcPause();
  clearSave();
  setBusy(true);
  refresh();
  u.scene.showWin(winEntries(gs));
  // against the CPU the jingle is from your side: a CPU win sounds like a loss
  const happy = match.mode !== 'cpu' || gs.status === `win:${match.human}`;
  if (match.mode === 'cpu') {
    const result: GameResult = gs.status === 'draw' ? 'd' : happy ? 'w' : 'l';
    justUnlocked = recordResult(match.level, result, { undos: match.undos });
    recorded = { level: match.level, result };
  }
  if (gs.status === 'draw') sound.draw();
  else if (gs.winReason === 'selfDestruct') sound.selfDestruct(happy);
  else if (happy) sound.win();
  else sound.lose();
  u.live.textContent = `${resultText(gs).title} ${resultText(gs).reason}`;
  await wait(gs.winReason === 'selfDestruct' ? 1500 : 1100);
  if (ui !== u) return;
  setBusy(false);
  refresh();
  showResult();
}

/**
 * 「盤面を確認する」 (after 詰み): the result closes and every cube move can be previewed on
 * the final board, without playing it. 「誤審の訂正」 there plays on (see playOn).
 */
function reviewBoard(): void {
  if (!ui || busy || !canPlayOn()) return;
  resultModal?.close();
  resultModal = null;
  reviewing = true;
  selectedMove = null;
  hoverMove = null;
  refresh();
}

/**
 * 「誤審の訂正」: the game goes on from the 詰み position with the mated player to move.
 * That turn ends like any other: if the opponent's line is still on the board, it is lost.
 */
function playOn(): void {
  if (!ui || busy || !canPlayOn()) return;
  resultModal?.close();
  resultModal = null;
  reviewing = false;
  if (recorded) { // the result is counted when that turn ends
    recordResult(recorded.level, recorded.result, { undos: 0, undo: true });
    recorded = null;
  }
  const next: GameState = { ...gs, status: 'playing' };
  delete next.winReason;
  gs = next;
  const last = log[log.length - 1];
  if (last?.result) {
    const entry: LogEntry = { ...last };
    delete entry.result;
    log = [...log.slice(0, -1), entry];
  }
  phase = 'step1';
  selectedFrom = null;
  selectedMove = null;
  clockOn();
  refresh();
  announceTurn();
  tcStart();
}

/** 次のレベル: a new game against the next stronger CPU, with the same turn order and clock. */
function startNextLevel(): void {
  const lv = nextLevelOf();
  if (!lv || match.mode !== 'cpu') return;
  setSetting('cpuLevel', lv);
  startGame({ ...match, level: lv });
}

/** 取消 (step ②): take back this turn's placement or move, to make it again. */
function cancelStep1(): void {
  if (!ui || busy || cpuActing || phase !== 'step2' || gs.status !== 'playing') return;
  // the snapshot taken just before this turn's step ①
  const snap = history[history.length - 1];
  if (!snap || snap.gameState.ply !== gs.ply || snap.gameState.current !== gs.current) return;
  const kind = log[log.length - 1]?.step1.kind === 'move' ? 'move' : 'place';
  history = history.slice(0, -1);
  restore(snap);
  // a move starts over from choosing the piece, not with it still lifted
  if (snap.phase === 'step1-move-from') { phase = 'step1'; selectedFrom = null; }
  sound.undo();
  toast(t().toast.undone(kind));
  refresh();
}

function restore(snap: Snapshot): void {
  if (!ui) return;
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
}

// ── CPU turn ───────────────────────────────────────────────────────────────
function cancelCpu(): void {
  cpuToken++;
  cpu?.cancel();
  cpuActing = false;
}

function maybeStartCpu(): void {
  if (!ui || !cpu || cpuActing || busy || !isCpuTurn()) return;
  const token = cpuToken;
  setTimeout(() => { if (token === cpuToken) void runCpuTurn(); }, 30);
}

/**
 * On a clock the CPU must not lose on time: it keeps its search well inside the
 * time left (its turn also spends ~2 s showing the move). Undefined = the level's own budget.
 */
function cpuThinkBudget(level: CpuLevel): number | undefined {
  const c = gameClock();
  if (!c) return undefined;
  const own = LEVEL_PARAMS[level].timeMs;
  if (own <= 0) return undefined;
  const left = c.left[gs.current] - tcUsed(c);
  const cap = left > 0 ? Math.max(400, left / 12) : c.byoyomiMs - 4000;
  return Math.max(300, Math.min(own, cap));
}

async function untilNoModal(alive: () => boolean): Promise<void> {
  if (!isModalOpen()) return;
  // pause while the rules / settings are open so you don't miss the CPU's move
  // (that wait is yours, so the CPU's clock is held meanwhile)
  tcHold = true;
  tcPause();
  while (alive() && isModalOpen()) await new Promise<void>(r => setTimeout(r, 200));
  tcHold = false;
  if (alive()) tcStart();
}

/**
 * The CPU's turn, shown at a readable pace: think → point at its cell (or
 * lift its piece) → place / move → show the chosen cube move → play it.
 */
async function runCpuTurn(): Promise<void> {
  const u = ui, client = cpu;
  if (!u || !client || cpuActing || busy || !isCpuTurn() || match.mode !== 'cpu') return;
  const level = match.level;
  const token = ++cpuToken;
  const alive = (): boolean => token === cpuToken && ui === u;
  cpuActing = true;
  selectedMove = null;
  hoverMove = null;
  refresh();

  const step1Done = phase === 'step2';
  const [decision] = await Promise.all([
    client.think(gs, level, step1Done, cpuThinkBudget(level)),
    wait((step1Done ? 450 : 800) + Math.random() * 400),
  ]);
  if (!alive()) return;
  if (!decision) { cpuActing = false; refresh(); return; }
  await untilNoModal(alive);
  if (!alive()) return;

  const me = gs.current;
  if (!step1Done && decision.step1) {
    const a = decision.step1;
    if (a.kind === 'place') {
      u.scene.setHover(a.index, me);
      u.schematic.setHover(a.index);
      await wait(380);
      if (!alive()) return;
      u.scene.setHover(null, null);
      u.schematic.setHover(null);
      u.live.textContent = t().hud.liveCpu(describeStep1(a, getLang()));
      await doPlace(a.index);
    } else {
      u.scene.setSelected(a.from);
      sound.select();
      await wait(520);
      if (!alive()) return;
      u.live.textContent = t().hud.liveCpu(describeStep1(a, getLang()));
      await doMove(a.from, a.to);
    }
    if (!alive() || gs.status !== 'playing') return; // e.g. the clock ran out meanwhile
  }

  const cube = decision.cube;
  selectedMove = cube;
  sound.preview();
  updatePreview();
  u.live.textContent = t().hud.liveCpu(describeMove(cube, getLang()));
  await wait(1050);
  if (!alive()) return;
  await untilNoModal(alive);
  if (!alive()) return;
  cpuActing = false;
  await doCubeMove(cube);
}

// ── Controls panel events ──────────────────────────────────────────────────
function onControlEvent(e: ControlEvent): void {
  sound.unlock();
  // while the CPU plays, only the result / navigation stay available
  if (cpuActing && e.type !== 'showResult' && e.type !== 'replay' && e.type !== 'title') return;
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
      if (selectedMove && !reviewing) void doCubeMove(selectedMove);
      break;
    case 'cancel':
      cancelStep1();
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
    case 'review':
      sound.click();
      reviewBoard();
      break;
    case 'playOn':
      sound.click();
      playOn();
      break;
    case 'nextLevel':
      sound.click();
      startNextLevel();
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
  toast(settings.sound ? t().game.soundOn : t().game.soundOff);
}
function toggleSymbols(): void {
  setSetting('showSymbols', !settings.showSymbols);
  sound.toggle(settings.showSymbols);
  toast(settings.showSymbols ? t().game.symbolsOn : t().game.symbolsOff);
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
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const scene = ui.scene;
  switch (k) {
    case 'Escape':
      if (cpuActing) break;
      if (reviewing) cancelMove();
      else if (phase === 'step2') cancelStep1();
      else deselectPiece();
      break;
    case 'Enter': {
      // Plain buttons keep their native Enter; on the move grid Enter means "confirm".
      const onButton = t?.tagName === 'BUTTON' && !t.classList.contains('op-btn');
      if (onButton) return;
      if (phase === 'step2' && selectedMove && !locked()) {
        e.preventDefault();
        void doCubeMove(selectedMove);
      }
      break;
    }
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
  const m = openModal({
    title: t().rules.title, subtitle: t().rules.tag, content: rulesHTML(), className: 'wide rules-modal',
    actions: [{ label: t().common.close, kind: 'primary' }],
  });
  // table of contents: jump within the dialog (no URL change)
  m.el.querySelectorAll<HTMLButtonElement>('.rules-nav button').forEach(b => {
    b.addEventListener('click', () => {
      sound.click();
      m.el.querySelector(`#${b.dataset['to'] ?? ''}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

/**
 * The result: YOU WIN / CPU WIN (PLAYER n WIN), a few figures, and タイトルへ・もう一度・次のレベル.
 * After a 詰み loss, 「盤面を確認する」 comes in a window of its own beside it.
 */
function showResult(): void {
  if (!ui || gs.status === 'playing') return;
  if (reviewing) {
    reviewing = false;
    selectedMove = null;
    refresh();
  }
  resultModal?.close();
  const TR = t().result, TC = t().common;
  const r = resultText(gs);
  const winner: Player | null = gs.status === 'win:O' ? 'O' : gs.status === 'win:X' ? 'X' : null;
  const placed = log.filter(e => e.step1.kind === 'place').length;
  const moved = log.length - placed;
  const vsCpu = match.mode === 'cpu' ? match : null;
  const unlock = vsCpu && justUnlocked
    ? `<div class="unlock" role="status">${icon('zap')}<div><b>${TR.unlockTitle}</b>
        <span>${TR.unlockBody(levelLabel(HIDDEN_LEVEL))}</span></div></div>`
    : '';
  const body = `
    <div class="result" style="--rc:${r.color}">
      <div class="result-icon">${winner ? `<span class="rchip ${winner.toLowerCase()}">${PLAYER_COLORS[winner].glyph}</span>` : '<span class="rchip draw">＝</span>'}</div>
      <div class="result-title">${r.title}</div>
      ${r.reason ? `<div class="result-reason">${r.reason}</div>` : ''}
      <dl class="stats">
        <div><dt>${TR.moves}</dt><dd>${gs.ply}</dd></div>
        ${vsCpu?.clock
          ? `<div><dt>${TR.timeLeft}</dt><dd>${vsCpu.clock.left[vsCpu.human] > 0 || gs.winReason === 'timeout'
            ? fmtClock(vsCpu.clock.left[vsCpu.human]) : TR.byoyomi}</dd></div>`
          : `<div><dt>${TR.placedMoved}</dt><dd>${placed}${getLang() === 'ja' ? '／' : ' / '}${moved}</dd></div>`}
        <div><dt>${TR.elapsed}</dt><dd>${fmtTime(currentElapsed())}</dd></div>
      </dl>
      ${unlock}
    </div>`;
  const actions: ModalAction[] = [
    { label: TC.toTitle, kind: 'ghost', onClick: () => { renderTitle(); } },
    { label: TC.replay, kind: 'primary', autofocus: true, onClick: () => { startGame(); } },
  ];
  if (nextLevelOf()) actions.push({ label: TC.nextLevel, kind: 'ghost', onClick: () => { startNextLevel(); } });
  const aside = canPlayOn()
    ? `<div class="aside-head">${icon('eye')}<b>${TR.reviewHead}</b></div>
      <p>${TR.reviewBody(nameOf(other(gs.current)))}</p>
      <button type="button" class="btn ok" data-act="review">${icon('eye')}${TR.review}</button>`
    : undefined;
  resultModal = openModal({
    content: body,
    className: 'result-modal',
    actions,
    aside,
    onClose: () => { resultModal = null; },
  });
  resultModal.aside?.querySelector('[data-act="review"]')?.addEventListener('click', () => { sound.click(); reviewBoard(); });
  if (justUnlocked) {
    sound.secret(0.5);
    justUnlocked = false;
  }
}

function confirmQuit(): void {
  if (gs.status !== 'playing') { renderTitle(); return; }
  const P = t().pause;
  const vs = match.mode === 'cpu' ? P.vsCpu(levelLabel(match.level)) : P.two;
  const clock = clockFaces();
  openModal({
    title: P.title, subtitle: P.tag,
    content: `<div class="pause-sum"><span>${vs}</span><span>${P.ply(gs.ply)}</span><span>${P.turn(nameOf(gs.current))}</span>${
      clock && match.mode === 'cpu' ? `<span>${icon('timer')}${clock[match.human].text}</span>` : ''}</div>
      <p>${P.ask}</p>
      <p class="pause-note">${icon('check')}${P.saved}</p>`,
    actions: [
      { label: t().common.toTitle, kind: 'ghost', onClick: () => { renderTitle(); } },
      { label: P.keep, kind: 'primary', autofocus: true },
    ],
  });
}

function showSettings(): void {
  const S = t().settings;
  const body = document.createElement('div');
  body.className = 'settings';
  const seg = <T extends string>(name: string, opts: [T, string][], cur: T): string =>
    `<div class="seg" role="radiogroup" data-seg="${name}">${opts.map(([v, l]) =>
      `<button type="button" role="radio" data-v="${v}" aria-checked="${v === cur}">${l}</button>`).join('')}</div>`;
  body.innerHTML = `
    <section class="set-card sound">
      <h3>${icon('soundOn')}${S.sound}</h3>
      <label class="row"><span>${S.sfx}</span><input type="checkbox" class="switch" data-k="sound" ${settings.sound ? 'checked' : ''}></label>
      <label class="row"><span>${S.volume}</span><input type="range" min="0" max="100" step="5" data-k="volume" value="${Math.round(settings.volume * 100)}"></label>
    </section>
    <section class="set-card disp">
      <h3>${icon('eye')}${S.display}</h3>
      <div class="row"><span>${S.anim}</span>${seg<AnimSpeed>('animSpeed', [['slow', S.slow], ['normal', S.normal], ['fast', S.fast]], settings.animSpeed)}</div>
      <label class="row"><span>${S.symbols}<small>${S.symbolsSub}</small></span><input type="checkbox" class="switch" data-k="showSymbols" ${settings.showSymbols ? 'checked' : ''}></label>
      <label class="row"><span>${S.hints}<small>${S.hintsSub}</small></span><input type="checkbox" class="switch" data-k="showHints" ${settings.showHints ? 'checked' : ''}></label>
      <label class="row"><span>${S.explode}<small>${S.explodeSub}</small></span><input type="checkbox" class="switch" data-k="explode" ${settings.explode ? 'checked' : ''}></label>
    </section>
    <section class="set-card rules">
      <h3>${icon('cube')}${S.rules} <small>${S.rulesSub}</small></h3>
      <div class="row"><span>${S.first}<small>${S.firstSub}</small></span>${seg<FirstPlayer>('firstPlayer', [['O', S.blue], ['X', S.red], ['random', t().common.random]], settings.firstPlayer)}</div>
      <label class="row"><span>${S.limit}<small>${S.limitSub}</small></span>
        <select data-k="turnLimit">${TURN_LIMITS.map(v => `<option value="${v ?? ''}" ${v === settings.turnLimit ? 'selected' : ''}>${v ? S.limitN(v) : t().common.none}</option>`).join('')}</select>
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

  openModal({ title: S.title, subtitle: S.tag, content: body, className: 'settings-modal', actions: [{ label: t().common.close, kind: 'primary' }] });
}

// ═══════════════════════════════ Entry ═════════════════════════════════════

export function initApp(el: HTMLElement): void {
  root = el;
  setLang(settings.lang);
  applySettings();
  const unlock = (): void => sound.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  document.addEventListener('keydown', onKey);
  // leaving the page suspends the game: the play time and 持ち時間 stop until you come back
  document.addEventListener('visibilitychange', () => {
    if (!ui) return;
    if (document.hidden) { clockOff(); tcPause(); persist(); }
    else { clockOn(); tcStart(); }
  });
  window.addEventListener('pagehide', () => { if (ui) { clockOff(); tcPause(); persist(); } });
  renderTitle();
}

