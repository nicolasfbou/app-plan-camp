/**
 * Onglet « Révisions » : historique des révisions figées (la plus récente en premier), état du
 * brouillon courant par rapport à la dernière révision, et accès aux actions (créer, consulter,
 * comparer, changer le statut, supprimer, créer un brouillon à partir d'une révision).
 */
import { AlertTriangle, Eye, GitCompare, Lock, Plus, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { diffPlans } from '@/domain/revisions/diff.ts';
import {
  allowedStatuses,
  isDeletable,
  REVISION_STATUS_LABELS,
  type RevisionMeta,
  type RevisionStatus,
} from '@/domain/revisions/revision.ts';
import { t } from '@/i18n/index.ts';
import { usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { loadRevisionCached, useRevisionMetas, useRevisionsStore } from './revisionsStore.ts';

const STATUS_TONES: Record<RevisionStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  review: 'bg-amber-100 text-amber-800',
  'field-validation': 'bg-orange-100 text-orange-800',
  approved: 'bg-emerald-100 text-emerald-800',
  archived: 'bg-slate-200 text-slate-600',
};

export function StatusChip({ status }: { status: RevisionStatus }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONES[status]}`}
      data-testid="revision-status"
    >
      {REVISION_STATUS_LABELS[status]}
    </span>
  );
}

/** Nombre de changements du brouillon courant depuis la dernière révision (calcul différé). */
function useDraftChanges(latest: RevisionMeta | undefined): { count: number | null; error: boolean } {
  const doc = usePlanStore((s) => s.doc);
  const [state, setState] = useState<{ count: number | null; error: boolean }>({ count: null, error: false });
  useEffect(() => {
    if (!latest || !doc) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      loadRevisionCached(latest.id).then(
        (r) => !cancelled && setState({ count: diffPlans(r.doc, doc).counts.user, error: false }),
        () => !cancelled && setState({ count: null, error: true }),
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [latest, doc]);
  return latest ? state : { count: null, error: false };
}

export function RevisionsPanel() {
  const status = useRevisionsStore((s) => s.status);
  const entries = useRevisionsStore((s) => s.entries);
  const error = useRevisionsStore((s) => s.error);
  const open = useRevisionsStore((s) => s.open);
  const metas = useRevisionMetas();
  const latest = metas.at(-1);
  const draft = useDraftChanges(latest);
  const draftBase = usePlanStore((s) => s.doc?.plan.draftBase ?? null);
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));
  const ordered = [...entries].reverse();

  return (
    <div className="space-y-3 text-sm" data-testid="revisions-panel">
      <Button
        variant="primary"
        className="w-full"
        onClick={() => open({ kind: 'create' })}
        data-testid="create-revision"
      >
        <Plus size={16} /> {t('rev.create')}
      </Button>
      <section className="rounded-md border border-slate-200 bg-white p-2" data-testid="draft-status">
        <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{t('rev.draft')}</h3>
        <p className="mt-1 text-slate-700">
          {draftBase ? t('rev.draftBase', { label: draftBase.label }) : t('rev.draftNoBase')}
        </p>
        {latest && (
          <p className="mt-1 text-slate-700" data-testid="draft-changes">
            {draft.error
              ? t('rev.draftChangesError')
              : draft.count === null
                ? t('rev.draftChangesLoading')
                : t('rev.draftChanges', { count: draft.count, label: latest.label })}
          </p>
        )}
        {latest && (
          <Button
            className="mt-2 w-full"
            onClick={() =>
              open({ kind: 'compare', before: { kind: 'revision', id: latest.id }, after: { kind: 'draft' } })
            }
            data-testid="compare-draft"
          >
            <GitCompare size={16} /> {t('rev.compareDraft', { label: latest.label })}
          </Button>
        )}
      </section>

      <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{t('rev.history')}</h3>
      {status === 'loading' && <p className="text-slate-500">{t('rev.loading')}</p>}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {status === 'ready' && !entries.length && <p className="text-slate-500">{t('rev.none')}</p>}
      {selected.length === 2 && (
        <Button
          className="w-full"
          onClick={() => {
            const [x, y] = [...selected].sort(
              (p, q) => metas.findIndex((m) => m.id === p) - metas.findIndex((m) => m.id === q),
            );
            open({
              kind: 'compare',
              before: { kind: 'revision', id: x! },
              after: { kind: 'revision', id: y! },
            });
          }}
          data-testid="compare-selected"
        >
          <GitCompare size={16} />
          {t('rev.compareSelected', {
            a: metas.find((m) => m.id === selected[0])?.label ?? '',
            b: metas.find((m) => m.id === selected[1])?.label ?? '',
          })}
        </Button>
      )}
      <ol className="space-y-2" data-testid="revision-list">
        {ordered.map((entry) =>
          entry.meta ? (
            <RevisionCard
              key={entry.id}
              meta={entry.meta}
              intact={entry.sealIntact}
              selected={selected.includes(entry.id)}
              onToggle={() => toggle(entry.id)}
            />
          ) : (
            <li
              key={entry.id}
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-2 text-red-800"
            >
              {t('rev.unreadable')}
            </li>
          ),
        )}
      </ol>
      <p className="text-xs text-slate-500">{t('rev.help')}</p>
    </div>
  );
}

function RevisionCard({
  meta,
  intact,
  selected,
  onToggle,
}: {
  meta: RevisionMeta;
  intact: boolean;
  selected: boolean;
  onToggle(): void;
}) {
  const open = useRevisionsStore((s) => s.open);
  return (
    <li
      className={`rounded-md border bg-white p-2 ${selected ? 'border-accent ring-1 ring-accent' : 'border-slate-200'}`}
      data-testid="revision-card"
      data-label={meta.label}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={t('rev.selectForCompare', { label: meta.label })}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">
            {t('rev.title', { label: meta.label, date: meta.date })}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <StatusChip status={meta.status} />
            <span className="inline-flex items-center gap-0.5 text-xs text-slate-500" title={t('rev.frozen')}>
              <Lock size={12} aria-hidden /> {t('rev.frozenShort')}
            </span>
          </div>
        </div>
      </div>
      {meta.description && <p className="mt-1 text-slate-800">{meta.description}</p>}
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs text-slate-600">
        <dt>{t('rev.author')}</dt>
        <dd>{meta.author}</dd>
        {meta.approval && (
          <>
            <dt>{t('rev.approvedBy')}</dt>
            <dd data-testid="revision-approval">
              {t('rev.approvalLine', { by: meta.approval.by, date: meta.approval.date })}
            </dd>
          </>
        )}
        <dt>{t('rev.changes')}</dt>
        <dd data-testid="revision-changes">
          {meta.changes
            ? t('rev.changesSince', { count: meta.changes.user, label: meta.changes.sinceLabel })
            : meta.parentId
              ? t('rev.changesUnknown')
              : t('rev.firstRevision')}
        </dd>
      </dl>
      {!intact && (
        <p role="alert" className="mt-1 flex items-center gap-1 text-xs text-red-700">
          <AlertTriangle size={12} aria-hidden /> {t('rev.tampered')}
        </p>
      )}
      {intact && meta.approval && (
        <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
          <ShieldCheck size={12} aria-hidden /> {t('rev.sealed')}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        <Button className="px-2 py-1 text-xs" onClick={() => open({ kind: 'view', id: meta.id })}>
          <Eye size={14} /> {t('rev.view')}
        </Button>
        {allowedStatuses(meta).length > 0 && intact && (
          <Button className="px-2 py-1 text-xs" onClick={() => open({ kind: 'status', id: meta.id })}>
            {t('rev.changeStatus')}
          </Button>
        )}
        <Button className="px-2 py-1 text-xs" onClick={() => open({ kind: 'restore', id: meta.id })}>
          <Undo2 size={14} /> {t('rev.restoreShort')}
        </Button>
        {isDeletable(meta) && (
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs text-red-700"
            onClick={() => open({ kind: 'delete', id: meta.id })}
            aria-label={t('rev.delete', { label: meta.label })}
          >
            <Trash2 size={14} />
          </Button>
        )}
      </div>
    </li>
  );
}
