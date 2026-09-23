/**
 * Centre de santé d'un projet : contrôles vert / jaune / rouge, jamais masqués (un contrôle
 * « ignoré » reste affiché avec sa couleur). Certains problèmes proposent une réparation
 * CONTRÔLÉE (sur confirmation, avec sauvegarde préalable proposée) ; aucune ne touche au contenu
 * d'une révision figée.
 */
import { sha256Hex } from '@/domain/image/hash.ts';
import { SCHEMA_VERSION } from '@/domain/model/schema.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { checkSymbolFile } from '@/domain/symbols/importSymbol.ts';
import { exportCampplan } from '@/persistence/campplan.ts';
import type { ProjectRepository } from '@/persistence/ProjectRepository.ts';
import { recoveryJournalPlanIds, recoveryJournalTexts, recoveryKey } from '@/persistence/recovery.ts';

export { recoveryJournalPlanIds };
import { oldEnough } from './cleanup.ts';

export type HealthStatus = 'ok' | 'warn' | 'error';
export type RepairId =
  'reindex' | 'delete-orphans' | 'clear-view-prefs' | 'clear-stale-recovery' | 'request-persistence';

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  repair?: RepairId;
}

export interface HealthContext {
  /** Dernière sauvegarde externe réussie (ISO) et intervalle prévu (minutes, 0 = aucun). */
  lastBackupAt: string | null;
  backupIntervalMinutes: number;
  lockMode: string;
  now?: Date;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

/** Tous les plans ENREGISTRÉS (clés de la table, même si leur camp manque). */
async function allPlanIds(repo: ProjectRepository): Promise<Set<string>> {
  return new Set(await repo.listPlanIds());
}

export async function runPlanHealth(
  repo: ProjectRepository,
  planId: string,
  ctx: HealthContext,
): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const add = (c: HealthCheck) => checks.push(c);
  const guard = async (id: string, label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      // Un contrôle qui échoue est un problème affiché, jamais un contrôle silencieusement omis.
      add({
        id,
        label,
        status: 'error',
        detail: `Contrôle impossible : ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  // Plan et version de schéma.
  let doc: PlanDocument | null = null;
  await guard('plan', 'Données du plan', async () => {
    const raw = (await repo.getPlanRaw(planId)) as { schemaVersion?: number } | undefined;
    const opened = await repo.openPlan(planId);
    if (!opened) throw new Error('plan introuvable');
    doc = opened.doc;
    add({
      id: 'plan',
      label: 'Données du plan',
      status: 'ok',
      detail: `Lisibles et valides (${Object.keys(doc.objects).length} objets, ${doc.layers.length} calques, ${doc.plan.views.length} vues).`,
    });
    const stored = raw?.schemaVersion ?? 0;
    add({
      id: 'schema',
      label: 'Version de schéma',
      status: stored === SCHEMA_VERSION ? 'ok' : 'warn',
      detail:
        stored === SCHEMA_VERSION
          ? `Format ${SCHEMA_VERSION} (actuel).`
          : `Enregistré au format ${stored}, lu au format ${SCHEMA_VERSION} (converti à la prochaine modification).`,
    });
  });
  const d = doc as PlanDocument | null;

  // Photo originale et fichiers associés.
  if (d) {
    const image = d.plan.baseImage;
    await guard('photo', 'Photo originale', async () => {
      if (!image) {
        add({ id: 'photo', label: 'Photo originale', status: 'warn', detail: 'Aucune photo importée.' });
        return;
      }
      const blob = await repo.getBlob(image.blobId);
      if (!blob) {
        add({
          id: 'photo',
          label: 'Photo originale',
          status: 'error',
          detail: `Absente du stockage (${image.fileName}).`,
        });
        return;
      }
      add({
        id: 'photo',
        label: 'Photo originale',
        status: 'ok',
        detail: `${image.fileName} — ${mb(blob.byteLength)}, ${image.width} × ${image.height} px.`,
      });
      const actual = await sha256Hex(blob.bytes);
      add({
        id: 'photo-sha',
        label: 'SHA-256 de la photo',
        status: actual === image.sha256 ? 'ok' : 'error',
        detail:
          actual === image.sha256
            ? `Conforme (${actual}).`
            : `DIFFÉRENT : attendu ${image.sha256}, trouvé ${actual}.`,
      });
    });
    await guard('files', 'Fichiers associés', async () => {
      const problems: string[] = [];
      let count = 0;
      if (image?.source.kind === 'pdf') {
        count++;
        const pdf = await repo.getBlob(image.source.pdfBlobId);
        if (!pdf) problems.push('PDF d’origine absent');
        else if ((await sha256Hex(pdf.bytes)) !== image.source.pdfSha256)
          problems.push('PDF d’origine altéré');
      }
      const assetProblems: string[] = [];
      for (const asset of Object.values(d.assets)) {
        count++;
        const blob = await repo.getBlob(asset.blobId);
        if (!blob) {
          problems.push(`pictogramme « ${asset.name} » absent`);
          continue;
        }
        if ((await sha256Hex(blob.bytes)) !== asset.sha256)
          problems.push(`pictogramme « ${asset.name} » altéré`);
        const check = checkSymbolFile(
          new Uint8Array(blob.bytes),
          asset.mimeType === 'image/svg+xml' ? 'x.svg' : 'x.png',
        );
        if (!check.ok) assetProblems.push(`« ${asset.name} » : ${check.reason}`);
      }
      add({
        id: 'files',
        label: 'Fichiers associés (PDF d’origine, pictogrammes)',
        status: problems.length ? 'error' : 'ok',
        detail: problems.length
          ? problems.join(' ; ')
          : count
            ? `${count} fichier(s) présent(s) et conforme(s).`
            : 'Aucun fichier associé.',
      });
      add({
        id: 'symbols',
        label: 'Pictogrammes importés',
        status: assetProblems.length ? 'error' : 'ok',
        detail: assetProblems.length
          ? `Invalides : ${assetProblems.join(' ; ')}`
          : `${Object.keys(d.assets).length} valide(s).`,
      });
    });
  }

  // Révisions.
  await guard('revisions', 'Révisions figées', async () => {
    const entries = await repo.listRevisions(planId);
    const bad: string[] = [];
    for (const e of entries) {
      if (!e.meta) {
        bad.push('révision illisible');
        continue;
      }
      try {
        await repo.loadRevision(e.id);
      } catch (error) {
        bad.push(`${e.meta.label} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    add({
      id: 'revisions',
      label: 'Révisions figées',
      status: bad.length ? 'error' : 'ok',
      detail: bad.length
        ? `${bad.length} révision(s) altérée(s) ou illisible(s) — jamais réparées automatiquement : ${bad.join(' ; ')}`
        : entries.length
          ? `${entries.length} révision(s) intègre(s) (empreinte et sceau vérifiés).`
          : 'Aucune révision.',
    });
  });

  // Index secondaires.
  await guard('index', 'Index secondaires', async () => {
    const r = await repo.checkPlanIndex(planId);
    add({
      id: 'index',
      label: 'Index secondaires (fichiers référencés)',
      status: r.consistent ? 'ok' : 'warn',
      detail: r.consistent ? 'Cohérents.' : r.details.join(' '),
      ...(r.consistent ? {} : { repair: 'reindex' as const }),
    });
  });

  // Ressources orphelines (tout le stockage).
  await guard('orphans', 'Ressources orphelines', async () => {
    const orphans = (await repo.listOrphanBlobs(recoveryJournalTexts())).filter((o) => oldEnough(o));
    const bytes = orphans.reduce((s, o) => s + o.byteLength, 0);
    add({
      id: 'orphans',
      label: 'Ressources orphelines',
      status: bytes > 5 * 1024 * 1024 ? 'warn' : 'ok',
      detail: orphans.length
        ? `${orphans.length} fichier(s) non référencé(s), ${mb(bytes)} récupérables.`
        : 'Aucune.',
      ...(orphans.length ? { repair: 'delete-orphans' as const } : {}),
    });
  });

  // Préférences de vue, journaux de récupération périmés.
  await guard('prefs', 'Préférence de vue', async () => {
    const prefs = await repo.getViewPrefs(planId);
    const valid =
      !prefs ||
      ([prefs.centerX, prefs.centerY, prefs.scale].every((v) => Number.isFinite(v)) && prefs.scale > 0);
    add({
      id: 'prefs',
      label: 'Préférence de vue (zoom, centre)',
      status: valid ? 'ok' : 'warn',
      detail: valid
        ? 'Valide.'
        : 'Corrompue : sera réinitialisée (la vue est recentrée ; le plan n’est pas touché).',
      ...(valid ? {} : { repair: 'clear-view-prefs' as const }),
    });
    const existing = await allPlanIds(repo);
    const stale = recoveryJournalPlanIds().filter((id) => !existing.has(id));
    if (stale.length)
      add({
        id: 'recovery',
        label: 'Journaux de récupération',
        status: 'warn',
        detail: `${stale.length} journal(aux) de plans supprimés.`,
        repair: 'clear-stale-recovery',
      });
  });

  // Espace de stockage.
  await guard('storage', 'Espace de stockage', async () => {
    const estimate = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const usage = estimate?.usage ?? 0;
    const quota = estimate?.quota ?? 0;
    const ratio = quota ? usage / quota : 0;
    add({
      id: 'storage',
      label: 'Espace IndexedDB estimé',
      status: ratio > 0.9 ? 'error' : ratio > 0.8 ? 'warn' : 'ok',
      detail: quota
        ? `${mb(usage)} utilisés sur ${mb(quota)} (${Math.round(ratio * 100)} %).`
        : 'Estimation indisponible dans ce navigateur.',
    });
    add({
      id: 'persistence',
      label: 'Stockage persistant',
      status: persisted ? 'ok' : 'warn',
      detail: persisted
        ? 'Le navigateur ne videra pas ce stockage de lui-même.'
        : 'Non garanti : le navigateur pourrait vider ce stockage s’il manque de place. Les sauvegardes externes protègent le projet.',
      ...(persisted ? {} : { repair: 'request-persistence' as const }),
    });
  });

  // Export .campplan possible.
  await guard('export', 'Export .campplan', async () => {
    const t0 = performance.now();
    const { bytes } = await exportCampplan(repo, planId);
    add({
      id: 'export',
      label: 'Export .campplan',
      status: 'ok',
      detail: `Possible (${mb(bytes.byteLength)}, ${Math.round(performance.now() - t0)} ms).`,
    });
  });

  // Dernière sauvegarde externe.
  const now = ctx.now ?? new Date();
  const age = ctx.lastBackupAt ? (now.getTime() - Date.parse(ctx.lastBackupAt)) / 60000 : null;
  const limit = Math.max(ctx.backupIntervalMinutes, 15) * 2;
  add({
    id: 'backup',
    label: 'Dernière sauvegarde externe',
    status: age === null ? 'error' : age > Math.max(limit, 24 * 60) ? 'warn' : 'ok',
    detail:
      age === null
        ? 'Aucune sauvegarde externe : si le navigateur vide son stockage, le projet est perdu. Choisissez un dossier ou téléchargez une copie.'
        : `Il y a ${age < 60 ? `${Math.round(age)} min` : `${Math.round(age / 60)} h`} (${ctx.lastBackupAt}).`,
  });

  add({
    id: 'lock',
    label: 'Verrou d’édition',
    status: ctx.lockMode === 'unsupported' ? 'warn' : 'ok',
    detail:
      ctx.lockMode === 'editor'
        ? 'Cet onglet modifie le plan (les autres le lisent).'
        : ctx.lockMode === 'readonly'
          ? 'Plan ouvert en édition ailleurs : lecture seule ici.'
          : ctx.lockMode === 'unsupported'
            ? 'Verrou indisponible dans ce navigateur : les conflits restent détectés à l’enregistrement.'
            : 'En attente.',
  });
  return checks;
}

/** Exécute une réparation (l'appelant a obtenu la confirmation de l'utilisateur). */
export async function applyRepair(
  repo: ProjectRepository,
  planId: string,
  repair: RepairId,
): Promise<string> {
  switch (repair) {
    case 'reindex':
      await repo.reindexPlan(planId);
      return 'Index recalculés à partir des documents (contenu inchangé).';
    case 'delete-orphans': {
      const orphans = (await repo.listOrphanBlobs(recoveryJournalTexts())).filter((o) => oldEnough(o));
      const r = await repo.deleteBlobs(
        orphans.map((o) => o.id),
        recoveryJournalTexts(),
      );
      return `${r.deleted} fichier(s) orphelin(s) supprimé(s), ${mb(r.bytes)} récupérés.`;
    }
    case 'clear-view-prefs':
      await repo.deleteViewPrefs(planId);
      return 'Préférence de vue réinitialisée.';
    case 'clear-stale-recovery': {
      const existing = await allPlanIds(repo);
      const stale = recoveryJournalPlanIds().filter((id) => !existing.has(id));
      for (const id of stale) localStorage.removeItem(recoveryKey(id));
      return `${stale.length} journal(aux) supprimé(s).`;
    }
    case 'request-persistence': {
      const granted = (await navigator.storage?.persist?.()) ?? false;
      return granted
        ? 'Stockage persistant accordé.'
        : 'Le navigateur a refusé le stockage persistant (sauvegardes externes recommandées).';
    }
  }
}

export const worstStatus = (checks: readonly HealthCheck[]): HealthStatus =>
  checks.some((c) => c.status === 'error')
    ? 'error'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';
