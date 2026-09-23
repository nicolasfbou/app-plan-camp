import { describe, expect, it } from 'vitest';
import { boundedSize, displayedSymbolSize, drawFlowArrows, effectiveSpacing } from './decorations.ts';

const display = { symbolMinPx: 12, symbolMaxPx: 44 };

/** Contexte 2D minimal qui compte les flèches dessinées. */
function fakeContext() {
  const calls = { fill: 0, translate: [] as [number, number][], rotate: [] as number[] };
  const noop = () => undefined;
  const c = {
    save: noop,
    restore: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    stroke: noop,
    fill: () => calls.fill++,
    translate: (x: number, y: number) => calls.translate.push([x, y]),
    rotate: (a: number) => calls.rotate.push(a),
  } as unknown as CanvasRenderingContext2D;
  return { c, calls };
}

const flow = (direction: 'forward' | 'backward' | 'both', visible = true) => ({
  arrows: { direction, visible, size: 20, spacing: 100 },
  style: {
    fill: null,
    fillOpacity: 0,
    stroke: '#1d4ed8',
    strokeOpacity: 1,
    strokeWidth: 4,
    dash: 'solid' as const,
    pattern: 'none' as const,
  },
  geometry: {
    points: [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
    ],
  },
});

describe('flèches des trajets à l’affichage', () => {
  it('taille bornée à l’écran : ni minuscule dézoomé, ni gigantesque zoomé', () => {
    expect(boundedSize(20, 1, display) * 1).toBe(20);
    expect(boundedSize(20, 0.1, display) * 0.1).toBeCloseTo(12); // 2 px → 12 px écran
    expect(boundedSize(20, 8, display) * 8).toBeCloseTo(44); // 160 px → 44 px écran
  });

  it('pictogramme placé : taille enregistrée dans les limites, bornée au-delà (sans re-rendu inutile)', () => {
    expect(displayedSymbolSize(40, 0.5, display)).toBe(40); // 20 px écran : inchangé
    expect(displayedSymbolSize(40, 0.9, display)).toBe(40); // 36 px écran : inchangé
    expect(displayedSymbolSize(40, 4, display) * 4).toBeCloseTo(44, 1); // 160 px → 44 px écran
    expect(displayedSymbolSize(40, 0.1, display) * 0.1).toBeCloseTo(12, 1); // 4 px → 12 px écran
  });

  it('dézoomé : les flèches s’espacent au lieu de se chevaucher', () => {
    expect(effectiveSpacing(100, 20)).toBe(100);
    expect(effectiveSpacing(100, 120)).toBeCloseTo(264);
  });

  it('sens, double sens, masquage', () => {
    const forward = fakeContext();
    expect(drawFlowArrows(forward.c, flow('forward'), 1, display)).toBe(10);
    expect(forward.calls.rotate.every((a) => a === 0)).toBe(true);
    const both = fakeContext();
    expect(drawFlowArrows(both.c, flow('both'), 1, display)).toBe(10);
    const hidden = fakeContext();
    expect(drawFlowArrows(hidden.c, flow('forward', false), 1, display)).toBe(0);
    expect(hidden.calls.fill).toBe(0);
  });
});
