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

export function useRevisionPhoto(ref: BaseImageRef | null | undefined): PhotoState {
  const editor = useEditorStore((s) => s.background);
  const shared =
    ref && editor.kind === 'ready' && editor.background.blobId === ref.blobId ? editor.background : null;
  const [own, setOwn] = useState<{ blobId: string | null; state: PhotoState }>({
    blobId: null,
    state: { kind: 'none' },
  });
  const blobId = ref?.blobId ?? null;
  const needsOwn = Boolean(ref) && !shared;

  useEffect(() => {
    if (!ref || !needsOwn) return;
    let cancelled = false;
    let loaded: LoadedBackground | null = null;
    const id = ref.blobId;
    loadBackground(ref).then(
      (bg) => {
        loaded = bg;
        if (cancelled) releaseBackground(bg);
        else setOwn({ blobId: id, state: { kind: 'ready', background: bg } });
      },
      (e: unknown) =>
        !cancelled &&
        setOwn({ blobId: id, state: { kind: 'error', message: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      cancelled = true;
      releaseBackground(loaded);
    };
    // Ne dépend que du fichier référencé.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blobId, needsOwn]);

  if (!ref) return { kind: 'none' };
  if (shared) return { kind: 'ready', background: shared };
  return own.blobId === blobId ? own.state : { kind: 'loading' };
}
