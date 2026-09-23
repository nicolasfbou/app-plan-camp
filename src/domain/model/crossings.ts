/**
 * Analyse visuelle : croisements GÉOMÉTRIQUES entre les trajets de véhicules et les corridors
 * piétons. C'est une aide à la planification, jamais une certification de sécurité : un croisement
 * non détecté n'est pas une garantie, un croisement détecté n'est pas un verdict.
 */
import { newId, nowIso } from './factories.ts';
import { segmentsClosest } from './paths.ts';
import { worldVertices } from './shapes.ts';
import type { CorridorObject, CrossingReview, FlowObject, PlanDocument, PlanObject, Point } from './types.ts';

export interface Crossing {
  /** Clé stable tant que la géométrie ne change pas (paire d'objets + rang). */
  key: string;
  flowId: string;
  corridorId: string;
  point: Point;
  /** `crossing` : les tracés se coupent ; `overlap` : le trajet passe dans la largeur du corridor. */
  kind: 'crossing' | 'overlap';
}

const isFlow = (o: PlanObject): o is FlowObject => o.type === 'flow';
const isCorridor = (o: PlanObject): o is CorridorObject => o.type === 'corridor';

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
function bounds(points: readonly Point[], margin: number): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}
const overlaps = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/**
 * Croisements entre chaque trajet et chaque corridor (coordonnées image, rotation appliquée).
 * Un segment de trajet qui coupe l'axe du corridor, ou passe à moins d'une demi-largeur de cet
 * axe, produit un point ; les points proches (moins d'une largeur de corridor) sont fusionnés.
 * `include` permet de ne garder que les objets affichés.
 */
export function detectCrossings(
  doc: PlanDocument,
  include: (o: PlanObject) => boolean = () => true,
): Crossing[] {
  const objects = Object.values(doc.objects).filter(include);
  const flows = objects.filter(isFlow).map((o) => ({ o, pts: worldVertices(o) }));
  const corridors = objects.filter(isCorridor).map((o) => ({ o, pts: worldVertices(o) }));
  const result: Crossing[] = [];
  for (const flow of flows) {
    const fb = bounds(flow.pts, 0);
    for (const corridor of corridors) {
      const half = corridor.o.width / 2;
      if (!overlaps(fb, bounds(corridor.pts, half))) continue;
      const found: { point: Point; kind: Crossing['kind'] }[] = [];
      for (let i = 1; i < flow.pts.length; i++) {
        for (let j = 1; j < corridor.pts.length; j++) {
          const c = segmentsClosest(flow.pts[i - 1]!, flow.pts[i]!, corridor.pts[j - 1]!, corridor.pts[j]!);
          if (c.distance > half) continue;
          const merge = found.find(
            (f) => Math.hypot(f.point.x - c.point.x, f.point.y - c.point.y) < Math.max(corridor.o.width, 1),
          );
          if (merge) {
            if (c.distance === 0) merge.kind = 'crossing';
            continue;
          }
          found.push({ point: c.point, kind: c.distance === 0 ? 'crossing' : 'overlap' });
        }
      }
      found.forEach((f, rank) =>
        result.push({
          key: `${flow.o.id}:${corridor.o.id}:${rank}`,
          flowId: flow.o.id,
          corridorId: corridor.o.id,
          point: f.point,
          kind: f.kind,
        }),
      );
    }
  }
  return result;
}

/** Distance au-delà de laquelle une décision enregistrée ne s'applique plus à un croisement. */
export function reviewTolerance(doc: PlanDocument, crossing: Crossing): number {
  const corridor = doc.objects[crossing.corridorId];
  return Math.max(40, corridor?.type === 'corridor' ? corridor.width * 1.5 : 0);
}

/** Décision enregistrée pour ce croisement (même paire d'objets, position voisine). */
export function reviewFor(doc: PlanDocument, crossing: Crossing): CrossingReview | undefined {
  const tolerance = reviewTolerance(doc, crossing);
  let best: CrossingReview | undefined;
  let bestDistance = Infinity;
  for (const review of doc.crossingReviews) {
    if (review.flowId !== crossing.flowId || review.corridorId !== crossing.corridorId) continue;
    const d = Math.hypot(review.point.x - crossing.point.x, review.point.y - crossing.point.y);
    if (d <= tolerance && d < bestDistance) {
      best = review;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Enregistre le statut et / ou la note d'un croisement (dans le document : annulable, sauvegardé,
 * exporté). La position enregistrée suit la dernière position détectée.
 */
export function setCrossingReview(
  doc: PlanDocument,
  crossing: Crossing,
  patch: Partial<Pick<CrossingReview, 'status' | 'note'>>,
  now = nowIso(),
): CrossingReview {
  const existing = reviewFor(doc, crossing);
  if (existing) {
    const review = doc.crossingReviews.find((r) => r.id === existing.id)!;
    Object.assign(review, patch, { point: crossing.point, updatedAt: now });
    doc.plan.updatedAt = now;
    return review;
  }
  const review: CrossingReview = {
    id: newId(),
    flowId: crossing.flowId,
    corridorId: crossing.corridorId,
    point: crossing.point,
    status: patch.status ?? 'open',
    note: patch.note ?? '',
    updatedAt: now,
  };
  doc.crossingReviews.push(review);
  doc.plan.updatedAt = now;
  return review;
}

/** Retire les décisions dont le trajet ou le corridor n'existe plus. */
export function pruneCrossingReviews(doc: PlanDocument): number {
  const before = doc.crossingReviews.length;
  doc.crossingReviews = doc.crossingReviews.filter((r) => doc.objects[r.flowId] && doc.objects[r.corridorId]);
  return before - doc.crossingReviews.length;
}
