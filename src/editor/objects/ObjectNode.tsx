import type Konva from 'konva';
import { memo } from 'react';
import { Ellipse, Group, Line, Rect, Text } from 'react-konva';
import { geometryCenter } from '@/domain/model/shapes.ts';
import type { PlanObject } from '@/domain/model/types.ts';
import { editActions } from '../editActions.ts';
import { areaFill, dashArray, hitStrokeWidth, measureText, rgba, textFontStyle } from './konvaStyle.ts';

interface ObjectNodeProps {
  object: PlanObject;
  /** L'objet peut être déplacé / transformé (ni lui ni son calque ne sont verrouillés). */
  editable: boolean;
  /** Clics acceptés (outil Sélection, calque non verrouillé). */
  interactive: boolean;
  hidden: boolean;
  scale: number;
  onSelect(id: string): void;
  onDoubleClick(object: PlanObject): void;
}

function transformOf(node: Konva.Node) {
  return {
    x: node.x(),
    y: node.y(),
    rotation: node.rotation(),
    scaleX: node.scaleX(),
    scaleY: node.scaleY(),
  };
}

/**
 * Un objet du plan, dessiné en coordonnées image. Nœud placé au CENTRE de sa géométrie et pivoté
 * autour de ce centre ; à la fin d'un glisser ou d'une transformation, la nouvelle position,
 * rotation et échelle sont intégrées au modèle (une action), puis l'échelle du nœud revient à 1.
 */
export const ObjectNode = memo(function ObjectNode({
  object,
  editable,
  interactive,
  hidden,
  scale,
  onSelect,
  onDoubleClick,
}: ObjectNodeProps) {
  const center = geometryCenter(object.geometry);
  const { style } = object;
  const common = {
    id: object.id,
    name: 'plan-object',
    x: center.x,
    y: center.y,
    rotation: object.rotation,
    scaleX: 1,
    scaleY: 1,
    visible: !hidden,
    listening: interactive,
    draggable: interactive && editable,
    perfectDrawEnabled: false,
    onPointerDown: (e: Konva.KonvaEventObject<PointerEvent>) => {
      if (e.evt.button !== 0) return;
      e.cancelBubble = true;
      onSelect(object.id);
    },
    onDblClick: () => onDoubleClick(object),
    onDblTap: () => onDoubleClick(object),
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
      editActions.commitNodeTransform(object.id, transformOf(e.target), 'Déplacer');
    },
    onTransformEnd: (e: Konva.KonvaEventObject<Event>) => {
      const node = e.target;
      const t = transformOf(node);
      // Le modèle reçoit l'échelle intégrée ; le nœud revient à l'échelle 1.
      node.scale({ x: 1, y: 1 });
      editActions.commitNodeTransform(object.id, t, 'Transformer');
    },
  };
  const stroke = {
    stroke: rgba(style.stroke, style.strokeOpacity),
    strokeWidth: style.stroke ? style.strokeWidth : 0,
    dash: dashArray(style),
    lineCap: style.dash === 'dotted' ? ('round' as const) : ('butt' as const),
    lineJoin: 'round' as const,
  };

  const g = object.geometry;
  if (object.type === 'text') {
    const box = measureText(object);
    const label = object.label;
    return (
      <Group {...common}>
        {label && (
          <Rect
            x={-box.width / 2}
            y={-box.height / 2}
            width={box.width}
            height={box.height}
            cornerRadius={label.cornerRadius}
            fill={rgba(label.background, label.backgroundOpacity)}
            stroke={label.border ?? undefined}
            strokeWidth={label.border ? label.borderWidth : 0}
            perfectDrawEnabled={false}
          />
        )}
        <Text
          x={-box.textWidth / 2}
          y={-box.textHeight / 2}
          text={object.text || ' '}
          fontFamily={object.fontFamily}
          fontSize={object.fontSize}
          fontStyle={textFontStyle(object)}
          align={object.align}
          lineHeight={1.2}
          fill={rgba(style.fill ?? '#000000', style.fillOpacity)}
          perfectDrawEnabled={false}
        />
        {/* Zone de clic couvrant tout le bloc, même entre les lettres. */}
        <Rect
          x={-box.width / 2}
          y={-box.height / 2}
          width={box.width}
          height={box.height}
          fill="rgba(0,0,0,0)"
        />
      </Group>
    );
  }

  switch (g.kind) {
    case 'rect':
      return (
        <Rect
          {...common}
          {...stroke}
          offsetX={g.width / 2}
          offsetY={g.height / 2}
          width={g.width}
          height={g.height}
          cornerRadius={g.cornerRadius}
          fill={areaFill(style)}
        />
      );
    case 'ellipse':
      return <Ellipse {...common} {...stroke} radiusX={g.rx} radiusY={g.ry} fill={areaFill(style)} />;
    case 'polygon':
    case 'polyline': {
      const closed = g.kind === 'polygon';
      return (
        <Line
          {...common}
          {...stroke}
          offsetX={center.x}
          offsetY={center.y}
          points={g.points.flatMap((p) => [p.x, p.y])}
          closed={closed}
          fill={closed ? areaFill(style) : undefined}
          hitStrokeWidth={hitStrokeWidth(style.strokeWidth, scale)}
        />
      );
    }
    default:
      return null;
  }
});
