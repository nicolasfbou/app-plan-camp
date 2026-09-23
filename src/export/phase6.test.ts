import { SCHEMA_VERSION } from '@/domain/model/schema.ts';
import { describe, expect, it } from 'vitest';
import { createVariant } from '@/domain/model/factories.ts';
import {
  createAreaObject,
  createDimensionObject,
  createFlowObject,
  createTextObject,
} from '@/domain/model/objectFactory.ts';
import { insertCopies, moveObjects } from '@/domain/model/multi.ts';
import { addObject } from '@/domain/model/operations.ts';
import { PRINT_STYLES } from '@/domain/model/planDefaults.ts';
import type { PlanDocument, Point, TextObject } from '@/domain/model/types.ts';
import { legendEntries } from '@/domain/print/legend.ts';
import { pageSize } from '@/domain/print/paper.ts';
import {
  applyLabelPlacement,
  resetLabelPlacement,
  setReadabilityReview,
} from '@/domain/print/readabilityReviews.ts';
import { createView, effectiveSettings, styleFromPreset, viewFilter } from '@/domain/print/views.ts';
import { parsePlanDocument } from '@/domain/schema/serialization.ts';
import { applyTemplate, templateFromPlan } from '@/domain/templates/template.ts';
import { readTemplateFile, writeTemplateFile } from '@/persistence/templateFile.ts';
import { makeDocument } from '@/test/fixtures.ts';
import { drawPage, layoutPage, type ComposeInput } from './compose.ts';
import { grayOf, grayscalePainter, MM_PER_PT, type Painter, type StrokeSpec } from './painter.ts';
import { analyzeReadability, proposeLabelPlacement } from './readability.ts';

const P = (x: number, y: number): Point => ({ x, y });

class Recorder implements Painter {
  readonly kind = 'canvas' as const;
  texts: { text: string; size: number; color: string }[] = [];
  strokes: StrokeSpec[] = [];
  fills: string[] = [];
  path(_s: unknown, _c: boolean, fill: { color: string } | null, stroke: StrokeSpec | null) {
    if (stroke) this.strokes.push(stroke);
    if (fill) this.fills.push(fill.color);
  }
  text(text: string, _x: number, _y: number, spec: { size: number; color: string }) {
    this.texts.push({ text, size: spec.size, color: spec.color });
  }
  textWidth(text: string, size: number) {
    return text.length * size * MM_PER_PT * 0.5;
  }
  image() {}
  clip(_: unknown, draw: () => void) {
    draw();
  }
  withOpacity(_: number, draw: () => void) {
    draw();
  }
}
const measure = (text: string, size: number) => text.length * size * MM_PER_PT * 0.5;

function photoDoc(): PlanDocument {
  const doc = makeDocument();
  doc.plan.baseImage = {
    blobId: 'b',
    fileName: 'camp.jpg',
    mimeType: 'image/jpeg',
    byteLength: 1,
    sha256: '0'.repeat(64),
    width: 4000,
    height: 2250,
    exifOrientation: 1,
    importedAt: '2026-01-15T12:00:00.000Z',
    source: { kind: 'image' },
  };
  return doc;
}

function render(doc: PlanDocument, viewId: string | null) {
  const s = effectiveSettings(doc, viewId);
  const input: ComposeInput = {
    doc,
    siteName: 'Camp 105',
    print: s.print,
    legend: s.legend,
    page: pageSize(s.print),
    target: 'paper',
    now: new Date('2026-09-23T12:00:00'),
    title: s.title,
    audienceNote: s.audienceNote,
    titleBlockPlacement: s.titleBlockPlacement,
  };
  const p = new Recorder();
  const layout = layoutPage(p, input, null);
  const warnings = drawPage(p, input, layout, { photo: null, symbols: null, background: 'white' });
  return { p, layout, warnings };
}

