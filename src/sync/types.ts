/**
 * Enregistrements locaux de la synchronisation (IndexedDB de l'espace d'organisation).
 */

export type EntityType = 'camp' | 'plan' | 'revision' | 'template' | 'file';

export type OperationKind =
  | 'camp.upsert'
  | 'camp.delete'
  | 'file.upload'
  | 'plan.upsert'
  | 'plan.delete'
  | 'revision.create'
  | 'revision.delete'
  | 'template.upsert'
  | 'template.delete';

export type OperationStatus = 'pending' | 'blocked' | 'failed' | 'done';

/**
 * Opération en file (rejouable sans duplication : `operationId` sert de clé d'idempotence côté
 * serveur). Une opération `plan.upsert` n'embarque pas de document figé : à l'envoi, elle lit
 * l'état ENREGISTRÉ le plus récent du plan (plusieurs modifications hors ligne = un seul envoi).
 */
export interface SyncOperationRecord {
  seq?: number;
  operationId: string;
  kind: OperationKind;
  entityType: EntityType;
  entityId: string;
  organizationId: string;
  /** Version serveur connue à la mise en file (information ; l'envoi relit le lien serveur). */
  baseServerVersion: number | null;
  createdAt: string;
  retryCount: number;
  status: OperationStatus;
  lastError: string | null;
  /** Prochain essai (ms) après une erreur réseau. */
  nextAttemptAt: number;
  /** Clé propre (`plan:<id>`…) puis clés dont elle dépend : ordre cohérent garanti. */
  keys: string[];
  /** Origine d'une création (audit serveur). */
  origin?: 'create' | 'import' | 'publish';
  /** Libellé lisible (camp, plan, révision…). */
  label: string;
  planId?: string;
  campId?: string;
}

/** Lien d'un élément local avec le serveur. */
export interface SyncLinkRecord {
  /** `<type>:<id>` */
  key: string;
  entityType: EntityType;
  entityId: string;
  serverVersion: number;
  /** Version LOCALE du plan au dernier envoi / à la dernière réception (propre = inchangée depuis). */
  syncedLocalVersion?: number;
  /** Document serveur de référence (base commune d'un conflit). */
  baseDoc?: unknown;
  syncedAt: string;
  /** Version serveur reçue mais pas encore appliquée (plan ouvert en édition). */
  pendingPull?: number;
  deleted?: boolean;
}

/** Conflit : jamais résolu en silence ; la copie locale reste intacte jusqu'à décision. */
export interface SyncConflictRecord {
  planId: string;
  planName: string;
  reason: 'version' | 'deleted';
  serverVersion: number;
  serverDoc: unknown | null;
  serverUpdatedBy: string;
  serverUpdatedAt: string;
  localVersion: number;
  localUpdatedAt: string;
  /** Dernière version serveur commune (pour distinguer mes changements et ceux du serveur). */
  baseDoc: unknown | null;
  detectedAt: string;
  operationId: string;
}

/** Version locale mise de côté lors d'un choix « garder la version serveur » (rien n'est perdu). */
export interface ConflictArchiveRecord {
  id?: number;
  planId: string;
  planName: string;
  doc: unknown;
  archivedAt: string;
  reason: string;
}

export const entityKey = (type: EntityType, id: string) => `${type}:${id}`;
