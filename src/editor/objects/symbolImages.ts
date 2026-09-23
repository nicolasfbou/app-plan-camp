/**
 * Images des pictogrammes (bibliothèque SVG et pictogrammes importés), chargées une fois puis
 * partagées par tous les objets. Un SVG importé est affiché via une balise image : le navigateur
 * n'y exécute aucun script et ne charge aucune ressource externe.
 */
import Konva from 'konva';
import { useSyncExternalStore } from 'react';
import { assetIdOf, isAssetSymbol, symbolDataUrl } from '@/domain/symbols/catalog.ts';
import type { SymbolAsset } from '@/domain/model/types.ts';
import { repository } from '@/app/repository.ts';

type Entry = { image: HTMLImageElement; ready: boolean; failed: boolean; bitmap?: HTMLCanvasElement };

/**
 * Côté du bitmap des repères répétés : un SVG redessiné à chaque image coûte cher (le navigateur
 * le rastérise à chaque fois) ; on le rastérise une fois à cette taille, suffisante pour la taille
 * d'affichage maximale des repères, écrans haute densité compris.
 */
const BITMAP_PX = 192;

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
  // Les formes dessinées à la main (pictogrammes des corridors et des zones) se redessinent.
  for (const stage of Konva.stages) stage.batchDraw();
}

function load(key: string, source: Promise<string | null>): Entry {
  const image = new Image();
  const entry: Entry = { image, ready: false, failed: false };
  cache.set(key, entry);
  image.onload = () => {
    entry.ready = true;
    changed();
  };
  image.onerror = () => {
    entry.failed = true;
    changed();
  };
  void source.then((url) => {
    if (url) image.src = url;
    else {
      entry.failed = true;
      changed();
    }
  });
  return entry;
}

async function assetUrl(asset: SymbolAsset): Promise<string | null> {
  const blob = await repository.getBlob(asset.blobId).catch(() => undefined);
  return blob ? URL.createObjectURL(new Blob([blob.bytes], { type: asset.mimeType })) : null;
}

/** Entrée du cache (chargement lancé au premier appel). */
function entryOf(
  symbolId: string,
  text: string | null | undefined,
  assets: Readonly<Record<string, SymbolAsset>>,
): Entry {
  const asset = isAssetSymbol(symbolId) ? assets[assetIdOf(symbolId)] : undefined;
  const key = asset ? `${symbolId}:${asset.sha256}` : `${symbolId}:${text ?? ''}`;
  return (
    cache.get(key) ??
    load(
      key,
      asset
        ? assetUrl(asset)
        : Promise.resolve(isAssetSymbol(symbolId) ? null : symbolDataUrl(symbolId, text)),
    )
  );
}

/**
 * Image prête d'un pictogramme (vectorielle, nette à toute taille), ou null (chargement en cours,
 * pictogramme inconnu). Les abonnés sont prévenus quand l'image est prête.
 */
export function symbolImage(
  symbolId: string,
  text: string | null | undefined,
  assets: Readonly<Record<string, SymbolAsset>>,
): HTMLImageElement | null {
  const entry = entryOf(symbolId, text, assets);
  return entry.ready ? entry.image : null;
}

/**
 * Version bitmap (rastérisée une fois) d'un pictogramme, pour les repères dessinés en grand nombre
 * à taille bornée (pictogrammes des corridors et des zones). Null tant que l'image n'est pas prête.
 */
export function symbolBitmap(
  symbolId: string,
  text: string | null | undefined,
  assets: Readonly<Record<string, SymbolAsset>>,
): CanvasImageSource | null {
  const entry = entryOf(symbolId, text, assets);
  if (!entry.ready) return null;
  if (!entry.bitmap && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = BITMAP_PX;
    canvas.height = BITMAP_PX;
    // Proportions d'origine conservées (pictogramme importé non carré : centré, jamais étiré).
    const w = entry.image.naturalWidth || 1;
    const h = entry.image.naturalHeight || 1;
    const dw = BITMAP_PX * Math.min(1, w / h);
    const dh = BITMAP_PX * Math.min(1, h / w);
    canvas.getContext('2d')?.drawImage(entry.image, (BITMAP_PX - dw) / 2, (BITMAP_PX - dh) / 2, dw, dh);
    entry.bitmap = canvas;
  }
  return entry.bitmap ?? entry.image;
}

/** URL affichable d'un pictogramme de la bibliothèque (vignettes de l'interface). */
export { symbolDataUrl };

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-rendu quand une image de pictogramme vient d'être chargée. */
export function useSymbolImagesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
