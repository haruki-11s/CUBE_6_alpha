export type AnimSpeed = 'slow' | 'normal' | 'fast';
export type FirstPlayer = 'O' | 'X' | 'random';

export interface Settings {
  sound: boolean;
  volume: number;          // 0..1
  animSpeed: AnimSpeed;
  showSymbols: boolean;    // 刻印表示: ○/× on the 3D spheres
  showHints: boolean;      // outcome prediction + completed-line preview
  explode: boolean;        // spread the layers apart
  turnLimit: number | null;
  firstPlayer: FirstPlayer;
}

export const SPEED_MULT: Readonly<Record<AnimSpeed, number>> = { slow: 1.5, normal: 1, fast: 0.55 };
export const TURN_LIMITS: readonly (number | null)[] = [null, 20, 30, 50, 100];

const KEY = 'cube6-settings';

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export function defaultSettings(): Settings {
  return {
    sound: true,
    volume: 0.7,
    animSpeed: prefersReducedMotion() ? 'fast' : 'normal',
    showSymbols: false,
    showHints: true,
    explode: false,
    turnLimit: null,
    firstPlayer: 'O',
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const legacy = localStorage.getItem('cube6-symbols'); // pre-1.1 checkbox
    if (legacy !== null) d.showSymbols = legacy === '1';
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const v = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    const bool = (x: unknown, fb: boolean): boolean => (typeof x === 'boolean' ? x : fb);
    return {
      sound: bool(v.sound, d.sound),
      volume: typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1 ? v.volume : d.volume,
      animSpeed: v.animSpeed === 'slow' || v.animSpeed === 'normal' || v.animSpeed === 'fast' ? v.animSpeed : d.animSpeed,
      showSymbols: bool(v.showSymbols, d.showSymbols),
      showHints: bool(v.showHints, d.showHints),
      explode: bool(v.explode, d.explode),
      turnLimit: v.turnLimit === null || (typeof v.turnLimit === 'number' && Number.isInteger(v.turnLimit) && v.turnLimit > 0)
        ? (v.turnLimit as number | null) : d.turnLimit,
      firstPlayer: v.firstPlayer === 'O' || v.firstPlayer === 'X' || v.firstPlayer === 'random' ? v.firstPlayer : d.firstPlayer,
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
