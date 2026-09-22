import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlanDocument, createSite } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import { ProjectFormatError } from '@/domain/schema/migrations.ts';
import { bytesEqual, makeLargeDocument } from '@/test/fixtures.ts';
import { IndexedDbRepository } from './indexedDbRepository.ts';

let repo: IndexedDbRepository;
let dbName: string;

beforeEach(() => {
  dbName = `test-${crypto.randomUUID()}`;
  repo = new IndexedDbRepository(dbName);
});

afterEach(() => repo.close());

function randomBytes(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 65536)
    crypto.getRandomValues(bytes.subarray(i, Math.min(length, i + 65536)));
  return bytes.buffer;
}

async function withImage(doc: PlanDocument, bytes: ArrayBuffer): Promise<PlanDocument> {
  const blob = await repo.putBlob(bytes, 'image/jpeg');
  return {
    ...doc,
    plan: {
      ...doc.plan,
      baseImage: {
        blobId: blob.id,
        fileName: 'camp-105.jpg',
        mimeType: blob.mimeType,
        byteLength: blob.byteLength,
        sha256: blob.sha256,
        width: 8000,
        height: 6000,
        exifOrientation: 1,
        importedAt: '2026-01-15T12:00:00.000Z',
        source: { kind: 'image' },
      },
    },
  };
}

describe('sauvegarde / réouverture', () => {
  it('rouvre exactement le même plan après fermeture de la base', async () => {
    const site = createSite('Camp 105');
    await repo.saveSite(site);
    const doc = { ...makeLargeDocument(250), plan: { ...makeLargeDocument(1).plan, siteId: site.id } };
    await repo.savePlan(doc);
    repo.close();

    repo = new IndexedDbRepository(dbName);
    expect(await repo.getSite(site.id)).toEqual(site);
    expect(await repo.loadPlan(doc.plan.id)).toEqual(doc);
    expect(await repo.listPlans(site.id)).toEqual([
      expect.objectContaining({ id: doc.plan.id, name: doc.plan.name, kind: 'general' }),
    ]);
  });

  it('gère plusieurs camps et plusieurs plans par camp', async () => {
    const camp105 = createSite('Camp 105');
    const camp60 = createSite('Camp 60');
    await repo.saveSite(camp105);
    await repo.saveSite(camp60);
    await repo.savePlan(
      createPlanDocument({ siteId: camp105.id, name: 'Circulation hiver', kind: 'winter-circulation' }),
    );
    await repo.savePlan(
      createPlanDocument({ siteId: camp105.id, name: 'Circulation été', kind: 'summer-circulation' }),
    );
    await repo.savePlan(createPlanDocument({ siteId: camp60.id, name: 'Sécurité', kind: 'safety' }));

    expect((await repo.listSites()).map((s) => s.name)).toEqual(['Camp 105', 'Camp 60']);
    expect((await repo.listPlans(camp105.id)).map((p) => p.name)).toEqual([
      'Circulation été',
      'Circulation hiver',
    ]);
  });

  it('refuse de charger un plan corrompu plutôt que d’ouvrir des données fausses', async () => {
    const doc = createPlanDocument({ siteId: 's', name: 'Plan' });
    await repo.savePlan({ ...doc, layers: [] } as unknown as PlanDocument);
    await expect(repo.loadPlan(doc.plan.id)).rejects.toThrow(ProjectFormatError);
  });
});

