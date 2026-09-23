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
 *                            identiques (non recompressés) — une seule fois, même si plusieurs
 *                            révisions les référencent
 *   revisions/<id>.json      instantané figé de chaque révision (texte exact : son SHA-256 est
 *                            celui des métadonnées de la révision, listées dans le manifeste)
 *
 * Versions du format d'archive : 1 (phase 3) ; 2 (phase 4) ajoute le rôle `symbol` (pictogrammes
 * importés) ; 3 (phase 7) ajoute les révisions. Un fichier de format 1 ou 2 se lit tel quel.
 *
 * À la lecture, tout est vérifié : structure de l'archive, version du format, empreinte de
 * plan.json, présence, taille et SHA-256 de chaque fichier, cohérence avec le plan. Un fichier
 * corrompu est refusé avec un message précis ; rien n'est écrit tant que tout n'est pas valide.
 */
import { inflateSync, strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { newId, nowIso } from '@/domain/model/factories.ts';
import type { BaseImageRef, PlanDocument, Site } from '@/domain/model/types.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import { FLOW_PRESETS, type FlowPreset } from '@/domain/presets/flowPresets.ts';
import { AREA_PRESETS, type ZonePreset } from '@/domain/presets/zonePresets.ts';
import { ProjectFormatError } from '@/domain/schema/migrations.ts';
import { parsePlanDocument, serializePlanDocument } from '@/domain/schema/serialization.ts';
import { checkSymbolFile } from '@/domain/symbols/importSymbol.ts';
import { salvagePlanDocument } from '@/domain/schema/salvage.ts';
import {
  isSealIntact,
  referencedBlobIds,
  type RevisionMeta,
  revisionMetaSchema,
  sha256OfText,
} from '@/domain/revisions/revision.ts';
import type { ImportedRevision, ProjectRepository } from './ProjectRepository.ts';

export const CAMPPLAN_EXTENSION = '.campplan';
export const CAMPPLAN_FORMAT_VERSION = 3;

export class CampplanError extends Error {
  override name = 'CampplanError';
}

/** Révisions illisibles ou altérées : l'export peut être refait sans elles (jamais en silence). */
export class DamagedRevisionsError extends CampplanError {
  override name = 'DamagedRevisionsError';
  constructor(readonly labels: string[]) {
    super(`Révision(s) illisible(s) ou altérée(s) : ${labels.join(', ')}.`);
  }
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

const revisionEntrySchema = z.object({
  meta: z.unknown(),
  path: z.string().regex(/^revisions\/[\w.-]+\.json$/),
  sha256: sha256Schema,
  byteLength: z.number().int().positive(),
  /** Identifiant de fichier dans l'instantané → identifiant du fichier dans l'archive. */
  blobMap: z.record(z.string(), z.string()),
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
  /** Révisions figées (format 3), dans l'ordre de création. */
  revisions: z.array(revisionEntrySchema),
  /** Copie de secours : ce qui manque (absent pour un export normal). */
  emergency: z
    .object({ createdAt: z.string(), complete: z.boolean(), problems: z.array(z.string()) })
    .optional(),
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
  /** Révisions vérifiées (empreinte, sceau, plan valide, fichiers présents). */
  revisions: CampplanRevision[];
  /** Mode récupération : tout ce qui n'a pas pu être lu (vide = fichier complet). */
  problems: string[];
}

export interface CampplanRevision {
  meta: RevisionMeta;
  json: string;
  /** Identifiant de fichier dans l'instantané → identifiant du fichier dans l'archive. */
  blobMap: Record<string, string>;
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
  options: { skipDamagedRevisions?: boolean } = {},
): Promise<{ bytes: Uint8Array; fileName: string; skippedRevisions: string[] }> {
  const doc = await repo.loadPlan(planId);
  if (!doc) throw new CampplanError('Plan introuvable.');
  const site: Site | undefined = await repo.getSite(doc.plan.siteId);

  const entries: Zippable = {};
  const files: CampplanManifest['files'] = [];
  const seen = new Set<string>();
  // Révisions : instantanés exacts ; leurs fichiers (souvent la même photo) ne sont écrits qu'une fois.
  const revisionEntries: CampplanManifest['revisions'] = [];
  const revisionRefs: FileRef[] = [];
  const damaged: string[] = [];
  for (const entry of await repo.listRevisions(planId)) {
    let loaded;
    try {
      if (!entry.meta) throw new CampplanError('illisible');
      loaded = await repo.loadRevision(entry.id); // vérifie sceau et empreinte
    } catch {
      damaged.push(entry.meta?.label ?? `(${entry.id.slice(0, 8)})`);
      continue;
    }
    const { json, blobMap } = await repo.readRevisionSnapshot(entry.id);
    const path = `revisions/${entry.id.replace(/[^\w.-]/g, '_')}.json`;
    const bytes = strToU8(json);
    entries[path] = bytes;
    const inSnapshot = referencedBlobIds(parsePlanDocument(json));
    revisionEntries.push({
      meta: loaded.meta,
      path,
      sha256: loaded.meta.snapshot.sha256,
      byteLength: bytes.byteLength,
      blobMap: Object.fromEntries(inSnapshot.map((id) => [id, blobMap[id] ?? id])),
    });
    revisionRefs.push(...referencedFiles(loaded.doc));
  }
  // Jamais une sauvegarde incomplète sans le dire : l'appelant doit accepter explicitement.
  if (damaged.length && !options.skipDamagedRevisions) throw new DamagedRevisionsError(damaged);
  for (const { blobId, role, sha256, label } of [...referencedFiles(doc), ...revisionRefs]) {
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
    revisions: revisionEntries,
  };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  entries['plan.json'] = planJson;
  return {
    bytes: zipSync(entries, { level: 6 }),
    fileName: campplanFileName(site?.name ?? '', doc.plan.name),
    skippedRevisions: damaged,
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
  /** 2 → 3 : révisions (aucune dans un fichier plus ancien). */
  2: (manifest) => ({ revisions: [], ...manifest }),
};

/**
 * Décompresse l'archive élément par élément (mode récupération) : un élément endommagé n'empêche
 * pas de lire les autres.
 */
function unzipEach(
  bytes: Uint8Array,
  accept: (name: string, size: number) => boolean,
  problems: string[],
): Record<string, Uint8Array> {
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        if (accept(name, originalSize)) names.push(name);
        return false;
      },
    });
  } catch {
    // Répertoire central illisible (fichier tronqué : il est à la FIN de l'archive) : lecture
    // directe des en-têtes locaux, élément par élément.
    problems.push('Archive tronquée ou endommagée : lecture élément par élément.');
    return scanLocalEntries(bytes, accept, problems);
  }
  const out: Record<string, Uint8Array> = {};
  for (const wanted of names) {
    try {
      Object.assign(out, unzipSync(bytes, { filter: ({ name }) => name === wanted }));
    } catch {
      problems.push(`Élément illisible dans l’archive : ${wanted}.`);
    }
  }
  return out;
}

