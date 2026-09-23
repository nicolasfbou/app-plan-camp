import type Konva from 'konva';
import { memo } from 'react';
import { Ellipse, Group, Image as KImage, Line, Rect, Shape, Text } from 'react-konva';
import { bandOutline } from '@/domain/model/paths.ts';
import { geometryCenter } from '@/domain/model/shapes.ts';
import type { DisplaySettings, PlanObject, Style, SymbolAsset } from '@/domain/model/types.ts';
import { editActions } from '../editActions.ts';
import {
  displayedSymbolSize,
  drawCorridorIcons,
  drawFlowArrows,
  drawZoneBadge,
  hatchPattern,
  type ViewBox,
} from './decorations.ts';
import { areaFill, dashArray, hitStrokeWidth, measureText, rgba, textFontStyle } from './konvaStyle.ts';
import { symbolBitmap, symbolImage } from './symbolImages.ts';
import { useViewportStore } from '@/store/viewportStore.ts';

interface ObjectNodeProps {
  object: PlanObject;
  /** L'objet peut être déplacé / transformé (ni lui ni son calque ne sont verrouillés). */
  editable: boolean;
  /** Clics acceptés (outil Sélection, calque non verrouillé). */
  interactive: boolean;
  hidden: boolean;
  scale: number;
  /** Limites d'affichage des repères répétés (flèches, pictogrammes). */
  display: DisplaySettings;
  /** Pictogrammes importés du plan. */
  assets: Readonly<Record<string, SymbolAsset>>;
  /** Change quand une image de pictogramme vient d'être chargée (redessin). */
  imagesVersion: number;
  onSelect(id: string, additive: boolean): void;
  onDoubleClick(object: PlanObject): void;
}

/** Image posée dans un carré de côté `size` centré, proportions d'origine conservées. */
function fitInSquare(image: HTMLImageElement, size: number) {
  const w = image.naturalWidth || 1;
  const h = image.naturalHeight || 1;
  const width = size * Math.min(1, w / h);
  const height = size * Math.min(1, h / w);
  return { x: -width / 2, y: -height / 2, width, height };
}

/** Remplissage d'une surface : couleur, ou motif de hachures (taille du motif en pixels image). */
function areaFillProps(style: Style) {
  const pattern = hatchPattern(style);
  if (!pattern) return { fill: areaFill(style) };
  const cell = Math.max(style.strokeWidth * 5, 6) / 32;
  return {
    fill: areaFill(style),
    fillPatternImage: pattern as unknown as HTMLImageElement,
    fillPatternRepeat: 'repeat',
    fillPatternScale: { x: cell, y: cell },
    fillPriority: 'pattern',
  };
}

/**
 * Contexte 2D natif d'une forme Konva, échelle absolue (zoom compris) au moment du dessin et zone
 * visible de la scène exprimée dans le repère de la forme (pour ne pas dessiner hors écran).
 */
