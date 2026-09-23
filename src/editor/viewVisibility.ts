/**
 * Visibilité dans l'éditeur, vue par public comprise : un objet masqué par la vue affichée n'est
 * ni dessiné, ni sélectionnable, ni accroché. Le plan lui-même n'est jamais modifié.
 */
import { isDisplayed } from '@/domain/model/operations.ts';
import type { PlanDocument, PlanObject } from '@/domain/model/types.ts';
import { viewFilter } from '@/domain/print/views.ts';
import { useEditorStore } from '@/store/editorStore.ts';

const cache = new WeakMap<PlanDocument, { viewId: string | null; filter: ReturnType<typeof viewFilter> }>();

function currentFilter(doc: PlanDocument) {
  const viewId = useEditorStore.getState().activeViewId;
  const hit = cache.get(doc);
  if (hit && hit.viewId === viewId) return hit.filter;
  const filter = viewFilter(doc, viewId);
  cache.set(doc, { viewId, filter });
  return filter;
}

export function isShownInEditor(doc: PlanDocument, object: PlanObject): boolean {
  if (!isDisplayed(doc, object)) return false;
  const f = currentFilter(doc);
  return !f.hiddenLayers.has(object.layerId) && !f.hiddenObjects.has(object.id);
}
