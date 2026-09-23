import { describe, expect, it } from 'vitest';
import { addObject } from '@/domain/model/operations.ts';
import { metersPerPixel } from '@/domain/model/measure.ts';
import {
  createAreaObject,
  createCorridorObject,
  createFlowObject,
  createIconObject,
  createTextObject,
} from '@/domain/model/objectFactory.ts';
import { createPlanDocument, duplicatePlanDocument } from '@/domain/model/factories.ts';
import { generateStalls, MAX_STALLS, StallLimitError } from '@/domain/model/parking.ts';
import { pointInPolygon } from '@/domain/model/parking.ts';
import { roundedRectPoints } from '@/domain/model/shapes.ts';
import type { PlanDocument, Point } from '@/domain/model/types.ts';
import { legendEntries, shownLegendEntries } from '@/domain/print/legend.ts';
import { pageSize } from '@/domain/print/paper.ts';
import { scaleBar, scaleRatioText } from '@/domain/print/scaleBar.ts';
import { ApprovalError, setPlanStatus, titleBlockRows } from '@/domain/print/titleBlock.ts';
import { parsePlanDocument } from '@/domain/schema/serialization.ts';
import { makeDocument } from '@/test/fixtures.ts';
import { drawPage, layoutPage, type ComposeInput } from './compose.ts';
import { exportFileName } from './exportPlan.ts';
import { MM_PER_PT, wrapText, type Painter } from './painter.ts';

const P = (x: number, y: number): Point => ({ x, y });

/** Surface factice : enregistre les textes ; largeur de texte ≈ 0,5 em par caractère. */
class RecordingPainter implements Painter {
  readonly kind = 'canvas' as const;
  texts: { text: string; x: number; y: number; size: number }[] = [];
  paths = 0;
  images = 0;
  path() {
    this.paths++;
  }
  text(text: string, x: number, y: number, spec: { size: number }) {
    this.texts.push({ text, x, y, size: spec.size });
  }
  textWidth(text: string, size: number) {
    return text.length * size * MM_PER_PT * 0.5;
  }
  image() {
    this.images++;
  }
  clip(_: unknown, draw: () => void) {
    draw();
  }
  withOpacity(_: number, draw: () => void) {
    draw();
  }
}

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

function input(doc: PlanDocument, overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    doc,
    siteName: 'Camp 105',
    print: doc.plan.print,
    legend: doc.plan.legend,
    page: pageSize(doc.plan.print),
    target: 'paper',
    now: new Date('2026-09-23T12:00:00'),
    ...overrides,
  };
}

const inside = (
  r: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
) =>
  r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.width <= page.width + 1e-6 && r.y + r.height <= page.height + 1e-6;

