import * as THREE from 'three';

// Canvas-generated textures, created once and shared by every scene.
const cache = new Map<string, THREE.Texture>();

function make(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (g) draw(g, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/** Soft radial glow (additive sprites, particles, floor light). */
export function glowTexture(): THREE.Texture {
  return make('glow', 128, (g, s) => {
    const r = s / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.18, 'rgba(255,255,255,0.75)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.2)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
}

/** Thin bright ring (shockwaves). */
export function ringTexture(): THREE.Texture {
  return make('ring', 128, (g, s) => {
    const r = s / 2;
    const grd = g.createRadialGradient(r, r, r * 0.5, r, r, r);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.78, 'rgba(255,255,255,0.3)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
}

/** White ○ / × glyph with a dark outline, readable on blue and red. */
export function symbolTexture(mark: 'O' | 'X'): THREE.Texture {
  return make(`sym-${mark}`, 128, (g, s) => {
    const c = s / 2;
    g.lineCap = 'round';
    const stroke = (w: number, color: string): void => {
      g.lineWidth = w;
      g.strokeStyle = color;
      g.beginPath();
      if (mark === 'O') {
        g.arc(c, c, s * 0.33, 0, Math.PI * 2);
      } else {
        const d = s * 0.26;
        g.moveTo(c - d, c - d); g.lineTo(c + d, c + d);
        g.moveTo(c + d, c - d); g.lineTo(c - d, c + d);
      }
      g.stroke();
    };
    stroke(s * 0.17, 'rgba(0,0,0,0.5)');
    stroke(s * 0.1, '#ffffff');
  });
}
