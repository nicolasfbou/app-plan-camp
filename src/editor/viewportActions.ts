/** Commandes de navigation, partagées par les boutons, les raccourcis et l'ouverture d'un plan. */
import { centerContent, fitToScreen, zoomByStep, zoomToActualSize } from '@/domain/viewport/viewport.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';

function context() {
  const { viewport, stageSize, setViewport } = useViewportStore.getState();
  const bg = useEditorStore.getState().background;
  const content = bg.kind === 'ready' ? { width: bg.background.width, height: bg.background.height } : null;
  const usable = stageSize.width > 0 && stageSize.height > 0;
  return { viewport, stageSize, setViewport, content, usable };
}

export const viewportActions = {
  zoomIn() {
    const c = context();
    if (c.usable && c.content) c.setViewport(zoomByStep(c.viewport, c.stageSize, 1));
  },
  zoomOut() {
    const c = context();
    if (c.usable && c.content) c.setViewport(zoomByStep(c.viewport, c.stageSize, -1));
  },
  fit() {
    const c = context();
    if (c.usable && c.content) c.setViewport(fitToScreen(c.content, c.stageSize));
  },
  actualSize() {
    const c = context();
    if (c.usable && c.content) c.setViewport(zoomToActualSize(c.viewport, c.stageSize));
  },
  /** Centre la vue sur un point de l'image, sans changer le zoom. */
  centerOn(point: { x: number; y: number }) {
    const c = context();
    if (!c.usable) return;
    const { scale } = c.viewport;
    c.setViewport({
      scale,
      x: c.stageSize.width / 2 - point.x * scale,
      y: c.stageSize.height / 2 - point.y * scale,
    });
  },
  /** Zoome sur une zone de l'image (pixels image), avec une marge autour. */
  zoomToBox(box: { x: number; y: number; width: number; height: number }) {
    const c = context();
    if (!c.usable) return;
    const w = Math.max(box.width, 40) * 3;
    const h = Math.max(box.height, 40) * 3;
    const scale = Math.min(4, Math.max(0.05, Math.min(c.stageSize.width / w, c.stageSize.height / h)));
    c.setViewport({
      scale,
      x: c.stageSize.width / 2 - (box.x + box.width / 2) * scale,
      y: c.stageSize.height / 2 - (box.y + box.height / 2) * scale,
    });
  },
  recenter() {
    const c = context();
    if (c.usable && c.content) c.setViewport(centerContent(c.viewport, c.content, c.stageSize));
  },
};
