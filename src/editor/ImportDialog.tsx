import { AlertTriangle, FileWarning } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { pdfPagePixelSize, defaultPdfDpi, PDF_DPI_CHOICES } from '@/domain/image/pdfRaster.ts';
import {
  CANVAS_MAX_SIDE,
  GPU_TEXTURE_SIDE,
  LARGE_MAX_MEGAPIXELS,
  NORMAL_MAX_MEGAPIXELS,
  type SizeAssessment,
  assessImageSize,
  formatBytes,
  formatMegapixels,
} from '@/domain/image/sizeAssessment.ts';
import { formatInteger, t, tPlural } from '@/i18n/index.ts';
import { ImportError } from '@/import/errors.ts';
import type { LoadedPdf } from '@/import/pdf.ts';
import {
  type ImportedBackground,
  type PreparedImport,
  finalizeImageImport,
  finalizePdfImport,
  prepareImport,
} from '@/import/importBackground.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { buildDisplayPyramid } from './backgroundImage.ts';
import { freshBackgrounds } from './session/freshBackgrounds.ts';

type Step =
  | { kind: 'working'; message: string }
  | { kind: 'confirm-size'; prepared: Extract<PreparedImport, { kind: 'image' }> }
  | { kind: 'pdf'; prepared: Extract<PreparedImport, { kind: 'pdf' }> }
  | { kind: 'error'; message: string };

const LIMITS: Record<SizeAssessment['reasons'][number], number> = {
  megapixels: NORMAL_MAX_MEGAPIXELS,
  'megapixels-critical': LARGE_MAX_MEGAPIXELS,
  side: GPU_TEXTURE_SIDE,
  'side-critical': CANVAS_MAX_SIDE,
};

function messageOf(error: unknown): string {
  if (error instanceof ImportError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Applique le fond importé au plan ouvert (action annulable). */
async function applyBackground(imported: ImportedBackground): Promise<void> {
  const doc = planStore.getState().doc;
  if (!doc) return;
  const current = doc.plan.baseImage;
  const hasObjects = Object.keys(doc.objects).length > 0;
  if (
    hasObjects &&
    current &&
    (current.width !== imported.ref.width || current.height !== imported.ref.height)
  ) {
    imported.bitmap.close();
    throw new ImportError(t('import.replaceBlocked'));
  }
  const loaded = await buildDisplayPyramid(imported.ref.blobId, imported.bitmap);
  freshBackgrounds.add(imported.ref.blobId);
  useEditorStore.getState().setBackground({ kind: 'ready', background: loaded });
  planStore.getState().update(t('history.importBackground'), (draft) => {
    draft.plan.baseImage = imported.ref;
    draft.plan.updatedAt = imported.ref.importedAt;
  });
}

export function ImportDialog({ file, onClose }: { file: File; onClose(): void }) {
  const [step, setStep] = useState<Step>({ kind: 'working', message: t('import.reading') });
  // Le PDF ouvert vit aussi longtemps que la boîte de dialogue (rendu compris), pas une étape.
  const openPdf = useRef<LoadedPdf | null>(null);
  useEffect(() => () => void openPdf.current?.destroy(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const prepared = await prepareImport({ name: file.name, bytes: await file.arrayBuffer() });
      if (cancelled) return;
      if (prepared.kind === 'pdf') {
        openPdf.current = prepared.pdf;
        return setStep({ kind: 'pdf', prepared });
      }
      if (prepared.assessment.level !== 'normal') return setStep({ kind: 'confirm-size', prepared });
      setStep({ kind: 'working', message: t('import.processing') });
      await applyBackground(await finalizeImageImport(repository, prepared));
      if (!cancelled) onClose();
    })().catch((error: unknown) => !cancelled && setStep({ kind: 'error', message: messageOf(error) }));
    return () => {
      cancelled = true;
    };
  }, [file, onClose]);

  const run = (message: string, action: () => Promise<ImportedBackground>) => {
    setStep({ kind: 'working', message });
    action()
      .then(applyBackground)
      .then(onClose, (error: unknown) => setStep({ kind: 'error', message: messageOf(error) }));
  };

  if (step.kind === 'working') {
    return (
      <Modal open title={t('import.title')} onClose={() => undefined}>
        <p role="status" className="flex items-center gap-2">
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent"
            aria-hidden
          />
          {step.message}
        </p>
      </Modal>
    );
  }

  if (step.kind === 'error') {
    return (
      <Modal
        open
        title={t('import.error.title')}
        onClose={onClose}
        footer={<Button onClick={onClose}>{t('common.close')}</Button>}
      >
        <p role="alert" className="flex gap-2 text-red-800">
          <FileWarning size={18} className="shrink-0" aria-hidden />
          {step.message}
        </p>
      </Modal>
    );
  }

  if (step.kind === 'confirm-size') {
    const { header, assessment, file: source } = step.prepared;
    const dangerous = assessment.level === 'dangerous';
    return (
      <Modal
        open
        title={t(dangerous ? 'import.size.dangerous.title' : 'import.size.large.title')}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose} autoFocus>
              {t('common.cancel')}
            </Button>
            <Button
              variant={dangerous ? 'danger' : 'primary'}
              onClick={() =>
                run(t('import.processing'), () => finalizeImageImport(repository, step.prepared))
              }
            >
              {t('import.size.continue')}
            </Button>
          </>
        }
      >
        <SizeDetails
          width={header.width}
          height={header.height}
          fileBytes={source.bytes.byteLength}
          assessment={assessment}
        />
      </Modal>
    );
  }

  return (
    <PdfPagePicker
      prepared={step.prepared}
      onCancel={onClose}
      onCreate={(page, dpi) =>
        run(t('import.rendering', { page, dpi }), () =>
          finalizePdfImport(repository, step.prepared, page, dpi),
        )
      }
    />
  );
}

