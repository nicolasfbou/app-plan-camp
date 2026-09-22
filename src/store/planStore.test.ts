import { beforeEach, describe, expect, it } from 'vitest';
import { addObject, moveObject, removeObject } from '@/domain/model/operations.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { serializePlanDocument } from '@/domain/schema/serialization.ts';
import { makeDocument, makeLargeDocument, makeZone } from '@/test/fixtures.ts';
import { HISTORY_LIMIT, type PlanStore, createPlanStore, selectCanUndo, selectIsDirty } from './planStore.ts';

let store: PlanStore;
let zonesLayer: string;

const state = () => store.getState();
const geometryOf = (id: string) => state().doc!.objects[id]!.geometry;

beforeEach(() => {
  store = createPlanStore();
  const doc = makeDocument();
  zonesLayer = doc.layers.find((l) => l.tier === 'zones')!.id;
  state().load(doc);
});

describe('annuler / rétablir', () => {
  it('annule puis rétablit un ajout d’objet', () => {
    const zone = makeZone(zonesLayer);
    state().update('Ajouter zone', (d) => addObject(d, zone));
    expect(state().doc!.objects[zone.id]).toBeDefined();
    state().undo();
    expect(state().doc!.objects[zone.id]).toBeUndefined();
    state().redo();
    expect(state().doc!.objects[zone.id]).toEqual(zone);
  });

  it('une nouvelle action vide la pile « rétablir »', () => {
    state().update('a', (d) => addObject(d, makeZone(zonesLayer)));
    state().undo();
    expect(state().future).toHaveLength(1);
    state().update('b', (d) => addObject(d, makeZone(zonesLayer)));
    expect(state().future).toHaveLength(0);
  });

  it('conserve au moins 100 actions et revient exactement à l’état initial', () => {
    const initial = serializePlanDocument(state().doc!);
    const zone = makeZone(zonesLayer);
    state().update('ajout', (d) => addObject(d, zone));
    for (let i = 0; i < 120; i++) state().update(`move ${i}`, (d) => moveObject(d, zone.id, 1, 2));
    expect(state().past.length).toBeGreaterThanOrEqual(100);

    const afterAll = serializePlanDocument(state().doc!);
    while (selectCanUndo(state())) state().undo();
    expect(serializePlanDocument(state().doc!)).toBe(initial);
    while (state().future.length) state().redo();
    expect(serializePlanDocument(state().doc!)).toBe(afterAll);
  });

  it(`limite l’historique à ${HISTORY_LIMIT} entrées`, () => {
    const zone = makeZone(zonesLayer);
    state().update('ajout', (d) => addObject(d, zone));
    for (let i = 0; i < HISTORY_LIMIT + 50; i++) state().update('move', (d) => moveObject(d, zone.id, 1, 0));
    expect(state().past).toHaveLength(HISTORY_LIMIT);
  });

  it('ignore une modification sans effet', () => {
    state().update('rien', () => {});
    expect(state().past).toHaveLength(0);
  });
});

