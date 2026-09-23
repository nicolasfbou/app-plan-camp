import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlanDocument, createSite } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import { bytesEqual, makeLargeDocument } from '@/test/fixtures.ts';
import {
  availablePlanName,
  CampplanError,
  exportCampplan,
  importCampplan,
  readCampplan,
} from './campplan.ts';
import { IndexedDbRepository } from './indexedDbRepository.ts';

let source: IndexedDbRepository;
let target: IndexedDbRepository;
let doc: PlanDocument;
let photo: ArrayBuffer;

function randomBytes(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes.subarray(0, Math.min(length, 65536)));
  for (let i = 65536; i < length; i++) bytes[i] = (i * 31) & 255;
  return bytes.buffer;
}

beforeEach(async () => {
  source = new IndexedDbRepository(`src-${crypto.randomUUID()}`);
  target = new IndexedDbRepository(`dst-${crypto.randomUUID()}`); // navigateur « vide »
  const site = createSite('Camp 105');
  await source.saveSite(site);
  photo = randomBytes(700_000);
  const blob = await source.putBlob(photo, 'image/jpeg');
  const base = makeLargeDocument(400); // plusieurs centaines d'objets
  doc = {
    ...base,
    plan: {
      ...base.plan,
      siteId: site.id,
      name: 'Plan général',
      calibration: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceMeters: 50 },
      baseImage: {
        blobId: blob.id,
        fileName: 'camp-105.jpg',
        mimeType: 'image/jpeg',
        byteLength: blob.byteLength,
        sha256: blob.sha256,
        width: 4000,
        height: 2250,
        exifOrientation: 1,
        importedAt: '2026-09-22T12:00:00.000Z',
        source: { kind: 'image' },
      },
    },
  };
  await source.savePlan(doc);
});

afterEach(() => {
  source.close();
  target.close();
});

const withoutBlobIds = (d: PlanDocument) => ({
  ...d,
  plan: { ...d.plan, siteId: '', baseImage: { ...d.plan.baseImage!, blobId: '' } },
});

