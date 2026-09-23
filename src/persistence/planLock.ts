/**
 * Verrou local d'édition d'un plan (sans serveur) : un seul onglet ou une seule fenêtre du même
 * navigateur modifie un plan à la fois ; les autres l'ouvrent en LECTURE SEULE.
 *
 * - Web Locks API (`navigator.locks`) : le verrou est libéré automatiquement quand l'onglet est
 *   fermé ou plante ; un onglet en lecture seule attend dans la file et prend la main tout seul
 *   (après relecture du plan enregistré).
 * - BroadcastChannel : « reprendre la main » demande à l'onglet éditeur d'écrire ses modifications
 *   puis de céder le verrou ; s'il ne répond pas (onglet figé, abandonné), le verrou lui est retiré
 *   (`steal`). Les enregistrements sont annoncés pour que les lecteurs se mettent à jour.
 * - Navigateur sans Web Locks : édition permise, les conflits restent détectés à l'enregistrement
 *   (version du plan) — signalé dans le diagnostic.
 */

export type LockMode = 'pending' | 'editor' | 'readonly' | 'unsupported';

export interface LockMessage {
  type: 'takeover-request' | 'released' | 'saved';
  planId: string;
  from: string;
  version?: number;
}

export interface LockDeps {
  locks: LockManager | undefined;
  createChannel(name: string): BroadcastChannel | null;
  tabId: string;
}

export interface PlanLock {
  readonly mode: LockMode;
  subscribe(listener: (mode: LockMode) => void): () => void;
  /**
   * Prend la main : demande à l'autre onglet de céder (après avoir écrit), puis retire le verrou
   * s'il ne répond pas dans `timeoutMs`.
   */
  takeOver(timeoutMs?: number): Promise<void>;
  /** Annonce un enregistrement (les onglets en lecture seule relisent le plan). */
  announceSaved(version: number): void;
  /** Appelé dans l'onglet éditeur avant de céder : écrire les modifications en attente. */
  onBeforeRelease(handler: () => Promise<void>): void;
  onRemoteSaved(handler: (version: number) => void): void;
  release(): void;
}

const lockName = (planId: string) => `campplanner-plan-${planId}`;
const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());

export function defaultLockDeps(): LockDeps {
  return {
    locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
    createChannel: (name) => (typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : null),
    tabId: TAB_ID,
  };
}

export function acquirePlanLock(planId: string, deps: LockDeps = defaultLockDeps()): PlanLock {
  let mode: LockMode = deps.locks ? 'pending' : 'unsupported';
  let releaseHeld: (() => void) | null = null;
  let disposed = false;
  let controller: AbortController | null = null;
  const listeners = new Set<(mode: LockMode) => void>();
  let beforeRelease: () => Promise<void> = async () => undefined;
  let remoteSaved: (version: number) => void = () => undefined;
  const channel = deps.createChannel('campplanner-locks');

  const setMode = (next: LockMode) => {
    if (mode === next || disposed) return;
    mode = next;
    listeners.forEach((l) => l(next));
  };
  const post = (message: Omit<LockMessage, 'from' | 'planId'>) =>
    channel?.postMessage({ ...message, planId, from: deps.tabId } satisfies LockMessage);

  /** Tient le verrou jusqu'à `release` (ou jusqu'à ce qu'il soit retiré par un autre onglet). */
  const hold = () =>
    new Promise<void>((resolve) => {
      releaseHeld = () => {
        releaseHeld = null;
        resolve();
      };
    });

  /** File d'attente : obtenu dès que l'éditeur actuel ferme ou cède. */
  const waitInQueue = () => {
    if (!deps.locks || disposed) return;
    controller = new AbortController();
    deps.locks
      .request(lockName(planId), { signal: controller.signal }, async () => {
        if (disposed) return;
        setMode('editor');
        await hold();
      })
      .catch(() => {
        // Annulé (onglet fermé ou « reprendre la main » par vol) ou retiré par un autre onglet.
        if (!disposed && mode === 'editor') {
          setMode('readonly');
          waitInQueue();
        }
      });
  };

  if (deps.locks) {
    deps.locks
      .request(lockName(planId), { ifAvailable: true }, async (lock) => {
        if (disposed) return;
        if (!lock) {
          setMode('readonly');
          waitInQueue();
          return;
        }
        setMode('editor');
        await hold();
      })
      .catch(() => {
        // Verrou retiré par un autre onglet (« reprendre la main » forcé).
        if (!disposed) {
          setMode('readonly');
          waitInQueue();
        }
      });
  }

  channel?.addEventListener('message', (event: MessageEvent<LockMessage>) => {
    const m = event.data;
    if (!m || m.planId !== planId || m.from === deps.tabId || disposed) return;
    if (m.type === 'takeover-request' && mode === 'editor') {
      // Écrit d'abord, puis cède le verrou et passe en lecture seule.
      void beforeRelease()
        .catch(() => undefined)
        .finally(() => {
          setMode('readonly');
          releaseHeld?.();
          post({ type: 'released' });
          // Reprend sa place dans la file (reprendra la main si l'autre onglet ferme).
          setTimeout(waitInQueue, 50);
        });
    }
    if (m.type === 'saved' && mode !== 'editor' && m.version !== undefined) remoteSaved(m.version);
  });

  return {
    get mode() {
      return mode;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async takeOver(timeoutMs = 3000) {
      if (!deps.locks || mode === 'editor') return;
      post({ type: 'takeover-request' });
      const granted = new Promise<boolean>((resolve) => {
        const off = this.subscribe((m) => {
          if (m === 'editor') {
            off();
            resolve(true);
          }
        });
        setTimeout(() => {
          off();
          resolve(false);
        }, timeoutMs);
      });
      if (await granted) return;
      // Onglet éditeur sans réponse (figé, abandonné) : verrou retiré.
      controller?.abort();
      controller = null;
      await new Promise<void>((resolve) => {
        void deps
          .locks!.request(lockName(planId), { steal: true }, async () => {
            if (disposed) return;
            setMode('editor');
            resolve();
            await hold();
          })
          .catch(() => {
            if (!disposed) {
              setMode('readonly');
              waitInQueue();
            }
          });
      });
    },
    announceSaved(version) {
      post({ type: 'saved', version });
    },
    onBeforeRelease(handler) {
      beforeRelease = handler;
    },
    onRemoteSaved(handler) {
      remoteSaved = handler;
    },
    release() {
      disposed = true;
      controller?.abort();
      releaseHeld?.();
      channel?.close();
      listeners.clear();
    },
  };
}
