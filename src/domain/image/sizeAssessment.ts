/**
 * Classement d'une image selon le risque pour le navigateur, AVANT de la décoder.
 *
 * - normal : ≤ 50 MP et côtés ≤ 16 384 px → ouverture directe.
 * - large : jusqu'à 120 MP ou côté > 16 384 px (limite de texture de nombreux GPU) → avertissement, ouverture permise.
 * - dangerous : > 120 MP ou côté > 32 767 px (limite dure des canevas Chromium) → confirmation explicite.
 *
 * L'image n'est jamais compressée ni réduite automatiquement.
 */

export const NORMAL_MAX_MEGAPIXELS = 50;
export const LARGE_MAX_MEGAPIXELS = 120;
export const GPU_TEXTURE_SIDE = 16_384;
export const CANVAS_MAX_SIDE = 32_767;

export type SizeLevel = 'normal' | 'large' | 'dangerous';
export type SizeReason = 'megapixels' | 'side' | 'megapixels-critical' | 'side-critical';

export interface SizeAssessment {
  level: SizeLevel;
  megapixels: number;
  /** Mémoire nécessaire pour l'image décodée (4 octets par pixel). */
  decodedBytes: number;
  reasons: SizeReason[];
}

export function assessImageSize(width: number, height: number): SizeAssessment {
  const megapixels = (width * height) / 1_000_000;
  const side = Math.max(width, height);
  const reasons: SizeReason[] = [];
  let level: SizeLevel = 'normal';

  if (megapixels > LARGE_MAX_MEGAPIXELS) reasons.push('megapixels-critical');
  else if (megapixels > NORMAL_MAX_MEGAPIXELS) reasons.push('megapixels');
  if (side > CANVAS_MAX_SIDE) reasons.push('side-critical');
  else if (side > GPU_TEXTURE_SIDE) reasons.push('side');

  if (reasons.some((r) => r.endsWith('-critical'))) level = 'dangerous';
  else if (reasons.length > 0) level = 'large';

  return { level, megapixels, decodedBytes: width * height * 4, reasons };
}

/** Taille lisible en français : « 7,5 Mo ». */
export function formatBytes(bytes: number): string {
  const units = ['octets', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toLocaleString('fr-CA', { maximumFractionDigits: digits })} ${units[unit]}`;
}

export function formatMegapixels(mp: number): string {
  return `${mp.toLocaleString('fr-CA', { maximumFractionDigits: 1 })} MP`;
}
