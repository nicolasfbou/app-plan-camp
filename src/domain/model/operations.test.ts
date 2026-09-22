import { beforeEach, describe, expect, it } from 'vitest';
import { parsePlanDocument, serializePlanDocument } from '../schema/serialization.ts';
import { createAreaObject, createLineObject, createTextObject } from './objectFactory.ts';
import {
  addObject,
  insertCopy,
  isDisplayed,
  isEditable,
  moveObject,
  objectsInRenderOrder,
  removeObject,
  reorderObject,
  replaceObject,
  setLayerFlag,
} from './operations.ts';
import { makeDocument } from '@/test/fixtures.ts';
import type { PlanDocument, PlanObject } from './types.ts';

let doc: PlanDocument;
let a: PlanObject;
let b: PlanObject;
let c: PlanObject;

beforeEach(() => {
  doc = makeDocument();
  for (const o of [
    createAreaObject(
      doc,
      { kind: 'rect', x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 },
      'zone.parking',
    ),
  ])
    addObject(doc, (a = o));
  addObject(doc, (b = createAreaObject(doc, { kind: 'ellipse', cx: 5, cy: 5, rx: 5, ry: 5 }, 'zone.waste')));
  addObject(
    doc,
    (c = createAreaObject(
      doc,
      {
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 9, y: 0 },
          { x: 0, y: 9 },
        ],
      },
      'zone.snow',
    )),
  );
});

const order = () => objectsInRenderOrder(doc).map((o) => o.id);

describe('sérialisation de tous les types créés', () => {
  it('aller-retour exact', () => {
    addObject(
      doc,
      createLineObject(doc, {
        kind: 'polyline',
        curved: false,
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      }),
    );
    addObject(doc, createTextObject(doc, { x: 5, y: 6 }, { label: true, text: 'Cuisine', fontSize: 30 }));
    expect(parsePlanDocument(serializePlanDocument(doc))).toEqual(doc);
  });
});

describe('z-index à l’intérieur du calque', () => {
  it('premier plan, arrière-plan, avancer, reculer', () => {
    expect(order()).toEqual([a.id, b.id, c.id]);
    reorderObject(doc, a.id, 'front');
    expect(order()).toEqual([b.id, c.id, a.id]);
    reorderObject(doc, a.id, 'back');
    expect(order()).toEqual([a.id, b.id, c.id]);
    reorderObject(doc, a.id, 'forward');
    expect(order()).toEqual([b.id, a.id, c.id]);
    reorderObject(doc, c.id, 'backward');
    expect(order()).toEqual([b.id, c.id, a.id]);
    expect(reorderObject(doc, a.id, 'front')).toBe(false); // déjà devant
  });

  it('un objet d’un calque inférieur reste dessous, quel que soit son zIndex', () => {
    const building = createAreaObject(
      doc,
      { kind: 'rect', x: 0, y: 0, width: 1, height: 1, cornerRadius: 0 },
      'building.office',
    );
    addObject(doc, building);
    reorderObject(doc, a.id, 'front');
    const ids = order();
    expect(ids.indexOf(building.id)).toBeGreaterThan(ids.indexOf(a.id));
  });
});

describe('copie, duplication, suppression', () => {
  it('insertCopy : nouvel identifiant, décalée, au-dessus, déverrouillée', () => {
    doc.objects[a.id]!.locked = true;
    const copy = insertCopy(doc, doc.objects[a.id]!, 16, 16);
    expect(copy.id).not.toBe(a.id);
    expect(copy.geometry).toMatchObject({ x: 16, y: 16 });
    expect(copy.locked).toBe(false);
    expect(order().at(-1)).toBe(copy.id);
    expect(doc.objects[a.id]!.geometry).toMatchObject({ x: 0, y: 0 });
  });

  it('suppression', () => {
    expect(removeObject(doc, b.id)).toBe(true);
    expect(doc.objects[b.id]).toBeUndefined();
  });
});

describe('verrouillage', () => {
  it('objet verrouillé : ni déplacé, ni modifié, ni supprimé ; déverrouillable', () => {
    doc.objects[a.id]!.locked = true;
    moveObject(doc, a.id, 50, 50);
    expect(doc.objects[a.id]!.geometry).toMatchObject({ x: 0, y: 0 });
    expect(removeObject(doc, a.id)).toBe(false);
    expect(replaceObject(doc, { ...doc.objects[a.id]!, name: 'Autre' })).toBe(false);
    expect(reorderObject(doc, a.id, 'front')).toBe(false);
    expect(replaceObject(doc, { ...doc.objects[a.id]!, locked: false })).toBe(true);
    moveObject(doc, a.id, 5, 0);
    expect(doc.objects[a.id]!.geometry).toMatchObject({ x: 5 });
  });

  it('calque verrouillé : ses objets ne sont plus modifiables', () => {
    setLayerFlag(doc, a.layerId, 'locked', true);
    expect(isEditable(doc, doc.objects[a.id]!)).toBe(false);
    expect(removeObject(doc, a.id)).toBe(false);
    setLayerFlag(doc, a.layerId, 'locked', false);
    expect(removeObject(doc, a.id)).toBe(true);
  });
});

describe('visibilité', () => {
  it('objet invisible ou calque masqué : non affiché', () => {
    expect(isDisplayed(doc, a)).toBe(true);
    doc.objects[a.id]!.visible = false;
    expect(isDisplayed(doc, doc.objects[a.id]!)).toBe(false);
    doc.objects[a.id]!.visible = true;
    setLayerFlag(doc, a.layerId, 'visible', false);
    expect(isDisplayed(doc, doc.objects[a.id]!)).toBe(false);
  });
});