function SizeDetails({
  width,
  height,
  fileBytes,
  assessment,
}: {
  width: number;
  height: number;
  fileBytes?: number;
  assessment: SizeAssessment;
}) {
  const dangerous = assessment.level === 'dangerous';
  const rows: [string, string][] = [
    [t('import.size.width'), `${formatInteger(width)} px`],
    [t('import.size.height'), `${formatInteger(height)} px`],
    [t('import.size.megapixels'), formatMegapixels(assessment.megapixels)],
    ...(fileBytes !== undefined
      ? ([[t('import.size.fileSize'), formatBytes(fileBytes)]] as [string, string][])
      : []),
    [t('import.size.memory'), formatBytes(assessment.decodedBytes)],
  ];
  return (
    <div className="space-y-3" data-testid="size-warning">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-slate-50 p-3">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-slate-500">{label}</dt>
            <dd className="font-medium tabular-nums text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>
      <ul className={`space-y-1 ${dangerous ? 'text-red-800' : 'text-amber-800'}`}>
        {assessment.reasons.map((reason) => (
          <li key={reason} className="flex gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
            {t(`import.size.reason.${reason}`, { limit: formatInteger(LIMITS[reason]) })}
          </li>
        ))}
      </ul>
      <p className="text-slate-600">{t('import.size.noCompression')}</p>
    </div>
  );
}

const MAX_THUMBNAILS = 24;

function PdfPagePicker({
  prepared,
  onCancel,
  onCreate,
}: {
  prepared: Extract<PreparedImport, { kind: 'pdf' }>;
  onCancel(): void;
  onCreate(page: number, dpi: number): void;
}) {
  const { pdf } = prepared;
  const [page, setPage] = useState(1);
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [pageSize, setPageSize] = useState<{ widthPt: number; heightPt: number } | null>(null);
  const [dpi, setDpi] = useState<number>(150);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let p = 1; p <= Math.min(pdf.pageCount, MAX_THUMBNAILS) && !cancelled; p++) {
        const url = await pdf.thumbnail(p, 160);
        if (!cancelled) setThumbnails((current) => ({ ...current, [p]: url }));
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  useEffect(() => {
    let cancelled = false;
    void pdf.pageSize(page).then((size) => {
      if (cancelled) return;
      setPageSize(size);
      setDpi(defaultPdfDpi(size.widthPt, size.heightPt));
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  const output = pageSize ? pdfPagePixelSize(pageSize.widthPt, pageSize.heightPt, dpi) : null;
  const assessment = output ? assessImageSize(output.width, output.height) : null;

  return (
    <Modal
      open
      wide
      title={t('import.pdf.title')}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button
            variant={assessment?.level === 'dangerous' ? 'danger' : 'primary'}
            disabled={!output}
            onClick={() => onCreate(page, dpi)}
          >
            {t('import.pdf.create')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-slate-600">
        {prepared.file.name} · {tPlural('import.pdf.pageCount', pdf.pageCount)} ·{' '}
        {formatBytes(prepared.file.bytes.byteLength)}
      </p>
      <div
        role="radiogroup"
        aria-label={t('import.pdf.title')}
        className="grid max-h-72 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6"
      >
        {Array.from({ length: Math.min(pdf.pageCount, MAX_THUMBNAILS) }, (_, i) => i + 1).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={p === page}
            onClick={() => setPage(p)}
            className={`flex flex-col items-center gap-1 rounded-md border p-1.5 text-xs ${p === page ? 'border-accent ring-2 ring-accent' : 'border-slate-200 hover:border-slate-400'}`}
          >
            <span className="flex h-24 w-full items-center justify-center bg-slate-100">
              {thumbnails[p] && <img src={thumbnails[p]} alt="" className="max-h-24 max-w-full" />}
            </span>
            {t('import.pdf.page', { page: p })}
          </button>
        ))}
      </div>
      {pdf.pageCount > MAX_THUMBNAILS && (
        <p className="mt-2 text-xs text-slate-500">
          {t('import.pdf.thumbnailsLimited', { count: MAX_THUMBNAILS })}
        </p>
      )}
      {pdf.pageCount > MAX_THUMBNAILS && (
        <label className="mt-2 block">
          <span className="mr-2">{t('import.pdf.page', { page: '' })}</span>
          <input
            type="number"
            min={1}
            max={pdf.pageCount}
            value={page}
            onChange={(e) => setPage(Math.min(pdf.pageCount, Math.max(1, Number(e.target.value) || 1)))}
            className="w-20 rounded border border-slate-300 px-2 py-1"
          />
        </label>
      )}
      <label className="mt-4 block">
        <span className="mb-1 block font-medium text-slate-800">{t('import.pdf.dpi')}</span>
        <select
          value={dpi}
          onChange={(e) => setDpi(Number(e.target.value))}
          className="rounded-md border border-slate-300 bg-white px-3 py-2"
        >
          {PDF_DPI_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {t('import.pdf.dpiOption', { dpi: choice })}
            </option>
          ))}
        </select>
      </label>
      {output && assessment && (
        <div className="mt-3 space-y-2">
          <p className="font-medium text-slate-800" data-testid="pdf-output-size">
            {t('import.pdf.result', {
              width: formatInteger(output.width),
              height: formatInteger(output.height),
              mp: formatMegapixels(assessment.megapixels),
            })}
          </p>
          {assessment.level !== 'normal' && (
            <SizeDetails width={output.width} height={output.height} assessment={assessment} />
          )}
        </div>
      )}
      <p className="mt-3 text-slate-600">{t('import.pdf.keep')}</p>
    </Modal>
  );
}
