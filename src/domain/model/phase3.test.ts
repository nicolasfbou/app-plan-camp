import { freeze, produce } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeDocument } from '@/test/fixtures.ts';
import { addLayer, deleteLayer, duplicateLayer, moveLayer, renameLayer } from './layers.ts';
import {
  expandGroups,
  groupObjects,
  insertCopies,
  moveObjects,
  removeObjects,
  selectableIds,
  setObjectsLayer,
  setObjectsLocked,
  setObjectsStyle,
  ungroupObjects,
} from './multi.ts';
import { createAreaObject, createLineObject, createTextObject, layerForTier } from './objectFactory.ts';
import { addObject, objectsInRenderOrder } from './operations.ts';
import {
  closePolyline,
  insertVertex,
  rectToPolygon,
  removeVertex,
  segmentMidpoints,
  worldVertices,
} from './shapes.ts';
import type { PlanDocument, PlanObject } from './types.ts';

let doc: PlanDocument;
let a: PlanObject;
let b: PlanObject;
let c: PlanObject;
const rect = (x: number) => ({ kind: 'rect' as const, x, y: 0, width: 10, height: 10, cornerRadius: 0 });

beforeEach(() => {
  doc = makeDocument();
  addObject(doc, (a = createAreaObject(doc, rect(0), 'zone.parking')));
  addObject(doc, (b = createAreaObject(doc, rect(20), 'building.dormitory')));
  addObject(
    doc,
    (c = createLineObject(doc, {
      kind: 'polyline',
      curved: false,
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 0 },
      ],
    })),
  );
});

describe('gestion des calques', () => {
  it('créer, renommer, réordonner : l’ordre de rendu suit l’ordre des calques', () => {
    const top = addLayer(doc, 'Stationnement', 'zones');
    expect(doc.layers.at(-1)).toBe(top);
    expect(renameLayer(doc, top.id, 'Stationnement employés')).toBe(true);
    const zones = doc.layers.find((l) => l.tier === 'zones' && l.id !== top.id)!;
    // Zones (sous Bâtiments) déplacé tout en haut : l'objet a passe devant b.
    expect(
      objectsInRenderOrder(doc)
        .map((o) => o.id)
        .indexOf(a.id),
    ).toBeLessThan(
      objectsInRenderOrder(doc)
        .map((o) => o.id)
        .indexOf(b.id),
    );
    while (moveLayer(doc, zones.id, 1));
    const order = objectsInRenderOrder(doc).map((o) => o.id);
    expect(order.indexOf(a.id)).toBeGreaterThan(order.indexOf(b.id));
    expect(moveLayer(doc, zones.id, 1)).toBe(false);
  });

  it('dupliquer un calque copie ses objets avec de nouveaux identifiants, juste au-dessus', () => {
    const zones = doc.layers.find((l) => l.id === a.layerId)!;
    const copy = duplicateLayer(doc, zones.id, 'Zones (copie)')!;
    expect(doc.layers.indexOf(copy)).toBe(doc.layers.indexOf(zones) + 1);
    const copied = Object.values(doc.objects).filter((o) => o.layerId === copy.id);
    expect(copied).toHaveLength(1);
    expect(copied[0]!.id).not.toBe(a.id);
    expect(copied[0]!.geometry).toEqual(a.geometry);
  });

  it('dupliquer un calque dans une mise à jour Immer (brouillon Proxy), comme le fait le store', () => {
    const base = freeze(structuredClone(doc), true);
    const next = produce(base, (draft) => {
      duplicateLayer(draft, a.layerId, 'Zones (copie)');
    });
    expect(Object.keys(next.objects)).toHaveLength(Object.keys(base.objects).length + 1);
  });

  it('sans calque actif, un objet va dans le calque d’origine de sa catégorie, pas dans un calque ajouté', () => {
    const original = doc.layers.find((l) => l.tier === 'buildings')!;
    addLayer(doc, 'Dortoirs', 'buildings');
    duplicateLayer(doc, original.id, 'Bâtiments (copie)');
    expect(layerForTier(doc, 'buildings').id).toBe(original.id);
    original.locked = true;
    expect(layerForTier(doc, 'buildings').name).toBe('Bâtiments (copie)');
  });

  it('supprimer : seulement un calque vide', () => {
    const empty = addLayer(doc, 'Vide', 'signage');
    expect(deleteLayer(doc, a.layerId)).toBe(false);
    expect(deleteLayer(doc, empty.id)).toBe(true);
  });
});

