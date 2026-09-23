import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupPlan,
  readBackupLog,
  type DirectoryHandle,
  saveBackupSettings,
  DEFAULT_SETTINGS,
} from '@/backups/backupService.ts';
import {
  backupFileName,
  DEFAULT_POLICY,
  parseBackupFileName,
  selectBackupsToDelete,
  type BackupFile,
} from '@/backups/rotation.ts';
import { createPlanDocument, createSite, nowIso } from '@/domain/model/factories.ts';
import { createIconObject } from '@/domain/model/objectFactory.ts';
import { addObject } from '@/domain/model/operations.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { salvagePlanDocument } from '@/domain/schema/salvage.ts';
import { exportCampplan, importCampplan, readCampplan } from '@/persistence/campplan.ts';
import { exportEmergency } from '@/persistence/emergency.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { PlanConflictError } from '@/persistence/ProjectRepository.ts';
import { createRevisionFromDraft, revisionMetas } from '@/persistence/revisions.ts';
import { recoveryJournalTexts, writeRecovery } from '@/persistence/recovery.ts';
import { applyCleanup, planCleanup } from './cleanup.ts';
import { buildDiagnostic } from './diagnostic.ts';
import { clearErrorLog, logEvent, MAX_ENTRIES, readErrorLog } from './errorLog.ts';
import { applyRepair, runPlanHealth, worstStatus } from './health.ts';

const OLD = '2020-01-01T00:00:00.000Z';
const REV = {
  label: 'A',
  description: 'Émission',
  author: 'N. Tremblay',
  date: '2026-10-02',
  reason: '',
  comments: '',
  status: 'review' as const,
};

let repo: IndexedDbRepository;
beforeEach(() => {
  repo = new IndexedDbRepository(`p8-${crypto.randomUUID()}`);
  localStorage.clear();
});
afterEach(() => repo.close());

type Db = {
  db: {
    blobs: { put(r: unknown): Promise<unknown>; count(): Promise<number>; get(id: string): Promise<unknown> };
    revisionSnapshots: { put(r: unknown): Promise<unknown> };
    plans: {
      get(id: string): Promise<{ blobIds: string[] } & Record<string, unknown>>;
      put(r: unknown): Promise<unknown>;
    };
    viewPrefs: { put(r: unknown): Promise<unknown> };
    sites: { delete(id: string): Promise<unknown> };
  };
};
const db = (r: IndexedDbRepository) => (r as unknown as Db).db;

async function setup(): Promise<PlanDocument> {
  const site = createSite('Camp 105');
  await repo.saveSite(site);
  const doc = createPlanDocument({ siteId: site.id, name: 'Circulation' });
  const bytes = new Uint8Array(4096).map((_, i) => (i * 13) % 251);
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
  addObject(doc, createIconObject(doc, { x: 100, y: 100 }, 'sign.stop', 'Arrêt'));
  await repo.savePlan(doc);
  return doc;
}

describe('rotation des sauvegardes', () => {
  const at = (d: string) => new Date(d);
  it('noms horodatés relus ; rapides, quotidiennes, hebdomadaires ; approuvées toujours conservées', () => {
    const name = backupFileName('Plan / hiver', at('2026-10-02T14:05:09'), 'approved', 'B');
    expect(name).toBe('Plan - hiver - 2026-10-02 14h05m09 - approuvee-B.campplan');
    expect(parseBackupFileName(name)).toMatchObject({ kind: 'approved', label: 'B' });
    expect(parseBackupFileName('notes personnelles.campplan')).toBeNull(); // jamais géré
    const files: BackupFile[] = [];
    // 30 jours, 3 sauvegardes par jour.
    for (let d = 1; d <= 30; d++)
      for (const h of [9, 13, 17])
        files.push({ name: `q-${d}-${h}`, at: new Date(2026, 8, d, h), kind: 'quick' });
    files.push({ name: 'approved-A', at: new Date(2026, 8, 2, 10), kind: 'approved', label: 'A' });
    const toDelete = new Set(
      selectBackupsToDelete(files, { quick: 10, daily: 7, weekly: 4, keepApproved: true }),
    );
    const kept = files.filter((f) => !toDelete.has(f.name)).map((f) => f.name);
    expect(kept).toContain('approved-A');
    expect(kept).toContain('q-30-17'); // la plus récente
    // 10 rapides (30/17 … 27/13) + 1 par jour sur 7 jours + 1 par semaine sur 4 semaines.
    expect(kept.filter((n) => n.startsWith('q-')).length).toBeLessThanOrEqual(10 + 7 + 4);
    expect(kept).toContain('q-24-17'); // dernier du 24 (quotidienne)
    expect(kept).not.toContain('q-1-9');
    // Politique à zéro : seule la plus récente reste (plus les approuvées).
    const minimal = new Set(
      selectBackupsToDelete(files, { quick: 0, daily: 0, weekly: 0, keepApproved: true }),
    );
    expect(
      files
        .filter((f) => !minimal.has(f.name))
        .map((f) => f.name)
        .sort(),
    ).toEqual(['approved-A', 'q-30-17']);
  });
});

