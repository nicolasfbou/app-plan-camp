/**
 * Journal local des erreurs (localStorage, borné) : imports, exports, stockage, récupération,
 * fichiers corrompus, migrations, sauvegardes, verrous. Jamais de contenu de plan ni de photo :
 * seulement la catégorie, le message et un contexte court. Exportable dans le rapport de
 * diagnostic ; peut être vidé par l'utilisateur.
 */

export const ERROR_CATEGORIES = [
  'import',
  'export',
  'storage',
  'recovery',
  'corrupt',
  'migration',
  'backup',
  'lock',
  'conflict',
  'repair',
  'app',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface ErrorEntry {
  at: string;
  category: ErrorCategory;
  /** « error » : échec ; « info » : événement notable (récupération appliquée, réparation…). */
  level: 'error' | 'warn' | 'info';
  message: string;
  /** Contexte court (identifiant de plan, nom de fichier) ; jamais de données du plan. */
  context?: string;
}

import { activeSpaceRemoved } from '@/app/profile';

const KEY = 'campplanner.errorLog';
export const MAX_ENTRIES = 200;
const MAX_MESSAGE = 500;

const listeners = new Set<() => void>();

function read(): ErrorEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? (list as ErrorEntry[]).filter((e) => e && typeof e.message === 'string')
      : [];
  } catch {
    return [];
  }
}

function write(list: ErrorEntry[]) {
  // Onglet d'un espace effacé (poste partagé, pas encore rechargé) : il n'écrit plus rien, sinon
  // il recréerait une trace personnelle que la déconnexion vient d'effacer.
  if (activeSpaceRemoved()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Stockage plein : on garde la moitié la plus récente plutôt que rien.
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(-Math.floor(MAX_ENTRIES / 2))));
    } catch {
      // Journal indisponible : l'application continue (les erreurs restent affichées à l'écran).
    }
  }
  listeners.forEach((l) => l());
}

export function logEvent(
  category: ErrorCategory,
  error: unknown,
  options: { level?: ErrorEntry['level']; context?: string; now?: Date } = {},
): void {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
    0,
    MAX_MESSAGE,
  );
  const entry: ErrorEntry = {
    at: (options.now ?? new Date()).toISOString(),
    category,
    level: options.level ?? 'error',
    message,
    ...(options.context ? { context: options.context.slice(0, 120) } : {}),
  };
  write([...read(), entry].slice(-MAX_ENTRIES));
}

export const readErrorLog = (): ErrorEntry[] => read();

export function clearErrorLog(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignoré
  }
  listeners.forEach((l) => l());
}

export function subscribeErrorLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Erreurs non interceptées de l'application (sans pile ni données). */
export function installGlobalErrorLogging(target: Window = window): void {
  target.addEventListener('error', (e) => logEvent('app', e.error ?? e.message));
  target.addEventListener('unhandledrejection', (e) => logEvent('app', e.reason));
}
