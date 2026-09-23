/** Pilote « disque » : objets sous un dossier racine, écriture atomique (fichier temporaire + renommage). */
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { ObjectStorage } from './storage.ts';

export class FsStorage implements ObjectStorage {
  readonly driver = 'fs';
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    if (!/^[A-Za-z0-9/_-]+$/.test(key) || key.includes('..')) throw new Error('Clé de stockage invalide.');
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('Clé de stockage invalide.');
    return full;
  }
  async putFile(key: string, path: string) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await copyFile(path, temp);
    await rename(temp, target);
  }
  async get(key: string): Promise<Readable | null> {
    const target = this.path(key);
    return (await this.exists(key)) ? createReadStream(target) : null;
  }
  async exists(key: string) {
    try {
      await access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}
