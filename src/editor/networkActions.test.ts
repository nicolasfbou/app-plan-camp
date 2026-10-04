import { beforeEach, describe, expect, it } from 'vitest';
import { createAreaObject, createIconObject, createUtilityObject } from '@/domain/model/objectFactory.ts';
import { setLayerFlag } from '@/domain/model/operations.ts';
import type { NetworkTier, Point } from '@/domain/model/types.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { makeDocument } from '@/test/fixtures.ts';
import { editActions } from './editActions.ts';
import { networkActions, networkSummaries } from './networkActions.ts';

const P = (x: number, y: number): Point => ({ x, y });
const doc = () => planStore.getState().doc!;
const layersOf = (tier: string) => doc().layers.filter((l) => l.tier === tier);
const draw = (network: NetworkTier, points = [P(0, 0), P(100, 0)]) =>
  editActions.create(createUtilityObject(doc(), points, network), 'Tracer');

beforeEach(() => {
  planStore.getState().load(makeDocument());
  useEditorStore.getState().reset();
  useViewportStore.getState().setViewport({ scale: 1, x: 0, y: 0 });
});

describe('tracé des réseaux', () => {
  it('premier tracé : le calque du réseau est créé avec la ligne, en une seule action', () => {
    expect(draw('water')).toBe(true);
    const [water] = layersOf('water');
    expect(water?.name).toBe('Réseau d’eau potable');
    const line = Object.values(doc().objects)[0]!;
    expect(line.layerId).toBe(water!.id);
    expect(useEditorStore.getState().notice).toMatch(/Réseau d’eau potable/);
    planStore.getState().undo();
    expect(layersOf('water')).toHaveLength(0);
    expect(Object.keys(doc().objects)).toHaveLength(0);
  });

  it('chaque réseau dans son calque ; un calque actif d’une autre catégorie est ignoré', () => {
    const zones = doc().layers.find((l) => l.tier === 'zones')!;
    useEditorStore.getState().setActiveLayer(zones.id);
    draw('water');
    draw('water');
    draw('electrical');
    expect(layersOf('water')).toHaveLength(1);
    expect(layersOf('electrical')).toHaveLength(1);
    const byLayer = (tier: string) =>
      Object.values(doc().objects).filter((o) => o.layerId === layersOf(tier)[0]!.id).length;
    expect(byLayer('water')).toBe(2);
    expect(byLayer('electrical')).toBe(1);
    expect(byLayer('zones')).toBe(0);
    // Les autres objets vont toujours dans le calque actif.
    editActions.create(
      createAreaObject(
        doc(),
        { kind: 'rect', x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 },
        'zone.storage',
      ),
      'Zone',
    );
    expect(byLayer('zones')).toBe(1);
  });

  it('équipement d’un réseau : placé dans le calque de ce réseau', () => {
    editActions.create(createIconObject(doc(), P(10, 10), 'net.propane-tank', 'Réservoir'), 'Placer');
    const icon = Object.values(doc().objects)[0]!;
    expect(doc().layers.find((l) => l.id === icon.layerId)?.tier).toBe('propane');
  });

  it('réseau masqué : le tracé est refusé avec un message (jamais d’objet invisible)', () => {
    draw('sewer');
    planStore
      .getState()
      .update('masquer', (d) => setLayerFlag(d, layersOf('sewer')[0]!.id, 'visible', false));
    expect(draw('sewer')).toBe(false);
    expect(useEditorStore.getState().notice).toMatch(/masqué ou verrouillé/);
    expect(Object.keys(doc().objects)).toHaveLength(1);
  });
});

describe('superposition des réseaux', () => {
  beforeEach(() => {
    draw('water', [P(0, 0), P(300, 0), P(300, 400)]);
    draw('electrical');
    draw('propane');
  });

  it('« seul » : n’affiche que ce réseau parmi les réseaux, les autres calques restent affichés', () => {
    networkActions.showOnly('electrical');
    const visible = (tier: string) => doc().layers.find((l) => l.tier === tier)!.visible;
    expect(visible('electrical')).toBe(true);
    expect(visible('water')).toBe(false);
    expect(visible('propane')).toBe(false);
    expect(visible('zones')).toBe(true);
    networkActions.setAllVisible(true);
    expect(['water', 'electrical', 'propane'].every(visible)).toBe(true);
    networkActions.setVisible('water', false);
    expect(visible('water')).toBe(false);
  });

  it('opacité d’un réseau : un glissement du curseur = une seule action', () => {
    const before = planStore.getState().past.length;
    networkActions.setOpacity('water', 0.8);
    networkActions.setOpacity('water', 0.5);
    expect(layersOf('water')[0]!.opacity).toBe(0.5);
    expect(planStore.getState().past.length).toBe(before + 1);
  });

  it('résumé : lignes et longueur tracée par réseau', () => {
    const water = networkSummaries(doc()).find((n) => n.network === 'water')!;
    expect(water).toMatchObject({ lines: 1, length: 700, visible: true });
    expect(networkSummaries(doc()).find((n) => n.network === 'sewer')!.layers).toHaveLength(0);
  });

  it('vue imprimable d’un réseau : créée sans modifier les objets', () => {
    const objects = JSON.stringify(doc().objects);
    networkActions.createView('propane');
    const view = doc().plan.views.at(-1)!;
    expect(view.name).toBe('Réseau — Propane / gaz');
    expect(view.print.excludedLayerIds).toContain(layersOf('water')[0]!.id);
    expect(view.print.excludedLayerIds).not.toContain(layersOf('propane')[0]!.id);
    expect(JSON.stringify(doc().objects)).toBe(objects);
  });
});
