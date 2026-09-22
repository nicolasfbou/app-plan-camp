/**
 * Gestion des calques. Le tableau `doc.layers` est l'ordre d'affichage (index 0 = dessous) :
 * réordonner les calques change réellement l'ordre de rendu (un groupe Konva par calque dans la
 * couche physique « content »). Chaque calque garde sa catégorie logique (`tier`).
 */
import { newId, nowIso } from './factories.ts';
import type { Layer, PlanDocument, PlanObject, RenderTier } from './types.ts';

function touch(doc: PlanDocument, now: string) {
  doc.plan.updatedAt = now;
}

/** Ajoute un calque au-dessus de tous les autres. Retourne le calque créé. */
export function addLayer(doc: PlanDocument, name: string, tier: RenderTier, now = nowIso()): Layer {
  const layer: Layer = { id: newId(), name, tier, visible: true, locked: false, opacity: 1 };
  doc.layers.push(layer);
  touch(doc, now);
  return layer;
}

export function renameLayer(doc: PlanDocument, layerId: string, name: string, now = nowIso()): boolean {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer || !name.trim() || layer.name === name) return false;
  layer.name = name;
  touch(doc, now);
  return true;
}

/** Monte (+1) ou descend (−1) un calque d'un cran dans l'ordre d'affichage. */
export function moveLayer(doc: PlanDocument, layerId: string, direction: 1 | -1, now = nowIso()): boolean {
  const from = doc.layers.findIndex((l) => l.id === layerId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= doc.layers.length) return false;
  const [layer] = doc.layers.splice(from, 1);
  doc.layers.splice(to, 0, layer!);
  touch(doc, now);
  return true;
}

/** Supprime un calque VIDE (jamais d'objets supprimés en cascade par erreur). Il doit en rester un. */
export function deleteLayer(doc: PlanDocument, layerId: string, now = nowIso()): boolean {
  if (doc.layers.length <= 1) return false;
  if (Object.values(doc.objects).some((o) => o.layerId === layerId)) return false;
  const index = doc.layers.findIndex((l) => l.id === layerId);
  if (index < 0) return false;
  doc.layers.splice(index, 1);
  touch(doc, now);
  return true;
}

/**
 * Duplique un calque juste au-dessus de l'original, avec une copie de chacun de ses objets
 * (nouveaux identifiants ; les groupes internes sont recréés, pas partagés avec l'original).
 */
export function duplicateLayer(
  doc: PlanDocument,
  layerId: string,
  name: string,
  now = nowIso(),
): Layer | null {
  const index = doc.layers.findIndex((l) => l.id === layerId);
  const source = doc.layers[index];
  if (!source) return null;
  const layer: Layer = { ...source, id: newId(), name, locked: false };
  doc.layers.splice(index + 1, 0, layer);
  const groups = new Map<string, string>();
  for (const object of Object.values(doc.objects).filter((o) => o.layerId === layerId)) {
    const groupId = object.groupId
      ? (groups.get(object.groupId) ?? groups.set(object.groupId, newId()).get(object.groupId)!)
      : null;
    const copy = {
      // Copie JSON : `object` peut être un brouillon Immer (Proxy), que structuredClone refuse.
      ...(JSON.parse(JSON.stringify(object)) as PlanObject),
      id: newId(),
      layerId: layer.id,
      locked: false,
      groupId,
      createdAt: now,
      updatedAt: now,
    };
    doc.objects[copy.id] = copy;
  }
  touch(doc, now);
  return layer;
}
