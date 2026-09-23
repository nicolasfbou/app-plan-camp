import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlanDocument, createSite, nowIso } from '@/domain/model/factories.ts';
import {
  createAreaObject,
  createFlowObject,
  createIconObject,
  createTextObject,
} from '@/domain/model/objectFactory.ts';
import { addObject } from '@/domain/model/operations.ts';
import type { PlanDocument, Point, TextObject } from '@/domain/model/types.ts';
import { createView } from '@/domain/print/views.ts';
import { MIGRATIONS } from '@/domain/schema/migrations.ts';
import { parsePlanDocument } from '@/domain/schema/serialization.ts';
import {
  DamagedRevisionsError,
  exportCampplan,
  importCampplan,
  readCampplan,
} from '@/persistence/campplan.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { createRevisionFromDraft, revisionMetas } from '@/persistence/revisions.ts';
import { makeLargeDocument } from '@/test/fixtures.ts';
import { diffPlans, summarizeDiff } from './diff.ts';
import {
  allowedStatuses,
  changeRevisionStatus,
  deepFreeze,
  draftFromRevision,
  freezeRevision,
  isSealIntact,
  nextRevisionLabel,
  revisionMetaSchema,
  revisionStamp,
  type NewRevisionInput,
  RevisionError,
  RevisionIntegrityError,
} from './revision.ts';

const P = (x: number, y: number): Point => ({ x, y });
const INPUT: NewRevisionInput = {
  label: 'A',
  description: 'Première émission',
  author: 'N. Tremblay',
  date: '2026-10-02',
  reason: 'Émission initiale',
  comments: '',
  status: 'review',
};

function sampleDoc(): PlanDocument {
  const doc = createPlanDocument({ siteId: createSite('Camp 105').id, name: 'Circulation' });
  addObject(doc, createFlowObject(doc, [P(100, 100), P(900, 400)], 'heavy'));
  const zone = createAreaObject(
    doc,
    { kind: 'rect', x: 300, y: 300, width: 200, height: 100, cornerRadius: 0 },
    'zone.delivery',
  );
  zone.name = 'Débarquement';
  addObject(doc, zone);
  const text = createTextObject(doc, P(600, 200), { label: true, text: 'Route du sud', fontSize: 20 });
  addObject(doc, text);
  addObject(doc, createIconObject(doc, P(700, 500), 'sign.stop', 'Arrêt'));
  return doc;
}

const byName = (doc: PlanDocument, name: string) => Object.values(doc.objects).find((o) => o.name === name)!;

