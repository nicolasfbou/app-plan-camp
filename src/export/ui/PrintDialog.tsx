/**
 * Mise en page et export : réglages à gauche, aperçu FIDÈLE à droite (même moteur de mise en page
 * que le fichier produit : format, orientation, marges, photo, annotations, légende, cartouche),
 * avec la liste des problèmes détectés (textes trop petits ou coupés, débordements, échelle, nord).
 */
import { AlertTriangle, CheckCircle2, Download, Files, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { downloadBytes } from '@/app/download.ts';
import { PAPER } from '@/domain/print/paper.ts';
import { t } from '@/i18n/index.ts';
import { NumberField, Section, SelectField } from '@/panels/fields.tsx';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import type { ExportWarning } from '../compose.ts';
import {
  ExportLimitError,
  exportPdf,
  exportRaster,
  rasterPlan,
  rasterSize,
  renderPreview,
  type ExportSource,
  type RasterOptions,
} from '../exportPlan.ts';
import {
  ElementSettings,
  LayerSettings,
  LegendSettingsSection,
  PageSettings,
  TitleBlockSection,
  type OutputFormat,
} from './PrintSettingsPanel.tsx';
import { StyleSection, ViewSection, ViewSelector } from './ViewSettingsPanel.tsx';
import { BatchExportDialog } from './BatchExportDialog.tsx';
import { effectiveSettings } from '@/domain/print/views.ts';

const readBlob = async (id: string) => {
  const blob = await repository.getBlob(id);
  return blob ? new Uint8Array(blob.bytes) : null;
};

export function PrintDialog({ siteName, onClose }: { siteName: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const previewBox = useRef<HTMLDivElement>(null);
  const doc = usePlanStore((s) => s.doc);
  const backgroundStatus = useEditorStore((s) => s.background);
  const background = backgroundStatus.kind === 'ready' ? backgroundStatus.background : null;
  const viewId = useEditorStore((s) => s.activeViewId);
  const [batch, setBatch] = useState(false);
  const [output, setOutput] = useState<OutputFormat>('pdf');
  const [framing, setFraming] = useState<RasterOptions['framing']>('page');
  const [scale, setScale] = useState(1);
  const [preview, setPreview] = useState<{
    status: 'loading' | 'ready' | 'error';
    warnings: ExportWarning[];
    message?: string;
    page?: { width: number; height: number };
  }>({ status: 'loading', warnings: [] });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    tone: 'ok' | 'error';
    message: string;
    suggestion?: number | null;
  } | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const raster: RasterOptions | undefined = output === 'pdf' ? undefined : { format: output, framing, scale };
  const source = (): ExportSource | null => (doc ? { doc, siteName, background, readBlob } : null);

  // Aperçu redessiné (après une courte pause) à chaque changement du plan ou des réglages.
  useEffect(() => {
    const src = source();
    const target = canvas.current;
    const box = previewBox.current;
    if (!src || !target || !box) return;
    let cancelled = false;
    setPreview((p) => ({ ...p, status: 'loading' }));
    const timer = setTimeout(() => {
      // Rendu dans un canevas hors écran, recopié seulement s'il est toujours d'actualité : un
      // rendu plus ancien qui se termine en retard n'écrase jamais l'aperçu courant.
      const offscreen = document.createElement('canvas');
      renderPreview(
        offscreen,
        src,
        effectiveSettings(src.doc, viewId),
        {
          maxWidth: box.clientWidth - 24,
          maxHeight: box.clientHeight - 24,
          pixelRatio: Math.min(2, window.devicePixelRatio || 1),
        },
        raster,
      ).then(
        (r) => {
          if (cancelled) return;
          target.width = offscreen.width;
          target.height = offscreen.height;
          target.style.width = offscreen.style.width;
          target.style.height = offscreen.style.height;
          target.getContext('2d')?.drawImage(offscreen, 0, 0);
          setPreview({ status: 'ready', warnings: r.warnings, page: r.page });
        },
        (e: unknown) =>
          !cancelled &&
          setPreview({ status: 'error', warnings: [], message: e instanceof Error ? e.message : String(e) }),
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `source` et `raster` dérivent de ces valeurs
  }, [doc, background, output, framing, scale, siteName, viewId]);

  if (!doc) return null;
  const settings = effectiveSettings(doc, viewId);
  const print = settings.print;
  const size = raster
    ? rasterSize(rasterPlan({ doc, siteName, background, readBlob }, settings, raster))
    : null;

  const run = async () => {
    const src = source();
    if (!src) return;
    setBusy(true);
    setResult(null);
    try {
      const r = raster
        ? await exportRaster(src, effectiveSettings(src.doc, viewId), raster)
        : await exportPdf(src, effectiveSettings(src.doc, viewId));
      downloadBytes(r.bytes, r.fileName, r.mimeType);
      setResult({ tone: 'ok', message: t('print.exported', { file: r.fileName }) });
    } catch (e) {
      // Jamais d'échec silencieux : message clair et, si possible, une résolution qui passe.
      setResult({
        tone: 'error',
        message: t('print.exportError', { message: e instanceof Error ? e.message : String(e) }),
        suggestion: e instanceof ExportLimitError ? e.suggestion : null,
      });
    } finally {
      setBusy(false);
    }
  };

  const applySuggestion = (value: number) => {
    if (output !== 'pdf' && framing === 'image') setScale(value);
    else
      planStore.getState().update('Résolution', (d) => {
        d.plan.print.dpi = Math.max(72, Math.round(value));
      });
    setResult(null);
  };

  const formatLabel = t(`print.output.${output}`);
  return (
    <dialog
      ref={ref}
      aria-label={t('print.title')}
      data-testid="print-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (e.target === e.currentTarget) onClose(); // pas l'Échap d'une boîte imbriquée
      }}
      className="m-0 h-full max-h-none w-full max-w-none bg-slate-100 p-0 backdrop:bg-slate-900/50"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
          <h2 className="flex-1 text-base font-semibold text-slate-900">{t('print.title')}</h2>
          <div
            role="radiogroup"
            aria-label={t('print.output')}
            className="flex overflow-hidden rounded-md border border-slate-300"
          >
            {(['pdf', 'png', 'jpeg'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={output === f}
                onClick={() => setOutput(f)}
                className={`px-3 py-1 text-sm font-medium ${output === f ? 'bg-accent text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
              >
                {t(`print.output.${f}`)}
              </button>
            ))}
          </div>
          <Button onClick={() => setBatch(true)} data-testid="open-batch">
            <Files size={16} /> {t('batch.open')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()} data-testid="print-export">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {busy ? t('print.exporting') : t('print.export', { format: formatLabel })}
          </Button>
          <Button aria-label={t('print.close')} title={t('print.close')} onClick={onClose}>
            <X size={16} />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <div
            className="w-80 shrink-0 space-y-3 overflow-y-auto border-r border-slate-200 bg-white p-4 text-sm"
            data-testid="print-settings"
          >
            {output !== 'pdf' && (
              <Section title={t('print.output')}>
                <SelectField
                  label={t('print.framing')}
                  value={framing}
                  options={[
                    { value: 'page' as const, label: t('print.framing.page') },
                    { value: 'image' as const, label: t('print.framing.image') },
                  ]}
                  onChange={(v: RasterOptions['framing']) => setFraming(v)}
                />
                {framing === 'image' && (
                  <NumberField
                    label={t('print.scale')}
                    value={scale}
                    min={0.05}
                    step={0.25}
                    digits={2}
                    onCommit={(v) => setScale(Math.min(8, v))}
                  />
                )}
                {size && (
                  <p
                    className={`text-xs ${size.fits ? 'text-slate-600' : 'text-red-700'}`}
                    data-testid="raster-size"
                  >
                    {t('print.pixels', { width: size.width, height: size.height })}
                    {!size.fits &&
                      ` ${t('print.pixelsTooBig', { max: Math.floor(size.maxFactor * 100) / 100 })}`}
                  </p>
                )}
              </Section>
            )}
            <ViewSelector doc={doc} />
            {viewId && <ViewSection doc={doc} viewId={viewId} />}
            <StyleSection doc={doc} viewId={viewId} />
            <PageSettings doc={doc} output={output} viewId={viewId} />
            <ElementSettings doc={doc} viewId={viewId} />
            <LayerSettings doc={doc} viewId={viewId} />
            <LegendSettingsSection doc={doc} viewId={viewId} />
            {print.mode !== 'simplified' && <TitleBlockSection doc={doc} viewId={viewId} />}
            <p className="text-xs text-slate-500">{t('print.illustrative')}</p>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              ref={previewBox}
              className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3"
            >
              {/* Damier : un fond transparent reste visible comme tel. */}
              <canvas
                ref={canvas}
                aria-label={t('print.preview')}
                data-testid="print-preview"
                className="bg-[repeating-conic-gradient(#e2e8f0_0_25%,#fff_0_50%)] bg-[length:16px_16px] shadow-lg ring-1 ring-slate-300"
              />
              {preview.status === 'loading' && (
                <p
                  role="status"
                  className="absolute top-3 right-3 rounded bg-white/90 px-2 py-1 text-xs text-slate-600 shadow"
                >
                  {t('print.previewLoading')}
                </p>
              )}
            </div>
            <div
              className="max-h-48 shrink-0 overflow-y-auto border-t border-slate-200 bg-white px-4 py-2 text-sm"
              data-testid="print-warnings"
            >
              {preview.page && output !== 'png' && output !== 'jpeg' && (
                <p className="text-xs text-slate-500" data-testid="page-info">
                  {t('print.pageInfo', {
                    paper: PAPER[print.paper].name,
                    orientation: t(`print.orientation.${print.orientation}`),
                    width: new Intl.NumberFormat('fr-CA').format(preview.page.width),
                    height: new Intl.NumberFormat('fr-CA').format(preview.page.height),
                  })}
                </p>
              )}
              {result && (
                <p
                  role="status"
                  className={`my-1 flex items-center gap-2 ${result.tone === 'ok' ? 'text-emerald-800' : 'text-red-700'}`}
                  data-testid="print-result"
                >
                  {result.message}
                  {result.suggestion ? (
                    <Button onClick={() => applySuggestion(result.suggestion!)}>
                      {t('print.useSuggestion', { value: result.suggestion })}
                    </Button>
                  ) : null}
                </p>
              )}
              {preview.status === 'error' && (
                <p className="text-red-700">{t('print.previewError', { message: preview.message ?? '' })}</p>
              )}
              <h3 className="mt-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {t('print.warnings')}
              </h3>
              {preview.warnings.length === 0 ? (
                <p className="flex items-center gap-1 text-emerald-800">
                  <CheckCircle2 size={14} /> {t('print.noWarnings')}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {preview.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-amber-900" data-warning={w.code}>
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {w.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
      {batch && (
        <BatchExportDialog source={{ doc, siteName, background, readBlob }} onClose={() => setBatch(false)} />
      )}
    </dialog>
  );
}
