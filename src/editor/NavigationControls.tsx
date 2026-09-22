import type { ReactNode } from 'react';
import { Crosshair, Maximize, Minus, Plus } from 'lucide-react';
import { t } from '@/i18n/index.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { viewportActions } from './viewportActions.ts';

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-8 min-w-8 items-center justify-center px-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

/** Contrôles de navigation compacts, en bas à droite de la zone de travail. */
export function NavigationControls() {
  const scale = useViewportStore((s) => s.viewport.scale);
  return (
    <div
      className="absolute right-3 bottom-3 flex items-center divide-x divide-slate-200 overflow-hidden rounded-md border border-slate-300 bg-white shadow-sm"
      data-testid="navigation-controls"
    >
      <ControlButton label={t('navctl.zoomOut')} onClick={viewportActions.zoomOut}>
        <Minus size={16} />
      </ControlButton>
      <span
        className="w-14 text-center text-xs tabular-nums text-slate-700"
        aria-label={t('navctl.zoomLevel')}
        data-testid="zoom-level"
      >
        {Math.round(scale * 100)} %
      </span>
      <ControlButton label={t('navctl.zoomIn')} onClick={viewportActions.zoomIn}>
        <Plus size={16} />
      </ControlButton>
      <ControlButton label={t('navctl.fit')} onClick={viewportActions.fit}>
        <Maximize size={16} />
      </ControlButton>
      <ControlButton label={t('navctl.actualSize')} onClick={viewportActions.actualSize}>
        1:1
      </ControlButton>
      <ControlButton label={t('navctl.recenter')} onClick={viewportActions.recenter}>
        <Crosshair size={16} />
      </ControlButton>
    </div>
  );
}
