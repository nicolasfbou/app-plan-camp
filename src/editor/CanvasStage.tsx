import { useEffect } from 'react';
import { Group, Layer, Stage } from 'react-konva';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { BackgroundLayer } from './BackgroundLayer.tsx';
import { CONTENT_GROUPS } from './renderTiers.ts';
import { useCanvasNavigation } from './useCanvasNavigation.ts';
import { useElementSize } from './useElementSize.ts';

/**
 * Zone de travail. Le Stage applique la transformation viewport (image → écran) ; tout ce qui est
 * dessiné dans les couches est exprimé en coordonnées image.
 */
export function CanvasStage() {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const viewport = useViewportStore((s) => s.viewport);
  const setStageSize = useViewportStore((s) => s.setStageSize);
  const background = useEditorStore((s) => (s.background.kind === 'ready' ? s.background.background : null));
  const panning = useEditorStore((s) => s.isPanning);
  const grabbable = useEditorStore((s) => s.tool === 'hand' || s.spaceHeld);
  const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  useEffect(() => setStageSize(size), [size, setStageSize]);
  useCanvasNavigation(containerRef, background !== null);

  const cursor = background ? (panning ? 'cursor-grabbing' : grabbable ? 'cursor-grab' : '') : '';

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full touch-none overflow-hidden bg-canvas select-none ${cursor}`}
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
          listening={false}
        >
          <BackgroundLayer background={background} scale={viewport.scale} pixelRatio={pixelRatio} />
          <Layer name="content">
            {CONTENT_GROUPS.map((tier) => (
              <Group key={tier} name={tier} />
            ))}
          </Layer>
          <Layer name="overlay" />
        </Stage>
      )}
    </div>
  );
}
