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

/**
 * Contour d'un rectangle à coins arrondis (arcs approchés par des segments de 15°). Partagé par
 * l'export et le générateur de cases : le contour utilisé est exactement celui qui est dessiné.
 */
export function roundedRectPoints(x: number, y: number, w: number, h: number, r: number): Point[] {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (radius <= 0)
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  const pts: Point[] = [];
  const corners = [
    { cx: x + w - radius, cy: y + radius, a0: -90 },
    { cx: x + w - radius, cy: y + h - radius, a0: 0 },
    { cx: x + radius, cy: y + h - radius, a0: 90 },
    { cx: x + radius, cy: y + radius, a0: 180 },
  ];
  for (const c of corners)
    for (let i = 0; i <= 6; i++) {
      const a = ((c.a0 + i * 15) * Math.PI) / 180;
      pts.push({ x: c.cx + radius * Math.cos(a), y: c.cy + radius * Math.sin(a) });
    }
  return pts;
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
  if (object.type === 'icon') {
    // Pictogramme : proportions conservées, l'échelle devient une taille.
    const s = Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY)) || 1;
    return {
      ...object,
      rotation,
      geometry: { ...object.geometry, x: center.x, y: center.y },
      size: Math.max(1, object.size * s),
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

// ---------------------------------------------------------------------------------------------
// Édition avancée des sommets (phase 3)
// ---------------------------------------------------------------------------------------------

type PointsGeometry = Extract<Geometry, { kind: 'polygon' | 'polyline' }>;

function pointsOf(object: PlanObject): PointsGeometry | null {
  const g = object.geometry;
  return g.kind === 'polygon' || g.kind === 'polyline' ? g : null;
}

/** Nombre minimal de sommets : 3 pour un polygone, 2 pour une polyligne. */
export function minVertices(object: PlanObject): number {
  return object.geometry.kind === 'polygon' ? 3 : 2;
}

/** Milieux des segments (poignées « insérer un sommet »), rotation appliquée. */
export function segmentMidpoints(object: PlanObject): { afterIndex: number; point: Point }[] {
  const vertices = worldVertices(object);
  const closed = object.geometry.kind === 'polygon';
  const result: { afterIndex: number; point: Point }[] = [];
  const count = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < count; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    result.push({ afterIndex: i, point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
  }
  return result;
}

/** Insère un sommet après `afterIndex` (rotation intégrée d'abord : le rendu ne bouge pas). */
export function insertVertex(object: PlanObject, afterIndex: number, at: Point): PlanObject {
  const baked = bakeRotation(object);
  const g = pointsOf(baked);
  if (!g || afterIndex < 0 || afterIndex >= g.points.length) return object;
  const points = [...g.points.slice(0, afterIndex + 1), { ...at }, ...g.points.slice(afterIndex + 1)];
  return { ...baked, geometry: { ...g, points } } as PlanObject;
}

/** Supprime un sommet, sauf si la forme passerait sous le minimum. */
export function removeVertex(object: PlanObject, index: number): PlanObject {
  const baked = bakeRotation(object);
  const g = pointsOf(baked);
  if (!g || index < 0 || index >= g.points.length || g.points.length <= minVertices(object)) return object;
  return { ...baked, geometry: { ...g, points: g.points.filter((_, i) => i !== index) } } as PlanObject;
}

/**
 * Ferme une polyligne (≥ 3 sommets) : elle devient une zone polygonale, avec un remplissage
 * léger de la couleur du trait. Les autres propriétés sont conservées.
 */
export function closePolyline(object: PlanObject): PlanObject {
  if (object.type !== 'line' || object.geometry.points.length < 3) return object;
  const baked = bakeRotation(object) as Extract<PlanObject, { type: 'line' }>;
  const { geometry, ...rest } = baked;
  return {
    ...rest,
    type: 'zone',
    geometry: { kind: 'polygon', points: geometry.points },
    style: { ...baked.style, fill: baked.style.stroke ?? '#6b7280', fillOpacity: 0.25 },
  } as PlanObject;
}

/**
 * Convertit un rectangle en polygone à 4 sommets (rotation intégrée) pour pouvoir ajuster chaque
 * coin sur un bâtiment réel. Le rendu est identique ; les coins arrondis sont abandonnés.
 */
export function rectToPolygon(object: PlanObject): PlanObject {
  const g = object.geometry;
  if (g.kind !== 'rect' || (object.type !== 'zone' && object.type !== 'building')) return object;
  const c = geometryCenter(g);
  const corners = [
    { x: g.x, y: g.y },
    { x: g.x + g.width, y: g.y },
    { x: g.x + g.width, y: g.y + g.height },
    { x: g.x, y: g.y + g.height },
  ].map((p) => rotatePoint(p, c, object.rotation));
  return { ...object, rotation: 0, geometry: { kind: 'polygon', points: corners } } as PlanObject;
}
