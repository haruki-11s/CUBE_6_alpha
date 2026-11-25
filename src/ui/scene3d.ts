import * as THREE from 'three';
import type { Axis, CubeMove, Mark, Player } from '../core/types';
import { fromIndex } from '../core/board';
import { AXIS_INDEX, movePermutation } from '../core/cube';
import type { Line } from '../core/lines';
import { ease, getAnimSpeed, tween } from './tween';
import { glowTexture, ringTexture, symbolTexture } from './textures';
import { AXIS_COLORS, PLAYER_COLORS } from './theme';
import { t } from './i18n';

type RotateMove = Extract<CubeMove, { kind: 'rotate' }>;
type SlideMove = Extract<CubeMove, { kind: 'slide' }>;
export type ViewPreset = 'iso' | 'front' | 'top' | 'side';

export interface SceneOptions { demo?: boolean }
export interface PreviewOptions {
  /** Lines that would be completed by the previewed move (hint). */
  lines?: { line: Line; player: Player }[];
  /** Animate translucent copies of the moving pieces (default true). */
  ghosts?: boolean;
  /** Dimmer guide, used to show the opponent's previous move. */
  muted?: boolean;
}

const BASE_SPACING = 1.2;
const EXPLODE_SPACING = 1.85;
const PIECE_R = 0.34;
const AXES: readonly Axis[] = ['X', 'Y', 'Z'];
const UP = new THREE.Vector3(0, 1, 0);
const EMPTY_COLOR = new THREE.Color(0x4a5890);
/** Cube in the owner's colour around each piece (faint fill, bright edges), so the board reads as claimed space. */
const TINT_SIZE = 1.1;       // edge length; the cell pitch is BASE_SPACING
// The scene is blue-tinted, so blue needs more opacity than red to show as strongly.
const TINT_FILL: Readonly<Record<Player, number>> = { O: 0.15, X: 0.08 };
const TINT_EDGE: Readonly<Record<Player, number>> = { O: 0.7, X: 0.6 };
const VIEWS: Readonly<Record<ViewPreset, { theta: number; phi: number }>> = {
  iso: { theta: Math.PI / 4, phi: 1.0 },
  front: { theta: 0, phi: Math.PI / 2 - 0.1 },
  top: { theta: 0, phi: 0.18 },
  side: { theta: Math.PI / 2, phi: Math.PI / 2 - 0.1 },
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function axisVec(a: Axis, out = new THREE.Vector3()): THREE.Vector3 {
  out.set(0, 0, 0);
  out.setComponent(AXIS_INDEX[a], 1);
  return out;
}
function unitPos(i: number, out = new THREE.Vector3()): THREE.Vector3 {
  const [x, y, z] = fromIndex(i);
  return out.set(x - 1, y - 1, z - 1);
}
function slideDir(m: SlideMove, out = new THREE.Vector3()): THREE.Vector3 {
  return axisVec(m.axis, out).multiplyScalar(m.dir === 'forward' ? -1 : 1);
}

type OpacityMat = THREE.Material & { opacity: number };
interface Pulse { mat: OpacityMat; base: number }

function basicMat(color: number, opacity: number, additive = false, extra: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, opacity, transparent: true, depthWrite: false, toneMapped: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, ...extra,
  });
}

/** Dispose geometries/materials below `obj`, except shared resources. Textures are cached globally. */
function disposeTree(obj: THREE.Object3D, keep?: ReadonlySet<unknown>): void {
  obj.traverse(o => {
    const node = o as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    if (node.geometry && !(o instanceof THREE.Sprite) && !keep?.has(node.geometry)) node.geometry.dispose();
    const m = node.material;
    if (Array.isArray(m)) m.forEach(x => { if (!keep?.has(x)) x.dispose(); });
    else if (m && !keep?.has(m)) m.dispose();
  });
}

interface CellView {
  index: number;
  group: THREE.Group;
  piece: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  glow: THREE.Sprite;
  symbol: THREE.Sprite;
  marker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Sprite;
  tint: Tint;
  mark: Mark;
  dim: number;     // 1 = normal, < 1 = faded (pieces about to move in a preview)
  busy: boolean;   // an animation owns this cell's scale / opacity
}

/** The owner's-colour cube of a cell. `edge` is a child of `fill`, so it shares its visibility, position and scale. */
interface Tint {
  fill: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  edge: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
}
function tintColor(t: Tint, m: Player): void {
  t.fill.material.color.setHex(PLAYER_COLORS[m].hex);
  t.edge.material.color.setHex(PLAYER_COLORS[m].light);
}
/** k: 0 = invisible … 1 = full strength (fades, and dimming in previews). */
function tintAlpha(t: Tint, m: Mark, k: number): void {
  t.fill.material.opacity = m ? TINT_FILL[m] * k : 0;
  t.edge.material.opacity = m ? TINT_EDGE[m] * k : 0;
}

interface Particle {
  sprite: THREE.Sprite; tex: THREE.Texture; vel: THREE.Vector3;
  age: number; life: number; s0: number; s1: number; o0: number; drag: number; grav: number;
}
interface Ghost { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>; from: number; to: number; mode: 'move' | 'leave' | 'enter' }
interface PreviewState { move: CubeMove; group: THREE.Group; ghosts: Ghost[]; moving: number[]; t0: number; pulse: Pulse[] }
interface WinState { group: THREE.Group; pulse: Pulse[]; cells: Set<number> }
interface CheckState { group: THREE.Group; pulse: Pulse[]; cells: Set<number> }
interface GizmoState {
  scene: THREE.Scene; cam: THREE.OrthographicCamera;
  letters: { el: HTMLElement; pos: THREE.Vector3 }[]; bg: HTMLElement; size: number; margin: number;
}

export class Scene3D {
  onCellClick?: (index: number | null, raw: number | null) => void;
  onCellHover?: (index: number | null) => void;
  /** Which cells are valid targets for the pointer right now. */
  pickFilter: (index: number) => boolean = () => true;

  private readonly demo: boolean;
  private readonly canvas: HTMLCanvasElement;
  private readonly labelLayer: HTMLDivElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  private readonly root = new THREE.Group();
  private readonly gridGroup = new THREE.Group();
  private readonly overlay = new THREE.Group();   // unit coordinates, scaled by spacing
  private readonly fx = new THREE.Group();        // particles (world coordinates)
  private readonly cells: CellView[] = [];
  private readonly hitMeshes: THREE.Mesh[] = [];
  private board: Mark[] = Array<Mark>(27).fill(null);

  private readonly pieceGeo = new THREE.SphereGeometry(PIECE_R, 40, 28);
  private readonly ghostGeo = new THREE.SphereGeometry(PIECE_R * 0.78, 24, 16);
  private readonly markerGeo = new THREE.SphereGeometry(0.075, 12, 8);
  private readonly hitGeo = new THREE.SphereGeometry(0.47, 12, 8);
  private readonly tintGeo = new THREE.BoxGeometry(TINT_SIZE, TINT_SIZE, TINT_SIZE);
  private readonly tintEdgeGeo = new THREE.EdgesGeometry(this.tintGeo);
  private readonly hitMat = new THREE.MeshBasicMaterial({ visible: false });
  private readonly shared: ReadonlySet<unknown>;

  private readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly floorRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly hoverGhost: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  private readonly selRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private readonly lastRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private readonly moveLine: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;

