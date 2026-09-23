/**
 * Rapport de diagnostic exportable (JSON lisible). Ne contient JAMAIS la photo ni le contenu du
 * plan (objets, textes, notes) ; les noms des camps et des plans ne sont inclus que si
 * l'utilisateur le demande. Contenu : version, navigateur, tailles et nombres, empreintes,
 * mémoire estimée, résultat des contrôles de santé, journal local des erreurs.
 */
import { SCHEMA_VERSION } from '@/domain/model/schema.ts';
import { CAMPPLAN_FORMAT_VERSION } from '@/persistence/campplan.ts';
import type { ProjectRepository } from '@/persistence/ProjectRepository.ts';
import { readErrorLog } from './errorLog.ts';
import type { HealthCheck } from './health.ts';

declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export interface DiagnosticOptions {
  planId?: string | null;
  health?: HealthCheck[];
  /** Noms des camps et des plans (désactivé par défaut). */
  includeNames?: boolean;
  backup?: { folder: string; lastAt: string | null; intervalMinutes: number };
  lockMode?: string;
  now?: Date;
}

export async function buildDiagnostic(repo: ProjectRepository, options: DiagnosticOptions = {}) {
  const now = options.now ?? new Date();
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const memory = (
    performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
  ).memory;
  const estimate = await nav?.storage?.estimate?.().catch(() => undefined);
  const persisted = await nav?.storage?.persisted?.().catch(() => undefined);
  const name = (text: string) => (options.includeNames ? text : undefined);

  const sites = await repo.listSites();
  // Noms à masquer (camps, plans, fichiers, pictogrammes, modèles) quand ils ne sont pas demandés :
  // ils peuvent apparaître dans le journal ou le détail des contrôles.
  const secrets = new Set<string>();
  const plans = [];
  for (const site of sites)
    for (const summary of await repo.listPlans(site.id)) {
      const entry: Record<string, unknown> = {
        id: summary.id,
        name: name(summary.name),
        site: name(site.name),
        kind: summary.kind,
        updatedAt: summary.updatedAt,
      };
      try {
        const opened = await repo.openPlan(summary.id);
        const revisions = await repo.listRevisions(summary.id);
        secrets.add(site.name).add(summary.name);
        if (opened) {
          const d = opened.doc;
          if (d.plan.baseImage) secrets.add(d.plan.baseImage.fileName);
          for (const a of Object.values(d.assets)) secrets.add(a.name);
          secrets.add(d.plan.titleBlock.company).add(d.plan.titleBlock.client);
          const image = d.plan.baseImage;
          Object.assign(entry, {
            version: opened.version,
            schemaVersion: d.schemaVersion,
            objects: Object.keys(d.objects).length,
            layers: d.layers.length,
            views: d.plan.views.length,
            importedSymbols: Object.keys(d.assets).length,
            calibrated: d.plan.calibration !== null,
            north: d.plan.northStatus,
            documentBytes: JSON.stringify(d).length,
            photo: image
              ? {
                  mimeType: image.mimeType,
                  bytes: image.byteLength,
                  width: image.width,
                  height: image.height,
                  megapixels: Math.round((image.width * image.height) / 1e5) / 10,
                  sha256: image.sha256,
                }
              : null,
          });
        }
        Object.assign(entry, {
          revisions: revisions.map((r) =>
            r.meta
              ? {
                  label: r.meta.label,
                  status: r.meta.status,
                  approved: r.meta.approval !== null,
                  sealIntact: r.sealIntact,
                  snapshotSha256: r.meta.snapshot.sha256,
                  snapshotBytes: r.meta.snapshot.byteLength,
                }
              : { unreadable: true },
          ),
        });
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
      }
      if (!options.planId || options.planId === summary.id) plans.push(entry);
    }

  for (const tpl of await repo.listTemplates().catch(() => [])) secrets.add(tpl.template.name);
  const hidden = [...secrets].filter((n) => n && n.trim().length >= 3).sort((a, b) => b.length - a.length);
  const redact = (text: string | undefined) => {
    if (!text || options.includeNames) return text;
    let out = text;
    for (const n of hidden) out = out.split(n).join('«nom masqué»');
    // Noms de fichiers restants (ex. fichier importé depuis le disque).
    return out.replace(
      /[^\s"«»/\\:;,()]+\.(campplan|campmodele|jpe?g|png|webp|pdf|svg)\b/gi,
      '«fichier masqué»',
    );
  };

  return {
    report: 'Diagnostic CampPlanner',
    generatedAt: now.toISOString(),
    application: {
      version: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      campplanFormat: CAMPPLAN_FORMAT_VERSION,
    },
    browser: {
      userAgent: nav?.userAgent,
      language: nav?.language,
      platform:
        (nav as Navigator & { userAgentData?: { platform?: string } })?.userAgentData?.platform ??
        nav?.platform,
      hardwareConcurrency: nav?.hardwareConcurrency,
      deviceMemoryGb: (nav as Navigator & { deviceMemory?: number })?.deviceMemory,
      screen:
        typeof screen !== 'undefined'
          ? { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio }
          : undefined,
      webLocks: Boolean(nav?.locks),
      broadcastChannel: typeof BroadcastChannel !== 'undefined',
      fileSystemAccess: typeof window !== 'undefined' && 'showDirectoryPicker' in window,
    },
    storage: {
      usageBytes: estimate?.usage,
      quotaBytes: estimate?.quota,
      persisted,
      camps: sites.length,
      plans: plans.length,
    },
    memory: memory
      ? { usedJSHeapBytes: memory.usedJSHeapSize, limitBytes: memory.jsHeapSizeLimit }
      : 'indisponible (navigateur)',
    lockMode: options.lockMode,
    backup: options.backup,
    plans,
    health: options.health?.map(({ id, label, status, detail }) => ({
      id,
      label,
      status,
      detail: redact(detail),
    })),
    errorLog: readErrorLog().map((e) => ({ ...e, message: redact(e.message)!, context: redact(e.context) })),
    privacy:
      'Ce rapport ne contient ni la photo, ni les objets, textes ou notes des plans' +
      (options.includeNames
        ? '. Les noms des camps et des plans sont inclus (choix de l’utilisateur).'
        : ', ni les noms des camps et des plans.'),
  };
}