/** Plan de démonstration : trajet, zone de livraison nommée, stationnement, cote, étiquette. */
function sampleDoc() {
  const doc = photoDoc();
  const flow = createFlowObject(doc, [P(200, 200), P(3000, 1500)], 'heavy');
  addObject(doc, flow);
  const delivery = createAreaObject(
    doc,
    { kind: 'rect', x: 1000, y: 1000, width: 400, height: 200, cornerRadius: 0 },
    'zone.delivery',
  );
  addObject(doc, delivery);
  const parking = createAreaObject(
    doc,
    { kind: 'rect', x: 2000, y: 400, width: 300, height: 200, cornerRadius: 0 },
    'zone.parking',
  );
  addObject(doc, parking);
  const dim = createDimensionObject(doc, [P(100, 2000), P(900, 2000)]);
  addObject(doc, dim);
  const label = createTextObject(doc, P(1800, 1800), { label: true, text: 'Route du sud', fontSize: 40 });
  addObject(doc, label);
  return { doc, flow, delivery, parking, dim, label };
}

describe('vues par public', () => {
  it('création : calques masqués selon le public, style et détail proposés', () => {
    const { doc } = sampleDoc();
    const suppliers = createView(doc, 'suppliers');
    const parkingLayer = doc.layers.find((l) => l.tier === 'parking')!;
    expect(suppliers.print.excludedLayerIds).toContain(parkingLayer.id);
    expect(suppliers.print.style).toEqual(styleFromPreset('supplier'));
    const employees = createView(doc, 'employees');
    expect(employees.print.excludedLayerIds).toContain(doc.layers.find((l) => l.tier === 'deliveries')!.id);
    expect(createView(doc, 'management').print.excludedLayerIds).toEqual(doc.plan.print.excludedLayerIds);
  });

  it('changer de vue ne modifie jamais le plan (filtre et réglages seulement)', () => {
    const { doc, delivery } = sampleDoc();
    doc.plan.views.push(createView(doc, 'employees'), createView(doc, 'suppliers'));
    const before = JSON.stringify(doc);
    for (const v of [...doc.plan.views, null]) {
      effectiveSettings(doc, v?.id ?? null);
      viewFilter(doc, v?.id ?? null);
      render(doc, v?.id ?? null);
    }
    expect(JSON.stringify(doc)).toBe(before);
    // La vue Employés masque la zone de livraison (calque exclu), le plan de base la montre.
    expect(viewFilter(doc, doc.plan.views[0]!.id).hiddenLayers.has(delivery.layerId)).toBe(true);
    expect(viewFilter(doc, null).hiddenLayers.size).toBe(0);
  });

  it('export par vue : titre, public, éléments exclus, légende et niveau de détail propres à la vue', () => {
    const { doc, label, dim } = sampleDoc();
    const view = createView(doc, 'suppliers');
    view.title = 'Accès fournisseurs';
    view.print.excludedObjectIds = [label.id];
    doc.plan.views.push(view);
    const base = render(doc, null);
    const r = render(doc, view.id);
    const texts = r.p.texts.map((t) => t.text);
    expect(texts).toContain('Accès fournisseurs');
    // Mention du public dans le cartouche (renvoyée à la ligne selon la largeur).
    expect(texts.join(' ')).toContain('Destiné aux fournisseurs et');
    expect(texts).not.toContain('Route du sud'); // élément exclu
    expect(base.p.texts.map((t) => t.text)).toContain('Route du sud');
    // Niveau « standard » : pas de cote, ni dans le plan ni dans la légende.
    expect(view.print.detail).toBe('standard');
    expect(texts.some((t) => t.endsWith('px'))).toBe(false);
    expect(
      legendEntries(doc, view.print.excludedLayerIds, view.print.excludedObjectIds, 'standard').some(
        (e) => e.key === 'dimension',
      ),
    ).toBe(false);
    expect(legendEntries(doc).some((e) => e.key === 'dimension')).toBe(true);
    void dim;
  });
});