describe('journal des erreurs', () => {
  it('borné, sans données du plan, vidable', () => {
    for (let i = 0; i < MAX_ENTRIES + 20; i++)
      logEvent('import', new Error(`erreur ${i}`), { context: 'fichier.campplan' });
    const log = readErrorLog();
    expect(log).toHaveLength(MAX_ENTRIES);
    expect(log.at(-1)).toMatchObject({
      category: 'import',
      level: 'error',
      message: `Error: erreur ${MAX_ENTRIES + 19}`,
    });
    clearErrorLog();
    expect(readErrorLog()).toEqual([]);
  });
});

describe('versions et conflits', () => {
  it('un enregistrement fondé sur une version périmée est refusé (jamais d’écrasement silencieux)', async () => {
    const doc = await setup();
    const opened = (await repo.openPlan(doc.plan.id))!;
    const other = structuredClone(opened.doc);
    other.plan.name = 'Modifié dans l’onglet B';
    const v2 = await repo.savePlan(other, { expectedVersion: opened.version });
    expect(v2).toBe(opened.version + 1);
    const mine = structuredClone(opened.doc);
    mine.plan.name = 'Modifié dans l’onglet A';
    await expect(repo.savePlan(mine, { expectedVersion: opened.version })).rejects.toThrow(PlanConflictError);
    expect((await repo.loadPlan(doc.plan.id))!.plan.name).toBe('Modifié dans l’onglet B');
    // Un import en remplacement fait aussi changer la version.
    const { bytes } = await exportCampplan(repo, doc.plan.id);
    await importCampplan(repo, await readCampplan(bytes), {
      target: { kind: 'new-site', name: 'x' },
      mode: 'replace',
      planName: 'P',
    });
    expect(await repo.getPlanVersion(doc.plan.id)).toBe(v2 + 1);
  });
});

