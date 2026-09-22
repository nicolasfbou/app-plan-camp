import type { ReactNode } from 'react';
import { t } from '@/i18n/index.ts';
import { BackgroundPanel } from '@/panels/BackgroundPanel.tsx';
import { LayersPanel } from '@/panels/LayersPanel.tsx';
import { PropertiesPanel } from '@/panels/PropertiesPanel.tsx';
import { type RightTab, useUiStore } from '@/store/uiStore.ts';

const TABS: { id: RightTab; label: () => string; content: () => ReactNode }[] = [
  { id: 'properties', label: () => t('panel.properties'), content: () => <PropertiesPanel /> },
  { id: 'layers', label: () => t('panel.layers'), content: () => <LayersPanel /> },
  { id: 'background', label: () => t('panel.background'), content: () => <BackgroundPanel /> },
];

export function RightPanel() {
  const { rightCollapsed, rightTab, setRightTab } = useUiStore();
  if (rightCollapsed) return null;
  const active = TABS.find((tab) => tab.id === rightTab) ?? TABS[0]!;

  return (
    <aside
      className="flex h-full min-h-0 w-72 shrink-0 flex-col border-l border-slate-200 bg-panel"
      data-testid="right-panel"
    >
      <div role="tablist" className="flex border-b border-slate-200 bg-white">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={tab.id === rightTab}
            aria-controls="right-panel-content"
            onClick={() => setRightTab(tab.id)}
            className={`flex-1 px-2 py-2 text-sm font-medium ${
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
  );
}
