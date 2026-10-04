import { describe, expect, it } from 'vitest';
import { drawPlanObjects } from '@/export/planScene.ts';
import { MM_PER_PT, type Painter, type StrokeSpec } from '@/export/painter.ts';
import { legendEntries } from '../print/legend.ts';
import { createNetworkView, createView, hideNewNetworkLayerInViews } from '../print/views.ts';
import { findNetworkPreset, utilityLabel } from '../presets/networkPresets.ts';
import { MIGRATIONS } from '../schema/migrations.ts';
import { parsePlanDocument, serializePlanDocument } from '../schema/serialization.ts';
import { findSymbol, SYMBOLS } from '../symbols/catalog.ts';
import { applyTemplate, templateFromPlan } from '../templates/template.ts';
import { makeDocument } from '@/test/fixtures.ts';
import { DEFAULT_LAYER_TIERS } from './factories.ts';
import { insertCopies } from './multi.ts';
import {
  copyLayerFor,
  createIconObject,
  createUtilityObject,
  ensureTierLayer,
  tierForObject,
} from './objectFactory.ts';
import { addObject } from './operations.ts';
import { NETWORK_TIERS } from './schema.ts';
import type { PlanDocument, Point, UtilityObject } from './types.ts';

const P = (x: number, y: number): Point => ({ x, y });
const tiers = (doc: PlanDocument) => doc.layers.map((l) => l.tier);

/** Ligne de réseau ajoutée dans le calque de son réseau (créé au besoin). */
function addUtility(doc: PlanDocument, network: UtilityObject['network'], points = [P(0, 0), P(300, 0)]) {
  const layer = ensureTierLayer(doc, network);
  const line = { ...createUtilityObject(doc, points, network), layerId: layer.id } as UtilityObject;
  addObject(doc, line);
  return line;
}

describe('réseaux techniques : calques', () => {
  it('un plan neuf n’a aucun calque de réseau ; les catégories par défaut sont inchangées', () => {
    const doc = makeDocument();
    expect(tiers(doc)).toEqual([...DEFAULT_LAYER_TIERS]);
    expect(tiers(doc)).toHaveLength(9);
    expect(doc.layers.some((l) => (NETWORK_TIERS as readonly string[]).includes(l.tier))).toBe(false);
  });

  it('calque d’un réseau créé à sa place (au-dessus des piétons, sous la signalisation), une seule fois', () => {
    const doc = makeDocument();
    const water = ensureTierLayer(doc, 'water');
    expect(water.name).toBe('Réseau d’eau potable');
    expect(ensureTierLayer(doc, 'water').id).toBe(water.id);
    ensureTierLayer(doc, 'propane');
    ensureTierLayer(doc, 'sewer');
    expect(tiers(doc)).toEqual([
      'zones',
      'parking',
      'deliveries',
      'safety',
      'buildings',
      'circulation',
      'pedestrians',
      'water',
      'sewer',
      'propane',
      'signage',
      'texts',
    ]);
  });

  it('une ligne et un équipement appartiennent au calque de leur réseau', () => {
    const doc = makeDocument();
    const line = createUtilityObject(doc, [P(0, 0), P(10, 0)], 'electrical');
    expect(tierForObject(line)).toBe('electrical');
    const valve = createIconObject(doc, P(5, 5), 'net.gas-valve', 'Vanne');
    expect(tierForObject(valve)).toBe('propane');
    expect(tierForObject(createIconObject(doc, P(5, 5), 'sign.stop', 'Arrêt'))).toBe('signage');
  });

  it('chaque équipement de réseau est rattaché à un réseau, dans la catégorie « Réseaux techniques »', () => {
    const equipment = SYMBOLS.filter((s) => s.category === 'networks');
    expect(equipment.length).toBeGreaterThanOrEqual(15);
    for (const s of equipment) expect(NETWORK_TIERS).toContain(s.network);
    expect(findSymbol('net.manhole')?.network).toBe('sewer');
    for (const s of equipment) expect(s.svg()).toMatch(/^<svg /);
  });

  it('coller une ligne dans un plan sans ce réseau crée le calque du réseau', () => {
    const source = makeDocument();
    const line = addUtility(source, 'water');
    const target = makeDocument();
    const ids = insertCopies(target, [line], 0, 0);
    const copy = target.objects[ids[0]!]!;
    expect(target.layers.find((l) => l.id === copy.layerId)?.tier).toBe('water');
    // Calque d'origine présent (même plan) : la copie y reste.
    expect(copyLayerFor(source, line).id).toBe(line.layerId);
  });
});

