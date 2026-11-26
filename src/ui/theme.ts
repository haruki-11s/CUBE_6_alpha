import type { Axis, Player } from '../core/types';

export interface PlayerTheme {
  hex: number;       // main colour (3D)
  light: number;     // highlight / ghost colour (3D)
  glow: number;      // additive glow colour (3D)
  css: string;
  cssLight: string;
  label: string;     // 〇（青） / ×（赤）
  symbol: string;    // 〇 / ×
  glyph: string;     // ○ / × (drawn glyph)
}

export const PLAYER_COLORS: Readonly<Record<Player, PlayerTheme>> = {
  O: { hex: 0x3d8bff, light: 0x9cc6ff, glow: 0x2f7bff, css: '#3d8bff', cssLight: '#9cc6ff', label: '〇（青）', symbol: '〇', glyph: '○' },
  X: { hex: 0xff3b5c, light: 0xff9aae, glow: 0xff2a4f, css: '#ff3b5c', cssLight: '#ff9aae', label: '×（赤）', symbol: '×', glyph: '×' },
};

/** Axis colours: chosen to stay distinct from the blue / red pieces. */
export const AXIS_COLORS: Readonly<Record<Axis, { hex: number; css: string }>> = {
  X: { hex: 0x2ee59d, css: '#2ee59d' }, // green
  Y: { hex: 0xffc233, css: '#ffc233' }, // amber
  Z: { hex: 0xb47cff, css: '#b47cff' }, // violet
};

export const other = (p: Player): Player => (p === 'O' ? 'X' : 'O');

export const APP_VERSION = '1.5.0';
