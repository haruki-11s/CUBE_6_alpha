import { describe, it, expect } from 'vitest';
import { describeMove, shortMove, cellName, describeStep1, layerHint } from '../src/core/notation';
import { toIndex } from '../src/core/board';

describe('notation', () => {
  it('cellName prints (x,y,z)', () => {
    expect(cellName(toIndex(1, 0, 2))).toBe('(1,0,2)');
  });

  it('shortMove is compact', () => {
    expect(shortMove({ kind: 'rotate', axis: 'X', layer: 1, dir: 'CCW' })).toBe('X1↺');
    expect(shortMove({ kind: 'rotate', axis: 'Z', layer: 0, dir: 'CW' })).toBe('Z0↻');
    expect(shortMove({ kind: 'slide', axis: 'Y', dir: 'forward' })).toBe('Y−');
    expect(shortMove({ kind: 'slide', axis: 'Y', dir: 'backward' })).toBe('Y+');
  });

  it('describeMove mentions axis, layer and direction', () => {
    const d = describeMove({ kind: 'rotate', axis: 'Y', layer: 2, dir: 'CW' });
    expect(d).toContain('Y軸');
    expect(d).toContain('層2');
    expect(d).toContain('上層');
    expect(d).toContain('右回り');
    expect(describeMove({ kind: 'slide', axis: 'Z', dir: 'backward' })).toContain('＋方向');
  });

  it('describeStep1', () => {
    expect(describeStep1({ kind: 'place', index: 0 })).toBe('配置 (0,0,0)');
    expect(describeStep1({ kind: 'move', from: 0, to: 26 })).toBe('移動 (0,0,0)→(2,2,2)');
  });

  it('layerHint', () => {
    expect(layerHint('Y', 0)).toBe('下層');
  });
});