describe('réseaux techniques : lignes', () => {
  it('valeurs par défaut : couleur du réseau, flèches d’écoulement pour les égouts, état', () => {
    const doc = makeDocument();
    const water = createUtilityObject(doc, [P(0, 0), P(10, 0)], 'water') as UtilityObject;
    expect(water).toMatchObject({ status: 'existing', placement: 'underground', showLabel: false });
    expect(water.style.stroke).toBe(findNetworkPreset('water').style.stroke);
    expect(water.arrows.visible).toBe(false);
    const sewer = createUtilityObject(doc, [P(0, 0), P(10, 0)], 'sewer', 1, 'proposed') as UtilityObject;
    expect(sewer.arrows.visible).toBe(true);
    expect(sewer.status).toBe('proposed');
    expect(sewer.style.dash).toBe('dashed');
  });

  it('étiquette : réseau, diamètre, matériau, profondeur, disposition et état', () => {
    const base = {
      network: 'water',
      nominalSize: '50 mm',
      material: 'PEHD',
      depthMeters: 2.1,
      placement: 'underground',
      status: 'existing',
    } as const;
    expect(utilityLabel(base)).toBe('Eau · 50 mm · PEHD · prof. 2,1 m');
    expect(
      utilityLabel({ ...base, network: 'electrical', placement: 'aerial', status: 'proposed', material: '' }),
    ).toBe('Élec. · 50 mm · aérien · projeté');
    expect(utilityLabel({ ...base, nominalSize: '', material: '', depthMeters: null })).toBe('Eau');
  });

  it('aller-retour exact du fichier ; un plan au format 6 s’ouvre sans changement', () => {
    const doc = makeDocument();
    const line = addUtility(doc, 'sewer');
    line.nominalSize = '200 mm';
    line.notes = 'Pente vers la fosse';
    const valve = createIconObject(doc, P(50, 50), 'net.water-valve', 'Vanne');
    addObject(doc, { ...valve, layerId: ensureTierLayer(doc, 'water').id });
    expect(parsePlanDocument(serializePlanDocument(doc))).toEqual(doc);

    const v6 = JSON.parse(serializePlanDocument(makeDocument()));
    v6.schemaVersion = 6;
    const migrated = parsePlanDocument(v6, MIGRATIONS);
    expect(migrated.schemaVersion).toBe(7);
    expect({ ...migrated, schemaVersion: 6 }).toEqual(v6);
  });

  it('migration 6 → 7 : les vues existantes ne sont celles d’aucun réseau', () => {
    const doc = makeDocument();
    doc.plan.views.push(createView(doc, 'suppliers'));
    const v6 = JSON.parse(serializePlanDocument(doc));
    v6.schemaVersion = 6;
    delete v6.plan.views[0].network;
    const migrated = parsePlanDocument(v6, MIGRATIONS);
    expect(migrated.plan.views[0]!.network).toBeNull();
    expect(migrated.plan.views[0]!.print).toEqual(doc.plan.views[0]!.print);
  });

  it('modèle d’entreprise : la vue d’un réseau garde son réseau', () => {
    const doc = makeDocument();
    addUtility(doc, 'water');
    doc.plan.views.push(createNetworkView(doc, 'water', 'Eau', ''));
    const template = templateFromPlan(doc, 'Modèle');
    const target = makeDocument();
    applyTemplate(target, template, { restyleExisting: false, logoAssetId: null });
    expect(target.plan.views[0]!.network).toBe('water');
    // Calque de réseau du modèle : ajouté à sa place, sous la signalisation et les textes.
    expect(tiers(target).slice(-3)).toEqual(['water', 'signage', 'texts']);
  });
});

