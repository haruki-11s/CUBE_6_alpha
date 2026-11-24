/**
 * Plays the sound effects made in sfx.ts (no audio files, works offline). No BGM by design.
 *
 * Each effect is rendered into a buffer the first time it is needed (the common ones in idle time
 * right after the first tap or key press) and then played as is, through one shared room.
 * Sounds that go with an animation are cut to its current speed setting (tween.ts).
 */
import { getAnimSpeed } from './tween';
import { moveLanding, renderSfx, roomImpulse, sfxKey, type SfxSpec, type Side } from './sfx';

type Ctx = BaseAudioContext;

function liveContext(): Ctx | null {
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AC ? new AC() : null;
}

/** In idle time when the browser offers it, else soon. */
function later(f: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => f(), { timeout: 400 });
  else setTimeout(f, 16);
}

export class SoundEngine {
  private ctx: Ctx | null = null;
  /** an OfflineAudioContext (previews, measurements) needs no resume and has no user gesture */
  private live = true;
  private master: GainNode | null = null;
  private room: ConvolverNode | null = null;
  private readonly cache = new Map<string, { buf: AudioBuffer; wet: number }>();
  private enabled = true;
  private volume = 0.7;
  private lastHover = 0;

  /** `makeContext` can supply another context, e.g. an OfflineAudioContext for rendering to a file. */
  constructor(private readonly makeContext: () => Ctx | null = liveContext) {}

