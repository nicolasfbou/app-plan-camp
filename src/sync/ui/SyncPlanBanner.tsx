/**
 * Dans l'éditeur (espace d'organisation) : version serveur plus récente disponible (jamais
 * appliquée sous l'éditeur sans demande), ou conflit à décider pour ce plan. Après application
 * d'une version serveur ou d'une résolution, le plan ouvert est relu — seulement s'il n'a pas de
 * modification non enregistrée.
 */
import { CloudDownload, GitMerge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { saveNow } from '@/app/saveNow.ts';
import { reloadOpenPlan } from '@/editor/session/usePlanSession.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import { t } from '@/i18n/index.ts';
import { planStore, selectIsDirty } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { onSync, postSync } from '../bus.ts';
import { useSyncStore } from '../syncStore.ts';
import { SyncConflictDialog } from './SyncConflictDialog.tsx';

export function SyncPlanBanner({ planId }: { planId: string }) {
  const enabled = useSyncStore((s) => s.enabled);
  const update = useSyncStore((s) => s.serverUpdates.has(planId));
  const conflict = useSyncStore((s) => s.conflicts.find((c) => c.planId === planId) ?? null);
  const [showConflict, setShowConflict] = useState(false);

  useEffect(
    () =>
      onSync((m) => {
        if (m.type !== 'pull-applied' || m.planId !== planId) return;
        if (selectIsDirty(planStore.getState())) return; // jamais par-dessus une modification en cours
        void reloadOpenPlan(planId).catch((error: unknown) =>
          logEvent('storage', error, { context: `plan ${planId}` }),
        );
      }),
    [planId],
  );

  if (!enabled || (!update && !conflict)) return null;
  return (
    <>
      <div
        role="status"
        data-testid="sync-plan-banner"
        className={`absolute top-12 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-md border px-3 py-1.5 text-sm shadow ${conflict ? 'border-red-300 bg-red-50 text-red-900' : 'border-sky-300 bg-sky-50 text-sky-900'}`}
      >
        {conflict ? <GitMerge size={16} aria-hidden /> : <CloudDownload size={16} aria-hidden />}
        <span>
          {conflict ? t('sync.conflictTitle', { plan: conflict.planName }) : t('sync.serverUpdate')}
        </span>
        {conflict ? (
          <Button onClick={() => setShowConflict(true)} data-testid="open-sync-conflict">
            {t('sync.openConflict')}
          </Button>
        ) : (
          <Button
            data-testid="apply-server-update"
            onClick={() =>
              void saveNow()
                .catch(() => undefined)
                .then(() => postSync({ type: 'apply-pull', planId }))
            }
          >
            {t('sync.applyUpdate')}
          </Button>
        )}
      </div>
      {conflict && showConflict && (
        <SyncConflictDialog
          conflict={conflict}
          onClose={() => setShowConflict(false)}
          onResolved={() => setShowConflict(false)}
        />
      )}
    </>
  );
}
