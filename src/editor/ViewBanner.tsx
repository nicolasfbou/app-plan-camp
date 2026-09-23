/** Rappel de la vue par public affichée : le plan est filtré, pas modifié. */
import { Eye } from 'lucide-react';
import { viewFilter } from '@/domain/print/views.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';

export function ViewBanner() {
  const viewId = useEditorStore((s) => s.activeViewId);
  const doc = usePlanStore((s) => s.doc);
  const view = viewId ? doc?.plan.views.find((v) => v.id === viewId) : undefined;
  if (!doc || !view) return null;
  const f = viewFilter(doc, view.id);
  const hidden = Object.values(doc.objects).filter(
    (o) => f.hiddenLayers.has(o.layerId) || f.hiddenObjects.has(o.id),
  ).length;
  return (
    <div
      role="status"
      data-testid="view-banner"
      className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-sm text-sky-900 shadow"
    >
      <Eye size={16} aria-hidden />
      <span>
        {t('views.banner', { name: view.name })} {t('views.hiddenCount', { count: hidden })}
      </span>
      <Button onClick={() => useEditorStore.getState().setActiveView(null)}>{t('views.showBase')}</Button>
    </div>
  );
}
