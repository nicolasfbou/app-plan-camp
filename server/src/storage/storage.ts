/**
 * Stockage objet ABSTRAIT : le code métier ne dépend d'aucun fournisseur. Pilotes :
 * - `fs`  : disque local (développement, tests, petit serveur interne) ;
 * - `s3`  : tout service compatible S3 (AWS S3, MinIO, Ceph…) ;
 * - Azure Blob Storage : prévu (même interface, pilote à ajouter — voir docs/PHASE9-SERVER.md).
 * Les objets sont immuables (clé = empreinte SHA-256) : jamais réécrits une fois stockés.
 */
import type { Readable } from 'node:stream';
import type { ServerConfig } from '../config.ts';

export interface ObjectStorage {
  readonly driver: string;
  /** Copie un fichier local (déjà vérifié) sous `key`. */
  putFile(key: string, path: string, meta: { contentType: string; byteLength: number }): Promise<void>;
  /** Flux de lecture, ou `null` si l'objet n'existe pas. */
  get(key: string): Promise<Readable | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export async function createStorage(config: ServerConfig['storage']): Promise<ObjectStorage> {
  if (config.driver === 's3') {
    const { S3Storage } = await import('./s3Storage.ts');
    return new S3Storage(config);
  }
  const { FsStorage } = await import('./fsStorage.ts');
  return new FsStorage(config.root);
}

/** Clé d'un fichier : isolée par organisation (jamais de dédoublonnage entre organisations). */
export const fileKey = (orgId: string, sha256: string) => `org/${orgId}/sha256/${sha256}`;
