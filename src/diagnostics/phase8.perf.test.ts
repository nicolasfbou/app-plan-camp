/**
 * Mesures de fiabilité à grande échelle (exécutées seulement avec PERF=1) :
 *   PERF=1 PERF_PHOTO=<photo.jpg> PERF_PHOTO_W=<l> PERF_PHOTO_H=<h> PERF_OUT=<dossier> \
 *     npx vitest run src/diagnostics/phase8.perf.test.ts
 * Projet : photo de 50 MP (fichier fourni, jamais modifié), 1 000 objets, 4 vues, 3 pictogrammes
 * importés, un modèle, 20 révisions. Mesures : santé, nettoyage, diagnostic, copie de secours,
 * export et import `.campplan` dans un navigateur vide (fake-indexeddb). Avec PERF_OUT : écrit
 * les mesures et le `.campplan` (utilisé ensuite par `bench/phase8-browser-perf.mjs`).
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@/domain/image/hash.ts';
import { createSite, newId, nowIso } from '@/domain/model/factories.ts';
import { createView } from '@/domain/print/views.ts';
import { nextRevisionLabel } from '@/domain/revisions/revision.ts';
import { templateFromPlan } from '@/domain/templates/template.ts';
import { exportCampplan, importCampplan, readCampplan } from '@/persistence/campplan.ts';
import { exportEmergency } from '@/persistence/emergency.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { createRevisionFromDraft, revisionMetas } from '@/persistence/revisions.ts';
import { makeLargeDocument } from '@/test/fixtures.ts';
import { planCleanup } from './cleanup.ts';
import { buildDiagnostic } from './diagnostic.ts';
import { runPlanHealth, worstStatus } from './health.ts';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const fs = async () =>
  (await import(/* @vite-ignore */ 'node:fs' as string)) as {
    readFileSync(path: string): Uint8Array;
    writeFileSync(path: string, data: Uint8Array | string): void;
  };
const ms = (t0: number) => Math.round(performance.now() - t0);
// PNG 1×1 (pictogrammes importés du banc d'essai).
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

