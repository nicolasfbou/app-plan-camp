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
import { postSync } from '@/sync/bus.ts';
import { stopSync } from '@/sync/runtime.ts';

let closingHere = false;
/** Cet onglet est-il celui qui purge l'espace (il ne doit pas se recharger en plein milieu) ? */
export const isClosingHere = () => closingHere;

/**
 * Bases purgées : effacées de nouveau au démarrage si un onglet encore ouvert les avait
 * recréées entre-temps (écriture tardive). Seules les bases d'espaces PURGÉS y figurent : une
 * base d'un poste de confiance n'est jamais effacée par ce balayage.
 */
const PURGED_KEY = 'campplanner.purgedDatabases';
const readPurged = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(PURGED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const writePurged = (names: string[]) => {
  try {
    if (names.length) localStorage.setItem(PURGED_KEY, JSON.stringify([...new Set(names)]));
    else localStorage.removeItem(PURGED_KEY);
  } catch {
    // stockage indisponible : le balayage sera simplement omis
  }
};

export async function sweepPurgedDatabases(): Promise<void> {
  const active = new Set(readProfiles().map((p) => p.dbName));
  const purged = readPurged();
  // Liste CONSERVÉE : un onglet tardif peut recréer la base après un premier balayage. Une entrée
  // n'est retirée que si l'espace est recréé par une nouvelle connexion sur cet appareil.
  writePurged(purged.filter((name) => !active.has(name)));
  const existing = new Set(
    ((await indexedDB.databases?.().catch(() => undefined)) ?? purged.map((name) => ({ name }))).map(
      (d) => d.name,
    ),
  );
  for (const name of purged) {
    if (active.has(name)) continue;
    if (existing.has(name)) await new IndexedDbRepository(name).destroy().catch(() => undefined);
    // Journaux de récupération éventuellement réécrits par un onglet tardif : effacés aussi.
    clearNamespaceJournals(`${name}.`);
  }
}

/**
 * Déconnexion forcée hors ligne (poste partagé, « effacer quand même ») : la session serveur n'a
 * pas pu être fermée. Elle l'est dès que le réseau revient (le cookie est encore envoyé), sauf si
 * une nouvelle connexion a eu lieu entre-temps.
 */
const PENDING_LOGOUT_KEY = 'campplanner.pendingLogout';

export async function retryPendingLogout(): Promise<void> {
  try {
    if (localStorage.getItem(PENDING_LOGOUT_KEY) !== '1') return;
  } catch {
    return;
  }
  try {
    await api.request('POST', '/api/auth/logout');
  } catch (error) {
    // Hors ligne : nouvel essai au retour du réseau. Session déjà invalide (401) : c'est fait.
    if (error instanceof ApiError && error.network) return;
  }
  try {
    localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch {
    // ignoré
  }
}

/** Session serveur non révocable (réseau) : la déconnexion d'un poste partagé est suspendue. */
export class ServerUnreachableError extends Error {
  constructor() {
    super(
      'Serveur injoignable : la session ne peut pas être fermée sur le serveur. Sur un appareil partagé, reconnectez le réseau puis réessayez, sinon la session resterait utilisable depuis ce navigateur jusqu’à son expiration.',
    );
    this.name = 'ServerUnreachableError';
  }
}

export interface LoginInput {
  email: string;
  password: string;
  organization?: string;
  deviceMode: DeviceMode;
}

/** Connexion : crée (ou met à jour) l'espace de cette organisation et le rend actif. */
export async function login(input: LoginInput): Promise<Profile> {
  const me = await api.request<MeResponse>('POST', '/api/auth/login', { body: input });
  // Nouvelle session : une ancienne déconnexion en attente ne doit pas la fermer.
  try {
    localStorage.removeItem('campplanner.pendingLogout');
  } catch {
    // ignoré
  }
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
    ...(me.accessEpoch !== undefined ? { accessEpoch: me.accessEpoch } : {}),
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
    // Rôle et période d'accès à jour (changés par un administrateur) ; relus : un autre onglet
    // peut avoir mis l'espace à jour entre-temps.
    const fresh = readProfiles().find((p) => p.id === profile.id) ?? profile;
    if (me.role !== fresh.role || (me.accessEpoch !== undefined && me.accessEpoch !== fresh.accessEpoch))
      saveProfile({
        ...fresh,
        role: me.role,
        ...(me.accessEpoch !== undefined ? { accessEpoch: me.accessEpoch } : {}),
      });
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
  // 1. L'espace disparaît de la liste (un onglet qui se recharge ouvrira l'espace local).
  removeProfile(profile.id);
  if (ACTIVE_PROFILE.id === profile.id) setActiveProfile('local');
  writePurged([...readPurged(), profile.dbName]);
  // 2. Synchronisation de cet onglet arrêtée ; les autres onglets de cet espace ferment la base
  //    pour de bon et se rechargent (aucune écriture tardive ne la recrée).
  if (namespace(ACTIVE_PROFILE) === namespace(profile)) {
    closingHere = true;
    stopSync();
    postSync({ type: 'space-closed' });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  // 3. Base détruite ; journaux de récupération de l'espace effacés.
  const repo = new IndexedDbRepository(profile.dbName);
  await repo.destroy();
  clearNamespaceJournals(namespace(profile));
  await sweepPurgedDatabases();
}

/**
 * Déconnexion : session révoquée côté serveur. Appareil partagé : données locales purgées — et
 * refus si le serveur est injoignable (sauf choix explicite `force`), car la session resterait
 * valable. Appareil de confiance : données conservées (travail hors ligne), synchro en pause.
 */
export async function logout(profile: Profile = ACTIVE_PROFILE, { force = false } = {}): Promise<void> {
  try {
    await api.request('POST', '/api/auth/logout');
  } catch (error) {
    const unreachable = error instanceof ApiError && error.network;
    if (unreachable && profile.deviceMode === 'shared' && !force) throw new ServerUnreachableError();
    if (unreachable && profile.deviceMode === 'shared')
      try {
        localStorage.setItem(PENDING_LOGOUT_KEY, '1');
      } catch {
        // ignoré
      }
  }
  if (profile.deviceMode === 'shared') await purgeProfile(profile);
}
