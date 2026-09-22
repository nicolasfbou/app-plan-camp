import { CheckCircle2, Download, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { formatBytes, formatMegapixels } from '@/domain/image/sizeAssessment.ts';
import type { BaseImageRef } from '@/domain/model/types.ts';
import { formatDateTime, formatInteger, t } from '@/i18n/index.ts';
import { verifyStoredBlob } from '@/import/importBackground.ts';
import { usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';

const FORMAT_LABELS: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'application/pdf': 'PDF',
};

type Verification =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok' }
  | { state: 'mismatch' | 'missing' }
  | { state: 'error'; message: string };

/** Télécharge des octets stockés tels quels, sans conversion. */
async function downloadStored(blobId: string, fileName: string, mimeType: string) {
  const stored = await repository.getBlob(blobId);
  if (!stored) throw new Error(t('bg.verify.missing'));
  const url = URL.createObjectURL(new Blob([stored.bytes], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Field({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-sm text-slate-900 ${mono ? 'font-mono text-xs break-all' : 'break-words'}`}>
        {children}
      </dd>
    </div>
  );
}

export function BackgroundPanel() {
  const ref = usePlanStore((s) => s.doc?.plan.baseImage ?? null);
  if (!ref) return <p className="text-sm text-slate-500">{t('bg.empty')}</p>;
  return <BackgroundDetails key={ref.blobId} image={ref} />;
}

function BackgroundDetails({ image }: { image: BaseImageRef }) {
  const [verification, setVerification] = useState<Verification>({ state: 'idle' });
  const source = image.source;

  const verify = async () => {
    setVerification({ state: 'running' });
    try {
      const main = await verifyStoredBlob(repository, image.blobId, image.sha256);
      const pdf =
        source.kind === 'pdf' ? await verifyStoredBlob(repository, source.pdfBlobId, source.pdfSha256) : main;
      const failed = !main.ok ? main : !pdf.ok ? pdf : null;
      setVerification(failed && !failed.ok ? { state: failed.reason } : { state: 'ok' });
    } catch (error) {
      setVerification({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
  const download = (blobId: string, fileName: string, mimeType: string) =>
    downloadStored(blobId, fileName, mimeType).catch((error: unknown) =>
      setVerification({ state: 'error', message: error instanceof Error ? error.message : String(error) }),
    );

  return (
    <div className="space-y-4" data-testid="background-panel">
      <p className="flex gap-2 rounded-md bg-slate-100 p-2 text-xs text-slate-600">
        <Lock size={14} className="mt-0.5 shrink-0" aria-hidden />
        {t('bg.locked')}
      </p>
      <dl className="space-y-2">
        <Field label={t('bg.fileName')}>{image.fileName}</Field>
        <Field label={t('bg.format')}>{FORMAT_LABELS[image.mimeType] ?? image.mimeType}</Field>
        <Field label={t('bg.dimensions')}>
          <span data-testid="bg-dimensions">
            {formatInteger(image.width)} × {formatInteger(image.height)} px
          </span>
        </Field>
        <Field label={t('bg.megapixels')}>{formatMegapixels((image.width * image.height) / 1e6)}</Field>
        <Field label={t('bg.fileSize')}>{formatBytes(image.byteLength)}</Field>
        <Field label={t('bg.orientation')}>
          {image.exifOrientation === 1
            ? t('bg.orientation.none')
            : t('bg.orientation.value', { value: image.exifOrientation })}
        </Field>
        <Field label={t('bg.importedAt')}>{formatDateTime(image.importedAt)}</Field>
        <Field label={t('bg.sha256')} mono>
          <span data-testid="bg-sha256">{image.sha256}</span>
        </Field>
      </dl>

      {source.kind === 'pdf' && (
        <dl className="space-y-2 border-t border-slate-200 pt-3" data-testid="bg-pdf-source">
          <p className="text-xs text-slate-600">{t('bg.renderedFromPdf')}</p>
          <Field label={t('bg.pdfSource')}>{source.pdfFileName}</Field>
          <Field label={t('bg.pdfPage')}>
            {t('bg.pdfPage', { page: source.page, count: source.pageCount })}
          </Field>
          <Field label={t('bg.pdfDpi')}>{t('import.pdf.dpiOption', { dpi: source.dpi })}</Field>
          <Field label={t('bg.pdfSize')}>{formatBytes(source.pdfByteLength)}</Field>
          <Field label={t('bg.pdfSha256')} mono>
            {source.pdfSha256}
          </Field>
        </dl>
      )}

      <div className="space-y-2 border-t border-slate-200 pt-3">
        <Button className="w-full" onClick={() => void verify()} disabled={verification.state === 'running'}>
          <ShieldCheck size={16} />
          {verification.state === 'running' ? t('bg.verify.running') : t('bg.verify')}
        </Button>
        {verification.state === 'ok' && (
          <p role="status" className="flex gap-2 text-xs text-emerald-700" data-testid="integrity-ok">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden />
            {t('bg.verify.ok')}
          </p>
        )}
        {verification.state === 'error' && (
          <p role="alert" className="flex gap-2 text-xs text-red-700">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
            {verification.message}
          </p>
        )}
        {(verification.state === 'mismatch' || verification.state === 'missing') && (
          <p role="alert" className="flex gap-2 text-xs text-red-700">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
            {t(verification.state === 'mismatch' ? 'bg.verify.mismatch' : 'bg.verify.missing')}
          </p>
        )}
        <Button
          className="w-full"
          onClick={() => void download(image.blobId, image.fileName, image.mimeType)}
        >
          <Download size={16} /> {t('bg.download')}
        </Button>
        {source.kind === 'pdf' && (
          <Button
            className="w-full"
            onClick={() => void download(source.pdfBlobId, source.pdfFileName, 'application/pdf')}
          >
            <Download size={16} /> {t('bg.downloadPdf')}
          </Button>
        )}
      </div>
    </div>
  );
}
