/**
 * Conflit de synchronisation : rien n'est écrasé tant que l'utilisateur n'a pas choisi.
 * Affiche ma version (appareil) et la version serveur (auteur, date, numéro), les changements de
 * chaque côté depuis la base commune (moteur de comparaison de la phase 7), puis 4 choix :
 * garder la version serveur · enregistrer ma version comme nouveau brouillon · créer une copie ·
 * décider plus tard.
 */
import { useEffect, useMemo, useState } from 'react';
import { ACTIVE_PROFILE } from '@/app/profile.ts';
import { saveNow } from '@/app/saveNow.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { diffPlans, summarizeDiff } from '@/domain/revisions/diff.ts';
import { parsePlanDocument } from '@/domain/schema/serialization.ts';
import { formatDateTime, t } from '@/i18n/index.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { Modal } from '@/ui/Modal.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';
import { conflictCopyName } from '../engine.ts';
import type { SyncConflictRecord } from '../types.ts';
import { actionEngine, afterAction } from './actions.ts';

const safeParse = (value: unknown): PlanDocument | null => {
  try {
    return value ? parsePlanDocument(value) : null;
  } catch {
    return null;
  }
};

export function SyncConflictDialog({
  conflict,
  onClose,
  onResolved,
}: {
  conflict: SyncConflictRecord;
  onClose(): void;
  onResolved(planId: string, siteId: string | null): void;
}) {
  const [local, setLocal] = useState<PlanDocument | null>(null);
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    const repo = new IndexedDbRepository(ACTIVE_PROFILE.dbName);
    void repo
      .openPlan(conflict.planId)
      .then((o) => setLocal(o?.doc ?? null))
      .finally(() => repo.close());
  }, [conflict.planId]);

  const server = useMemo(() => safeParse(conflict.serverDoc), [conflict.serverDoc]);
  const base = useMemo(() => safeParse(conflict.baseDoc), [conflict.baseDoc]);
  const changes = useMemo(() => {
    if (!local) return null;
    if (base && server) {
      const mine = diffPlans(base, local);
      const theirs = diffPlans(base, server);
      const theirIds = new Set(theirs.objects.map((o) => o.id));
      const both = mine.objects.filter((o) => theirIds.has(o.id)).map((o) => o.name);
      return { mine: summarizeDiff(mine), theirs: summarizeDiff(theirs), both, direct: null };
    }
    if (server) return { mine: [], theirs: [], both: [], direct: summarizeDiff(diffPlans(server, local)) };
    return { mine: base ? summarizeDiff(diffPlans(base, local)) : [], theirs: [], both: [], direct: null };
  }, [local, server, base]);

  const deleted = conflict.reason === 'deleted';
  const act = (action: () => Promise<unknown>, siteId: string | null) =>
    submit(async () => {
      // Modifications de l'éditeur encore en mémoire : écrites d'abord (elles font partie de « ma version »).
      await saveNow().catch(() => undefined);
      await action();
      await afterAction();
      onResolved(conflict.planId, siteId);
    });

  const list = (lines: string[]) =>
    lines.length ? (
      <ul className="list-disc space-y-0.5 pl-5 text-xs">
        {lines.slice(0, 12).map((l, i) => (
          <li key={i}>{l}</li>
        ))}
        {lines.length > 12 && <li>… (+{lines.length - 12})</li>}
      </ul>
    ) : (
      <p className="text-xs text-slate-500">—</p>
    );

  return (
    <Modal open wide title={t('sync.conflictTitle', { plan: conflict.planName })} onClose={onClose}>
      <div className="space-y-4 text-sm" data-testid="sync-conflict-dialog" data-reason={conflict.reason}>
        <p className="rounded-md bg-amber-50 p-2 text-amber-900">
          {deleted ? t('sync.conflictDeleted') : t('sync.conflictIntro')}
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <section className="rounded border border-slate-200 p-2" data-testid="conflict-mine">
            <h3 className="font-semibold">{t('sync.mine')}</h3>
            <p className="text-xs text-slate-500">
              {t('sync.localMeta', { date: formatDateTime(conflict.localUpdatedAt) })}
            </p>
            <h4 className="mt-2 text-xs font-semibold">{t('sync.myChanges')}</h4>
            {changes && list(changes.direct ?? changes.mine)}
          </section>
          <section className="rounded border border-slate-200 p-2" data-testid="conflict-theirs">
            <h3 className="font-semibold">{t('sync.theirs')}</h3>
            {!deleted && (
              <p className="text-xs text-slate-500">
                {t('sync.versionMeta', {
                  version: conflict.serverVersion,
                  author: conflict.serverUpdatedBy,
                  date: conflict.serverUpdatedAt ? formatDateTime(conflict.serverUpdatedAt) : '—',
                })}
              </p>
            )}
            <h4 className="mt-2 text-xs font-semibold">{t('sync.theirChanges')}</h4>
            {changes && list(changes.theirs)}
          </section>
        </div>
        {changes?.direct && <p className="text-xs text-slate-500">{t('sync.noBase')}</p>}
        {changes && changes.both.length > 0 && (
          <div className="rounded border border-red-200 bg-red-50 p-2" data-testid="conflict-both">
            <h4 className="text-xs font-semibold text-red-800">{t('sync.bothChanged')}</h4>
            {list(changes.both)}
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          <Choice
            testId="conflict-keep-server"
            label={t('sync.keepServer')}
            help={t('sync.keepServerHelp')}
            disabled={busy}
            onClick={() =>
              void act(
                () => actionEngine().keepServer(conflict.planId),
                deleted ? null : (local?.plan.siteId ?? null),
              )
            }
          />
          {!deleted && (
            <Choice
              testId="conflict-keep-mine"
              label={t('sync.keepMine')}
              help={t('sync.keepMineHelp')}
              disabled={busy}
              onClick={() =>
                void act(() => actionEngine().keepMine(conflict.planId), local?.plan.siteId ?? null)
              }
            />
          )}
          <Choice
            testId="conflict-copy-sync"
            label={t('sync.copy')}
            help={t('sync.copyHelp')}
            disabled={busy || !local}
            onClick={() =>
              void act(
                () =>
                  actionEngine().keepBothAsCopy(
                    conflict.planId,
                    conflictCopyName(local?.plan.name ?? conflict.planName),
                  ),
                deleted ? null : (local?.plan.siteId ?? null),
              )
            }
          />
          <Choice
            testId="conflict-later"
            label={t('sync.later')}
            help={t('sync.laterHelp')}
            disabled={busy}
            onClick={onClose}
          />
        </div>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function Choice(props: { testId: string; label: string; help: string; disabled: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
      className="rounded-md border border-slate-300 p-2 text-left hover:border-accent hover:bg-sky-50 disabled:opacity-50"
    >
      <span className="block font-medium">{props.label}</span>
      <span className="block text-xs text-slate-600">{props.help}</span>
    </button>
  );
}