describe('préréglages d’impression (rendu seulement)', () => {
  it('épaisseurs, taille minimale des textes, noir et blanc', () => {
    const { doc, label } = sampleDoc();
    // Minuscule à l'échelle du Tabloïd.
    doc.objects[label.id] = { ...(label as TextObject), fontSize: 4 };
    const field = createView(doc, 'custom');
    field.print.style = styleFromPreset('field');
    doc.plan.views.push(field);
    const base = render(doc, null);
    const styled = render(doc, field.id);
    const flowWidth = (r: ReturnType<typeof render>) => Math.max(...r.p.strokes.map((s) => s.width));
    expect(flowWidth(styled)).toBeGreaterThan(flowWidth(base) * 1.4);
    const size = (r: ReturnType<typeof render>) => r.p.texts.find((t) => t.text === 'Route du sud')!.size;
    expect(size(base)).toBeLessThan(6);
    expect(size(styled)).toBeCloseTo(PRINT_STYLES.field.minTextPt, 6);
    expect(base.warnings.map((w) => w.code)).toContain('small-text');
    expect(styled.warnings.map((w) => w.code)).not.toContain('small-text');

    const bw = createView(doc, 'custom');
    bw.print.style = styleFromPreset('bw');
    doc.plan.views.push(bw);
    const gray = render(doc, bw.id);
    for (const c of [...gray.p.fills, ...gray.p.texts.map((t) => t.color)])
      expect(grayOf(c)).toBe(c.toLowerCase());
  });

  it('surface noir et blanc : luminance ; « standard » ne change rien', () => {
    expect(grayOf('#ff0000')).toBe('#4c4c4c');
    const r = new Recorder();
    grayscalePainter(r).text('x', 0, 0, { size: 8, color: '#1d4ed8' });
    expect(r.texts[0]!.color).toBe(grayOf('#1d4ed8'));
    expect(PRINT_STYLES.standard).toMatchObject({
      photoDim: 0,
      photoContrast: 1,
      strokeScale: 1,
      minTextPt: 0,
      iconScale: 1,
      grayscale: false,
    });
  });
});

describe('lisibilité', () => {
  function crowded() {
    const doc = photoDoc();
    const a = createTextObject(doc, P(2000, 1100), { label: true, text: 'Dortoir A — accès', fontSize: 60 });
    const b = createTextObject(doc, P(2030, 1120), {
      label: true,
      text: 'Cuisine — livraison',
      fontSize: 60,
    });
    addObject(doc, a);
    addObject(doc, b);
    return { doc, a, b };
  }

  it('détecte les textes qui se chevauchent, avec une clé stable et un statut', () => {
    const { doc, a, b } = crowded();
    const report = analyzeReadability(doc, effectiveSettings(doc, null), measure);
    const issue = report.issues.find((i) => i.kind === 'text-text')!;
    expect(issue.objectIds.sort()).toEqual([a.id, b.id].sort());
    expect(issue.status).toBe('open');
    expect(issue.bounds!.width).toBeGreaterThan(0);
    setReadabilityReview(doc, issue.key, 'ignored');
    const again = analyzeReadability(doc, effectiveSettings(doc, null), measure);
    expect(again.issues.find((i) => i.key === issue.key)!.status).toBe('ignored');
    expect(again.open).toBe(report.open - 1);
    setReadabilityReview(doc, issue.key, null);
    expect(doc.readabilityReviews).toEqual([]);
  });

  it('proposition : meilleur emplacement, appliqué seulement si accepté ; retour possible', () => {
    const { doc, a, b } = crowded();
    const settings = effectiveSettings(doc, null);
    const report = analyzeReadability(doc, settings, measure);
    const before = JSON.stringify(doc);
    const proposal = proposeLabelPlacement(doc, report, b.id, settings)!;
    expect(proposal).not.toBeNull();
    expect(proposal.remainingOverlap).toBe(0);
    expect(JSON.stringify(doc)).toBe(before); // proposer ne modifie rien (refus = rien à faire)
    expect(applyLabelPlacement(doc, proposal)).toBe(true);
    const moved = doc.objects[b.id] as TextObject;
    expect(moved.geometry).toMatchObject({ x: proposal.at.x, y: proposal.at.y });
    const after = analyzeReadability(doc, settings, measure);
    expect(after.issues.filter((i) => i.kind === 'text-text')).toHaveLength(0);
    expect(resetLabelPlacement(doc, b.id) || moved.leaderTo === null).toBe(true);
    void a;
  });

  it('nom de zone : déplacé par décalage, relié par une ligne de renvoi ; étiquette verrouillée intouchable', () => {
    const doc = photoDoc();
    const zone = createAreaObject(
      doc,
      { kind: 'rect', x: 1000, y: 1000, width: 60, height: 40, cornerRadius: 0 },
      'zone.delivery',
    );
    addObject(doc, zone);
    const ok = applyLabelPlacement(doc, {
      objectId: zone.id,
      kind: 'zone-name',
      at: P(1200, 900),
      leaderTo: P(1030, 1020),
    });
    expect(ok).toBe(true);
    expect((doc.objects[zone.id] as { nameOffset: Point }).nameOffset).toEqual(P(170, -120));
    doc.objects[zone.id]!.locked = true;
    expect(
      applyLabelPlacement(doc, { objectId: zone.id, kind: 'zone-name', at: P(0, 0), leaderTo: null }),
    ).toBe(false);
  });
});