describe('récupération partielle', () => {
  it('document endommagé : objets, vues et champs illisibles retirés et listés', () => {
    const doc = createPlanDocument({ siteId: 's', name: 'Plan' });
    addObject(doc, createIconObject(doc, { x: 1, y: 1 }, 'sign.stop', 'Arrêt'));
    const raw = JSON.parse(JSON.stringify(doc));
    raw.objects.cassé = { id: 'cassé', type: 'inconnu' };
    raw.plan.views = [{ id: 'v', name: 'vue cassée' }];
    raw.plan.titleBlock = 'illisible';
    const result = salvagePlanDocument(raw)!;
    expect(Object.keys(result.doc.objects)).toHaveLength(1);
    expect(result.doc.plan.views).toEqual([]);
    expect(result.problems.join(' ')).toMatch(/1 objet.*retiré/);
    expect(result.problems.join(' ')).toMatch(/vue.*retirée/);
    expect(result.problems.join(' ')).toMatch(/titleBlock/);
    expect(salvagePlanDocument('pas du json')).toBeNull();
  });

  it('.campplan : révision corrompue → refusé ; en récupération : importé sans elle, problèmes listés, copie marquée', async () => {
    const doc = await setup();
    await createRevisionFromDraft(repo, doc, REV);
    doc.plan.titleBlock.notes = 'B';
    await repo.savePlan(doc);
    await createRevisionFromDraft(repo, doc, { ...REV, label: 'B' });
    const { bytes } = await exportCampplan(repo, doc.plan.id);
    const entries = unzipSync(bytes);
    const revPath = Object.keys(entries).filter((p) => p.startsWith('revisions/'))[1]!;
    entries[revPath] = strToU8(strFromU8(entries[revPath]!).replace('"B"', '"X"'));
    const damaged = zipSync(entries);
    await expect(readCampplan(damaged)).rejects.toThrow(/corrompu/);
    const content = await readCampplan(damaged, { recovery: true });
    expect(content.problems.join(' ')).toMatch(/Révision .* corrompu/);
    expect(content.revisions.map((r) => r.meta.label)).toEqual(['A']);
    await expect(
      importCampplan(repo, content, {
        target: { kind: 'new-site', name: 'x' },
        mode: 'replace',
        planName: 'P',
      }),
    ).rejects.toThrow(/copie/);
    const empty = new IndexedDbRepository(`p8-${crypto.randomUUID()}`);
    try {
      const { planId } = await importCampplan(empty, content, {
        target: { kind: 'new-site', name: 'x' },
        mode: 'copy',
        planName: 'P (récupéré)',
      });
      const imported = (await empty.loadPlan(planId))!;
      expect((imported.plan.metadata.recovery as { problems: string[] }).problems.length).toBeGreaterThan(0);
      expect((await revisionMetas(empty, planId)).map((m) => m.label)).toEqual(['A']);
      expect((await empty.getBlob(imported.plan.baseImage!.blobId))!.sha256).toBe(doc.plan.baseImage!.sha256);
    } finally {
      empty.close();
    }
  });

  it('plan.json illisible : brouillon repris de la dernière révision (dit) ; photo aussi corrompue : rien de récupérable', async () => {
    const doc = await setup();
    await createRevisionFromDraft(repo, doc, REV);
    const entries = unzipSync((await exportCampplan(repo, doc.plan.id)).bytes);
    entries['plan.json'] = strToU8('{ endommagé');
    const fromRevision = await readCampplan(zipSync(entries), { recovery: true });
    expect(fromRevision.problems.join(' ')).toMatch(
      /Brouillon perdu : reconstitué à partir de la révision A/,
    );
    expect(fromRevision.doc.plan.baseImage?.sha256).toBe(doc.plan.baseImage!.sha256);
    const photo = Object.keys(entries).find((p) => p.startsWith('fichiers/background'))!;
    entries[photo] = entries[photo]!.map((b) => b ^ 1);
    // La révision référence la photo corrompue (jamais modifiée) : rien à reconstruire — refusé.
    await expect(readCampplan(zipSync(entries), { recovery: true })).rejects.toThrow(/Aucune donnée de plan/);
  });

  it('photo corrompue seule : plan importé SANS photo, révisions écartées, tout est dit', async () => {
    const doc = await setup();
    await createRevisionFromDraft(repo, doc, REV);
    const entries = unzipSync((await exportCampplan(repo, doc.plan.id)).bytes);
    const photo = Object.keys(entries).find((p) => p.startsWith('fichiers/background'))!;
    entries[photo] = entries[photo]!.map((b) => b ^ 1);
    const content = await readCampplan(zipSync(entries), { recovery: true });
    expect(content.doc.plan.baseImage).toBeNull();
    expect(content.revisions).toEqual([]);
    expect(content.problems.join(' ')).toMatch(/SANS sa photo/);
  });
});

