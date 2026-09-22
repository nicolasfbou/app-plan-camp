import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addObject, moveObject } from '@/domain/model/operations.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { type PlanStore, createPlanStore, selectIsDirty } from '@/store/planStore.ts';
import { makeDocument, makeZone } from '@/test/fixtures.ts';
import { type Autosave, startAutosave } from './autosave.ts';

let store: PlanStore;
let autosave: Autosave;
let saved: PlanDocument[];
let layerId: string;

beforeEach(() => {
  vi.useFakeTimers();
  store = createPlanStore();
  const doc = makeDocument();
  layerId = doc.layers[0]!.id;
  store.getState().load(doc);
  saved = [];
  autosave = startAutosave({ store, delayMs: 1000, save: async (d) => void saved.push(d) });
});

afterEach(() => {
  autosave.dispose();
  vi.useRealTimers();
});

describe('sauvegarde automatique', () => {
  it('ne sauvegarde pas l’ouverture d’un plan', async () => {
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved).toHaveLength(0);
  });

  it('regroupe des modifications rapprochées en une seule écriture après inactivité', async () => {
    for (let i = 0; i < 5; i++) {
      store.getState().update('ajout', (d) => addObject(d, makeZone(layerId)));
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]!.objects)).toHaveLength(5);
    expect(selectIsDirty(store.getState())).toBe(false);
  });

  it('n’écrit jamais pendant un glisser, puis écrit une fois le geste terminé', async () => {
    const zone = makeZone(layerId);
    store.getState().update('ajout', (d) => addObject(d, zone));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toHaveLength(1);

    store.getState().beginTransaction('drag');
    for (let i = 0; i < 100; i++) {
      store.getState().update('drag', (d) => moveObject(d, zone.id, 1, 0));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(saved).toHaveLength(1);
    store.getState().commitTransaction();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toHaveLength(2);
    expect(saved[1]!.objects[zone.id]!.geometry).toMatchObject({ x: 200 });
  });

  it('flush écrit immédiatement les modifications en attente', async () => {
    store.getState().update('ajout', (d) => addObject(d, makeZone(layerId)));
    await autosave.flush();
    expect(saved).toHaveLength(1);
  });

  it('garde l’indicateur « non enregistré » si l’écriture échoue', async () => {
    autosave.dispose();
    const errors: unknown[] = [];
    autosave = startAutosave({
      store,
      delayMs: 10,
      save: () => Promise.reject(new Error('Disque plein')),
      onError: (e) => errors.push(e),
    });
    store.getState().update('ajout', (d) => addObject(d, makeZone(layerId)));
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toHaveLength(1);
    expect(selectIsDirty(store.getState())).toBe(true);
  });
});

describe('changement de plan', () => {
  it('écrit immédiatement les modifications du plan quitté', async () => {
    const zone = makeZone(layerId);
    store.getState().update('ajout', (d) => addObject(d, zone));
    const leaving = store.getState().doc!;
    store.getState().load(makeDocument());
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual([leaving]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved).toHaveLength(1);
  });

  it('une écriture qui se termine après l’ouverture d’un autre plan ne le marque pas « non enregistré »', async () => {
    autosave.dispose();
    let release!: () => void;
    autosave = startAutosave({
      store,
      delayMs: 10,
      save: () => new Promise<void>((resolve) => (release = resolve)),
    });
    store.getState().update('ajout', (d) => addObject(d, makeZone(layerId)));
    await vi.advanceTimersByTimeAsync(10);
    store.getState().load(makeDocument());
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(selectIsDirty(store.getState())).toBe(false);
  });
});
