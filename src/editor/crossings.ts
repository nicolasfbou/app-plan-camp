/** Croisements affichés (objets visibles seulement), recalculés quand le document change. */
import { useMemo } from 'react';
import { type Crossing, detectCrossings, reviewFor } from '@/domain/model/crossings.ts';
import { isDisplayed } from '@/domain/model/operations.ts';
import type { CrossingReview, PlanDocument } from '@/domain/model/types.ts';
import { usePlanStore } from '@/store/planStore.ts';

export interface CrossingView extends Crossing {
  review: CrossingReview | undefined;
  status: CrossingReview['status'];
}

export function crossingViews(doc: PlanDocument): CrossingView[] {
  return detectCrossings(doc, (o) => isDisplayed(doc, o)).map((c) => {
    const review = reviewFor(doc, c);
    return { ...c, review, status: review?.status ?? 'open' };
  });
}

export function useCrossings(): CrossingView[] {
  const doc = usePlanStore((s) => s.doc);
  return useMemo(() => (doc ? crossingViews(doc) : []), [doc]);
}
