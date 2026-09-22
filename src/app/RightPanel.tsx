import { t } from '@/i18n/index.ts';
import { type RightTab, useUiStore } from '@/store/uiStore.ts';

const TABS: { id: RightTab; label: () => string; empty: () => string }[] = [
  { id: 'properties', label: () => t('panel.properties'), empty: () => t('panel.properties.empty') },
  { id: 'layers', label: () => t('panel.layers'), empty: () => t('panel.layers.empty') },
];

export function RightPanel() {
  const { rightCollapsed, rightTab, setRightTab } = useUiStore();
  if (rightCollapsed) return null;
  const active = TABS.find((tab) => tab.id === rightTab) ?? TABS[0]!;

  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-l border-slate-200 bg-panel"
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
            className={`flex-1 px-3 py-2 text-sm font-medium ${
              tab.id === rightTab
                ? 'border-b-2 border-accent text-accent'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label()}
          </button>
        ))}
      </div>
      <div id="right-panel-content" role="tabpanel" aria-labelledby={`tab-${active.id}`} className="p-4">
        <p className="text-sm text-slate-500">{active.empty()}</p>
      </div>
    </aside>
  );
}
