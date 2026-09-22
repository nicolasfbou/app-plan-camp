/**
 * Journal de récupération synchrone (localStorage). Écrit uniquement à la fermeture ou au
 * masquage de la page quand des modifications ne sont pas encore dans IndexedDB ; relu et
 * appliqué à la réouverture du plan, puis effacé dès que la sauvegarde normale aboutit.
 * Le document est validé (et migré) à la relecture : un journal corrompu est ignoré.
 */
import type { PlanDocument } from '@/domain/model/types.ts';
import { parsePlanDocument, serializePlanDocument } from '@/domain/schema/serialization.ts';

const key = (planId: string) => `campplanner.recovery.${planId}`;

export function writeRecovery(doc: PlanDocument): void {
  try {
    localStorage.setItem(key(doc.plan.id), serializePlanDocument(doc));
  } catch {
    // Quota dépassé ou stockage indisponible : la sauvegarde IndexedDB reste la voie normale.
  }
}

export function readRecovery(planId: string): PlanDocument | null {
  try {
    const raw = localStorage.getItem(key(planId));
    if (!raw) return null;
    const doc = parsePlanDocument(raw);
    return doc.plan.id === planId ? doc : null;
  } catch {
    clearRecovery(planId);
    return null;
  }
}

export function clearRecovery(planId: string): void {
  try {
    localStorage.removeItem(key(planId));
  } catch {
    // ignoré
  }
}
