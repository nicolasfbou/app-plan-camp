import {
  CircleCheck,
  CircleDot,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Undo2,
} from 'lucide-react';
import { t } from '@/i18n/index.ts';
import { planStore, selectCanRedo, selectCanUndo, selectIsDirty, usePlanStore } from '@/store/planStore.ts';
import { useUiStore } from '@/store/uiStore.ts';
import { IconButton } from '@/ui/IconButton.tsx';

export function TopBar() {
  const planName = usePlanStore((s) => s.doc?.plan.name ?? null);
  const canUndo = usePlanStore(selectCanUndo);
  const canRedo = usePlanStore(selectCanRedo);
  const isDirty = usePlanStore(selectIsDirty);
  const { leftCollapsed, rightCollapsed, toggleLeft, toggleRight } = useUiStore();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2">
      <IconButton label={t('topbar.toggleLeft')} onClick={toggleLeft} pressed={!leftCollapsed}>
        {leftCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </IconButton>

      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800" data-testid="plan-title">
        {planName ?? <span className="font-normal text-slate-500">{t('topbar.noPlan')}</span>}
      </h1>

      {planName !== null && (
        <span
          className={`flex items-center gap-1 text-xs ${isDirty ? 'text-amber-700' : 'text-emerald-700'}`}
          role="status"
          data-testid="save-status"
        >
          {isDirty ? <CircleDot size={14} /> : <CircleCheck size={14} />}
          {isDirty ? t('save.dirty') : t('save.saved')}
        </span>
      )}

      <div className="flex items-center gap-1">
        <IconButton label={t('topbar.undo')} onClick={() => planStore.getState().undo()} disabled={!canUndo}>
          <Undo2 size={18} />
        </IconButton>
        <IconButton label={t('topbar.redo')} onClick={() => planStore.getState().redo()} disabled={!canRedo}>
          <Redo2 size={18} />
        </IconButton>
      </div>

      <IconButton label={t('topbar.toggleRight')} onClick={toggleRight} pressed={!rightCollapsed}>
        {rightCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
      </IconButton>
    </header>
  );
}
