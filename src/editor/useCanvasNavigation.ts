/**
 * Navigation « comme Google Maps » sur la zone de travail. Ne modifie QUE le viewport :
 * aucune donnée du projet n'est touchée.
 *
 * - Molette de souris : zoom autour du curseur. Pincement trackpad (ctrl+molette) : zoom fin.
 * - Défilement à deux doigts du trackpad : déplacement.
 * - Glisser avec l'outil main, avec le bouton du milieu, ou avec Espace maintenu : déplacement.
 * - Écran tactile : un doigt déplace, deux doigts zooment (pincement).
 * Les mises à jour sont regroupées par image d'animation pour rester fluides.
 */
import { type RefObject, useEffect } from 'react';
import type { Point } from '@/domain/model/types.ts';
import { type Viewport, interpretWheel, panBy, pinch, zoomAt } from '@/domain/viewport/viewport.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function useCanvasNavigation(containerRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const element = containerRef.current;
    if (!element || !enabled) return;

    // Viewport « en cours » : appliqué au store au plus une fois par image d'animation.
    let target: Viewport | null = null;
    let frame = 0;
    const current = () => target ?? useViewportStore.getState().viewport;
    const schedule = (next: Viewport) => {
      target = next;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (target) useViewportStore.getState().setViewport(target);
        target = null;
      });
    };
    const local = (e: { clientX: number; clientY: number }): Point => {
      const rect = element.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const intent = interpretWheel(e);
      schedule(
        intent.kind === 'zoom'
          ? zoomAt(current(), local(e), intent.factor)
          : panBy(current(), intent.dx, intent.dy),
      );
    };

    // Pointeurs actifs (souris, stylet, doigts) pour le déplacement et le pincement.
    const pointers = new Map<number, Point>();
    let panning = false;
    const gesture = () => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return null;
      return {
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        distance: Math.hypot(a.x - b.x, a.y - b.y),
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      const { tool, spaceHeld } = useEditorStore.getState();
      const wantsPan =
        e.pointerType === 'touch' || e.button === 1 || (e.button === 0 && (tool === 'hand' || spaceHeld));
      if (!wantsPan) return;
      e.preventDefault();
      element.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (!panning) {
        panning = true;
        useEditorStore.getState().setPanning(true);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const previousPoint = pointers.get(e.pointerId);
      if (!previousPoint) return;
      const before = gesture();
      const point = local(e);
      pointers.set(e.pointerId, point);
      const after = gesture();
      if (before && after) schedule(pinch(current(), before, after));
      else if (pointers.size === 1)
        schedule(panBy(current(), point.x - previousPoint.x, point.y - previousPoint.y));
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
      if (pointers.size === 0) {
        panning = false;
        useEditorStore.getState().setPanning(false);
      }
    };

    // Empêche le défilement automatique du navigateur au clic du bouton du milieu.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        e.preventDefault();
        if (!e.repeat) useEditorStore.getState().setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') useEditorStore.getState().setSpaceHeld(false);
    };
    const onBlur = () => useEditorStore.getState().setSpaceHeld(false);

    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      useEditorStore.getState().setPanning(false);
    };
  }, [containerRef, enabled]);
}
