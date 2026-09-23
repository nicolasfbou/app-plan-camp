/**
 * Fichier projet `.campplan` : tout ce qu'il faut pour retrouver un plan identique sur un autre
 * ordinateur (clé USB, courriel…), indépendamment du stockage du navigateur.
 *
 * Archive ZIP :
 *   manifest.json            format, version du format, application, date, camp, plan, fichiers,
 *                            empreintes SHA-256, modèles utilisés, compteurs
 *   plan.json                document du plan (objets, calques, styles, coordonnées, calibration,
 *                            métadonnées, schemaVersion)
 *   fichiers/<rôle>-<sha>.<ext>   photo d'origine, PDF d'origine et pictogrammes importés, octets
 *                            identiques (non recompressés)
 *
 * Versions du format d'archive : 1 (phase 3) ; 2 (phase 4) ajoute le rôle `symbol` (pictogrammes
 * importés). Un fichier de format 1 se lit tel quel.
 *
 * À la lecture, tout est vérifié : structure de l'archive, version du format, empreinte de
 * plan.json, présence, taille et SHA-256 de chaque fichier, cohérence avec le plan. Un fichier
 * corrompu est refusé avec un message précis ; rien n'est écrit tant que tout n'est pas valide.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { newId, nowIso } from '@/domain/model/factories.ts';
import type { BaseImageRef, PlanDocument, Site } from '@/domain/model/types.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import { FLOW_PRESETS, type FlowPreset } from '@/domain/presets/flowPresets.ts';
import { AREA_PRESETS, type ZonePreset } from '@/domain/presets/zonePresets.ts';
import { ProjectFormatError } from '@/domain/schema/migrations.ts';
import { parsePlanDocument, serializePlanDocument } from '@/domain/schema/serialization.ts';
import type { ProjectRepository } from './ProjectRepository.ts';

export const CAMPPLAN_EXTENSION = '.campplan';
export const CAMPPLAN_FORMAT_VERSION = 2;

export class CampplanError extends Error {
  override name = 'CampplanError';
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const fileEntrySchema = z.object({
  path: z.string().regex(/^fichiers\/[\w.-]+$/),
  role: z.enum(['background', 'pdf', 'symbol']),
  /** Identifiant du fichier dans le plan exporté (relié à `plan.baseImage` ou à `assets`). */
  blobId: z.string().min(1),
  mimeType: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: sha256Schema,
});

const manifestSchema = z.object({
  format: z.literal('campplan'),
  formatVersion: z.number().int().positive(),
  application: z.string(),
  exportedAt: z.string(),
  schemaVersion: z.number().int().positive(),
  site: z.object({ name: z.string(), notes: z.string() }),
  plan: z.object({ id: z.string().min(1), name: z.string(), kind: z.string() }),
  planSha256: sha256Schema,
  files: z.array(fileEntrySchema),
  /** Définition des modèles utilisés par les objets (pour les retrouver même s'ils changent). */
  presets: z.array(z.unknown()),
  counts: z.object({ objects: z.number().int().nonnegative(), layers: z.number().int().positive() }),
});

export type CampplanManifest = z.infer<typeof manifestSchema>;

export interface CampplanFile {
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
  role: FileRole;
}

type FileRole = 'background' | 'pdf' | 'symbol';

/** Contenu lu et entièrement vérifié d'un fichier `.campplan`. */
export interface CampplanContent {
  manifest: CampplanManifest;
  doc: PlanDocument;
  /** Fichiers par identifiant d'origine (`blobId` du plan exporté). */
  files: Map<string, CampplanFile>;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'image/svg+xml': 'svg',
};

interface FileRef {
  blobId: string;
  role: FileRole;
  sha256: string;
  /** Nom affiché dans les messages d'erreur. */
  label: string;
}

