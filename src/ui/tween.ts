export type Easing = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
} satisfies Record<string, Easing>;

let speed = 1;
/** Global animation-duration multiplier (settings: slow / normal / fast). */
export function setAnimSpeed(mult: number): void { speed = Math.max(0.1, mult); }
export function getAnimSpeed(): number { return speed; }

/**
 * rAF-driven tween. `onUpdate` receives the eased progress (0..1) and is always
 * called with 1 at the end. Robust against background tabs (rAF paused): the
 * promise resolves immediately when the page is hidden and has a timeout fallback.
 */
export function tween(ms: number, onUpdate: (t: number) => void, easing: Easing = ease.inOutCubic): Promise<void> {
  const dur = ms * speed;
  if (dur <= 0 || typeof document === 'undefined' || document.hidden) {
    onUpdate(1);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const start = performance.now();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      try { onUpdate(1); } catch (e) { console.error(e); }
      resolve();
    };
    const fallback = setTimeout(finish, dur + 1000);
    const tick = (now: number): void => {
      if (done) return;
      const raw = Math.min(1, (now - start) / dur);
      if (raw >= 1) { finish(); return; }
      try { onUpdate(easing(raw)); } catch (e) { console.error(e); finish(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms * speed));
}
