import { afterEach, describe, it, expect } from 'vitest';
import styleCss from '../src/style.css?raw';
import { adMode, adSlot, adsOn } from '../src/ui/ads';
import { setLang } from '../src/ui/i18n';

/** The declarations of every rule in style.css whose selector names `cls`. */
function rulesFor(cls: string): string[] {
  const css = styleCss.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].includes(cls)).map(m => m[2]);
}

describe('ad slots', () => {
  afterEach(() => setLang('ja'));

  it('stay off unless a dev build asks for the preview', () => {
    expect(adMode('')).toBe('off');
    expect(adMode('?ads=on')).toBe('off');
    expect(adMode('?ads=preview')).toBe('preview');
    expect(adsOn('off')).toBe(false);
  });

  it('render nothing while off, so the layout stays as it is', () => {
    for (const k of ['title', 'game', 'result'] as const) expect(adSlot(k, 'off')).toBe('');
  });

  it('carry a label AdSense allows and a box', () => {
    setLang('ja');
    const ja = adSlot('result', 'preview');
    expect(ja).toContain('class="ad-slot ad-result preview"');
    expect(ja).toContain('<span class="ad-label">広告</span>');
    expect(ja).toContain('class="ad-box"');
    setLang('en');
    // AdSense allows only "Advertisements" or "Sponsored Links"
    expect(adSlot('title', 'preview')).toContain('<span class="ad-label">Advertisements</span>');
  });

  it('show the ad with its screen: nothing hides it, holds back its clicks or covers it', () => {
    expect(adSlot('result', 'preview')).not.toMatch(/\b(hidden|inert|disabled)\b/);
    const box = rulesFor('.ad-box');
    expect(box.length).toBeGreaterThan(0);
    for (const decls of box) expect(decls).not.toMatch(/opacity|visibility|pointer-events|display\s*:\s*none|transition/);
  });

  it('keep the result ad a fingertip (48px) clear of the result buttons', () => {
    const px = (decls: string, prop: string) => {
      const m = decls.match(new RegExp(`${prop}\\s*:\\s*([^;]+)`));
      return m ? m[1].trim().split(/\s+/).map(v => parseFloat(v)) : null;
    };
    const margin = px(rulesFor('.ad-result').find(d => /margin\s*:/.test(d)) ?? '', 'margin');
    const actions = px(rulesFor('.modal-actions').find(d => /margin-top/.test(d)) ?? '', 'margin-top');
    expect(margin).not.toBeNull();
    expect(actions).not.toBeNull();
    // margin: top sides bottom; the bottom margin and the buttons' own margin add up
    expect(margin![2] + actions![0]).toBeGreaterThanOrEqual(48);
  });

  it('pass extra attributes to the slot', () => {
    expect(adSlot('title', 'preview', 'data-title-ui')).toMatch(/^<aside [^>]*data-title-ui>/);
  });
});