describe('modèles réutilisables', () => {
  it('modèle tiré d’un plan : réglages sans objets ; appliqué à un autre plan (calques par catégorie)', async () => {
    const { doc } = sampleDoc();
    doc.plan.titleBlock.company = 'PAMM';
    doc.plan.titleBlock.status = 'draft';
    doc.plan.styleOverrides['zone.delivery'] = {
      ...doc.objects[Object.keys(doc.objects)[1]!]!.style,
      fill: '#123456',
    };
    doc.plan.views.push(createView(doc, 'suppliers'));
    doc.plan.print.paper = 'a3';
    const template = templateFromPlan(doc, 'Modèle PAMM — fournisseur');
    expect(JSON.stringify(template)).not.toContain('Route du sud');
    expect(template.views[0]!.print.excludedTiers).toEqual(['parking']);

    const target = photoDoc();
    target.plan.titleBlock.status = 'review';
    target.plan.titleBlock.notes = 'Notes propres au plan';
    const objectsBefore = JSON.stringify(target.objects);
    applyTemplate(target, template, { restyleExisting: false, logoAssetId: null });
    expect(target.plan.titleBlock.company).toBe('PAMM');
    expect(target.plan.titleBlock.status).toBe('review'); // jamais modifié par un modèle
    expect(target.plan.titleBlock.notes).toBe('Notes propres au plan'); // champ vide du modèle : conservé
    expect(target.plan.print.paper).toBe('a3');
    expect(target.plan.views).toHaveLength(1);
    expect(target.plan.views[0]!.print.excludedLayerIds).toEqual([
      target.layers.find((l) => l.tier === 'parking')!.id,
    ]);
    expect(JSON.stringify(target.objects)).toBe(objectsBefore);
    // Les nouveaux objets suivent le style d'entreprise.
    const zone = createAreaObject(
      target,
      { kind: 'rect', x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 },
      'zone.delivery',
    );
    expect(zone.style.fill).toBe('#123456');

    // Fichier .campmodele : aller-retour vérifié, altération détectée.
    const bytes = await writeTemplateFile({ template, logo: null });
    const back = await readTemplateFile(bytes);
    expect(back.template).toEqual(template);
    const corrupted = bytes.slice();
    corrupted[corrupted.length - 200] = corrupted[corrupted.length - 200]! ^ 0xff;
    await expect(readTemplateFile(corrupted)).rejects.toThrow();
  });
});

