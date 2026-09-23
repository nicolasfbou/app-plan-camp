/**
 * Messages de synchronisation entre onglets (BroadcastChannel) ET dans l'onglet lui-même (le canal
 * ne renvoie pas ses propres messages) : mise à jour serveur disponible, état du moteur, relance.
 */
import { namespace } from '@/app/profile.ts';
import type { SyncMessage } from './engine.ts';

type Listener = (message: SyncMessage) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function ensureChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(`campplanner-sync-${namespace()}`);
  channel.onmessage = (event: MessageEvent<SyncMessage>) => listeners.forEach((l) => l(event.data));
}

export function postSync(message: SyncMessage) {
  ensureChannel();
  channel?.postMessage(message);
  listeners.forEach((l) => l(message));
}

export function onSync(listener: Listener): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Demande un cycle de synchronisation (après une écriture locale). */
export const kickSync = () => postSync({ type: 'kick' });
