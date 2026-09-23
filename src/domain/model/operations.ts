/**
 * Opérations métier sur un document de plan. Elles mutent le document reçu et sont conçues
 * pour être appelées dans une recette Immer (`planStore.update`), qui produit les patches
 * d'historique. Elles ne connaissent ni React, ni Konva, ni le viewport.
 *
 * Règle de verrouillage : un objet verrouillé, ou posé sur un calque verrouillé, ne peut être ni
 * déplacé, ni transformé, ni supprimé. Seul son verrouillage (et sa visibilité) peut changer.
 */
import { translateGeometry } from './geometry.ts';
import { newId, nowIso } from './factories.ts';
import { isLayerUsable, layerForTier, tierForType, topZIndex } from './objectFactory.ts';
import type { Layer, PlanDocument, PlanObject } from './types.ts';

export function addObject(doc: PlanDocument, object: PlanObject): void {
  if (doc.objects[object.id]) throw new Error(`Objet déjà présent : ${object.id}`);
  if (!doc.layers.some((layer) => layer.id === object.layerId)) {
    throw new Error(`Calque inexistant : ${object.layerId}`);
  }
  doc.objects[object.id] = object;
  doc.plan.updatedAt = object.updatedAt;
}

export function layerOf(doc: PlanDocument, object: PlanObject): Layer | undefined {
  return doc.layers.find((layer) => layer.id === object.layerId);
}

/** Vrai si l'objet peut être modifié (ni lui ni son calque ne sont verrouillés). */
export function isEditable(doc: PlanDocument, object: PlanObject): boolean {
  return !object.locked && !layerOf(doc, object)?.locked;
}

/** Vrai si l'objet est affiché (lui et son calque sont visibles). */
export function isDisplayed(doc: PlanDocument, object: PlanObject): boolean {
  return object.visible && layerOf(doc, object)?.visible !== false;
}

function touch(doc: PlanDocument, object: PlanObject, now: string) {
  object.updatedAt = now;
  doc.plan.updatedAt = now;
}

/** Supprime l'objet s'il est modifiable. Retourne vrai si la suppression a eu lieu. */
export function removeObject(doc: PlanDocument, id: string, now = nowIso()): boolean {
  const object = doc.objects[id];
  if (!object || !isEditable(doc, object)) return false;
  delete doc.objects[id];
  dropCrossingReviews(doc, [id]);
  doc.plan.updatedAt = now;
  return true;
}

/** Pictogrammes importés qu'aucun objet (pictogramme placé ou zone) n'utilise : retirés du plan. */
export function removeUnusedAssets(doc: PlanDocument, now = nowIso()): number {
  const used = new Set<string>();
  for (const o of Object.values(doc.objects)) {
    if (o.type === 'icon') used.add(o.symbolId);
    if (o.type === 'zone' && o.icon) used.add(o.icon.symbolId);
  }
  let removed = 0;
  for (const id of Object.keys(doc.assets))
    if (!used.has(`asset:${id}`)) {
      delete doc.assets[id];
      removed++;
    }
  if (removed) doc.plan.updatedAt = now;
  return removed;
}

/**
 * Les décisions sur les croisements d'un trajet ou d'un corridor supprimé disparaissent avec lui
 * (dans la même action : annuler la suppression les restaure).
 */
export function dropCrossingReviews(doc: PlanDocument, removedIds: readonly string[]): void {
  if (!doc.crossingReviews.length) return;
  const removed = new Set(removedIds);
  if (doc.crossingReviews.some((r) => removed.has(r.flowId) || removed.has(r.corridorId)))
    doc.crossingReviews = doc.crossingReviews.filter(
      (r) => !removed.has(r.flowId) && !removed.has(r.corridorId),
    );
}

export function moveObject(doc: PlanDocument, id: string, dx: number, dy: number, now = nowIso()): void {
  const object = doc.objects[id];
  if (!object || !isEditable(doc, object)) return;
  // Le type de géométrie est conservé par translateGeometry ; l'assertion l'indique à TypeScript.
  object.geometry = translateGeometry(object.geometry, dx, dy) as typeof object.geometry;
  touch(doc, object, now);
}

/**
 * Remplace un objet par sa nouvelle version (issue du panneau de propriétés ou d'un geste).
 * Refusé si l'objet est verrouillé, sauf pour les champs de verrouillage et de visibilité.
 */
