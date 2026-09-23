/**
 * Copie de secours : exporte TOUT ce qui peut l'être, même si une partie du projet est en erreur.
 * Priorité : 1. données du plan ; 2. photo originale ; 3. révisions valides ; 4. autres ressources.
 * Chaque partie manquante ou altérée est listée dans le manifeste (`emergency`) et dans
 * `LISEZ-MOI.txt` ; une copie incomplète ne se réimporte qu'en mode récupération (jamais présentée
 * comme complète). N'utilise que le stockage et le format : aucune fonction secondaire (rendu,
 * modèles, préréglages) n'est nécessaire.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import { sha256Hex } from '@/domain/image/hash.ts';
import { nowIso } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { referencedBlobIds } from '@/domain/revisions/revision.ts';
import { salvagePlanDocument } from '@/domain/schema/salvage.ts';
import { parsePlanDocument, serializePlanDocument } from '@/domain/schema/serialization.ts';
import { asciiName } from '@/backups/rotation.ts';
import { CAMPPLAN_FORMAT_VERSION, type CampplanManifest } from './campplan.ts';
import type { ProjectRepository } from './ProjectRepository.ts';

export interface EmergencyResult {
  bytes: Uint8Array;
  fileName: string;
  complete: boolean;
  problems: string[];
  /** Ce qui a été inclus. */
  included: {
    plan: 'intact' | 'partiel' | 'depuis-revision' | 'brut' | 'memoire';
    photo: boolean;
    revisions: number;
    files: number;
  };
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'image/svg+xml': 'svg',
};

export interface EmergencyOptions {
  now?: Date;
  /**
   * Document ouvert en mémoire, s'il contient des modifications NON enregistrées (ex. stockage
   * plein) : il devient le plan de la copie (le plan enregistré est joint à part).
   */
  memoryDoc?: PlanDocument | null;
}