describe('comparaison', () => {
  it('objets ajoutés, supprimés, déplacés, redimensionnés, tracé, texte, style, calque', () => {
    const a = sampleDoc();
    const b = structuredClone(a);
    const flow = Object.values(b.objects).find((o) => o.type === 'flow')!;
    if (flow.geometry.kind === 'polyline') flow.geometry.points.push(P(1000, 800));
    const zone = byName(b, 'Débarquement');
    if (zone.geometry.kind === 'rect') zone.geometry.width = 240; // +20 % de surface
    const text = Object.values(b.objects).find((o): o is TextObject => o.type === 'text')!;
    text.text = 'Route du sud (fermée l’hiver)';
    const icon = byName(b, 'Arrêt');
    if (icon.geometry.kind === 'point') icon.geometry.x += 50;
    const removed = Object.values(a.objects).find((o) => o.type === 'flow')!;
    const newIcon = createIconObject(b, P(50, 50), 'sign.stop', 'Nouvel arrêt');
    addObject(b, newIcon);
    const beforeJson = JSON.stringify(a);
    const diff = diffPlans(deepFreeze(a), deepFreeze(b));
    expect(JSON.stringify(a)).toBe(beforeJson); // jamais modifié
    const kind = (id: string) => diff.objects.find((c) => c.id === id)?.primary;
    expect(kind(newIcon.id)).toBe('added');
    expect(kind(removed.id)).toBe('reshaped');
    expect(kind(zone.id)).toBe('resized');
    expect(diff.objects.find((c) => c.id === zone.id)!.sizeRatio).toBeCloseTo(1.2);
    expect(kind(text.id)).toBe('text');
    expect(kind(icon.id)).toBe('moved');
    expect(diff.objects.find((c) => c.id === icon.id)!.details[0]).toContain('50 px');
    const summary = summarizeDiff(diff);
    expect(summary).toContain('Pictogramme « Nouvel arrêt » ajouté');
    expect(summary).toContain('Zone « Débarquement » agrandie (+20 %)');
    expect(summary).toContain('Pictogramme « Arrêt » déplacé');

    // Suppression et changement de style / de calque.
    const c = structuredClone(b);
    delete c.objects[newIcon.id];
    const z = c.objects[zone.id]!;
    z.style = { ...z.style, fill: '#ff0000' };
    z.layerId = c.layers.find((l) => l.tier === 'safety')!.id;
    const d2 = diffPlans(b, c);
    expect(d2.objects.find((x) => x.id === newIcon.id)!.primary).toBe('removed');
    expect(d2.objects.find((x) => x.id === zone.id)!.kinds).toEqual(['style', 'layer']);
    expect(d2.objects.find((x) => x.id === zone.id)!.details.join()).toContain('remplissage');
  });

  it('calques, vues, impression, cartouche ; changements automatiques distingués', () => {
    const a = sampleDoc();
    const b = structuredClone(a);
    b.layers[0]!.name = 'Zones générales';
    b.plan.views.push(createView(b, 'suppliers'));
    b.plan.print.paper = 'a3';
    b.plan.titleBlock.notes = 'Circulation des fournisseurs modifiée';
    // Automatiques : horodatage seul, renumérotation sans changement d'ordre, référence de fichier.
    for (const o of Object.values(b.objects)) {
      o.updatedAt = '2030-01-01T00:00:00.000Z';
      o.zIndex += 10;
    }
    const diff = diffPlans(a, b, { schemaVersions: { before: 5, after: 6 } });
    expect(diff.objects).toEqual([]);
    const areas = diff.settings.map((s) => `${s.area}:${s.label}`);
    expect(areas).toContain('layers:calque renommé');
    expect(areas).toContain('views:vue ajoutée');
    expect(areas).toContain('print:format du papier');
    expect(areas).toContain('titleBlock:Notes');
    expect(diff.auto.map((x) => x.label)).toEqual([
      'Horodatages mis à jour',
      'Ordre d’affichage renuméroté',
      'Format de données converti',
    ]);
    expect(diff.counts.user).toBe(diff.settings.length);
    const summary = summarizeDiff(diff);
    expect(summary.some((l) => l.startsWith('Cartouche mis à jour'))).toBe(true);
    expect(summary.some((l) => l.startsWith('Vue « Fournisseurs »'))).toBe(true);
    // Deux états identiques : aucun changement.
    expect(diffPlans(a, structuredClone(a)).counts.user).toBe(0);
  });
});