export function replaceObject(doc: PlanDocument, next: PlanObject, now = nowIso()): boolean {
  const current = doc.objects[next.id];
  if (!current) return false;
  if (!isEditable(doc, current)) {
    const onlyLockOrVisibility =
      JSON.stringify({ ...current, locked: 0, visible: 0, updatedAt: 0 }) ===
      JSON.stringify({ ...next, locked: 0, visible: 0, updatedAt: 0 });
    if (!onlyLockOrVisibility) return false;
  }
  let zIndex = next.zIndex;
  if (next.layerId !== current.layerId) {
    // Changement de calque : seulement vers un calque visible et déverrouillé, et au-dessus de ses objets.
    const target = doc.layers.find((l) => l.id === next.layerId);
    if (!target || !isLayerUsable(target)) return false;
    zIndex = topZIndex(doc, target.id);
  }
  doc.objects[next.id] = { ...next, zIndex, updatedAt: now };
  doc.plan.updatedAt = now;
  return true;
}

/**
 * Calque qui recevra la copie d'un objet : son calque d'origine s'il existe dans ce plan, sinon le
 * calque du niveau naturel de son type. `null` si ce calque est masqué ou verrouillé.
 */
export function copyTargetLayer(doc: PlanDocument, source: PlanObject): Layer | null {
  const layer =
    doc.layers.find((l) => l.id === source.layerId) ?? layerForTier(doc, tierForType(source.type));
  return isLayerUsable(layer) ? layer : null;
}

/**
 * Copie d'un objet (duplication ou collage) : nouvel identifiant, décalée de (dx, dy),
 * déverrouillée, placée au-dessus des objets de son calque. Retourne la copie ajoutée, ou `null`
 * si le calque cible est masqué ou verrouillé (rien n'est alors créé).
 */
export function insertCopy(
  doc: PlanDocument,
  source: PlanObject,
  dx: number,
  dy: number,
  now = nowIso(),
): PlanObject | null {
  const target = copyTargetLayer(doc, source);
  if (!target) return null;
  const layerId = target.id;
  const copy = {
    ...structuredClone(source),
    id: newId(),
    layerId,
    locked: false,
    visible: true,
    zIndex: topZIndex(doc, layerId),
    geometry: translateGeometry(source.geometry, dx, dy),
    createdAt: now,
    updatedAt: now,
  } as PlanObject;
  doc.objects[copy.id] = copy;
  doc.plan.updatedAt = now;
  return copy;
}

export type ZOrderMove = 'front' | 'back' | 'forward' | 'backward';

/**
 * Ordre d'empilement À L'INTÉRIEUR du calque de l'objet. Les zIndex du calque sont renumérotés
 * 0..n-1 pour rester compacts. Les contrôles de sélection sont sur une couche à part : aucun objet
 * ne peut passer devant eux.
 */
export function reorderObject(doc: PlanDocument, id: string, move: ZOrderMove, now = nowIso()): boolean {
  const object = doc.objects[id];
  if (!object || !isEditable(doc, object)) return false;
  const siblings = Object.values(doc.objects)
    .filter((o) => o.layerId === object.layerId)
    .sort(
      (a, b) => a.zIndex - b.zIndex || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const from = siblings.findIndex((o) => o.id === id);
  const to =
    move === 'front'
      ? siblings.length - 1
      : move === 'back'
        ? 0
        : move === 'forward'
          ? Math.min(siblings.length - 1, from + 1)
          : Math.max(0, from - 1);
  if (from === to) return false;
  siblings.splice(from, 1);
  siblings.splice(to, 0, object);
  siblings.forEach((o, index) => {
    if (doc.objects[o.id]!.zIndex !== index) doc.objects[o.id]!.zIndex = index;
  });
  touch(doc, doc.objects[id]!, now);
  return true;
}

export function setLayerFlag(
  doc: PlanDocument,
  layerId: string,
  flag: 'visible' | 'locked',
  value: boolean,
  now = nowIso(),
): void {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer || layer[flag] === value) return;
  layer[flag] = value;
  doc.plan.updatedAt = now;
}

/** Objets triés pour le rendu : ordre des calques (dessous → dessus), puis zIndex. */
export function objectsInRenderOrder(doc: PlanDocument): PlanObject[] {
  const layerIndex = new Map(doc.layers.map((l, i) => [l.id, i]));
  return Object.values(doc.objects).sort(
    (a, b) =>
      (layerIndex.get(a.layerId) ?? 0) - (layerIndex.get(b.layerId) ?? 0) ||
      a.zIndex - b.zIndex ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
