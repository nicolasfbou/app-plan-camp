/**
 * Serveur de test complet : PostgreSQL réel (rôle applicatif, RLS active), stockage disque
 * temporaire, deux organisations (A = PAMM, B = Autre) et un compte par rôle.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createPlanDocument, createSite, newId } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { freezeRevision } from '@/domain/revisions/revision.ts';
import { buildApp } from '../src/app.ts';
import { addUser, createOrganization } from '../src/bootstrap.ts';
import { loadConfig } from '../src/config.ts';
import { FsStorage } from '../src/storage/fsStorage.ts';
import { createTestDatabase } from './db.ts';

export const PASSWORD = 'mot-de-passe-solide-2026';

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(overrides: Record<string, string> = {}) {
  const db = await createTestDatabase();
  const filesRoot = mkdtempSync(join(tmpdir(), 'campplanner-files-'));
  const config = loadConfig({ DATABASE_URL: db.appUrl, STORAGE_FS_ROOT: filesRoot, ...overrides });
  const app = await buildApp({ config, pool: db.pool, storage: new FsStorage(filesRoot) });
  const orgA = await createOrganization(db.owner, { name: 'PAMM', slug: 'pamm' });
  const orgB = await createOrganization(db.owner, { name: 'Autre entreprise', slug: 'autre' });
  const mk = (orgId: string, email: string, name: string, role: 'admin' | 'manager' | 'editor' | 'reader') =>
    addUser(db.owner, { orgId, email, displayName: name, password: PASSWORD, role });
  const users = {
    adminA: await mk(orgA.id, 'admin@pamm.test', 'Admin PAMM', 'admin'),
    managerA: await mk(orgA.id, 'gestion@pamm.test', 'M. Gagnon', 'manager'),
    editorA: await mk(orgA.id, 'edition@pamm.test', 'N. Tremblay', 'editor'),
    readerA: await mk(orgA.id, 'lecture@pamm.test', 'L. Roy', 'reader'),
    adminB: await mk(orgB.id, 'admin@autre.test', 'Admin Autre', 'admin'),
  };

  /** Client HTTP authentifié (cookie de session) sur l'application en processus. */
  async function login(email: string, deviceMode: 'trusted' | 'shared' = 'trusted') {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-campplanner': '1' },
      payload: { email, password: PASSWORD, deviceMode },
    });
    if (r.statusCode !== 200) throw new Error(`login ${email}: ${r.statusCode} ${r.body}`);
    const cookie = r.cookies.find((c) => c.name === 'cp_session')!;
    return client(app, `cp_session=${cookie.value}`);
  }

  return {
    db,
    app,
    config,
    orgA,
    orgB,
    users,
    login,
    anonymous: client(app, ''),
    async close() {
      await app.close();
      await db.drop();
      rmSync(filesRoot, { recursive: true, force: true });
    },
  };
}

export interface ApiClient {
  req(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options?: { body?: unknown; headers?: Record<string, string>; raw?: Buffer },
  ): Promise<LightMyRequestResponse>;
  cookie: string;
}

export function client(app: FastifyInstance, cookie: string): ApiClient {
  return {
    cookie,
    req(method, url, options = {}) {
      return app.inject({
        method,
        url,
        headers: {
          ...(cookie ? { cookie } : {}),
          'x-campplanner': '1',
          ...(options.raw ? { 'content-type': 'application/octet-stream' } : {}),
          ...options.headers,
        },
        ...(options.raw
          ? { payload: options.raw }
          : options.body !== undefined
            ? { payload: options.body as object }
            : {}),
      });
    },
  };
}

// --- Données de test ---------------------------------------------------------------------------

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Fausse photo JPEG (octets aléatoires derrière une vraie signature). */
export function jpeg(size = 4096): Buffer {
  const b = randomBytes(size);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

export async function uploadFile(api: ApiClient, bytes: Buffer, type = 'image/jpeg') {
  return api.req('PUT', `/api/files/${sha256(bytes)}`, { raw: bytes, headers: { 'x-file-type': type } });
}

/** Camp + plan avec photo, créés sur le serveur ; renvoie le document et sa version. */
export async function seedPlan(api: ApiClient, name = 'Circulation') {
  const site = createSite('Camp 105');
  const photo = jpeg();
  const up = await uploadFile(api, photo);
  if (up.statusCode >= 300) throw new Error(`upload: ${up.body}`);
  const camp = await api.req('PUT', `/api/camps/${site.id}`, {
    body: { name: site.name },
    headers: { 'if-match': '0' },
  });
  if (camp.statusCode !== 201) throw new Error(`camp: ${camp.body}`);
  const doc = createPlanDocument({ siteId: site.id, name });
  doc.plan.baseImage = {
    blobId: newId(),
    fileName: 'camp-105.jpg',
    mimeType: 'image/jpeg',
    byteLength: photo.length,
    sha256: sha256(photo),
    width: 400,
    height: 300,
    exifOrientation: 1,
    importedAt: new Date().toISOString(),
    source: { kind: 'image' },
  };
  const put = await putPlan(api, doc, 0);
  if (put.statusCode !== 201) throw new Error(`plan: ${put.body}`);
  return { site, doc, photo, version: put.json().serverVersion as number };
}

export function putPlan(api: ApiClient, doc: PlanDocument, ifMatch: number, key?: string) {
  return api.req('PUT', `/api/plans/${doc.plan.id}`, {
    body: { campId: doc.plan.siteId, document: doc },
    headers: { 'if-match': String(ifMatch), ...(key ? { 'idempotency-key': key } : {}) },
  });
}

export async function frozen(doc: PlanDocument, label = 'A', existingLabels: string[] = []) {
  return freezeRevision(
    doc,
    {
      label,
      description: 'Émission',
      author: 'N. Tremblay',
      date: '2026-10-01',
      reason: '',
      comments: '',
      status: 'review',
    },
    { id: newId(), existingLabels, parentId: null, changes: null, now: new Date().toISOString() },
  );
}
