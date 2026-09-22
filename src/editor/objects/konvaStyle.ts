/** Conversion du style du modèle vers les attributs Konva (en pixels image). */
import Konva from 'konva';
import type { PlanObject, Style } from '@/domain/model/types.ts';

export function rgba(hex: string | null, alpha: number): string | undefined {
  if (!hex) return undefined;
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function dashArray(style: Style): number[] | undefined {
  const w = Math.max(style.strokeWidth, 1);
  if (style.dash === 'dashed') return [w * 4, w * 3];
  if (style.dash === 'dotted') return [0.01, w * 2];
  return undefined;
}

/**
 * Zone de clic des traits : au moins `HIT_SCREEN_PX` pixels écran, quel que soit le zoom.
 * Arrondie par puissance de 2 du zoom pour ne pas redessiner tous les objets à chaque cran.
 */
export const HIT_SCREEN_PX = 12;
export function hitStrokeWidth(strokeWidth: number, scale: number): number {
  const bucket = 2 ** Math.round(Math.log2(Math.max(scale, 1e-6)));
  return Math.max(strokeWidth, HIT_SCREEN_PX / bucket);
}

/** Remplissage d'une surface : toujours défini (même transparent) pour garder une zone de clic. */
export function areaFill(style: Style): string {
  return rgba(style.fill ?? '#000000', style.fill ? style.fillOpacity : 0)!;
}

// --- Mesure du texte (même moteur que le rendu Konva) --------------------------------------------

let measurer: Konva.Text | null = null;

export interface TextBox {
  textWidth: number;
  textHeight: number;
  width: number;
  height: number;
}

export function measureText(object: Extract<PlanObject, { type: 'text' }>): TextBox {
  measurer ??= new Konva.Text();
  measurer.setAttrs({
    text: object.text || ' ',
    fontFamily: object.fontFamily,
    fontSize: object.fontSize,
    fontStyle: textFontStyle(object),
    align: object.align,
    lineHeight: 1.2,
    padding: 0,
  });
  const textWidth = measurer.width();
  const textHeight = measurer.height();
  const pad = object.label ? object.label.padding : 0;
  return { textWidth, textHeight, width: textWidth + pad * 2, height: textHeight + pad * 2 };
}

export function textFontStyle(object: Extract<PlanObject, { type: 'text' }>): string {
  return (
    [object.italic ? 'italic' : '', object.fontWeight === 'bold' ? 'bold' : ''].filter(Boolean).join(' ') ||
    'normal'
  );
}