describe('copie de secours', () => {
  it('complète si tout est sain ; sinon plan + photo + révisions valides, parties manquantes listées', async () => {
    const doc = await setup();
    const a = await createRevisionFromDraft(repo, doc, REV);
    const ok = await exportEmergency(repo, doc.plan.id);
    expect(ok.complete).toBe(true);
    expect((await readCampplan(ok.bytes)).doc.plan.name).toBe('Circulation'); // réimportable normalement
    doc.plan.titleBlock.notes = 'B';
    await repo.savePlan(doc);
    const b = await createRevisionFromDraft(repo, doc, { ...REV, label: 'B' });
    await db(repo).revisionSnapshots.put({ id: b.id, json: '{"altéré":1}' });
    const partial = await exportEmergency(repo, doc.plan.id);
    expect(partial.complete).toBe(false);
    expect(partial.problems.join(' ')).toMatch(/Révision B non incluse/);
    expect(partial.included).toMatchObject({ plan: 'intact', photo: true, revisions: 1 });
    const zip = unzipSync(partial.bytes);
    expect(strFromU8(zip['LISEZ-MOI.txt']!)).toMatch(/INCOMPLÈTE/);
    await expect(readCampplan(partial.bytes)).rejects.toThrow(/INCOMPLÈTE/);
    const recovered = await readCampplan(partial.bytes, { recovery: true });
    expect(recovered.revisions.map((r) => r.meta.id)).toEqual([a.id]);
    // Plan illisible dans le stockage : données brutes jointes + dernière révision valide.
    const record = await db(repo).plans.get(doc.plan.id);
    await db(repo).plans.put({ ...record, document: { schemaVersion: 6, plan: 'cassé' } });
    const fromRevision = await exportEmergency(repo, doc.plan.id);
    expect(fromRevision.included.plan).toBe('depuis-revision');
    expect(Object.keys(unzipSync(fromRevision.bytes))).toContain('plan-brut.json');
  });
});

