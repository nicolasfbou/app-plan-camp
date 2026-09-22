import {
  AlertTriangle,
  ChevronRight,
  Download,
  CircleCheck,
  CircleDot,
  ImageUp,
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
import { Button } from '@/ui/Button.tsx';
import { IconButton } from '@/ui/IconButton.tsx';
import { routeHref } from './router.ts';

interface TopBarProps {
  siteId?: string;
  siteName?: string;
  saveError?: string | null;
  onRename?(): void;
  onImport?(): void;
  onExport?(): void;
}

export function TopBar({ siteId, siteName, saveError = null, onRename, onImport, onExport }: TopBarProps) {
  const planName = usePlanStore((s) => s.doc?.plan.name ?? null);
  const hasBackground = usePlanStore((s) => s.doc?.plan.baseImage != null);
  const canUndo = usePlanStore(selectCanUndo);
  const canRedo = usePlanStore(selectCanRedo);
  const isDirty = usePlanStore(selectIsDirty);
  const { leftCollapsed, rightCollapsed, toggleLeft, toggleRight } = useUiStore();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2">
      <IconButton label={t('topbar.toggleLeft')} onClick={toggleLeft} pressed={!leftCollapsed}>
        {leftCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </IconButton>

      <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Fil d’Ariane">
        <a href={routeHref({ name: 'camps' })} className="shrink-0 text-slate-500 hover:underline">
          {t('nav.camps')}
        </a>
        {siteId && siteName && (
          <>
            <ChevronRight size={14} className="shrink-0 text-slate-400" aria-hidden />
            <a
              href={routeHref({ name: 'camp', siteId })}
              className="max-w-48 shrink-0 truncate text-slate-500 hover:underline"
            >
              {siteName}
            </a>
          </>
        )}
        <ChevronRight size={14} className="shrink-0 text-slate-400" aria-hidden />
        <h1 className="min-w-0 truncate font-semibold text-slate-800" data-testid="plan-title">
          {planName === null ? (
            <span className="font-normal text-slate-500">{t('topbar.noPlan')}</span>
          ) : onRename ? (
            <button
              type="button"
              title={t('topbar.renamePlan')}
              onClick={onRename}
              className="truncate hover:underline"
            >
              {planName}
            </button>
          ) : (
            planName
          )}
        </h1>
      </nav>

      {planName !== null && (
        <span
          className={`flex shrink-0 items-center gap-1 text-xs ${saveError ? 'text-red-700' : isDirty ? 'text-amber-700' : 'text-emerald-700'}`}
          role="status"
          title={saveError ? t('save.error', { message: saveError }) : undefined}
          data-testid="save-status"
        >
          {saveError ? (
            <AlertTriangle size={14} />
          ) : isDirty ? (
            <CircleDot size={14} />
          ) : (
            <CircleCheck size={14} />
          )}
          {isDirty || saveError ? t('save.dirty') : t('save.saved')}
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

      {onImport && planName !== null && (
        <Button onClick={onImport}>
          <ImageUp size={16} /> {hasBackground ? t('topbar.replace') : t('topbar.import')}
        </Button>
      )}

      {onExport && planName !== null && (
        <Button onClick={onExport}>
          <Download size={16} /> {t('campplan.export')}
        </Button>
      )}

      <IconButton label={t('topbar.toggleRight')} onClick={toggleRight} pressed={!rightCollapsed}>
        {rightCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
      </IconButton>
    </header>
  );
}
