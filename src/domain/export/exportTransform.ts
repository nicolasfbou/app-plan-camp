/**
 * L'export ne capture jamais l'écran : il redessine le plan dans un canevas hors écran avec
 * son propre viewport, calculé ici à partir de la taille de l'image d'origine.
 * Comme les objets sont en coordonnées image, le même rendu sert à l'écran et à l'export.
 */
import type { Size, Viewport } from '../viewport/viewport.ts';

export interface ExportRaster {
  viewport: Viewport;
  width: number;
  height: number;
}

/**
 * @param image dimensions de l'image de base (espace projet)
 * @param scale pixels de sortie par pixel image (1 = résolution native, 2 = double…)
 */
export function exportRaster(image: Size, scale = 1): ExportRaster {
  if (!(scale > 0)) throw new RangeError("L'échelle d'export doit être positive.");
  return {
    viewport: { scale, x: 0, y: 0 },
    width: Math.round(image.width * scale),
    height: Math.round(image.height * scale),
  };
}
