/**
 * Suppression d'un plan (ou d'un camp) qui emporte ses révisions figées : le nombre de révisions
 * est affiché ; s'il y a des révisions APPROUVÉES, une deuxième confirmation est exigée (saisir le
 * nom). Sans révision, simple confirmation comme avant.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { REVISION_STATUS_LABELS } from '@/domain/revisions/revision.ts';
import { t } from '@/i18n/index.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';

interface Counts {
  total: number;
  approved: string[];
}

export function ProtectedDeleteDialog({
  title,
  children,
  planIds,
  confirmName,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  /** Plans supprimés (dont les révisions sont comptées). */
  planIds: () => Promise<string[]>;
  /** Nom à saisir pour la deuxième confirmation (révisions approuvées). */
  confirmName: string;
  onConfirm(): Promise<void>;
  onCancel(): void;
}) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState('');
  const { busy, error, submit } = useSubmit();
  useEffect(() => {
    let cancelled = false;
    planIds()
      .then((ids) => Promise.all(ids.map((id) => repository.listRevisions(id))))
      .then((lists) => {
        if (cancelled) return;
        const entries = lists.flat();
        setCounts({
          total: entries.length,
          approved: entries.flatMap((e) =>
            e.meta?.approval ? [`${e.meta.label} (${REVISION_STATUS_LABELS[e.meta.status]})`] : [],
          ),
        });
      })
      // Révisions illisibles : on exige la deuxième confirmation plutôt que de les ignorer.
      .catch(() => !cancelled && setCounts({ total: 0, approved: [t('rev.unreadable')] }));
    return () => {
      cancelled = true;
    };
    // Chargé une fois, à l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsSecond = (counts?.approved.length ?? 0) > 0;
  const confirm = () => {
    if (needsSecond && step === 1) setStep(2);
    else void submit(onConfirm);
  };
  const disabled = !counts || busy || (step === 2 && typed.trim() !== confirmName.trim());

  return (
    <Modal
      open
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} autoFocus>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={disabled}
            onClick={confirm}
            data-testid="confirm-protected-delete"
          >
            {needsSecond && step === 1 ? t('rev.deleteContinue') : t('common.delete')}
          </Button>
        </>
      }
    >
      <div className="space-y-2" data-testid="protected-delete">
        {step === 1 && children}
        {counts && counts.total > 0 && (
          <p className="text-red-800" data-testid="delete-revision-count">
            {t('rev.planDeleteRevisions', { count: counts.total })}
          </p>
        )}
        {step === 2 && (
          <>
            <p className="font-medium text-red-800">
              {t('rev.planDeleteApproved', { list: counts!.approved.join(', ') })}
            </p>
            <label className="block">
              <span className="mb-0.5 block text-xs text-slate-700">
                {t('rev.planDeleteType', { name: confirmName })}
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5"
                data-testid="protected-delete-name"
              />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
