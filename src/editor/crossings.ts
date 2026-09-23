/** Croisements affichés (objets visibles seulement), recalculés quand le document change. */
import { assignReviews, type Crossing, detectCrossings } from '@/domain/model/crossings.ts';
import { isShownInEditor } from './viewVisibility.ts';
import type { CrossingReview, PlanDocument } from '@/domain/model/types.ts';
import { usePlanStore } from '@/store/planStore.ts';

export interface CrossingView extends Crossing {
  review: CrossingReview | undefined;
  status: CrossingReview['status'];
}

export function crossingViews(doc: PlanDocument): CrossingView[] {
  const crossings = detectCrossings(doc, (o) => isShownInEditor(doc, o));
  const reviews = assignReviews(doc, crossings);
  return crossings.map((c) => {
    const review = reviews.get(c.key);
    return { ...c, review, status: review?.status ?? 'open' };
  });
}

/** Un seul calcul par version du document, partagé par le panneau Analyse et les marqueurs. */
const cache = new WeakMap<PlanDocument, CrossingView[]>();
function cachedViews(doc: PlanDocument): CrossingView[] {
  let views = cache.get(doc);
  if (!views) {
    views = crossingViews(doc);
    cache.set(doc, views);
  }
  return views;
}

const NONE: CrossingView[] = [];

export function useCrossings(): CrossingView[] {
  const doc = usePlanStore((s) => s.doc);
  return doc ? cachedViews(doc) : NONE;
}
