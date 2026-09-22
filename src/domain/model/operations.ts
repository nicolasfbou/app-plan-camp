/**
 * Opérations métier sur un document de plan. Elles mutent le document reçu et sont conçues
 * pour être appelées dans une recette Immer (`planStore.update`), qui produit les patches
 * d'historique. Elles ne connaissent ni React, ni Konva, ni le viewport.
 */
import { translateGeometry } from './geometry.ts';
import { nowIso } from './factories.ts';
import type { PlanDocument, PlanObject } from './types.ts';

export function addObject(doc: PlanDocument, object: PlanObject): void {
  if (doc.objects[object.id]) throw new Error(`Objet déjà présent : ${object.id}`);
  if (!doc.layers.some((layer) => layer.id === object.layerId)) {
    throw new Error(`Calque inexistant : ${object.layerId}`);
  }
  doc.objects[object.id] = object;
}

export function removeObject(doc: PlanDocument, id: string): void {
  delete doc.objects[id];
}

export function moveObject(doc: PlanDocument, id: string, dx: number, dy: number, now = nowIso()): void {
  const object = doc.objects[id];
  if (!object || object.locked) return;
  // Le type de géométrie est conservé par translateGeometry ; l'assertion l'indique à TypeScript.
  object.geometry = translateGeometry(object.geometry, dx, dy) as typeof object.geometry;
  object.updatedAt = now;
}
