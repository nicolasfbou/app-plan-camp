import { TentTree } from 'lucide-react';
import { t } from '@/i18n/index.ts';
import { useUiStore } from '@/store/uiStore.ts';

export function LeftSidebar() {
  const collapsed = useUiStore((s) => s.leftCollapsed);
  if (collapsed) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-sidebar text-slate-200" data-testid="left-sidebar">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <TentTree size={22} className="text-white" aria-hidden />
        <div>
          <div className="text-base font-semibold text-white">{t('app.name')}</div>
          <div className="text-xs text-slate-400">{t('app.tagline')}</div>
        </div>
      </div>
      <section className="px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('tools.title')}</h2>
        <p className="mt-2 text-sm text-slate-400">{t('tools.empty')}</p>
      </section>
    </aside>
  );
}
