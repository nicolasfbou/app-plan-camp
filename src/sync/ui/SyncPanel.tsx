/**
 * Détail de la synchronisation : état, dernière synchro réussie, conflits à décider, file des
 * opérations (avec essais et erreurs), nouvel essai / abandon EXPLICITES, versions mises de côté.
 */
import { useEffect, useState } from 'react';
import { ACTIVE_PROFILE } from '@/app/profile.ts';
import { navigate } from '@/app/router.ts';
import { formatDateTime, t } from '@/i18n/index.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { postSync } from '../bus.ts';
import { overallState, useSyncStore } from '../syncStore.ts';
import type { ConflictArchiveRecord, SyncConflictRecord } from '../types.ts';
import { actionEngine, afterAction } from './actions.ts';
import { SyncConflictDialog } from './SyncConflictDialog.tsx';

export function SyncPanel({ onClose }: { onClose(): void }) {
  const store = useSyncStore();
  const state = overallState(store);
  const [conflict, setConflict] = useState<SyncConflictRecord | null>(null);
  const [archive, setArchive] = useState<ConflictArchiveRecord[]>([]);

  useEffect(() => {
    const repo = new IndexedDbRepository(ACTIVE_PROFILE.dbName);
    void repo.sync.conflictArchive
      .toArray()
      .then(setArchive)
      .finally(() => repo.close());
  }, [store.conflicts.length]);

  const blockedKeys = new Set<string>();
  const waitingFor = (keys: string[]) => keys.some((k) => blockedKeys.has(k));

  return (
    <Modal
      open
      wide
      title={t('sync.title')}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-4 text-sm" data-testid="sync-panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            <strong>{t(`sync.state.${state}`, { count: store.operations.length })}</strong>
            {' · '}
            {store.engine?.lastSyncAt
              ? t('sync.lastSync', { date: formatDateTime(store.engine.lastSyncAt) })
              : t('sync.never')}
          </p>
          <div className="flex gap-2">
            {store.engine?.authRequired && (
              <Button onClick={() => (window.location.hash = '#/connexion')}>{t('sync.reconnect')}</Button>
            )}
            <Button
              variant="primary"
              onClick={() => postSync({ type: 'kick', force: true })}
              data-testid="sync-now"
            >
              {t('sync.now')}
            </Button>
          </div>
        </div>
        {store.engine?.lastError && <p className="text-slate-600">{store.engine.lastError}</p>}

        {store.conflicts.length > 0 && (
          <section>
            <h3 className="mb-1 font-semibold text-red-800">{t('sync.conflicts')}</h3>
            <ul className="space-y-1" data-testid="sync-conflicts">
              {store.conflicts.map((c) => (
                <li
                  key={c.planId}
                  className="flex items-center justify-between rounded border border-red-200 bg-red-50 px-2 py-1"
                >
                  <span>{c.planName}</span>
                  <Button onClick={() => setConflict(c)} data-testid="open-conflict">
                    {t('sync.openConflict')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="mb-1 font-semibold">{t('sync.queue')}</h3>
          {store.operations.length === 0 ? (
            <p className="text-slate-600" data-testid="sync-queue-empty">
              {t('sync.queueEmpty')}
            </p>
          ) : (
            <ul className="space-y-1" data-testid="sync-queue">
              {store.operations.map((op) => {
                const waiting = waitingFor(op.keys);
                if (op.status !== 'done') blockedKeys.add(op.keys[0]!);
                return (
                  <li
                    key={op.operationId}
                    data-kind={op.kind}
                    data-status={op.status}
                    className="flex flex-wrap items-start justify-between gap-2 rounded border border-slate-200 px-2 py-1"
                  >
                    <div>
                      <div>
                        <span className="font-mono text-xs text-slate-500">{op.kind}</span> — {op.label}
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatDateTime(op.createdAt)} · {t('sync.attempts', { count: op.retryCount })}
                        {waiting && op.status === 'pending' ? ` · ${t('sync.waiting')}` : ''}
                      </div>
                      {op.lastError && <div className="text-xs text-red-700">{op.lastError}</div>}
                    </div>
                    {op.status === 'failed' && (
                      <div className="flex gap-1">
                        <Button onClick={() => void actionEngine().retry(op.seq!).then(afterAction)}>
                          {t('sync.retry')}
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => {
                            if (window.confirm(t('sync.abandonConfirm')))
                              void actionEngine().abandon(op.seq!).then(afterAction);
                          }}
                        >
                          {t('sync.abandon')}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {archive.length > 0 && (
          <section>
            <h3 className="mb-1 font-semibold">{t('sync.archive')}</h3>
            <ul className="space-y-1 text-xs">
              {archive.map((a) => (
                <li key={a.id}>
                  {a.planName} — {formatDateTime(a.archivedAt)} — {a.reason}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {conflict && (
        <SyncConflictDialog
          conflict={conflict}
          onClose={() => setConflict(null)}
          onResolved={(planId, siteId) => {
            setConflict(null);
            onClose();
            if (siteId) navigate({ name: 'plan', siteId, planId });
          }}
        />
      )}
    </Modal>
  );
}