describe('sélection multiple et groupes', () => {
  it('déplacement groupé : les objets verrouillés restent en place', () => {
    doc.objects[b.id]!.locked = true;
    expect(moveObjects(doc, [a.id, b.id, c.id], 5, 7)).toBe(2);
    expect(doc.objects[a.id]!.geometry).toMatchObject({ x: 5, y: 7 });
    expect(doc.objects[b.id]!.geometry).toMatchObject({ x: 20, y: 0 });
  });

  it('verrouiller des objets déjà verrouillés ne change rien (aucune entrée d’historique)', () => {
    doc.objects[a.id]!.locked = true;
    const before = doc.plan.updatedAt;
    expect(setObjectsLocked(doc, [a.id], true, '2099-01-01T00:00:00.000Z')).toBe(0);
    expect(doc.plan.updatedAt).toBe(before);
  });

  it('suppression multiple : les verrouillés sont comptés comme ignorés', () => {
    doc.objects[b.id]!.locked = true;
    expect(removeObjects(doc, [a.id, b.id])).toEqual({ removed: 1, skipped: 1 });
  });

  it('grouper / dégrouper ; un clic sur un membre sélectionne tout le groupe', () => {
    const g = groupObjects(doc, [a.id, c.id])!;
    expect(expandGroups(doc, [a.id])).toEqual(expect.arrayContaining([a.id, c.id]));
    expect(expandGroups(doc, [b.id])).toEqual([b.id]);
    expect(ungroupObjects(doc, [a.id, c.id])).toBe(2);
    expect(Object.values(doc.objects).some((o) => o.groupId === g)).toBe(false);
  });

  it('copies d’une sélection groupée : nouveaux ids, nouveau groupe distinct', () => {
    const g = groupObjects(doc, [a.id, c.id])!;
    const ids = insertCopies(doc, [doc.objects[a.id]!, doc.objects[c.id]!], 16, 16);
    expect(ids).toHaveLength(2);
    const copies = ids.map((id) => doc.objects[id]!);
    expect(copies[0]!.groupId).toBe(copies[1]!.groupId);
    expect(copies[0]!.groupId).not.toBe(g);
    expect(copies.map((o) => o.id)).not.toContain(a.id);
  });

  it('changer le calque et la couleur de plusieurs objets', () => {
    const top = addLayer(doc, 'Sécurité', 'signage');
    expect(setObjectsLayer(doc, [a.id, b.id], top.id)).toBe(2);
    expect(doc.objects[a.id]!.layerId).toBe(top.id);
    expect(setObjectsStyle(doc, [a.id, c.id], { fill: '#dc2626', stroke: '#16a34a' })).toBe(2);
    expect(doc.objects[a.id]!.style).toMatchObject({ fill: '#dc2626', stroke: '#16a34a' });
    expect(doc.objects[c.id]!.style.fill).toBeNull(); // une ligne n'a pas de remplissage
  });

  it('Ctrl+A : uniquement les objets modifiables et affichés', () => {
    doc.objects[b.id]!.locked = true;
    doc.objects[c.id]!.visible = false;
    expect(selectableIds(doc)).toEqual([a.id]);
  });

  it('un calque verrouillé ne reçoit pas d’objets', () => {
    const top = addLayer(doc, 'Verrouillé', 'zones');
    top.locked = true;
    expect(setObjectsLayer(doc, [a.id], top.id)).toBe(0);
  });
});

describe('édition avancée des sommets', () => {
  it('insérer un sommet au milieu d’un segment', () => {
    const [mid] = segmentMidpoints(c);
    const edited = insertVertex(c, mid!.afterIndex, mid!.point);
    expect(worldVertices(edited)).toEqual([
      { x: 0, y: 0 },
      { x: 2.5, y: 2.5 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ]);
  });

  it('supprimer un sommet, jamais sous le minimum (2 pour une ligne, 3 pour un polygone)', () => {
    const two = removeVertex(c, 1);
    expect(worldVertices(two)).toHaveLength(2);
    expect(removeVertex(two, 0)).toBe(two);
    const poly = createAreaObject(
      doc,
      {
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
      },
      'zone.snow',
    );
    expect(removeVertex(poly, 0)).toBe(poly);
  });

  it('fermer une polyligne en polygone', () => {
    const closed = closePolyline(c);
    expect(closed).toMatchObject({ type: 'zone', geometry: { kind: 'polygon' } });
    expect(worldVertices(closed)).toEqual(worldVertices(c));
    expect(closed.style.fill).toBe(c.style.stroke);
  });

  it('rectangle pivoté → polygone : même rendu, coins éditables', () => {
    const r = { ...a, rotation: 30 } as PlanObject;
    const poly = rectToPolygon(r);
    expect(poly).toMatchObject({ rotation: 0, geometry: { kind: 'polygon' } });
    expect(worldVertices(poly)).toHaveLength(4);
    // Le centre ne bouge pas.
    const xs = worldVertices(poly).map((p) => p.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(5, 9);
  });

  it('texte : non concerné', () => {
    const t = createTextObject(doc, { x: 0, y: 0 }, { label: true, text: 'A', fontSize: 10 });
    expect(rectToPolygon(t)).toBe(t);
    expect(closePolyline(t)).toBe(t);
  });
});
