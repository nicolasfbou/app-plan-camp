/**
 * Comparaison de deux états d'un plan : deux révisions, ou une révision et le brouillon courant.
 * Modes : superposition (ancien en gris, nouveau en couleur, repères numérotés) et avant / après
 * (curseur ou bascule). Liste détaillée des changements (l'utilisateur / automatiques), zoom sur un
 * changement, rapport PDF ou Markdown. Les données comparées sont des copies figées : la
 * comparaison ne peut rien modifier.
 */
import { Download, FileText, GitCompare, Loader2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { downloadBytes } from '@/app/download.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import {
  AREA_LABELS,
  CHANGE_KIND_LABELS,
  diffPlans,
  nounLabel,
  type ObjectChange,
  type PlanDiff,
  summarizeDiff,
} from '@/domain/revisions/diff.ts';
import { buildChangeReport, changeReportMarkdown, type ReportSide } from '@/domain/revisions/report.ts';
import { deepFreeze, REVISION_STATUS_LABELS, type RevisionMeta } from '@/domain/revisions/revision.ts';
import { STATUS_LABELS } from '@/domain/print/titleBlock.ts';
import { t } from '@/i18n/index.ts';
import { usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { changeReportPdf } from './changeReportPdf.ts';
import { type ComparisonImages, markerColor, MARKER_COLORS, renderComparison } from './compareRender.ts';
import { useRevisionPhoto } from './revisionBackground.ts';
import { type CompareSide, loadRevisionCached, useRevisionMetas } from './revisionsStore.ts';

const readBlob = async (id: string) => {
  const blob = await repository.getBlob(id);
  return blob ? new Uint8Array(blob.bytes) : null;
};

const sideKey = (s: CompareSide) => (s.kind === 'draft' ? 'draft' : s.id);
const parseSide = (key: string): CompareSide =>
  key === 'draft' ? { kind: 'draft' } : { kind: 'revision', id: key };

interface Loaded {
  doc: PlanDocument;
  meta: RevisionMeta | null;
}

function useSide(side: CompareSide, draft: PlanDocument | null, metas: RevisionMeta[]) {
  const [state, setState] = useState<{ key: string; loaded: Loaded | null; error: string | null }>({
    key: '',
    loaded: null,
    error: null,
  });
  const key = sideKey(side);
  useEffect(() => {
    if (side.kind === 'draft') return;
    let cancelled = false;
    loadRevisionCached(side.id).then(
      (r) => !cancelled && setState({ key, loaded: { doc: r.doc, meta: r.meta }, error: null }),
      (e: unknown) =>
        !cancelled && setState({ key, loaded: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const meta = side.kind === 'revision' ? (metas.find((m) => m.id === side.id) ?? null) : null;
  // Valeur stable (sinon la comparaison et les images seraient recalculées à chaque rendu).
  return useMemo(() => {
    if (side.kind === 'draft') return { loaded: draft ? { doc: draft, meta: null } : null, error: null };
    if (state.key !== key) return { loaded: null, error: null };
    return {
      loaded: state.loaded && { doc: state.loaded.doc, meta: meta ?? state.loaded.meta },
      error: state.error,
    };
  }, [side.kind, draft, state, key, meta]);
}

function reportSide(loaded: Loaded): ReportSide {
  const m = loaded.meta;
  if (!m)
    return {
      name: t('rev.currentDraft'),
      description: t('rev.draftNotFrozen'),
      date: new Date().toISOString().slice(0, 10),
      author: loaded.doc.plan.titleBlock.preparedBy,
      status: STATUS_LABELS[loaded.doc.plan.titleBlock.status],
      approval: '',
    };
  return {
    name: t('rev.revisionName', { label: m.label }),
    description: m.description,
    date: m.date,
    author: m.author,
    status: REVISION_STATUS_LABELS[m.status],
    approval: m.approval ? `${m.approval.by} — ${m.approval.date}` : '',
  };
}

export function CompareDialog({
  initialBefore,
  initialAfter,
  siteName,
  onClose,
}: {
  initialBefore: CompareSide;
  initialAfter: CompareSide;
  siteName: string;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const metas = useRevisionMetas();
  const liveDoc = usePlanStore((s) => s.doc);
  // Le brouillon est comparé tel qu'il était à l'ouverture (copie figée, jamais modifiée).
  const [draft] = useState(() => (liveDoc ? deepFreeze(structuredClone(liveDoc)) : null));
  const [before, setBefore] = useState(initialBefore);
  const [after, setAfter] = useState(initialAfter);
  const [mode, setMode] = useState<'overlay' | 'split'>('overlay');
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState<string | null>(null);
  const [showAuto, setShowAuto] = useState(true);
  const [rendered, setRendered] = useState<{
    diff: PlanDiff | null;
    images: ComparisonImages | null;
    error: string | null;
  }>({ diff: null, images: null, error: null });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const beforeCanvas = useRef<HTMLCanvasElement>(null);
  const afterCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const a = useSide(before, draft, metas);
  const b = useSide(after, draft, metas);
  const photoA = useRevisionPhoto(a.loaded?.doc.plan.baseImage);
  const photoB = useRevisionPhoto(b.loaded?.doc.plan.baseImage);
  const diff: PlanDiff | null = useMemo(
    () =>
      a.loaded && b.loaded
        ? diffPlans(a.loaded.doc, b.loaded.doc, {
            beforeRevisionId: a.loaded.meta?.id,
            schemaVersions: {
              before: a.loaded.meta?.snapshot.schemaVersion ?? a.loaded.doc.schemaVersion,
              after: b.loaded.meta?.snapshot.schemaVersion ?? b.loaded.doc.schemaVersion,
            },
          })
        : null,
    [a.loaded, b.loaded],
  );
  const summary = useMemo(() => (diff ? summarizeDiff(diff) : []), [diff]);
  // Images de la comparaison COURANTE seulement (jamais celles d'un choix précédent).
  const images = rendered.diff === diff ? rendered.images : null;
  const renderError = rendered.diff === diff ? rendered.error : null;

  // Images (à chaque changement des deux états ou des photos).
  useEffect(() => {
    if (!diff || !a.loaded || !b.loaded || photoA.kind === 'loading' || photoB.kind === 'loading') return;
    let cancelled = false;
    renderComparison({
      before: a.loaded.doc,
      after: b.loaded.doc,
      diff,
      backgroundBefore: photoA.kind === 'ready' ? photoA.background : null,
      backgroundAfter: photoB.kind === 'ready' ? photoB.background : null,
      readBlob,
    }).then(
      (r) => !cancelled && setRendered({ diff, images: r, error: null }),
      (e: unknown) =>
        !cancelled && setRendered({ diff, images: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, photoA.kind, photoB.kind]);

  // Recopie des images dans les canevas visibles.
  useEffect(() => {
    if (!images) return;
    const copy = (target: HTMLCanvasElement | null, source: HTMLCanvasElement) => {
      if (!target) return;
      target.width = source.width;
      target.height = source.height;
      target.getContext('2d')?.drawImage(source, 0, 0);
    };
    copy(overlayCanvas.current, images.overlay);
    copy(beforeCanvas.current, images.before);
    copy(afterCanvas.current, images.after);
  }, [images, mode]);

  // Zoom sur le changement choisi.
  const focused = diff?.objects.find((o) => o.id === focus) ?? null;
  const focusBounds = focused ? (focused.after ?? focused.before) : null;
  useEffect(() => {
    const el = scroller.current;
    if (!el || !images || !focusBounds) return;
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const cx = (focusBounds.x + focusBounds.width / 2 - images.extent.x) / images.extent.width;
    const cy = (focusBounds.y + focusBounds.height / 2 - images.extent.y) / images.extent.height;
    requestAnimationFrame(() =>
      el.scrollTo({
        left: cx * inner.clientWidth - el.clientWidth / 2,
        top: cy * inner.clientHeight - el.clientHeight / 2,
        behavior: 'smooth',
      }),
    );
  }, [focus, zoom, images, focusBounds]);

  const selectChange = (c: ObjectChange) => {
    setFocus(c.id);
    if (zoom < 2) setZoom(2);
  };

  const report = () =>
    diff && a.loaded && b.loaded
      ? buildChangeReport(diff, reportSide(a.loaded), reportSide(b.loaded), {
          planName: b.loaded.doc.plan.name,
          siteName,
          generatedAt: new Date().toISOString(),
        })
      : null;
  const fileBase = () =>
    `rapport-changements-${(a.loaded?.meta?.label ?? 'brouillon').replace(/[^\w-]/g, '')}-${(b.loaded?.meta?.label ?? 'brouillon').replace(/[^\w-]/g, '')}`;

  const exportPdf = async () => {
    const r = report();
    if (!r) return;
    setBusy(true);
    setMessage(null);
    try {
      const bytes = await changeReportPdf(r, images?.overlay ?? null);
      downloadBytes(bytes, `${fileBase()}.pdf`, 'application/pdf');
      setMessage(t('print.exported', { file: `${fileBase()}.pdf` }));
    } catch (e) {
      setMessage(t('print.exportError', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  const exportMarkdown = () => {
    const r = report();
    if (!r) return;
    downloadBytes(new TextEncoder().encode(changeReportMarkdown(r)), `${fileBase()}.md`, 'text/markdown');
    setMessage(t('print.exported', { file: `${fileBase()}.md` }));
  };

  const options = [
    ...metas.map((m) => ({ value: m.id, label: t('rev.revisionName', { label: m.label }) })),
    { value: 'draft', label: t('rev.currentDraft') },
  ];
  const sideSelect = (
    label: string,
    value: CompareSide,
    onChange: (s: CompareSide) => void,
    testId: string,
  ) => (
    <label className="flex items-center gap-1 text-sm text-slate-600">
      {label}
      <select
        value={sideKey(value)}
        onChange={(e) => {
          setFocus(null);
          onChange(parseSide(e.target.value));
        }}
        className="rounded border border-slate-300 bg-white px-1 py-1 text-sm"
        data-testid={testId}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const error = a.error ?? b.error ?? renderError;
  const nameA = a.loaded ? reportSide(a.loaded).name : '…';
  const nameB = b.loaded ? reportSide(b.loaded).name : '…';
  const aspect = images ? images.overlay.width / images.overlay.height : 1.4;

  return (
    <dialog
      ref={ref}
      aria-label={t('rev.compareTitle')}
      data-testid="compare-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 h-full max-h-none w-full max-w-none bg-slate-100 p-0 backdrop:bg-slate-900/50"
    >
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <GitCompare size={16} aria-hidden /> {t('rev.compareTitle')}
          </h2>
          {sideSelect(t('rev.before'), before, setBefore, 'compare-before')}
          <span aria-hidden>↔</span>
          {sideSelect(t('rev.after'), after, setAfter, 'compare-after')}
          <div
            role="radiogroup"
            aria-label={t('rev.mode')}
            className="ml-2 flex overflow-hidden rounded-md border border-slate-300"
          >
            {(['overlay', 'split'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 text-sm font-medium ${mode === m ? 'bg-accent text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
              >
                {t(m === 'overlay' ? 'rev.mode.overlay' : 'rev.mode.split')}
              </button>
            ))}
          </div>
          <Button
            aria-label={t('rev.zoomOut')}
            onClick={() => setZoom((z) => Math.max(1, z / 2))}
            disabled={zoom <= 1}
          >
            <ZoomOut size={16} />
          </Button>
          <span className="w-12 text-center text-sm tabular-nums">{zoom * 100} %</span>
          <Button
            aria-label={t('rev.zoomIn')}
            onClick={() => setZoom((z) => Math.min(8, z * 2))}
            disabled={zoom >= 8}
          >
            <ZoomIn size={16} />
          </Button>
          <div className="flex-1" />
          <Button disabled={!diff || busy} onClick={() => void exportPdf()} data-testid="report-pdf">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}{' '}
            {t('rev.reportPdf')}
          </Button>
          <Button disabled={!diff} onClick={exportMarkdown} data-testid="report-md">
            <FileText size={16} /> {t('rev.reportMd')}
          </Button>
          <Button aria-label={t('print.close')} title={t('print.close')} onClick={onClose}>
            <X size={16} />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside
            className="w-96 shrink-0 space-y-3 overflow-y-auto border-r border-slate-200 bg-white p-4 text-sm"
            data-testid="compare-changes"
          >
            {error && (
              <p role="alert" className="text-red-700">
                {error}
              </p>
            )}
            {!diff && !error && <p className="text-slate-500">{t('rev.loading')}</p>}
            {diff && (
              <>
                <p className="font-medium text-slate-900" data-testid="compare-count">
                  {t('rev.compareCount', { a: nameA, b: nameB, count: diff.counts.user })}
                </p>
                <section>
                  <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    {t('rev.summary')}
                  </h3>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4" data-testid="compare-summary">
                    {summary.length ? (
                      summary.map((l) => <li key={l}>{l}</li>)
                    ) : (
                      <li>{t('rev.noChanges')}</li>
                    )}
                  </ul>
                </section>
                {diff.objects.length > 0 && (
                  <section>
                    <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                      {t('rev.objects', { count: diff.objects.length })}
                    </h3>
                    <ol className="mt-1 space-y-1" data-testid="compare-objects">
                      {diff.objects.map((c, i) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => selectChange(c)}
                            className={`flex w-full gap-2 rounded px-1 py-1 text-left hover:bg-slate-50 ${focus === c.id ? 'bg-blue-50' : ''}`}
                            data-kind={c.primary}
                          >
                            <span
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                              style={{ background: markerColor(c) }}
                              aria-hidden
                            >
                              {i + 1}
                            </span>
                            <span className="min-w-0">
                              <span className="font-medium">
                                {nounLabel(c.noun)}
                                {c.name ? ` « ${c.name} »` : ''}
                              </span>
                              <span className="block text-xs text-slate-600">
                                {c.kinds.map((k) => CHANGE_KIND_LABELS[k]).join(', ')}
                                {c.details.length ? ` — ${c.details.join(' ; ')}` : ''}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
                {(Object.keys(AREA_LABELS) as (keyof typeof AREA_LABELS)[]).map((area) => {
                  const list = diff.settings.filter((s) => s.area === area);
                  if (!list.length) return null;
                  return (
                    <section key={area} data-testid={`compare-area-${area}`}>
                      <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                        {AREA_LABELS[area]} ({list.length})
                      </h3>
                      <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
                        {list.map((s, i) => (
                          <li key={i}>
                            {s.subject !== 'cartouche' && s.subject !== 'plan' ? `${s.subject} — ` : ''}
                            <span className="font-medium">{s.label}</span>
                            {s.before !== '—' || s.after !== '—' ? ` : ${s.before} → ${s.after}` : ''}
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
                <section className="rounded-md bg-slate-50 p-2">
                  <label className="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    <input
                      type="checkbox"
                      checked={showAuto}
                      onChange={(e) => setShowAuto(e.target.checked)}
                    />
                    {t('rev.autoChanges', { count: diff.auto.length })}
                  </label>
                  {showAuto && (
                    <ul className="mt-1 space-y-0.5 text-xs text-slate-600" data-testid="compare-auto">
                      {diff.auto.length ? (
                        diff.auto.map((x) => (
                          <li key={x.label}>
                            <span className="font-medium">{x.label}</span> — {x.detail}
                          </li>
                        ))
                      ) : (
                        <li>{t('rev.noAuto')}</li>
                      )}
                    </ul>
                  )}
                </section>
                <p className="text-xs text-slate-500">{t('rev.compareNote')}</p>
                {message && (
                  <p role="status" className="text-emerald-700">
                    {message}
                  </p>
                )}
              </>
            )}
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            {mode === 'split' && (
              <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-1.5 text-sm">
                <Button className="px-2 py-1 text-xs" onClick={() => setSplit(100)} data-testid="show-before">
                  {t('rev.showBefore', { name: nameA })}
                </Button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={split}
                  onChange={(e) => setSplit(Number(e.target.value))}
                  aria-label={t('rev.slider')}
                  className="flex-1"
                  data-testid="compare-slider"
                />
                <Button className="px-2 py-1 text-xs" onClick={() => setSplit(0)} data-testid="show-after">
                  {t('rev.showAfter', { name: nameB })}
                </Button>
              </div>
            )}
            {mode === 'overlay' && (
              <div
                className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
                data-testid="compare-legend"
              >
                {(
                  [
                    [MARKER_COLORS.added, t('rev.legend.added')],
                    [MARKER_COLORS.removed, t('rev.legend.removed')],
                    [MARKER_COLORS.moved, t('rev.legend.moved')],
                    [MARKER_COLORS.modified, t('rev.legend.modified')],
                  ] as const
                ).map(([color, text]) => (
                  <span key={text} className="flex items-center gap-1">
                    <span className="h-3 w-3 rounded-sm" style={{ background: color }} aria-hidden /> {text}
                  </span>
                ))}
                <span className="text-slate-500">{t('rev.legend.ghost')}</span>
              </div>
            )}
            <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto p-3">
              <div
                className="relative mx-auto"
                style={{
                  width: zoom === 1 ? `min(100%, calc((100vh - 9rem) * ${aspect}))` : `${zoom * 100}%`,
                  aspectRatio: String(aspect),
                }}
              >
                {!images && !error && (
                  <p
                    role="status"
                    className="absolute inset-x-0 top-6 mx-auto w-fit rounded bg-white px-3 py-1 shadow"
                  >
                    {t('rev.rendering')}
                  </p>
                )}
                {mode === 'overlay' ? (
                  <canvas
                    ref={overlayCanvas}
                    className="absolute inset-0 h-full w-full bg-white shadow"
                    aria-label={t('rev.overlayCanvas', { a: nameA, b: nameB })}
                    data-testid="compare-overlay"
                  />
                ) : (
                  <>
                    <canvas
                      ref={afterCanvas}
                      className="absolute inset-0 h-full w-full bg-white shadow"
                      aria-label={nameB}
                      data-testid="compare-after-canvas"
                    />
                    <canvas
                      ref={beforeCanvas}
                      className="absolute inset-0 h-full w-full"
                      style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                      aria-label={nameA}
                      data-testid="compare-before-canvas"
                    />
                    <div
                      className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow"
                      style={{ left: `${split}%` }}
                      aria-hidden
                    />
                    <span className="absolute top-2 left-2 rounded bg-slate-900/70 px-2 py-0.5 text-xs text-white">
                      {nameA}
                    </span>
                    <span className="absolute top-2 right-2 rounded bg-slate-900/70 px-2 py-0.5 text-xs text-white">
                      {nameB}
                    </span>
                  </>
                )}
                {images && focusBounds && (
                  <div
                    className="pointer-events-none absolute animate-pulse rounded border-4 border-fuchsia-500"
                    style={{
                      left: `${((focusBounds.x - images.extent.x) / images.extent.width) * 100}%`,
                      top: `${((focusBounds.y - images.extent.y) / images.extent.height) * 100}%`,
                      width: `${Math.max(1, (focusBounds.width / images.extent.width) * 100)}%`,
                      height: `${Math.max(1, (focusBounds.height / images.extent.height) * 100)}%`,
                      margin: '-8px',
                      padding: '8px',
                      boxSizing: 'content-box',
                    }}
                    data-testid="compare-focus"
                    aria-hidden
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