/** Fichiers référencés par le plan : photo, PDF d'origine, pictogrammes importés. */
function referencedFiles(doc: PlanDocument): FileRef[] {
  const files: FileRef[] = [];
  const ref: BaseImageRef | null = doc.plan.baseImage;
  if (ref) {
    files.push({ blobId: ref.blobId, role: 'background', sha256: ref.sha256, label: 'de la photo' });
    if (ref.source.kind === 'pdf')
      files.push({ blobId: ref.source.pdfBlobId, role: 'pdf', sha256: ref.source.pdfSha256, label: 'PDF' });
  }
  for (const asset of Object.values(doc.assets))
    files.push({
      blobId: asset.blobId,
      role: 'symbol',
      sha256: asset.sha256,
      label: `du pictogramme « ${asset.name} »`,
    });
  return files;
}

const roleLabel = (role: FileRole) =>
  role === 'pdf' ? 'PDF' : role === 'symbol' ? 'du pictogramme' : 'de la photo';

function usedPresets(doc: PlanDocument): (ZonePreset | FlowPreset)[] {
  const ids = new Set(
    Object.values(doc.objects)
      .map((o) => o.presetId)
      .filter(Boolean),
  );
  return [...AREA_PRESETS, ...FLOW_PRESETS].filter((p) => ids.has(p.id));
}

