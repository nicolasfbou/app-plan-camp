/**
 * Analyse visuelle des croisements entre trajets de véhicules et corridors piétons. Aide à la
 * planification seulement : la détection est géométrique et ne certifie rien.
 */
import { AlertTriangle, CheckCircle2, Eye, RotateCcw } from 'lucide-react';
import { setCrossingReview } from '@/domain/model/crossings.ts';
import { type CrossingView, useCrossings } from '@/editor/crossings.ts';
import { viewportActions } from '@/editor/viewportActions.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { Section, TextField, Toggle } from './fields.tsx';
import { ReadabilityPanel } from './ReadabilityPanel.tsx';

const STATUS_CLASS: Record<CrossingView['status'], string> = {
  open: 'bg-amber-100 text-amber-900',
  vigilance: 'bg-red-100 text-red-800',
  verified: 'bg-slate-200 text-slate-700',
};

export function AnalysisPanel() {
  const doc = usePlanStore((s) => s.doc);
  const show = useEditorStore((s) => s.showCrossings);
  const showVerified = useEditorStore((s) => s.showVerifiedCrossings);
  const selectedKey = useEditorStore((s) => s.selectedCrossing);
  const crossings = useCrossings();
  if (!doc) return null;
  const listed = crossings.filter((c) => showVerified || c.status !== 'verified');
  const hidden = crossings.length - listed.length;
  const selected = crossings.find((c) => c.key === selectedKey) ?? null;
  const name = (id: string) => doc.objects[id]?.name ?? '?';

  const review = (
    c: CrossingView,
    patch: { status?: CrossingView['status']; note?: string },
    label: string,
    merge?: boolean,
  ) =>
    planStore
      .getState()
      .update(
        label,
        (d) => void setCrossingReview(d, c, patch),
        merge ? { mergeKey: `crossing-note:${c.key}` } : undefined,
      );

  return (
    <div className="space-y-3 text-sm" data-testid="analysis-panel">
      <ReadabilityPanel />
      <h3 className="border-t border-slate-200 pt-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {t('analysis.crossingsTitle')}
      </h3>
      <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900" data-testid="analysis-disclaimer">
        <AlertTriangle size={14} className="mr-1 inline" aria-hidden />
        {t('analysis.disclaimer')}
      </p>
      <Toggle
        label={t('analysis.show')}
        checked={show}
        onChange={(v) => useEditorStore.getState().setShowCrossings(v)}
      />
      <Toggle
        label={t('analysis.showVerified')}
        checked={showVerified}
        onChange={(v) => useEditorStore.getState().setShowVerifiedCrossings(v)}
      />
      <p className="text-xs text-slate-600" data-testid="crossing-count">
        {t('analysis.count', { count: crossings.length })}
        {hidden > 0 && ` · ${t('analysis.hiddenCount', { count: hidden })}`}
      </p>

      {listed.length > 0 && (
        <ul className="space-y-1" aria-label={t('analysis.list')}>
          {listed.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                data-testid="crossing-item"
                aria-pressed={c.key === selectedKey}
                onClick={() => {
                  useEditorStore.getState().setShowCrossings(true);
                  useEditorStore.getState().selectCrossing(c.key);
                  viewportActions.centerOn(c.point);
                }}
                className={`w-full rounded-md border px-2 py-1.5 text-left ${
                  c.key === selectedKey ? 'border-accent ring-1 ring-accent' : 'border-slate-200 bg-white'
                }`}
              >
                <span className="block truncate font-medium text-slate-800">
                  {name(c.flowId)} × {name(c.corridorId)}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-xs">
                  <span className={`rounded px-1.5 ${STATUS_CLASS[c.status]}`}>
                    {t(`analysis.status.${c.status}`)}
                  </span>
                  <span className="text-slate-500">{t(`analysis.kind.${c.kind}`)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <Section title={t('analysis.selected')}>
          <p className="text-xs text-slate-600" data-testid="crossing-details">
            {name(selected.flowId)} × {name(selected.corridorId)} · {t(`analysis.kind.${selected.kind}`)} ·{' '}
            {t(`analysis.status.${selected.status}`)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={selected.status === 'vigilance'}
              onClick={() => review(selected, { status: 'vigilance' }, 'Point de vigilance')}
            >
              <Eye size={16} /> {t('analysis.markVigilance')}
            </Button>
            <Button
              disabled={selected.status === 'verified'}
              onClick={() => review(selected, { status: 'verified' }, 'Croisement vérifié')}
            >
              <CheckCircle2 size={16} /> {t('analysis.markVerified')}
            </Button>
            {selected.status !== 'open' && (
              <Button onClick={() => review(selected, { status: 'open' }, 'Croisement rouvert')}>
                <RotateCcw size={16} /> {t('analysis.reopen')}
              </Button>
            )}
          </div>
          <TextField
            label={t('analysis.note')}
            multiline
            value={selected.review?.note ?? ''}
            onChange={(note) => review(selected, { note }, 'Note du croisement', true)}
          />
        </Section>
      )}
    </div>
  );
}