export async function exportEmergency(
  repo: ProjectRepository,
  planId: string,
  options: EmergencyOptions = {},
): Promise<EmergencyResult> {
  const now = options.now ?? new Date();
  const problems: string[] = [];
  const entries: Zippable = {};
  let siteName = '';

  // 1. Données du plan (validées, sinon récupérées, sinon brutes).
  let raw: unknown = undefined;
  try {
    raw = await repo.getPlanRaw(planId);
  } catch (error) {
    problems.push(
      `Plan illisible dans le stockage : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let doc: PlanDocument | null = null;
  let planState: EmergencyResult['included']['plan'] = 'intact';
  if (raw !== undefined) {
    try {
      doc = parsePlanDocument(raw);
    } catch (error) {
      const salvaged = salvagePlanDocument(raw);
      problems.push(`Plan endommagé : ${error instanceof Error ? error.message : String(error)}`);
      // Récupération utile seulement si le plan garde son identité et ses calques ; sinon la
      // dernière révision valide est un meilleur point de départ (les données brutes sont jointes).
      const useful =
        salvaged && !salvaged.problems.some((p) => /Aucun calque lisible|« id »|« siteId »/.test(p));
      if (salvaged && useful) {
        doc = salvaged.doc;
        planState = 'partiel';
        problems.push(...salvaged.problems.map((p) => `Plan : ${p}`));
      }
      // Les données brutes sont TOUJOURS jointes, pour ne rien perdre.
      try {
        entries['plan-brut.json'] = strToU8(JSON.stringify(raw));
      } catch {
        problems.push('Données brutes du plan non sérialisables.');
      }
    }
  } else problems.push('Plan introuvable dans le stockage.');
  // Modifications en mémoire non enregistrées : elles priment (rien de ce qui est à l'écran
  // n'est perdu) ; la version enregistrée est jointe telle quelle.
  const memory = options.memoryDoc?.plan.id === planId ? options.memoryDoc : null;
  if (memory) {
    if (doc) entries['plan-enregistre.json'] = strToU8(serializePlanDocument(doc));
    doc = structuredClone(memory);
    planState = 'memoire';
    problems.push(
      'Plan pris dans l’éditeur (modifications non enregistrées dans le navigateur) ; la dernière version enregistrée est jointe (plan-enregistre.json).',
    );
  }
  try {
    siteName = doc ? ((await repo.getSite(doc.plan.siteId))?.name ?? '') : '';
  } catch {
    problems.push('Camp illisible (nom non repris).');
  }

  // 3. Révisions valides (lues avant la photo : elles peuvent remplacer un plan perdu).
  const revisionEntries: CampplanManifest['revisions'] = [];
  const revisionDocs: PlanDocument[] = [];
  let entriesList: Awaited<ReturnType<ProjectRepository['listRevisions']>> = [];
  try {
    entriesList = await repo.listRevisions(planId);
  } catch (error) {
    problems.push(`Révisions illisibles : ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const entry of entriesList) {
    try {
      if (!entry.meta) throw new Error('métadonnées illisibles');
      const loaded = await repo.loadRevision(entry.id);
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
      revisionDocs.push(loaded.doc);
    } catch (error) {
      problems.push(
        `Révision ${entry.meta?.label ?? entry.id.slice(0, 8)} non incluse (altérée ou illisible) : ${error instanceof Error ? error.message : String(error)} — données brutes jointes (revisions-brutes/, NON vérifiées).`,
      );
      // Rien n'est jeté : métadonnées et instantané bruts joints pour une expertise manuelle.
      try {
        const rawSnapshot = await repo.readRevisionSnapshot(entry.id).catch(() => null);
        entries[`revisions-brutes/${entry.id.replace(/[^\w.-]/g, '_')}.json`] = strToU8(
          JSON.stringify({
            avertissement: 'Révision NON vérifiée (empreinte ou sceau invalide, ou illisible).',
            meta: entry.meta ?? null,
            instantane: rawSnapshot?.json ?? null,
            correspondanceFichiers: rawSnapshot?.blobMap ?? null,
          }),
        );
      } catch {
        problems.push(`Révision ${entry.id.slice(0, 8)} : données brutes non récupérables.`);
      }
    }
  }
  if (!doc && revisionDocs.length) {
    doc = structuredClone(revisionDocs.at(-1)!);
    planState = 'depuis-revision';
    problems.push('Brouillon perdu : le plan de la copie est celui de la dernière révision valide.');
  }
  if (doc) entries['plan.json'] = strToU8(serializePlanDocument(doc));

  // 2. et 4. Photo originale, PDF d'origine, pictogrammes (ceux du plan puis des révisions).
  const files: CampplanManifest['files'] = [];
  const seen = new Set<string>();
  let photo = false;
  const wanted: { blobId: string; role: 'background' | 'pdf' | 'symbol'; sha256: string; label: string }[] =
    [];
  for (const d of [...(doc ? [doc] : []), ...revisionDocs]) {
    const image = d.plan.baseImage;
    if (image) {
      wanted.push({ blobId: image.blobId, role: 'background', sha256: image.sha256, label: 'photo' });
      if (image.source.kind === 'pdf')
        wanted.push({
          blobId: image.source.pdfBlobId,
          role: 'pdf',
          sha256: image.source.pdfSha256,
          label: 'PDF d’origine',
        });
    }
    for (const asset of Object.values(d.assets))
      wanted.push({
        blobId: asset.blobId,
        role: 'symbol',
        sha256: asset.sha256,
        label: `pictogramme « ${asset.name} »`,
      });
  }
  for (const w of wanted) {
    if (seen.has(w.blobId)) continue;
    seen.add(w.blobId);
    try {
      const blob = await repo.getBlob(w.blobId);
      if (!blob) {
        problems.push(`Fichier absent du stockage : ${w.label}.`);
        continue;
      }
      const actual = await sha256Hex(blob.bytes);
      const path = `fichiers/${w.role}-${actual.slice(0, 16)}.${EXT[blob.mimeType] ?? 'bin'}`;
      entries[path] = [new Uint8Array(blob.bytes), { level: 0 }];
      // Fichier altéré : joint quand même (rien n'est jeté), mais signalé et non déclaré conforme.
      if (actual !== w.sha256)
        problems.push(`Fichier altéré (SHA-256 différent) joint tel quel : ${w.label}.`);
      files.push({
        path,
        role: w.role,
        blobId: w.blobId,
        mimeType: blob.mimeType,
        byteLength: blob.byteLength,
        sha256: actual,
      });
      if (w.role === 'background' && actual === w.sha256) photo = true;
    } catch (error) {
      problems.push(
        `Fichier illisible (${w.label}) : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Fichiers indexés pour ce plan mais que le document (illisible) ne décrit plus : joints bruts,
  // pour que la photo originale ne soit jamais perdue avec un plan endommagé.
  let indexed: string[] = [];
  try {
    indexed = await repo.getPlanBlobIds(planId);
  } catch {
    // index illisible : rien de plus à joindre
  }
  for (const blobId of indexed) {
    if (seen.has(blobId)) continue;
    seen.add(blobId);
    try {
      const blob = await repo.getBlob(blobId);
      if (!blob) continue;
      const path = `fichiers-bruts/${blobId.replace(/[^\w.-]/g, '_')}.${EXT[blob.mimeType] ?? 'bin'}`;
      entries[path] = [new Uint8Array(blob.bytes), { level: 0 }];
      problems.push(
        `Fichier du plan joint sans description (document illisible ; probablement la photo ou un pictogramme) : ${path}, SHA-256 ${await sha256Hex(blob.bytes)}.`,
      );
    } catch {
      problems.push(`Fichier du plan illisible : ${blobId.slice(0, 8)}.`);
    }
  }
  if (doc?.plan.baseImage && !photo) problems.push('Photo originale NON incluse ou altérée.');

  const complete = problems.length === 0 && planState === 'intact';
  const planJson = entries['plan.json'] as Uint8Array | undefined;
  const manifest: CampplanManifest = {
    format: 'campplan',
    formatVersion: CAMPPLAN_FORMAT_VERSION,
    application: 'CampPlanner',
    exportedAt: now.toISOString(),
    schemaVersion: doc?.schemaVersion ?? 1,
    site: { name: siteName, notes: '' },
    plan: { id: doc?.plan.id ?? planId, name: doc?.plan.name ?? '', kind: doc?.plan.kind ?? 'other' },
    planSha256: planJson ? await sha256Hex(planJson.slice().buffer) : '0'.repeat(64),
    files,
    presets: [],
    counts: { objects: doc ? Object.keys(doc.objects).length : 0, layers: doc?.layers.length ?? 1 },
    revisions: revisionEntries,
    emergency: { createdAt: nowIso(), complete, problems },
  };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  entries['LISEZ-MOI.txt'] = strToU8(
    [
      'COPIE DE SECOURS CampPlanner',
      `Créée le ${now.toISOString()}`,
      complete
        ? 'Copie COMPLÈTE : plan, photo originale, révisions et ressources inclus et vérifiés.'
        : 'Copie INCOMPLÈTE : à réimporter en mode « récupération ». Parties manquantes ou altérées :',
      ...problems.map((p) => `- ${p}`),
      '',
    ].join('\r\n'),
  );
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
  return {
    bytes: zipSync(entries, { level: 6 }),
    // Nom ASCII portable (clés USB, disques Windows, navigateurs) comme les sauvegardes externes.
    fileName: `${asciiName(`${siteName ? `${siteName} - ` : ''}${doc?.plan.name ?? planId}`)} - SECOURS ${stamp}.campplan`,
    complete,
    problems,
    included: {
      plan: doc ? planState : 'brut',
      photo,
      revisions: revisionEntries.length,
      files: files.length,
    },
  };
}