describe('révision figée', () => {
  it('numéro suivant, sceau, statuts, approbation irréversible', async () => {
    expect(nextRevisionLabel([])).toBe('A');
    expect(nextRevisionLabel(['A', 'B'])).toBe('C');
    expect(nextRevisionLabel(['Z'])).toBe('AA');
    expect(nextRevisionLabel(['3'])).toBe('4');
    const doc = sampleDoc();
    const now = '2026-10-02T12:00:00.000Z';
    const { meta, json } = await freezeRevision(doc, INPUT, {
      id: 'r1',
      existingLabels: [],
      parentId: null,
      changes: null,
      now,
    });
    expect(JSON.parse(json)).toEqual(doc);
    expect(meta.snapshot.objectCount).toBe(4);
    expect(await isSealIntact(meta)).toBe(true);
    await expect(
      freezeRevision(doc, INPUT, { id: 'r2', existingLabels: ['a'], parentId: null, changes: null, now }),
    ).rejects.toThrow(RevisionError);
    // Approbation : approbateur nommé et confirmation obligatoires.
    await expect(changeRevisionStatus(meta, { to: 'approved', by: 'X', comment: '' }, now)).rejects.toThrow(
      /confirmation/,
    );
    const approved = await changeRevisionStatus(
      meta,
      { to: 'approved', by: 'M. Gagnon', comment: 'Conforme', confirmed: true, approvalDate: '2026-10-05' },
      now,
    );
    expect(approved.approval).toMatchObject({
      by: 'M. Gagnon',
      date: '2026-10-05',
      comment: 'Conforme',
      revisionAuthor: 'N. Tremblay',
    });
    expect(allowedStatuses(approved)).toEqual(['archived']);
    await expect(changeRevisionStatus(approved, { to: 'review', by: 'X', comment: '' }, now)).rejects.toThrow(
      /approuvée/,
    );
    const archived = await changeRevisionStatus(
      approved,
      { to: 'archived', by: 'M. Gagnon', comment: '' },
      now,
    );
    expect(archived.approval).toEqual(approved.approval); // l'approbation reste
    expect(archived.statusLog.map((s) => s.to)).toEqual(['review', 'approved', 'archived']);
    expect(allowedStatuses(archived)).toEqual([]);
    // Altération des champs figés : détectée, plus aucun changement permis.
    const tampered = { ...approved, approval: { ...approved.approval!, by: 'Quelqu’un d’autre' } };
    expect(await isSealIntact(tampered)).toBe(false);
    await expect(
      changeRevisionStatus(tampered, { to: 'archived', by: 'X', comment: '' }, now),
    ).rejects.toThrow(RevisionIntegrityError);
  });

  it('brouillon issu d’une révision : copie indépendante, sans approbation', () => {
    const current = sampleDoc();
    const snapshot = deepFreeze(structuredClone(current));
    const other = structuredClone(current);
    other.plan.id = 'autre';
    const draft = draftFromRevision(other, snapshot, { id: 'r1', label: 'B' }, nowIso());
    expect(draft.plan.id).toBe('autre');
    expect(draft.plan.draftBase?.label).toBe('B');
    expect(draft.plan.titleBlock.status).toBe('draft');
    draft.objects = {};
    expect(Object.keys(snapshot.objects)).toHaveLength(4);
  });

  it('migration 5 → 6 : anciens plans sans révision', () => {
    const doc = sampleDoc();
    const v5 = JSON.parse(JSON.stringify(doc));
    v5.schemaVersion = 5;
    delete v5.plan.draftBase;
    const migrated = parsePlanDocument(v5, MIGRATIONS);
    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.plan.draftBase).toBeNull();
  });
});

