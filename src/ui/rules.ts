// "How to play" content with small SVG diagrams.

type P3 = [number, number, number];
// Cabinet projection: unlike a true isometric view, no two lattice points overlap.
const iso = ([x, y, z]: P3): [number, number] => [x * 30 - z * 14, -y * 30 + z * 12];

function svgLines(): string {
  const dots: string[] = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
    const [px, py] = iso([x, y, z]);
    dots.push(`<circle cx="${px}" cy="${py}" r="2.6" fill="#55608f"/>`);
  }
  const corners: P3[] = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2], [2, 2, 0], [2, 0, 2], [0, 2, 2], [2, 2, 2]];
  const edges: string[] = [];
  for (let i = 0; i < corners.length; i++) for (let j = i + 1; j < corners.length; j++) {
    const a = corners[i], b = corners[j];
    const diff = a.reduce((n, v, k) => n + (v !== b[k] ? 1 : 0), 0);
    if (diff !== 1) continue;
    const [x1, y1] = iso(a), [x2, y2] = iso(b);
    edges.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3b4a80" stroke-width="1.2"/>`);
  }
  const line = (a: P3, b: P3, color: string): string => {
    const [x1, y1] = iso(a), [x2, y2] = iso(b);
    const [mx, my] = iso([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as P3);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3.2" stroke-linecap="round"/>`
      + [[x1, y1], [mx, my], [x2, y2]].map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="5" fill="${color}"/>`).join('');
  };
  return `<svg class="dia" viewBox="-42 -72 116 106" role="img" aria-label="ラインの例">
    ${edges.join('')}${dots.join('')}
    ${line([0, 0, 2], [2, 0, 2], '#3d8bff')}
    ${line([0, 0, 0], [2, 2, 0], '#ff3b5c')}
    ${line([0, 2, 2], [2, 0, 0], '#b47cff')}
  </svg>`;
}

function grid3(cx: number, cy: number, step: number, marks: string[], color: string): string {
  let s = '';
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const m = marks[r * 3 + c];
    const x = cx + (c - 1) * step, y = cy + (r - 1) * step;
    const fill = m === 'o' ? '#3d8bff' : m === 'x' ? '#ff3b5c' : '#1a2040';
    s += `<circle cx="${x}" cy="${y}" r="${m ? 7.5 : 4}" fill="${fill}" stroke="${m ? 'none' : color}" stroke-opacity=".5"/>`;
  }
  return s;
}

function svgRotate(): string {
  const before = ['o', '', '', '', 'x', '', '', '', ''];
  const after = ['', '', '', '', 'x', '', 'o', '', ''];
  return `<svg class="dia" viewBox="0 0 230 110" role="img" aria-label="回転の例">
    <defs><marker id="rr-ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ffc233"/></marker></defs>
    <rect x="18" y="23" width="64" height="64" rx="8" fill="rgba(255,194,51,.07)" stroke="#ffc233" stroke-opacity=".55"/>
    ${grid3(50, 55, 21, before, '#ffc233')}
    <path d="M 100 55 L 128 55" stroke="#8a93c4" stroke-width="2" marker-end="url(#rr-ah)"/>
    <rect x="148" y="23" width="64" height="64" rx="8" fill="rgba(255,194,51,.07)" stroke="#ffc233" stroke-opacity=".55"/>
    ${grid3(180, 55, 21, after, '#ffc233')}
    <path d="M 214 34 A 40 40 0 0 0 146 34" fill="none" stroke="#ffc233" stroke-width="2.4" marker-end="url(#rr-ah)"/>
    <text x="180" y="104" fill="#ffc233" font-size="10" text-anchor="middle">↺ 左回りに90°</text>
    <text x="50" y="104" fill="#8a93c4" font-size="10" text-anchor="middle">上から見た層</text>
  </svg>`;
}

function svgSlide(): string {
  const cell = (x: number, m: string, dim = false): string =>
    `<rect x="${x - 14}" y="36" width="28" height="28" rx="6" fill="#141a36" stroke="#2ee59d" stroke-opacity="${dim ? 0.25 : 0.55}"/>`
    + (m ? `<circle cx="${x}" cy="50" r="8" fill="${m === 'o' ? '#3d8bff' : '#ff3b5c'}"/>` : '');
  return `<svg class="dia" viewBox="0 0 230 110" role="img" aria-label="繰越の例">
    <defs><marker id="sl-ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2ee59d"/></marker></defs>
    ${cell(22, 'o')}${cell(52, 'x')}${cell(82, '')}
    <path d="M 100 50 L 126 50" stroke="#8a93c4" stroke-width="2" marker-end="url(#sl-ah)"/>
    ${cell(148, 'x')}${cell(178, '')}${cell(208, 'o')}
    <path d="M 148 32 C 148 8, 208 8, 208 30" fill="none" stroke="#2ee59d" stroke-width="2.2" stroke-dasharray="4 3" marker-end="url(#sl-ah)" opacity=".9"/>
    <text x="178" y="86" fill="#2ee59d" font-size="10" text-anchor="middle">−方向へ1マス</text>
    <text x="178" y="100" fill="#8a93c4" font-size="9.5" text-anchor="middle">はみ出した駒は反対側へ</text>
  </svg>`;
}

export function rulesHTML(): string {
  return `
  <div class="rules">
    <section>
      <h3><span class="rn">1</span>目的</h3>
      <div class="rule-split">
        <p>3×3×3 の立体盤で、自分の駒を<b>一直線に3つ</b>並べたら勝ち。縦・横・面の斜め・<b>立体対角線</b>を合わせて <b>49本</b> のラインがあります。</p>
        <figure>${svgLines()}<figcaption><span style="color:#3d8bff">■</span>直線 <span style="color:#ff3b5c">■</span>面の斜め <span style="color:#b47cff">■</span>立体対角線</figcaption></figure>
      </div>
    </section>
    <section>
      <h3><span class="rn">2</span>手番の流れ</h3>
      <ol class="flow">
        <li><b>① 配置 / 移動</b>手駒（各6個）があるうちは空きマスに<b>配置</b>。6個すべて置いたら、自分の駒を1つ好きな空きマスへ<b>移動</b>します。</li>
        <li><b>② キューブ操作（必須）</b>「回転」か「繰越」を必ず1回行います。パスはできません。</li>
      </ol>
    </section>
    <section>
      <h3><span class="rn">3</span>キューブ操作</h3>
      <div class="dia-row">
        <figure>${svgRotate()}<figcaption><b>回転</b>：X・Y・Z いずれかの軸の<b>層（0〜2）</b>を90°回します。↺／↻ は<b>その軸の＋側から見た</b>向きです。</figcaption></figure>
        <figure>${svgSlide()}<figcaption><b>繰越（スライド）</b>：盤全体を軸方向に1マスずらします。はみ出した列は反対側へ回り込みます。</figcaption></figure>
      </div>
      <p class="note">操作を選ぶと、3D表示に<b>対象の層（色付きの枠）</b>と<b>駒の動き（半透明の予告）</b>、見取り図に<b>操作後の配置</b>が表示されます。軸の色：<b class="ax-x">X＝緑</b>・<b class="ax-y">Y＝黄</b>・<b class="ax-z">Z＝紫</b></p>
      <p class="note warn">直前に相手が行った操作の<b>完全な逆操作</b>は禁止です（パネルに「禁」と表示）。</p>
    </section>
    <section>
      <h3><span class="rn">4</span>勝敗</h3>
      <ul class="cards3">
        <li class="c-win"><b>勝ち</b>①で自分の列が揃えば即勝利（②は省略）。②の後に自分だけ揃っても勝ち。</li>
        <li class="c-lose"><b>自爆負け</b>②の後に<b>相手だけ</b>列が揃うと負け。</li>
        <li class="c-draw"><b>引き分け</b>②の後に両者同時に揃う、または手数上限に達する。</li>
      </ul>
    </section>
    <section>
      <h3><span class="rn">5</span>操作方法</h3>
      <table class="keys">
        <tr><td>クリック / タップ</td><td>マスを選択（3D・見取り図のどちらでも可）</td></tr>
        <tr><td>ドラッグ</td><td>視点を回転（盤の回転とは別）</td></tr>
        <tr><td>ホイール / ピンチ</td><td>ズーム</td></tr>
        <tr><td><kbd>Enter</kbd> / <kbd>Esc</kbd></td><td>キューブ操作の確定 / 取消・選択解除</td></tr>
        <tr><td><kbd>U</kbd> / <kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>一手戻す</td></tr>
        <tr><td><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> / <kbd>+</kbd><kbd>−</kbd></td><td>視点の回転 / ズーム</td></tr>
        <tr><td><kbd>1</kbd>〜<kbd>4</kbd></td><td>視点プリセット（斜め・正面・真上・側面）</td></tr>
        <tr><td><kbd>V</kbd> / <kbd>S</kbd> / <kbd>M</kbd> / <kbd>H</kbd></td><td>展開表示 / 刻印表示 / サウンド / ルール</td></tr>
      </table>
    </section>
  </div>`;
}
