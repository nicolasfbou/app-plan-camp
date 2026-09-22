import type Konva from 'konva';
import { useEffect, useRef } from 'react';
import { Circle, Ellipse, Layer, Line, Rect, Transformer } from 'react-konva';
import { isDisplayed, isEditable } from '@/domain/model/operations.ts';
import { geometryBox, segmentMidpoints, worldVertices } from '@/domain/model/shapes.ts';
import type { PlanObject } from '@/domain/model/types.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { usePlanStore } from '@/store/planStore.ts';
import { editActions } from './editActions.ts';

const ACCENT = '#2563eb';
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const ALL_ANCHORS = [...CORNERS, 'top-center', 'middle-right', 'bottom-center', 'middle-left'];
/** En dessous de cette taille à l'écran, les poignées des côtés couvriraient l'objet : coins seuls. */
const SMALL_SELECTION_PX = 40;

/** Plus petit côté, en pixels écran, du rectangle englobant les objets (rotation ignorée). */
function smallestSide(objects: PlanObject[], scale: number): number {
  if (!objects.length) return Infinity;
  const boxes = objects.map((o) => geometryBox(o.geometry));
  const width = Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x));
  const height = Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y));
  return Math.min(width, height) * scale;
}

/**
 * Couche physique « overlay » : cadre et poignées de sélection (un ou plusieurs objets), sommets
 * éditables, forme en cours de création, rectangle de sélection. Toujours au-dessus des objets :
 * aucun objet ne peut passer devant ces contrôles.
 *
 * Les objets verrouillés (ou sur un calque verrouillé) ne sont jamais attachés au Transformer :
 * ils ne peuvent donc pas être entraînés par le déplacement d'une sélection. Ils sont signalés
 * par un simple cadre pointillé.
 */