  private spacing = BASE_SPACING;
  private spacingTarget = BASE_SPACING;
  private readonly turnColor = new THREE.Color(PLAYER_COLORS.O.hex);
  private readonly turnColorTarget = new THREE.Color(PLAYER_COLORS.O.hex);
  private readonly targetColor = new THREE.Color(PLAYER_COLORS.O.light);
  private targets = new Set<number>();
  private selected: number | null = null;
  private lastMoved: number | null = null;
  private hover: number | null = null;
  private hoverMark: Player | null = null;
  private showSymbols = false;
  private preview: PreviewState | null = null;
  private win: WinState | null = null;
  private check: CheckState | null = null;
  private labelsOn = false;
  private readonly labelEls = new Map<string, HTMLElement>();
  private labelEmph = new Set<string>();
  private gizmo: GizmoState | null = null;
  private readonly particles: Particle[] = [];
  private readonly pools = new Map<THREE.Texture, THREE.Sprite[]>();
  private readonly shakeState = { amp: 0, t: 0, dur: 0 };
  private animating = 0;

  private readonly cam = { theta: Math.PI / 4, phi: 1.0 };
  private readonly camT = { theta: Math.PI / 4, phi: 1.0 };
  private zoom = 1;
  private zoomT = 1;
  private fitRadius = 8.5;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number; id: number; moved: boolean; touch: boolean } | null = null;
  private pinch: { d0: number; z0: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly disposers: (() => void)[] = [];
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private last = 0;
  private time = 0;
  private disposed = false;
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();

  constructor(private readonly host: HTMLElement, opts: SceneOptions = {}) {
    this.demo = !!opts.demo;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', t().game.canvasAria);
    host.prepend(this.canvas);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    host.appendChild(this.labelLayer);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.autoClear = false;

    this.shared = new Set<unknown>([this.pieceGeo, this.ghostGeo, this.markerGeo, this.hitGeo, this.hitMat, this.tintGeo, this.tintEdgeGeo]);

    this.scene.fog = new THREE.Fog(0x070914, 9, 24);
    this.scene.add(new THREE.HemisphereLight(0xb4c8ff, 0x1c1236, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(5, 9, 7);
    const rim = new THREE.DirectionalLight(0x7f9bff, 1.6);
    rim.position.set(-7, 3, -6);
    const under = new THREE.DirectionalLight(0xff8fd0, 0.45);
    under.position.set(0, -6, 3);
    this.scene.add(key, rim, under);

    this.scene.add(this.root, this.fx);
    this.root.add(this.gridGroup, this.overlay);

    // Stars (parallax background)
    {
      const n = 900;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const r = 40 + Math.random() * 60;
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
        c.setHSL(0.58 + Math.random() * 0.22, 0.6, 0.6 + Math.random() * 0.35);
        col.set([c.r, c.g, c.b], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 0.55, map: glowTexture(), vertexColors: true, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
      }));
      this.scene.add(this.stars);
    }

    // Floor light in the colour of the player to move
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), basicMat(PLAYER_COLORS.O.hex, 0.3, true, { map: glowTexture(), fog: false }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floorRing = new THREE.Mesh(new THREE.RingGeometry(3.15, 3.2, 128), basicMat(PLAYER_COLORS.O.hex, 0.35, true, { fog: false, side: THREE.DoubleSide }));
    this.floorRing.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor, this.floorRing);

    this.buildGrid();
    this.buildCells();

    this.hoverGhost = new THREE.Mesh(this.pieceGeo, new THREE.MeshPhysicalMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.3,
      transparent: true, opacity: 0.4, depthWrite: false,
    }));
    this.hoverGhost.visible = false;
    this.selRing = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.03, 10, 64), basicMat(0xffffff, 0.95));
    this.selRing.visible = false;
    this.lastRing = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.015, 8, 64), basicMat(0xffffff, 0.55));
    this.lastRing.visible = false;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.moveLine = new THREE.Line(lg, new THREE.LineDashedMaterial({
      color: 0xffffff, dashSize: 0.12, gapSize: 0.09, transparent: true, opacity: 0.75, toneMapped: false, depthTest: false,
    }));
    this.moveLine.visible = false;
    this.root.add(this.hoverGhost, this.selRing, this.lastRing, this.moveLine);

    if (this.demo) {
      this.zoom = this.zoomT = 1.08;
    } else {
      this.buildLabels();
      this.buildGizmo();
      this.bindInput();
    }
    this.applySpacing();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ═════════════════════════════ Construction ══════════════════════════════

  private buildGrid(): void {
    const D = [-1.5, -0.5, 0.5, 1.5];
    const inner: number[] = [];
    const outer: number[] = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const a = D[i], b = D[j];
        const arr = (i === 0 || i === 3) && (j === 0 || j === 3) ? outer : inner;
        arr.push(-1.5, a, b, 1.5, a, b, a, -1.5, b, a, 1.5, b, a, b, -1.5, a, b, 1.5);
      }
    }
    const lines = (arr: number[], color: number, opacity: number): THREE.LineSegments => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, toneMapped: false }));
    };
    this.gridGroup.add(lines(inner, 0x3a4f8c, 0.3), lines(outer, 0x7fa6ff, 0.75));
    // faint glass volume
    this.gridGroup.add(new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), basicMat(0x4060c0, 0.045, false, { side: THREE.BackSide })));
  }

  private buildCells(): void {
    for (let i = 0; i < 27; i++) {
      const group = new THREE.Group();
      const piece = new THREE.Mesh(this.pieceGeo, new THREE.MeshPhysicalMaterial({
        color: 0xffffff, emissive: 0x000000, emissiveIntensity: 0.32, roughness: 0.22, metalness: 0.05,
        clearcoat: 0.9, clearcoatRoughness: 0.12,
      }));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }));
      glow.scale.setScalar(1.45);
      const symbol = new THREE.Sprite(new THREE.SpriteMaterial({ map: symbolTexture('O'), transparent: true, depthWrite: false, toneMapped: false }));
      symbol.scale.setScalar(0.4);
      const marker = new THREE.Mesh(this.markerGeo, new THREE.MeshBasicMaterial({
        color: EMPTY_COLOR, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false,
      }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }));
      halo.scale.setScalar(0.95);
      const hit = new THREE.Mesh(this.hitGeo, this.hitMat);
      hit.userData['index'] = i;
      this.hitMeshes.push(hit);
      const tint = this.makeTint();
      group.add(piece, glow, symbol, marker, halo, hit, tint.fill);
      this.root.add(group);
      const cell: CellView = { index: i, group, piece, glow, symbol, marker, halo, tint, mark: null, dim: 1, busy: false };
      this.cells.push(cell);
      this.paint(cell, null);
    }
  }

  private makeTint(): Tint {
    const fill = new THREE.Mesh(this.tintGeo, basicMat(0xffffff, 0));
    const edge = new THREE.LineSegments(this.tintEdgeGeo, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    }));
    fill.add(edge);
    return { fill, edge };
  }

  private buildLabels(): void {
    for (const a of AXES) {
      for (let k = 0; k < 3; k++) {
        const el = document.createElement('div');
        el.className = `lbl3d ax-${a.toLowerCase()}`;
        el.textContent = `${a}${k}`;
        this.labelLayer.appendChild(el);
        this.labelEls.set(`${a}${k}`, el);
      }
    }
  }

  private buildGizmo(): void {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);
    const letters: GizmoState['letters'] = [];
    for (const a of AXES) {
      const dir = axisVec(a);
      const color = AXIS_COLORS[a].hex;
      const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.0, 10), mat);
      shaft.position.copy(dir).multiplyScalar(0.5);
      shaft.quaternion.copy(q);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 14), mat);
      head.position.copy(dir).multiplyScalar(1.15);
      head.quaternion.copy(q);
      const neg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.85, 8), basicMat(color, 0.35));
      neg.position.copy(dir).multiplyScalar(-0.42);
      neg.quaternion.copy(q);
      scene.add(shaft, head, neg);
      const el = document.createElement('div');
      el.className = `gz-lbl ax-${a.toLowerCase()}`;
      el.textContent = a;
      this.labelLayer.appendChild(el);
      letters.push({ el, pos: dir.clone().multiplyScalar(1.62) });
    }
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })));
    const bg = document.createElement('div');
    bg.className = 'gz-bg';
    this.labelLayer.prepend(bg);
    this.gizmo = { scene, cam, letters, bg, size: 84, margin: 10 };
  }

  // ═════════════════════════════ Board state ═══════════════════════════════

  private home(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return unitPos(i, out).multiplyScalar(this.spacing);
  }

  private paint(c: CellView, mark: Mark): void {
    c.mark = mark;
    const on = mark !== null;
    c.piece.visible = on;
    c.glow.visible = on;
    c.symbol.visible = on && this.showSymbols;
    c.marker.visible = !on;
    c.halo.visible = !on;
    c.tint.fill.visible = on;
    if (mark) {
      const P = PLAYER_COLORS[mark];
      tintColor(c.tint, mark);
      c.piece.material.color.setHex(P.hex);
      c.piece.material.emissive.setHex(P.hex);
      c.glow.material.color.setHex(P.glow);
      const tex = symbolTexture(mark);
      if (c.symbol.material.map !== tex) {
        c.symbol.material.map = tex;
        c.symbol.material.needsUpdate = true;
      }
    }
    c.piece.scale.setScalar(1);
    this.setDim(c, 1);
  }

  private setDim(c: CellView, dim: number): void {
    c.dim = dim;
    const m = c.piece.material;
    const tr = dim < 0.999;
    if (m.transparent !== tr) {
      m.transparent = tr;
      m.depthWrite = !tr;
      m.needsUpdate = true;
    }
    m.opacity = dim;
  }

  /** Instantly show `board` (no animation). Clears any cube-move preview. */
  setBoard(board: Mark[]): void {
    this.clearPreview();
    this.board = board.slice();
    for (const c of this.cells) {
      this.paint(c, this.board[c.index]);
      if (!c.busy) {
        this.home(c.index, c.group.position);
        c.group.quaternion.identity();
      }
    }
  }

  setTurn(p: Player): void { this.turnColorTarget.setHex(PLAYER_COLORS[p].hex); }

  setTargets(indices: number[], p: Player): void {
    this.targets = new Set(indices);
    this.targetColor.setHex(PLAYER_COLORS[p].light);
  }

  setSelected(i: number | null): void { this.selected = i; }
  setLastMoved(i: number | null): void { this.lastMoved = i; }

  /** Hovered cell; `ghost` = player whose translucent piece should be previewed there. */
  setHover(i: number | null, ghost: Player | null): void {
    this.hover = i;
    this.hoverMark = ghost;
    if (ghost) {
      const P = PLAYER_COLORS[ghost];
      this.hoverGhost.material.color.setHex(P.light);
      this.hoverGhost.material.emissive.setHex(P.hex);
    }
  }

  setShowSymbols(on: boolean): void {
    this.showSymbols = on;
    for (const c of this.cells) c.symbol.visible = on && c.mark !== null;
  }

  setExplode(on: boolean): void { this.spacingTarget = on ? EXPLODE_SPACING : BASE_SPACING; }
  setLabelsVisible(on: boolean): void { this.labelsOn = on; }

  // ═══════════════════════════ Cube-move preview ═══════════════════════════

  setCubeMovePreview(move: CubeMove | null, opts: PreviewOptions = {}): void {
    this.clearPreview();
    this.labelEmph = new Set();
    if (!move) return;

    const k = opts.muted ? 0.55 : 1;
    const color = AXIS_COLORS[move.axis].hex;
    const group = new THREE.Group();
    const pulse: Pulse[] = [];
    if (move.kind === 'rotate') {
      this.buildRotateGuide(group, move, color, pulse, k);
      this.labelEmph.add(`${move.axis}${move.layer}`);
    } else {
      this.buildSlideGuide(group, move, color, pulse, k);
      for (let l = 0; l < 3; l++) this.labelEmph.add(`${move.axis}${l}`);
    }
    for (const { line, player } of opts.lines ?? []) {
      group.add(this.makeBeam(line, PLAYER_COLORS[player].light, 0.035, pulse, 0.75));
    }
    this.overlay.add(group);

    const ghosts: Ghost[] = [];
    const moving: number[] = [];
    if (opts.ghosts !== false) {
      const perm = movePermutation(move);
      const leavingCoord = move.kind === 'slide' ? (move.dir === 'forward' ? 0 : 2) : -1;
      for (let i = 0; i < 27; i++) {
        const mark = this.board[i];
        if (!mark || perm[i] === i) continue;
        moving.push(i);
        if (move.kind === 'slide' && fromIndex(i)[AXIS_INDEX[move.axis]] === leavingCoord) {
          ghosts.push({ mesh: this.makeGhost(mark), from: i, to: perm[i], mode: 'leave' });
          ghosts.push({ mesh: this.makeGhost(mark), from: i, to: perm[i], mode: 'enter' });
        } else {
          ghosts.push({ mesh: this.makeGhost(mark), from: i, to: perm[i], mode: 'move' });
        }
      }
      for (const g of ghosts) this.root.add(g.mesh);
      for (const i of moving) this.setDim(this.cells[i], 0.3);
    }
    this.preview = { move, group, ghosts, moving, t0: this.time, pulse };
  }

  private clearPreview(): void {
    const p = this.preview;
    if (!p) return;
    this.overlay.remove(p.group);
    disposeTree(p.group, this.shared);
    for (const g of p.ghosts) {
      this.root.remove(g.mesh);
      g.mesh.material.dispose();
    }
    for (const i of p.moving) if (!this.cells[i].busy) this.setDim(this.cells[i], 1);
    this.preview = null;
  }

  private makeGhost(mark: Player): Ghost['mesh'] {
    const P = PLAYER_COLORS[mark];
    return new THREE.Mesh(this.ghostGeo, new THREE.MeshStandardMaterial({
      color: P.light, emissive: P.hex, emissiveIntensity: 0.9, roughness: 0.35,
      transparent: true, opacity: 0.6, depthWrite: false,
    }));
  }

  private buildRotateGuide(group: THREE.Group, m: RotateMove, color: number, pulse: Pulse[], k: number): void {
    const ax = AXIS_INDEX[m.axis];
    const center = new THREE.Vector3();
    center.setComponent(ax, m.layer - 1);
    const size: [number, number, number] = [3.12, 3.12, 3.12];
    size[ax] = 1.04;
    const geo = new THREE.BoxGeometry(...size);
    const plateMat = basicMat(color, 0.16 * k);
    const plate = new THREE.Mesh(geo, plateMat);
    const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 * k, toneMapped: false, depthTest: false });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    edges.renderOrder = 5;
    plate.position.copy(center);
    edges.position.copy(center);
    pulse.push({ mat: plateMat, base: 0.16 * k }, { mat: edgeMat, base: 0.95 * k });

    const arrow = this.makeArcArrow(color, m.dir === 'CCW', pulse, k);
    arrow.position.copy(center);
    if (m.axis === 'X') arrow.rotation.y = Math.PI / 2;      // local +Z → world +X
    else if (m.axis === 'Y') arrow.rotation.x = -Math.PI / 2; // local +Z → world +Y
    group.add(plate, edges, arrow);
  }

  /** 3/4 ring with an arrow head, counter-clockwise about local +Z (mirrored for CW). */
  private makeArcArrow(color: number, ccw: boolean, pulse: Pulse[], k: number): THREE.Group {
    const outer = new THREE.Group();
    const inner = new THREE.Group();
    outer.add(inner);
    const R = 2.3, arc = Math.PI * 1.5, a0 = Math.PI * 0.12;
    const coreMat = basicMat(color, 0.95 * k, false, { side: THREE.DoubleSide });
    const glowMat = basicMat(color, 0.22 * k, true, { side: THREE.DoubleSide });
    pulse.push({ mat: coreMat, base: 0.95 * k }, { mat: glowMat, base: 0.22 * k });
    const core = new THREE.Mesh(new THREE.TorusGeometry(R, 0.04, 8, 120, arc), coreMat);
    const glow = new THREE.Mesh(new THREE.TorusGeometry(R, 0.12, 8, 120, arc), glowMat);
    core.rotation.z = a0;
    glow.rotation.z = a0;
    const a1 = a0 + arc;
    const tangent = new THREE.Vector3(-Math.sin(a1), Math.cos(a1), 0);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.46, 18), coreMat);
    head.position.set(R * Math.cos(a1), R * Math.sin(a1), 0).addScaledVector(tangent, 0.18);
    head.quaternion.setFromUnitVectors(UP, tangent);
    inner.add(core, glow, head);
    if (!ccw) inner.scale.y = -1;
    return outer;
  }

  private buildSlideGuide(group: THREE.Group, m: SlideMove, color: number, pulse: Pulse[], k: number): void {
    const ax = AXIS_INDEX[m.axis];
    const d = slideDir(m);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, d);
    const coreMat = basicMat(color, 0.95 * k);
    const glowMat = basicMat(color, 0.2 * k, true);
    pulse.push({ mat: coreMat, base: 0.95 * k }, { mat: glowMat, base: 0.2 * k });

    // Through-arrow along the movement direction
    const len = 4.2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, len, 12), coreMat);
    const shaftGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, len, 12, 1, true), glowMat);
    for (const s of [shaft, shaftGlow]) {
      s.quaternion.copy(q);
      s.position.copy(d).multiplyScalar(-0.15);
    }
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.52, 18), coreMat);
    head.quaternion.copy(q);
    head.position.copy(d).multiplyScalar(len / 2 + 0.1);
    group.add(shaft, shaftGlow, head);

    // The slice that leaves the cube (and wraps around)
    const size: [number, number, number] = [3.12, 3.12, 3.12];
    size[ax] = 1.04;
    const plateGeo = new THREE.BoxGeometry(...size);
    const plateMat = basicMat(color, 0.1 * k);
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.copy(d);
    const edgeMat = new THREE.LineDashedMaterial({
      color, dashSize: 0.14, gapSize: 0.1, transparent: true, opacity: 0.85 * k, toneMapped: false, depthTest: false,
    });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(plateGeo), edgeMat);
    edges.computeLineDistances();
    edges.position.copy(d);
    pulse.push({ mat: plateMat, base: 0.1 * k }, { mat: edgeMat, base: 0.85 * k });
    group.add(plate, edges);

    // Wrap-around arch: leaving end → over the cube → entry end
    const u = new THREE.Vector3();
    u.setComponent(m.axis === 'Y' ? 2 : 1, 1);
    const P = (a: number, b: number): THREE.Vector3 => d.clone().multiplyScalar(a).addScaledVector(u, b);
    const curve = new THREE.CatmullRomCurve3([P(1.95, 0.5), P(2.05, 1.8), P(0, 2.2), P(-2.05, 1.8), P(-2.3, 0.85), P(-2.0, 0.1)]);
    const archMat = basicMat(color, 0.7 * k);
    pulse.push({ mat: archMat, base: 0.7 * k });
    const arch = new THREE.Mesh(new THREE.TubeGeometry(curve, 80, 0.03, 8, false), archMat);
    const end = curve.getPoint(1);
    const tan = curve.getTangent(1).normalize();
    const head2 = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 14), archMat);
    head2.position.copy(end).addScaledVector(tan, 0.1);
    head2.quaternion.setFromUnitVectors(UP, tan);
    group.add(arch, head2);
  }

  /** Glowing cylinder through a line of 3 cells (overlay / unit coordinates). */
  private makeBeam(line: Line, color: number, r: number, pulse: Pulse[], strength = 1): THREE.Group {
    const a = unitPos(line[0]);
    const b = unitPos(line[2]);
    const dir = b.clone().sub(a);
    const len = dir.length() + 0.9;
    dir.normalize();
    const g = new THREE.Group();
    g.position.copy(a).add(b).multiplyScalar(0.5);
    g.quaternion.setFromUnitVectors(UP, dir);
    const coreMat = basicMat(color, 0.95 * strength, true);
    const haloMat = basicMat(color, 0.22 * strength, true);
    g.add(
      new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12, 1, true), coreMat),
      new THREE.Mesh(new THREE.CylinderGeometry(r * 3.2, r * 3.2, len, 16, 1, true), haloMat),
    );
    pulse.push({ mat: coreMat, base: 0.95 * strength }, { mat: haloMat, base: 0.22 * strength });
    return g;
  }

  // ═══════════════════════════════ Win display ═════════════════════════════

  showWin(entries: { line: Line; player: Player }[]): void {
    this.clearWin();
    const group = new THREE.Group();
    const pulse: Pulse[] = [];
    const cells = new Set<number>();
    for (const { line, player } of entries) {
      const beam = this.makeBeam(line, PLAYER_COLORS[player].light, 0.07, pulse);
      beam.scale.y = 0.001;
      group.add(beam);
      void tween(650, t => { beam.scale.y = Math.max(0.001, t); }, ease.outCubic);
      for (const i of line) cells.add(i);
    }
    this.overlay.add(group);
    this.win = { group, pulse, cells };
    const colors: number[] = [];
    for (const i of cells) {
      const m = this.board[i];
      const col = m ? PLAYER_COLORS[m].light : 0xffffff;
      colors.push(col);
      const p = this.cells[i].group.getWorldPosition(new THREE.Vector3());
      this.burst(p, col, 22, 3.4);
      this.shockwave(p, col, 2.8);
    }
    this.confetti(colors.length ? colors : [0xffffff]);
  }

  clearWin(): void {
    if (!this.win) return;
    this.overlay.remove(this.win.group);
    disposeTree(this.win.group, this.shared);
    this.win = null;
  }

  // ═══════════════════════════════ 王手 display ════════════════════════════

  /** Lines that put the player to move in check (pulsing beams), or none. */
  setCheck(entries: { line: Line; player: Player }[]): void {
    this.clearCheck();
    if (entries.length === 0) return;
    const group = new THREE.Group();
    const pulse: Pulse[] = [];
    const cells = new Set<number>();
    for (const { line, player } of entries) {
      group.add(this.makeBeam(line, PLAYER_COLORS[player].light, 0.05, pulse, 0.9));
      for (const i of line) cells.add(i);
    }
    this.overlay.add(group);
    this.check = { group, pulse, cells };
  }

  clearCheck(): void {
    if (!this.check) return;
    this.overlay.remove(this.check.group);
    disposeTree(this.check.group, this.shared);
    this.check = null;
  }

  // ═══════════════════════════════ Animations ══════════════════════════════

  get isAnimating(): boolean { return this.animating > 0; }

  async animatePlace(index: number, mark: Player): Promise<void> {
    this.animating++;
    const c = this.cells[index];
    try {
      this.board[index] = mark;
      this.paint(c, mark);
      c.busy = true;
      c.piece.scale.setScalar(0.001);
      tintAlpha(c.tint, mark, 0);
      const wp = c.group.getWorldPosition(new THREE.Vector3());
      const col = PLAYER_COLORS[mark].light;
      this.shockwave(wp, col);
      this.burst(wp, col, 16, 2.6);
      await tween(440, t => {
        c.piece.scale.setScalar(Math.max(0.001, ease.outBack(t)));
        c.glow.material.opacity = 0.9 * t;
        tintAlpha(c.tint, mark, t);
      }, ease.linear);
    } finally {
      c.busy = false;
      c.piece.scale.setScalar(1);
      this.animating--;
    }
  }

  async animateMove(from: number, to: number, mark: Player): Promise<void> {
    this.animating++;
    const a = this.cells[from], b = this.cells[to];
    try {
      this.board[from] = null;
      this.board[to] = mark;
      this.paint(a, null);
      this.paint(b, mark);
      b.busy = true;
      // The colour does not fly with the piece: it fades out at the start cell and fills the
      // destination after landing.
      a.tint.fill.visible = true;
      tintColor(a.tint, mark);
      tintAlpha(b.tint, mark, 0);
      const start = this.home(from), end = this.home(to);
      const dir = end.clone().sub(start);
      const dist = dir.length();
      dir.normalize();
      const up = UP.clone().addScaledVector(dir, -UP.dot(dir));
      if (up.lengthSq() < 0.09) {
        up.copy(this.camera.position).normalize();
        up.addScaledVector(dir, -up.dot(dir));
      }
      up.normalize();
      const h = 0.55 + dist * 0.22;
      const col = PLAYER_COLORS[mark].light;
      let lastTrail = 0;
      b.group.position.copy(start);
      await tween(560, t => {
        const e = ease.inOutCubic(t);
        b.group.position.lerpVectors(start, end, e).addScaledVector(up, 4 * h * e * (1 - e));
        b.piece.scale.setScalar(1 + 0.12 * Math.sin(Math.PI * e));
        tintAlpha(a.tint, mark, 1 - e);
        if (t - lastTrail > 0.04 && t < 0.95) {
          lastTrail = t;
          this.spawn(glowTexture(), b.group.position, new THREE.Vector3(), col, 0.45, 0.55, 0.1, 0.6, 0);
        }
      }, ease.linear);
      a.tint.fill.visible = a.mark !== null;
      b.group.position.copy(end);
      this.shockwave(end, col);
      await tween(180, t => {
        const sq = 1 - 0.2 * Math.sin(Math.PI * t);
        const w = 1 / Math.sqrt(sq);
        b.piece.scale.set(w, sq, w);
        tintAlpha(b.tint, mark, t);
      }, ease.linear);
    } finally {
      a.tint.fill.visible = a.mark !== null;
      b.busy = false;
      b.piece.scale.setScalar(1);
      this.home(to, b.group.position);
      this.animating--;
    }
  }

  async animateRotate(move: RotateMove, newBoard: Mark[]): Promise<void> {
    this.animating++;
    this.clearPreview();
    const pivot = new THREE.Group();
    try {
      const axis = axisVec(move.axis);
      const ax = AXIS_INDEX[move.axis];
      const s = this.spacing;
      pivot.position.copy(axis).multiplyScalar((move.layer - 1) * s);
      this.root.add(pivot);
      const layer = this.cells.filter(c => fromIndex(c.index)[ax] === move.layer);
      for (const c of layer) pivot.attach(c.group);

      const size: [number, number, number] = [3.12 * s, 3.12 * s, 3.12 * s];
      size[ax] = 1.04 * s;
      const plateMat = basicMat(AXIS_COLORS[move.axis].hex, 0);
      pivot.add(new THREE.Mesh(new THREE.BoxGeometry(...size), plateMat));

      const angle = (move.dir === 'CCW' ? 1 : -1) * Math.PI / 2;
      await tween(600, t => {
        // ease-in-out with a small mechanical overshoot at the end
        const k = t < 0.8 ? ease.inOutCubic(t / 0.8) * 1.035 : 1.035 - 0.035 * ease.outCubic((t - 0.8) / 0.2);
        pivot.quaternion.setFromAxisAngle(axis, angle * k);
        plateMat.opacity = 0.2 * Math.sin(Math.PI * t);
      }, ease.linear);

      for (const c of layer) {
        this.root.attach(c.group);
        c.group.quaternion.identity();
        this.home(c.index, c.group.position);
      }
      this.setBoard(newBoard);
      this.shake(0.05, 0.18);
    } finally {
      this.root.remove(pivot);
      disposeTree(pivot, this.shared);
      this.animating--;
    }
  }

  async animateSlide(move: SlideMove, newBoard: Mark[]): Promise<void> {
    this.animating++;
    this.clearPreview();
    const ax = AXIS_INDEX[move.axis];
    const d = slideDir(move).multiplyScalar(this.spacing);
    const leavingCoord = move.dir === 'forward' ? 0 : 2;
    const perm = movePermutation(move);
    const leaving = this.cells.filter(c => fromIndex(c.index)[ax] === leavingCoord);
    const clones: {
      mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>; glow: THREE.Sprite;
      tint: Tint; mark: Player; from: THREE.Vector3; to: THREE.Vector3;
    }[] = [];
    try {
      for (const c of leaving) {
        c.busy = true;
        this.setDim(c, 0.999);
        if (!c.mark) continue;
        const P = PLAYER_COLORS[c.mark];
        const mesh = new THREE.Mesh(this.pieceGeo, c.piece.material.clone());
        mesh.material.transparent = true;
        mesh.material.opacity = 0;
        const glow = new THREE.Sprite(c.glow.material.clone());
        glow.material.color.setHex(P.glow);
        glow.scale.setScalar(1.45);
        const tint = this.makeTint();
        tintColor(tint, c.mark);
        const to = this.home(perm[c.index]);
        const from = to.clone().sub(d);
        mesh.position.copy(from);
        glow.position.copy(from);
        tint.fill.position.copy(from);
        this.root.add(mesh, glow, tint.fill);
        clones.push({ mesh, glow, tint, mark: c.mark, from, to });
      }
      const starts = this.cells.map(c => this.home(c.index));
      await tween(600, t => {
        const e = ease.inOutCubic(t);
        for (const c of this.cells) c.group.position.copy(starts[c.index]).addScaledVector(d, e);
        for (const c of leaving) {
          const o = 1 - e;
          c.piece.material.opacity = o;
          c.glow.material.opacity = 0.5 * o;
          c.symbol.material.opacity = o;
          c.marker.material.opacity = 0.6 * o;
          tintAlpha(c.tint, c.mark, o);
          c.piece.scale.setScalar(1 - 0.35 * e);
          c.tint.fill.scale.setScalar(1 - 0.35 * e);
        }
        for (const k of clones) {
          k.mesh.position.lerpVectors(k.from, k.to, e);
          k.glow.position.copy(k.mesh.position);
          k.tint.fill.position.copy(k.mesh.position);
          k.mesh.material.opacity = e;
          k.glow.material.opacity = 0.5 * e;
          tintAlpha(k.tint, k.mark, e);
          k.mesh.scale.setScalar(0.65 + 0.35 * e);
          k.tint.fill.scale.setScalar(0.65 + 0.35 * e);
        }
      }, ease.linear);
      for (const c of this.cells) this.home(c.index, c.group.position);
      for (const c of leaving) c.busy = false;
      this.setBoard(newBoard);
      this.shake(0.04, 0.16);
    } finally {
      for (const k of clones) {
        this.root.remove(k.mesh, k.glow, k.tint.fill);
        k.mesh.material.dispose();
        k.glow.material.dispose();
        k.tint.fill.material.dispose();
        k.tint.edge.material.dispose();
      }
      for (const c of leaving) {
        c.busy = false;
        c.piece.scale.setScalar(1);
        c.tint.fill.scale.setScalar(1);
      }
      this.animating--;
    }
  }

  /** Shrink every piece away (title-screen demo reset). */
  async clearBoardAnimated(): Promise<void> {
    this.animating++;
    const on = this.cells.filter(c => c.mark);
    try {
      on.forEach(c => { c.busy = true; });
      await tween(380, t => on.forEach(c => {
        c.piece.scale.setScalar(Math.max(0.001, 1 - t));
        tintAlpha(c.tint, c.mark, 1 - t);
      }), ease.inCubic);
    } finally {
      on.forEach(c => { c.busy = false; });
      this.setBoard(Array<Mark>(27).fill(null));
      this.animating--;
    }
  }

  /** Small red pulse on a cell (invalid click feedback). */
  flashInvalid(i: number): void {
    const p = this.cells[i].group.getWorldPosition(new THREE.Vector3());
    this.shockwave(p, 0xff5a6e, 1.3);
  }

  // ═══════════════════════════════ Particles ═══════════════════════════════

  private spawn(tex: THREE.Texture, pos: THREE.Vector3, vel: THREE.Vector3, color: number,
    life: number, s0: number, s1: number, o0 = 1, drag = 2.2, grav = 0): void {
    if (this.particles.length > 420 || this.disposed) return;
    let pool = this.pools.get(tex);
    if (!pool) { pool = []; this.pools.set(tex, pool); }
    const sprite = pool.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    sprite.material.color.setHex(color);
    sprite.material.opacity = o0;
    sprite.position.copy(pos);
    sprite.scale.setScalar(s0);
    this.fx.add(sprite);
    this.particles.push({ sprite, tex, vel: vel.clone(), age: 0, life, s0, s1, o0, drag, grav });
  }

  private burst(pos: THREE.Vector3, color: number, n: number, speed: number): void {
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      v.set(r * Math.cos(th), u, r * Math.sin(th)).multiplyScalar(speed * (0.45 + Math.random() * 0.55));
      this.spawn(glowTexture(), pos, v, i % 4 === 0 ? 0xffffff : color, 0.55 + Math.random() * 0.35, 0.22, 0.05, 1, 3.2, 0);
    }
  }

  private shockwave(pos: THREE.Vector3, color: number, size = 2.2): void {
    this.spawn(ringTexture(), pos, new THREE.Vector3(), color, 0.5, 0.25, size, 0.9, 0, 0);
  }

  private confetti(colors: number[]): void {
    const v = new THREE.Vector3(), p = new THREE.Vector3();
    const palette = [...colors, 0xffffff, 0xffd166];
    for (let i = 0; i < 90; i++) {
      p.set((Math.random() - 0.5) * 4, 2.6 + Math.random() * 1.2, (Math.random() - 0.5) * 4);
      v.set((Math.random() - 0.5) * 2.4, 0.6 + Math.random() * 1.6, (Math.random() - 0.5) * 2.4);
      this.spawn(glowTexture(), p, v, palette[i % palette.length], 1.8 + Math.random() * 1.2, 0.2, 0.12, 1, 0.7, 2.4);
    }
  }

  private shake(amp: number, dur: number): void {
    this.shakeState.amp = amp;
    this.shakeState.dur = dur;
    this.shakeState.t = 0;
  }

  // ═══════════════════════════════ Camera ══════════════════════════════════

  setView(p: ViewPreset): void {
    const v = VIEWS[p];
    const twoPi = Math.PI * 2;
    this.camT.theta = v.theta + twoPi * Math.round((this.camT.theta - v.theta) / twoPi);
    this.camT.phi = v.phi;
    this.zoomT = 1;
  }

  orbit(dTheta: number, dPhi: number): void {
    this.camT.theta += dTheta;
    this.camT.phi = clamp(this.camT.phi + dPhi, 0.12, Math.PI - 0.12);
  }

  zoomBy(f: number): void { this.zoomT = clamp(this.zoomT * f, 0.55, 1.9); }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    // fit the cube plus its guides (arc arrows reach ~2.9 units from the centre)
    this.fitRadius = Math.max(7.6, 3.3 / Math.sin(Math.min(vfov, hfov) / 2));
    if (this.gizmo) {
      const size = Math.round(clamp(Math.min(w, h) * 0.17, 64, 92));
      this.gizmo.size = size;
      this.gizmo.bg.style.width = this.gizmo.bg.style.height = `${size}px`;
      this.gizmo.bg.style.left = `${this.gizmo.margin}px`;
      this.gizmo.bg.style.bottom = `${this.gizmo.margin}px`;
    }
  }

  // ═══════════════════════════════ Input ═══════════════════════════════════

  private bindInput(): void {
    const c = this.canvas;
    const listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      c.addEventListener(type, fn, opts);
      this.disposers.push(() => c.removeEventListener(type, fn, opts));
    };

    listen('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, moved: false, touch: e.pointerType === 'touch' };
      } else if (this.pointers.size === 2) {
        const [p1, p2] = [...this.pointers.values()];
        this.pinch = { d0: Math.hypot(p1.x - p2.x, p1.y - p2.y), z0: this.zoomT };
        if (this.down) this.down.moved = true;
      }
    });

    listen('pointermove', e => {
      const p = this.pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType !== 'touch') this.updateHover(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size >= 2 && this.pinch) {
        const [p1, p2] = [...this.pointers.values()];
        const d = Math.max(10, Math.hypot(p1.x - p2.x, p1.y - p2.y));
        this.zoomT = clamp(this.pinch.z0 * this.pinch.d0 / d, 0.55, 1.9);
        return;
      }
      const dn = this.down;
      if (!dn) return;
      if (!dn.moved && Math.hypot(e.clientX - dn.x, e.clientY - dn.y) > 6) {
        dn.moved = true;
        c.classList.add('dragging');
        this.emitHover(null);
      }
      if (dn.moved) this.orbit(-dx * 0.0085, -dy * 0.0085);
    });

    const end = (e: PointerEvent): void => {
      const had = this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const dn = this.down;
      if (had && dn && dn.id === e.pointerId) {
        const tap = !dn.moved && performance.now() - dn.t < 650 && e.type === 'pointerup';
        this.down = null;
        c.classList.remove('dragging');
        if (tap) {
          const r = this.pick(e.clientX, e.clientY, dn.touch);
          this.onCellClick?.(r.valid, r.raw);
          if (!dn.touch) this.updateHover(e.clientX, e.clientY);
        }
      }
      if (this.pointers.size === 0) {
        this.down = null;
        c.classList.remove('dragging');
      }
    };
    listen('pointerup', end);
    listen('pointercancel', end);
    listen('pointerleave', e => { if (e.pointerType !== 'touch' && this.pointers.size === 0) this.emitHover(null); });
    listen('wheel', e => {
      e.preventDefault();
      this.zoomBy(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    listen('contextmenu', e => e.preventDefault());
  }

  private lastHoverEmit: number | null = null;

  private emitHover(i: number | null): void {
    if (i === this.lastHoverEmit) return;
    this.lastHoverEmit = i;
    this.onCellHover?.(i);
  }

  private updateHover(cx: number, cy: number): void {
    if (this.animating > 0) {
      this.emitHover(null);
      this.canvas.style.cursor = '';
      return;
    }
    const { valid } = this.pick(cx, cy, false);
    this.canvas.style.cursor = valid !== null ? 'pointer' : '';
    this.emitHover(valid);
  }

  /**
   * First valid cell along the ray. With a mouse, invalid cells are "see-through"
   * (the hover ghost shows the result before clicking). With touch there is no
   * hover, so a visible piece in front blocks the tap.
   */
  private pick(cx: number, cy: number, touch: boolean): { valid: number | null; raw: number | null } {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.hitMeshes, false);
    let raw: number | null = null;
    for (const h of hits) {
      const i = h.object.userData['index'] as number;
      if (raw === null) raw = i;
      if (this.pickFilter(i)) return { valid: i, raw: i };
      if (touch && this.board[i] !== null) break;
    }
    return { valid: null, raw };
  }

  // ═══════════════════════════════ Frame loop ══════════════════════════════

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;
    this.updateCamera(dt);
    this.updateSpacing(dt);
    this.scene.updateMatrixWorld();
    this.updateCells();
    this.updatePreview();
    this.updateFx(dt);
    this.render();
    this.updateLabels();
  };

  private updateCamera(dt: number): void {
    if (this.demo) this.camT.theta += dt * 0.13;
    const k = 1 - Math.exp(-dt * 9);
    this.cam.theta += (this.camT.theta - this.cam.theta) * k;
    this.cam.phi += (this.camT.phi - this.cam.phi) * k;
    this.zoom += (this.zoomT - this.zoom) * k;
    const radius = this.fitRadius * this.zoom * Math.pow(this.spacing / BASE_SPACING, 0.9);
    this.camera.position.setFromSphericalCoords(radius, this.cam.phi, this.cam.theta);
    const sh = this.shakeState;
    if (sh.t < sh.dur) {
      sh.t += dt;
      const a = sh.amp * (1 - sh.t / sh.dur);
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
    }
    this.camera.lookAt(0, 0, 0);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = radius - 2.5;
    fog.far = radius + 10;

    this.turnColor.lerp(this.turnColorTarget, 1 - Math.exp(-dt * 4));
    this.floor.material.color.copy(this.turnColor);
    this.floorRing.material.color.copy(this.turnColor);
    this.floorRing.material.opacity = 0.28 + 0.08 * Math.sin(this.time * 1.6);
    this.stars.rotation.y += dt * 0.006;
  }

  private updateSpacing(dt: number): void {
    if (this.animating > 0 || this.spacing === this.spacingTarget) return;
    this.spacing += (this.spacingTarget - this.spacing) * (1 - Math.exp(-dt * 8));
    if (Math.abs(this.spacing - this.spacingTarget) < 1e-3) this.spacing = this.spacingTarget;
    this.applySpacing();
  }

  private applySpacing(): void {
    for (const c of this.cells) if (!c.busy) this.home(c.index, c.group.position);
    this.gridGroup.scale.setScalar(this.spacing);
    this.overlay.scale.setScalar(this.spacing);
    this.floor.position.y = this.floorRing.position.y = -(1.5 * this.spacing + 1.15);
  }

  private updateCells(): void {
    const t = this.time;
    const camPos = this.camera.position;
    for (const c of this.cells) {
      const i = c.index;
      const isT = this.targets.has(i);
      const isH = this.hover === i;
      const isS = this.selected === i;
      const isW = !!this.win?.cells.has(i);
      const isC = !isW && !!this.check?.cells.has(i);
      if (c.mark) {
        let glowO = 0.5, scale = 1, emi = 0.32;
        if (isT) { glowO = 0.62 + 0.25 * Math.sin(t * 4 + i); emi = 0.45; }
        if (isH) { glowO = 0.95; scale = 1.08; emi = 0.6; }
        if (isS) { glowO = 1; scale = 1.1 + 0.03 * Math.sin(t * 6); emi = 0.7; }
        if (isW) { const k = 0.5 + 0.5 * Math.sin(t * 5); glowO = 0.75 + 0.5 * k; scale = 1.06 + 0.08 * k; emi = 0.42 + 0.3 * k; }
        if (isC) { const k = 0.5 + 0.5 * Math.sin(t * 7); glowO = Math.max(glowO, 0.7 + 0.3 * k); emi = Math.max(emi, 0.45 + 0.25 * k); }
        c.piece.material.emissiveIntensity = emi;
        if (!c.busy) {
          c.piece.scale.setScalar(scale);
          c.glow.material.opacity = glowO * c.dim;
          c.symbol.material.opacity = c.dim;
          tintAlpha(c.tint, c.mark, c.dim);
        }
        if (c.symbol.visible) {
          // keep the ○/× glyph on the sphere surface facing the camera
          c.group.getWorldPosition(this.v1);
          this.v2.copy(camPos).sub(this.v1).normalize().multiplyScalar(PIECE_R * c.piece.scale.x + 0.03).add(this.v1);
          c.symbol.position.copy(c.group.worldToLocal(this.v2));
        }
      } else if (!c.busy) {
        let ms = 1, mo = 0.55, ho = 0;
        if (isT) {
          const k = 0.5 + 0.5 * Math.sin(t * 3.2 + i * 0.7);
          ms = 1.5 + 0.45 * k; mo = 0.95; ho = 0.2 + 0.2 * k;
        }
        if (isH) { ms = 2.2; mo = 1; ho = 0.55; }
        c.marker.scale.setScalar(ms);
        c.marker.material.opacity = mo * c.dim;
        c.marker.material.color.copy(isT || isH ? this.targetColor : EMPTY_COLOR);
        c.halo.material.opacity = ho;
        c.halo.material.color.copy(this.targetColor);
      }
    }

    // hover ghost (placement / move-destination preview)
    const hc = this.hover !== null ? this.cells[this.hover] : null;
    const showGhost = !!hc && !hc.mark && this.hoverMark !== null && this.animating === 0;
    this.hoverGhost.visible = showGhost;
    if (showGhost && hc) {
      hc.group.getWorldPosition(this.hoverGhost.position);
      this.hoverGhost.scale.setScalar(0.94 + 0.04 * Math.sin(t * 6));
      this.hoverGhost.material.opacity = 0.36 + 0.1 * Math.sin(t * 6);
    }

    // selection ring (billboard)
    const sc = this.selected !== null ? this.cells[this.selected] : null;
    this.selRing.visible = !!sc && this.animating === 0;
    if (sc) {
      sc.group.getWorldPosition(this.selRing.position);
      this.selRing.quaternion.copy(this.camera.quaternion);
      this.selRing.scale.setScalar(1 + 0.06 * Math.sin(t * 5));
      this.selRing.material.color.copy(this.targetColor);
    }

    // last moved piece marker
    const lc = this.lastMoved !== null ? this.cells[this.lastMoved] : null;
    this.lastRing.visible = !!lc && !!lc.mark && this.animating === 0 && this.preview === null && this.lastMoved !== this.selected;
    if (lc) {
      lc.group.getWorldPosition(this.lastRing.position);
      this.lastRing.quaternion.copy(this.camera.quaternion);
      this.lastRing.material.opacity = 0.35 + 0.2 * Math.sin(t * 2.4);
    }

    // dashed line: selected piece → hovered destination
    this.moveLine.visible = !!sc && showGhost;
    if (this.moveLine.visible && sc && hc) {
      const attr = this.moveLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      sc.group.getWorldPosition(this.v1);
      hc.group.getWorldPosition(this.v2);
      attr.setXYZ(0, this.v1.x, this.v1.y, this.v1.z);
      attr.setXYZ(1, this.v2.x, this.v2.y, this.v2.z);
      attr.needsUpdate = true;
      this.moveLine.geometry.computeBoundingSphere();
      this.moveLine.computeLineDistances();
    }
  }

  private updatePreview(): void {
    const pulseK = 0.75 + 0.25 * Math.sin(this.time * 3.4);
    if (this.win) {
      const wk = 0.7 + 0.3 * Math.sin(this.time * 4);
      for (const p of this.win.pulse) p.mat.opacity = p.base * wk;
    }
    if (this.check) {
      const ck = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.time * 7));
      for (const p of this.check.pulse) p.mat.opacity = p.base * ck;
    }
    const p = this.preview;
    if (!p) return;
    for (const q of p.pulse) q.mat.opacity = q.base * pulseK;
    if (!p.ghosts.length) return;

    const period = 1.8 * getAnimSpeed();
    const ph = ((this.time - p.t0) % period) / period;
    const k = ph < 0.16 ? 0 : ph < 0.7 ? ease.inOutCubic((ph - 0.16) / 0.54) : 1;
    const fade = ph < 0.06 ? ph / 0.06 : ph > 0.92 ? Math.max(0, (1 - ph) / 0.08) : 1;
    const s = this.spacing;
    const m = p.move;
    for (const g of p.ghosts) {
      const pos = g.mesh.position;
      if (m.kind === 'rotate') {
        axisVec(m.axis, this.v3);
        this.v2.copy(this.v3).multiplyScalar((m.layer - 1) * s); // pivot
        this.home(g.from, pos).sub(this.v2)
          .applyAxisAngle(this.v3, (m.dir === 'CCW' ? 1 : -1) * Math.PI / 2 * k)
          .add(this.v2);
      } else {
        slideDir(m, this.v3).multiplyScalar(s);
        if (g.mode === 'enter') this.home(g.to, pos).addScaledVector(this.v3, k - 1);
        else this.home(g.from, pos).addScaledVector(this.v3, k);
      }
      const base = 0.62 * fade;
      g.mesh.material.opacity = g.mode === 'leave' ? base * (1 - k) : g.mode === 'enter' ? base * k : base;
    }
  }

  private updateFx(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.fx.remove(p.sprite);
        this.pools.get(p.tex)?.push(p.sprite);
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.vel.y -= p.grav * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      const k = p.age / p.life;
      p.sprite.scale.setScalar(p.s0 + (p.s1 - p.s0) * ease.outCubic(k));
      p.sprite.material.opacity = p.o0 * Math.pow(1 - k, 1.4);
    }
  }

  private render(): void {
    const r = this.renderer;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.clear();
    r.render(this.scene, this.camera);
    const g = this.gizmo;
    const showGizmo = !!g && w > 220 && h > 180;
    this.labelLayer.classList.toggle('gizmo-off', !showGizmo);
    if (g && showGizmo) {
      g.cam.position.copy(this.camera.position).normalize().multiplyScalar(6);
      g.cam.up.copy(this.camera.up);
      g.cam.lookAt(0, 0, 0);
      r.clearDepth();
      r.setScissorTest(true);
      r.setScissor(g.margin, g.margin, g.size, g.size);
      r.setViewport(g.margin, g.margin, g.size, g.size);
      r.render(g.scene, g.cam);
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
    }
  }

  /**
   * For each axis, pick the cube edge (parallel to that axis) that lies on the
   * silhouette and is highest on screen, so the layer labels stay readable and
   * inside the canvas whatever the camera angle.
   */
  private readonly labelEdge: Record<Axis, [number, number]> = { X: [1, -1], Y: [-1, 1], Z: [-1, 1] };

  private chooseLabelEdges(w: number, h: number): void {
    const cp = this.camera.position;
    const sgn = (v: number): number => (v >= 0 ? 1 : -1);
    const e = 1.5 * this.spacing;
    for (const a of AXES) {
      const ai = AXIS_INDEX[a];
      const [bi, ci] = [0, 1, 2].filter(i => i !== ai);
      const sb = sgn(cp.getComponent(bi)), sc = sgn(cp.getComponent(ci));
      const cands: [number, number][] = [[sb, -sc], [-sb, sc]];
      let best = cands[0];
      let bestY = Infinity, bestX = Infinity;
      for (const cand of cands) {
        this.v1.set(0, 0, 0);
        this.v1.setComponent(bi, cand[0] * e);
        this.v1.setComponent(ci, cand[1] * e);
        this.v1.project(this.camera);
        const x = ((this.v1.x + 1) / 2) * w, y = ((1 - this.v1.y) / 2) * h;
        if (y < bestY - 2 || (Math.abs(y - bestY) <= 2 && x < bestX)) { best = cand; bestY = y; bestX = x; }
      }
      this.labelEdge[a] = best;
    }
  }

  private labelPos(a: Axis, k: number, out: THREE.Vector3): THREE.Vector3 {
    const ai = AXIS_INDEX[a];
    const [bi, ci] = [0, 1, 2].filter(i => i !== ai);
    const [b, c] = this.labelEdge[a];
    const e = 1.5 * this.spacing + 0.3;
    out.set(0, 0, 0);
    out.setComponent(ai, (k - 1) * this.spacing);
    out.setComponent(bi, b * e);
    out.setComponent(ci, c * e);
    return out;
  }

  private updateLabels(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.labelLayer.classList.toggle('labels-on', this.labelsOn);
    if (this.labelsOn) {
      this.chooseLabelEdges(w, h);
      const anyEmph = this.labelEmph.size > 0;
      for (const [key, el] of this.labelEls) {
        this.labelPos(key[0] as Axis, Number(key[1]), this.v1).project(this.camera);
        const x = clamp(((this.v1.x + 1) / 2) * w, 16, w - 16), y = clamp(((1 - this.v1.y) / 2) * h, 12, h - 12);
        const em = this.labelEmph.has(key);
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${em ? 1.25 : 1})`;
        el.classList.toggle('emph', em);
        el.classList.toggle('faded', anyEmph && !em);
      }
    }
    const g = this.gizmo;
    if (g) {
      for (const L of g.letters) {
        this.v1.copy(L.pos).project(g.cam);
        const x = g.margin + ((this.v1.x + 1) / 2) * g.size;
        const y = h - g.margin - ((this.v1.y + 1) / 2) * g.size;
        L.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      }
    }
  }

  // ═══════════════════════════════ Lifecycle ═══════════════════════════════

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    for (const f of this.disposers) f();
    this.clearPreview();
    this.clearWin();
    this.clearCheck();
    disposeTree(this.scene);
    if (this.gizmo) disposeTree(this.gizmo.scene);
    for (const pool of this.pools.values()) for (const s of pool) s.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.labelLayer.remove();
  }
}