/** Lecture des en-têtes locaux ZIP (`PK\x03\x04`) sans répertoire central. */
export function scanLocalEntries(
  bytes: Uint8Array,
  accept: (name: string, size: number) => boolean,
  problems: string[],
): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let i = 0;
  while (i + 30 <= bytes.length) {
    if (view.getUint32(i, true) !== 0x04034b50) {
      i++;
      continue;
    }
    const flags = view.getUint16(i + 6, true);
    const method = view.getUint16(i + 8, true);
    const compressed = view.getUint32(i + 18, true);
    const size = view.getUint32(i + 22, true);
    const nameLength = view.getUint16(i + 26, true);
    const extraLength = view.getUint16(i + 28, true);
    const start = i + 30 + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(i + 30, i + 30 + nameLength));
    const unknownSize = (flags & 8) !== 0 && compressed === 0;
    const end = unknownSize ? bytes.length : start + compressed;
    if (!name.endsWith('/') && accept(name, size)) {
      try {
        if (end > bytes.length) throw new Error('tronqué');
        const data = bytes.subarray(start, end);
        let content: Uint8Array;
        if (method === 0 && !unknownSize) content = data.slice();
        else if (method === 8) content = inflateSync(data);
        else throw new Error(`méthode ${method}`);
        if (!unknownSize && content.length !== size) throw new Error('taille incohérente');
        out[name] = content;
      } catch (error) {
        problems.push(
          `Élément illisible dans l’archive : ${name} (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
    i = unknownSize || end > bytes.length ? i + 4 : end;
  }
  return out;
}

const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]),
);

export interface ReadOptions {
  /**
   * Mode récupération : un fichier partiellement endommagé est lu malgré tout ; chaque partie
   * perdue est décrite dans `problems` (jamais présenté comme complet).
   */
  recovery?: boolean;
}

export async function readCampplan(bytes: Uint8Array, options: ReadOptions = {}): Promise<CampplanContent> {
  const recovery = Boolean(options.recovery);
  const problems: string[] = [];
  /** Problème : bloquant en lecture normale ; noté (et contourné) en récupération. */
  const fail = (message: string) => {
    if (!recovery) throw new CampplanError(message);
    problems.push(message);
  };
  const accept = (name: string, originalSize: number) => {
    const json = name === 'manifest.json' || name === 'plan.json' || /^revisions\/[\w.-]+\.json$/.test(name);
    if (!json && !name.startsWith('fichiers/')) return false;
    if (originalSize > (json ? MAX_JSON_BYTES : MAX_FILE_BYTES))
      throw new CampplanError(`Fichier refusé : l’élément « ${name} » dépasse la taille autorisée.`);
    return true;
  };
  let entries: Record<string, Uint8Array>;
  try {
    // Seules les entrées attendues sont décompressées, et jamais au-delà d'une taille plafond
    // (taille déclarée vérifiée AVANT décompression) : un fichier piégé ne peut pas saturer la mémoire.
    entries = unzipSync(bytes, { filter: ({ name, originalSize }) => accept(name, originalSize) });
  } catch (error) {
    if (error instanceof CampplanError) throw error;
    if (!recovery)
      throw new CampplanError(
        'Fichier illisible : ce n’est pas un fichier .campplan valide, ou il est corrompu.',
      );
    entries = unzipEach(bytes, accept, problems);
    if (!Object.keys(entries).length)
      throw new CampplanError(
        'Fichier illisible : aucun élément récupérable (ce n’est pas une archive valide).',
      );
  }

  // --- Manifeste ---
  let manifest: CampplanManifest | null = null;
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) fail('Fichier incomplet : manifeste manquant.');
  else {
    let rawManifest: Record<string, unknown> | null = null;
    try {
      rawManifest = JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown>;
    } catch {
      fail('Manifeste illisible (JSON invalide).');
    }
    if (rawManifest) {
      if (rawManifest.format !== 'campplan' && !recovery)
        throw new CampplanError('Ce fichier n’est pas un projet CampPlanner.');
      const version = rawManifest.formatVersion;
      if (typeof version === 'number' && version > CAMPPLAN_FORMAT_VERSION)
        // Jamais « récupéré » : une version plus récente se lit avec une application à jour.
        throw new CampplanError(
          `Ce projet a été créé par une version plus récente de CampPlanner (format ${version}, format supporté ${CAMPPLAN_FORMAT_VERSION}). Mettez l’application à jour pour l’ouvrir.`,
        );
      if (typeof version !== 'number' || version < 1) fail('Version du format absente ou invalide.');
      else {
        for (let v = version; v < CAMPPLAN_FORMAT_VERSION; v++) {
          const migrate = FORMAT_MIGRATIONS[v];
          if (!migrate) throw new CampplanError(`Migration du format ${v} vers ${v + 1} manquante.`);
          rawManifest = { ...migrate(rawManifest), formatVersion: v + 1 };
        }
        const parsed = manifestSchema.safeParse(rawManifest);
        if (parsed.success) manifest = parsed.data;
        else fail('Manifeste invalide : structure inattendue.');
      }
    }
  }
  // Copie de secours incomplète : jamais importée comme un projet complet.
  if (manifest?.emergency && !manifest.emergency.complete) {
    if (!recovery)
      throw new CampplanError(
        'Copie de secours INCOMPLÈTE : importez-la en mode récupération (les parties manquantes seront listées).',
      );
    problems.push(...manifest.emergency.problems.map((p) => `Copie de secours : ${p}`));
  }

  // --- Plan ---
  let doc: PlanDocument | null = null;
  const planBytes = entries['plan.json'];
  if (!planBytes) fail('Fichier incomplet : plan manquant.');
  else {
    if (manifest && (await sha256Hex(planBytes.slice().buffer)) !== manifest.planSha256)
      fail('Le plan contenu dans le fichier est corrompu (empreinte SHA-256 différente).');
    try {
      doc = parsePlanDocument(strFromU8(planBytes)); // validation + migrations du schéma
    } catch (error) {
      const message = error instanceof ProjectFormatError ? error.message : 'Plan invalide.';
      if (!recovery) throw new CampplanError(message);
      const salvaged = salvagePlanDocument(strFromU8(planBytes));
      if (salvaged) {
        doc = salvaged.doc;
        problems.push(
          `Plan partiellement illisible (${message}) :`,
          ...salvaged.problems.map((p) => `— ${p}`),
        );
      } else problems.push(`Plan illisible : ${message}`);
    }
  }

  // --- Fichiers (photo, PDF d'origine, pictogrammes) ---
  const files = new Map<string, CampplanFile>();
  /** Fichiers vérifiés, par empreinte (récupération sans manifeste). */
  const bySha = new Map<string, CampplanFile>();
  if (manifest) {
    for (const entry of manifest.files) {
      const data = entries[entry.path];
      if (!data) {
        fail(`Fichier manquant dans l’archive : ${entry.path}.`);
        continue;
      }
      if (data.byteLength !== entry.byteLength || (await sha256Hex(data.slice().buffer)) !== entry.sha256) {
        fail(`Le fichier ${roleLabel(entry.role)} est corrompu (empreinte SHA-256 différente).`);
        continue;
      }
      const file = { bytes: data, mimeType: entry.mimeType, sha256: entry.sha256, role: entry.role };
      files.set(entry.blobId, file);
      bySha.set(entry.sha256, file);
    }
  } else
    for (const [path, data] of Object.entries(entries)) {
      if (!path.startsWith('fichiers/')) continue;
      const role = (path.split('/')[1]!.split('-')[0] ?? 'background') as FileRole;
      const sha = await sha256Hex(data.slice().buffer);
      bySha.set(sha, {
        bytes: data,
        mimeType: MIME_BY_EXTENSION[path.split('.').pop() ?? ''] ?? 'application/octet-stream',
        sha256: sha,
        role: ['background', 'pdf', 'symbol'].includes(role) ? role : 'background',
      });
    }
  /** Fichier attendu par un document : par identifiant, sinon (récupération) par empreinte. */
  const resolve = (blobId: string, sha: string) => {
    const direct = files.get(blobId);
    if (direct && direct.sha256 === sha) return direct;
    if (!recovery) return undefined;
    const found = bySha.get(sha);
    if (found) files.set(blobId, found);
    return found;
  };

  // --- Révisions ---
  const revisions: CampplanRevision[] = [];
  const revisionAssets: { blobId: string; asset: PlanDocument['assets'][string]; label: string }[] = [];
  const revisionIds = new Set<string>();
  const snapshots = new Map<string, PlanDocument>();
  if (!manifest && Object.keys(entries).some((p) => p.startsWith('revisions/')))
    problems.push('Révisions présentes mais leurs métadonnées (manifeste) sont perdues : non récupérées.');
  for (const entry of manifest?.revisions ?? []) {
    const parsedMeta = revisionMetaSchema.safeParse(entry.meta);
    if (!parsedMeta.success) {
      fail('Révision invalide dans le fichier : structure inattendue.');
      continue;
    }
    const meta = parsedMeta.data;
    const where = `Révision ${meta.label}`;
    if (revisionIds.has(meta.id)) {
      fail(`${where} : présente deux fois.`);
      continue;
    }
    const data = entries[entry.path];
    if (!data) {
      fail(`${where} : instantané manquant dans l’archive.`);
      continue;
    }
    const json = strFromU8(data);
    if (
      entry.sha256 !== meta.snapshot.sha256 ||
      data.byteLength !== entry.byteLength ||
      (await sha256OfText(json)) !== meta.snapshot.sha256
    ) {
      fail(`${where} : instantané corrompu (empreinte SHA-256 différente).`);
      continue;
    }
    if (!(await isSealIntact(meta))) {
      fail(`${where} : métadonnées altérées (sceau non conforme).`);
      continue;
    }
    let snapshot: PlanDocument;
    try {
      snapshot = parsePlanDocument(json);
    } catch (error) {
      fail(`${where} : ${error instanceof ProjectFormatError ? error.message : 'plan invalide.'}`);
      continue;
    }
    const missing = referencedFiles(snapshot).find(
      (needed) => !resolve(entry.blobMap[needed.blobId] ?? needed.blobId, needed.sha256),
    );
    if (missing) {
      fail(`${where} : le fichier ${missing.label} ne correspond pas aux fichiers de l’archive.`);
      continue;
    }
    revisionIds.add(meta.id);
    snapshots.set(meta.id, snapshot);
    for (const asset of Object.values(snapshot.assets))
      revisionAssets.push({ blobId: entry.blobMap[asset.blobId] ?? asset.blobId, asset, label: meta.label });
    revisions.push({ meta, json, blobMap: entry.blobMap });
  }

  // Plan illisible mais révision valide : le brouillon repart de la dernière révision (signalé).
  if (!doc && revisions.length) {
    const last = revisions.at(-1)!;
    doc = structuredClone(snapshots.get(last.meta.id)!);
    doc.plan.draftBase = { revisionId: last.meta.id, label: last.meta.label, at: nowIso() };
    problems.push(
      `Brouillon perdu : reconstitué à partir de la révision ${last.meta.label} (les modifications faites depuis sont perdues).`,
    );
  }
  if (!doc) throw new CampplanError(`Aucune donnée de plan récupérable. ${problems.join(' ')}`);

  // Le plan doit référencer exactement les fichiers fournis, avec les mêmes empreintes.
  for (const needed of referencedFiles(doc)) {
    if (resolve(needed.blobId, needed.sha256)) continue;
    fail(`Le fichier ${needed.label} ne correspond pas aux fichiers de l’archive.`);
    // Récupération : photo absente → plan SANS photo ; pictogramme absent → retiré.
    if (needed.role === 'symbol') {
      for (const [id, asset] of Object.entries(doc.assets))
        if (asset.blobId === needed.blobId) {
          delete doc.assets[id];
          if (doc.plan.titleBlock.logoAssetId === id) doc.plan.titleBlock.logoAssetId = null;
        }
    } else if (needed.role === 'pdf' && doc.plan.baseImage?.source.kind === 'pdf') {
      // PDF d'origine perdu : l'image rastérisée (le fond affiché) est conservée.
      doc.plan.baseImage = { ...doc.plan.baseImage, source: { kind: 'image' } };
      problems.push('PDF d’origine perdu : l’image du plan (rastérisée) est conservée.');
    } else if (needed.role === 'background' && doc.plan.baseImage) {
      doc.plan.baseImage = null;
      problems.push('Plan importé SANS sa photo (photo absente ou endommagée).');
    }
  }

  // Pictogrammes importés : mêmes vérifications qu'à l'import depuis l'éditeur (un fichier
  // .campplan fabriqué ne doit pas faire entrer un SVG actif ou une image démesurée), et type MIME
  // imposé par le plan (jamais celui, libre, du manifeste).
  const checked = new Map<string, boolean>();
  const checkAsset = (blobId: string, asset: PlanDocument['assets'][string]) => {
    const file = files.get(blobId);
    if (!file) return false;
    if (checked.has(blobId)) return checked.get(blobId)!;
    const check = checkSymbolFile(file.bytes, asset.mimeType === 'image/svg+xml' ? 'x.svg' : 'x.png');
    const ok = check.ok && check.mimeType === asset.mimeType;
    if (ok) files.set(blobId, { ...file, mimeType: asset.mimeType, role: 'symbol' });
    else
      fail(
        `Le pictogramme importé « ${asset.name} » est refusé : ${check.ok ? 'type de fichier incohérent' : check.reason}`,
      );
    checked.set(blobId, ok);
    return ok;
  };
  for (const [id, asset] of Object.entries(doc.assets))
    if (!checkAsset(asset.blobId, asset)) {
      delete doc.assets[id];
      if (doc.plan.titleBlock.logoAssetId === id) doc.plan.titleBlock.logoAssetId = null;
    }
  const refused = new Set(revisionAssets.filter((r) => !checkAsset(r.blobId, r.asset)).map((r) => r.label));
  // Une révision figée n'est jamais modifiée : si l'un de ses pictogrammes est refusé, elle est écartée.
  const keptRevisions = revisions.filter((r) => !refused.has(r.meta.label));
  for (const label of refused) problems.push(`Révision ${label} écartée (pictogramme refusé).`);

  const finalManifest: CampplanManifest = manifest ?? {
    format: 'campplan',
    formatVersion: CAMPPLAN_FORMAT_VERSION,
    application: 'CampPlanner',
    exportedAt: '',
    schemaVersion: doc.schemaVersion,
    site: { name: '', notes: '' },
    plan: { id: doc.plan.id, name: doc.plan.name, kind: doc.plan.kind },
    planSha256: '0'.repeat(64),
    files: [],
    presets: [],
    counts: { objects: Object.keys(doc.objects).length, layers: doc.layers.length },
    revisions: [],
  };
  return { manifest: finalManifest, doc, files, revisions: keptRevisions, problems };
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
  // Projet récupéré partiellement : toujours importé comme COPIE, marqué incomplet, jamais approuvé.
  if (content.problems.length) {
    if (options.mode === 'replace')
      throw new CampplanError('Un projet récupéré partiellement s’importe toujours comme une copie.');
    doc.plan.metadata = { ...doc.plan.metadata, recovery: { at: nowIso(), problems: content.problems } };
    if (doc.plan.titleBlock.status === 'approved')
      doc.plan.titleBlock = { ...doc.plan.titleBlock, status: 'draft', approvedAt: null };
  }
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
    // Même contenu déjà stocké (même SHA-256) : réutilisé, jamais une deuxième copie de la photo.
    const same = await repo.findBlobBySha256(file.sha256);
    if (same) {
      written.set(blobId, same);
      return same;
    }
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

  // Révisions : instantanés intacts (jamais réécrits) ; les fichiers sont résolus par une table de
  // correspondance. Une copie reçoit de nouveaux identifiants de révision (jamais de collision).
  const renewIds = doc.plan.id !== content.doc.plan.id;
  const idMap = new Map(content.revisions.map((r) => [r.meta.id, renewIds ? newId() : r.meta.id]));
  // Remplacement : les révisions locales restent (jamais remplacées). Une révision du fichier déjà
  // présente est ignorée ; une révision DIFFÉRENTE portant le même numéro est refusée (deux
  // historiques divergents ne sont jamais fusionnés en silence).
  const local = existing && options.mode === 'replace' ? await repo.listRevisions(doc.plan.id) : [];
  const localIds = new Set(local.map((e) => e.id));
  const localLabels = new Map(
    local.flatMap((e) => (e.meta ? [[e.meta.label.toUpperCase(), e.id] as const] : [])),
  );
  for (const r of content.revisions) {
    const clash = localLabels.get(r.meta.label.toUpperCase());
    if (!localIds.has(r.meta.id) && clash && clash !== r.meta.id)
      throw new CampplanError(
        `Le fichier contient une révision ${r.meta.label} différente de la révision ${r.meta.label} de ce plan (historiques divergents). Importez-le comme copie.`,
      );
  }
  const revisions: ImportedRevision[] = [];
  for (const r of content.revisions) {
    if (localIds.has(r.meta.id)) continue; // déjà présente : la version locale fait foi
    const blobMap: Record<string, string> = {};
    for (const [inSnapshot, inArchive] of Object.entries(r.blobMap))
      blobMap[inSnapshot] = await store(inArchive);
    for (const id of referencedBlobIds(parsePlanDocument(r.json)))
      if (!blobMap[id]) blobMap[id] = await store(id);
    revisions.push({
      meta: {
        ...r.meta,
        id: idMap.get(r.meta.id)!,
        planId: doc.plan.id,
        parentId: r.meta.parentId ? (idMap.get(r.meta.parentId) ?? null) : null,
      },
      json: r.json,
      blobMap,
    });
  }
  // Le brouillon issu d'une révision garde son lien (identifiant renouvelé le cas échéant).
  if (doc.plan.draftBase)
    doc.plan.draftBase = idMap.has(doc.plan.draftBase.revisionId)
      ? { ...doc.plan.draftBase, revisionId: idMap.get(doc.plan.draftBase.revisionId)! }
      : doc.plan.draftBase;

  // Camp éventuel + plan (+ fichiers de la version remplacée) + révisions : une seule transaction.
  await repo.saveImportedPlan(doc, newSite, revisions);
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
