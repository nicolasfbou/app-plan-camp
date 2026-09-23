/**
 * Commandes d'édition, partagées par le clavier, les boutons et le canevas. Elles agissent sur la
 * SÉLECTION (un ou plusieurs objets). Chaque commande correspond à UNE entrée d'historique (ou
 * fusionne avec la précédente via `mergeKey`). Verrous d'objets et de calques toujours respectés.
 */
import { isLayerUsable } from '@/domain/model/objectFactory.ts';
import {
  groupObjects,
  insertCopies,
  moveObjects,
  removeObjects,
  selectableIds,
  setObjectsLayer,
  setObjectsLocked,
  setObjectsStyle,
  ungroupObjects,
} from '@/domain/model/multi.ts';
import { isEditable, reorderObject, replaceObject, type ZOrderMove } from '@/domain/model/operations.ts';
import {
  closePolyline,
  geometryCenter,
  insertVertex,
  moveVertex,
  normalizeTransform,
  rectToPolygon,
  removeVertex,
  type NodeTransform,
} from '@/domain/model/shapes.ts';
import type { PlanObject, Point, Style } from '@/domain/model/types.ts';
import { type MessageKey, t } from '@/i18n/index.ts';
import { isShownInEditor } from './viewVisibility.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';

const doc = () => planStore.getState().doc;
const selectedIds = () => useEditorStore.getState().selectedIds;
const selectedObjects = (): PlanObject[] => {
  const d = doc();
  return d
    ? selectedIds()
        .map((id) => d.objects[id])
        .filter((o): o is PlanObject => Boolean(o))
    : [];
};
const single = (): PlanObject | null => {
  const objects = selectedObjects();
  return objects.length === 1 ? objects[0]! : null;
};

function notify(key: MessageKey, vars?: Record<string, string | number>): void {
  useEditorStore.getState().notify(t(key, vars));
}

/** Décalage d'une copie : ~16 pixels écran, exprimé en pixels image (visible à tout zoom). */
function copyOffset(): number {
  return Math.max(1, Math.round(16 / useViewportStore.getState().viewport.scale));
}

// --- Gestes regroupés (plusieurs nœuds Konva, une seule action) ------------------------------

/** Vrai quand le geste en cours a été annulé (ex. 2e doigt posé) : sa fin ne doit rien écrire. */
let gestureCancelled = false;
let commitScheduled = false;

/** Valide le geste après que TOUS les nœuds ont signalé leur fin (même tâche JavaScript). */
function endGestureSoon(): void {
  if (commitScheduled) return;
  commitScheduled = true;
  queueMicrotask(() => {
    commitScheduled = false;
    planStore.getState().commitTransaction();
  });
}

