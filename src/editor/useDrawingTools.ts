/**
 * Outils de création sur le canevas. Toutes les positions sont converties en coordonnées image
 * (`screenToImage`) : la géométrie créée ne dépend jamais du zoom ni de la taille de la fenêtre.
 *
 * - Rectangle, rectangle arrondi, ellipse : cliquer-glisser (Maj = carré / cercle).
 * - Ligne : cliquer-glisser, ou deux clics.
 * - Polygone, polyligne : un clic par sommet ; double clic ou Entrée pour terminer, Échap pour annuler,
 *   Retour arrière pour retirer le dernier sommet ; clic sur le premier sommet pour fermer un polygone.
 * - Circulation véhicules, corridor piéton : comme la polyligne (le tracé suit exactement les clics).
 * - Pictogramme : un clic place le pictogramme choisi dans la bibliothèque.
 * - Texte, étiquette : un clic, puis saisie directe.
 * Après création, l'objet est sélectionné et l'outil Sélection est réactivé.
 */
import Konva from 'konva';
import { expandGroups } from '@/domain/model/multi.ts';
import { isDisplayed, isEditable } from '@/domain/model/operations.ts';
import { type RefObject, useEffect } from 'react';
import {
  createAreaObject,
  createCorridorObject,
  createFlowObject,
  createIconObject,
  createLineObject,
  createTextObject,
} from '@/domain/model/objectFactory.ts';
import { assetIdOf, findSymbol, isAssetSymbol } from '@/domain/symbols/catalog.ts';
import type { Point } from '@/domain/model/types.ts';
import { screenToImage } from '@/domain/viewport/viewport.ts';
import { type DrawingTool, type Draft, useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { editActions } from './editActions.ts';

/** Taille minimale d'une forme glissée, en pixels écran (en dessous : clic accidentel ignoré). */
const MIN_DRAG_PX = 4;
/** Distance écran pour « cliquer sur le premier sommet » / double clic. */
const SNAP_PX = 10;

const scale = () => useViewportStore.getState().viewport.scale;

function imagePoint(element: HTMLElement, e: { clientX: number; clientY: number }): Point {
  const rect = element.getBoundingClientRect();
  return screenToImage(useViewportStore.getState().viewport, {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  });
}

function screenDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * scale();
}

function constrain(start: Point, end: Point, square: boolean): Point {
  if (!square) return end;
  const size = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
  return {
    x: start.x + Math.sign(end.x - start.x || 1) * size,
    y: start.y + Math.sign(end.y - start.y || 1) * size,
  };
}

/** Termine la forme en cours (polygone, polyligne, ligne en deux clics). */
export function finishPathDraft(): void {
  const editor = useEditorStore.getState();
  const draft = editor.draft;
  const doc = planStore.getState().doc;
  if (!draft || draft.kind !== 'path' || !doc) return;
  const points = draft.points;
  editor.setDraft(null);
  if (draft.tool === 'flow') {
    if (points.length >= 2)
      editActions.create(
        createFlowObject(doc, points, editor.flowCategory, scale()),
        'Créer un trajet de véhicules',
      );
  } else if (draft.tool === 'corridor') {
    if (points.length >= 2)
      editActions.create(createCorridorObject(doc, points, scale()), 'Créer un corridor piéton');
  } else if (draft.tool === 'polygon') {
    if (points.length >= 3)
      editActions.create(
        createAreaObject(doc, { kind: 'polygon', points }, editor.presetId, scale()),
        'Créer un polygone',
      );
  } else if (points.length >= 2) {
    editActions.create(
      createLineObject(doc, { kind: 'polyline', curved: false, points }, scale()),
      draft.tool === 'line' ? 'Créer une ligne' : 'Créer une polyligne',
    );
  }
}

