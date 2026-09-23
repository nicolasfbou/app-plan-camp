/**
 * Contrat de persistance. L'application ne dépend que de cette interface : l'implémentation
 * IndexedDB (V1) pourra être complétée par un serveur (V3) sans toucher à l'éditeur.
 */
import type { PlanDocument, PlanKind, Site } from '@/domain/model/types.ts';
import type { ViewCenter } from '@/domain/viewport/viewport.ts';
import type { PlanTemplate } from '@/domain/templates/template.ts';

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
  /** Supprime le site, ses plans et les fichiers qui ne sont plus référencés. */
  deleteSite(id: string): Promise<void>;

  listPlans(siteId: string): Promise<PlanSummary[]>;
  /** Charge, migre et valide un plan. Lève `ProjectFormatError` si les données sont corrompues. */
  loadPlan(id: string): Promise<PlanDocument | undefined>;
  savePlan(doc: PlanDocument): Promise<void>;
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
  saveImportedPlan(doc: PlanDocument, newSite: Site | null): Promise<void>;

  /** Stocke des octets tels quels et retourne leur empreinte. */
  putBlob(bytes: ArrayBuffer, mimeType: string): Promise<Omit<StoredBlob, 'bytes'>>;
  getBlob(id: string): Promise<StoredBlob | undefined>;
  /**
   * Supprime les fichiers qui ne sont référencés par aucun plan (ex. import annulé) et qui ont
   * plus de `minAgeMs` : un fichier tout juste importé dans un autre onglet, pas encore
   * référencé par la sauvegarde automatique, n'est donc jamais supprimé.
   */
  deleteOrphanBlobs(minAgeMs?: number): Promise<number>;

  /**
   * Préférence d'affichage (dernier zoom / centre de vue) : confort uniquement. Stockée à part,
   * elle ne fait partie ni du document, ni de la géométrie des objets, ni du fichier `.campplan`.
   */
  getViewPrefs(planId: string): Promise<ViewCenter | undefined>;
  saveViewPrefs(planId: string, view: ViewCenter): Promise<void>;

  /** Modèles d'entreprise (validés à la lecture ; un modèle illisible est ignoré). */
  listTemplates(): Promise<StoredTemplate[]>;
  getTemplate(id: string): Promise<StoredTemplate | undefined>;
  saveTemplate(entry: StoredTemplate): Promise<void>;
  deleteTemplate(id: string): Promise<void>;
}