describe('mise en page', () => {
  it('Tabloïd paysage : carte aux proportions de la photo, légende et cartouche à côté, dans les marges', () => {
    const doc = photoDoc();
    addObject(doc, createFlowObject(doc, [P(100, 100), P(3000, 1500)], 'heavy'));
    addObject(
      doc,
      createAreaObject(
        doc,
        { kind: 'rect', x: 500, y: 500, width: 400, height: 300, cornerRadius: 0 },
        'zone.parking',
      ),
    );
    const p = new RecordingPainter();
    const layout = layoutPage(p, input(doc), null);
    expect(layout.page).toEqual({ width: 431.8, height: 279.4 });
    expect(layout.map.width / layout.map.height).toBeCloseTo(4000 / 2250, 5);
    expect(layout.transform.k).toBeCloseTo(layout.map.width / 4000, 9);
    for (const r of [layout.map, layout.legend!.rect, layout.titleBlock!.rect]) {
      expect(inside(r, { width: 431.8 - 10, height: 279.4 - 10 })).toBe(true);
      expect(r.x).toBeGreaterThanOrEqual(10 - 1e-6);
    }
    // À côté de la carte, jamais dessus.
    expect(layout.legend!.overlay).toBe(false);
    expect(layout.legend!.rect.x).toBeGreaterThan(layout.map.x + layout.map.width);
    expect(layout.titleBlock!.rect.x).toBeGreaterThan(layout.map.x + layout.map.width);
  });

  it('tous les formats et orientations : tout reste dans la page', () => {
    const doc = photoDoc();
    addObject(doc, createFlowObject(doc, [P(100, 100), P(3000, 1500)], 'light'));
    for (const paper of ['letter', 'legal', 'tabloid', 'a4', 'a3', 'a2', 'a1'] as const)
      for (const orientation of ['portrait', 'landscape'] as const) {
        const print = { ...doc.plan.print, paper, orientation };
        const page = pageSize(print);
        const layout = layoutPage(new RecordingPainter(), input(doc, { print, page }), null);
        for (const r of [layout.map, layout.legend?.rect, layout.titleBlock?.rect].filter(Boolean))
          expect(inside(r!, page)).toBe(true);
      }
  });

  it('plan non calibré : aucune barre d’échelle, avertissement ; calibré : barre cohérente', () => {
    const doc = photoDoc();
    const p = new RecordingPainter();
    let layout = layoutPage(p, input(doc), null);
    expect(layout.scale).toBeNull();
    expect(layout.warnings.map((w) => w.code)).toContain('not-calibrated');
    expect(layout.titleBlock!.fit.cells.find((c) => c.label === 'Échelle')!.lines.join(' ')).toMatch(
      /non calibré/,
    );

    doc.plan.calibration = { p1: P(0, 0), p2: P(1000, 0), distanceMeters: 250 };
    layout = layoutPage(p, input(doc), null);
    expect(layout.scale).not.toBeNull();
    const bar = scaleBar(doc.plan.calibration, layout.transform.k, layout.scale!.maxMm)!;
    // Longueur sur le papier ↔ longueur réelle : mm / (mm par pixel) × (m par pixel) = mètres.
    expect((bar.mm / layout.transform.k) * metersPerPixel(doc.plan.calibration)!).toBeCloseTo(bar.length, 6);
    expect(scaleRatioText(doc.plan.calibration, layout.transform.k)).toMatch(/^≈ 1:/);
  });

  it('nord : jamais supposé ; estimé = mention « à vérifier »', () => {
    const doc = photoDoc();
    const p = new RecordingPainter();
    let layout = layoutPage(p, input(doc), null);
    expect(layout.north).toBeNull();
    expect(layout.warnings.map((w) => w.code)).toContain('north-undefined');
    doc.plan.northStatus = 'estimated';
    doc.plan.northAngleDeg = 30;
    layout = layoutPage(p, input(doc), null);
    expect(layout.north).not.toBeNull();
    drawPage(p, input(doc), layout, { photo: null, symbols: null, background: 'white' });
    expect(p.texts.map((t) => t.text)).toContain('Nord estimé — à vérifier');
  });

  it('plan simplifié : pas de cartouche ; sans fond : pas de photo', () => {
    const doc = photoDoc();
    let layout = layoutPage(
      new RecordingPainter(),
      input(doc, { print: { ...doc.plan.print, mode: 'simplified' } }),
      null,
    );
    expect(layout.titleBlock).toBeNull();
    expect(layout.photo).toBe(true);
    layout = layoutPage(
      new RecordingPainter(),
      input(doc, { print: { ...doc.plan.print, mode: 'annotations' } }),
      null,
    );
    expect(layout.photo).toBe(false);
    expect(layout.titleBlock).not.toBeNull();
  });

  it('légende sur la carte : évite le coin où se trouve un bâtiment', () => {
    const doc = photoDoc();
    doc.plan.legend.placement = 'map-auto';
    // Bâtiment dans le coin haut-gauche, zone ailleurs.
    addObject(
      doc,
      createAreaObject(
        doc,
        { kind: 'rect', x: 0, y: 0, width: 1500, height: 900, cornerRadius: 0 },
        'building.dormitory',
      ),
    );
    const layout = layoutPage(new RecordingPainter(), input(doc), null);
    expect(layout.legend).not.toBeNull();
    const { rect } = layout.legend!;
    expect(
      rect.x > layout.map.x + layout.map.width / 3 || rect.y > layout.map.y + layout.map.height / 3,
    ).toBe(true);
    expect(layout.warnings.map((w) => w.code)).not.toContain('legend-over-building');
  });

  it('légende trop longue : taille réduite, puis entrées omises et SIGNALÉES', () => {
    const doc = photoDoc();
    const presets = [
      'zone.parking',
      'zone.parking-visitors',
      'zone.dropoff',
      'zone.assembly',
      'zone.danger',
      'zone.snow',
    ];
    presets.forEach((preset, i) => {
      const zone = createAreaObject(
        doc,
        { kind: 'rect', x: i * 100, y: 0, width: 50, height: 50, cornerRadius: 0 },
        preset,
      );
      addObject(doc, zone);
    });
    // Petite page : la légende ne peut pas tout contenir.
    const print = { ...doc.plan.print, paper: 'letter' as const, orientation: 'portrait' as const };
    const many = makeManyCategories(doc);
    const layout = layoutPage(new RecordingPainter(), input(many, { print, page: pageSize(print) }), null);
    expect(layout.legend!.fit.font).toBeGreaterThanOrEqual(6 - 1e-9);
    expect(layout.legend!.fit.omitted).toBeGreaterThan(0);
    expect(layout.warnings.map((w) => w.code)).toContain('legend-overflow');
  });

  it('texte trop petit pour le format ou coupé par le cadre : signalé', () => {
    const doc = photoDoc();
    addObject(doc, createTextObject(doc, P(2000, 1000), { label: false, text: 'Minuscule', fontSize: 4 }));
    addObject(
      doc,
      createTextObject(doc, P(3995, 1000), { label: true, text: 'Au bord du cadre', fontSize: 60 }),
    );
    const p = new RecordingPainter();
    const layout = layoutPage(p, input(doc), null);
    const warnings = drawPage(p, input(doc), layout, { photo: null, symbols: null, background: 'white' });
    expect(warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['small-text', 'cut-text']));
  });

  it('calque exclu : ni dessiné ni légendé', () => {
    const doc = photoDoc();
    const flow = createFlowObject(doc, [P(100, 100), P(3000, 1500)], 'heavy');
    addObject(doc, flow);
    expect(legendEntries(doc).length).toBe(1);
    expect(legendEntries(doc, [flow.layerId])).toEqual([]);
    doc.layers.find((l) => l.id === flow.layerId)!.visible = false;
    expect(legendEntries(doc)).toEqual([]);
  });
});