describe('corrections de la revue', () => {
  it('modèle réappliqué : éléments exclus du plan et des vues conservés ; calques appariés une seule fois', () => {
    const { doc } = sampleDoc();
    const view = createView(doc, 'employees');
    doc.plan.views.push(view);
    const someId = Object.keys(doc.objects)[0]!;
    doc.plan.print.excludedObjectIds = [someId];
    view.print.excludedObjectIds = [someId];
    const layersBefore = doc.layers.length;
    const template = templateFromPlan(doc, 'Modèle');
    applyTemplate(doc, template, { restyleExisting: false, logoAssetId: null });
    applyTemplate(doc, template, { restyleExisting: false, logoAssetId: null });
    expect(doc.plan.print.excludedObjectIds).toEqual([someId]);
    expect(doc.plan.views).toHaveLength(1);
    expect(doc.plan.views[0]!.id).toBe(view.id);
    expect(doc.plan.views[0]!.print.excludedObjectIds).toEqual([someId]);
    expect(doc.layers).toHaveLength(layersBefore); // aucun calque dupliqué
  });

  it('étiquette avec renvoi : déplacée avec sa cible, le renvoi suit ; seule, il reste en place ; copie décalée', () => {
    const doc = photoDoc();
    const label = createTextObject(doc, P(100, 100), {
      label: true,
      text: 'Zone',
      fontSize: 14,
    }) as TextObject;
    label.leaderTo = P(200, 200);
    addObject(doc, label);
    const zone = createAreaObject(
      doc,
      { kind: 'rect', x: 180, y: 180, width: 40, height: 40, cornerRadius: 0 },
      'zone.delivery',
    );
    addObject(doc, zone);
    moveObjects(doc, [label.id], 10, 0);
    expect((doc.objects[label.id] as TextObject).leaderTo).toEqual(P(200, 200));
    moveObjects(doc, [label.id, zone.id], 5, 5);
    expect((doc.objects[label.id] as TextObject).leaderTo).toEqual(P(205, 205));
    const [copyId] = insertCopies(doc, [doc.objects[label.id]!], 20, 20);
    expect((doc.objects[copyId!] as TextObject).leaderTo).toEqual(P(225, 225));
  });
});

describe('variantes été / hiver', () => {
  it('tout est copié au départ, puis les plans sont indépendants ; origine tracée ; brouillon', () => {
    const { doc } = sampleDoc();
    doc.plan.kind = 'summer-circulation';
    doc.plan.titleBlock.status = 'approved';
    doc.plan.views.push(createView(doc, 'employees'));
    const winter = createVariant(doc, 'Circulation hiver', 'winter-circulation');
    expect(winter.plan.id).not.toBe(doc.plan.id);
    expect(winter.plan.kind).toBe('winter-circulation');
    expect(winter.plan.variantOf).toMatchObject({
      planId: doc.plan.id,
      planName: doc.plan.name,
      kind: 'summer-circulation',
    });
    expect(winter.plan.titleBlock.status).toBe('draft');
    expect(Object.keys(winter.objects)).toEqual(Object.keys(doc.objects));
    expect(winter.plan.views).toHaveLength(1);
    expect(winter.plan.baseImage).toEqual(doc.plan.baseImage); // même photo, même empreinte
    // Indépendance : modifier la variante ne change pas l'original.
    const id = Object.keys(winter.objects)[0]!;
    winter.objects[id]!.name = 'Modifié en hiver';
    expect(doc.objects[id]!.name).not.toBe('Modifié en hiver');
  });
});

describe('migration 4 → 5', () => {
  it('anciens plans : aucune vue, style standard (rendu inchangé), étiquettes à leur place', () => {
    const { doc, label, delivery } = sampleDoc();
    type Raw = Record<string, unknown>;
    const v4 = JSON.parse(JSON.stringify({ ...doc, schemaVersion: 4 })) as Raw;
    const plan = v4.plan as Raw;
    const objects = v4.objects as Record<string, Raw>;
    for (const k of ['views', 'variantOf', 'styleOverrides']) delete plan[k];
    for (const k of ['excludedObjectIds', 'detail', 'style']) delete (plan.print as Raw)[k];
    delete objects[label.id]!.leaderTo;
    delete objects[delivery.id]!.nameOffset;
    delete v4.readabilityReviews;
    const migrated = parsePlanDocument(v4);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.plan.views).toEqual([]);
    expect(migrated.plan.print.style.preset).toBe('standard');
    expect(migrated.plan.print.detail).toBe('full');
    expect((migrated.objects[label.id] as { leaderTo: unknown }).leaderTo).toBeNull();
    expect((migrated.objects[delivery.id] as { nameOffset: unknown }).nameOffset).toBeNull();
    expect(migrated.readabilityReviews).toEqual([]);
  });
});
