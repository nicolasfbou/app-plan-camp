/**
 * Configuration du serveur, uniquement par variables d'environnement (portable : serveur PAMM,
 * Azure, ailleurs). Aucune valeur secrète par défaut.
 */
import { z } from 'zod';

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : ['1', 'true', 'yes'].includes(v.toLowerCase());

const schema = z.object({
  /** Connexion du rôle applicatif (sans droits de propriétaire : la RLS s'applique). */
  databaseUrl: z.string().min(1),
  /** Connexion du propriétaire du schéma (migrations). Par défaut : `databaseUrl`. */
  migrationDatabaseUrl: z.string().min(1),
  host: z.string(),
  port: z.number().int().positive(),
  /** Origine publique (liens d'invitation). */
  publicOrigin: z.string(),
  cookieSecure: z.boolean(),
  trustProxy: z.boolean(),
  sessionTtlDays: z.number().positive(),
  sharedSessionTtlHours: z.number().positive(),
  maxUploadBytes: z.number().int().positive(),
  maxSvgBytes: z.number().int().positive(),
  maxPlanBytes: z.number().int().positive(),
  staticDir: z.string().nullable(),
  storage: z.discriminatedUnion('driver', [
    z.object({ driver: z.literal('fs'), root: z.string().min(1) }),
    z.object({
      driver: z.literal('s3'),
      bucket: z.string().min(1),
      region: z.string().min(1),
      endpoint: z.string().optional(),
      forcePathStyle: z.boolean(),
      prefix: z.string(),
    }),
  ]),
});

export type ServerConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL ?? '';
  const driver = env.STORAGE_DRIVER ?? 'fs';
  return schema.parse({
    databaseUrl,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? databaseUrl,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8787),
    publicOrigin: env.PUBLIC_ORIGIN ?? `http://localhost:${env.PORT ?? 8787}`,
    cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
    trustProxy: bool(env.TRUST_PROXY, false),
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    sharedSessionTtlHours: Number(env.SHARED_SESSION_TTL_HOURS ?? 12),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024),
    maxSvgBytes: Number(env.MAX_SVG_BYTES ?? 2 * 1024 * 1024),
    maxPlanBytes: Number(env.MAX_PLAN_BYTES ?? 25 * 1024 * 1024),
    staticDir: env.STATIC_DIR ?? null,
    storage:
      driver === 's3'
        ? {
            driver: 's3',
            bucket: env.S3_BUCKET ?? '',
            region: env.S3_REGION ?? 'us-east-1',
            endpoint: env.S3_ENDPOINT,
            forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, false),
            prefix: env.S3_PREFIX ?? '',
          }
        : { driver: 'fs', root: env.STORAGE_FS_ROOT ?? './server-data/files' },
  });
}