describe('export / import .campplan', () => {
  it('aller-retour vers un stockage VIDE : plan identique, photo identique à l’octet et au SHA-256', async () => {
    const { bytes, fileName } = await exportCampplan(source, doc.plan.id);
    expect(fileName).toBe('Camp 105 - Plan général.campplan');
    const content = await readCampplan(bytes);
    expect(content.manifest).toMatchObject({
      format: 'campplan',
      formatVersion: 2,
      schemaVersion: 3,
      counts: { objects: 400 },
    });
    const { siteId, planId } = await importCampplan(target, content, {
      target: { kind: 'new-site', name: 'Camp 105' },
      mode: 'copy',
      planName: 'Plan général',
    });

    expect(planId).toBe(doc.plan.id); // identité conservée quand le plan n'existe pas encore
    const imported = (await target.loadPlan(planId))!;
    expect(withoutBlobIds(imported)).toEqual(withoutBlobIds(doc));
    expect(imported.plan.calibration).toEqual(doc.plan.calibration);
    const stored = (await target.getBlob(imported.plan.baseImage!.blobId))!;
    expect(bytesEqual(stored.bytes, photo)).toBe(true);
    expect(await sha256Hex(stored.bytes)).toBe(doc.plan.baseImage!.sha256);
    expect((await target.getSite(siteId))!.name).toBe('Camp 105');
  });

  it('importer un plan déjà présent : copie avec nouvel identifiant et nom distinct, l’original est intact', async () => {
    const content = await readCampplan((await exportCampplan(source, doc.plan.id)).bytes);
    const names = (await source.listPlans(doc.plan.siteId)).map((p) => p.name);
    const name = availablePlanName(content.doc.plan.name, names);
    expect(name).toBe('Plan général (importé)');
    const { planId } = await importCampplan(source, content, {
      target: { kind: 'existing-site', siteId: doc.plan.siteId },
      mode: 'copy',
      planName: name,
    });
    expect(planId).not.toBe(doc.plan.id);
    expect((await source.listPlans(doc.plan.siteId)).map((p) => p.name)).toEqual([
      'Plan général',
      'Plan général (importé)',
    ]);
    expect(await source.loadPlan(doc.plan.id)).toEqual(doc);
  });

  it('remplacement explicite : même identifiant, contenu du fichier', async () => {
    const content = await readCampplan((await exportCampplan(source, doc.plan.id)).bytes);
    const modified = structuredClone(doc);
    modified.objects = {};
    await source.savePlan(modified);
    await importCampplan(source, content, {
      target: { kind: 'existing-site', siteId: doc.plan.siteId },
      mode: 'replace',
      planName: 'Plan général',
    });
    expect(Object.keys((await source.loadPlan(doc.plan.id))!.objects)).toHaveLength(400);
    expect(await source.listPlans(doc.plan.siteId)).toHaveLength(1);
  });

  it('remplacement : le plan reste dans SON camp (jamais déplacé) ; l’ancienne photo non partagée est supprimée', async () => {
    const content = await readCampplan((await exportCampplan(source, doc.plan.id)).bytes);
    const oldPhoto = await source.putBlob(randomBytes(1000), 'image/jpeg');
    const local = structuredClone(doc);
    local.plan.baseImage = { ...local.plan.baseImage!, blobId: oldPhoto.id, sha256: oldPhoto.sha256 };
    await source.savePlan(local);
    const { siteId } = await importCampplan(source, content, {
      target: { kind: 'new-site', name: 'Camp 105 (renommé ailleurs)' },
      mode: 'replace',
      planName: 'Plan général',
    });
    expect(siteId).toBe(doc.plan.siteId);
    expect(await source.listSites()).toHaveLength(1);
    expect(await source.getBlob(oldPhoto.id)).toBeUndefined();
    const replaced = (await source.loadPlan(doc.plan.id))!;
    expect(bytesEqual((await source.getBlob(replaced.plan.baseImage!.blobId))!.bytes, photo)).toBe(true);
  });

  it('échec d’écriture pendant l’import : aucun camp créé, le plan remplacé est intact', async () => {
    const content = await readCampplan((await exportCampplan(source, doc.plan.id)).bytes);
    const failingSave = () => Promise.reject(new Error('QuotaExceededError'));
    target.savePlan = failingSave;
    await expect(
      importCampplan(target, content, {
        target: { kind: 'new-site', name: 'Camp 105' },
        mode: 'copy',
        planName: 'P',
      }),
    ).rejects.toThrow('QuotaExceededError');
    expect(await target.listSites()).toEqual([]);

    const modified = structuredClone(doc);
    modified.objects = {};
    await source.savePlan(modified);
    source.savePlan = failingSave;
    await expect(
      importCampplan(source, content, {
        target: { kind: 'existing-site', siteId: doc.plan.siteId },
        mode: 'replace',
        planName: 'Plan général',
      }),
    ).rejects.toThrow('QuotaExceededError');
    expect(await source.loadPlan(doc.plan.id)).toEqual(modified);
    expect(await source.getBlob(doc.plan.baseImage!.blobId)).toBeDefined();
  });

  it('un plan existant mais illisible compte comme existant : jamais écrasé par une copie', async () => {
    const content = await readCampplan((await exportCampplan(source, doc.plan.id)).bytes);
    const raw = source as unknown as {
      db: { plans: { update(id: string, changes: object): Promise<number> } };
    };
    await raw.db.plans.update(doc.plan.id, { document: { illisible: true } });
    await expect(source.loadPlan(doc.plan.id)).rejects.toThrow();
    const { planId } = await importCampplan(source, content, {
      target: { kind: 'existing-site', siteId: doc.plan.siteId },
      mode: 'copy',
      planName: 'Plan général (importé)',
    });
    expect(planId).not.toBe(doc.plan.id);
    expect((await source.getPlanSummary(doc.plan.id))?.name).toBe('Plan général');
  });

  it('plan PDF : le PDF d’origine est aussi exporté et vérifié', async () => {
    const pdf = await source.putBlob(strToU8('%PDF-1.4 contenu').slice().buffer, 'application/pdf');
    const withPdf: PlanDocument = {
      ...doc,
      plan: {
        ...doc.plan,
        baseImage: {
          ...doc.plan.baseImage!,
          source: {
            kind: 'pdf',
            pdfBlobId: pdf.id,
            pdfFileName: 'plan.pdf',
            pdfByteLength: pdf.byteLength,
            pdfSha256: pdf.sha256,
            pageCount: 2,
            page: 1,
            dpi: 150,
          },
        },
      },
    };
    await source.savePlan(withPdf);
    const content = await readCampplan((await exportCampplan(source, doc.plan.id)).bytes);
    expect(content.manifest.files.map((f) => f.role)).toEqual(['background', 'pdf']);
    const { planId } = await importCampplan(target, content, {
      target: { kind: 'new-site', name: 'X' },
      mode: 'copy',
      planName: 'P',
    });
    const imported = (await target.loadPlan(planId))!;
    const source2 = imported.plan.baseImage!.source;
    expect(source2.kind === 'pdf' && (await target.getBlob(source2.pdfBlobId))!.sha256).toBe(pdf.sha256);
  });
});