describe('dépôt et fichier .campplan', () => {
  let repo: IndexedDbRepository;
  beforeEach(() => {
    repo = new IndexedDbRepository(`rev-${crypto.randomUUID()}`);
  });
  afterEach(() => repo.close());

  async function withPhoto(doc: PlanDocument) {
    const bytes = new Uint8Array(4096).map((_, i) => (i * 31) % 251);
    const blob = await repo.putBlob(bytes.buffer, 'image/jpeg');
    doc.plan.baseImage = {
      blobId: blob.id,
      fileName: 'camp-105.jpg',
      mimeType: 'image/jpeg',
      byteLength: blob.byteLength,
      sha256: blob.sha256,
      width: 2000,
      height: 1500,
      exifOrientation: 1,
      importedAt: nowIso(),
      source: { kind: 'image' },
    };
    return blob;
  }

  it('A → brouillon → B : historique, immutabilité, photo jamais dupliquée, suppression protégée', async () => {
    const site = createSite('Camp 105');
    await repo.saveSite(site);
    const doc = sampleDoc();
    doc.plan.siteId = site.id;
    const photo = await withPhoto(doc);
    await repo.savePlan(doc);
    const a = await createRevisionFromDraft(repo, doc, INPUT);
    expect(a.changes).toBeNull();
    // Le brouillon continue de vivre ; la révision A ne bouge pas.
    const zone = byName(doc, 'Débarquement');
    if (zone.geometry.kind === 'rect') zone.geometry.x += 100;
    doc.plan.titleBlock.notes = 'Modifié';
    await repo.savePlan(doc);
    const b = await createRevisionFromDraft(repo, doc, { ...INPUT, label: 'B', description: 'Circulation' });
    expect(b.parentId).toBe(a.id);
    expect(b.changes).toMatchObject({ sinceLabel: 'A', user: 2 });
    expect(b.changes!.lines).toContain('Zone « Débarquement » déplacée');
    const loadedA = await repo.loadRevision(a.id);
    expect(byName(loadedA.doc, 'Débarquement').geometry).toMatchObject({ x: 300 });
    expect(() => {
      (loadedA.doc.plan as { name: string }).name = 'x';
    }).toThrow(); // figée en mémoire
    await expect(createRevisionFromDraft(repo, doc, { ...INPUT, label: 'b' })).rejects.toThrow(/existe déjà/);
    // Une seule photo stockée pour le brouillon et les deux révisions.
    expect(loadedA.doc.plan.baseImage!.blobId).toBe(photo.id);
    await repo.deleteOrphanBlobs(0);
    expect(await repo.getBlob(photo.id)).toBeDefined();

    // Approbation, puis suppression refusée ; révision non approuvée supprimable.
    await repo.setRevisionStatus(a.id, { to: 'approved', by: 'M. Gagnon', comment: '', confirmed: true });
    await expect(repo.deleteRevision(a.id)).rejects.toThrow(/approuvée/);
    await expect(repo.setRevisionStatus(a.id, { to: 'draft', by: 'X', comment: '' })).rejects.toThrow(
      /approuvée/,
    );

    // Export .campplan → import dans une base vide : révisions intactes, photo identique.
    const { bytes } = await exportCampplan(repo, doc.plan.id);
    const content = await readCampplan(bytes);
    expect(content.revisions.map((r) => r.meta.label)).toEqual(['A', 'B']);
    expect(content.manifest.files).toHaveLength(1); // la photo, une seule fois
    const empty = new IndexedDbRepository(`rev-${crypto.randomUUID()}`);
    try {
      const { planId } = await importCampplan(empty, content, {
        target: { kind: 'new-site', name: 'Camp 105' },
        mode: 'copy',
        planName: 'Circulation',
      });
      const metas = await revisionMetas(empty, planId);
      expect(metas.map((m) => [m.label, m.status])).toEqual([
        ['A', 'approved'],
        ['B', 'review'],
      ]);
      expect(metas[1]!.parentId).toBe(metas[0]!.id);
      const ra = await empty.loadRevision(metas[0]!.id);
      const rb = await empty.loadRevision(metas[1]!.id);
      const diff = diffPlans(ra.doc, rb.doc);
      expect(diff.objects.map((o) => o.primary)).toEqual(['moved']);
      const stored = await empty.getBlob(ra.doc.plan.baseImage!.blobId);
      expect(stored!.sha256).toBe(photo.sha256);
      expect(rb.doc.plan.baseImage!.blobId).toBe(ra.doc.plan.baseImage!.blobId);
      // Suppression du plan : révisions et photo retirées.
      await empty.deletePlan(planId);
      expect(await empty.listRevisions(planId)).toEqual([]);
      expect(await empty.getBlob(stored!.id)).toBeUndefined();
    } finally {
      empty.close();
    }

    // Fichier altéré : refusé.
    const zip = await import('fflate');
    const entries = zip.unzipSync(bytes);
    const path = Object.keys(entries).find((p) => p.startsWith('revisions/'))!;
    entries[path] = zip.strToU8(zip.strFromU8(entries[path]!).replace('Débarquement', 'Debarquement'));
    await expect(readCampplan(zip.zipSync(entries))).rejects.toThrow(/corrompu/);

    await repo.deleteRevision(b.id);
    expect((await revisionMetas(repo, doc.plan.id)).map((m) => m.label)).toEqual(['A']);
  });

  it('performance : 20 révisions de plusieurs centaines d’objets, listées sans charger les instantanés', async () => {
    const doc = makeLargeDocument(600);
    await repo.savePlan(doc);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const o = Object.values(doc.objects)[i]!;
      if (o.geometry.kind === 'point') o.geometry.x += 10;
      o.name = `${o.name} (r${i})`;
      await createRevisionFromDraft(repo, doc, {
        ...INPUT,
        label: nextRevisionLabel((await revisionMetas(repo, doc.plan.id)).map((m) => m.label)),
      });
    }
    const created = performance.now() - t0;
    const t1 = performance.now();
    const list = await repo.listRevisions(doc.plan.id);
    const listed = performance.now() - t1;
    expect(list).toHaveLength(20);
    const t2 = performance.now();
    const [first, last] = await Promise.all([
      repo.loadRevision(list[0]!.id),
      repo.loadRevision(list[19]!.id),
    ]);
    const diff = diffPlans(first.doc, last.doc);
    const compared = performance.now() - t2;
    expect(diff.counts.user).toBeGreaterThan(0);
    console.info(
      `20 révisions × 600 objets : création ${Math.round(created)} ms, liste ${Math.round(listed)} ms, comparaison ${Math.round(compared)} ms`,
    );
    expect(listed).toBeLessThan(2000);
  }, 60_000);
});

