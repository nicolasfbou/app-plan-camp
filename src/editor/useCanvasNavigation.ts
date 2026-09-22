/**
 * Navigation « comme Google Maps » sur la zone de travail. Ne modifie QUE le viewport :
 * aucune donnée du projet n'est touchée.
 *
 * - Molette de souris : zoom autour du curseur. Pincement trackpad (ctrl+molette) : zoom fin.
 * - Défilement à deux doigts du trackpad : déplacement.
 * - Glisser avec l'outil main, avec le bouton du milieu, ou avec Espace maintenu : déplacement.
 * - Écran tactile : deux doigts déplacent et zooment (pincement) ; un doigt déplace avec l'outil main,
 *   sinon il sert à l'outil actif (sélection, dessin).
 * Ces gestes sont interceptés en phase de capture, avant Konva : ils ne déplacent jamais un objet.
 * Les mises à jour sont regroupées par image d'animation pour rester fluides.
 */
import { type RefObject, useEffect } from 'react';
import type { Point } from '@/domain/model/types.ts';
import { type Viewport, interpretWheel, panBy, pinch, zoomAt } from '@/domain/viewport/viewport.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';

/**
 * Espace sert au déplacement seulement quand le focus n'est sur aucun contrôle (sinon Espace doit
 * activer le bouton, cocher la case, etc.) et qu'aucune boîte de dialogue n'est ouverte.
 */
function spaceMeansPan(target: EventTarget | null, element: HTMLElement): boolean {
  if (document.querySelector('dialog[open]')) return false;
  if (!(target instanceof HTMLElement)) return true;
  return target === document.body || target === element || element.contains(target);
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

    // Doigts posés (écran tactile) : deux doigts = pincement / déplacement, quel que soit l'outil.
    const touches = new Map<number, Point>();

    const startPan = (e: PointerEvent) => {
      // Intercepté AVANT Konva (phase de capture) : aucun objet ne sera déplacé par ce geste.
      e.stopPropagation();
      e.preventDefault();
      element.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (!panning) {
        panning = true;
        useEditorStore.getState().setPanning(true);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const { tool, spaceHeld } = useEditorStore.getState();
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, local(e));
        if (touches.size >= 2) {
          // Deuxième doigt : on bascule en pincement avec les deux doigts.
          for (const [id, point] of touches) pointers.set(id, point);
          return startPan(e);
        }
        if (tool === 'hand') return startPan(e);
        return;
      }
      if (e.button === 1 || (e.button === 0 && (tool === 'hand' || spaceHeld))) startPan(e);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, local(e));
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
      touches.delete(e.pointerId);
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
      if (e.code === 'Space' && spaceMeansPan(e.target, element)) {
        e.preventDefault();
        if (!e.repeat) useEditorStore.getState().setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') useEditorStore.getState().setSpaceHeld(false);
    };
    const onBlur = () => useEditorStore.getState().setSpaceHeld(false);

    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('pointerdown', onPointerDown, { capture: true });
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
      element.removeEventListener('pointerdown', onPointerDown, { capture: true });
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
