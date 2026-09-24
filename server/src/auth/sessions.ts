/**
 * Sessions serveur : jeton opaque aléatoire (256 bits) en cookie `HttpOnly; SameSite=Strict`,
 * stocké HACHÉ (SHA-256) en base, révocable. Appareil de confiance : cookie persistant, session
 * longue. Appareil partagé : cookie de session (effacé à la fermeture du navigateur) et durée
 * courte.
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { ServerConfig } from '../config.ts';
import type { Auth, Role } from '../permissions.ts';

export const SESSION_COOKIE = 'cp_session';
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export async function createSession(
  pool: pg.Pool,
  config: ServerConfig,
  input: { userId: string; orgId: string; deviceMode: 'trusted' | 'shared' },
) {
  const token = newToken();
  const ttlMs =
    input.deviceMode === 'shared'
      ? config.sharedSessionTtlHours * 3600_000
      : config.sessionTtlDays * 86400_000;
  const expiresAt = new Date(Date.now() + ttlMs);
  // La session appartient à la période d'accès ACTUELLE du membre.
  await pool.query(
    `INSERT INTO sessions (id_hash, user_id, organization_id, device_mode, expires_at, access_epoch)
     SELECT $1, $2, $3, $4, $5, m.access_epoch FROM memberships m
      WHERE m.organization_id = $3 AND m.user_id = $2`,
    [sha256(token), input.userId, input.orgId, input.deviceMode, expiresAt],
  );
  return { token, expiresAt };
}

export function cookieOptions(config: ServerConfig, deviceMode: 'trusted' | 'shared', expiresAt: Date) {
  return {
    path: '/api',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.cookieSecure,
    // Appareil partagé : pas d'expiration persistante (cookie effacé à la fermeture).
    ...(deviceMode === 'trusted' ? { expires: expiresAt } : {}),
  };
}

/** Session valide → identité complète (compte actif, adhésion active à l'organisation). */
export async function resolveSession(pool: pg.Pool, token: string | undefined): Promise<Auth | null> {
  if (!token || token.length > 200) return null;
  const hash = sha256(token);
  const r = await pool.query<{
    user_id: string;
    organization_id: string;
    role: Role;
    email: string;
    display_name: string;
    device_mode: 'trusted' | 'shared';
    last_seen_at: Date;
    access_epoch: number;
  }>(
    `SELECT s.user_id, s.organization_id, m.role, u.email, u.display_name, s.device_mode, s.last_seen_at,
            m.access_epoch
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN memberships m ON m.organization_id = s.organization_id AND m.user_id = s.user_id
                          AND m.status = 'active' AND m.access_epoch = s.access_epoch
      WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hash],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000)
    await pool.query('UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1', [hash]);
  return {
    userId: row.user_id,
    orgId: row.organization_id,
    role: row.role,
    email: row.email,
    displayName: row.display_name,
    sessionHash: hash,
    deviceMode: row.device_mode,
    accessEpoch: row.access_epoch,
  };
}

export async function revokeSession(pool: pg.Pool, sessionHash: string) {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL', [
    sessionHash,
  ]);
}

/**
 * Limitation des tentatives de mot de passe (mémoire du processus), sur 15 minutes :
 * - par compte ET adresse (`pair:`) : 8 échecs — bloque l'essai répété depuis un poste sans
 *   empêcher le vrai titulaire de se connecter depuis ailleurs ;
 * - par compte, toutes adresses (`email:`) : 30 — plafonne l'essai distribué ;
 * - par adresse (`ip:`) : 50 — plusieurs personnes d'un même camp partagent souvent une adresse
 *   (derrière un proxy, `TRUST_PROXY=true` est indispensable pour voir la vraie adresse).
 * Les entrées expirées sont purgées : la mémoire ne grossit pas sans limite.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private calls = 0;
  constructor(
    private readonly maxPerPair = 8,
    private readonly maxPerAddress = 50,
    private readonly windowMs = 15 * 60_000,
    private readonly maxPerAccount = 30,
  ) {}
  /** Clés d'une tentative : adresse, compte, compte + adresse. */
  static keys(ip: string, email: string) {
    return [`ip:${ip}`, `email:${email}`, `pair:${email}|${ip}`];
  }
  private max(key: string) {
    if (key.startsWith('ip:')) return this.maxPerAddress;
    if (key.startsWith('email:')) return this.maxPerAccount;
    return this.maxPerPair;
  }
  private recent(key: string) {
    const now = Date.now();
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
  private sweep() {
    if (++this.calls % 1000) return;
    for (const key of [...this.failures.keys()]) this.recent(key);
  }
  blocked(...keys: string[]) {
    this.sweep();
    return keys.some((k) => this.recent(k).length >= this.max(k));
  }
  fail(...keys: string[]) {
    const now = Date.now();
    for (const k of keys) this.failures.set(k, [...this.recent(k), now]);
  }
  reset(...keys: string[]) {
    for (const k of keys) this.failures.delete(k);
  }
}
