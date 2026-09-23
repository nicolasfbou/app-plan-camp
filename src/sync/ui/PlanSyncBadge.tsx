/** État de synchronisation d'un plan (liste des plans, espace d'organisation). */
import { t } from '@/i18n/index.ts';
import { planState, useSyncStore } from '../syncStore.ts';

const STYLE = {
  synced: 'bg-emerald-50 text-emerald-800',
  'local-changes': 'bg-amber-50 text-amber-900',
  conflict: 'bg-red-50 text-red-800',
  error: 'bg-red-50 text-red-800',
  'local-only': 'bg-slate-100 text-slate-700',
  'server-update': 'bg-sky-50 text-sky-800',
} as const;

export function PlanSyncBadge({ planId }: { planId: string }) {
  const store = useSyncStore();
  if (!store.enabled) return null;
  const state = planState(store, planId);
  return (
    <span
      data-testid="plan-sync-badge"
      data-state={state}
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STYLE[state]}`}
    >
      {t(`sync.plan.${state}`)}
    </span>
  );
}