export const editActions = {
  /**
   * Ajoute un objet créé par un outil, le sélectionne et revient à l'outil Sélection. Il va dans
   * le calque actif s'il est utilisable, sinon dans le calque prévu par son modèle. Refusé (avec un
   * message) si ce calque est masqué ou verrouillé. Retourne vrai si l'objet a été créé.
   */
  create(object: PlanObject, label: string): boolean {
    const d = doc();
    if (!d) return false;
    const editor = useEditorStore.getState();
    const active = d.layers.find((l) => l.id === editor.activeLayerId);
    const layer = active && isLayerUsable(active) ? active : d.layers.find((l) => l.id === object.layerId);
    if (!layer || !isLayerUsable(layer)) {
      notify('notice.layerUnusable', { name: layer?.name ?? '' });
      return false;
    }
    let zIndex = -1;
    for (const o of Object.values(d.objects)) if (o.layerId === layer.id) zIndex = Math.max(zIndex, o.zIndex);
    const placed = { ...object, layerId: layer.id, zIndex: zIndex + 1 } as PlanObject;
    planStore.getState().update(label, (draft) => {
      draft.objects[placed.id] = placed;
      draft.plan.updatedAt = placed.updatedAt;
    });
    editor.setTool('select');
    const view = editor.activeViewId ? d.plan.views.find((v) => v.id === editor.activeViewId) : undefined;
    if (view?.print.excludedLayerIds.includes(layer.id)) {
      // Créé sur un calque que la vue affichée masque : l'utilisateur est prévenu (jamais d'objet « perdu »).
      notify('notice.hiddenByView', { layer: layer.name, view: view.name });
      return true;
    }
    editor.select(placed.id);
    return true;
  },

  /** Remplace un objet par sa version modifiée (panneau de propriétés). */
  replace(next: PlanObject, label: string, mergeKey?: string) {
    planStore.getState().update(label, (d) => replaceObject(d, next), mergeKey ? { mergeKey } : undefined);
  },

  selectAll() {
    const d = doc();
    if (d)
      useEditorStore.getState().select(selectableIds(d).filter((id) => isShownInEditor(d, d.objects[id]!)));
  },

  deleteSelected(): boolean {
    const ids = selectedIds();
    const d = doc();
    if (!ids.length || !d) return false;
    const deletable = ids.filter((id) => d.objects[id] && isEditable(d, d.objects[id]!));
    if (deletable.length === 0) {
      notify('notice.lockedSkipped', { count: ids.length });
      return false;
    }
    planStore.getState().update('Supprimer', (draft) => removeObjects(draft, deletable));
    useEditorStore.getState().select(ids.filter((id) => !deletable.includes(id)));
    if (deletable.length < ids.length)
      notify('notice.lockedSkipped', { count: ids.length - deletable.length });
    return true;
  },

  duplicateSelected() {
    const sources = selectedObjects();
    if (!sources.length) return;
    let created: string[] = [];
    const offset = copyOffset();
    planStore.getState().update('Dupliquer', (d) => {
      created = insertCopies(d, sources, offset, offset);
    });
    if (created.length) useEditorStore.getState().select(created);
    if (created.length < sources.length) notify('notice.copySkipped');
  },

  copySelected() {
    const objects = selectedObjects();
    if (objects.length) useEditorStore.getState().setClipboard(structuredClone(objects));
  },

  paste() {
    const editor = useEditorStore.getState();
    const sources = editor.clipboard;
    if (!sources.length || !doc()) return;
    const offset = copyOffset() * editor.nextPaste();
    let created: string[] = [];
    planStore.getState().update('Coller', (d) => {
      created = insertCopies(d, sources, offset, offset);
    });
    if (created.length) editor.select(created);
    if (created.length < sources.length) notify('notice.copySkipped');
  },

  /** Déplacement clavier en pixels image (même pas quel que soit le zoom). */
  nudge(dx: number, dy: number) {
    const ids = selectedIds();
    if (!ids.length) return;
    planStore
      .getState()
      .update('Déplacer', (d) => moveObjects(d, ids, dx, dy), { mergeKey: `nudge:${ids.join(',')}` });
  },

  reorder(move: ZOrderMove) {
    const object = single();
    if (object) planStore.getState().update('Ordre', (d) => reorderObject(d, object.id, move));
  },

  setStyle(patch: Partial<Style>, field?: string) {
    const ids = selectedIds();
    if (!ids.length) return;
    planStore
      .getState()
      .update(
        'Modifier le style',
        (d) => setObjectsStyle(d, ids, patch),
        field ? { mergeKey: `${field}:${ids.join(',')}` } : undefined,
      );
  },

  setLayer(layerId: string) {
    const ids = selectedIds();
    const layer = doc()?.layers.find((l) => l.id === layerId);
    if (!ids.length || !layer) return;
    if (!isLayerUsable(layer)) return notify('notice.layerUnusable', { name: layer.name });
    planStore.getState().update('Changer de calque', (d) => setObjectsLayer(d, ids, layerId));
  },

  setLocked(locked: boolean) {
    const ids = selectedIds();
    if (ids.length)
      planStore
        .getState()
        .update(locked ? 'Verrouiller' : 'Déverrouiller', (d) => setObjectsLocked(d, ids, locked));
  },

  group() {
    const ids = selectedIds();
    if (ids.length >= 2) planStore.getState().update('Grouper', (d) => groupObjects(d, ids));
  },

  ungroup() {
    const ids = selectedIds();
    if (ids.length) planStore.getState().update('Dégrouper', (d) => ungroupObjects(d, ids));
  },

  // --- Gestes sur le canevas --------------------------------------------------------------------

  /**
   * Début d'un geste pouvant toucher plusieurs objets (glisser ou transformer une sélection) :
   * toutes les fins de geste des nœuds s'inscrivent dans une seule transaction.
   */
  beginNodeGesture(label: string) {
    if (!gestureCancelled && !planStore.getState().pending) planStore.getState().beginTransaction(label);
  },

  /** Fin d'un glisser ou d'un geste du Transformer pour UN nœud (validé avec les autres nœuds). */
  commitNodeTransform(id: string, transform: NodeTransform, label: string) {
    const object = doc()?.objects[id];
    if (object) {
      const center = geometryCenter(object.geometry);
      const unchanged =
        Math.abs(transform.x - center.x) < 1e-9 &&
        Math.abs(transform.y - center.y) < 1e-9 &&
        transform.rotation === object.rotation &&
        transform.scaleX === 1 &&
        transform.scaleY === 1;
      if (!unchanged)
        planStore.getState().update(label, (d) => replaceObject(d, normalizeTransform(object, transform)));
    }
    endGestureSoon();
  },

  /**
   * Annule le geste en cours (glisser d'objets, transformation, glisser de sommet, forme ou
   * rectangle de sélection en cours) sans rien enregistrer. Utilisé quand un 2e doigt transforme
   * le geste en pincement.
   */
  cancelActiveGesture(
    stage: {
      find(selector: string): {
        isDragging?(): boolean;
        stopDrag?(): void;
        isTransforming?(): boolean;
        stopTransform?(): void;
      }[];
    } | null,
  ) {
    gestureCancelled = true;
    useEditorStore.getState().setDraft(null);
    useEditorStore.getState().setMarquee(null);
    planStore.getState().cancelTransaction();
    for (const node of stage?.find('.plan-object, .vertex-handle, .midpoint-handle') ?? [])
      if (node.isDragging?.()) node.stopDrag?.();
    for (const tr of stage?.find('Transformer') ?? []) if (tr.isTransforming?.()) tr.stopTransform?.();
    gestureCancelled = false;
  },
  /** Pendant `cancelActiveGesture`, la fin de geste déclenchée par Konva doit être ignorée. */
  isGestureCancelled: () => gestureCancelled,

  // --- Sommets ------------------------------------------------------------------------------------

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

  /**
   * Insère un sommet au milieu d'un segment et ouvre le geste : insertion et glisser du nouveau
   * sommet forment une seule action (terminée par `endVertexDrag`).
   */
  beginInsertVertex(id: string, afterIndex: number, at: Point) {
    const object = doc()?.objects[id];
    if (!object) return;
    planStore.getState().beginTransaction('Ajouter un sommet');
    planStore
      .getState()
      .update('Ajouter un sommet', (d) => replaceObject(d, insertVertex(object, afterIndex, at)));
    useEditorStore.getState().setSelectedVertex(afterIndex + 1);
  },

  deleteSelectedVertex(): boolean {
    const editor = useEditorStore.getState();
    const object = single();
    if (!object || !editor.vertexEditing || editor.selectedVertex === null) return false;
    const next = removeVertex(object, editor.selectedVertex);
    if (next === object) {
      notify('notice.minVertices');
      return true;
    }
    planStore.getState().update('Supprimer un sommet', (d) => replaceObject(d, next));
    editor.setSelectedVertex(null);
    return true;
  },

  closeSelectedPolyline() {
    const object = single();
    if (object)
      planStore.getState().update('Fermer en polygone', (d) => replaceObject(d, closePolyline(object)));
  },

  convertSelectedToPolygon() {
    const object = single();
    if (!object) return;
    planStore.getState().update('Convertir en polygone', (d) => replaceObject(d, rectToPolygon(object)));
    useEditorStore.getState().setVertexEditing(true);
  },
};
