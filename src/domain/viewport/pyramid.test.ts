import { describe, expect, it } from 'vitest';
import { chooseLevel, pyramidFactors } from './pyramid.ts';

describe('pyramide d’affichage', () => {
  it('propose 1/4, 1/8… tant que la copie garde au moins 512 px', () => {
    expect(pyramidFactors(4896, 3672)).toEqual([1, 1 / 4, 1 / 8]);
    expect(pyramidFactors(800, 600)).toEqual([1]);
  });

  it('utilise l’original dès que l’écran peut afficher plus d’un quart des pixels', () => {
    const f = [1, 1 / 4, 1 / 8, 1 / 16];
    expect(chooseLevel(f, 1)).toBe(1);
    expect(chooseLevel(f, 0.5)).toBe(1);
    expect(chooseLevel(f, 0.26)).toBe(1);
    expect(chooseLevel(f, 0.25)).toBe(1 / 4);
    expect(chooseLevel(f, 0.1)).toBe(1 / 8);
    expect(chooseLevel(f, 0.05)).toBe(1 / 16);
    expect(chooseLevel(f, 0.001)).toBe(1 / 16);
  });

  it('la copie choisie contient toujours au moins autant de pixels que l’écran en affiche', () => {
    const f = pyramidFactors(20000, 15000);
    for (let s = 0.01; s <= 2; s *= 1.1) expect(chooseLevel(f, s)).toBeGreaterThanOrEqual(Math.min(1, s));
  });
});
