/**
 * Contrat de persistance. L'application ne dépend que de cette interface : l'implémentation
 * IndexedDB (V1) pourra être complétée par un serveur (V3) sans toucher à l'éditeur.
 */
import type { PlanDocument, PlanKind, Site } from '@/domain/model/types.ts';
import type { ViewCenter } from '@/domain/viewport/viewport.ts';
import type { PlanTemplate } from '@/domain/templates/template.ts';
import type { FrozenRevision, RevisionMeta, StatusChange } from '@/domain/revisions/revision.ts';

/** Révision listée (métadonnées seulement : l'instantané n'est lu qu'à la demande). */
export interface RevisionEntry {
  id: string;
  /** null : métadonnées illisibles (jamais masqué en silence). */
  meta: RevisionMeta | null;
  /** Sceau conforme (champs figés et approbation non altérés). */
  sealIntact: boolean;
}

/** Révision chargée : instantané vérifié (SHA-256), migré, figé, fichiers locaux résolus. */
export interface LoadedRevision {
  meta: RevisionMeta;
  doc: PlanDocument;
}

/** Révision importée d'un fichier `.campplan` (identifiants de fichiers locaux). */
export interface ImportedRevision extends FrozenRevision {
  /** Identifiant de fichier dans l'instantané → identifiant local. */
  blobMap: Record<string, string>;
}

/** Le plan enregistré a changé depuis son ouverture : conflit à résoudre par l'utilisateur. */
export class PlanConflictError extends Error {
  override name = 'PlanConflictError';
  constructor(
    readonly planId: string,
    readonly storedVersion: number,
    readonly expectedVersion: number,
  ) {
    super('Ce plan a été modifié ailleurs (autre onglet, import…) depuis son ouverture.');
  }
}

/** Modèle d'entreprise enregistré sur cet ordinateur (avec les octets de son logo). */
export interface StoredTemplate {
  template: PlanTemplate;
  logo: Uint8Array | null;
}

export interface PlanSummary {
  id: string;
  siteId: string;
  name: string;
  kind: PlanKind;
  updatedAt: string;
}

export interface OrphanBlob {
  id: string;
  byteLength: number;
  mimeType: string;
  createdAt?: string;
}

/** Fichier binaire conservé à l'octet près (photo d'origine, PDF d'origine, icône importée). */
export interface StoredBlob {
  id: string;
  bytes: ArrayBuffer;
  mimeType: string;
  byteLength: number;
  sha256: string;
  /** Date d'écriture (ISO). Sert à ne jamais nettoyer un fichier tout juste importé. */
  createdAt?: string;
}

export interface ProjectRepository {
  listSites(): Promise<Site[]>;
  getSite(id: string): Promise<Site | undefined>;
  saveSite(site: Site): Promise<void>;
  /** Supprime le site, ses plans (et leurs révisions) et les fichiers qui ne sont plus référencés. */
  deleteSite(id: string): Promise<void>;

  listPlans(siteId: string): Promise<PlanSummary[]>;
  /** Charge, migre et valide un plan. Lève `ProjectFormatError` si les données sont corrompues. */
  loadPlan(id: string): Promise<PlanDocument | undefined>;
  /** Plan et sa version d'enregistrement (lus ensemble), pour détecter les écritures concurrentes. */
  openPlan(id: string): Promise<{ doc: PlanDocument; version: number } | undefined>;
  /**
   * Écrit le plan et retourne sa nouvelle version. Avec `expectedVersion`, l'écriture est REFUSÉE
   * (`PlanConflictError`) si le plan enregistré a changé depuis (autre onglet, import…) : jamais
   * d'écrasement silencieux.
   */
  savePlan(doc: PlanDocument, options?: { expectedVersion?: number }): Promise<number>;
  getPlanVersion(id: string): Promise<number | undefined>;
  /** Document brut d'un plan, SANS validation (export de secours d'un plan endommagé). */
  getPlanRaw(id: string): Promise<unknown>;
  /** Date (ms) de la dernière écriture du plan, pour comparer avec un journal de récupération. */
  getPlanSavedAt(id: string): Promise<number | undefined>;
  deletePlan(id: string): Promise<void>;
  /**
   * Résumé d'un plan lu SANS le valider : sert à savoir si un identifiant existe déjà (même si
   * son contenu est illisible) et dans quel camp il se trouve.
   */
  getPlanSummary(id: string): Promise<PlanSummary | undefined>;
  /**
   * Écriture ATOMIQUE d'un plan importé : crée le camp éventuel, écrit le plan (remplace celui de
   * même identifiant), puis supprime les fichiers de l'ancienne version qui ne sont plus
   * référencés. En cas d'échec, rien de tout cela n'est écrit.
   */
  saveImportedPlan(doc: PlanDocument, newSite: Site | null, revisions?: ImportedRevision[]): Promise<void>;

