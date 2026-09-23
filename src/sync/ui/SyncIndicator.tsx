/**
 * Indicateur d'état de synchronisation, toujours visible dans un espace d'organisation :
 * En ligne · synchronisé / Hors ligne / Synchronisation… / Changements locaux (n) / Conflit /
 * Erreur de synchro / Connexion requise. Un clic ouvre le détail.
 */
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  GitMerge,
  KeyRound,
  Loader2,
  UploadCloud,
} from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n/index.ts';
import { overallState, type SyncState, useSyncStore } from '../syncStore.ts';
import { SyncPanel } from './SyncPanel.tsx';

const STYLE: Record<SyncState, string> = {
  synced: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  offline: 'border-slate-300 bg-slate-100 text-slate-700',
  syncing: 'border-sky-300 bg-sky-50 text-sky-800',
  'local-changes': 'border-amber-300 bg-amber-50 text-amber-900',
  conflict: 'border-red-300 bg-red-50 text-red-800',
  error: 'border-red-300 bg-red-50 text-red-800',
  auth: 'border-amber-300 bg-amber-50 text-amber-900',
};

const ICON: Record<SyncState, typeof CheckCircle2> = {
  synced: CheckCircle2,
  offline: CloudOff,
  syncing: Loader2,
  'local-changes': UploadCloud,
  conflict: GitMerge,
  error: AlertTriangle,
  auth: KeyRound,
};

export function SyncIndicator({ compact = false }: { compact?: boolean }) {
  const store = useSyncStore();
  const [open, setOpen] = useState(false);
  if (!store.enabled) return null;
  const state = overallState(store);
  const Icon = ICON[state];
  const label = t(`sync.state.${state}`, { count: store.operations.length });
  return (
    <>
      <button
        type="button"
        data-testid="sync-indicator"
        data-state={state}
        title={label}
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STYLE[state]}`}
      >
        <Icon size={14} className={state === 'syncing' ? 'animate-spin' : ''} aria-hidden />
        {compact ? <span className="sr-only">{label}</span> : label}
      </button>
      {open && <SyncPanel onClose={() => setOpen(false)} />}
    </>
  );
}
