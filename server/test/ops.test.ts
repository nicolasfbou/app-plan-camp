/** Exploitation (phase 9.1) : secrets lus dans des fichiers montés, contrôle de disponibilité. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFileSecrets } from '../src/config.ts';
import type { ObjectStorage } from '../src/storage/storage.ts';
import { createHarness, type Harness } from './harness.ts';

describe('secrets en fichiers (*_FILE)', () => {
  it('lit la valeur du fichier (fin de ligne retirée) ; refuse valeur ET fichier', () => {
    const files: Record<string, string> = { '/run/secrets/db': 'postgres://app:s3cret@db/cp\n' };
    const env = resolveFileSecrets({ DATABASE_URL_FILE: '/run/secrets/db' }, (p) => files[p]!);
    expect(env.DATABASE_URL).toBe('postgres://app:s3cret@db/cp');
    expect(() =>
      resolveFileSecrets({ DATABASE_URL: 'x', DATABASE_URL_FILE: '/run/secrets/db' }, (p) => files[p]!),
    ).toThrow(/tous deux/);
  });
});

describe('contrôle de disponibilité', () => {
  let h: Harness;
  let broken: Harness;
  beforeAll(async () => {
    h = await createHarness();
    const failing: ObjectStorage = {
      driver: 'test',
      putFile: () => Promise.reject(new Error('indisponible')),
      get: () => Promise.reject(new Error('indisponible')),
      exists: () => Promise.reject(new Error('indisponible')),
      delete: () => Promise.reject(new Error('indisponible')),
    };
    broken = await createHarness({}, { storage: failing });
  });
  afterAll(async () => {
    await h.close();
    await broken.close();
  });

  it('prêt : base et stockage joignables (sans session, sans donnée) ; 503 si le stockage tombe', async () => {
    const ok = await h.anonymous.req('GET', '/api/health/ready');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, database: true, storage: true });
    const ko = await broken.anonymous.req('GET', '/api/health/ready');
    expect(ko.statusCode).toBe(503);
    expect(ko.json()).toEqual({ ok: false, database: true, storage: false });
  });
});
