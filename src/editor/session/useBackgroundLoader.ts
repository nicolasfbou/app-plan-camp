/**
 * Charge le fond référencé par le plan : lecture des octets stockés, VÉRIFICATION de l'empreinte
 * SHA-256, décodage (orientation appliquée), puis pyramide d'affichage.
 */
import { useEffect } from 'react';
import { repository } from '@/app/repository.ts';
import { t } from '@/i18n/index.ts';
import { decodeImage } from '@/import/decodeImage.ts';
import { verifyStoredBlob } from '@/import/importBackground.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { usePlanStore } from '@/store/planStore.ts';
import { buildDisplayPyramid } from '../backgroundImage.ts';

export function useBackgroundLoader(): void {
  const ref = usePlanStore((s) => s.doc?.plan.baseImage ?? null);
  const blobId = ref?.blobId ?? null;

  useEffect(() => {
    const { background, setBackground } = useEditorStore.getState();
    if (!ref) {
      setBackground({ kind: 'none' });
      return;
    }
    // Déjà en mémoire (ex. juste après l'import) : rien à relire.
    if (background.kind === 'ready' && background.background.blobId === ref.blobId) return;

    let cancelled = false;
    setBackground({ kind: 'loading' });
    (async () => {
      const check = await verifyStoredBlob(repository, ref.blobId, ref.sha256);
      if (!check.ok) {
        throw new Error(
          t(check.reason === 'missing' ? 'canvas.integrity.missing' : 'canvas.integrity.mismatch'),
        );
      }
      const bitmap = await decodeImage(check.blob.bytes, ref.mimeType);
      if (bitmap.width !== ref.width || bitmap.height !== ref.height) {
        bitmap.close();
        throw new Error(
          `Dimensions inattendues : ${bitmap.width} × ${bitmap.height} px au lieu de ${ref.width} × ${ref.height} px.`,
        );
      }
      return buildDisplayPyramid(ref.blobId, bitmap);
    })().then(
      (loaded) => {
        if (cancelled) {
          loaded.levels.forEach((l) => l.bitmap.close());
          return;
        }
        setBackground({ kind: 'ready', background: loaded });
      },
      (error: unknown) => {
        if (!cancelled)
          setBackground({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
    // Le fond ne dépend que du fichier référencé.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blobId]);

  useEffect(() => () => useEditorStore.getState().reset(), []);
}
