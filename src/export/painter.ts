/**
 * Surface de dessin de l'export, indépendante du viewport de l'éditeur. Toutes les coordonnées sont
 * en MILLIMÈTRES de page (origine en haut à gauche, y vers le bas), les tailles de texte en points.
 * Deux implémentations : canevas (aperçu, PNG, JPG) et PDF (vectoriel). Le même code de mise en
 * page les pilote : l'aperçu montre exactement ce que contiendra le PDF.
 */
import { roundedRectPoints } from '@/domain/model/shapes.ts';
import type { Point } from '@/domain/model/types.ts';

export interface FillSpec {
  color: string;
  opacity: number;
  evenOdd?: boolean;
}

export interface StrokeSpec {
  color: string;
  opacity: number;
  /** Épaisseur, en mm. */
  width: number;
  /** Tirets, en mm (null = trait plein). */
  dash?: number[] | null;
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

export type TextBaseline = 'top' | 'middle' | 'alphabetic' | 'bottom';

export interface TextSpec {
  /** Taille, en points. */
  size: number;
  bold?: boolean;
  color: string;
  opacity?: number;
  align?: 'left' | 'center' | 'right';
  baseline?: TextBaseline;
  /** Rotation en degrés, sens horaire (comme la rotation des objets). */
  angle?: number;
  /** Liseré autour des lettres (lisibilité sur la photo), épaisseur en mm. */
  halo?: { color: string; opacity?: number; width: number };
}

/** Image : bitmap dessinable, et octets JPEG d'origine si on peut les intégrer tels quels au PDF. */
export interface PainterImage {
  /** Identifiant stable : une même image n'est intégrée qu'une fois dans le PDF. */
  key: string;
  drawable: CanvasImageSource;
  width: number;
  height: number;
  /** Octets JPEG à intégrer tels quels (sinon le bitmap est intégré en PNG, sans perte). */
  jpeg?: Uint8Array;
}

export interface Painter {
  readonly kind: 'canvas' | 'pdf';
  path(
    subpaths: readonly (readonly Point[])[],
    closed: boolean,
    fill: FillSpec | null,
    stroke: StrokeSpec | null,
  ): void;
  text(text: string, x: number, y: number, spec: TextSpec): void;
  /** Largeur du texte, en mm. */
  textWidth(text: string, size: number, bold?: boolean): number;
  image(image: PainterImage, x: number, y: number, width: number, height: number, opacity?: number): void;
  /** Dessine `draw` limité à l'intérieur des contours donnés. */
  clip(subpaths: readonly (readonly Point[])[], draw: () => void): void;
  /** Opacité multipliée à tout ce qui est dessiné dans `draw` (opacité d'un calque). */
  withOpacity(opacity: number, draw: () => void): void;
  /**
   * Objet du plan en cours de dessin (null = mise en page) : permet à une surface d'analyse de
   * rattacher chaque texte et chaque image à son objet. Ignoré par les surfaces de rendu.
   */
  owner?(objectId: string | null): void;
}

export const MM_PER_PT = 25.4 / 72;

/**
 * Décalage vertical (en fraction de la taille) entre la ligne de base alphabétique et la position
 * demandée. Les deux surfaces dessinent sur la ligne de base : l'alignement est identique.
 */
export const BASELINE_SHIFT: Record<TextBaseline, number> = {
  top: 0.74,
  middle: 0.36,
  alphabetic: 0,
  bottom: -0.21,
};

/** Point d'ancrage du texte ramené sur la ligne de base, début de ligne (rotation comprise). */
export function textOrigin(
  width: number,
  x: number,
  y: number,
  spec: Pick<TextSpec, 'size' | 'align' | 'baseline' | 'angle'>,
): Point {
  const dx = spec.align === 'center' ? -width / 2 : spec.align === 'right' ? -width : 0;
  const dy = BASELINE_SHIFT[spec.baseline ?? 'alphabetic'] * spec.size * MM_PER_PT;
  const r = ((spec.angle ?? 0) * Math.PI) / 180;
  return { x: x + dx * Math.cos(r) - dy * Math.sin(r), y: y + dx * Math.sin(r) + dy * Math.cos(r) };
}

/** Rectangle (mm) → contour. */
export function rectPath(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Rectangle à coins arrondis, en polygone (même contour que le générateur de cases). */
export const roundedRectPath = roundedRectPoints;

/**
 * Découpe un texte en lignes d'au plus `maxWidth` mm, par mots entiers ; un mot plus long que la
 * ligne est coupé entre deux lettres. Le texte reste donc toujours ENTIER (jamais tronqué).
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    // Espaces ordinaires seulement : l'espace fine insécable d'un nombre (« 1:2 900 ») ne coupe jamais.
    for (let word of paragraph.split(/[ \t]+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      while (measure(word) > maxWidth && word.length > 1) {
        let n = word.length - 1;
        while (n > 1 && measure(word.slice(0, n)) > maxWidth) n--;
        lines.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    }
    lines.push(line);
  }
  return lines;
}

/** Niveau de gris d'une couleur (luminance perçue), pour l'impression noir et blanc. */
export function grayOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const y = Math.round(0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255));
  const h = y.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/** Surface qui convertit toutes les couleurs en niveaux de gris (style « Noir et blanc »). */
export function grayscalePainter(p: Painter): Painter {
  return {
    kind: p.kind,
    path: (subpaths, closed, fill, stroke) =>
      p.path(
        subpaths,
        closed,
        fill && { ...fill, color: grayOf(fill.color) },
        stroke && { ...stroke, color: grayOf(stroke.color) },
      ),
    text: (text, x, y, spec) =>
      p.text(text, x, y, {
        ...spec,
        color: grayOf(spec.color),
        halo: spec.halo && { ...spec.halo, color: grayOf(spec.halo.color) },
      }),
    textWidth: (text, size, bold) => p.textWidth(text, size, bold),
    image: (image, x, y, w, h, opacity) => p.image(image, x, y, w, h, opacity),
    clip: (subpaths, draw) => p.clip(subpaths, draw),
    withOpacity: (opacity, draw) => p.withOpacity(opacity, draw),
    owner: (id) => p.owner?.(id),
  };
}

/**
 * Réglage d'une COPIE de pixels (jamais de l'original) : contraste autour du gris moyen, puis
 * niveaux de gris. Calcul direct sur les pixels (même résultat dans tous les navigateurs).
 */
export function adjustPixels(data: Uint8ClampedArray, contrast: number, grayscale: boolean): void {
  if (contrast === 1 && !grayscale) return;
  for (let i = 0; i < data.length; i += 4) {
    let r = (data[i]! - 128) * contrast + 128;
    let g = (data[i + 1]! - 128) * contrast + 128;
    let b = (data[i + 2]! - 128) * contrast + 128;
    if (grayscale) r = g = b = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}
