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
  type: 'takeover-request' | 'releasing' | 'refused' | 'released' | 'saved';
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
   * Prend la main : demande à l'autre onglet de céder (après avoir écrit). S'il répond qu'il
   * écrit (« releasing »), on attend jusqu'à `writeTimeoutMs` ; s'il refuse (modifications qu'il
   * n'a pas pu enregistrer), lève `TakeoverRefusedError` ; s'il ne répond pas du tout dans
   * `timeoutMs` (onglet figé, abandonné), le verrou lui est retiré.
   */
  takeOver(timeoutMs?: number, writeTimeoutMs?: number): Promise<void>;
  /** Annonce un enregistrement (les onglets en lecture seule relisent le plan). */
  announceSaved(version: number): void;
  /**
   * Appelé dans l'onglet éditeur avant de céder : écrire les modifications en attente. Retourne
   * `false` (ou échoue) si des modifications restent non enregistrées : l'onglet garde la main.
   */
  onBeforeRelease(handler: () => Promise<boolean>): void;
  onRemoteSaved(handler: (version: number) => void): void;
  release(): void;
}

export class TakeoverRefusedError extends Error {
  constructor(message = 'L’autre onglet a des modifications non enregistrées : il garde la main.') {
    super(message);
    this.name = 'TakeoverRefusedError';
  }
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
  let beforeRelease: () => Promise<boolean> = async () => true;
  const pending = new Set<() => void>(); // prises de main en cours (résolues à la fermeture)
  const replies = new Set<(m: LockMessage) => void>();
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
    let granted = false;
    deps.locks
      .request(lockName(planId), { signal: controller.signal }, async () => {
        if (disposed) return;
        granted = true;
        setMode('editor');
        await hold();
      })
      .catch(() => {
        // Annulé avant d'être obtenu (fermeture, « reprendre la main » par vol) : rien à faire —
        // surtout ne pas repasser en lecture seule un onglet qui vient de prendre la main.
        // Obtenu puis retiré par un autre onglet : lecture seule et retour dans la file.
        if (!disposed && granted) {
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
      // Écrit d'abord ; cède seulement si tout est enregistré, sinon garde la main.
      post({ type: 'releasing' });
      void beforeRelease()
        .catch(() => false)
        .then((clean) => {
          if (disposed || mode !== 'editor') return;
          if (!clean) return void post({ type: 'refused' });
          setMode('readonly');
          releaseHeld?.();
          post({ type: 'released' });
          // Reprend sa place dans la file (reprendra la main si l'autre onglet ferme).
          setTimeout(waitInQueue, 50);
        });
    }
    replies.forEach((r) => r(m));
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
    async takeOver(timeoutMs = 3000, writeTimeoutMs = 30_000) {
      if (!deps.locks || mode === 'editor' || disposed) return;
      post({ type: 'takeover-request' });
      const answer = await new Promise<'granted' | 'refused' | 'silent'>((resolve) => {
        let timer = setTimeout(() => done('silent'), timeoutMs);
        const off = this.subscribe((m) => m === 'editor' && done('granted'));
        const reply = (m: LockMessage) => {
          if (m.type === 'refused') done('refused');
          // L'éditeur écrit ses modifications : on lui laisse le temps (pas de vol en pleine écriture).
          if (m.type === 'releasing') {
            clearTimeout(timer);
            timer = setTimeout(() => done('silent'), writeTimeoutMs);
          }
        };
        const cancel = () => done('granted');
        function done(result: 'granted' | 'refused' | 'silent') {
          clearTimeout(timer);
          off();
          replies.delete(reply);
          pending.delete(cancel);
          resolve(result);
        }
        replies.add(reply);
        pending.add(cancel);
      });
      if (disposed || answer === 'granted') return;
      if (answer === 'refused') throw new TakeoverRefusedError();
      // Onglet éditeur sans réponse (figé, abandonné) : verrou retiré.
      controller?.abort();
      controller = null;
      await new Promise<void>((resolve) => {
        pending.add(resolve);
        void deps
          .locks!.request(lockName(planId), { steal: true }, async () => {
            pending.delete(resolve);
            if (disposed) return resolve();
            setMode('editor');
            resolve();
            await hold();
          })
          .catch(() => {
            pending.delete(resolve);
            resolve();
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
      replies.clear();
      // Une prise de main en attente ne reste jamais bloquée.
      pending.forEach((resolve) => resolve());
      pending.clear();
    },
  };
}

/** Plans ouverts en édition dans un onglet de ce navigateur (verrous détenus). */
export async function openPlanIds(): Promise<Set<string>> {
  const held = (await navigator.locks?.query?.())?.held ?? [];
  const prefix = 'campplanner-plan-';
  return new Set(held.flatMap((l) => (l.name?.startsWith(prefix) ? [l.name.slice(prefix.length)] : [])));
}
