/**
 * Décisions de l'utilisateur sur la lisibilité : problème vérifié ou ignoré volontairement (clé
 * stable), et application d'une proposition de placement ACCEPTÉE (jamais automatique).
 */
import { nowIso } from '../model/factories.ts';
import { geometryCenter } from '../model/shapes.ts';
import type { PlanDocument, Point } from '../model/types.ts';

export function setReadabilityReview(
  doc: PlanDocument,
  key: string,
  status: 'verified' | 'ignored' | null,
  now = nowIso(),
): void {
  doc.readabilityReviews = doc.readabilityReviews.filter((r) => r.key !== key);
  if (status) doc.readabilityReviews.push({ key, status, at: now });
}

/**
 * Applique un emplacement accepté : le texte est déplacé (avec une ligne de renvoi vers ce qu'il
 * désignait si demandé), ou le nom de la zone est décalé de son centre. Retourne false si l'objet
 * n'existe plus, est verrouillé ou n'est pas une étiquette.
 */
export function applyLabelPlacement(
  doc: PlanDocument,
  proposal: { objectId: string; kind: 'text' | 'zone-name'; at: Point; leaderTo: Point | null },
  now = nowIso(),
): boolean {
  const o = doc.objects[proposal.objectId];
  const layer = o && doc.layers.find((l) => l.id === o.layerId);
  if (!o || o.locked || layer?.locked) return false;
  if (proposal.kind === 'text' && o.type === 'text') {
    o.geometry = { kind: 'point', x: proposal.at.x, y: proposal.at.y };
    o.leaderTo = proposal.leaderTo;
  } else if (proposal.kind === 'zone-name' && o.type === 'zone') {
    const c = geometryCenter(o.geometry);
    o.nameOffset = { x: proposal.at.x - c.x, y: proposal.at.y - c.y };
  } else return false;
  o.updatedAt = now;
  doc.plan.updatedAt = now;
  return true;
}

/** Remet une étiquette à sa place d'origine (nom de zone au centre, texte sans renvoi). */
export function resetLabelPlacement(doc: PlanDocument, objectId: string, now = nowIso()): boolean {
  const o = doc.objects[objectId];
  if (!o) return false;
  if (o.type === 'zone') o.nameOffset = null;
  else if (o.type === 'text' && o.leaderTo) {
    o.geometry = { kind: 'point', x: o.leaderTo.x, y: o.leaderTo.y };
    o.leaderTo = null;
  } else return false;
  o.updatedAt = now;
  doc.plan.updatedAt = now;
  return true;
}
