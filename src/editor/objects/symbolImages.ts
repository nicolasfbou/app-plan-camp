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

type Entry = { image: HTMLImageElement; ready: boolean; failed: boolean };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
  // Les formes dessinées à la main (flèches, pictogrammes des corridors et des zones) se redessinent.
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

/**
 * Image prête d'un pictogramme, ou null (chargement en cours, pictogramme inconnu). Le chargement
 * est lancé au premier appel ; les abonnés sont prévenus quand l'image est prête.
 */
export function symbolImage(
  symbolId: string,
  text: string | null | undefined,
  assets: Readonly<Record<string, SymbolAsset>>,
): HTMLImageElement | null {
  const asset = isAssetSymbol(symbolId) ? assets[assetIdOf(symbolId)] : undefined;
  const key = asset ? `${symbolId}:${asset.sha256}` : `${symbolId}:${text ?? ''}`;
  const entry =
    cache.get(key) ??
    load(
      key,
      asset
        ? assetUrl(asset)
        : Promise.resolve(isAssetSymbol(symbolId) ? null : symbolDataUrl(symbolId, text)),
    );
  return entry.ready ? entry.image : null;
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
