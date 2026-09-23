/**
 * Opérations sur plusieurs objets à la fois (sélection multiple, groupes). Les objets verrouillés
 * ou posés sur un calque verrouillé sont toujours ignorés : ils ne bougent pas, ne changent pas,
 * ne sont pas supprimés. Chaque fonction est appelée dans UNE recette d'historique.
 */
import { translateGeometry } from './geometry.ts';
import { newId, nowIso } from './factories.ts';
import { isLayerUsable, tierForType, layerForTier, topZIndex } from './objectFactory.ts';
import { dropCrossingReviews, isDisplayed, isEditable } from './operations.ts';
import type { PlanDocument, PlanObject, Style } from './types.ts';

/** Ajoute à la sélection tous les membres des groupes qu'elle touche. */
export function expandGroups(doc: PlanDocument, ids: readonly string[]): string[] {
  const groups = new Set(ids.map((id) => doc.objects[id]?.groupId).filter((g): g is string => Boolean(g)));
  const result = new Set(ids.filter((id) => doc.objects[id]));
  if (groups.size)
    for (const o of Object.values(doc.objects)) if (o.groupId && groups.has(o.groupId)) result.add(o.id);
  return [...result];
}

/** Objets modifiables et affichés (cible de Ctrl+A). */
export function selectableIds(doc: PlanDocument): string[] {
  return Object.values(doc.objects)
    .filter((o) => isEditable(doc, o) && isDisplayed(doc, o))
    .map((o) => o.id);
}

function editableObjects(doc: PlanDocument, ids: readonly string[]): PlanObject[] {
  return ids.map((id) => doc.objects[id]).filter((o): o is PlanObject => Boolean(o) && isEditable(doc, o!));
}

export function moveObjects(
  doc: PlanDocument,
  ids: readonly string[],
  dx: number,
  dy: number,
  now = nowIso(),
): number {
  const objects = editableObjects(doc, ids);
  for (const object of objects) {
    object.geometry = translateGeometry(object.geometry, dx, dy) as typeof object.geometry;
    object.updatedAt = now;
  }
  if (objects.length) doc.plan.updatedAt = now;
  return objects.length;
}

/** Supprime les objets modifiables. Retourne le nombre d'objets ignorés (verrouillés). */
export function removeObjects(
  doc: PlanDocument,
  ids: readonly string[],
  now = nowIso(),
): { removed: number; skipped: number } {
  const objects = editableObjects(doc, ids);
  for (const object of objects) delete doc.objects[object.id];
  dropCrossingReviews(
    doc,
    objects.map((o) => o.id),
  );
  if (objects.length) doc.plan.updatedAt = now;
  return { removed: objects.length, skipped: ids.length - objects.length };
}

/**
 * Copies (duplication, collage) : nouveaux identifiants, décalées, déverrouillées, au-dessus de
 * leur calque ; les groupes copiés sont recréés. Les objets dont le calque cible est masqué ou
 * verrouillé ne sont pas copiés. Retourne les identifiants créés.
 */
export function insertCopies(
  doc: PlanDocument,
  sources: readonly PlanObject[],
  dx: number,
  dy: number,
  now = nowIso(),
): string[] {
  const groups = new Map<string, string>();
  const created: string[] = [];
  const ordered = [...sources].sort((a, b) => a.zIndex - b.zIndex);
  for (const source of ordered) {
    const layer =
      doc.layers.find((l) => l.id === source.layerId) ?? layerForTier(doc, tierForType(source.type));
    if (!isLayerUsable(layer)) continue;
    const groupId = source.groupId
      ? (groups.get(source.groupId) ?? groups.set(source.groupId, newId()).get(source.groupId)!)
      : null;
    const copy = {
      ...structuredClone(source),
      id: newId(),
      layerId: layer.id,
      groupId,
      locked: false,
      visible: true,
      zIndex: topZIndex(doc, layer.id),
      geometry: translateGeometry(source.geometry, dx, dy),
      createdAt: now,
      updatedAt: now,
    } as PlanObject;
    doc.objects[copy.id] = copy;
    created.push(copy.id);
  }
  if (created.length) doc.plan.updatedAt = now;
  return created;
}

/** Déplace des objets vers un autre calque (visible et déverrouillé), au-dessus de ses objets. */
export function setObjectsLayer(
  doc: PlanDocument,
  ids: readonly string[],
  layerId: string,
  now = nowIso(),
): number {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer || !isLayerUsable(layer)) return 0;
  const objects = editableObjects(doc, ids)
    .filter((o) => o.layerId !== layerId)
    .sort((a, b) => a.zIndex - b.zIndex);
  for (const object of objects) {
    object.zIndex = topZIndex(doc, layerId);
    object.layerId = layerId;
    object.updatedAt = now;
  }
  if (objects.length) doc.plan.updatedAt = now;
  return objects.length;
}

/**
 * Change le style de plusieurs objets. Le remplissage ne s'applique qu'aux surfaces, la couleur
 * de texte aux textes (via `fill`), le trait à tout sauf les textes.
 */
export function setObjectsStyle(
  doc: PlanDocument,
  ids: readonly string[],
  patch: Partial<Style>,
  now = nowIso(),
): number {
  let changed = 0;
  for (const object of editableObjects(doc, ids)) {
    const isArea = object.type === 'zone' || object.type === 'building';
    const applicable: Partial<Style> = {};
    for (const [key, value] of Object.entries(patch) as [keyof Style, never][]) {
      const fillKey = key === 'fill' || key === 'fillOpacity';
      if (fillKey && !(isArea || object.type === 'text')) continue;
      if (!fillKey && object.type === 'text') continue;
      applicable[key] = value;
    }
    if (Object.keys(applicable).length === 0) continue;
    object.style = { ...object.style, ...applicable };
    object.updatedAt = now;
    changed++;
  }
  if (changed) doc.plan.updatedAt = now;
  return changed;
}

/** Regroupe les objets modifiables (au moins 2). Retourne l'identifiant du groupe, ou null. */
export function groupObjects(doc: PlanDocument, ids: readonly string[], now = nowIso()): string | null {
  const objects = editableObjects(doc, ids);
  if (objects.length < 2) return null;
  const groupId = newId();
  for (const object of objects) {
    object.groupId = groupId;
    object.updatedAt = now;
  }
  doc.plan.updatedAt = now;
  return groupId;
}

export function ungroupObjects(doc: PlanDocument, ids: readonly string[], now = nowIso()): number {
  const objects = editableObjects(doc, ids).filter((o) => o.groupId);
  for (const object of objects) {
    object.groupId = null;
    object.updatedAt = now;
  }
  if (objects.length) doc.plan.updatedAt = now;
  return objects.length;
}

export function setObjectsLocked(
  doc: PlanDocument,
  ids: readonly string[],
  locked: boolean,
  now = nowIso(),
): number {
  let changed = 0;
  for (const id of ids) {
    const object = doc.objects[id];
    if (!object || object.locked === locked) continue;
    object.locked = locked;
    object.updatedAt = now;
    changed++;
  }
  // Rien de changé : aucune écriture, donc aucune entrée d'historique.
  if (changed) doc.plan.updatedAt = now;
  return changed;
}
