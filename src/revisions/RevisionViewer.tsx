/**
 * Consultation d'une révision figée (lecture seule) : la page telle qu'elle s'imprime, pour le plan
 * de base ou l'une de SES vues (celles de la révision, exactement comme au moment où elle a été
 * figée), ses métadonnées, son journal de statuts et son empreinte ; export PDF (une vue ou toutes
 * les vues), comparaison, nouveau brouillon. Rien ici ne peut modifier la révision.
 */
import {
  Download,
  Files,
  GitCompare,
  Loader2,
  Lock,
  ShieldCheck,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { downloadBytes } from '@/app/download.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { effectiveSettings } from '@/domain/print/views.ts';
import {
  REVISION_STATUS_LABELS,
  revisionHistoryRows,
  type RevisionMeta,
  revisionStamp,
} from '@/domain/revisions/revision.ts';
import { exportPdfPages, renderPreview, type ExportSource } from '@/export/exportPlan.ts';
import { formatDateTime, t } from '@/i18n/index.ts';
import { Button } from '@/ui/Button.tsx';
import { useRevisionPhoto } from './revisionBackground.ts';
import { StatusChip } from './RevisionsPanel.tsx';
import { loadRevisionCached, useRevisionMetas, useRevisionsStore } from './revisionsStore.ts';

const readBlob = async (id: string) => {
  const blob = await repository.getBlob(id);
  return blob ? new Uint8Array(blob.bytes) : null;
};

const ZOOMS = [1, 2, 4];

export function RevisionViewer({
  meta,
  siteName,
  onClose,
}: {
  meta: RevisionMeta;
  siteName: string;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const metas = useRevisionMetas();
  const open = useRevisionsStore((s) => s.open);
  const [doc, setDoc] = useState<PlanDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rendering, setRendering] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const photo = useRevisionPhoto(doc?.plan.baseImage);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadRevisionCached(meta.id).then(
      (r) => !cancelled && setDoc(r.doc),
      (e: unknown) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [meta.id]);

  const source = (): ExportSource | null =>
    doc
      ? {
          doc,
          siteName,
          background: photo.kind === 'ready' ? photo.background : null,
          readBlob,
          now: new Date(`${meta.date}T12:00:00`),
          revision: revisionStamp(meta),
          revisionHistory: revisionHistoryRows(metas, meta.id),
        }
      : null;

  useEffect(() => {
    const src = source();
    const target = canvas.current;
    const container = box.current;
    if (!src || !target || !container || photo.kind === 'loading') return;
    let cancelled = false;
    setRendering(true);
    const offscreen = document.createElement('canvas');
    renderPreview(offscreen, src, effectiveSettings(src.doc, viewId), {
      maxWidth: (container.clientWidth - 24) * zoom,
      maxHeight: (container.clientHeight - 24) * zoom,
      pixelRatio: Math.min(2, window.devicePixelRatio || 1),
    }).then(
      () => {
        if (cancelled) return;
        target.width = offscreen.width;
        target.height = offscreen.height;
        target.style.width = offscreen.style.width;
        target.style.height = offscreen.style.height;
        target.getContext('2d')?.drawImage(offscreen, 0, 0);
        setRendering(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setRendering(false);
        setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `source` dérive de ces valeurs
  }, [doc, viewId, zoom, photo.kind, metas]);

  const exportPages = async (all: boolean) => {
    const src = source();
    if (!src) return;
    setBusy(true);
    setMessage(null);
    try {
      const pages = all
        ? [
            effectiveSettings(src.doc, null),
            ...src.doc.plan.views.map((v) => effectiveSettings(src.doc, v.id)),
          ]
        : [effectiveSettings(src.doc, viewId)];
      const r = await exportPdfPages(src, pages);
      downloadBytes(r.bytes, r.fileName, r.mimeType);
      setMessage({ tone: 'ok', text: t('print.exported', { file: r.fileName }) });
    } catch (e) {
      setMessage({
        tone: 'error',
        text: t('print.exportError', { message: e instanceof Error ? e.message : String(e) }),
      });
    } finally {
      setBusy(false);
    }
  };

  const others = metas.filter((m) => m.id !== meta.id);
  return (
    <dialog
      ref={ref}
      aria-label={t('rev.viewerTitle', { label: meta.label })}
      data-testid="revision-viewer"
      onCancel={(e) => {
        e.preventDefault();
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 h-full max-h-none w-full max-w-none bg-slate-100 p-0 backdrop:bg-slate-900/50"
    >
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
          <h2 className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold text-slate-900">
            <Lock size={16} className="shrink-0 text-slate-500" aria-hidden />
            <span className="truncate">
              {t('rev.title', { label: meta.label, date: meta.date })}
              {meta.description ? ` — ${meta.description}` : ''}
            </span>
            <StatusChip status={meta.status} />
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-600">
              {t('rev.readOnly')}
            </span>
          </h2>
          {doc && (
            <label className="flex items-center gap-1 text-sm text-slate-600">
              {t('views.topbar')}
              <select
                value={viewId ?? ''}
                onChange={(e) => setViewId(e.target.value || null)}
                className="rounded border border-slate-300 bg-white px-1 py-1 text-sm"
                data-testid="revision-view-select"
              >
                <option value="">{t('views.base')}</option>
                {doc.plan.views.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button
            aria-label={t('rev.zoomOut')}
            onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)]!)}
            disabled={zoom === ZOOMS[0]}
          >
            <ZoomOut size={16} />
          </Button>
          <span className="w-12 text-center text-sm tabular-nums">{zoom * 100} %</span>
          <Button
            aria-label={t('rev.zoomIn')}
            onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)]!)}
            disabled={zoom === ZOOMS.at(-1)}
          >
            <ZoomIn size={16} />
          </Button>
          <Button
            variant="primary"
            disabled={!doc || busy}
            onClick={() => void exportPages(false)}
            data-testid="revision-export-pdf"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}{' '}
            {t('rev.exportPdf')}
          </Button>
          {doc && doc.plan.views.length > 0 && (
            <Button disabled={busy} onClick={() => void exportPages(true)} data-testid="revision-export-all">
              <Files size={16} /> {t('rev.exportAll')}
            </Button>
          )}
          <Button aria-label={t('print.close')} title={t('print.close')} onClick={onClose}>
            <X size={16} />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside
            className="w-80 shrink-0 space-y-3 overflow-y-auto border-r border-slate-200 bg-white p-4 text-sm"
            data-testid="revision-meta"
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-slate-500">{t('rev.field.label')}</dt>
              <dd className="font-medium">{meta.label}</dd>
              <dt className="text-slate-500">{t('rev.field.date')}</dt>
              <dd>{meta.date}</dd>
              <dt className="text-slate-500">{t('rev.field.author')}</dt>
              <dd>{meta.author}</dd>
              <dt className="text-slate-500">{t('rev.field.status')}</dt>
              <dd>{REVISION_STATUS_LABELS[meta.status]}</dd>
              {meta.reason && (
                <>
                  <dt className="text-slate-500">{t('rev.field.reason')}</dt>
                  <dd>{meta.reason}</dd>
                </>
              )}
              {meta.comments && (
                <>
                  <dt className="text-slate-500">{t('rev.field.comments')}</dt>
                  <dd className="whitespace-pre-wrap">{meta.comments}</dd>
                </>
              )}
              {meta.approval && (
                <>
                  <dt className="text-slate-500">{t('rev.approvedBy')}</dt>
                  <dd>
                    {t('rev.approvalLine', { by: meta.approval.by, date: meta.approval.date })}
                    {meta.approval.comment && (
                      <span className="block text-slate-600">« {meta.approval.comment} »</span>
                    )}
                  </dd>
                </>
              )}
            </dl>
            <section>
              <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {t('rev.statusLog')}
              </h3>
              <ol className="mt-1 space-y-1 text-xs text-slate-700">
                {meta.statusLog.map((s, i) => (
                  <li key={i}>
                    {formatDateTime(s.at)} — {s.from ? `${REVISION_STATUS_LABELS[s.from]} → ` : ''}
                    {REVISION_STATUS_LABELS[s.to]}
                    {s.by ? ` (${s.by})` : ''}
                    {s.comment ? ` : ${s.comment}` : ''}
                  </li>
                ))}
              </ol>
            </section>
            <section
              className="rounded-md bg-slate-50 p-2 text-xs text-slate-600"
              data-testid="revision-integrity"
            >
              <p className="flex items-center gap-1 font-medium text-emerald-700">
                <ShieldCheck size={14} aria-hidden /> {doc ? t('rev.integrityOk') : t('rev.loading')}
              </p>
              <p>
                {t('rev.snapshotCounts', {
                  objects: meta.snapshot.objectCount,
                  layers: meta.snapshot.layerCount,
                  views: meta.snapshot.viewCount,
                })}
              </p>
              <p className="break-all">{t('rev.snapshotSha', { sha: meta.snapshot.sha256 })}</p>
              {meta.snapshot.photo && (
                <p className="break-all">
                  {t('rev.photoSha', { name: meta.snapshot.photo.fileName, sha: meta.snapshot.photo.sha256 })}
                </p>
              )}
            </section>
            <div className="space-y-2">
              {others.length > 0 && (
                <label className="block">
                  <span className="mb-0.5 block text-xs text-slate-600">{t('rev.compareWith')}</span>
                  <select
                    defaultValue=""
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1"
                    onChange={(e) => {
                      const other = e.target.value;
                      if (!other) return;
                      const before =
                        metas.findIndex((m) => m.id === other) < metas.findIndex((m) => m.id === meta.id);
                      open(
                        other === 'draft'
                          ? {
                              kind: 'compare',
                              before: { kind: 'revision', id: meta.id },
                              after: { kind: 'draft' },
                            }
                          : before
                            ? {
                                kind: 'compare',
                                before: { kind: 'revision', id: other },
                                after: { kind: 'revision', id: meta.id },
                              }
                            : {
                                kind: 'compare',
                                before: { kind: 'revision', id: meta.id },
                                after: { kind: 'revision', id: other },
                              },
                      );
                    }}
                    data-testid="revision-compare-with"
                  >
                    <option value="">—</option>
                    {others.map((m) => (
                      <option key={m.id} value={m.id}>
                        {t('rev.revisionName', { label: m.label })}
                      </option>
                    ))}
                    <option value="draft">{t('rev.currentDraft')}</option>
                  </select>
                </label>
              )}
              {others.length === 0 && (
                <Button
                  className="w-full"
                  onClick={() =>
                    open({
                      kind: 'compare',
                      before: { kind: 'revision', id: meta.id },
                      after: { kind: 'draft' },
                    })
                  }
                >
                  <GitCompare size={16} /> {t('rev.compareDraft', { label: meta.label })}
                </Button>
              )}
              <Button className="w-full" onClick={() => open({ kind: 'restore', id: meta.id })}>
                <Undo2 size={16} /> {t('rev.restore')}
              </Button>
            </div>
            {message && (
              <p
                role={message.tone === 'error' ? 'alert' : 'status'}
                className={message.tone === 'error' ? 'text-red-700' : 'text-emerald-700'}
              >
                {message.text}
              </p>
            )}
            <p className="text-xs text-slate-500">{t('rev.viewerNote')}</p>
          </aside>
          <div ref={box} className="relative min-h-0 min-w-0 flex-1 overflow-auto p-3">
            {loadError && (
              <p role="alert" className="m-6 rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
                {loadError}
              </p>
            )}
            {photo.kind === 'error' && (
              <p role="alert" className="mb-2 text-red-700">
                {photo.message}
              </p>
            )}
            <div className={`flex ${zoom === 1 ? 'h-full items-center justify-center' : ''}`}>
              <canvas
                ref={canvas}
                aria-label={t('rev.viewerCanvas', { label: meta.label })}
                className="bg-white shadow"
                data-testid="revision-canvas"
              />
            </div>
            {(rendering || photo.kind === 'loading') && !loadError && (
              <p
                role="status"
                className="absolute top-4 left-1/2 -translate-x-1/2 rounded bg-white px-3 py-1 text-sm shadow"
              >
                {t('rev.rendering')}
              </p>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
