import { describe, expect, it } from 'vitest';
import { acquirePlanLock, type LockDeps, type LockMode, TakeoverRefusedError } from './planLock.ts';

/** Gestionnaire de verrous simulé (sémantique Web Locks : file, ifAvailable, signal, steal). */
class FakeLocks {
  private held = new Map<string, { reject(e: unknown): void }>();
  private queue = new Map<string, (() => void)[]>();
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) {
    return new Promise((resolve, reject) => {
      const grant = () => {
        let settled = false;
        const holder = {
          reject: (e: unknown) => {
            settled = true;
            reject(e);
          },
        };
        this.held.set(name, holder);
        void Promise.resolve(callback({ name, mode: 'exclusive' } as Lock)).then((value) => {
          if (this.held.get(name) === holder) {
            this.held.delete(name);
            this.queue.get(name)?.shift()?.();
          }
          if (!settled) resolve(value);
        });
      };
      if (options.steal) {
        this.held.get(name)?.reject(new DOMException('stolen', 'AbortError'));
        this.held.delete(name);
        return grant();
      }
      if (!this.held.has(name)) return grant();
      if (options.ifAvailable) return void Promise.resolve(callback(null)).then(resolve);
      const waiter = () => grant();
      this.queue.set(name, [...(this.queue.get(name) ?? []), waiter]);
      options.signal?.addEventListener('abort', () => {
        this.queue.set(
          name,
          (this.queue.get(name) ?? []).filter((w) => w !== waiter),
        );
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  }
}

/** Canal de diffusion simulé : livraison asynchrone aux AUTRES canaux du même nom. */
function bus() {
  const channels = new Set<{ deliver(data: unknown): void }>();
  return (enabled = true) =>
    (): BroadcastChannel | null => {
      if (!enabled) return null;
      const listeners = new Set<(e: MessageEvent) => void>();
      const self = {
        deliver: (data: unknown) => listeners.forEach((l) => l({ data } as MessageEvent)),
        postMessage: (data: unknown) =>
          setTimeout(() => channels.forEach((c) => c !== self && c.deliver(data)), 0),
        addEventListener: (_: string, l: (e: MessageEvent) => void) => listeners.add(l),
        close: () => channels.delete(self),
      };
      channels.add(self);
      return self as unknown as BroadcastChannel;
    };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await tick(5);
  expect(fn()).toBe(true);
};

function tabs(options: { silentFirst?: boolean } = {}) {
  const locks = new FakeLocks() as unknown as LockManager;
  const channel = bus();
  const deps = (id: string, enabled = true): LockDeps => ({
    locks,
    createChannel: channel(enabled),
    tabId: id,
  });
  const a = acquirePlanLock('p1', deps('A', !options.silentFirst));
  const b = acquirePlanLock('p1', deps('B'));
  return { a, b };
}

describe('verrou d’édition entre onglets', () => {
  it('premier onglet éditeur, second en lecture seule ; reprise de la main après écriture', async () => {
    const { a, b } = tabs();
    await until(() => a.mode === 'editor' && b.mode === 'readonly');
    let flushed = false;
    a.onBeforeRelease(async () => {
      flushed = true;
      return true;
    });
    await b.takeOver(200);
    await until(() => b.mode === 'editor');
    expect(flushed).toBe(true);
    expect(a.mode).toBe('readonly');
    a.release();
    b.release();
  });

  it('modifications non enregistrées dans l’éditeur : il REFUSE de céder (aucun vol)', async () => {
    const { a, b } = tabs();
    await until(() => a.mode === 'editor' && b.mode === 'readonly');
    a.onBeforeRelease(async () => false);
    await expect(b.takeOver(200)).rejects.toBeInstanceOf(TakeoverRefusedError);
    await tick(50);
    expect(a.mode).toBe('editor');
    expect(b.mode).toBe('readonly');
    a.release();
    b.release();
  });

  it('éditeur qui écrit lentement : on attend (« releasing ») au lieu de voler', async () => {
    const { a, b } = tabs();
    await until(() => a.mode === 'editor');
    a.onBeforeRelease(async () => {
      await tick(150); // plus long que le délai sans réponse (50 ms)
      return true;
    });
    await b.takeOver(50, 2000);
    await until(() => b.mode === 'editor');
    expect(a.mode).toBe('readonly');
    a.release();
    b.release();
  });

  it('éditeur muet (onglet figé) : verrou retiré après le délai', async () => {
    const { a, b } = tabs({ silentFirst: true });
    const modes: LockMode[] = [];
    a.subscribe((m) => modes.push(m));
    await until(() => a.mode === 'editor' && b.mode === 'readonly');
    await b.takeOver(50);
    await until(() => b.mode === 'editor' && a.mode === 'readonly');
    await tick(50);
    expect(b.mode).toBe('editor'); // pas de retour intempestif en lecture seule
    expect(modes).toContain('readonly');
    a.release();
    b.release();
  });

  it('fermeture pendant une prise de main : la promesse se termine (bouton jamais bloqué)', async () => {
    const { a, b } = tabs({ silentFirst: true });
    await until(() => a.mode === 'editor' && b.mode === 'readonly');
    const pending = b.takeOver(10_000);
    await tick(20);
    b.release();
    await expect(pending).resolves.toBeUndefined();
    a.release();
  });
});
