/**
 * Sauvegarde et restauration COMPLÈTES du serveur : base PostgreSQL + tous les fichiers (photos,
 * PDF, pictogrammes, logos de modèles). Une sauvegarde de la base seule n'est jamais produite :
 * la base cite des fichiers par empreinte, ils sont copiés et vérifiés dans le même lot.
 *
 * Cohérence : la base est exportée (pg_dump) dans un INSTANTANÉ exporté ; la liste des fichiers
 * est lue dans le même instantané. Chaque fichier est relu depuis le stockage (disque ou S3) et
 * vérifié par SHA-256. Un manifeste (comptes, empreintes) permet de vérifier la sauvegarde avant
 * toute restauration, puis la restauration elle-même.
 *
 * Droits : rôle PROPRIÉTAIRE ou superutilisateur de la base, avec BYPASSRLS (la RLS forcée
 * cacherait sinon des lignes : pg_dump échoue plutôt que de produire une sauvegarde incomplète).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import type { ObjectStorage } from '../storage/storage.ts';

export const BACKUP_FORMAT = 'campplanner-backup';

/** Comptes vérifiés après restauration (mêmes requêtes des deux côtés). */
const COUNTS: Record<string, string> = {
  organizations: 'SELECT count(*) FROM organizations',
  users: 'SELECT count(*) FROM users',
  user_identities: 'SELECT count(*) FROM user_identities',
  memberships: 'SELECT count(*) FROM memberships',
  camps: 'SELECT count(*) FROM camps',
  plans: 'SELECT count(*) FROM plans',
  plan_versions: 'SELECT count(*) FROM plan_versions',
  revisions: 'SELECT count(*) FROM revisions',
  revisions_approved: "SELECT count(*) FROM revisions WHERE approved_at IS NOT NULL OR status = 'approved'",
  revision_snapshots: 'SELECT count(*) FROM revision_snapshots',
  templates: 'SELECT count(*) FROM templates',
  files: 'SELECT count(*) FROM files',
  file_refs: 'SELECT count(*) FROM file_refs',
  audit_events: 'SELECT count(*) FROM audit_events',
  change_log: 'SELECT count(*) FROM change_log',
};

/**
 * Empreintes de contenu vérifiées après restauration (détectent une altération, pas seulement un
 * compte). Dates en secondes depuis l'époque : indépendantes du fuseau du serveur cible.
 */
const DIGESTS: Record<string, string> = {
  revisions:
    "SELECT coalesce(string_agg(id || ':' || seal || ':' || chain_hash || ':' || coalesce(verification_type, '') || ':' || coalesce(extract(epoch FROM approved_at)::text, ''), ',' ORDER BY id), '') FROM revisions",
  plan_versions:
    "SELECT coalesce(string_agg(plan_id || ':' || version || ':' || document_sha256, ',' ORDER BY plan_id, version), '') FROM plan_versions",
  audit_events:
    "SELECT coalesce(string_agg(id || ':' || action || ':' || target_id || ':' || extract(epoch FROM at)::text, ',' ORDER BY id), '') FROM audit_events",
  users: "SELECT coalesce(string_agg(email || ':' || status, ',' ORDER BY email), '') FROM users",
  // Contenu intégral (et pas seulement l'empreinte annoncée) : réduit à un MD5 par table.
  plan_documents:
    "SELECT md5(coalesce(string_agg(plan_id || ':' || version || ':' || md5(document::text), ',' ORDER BY plan_id, version), '')) FROM plan_versions",
  revision_snapshots:
    "SELECT md5(coalesce(string_agg(revision_id || ':' || md5(json), ',' ORDER BY organization_id, revision_id), '')) FROM revision_snapshots",
  templates:
    "SELECT md5(coalesce(string_agg(id || ':' || server_version || ':' || md5(body::text) || ':' || coalesce(logo_sha256, ''), ',' ORDER BY organization_id, id), '')) FROM templates",
  memberships:
    "SELECT md5(coalesce(string_agg(organization_id || ':' || user_id || ':' || role || ':' || status || ':' || access_epoch, ',' ORDER BY organization_id, user_id), '')) FROM memberships",
  user_identities:
    "SELECT md5(coalesce(string_agg(user_id || ':' || provider || ':' || subject || ':' || md5(coalesce(secret_hash, '')), ',' ORDER BY user_id, provider, subject), '')) FROM user_identities",
};

export interface BackupFile {
  organizationId: string;
  sha256: string;
  storageKey: string;
  bytes: number;
  mimeType: string;
  /** Chemin relatif dans la sauvegarde. */
  path: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: 1;
  createdAt: string;
  migrations: string[];
  counts: Record<string, number>;
  digests: Record<string, string>;
  database: { path: string; sha256: string; bytes: number };
  files: BackupFile[];
}

