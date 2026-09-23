/**
 * Barre d'échelle et échelle numérique : calculées à partir de la calibration et de l'échelle
 * RÉELLE du plan imprimé (mm de papier par pixel de photo). Sans calibration : aucune échelle.
 */
import { FEET_PER_METER, metersPerPixel } from '../model/measure.ts';
import type { Calibration } from '../model/types.ts';

export interface ScaleBar {
  /** Longueur représentée (dans l'unité choisie). */
  length: number;
  unit: 'm' | 'pi';
  /** Longueur sur le papier, en mm. */
  mm: number;
  /** Graduations (valeurs), de 0 à `length`. */
  ticks: number[];
}

/** Longueur « ronde » (1, 2, 5 × 10ⁿ) la plus grande ne dépassant pas `max`. */
export function niceLength(max: number): number {
  if (!(max > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const f of [5, 2, 1]) if (f * p <= max) return f * p;
  return p;
}

/**
 * Barre d'échelle d'au plus `maxMm` de papier. `mmPerPixel` = échelle d'impression de la photo.
 * Null si le plan n'est pas calibré.
 */
export function scaleBar(
  cal: Calibration | null,
  mmPerPixel: number,
  maxMm: number,
  units: 'metric' | 'imperial' = 'metric',
): ScaleBar | null {
  const mpp = metersPerPixel(cal);
  if (!mpp || !(mmPerPixel > 0)) return null;
  const perMm = (mpp / mmPerPixel) * (units === 'imperial' ? FEET_PER_METER : 1); // unités par mm
  const length = niceLength(maxMm * perMm);
  if (!length) return null;
  const mm = length / perMm;
  // Graduations : 5 pour 1 ou 5 × 10ⁿ, 4 pour 2 × 10ⁿ (valeurs rondes à chaque trait).
  const lead = Math.round(length / 10 ** Math.floor(Math.log10(length)));
  const n = lead === 2 ? 4 : 5;
  return {
    length,
    unit: units === 'imperial' ? 'pi' : 'm',
    mm,
    ticks: Array.from({ length: n + 1 }, (_, i) => (length * i) / n),
  };
}

/** Échelle numérique approximative « ≈ 1:1 250 » (arrondie à 2 chiffres significatifs). */
export function scaleRatioText(cal: Calibration | null, mmPerPixel: number): string | null {
  const mpp = metersPerPixel(cal);
  if (!mpp || !(mmPerPixel > 0)) return null;
  const ratio = (mpp * 1000) / mmPerPixel;
  const p = 10 ** Math.max(0, Math.floor(Math.log10(ratio)) - 1);
  const rounded = Math.round(ratio / p) * p;
  return `≈ 1:${new Intl.NumberFormat('fr-CA').format(rounded)}`;
}
