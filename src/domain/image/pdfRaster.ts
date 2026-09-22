/** Calculs purs pour la rastérisation d'une page PDF en image de fond. */
import { NORMAL_MAX_MEGAPIXELS } from './sizeAssessment.ts';

export const PDF_DPI_CHOICES = [72, 100, 150, 200, 300] as const;

/** Taille en pixels d'une page (dimensions PDF en points, 72 points = 1 pouce). */
export function pdfPagePixelSize(widthPt: number, heightPt: number, dpi: number) {
  return { width: Math.round((widthPt / 72) * dpi), height: Math.round((heightPt / 72) * dpi) };
}

/** Résolution par défaut : la plus fine qui reste dans la zone « normale » (≤ 50 MP). */
export function defaultPdfDpi(widthPt: number, heightPt: number): number {
  const fitting = PDF_DPI_CHOICES.filter((dpi) => {
    const { width, height } = pdfPagePixelSize(widthPt, heightPt, dpi);
    return (width * height) / 1_000_000 <= NORMAL_MAX_MEGAPIXELS;
  });
  return fitting.at(-1) ?? PDF_DPI_CHOICES[0];
}