export function campplanFileName(siteName: string, planName: string): string {
  const safe = `${siteName} - ${planName}`.replace(/[\\/:*?"<>|]+/g, '-').trim();
  return `${safe || 'plan'}${CAMPPLAN_EXTENSION}`;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export async function exportCampplan(
  repo: ProjectRepository,
  planId: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const doc = await repo.loadPlan(planId);
  if (!doc) throw new CampplanError('Plan introuvable.');
  const site: Site | undefined = await repo.getSite(doc.plan.siteId);

  const entries: Zippable = {};
  const files: CampplanManifest['files'] = [];
  const seen = new Set<string>();
  for (const { blobId, role, sha256, label } of referencedFiles(doc)) {
    if (seen.has(blobId)) continue;
    seen.add(blobId);
    const blob = await repo.getBlob(blobId);
    if (!blob) throw new CampplanError(`Le fichier ${label} est introuvable dans le stockage local.`);
    // Aucun fichier altéré ne doit partir dans une sauvegarde.
    const actual = await sha256Hex(blob.bytes);
    if (actual !== sha256)
      throw new CampplanError(
        'L’empreinte du fichier stocké ne correspond plus à celle de l’import : export annulé.',
      );
    const path = `fichiers/${role}-${sha256.slice(0, 16)}.${EXTENSIONS[blob.mimeType] ?? 'bin'}`;
    // Niveau 0 : fichiers stockés tels quels (déjà compressés, et octets strictement identiques).
    entries[path] = [new Uint8Array(blob.bytes), { level: 0 }];
    files.push({ path, role, blobId, mimeType: blob.mimeType, byteLength: blob.byteLength, sha256 });
  }

  const planJson = strToU8(serializePlanDocument(doc));
  const manifest: CampplanManifest = {
    format: 'campplan',
    formatVersion: CAMPPLAN_FORMAT_VERSION,
    application: 'CampPlanner',
    exportedAt: nowIso(),
    schemaVersion: doc.schemaVersion,
    site: { name: site?.name ?? '', notes: site?.notes ?? '' },
    plan: { id: doc.plan.id, name: doc.plan.name, kind: doc.plan.kind },
    planSha256: await sha256Hex(planJson.slice().buffer),
    files,
    presets: usedPresets(doc),
    counts: { objects: Object.keys(doc.objects).length, layers: doc.layers.length },
  };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  entries['plan.json'] = planJson;
  return {
    bytes: zipSync(entries, { level: 6 }),
    fileName: campplanFileName(site?.name ?? '', doc.plan.name),
  };
}

// ---------------------------------------------------------------------------------------------
// Lecture et vérification
// ---------------------------------------------------------------------------------------------

/** Plafonds de décompression (bien au-delà d'une photo de 50 Mpx ou d'un plan de 10 000 objets). */
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Migrations du format d'archive (le document du plan a ses propres migrations). */
const FORMAT_MIGRATIONS: Record<number, (manifest: Record<string, unknown>) => Record<string, unknown>> = {
  /** 1 → 2 : nouveau rôle de fichier possible (`symbol`) ; un manifeste de format 1 reste valide. */
  1: (manifest) => manifest,
};

export async function readCampplan(bytes: Uint8Array): Promise<CampplanContent> {
  let entries: Record<string, Uint8Array>;
  try {
    // Seules les entrées attendues sont décompressées, et jamais au-delà d'une taille plafond
    // (taille déclarée vérifiée AVANT décompression) : un fichier piégé ne peut pas saturer la mémoire.
    entries = unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        const json = name === 'manifest.json' || name === 'plan.json';
        if (!json && !name.startsWith('fichiers/')) return false;
        if (originalSize > (json ? MAX_JSON_BYTES : MAX_FILE_BYTES))
          throw new CampplanError(`Fichier refusé : l’élément « ${name} » dépasse la taille autorisée.`);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof CampplanError) throw error;
    throw new CampplanError(
      'Fichier illisible : ce n’est pas un fichier .campplan valide, ou il est corrompu.',
    );
  }
  const manifestBytes = entries['manifest.json'];
  const planBytes = entries['plan.json'];
  if (!manifestBytes || !planBytes)
    throw new CampplanError('Fichier incomplet : manifeste ou plan manquant.');

  let rawManifest: Record<string, unknown>;
  try {
    rawManifest = JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown>;
  } catch {
    throw new CampplanError('Manifeste illisible (JSON invalide).');
  }
  if (rawManifest.format !== 'campplan')
    throw new CampplanError('Ce fichier n’est pas un projet CampPlanner.');
  const version = rawManifest.formatVersion;
  if (typeof version !== 'number' || version < 1)
    throw new CampplanError('Version du format absente ou invalide.');
  if (version > CAMPPLAN_FORMAT_VERSION) {
    throw new CampplanError(
      `Ce projet a été créé par une version plus récente de CampPlanner (format ${version}, format supporté ${CAMPPLAN_FORMAT_VERSION}). Mettez l’application à jour pour l’ouvrir.`,
    );
  }
  for (let v = version; v < CAMPPLAN_FORMAT_VERSION; v++) {
    const migrate = FORMAT_MIGRATIONS[v];
    if (!migrate) throw new CampplanError(`Migration du format ${v} vers ${v + 1} manquante.`);
    rawManifest = { ...migrate(rawManifest), formatVersion: v + 1 };
  }
  const parsedManifest = manifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) throw new CampplanError('Manifeste invalide : structure inattendue.');
  const manifest = parsedManifest.data;

  if ((await sha256Hex(planBytes.slice().buffer)) !== manifest.planSha256) {
    throw new CampplanError('Le plan contenu dans le fichier est corrompu (empreinte SHA-256 différente).');
  }
  let doc: PlanDocument;
  try {
    doc = parsePlanDocument(strFromU8(planBytes)); // validation + migrations du schéma
  } catch (error) {
    throw new CampplanError(error instanceof ProjectFormatError ? error.message : 'Plan invalide.');
  }

  const files = new Map<string, CampplanFile>();
  for (const entry of manifest.files) {
    const data = entries[entry.path];
    if (!data) throw new CampplanError(`Fichier manquant dans l’archive : ${entry.path}.`);
    if (data.byteLength !== entry.byteLength || (await sha256Hex(data.slice().buffer)) !== entry.sha256) {
      throw new CampplanError(
        `Le fichier ${roleLabel(entry.role)} est corrompu (empreinte SHA-256 différente).`,
      );
    }
    files.set(entry.blobId, {
      bytes: data,
      mimeType: entry.mimeType,
      sha256: entry.sha256,
      role: entry.role,
    });
  }
  // Le plan doit référencer exactement les fichiers fournis, avec les mêmes empreintes.
  for (const needed of referencedFiles(doc)) {
    const file = files.get(needed.blobId);
    if (!file || file.sha256 !== needed.sha256)
      throw new CampplanError(`Le fichier ${needed.label} ne correspond pas aux fichiers de l’archive.`);
  }
  return { manifest, doc, files };
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export type ImportTarget = { kind: 'existing-site'; siteId: string } | { kind: 'new-site'; name: string };

export interface ImportOptions {
  target: ImportTarget;
  /**
   * `copy` : le plan importé reçoit un nouvel identifiant si ce plan existe déjà (jamais d'écrasement).
   * `replace` : remplace le plan existant de même identifiant — uniquement après confirmation explicite.
   */
  mode: 'copy' | 'replace';
  /** Nom du plan importé (l'interface propose un nom distinct si un plan du camp porte déjà ce nom). */
  planName: string;
}

export async function importCampplan(
  repo: ProjectRepository,
  content: CampplanContent,
  options: ImportOptions,
): Promise<{ siteId: string; planId: string }> {
  const doc = structuredClone(content.doc);
  // Existence lue sans validation : un plan présent mais illisible n'est jamais écrasé en silence.
  const existing = await repo.getPlanSummary(doc.plan.id);
  if (existing && options.mode === 'copy') doc.plan.id = newId();

  // Destination. Un remplacement reste TOUJOURS dans le camp du plan remplacé (jamais déplacé).
  let siteId: string;
  let newSite: Site | null = null;
  if (existing && options.mode === 'replace') {
    siteId = existing.siteId;
  } else if (options.target.kind === 'existing-site') {
    const site = await repo.getSite(options.target.siteId);
    if (!site) throw new CampplanError('Camp de destination introuvable.');
    siteId = site.id;
  } else {
    const now = nowIso();
    newSite = {
      id: newId(),
      name: options.target.name,
      notes: content.manifest.site.notes,
      createdAt: now,
      updatedAt: now,
    };
    siteId = newSite.id;
  }

  // Fichiers d'origine : écrits tels quels, références du plan mises à jour. Si l'import échoue
  // ensuite, ces fichiers restent non référencés et sont supprimés par le nettoyage des orphelins.
  const written = new Map<string, string>(); // identifiant dans l'archive → nouvel identifiant
  const store = async (blobId: string) => {
    const already = written.get(blobId);
    if (already) return already;
    const file = content.files.get(blobId)!;
    const stored = await repo.putBlob(file.bytes.slice().buffer, file.mimeType);
    if (stored.sha256 !== file.sha256)
      throw new CampplanError('Écriture du fichier incorrecte (empreinte différente).');
    written.set(blobId, stored.id);
    return stored.id;
  };
  const ref = doc.plan.baseImage;
  if (ref) {
    ref.blobId = await store(ref.blobId);
    if (ref.source.kind === 'pdf') ref.source.pdfBlobId = await store(ref.source.pdfBlobId);
  }
  for (const asset of Object.values(doc.assets)) asset.blobId = await store(asset.blobId);
  doc.plan.siteId = siteId;
  doc.plan.name = options.planName;

  // Camp éventuel + plan (+ fichiers de la version remplacée) : une seule transaction.
  await repo.saveImportedPlan(doc, newSite);
  return { siteId, planId: doc.plan.id };
}

/** Nom libre dans un camp : « Nom », sinon « Nom (importé) », « Nom (importé 2) »… */
export function availablePlanName(name: string, existing: readonly string[]): string {
  if (!existing.includes(name)) return name;
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${name} (importé)` : `${name} (importé ${i})`;
    if (!existing.includes(candidate)) return candidate;
  }
}
