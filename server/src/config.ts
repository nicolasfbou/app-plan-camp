/**
 * Configuration du serveur, uniquement par variables d'environnement (portable : serveur PAMM,
 * Azure, ailleurs). Aucune valeur secrète par défaut.
 */
import { readFileSync } from 'node:fs';
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
  /** Migrations au démarrage (pratique en développement) ; en production : étape séparée. */
  migrateOnStart: z.boolean(),
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

/** Variables secrètes lisibles depuis un fichier monté (`<NOM>_FILE`, secrets Docker / coffre). */
export const FILE_SECRETS = [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'BOOTSTRAP_PASSWORD',
] as const;

/**
 * Remplace `<NOM>_FILE` par le contenu du fichier (sans fin de ligne). Une valeur directe et un
 * fichier en même temps : refusé (ambiguïté).
 */
export function resolveFileSecrets(
  env: Record<string, string | undefined>,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Record<string, string | undefined> {
  const out = { ...env };
  for (const name of FILE_SECRETS) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    if (env[name]) throw new Error(`${name} et ${name}_FILE sont tous deux définis : n’en garder qu’un.`);
    out[name] = read(file).replace(/\r?\n$/, '');
  }
  return out;
}

/**
 * Pour les points d'entrée (serveur, sauvegarde, nettoyage) : les identifiants S3 montés en
 * fichiers sont placés dans l'environnement du processus, où le SDK AWS les lit.
 */
export function applyFileSecretsToEnv(target: NodeJS.ProcessEnv = process.env): void {
  const env = resolveFileSecrets(target);
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const)
    if (env[name] && !target[name]) target[name] = env[name];
}

export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): ServerConfig {
  const env = resolveFileSecrets(rawEnv);
  // Outils d'exploitation (migrations, sauvegarde) : l'URL du propriétaire suffit. Le serveur, lui,
  // refuse de démarrer avec un rôle qui contourne la RLS (assertRowSecurityApplies).
  const databaseUrl = env.DATABASE_URL ?? env.MIGRATION_DATABASE_URL ?? '';
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
    migrateOnStart: bool(env.MIGRATE_ON_START, true),
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