  /**
   * Révisions figées d'un plan, dans l'ordre de création. Métadonnées seulement : les instantanés
   * complets ne sont jamais chargés pour lister.
   */
  listRevisions(planId: string): Promise<RevisionEntry[]>;
  /**
   * Instantané d'une révision. Lève `RevisionIntegrityError` si son empreinte SHA-256 ne
   * correspond plus (révision altérée), `ProjectFormatError` s'il est illisible.
   */
  loadRevision(id: string): Promise<LoadedRevision>;
  /** Texte exact de l'instantané (export `.campplan`) et correspondance des fichiers locaux. */
  readRevisionSnapshot(id: string): Promise<{ json: string; blobMap: Record<string, string> }>;
  /** Enregistre une révision figée (instantané + métadonnées, en une transaction). */
  createRevision(revision: FrozenRevision): Promise<void>;
  /** Seul changement possible après la création : le statut (règles de `changeRevisionStatus`). */
  setRevisionStatus(id: string, change: StatusChange, now?: string): Promise<RevisionMeta>;
  /** Supprime une révision non approuvée. Lève `RevisionError` pour une révision approuvée. */
  deleteRevision(id: string): Promise<void>;

  /** Stocke des octets tels quels et retourne leur empreinte. */
  putBlob(bytes: ArrayBuffer, mimeType: string): Promise<Omit<StoredBlob, 'bytes'>>;
  getBlob(id: string): Promise<StoredBlob | undefined>;
  /** Identifiant d'un fichier déjà stocké avec cette empreinte (réutilisé plutôt que dupliqué). */
  findBlobBySha256(sha256: string): Promise<string | undefined>;
  /**
   * Supprime les fichiers qui ne sont référencés par aucun plan (ex. import annulé) et qui ont
   * plus de `minAgeMs` : un fichier tout juste importé dans un autre onglet, pas encore
   * référencé par la sauvegarde automatique, n'est donc jamais supprimé.
   */
  deleteOrphanBlobs(minAgeMs?: number, protectedTexts?: readonly string[]): Promise<number>;

  /**
   * Préférence d'affichage (dernier zoom / centre de vue) : confort uniquement. Stockée à part,
   * elle ne fait partie ni du document, ni de la géométrie des objets, ni du fichier `.campplan`.
   */
  getViewPrefs(planId: string): Promise<ViewCenter | undefined>;
  saveViewPrefs(planId: string, view: ViewCenter): Promise<void>;

  /**
   * Réglages locaux de l'application (clé → valeur clonable : dossier de sauvegarde autorisé,
   * historique des sauvegardes externes). Hors des plans et des fichiers `.campplan`.
   */
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;

  // --- Maintenance (centre de santé, nettoyage) ---------------------------------------------
  /**
   * Fichiers stockés que plus aucun plan ni aucune révision ne référence. La référence est
   * établie par les index ET par le CONTENU (documents, instantanés, correspondances de fichiers,
   * même illisibles) : un index périmé ne suffit jamais à rendre un fichier orphelin.
   * `protectedTexts` : autres textes à respecter (ex. journaux de récupération).
   */
  listOrphanBlobs(protectedTexts?: readonly string[]): Promise<OrphanBlob[]>;
  /** Supprime ces fichiers s'ils sont TOUJOURS orphelins (revérifié dans la transaction). */
  deleteBlobs(
    ids: readonly string[],
    protectedTexts?: readonly string[],
  ): Promise<{ deleted: number; bytes: number }>;
  /** Fichiers indexés pour un plan (même si son document est illisible). */
  getPlanBlobIds(planId: string): Promise<string[]>;
  /** Identifiants de TOUS les plans enregistrés (même ceux dont le camp est absent). */
  listPlanIds(): Promise<string[]>;
  /** Index secondaires d'un plan et de ses révisions (fichiers référencés) : cohérents ou non. */
  checkPlanIndex(planId: string): Promise<{ consistent: boolean; details: string[] }>;
  /** Recalcule ces index à partir des documents (aucun contenu modifié). */
  reindexPlan(planId: string): Promise<void>;
  deleteViewPrefs(planId: string): Promise<void>;
  listViewPrefPlanIds(): Promise<string[]>;

  /** Modèles d'entreprise (validés à la lecture ; un modèle illisible est ignoré). */
  listTemplates(): Promise<StoredTemplate[]>;
  getTemplate(id: string): Promise<StoredTemplate | undefined>;
  saveTemplate(entry: StoredTemplate): Promise<void>;
  deleteTemplate(id: string): Promise<void>;
}