const sha256File = async (path: string) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};

/**
 * Adresse de connexion pour pg_dump/pg_restore SANS mot de passe (visible dans la liste des
 * processus sinon) : le mot de passe passe par la variable PGPASSWORD du seul processus enfant.
 */
function pgTarget(databaseUrl: string): { dbname: string; env: NodeJS.ProcessEnv } {
  try {
    const url = new URL(databaseUrl);
    if (!url.password) return { dbname: databaseUrl, env: {} };
    const password = decodeURIComponent(url.password);
    url.password = '';
    return { dbname: url.toString(), env: { PGPASSWORD: password } };
  } catch {
    return { dbname: databaseUrl, env: {} };
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} a échoué (${code}) : ${stderr.trim()}`)),
    );
  });
}

async function measure(client: pg.ClientBase) {
  const counts: Record<string, number> = {};
  for (const [name, sql] of Object.entries(COUNTS))
    counts[name] = Number((await client.query(sql)).rows[0].count);
  const digests: Record<string, string> = {};
  for (const [name, sql] of Object.entries(DIGESTS))
    digests[name] = createHash('sha256')
      .update(String(Object.values((await client.query(sql)).rows[0])[0] ?? ''))
      .digest('hex');
  return { counts, digests };
}

export async function backup(options: {
  databaseUrl: string;
  storage: ObjectStorage;
  outDir: string;
  pgBin?: string;
}): Promise<BackupManifest> {
  const pgBin = options.pgBin ?? process.env.PG_BIN ?? '';
  const bin = (name: string) => (pgBin ? join(pgBin, name) : name);
  // Sauvegarde = données de TOUTES les organisations et empreintes de mots de passe : lisible
  // par le seul compte qui l'a produite.
  await mkdir(options.outDir, { recursive: true, mode: 0o700 });
  await chmod(options.outDir, 0o700);
  await mkdir(join(options.outDir, 'files'), { recursive: true, mode: 0o700 });
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    // Toutes les lignes, toutes organisations (la RLS ne doit rien cacher à la sauvegarde).
    await client.query('SET LOCAL row_security = off');
    const snapshot = (await client.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0]!.s;
    const dumpPath = join(options.outDir, 'database.dump');
    const conn = pgTarget(options.databaseUrl);
    await run(
      bin('pg_dump'),
      [
        '--format=custom',
        '--no-password',
        `--snapshot=${snapshot}`,
        `--file=${dumpPath}`,
        `--dbname=${conn.dbname}`,
      ],
      conn.env,
    );
    await chmod(dumpPath, 0o600);
    const migrations = (
      await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')
    ).rows.map((r) => r.name);
    const { counts, digests } = await measure(client);
    const rows = (
      await client.query<{
        organization_id: string;
        sha256: string;
        storage_key: string;
        byte_length: number;
        mime_type: string;
      }>(
        'SELECT organization_id, sha256, storage_key, byte_length, mime_type FROM files ORDER BY organization_id, sha256',
      )
    ).rows;
    await client.query('COMMIT');
    const files: BackupFile[] = [];
    for (const row of rows) {
      const rel = join('files', row.organization_id, row.sha256);
      const target = join(options.outDir, rel);
      await mkdir(join(options.outDir, 'files', row.organization_id), { recursive: true, mode: 0o700 });
      const stream = await options.storage.get(row.storage_key);
      if (!stream)
        throw new Error(`Fichier absent du stockage : ${row.storage_key} (sauvegarde incomplète refusée).`);
      const hash = createHash('sha256');
      stream.on('data', (chunk: Buffer) => hash.update(chunk));
      await pipeline(stream, createWriteStream(target, { mode: 0o600 }));
      const digest = hash.digest('hex');
      const size = (await stat(target)).size;
      if (digest !== row.sha256 || size !== Number(row.byte_length))
        throw new Error(
          `Fichier altéré dans le stockage : ${row.storage_key} (SHA-256 ou taille différente).`,
        );
      files.push({
        organizationId: row.organization_id,
        sha256: row.sha256,
        storageKey: row.storage_key,
        bytes: Number(row.byte_length),
        mimeType: row.mime_type,
        path: rel,
      });
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      migrations,
      counts,
      digests,
      database: {
        path: 'database.dump',
        sha256: await sha256File(dumpPath),
        bytes: (await stat(dumpPath)).size,
      },
      files,
    };
    await writeFile(join(options.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    return manifest;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Vérifie une sauvegarde SANS rien restaurer (base exportée et chaque fichier). */
export async function verifyBackup(dir: string): Promise<BackupManifest> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) throw new Error('Ce dossier n’est pas une sauvegarde CampPlanner.');
  if ((await sha256File(join(dir, manifest.database.path))) !== manifest.database.sha256)
    throw new Error('Export de la base altéré (SHA-256 différent).');
  for (const f of manifest.files)
    if ((await sha256File(join(dir, f.path))) !== f.sha256)
      throw new Error(`Fichier altéré dans la sauvegarde : ${f.path}.`);
  return manifest;
}

export interface RestoreReport {
  manifest: BackupManifest;
  counts: Record<string, number>;
  digests: Record<string, string>;
  files: number;
  mismatches: string[];
}

/**
 * Restauration dans une base VIDE (jamais par-dessus des données existantes) et un stockage de
 * fichiers (vide ou non : objets immuables, clé = empreinte). Le rôle applicatif
 * `campplanner_app` doit exister sur le serveur cible (droits restaurés depuis la sauvegarde).
 */
export async function restore(options: {
  fromDir: string;
  databaseUrl: string;
  storage: ObjectStorage;
  pgBin?: string;
}): Promise<RestoreReport> {
  const pgBin = options.pgBin ?? process.env.PG_BIN ?? '';
  const bin = (name: string) => (pgBin ? join(pgBin, name) : name);
  const manifest = await verifyBackup(options.fromDir);
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const tables = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    if (tables.rows[0].n > 0)
      throw new Error('La base cible n’est pas vide : restauration refusée (aucune donnée écrasée).');
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'campplanner_app'");
    if (!role.rowCount)
      throw new Error('Rôle campplanner_app absent du serveur cible : créez-le avant de restaurer.');
  } finally {
    await client.end();
  }
  const conn = pgTarget(options.databaseUrl);
  await run(
    bin('pg_restore'),
    [
      '--exit-on-error',
      '--no-owner',
      '--no-password',
      `--dbname=${conn.dbname}`,
      join(options.fromDir, manifest.database.path),
    ],
    conn.env,
  );
  // Nouvelle génération : les appareils sauront que l'historique du serveur a été remplacé.
  const gen = new pg.Client({ connectionString: options.databaseUrl });
  await gen.connect();
  try {
    // (Sauvegarde antérieure à la migration 004 : la table sera créée par la migration, avec une
    // génération neuve de toute façon.)
    if ((await gen.query("SELECT to_regclass('public.server_meta') AS t")).rows[0].t)
      await gen.query(
        `INSERT INTO server_meta (key, value) VALUES ('generation', gen_random_uuid()::text)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
    // Sessions de la sauvegarde fermées : un accès retiré APRÈS la sauvegarde ne doit pas
    // redevenir utilisable avec un ancien témoin. Chacun se reconnecte (avec ses droits restaurés).
    await gen.query('BEGIN');
    await gen.query('SET LOCAL row_security = off');
    await gen.query('UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL');
    await gen.query('COMMIT');
  } finally {
    await gen.end();
  }
  for (const f of manifest.files)
    if (!(await options.storage.exists(f.storageKey)))
      await options.storage.putFile(f.storageKey, join(options.fromDir, f.path), {
        contentType: f.mimeType,
        byteLength: f.bytes,
      });
  // Vérification : comptes, empreintes de contenu, et chaque fichier relu depuis le stockage cible.
  const check = new pg.Client({ connectionString: options.databaseUrl });
  await check.connect();
  let measured: Awaited<ReturnType<typeof measure>>;
  try {
    await check.query('BEGIN');
    await check.query('SET LOCAL row_security = off');
    measured = await measure(check);
    await check.query('COMMIT');
  } finally {
    await check.end();
  }
  const mismatches: string[] = [];
  for (const [k, v] of Object.entries(manifest.counts))
    if (measured.counts[k] !== v) mismatches.push(`${k} : ${measured.counts[k]} au lieu de ${v}`);
  for (const [k, v] of Object.entries(manifest.digests))
    if (measured.digests[k] !== v) mismatches.push(`${k} : contenu différent`);
  for (const f of manifest.files) {
    const stream = await options.storage.get(f.storageKey);
    if (!stream) {
      mismatches.push(`fichier absent après restauration : ${f.storageKey}`);
      continue;
    }
    const hash = createHash('sha256');
    for await (const chunk of stream) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== f.sha256)
      mismatches.push(`fichier altéré après restauration : ${f.storageKey}`);
  }
  return {
    manifest,
    counts: measured.counts,
    digests: measured.digests,
    files: manifest.files.length,
    mismatches,
  };
}
