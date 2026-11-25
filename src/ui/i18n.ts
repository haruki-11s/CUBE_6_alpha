// Display language: Japanese and English. Another language is one more file in ./lang
// (with the same shape as ja.ts) plus an entry in LANGS and DICTS.
import type { Lang } from '../core/types';
import ja, { type Messages } from './lang/ja';
import en from './lang/en';

export type { Lang, Messages };

/** The languages offered, each by its own name. */
export const LANGS: readonly { id: Lang; name: string }[] = [
  { id: 'ja', name: '日本語' },
  { id: 'en', name: 'English' },
];

const DICTS: Readonly<Record<Lang, Messages>> = { ja, en };

export function isLang(v: unknown): v is Lang {
  return LANGS.some(l => l.id === v);
}

/** The browser's preferred language when it is one we have; otherwise English. */
export function detectLang(prefs?: readonly string[]): Lang {
  let list: readonly string[] = prefs ?? [];
  if (!prefs) {
    try {
      list = navigator.languages?.length ? navigator.languages : [navigator.language];
    } catch { /* no navigator */ }
  }
  for (const tag of list) {
    const base = (tag || '').toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

let current: Lang = 'ja';

export function getLang(): Lang {
  return current;
}

/** Switches the text and the page's language attribute and title. */
export function setLang(l: Lang): void {
  current = l;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l;
    document.title = DICTS[l].docTitle;
  }
}

/** The text in the current language. */
export function t(): Messages {
  return DICTS[current];
}

/** For tests: every dictionary by language. */
export function dictionaries(): Readonly<Record<Lang, Messages>> {
  return DICTS;
}
