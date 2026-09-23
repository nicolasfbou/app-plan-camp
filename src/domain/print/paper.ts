/** Formats de papier (millimètres, portrait) et conversions d'unités d'impression. */
import type { PrintSettings } from '../model/types.ts';

export const PAPER: Record<PrintSettings['paper'], { name: string; width: number; height: number }> = {
  letter: { name: 'Lettre 8,5 × 11 po', width: 215.9, height: 279.4 },
  legal: { name: 'Légal 8,5 × 14 po', width: 215.9, height: 355.6 },
  tabloid: { name: 'Tabloïd 11 × 17 po', width: 279.4, height: 431.8 },
  a4: { name: 'A4', width: 210, height: 297 },
  a3: { name: 'A3', width: 297, height: 420 },
  a2: { name: 'A2', width: 420, height: 594 },
  a1: { name: 'A1', width: 594, height: 841 },
};

export const MM_PER_INCH = 25.4;
export const PT_PER_MM = 72 / MM_PER_INCH;
/** Pixel CSS (1/96 po) en millimètres : équivalence « écran à 100 % ». */
export const MM_PER_CSS_PX = MM_PER_INCH / 96;

export function pageSize(print: Pick<PrintSettings, 'paper' | 'orientation'>): {
  width: number;
  height: number;
} {
  const p = PAPER[print.paper];
  return print.orientation === 'landscape'
    ? { width: p.height, height: p.width }
    : { width: p.width, height: p.height };
}
