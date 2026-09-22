/**
 * Sauvegarde automatique du plan ouvert.
 *
 * Stratégie : on observe `revision`, qui n'augmente qu'à la validation d'une modification
 * (fin d'un glisser, d'un redimensionnement…), jamais pendant une interaction continue.
 * Chaque nouvelle révision relance un délai d'inactivité ; à son terme, le document est écrit.
 * Plusieurs modifications rapprochées produisent donc une seule écriture.
 */
import type { PlanDocument } from '@/domain/model/types.ts';
import type { PlanStore } from '@/store/planStore.ts';

export interface AutosaveOptions {
  store: PlanStore;
  save(doc: PlanDocument): Promise<void>;
  delayMs?: number;
  onError?(error: unknown): void;
}

export interface Autosave {
  /** Écrit immédiatement les modifications en attente (ex. avant fermeture). */
  flush(): Promise<void>;
  dispose(): void;
}

export function startAutosave({ store, save, delayMs = 1500, onError }: AutosaveOptions): Autosave {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const persist = (): Promise<void> => {
    timer = undefined;
    inFlight = inFlight.then(async () => {
      const { doc, revision, savedRevision, pending } = store.getState();
      if (!doc || revision === savedRevision || pending) return;
      try {
        await save(doc);
        // Si un autre plan a été ouvert pendant l'écriture, son état ne doit pas être touché.
        if (store.getState().doc?.plan.id === doc.plan.id) store.getState().markSaved(revision);
      } catch (error) {
        onError?.(error);
      }
    });
    return inFlight;
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.revision === previous.revision) return;
    // Ouverture d'un autre plan alors que le précédent avait des modifications non écrites :
    // on écrit immédiatement l'ancien document pour ne rien perdre.
    const replaced = previous.doc && previous.doc.plan.id !== state.doc?.plan.id;
    if (replaced && previous.revision !== previous.savedRevision) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const unsaved = previous.doc!;
      inFlight = inFlight.then(() => save(unsaved)).catch((error: unknown) => onError?.(error));
    }
    // Un nouveau document chargé est déjà à jour : rien à écrire.
    if (state.revision === state.savedRevision) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void persist(), delayMs);
  });

  return {
    flush() {
      if (timer) clearTimeout(timer);
      return persist();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      unsubscribe();
    },
  };
}
