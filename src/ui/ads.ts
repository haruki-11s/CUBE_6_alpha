/*
 * Ad slots. Nothing shows until an ad network is set up: release builds render no slot at all, so
 * the layout stays exactly as it is. A dev build shows sample frames with ?ads=preview, to check
 * the layout.
 *
 * An ad shows with its screen, at once: a late ad loses views, and practised players move fast
 * (the user's call, 2026-11-27). Accidental clicks are designed out by placement alone:
 *  - every slot has a fixed size, so nothing moves when an ad arrives;
 *  - no ad sits beside the board or the game's buttons: phones get no banner during play, and
 *    a PC gets one only above the top bar (see style.css, "Ads");
 *  - the result window keeps a wide gap between its ad and its buttons, and it opens only after
 *    the finished board has been still for a moment (finishGame), so no tap meant for the board
 *    can land on it.
 *
 * The page must never hide, cover, delay or intercept an ad, nor ask before the ad's page opens:
 * AdSense forbids altering the result of an ad click, and the ad lives in the network's own frame
 * anyway. Google adds its own "Visit site" step (Confirmed Click) to ads where it sees accidental
 * clicks, which costs clicks: the placement above is meant to keep it from ever being needed.
 *
 * AdSense allows only the labels 「広告」 (ja) and "Advertisements" (en) on an ad unit.
 */
import { t } from './i18n';

/** title: the title screen's bottom banner; game: the PC banner above the top bar; result: the box in the result window. */
export type AdKind = 'title' | 'game' | 'result';
export type AdMode = 'off' | 'preview';

/** 'preview' only in a dev build opened with ?ads=preview. */
export function adMode(search: string = typeof location === 'undefined' ? '' : location.search): AdMode {
  if (import.meta.env.DEV && new URLSearchParams(search).get('ads') === 'preview') return 'preview';
  return 'off';
}

export const adsOn = (mode: AdMode = adMode()): boolean => mode !== 'off';

/** The slot's HTML, or '' when ads are off. `attrs` go on the slot's root element. */
export function adSlot(kind: AdKind, mode: AdMode = adMode(), attrs = ''): string {
  if (mode === 'off') return '';
  const A = t().ads;
  const sample = mode === 'preview' ? `<span class="ad-sample">${A.sample}<small data-ad-size></small></span>` : '';
  return `<aside class="ad-slot ad-${kind} ${mode}" data-ad="${kind}" aria-label="${A.label}"${attrs ? ` ${attrs}` : ''}>`
    + `<span class="ad-label">${A.label}</span><div class="ad-box">${sample}</div></aside>`;
}

/**
 * Fills the slots under `scope` that are on screen, as soon as they are laid out. A slot this
 * screen size does not show (the PC banner on a phone) is left alone: an ad must never be hidden.
 * A sample frame shows its size, so the layout can be checked.
 */
export function fillAds(scope: ParentNode): void {
  const slots = [...scope.querySelectorAll<HTMLElement>('.ad-slot:not([data-filled])')];
  if (!slots.length) return;
  requestAnimationFrame(() => {
    for (const s of slots) {
      if (!s.isConnected || !s.getClientRects().length) continue;
      s.dataset.filled = '';
      const size = s.querySelector<HTMLElement>('[data-ad-size]');
      const box = s.querySelector<HTMLElement>('.ad-box');
      if (size && box) size.textContent = `${box.offsetWidth}×${box.offsetHeight}`;
    }
  });
}
