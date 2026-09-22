import { Hand, TentTree } from 'lucide-react';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { useUiStore } from '@/store/uiStore.ts';
import { routeHref } from './router.ts';

/** Barre latérale foncée. Dans l'éditeur, elle contient les outils réellement disponibles. */
export function LeftSidebar({ showTools }: { showTools: boolean }) {
  const collapsed = useUiStore((s) => s.leftCollapsed);
  const tool = useEditorStore((s) => s.tool);
  if (collapsed) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-sidebar text-slate-200" data-testid="left-sidebar">
      <a
        href={routeHref({ name: 'camps' })}
        className="flex items-center gap-2 border-b border-white/10 px-4 py-3"
      >
        <TentTree size={22} className="text-white" aria-hidden />
        <div>
          <div className="text-base font-semibold text-white">{t('app.name')}</div>
          <div className="text-xs text-slate-400">{t('app.tagline')}</div>
        </div>
      </a>
      <nav className="px-2 py-2">
        <a
          href={routeHref({ name: 'camps' })}
          className="block rounded-md px-3 py-2 text-sm hover:bg-white/10"
        >
          {t('nav.camps')}
        </a>
      </nav>
      {showTools && (
        <section className="border-t border-white/10 px-4 py-3">
          <h2 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">{t('tools.title')}</h2>
          <button
            type="button"
            aria-pressed={tool === 'hand'}
            title={t('tools.hand.tooltip')}
            className="mt-2 flex w-full items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm text-white"
          >
            <Hand size={16} aria-hidden /> {t('tools.hand')}
          </button>
          <p className="mt-2 text-xs text-slate-400">{t('tools.hint')}</p>
          <p className="mt-3 text-xs text-slate-500">{t('tools.empty')}</p>
        </section>
      )}
    </aside>
  );
}