describe.skipIf(!env.PERF)('fiabilité à grande échelle', () => {
  it('50 MP, 1 000 objets, 20 révisions, vues, pictogrammes, modèle', async () => {
    const r: Record<string, unknown> = {};
    const photo = env.PERF_PHOTO ? (await fs()).readFileSync(env.PERF_PHOTO) : new Uint8Array(4_000_000);
    const width = Number(env.PERF_PHOTO_W ?? 8660);
    const height = Number(env.PERF_PHOTO_H ?? 5774);
    const repo = new IndexedDbRepository(`perf8-${crypto.randomUUID()}`);
    const site = createSite('Camp perf');
    await repo.saveSite(site);
    const doc = makeLargeDocument(1000);
    doc.plan.siteId = site.id;
    doc.plan.name = 'Plan perf';
    const blob = await repo.putBlob(photo.slice().buffer, 'image/jpeg');
    doc.plan.baseImage = {
      blobId: blob.id,
      fileName: 'photo-50mp.jpg',
      mimeType: 'image/jpeg',
      byteLength: blob.byteLength,
      sha256: blob.sha256,
      width,
      height,
      exifOrientation: 1,
      importedAt: nowIso(),
      source: { kind: 'image' },
    };
    for (let i = 0; i < 3; i++) {
      const bytes = PNG.slice();
      bytes[bytes.length - 13] = i; // contenu distinct → empreinte distincte
      const stored = await repo.putBlob(bytes.buffer, 'image/png');
      const id = newId();
      doc.assets[id] = {
        id,
        name: `Pictogramme ${i + 1}`,
        blobId: stored.id,
        mimeType: 'image/png',
        byteLength: stored.byteLength,
        sha256: await sha256Hex(bytes.buffer),
        createdAt: nowIso(),
      };
    }
    for (const audience of ['employees', 'suppliers', 'management', 'safety'] as const)
      doc.plan.views.push(createView(doc, audience));
    await repo.saveTemplate({ template: templateFromPlan(doc, 'Modèle perf'), logo: null });
    let version = await repo.savePlan(doc);
    r.photo = { octets: photo.length, largeur: width, hauteur: height, megapixels: (width * height) / 1e6 };
    r.objets = Object.keys(doc.objects).length;
    r.vues = doc.plan.views.length;

    const creation: number[] = [];
    for (let i = 0; i < 20; i++) {
      for (const o of Object.values(doc.objects).slice(i * 10, i * 10 + 10)) {
        if (o.geometry.kind === 'point' || o.geometry.kind === 'rect') o.geometry.x += 15;
        o.name = `${o.name} (r${i})`;
      }
      version = await repo.savePlan(doc, { expectedVersion: version });
      const labels = (await revisionMetas(repo, doc.plan.id)).map((m) => m.label);
      const t0 = performance.now();
      await createRevisionFromDraft(repo, doc, {
        label: nextRevisionLabel(labels),
        description: `Révision ${i + 1}`,
        author: 'Banc d’essai',
        date: '2026-10-01',
        reason: '',
        comments: '',
        status: 'review',
      });
      creation.push(ms(t0));
    }
    r.revisions = 20;
    r.creationRevisionMoyenneMs = Math.round(creation.reduce((a, b) => a + b, 0) / creation.length);

    let t0 = performance.now();
    const health = await runPlanHealth(repo, doc.plan.id, {
      lastBackupAt: null,
      backupIntervalMinutes: 15,
      lockMode: 'editor',
    });
    r.santeMs = ms(t0);
    r.santeGlobale = worstStatus(health);
    r.santeControles = Object.fromEntries(health.map((c) => [c.id, c.status]));
    t0 = performance.now();
    const cleanup = await planCleanup(repo);
    r.analyseNettoyageMs = ms(t0);
    r.nettoyageElements = cleanup.length;
    t0 = performance.now();
    const diagnostic = await buildDiagnostic(repo, { planId: doc.plan.id, health });
    r.diagnosticMs = ms(t0);
    r.diagnosticOctets = JSON.stringify(diagnostic).length;
    t0 = performance.now();
    const emergency = await exportEmergency(repo, doc.plan.id);
    r.copieSecoursMs = ms(t0);
    r.copieSecoursOctets = emergency.bytes.length;
    r.copieSecoursComplete = emergency.complete;
    t0 = performance.now();
    const { bytes } = await exportCampplan(repo, doc.plan.id);
    r.exportCampplanMs = ms(t0);
    r.campplanOctets = bytes.length;

    const empty = new IndexedDbRepository(`perf8-${crypto.randomUUID()}`);
    t0 = performance.now();
    const content = await readCampplan(bytes);
    const { planId } = await importCampplan(empty, content, {
      target: { kind: 'new-site', name: 'Camp perf' },
      mode: 'copy',
      planName: 'Plan perf',
    });
    r.importNavigateurVideMs = ms(t0);
    const imported = (await empty.openPlan(planId))!.doc;
    r.importPhotoShaIdentique = imported.plan.baseImage?.sha256 === blob.sha256;
    r.importRevisions = (await revisionMetas(empty, planId)).length;
    r.importPictogrammes = Object.keys(imported.assets).length;
    r.importVues = imported.plan.views.length;
    const reimportHealth = await runPlanHealth(empty, planId, {
      lastBackupAt: null,
      backupIntervalMinutes: 15,
      lockMode: 'editor',
    });
    r.santeApresImport = worstStatus(reimportHealth);

    console.info(JSON.stringify(r, null, 2));
    if (env.PERF_OUT) {
      const { writeFileSync } = await fs();
      writeFileSync(`${env.PERF_OUT}/perf-phase8.json`, JSON.stringify(r, null, 2));
      writeFileSync(`${env.PERF_OUT}/perf-50mp-1000-objets-20-revisions.campplan`, bytes);
    }
    expect(r.copieSecoursComplete).toBe(true);
    expect(r.importPhotoShaIdentique).toBe(true);
    expect(r.importRevisions).toBe(20);
    expect(r.importPictogrammes).toBe(3);
    expect(r.importVues).toBe(4);
    empty.close();
    repo.close();
  }, 600_000);
});
