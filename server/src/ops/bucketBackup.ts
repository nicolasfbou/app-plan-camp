/**
 * Sauvegardes complètes déposées dans un compartiment S3 DISTINCT de celui des fichiers (Railway
 * Buckets, ou tout service compatible S3) : l'hébergeur ne fournit pas toujours de sauvegarde
 * (Railway : aucune sur le forfait Hobby), et le disque d'un conteneur est temporaire.
 *
 * Chaque sauvegarde (voir ops/backup.ts : base + tous les fichiers, vérifiée) est déposée sous
 * `<préfixe><horodatage>/`, le manifeste EN DERNIER : une sauvegarde sans manifeste est incomplète
 * (envoi interrompu) et n'est jamais proposée à la restauration. Chaque objet déposé est relu
 * (taille). Rétention : les N plus récentes complètes sont gardées.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStorage } from '../storage/storage.ts';
import { backup, restore, verifyBackup, type BackupManifest, type RestoreReport } from './backup.ts';

export interface BackupBucket {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

/** Configuration lue dans l'environnement (`BACKUP_S3_*`). */
export function backupBucketFromEnv(env: Record<string, string | undefined>): BackupBucket {
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} manquant (compartiment des sauvegardes).`);
    return v;
  };
  return {
    bucket: need('BACKUP_S3_BUCKET'),
    region: env.BACKUP_S3_REGION ?? 'us-east-1',
    endpoint: env.BACKUP_S3_ENDPOINT,
    forcePathStyle: ['1', 'true', 'yes'].includes((env.BACKUP_S3_FORCE_PATH_STYLE ?? '').toLowerCase()),
    accessKeyId: need('BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: need('BACKUP_S3_SECRET_ACCESS_KEY'),
    prefix: env.BACKUP_S3_PREFIX ?? 'campplanner/',
  };
}

const client = (b: BackupBucket) =>
  new S3Client({
    region: b.region,
    ...(b.endpoint ? { endpoint: b.endpoint } : {}),
    forcePathStyle: b.forcePathStyle,
    credentials: { accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey },
    // Même réglage que le pilote des fichiers (voir storage/s3Storage.ts).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

async function listKeys(s3: S3Client, b: BackupBucket, prefix: string) {
  const keys: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: b.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of r.Contents ?? []) keys.push({ key: o.Key!, size: Number(o.Size ?? 0) });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Sauvegardes du compartiment : complètes (avec manifeste) ou non, de la plus ancienne à la plus récente. */
export async function listBucketBackups(b: BackupBucket) {
  const s3 = client(b);
  const byStamp = new Map<string, { complete: boolean; bytes: number; objects: number }>();
  for (const { key, size } of await listKeys(s3, b, b.prefix)) {
    const [stamp, ...rest] = key.slice(b.prefix.length).split('/');
    if (!stamp || !rest.length) continue;
    const e = byStamp.get(stamp) ?? { complete: false, bytes: 0, objects: 0 };
    e.bytes += size;
    e.objects += 1;
    if (rest.join('/') === 'manifest.json') e.complete = true;
    byStamp.set(stamp, e);
  }
  return [...byStamp.entries()]
    .sort(([a], [b2]) => a.localeCompare(b2))
    .map(([stamp, e]) => ({ stamp, ...e }));
}

async function deleteStamp(s3: S3Client, b: BackupBucket, stamp: string) {
  const keys = await listKeys(s3, b, `${b.prefix}${stamp}/`);
  for (let i = 0; i < keys.length; i += 1000)
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: b.bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((k) => ({ Key: k.key })) },
      }),
    );
}

export async function backupToBucket(options: {
  databaseUrl: string;
  storage: ObjectStorage;
  bucket: BackupBucket;
  keep: number;
  pgBin?: string;
  now?: Date;
}): Promise<{ stamp: string; manifest: BackupManifest; removed: string[] }> {
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const work = await mkdtemp(join(tmpdir(), 'campplanner-sauvegarde-'));
  const dir = join(work, stamp);
  const s3 = client(options.bucket);
  try {
    const manifest = await backup({
      databaseUrl: options.databaseUrl,
      storage: options.storage,
      outDir: dir,
      pgBin: options.pgBin,
    });
    await verifyBackup(dir);
    // Manifeste en dernier : sa présence signifie « sauvegarde complète ».
    const files = (await listFiles(dir)).sort((a, b) =>
      a.endsWith('manifest.json') ? 1 : b.endsWith('manifest.json') ? -1 : a.localeCompare(b),
    );
    for (const path of files) {
      const key = `${options.bucket.prefix}${stamp}/${relative(dir, path).split(sep).join('/')}`;
      const size = (await stat(path)).size;
      await s3.send(
        new PutObjectCommand({
          Bucket: options.bucket.bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: size,
        }),
      );
      const head = await s3.send(new HeadObjectCommand({ Bucket: options.bucket.bucket, Key: key }));
      if (Number(head.ContentLength) !== size)
        throw new Error(`Objet déposé altéré : ${key} (${head.ContentLength} octets au lieu de ${size}).`);
    }
    // Rétention : les plus récentes complètes ; les incomplètes plus anciennes que celle-ci.
    const all = await listBucketBackups(options.bucket);
    const complete = all.filter((e) => e.complete).map((e) => e.stamp);
    const kept = new Set(complete.slice(-Math.max(1, options.keep)));
    const removed = all
      .filter((e) => (e.complete ? !kept.has(e.stamp) : e.stamp < stamp))
      .map((e) => e.stamp);
    for (const old of removed) await deleteStamp(s3, options.bucket, old);
    return { stamp, manifest, removed };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Télécharge une sauvegarde complète (la plus récente par défaut) puis la restaure (base VIDE). */
export async function restoreFromBucket(options: {
  bucket: BackupBucket;
  stamp?: string;
  databaseUrl: string;
  storage: ObjectStorage;
  pgBin?: string;
}): Promise<RestoreReport & { stamp: string }> {
  const complete = (await listBucketBackups(options.bucket)).filter((e) => e.complete);
  const stamp = options.stamp ?? complete.at(-1)?.stamp;
  if (!stamp || !complete.some((e) => e.stamp === stamp))
    throw new Error(`Sauvegarde complète introuvable dans le compartiment : ${options.stamp ?? '(aucune)'}.`);
  const s3 = client(options.bucket);
  const work = await mkdtemp(join(tmpdir(), 'campplanner-restauration-'));
  try {
    const base = `${options.bucket.prefix}${stamp}/`;
    for (const { key } of await listKeys(s3, options.bucket, base)) {
      const target = join(work, ...key.slice(base.length).split('/'));
      if (!target.startsWith(work + sep)) throw new Error(`Clé refusée : ${key}`);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const r = await s3.send(new GetObjectCommand({ Bucket: options.bucket.bucket, Key: key }));
      await pipeline(r.Body as Readable, createWriteStream(target, { mode: 0o600 }));
    }
    const report = await restore({
      fromDir: work,
      databaseUrl: options.databaseUrl,
      storage: options.storage,
      pgBin: options.pgBin,
    });
    return { ...report, stamp };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
