import { useEffect } from 'react';
import { Layer, Stage } from 'react-konva';
import { t } from '@/i18n/index.ts';
import { usePlanStore } from '@/store/planStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { NON_INTERACTIVE_LAYERS, STAGE_LAYERS } from './renderTiers.ts';
import { useElementSize } from './useElementSize.ts';

/**
 * Zone de travail. Le Stage applique le viewport (projet → écran) ; tout ce qui est dessiné
 * dans les couches est exprimé en coordonnées image.
 */
export function CanvasStage() {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const viewport = useViewportStore((s) => s.viewport);
  const setStageSize = useViewportStore((s) => s.setStageSize);
  const hasPlan = usePlanStore((s) => s.doc !== null);

  useEffect(() => setStageSize(size), [size, setStageSize]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-canvas"
      role="region"
      aria-label={t('canvas.label')}
      data-testid="canvas-container"
    >
      {size.width > 0 && size.height > 0 && (
        <Stage
          width={size.width}
          height={size.height}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
          x={viewport.x}
          y={viewport.y}
        >
          {STAGE_LAYERS.map((name) => (
            <Layer key={name} name={name} listening={!NON_INTERACTIVE_LAYERS.has(name)} />
          ))}
        </Stage>
      )}
      {!hasPlan && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
          <div className="max-w-md rounded-lg border border-slate-300 bg-white/90 p-6 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-slate-800">{t('canvas.empty.title')}</h2>
            <p className="mt-2 text-sm text-slate-600">{t('canvas.empty.body')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