function createBox(draft: Extract<Draft, { kind: 'box' }>): void {
  const doc = planStore.getState().doc;
  if (!doc) return;
  const x = Math.min(draft.start.x, draft.end.x);
  const y = Math.min(draft.start.y, draft.end.y);
  const width = Math.abs(draft.end.x - draft.start.x);
  const height = Math.abs(draft.end.y - draft.start.y);
  if (Math.max(width, height) * scale() < MIN_DRAG_PX) return;
  const presetId = useEditorStore.getState().presetId;
  const object =
    draft.tool === 'ellipse'
      ? createAreaObject(
          doc,
          { kind: 'ellipse', cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2 },
          presetId,
          scale(),
        )
      : createAreaObject(
          doc,
          {
            kind: 'rect',
            x,
            y,
            width,
            height,
            cornerRadius: draft.tool === 'roundedRect' ? Math.min(width, height) * 0.15 : 0,
          },
          presetId,
          scale(),
        );
  editActions.create(object, draft.tool === 'ellipse' ? 'Créer une ellipse' : 'Créer un rectangle');
}

/** Rectangle de sélection : suit le pointeur, puis sélectionne les objets qu'il touche. */
function startMarquee(element: HTMLElement, stage: Konva.Stage, start: Point, additive: boolean): void {
  const editor = useEditorStore.getState();
  editor.setMarquee({ start, end: start });
  const onMove = (ev: PointerEvent) => {
    if (useEditorStore.getState().marquee) editor.setMarquee({ start, end: imagePoint(element, ev) });
  };
  const detach = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  const onCancel = () => {
    detach();
    editor.setMarquee(null);
  };
  const onUp = (ev: PointerEvent) => {
    detach();
    const marquee = useEditorStore.getState().marquee;
    editor.setMarquee(null);
    if (!marquee) return; // annulé entre-temps (2e doigt, Échap)
    const end = imagePoint(element, ev);
    if (screenDistance(start, end) < MIN_DRAG_PX) {
      if (!additive) editor.select(null); // simple clic dans le vide
      return;
    }
    const doc = planStore.getState().doc;
    if (!doc) return;
    const s = useViewportStore.getState().viewport;
    const box = {
      x: Math.min(start.x, end.x) * s.scale + s.x,
      y: Math.min(start.y, end.y) * s.scale + s.y,
      width: Math.abs(end.x - start.x) * s.scale,
      height: Math.abs(end.y - start.y) * s.scale,
    };
    const hits = stage
      .find('.plan-object')
      .filter((node) => node.isVisible() && Konva.Util.haveIntersection(box, node.getClientRect()))
      .map((node) => node.id())
      .filter((id) => {
        const object = doc.objects[id];
        return object !== undefined && isEditable(doc, object) && isDisplayed(doc, object);
      });
    const ids = expandGroups(doc, hits);
    if (additive) editor.select([...editor.selectedIds, ...ids]);
    else editor.select(ids);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

export function useDrawingTools(stageRef: RefObject<Konva.Stage | null>, enabled: boolean): void {
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !enabled) return;
    const element = stage.container();

    const onPointerDown = (e: Konva.KonvaEventObject<PointerEvent>) => {
      const editor = useEditorStore.getState();
      const tool = editor.tool;
      if (e.evt.button !== 0) return;

      // Outil Sélection, dans le vide : clic = désélection ; glisser = rectangle de sélection
      // (Maj : ajoute à la sélection). Seuls les objets modifiables et affichés sont retenus.
      if (tool === 'select') {
        if (e.target !== stage) return;
        startMarquee(element, stage, imagePoint(element, e.evt), e.evt.shiftKey);
        return;
      }
      if (tool === 'hand') return;
      const at = imagePoint(element, e.evt);
      const drawing = tool as DrawingTool;

      if (drawing === 'text' || drawing === 'label') {
        const doc = planStore.getState().doc;
        if (!doc) return;
        const fontSize = Math.max(4, Math.round((drawing === 'label' ? 18 : 22) / scale()));
        const object = createTextObject(doc, at, {
          label: drawing === 'label',
          text: drawing === 'label' ? 'Étiquette' : 'Texte',
          fontSize,
        });
        // Empêche le clic de retirer le focus du champ de saisie qui va s'ouvrir.
        e.evt.preventDefault();
        if (editActions.create(object, drawing === 'label' ? 'Créer une étiquette' : 'Créer un texte')) {
          setTimeout(() => useEditorStore.getState().setEditingText(object.id), 0);
        }
        return;
      }

      if (drawing === 'symbol') {
        const doc = planStore.getState().doc;
        if (!doc) return;
        const symbolId = editor.symbolId;
        const name = isAssetSymbol(symbolId)
          ? (doc.assets[assetIdOf(symbolId)]?.name ?? 'Pictogramme')
          : (findSymbol(symbolId)?.name ?? 'Pictogramme');
        editActions.create(createIconObject(doc, at, symbolId, name, scale()), 'Placer un pictogramme');
        return;
      }

      if (drawing === 'rect' || drawing === 'roundedRect' || drawing === 'ellipse') {
        editor.setDraft({ kind: 'box', tool: drawing, start: at, end: at });
        const onMove = (ev: PointerEvent) => {
          const d = useEditorStore.getState().draft;
          if (d?.kind === 'box')
            editor.setDraft({ ...d, end: constrain(d.start, imagePoint(element, ev), ev.shiftKey) });
        };
        const detach = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
        };
        // Geste interrompu par le système : rien n'est créé.
        const onCancel = () => {
          detach();
          useEditorStore.getState().setDraft(null);
        };
        // Si la forme a été annulée entre-temps (2e doigt, Échap), le brouillon est vide : rien n'est créé.
        const onUp = (ev: PointerEvent) => {
          detach();
          const d = useEditorStore.getState().draft;
          useEditorStore.getState().setDraft(null);
          if (d?.kind === 'box')
            createBox({ ...d, end: constrain(d.start, imagePoint(element, ev), ev.shiftKey) });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        return;
      }

      // Polygone, polyligne, ligne.
      const current = editor.draft;
      if (current?.kind === 'path' && current.tool === drawing) {
        const last = current.points.at(-1)!;
        const first = current.points[0]!;
        const closesPolygon =
          drawing === 'polygon' && current.points.length >= 3 && screenDistance(at, first) <= SNAP_PX;
        const repeatsLast = screenDistance(at, last) <= SNAP_PX / 2; // 2e clic d'un double clic
        if (closesPolygon || repeatsLast) return finishPathDraft();
        editor.setDraft({ ...current, points: [...current.points, at] });
        if (drawing === 'line') finishPathDraft();
        return;
      }
      editor.setDraft({ kind: 'path', tool: drawing, points: [at], cursor: at });
      if (drawing === 'line') {
        // Cliquer-glisser : la ligne est créée au relâchement si on a glissé.
        const onCancel = () => {
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          useEditorStore.getState().setDraft(null);
        };
        const onUp = (ev: PointerEvent) => {
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          const end = imagePoint(element, ev);
          const d = useEditorStore.getState().draft;
          if (d?.kind === 'path' && d.tool === 'line' && screenDistance(end, at) > MIN_DRAG_PX) {
            useEditorStore.getState().setDraft({ ...d, points: [at, end] });
            finishPathDraft();
          }
        };
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
      }
    };

    const onPointerMove = (e: Konva.KonvaEventObject<PointerEvent>) => {
      const draft = useEditorStore.getState().draft;
      if (draft?.kind === 'path')
        useEditorStore.getState().setDraft({ ...draft, cursor: imagePoint(element, e.evt) });
    };

    stage.on('pointerdown.drawing', onPointerDown);
    stage.on('pointermove.drawing', onPointerMove);
    return () => {
      stage.off('.drawing');
    };
  }, [stageRef, enabled]);
}