describe('pictogrammes importés', () => {
  const svg = strToU8(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
  );
  async function withSymbol(): Promise<PlanDocument> {
    const blob = await source.putBlob(svg.slice().buffer, 'image/svg+xml');
    const next: PlanDocument = structuredClone(doc);
    next.assets = {
      a1: {
        id: 'a1',
        name: 'Borne de recharge',
        blobId: blob.id,
        mimeType: 'image/svg+xml',
        byteLength: blob.byteLength,
        sha256: blob.sha256,
        createdAt: '2026-09-22T12:00:00.000Z',
      },
    };
    const layerId = next.layers.find((l) => l.tier === 'signage')!.id;
    const {
      icon: _icon,
      showName: _showName,
      ...zone
    } = Object.values(next.objects)[0] as Record<string, unknown>;
    next.objects.icon1 = {
      ...zone,
      id: 'icon1',
      layerId,
      type: 'icon',
      geometry: { kind: 'point', x: 50, y: 60 },
      symbolId: 'asset:a1',
      size: 40,
      text: null,
    } as PlanDocument['objects'][string];
    await source.savePlan(next);
    return next;
  }

  it('exportés avec le plan, vérifiés, réimportés à l’octet près dans un stockage vide', async () => {
    const next = await withSymbol();
    const content = await readCampplan((await exportCampplan(source, doc.plan.id)).bytes);
    expect(content.manifest.files.map((f) => f.role)).toEqual(['background', 'symbol']);
    const { planId } = await importCampplan(target, content, {
      target: { kind: 'new-site', name: 'Camp 105' },
      mode: 'copy',
      planName: 'Plan',
    });
    const imported = (await target.loadPlan(planId))!;
    const asset = imported.assets.a1!;
    expect(asset.blobId).not.toBe(next.assets.a1!.blobId); // nouvel identifiant de stockage
    const stored = (await target.getBlob(asset.blobId))!;
    expect(stored.sha256).toBe(next.assets.a1!.sha256);
    expect(bytesEqual(stored.bytes, svg.slice().buffer)).toBe(true);
    expect(imported.objects.icon1).toEqual(next.objects.icon1); // le pictogramme placé reste modifiable
  });

  it('pictogramme altéré dans l’archive : refusé', async () => {
    await withSymbol();
    const entries = unzipSync((await exportCampplan(source, doc.plan.id)).bytes);
    const path = Object.keys(entries).find((p) => p.startsWith('fichiers/symbol-'))!;
    const altered = entries[path]!.slice();
    altered[10] = altered[10]! ^ 1;
    await expect(readCampplan(zipSync({ ...entries, [path]: altered }))).rejects.toThrow(
      /pictogramme est corrompu/,
    );
  });

  it('une archive au format 1 (phase 3) se lit toujours', async () => {
    const entries = unzipSync((await exportCampplan(source, doc.plan.id)).bytes);
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    manifest.formatVersion = 1;
    const content = await readCampplan(
      zipSync({ ...entries, 'manifest.json': strToU8(JSON.stringify(manifest)) }),
    );
    expect(content.manifest.formatVersion).toBe(2);
  });
});

describe('fichiers corrompus ou invalides : refusés, rien n’est écrit', () => {
  const rezip = (entries: Record<string, Uint8Array>) => zipSync(entries);
  let entries: Record<string, Uint8Array>;
  beforeEach(async () => {
    entries = unzipSync((await exportCampplan(source, doc.plan.id)).bytes);
  });
  const expectRejected = async (bytes: Uint8Array, message: RegExp) => {
    await expect(readCampplan(bytes)).rejects.toThrow(CampplanError);
    await expect(readCampplan(bytes)).rejects.toThrow(message);
    expect(await target.listSites()).toEqual([]);
  };

  it('pas une archive / archive tronquée', async () => {
    await expectRejected(strToU8('bonjour'), /illisible/);
    const bytes = rezip(entries);
    await expectRejected(bytes.slice(0, bytes.length / 2), /illisible/);
  });

  it('un octet de la photo modifié', async () => {
    const photoPath = Object.keys(entries).find((p) => p.startsWith('fichiers/'))!;
    const tampered = entries[photoPath]!.slice();
    tampered[1000] = tampered[1000]! ^ 0xff;
    await expectRejected(rezip({ ...entries, [photoPath]: tampered }), /photo est corrompu/);
  });

  it('photo manquante', async () => {
    const photoPath = Object.keys(entries).find((p) => p.startsWith('fichiers/'))!;
    const { [photoPath]: _removed, ...rest } = entries;
    await expectRejected(rezip(rest), /Fichier manquant/);
  });

  it('plan.json modifié', async () => {
    const plan = JSON.parse(new TextDecoder().decode(entries['plan.json']));
    plan.plan.name = 'Falsifié';
    await expectRejected(
      rezip({ ...entries, 'plan.json': strToU8(JSON.stringify(plan)) }),
      /plan contenu dans le fichier est corrompu/,
    );
  });

  it('format d’une version plus récente', async () => {
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    manifest.formatVersion = 99;
    await expectRejected(
      rezip({ ...entries, 'manifest.json': strToU8(JSON.stringify(manifest)) }),
      /version plus récente/,
    );
  });

  it('autre type de fichier ZIP', async () => {
    await expectRejected(rezip({ 'document.txt': strToU8('x') }), /incomplet/);
  });
});

describe('plan sans photo', () => {
  it('s’exporte et se réimporte', async () => {
    const empty = createPlanDocument({ siteId: doc.plan.siteId, name: 'Vide' });
    await source.savePlan(empty);
    const content = await readCampplan((await exportCampplan(source, empty.plan.id)).bytes);
    expect(content.manifest.files).toEqual([]);
    const { planId } = await importCampplan(target, content, {
      target: { kind: 'new-site', name: 'Camp' },
      mode: 'copy',
      planName: 'Vide',
    });
    expect((await target.loadPlan(planId))!.plan.baseImage).toBeNull();
  });
});
