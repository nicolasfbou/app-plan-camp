/**
 * Fond chargé pour l'affichage : l'image décodée d'origine + ses copies réduites d'affichage.
 * Rien ici n'est jamais écrit dans le projet.
 */
import { pyramidFactors } from '@/domain/viewport/pyramid.ts';

export interface DisplayLevel {
  factor: number;
  bitmap: ImageBitmap;
}

export interface LoadedBackground {
  blobId: string;
  width: number;
  height: number;
  /** Niveau 0 = image décodée à pleine résolution. */
  levels: DisplayLevel[];
}

export async function buildDisplayPyramid(blobId: string, bitmap: ImageBitmap): Promise<LoadedBackground> {
  const levels: DisplayLevel[] = [{ factor: 1, bitmap }];
  try {
    for (const factor of pyramidFactors(bitmap.width, bitmap.height).slice(1)) {
      const reduced = await createImageBitmap(bitmap, {
        resizeWidth: Math.max(1, Math.round(bitmap.width * factor)),
        resizeHeight: Math.max(1, Math.round(bitmap.height * factor)),
        resizeQuality: 'high',
      });
      levels.push({ factor, bitmap: reduced });
    }
  } catch (error) {
    // Échec (mémoire insuffisante) : on libère tout plutôt que de laisser fuir les bitmaps.
    levels.forEach((level) => level.bitmap.close());
    throw error;
  }
  return { blobId, width: bitmap.width, height: bitmap.height, levels };
}

export function releaseBackground(background: LoadedBackground | null): void {
  for (const level of background?.levels ?? []) level.bitmap.close();
}
