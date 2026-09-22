/**
 * Store du plan ouvert : source de vérité unique du document, avec historique annuler/rétablir.
 *
 * - Chaque modification passe par `update()` : Immer produit les patches et leurs inverses.
 * - Une interaction continue (glisser, redimensionner, pivoter, déplacer un point) est encadrée par
 *   `beginTransaction()` / `commitTransaction()` : toutes ses modifications forment UNE entrée.
 * - `revision` n'augmente qu'à la validation d'une modification (jamais pendant une transaction) ;
 *   la sauvegarde automatique s'appuie dessus et ne s'exécute donc jamais en plein glisser.
 * - Le viewport n'est pas ici : zoom et déplacement n'entrent pas dans l'historique.
 */
import { applyPatches, enablePatches, type Patch, produceWithPatches } from 'immer';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { PlanDocument } from '@/domain/model/types.ts';

enablePatches();

/** Au moins 100 actions annulables sont exigées ; on en garde davantage. */
export const HISTORY_LIMIT = 200;

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  /** Modifications répétées d'un même champ (flèches, curseur, saisie) fusionnées en une entrée. */
  mergeKey?: string;
  time?: number;
}

/** Délai pendant lequel deux modifications de même `mergeKey` forment une seule action. */
export const MERGE_WINDOW_MS = 1000;

export interface UpdateOptions {
  mergeKey?: string;
}

export interface PlanState {
  doc: PlanDocument | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Transaction en cours (interaction continue), non encore inscrite dans l'historique. */
  pending: HistoryEntry | null;
  revision: number;
  savedRevision: number;

  /** Ouvre un document : réinitialise l'historique, état « enregistré ». */
  load(doc: PlanDocument | null): void;
  update(label: string, recipe: (draft: PlanDocument) => unknown, options?: UpdateOptions): void;
  beginTransaction(label: string): void;
  commitTransaction(): void;
  cancelTransaction(): void;
  undo(): void;
  redo(): void;
  markSaved(revision: number): void;
}

export type PlanStore = ReturnType<typeof createPlanStore>;

export function createPlanStore() {
  return createStore<PlanState>()((set, get) => {
    /** Inscrit une entrée validée dans l'historique et incrémente la révision. */
    const pushEntry = (entry: HistoryEntry) => {
      if (entry.patches.length === 0) return;
      const past = [...get().past, entry];
      if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
      set({ past, future: [], revision: get().revision + 1 });
    };

    return {
      doc: null,
      past: [],
      future: [],
      pending: null,
      revision: 0,
      savedRevision: 0,

      load(doc) {
        const revision = get().revision + 1;
        set({ doc, past: [], future: [], pending: null, revision, savedRevision: revision });
      },

      update(label, recipe, options) {
        const { doc, pending } = get();
        if (!doc) return;
        // La valeur retournée par la recette est ignorée : seules les mutations du brouillon comptent.
        const [next, patches, inversePatches] = produceWithPatches(doc, (draft) => {
          recipe(draft);
        });
        if (patches.length === 0) return;
        if (pending) {
          // Les inverses s'appliquent dans l'ordre inverse des modifications.
          set({
            doc: next,
            pending: {
              label: pending.label,
              patches: [...pending.patches, ...patches],
              inversePatches: [...inversePatches, ...pending.inversePatches],
            },
          });
        } else {
          const last = get().past.at(-1);
          const now = Date.now();
          const merge =
            options?.mergeKey !== undefined &&
            last?.mergeKey === options.mergeKey &&
            last.time !== undefined &&
            now - last.time < MERGE_WINDOW_MS &&
            get().future.length === 0;
          if (merge && last) {
            const merged: HistoryEntry = {
              ...last,
              patches: [...last.patches, ...patches],
              inversePatches: [...inversePatches, ...last.inversePatches],
              time: now,
            };
            set({ doc: next, past: [...get().past.slice(0, -1), merged], revision: get().revision + 1 });
          } else {
            set({ doc: next });
            pushEntry({ label, patches, inversePatches, mergeKey: options?.mergeKey, time: now });
          }
        }
      },

      beginTransaction(label) {
        if (get().pending) get().commitTransaction();
        set({ pending: { label, patches: [], inversePatches: [] } });
      },

      commitTransaction() {
        const { pending } = get();
        if (!pending) return;
        set({ pending: null });
        pushEntry(pending);
      },

      cancelTransaction() {
        const { pending, doc } = get();
        if (!pending) return;
        set({ pending: null, doc: doc && applyPatches(doc, pending.inversePatches) });
      },

      undo() {
        get().commitTransaction();
        const { past, future, doc, revision } = get();
        const entry = past.at(-1);
        if (!entry || !doc) return;
        set({
          doc: applyPatches(doc, entry.inversePatches),
          past: past.slice(0, -1),
          future: [...future, entry],
          revision: revision + 1,
        });
      },

      redo() {
        get().commitTransaction();
        const { past, future, doc, revision } = get();
        const entry = future.at(-1);
        if (!entry || !doc) return;
        set({
          doc: applyPatches(doc, entry.patches),
          past: [...past, entry],
          future: future.slice(0, -1),
          revision: revision + 1,
        });
      },

      markSaved(revision) {
        set({ savedRevision: revision });
      },
    };
  });
}

/** Store de l'application (un seul plan ouvert à la fois). */
export const planStore = createPlanStore();

export function usePlanStore<T>(selector: (state: PlanState) => T): T {
  return useStore(planStore, selector);
}

export const selectCanUndo = (s: PlanState) => s.past.length > 0 || s.pending !== null;
export const selectCanRedo = (s: PlanState) => s.future.length > 0;
export const selectIsDirty = (s: PlanState) =>
  s.doc !== null && (s.revision !== s.savedRevision || s.pending !== null);
