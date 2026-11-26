import { describe, it, expect } from 'vitest';
import { detectLang, dictionaries, getLang, isLang, LANGS, setLang, t } from '../src/ui/i18n';

type Node = unknown;

/** Every leaf of a dictionary as "path → kind", so two languages can be compared. */
function shape(v: Node, path = ''): Record<string, string> {
  if (typeof v === 'string') return { [path]: 'string' };
  if (typeof v === 'function') return { [path]: `function/${v.length}` };
  if (Array.isArray(v)) {
    return Object.assign({ [path]: `array/${v.length}` }, ...v.map((x, i) => shape(x, `${path}[${i}]`)));
  }
  if (typeof v === 'object' && v !== null) {
    return Object.assign({}, ...Object.entries(v).map(([k, x]) => shape(x, path ? `${path}.${k}` : k)));
  }
  return { [path]: typeof v };
}

/** Calls every text function with sample arguments; returns every resulting string by path. */
function texts(v: Node, path = ''): Array<[string, string]> {
  if (typeof v === 'string') return [[path, v]];
  if (typeof v === 'function') {
    const out = (v as (...a: unknown[]) => unknown)(3, 30, 'Lv.3');
    return [[path, String(out)]];
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => texts(x, `${path}[${i}]`));
  if (typeof v === 'object' && v !== null) return Object.entries(v).flatMap(([k, x]) => texts(x, path ? `${path}.${k}` : k));
  return [];
}

describe('i18n', () => {
  const dicts = dictionaries();

  it('offers Japanese and English, each by its own name', () => {
    expect(LANGS.map(l => l.id)).toEqual(['ja', 'en']);
    expect(LANGS.map(l => l.name)).toEqual(['日本語', 'English']);
  });

  it('English has exactly the entries Japanese has', () => {
    expect(shape(dicts.en)).toEqual(shape(dicts.ja));
  });

  it('only the small tags may be empty, and only in English', () => {
    for (const [lang, d] of Object.entries(dicts)) {
      for (const [path, text] of texts(d)) {
        if (text !== '') continue;
        expect(lang, path).toBe('en');
        expect(path, path).toMatch(/(^|\.)(tag|[a-z][a-zA-Z]*Tag)$/);
      }
    }
  });

  it('English text has no Japanese in it, apart from the language names', () => {
    const japanese = /[぀-ヿ一-鿿]/;
    for (const [path, text] of texts(dicts.en)) expect(japanese.test(text), `${path}: ${text}`).toBe(false);
  });

  it('switches the text with the language', () => {
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t().title.local).toBe('Local');
    setLang('ja');
    expect(t().title.local).toBe('ローカル');
  });

  it('the title menu names follow the agreed structure', () => {
    const ja = dicts.ja.title;
    expect([ja.local, ja.online]).toEqual(['ローカル', 'インターネット']);
    expect([ja.cpu, ja.two, ja.random, ja.code]).toEqual(['対CPU', '2人で遊ぶ', 'ランダム対戦', '合言葉で遊ぶ']);
  });

  it('戦績 on the title holds the two rankings and the CPU records', () => {
    const ja = dicts.ja.title;
    expect([ja.records, ja.daily, ja.weekly, ja.cpuRecords]).toEqual(['戦績', 'デイリーランキング', 'ウィークリーランキング', 'CPU戦の戦績']);
  });

  it('the time to the next ranking reset reads in days once it is a day or more', () => {
    expect(dicts.ja.ranking.resetIn(104, 2)).toBe('次の更新まで あと 4日8時間');
    expect(dicts.ja.ranking.resetIn(8, 2)).toBe('次の更新まで あと 8時間2分');
    expect(dicts.ja.ranking.resetIn(0, 45)).toBe('次の更新まで あと 45分');
    expect(dicts.en.ranking.resetIn(104, 2)).toBe('Next reset in 4 d 8 h');
    expect(dicts.en.ranking.resetIn(8, 2)).toBe('Next reset in 8 h 2 min');
  });

  it('the result of an online game gives no reason for resigning or a lost connection', () => {
    // (the user asked to keep the result screen as it is: no new reason lines)
    expect(JSON.stringify(dicts.ja.result)).not.toMatch(/降参|切断/);
  });

  it('the CPU setup no longer says the first player has the advantage', () => {
    expect(dicts.ja.cpuSetup.sides).not.toContain('有利');
    expect(dicts.en.cpuSetup.sides.toLowerCase()).not.toContain('advantage');
  });

  it('detects the language from the browser preferences', () => {
    expect(detectLang(['ja-JP', 'en-US'])).toBe('ja');
    expect(detectLang(['en-GB'])).toBe('en');
    expect(detectLang(['ko-KR', 'ja'])).toBe('ja');
    expect(detectLang(['ko-KR'])).toBe('en');
    expect(detectLang([])).toBe('en');
    expect(isLang('ja')).toBe(true);
    expect(isLang('ko')).toBe(false);
  });

  it('English names a person or "your" correctly', () => {
    expect(dicts.en.hud.liveTurn('You')).toBe('Your turn.');
    expect(dicts.en.hud.liveTurn('CPU')).toBe('CPU’s turn.');
    expect(dicts.en.pause.turn('PLAYER 2')).toBe('PLAYER 2’s turn');
    expect(dicts.en.result.reviewBody('CPU')).toContain('CPU’s line');
  });
});