function native(ctx: Konva.Context, shape: Konva.Shape) {
  const stage = shape.getStage();
  let view: ViewBox | null = null;
  if (stage) {
    const inverse = shape.getAbsoluteTransform().copy().invert();
    const corners = [
      inverse.point({ x: 0, y: 0 }),
      inverse.point({ x: stage.width(), y: 0 }),
      inverse.point({ x: 0, y: stage.height() }),
      inverse.point({ x: stage.width(), y: stage.height() }),
    ];
    view = {
      minX: Math.min(...corners.map((p) => p.x)),
      minY: Math.min(...corners.map((p) => p.y)),
      maxX: Math.max(...corners.map((p) => p.x)),
      maxY: Math.max(...corners.map((p) => p.y)),
    };
  }
  return { c: ctx._context, scale: Math.abs(shape.getAbsoluteScale().x) || 1, view };
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
  display,
  assets,
  onSelect,
  onDoubleClick,
}: ObjectNodeProps) {
  // Pictogramme placé : taille affichée bornée à l'écran (limites du plan). Le nœud n'est
  // re-rendu au zoom que si la limite s'applique (sinon la valeur ne change pas).
  const iconSize = useViewportStore((s) =>
    object.type === 'icon' ? displayedSymbolSize(object.size, s.viewport.scale, display) : 0,
  );
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
      onSelect(object.id, e.evt.shiftKey);
    },
    onDragStart: () => editActions.beginNodeGesture('Déplacer'),
    onTransformStart: () => editActions.beginNodeGesture('Transformer'),
    onDblClick: () => onDoubleClick(object),
    onDblTap: () => onDoubleClick(object),
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
      // Le Transformer déplace avec lui tous les nœuds sélectionnés, mais seul le nœud tiré
      // signale la fin du glisser : on enregistre la position de chacun (une seule action).
      const transformerNodes = e.target.getStage()?.findOne<Konva.Transformer>('Transformer')?.nodes() ?? [];
      const moved = transformerNodes.includes(e.target) ? transformerNodes : [e.target];
      if (editActions.isGestureCancelled()) {
        e.target.position(center); // geste annulé : l'objet revient à sa position enregistrée
        return;
      }
      for (const node of moved) editActions.commitNodeTransform(node.id(), transformOf(node), 'Déplacer');
    },
    onTransformEnd: (e: Konva.KonvaEventObject<Event>) => {
      const node = e.target;
      const t = transformOf(node);
      if (object.type === 'icon' && (Math.abs(t.scaleX - 1) > 1e-6 || Math.abs(t.scaleY - 1) > 1e-6)) {
        // Pictogramme affiché à une taille bornée : l'échelle s'applique à la taille AFFICHÉE.
        const k = iconSize / object.size;
        t.scaleX *= k;
        t.scaleY *= k;
      }
      // Le modèle reçoit l'échelle intégrée ; le nœud revient à l'échelle 1.
      node.scale({ x: 1, y: 1 });
      if (editActions.isGestureCancelled()) {
        node.position(center);
        node.rotation(object.rotation);
        return;
      }
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

  if (object.type === 'flow' && g.kind === 'polyline') {
    return (
      <Group {...common} offsetX={center.x} offsetY={center.y}>
        <Line
          {...stroke}
          points={g.points.flatMap((p) => [p.x, p.y])}
          hitStrokeWidth={hitStrokeWidth(style.strokeWidth, scale)}
          perfectDrawEnabled={false}
        />
        <Shape
          listening={false}
          sceneFunc={(ctx, shape) => {
            const { c, scale: s, view } = native(ctx, shape);
            drawFlowArrows(c, { ...object, geometry: g }, s, display, view);
          }}
        />
      </Group>
    );
  }

  if (object.type === 'corridor' && g.kind === 'polyline') {
    const outline = bandOutline(g.points, object.width);
    const image = object.showIcons
      ? symbolBitmap(object.iconsOriented ? 'mark.footprints' : 'mark.walker', null, assets)
      : null;
    return (
      <Group {...common} offsetX={center.x} offsetY={center.y}>
        <Line
          {...stroke}
          points={outline.flatMap((p) => [p.x, p.y])}
          closed
          lineJoin="miter"
          {...areaFillProps(style)}
          perfectDrawEnabled={false}
        />
        {image && (
          <Shape
            listening={false}
            sceneFunc={(ctx, shape) => {
              const { c, scale: s, view } = native(ctx, shape);
              drawCorridorIcons(c, g.points, object, object.rotation, s, display, image, view);
            }}
          />
        )}
      </Group>
    );
  }

  if (object.type === 'icon') {
    const image = symbolImage(object.symbolId, object.text, assets);
    const size = iconSize;
    return (
      <Group {...common} opacity={style.fillOpacity}>
        {image ? (
          <KImage image={image} {...fitInSquare(image, size)} />
        ) : (
          // Pictogramme en cours de chargement ou introuvable : emplacement visible et sélectionnable.
          <Rect
            x={-size / 2}
            y={-size / 2}
            width={size}
            height={size}
            cornerRadius={size * 0.15}
            fill="rgba(148, 163, 184, 0.5)"
            stroke="#475569"
            strokeWidth={size / 24}
            dash={[size / 8, size / 12]}
          />
        )}
      </Group>
    );
  }

  const fillProps = areaFillProps(style);
  const badge =
    object.type === 'zone' && (object.icon || object.showName)
      ? {
          icon: object.icon,
          image: object.icon ? symbolBitmap(object.icon.symbolId, null, assets) : null,
          name: object.showName ? object.name : null,
        }
      : null;
  const area = (placement: 'node' | 'child') => {
    const base = placement === 'node' ? common : {};
    switch (g.kind) {
      case 'rect':
        return placement === 'node' ? (
          <Rect
            {...base}
            {...stroke}
            offsetX={g.width / 2}
            offsetY={g.height / 2}
            width={g.width}
            height={g.height}
            cornerRadius={g.cornerRadius}
            {...fillProps}
          />
        ) : (
          <Rect
            {...stroke}
            x={-g.width / 2}
            y={-g.height / 2}
            width={g.width}
            height={g.height}
            cornerRadius={g.cornerRadius}
            {...fillProps}
          />
        );
      case 'ellipse':
        return <Ellipse {...base} {...stroke} radiusX={g.rx} radiusY={g.ry} {...fillProps} />;
      case 'polygon':
      case 'polyline': {
        const closed = g.kind === 'polygon';
        return (
          <Line
            {...base}
            {...stroke}
            offsetX={center.x}
            offsetY={center.y}
            points={g.points.flatMap((p) => [p.x, p.y])}
            closed={closed}
            {...(closed ? fillProps : {})}
            hitStrokeWidth={hitStrokeWidth(style.strokeWidth, scale)}
          />
        );
      }
      default:
        return null;
    }
  };

  if (!badge) return area('node');
  // Zone avec pictogramme et / ou nom : un groupe (même position, même rotation) contenant la
  // surface et le badge, toujours droit à l'écran.
  return (
    <Group {...common}>
      {area('child')}
      <Shape
        listening={false}
        sceneFunc={(ctx, shape) => {
          const { c, scale: s } = native(ctx, shape);
          drawZoneBadge(
            c,
            { x: 0, y: 0 },
            { iconSize: badge.icon?.size ?? null, name: badge.name, rotation: object.rotation },
            s,
            display,
            badge.image,
          );
        }}
      />
    </Group>
  );
});
