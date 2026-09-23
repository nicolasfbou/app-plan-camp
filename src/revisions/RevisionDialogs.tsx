/**
 * Boîtes de dialogue des révisions : création (le brouillon est figé), changement de statut
 * (approbation explicite), suppression protégée, brouillon à partir d'une révision.
 */
import { AlertTriangle, Lock } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useId, useMemo, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { navigate } from '@/app/router.ts';
import { saveNow } from '@/app/saveNow.ts';
import { backupAfterRevision } from '@/backups/backupService.ts';
import { newId, nowIso } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { diffPlans, summarizeDiff } from '@/domain/revisions/diff.ts';
import {
  allowedStatuses,
  draftFromRevision,
  isDeletable,
  nextRevisionLabel,
  type NewRevisionInput,
  REVISION_STATUS_LABELS,
  type RevisionMeta,
  type RevisionStatus,
} from '@/domain/revisions/revision.ts';
import { t } from '@/i18n/index.ts';
import { createRevisionFromDraft } from '@/persistence/revisions.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';
import { StatusChip } from './RevisionsPanel.tsx';
import { forgetRevision, loadRevisionCached, useRevisionMetas, useRevisionsStore } from './revisionsStore.ts';

// Consultation et comparaison : chargées à l'ouverture (moteur d'export, jsPDF).
const RevisionViewer = lazy(() =>
  import('./RevisionViewer.tsx').then((m) => ({ default: m.RevisionViewer })),
);
const CompareDialog = lazy(() => import('./CompareDialog.tsx').then((m) => ({ default: m.CompareDialog })));

