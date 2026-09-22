/**
 * Géométrie des objets, en coordonnées image. Fonctions pures, sans React ni Konva.
 *
 * Convention de rendu (appliquée par l'éditeur) : chaque objet est un nœud Konva placé au CENTRE
 * de sa géométrie (`x`, `y` = centre), pivoté de `rotation` autour de ce centre, échelle 1.
 * Le Transformer modifie temporairement position, rotation et échelle du nœud ; `normalizeTransform`
 * reporte ces valeurs dans la géométrie pour que l'échelle stockée reste toujours 1.
 */
import type { Geometry, PlanObject, Point } from './types.ts';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Boîte englobante de la géométrie NON pivotée. */
export function geometryBox(geometry: Geometry): Box {
  switch (geometry.kind) {
    case 'rect':
      return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
    case 'ellipse':
      return {
        x: geometry.cx - geometry.rx,
        y: geometry.cy - geometry.ry,
        width: geometry.rx * 2,
        height: geometry.ry * 2,
      };
    case 'polygon':
    case 'polyline': {
      const xs = geometry.points.map((p) => p.x);
      const ys = geometry.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    case 'point':
      return { x: geometry.x, y: geometry.y, width: 0, height: 0 };
  }
}

/** Centre de rotation de la géométrie. */
export function geometryCenter(geometry: Geometry): Point {
  const box = geometryBox(geometry);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function rotatePoint(p: Point, center: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** Place le coin haut-gauche de la boîte (non pivotée) en (x, y). */
export function moveGeometryTo<G extends Geometry>(geometry: G, x: number, y: number): G {
  const box = geometryBox(geometry);
  const dx = x - box.x;
  const dy = y - box.y;
  switch (geometry.kind) {
    case 'rect':
    case 'point':
      return { ...geometry, x: geometry.x + dx, y: geometry.y + dy };
    case 'ellipse':
      return { ...geometry, cx: geometry.cx + dx, cy: geometry.cy + dy };
    case 'polygon':
    case 'polyline':
      return { ...geometry, points: geometry.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

/** Change la taille de la boîte en gardant le coin haut-gauche. Les points sont mis à l'échelle. */
export function resizeGeometry<G extends Geometry>(geometry: G, width: number, height: number): G {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const box = geometryBox(geometry);
  switch (geometry.kind) {
    case 'rect':
      return { ...geometry, width: w, height: h };
    case 'ellipse':
      return { ...geometry, rx: w / 2, ry: h / 2, cx: box.x + w / 2, cy: box.y + h / 2 };
    case 'polygon':
    case 'polyline': {
      const sx = box.width > 0 ? w / box.width : 1;
      const sy = box.height > 0 ? h / box.height : 1;
      return {
        ...geometry,
        points: geometry.points.map((p) => ({
          x: box.x + (p.x - box.x) * sx,
          y: box.y + (p.y - box.y) * sy,
        })),
      };
    }
    case 'point':
      return geometry;
  }
}

/** Échelle appliquée autour du centre puis recentrage en `center`. */
function scaleGeometryAbout<G extends Geometry>(geometry: G, sx: number, sy: number, center: Point): G {
  const c = geometryCenter(geometry);
  const map = (p: Point) => ({ x: center.x + (p.x - c.x) * sx, y: center.y + (p.y - c.y) * sy });
  switch (geometry.kind) {
    case 'rect': {
      const width = geometry.width * Math.abs(sx);
      const height = geometry.height * Math.abs(sy);
      return { ...geometry, x: center.x - width / 2, y: center.y - height / 2, width, height };
    }
    case 'ellipse':
      return {
        ...geometry,
        cx: center.x,
        cy: center.y,
        rx: geometry.rx * Math.abs(sx),
        ry: geometry.ry * Math.abs(sy),
      };
    case 'polygon':
    case 'polyline':
      return { ...geometry, points: geometry.points.map(map) };
    case 'point':
      return { ...geometry, x: center.x, y: center.y };
  }
}

/** État d'un nœud Konva à la fin d'un geste du Transformer ou d'un glisser. */
export interface NodeTransform {
  /** Position du nœud = nouveau centre, en coordonnées image. */
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/**
 * Intègre la transformation d'un nœud dans l'objet : nouvelle géométrie (échelle intégrée),
 * nouvelle rotation. Pour un texte, l'échelle devient une taille de police (et une marge).
 */
export function normalizeTransform(object: PlanObject, t: NodeTransform): PlanObject {
  const rotation = normalizeAngle(t.rotation);
  const center = { x: t.x, y: t.y };
  if (object.type === 'text') {
    const s = Math.abs(t.scaleY) || 1;
    return {
      ...object,
      rotation,
      geometry: { ...object.geometry, x: center.x, y: center.y },
      fontSize: Math.max(1, object.fontSize * s),
      label: object.label
        ? {
            ...object.label,
            padding: object.label.padding * s,
            borderWidth: object.label.borderWidth * s,
            cornerRadius: object.label.cornerRadius * s,
          }
        : null,
    };
  }
  const geometry = scaleGeometryAbout(object.geometry, t.scaleX, t.scaleY, center);
  return { ...object, rotation, geometry } as PlanObject;
}

/** Angle ramené dans ]-180, 180]. */
export function normalizeAngle(degrees: number): number {
  let a = degrees % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.abs(a) < 1e-9 ? 0 : a;
}

/**
 * Intègre la rotation dans les points (polygone / polyligne) : même rendu, rotation 0.
 * Nécessaire avant d'éditer un sommet, sinon le centre de rotation bougerait avec lui.
 */
export function bakeRotation(object: PlanObject): PlanObject {
  const g = object.geometry;
  if (object.rotation === 0 || (g.kind !== 'polygon' && g.kind !== 'polyline')) return object;
  const c = geometryCenter(g);
  return {
    ...object,
    rotation: 0,
    geometry: { ...g, points: g.points.map((p) => rotatePoint(p, c, object.rotation)) },
  } as PlanObject;
}

/** Positions affichées (rotation appliquée) des sommets d'un polygone / d'une polyligne. */
export function worldVertices(object: PlanObject): Point[] {
  const g = object.geometry;
  if (g.kind !== 'polygon' && g.kind !== 'polyline') return [];
  const c = geometryCenter(g);
  return g.points.map((p) => rotatePoint(p, c, object.rotation));
}

/** Déplace un sommet vers une position image (l'objet doit avoir une rotation intégrée : 0). */
export function moveVertex(object: PlanObject, index: number, to: Point): PlanObject {
  const g = object.geometry;
  if ((g.kind !== 'polygon' && g.kind !== 'polyline') || index < 0 || index >= g.points.length) return object;
  const baked = bakeRotation(object);
  const bg = baked.geometry as typeof g;
  return {
    ...baked,
    geometry: { ...bg, points: bg.points.map((p, i) => (i === index ? { ...to } : p)) },
  } as PlanObject;
}
