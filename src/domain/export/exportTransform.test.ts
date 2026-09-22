import { describe, expect, it } from 'vitest';
import { projectToScreen } from '../viewport/viewport.ts';
import { exportRaster } from './exportTransform.ts';

describe('export indépendant de l’écran', () => {
  it('exporte à la résolution native de la photo, quel que soit le zoom écran', () => {
    const raster = exportRaster({ width: 8000, height: 6000 });
    expect(raster).toMatchObject({ width: 8000, height: 6000 });
    // Un point image tombe exactement sur le même pixel de sortie.
    expect(projectToScreen(raster.viewport, { x: 1234, y: 5678 })).toEqual({ x: 1234, y: 5678 });
  });

  it('permet une sortie supérieure à la résolution native', () => {
    const raster = exportRaster({ width: 8000, height: 6000 }, 1.5);
    expect(raster).toMatchObject({ width: 12000, height: 9000 });
    expect(projectToScreen(raster.viewport, { x: 100, y: 200 })).toEqual({ x: 150, y: 300 });
  });

  it('refuse une échelle invalide', () => {
    expect(() => exportRaster({ width: 10, height: 10 }, 0)).toThrow(RangeError);
  });
});
