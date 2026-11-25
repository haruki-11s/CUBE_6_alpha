// "How to play" content with small SVG diagrams (text from the dictionaries).
import { t } from './i18n';

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
  return `<svg class="dia" viewBox="-42 -72 116 106" role="img" aria-label="${t().rules.linesAria}">
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
  return `<svg class="dia" viewBox="0 0 230 110" role="img" aria-label="${t().rules.rotateAria}">
    <defs><marker id="rr-ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ffc233"/></marker></defs>
    <rect x="18" y="23" width="64" height="64" rx="8" fill="rgba(255,194,51,.07)" stroke="#ffc233" stroke-opacity=".55"/>
    ${grid3(50, 55, 21, before, '#ffc233')}
    <path d="M 100 55 L 128 55" stroke="#8a93c4" stroke-width="2" marker-end="url(#rr-ah)"/>
    <rect x="148" y="23" width="64" height="64" rx="8" fill="rgba(255,194,51,.07)" stroke="#ffc233" stroke-opacity=".55"/>
    ${grid3(180, 55, 21, after, '#ffc233')}
    <path d="M 214 34 A 40 40 0 0 0 146 34" fill="none" stroke="#ffc233" stroke-width="2.4" marker-end="url(#rr-ah)"/>
    <text x="180" y="104" fill="#ffc233" font-size="10" text-anchor="middle">${t().rules.rotateDia}</text>
    <text x="50" y="104" fill="#8a93c4" font-size="10" text-anchor="middle">${t().rules.rotateDiaFrom}</text>
  </svg>`;
}

function svgSlide(): string {
  const cell = (x: number, m: string, dim = false): string =>
    `<rect x="${x - 14}" y="36" width="28" height="28" rx="6" fill="#141a36" stroke="#2ee59d" stroke-opacity="${dim ? 0.25 : 0.55}"/>`
    + (m ? `<circle cx="${x}" cy="50" r="8" fill="${m === 'o' ? '#3d8bff' : '#ff3b5c'}"/>` : '');
  return `<svg class="dia" viewBox="0 0 230 110" role="img" aria-label="${t().rules.slideAria}">
    <defs><marker id="sl-ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2ee59d"/></marker></defs>
    ${cell(22, 'o')}${cell(52, 'x')}${cell(82, '')}
    <path d="M 100 50 L 126 50" stroke="#8a93c4" stroke-width="2" marker-end="url(#sl-ah)"/>
    ${cell(148, 'x')}${cell(178, '')}${cell(208, 'o')}
    <path d="M 148 32 C 148 8, 208 8, 208 30" fill="none" stroke="#2ee59d" stroke-width="2.2" stroke-dasharray="4 3" marker-end="url(#sl-ah)" opacity=".9"/>
    <text x="178" y="86" fill="#2ee59d" font-size="10" text-anchor="middle">${t().rules.slideDia}</text>
    <text x="178" y="100" fill="#8a93c4" font-size="9.5" text-anchor="middle">${t().rules.slideDiaWrap}</text>
  </svg>`;
}

export function rulesHTML(): string {
  const R = t().rules;
  const ids = ['r-goal', 'r-flow', 'r-ops', 'r-win', 'r-cpu', 'r-keys'];
  const nav = R.nav.map((label, i) => `<button type="button" data-to="${ids[i]}">${label}</button>`).join('');
  const keys = R.keyRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  return `
  <div class="rules">
    <nav class="rules-nav" aria-label="${R.navAria}">${nav}</nav>
    <section id="r-goal">
      <h3><span class="rn">1</span>${R.goal}</h3>
      <div class="rule-split">
        <p>${R.goalText}</p>
        <figure>${svgLines()}<figcaption><span style="color:#3d8bff">■</span>${R.lineStraight} <span style="color:#ff3b5c">■</span>${R.lineFace} <span style="color:#b47cff">■</span>${R.lineSpace}</figcaption></figure>
      </div>
    </section>
    <section id="r-flow">
      <h3><span class="rn">2</span>${R.flow}</h3>
      <ol class="flow">
        <li><b>${R.flowStep1}</b>${R.flowStep1Text}</li>
        <li><b>${R.flowStep2}</b>${R.flowStep2Text}</li>
      </ol>
    </section>
    <section id="r-ops">
      <h3><span class="rn">3</span>${R.ops}</h3>
      <div class="dia-row">
        <figure>${svgRotate()}<figcaption>${R.rotateText}</figcaption></figure>
        <figure>${svgSlide()}<figcaption>${R.slideText}</figcaption></figure>
      </div>
      <p class="note">${R.opsNote}</p>
    </section>
    <section id="r-win">
      <h3><span class="rn">4</span>${R.win}</h3>
      <p class="lead-p">${R.winLead}</p>
      <ul class="cards3">
        <li class="c-check"><b>${R.cardCheck}</b>${R.cardCheckText}</li>
        <li class="c-win"><b>${R.cardWin}</b>${R.cardWinText}</li>
        <li class="c-lose"><b>${R.cardLose}</b>${R.cardLoseText}</li>
      </ul>
      <p class="note">${R.winNote}</p>
      <p class="note">${R.mateNote}</p>
    </section>
    <section id="r-cpu">
      <h3><span class="rn">5</span>${R.cpu}</h3>
      <p>${R.cpuText}</p>
      <p>${R.cpuClock}</p>
      <p class="note">${R.cpuNote}</p>
    </section>
    <section id="r-keys">
      <h3><span class="rn">6</span>${R.keys}</h3>
      <table class="keys">${keys}</table>
    </section>
  </div>`;
}
