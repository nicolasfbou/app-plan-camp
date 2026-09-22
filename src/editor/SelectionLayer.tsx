import type Konva from 'konva';
import { useEffect, useRef } from 'react';
import { Circle, Ellipse, Layer, Line, Rect, Transformer } from 'react-konva';
import { isDisplayed, isEditable } from '@/domain/model/operations.ts';
import { worldVertices } from '@/domain/model/shapes.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { usePlanStore } from '@/store/planStore.ts';
import { editActions } from './editActions.ts';

const ACCENT = '#2563eb';

/**
 * Couche physique « overlay » : cadre et poignées de sélection, sommets éditables, forme en cours
 * de création. Toujours au-dessus des objets : aucun objet ne peut passer devant ces contrôles.
 */
export function SelectionLayer({ scale }: { scale: number }) {
  const selectedId = useEditorStore((s) => s.selectedId);
  const vertexEditing = useEditorStore((s) => s.vertexEditing);
  const editingTextId = useEditorStore((s) => s.editingTextId);
  const draft = useEditorStore((s) => s.draft);
  // Hors de l'outil Sélection, le cadre de transformation est retiré (pas de conflit avec le dessin).
  const selectTool = useEditorStore((s) => s.tool === 'select');
  const object = usePlanStore((s) => (selectedId ? s.doc?.objects[selectedId] : undefined));
  const editable = usePlanStore((s) => (object && s.doc ? isEditable(s.doc, object) : false));
  const displayed = usePlanStore((s) => (object && s.doc ? isDisplayed(s.doc, object) : false));
  const transformer = useRef<Konva.Transformer>(null);

  const hasVertices = object?.geometry.kind === 'polygon' || object?.geometry.kind === 'polyline';
  const showVertices = Boolean(object && displayed && vertexEditing && hasVertices);
  const px = 1 / scale; // 1 pixel écran, en pixels image

  // Rattache le Transformer au nœud sélectionné (recherché par identifiant dans la couche « content »).
  useEffect(() => {
    const tr = transformer.current;
    if (!tr) return;
    const node =
      selectTool && selectedId && displayed && !showVertices && editingTextId !== selectedId
        ? tr.getStage()?.findOne(`#${selectedId}`)
        : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, object, displayed, showVertices, editingTextId, selectTool]);

  const isText = object?.type === 'text';

  return (
    <Layer name="overlay">
      <Transformer
        ref={transformer}
        flipEnabled={false}
        ignoreStroke
        keepRatio={isText}
        enabledAnchors={
          isText
            ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
            : [
                'top-left',
                'top-center',
                'top-right',
                'middle-right',
                'bottom-right',
                'bottom-center',
                'bottom-left',
                'middle-left',
              ]
        }
        resizeEnabled={editable}
        rotateEnabled={editable}
        borderDash={editable ? undefined : [4, 4]}
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

      {showVertices &&
        object &&
        worldVertices(object).map((p, index) => (
          <Circle
            key={index}
            name="vertex-handle"
            x={p.x}
            y={p.y}
            radius={6 * px}
            fill="#ffffff"
            stroke={ACCENT}
            strokeWidth={2 * px}
            hitStrokeWidth={10 * px}
            draggable={editable}
            onPointerDown={(e) => {
              e.cancelBubble = true;
            }}
            onDragStart={() => editActions.beginVertexDrag()}
            onDragMove={(e) => editActions.moveVertex(object.id, index, e.target.position())}
            onDragEnd={() => editActions.endVertexDrag()}
          />
        ))}

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