describe('santé, réparations, nettoyage, diagnostic', () => {
  it('contrôles vert / jaune / rouge ; réparations contrôlées', async () => {
    const doc = await setup();
    await createRevisionFromDraft(repo, doc, REV);
    await db(repo).blobs.put({
      id: 'orphelin',
      bytes: new ArrayBuffer(6 * 1024 * 1024),
      mimeType: 'image/png',
      byteLength: 6 * 1024 * 1024,
      sha256: '0'.repeat(64),
      createdAt: OLD,
    });
    await db(repo).blobs.put({
      id: 'recent',
      bytes: new ArrayBuffer(10),
      mimeType: 'image/png',
      byteLength: 10,
      sha256: '1'.repeat(64),
      createdAt: nowIso(),
    });
    await db(repo).viewPrefs.put({ planId: doc.plan.id, centerX: Number.NaN, centerY: 0, scale: 1 });
    const record = await db(repo).plans.get(doc.plan.id);
    await db(repo).plans.put({ ...record, blobIds: [] }); // index secondaire incohérent
    const ctx = { lastBackupAt: null, backupIntervalMinutes: 15, lockMode: 'editor' };
    const checks = await runPlanHealth(repo, doc.plan.id, ctx);
    const status = (id: string) => checks.find((c) => c.id === id)?.status;
    expect(status('photo')).toBe('ok');
    expect(status('photo-sha')).toBe('ok');
    expect(status('revisions')).toBe('ok');
    expect(status('export')).toBe('ok');
    expect(status('index')).toBe('warn');
    expect(status('orphans')).toBe('warn');
    expect(status('prefs')).toBe('warn');
    expect(status('backup')).toBe('error');
    expect(worstStatus(checks)).toBe('error');
    for (const repair of ['reindex', 'delete-orphans', 'clear-view-prefs'] as const)
      await applyRepair(repo, doc.plan.id, repair);
    const after = await runPlanHealth(repo, doc.plan.id, { ...ctx, lastBackupAt: nowIso() });
    for (const id of ['index', 'orphans', 'prefs', 'backup'])
      expect(after.find((c) => c.id === id)?.status).toBe('ok');
    expect(await db(repo).blobs.get('recent')).toBeDefined(); // fichier récent : jamais supprimé
    // Photo altérée : rouge, jamais « réparée ».
    const blob = (await db(repo).blobs.get(doc.plan.baseImage!.blobId)) as Record<string, unknown>;
    await db(repo).blobs.put({ ...blob, bytes: new Uint8Array(4096).buffer });
    const broken = await runPlanHealth(repo, doc.plan.id, ctx);
    expect(broken.find((c) => c.id === 'photo-sha')).toMatchObject({ status: 'error' });
    expect(broken.find((c) => c.id === 'photo-sha')?.repair).toBeUndefined();
  });

  it('nettoyage : espace annoncé avant ; jamais un fichier référencé ; plan ouvert non touché', async () => {
    const doc = await setup();
    const icon = await repo.putBlob(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>').buffer,
      'image/svg+xml',
    );
    doc.assets.inutile = {
      id: 'inutile',
      name: 'Inutile',
      blobId: icon.id,
      mimeType: 'image/svg+xml',
      byteLength: icon.byteLength,
      sha256: icon.sha256,
      createdAt: nowIso(),
    };
    await repo.savePlan(doc);
    await createRevisionFromDraft(repo, doc, REV); // la révision référence aussi le pictogramme
    await db(repo).blobs.put({
      id: 'orphelin',
      bytes: new ArrayBuffer(300 * 1024),
      mimeType: 'application/pdf',
      byteLength: 300 * 1024,
      sha256: '0'.repeat(64),
      createdAt: OLD,
    });
    const items = await planCleanup(repo);
    expect(items.map((i) => [i.kind, i.count])).toEqual([
      ['orphan-pdfs', 1],
      ['unused-symbols', 1],
    ]);
    expect(items[0]!.bytes).toBe(300 * 1024);
    // Plan ouvert en édition : les pictogrammes de son brouillon ne sont pas touchés.
    const skipped = await applyCleanup(repo, items, async () => new Set([doc.plan.id]));
    expect(skipped[1]!.skipped[0]).toMatch(/ouvert/);
    const results = await applyCleanup(repo, await planCleanup(repo), async () => new Set());
    expect(results.find((r) => r.kind === 'unused-symbols')).toMatchObject({ done: 1, bytes: 0 }); // encore dans la révision
    expect(await repo.getBlob(icon.id)).toBeDefined();
    expect((await repo.loadPlan(doc.plan.id))!.assets).toEqual({});
    expect(await repo.getBlob(doc.plan.baseImage!.blobId)).toBeDefined();
  });

  it('diagnostic : ni photo ni contenu ni noms par défaut ; journal et contrôles inclus', async () => {
    const doc = await setup();
    logEvent('import', new Error('Fichier corrompu'));
    const report = await buildDiagnostic(repo, {
      planId: doc.plan.id,
      health: [{ id: 'x', label: 'X', status: 'ok', detail: 'd' }],
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain('Circulation');
    expect(text).not.toContain('Camp 105');
    expect(text).not.toContain('Arrêt');
    expect(text).toContain(doc.plan.baseImage!.sha256);
    expect(report.plans[0]).toMatchObject({ objects: 1, layers: doc.layers.length, photo: { bytes: 4096 } });
    expect(report.errorLog.at(-1)?.message).toContain('Fichier corrompu');
    const named = await buildDiagnostic(repo, { includeNames: true });
    expect(JSON.stringify(named)).toContain('Circulation');
  });
});

describe('sauvegarde externe (dossier simulé en mémoire)', () => {
  /** Dossier en mémoire au comportement de la File System Access API. */
  function memoryDir(
    name = 'racine',
  ): DirectoryHandle & { files: Map<string, Uint8Array>; dirs: Map<string, ReturnType<typeof memoryDir>> } {
    const files = new Map<string, Uint8Array>();
    const dirs = new Map<string, ReturnType<typeof memoryDir>>();
    return {
      kind: 'directory',
      name,
      files,
      dirs,
      async getDirectoryHandle(n) {
        if (!dirs.has(n)) dirs.set(n, memoryDir(n));
        return dirs.get(n)!;
      },
      async getFileHandle(n) {
        return {
          async createWritable() {
            const chunks: Uint8Array[] = [];
            return {
              async write(d: Uint8Array) {
                chunks.push(d);
              },
              async close() {
                files.set(n, chunks[0]!);
              },
            };
          },
        };
      },
      async removeEntry(n) {
        files.delete(n);
      },
      async *values() {
        for (const n of files.keys()) yield { kind: 'file', name: n };
      },
      async queryPermission() {
        return 'granted';
      },
    };
  }

  it('fichier horodaté écrit, rotation appliquée, approuvées conservées, historique', async () => {
    const doc = await setup();
    const root = memoryDir();
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => root;
    // Un vrai dossier (FileSystemDirectoryHandle) se stocke dans IndexedDB ; le dossier simulé
    // (avec des fonctions) est fourni par un dépôt enveloppé.
    const wrapped = new Proxy(repo, {
      get(target, prop) {
        if (prop === 'getSetting')
          return async (key: string) => (key === 'backup.directory' ? root : target.getSetting(key));
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await saveBackupSettings(
      { ...DEFAULT_SETTINGS, policy: { ...DEFAULT_POLICY, quick: 2, daily: 0, weekly: 0 } },
      wrapped,
    );
    for (let i = 0; i < 5; i++)
      await backupPlan({ planId: doc.plan.id, kind: 'quick', now: new Date(2026, 9, 2, 10, i) }, wrapped);
    await backupPlan(
      { planId: doc.plan.id, kind: 'approved', label: 'A', now: new Date(2026, 9, 1, 9, 0) },
      wrapped,
    );
    const folder = root.dirs.get('Camp 105')!.dirs.get(`Circulation [${doc.plan.id.slice(0, 8)}]`)!;
    const names = [...folder.files.keys()].sort();
    expect(names).toEqual([
      'Circulation - 2026-10-01 09h00m00 - approuvee-A.campplan',
      'Circulation - 2026-10-02 10h03m00 - rapide.campplan',
      'Circulation - 2026-10-02 10h04m00 - rapide.campplan',
    ]);
    // Le fichier écrit est un .campplan valide, photo identique.
    const content = await readCampplan(folder.files.get(names[1]!)!);
    expect(content.files.get(doc.plan.baseImage!.blobId)!.sha256).toBe(doc.plan.baseImage!.sha256);
    const log = await readBackupLog(repo);
    expect(log).toHaveLength(6);
    expect(log.every((e) => e.ok && e.destination === 'folder')).toBe(true);
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
});

describe('revue indépendante — régressions', () => {
  it('orphelins : un index périmé ne rend JAMAIS orphelin un fichier référencé (plan, révision, journal)', async () => {
    const doc = await setup();
    await createRevisionFromDraft(repo, doc, REV);
    const photoId = doc.plan.baseImage!.blobId;
    // Index du plan ET de la révision vidés (corruption) : le contenu fait foi.
    const record = await db(repo).plans.get(doc.plan.id);
    await db(repo).plans.put({ ...record, blobIds: [] });
    expect((await repo.listOrphanBlobs()).map((o) => o.id)).not.toContain(photoId);
    expect(await repo.deleteOrphanBlobs(0)).toBe(0);
    expect(await repo.getBlob(photoId)).toBeDefined();
    // Fichier référencé seulement par un journal de récupération (photo importée puis fermeture brutale).
    const lone = await repo.putBlob(new Uint8Array([1, 2, 3]).buffer, 'image/png');
    writeRecovery({ ...doc, plan: { ...doc.plan, name: lone.id } }, 1);
    expect(await repo.deleteOrphanBlobs(0, recoveryJournalTexts())).toBe(0);
    expect(await repo.deleteOrphanBlobs(0)).toBe(1); // sans le journal : vraiment orphelin
  });

  it('enregistrement d’un plan supprimé ailleurs : conflit, jamais une recréation silencieuse', async () => {
    const doc = await setup();
    const version = (await repo.getPlanVersion(doc.plan.id))!;
    await repo.deletePlan(doc.plan.id);
    await expect(repo.savePlan(doc, { expectedVersion: version })).rejects.toBeInstanceOf(PlanConflictError);
    expect(await repo.getPlanVersion(doc.plan.id)).toBeUndefined();
  });

  it('journal d’un plan dont le camp manque : jamais considéré « périmé »', async () => {
    const doc = await setup();
    await db(repo).sites.delete(doc.plan.siteId);
    writeRecovery(doc, 1);
    expect(await repo.listPlanIds()).toContain(doc.plan.id);
    const items = await planCleanup(repo);
    expect(items.find((i) => i.kind === 'stale-journals')).toBeUndefined();
  });

  it('copie de secours : document en mémoire (non enregistré) prioritaire ; révision altérée jointe brute', async () => {
    const doc = await setup();
    const b = await createRevisionFromDraft(repo, doc, REV);
    await db(repo).revisionSnapshots.put({ id: b.id, json: '{"altéré":1}' });
    const memory = structuredClone(doc);
    memory.plan.titleBlock.notes = 'Modification non enregistrée';
    const r = await exportEmergency(repo, doc.plan.id, { memoryDoc: memory });
    expect(r.included.plan).toBe('memoire');
    expect(r.complete).toBe(false);
    const zip = unzipSync(r.bytes);
    expect(strFromU8(zip['plan.json']!)).toContain('Modification non enregistrée');
    expect(strFromU8(zip['plan-enregistre.json']!)).not.toContain('Modification non enregistrée');
    const raw = Object.keys(zip).find((k) => k.startsWith('revisions-brutes/'));
    expect(raw).toBeDefined();
    expect(strFromU8(zip[raw!]!)).toContain('altéré');
  });

  it('diagnostic : noms de camp, de plan et de fichiers masqués dans le journal et les contrôles', async () => {
    const doc = await setup();
    logEvent('backup', new Error('Échec de la sauvegarde de Circulation'), {
      context: 'Camp 105 - Circulation - 2026.campplan',
    });
    const report = await buildDiagnostic(repo, {
      planId: doc.plan.id,
      health: [{ id: 'photo', label: 'Photo', status: 'ok', detail: 'camp-105.jpg présente' }],
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain('Circulation');
    expect(text).not.toContain('Camp 105');
    expect(text).not.toContain('camp-105.jpg');
    expect(text).toContain('«nom masqué»');
  });

  it('rotation : les copies partielles ne chassent jamais les complètes', () => {
    const at = (h: number) => new Date(2026, 9, 1, h, 0, 0);
    const complete = { name: backupFileName('Plan', at(0), 'quick'), at: at(0), kind: 'quick' as const };
    const partials = Array.from({ length: 15 }, (_, i) => {
      const name = backupFileName('Plan', at(i + 1), 'quick', undefined, true);
      return parseBackupFileName(name)!;
    });
    expect(partials[0]!.partial).toBe(true);
    const toDelete = selectBackupsToDelete([complete, ...partials], DEFAULT_POLICY);
    expect(toDelete).not.toContain(complete.name);
    expect(15 + 1 - toDelete.length).toBe(DEFAULT_POLICY.quick + 1);
    const revision = parseBackupFileName(backupFileName('Plan', at(3), 'revision', 'B', true))!;
    expect(revision).toMatchObject({ kind: 'revision', label: 'B', partial: true });
  });

  it('archive tronquée (répertoire central perdu) : récupération élément par élément', async () => {
    const doc = await setup();
    await createRevisionFromDraft(repo, doc, REV);
    const { bytes } = await exportCampplan(repo, doc.plan.id);
    const truncated = bytes.slice(0, bytes.length - 60);
    await expect(readCampplan(truncated)).rejects.toThrow();
    const content = await readCampplan(truncated, { recovery: true });
    expect(content.doc.plan.name).toBe('Circulation');
    expect(content.doc.plan.baseImage?.sha256).toBe(doc.plan.baseImage!.sha256);
    expect(content.problems.join(' ')).toMatch(/tronquée/);
  });
});
