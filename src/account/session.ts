/**
 * Comptes sur cet appareil : connexion (création de l'espace d'organisation), vérification de la
 * session, déconnexion (appareil partagé : purge), retrait d'un espace.
 */
import {
  ACTIVE_PROFILE,
  type DeviceMode,
  markUnlocked,
  namespace,
  type Profile,
  profileIdOf,
  readProfiles,
  removeProfile,
  saveProfile,
  setActiveProfile,
} from '@/app/profile.ts';
import { nowIso } from '@/domain/model/factories.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { clearNamespaceJournals } from '@/persistence/recovery.ts';
import { api, ApiError, type MeResponse } from '@/sync/api.ts';

export interface LoginInput {
  email: string;
  password: string;
  organization?: string;
  deviceMode: DeviceMode;
}

/** Connexion : crée (ou met à jour) l'espace de cette organisation et le rend actif. */
export async function login(input: LoginInput): Promise<Profile> {
  const me = await api.request<MeResponse>('POST', '/api/auth/login', { body: input });
  const id = profileIdOf(me.organization.id, me.user.id);
  const existing = readProfiles().find((p) => p.id === id);
  const profile: Profile = {
    id,
    kind: 'org',
    dbName: `campplanner-${me.organization.id}-${me.user.id}`,
    orgId: me.organization.id,
    orgName: me.organization.name,
    orgSlug: me.organization.slug,
    userId: me.user.id,
    userName: me.user.displayName,
    email: me.user.email,
    role: me.role,
    deviceMode: input.deviceMode,
    createdAt: existing?.createdAt ?? nowIso(),
  };
  saveProfile(profile);
  markUnlocked(profile);
  setActiveProfile(profile.id);
  return profile;
}

export type SessionCheck = 'valid' | 'expired' | 'offline';

/** La session serveur correspond-elle à l'espace actif ? */
export async function checkSession(profile: Profile = ACTIVE_PROFILE): Promise<SessionCheck> {
  if (profile.kind !== 'org') return 'valid';
  try {
    const me = await api.request<MeResponse>('GET', '/api/auth/me');
    if (me.user.id !== profile.userId || me.organization.id !== profile.orgId) return 'expired';
    // Rôle à jour (changé par un administrateur).
    if (me.role !== profile.role) saveProfile({ ...profile, role: me.role });
    markUnlocked(profile);
    return 'valid';
  } catch (error) {
    if (error instanceof ApiError && error.network) return 'offline';
    return 'expired';
  }
}

/** Changements non envoyés d'un espace (sans l'ouvrir comme espace actif). */
export async function pendingChanges(profile: Profile): Promise<number> {
  if (profile.kind !== 'org') return 0;
  const repo = new IndexedDbRepository(profile.dbName);
  try {
    return await repo.sync.outbox.count();
  } finally {
    repo.close();
  }
}

/** Supprime toutes les données locales d'un espace (base, journaux, file) et l'espace lui-même. */
export async function purgeProfile(profile: Profile): Promise<void> {
  if (profile.kind !== 'org') return;
  const repo = new IndexedDbRepository(profile.dbName);
  await repo.destroy();
  clearNamespaceJournals(namespace(profile));
  removeProfile(profile.id);
}

/**
 * Déconnexion : session révoquée côté serveur (si joignable). Appareil partagé : données locales
 * purgées. Appareil de confiance : données conservées (travail hors ligne), synchro en pause.
 */
export async function logout(profile: Profile = ACTIVE_PROFILE): Promise<void> {
  await api.request('POST', '/api/auth/logout').catch(() => undefined);
  if (profile.deviceMode === 'shared') {
    await purgeProfile(profile);
    setActiveProfile('local');
  }
}
