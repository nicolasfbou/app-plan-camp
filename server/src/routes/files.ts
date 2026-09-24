/**
 * Fichiers (photos, PDF d'origine, pictogrammes, logos), identifiés par (organisation, SHA-256).
 * Envoi en flux vers un fichier temporaire, SHA-256 RECALCULÉ, taille bornée, type réel vérifié,
 * SVG contrôlé ; rien n'est enregistré si l'envoi est interrompu ou refusé. Idempotent : renvoyer
 * un fichier déjà présent ne crée rien.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';
import { tx } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { ALLOWED_TYPES, sniffType, unsafeSvg } from '../files/validate.ts';
import { allowedCampIds, requirePermission } from '../permissions.ts';
import { fileKey } from '../storage/storage.ts';

const SHA = /^[0-9a-f]{64}$/;

/** Écrit le flux dans un fichier temporaire en calculant SHA-256 et taille ; borne la taille. */
async function receive(stream: Readable, limit: number) {
  const path = join(tmpdir(), `campplanner-upload-${randomBytes(8).toString('hex')}`);
  const hash = createHash('sha256');
  let size = 0;
  const out = createWriteStream(path);
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          // Ne plus lire (sans couper la connexion avant la réponse) : le client reçoit bien le 413,
          // erreur définitive, au lieu d'une coupure réseau qu'il réessaierait indéfiniment.
          stream.removeAllListeners('data');
          stream.pause();
          reject(
            new HttpError(
              413,
              'too-large',
              `Fichier trop volumineux (maximum ${Math.round(limit / 1048576)} Mo).`,
            ),
          );
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          stream.pause();
          out.once('drain', () => stream.resume());
        }
      });
      stream.on('end', () => out.end(resolve));
      stream.on('error', reject);
      stream.on('aborted', () => reject(new HttpError(400, 'aborted', 'Envoi interrompu.')));
      out.on('error', reject);
    });
  } catch (error) {
    out.destroy();
    await rm(path, { force: true });
    throw error;
  }
  return { path, size, sha256: hash.digest('hex') };
}

async function head(path: string, n = 512) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buffer, 0, n, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function registerFileRoutes(app: FastifyInstance, deps: Deps) {
  // Corps brut, lu en flux (jamais entièrement en mémoire).
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.post('/api/files/check', async (request) => {
    const auth = requireAuth(request);
    const body = z.object({ sha256: z.array(z.string().regex(SHA)).max(1000) }).parse(request.body);
    const present = await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, (c) =>
      c.query<{ sha256: string }>(
        'SELECT sha256 FROM files WHERE organization_id = $2 AND sha256 = ANY($1)',
        [body.sha256, auth.orgId],
      ),
    );
    return { present: present.rows.map((r) => r.sha256) };
  });

  app.put<{ Params: { sha256: string } }>(
    '/api/files/:sha256',
    { bodyLimit: deps.config.maxUploadBytes + 1024 },
    async (request, reply) => {
      const auth = requireAuth(request);
      requirePermission(auth, 'plan.write');
      const expected = request.params.sha256;
      if (!SHA.test(expected)) throw notFound('Fichier');
      const declared = String(request.headers['x-file-type'] ?? '');
      if (!(ALLOWED_TYPES as readonly string[]).includes(declared))
        throw new HttpError(415, 'unsupported-type', 'Type de fichier non accepté.');
      if (!(request.body && typeof (request.body as Readable).on === 'function'))
        throw new HttpError(415, 'unsupported-type', 'Corps binaire attendu (application/octet-stream).');
      const received = await receive(request.body as Readable, deps.config.maxUploadBytes);
      try {
        if (received.size === 0) throw new HttpError(422, 'empty', 'Fichier vide.');
        if (received.sha256 !== expected)
          throw new HttpError(
            422,
            'sha-mismatch',
            'Empreinte SHA-256 différente de celle annoncée : fichier refusé.',
          );
        const actual = sniffType(await head(received.path));
        if (!actual || actual !== declared)
          throw new HttpError(
            415,
            'type-mismatch',
            'Le contenu du fichier ne correspond pas au type annoncé.',
          );
        if (actual === 'image/svg+xml') {
          if (received.size > deps.config.maxSvgBytes)
            throw new HttpError(413, 'too-large', 'SVG trop volumineux.');
          const problem = unsafeSvg(new Uint8Array(await readFile(received.path)));
          if (problem) throw new HttpError(422, 'unsafe-svg', problem);
        }
        const key = fileKey(auth.orgId, expected);
        const created = await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
          const exists = await c.query('SELECT 1 FROM files WHERE organization_id = $2 AND sha256 = $1', [
            expected,
            auth.orgId,
          ]);
          if (exists.rowCount) return false;
          // Objet écrit AVANT la ligne (si l'écriture échoue, rien n'est référencé).
          await deps.storage.putFile(key, received.path, { contentType: actual, byteLength: received.size });
          await c.query(
            `INSERT INTO files (organization_id, sha256, byte_length, mime_type, storage_key, created_by)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
            [auth.orgId, expected, received.size, actual, key, auth.userId],
          );
          await audit(c, {
            orgId: auth.orgId,
            userId: auth.userId,
            action: 'file.upload',
            targetKind: 'file',
            targetId: expected,
            requestId: request.id,
            context: { bytes: received.size, type: actual },
          });
          return true;
        });
        return reply.status(created ? 201 : 200).send({ sha256: expected, created });
      } finally {
        await rm(received.path, { force: true });
      }
    },
  );

  app.get<{ Params: { sha256: string } }>('/api/files/:sha256', async (request, reply) => {
    const auth = requireAuth(request);
    if (!SHA.test(request.params.sha256)) throw notFound('Fichier');
    const row = await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const file = (
        await c.query<{ storage_key: string; mime_type: string; byte_length: number }>(
          'SELECT storage_key, mime_type, byte_length FROM files WHERE organization_id = $2 AND sha256 = $1',
          [request.params.sha256, auth.orgId],
        )
      ).rows[0];
      const allowed = await allowedCampIds(c, auth);
      if (!file || !allowed) return file;
      // Accès restreint à certains camps : seulement les fichiers d'un plan ou d'une révision de
      // ces camps, ou d'un modèle de l'organisation.
      const reachable = await c.query(
        `SELECT 1 FROM file_refs f
           LEFT JOIN plans p ON f.owner_kind = 'plan' AND p.organization_id = f.organization_id AND p.id = f.owner_id
           LEFT JOIN revisions r ON f.owner_kind = 'revision' AND r.organization_id = f.organization_id AND r.id = f.owner_id
           LEFT JOIN plans rp ON rp.organization_id = r.organization_id AND rp.id = r.plan_id
          WHERE f.organization_id = $3 AND f.sha256 = $1
            AND (f.owner_kind = 'template' OR p.camp_id = ANY($2) OR rp.camp_id = ANY($2))
          LIMIT 1`,
        [request.params.sha256, [...allowed], auth.orgId],
      );
      return reachable.rowCount ? file : undefined;
    });
    // Fichier d'une autre organisation : même réponse qu'un fichier inexistant.
    if (!row) throw notFound('Fichier');
    const stream = await deps.storage.get(row.storage_key);
    if (!stream) throw new HttpError(500, 'storage-missing', 'Fichier absent du stockage.');
    return reply
      .header('Content-Type', row.mime_type)
      .header('Content-Length', String(row.byte_length))
      .header('Content-Disposition', 'attachment')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(stream);
  });
}
