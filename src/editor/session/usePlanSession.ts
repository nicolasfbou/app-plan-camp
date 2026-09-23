/**
 * Ouverture d'un plan : verrou d'édition local (un seul onglet modifie le plan, les autres le
 * lisent), chargement validé avec sa version, sauvegarde automatique à version contrôlée (conflit
 * affiché plutôt qu'écrasement), écriture forcée quand l'onglet est masqué ou fermé, journal de
 * récupération relu après une fermeture brutale.
 *
 * Règles anti-perte :
 * - une écriture refusée (lecture seule, conflit) laisse le plan « non enregistré » (avertissement
 *   à la fermeture, journal de récupération) ;
 * - l'onglet ne cède la main que si tout est enregistré ; un document modifié n'est jamais
 *   remplacé par la version d'un autre onglet (conflit « main reprise » à la place) ;
 * - le journal de récupération porte la version sur laquelle il repose : appliqué seulement si le
 *   plan enregistré n'a pas changé depuis, sinon enregistré comme copie.
 */
import { useEffect, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { duplicatePlanDocument, nowIso } from '@/domain/model/factories.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import { t } from '@/i18n/index.ts';
import { startAutosave } from '@/persistence/autosave.ts';
import { acquirePlanLock, type LockMode } from '@/persistence/planLock.ts';
import { PlanConflictError } from '@/persistence/ProjectRepository.ts';
import {
  clearRecovery,
  clearRecoveryIfCovered,
  readRecovery,
  writeRecovery,
} from '@/persistence/recovery.ts';
import { planStore, selectIsDirty } from '@/store/planStore.ts';
import { persistOpenPlan, planSession, SaveSkippedError, useSessionStore } from './sessionStore.ts';

export type SessionState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

/** Relit le plan enregistré (version comprise) et remplace le document ouvert. */
export async function reloadOpenPlan(planId: string): Promise<void> {
  const opened = await repository.openPlan(planId);
  if (!opened) throw new Error(t('plans.notFound'));
  const readOnly = planStore.getState().readOnly;
  planStore.getState().load(opened.doc);
  planStore.getState().setReadOnly(readOnly);
  useSessionStore.getState().setVersion(planId, opened.version);
  useSessionStore.getState().setConflict(planId, null);
}

const dirtyDocOf = (planId: string) => {
  const s = planStore.getState();
  return s.doc?.plan.id === planId && selectIsDirty(s) ? { doc: s.doc, revision: s.revision } : null;
};

/**
 * Journal de récupération d'une fermeture brutale : appliqué s'il est plus récent que la dernière
 * écriture ET si le plan enregistré est encore à la version sur laquelle il repose ; sinon
 * enregistré comme copie (jamais par-dessus une version écrite ailleurs entre-temps).
 */
export async function applyRecoveryJournal(planId: string): Promise<void> {
  const recovered = readRecovery(planId);
  if (!recovered) return;
  const opened = await repository.openPlan(planId);
  if (!opened) {
    // Plan supprimé : le journal est gardé (visible dans le nettoyage, jamais effacé en silence).
    logEvent('recovery', 'Journal de récupération d’un plan absent : conservé.', {
      level: 'warn',
      context: `plan ${planId}`,
    });
    return;
  }
  const savedAt = await repository.getPlanSavedAt(planId);
  const base = recovered.baseVersion;
  // Déjà enregistré (l'écriture finale a abouti avant la fermeture) : rien à faire.
  const same = JSON.stringify(opened.doc) === JSON.stringify(recovered.doc);
  const covered = base === undefined && savedAt !== undefined && recovered.writtenAt <= savedAt;
  if (same || covered) return clearRecovery(planId);
  const upToDate = base === undefined || base === opened.version;
  try {
    if (!upToDate) throw new PlanConflictError(planId, opened.version, base);
    await repository.savePlan(recovered.doc, { expectedVersion: opened.version });
    logEvent('recovery', 'Modifications récupérées après une fermeture brutale.', {
      level: 'info',
      context: `plan ${planId}`,
    });
  } catch (error) {
    if (!(error instanceof PlanConflictError)) throw error;
    // Le plan a changé depuis (autre onglet) : les modifications récupérées vont dans une copie.
    const copy = duplicatePlanDocument(
      recovered.doc,
      t('session.recoveredCopyName', {
        name: recovered.doc.plan.name,
        date: nowIso().slice(0, 16).replace('T', ' '),
      }),
    );
    await repository.savePlan(copy);
    logEvent('recovery', 'Modifications récupérées enregistrées dans une copie (plan modifié ailleurs).', {
      level: 'warn',
      context: `plan ${planId} → copie ${copy.plan.id}`,
    });
  }
  clearRecovery(planId);
}

export function usePlanSession(planId: string) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Le composant appelant est remonté pour chaque plan : l'état initial est déjà « loading ».
    let cancelled = false;
    const lock = acquirePlanLock(planId);
    const token = useSessionStore.getState().begin(planId, lock);
    const session = () => planSession(planId);

    const firstMode = new Promise<LockMode>((resolve) => {
      if (lock.mode !== 'pending') return resolve(lock.mode);
      const off = lock.subscribe((mode) => {
        off();
        resolve(mode);
      });
      // Verrou indisponible (API absente ou bloquée) : on ouvre, les conflits restent détectés.
      setTimeout(() => resolve(lock.mode === 'pending' ? 'unsupported' : lock.mode), 2000);
    });

    // Journal (synchrone) des modifications non enregistrées, avec leur version de base.
    const journal = () => {
      const dirty = dirtyDocOf(planId);
      if (dirty) writeRecovery(dirty.doc, session()?.version);
    };

    let loaded = false;
    lock.subscribe((mode) => {
      useSessionStore.getState().setLockMode(planId, mode);
      if (mode === 'readonly') {
        planStore.getState().setReadOnly(true);
        logEvent('lock', 'Plan ouvert ailleurs : lecture seule.', {
          level: 'info',
          context: `plan ${planId}`,
        });
        // Main retirée (onglet figé puis « reprendre la main » forcé) avec des modifications ici :
        // conservées (journal) et signalées ; jamais remplacées par la version de l'autre onglet.
        if (dirtyDocOf(planId)) {
          journal();
          useSessionStore.getState().setConflict(planId, {
            storedVersion: session()?.version ?? 0,
            reason: 'handover',
          });
        }
        return;
      }
      planStore.getState().setReadOnly(false);
      // Prise de la main après une lecture seule : on repart du plan tel qu'enregistré ailleurs
      // (sauf modifications locales en attente : le conflit reste ouvert pour décision).
      if (mode === 'editor' && loaded && !dirtyDocOf(planId))
        void reloadOpenPlan(planId).catch((error: unknown) =>
          logEvent('lock', error, { context: `plan ${planId}` }),
        );
    });

    (async () => {
      const mode = await firstMode;
      useSessionStore.getState().setLockMode(planId, mode);
      const editing = mode !== 'readonly';
      // Journal de récupération (fermeture brutale) : seulement par l'onglet qui édite.
      if (editing) await applyRecoveryJournal(planId);
      return { opened: await repository.openPlan(planId), editing };
    })().then(
      ({ opened, editing }) => {
        if (cancelled) return;
        if (!opened) return setState({ status: 'error', message: t('plans.notFound') });
        planStore.getState().load(opened.doc);
        planStore.getState().setReadOnly(!editing || lock.mode === 'readonly');
        useSessionStore.getState().setVersion(planId, opened.version);
        loaded = true;
        setState({ status: 'ready' });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logEvent(/migration|format/i.test(message) ? 'migration' : 'corrupt', error, {
          context: `plan ${planId}`,
        });
        setState({ status: 'error', message: t('plans.loadError', { message }) });
      },
    );

    const autosave = startAutosave({
      store: planStore,
      save: async (doc) => {
        // Lecture seule ou conflit en cours : `persistOpenPlan` refuse (erreur) et le plan reste
        // « non enregistré » — jamais marqué enregistré sans écriture.
        const startedAt = Date.now();
        await persistOpenPlan(doc);
        clearRecoveryIfCovered(doc.plan.id, startedAt);
        setSaveError(null);
      },
      onError: (error) => {
        if (error instanceof SaveSkippedError) return;
        if (!(error instanceof PlanConflictError)) logEvent('storage', error, { context: `plan ${planId}` });
        setSaveError(error instanceof Error ? error.message : String(error));
      },
    });
    // Avant de céder la main à un autre onglet : écrire ; céder seulement si tout est enregistré.
    lock.onBeforeRelease(async () => {
      const dirty = dirtyDocOf(planId);
      if (dirty) await autosave.flush(dirty);
      const clean = !dirtyDocOf(planId) && !session()?.conflict;
      if (clean) planStore.getState().setReadOnly(true); // plus aucune modification à partir d'ici
      return clean;
    });
    // Un autre onglet a enregistré : un lecteur se met à jour (jamais par-dessus des modifications).
    lock.onRemoteSaved((version) => {
      if (!planStore.getState().readOnly || !loaded) return;
      if (dirtyDocOf(planId)) {
        useSessionStore.getState().setConflict(planId, { storedVersion: version, reason: 'handover' });
        return;
      }
      void reloadOpenPlan(planId).catch((error: unknown) =>
        logEvent('lock', error, { context: `plan ${planId}` }),
      );
    });

    // Fermeture de page : l'écriture IndexedDB est asynchrone et peut ne pas aboutir. On écrit
    // donc aussi, de façon synchrone, un journal de récupération relu à la prochaine ouverture.
    const flush = () => {
      journal();
      void autosave.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (selectIsDirty(planStore.getState())) event.preventDefault();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Document de CE plan capturé maintenant (avant qu'un autre plan ne soit chargé) ; journal
      // écrit par sécurité, puis écriture finale à version contrôlée, puis fermeture du plan.
      const final = dirtyDocOf(planId);
      if (final) journal();
      autosave.dispose();
      void (final ? autosave.flush(final) : Promise.resolve()).finally(() => {
        lock.release();
        useSessionStore.getState().end(planId, token);
        if (planStore.getState().doc?.plan.id === planId && !useSessionStore.getState().sessions[planId]) {
          planStore.getState().load(null);
          planStore.getState().setReadOnly(false);
        }
      });
    };
  }, [planId]);

  return { state, saveError };
}
