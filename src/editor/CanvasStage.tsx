import Konva from 'konva';
import { useEffect, useRef } from 'react';
import { Stage } from 'react-konva';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { BackgroundLayer } from './BackgroundLayer.tsx';
import { ObjectsLayer } from './objects/ObjectsLayer.tsx';
import { SelectionLayer } from './SelectionLayer.tsx';
import { useCanvasNavigation } from './useCanvasNavigation.ts';
import { useDrawingTools } from './useDrawingTools.ts';
import { useElementSize } from './useElementSize.ts';

// Un clic légèrement tremblé ne doit pas devenir un déplacement (ni une action d'historique).
Konva.dragDistance = 3;

/**
 * Zone de travail. Le Stage applique la transformation viewport (image → écran) ; tout ce qui est
 * dessiné dans les 3 couches physiques (fond, contenu, surcouche) est en coordonnées image.
 */
export function CanvasStage() {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const stageRef = useRef<Konva.Stage>(null);
  const viewport = useViewportStore((s) => s.viewport);
  const setStageSize = useViewportStore((s) => s.setStageSize);
  const background = useEditorStore((s) => (s.background.kind === 'ready' ? s.background.background : null));
  const panning = useEditorStore((s) => s.isPanning);
  const tool = useEditorStore((s) => s.tool);
  const spaceHeld = useEditorStore((s) => s.spaceHeld);
  const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const ready = background !== null && size.width > 0;

  useEffect(() => setStageSize(size), [size, setStageSize]);
  useCanvasNavigation(containerRef, background !== null);
  useDrawingTools(stageRef, ready);

  const cursor = !background
    ? ''
    : panning
      ? 'cursor-grabbing'
      : tool === 'hand' || spaceHeld
        ? 'cursor-grab'
        : tool === 'select'
          ? ''
          : 'cursor-crosshair';

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full touch-none overflow-hidden bg-canvas select-none ${cursor}`}
      role="region"
      aria-label={t('canvas.label')}
      data-testid="canvas-container"
      data-tool={tool}
    >
      {size.width > 0 && size.height > 0 && (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
          x={viewport.x}
          y={viewport.y}
        >
          <BackgroundLayer background={background} scale={viewport.scale} pixelRatio={pixelRatio} />
          <ObjectsLayer scale={viewport.scale} />
          <SelectionLayer scale={viewport.scale} />
        </Stage>
      )}
    </div>
  );
}