export function SelectionLayer({ scale }: { scale: number }) {
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const vertexEditing = useEditorStore((s) => s.vertexEditing);
  const selectedVertex = useEditorStore((s) => s.selectedVertex);
  const editingTextId = useEditorStore((s) => s.editingTextId);
  const draft = useEditorStore((s) => s.draft);
  const marquee = useEditorStore((s) => s.marquee);
  // Hors de l'outil Sélection, le cadre de transformation est retiré (pas de conflit avec le dessin).
  const selectTool = useEditorStore((s) => s.tool === 'select');
  const doc = usePlanStore((s) => s.doc);
  const transformer = useRef<Konva.Transformer>(null);
  const lockedFrames = useRef<Konva.Rect[]>([]);

  const selected: PlanObject[] = doc
    ? selectedIds
        .map((id) => doc.objects[id])
        .filter((o): o is PlanObject => Boolean(o) && isDisplayed(doc, o!))
    : [];
  const movable = doc ? selected.filter((o) => isEditable(doc, o)) : [];
  const locked = doc ? selected.filter((o) => !isEditable(doc, o)) : [];
  const single = selected.length === 1 ? selected[0]! : null;
  const hasVertices = single?.geometry.kind === 'polygon' || single?.geometry.kind === 'polyline';
  const showVertices = Boolean(single && vertexEditing && hasVertices);
  const singleEditable = Boolean(single && movable.length === 1);
  const px = 1 / scale; // 1 pixel écran, en pixels image
  const movableKey = movable.map((o) => `${o.id}:${o.updatedAt}`).join('|');

  // Rattache le Transformer aux nœuds sélectionnés modifiables (recherchés dans « content »).
  useEffect(() => {
    const tr = transformer.current;
    const stage = tr?.getStage();
    if (!tr || !stage) return;
    const attachable = selectTool && !showVertices ? movable.filter((o) => o.id !== editingTextId) : [];
    // Un objet seul et verrouillé garde un cadre (sans poignées) pour montrer qu'il est sélectionné.
    const framed =
      attachable.length === 0 && selectTool && single && !showVertices && editingTextId !== single.id
        ? [single]
        : attachable;
    tr.nodes(framed.map((o) => stage.findOne(`#${o.id}`)).filter((n): n is Konva.Node => Boolean(n)));
    tr.getLayer()?.batchDraw();
    // movableKey résume la liste et les versions des objets déplaçables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movableKey, selectTool, showVertices, editingTextId, single?.id]);

  // Cadres pointillés des objets verrouillés d'une sélection multiple.
  useEffect(() => {
    const stage = transformer.current?.getStage();
    lockedFrames.current.forEach((frame, i) => {
      const node = stage?.findOne(`#${locked[i]?.id}`);
      if (!node) return;
      const box = node.getClientRect({ relativeTo: stage as unknown as Konva.Container });
      frame.setAttrs(box);
    });
  });

  const isText = single?.type === 'text';
  const multi = movable.length > 1;
  // Coins seuls : texte ; sélection multiple (une poignée de côté déformerait en biais un objet
  // tourné, ce que le modèle ne sait pas représenter) ; petit objet (le glisser depuis son centre
  // doit le DÉPLACER, pas le redimensionner par une poignée qui le recouvre).
  const cornersOnly = isText || multi || smallestSide(movable, scale) < SMALL_SELECTION_PX;

  return (
    <Layer name="overlay">
      <Transformer
        ref={transformer}
        flipEnabled={false}
        ignoreStroke
        keepRatio={isText || multi}
        enabledAnchors={cornersOnly ? CORNERS : ALL_ANCHORS}
        resizeEnabled={singleEditable || multi}
        rotateEnabled={singleEditable || multi}
        borderDash={movable.length === 0 ? [4, 4] : undefined}
        borderStroke={ACCENT}
        anchorStroke={ACCENT}
        anchorFill="#ffffff"
        anchorSize={9}
        rotateAnchorOffset={24}
        rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
        rotationSnapTolerance={4}
        boundBoxFunc={(oldBox, newBox) =>
          Math.abs(newBox.width) < 2 || Math.abs(newBox.height) < 2 ? oldBox : newBox
        }
      />

      {multi &&
        locked.map((o, i) => (
          <Rect
            key={o.id}
            ref={(node) => {
              if (node) lockedFrames.current[i] = node;
            }}
            stroke="#b45309"
            strokeWidth={1.5 * px}
            dash={[4 * px, 3 * px]}
            listening={false}
          />
        ))}

      {showVertices &&
        single &&
        segmentMidpoints(single).map(({ afterIndex, point }) => (
          <Circle
            key={`m${afterIndex}`}
            name="midpoint-handle"
            x={point.x}
            y={point.y}
            radius={4.5 * px}
            fill={ACCENT}
            opacity={0.55}
            stroke="#ffffff"
            strokeWidth={1.5 * px}
            hitStrokeWidth={8 * px}
            draggable={singleEditable}
            onPointerDown={(e) => {
              e.cancelBubble = true;
            }}
            // Glisser un « + » insère un sommet à cet endroit (une seule action avec le glisser).
            onDragStart={() => editActions.beginInsertVertex(single.id, afterIndex, point)}
            onDragMove={(e) => editActions.moveVertex(single.id, afterIndex + 1, e.target.position())}
            onDragEnd={() => editActions.endVertexDrag()}
          />
        ))}

      {showVertices &&
        single &&
        worldVertices(single).map((p, index) => (
          <Circle
            key={`v${index}`}
            name="vertex-handle"
            x={p.x}
            y={p.y}
            radius={6 * px}
            fill={selectedVertex === index ? ACCENT : '#ffffff'}
            stroke={ACCENT}
            strokeWidth={2 * px}
            hitStrokeWidth={10 * px}
            draggable={singleEditable}
            onPointerDown={(e) => {
              e.cancelBubble = true;
              useEditorStore.getState().setSelectedVertex(index);
            }}
            onDragStart={() => editActions.beginVertexDrag()}
            onDragMove={(e) => editActions.moveVertex(single.id, index, e.target.position())}
            onDragEnd={() => editActions.endVertexDrag()}
          />
        ))}

      {marquee && (
        <Rect
          name="marquee"
          x={Math.min(marquee.start.x, marquee.end.x)}
          y={Math.min(marquee.start.y, marquee.end.y)}
          width={Math.abs(marquee.end.x - marquee.start.x)}
          height={Math.abs(marquee.end.y - marquee.start.y)}
          fill="rgba(37, 99, 235, 0.08)"
          stroke={ACCENT}
          strokeWidth={1 * px}
          dash={[4 * px, 3 * px]}
          listening={false}
        />
      )}

      {draft?.kind === 'box' &&
        (() => {
          const x = Math.min(draft.start.x, draft.end.x);
          const y = Math.min(draft.start.y, draft.end.y);
          const width = Math.abs(draft.end.x - draft.start.x);
          const height = Math.abs(draft.end.y - draft.start.y);
          const common = {
            stroke: ACCENT,
            strokeWidth: 2 * px,
            dash: [6 * px, 4 * px],
            fill: 'rgba(37, 99, 235, 0.12)',
            listening: false,
          };
          return draft.tool === 'ellipse' ? (
            <Ellipse
              {...common}
              x={x + width / 2}
              y={y + height / 2}
              radiusX={width / 2}
              radiusY={height / 2}
            />
          ) : (
            <Rect
              {...common}
              x={x}
              y={y}
              width={width}
              height={height}
              cornerRadius={draft.tool === 'roundedRect' ? Math.min(width, height) * 0.15 : 0}
            />
          );
        })()}

      {draft?.kind === 'path' && (
        <>
          <Line
            points={[...draft.points, ...(draft.cursor ? [draft.cursor] : [])].flatMap((p) => [p.x, p.y])}
            closed={draft.tool === 'polygon' && draft.points.length >= 2}
            stroke={ACCENT}
            strokeWidth={2 * px}
            dash={[6 * px, 4 * px]}
            fill={draft.tool === 'polygon' ? 'rgba(37, 99, 235, 0.12)' : undefined}
            listening={false}
          />
          {draft.points.map((p, i) => (
            <Circle key={i} x={p.x} y={p.y} radius={4 * px} fill={ACCENT} listening={false} />
          ))}
        </>
      )}
    </Layer>
  );
}
