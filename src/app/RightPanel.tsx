import type { ReactNode } from 'react';
import { t } from '@/i18n/index.ts';
import { AnalysisPanel } from '@/panels/AnalysisPanel.tsx';
import { BackgroundPanel } from '@/panels/BackgroundPanel.tsx';
import { LayersPanel } from '@/panels/LayersPanel.tsx';
import { PropertiesPanel } from '@/panels/PropertiesPanel.tsx';
import { RevisionsPanel } from '@/revisions/RevisionsPanel.tsx';
import { type RightTab, useUiStore } from '@/store/uiStore.ts';

const TABS: { id: RightTab; label: () => string; content: () => ReactNode }[] = [
  { id: 'properties', label: () => t('panel.properties'), content: () => <PropertiesPanel /> },
  { id: 'layers', label: () => t('panel.layers'), content: () => <LayersPanel /> },
  { id: 'analysis', label: () => t('panel.analysis'), content: () => <AnalysisPanel /> },
  { id: 'revisions', label: () => t('panel.revisions'), content: () => <RevisionsPanel /> },
  { id: 'background', label: () => t('panel.background'), content: () => <BackgroundPanel /> },
];

export function RightPanel() {
  const { rightCollapsed, rightTab, setRightTab, toggleRight } = useUiStore();
  if (rightCollapsed) return null;
  const active = TABS.find((tab) => tab.id === rightTab) ?? TABS[0]!;

  return (
    <>
      {/* Téléphone : le panneau recouvre le plan ; toucher à côté le referme. */}
      <button
        type="button"
        aria-label={t('topbar.closePanel')}
        onClick={toggleRight}
        className="absolute inset-0 z-20 bg-slate-900/30 md:hidden"
      />
      <aside
        className="flex h-full min-h-0 w-72 shrink-0 flex-col border-l border-slate-200 bg-panel max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-80 max-md:max-w-[90vw] max-md:shadow-xl"
        data-testid="right-panel"
      >
        <div role="tablist" className="flex overflow-x-auto border-b border-slate-200 bg-white">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={tab.id === rightTab}
              aria-controls="right-panel-content"
              onClick={() => setRightTab(tab.id)}
              className={`flex-1 shrink-0 px-1.5 py-2 text-xs font-medium whitespace-nowrap ${
                tab.id === rightTab
                  ? 'border-b-2 border-accent text-accent'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label()}
            </button>
          ))}
        </div>
        <div
          id="right-panel-content"
          role="tabpanel"
          aria-labelledby={`tab-${active.id}`}
          className="min-h-0 flex-1 overflow-y-auto p-4"
        >
          {active.content()}
        </div>
      </aside>
    </>
  );
}
