/**
 * État de la session d'édition : bandeau « lecture seule » (plan ouvert ailleurs, avec « reprendre
 * la main ») et résolution d'un conflit d'enregistrement (jamais d'écrasement silencieux).
 */
import { AlertTriangle, Lock } from 'lucide-react';
import { useState } from 'react';
import { repository } from '@/app/repository.ts';
import { duplicatePlanDocument, nowIso } from '@/domain/model/factories.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';
import { useSessionStore } from './session/sessionStore.ts';
import { reloadOpenPlan } from './session/usePlanSession.ts';

export function LockBanner() {
  const mode = useSessionStore((s) => s.lockMode);
  const lock = useSessionStore((s) => s.lock);
  const [busy, setBusy] = useState(false);
  if (mode !== 'readonly') return null;
  return (
    <div
      role="status"
      data-testid="lock-banner"
      className="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 shadow"
    >
      <Lock size={16} aria-hidden />
      <span>{t('session.readOnly')}</span>
      <Button
        disabled={busy}
        data-testid="lock-takeover"
        onClick={() => {
          setBusy(true);
          void lock
            ?.takeOver()
            .catch((e: unknown) => logEvent('lock', e))
            .finally(() => setBusy(false));
        }}
      >
        {t('session.takeOver')}
      </Button>
    </div>
  );
}

export function ConflictDialog() {
  const conflict = useSessionStore((s) => s.conflict);
  const planId = useSessionStore((s) => s.planId);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const { busy, error, submit } = useSubmit();
  if (!conflict || !planId) return null;
  const notify = useEditorStore.getState().notify;

  const reload = () =>
    submit(async () => {
      await reloadOpenPlan(planId);
      logEvent('conflict', 'Conflit résolu : version enregistrée rechargée.', {
        level: 'info',
        context: `plan ${planId}`,
      });
      notify(t('session.reloaded'));
    });
  const saveCopy = () =>
    submit(async () => {
      const doc = planStore.getState().doc;
      if (!doc) return;
      const copy = duplicatePlanDocument(
        doc,
        t('session.copyName', { name: doc.plan.name, date: nowIso().slice(0, 16).replace('T', ' ') }),
      );
      await repository.savePlan(copy);
      await reloadOpenPlan(planId);
      logEvent('conflict', 'Conflit résolu : modifications enregistrées dans une copie.', {
        level: 'info',
        context: `plan ${planId}`,
      });
      notify(t('session.copySaved', { name: copy.plan.name }));
    });
  const overwrite = () =>
    submit(async () => {
      const doc = planStore.getState().doc;
      if (!doc) return;
      const stored = (await repository.getPlanVersion(planId)) ?? 0;
      const version = await repository.savePlan(doc, { expectedVersion: stored });
      const state = planStore.getState();
      state.markSaved(state.revision);
      useSessionStore.getState().setVersion(version);
      useSessionStore.getState().setConflict(null);
      useSessionStore.getState().lock?.announceSaved(version);
      logEvent('conflict', 'Conflit résolu : version enregistrée remplacée (choix explicite).', {
        level: 'warn',
        context: `plan ${planId}`,
      });
    });

  return (
    <Modal
      open
      wide
      title={t('session.conflictTitle')}
      onClose={() => undefined}
      footer={
        <>
          <Button disabled={busy} onClick={() => void reload()} data-testid="conflict-reload">
            {t('session.reload')}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void saveCopy()}
            data-testid="conflict-copy"
          >
            {t('session.saveCopy')}
          </Button>
          <Button
            variant="danger"
            disabled={busy || !confirmOverwrite}
            onClick={() => void overwrite()}
            data-testid="conflict-overwrite"
          >
            {t('session.overwrite')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="conflict-dialog">
        <p className="flex gap-2 text-amber-900">
          <AlertTriangle size={18} className="shrink-0" aria-hidden />
          {t('session.conflictBody')}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-slate-700">
          <li>{t('session.reloadHelp')}</li>
          <li>{t('session.saveCopyHelp')}</li>
          <li>{t('session.overwriteHelp')}</li>
        </ul>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={confirmOverwrite}
            onChange={(e) => setConfirmOverwrite(e.target.checked)}
            className="mt-1"
          />
          <span>{t('session.overwriteConfirm')}</span>
        </label>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Projet importé en mode récupération : rappel permanent qu'il est incomplet. */
export function RecoveredBanner() {
  const recovery = usePlanStore((s) => s.doc?.plan.metadata.recovery) as
    { at?: string; problems?: string[] } | undefined;
  const [open, setOpen] = useState(false);
  if (!recovery?.problems?.length) return null;
  return (
    <div
      role="status"
      data-testid="recovered-banner"
      className="absolute bottom-3 left-1/2 z-20 max-w-xl -translate-x-1/2 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-900 shadow"
    >
      <p className="flex items-center gap-2">
        <AlertTriangle size={16} aria-hidden />
        {t('session.recovered', { date: recovery.at?.slice(0, 10) ?? '', count: recovery.problems.length })}
        <button type="button" className="underline" onClick={() => setOpen((v) => !v)}>
          {t('session.recoveredDetails')}
        </button>
      </p>
      {open && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {recovery.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
