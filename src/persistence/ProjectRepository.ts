/**
 * Contrat de persistance. L'application ne dépend que de cette interface : l'implémentation
 * IndexedDB (V1) pourra être complétée par un serveur (V3) sans toucher à l'éditeur.
 */
import type { PlanDocument, PlanKind, Site } from '@/domain/model/types.ts';

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
  deletePlan(id: string): Promise<void>;

  /** Stocke des octets tels quels et retourne leur empreinte. */
  putBlob(bytes: ArrayBuffer, mimeType: string): Promise<Omit<StoredBlob, 'bytes'>>;
  getBlob(id: string): Promise<StoredBlob | undefined>;
}
