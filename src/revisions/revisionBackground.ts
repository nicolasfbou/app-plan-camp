/**
 * Photo d'une révision : celle de l'éditeur si c'est le même fichier (aucun second décodage),
 * sinon relue, VÉRIFIÉE (SHA-256) et décodée pour l'occasion, puis libérée.
 */
import { useEffect, useState } from 'react';
import { repository } from '@/app/repository.ts';
import type { BaseImageRef } from '@/domain/model/types.ts';
import { buildDisplayPyramid, type LoadedBackground, releaseBackground } from '@/editor/backgroundImage.ts';
import { decodeImage } from '@/import/decodeImage.ts';
import { verifyStoredBlob } from '@/import/importBackground.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';

export type PhotoState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ready'; background: LoadedBackground }
  | { kind: 'error'; message: string };

export async function loadBackground(ref: BaseImageRef): Promise<LoadedBackground> {
  const check = await verifyStoredBlob(repository, ref.blobId, ref.sha256);
  if (!check.ok)
    throw new Error(t(check.reason === 'missing' ? 'canvas.integrity.missing' : 'canvas.integrity.mismatch'));
  const bitmap = await decodeImage(check.blob.bytes, ref.mimeType);
  return buildDisplayPyramid(ref.blobId, bitmap);
}

/**
 * Photos décodées pour les révisions, partagées par fichier et comptées : deux vues de la même
 * photo (ex. avant / après d'une comparaison) ne la décodent qu'une fois ; libérée au dernier usage.
 */
const shared = new Map<string, { promise: Promise<LoadedBackground>; users: number }>();

function acquire(ref: BaseImageRef): Promise<LoadedBackground> {
  const entry = shared.get(ref.blobId);
  if (entry) {
    entry.users++;
    return entry.promise;
  }
  const promise = loadBackground(ref);
  shared.set(ref.blobId, { promise, users: 1 });
  promise.catch(() => shared.delete(ref.blobId));
  return promise;
}

function release(blobId: string) {
  const entry = shared.get(blobId);
  if (!entry || --entry.users > 0) return;
  shared.delete(blobId);
  entry.promise.then(releaseBackground, () => undefined);
}

export function useRevisionPhoto(ref: BaseImageRef | null | undefined): PhotoState {
  const editor = useEditorStore((s) => s.background);
  const fromEditor =
    ref && editor.kind === 'ready' && editor.background.blobId === ref.blobId ? editor.background : null;
  const [own, setOwn] = useState<{ blobId: string | null; state: PhotoState }>({
    blobId: null,
    state: { kind: 'none' },
  });
  const blobId = ref?.blobId ?? null;
  const needsOwn = Boolean(ref) && !fromEditor;

  useEffect(() => {
    if (!ref || !needsOwn) return;
    let cancelled = false;
    const id = ref.blobId;
    acquire(ref).then(
      (bg) => !cancelled && setOwn({ blobId: id, state: { kind: 'ready', background: bg } }),
      (e: unknown) =>
        !cancelled &&
        setOwn({ blobId: id, state: { kind: 'error', message: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      cancelled = true;
      release(id);
      // L'état ne garde jamais une photo libérée.
      setOwn({ blobId: null, state: { kind: 'none' } });
    };
    // Ne dépend que du fichier référencé.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blobId, needsOwn]);

  if (!ref) return { kind: 'none' };
  if (fromEditor) return { kind: 'ready', background: fromEditor };
  return own.blobId === blobId ? own.state : { kind: 'loading' };
}