describe('corrections de la revue (phase 7)', () => {
  let repo: IndexedDbRepository;
  beforeEach(() => {
    repo = new IndexedDbRepository(`rev-${crypto.randomUUID()}`);
  });
  afterEach(() => repo.close());
  type Tables = {
    db: { revisionSnapshots: { put(r: unknown): Promise<unknown> }; blobs: { count(): Promise<number> } };
  };
  const tables = (r: IndexedDbRepository) => (r as unknown as Tables).db;

  async function setup() {
    const site = createSite('Camp 105');
    await repo.saveSite(site);
    const doc = sampleDoc();
    doc.plan.siteId = site.id;
    const bytes = new Uint8Array(2048).map((_, i) => (i * 7) % 251);
    const blob = await repo.putBlob(bytes.buffer, 'image/jpeg');
    doc.plan.baseImage = {
      blobId: blob.id,
      fileName: 'camp-105.jpg',
      mimeType: 'image/jpeg',
      byteLength: blob.byteLength,
      sha256: blob.sha256,
      width: 2000,
      height: 1500,
      exifOrientation: 1,
      importedAt: nowIso(),
      source: { kind: 'image' },
    };
    await repo.savePlan(doc);
    return { doc, site };
  }

  it('statut « Approuvé » sans approbation : refusé ; statut modifié : sceau non conforme', async () => {
    const { meta } = await freezeRevision(sampleDoc(), INPUT, {
      id: 'r1',
      existingLabels: [],
      parentId: null,
      changes: null,
      now: nowIso(),
    });
    expect(revisionMetaSchema.safeParse({ ...meta, status: 'approved' }).success).toBe(false);
    expect(await isSealIntact({ ...meta, status: 'draft' })).toBe(false);
    const approved = await changeRevisionStatus(
      meta,
      { to: 'approved', by: 'M. Gagnon', comment: '', confirmed: true },
      nowIso(),
    );
    const archived = await changeRevisionStatus(
      approved,
      { to: 'archived', by: 'M. Gagnon', comment: '' },
      nowIso(),
    );
    // Archivée après approbation : toujours imprimée comme approuvée.
    expect(revisionStamp(archived)).toMatchObject({ approved: true, statusLabel: 'Archivé (approuvé)' });
  });

  it('approbation refusée si l’instantané est altéré ; export : révision altérée signalée, export sans elle sur demande', async () => {
    const { doc } = await setup();
    const a = await createRevisionFromDraft(repo, doc, INPUT);
    await tables(repo).revisionSnapshots.put({ id: a.id, json: '{"altéré":true}' });
    await expect(
      repo.setRevisionStatus(a.id, { to: 'approved', by: 'X', comment: '', confirmed: true }),
    ).rejects.toThrow(RevisionIntegrityError);
    await expect(exportCampplan(repo, doc.plan.id)).rejects.toThrow(DamagedRevisionsError);
    const partial = await exportCampplan(repo, doc.plan.id, { skipDamagedRevisions: true });
    expect(partial.skippedRevisions).toEqual(['A']);
    expect((await readCampplan(partial.bytes)).revisions).toEqual([]);
  });

  it('remplacement : photo jamais dupliquée ; historiques divergents refusés', async () => {
    const { doc } = await setup();
    await createRevisionFromDraft(repo, doc, INPUT);
    const exported = await exportCampplan(repo, doc.plan.id);
    // Même historique : import en remplacement → aucune nouvelle copie de la photo.
    const content = await readCampplan(exported.bytes);
    await importCampplan(repo, content, {
      target: { kind: 'new-site', name: 'x' },
      mode: 'replace',
      planName: doc.plan.name,
    });
    expect(await tables(repo).blobs.count()).toBe(1);
    expect(await revisionMetas(repo, doc.plan.id)).toHaveLength(1);
    // Ailleurs, une autre révision « B » a été créée : fichier refusé en remplacement.
    const other = new IndexedDbRepository(`rev-${crypto.randomUUID()}`);
    try {
      await importCampplan(other, content, {
        target: { kind: 'new-site', name: 'x' },
        mode: 'copy',
        planName: 'P',
      });
      const [plan] = await other.listPlans((await other.listSites())[0]!.id);
      const otherDoc = (await other.loadPlan(plan!.id))!;
      otherDoc.objects = {};
      await other.savePlan(otherDoc);
      await createRevisionFromDraft(other, otherDoc, { ...INPUT, label: 'B', description: 'ailleurs' });
      doc.plan.titleBlock.notes = 'ici';
      await repo.savePlan(doc);
      await createRevisionFromDraft(repo, doc, { ...INPUT, label: 'B', description: 'ici' });
      const divergent = await readCampplan((await exportCampplan(other, otherDoc.plan.id)).bytes);
      // Même identifiant de plan que dans `repo` pour tester le remplacement.
      divergent.doc.plan.id = doc.plan.id;
      await expect(
        importCampplan(repo, divergent, {
          target: { kind: 'new-site', name: 'x' },
          mode: 'replace',
          planName: 'P',
        }),
      ).rejects.toThrow(/historiques divergents/);
    } finally {
      other.close();
    }
  });

  it('brouillon repris d’une révision approuvée : 0 changement de l’utilisateur ; déplacé ET agrandi signalés', () => {
    const snapshot = sampleDoc();
    snapshot.plan.titleBlock.status = 'approved';
    snapshot.plan.titleBlock.approvedAt = nowIso();
    const draft = draftFromRevision(snapshot, snapshot, { id: 'rA', label: 'A' }, nowIso());
    const diff = diffPlans(snapshot, draft, { beforeRevisionId: 'rA' });
    expect(diff.counts.user).toBe(0);
    expect(diff.auto.map((x) => x.label)).toContain('Statut du brouillon remis à « Brouillon »');

    const moved = structuredClone(snapshot);
    const icon = byName(moved, 'Arrêt');
    if (icon.type === 'icon' && icon.geometry.kind === 'point') {
      icon.geometry.x += 450;
      icon.size *= 2;
    }
    const change = diffPlans(snapshot, moved).objects.find((o) => o.id === icon.id)!;
    expect(change.kinds).toEqual(['resized', 'moved']);
    expect(change.shift?.x).toBeCloseTo(450);
  });
});
