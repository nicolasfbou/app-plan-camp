/**
 * Journal de récupération synchrone (localStorage). Écrit uniquement à la fermeture ou au
 * masquage de la page quand des modifications ne sont pas encore dans IndexedDB.
 *
 * - Il est horodaté : une sauvegarde IndexedDB ne l'efface que si elle a COMMENCÉ après son
 *   écriture (elle contient alors au moins les mêmes modifications).
 * - À la réouverture, il n'est appliqué que s'il est plus récent que la dernière sauvegarde.
 * - Le document est validé (et migré) à la relecture : un journal corrompu est ignoré.
 */
import type { PlanDocument } from '@/domain/model/types.ts';
import { parsePlanDocument, serializePlanDocument } from '@/domain/schema/serialization.ts';

const key = (planId: string) => `campplanner.recovery.${planId}`;

export interface RecoveryEntry {
  doc: PlanDocument;
  /** Date d'écriture du journal (ms depuis l'époque). */
  writtenAt: number;
}

export function writeRecovery(doc: PlanDocument, now = Date.now()): void {
  try {
    localStorage.setItem(
      key(doc.plan.id),
      JSON.stringify({ writtenAt: now, document: JSON.parse(serializePlanDocument(doc)) }),
    );
  } catch {
    // Quota dépassé ou stockage indisponible : la sauvegarde IndexedDB reste la voie normale.
  }
}

export function readRecovery(planId: string): RecoveryEntry | null {
  try {
    const raw = localStorage.getItem(key(planId));
    if (!raw) return null;
    const entry = JSON.parse(raw) as { writtenAt?: unknown; document?: unknown };
    if (typeof entry.writtenAt !== 'number') throw new Error('Journal sans date.');
    const doc = parsePlanDocument(entry.document);
    if (doc.plan.id !== planId) throw new Error('Journal d’un autre plan.');
    return { doc, writtenAt: entry.writtenAt };
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

/** Efface le journal seulement s'il est couvert par une sauvegarde commencée à `saveStartedAt`. */
export function clearRecoveryIfCovered(planId: string, saveStartedAt: number): void {
  try {
    const raw = localStorage.getItem(key(planId));
    if (!raw) return;
    const { writtenAt } = JSON.parse(raw) as { writtenAt?: number };
    if (typeof writtenAt !== 'number' || writtenAt <= saveStartedAt) clearRecovery(planId);
  } catch {
    clearRecovery(planId);
  }
}
