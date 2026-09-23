import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/app/repository.ts';
import { createPlanDocument, createSite } from '@/domain/model/factories.ts';
import { startAutosave } from '@/persistence/autosave.ts';
import { PlanConflictError } from '@/persistence/ProjectRepository.ts';
import { readRecovery, writeRecovery } from '@/persistence/recovery.ts';
import { createPlanStore, selectIsDirty } from '@/store/planStore.ts';
import { makeDocument, makeZone } from '@/test/fixtures.ts';
import { addObject } from '@/domain/model/operations.ts';
import { persistOpenPlan, SaveSkippedError, useSessionStore } from './sessionStore.ts';
import { applyRecoveryJournal } from './usePlanSession.ts';

beforeEach(() => localStorage.clear());

async function storedPlan(name = 'Plan') {
  const site = createSite('Camp');
  await repository.saveSite(site);
  const doc = createPlanDocument({ siteId: site.id, name });
  const version = await repository.savePlan(doc);
  return { doc, version };
}

describe('écritures refusées : jamais marquées « enregistré »', () => {
  it('lecture seule / conflit : le plan reste non enregistré', async () => {
    vi.useFakeTimers();
    const store = createPlanStore();
    const doc = makeDocument();
    store.getState().load(doc);
    const autosave = startAutosave({
      store,
      delayMs: 100,
      save: async () => {
        throw new SaveSkippedError('lecture seule');
      },
    });
    store.getState().update('ajout', (d) => addObject(d, makeZone(doc.layers[0]!.id)));
    await vi.advanceTimersByTimeAsync(500);
    await autosave.flush();
    expect(selectIsDirty(store.getState())).toBe(true);
    autosave.dispose();
    vi.useRealTimers();
  });

  it('plan sans session : écriture sans contrôle de version refusée', async () => {
    const { doc } = await storedPlan();
    await expect(persistOpenPlan(doc)).rejects.toBeInstanceOf(SaveSkippedError);
  });

  it('écriture finale d’un plan quitté : SA version est vérifiée, même si un autre plan est ouvert', async () => {
    const x = await storedPlan('X');
    const y = await storedPlan('Y');
    const session = useSessionStore.getState();
    const tokenX = session.begin(x.doc.plan.id, null);
    session.setVersion(x.doc.plan.id, x.version);
    session.begin(y.doc.plan.id, null); // on passe à Y avant la fin de l'écriture de X
    await repository.savePlan(x.doc, { expectedVersion: x.version }); // autre onglet
    await expect(persistOpenPlan(x.doc)).rejects.toBeInstanceOf(PlanConflictError);
    expect(useSessionStore.getState().sessions[x.doc.plan.id]?.conflict?.reason).toBe('version');
    session.end(x.doc.plan.id, tokenX);
    expect(useSessionStore.getState().planId).toBe(y.doc.plan.id);
  });
});

describe('journal de récupération à version contrôlée', () => {
  it('plan inchangé depuis : journal appliqué', async () => {
    const { doc, version } = await storedPlan();
    const edited = structuredClone(doc);
    edited.plan.titleBlock.notes = 'récupéré';
    writeRecovery(edited, version);
    await applyRecoveryJournal(doc.plan.id);
    expect((await repository.loadPlan(doc.plan.id))!.plan.titleBlock.notes).toBe('récupéré');
    expect(readRecovery(doc.plan.id)).toBeNull();
  });

  it('plan modifié ailleurs depuis : journal enregistré comme COPIE, jamais par-dessus', async () => {
    const { doc, version } = await storedPlan('Original');
    const edited = structuredClone(doc);
    edited.plan.titleBlock.notes = 'onglet fermé brutalement';
    writeRecovery(edited, version);
    const other = structuredClone(doc);
    other.plan.titleBlock.notes = 'autre onglet';
    await repository.savePlan(other, { expectedVersion: version });
    await applyRecoveryJournal(doc.plan.id);
    expect((await repository.loadPlan(doc.plan.id))!.plan.titleBlock.notes).toBe('autre onglet');
    const plans = await repository.listPlans(doc.plan.siteId);
    const copy = plans.find((p) => p.id !== doc.plan.id)!;
    expect(copy.name).toMatch(/récupéré/);
    expect((await repository.loadPlan(copy.id))!.plan.titleBlock.notes).toBe('onglet fermé brutalement');
    expect(readRecovery(doc.plan.id)).toBeNull();
  });

  it('écriture finale déjà faite avant la fermeture : aucune copie parasite', async () => {
    const { doc, version } = await storedPlan();
    const edited = structuredClone(doc);
    edited.plan.titleBlock.notes = 'final';
    writeRecovery(edited, version);
    await repository.savePlan(edited, { expectedVersion: version }); // l'écriture a abouti
    await applyRecoveryJournal(doc.plan.id);
    expect(await repository.listPlans(doc.plan.siteId)).toHaveLength(1);
  });
});