/** Un plan avec beaucoup de catégories distinctes (styles différents = entrées différentes). */
function makeManyCategories(doc: PlanDocument): PlanDocument {
  for (let i = 0; i < 60; i++) {
    const c = createCorridorObject(doc, [P(i * 60, 1800), P(i * 60 + 40, 1900)]);
    addObject(doc, {
      ...c,
      style: { ...c.style, fill: `#${(i * 4000 + 1000).toString(16).padStart(6, '0').slice(-6)}` },
    });
  }
  return doc;
}

describe('légende automatique', () => {
  it('seulement les catégories présentes, couleurs exactes, masquage et intitulés personnalisés', () => {
    const doc = makeDocument();
    expect(legendEntries(doc)).toEqual([]);
    const flow = createFlowObject(doc, [P(0, 0), P(100, 0)], 'heavy');
    addObject(doc, flow);
    addObject(doc, createFlowObject(doc, [P(0, 50), P(100, 50)], 'heavy'));
    const entries = legendEntries(doc);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.count).toBe(2);
    expect(entries[0]!.swatch).toMatchObject({ kind: 'flow', style: flow.style });
    const key = entries[0]!.key;
    expect(shownLegendEntries(doc, { ...doc.plan.legend, labels: { [key]: 'Camions' } })[0]!.label).toBe(
      'Camions',
    );
    expect(shownLegendEntries(doc, { ...doc.plan.legend, hidden: [key] })).toEqual([]);
  });
});

describe('cartouche', () => {
  it('« Approuvé » exige un nom ET une confirmation explicite ; jamais automatique', () => {
    const doc = makeDocument();
    expect(doc.plan.titleBlock.status).toBe('draft');
    expect(() => setPlanStatus(doc, 'approved', null)).toThrow(ApprovalError);
    expect(() => setPlanStatus(doc, 'approved', { confirmed: false, approvedBy: 'A. Tremblay' })).toThrow(
      ApprovalError,
    );
    expect(() => setPlanStatus(doc, 'approved', { confirmed: true, approvedBy: '  ' })).toThrow(
      ApprovalError,
    );
    expect(doc.plan.titleBlock.status).toBe('draft');
    setPlanStatus(
      doc,
      'approved',
      { confirmed: true, approvedBy: 'A. Tremblay' },
      '2026-09-23T12:00:00.000Z',
    );
    expect(doc.plan.titleBlock).toMatchObject({
      status: 'approved',
      approvedBy: 'A. Tremblay',
      approvedAt: '2026-09-23T12:00:00.000Z',
    });
    // Une copie du plan n'est jamais approuvée d'office.
    expect(duplicatePlanDocument(doc, 'Copie').plan.titleBlock).toMatchObject({
      status: 'draft',
      approvedAt: null,
    });
    setPlanStatus(doc, 'review');
    expect(doc.plan.titleBlock.approvedAt).toBeNull();
  });

  it('lignes : « Approuvé par » seulement si approuvé ; champs vides omis ; options date/révision/notes', () => {
    const doc = makeDocument();
    doc.plan.titleBlock.approvedBy = 'Personne';
    doc.plan.titleBlock.notes = 'Illustratif';
    const include = { date: true, revision: true, notes: true };
    let rows = titleBlockRows(doc, {
      siteName: 'Camp 105',
      scaleText: 'x',
      northText: 'Non défini',
      include,
    });
    expect(rows.map((r) => r.label)).not.toContain('Approuvé par');
    expect(rows.find((r) => r.label === 'Camp')!.value).toBe('Camp 105');
    expect(rows.find((r) => r.label === 'Statut')!.value).toBe('Brouillon');
    rows = titleBlockRows(doc, {
      siteName: 'Camp 105',
      scaleText: 'x',
      northText: 'y',
      include: { date: false, revision: false, notes: false },
    });
    expect(rows.map((r) => r.label)).not.toEqual(expect.arrayContaining(['Date', 'Révision', 'Notes']));
  });
});