describe('image originale non modifiée', () => {
  it('restitue les octets à l’identique, avec la même empreinte SHA-256', async () => {
    const original = randomBytes(3 * 1024 * 1024 + 17);
    const originalHash = await sha256Hex(original);
    const doc = await withImage(createPlanDocument({ siteId: 's', name: 'Plan' }), original);
    await repo.savePlan(doc);
    repo.close();

    repo = new IndexedDbRepository(dbName);
    const reopened = await repo.loadPlan(doc.plan.id);
    const stored = await repo.getBlob(reopened!.plan.baseImage!.blobId);
    expect(stored!.byteLength).toBe(original.byteLength);
    expect(bytesEqual(stored!.bytes, original)).toBe(true);
    expect(await sha256Hex(stored!.bytes)).toBe(originalHash);
    expect(reopened!.plan.baseImage!.sha256).toBe(originalHash);
  }, 30_000);

  it('ne supprime pas une photo encore utilisée par un plan dupliqué', async () => {
    const doc = await withImage(createPlanDocument({ siteId: 's', name: 'A' }), randomBytes(1024));
    const copy: PlanDocument = { ...doc, plan: { ...doc.plan, id: 'copie', name: 'B' } };
    await repo.savePlan(doc);
    await repo.savePlan(copy);
    const blobId = doc.plan.baseImage!.blobId;

    await repo.deletePlan(doc.plan.id);
    expect(await repo.getBlob(blobId)).toBeDefined();
    await repo.deletePlan(copy.plan.id);
    expect(await repo.getBlob(blobId)).toBeUndefined();
  });

  it('supprimer un site supprime ses plans et leurs photos', async () => {
    const site = createSite('Camp 132');
    await repo.saveSite(site);
    const doc = await withImage(createPlanDocument({ siteId: site.id, name: 'Plan' }), randomBytes(2048));
    await repo.savePlan(doc);
    await repo.deleteSite(site.id);
    expect(await repo.getSite(site.id)).toBeUndefined();
    expect(await repo.loadPlan(doc.plan.id)).toBeUndefined();
    expect(await repo.getBlob(doc.plan.baseImage!.blobId)).toBeUndefined();
  });
});

describe('robustesse', () => {
  it('un plan corrompu n’empêche ni de lister ni de supprimer les autres', async () => {
    const good = createPlanDocument({ siteId: 's', name: 'Bon' });
    const bad = createPlanDocument({ siteId: 's', name: 'Abîmé' });
    await repo.savePlan(good);
    await repo.savePlan({ ...bad, objects: { x: 'corrompu' } } as unknown as PlanDocument);

    expect((await repo.listPlans('s')).map((p) => p.name)).toEqual(['Abîmé', 'Bon']);
    await expect(repo.loadPlan(bad.plan.id)).rejects.toThrow(ProjectFormatError);
    await repo.deletePlan(good.plan.id);
    await repo.deletePlan(bad.plan.id);
    expect(await repo.listPlans('s')).toEqual([]);
  });
});

describe('camps et plans', () => {
  it('duplique un plan : nouveau plan indépendant, même photo d’origine partagée', async () => {
    const { duplicatePlanDocument } = await import('@/domain/model/factories.ts');
    const doc = await withImage(createPlanDocument({ siteId: 's', name: 'Plan général' }), randomBytes(4096));
    await repo.savePlan(doc);
    const copy = duplicatePlanDocument(doc, 'Plan général (copie)');
    await repo.savePlan(copy);

    expect(copy.plan.id).not.toBe(doc.plan.id);
    expect(copy.plan.baseImage).toEqual(doc.plan.baseImage);
    expect((await repo.listPlans('s')).map((p) => p.name)).toEqual(['Plan général', 'Plan général (copie)']);

    await repo.savePlan({ ...copy, plan: { ...copy.plan, name: 'Renommé' } });
    expect((await repo.loadPlan(doc.plan.id))!.plan.name).toBe('Plan général');
  });

  it('un plan sans image s’enregistre et se rouvre', async () => {
    const doc = createPlanDocument({ siteId: 's', name: 'Vide' });
    await repo.savePlan(doc);
    const reopened = await repo.loadPlan(doc.plan.id);
    expect(reopened!.plan.baseImage).toBeNull();
  });

  it('supprime les fichiers orphelins (import annulé) sans toucher aux fichiers utilisés', async () => {
    const used = await withImage(createPlanDocument({ siteId: 's', name: 'A' }), randomBytes(1000));
    await repo.savePlan(used);
    const orphan = await repo.putBlob(randomBytes(500), 'image/png');
    expect(await repo.deleteOrphanBlobs()).toBe(1);
    expect(await repo.getBlob(orphan.id)).toBeUndefined();
    expect(await repo.getBlob(used.plan.baseImage!.blobId)).toBeDefined();
  });

  it('la préférence de vue est stockée à part et supprimée avec le plan', async () => {
    const doc = createPlanDocument({ siteId: 's', name: 'A' });
    await repo.savePlan(doc);
    await repo.saveViewPrefs(doc.plan.id, { centerX: 100, centerY: 50, scale: 0.5 });
    expect(await repo.getViewPrefs(doc.plan.id)).toEqual({ centerX: 100, centerY: 50, scale: 0.5 });
    expect(JSON.stringify(await repo.loadPlan(doc.plan.id))).not.toMatch(/centerX|scale/);
    await repo.deletePlan(doc.plan.id);
    expect(await repo.getViewPrefs(doc.plan.id)).toBeUndefined();
  });
});
