/**
 * « Projet local → Publier dans <organisation> ».
 *
 * 1. Vérification : plans lisibles, révisions intègres (SHA + sceau), fichiers (SHA-256, taille),
 *    approbations locales non vérifiées, identifiants déjà présents sur le serveur.
 * 2. Confirmation de l'utilisateur.
 * 3. Copie dans l'espace de l'organisation (MÊMES identifiants : camp, plans, révisions) par le
 *    format `.campplan` (même vérification qu'un import), mise en file, envoi.
 * 4. Le projet local est marqué « publié » (lien vers l'espace d'organisation) ; il n'est ni
 *    modifié ni supprimé.
 */
import type { Profile } from '@/app/profile.ts';
import { nowIso } from '@/domain/model/factories.ts';
import { approvalVerification } from '@/domain/revisions/revision.ts';
import { parsePlanDocument } from '@/domain/schema/serialization.ts';
import { exportCampplan, importCampplan, readCampplan } from '@/persistence/campplan.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import type { ProjectRepository } from '@/persistence/ProjectRepository.ts';
import { type Api, type MeResponse } from './api.ts';
import { SyncEngine } from './engine.ts';
import { planShas } from './outbox.ts';
import { SyncingRepository } from './syncingRepository.ts';

export interface PublishCheck {
  campId: string;
  campName: string;
  plans: { id: string; name: string }[];
  revisions: number;
  files: { sha256: string; byteLength: number }[];
  totalBytes: number;
  presentFiles: number;
  unverifiedApprovals: number;
  conflicts: string[];
  problems: string[];
}

export const publicationKey = (campId: string) => `publication.${campId}`;

export interface PublicationRecord {
  orgId: string;
  orgName: string;
  profileId: string;
  at: string;
}

/** Espace d'organisation correspondant à la session serveur active (ou null). */
export async function sessionProfile(api: Api, profiles: Profile[]): Promise<Profile | null> {
  try {
    const me = await api.request<MeResponse>('GET', '/api/auth/me');
    return profiles.find((p) => p.orgId === me.organization.id && p.userId === me.user.id) ?? null;
  } catch {
    return null;
  }
}

export async function checkPublication(
  local: ProjectRepository,
  api: Api,
  campId: string,
): Promise<PublishCheck> {
  const site = await local.getSite(campId);
  if (!site) throw new Error('Camp introuvable.');
  const problems: string[] = [];
  const plans = await local.listPlans(campId);
  const files = new Map<string, number>();
  let revisions = 0;
  let unverified = 0;
  const revisionIds: string[] = [];
  for (const p of plans) {
    try {
      const doc = (await local.loadPlan(p.id))!;
      const image = doc.plan.baseImage;
      if (image) files.set(image.sha256, image.byteLength);
      for (const a of Object.values(doc.assets)) files.set(a.sha256, a.byteLength);
      for (const s of planShas(doc)) if (!files.has(s)) files.set(s, 0);
    } catch (error) {
      problems.push(
        `Plan « ${p.name} » illisible : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of await local.listRevisions(p.id)) {
      if (!entry.meta || !entry.sealIntact) {
        problems.push(
          `Plan « ${p.name} » : révision ${entry.meta?.label ?? entry.id} altérée — non publiée.`,
        );
        continue;
      }
      revisions++;
      revisionIds.push(entry.id);
      if (approvalVerification(entry.meta.approval) === 'local_unverified') unverified++;
      try {
        const snap = parsePlanDocument((await local.readRevisionSnapshot(entry.id)).json);
        for (const s of planShas(snap)) if (!files.has(s)) files.set(s, snap.plan.baseImage?.byteLength ?? 0);
      } catch {
        problems.push(`Révision ${entry.meta.label} : instantané illisible — non publiée.`);
      }
    }
  }
  const check = await api.request<{
    existing: { camps: string[]; plans: string[]; revisions: string[] };
    presentFiles: string[];
  }>('POST', '/api/publish/check', {
    body: { campIds: [campId], planIds: plans.map((p) => p.id), revisionIds, sha256: [...files.keys()] },
  });
  const conflicts = [
    ...check.existing.plans.map((id) => `plan « ${plans.find((p) => p.id === id)?.name ?? id} »`),
    ...check.existing.revisions.map((id) => `révision ${id}`),
  ];
  return {
    campId,
    campName: site.name,
    plans: plans.map((p) => ({ id: p.id, name: p.name })),
    revisions,
    files: [...files].map(([sha256, byteLength]) => ({ sha256, byteLength })),
    totalBytes: [...files.values()].reduce((a, b) => a + b, 0),
    presentFiles: check.presentFiles.length,
    unverifiedApprovals: unverified,
    conflicts,
    problems,
  };
}

/**
 * Copie dans l'espace de l'organisation puis envoi. `onProgress` reçoit (fait, total) opérations.
 * Les révisions altérées ne sont pas publiées (listées à la vérification).
 */
export async function publishCamp(
  local: ProjectRepository,
  api: Api,
  target: Profile,
  campId: string,
  onProgress: (done: number, total: number) => void = () => undefined,
): Promise<{ pending: number }> {
  const site = (await local.getSite(campId))!;
  const org = new SyncingRepository(target.dbName, target.orgId!, api);
  try {
    await org.saveSite({ ...site, updatedAt: nowIso() });
    for (const p of await local.listPlans(campId)) {
      const { bytes } = await exportCampplan(local, p.id, { skipDamagedRevisions: true });
      const content = await readCampplan(bytes);
      org.importOrigin = 'publish';
      await importCampplan(org, content, {
        target: { kind: 'existing-site', siteId: campId },
        mode: 'replace',
        planName: p.name,
      });
    }
  } finally {
    org.close();
  }
  // Envoi immédiat (même moteur que la synchronisation ; reprend plus tard si interrompu).
  const raw = new IndexedDbRepository(target.dbName);
  const engine = new SyncEngine({ raw, api, orgId: target.orgId! });
  try {
    const total = await raw.sync.outbox.count();
    for (let i = 0; i < 20; i++) {
      await engine.runOnce();
      const left = await raw.sync.outbox.count();
      onProgress(total - left, total);
      if (!left || !engine.status.reachable) break;
    }
    const pending = await raw.sync.outbox.count();
    await local.setSetting(publicationKey(campId), {
      orgId: target.orgId!,
      orgName: target.orgName ?? '',
      profileId: target.id,
      at: nowIso(),
    } satisfies PublicationRecord);
    return { pending };
  } finally {
    raw.close();
  }
}