describe('outils', () => {
  it('retour à la ligne : aucun caractère perdu, même un mot trop long', () => {
    const measure = (s: string) => s.length;
    const text = 'Stationnement des véhicules lourds supercalifragilisticexpialidocious';
    const lines = wrapText(text, 12, measure);
    expect(lines.every((l) => l.length <= 12)).toBe(true);
    expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('nom de fichier sûr (numéro de plan, révision)', () => {
    const doc = makeDocument();
    doc.plan.titleBlock.planNumber = 'CP-105 / Été';
    doc.plan.titleBlock.revision = 'B';
    expect(exportFileName(doc, 'pdf')).toBe('CP-105-Ete-revB.pdf');
  });

  it('migration 3 → 4 : anciens plans ouverts avec des réglages par défaut sûrs', () => {
    const doc = createPlanDocument({ siteId: 's', name: 'Ancien' });
    const corridor = createCorridorObject(doc, [P(0, 0), P(100, 0)]);
    addObject(doc, corridor);
    const v3 = JSON.parse(JSON.stringify({ ...doc, schemaVersion: 3 })) as Record<string, unknown>;
    const plan = v3.plan as Record<string, unknown>;
    for (const key of ['northStatus', 'units', 'legend', 'titleBlock', 'print']) delete plan[key];
    delete (v3.objects as Record<string, Record<string, unknown>>)[corridor.id]!.widthMeters;
    const migrated = parsePlanDocument(v3);
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.plan.northStatus).toBe('undefined');
    expect(migrated.plan.titleBlock.status).toBe('draft');
    expect(migrated.plan.print.paper).toBe('tabloid');
    expect((migrated.objects[corridor.id] as unknown as { widthMeters: unknown }).widthMeters).toBeNull();
  });
});

describe('corrections issues de la revue', () => {
  const printed = (layout: ReturnType<typeof layoutPage>) =>
    layout.titleBlock!.fit.cells.find((c) => c.label === 'Échelle')!.lines.join(' ');

  it('échelle du cartouche = échelle réelle de la carte (cartouche en bas, repli de la légende)', () => {
    const doc = photoDoc();
    doc.plan.calibration = { p1: P(0, 0), p2: P(1000, 0), distanceMeters: 250 };
    doc.plan.titleBlock.placement = 'bottom';
    doc.plan.titleBlock.notes = 'Note longue. '.repeat(40);
    let layout = layoutPage(new RecordingPainter(), input(doc), null);
    expect(printed(layout)).toContain(scaleRatioText(doc.plan.calibration, layout.transform.k)!);

    // Bâtiments dans les quatre coins : la légende « automatique » passe à côté de la carte.
    doc.plan.legend.placement = 'map-auto';
    for (const [x, y] of [
      [0, 0],
      [3000, 0],
      [0, 1650],
      [3000, 1650],
    ] as const)
      addObject(
        doc,
        createAreaObject(
          doc,
          { kind: 'rect', x, y, width: 1000, height: 600, cornerRadius: 0 },
          'building.dormitory',
        ),
      );
    layout = layoutPage(new RecordingPainter(), input(doc), null);
    expect(layout.legend!.overlay).toBe(false);
    expect(printed(layout)).toContain(scaleRatioText(doc.plan.calibration, layout.transform.k)!);
  });

  it('cartouche trop long : réduit puis raccourci de façon visible, jamais hors de son cadre', () => {
    const doc = photoDoc();
    doc.plan.titleBlock.notes = 'Consigne très longue à respecter sur le chantier. '.repeat(200);
    const print = { ...doc.plan.print, paper: 'letter' as const, orientation: 'portrait' as const };
    const p = new RecordingPainter();
    const layout = layoutPage(p, input(doc, { print, page: pageSize(print) }), null);
    const { rect, fit } = layout.titleBlock!;
    expect(fit.truncated).toBe(true);
    expect(layout.warnings.map((w) => w.code)).toContain('title-block-overflow');
    drawPage(p, input(doc, { print, page: pageSize(print) }), layout, {
      photo: null,
      symbols: null,
      background: 'white',
    });
    expect(p.texts.some((t) => t.text.includes('suite non imprimée'))).toBe(true);
    for (const t of p.texts) expect(t.y).toBeLessThanOrEqual(pageSize(print).height);
    expect(rect.y + rect.height).toBeLessThanOrEqual(pageSize(print).height - print.marginMm + 1e-6);
  });

  it('titre trop long : raccourci et signalé, sans chevaucher le statut', () => {
    const doc = photoDoc();
    doc.plan.titleBlock.title = 'Plan de circulation '.repeat(20);
    const p = new RecordingPainter();
    const layout = layoutPage(p, input(doc), null);
    const warnings = drawPage(p, input(doc), layout, { photo: null, symbols: null, background: 'white' });
    expect(warnings.some((w) => w.code === 'cut-text' && w.message.includes('Titre'))).toBe(true);
    const title = p.texts.find((t) => t.text.startsWith('Plan de circulation'))!;
    expect(title.text.endsWith('…')).toBe(true);
  });

  it('plan modifié après approbation : signalé, le bandeau demande une nouvelle approbation', () => {
    const doc = photoDoc();
    setPlanStatus(
      doc,
      'approved',
      { confirmed: true, approvedBy: 'A. Tremblay' },
      '2026-09-01T12:00:00.000Z',
    );
    doc.plan.updatedAt = '2026-09-02T12:00:00.000Z';
    const p = new RecordingPainter();
    const layout = layoutPage(p, input(doc), null);
    expect(layout.warnings.map((w) => w.code)).toContain('approval-stale');
    drawPage(p, input(doc), layout, { photo: null, symbols: null, background: 'white' });
    expect(p.texts.map((t) => t.text)).toContain('APPROUVÉ PUIS MODIFIÉ — À RÉAPPROUVER');
  });

  it('légende : un même pictogramme avec des textes différents donne deux entrées', () => {
    const doc = makeDocument();
    for (const text of ['20', '50']) {
      const icon = createIconObject(doc, P(0, 0), 'sign.speed-limit', 'Limite de vitesse');
      addObject(doc, { ...icon, text } as typeof icon);
    }
    expect(legendEntries(doc)).toHaveLength(2);
  });

  it('cases : zone à coins arrondis respectée ; trop de cases = refus sans modification', () => {
    const doc = makeDocument();
    const zone = createAreaObject(
      doc,
      { kind: 'rect', x: 0, y: 0, width: 100, height: 60, cornerRadius: 25 },
      'zone.parking',
    );
    addObject(doc, zone);
    generateStalls(doc, zone.id, { width: 10, length: 20, rows: 2, aisle: 5, angleDeg: 0 }, 1);
    const outline = roundedRectPoints(0, 0, 100, 60, 25);
    for (const s of Object.values(doc.objects).filter((o) => o.type === 'stall')) {
      const g = s.geometry as { x: number; y: number; width: number; height: number };
      for (const c of [
        P(g.x, g.y),
        P(g.x + g.width, g.y),
        P(g.x + g.width, g.y + g.height),
        P(g.x, g.y + g.height),
      ])
        expect(pointInPolygon(c, outline)).toBe(true);
    }
    const before = Object.keys(doc.objects).length;
    const big = createAreaObject(
      doc,
      { kind: 'rect', x: 0, y: 0, width: 4000, height: 3000, cornerRadius: 0 },
      'zone.parking',
    );
    addObject(doc, big);
    expect(() =>
      generateStalls(doc, big.id, { width: 2, length: 4, rows: 50, aisle: 1, angleDeg: 0 }, 1),
    ).toThrow(StallLimitError);
    expect(Object.keys(doc.objects).length).toBe(before + 1);
    expect(MAX_STALLS).toBe(2000);
  });
});