  configure(enabled: boolean, volume: number): void {
    this.enabled = enabled;
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.02);
    }
  }

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const ctx = this.makeContext();
        if (!ctx) return;
        this.ctx = ctx;
        this.live = !('startRendering' in ctx);
        this.master = ctx.createGain();
        this.master.gain.value = this.enabled ? this.volume : 0;
        this.master.connect(ctx.destination);
        const ir = roomImpulse(ctx.sampleRate);
        const irBuf = ctx.createBuffer(2, ir.l.length, ctx.sampleRate);
        irBuf.copyToChannel(ir.l, 0);
        irBuf.copyToChannel(ir.r, 1);
        this.room = ctx.createConvolver();
        this.room.normalize = false;
        this.room.buffer = irBuf;
        this.room.connect(this.master);
        if (this.live) this.warmUp();
      }
      if (this.live && this.ctx.state !== 'running') void (this.ctx as AudioContext).resume();
    } catch {
      /* audio unavailable: stay silent */
    }
  }

  private ready(): Ctx | null {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !this.master) return null;
    if (this.live && ctx.state !== 'running') {
      void (ctx as AudioContext).resume();
      return null;
    }
    return ctx;
  }

  private get(ctx: Ctx, spec: SfxSpec): { buf: AudioBuffer; wet: number } {
    const key = sfxKey(spec);
    let e = this.cache.get(key);
    if (!e) {
      const s = renderSfx(spec, ctx.sampleRate);
      const buf = ctx.createBuffer(2, s.l.length, ctx.sampleRate);
      buf.copyToChannel(s.l, 0);
      buf.copyToChannel(s.r, 1);
      e = { buf, wet: s.wet };
      this.cache.set(key, e);
    }
    return e;
  }

  /** Renders the sounds a game uses all the time, one per idle slot, so none waits on first use. */
  private warmUp(): void {
    const speed = getAnimSpeed();
    const list: SfxSpec[] = [
      { id: 'click' }, { id: 'hover' }, { id: 'open' }, { id: 'close' }, { id: 'select' }, { id: 'start' },
      { id: 'place', side: 'O' }, { id: 'place', side: 'X' }, { id: 'preview' }, { id: 'confirm' },
      { id: 'rotate', speed }, { id: 'slide', speed }, { id: 'move', speed },
      { id: 'turn', side: 'O' }, { id: 'turn', side: 'X' }, { id: 'check' }, { id: 'deselect' }, { id: 'cancel' },
      { id: 'invalid' }, { id: 'undo' }, { id: 'win' }, { id: 'lose' },
    ];
    const next = (): void => {
      const s = list.shift();
      if (!s || !this.ctx) return;
      try { this.get(this.ctx, s); } catch { return; }
      later(next);
    };
    later(next);
  }

  /** Plays an effect `at` seconds from now; `vary` detunes it at random by up to ± that fraction. */
  private play(spec: SfxSpec, at = 0, vary = 0): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    try {
      const { buf, wet } = this.get(ctx, spec);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (vary) src.playbackRate.value = 1 + (Math.random() * 2 - 1) * vary;
      src.connect(this.master);
      if (wet > 0 && this.room) {
        const send = ctx.createGain();
        send.gain.value = wet;
        src.connect(send);
        send.connect(this.room);
      }
      src.start(ctx.currentTime + Math.max(0, at));
    } catch {
      /* a sound is never worth an error */
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────
  click(): void { this.play({ id: 'click' }, 0, 0.03); }
  hover(): void {
    const now = performance.now();
    if (now - this.lastHover < 45) return;
    this.lastHover = now;
    this.play({ id: 'hover' }, 0, 0.04);
  }
  toggle(on: boolean): void { this.play({ id: 'toggle', on }); }
  open(): void { this.play({ id: 'open' }); }
  close(): void { this.play({ id: 'close' }); }
  whoosh(): void { this.play({ id: 'whoosh' }); }
  invalid(): void { this.play({ id: 'invalid' }); }
  // ── Clock ─────────────────────────────────────────────────────────────
  /** 秒読み countdown: a soft tick, or a sharper one for the last seconds. */
  tick(urgent = false): void { this.play({ id: 'tick', urgent }); }
  /** Main time used up: from now on every turn is on 秒読み. */
  byoyomi(): void { this.play({ id: 'byoyomi' }); }
  start(): void { this.play({ id: 'start' }); }

  // ── Board ─────────────────────────────────────────────────────────────
  select(): void { this.play({ id: 'select' }, 0, 0.03); }
  deselect(): void { this.play({ id: 'deselect' }, 0, 0.03); }
  place(player: Side): void { this.play({ id: 'place', side: player }, 0, 0.02); }
  /** A piece moving: its flight, then the place sound as it touches down (scene3d's animateMove). */
  move(player: Side): void {
    const speed = getAnimSpeed();
    this.play({ id: 'move', speed });
    this.play({ id: 'place', side: player }, moveLanding(speed), 0.02);
  }
  preview(): void { this.play({ id: 'preview' }, 0, 0.03); }
  confirm(): void { this.play({ id: 'confirm' }); }
  cancel(): void { this.play({ id: 'cancel' }); }
  /** A layer turn: air while it turns, a click as it snaps in (animateRotate). */
  rotate(): void { this.play({ id: 'rotate', speed: getAnimSpeed() }); }
  /** A layer slide: air while it slides, a soft stop (animateSlide). */
  slide(): void { this.play({ id: 'slide', speed: getAnimSpeed() }); }
  turn(player: Side): void { this.play({ id: 'turn', side: player }); }
  /** 王手 */
  check(): void { this.play({ id: 'check' }); }
  undo(): void { this.play({ id: 'undo' }); }

  // ── Results ───────────────────────────────────────────────────────────
  win(offset = 0): void { this.play({ id: 'win' }, offset); }
  /** Defeat against the CPU: short and muted. */
  lose(offset = 0): void { this.play({ id: 'lose' }, offset); }
  /** A muffled hit, then the winner's sound, or `lose()` when the listener is the one who lost. */
  selfDestruct(listenerWins = true): void {
    this.play({ id: 'boom' });
    if (listenerWins) this.win(0.55);
    else this.lose(0.55);
  }
  /** Hidden level unlocked. */
  secret(offset = 0): void { this.play({ id: 'secret' }, offset); }
  draw(): void { this.play({ id: 'draw' }); }
}

export const sound = new SoundEngine();