describe('interaction continue = une seule action', () => {
  it('150 déplacements pendant un glisser donnent 1 entrée d’historique', () => {
    const zone = makeZone(zonesLayer, 100, 200);
    state().update('ajout', (d) => addObject(d, zone));
    const pastBefore = state().past.length;
    const revisionBefore = state().revision;

    state().beginTransaction('Déplacer');
    for (let i = 0; i < 150; i++) state().update('drag', (d) => moveObject(d, zone.id, 2, 1));
    // Pendant le glisser, la révision ne bouge pas : aucune sauvegarde ne se déclenche.
    expect(state().revision).toBe(revisionBefore);
    state().commitTransaction();

    expect(state().past).toHaveLength(pastBefore + 1);
    expect(state().past.at(-1)!.label).toBe('Déplacer');
    expect(geometryOf(zone.id)).toMatchObject({ x: 400, y: 350 });

    state().undo();
    expect(geometryOf(zone.id)).toMatchObject({ x: 100, y: 200 });
    state().redo();
    expect(geometryOf(zone.id)).toMatchObject({ x: 400, y: 350 });
  });

  it('annuler une transaction en cours restaure l’état d’avant le geste', () => {
    const zone = makeZone(zonesLayer, 10, 10);
    state().update('ajout', (d) => addObject(d, zone));
    const pastBefore = state().past.length;
    state().beginTransaction('Déplacer');
    for (let i = 0; i < 20; i++) state().update('drag', (d) => moveObject(d, zone.id, 5, 5));
    state().cancelTransaction();
    expect(geometryOf(zone.id)).toMatchObject({ x: 10, y: 10 });
    expect(state().past).toHaveLength(pastBefore);
  });

  it('Ctrl+Z pendant un geste valide d’abord le geste puis l’annule', () => {
    const zone = makeZone(zonesLayer, 0, 0);
    state().update('ajout', (d) => addObject(d, zone));
    state().beginTransaction('Déplacer');
    state().update('drag', (d) => moveObject(d, zone.id, 50, 0));
    state().undo();
    expect(geometryOf(zone.id)).toMatchObject({ x: 0, y: 0 });
    expect(state().pending).toBeNull();
  });

  it('une transaction plusieurs opérations (ajout + suppression) s’annule en bloc', () => {
    const a = makeZone(zonesLayer);
    const b = makeZone(zonesLayer);
    state().update('a', (d) => addObject(d, a));
    state().beginTransaction('Remplacer');
    state().update('x', (d) => removeObject(d, a.id));
    state().update('y', (d) => addObject(d, b));
    state().commitTransaction();
    state().undo();
    expect(Object.keys(state().doc!.objects)).toEqual([a.id]);
  });
});

describe('indicateur de modifications non enregistrées', () => {
  it('passe à « non enregistré » après une modification et revient après markSaved', () => {
    expect(selectIsDirty(state())).toBe(false);
    state().update('a', (d) => addObject(d, makeZone(zonesLayer)));
    expect(selectIsDirty(state())).toBe(true);
    state().markSaved(state().revision);
    expect(selectIsDirty(state())).toBe(false);
  });

  it('est « non enregistré » pendant un geste en cours', () => {
    const zone = makeZone(zonesLayer);
    state().update('a', (d) => addObject(d, zone));
    state().markSaved(state().revision);
    state().beginTransaction('drag');
    state().update('drag', (d) => moveObject(d, zone.id, 1, 1));
    expect(selectIsDirty(state())).toBe(true);
  });
});

describe('gros projets', () => {
  it('gère 800 objets : modification, annulation, sérialisation en temps raisonnable', () => {
    const doc: PlanDocument = makeLargeDocument(800);
    const start = performance.now();
    state().load(doc);
    const ids = Object.keys(doc.objects);
    state().beginTransaction('drag');
    for (let i = 0; i < 60; i++) state().update('drag', (d) => moveObject(d, ids[i % ids.length]!, 1, 1));
    state().commitTransaction();
    state().undo();
    const json = serializePlanDocument(state().doc!);
    const elapsed = performance.now() - start;

    expect(Object.keys(state().doc!.objects)).toHaveLength(800);
    expect(json).toBe(serializePlanDocument(doc));
    expect(elapsed).toBeLessThan(2000);
  });

  it('partage la structure : un objet non modifié garde la même référence', () => {
    const doc = makeLargeDocument(300);
    state().load(doc);
    const [first, second] = Object.keys(doc.objects);
    state().update('move', (d) => moveObject(d, first!, 3, 3));
    expect(state().doc!.objects[second!]).toBe(doc.objects[second!]);
    expect(state().doc!.objects[first!]).not.toBe(doc.objects[first!]);
  });
});

describe('fusion des modifications répétées', () => {
  it('des flèches clavier rapprochées forment une seule action ; des clés différentes non', () => {
    const zone = makeZone(zonesLayer, 0, 0);
    state().update('ajout', (d) => addObject(d, zone));
    const before = state().past.length;
    for (let i = 0; i < 10; i++)
      state().update('Déplacer', (d) => moveObject(d, zone.id, 1, 0), { mergeKey: `nudge:${zone.id}` });
    expect(state().past.length).toBe(before + 1);
    state().update('Nom', (d) => void (d.objects[zone.id]!.name = 'X'), { mergeKey: `name:${zone.id}` });
    expect(state().past.length).toBe(before + 2);
    state().undo();
    state().undo();
    expect(geometryOf(zone.id)).toMatchObject({ x: 0 });
  });
});
