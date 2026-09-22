import { t } from '@/i18n/index.ts';
import { usePlanStore } from '@/store/planStore.ts';

/** Phase 1 : liste en lecture seule des calques du plan. La gestion arrive en phase 3. */
export function LayersPanel() {
  const layers = usePlanStore((s) => s.doc?.layers ?? null);
  if (!layers) return <p className="text-sm text-slate-500">{t('panel.layers.empty')}</p>;
  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {[...layers].reverse().map((layer) => (
          <li key={layer.id} className="rounded px-2 py-1 text-sm text-slate-700">
            {layer.name}
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">{t('panel.layers.readonly')}</p>
    </div>
  );
}
