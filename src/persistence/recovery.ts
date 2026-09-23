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
import { logEvent } from '@/diagnostics/errorLog.ts';

const key = (planId: string) => `campplanner.recovery.${planId}`;

export interface RecoveryEntry {
  doc: PlanDocument;
  /** Date d'écriture du journal (ms depuis l'époque). */
  writtenAt: number;
  /**
   * Version enregistrée sur laquelle reposaient ces modifications. À la réouverture, le journal
   * n'est appliqué que si le plan enregistré est TOUJOURS à cette version ; sinon (modifié
   * ailleurs entre-temps), il est enregistré comme copie — jamais par-dessus.
   */
  baseVersion?: number;
}

export function writeRecovery(doc: PlanDocument, baseVersion?: number, now = Date.now()): void {
  try {
    localStorage.setItem(
      key(doc.plan.id),
      JSON.stringify({ writtenAt: now, baseVersion, document: JSON.parse(serializePlanDocument(doc)) }),
    );
  } catch {
    // Quota dépassé ou stockage indisponible : la sauvegarde IndexedDB reste la voie normale.
  }
}

export function readRecovery(planId: string): RecoveryEntry | null {
  try {
    const raw = localStorage.getItem(key(planId));
    if (!raw) return null;
    const entry = JSON.parse(raw) as { writtenAt?: unknown; baseVersion?: unknown; document?: unknown };
    if (typeof entry.writtenAt !== 'number') throw new Error('Journal sans date.');
    const doc = parsePlanDocument(entry.document);
    if (doc.plan.id !== planId) throw new Error('Journal d’un autre plan.');
    return {
      doc,
      writtenAt: entry.writtenAt,
      ...(typeof entry.baseVersion === 'number' ? { baseVersion: entry.baseVersion } : {}),
    };
  } catch (error) {
    // Journal illisible : conservé tel quel sous une autre clé (jamais détruit en silence).
    try {
      const raw = localStorage.getItem(key(planId));
      if (raw) localStorage.setItem(`campplanner.recovery-illisible.${planId}`, raw);
    } catch {
      // stockage plein : tant pis, l'erreur est journalisée par l'appelant
    }
    clearRecovery(planId);
    logEvent('corrupt', error, { context: `journal de récupération du plan ${planId} (conservé à part)` });
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

/**
 * Contenu brut de tous les journaux de récupération : les fichiers qu'ils référencent (photo
 * importée juste avant une fermeture brutale…) ne sont jamais considérés comme orphelins.
 */
export function recoveryJournalTexts(): string[] {
  const texts: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('campplanner.recovery')) texts.push(localStorage.getItem(k) ?? '');
    }
  } catch {
    // stockage indisponible
  }
  return texts;
}
