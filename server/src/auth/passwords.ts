/**
 * Mots de passe : argon2id (recommandation OWASP : m = 19 Mio, t = 2, p = 1), sel aléatoire
 * intégré au hachage. Aucun mot de passe n'est jamais stocké ni journalisé en clair.
 */
import { hash, verify } from '@node-rs/argon2';

const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const MIN_PASSWORD_LENGTH = 12;

export function checkPasswordPolicy(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `Mot de passe trop court (${MIN_PASSWORD_LENGTH} caractères au minimum).`;
  if (password.length > 256) return 'Mot de passe trop long.';
  return null;
}

export const hashPassword = (password: string) => hash(password, OPTIONS);

export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  if (!stored) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Hachage factice : même coût de calcul quand le compte n'existe pas (pas d'énumération par le temps). */
let dummy: Promise<string> | null = null;
export async function burnPasswordCheck(password: string) {
  dummy ??= hashPassword('campplanner-dummy-password');
  await verifyPassword(await dummy, password);
}
