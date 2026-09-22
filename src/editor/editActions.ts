/**
 * Commandes d'édition, partagées par le clavier, les boutons et le canevas. Chaque commande
 * correspond à UNE entrée d'historique (ou fusionne avec la précédente via `mergeKey`).
 */
import { isLayerUsable } from '@/domain/model/objectFactory.ts';
import {
  copyTargetLayer,
  insertCopy,
  isEditable,
  moveObject,
  removeObject,
  reorderObject,
  replaceObject,
  type ZOrderMove,
} from '@/domain/model/operations.ts';
import { geometryCenter, moveVertex, normalizeTransform, type NodeTransform } from '@/domain/model/shapes.ts';
import type { PlanObject, Point } from '@/domain/model/types.ts';
import { planStore } from '@/store/planStore.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { t } from '@/i18n/index.ts';

const doc = () => planStore.getState().doc;

/** Vrai quand le geste en cours a été annulé (ex. 2e doigt posé) : sa fin ne doit rien écrire. */
let gestureCancelled = false;

function notifyUnusableLayer(name?: string): void {
  useEditorStore.getState().notify(t('notice.layerUnusable', { name: name ?? '' }));
}
const selected = (): PlanObject | null => {
  const id = useEditorStore.getState().selectedId;
  return (id && doc()?.objects[id]) || null;
};

/** Décalage d'une copie : ~16 pixels écran, exprimé en pixels image (visible à tout zoom). */
function copyOffset(): number {
  return Math.max(1, Math.round(16 / useViewportStore.getState().viewport.scale));
}

export const editActions = {
  /**
   * Ajoute un objet créé par un outil, le sélectionne et revient à l'outil Sélection.
   * Refusé (avec un message) si son calque est masqué ou verrouillé. Retourne vrai si créé.
   */
  create(object: PlanObject, label: string): boolean {
    const layer = doc()?.layers.find((l) => l.id === object.layerId);
    if (!layer || !isLayerUsable(layer)) {
      notifyUnusableLayer(layer?.name);
      return false;
    }
    planStore.getState().update(label, (d) => {
      d.objects[object.id] = object;
      d.plan.updatedAt = object.updatedAt;
    });
    const editor = useEditorStore.getState();
    editor.setTool('select');
    editor.select(object.id);
    return true;
  },

  /** Remplace l'objet sélectionné par sa version modifiée (panneau de propriétés). */
  replace(next: PlanObject, label: string, mergeKey?: string) {
    planStore.getState().update(label, (d) => replaceObject(d, next), mergeKey ? { mergeKey } : undefined);
  },

  deleteSelected(): boolean {
    const object = selected();
    const d = doc();
    if (!object || !d || !isEditable(d, object)) return false;
    planStore.getState().update('Supprimer', (draft) => removeObject(draft, object.id));
    useEditorStore.getState().select(null);
    return true;
  },

  duplicateSelected() {
    const object = selected();
    if (!object) return;
    const d0 = doc();
    if (!d0 || !copyTargetLayer(d0, object))
      return notifyUnusableLayer(d0?.layers.find((l) => l.id === object.layerId)?.name);
    let copyId = '';
    const offset = copyOffset();
    planStore.getState().update('Dupliquer', (d) => {
      copyId = insertCopy(d, object, offset, offset)?.id ?? '';
    });
    if (copyId) useEditorStore.getState().select(copyId);
  },

  copySelected() {
    const object = selected();
    if (object) useEditorStore.getState().setClipboard(structuredClone(object));
  },

  paste() {
    const editor = useEditorStore.getState();
    const source = editor.clipboard;
    const d0 = doc();
    if (!source || !d0) return;
    if (!copyTargetLayer(d0, source)) return notifyUnusableLayer();
    const offset = copyOffset() * editor.nextPaste();
    let copyId = '';
    planStore.getState().update('Coller', (d) => {
      copyId = insertCopy(d, source, offset, offset)?.id ?? '';
    });
    if (copyId) editor.select(copyId);
  },

  /** Déplacement clavier en pixels image (même pas quel que soit le zoom). */
  nudge(dx: number, dy: number) {
    const object = selected();
    if (!object) return;
    planStore
      .getState()
      .update('Déplacer', (d) => moveObject(d, object.id, dx, dy), { mergeKey: `nudge:${object.id}` });
  },

  reorder(move: ZOrderMove) {
    const object = selected();
    if (object) planStore.getState().update('Ordre', (d) => reorderObject(d, object.id, move));
  },

  /** Fin d'un glisser ou d'un geste du Transformer : une seule action, échelle intégrée. */
  commitNodeTransform(id: string, transform: NodeTransform, label: string) {
    const object = doc()?.objects[id];
    if (!object) return;
    const center = geometryCenter(object.geometry);
    const unchanged =
      Math.abs(transform.x - center.x) < 1e-9 &&
      Math.abs(transform.y - center.y) < 1e-9 &&
      transform.rotation === object.rotation &&
      transform.scaleX === 1 &&
      transform.scaleY === 1;
    if (unchanged) return; // simple clic : aucune action
    planStore.getState().update(label, (d) => replaceObject(d, normalizeTransform(object, transform)));
  },

  /**
   * Annule le geste en cours (glisser d'objet, transformation, glisser de sommet, forme en cours
   * de dessin) sans rien enregistrer. Utilisé quand un 2e doigt transforme le geste en pincement.
   */
  cancelActiveGesture(
    stage: {
      find(
        selector: string,
      ): { isDragging?(): boolean; stopDrag?(): void; isTransforming?(): boolean; stopTransform?(): void }[];
    } | null,
  ) {
    gestureCancelled = true;
    useEditorStore.getState().setDraft(null);
    planStore.getState().cancelTransaction();
    for (const node of stage?.find('.plan-object, .vertex-handle') ?? [])
      if (node.isDragging?.()) node.stopDrag?.();
    for (const tr of stage?.find('Transformer') ?? []) if (tr.isTransforming?.()) tr.stopTransform?.();
    gestureCancelled = false;
  },
  /** Pendant `cancelActiveGesture`, la fin de geste déclenchée par Konva doit être ignorée. */
  isGestureCancelled: () => gestureCancelled,

  beginVertexDrag() {
    planStore.getState().beginTransaction('Modifier un sommet');
  },
  moveVertex(id: string, index: number, to: Point) {
    const object = doc()?.objects[id];
    // Hors d'un geste ouvert par beginVertexDrag : ignoré (jamais une action par mouvement).
    if (!object || !planStore.getState().pending) return;
    planStore.getState().update('Modifier un sommet', (d) => replaceObject(d, moveVertex(object, index, to)));
  },
  endVertexDrag() {
    if (gestureCancelled) return;
    planStore.getState().commitTransaction();
  },
};
