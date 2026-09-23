/**
 * Espaces de travail sur cet appareil :
 * - « Local (sans compte) » : le fonctionnement des phases 1 à 8, inchangé (base `campplanner`) ;
 * - un espace par compte d'organisation (ex. PAMM — N. Tremblay), avec SA propre base IndexedDB :
 *   les données de deux organisations ne se mélangent jamais sur un poste.
 *
 * Mode d'appareil (choisi explicitement à la première connexion, jamais supposé) :
 * - `trusted` (personnel / de confiance) : données conservées, travail hors ligne complet ;
 * - `shared` (partagé) : aucun accès aux projets sans authentification valide dans cette session
 *   du navigateur ; données purgées à la déconnexion.
 *
 * L'espace actif est choisi au chargement de la page (changer d'espace recharge l'application).
 */

export type DeviceMode = 'trusted' | 'shared';

export interface Profile {
  id: string;
  kind: 'local' | 'org';
  /** Base IndexedDB de l'espace. */
  dbName: string;
  orgId?: string;
  orgName?: string;
  orgSlug?: string;
  userId?: string;
  userName?: string;
  email?: string;
  role?: 'admin' | 'manager' | 'editor' | 'reader';
  deviceMode?: DeviceMode;
  createdAt?: string;
}

export const LOCAL_PROFILE: Profile = { id: 'local', kind: 'local', dbName: 'campplanner' };

const PROFILES_KEY = 'campplanner.profiles';
const ACTIVE_KEY = 'campplanner.activeProfile';
const UNLOCK_KEY = (id: string) => `campplanner.unlocked.${id}`;

export const profileIdOf = (orgId: string, userId: string) => `org-${orgId}-${userId}`;

function safeGet(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function readProfiles(): Profile[] {
  try {
    const list = JSON.parse(safeGet(globalThis.localStorage, PROFILES_KEY) ?? '[]') as Profile[];
    return Array.isArray(list) ? list.filter((p) => p && p.kind === 'org' && p.id && p.dbName) : [];
  } catch {
    return [];
  }
}

export function saveProfile(profile: Profile) {
  const list = readProfiles().filter((p) => p.id !== profile.id);
  localStorage.setItem(PROFILES_KEY, JSON.stringify([...list, profile]));
}

export function removeProfile(id: string) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(readProfiles().filter((p) => p.id !== id)));
  if (safeGet(globalThis.localStorage, ACTIVE_KEY) === id) localStorage.removeItem(ACTIVE_KEY);
  try {
    sessionStorage.removeItem(UNLOCK_KEY(id));
  } catch {
    // ignoré
  }
}

export function resolveActiveProfile(): Profile {
  const id = safeGet(globalThis.localStorage, ACTIVE_KEY);
  return (id && readProfiles().find((p) => p.id === id)) || LOCAL_PROFILE;
}

/** Change d'espace (l'application est rechargée par l'appelant). */
export function setActiveProfile(id: string) {
  if (id === 'local') localStorage.removeItem(ACTIVE_KEY);
  else localStorage.setItem(ACTIVE_KEY, id);
}

/** Appareil partagé : l'espace n'est accessible qu'après une authentification dans CETTE session du navigateur. */
export function isUnlocked(profile: Profile): boolean {
  if (profile.kind === 'local' || profile.deviceMode !== 'shared') return true;
  return safeGet(globalThis.sessionStorage, UNLOCK_KEY(profile.id)) === '1';
}

export function markUnlocked(profile: Profile) {
  try {
    sessionStorage.setItem(UNLOCK_KEY(profile.id), '1');
  } catch {
    // ignoré
  }
}

export function lockProfile(profile: Profile) {
  try {
    sessionStorage.removeItem(UNLOCK_KEY(profile.id));
  } catch {
    // ignoré
  }
}

/** Espace actif de cette page (fixé au chargement). */
export const ACTIVE_PROFILE: Profile = resolveActiveProfile();

/**
 * Préfixe des clés locales (journaux de récupération, verrous d'onglet) de l'espace actif :
 * vide pour l'espace local (compatibilité avec les données existantes), sinon `<base>.`.
 * Un même identifiant de plan peut exister dans deux espaces (projet publié) sans collision.
 */
export const namespace = (profile: Profile = ACTIVE_PROFILE) =>
  profile.kind === 'local' ? '' : `${profile.dbName}.`;
