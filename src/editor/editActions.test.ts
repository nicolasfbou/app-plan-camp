import { beforeEach, describe, expect, it } from 'vitest';
import { createAreaObject, createTextObject } from '@/domain/model/objectFactory.ts';
import type { PlanObject } from '@/domain/model/types.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { makeDocument } from '@/test/fixtures.ts';
import { editActions } from './editActions.ts';

const doc = () => planStore.getState().doc!;
const objects = () => Object.values(doc().objects);
let rect: PlanObject;

beforeEach(() => {
  planStore.getState().load(makeDocument());
  useEditorStore.getState().reset();
  useViewportStore.getState().setViewport({ scale: 0.5, x: 0, y: 0 });
  rect = createAreaObject(
    doc(),
    { kind: 'rect', x: 100, y: 100, width: 50, height: 40, cornerRadius: 0 },
    'zone.storage',
    0.5,
  );
  editActions.create(rect, 'Créer');
});

describe('commandes d’édition', () => {
  it('création : sélectionne l’objet et revient à l’outil Sélection ; épaisseur selon le zoom', () => {
    expect(useEditorStore.getState()).toMatchObject({ selectedIds: [rect.id], tool: 'select' });
    expect(rect.style.strokeWidth).toBe(6); // 3 px écran à 50 % = 6 px image
  });

  it('duplication : nouvel identifiant, décalage de 16 px écran (32 px image à 50 %)', () => {
    editActions.duplicateSelected();
    const copy = objects().find((o) => o.id !== rect.id)!;
    expect(copy.geometry).toMatchObject({ x: 132, y: 132 });
    expect(useEditorStore.getState().selectedIds).toEqual([copy.id]);
  });

  it('copier / coller : chaque collage est un nouvel objet, décalé un peu plus', () => {
    editActions.copySelected();
    editActions.paste();
    editActions.paste();
    expect(objects()).toHaveLength(3);
    expect(new Set(objects().map((o) => o.id)).size).toBe(3);
    const xs = objects()
      .map((o) => (o.geometry as { x: number }).x)
      .sort((a, b) => a - b);
    expect(xs).toEqual([100, 132, 164]);
  });

  it('suppression, puis annulation', () => {
    expect(editActions.deleteSelected()).toBe(true);
    expect(objects()).toHaveLength(0);
    planStore.getState().undo();
    expect(objects()).toHaveLength(1);
  });

  it('objet verrouillé : ni suppression ni déplacement clavier', () => {
    planStore.getState().update('lock', (d) => void (d.objects[rect.id]!.locked = true));
    expect(editActions.deleteSelected()).toBe(false);
    editActions.nudge(10, 0);
    expect(doc().objects[rect.id]!.geometry).toMatchObject({ x: 100 });
  });

  it('fin de geste du Transformer : une action, échelle intégrée ; un clic sans mouvement : aucune action', () => {
    const before = planStore.getState().past.length;
    editActions.commitNodeTransform(
      rect.id,
      { x: 125, y: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      'Déplacer',
    );
    expect(planStore.getState().past.length).toBe(before);
    editActions.commitNodeTransform(
      rect.id,
      { x: 125, y: 120, rotation: 15, scaleX: 2, scaleY: 1 },
      'Transformer',
    );
    expect(planStore.getState().past.length).toBe(before + 1);
    expect(doc().objects[rect.id]).toMatchObject({ rotation: 15, geometry: { width: 100, height: 40 } });
  });

  it('glisser un sommet : une seule action pour tout le geste', () => {
    const poly = createAreaObject(
      doc(),
      {
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 0, y: 10 },
        ],
      },
      'zone.snow',
    );
    editActions.create(poly, 'Créer');
    const before = planStore.getState().past.length;
    editActions.beginVertexDrag();
    for (let i = 1; i <= 30; i++) editActions.moveVertex(poly.id, 0, { x: -i, y: -i });
    editActions.endVertexDrag();
    expect(planStore.getState().past.length).toBe(before + 1);
    expect((doc().objects[poly.id]!.geometry as { points: { x: number }[] }).points[0]).toEqual({
      x: -30,
      y: -30,
    });
    planStore.getState().undo();
    expect((doc().objects[poly.id]!.geometry as { points: { x: number }[] }).points[0]).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('texte : créé à une taille lisible au zoom courant', () => {
    const text = createTextObject(doc(), { x: 0, y: 0 }, { label: false, text: 'A', fontSize: 44 });
    editActions.create(text, 'Créer');
    expect(doc().objects[text.id]).toMatchObject({ type: 'text', fontSize: 44 });
  });
});

describe('corrections de la revue', () => {
  it('aucun objet créé dans un calque masqué ou verrouillé : refus avec message', () => {
    const zonesLayer = doc().layers.find((l) => l.tier === 'zones')!;
    planStore
      .getState()
      .update('lock', (d) => void (d.layers.find((l) => l.id === zonesLayer.id)!.locked = true));
    const other = createAreaObject(
      doc(),
      { kind: 'rect', x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 },
      'zone.waste',
    );
    expect(editActions.create(other, 'Créer')).toBe(false);
    expect(doc().objects[other.id]).toBeUndefined();
    expect(useEditorStore.getState().notice).toMatch(/masqué ou verrouillé/);
  });

  it('dupliquer / coller vers un calque masqué : refusé', () => {
    const zonesLayer = doc().layers.find((l) => l.tier === 'zones')!;
    editActions.copySelected();
    planStore
      .getState()
      .update('hide', (d) => void (d.layers.find((l) => l.id === zonesLayer.id)!.visible = false));
    editActions.duplicateSelected();
    editActions.paste();
    expect(objects()).toHaveLength(1);
  });

  it('changer de calque : placé au-dessus des objets du nouveau calque ; calque verrouillé refusé', () => {
    const buildings = doc().layers.find((l) => l.tier === 'buildings')!;
    const b = createAreaObject(
      doc(),
      { kind: 'rect', x: 0, y: 0, width: 5, height: 5, cornerRadius: 0 },
      'building.office',
    );
    editActions.create(b, 'Créer');
    editActions.replace({ ...doc().objects[rect.id]!, layerId: buildings.id }, 'Changer de calque');
    expect(doc().objects[rect.id]).toMatchObject({ layerId: buildings.id, zIndex: 1 });
    const texts = doc().layers.find((l) => l.tier === 'texts')!;
    planStore.getState().update('lock', (d) => void (d.layers.find((l) => l.id === texts.id)!.locked = true));
    editActions.replace({ ...doc().objects[rect.id]!, layerId: texts.id }, 'Changer de calque');
    expect(doc().objects[rect.id]!.layerId).toBe(buildings.id);
  });

  it('un 2e doigt annule le geste en cours : forme en cours effacée, glisser de sommet annulé, aucune action', () => {
    const poly = createAreaObject(
      doc(),
      {
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 0, y: 10 },
        ],
      },
      'zone.snow',
    );
    editActions.create(poly, 'Créer');
    const before = planStore.getState().past.length;
    editActions.beginVertexDrag();
    editActions.moveVertex(poly.id, 0, { x: -50, y: -50 });
    useEditorStore
      .getState()
      .setDraft({ kind: 'box', tool: 'rect', start: { x: 0, y: 0 }, end: { x: 5, y: 5 } });
    let stopped = 0;
    const fakeStage = { find: () => [{ isDragging: () => true, stopDrag: () => void stopped++ }] };
    editActions.cancelActiveGesture(fakeStage);
    editActions.endVertexDrag();
    expect(stopped).toBe(1);
    expect(useEditorStore.getState().draft).toBeNull();
    expect(planStore.getState().past.length).toBe(before);
    expect((doc().objects[poly.id]!.geometry as { points: { x: number }[] }).points[0]).toEqual({
      x: 0,
      y: 0,
    });
  });
});