describe('réseaux techniques : légende, vues, export', () => {
  it('légende : groupe « réseaux », intitulé avec l’état, équipements avec les réseaux', () => {
    const doc = makeDocument();
    addUtility(doc, 'water');
    const proposed = addUtility(doc, 'electrical');
    doc.objects[proposed.id] = { ...proposed, status: 'proposed', placement: 'aerial' };
    addObject(doc, {
      ...createIconObject(doc, P(5, 5), 'net.manhole', 'Regard'),
      layerId: ensureTierLayer(doc, 'sewer').id,
    });
    const entries = legendEntries(doc);
    const networks = entries.filter((e) => e.group === 'networks').map((e) => e.defaultLabel);
    expect(networks).toEqual(['Eau potable', 'Électricité (aérien, projeté)', "Regard d'égout"]);
  });

  it('vue d’un réseau : ce réseau, zones, bâtiments et textes ; les autres réseaux et la circulation masqués', () => {
    const doc = makeDocument();
    addUtility(doc, 'water');
    addUtility(doc, 'electrical');
    const view = createNetworkView(doc, 'water', 'Réseau — Eau potable', 'Plan du réseau');
    const shown = doc.layers.filter((l) => !view.print.excludedLayerIds.includes(l.id)).map((l) => l.tier);
    expect(shown).toEqual(['zones', 'buildings', 'water', 'texts']);
    expect(view).toMatchObject({ title: 'Réseau — Eau potable', audienceNote: 'Plan du réseau' });
  });

  it('nouveau réseau : masqué dans les vues Employés et Fournisseurs, affiché dans les autres', () => {
    const doc = makeDocument();
    doc.plan.views.push(createView(doc, 'employees'), createView(doc, 'management'));
    const layer = ensureTierLayer(doc, 'propane');
    const [employees, management] = doc.plan.views;
    expect(employees!.print.excludedLayerIds).toContain(layer.id);
    expect(management!.print.excludedLayerIds).not.toContain(layer.id);
    // Une vue qui masque déjà un réseau masque aussi les réseaux tracés ensuite.
    doc.plan.views.push(createNetworkView(doc, 'propane', 'Propane', ''));
    const telecom = ensureTierLayer(doc, 'telecom');
    hideNewNetworkLayerInViews(doc, telecom.id); // sans effet de plus si déjà fait
    expect(doc.plan.views[2]!.print.excludedLayerIds.filter((id) => id === telecom.id)).toHaveLength(1);
    expect(doc.plan.views[1]!.print.excludedLayerIds).not.toContain(telecom.id);
  });

  it('export : trait dans la couleur du réseau, étiquette imprimée sauf en détail simplifié', () => {
    const doc = makeDocument();
    const line = addUtility(doc, 'propane', [P(0, 0), P(1000, 0)]);
    doc.objects[line.id] = { ...line, showLabel: true, nominalSize: '1 po' };
    const draw = (detail: 'full' | 'simplified') => {
      const strokes: StrokeSpec[] = [];
      const texts: string[] = [];
      const painter: Painter = {
        kind: 'canvas',
        path: (_s, _c, _f, stroke) => void (stroke && strokes.push(stroke)),
        text: (text) => void texts.push(text),
        textWidth: (text, size) => text.length * size * MM_PER_PT * 0.5,
        image: () => {},
        clip: (_c, fn) => fn(),
        withOpacity: (_o, fn) => fn(),
      } as Painter;
      drawPlanObjects(
        painter,
        doc,
        { x: 0, y: 0, originX: 0, originY: 0, k: 0.2 },
        { x: 0, y: 0, width: 400, height: 400 },
        null,
        [],
        { detail },
      );
      return { strokes, texts };
    };
    const full = draw('full');
    expect(full.strokes.map((s) => s.color)).toContain(findNetworkPreset('propane').style.stroke);
    expect(full.texts).toEqual(['Propane · 1 po']);
    expect(draw('simplified').texts).toEqual([]);
  });
});