const AUTHOR_KEY = 'campplanner.revisionAuthor';
function rememberedAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {
    return '';
  }
}
function rememberAuthor(name: string) {
  try {
    localStorage.setItem(AUTHOR_KEY, name);
  } catch {
    // Préférence de confort seulement.
  }
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-accent focus:outline-none';

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: (id: string) => ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-0.5 block text-xs font-medium text-slate-700">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Aiguillage des boîtes ouvertes depuis l'onglet Révisions. */
export function RevisionDialogsHost({ siteName }: { siteName: string }) {
  const dialog = useRevisionsStore((s) => s.dialog);
  const close = useRevisionsStore((s) => s.close);
  const metas = useRevisionMetas();
  if (!dialog) return null;
  const meta = 'id' in dialog ? metas.find((m) => m.id === dialog.id) : undefined;
  switch (dialog.kind) {
    case 'create':
      return <CreateRevisionDialog onClose={close} />;
    case 'status':
      return meta ? <StatusDialog meta={meta} onClose={close} /> : null;
    case 'delete':
      return meta ? <DeleteRevisionDialog meta={meta} onClose={close} /> : null;
    case 'restore':
      return meta ? <RestoreDialog meta={meta} onClose={close} /> : null;
    case 'view':
      return meta ? (
        <Suspense fallback={null}>
          <RevisionViewer meta={meta} siteName={siteName} onClose={close} />
        </Suspense>
      ) : null;
    case 'compare':
      return (
        <Suspense fallback={null}>
          <CompareDialog
            initialBefore={dialog.before}
            initialAfter={dialog.after}
            siteName={siteName}
            onClose={close}
          />
        </Suspense>
      );
  }
}

// --- Création ----------------------------------------------------------------------------------------

function CreateRevisionDialog({ onClose }: { onClose(): void }) {
  const doc = usePlanStore((s) => s.doc);
  const metas = useRevisionMetas();
  const refresh = useRevisionsStore((s) => s.refresh);
  const latest = metas.at(-1);
  const [input, setInput] = useState<NewRevisionInput>(() => ({
    label: nextRevisionLabel(
      metas.map((m) => m.label),
      doc?.plan.titleBlock.revision || 'A',
    ),
    description: '',
    author: rememberedAuthor() || doc?.plan.titleBlock.preparedBy || '',
    date: today(),
    reason: '',
    comments: '',
    status: 'review',
  }));
  const [changes, setChanges] = useState<string[] | null>(null);
  const { busy, error, submit } = useSubmit();
  const set = <K extends keyof NewRevisionInput>(key: K, value: NewRevisionInput[K]) =>
    setInput((s) => ({ ...s, [key]: value }));

  useEffect(() => {
    if (!latest || !doc) return;
    let cancelled = false;
    loadRevisionCached(latest.id).then(
      (r) => !cancelled && setChanges(summarizeDiff(diffPlans(r.doc, doc, { beforeRevisionId: r.meta.id }))),
      () => !cancelled && setChanges(null),
    );
    return () => {
      cancelled = true;
    };
  }, [latest, doc]);

  if (!doc) return null;
  const labelTaken = metas.some((m) => m.label.toUpperCase() === input.label.trim().toUpperCase());
  const canSubmit = input.label.trim() !== '' && input.author.trim() !== '' && !labelTaken && !busy;
  const image = doc.plan.baseImage;

  const run = () =>
    submit(async () => {
      await saveNow();
      const current = planStore.getState().doc!;
      const meta = await createRevisionFromDraft(repository, current, input);
      rememberAuthor(input.author.trim());
      // Le brouillon garde le lien vers la révision dont il repart (sans effet sur la révision figée).
      planStore.getState().update(t('rev.history.created', { label: meta.label }), (d) => {
        d.plan.draftBase = { revisionId: meta.id, label: meta.label, at: meta.createdAt };
      });
      await saveNow();
      await refresh();
      backupAfterRevision(meta.planId, meta.label, false);
      useEditorStore.getState().notify(t('rev.created', { label: meta.label }));
      onClose();
    });

  return (
    <Modal
      open
      wide
      title={t('rev.createTitle')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() => void run()}
            data-testid="confirm-create-revision"
          >
            <Lock size={16} /> {t('rev.freeze', { label: input.label.trim() || '…' })}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3" data-testid="create-revision-dialog">
        <Field
          label={t('rev.field.label')}
          hint={labelTaken ? t('rev.labelTaken') : t('rev.field.labelHint')}
        >
          {(id) => (
            <input
              id={id}
              value={input.label}
              maxLength={20}
              onChange={(e) => set('label', e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        <Field label={t('rev.field.date')}>
          {(id) => (
            <input
              id={id}
              type="date"
              value={input.date}
              onChange={(e) => set('date', e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        <div className="col-span-2">
          <Field label={t('rev.field.description')}>
            {(id) => (
              <input
                id={id}
                value={input.description}
                placeholder={t('rev.field.descriptionPlaceholder')}
                onChange={(e) => set('description', e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        </div>
        <Field label={t('rev.field.author')}>
          {(id) => (
            <input
              id={id}
              value={input.author}
              onChange={(e) => set('author', e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        <Field label={t('rev.field.status')} hint={t('rev.field.statusHint')}>
          {(id) => (
            <select
              id={id}
              value={input.status}
              onChange={(e) => set('status', e.target.value as NewRevisionInput['status'])}
              className={inputClass}
            >
              {(['draft', 'review', 'field-validation'] as const).map((s) => (
                <option key={s} value={s}>
                  {REVISION_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="col-span-2">
          <Field label={t('rev.field.reason')}>
            {(id) => (
              <input
                id={id}
                value={input.reason}
                onChange={(e) => set('reason', e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        </div>
        <div className="col-span-2">
          <Field label={t('rev.field.comments')}>
            {(id) => (
              <textarea
                id={id}
                rows={2}
                value={input.comments}
                onChange={(e) => set('comments', e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        </div>
      </div>
      <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs text-slate-700">
        <p className="font-medium">{t('rev.frozenContent')}</p>
        <p>
          {t('rev.frozenCounts', {
            objects: Object.keys(doc.objects).length,
            layers: doc.layers.length,
            views: doc.plan.views.length,
          })}
        </p>
        <p>
          {image
            ? t('rev.frozenPhoto', { name: image.fileName, sha: image.sha256.slice(0, 16) })
            : t('rev.frozenNoPhoto')}
        </p>
        {latest && (
          <div className="mt-2" data-testid="create-revision-changes">
            <p className="font-medium">{t('rev.sinceLatest', { label: latest.label })}</p>
            {changes === null ? (
              <p>{t('rev.draftChangesLoading')}</p>
            ) : changes.length ? (
              <ul className="list-disc pl-4">
                {changes.slice(0, 8).map((l) => (
                  <li key={l}>{l}</li>
                ))}
                {changes.length > 8 && <li>{t('rev.more', { count: changes.length - 8 })}</li>}
              </ul>
            ) : (
              <p>{t('rev.noChanges')}</p>
            )}
          </div>
        )}
        <p className="mt-2 text-slate-500">{t('rev.immutableNote')}</p>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-red-700">
          {error}
        </p>
      )}
    </Modal>
  );
}

// --- Statut et approbation ----------------------------------------------------------------------------

function StatusDialog({ meta, onClose }: { meta: RevisionMeta; onClose(): void }) {
  const refresh = useRevisionsStore((s) => s.refresh);
  const options = allowedStatuses(meta);
  const [to, setTo] = useState<RevisionStatus>(options[0] ?? meta.status);
  const [by, setBy] = useState(rememberedAuthor());
  const [comment, setComment] = useState('');
  const [date, setDate] = useState(today());
  const [confirmed, setConfirmed] = useState(false);
  const { busy, error, submit } = useSubmit();
  const approving = to === 'approved';
  const canSubmit = !busy && options.includes(to) && (!approving || (confirmed && by.trim() !== ''));

  const run = () =>
    submit(async () => {
      await repository.setRevisionStatus(meta.id, { to, by, comment, confirmed, approvalDate: date });
      forgetRevision(meta.id);
      await refresh();
      // Une révision approuvée est sauvegardée à part (conservée hors rotation).
      if (to === 'approved') backupAfterRevision(meta.planId, meta.label, true);
      useEditorStore
        .getState()
        .notify(t('rev.statusChanged', { label: meta.label, status: REVISION_STATUS_LABELS[to] }));
      onClose();
    });

  return (
    <Modal
      open
      title={t('rev.statusTitle', { label: meta.label })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() => void run()}
            data-testid="confirm-status"
          >
            {approving ? t('rev.approve') : t('rev.applyStatus')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="status-dialog">
        <p className="flex items-center gap-2">
          {t('rev.currentStatus')} <StatusChip status={meta.status} />
        </p>
        <Field label={t('rev.newStatus')}>
          {(id) => (
            <select
              id={id}
              value={to}
              onChange={(e) => setTo(e.target.value as RevisionStatus)}
              className={inputClass}
            >
              {options.map((s) => (
                <option key={s} value={s}>
                  {REVISION_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={approving ? t('rev.approver') : t('rev.changedBy')}>
          {(id) => (
            <input id={id} value={by} onChange={(e) => setBy(e.target.value)} className={inputClass} />
          )}
        </Field>
        {approving && (
          <Field label={t('rev.approvalDate')}>
            {(id) => (
              <input
                id={id}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        )}
        <Field label={t('rev.comment')}>
          {(id) => (
            <textarea
              id={id}
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        {approving && (
          <>
            <p className="flex gap-2 rounded-md bg-amber-50 p-2 text-amber-900">
              <AlertTriangle size={16} className="shrink-0" aria-hidden />
              {t('rev.approveWarning', { label: meta.label })}
            </p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t('rev.approveConfirm')}</span>
            </label>
          </>
        )}
        {to === 'archived' && meta.approval && <p className="text-slate-600">{t('rev.archiveApproved')}</p>}
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// --- Suppression -----------------------------------------------------------------------------------------

function DeleteRevisionDialog({ meta, onClose }: { meta: RevisionMeta; onClose(): void }) {
  const refresh = useRevisionsStore((s) => s.refresh);
  const [typed, setTyped] = useState('');
  const { busy, error, submit } = useSubmit();
  const deletable = isDeletable(meta);
  const matches = typed.trim().toUpperCase() === meta.label.toUpperCase();
  const run = () =>
    submit(async () => {
      await repository.deleteRevision(meta.id);
      forgetRevision(meta.id);
      await refresh();
      useEditorStore.getState().notify(t('rev.deleted', { label: meta.label }));
      onClose();
    });
  return (
    <Modal
      open
      title={t('rev.deleteTitle', { label: meta.label })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} autoFocus>
            {t('common.cancel')}
          </Button>
          {deletable && (
            <Button
              variant="danger"
              disabled={!matches || busy}
              onClick={() => void run()}
              data-testid="confirm-delete-revision"
            >
              {t('rev.deleteAction', { label: meta.label })}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3" data-testid="delete-revision-dialog">
        <p className="flex flex-wrap items-center gap-2">
          <strong>{t('rev.title', { label: meta.label, date: meta.date })}</strong>
          <StatusChip status={meta.status} />
        </p>
        {meta.description && <p>{meta.description}</p>}
        {deletable ? (
          <>
            <p className="text-red-800">{t('rev.deleteWarning')}</p>
            <Field label={t('rev.deleteType', { label: meta.label })}>
              {(id) => (
                <input
                  id={id}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className={inputClass}
                />
              )}
            </Field>
          </>
        ) : (
          <p className="text-slate-700">{t('rev.notDeletable')}</p>
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

// --- Brouillon à partir d'une révision ------------------------------------------------------------------

function RestoreDialog({ meta, onClose }: { meta: RevisionMeta; onClose(): void }) {
  const doc = usePlanStore((s) => s.doc);
  const [mode, setMode] = useState<'replace' | 'new-plan'>('replace');
  const [name, setName] = useState(() =>
    t('rev.restoreName', { name: doc?.plan.name ?? '', label: meta.label }),
  );
  const [snapshot, setSnapshot] = useState<PlanDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    let cancelled = false;
    loadRevisionCached(meta.id).then(
      (r) => {
        if (cancelled) return;
        setSnapshot(r.doc);
      },
      (e: unknown) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [meta.id]);

  // Changements du brouillon courant qui seraient remplacés.
  const lost = useMemo(
    () => (snapshot && doc ? diffPlans(snapshot, doc, { beforeRevisionId: meta.id }).counts.user : null),
    [snapshot, doc, meta.id],
  );

  if (!doc) return null;
  const run = () =>
    submit(async () => {
      if (!snapshot) return;
      const now = nowIso();
      if (mode === 'replace') {
        const current = planStore.getState().doc!;
        const next = draftFromRevision(current, snapshot, meta, now);
        planStore.getState().update(t('rev.history.restored', { label: meta.label }), (d) => {
          d.schemaVersion = next.schemaVersion;
          d.plan = next.plan;
          d.layers = next.layers;
          d.objects = next.objects;
          d.assets = next.assets;
          d.crossingReviews = next.crossingReviews;
          d.readabilityReviews = next.readabilityReviews;
        });
        useEditorStore.getState().select([]);
        await saveNow();
        useEditorStore.getState().notify(t('rev.restored', { label: meta.label }));
        onClose();
      } else {
        const target: PlanDocument = {
          ...doc,
          plan: {
            ...doc.plan,
            id: newId(),
            name: name.trim() || doc.plan.name,
            createdAt: now,
            variantOf: null,
          },
        };
        const copy = draftFromRevision(target, snapshot, meta, now);
        copy.plan.draftBase = null; // le nouveau plan n'a pas (encore) de révisions
        await repository.savePlan(copy);
        onClose();
        navigate({ name: 'plan', siteId: copy.plan.siteId, planId: copy.plan.id });
      }
    });

  return (
    <Modal
      open
      wide
      title={t('rev.restoreTitle', { label: meta.label })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!snapshot || busy}
            onClick={() => void run()}
            data-testid="confirm-restore"
          >
            {mode === 'replace' ? t('rev.restoreReplace') : t('rev.restoreNewPlan')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="restore-dialog">
        <p>{t('rev.restoreHelp', { label: meta.label })}</p>
        {loadError && (
          <p role="alert" className="text-red-700">
            {loadError}
          </p>
        )}
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="restore-mode"
            checked={mode === 'replace'}
            onChange={() => setMode('replace')}
            className="mt-1"
          />
          <span>
            <strong>{t('rev.restoreReplace')}</strong>
            <span className="block text-slate-600">
              {lost === null
                ? t('rev.draftChangesLoading')
                : t('rev.restoreLost', { count: lost, label: meta.label })}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="restore-mode"
            checked={mode === 'new-plan'}
            onChange={() => setMode('new-plan')}
            className="mt-1"
          />
          <span className="flex-1">
            <strong>{t('rev.restoreNewPlan')}</strong>
            <span className="block text-slate-600">{t('rev.restoreNewPlanHelp')}</span>
            {mode === 'new-plan' && (
              <input
                aria-label={t('plans.name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`${inputClass} mt-1`}
              />
            )}
          </span>
        </label>
        <p className="text-xs text-slate-500">{t('rev.restoreIntact', { label: meta.label })}</p>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
