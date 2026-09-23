/**
 * Export groupé : à partir du même plan, un PDF par vue (réunis dans une archive .zip), ou un seul
 * PDF d'une page par vue. Chaque page suit exactement les réglages de sa vue.
 */
import { Files, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { downloadBytes } from '@/app/download.ts';
import { t } from '@/i18n/index.ts';
import { Toggle } from '@/panels/fields.tsx';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import type { ExportSource } from '../exportPlan.ts';
import { batchExport, type BatchMode } from '../batch.ts';

export function BatchExportDialog({ source, onClose }: { source: ExportSource; onClose(): void }) {
  const views = source.doc.plan.views;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(views.map((v) => v.id)));
  const [includeBase, setIncludeBase] = useState(views.length === 0);
  const [mode, setMode] = useState<BatchMode>('separate');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; warnings: string[] } | null>(null);
  const ids: (string | null)[] = [
    ...(includeBase ? [null] : []),
    ...views.filter((v) => selected.has(v.id)).map((v) => v.id),
  ];

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await batchExport(source, ids, mode);
      downloadBytes(r.bytes, r.fileName, r.mimeType);
      setResult({
        ok: true,
        message: t('batch.done', { count: ids.length, file: r.fileName }),
        warnings: r.warnings,
      });
    } catch (e) {
      setResult({
        ok: false,
        message: t('print.exportError', { message: e instanceof Error ? e.message : String(e) }),
        warnings: [],
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      title={t('batch.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('print.close')}</Button>
          <Button
            variant="primary"
            disabled={busy || ids.length === 0}
            onClick={() => void run()}
            data-testid="batch-export"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Files size={16} />}
            {busy ? t('print.exporting') : t('batch.export', { count: ids.length })}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="batch-dialog">
        <p className="text-sm text-slate-600">{t('batch.help')}</p>
        {views.length === 0 && <p className="text-sm text-amber-800">{t('batch.noViews')}</p>}
        <ul className="space-y-1">
          <li>
            <Toggle label={t('views.base')} checked={includeBase} onChange={setIncludeBase} />
          </li>
          {views.map((v) => (
            <li key={v.id}>
              <Toggle
                label={v.name}
                checked={selected.has(v.id)}
                onChange={(on) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (on) next.add(v.id);
                    else next.delete(v.id);
                    return next;
                  })
                }
              />
            </li>
          ))}
        </ul>
        <fieldset className="space-y-1">
          <legend className="text-xs font-semibold text-slate-600">{t('batch.mode')}</legend>
          {(['separate', 'combined'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="batch-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
                className="accent-accent"
              />
              {t(`batch.mode.${m}`)}
            </label>
          ))}
        </fieldset>
        {result && (
          <div
            role="status"
            data-testid="batch-result"
            className={result.ok ? 'text-emerald-800' : 'text-red-700'}
          >
            <p>{result.message}</p>
            {result.warnings.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-amber-900">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
