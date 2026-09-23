/**
 * Générateur de cases de stationnement. Les cases sont placées en rangées dans la zone, selon une
 * orientation, une largeur et une longueur de case, un nombre de rangées et une allée entre
 * rangées. Une case n'est créée que si elle est ENTIÈREMENT à l'intérieur du contour (zones
 * irrégulières comprises). Les dimensions sont des paramètres de dessin, jamais une attestation de
 * conformité réglementaire.
 */
import { newId, nowIso } from './factories.ts';
import { segmentIntersection } from './paths.ts';
import { geometryCenter, rotatePoint, roundedRectPoints } from './shapes.ts';
import type { PlanDocument, PlanObject, Point, Style } from './types.ts';

export interface StallParams {
  /** Largeur d'une case (le long de la rangée), en pixels image. */
  width: number;
  /** Longueur d'une case (profondeur), en pixels image. */
  length: number;
  /** Orientation des rangées, en degrés (0 = rangées horizontales sur la photo). */
  angleDeg: number;
  rows: number;
  /** Allée entre deux rangées, en pixels image. */
  aisle: number;
}

export interface StallSpec {
  center: Point;
  width: number;
  length: number;
  rotation: number;
}

/** Contour affiché d'une zone (rotation appliquée) ; ellipse approchée par un polygone. */
export function zoneOutline(zone: PlanObject): Point[] {
  const g = zone.geometry;
  const c = geometryCenter(g);
  let pts: Point[];
  // Coins arrondis compris : le contour testé est exactement celui qui est dessiné.
  if (g.kind === 'rect') pts = roundedRectPoints(g.x, g.y, g.width, g.height, g.cornerRadius);
  else if (g.kind === 'ellipse')
    pts = Array.from({ length: 72 }, (_, k) => {
      const a = (k / 72) * 2 * Math.PI;
      return { x: g.cx + g.rx * Math.cos(a), y: g.cy + g.ry * Math.sin(a) };
    });
  else if (g.kind === 'polygon') pts = g.points;
  else return [];
  return pts.map((p) => rotatePoint(p, c, zone.rotation));
}

export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Vrai si le quadrilatère (convexe) est entièrement dans le polygone (même concave). */
export function quadInside(quad: readonly Point[], polygon: readonly Point[]): boolean {
  if (!quad.every((p) => pointInPolygon(p, polygon))) return false;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % quad.length]!;
    for (let j = 0; j < polygon.length; j++) {
      const c = polygon[j]!;
      const d = polygon[(j + 1) % polygon.length]!;
      const hit = segmentIntersection(a, b, c, d);
      // Un sommet du contour qui entre dans la case : la case déborde (zone concave).
      if (hit && Math.hypot(hit.x - a.x, hit.y - a.y) > 1e-6 && Math.hypot(hit.x - b.x, hit.y - b.y) > 1e-6)
        return false;
    }
  }
  return polygon.every((p) => !pointInPolygonStrict(p, quad));
}

function pointInPolygonStrict(p: Point, polygon: readonly Point[]): boolean {
  // Intérieur strict (un sommet du contour posé sur le bord de la case est accepté).
  const shrink = 1e-6;
  const c = polygon.reduce(
    (acc, q) => ({ x: acc.x + q.x / polygon.length, y: acc.y + q.y / polygon.length }),
    { x: 0, y: 0 },
  );
  const inner = polygon.map((q) => ({ x: q.x + (c.x - q.x) * shrink, y: q.y + (c.y - q.y) * shrink }));
  return pointInPolygon(p, inner);
}

