/**
 * Calibration et mesures. La calibration relie une distance connue entre deux points de la photo
 * à des mètres ; les mesures restent APPROXIMATIVES (photo non géoréférencée, perspective,
 * relief) : les résultats sont arrondis selon une incertitude estimée, jamais affichés avec une
 * précision artificielle. Sans calibration, tout reste en pixels de la photo.
 */
import type { Calibration, CorridorObject, PlanObject, Point } from './types.ts';

/** Incertitude relative minimale d'une mesure sur photo (déformations, perspective) : 2 %. */
export const MIN_RELATIVE_UNCERTAINTY = 0.02;
/** Précision de pointage estimée d'un clic, en pixels image (à chaque extrémité). */
const CLICK_PX = 1;

export const FEET_PER_METER = 3.280839895;

export function calibrationPixels(c: Calibration): number {
  return Math.hypot(c.p2.x - c.p1.x, c.p2.y - c.p1.y);
}

/** Mètres par pixel image, ou null si la calibration est inutilisable. */
export function metersPerPixel(c: Calibration | null): number | null {
  if (!c) return null;
  const px = calibrationPixels(c);
  return px > 0 && c.distanceMeters > 0 ? c.distanceMeters / px : null;
}

/** Incertitude relative des longueurs issue de la calibration (pointage des deux extrémités). */
export function calibrationUncertainty(c: Calibration | null): number {
  if (!c) return 1;
  const px = calibrationPixels(c);
  return Math.max(MIN_RELATIVE_UNCERTAINTY, px > 0 ? (2 * CLICK_PX) / px : 1);
}

// --- Géométrie en pixels image -------------------------------------------------------------------

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return total;
}

/** Aire d'un polygone simple (formule du lacet), en pixels². */
export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Périmètre d'une ellipse (approximation de Ramanujan, erreur négligeable ici). */
function ellipsePerimeter(a: number, b: number): number {
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

export interface ObjectMeasure {
  /** Longueur d'un tracé (trajet, ligne, cote, axe d'un corridor), en pixels. */
  length?: number;
  /** Périmètre et surface d'une zone, d'un bâtiment, d'une case, en pixels / pixels². */
  perimeter?: number;
  area?: number;
}

/** Mesures en pixels image d'un objet (la rotation ne change ni longueur ni surface). */
export function measureObject(object: PlanObject): ObjectMeasure {
  const g = object.geometry;
  switch (g.kind) {
    case 'polyline':
      return { length: polylineLength(g.points) };
    case 'polygon':
      return { perimeter: polylineLength([...g.points, g.points[0]!]), area: polygonArea(g.points) };
    case 'rect':
      return { perimeter: 2 * (g.width + g.height), area: g.width * g.height };
    case 'ellipse':
      return { perimeter: ellipsePerimeter(g.rx, g.ry), area: Math.PI * g.rx * g.ry };
    default:
      return {};
  }
}

// --- Largeur physique des corridors ---------------------------------------------------------------

/**
 * Largeur de rendu d'un corridor, en pixels image : la largeur physique convertie si elle est
 * définie ET que le plan est calibré ; sinon la largeur en pixels. Recalculée à chaque changement
 * de calibration ; un corridor défini en pixels n'est jamais modifié.
 */
export function corridorWidthPx(
  corridor: Pick<CorridorObject, 'width' | 'widthMeters'>,
  c: Calibration | null,
): number {
  const mpp = metersPerPixel(c);
  return corridor.widthMeters !== null && mpp ? corridor.widthMeters / mpp : corridor.width;
}

// --- Présentation honnête des résultats --------------------------------------------------------------

const number = (value: number, decimals: number) =>
  new Intl.NumberFormat('fr-CA', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(
    value,
  );

/**
 * Arrondit une valeur à la précision que permet son incertitude relative : le pas d'arrondi est
 * la puissance de 10 immédiatement inférieure à l'incertitude absolue (ex. 123,4 ± 2,5 → 123 ;
 * 1 234 ± 25 → 1 230).
 */
export function roundToUncertainty(value: number, relative: number): { value: number; decimals: number } {
  const absolute = Math.abs(value) * relative;
  if (!Number.isFinite(absolute) || absolute <= 0) return { value, decimals: 0 };
  const step = 10 ** Math.floor(Math.log10(absolute));
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return { value: Math.round(value / step) * step, decimals: Math.min(decimals, 3) };
}

export type Units = 'metric' | 'imperial';

/** Longueur mesurée : « ≈ 123 m » (ou « ≈ 404 pi »), ou « 1 234 px » sans calibration. */
export function formatLength(pixels: number, c: Calibration | null, units: Units = 'metric'): string {
  const mpp = metersPerPixel(c);
  if (!mpp) return `${number(Math.round(pixels), 0)} px`;
  const meters = pixels * mpp;
  const value = units === 'imperial' ? meters * FEET_PER_METER : meters;
  const r = roundToUncertainty(value, calibrationUncertainty(c));
  return `≈ ${number(r.value, r.decimals)} ${units === 'imperial' ? 'pi' : 'm'}`;
}

/** Surface mesurée : incertitude relative doublée (produit de deux longueurs). */
export function formatArea(pixels2: number, c: Calibration | null, units: Units = 'metric'): string {
  const mpp = metersPerPixel(c);
  if (!mpp) return `${number(Math.round(pixels2), 0)} px²`;
  const m2 = pixels2 * mpp * mpp;
  const value = units === 'imperial' ? m2 * FEET_PER_METER ** 2 : m2;
  const r = roundToUncertainty(value, 2 * calibrationUncertainty(c));
  return `≈ ${number(r.value, r.decimals)} ${units === 'imperial' ? 'pi²' : 'm²'}`;
}

/** Point milieu (en abscisse curviligne) d'un tracé, et direction du segment porteur (degrés). */
export function midpointAlong(points: readonly Point[]): { point: Point; angle: number } {
  const total = polylineLength(points);
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + len >= total / 2 && len > 0) {
      const t = (total / 2 - walked) / len;
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      };
    }
    walked += len;
  }
  return { point: points[0] ?? { x: 0, y: 0 }, angle: 0 };
}
