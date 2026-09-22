/**
 * Vue initiale et préférence d'affichage.
 * - À l'ouverture : dernière vue mémorisée pour ce plan, sinon « adapter à l'écran ».
 * - Ensuite : la vue (centre + zoom) est mémorisée à part, après une courte inactivité.
 * La vue n'est jamais écrite dans le document ni dans la géométrie des objets.
 */
import { useEffect, useRef } from 'react';
import { repository } from '@/app/repository.ts';
import { fitToScreen, fromViewCenter, toViewCenter } from '@/domain/viewport/viewport.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { freshBackgrounds } from './freshBackgrounds.ts';

const SAVE_DELAY_MS = 800;

export function useViewPersistence(planId: string): void {
  const background = useEditorStore((s) => (s.background.kind === 'ready' ? s.background.background : null));
  const stageReady = useViewportStore((s) => s.stageSize.width > 0 && s.stageSize.height > 0);
  const appliedFor = useRef<string | null>(null);

  // Vue initiale : une fois par fond affiché.
  useEffect(() => {
    if (!background || !stageReady || appliedFor.current === background.blobId) return;
    const blobId = background.blobId;
    let cancelled = false;
    const fresh = freshBackgrounds.has(blobId);
    (fresh ? Promise.resolve(undefined) : repository.getViewPrefs(planId))
      .catch(() => undefined)
      .then((prefs) => {
        if (cancelled) return;
        // Marqué appliqué seulement ici : une relance annulée n'empêche pas la vue initiale.
        appliedFor.current = blobId;
        freshBackgrounds.delete(blobId);
        const { stageSize, setViewport } = useViewportStore.getState();
        const inside =
          prefs &&
          prefs.centerX >= 0 &&
          prefs.centerY >= 0 &&
          prefs.centerX <= background.width &&
          prefs.centerY <= background.height;
        setViewport(inside ? fromViewCenter(prefs, stageSize) : fitToScreen(background, stageSize));
      });
    return () => {
      cancelled = true;
    };
  }, [background, stageReady, planId]);

  // Mémorisation de la vue (préférence d'affichage uniquement).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: (() => void) | null = null;
    const unsubscribe = useViewportStore.subscribe((state, previous) => {
      if (state.viewport === previous.viewport || !appliedFor.current) return;
      clearTimeout(timer);
      pending = () => {
        pending = null;
        void repository
          .saveViewPrefs(planId, toViewCenter(state.viewport, state.stageSize))
          .catch(() => undefined);
      };
      timer = setTimeout(() => pending?.(), SAVE_DELAY_MS);
    });
    return () => {
      // En quittant le plan, la dernière vue est enregistrée sans attendre le délai.
      clearTimeout(timer);
      pending?.();
      unsubscribe();
    };
  }, [planId]);
}