/** Positions des cases dans la zone (coordonnées image). */
export function layoutStalls(outline: readonly Point[], params: StallParams): StallSpec[] {
  const { width: W, length: L, rows, aisle } = params;
  if (outline.length < 3 || W <= 0 || L <= 0 || rows < 1) return [];
  const center = outline.reduce(
    (acc, p) => ({ x: acc.x + p.x / outline.length, y: acc.y + p.y / outline.length }),
    { x: 0, y: 0 },
  );
  // Repère des rangées : contour tourné de -angle autour du centre.
  const local = outline.map((p) => rotatePoint(p, center, -params.angleDeg));
  const minX = Math.min(...local.map((p) => p.x));
  const maxX = Math.max(...local.map((p) => p.x));
  const minY = Math.min(...local.map((p) => p.y));
  const maxY = Math.max(...local.map((p) => p.y));
  const depth = rows * L + (rows - 1) * aisle;
  const top = minY + Math.max(0, (maxY - minY - depth) / 2);
  const perRow = Math.floor((maxX - minX) / W);
  const left = minX + (maxX - minX - perRow * W) / 2;
  const specs: StallSpec[] = [];
  for (let r = 0; r < rows; r++) {
    const y0 = top + r * (L + aisle);
    if (y0 + L > maxY + 1e-9) break;
    for (let k = 0; k < perRow; k++) {
      const x0 = left + k * W;
      // Case très légèrement rentrée : un coin posé exactement sur le contour reste « dedans ».
      const e = 1e-6 * Math.max(W, L);
      const quad = [
        { x: x0 + e, y: y0 + e },
        { x: x0 + W - e, y: y0 + e },
        { x: x0 + W - e, y: y0 + L - e },
        { x: x0 + e, y: y0 + L - e },
      ];
      if (!quadInside(quad, local)) continue;
      const c = rotatePoint({ x: x0 + W / 2, y: y0 + L / 2 }, center, params.angleDeg);
      specs.push({ center: c, width: W, length: L, rotation: params.angleDeg });
    }
  }
  return specs;
}

/** Nombre maximal de cases par génération (au-delà, l'éditeur deviendrait très lent). */
export const MAX_STALLS = 2000;

export class StallLimitError extends Error {
  override name = 'StallLimitError';
  constructor(readonly count: number) {
    super(`${count} cases : au-delà de la limite de ${MAX_STALLS} par génération.`);
  }
}

export const STALL_STYLE: Style = {
  fill: '#ffffff',
  fillOpacity: 0.08,
  stroke: '#ffffff',
  strokeOpacity: 0.95,
  strokeWidth: 2,
  dash: 'solid',
  pattern: 'none',
};

/**
 * Remplace les cases de la zone par une nouvelle génération (une seule action d'historique pour
 * l'appelant). Retourne le nombre de cases créées ; `StallLimitError` si plus de `MAX_STALLS`. Les cases sont des objets indépendants :
 * chacune peut ensuite être déplacée, modifiée ou supprimée.
 */
export function generateStalls(
  doc: PlanDocument,
  zoneId: string,
  params: StallParams,
  strokeWidth: number,
  now = nowIso(),
): number {
  const zone = doc.objects[zoneId];
  if (!zone || (zone.type !== 'zone' && zone.type !== 'building')) return 0;
  const specs = layoutStalls(zoneOutline(zone), params);
  // Trop de cases (dimensions trop petites) : rien n'est modifié, l'appelant prévient l'utilisateur.
  if (specs.length > MAX_STALLS) throw new StallLimitError(specs.length);
  for (const o of Object.values(doc.objects))
    if (o.type === 'stall' && o.parentZoneId === zoneId) delete doc.objects[o.id];
  let z = Math.max(
    -1,
    ...Object.values(doc.objects)
      .filter((o) => o.layerId === zone.layerId)
      .map((o) => o.zIndex),
  );
  specs.forEach((spec, i) => {
    const id = newId();
    doc.objects[id] = {
      id,
      type: 'stall',
      name: `Case ${i + 1}`,
      layerId: zone.layerId,
      presetId: null,
      style: { ...STALL_STYLE, strokeWidth },
      rotation: spec.rotation,
      visible: true,
      locked: false,
      zIndex: ++z,
      groupId: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      parentZoneId: zoneId,
      geometry: {
        kind: 'rect',
        x: spec.center.x - spec.width / 2,
        y: spec.center.y - spec.length / 2,
        width: spec.width,
        height: spec.length,
        cornerRadius: 0,
      },
    };
  });
  doc.plan.updatedAt = now;
  return specs.length;
}

/** Nombre de cases rattachées à une zone. */
export function stallCount(doc: PlanDocument, zoneId: string): number {
  return Object.values(doc.objects).filter((o) => o.type === 'stall' && o.parentZoneId === zoneId).length;
}

/** Dimensions proposées par type de stationnement, en mètres (paramètres de dessin). */
export const STALL_DEFAULTS_M: Record<string, { width: number; length: number; aisle: number }> = {
  'zone.parking': { width: 2.6, length: 5.5, aisle: 6.5 },
  'zone.parking-visitors': { width: 2.6, length: 5.5, aisle: 6.5 },
  'zone.parking-heavy': { width: 4, length: 16, aisle: 15 },
  'zone.parking-service': { width: 3, length: 6.5, aisle: 7 },
  'zone.parking-temporary': { width: 2.6, length: 5.5, aisle: 6.5 },
  'zone.parking-custom': { width: 2.6, length: 5.5, aisle: 6.5 },
};
