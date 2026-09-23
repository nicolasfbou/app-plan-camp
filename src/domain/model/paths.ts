/**
 * Géométrie des tracés (trajets de véhicules, corridors piétons), en pixels image. Fonctions
 * pures : les flèches et les bords d'un corridor sont CALCULÉS à partir des sommets et des
 * paramètres ; rien de tout cela n'est stocké (aucun objet par flèche).
 */
import type { Point } from './types.ts';

const EPS = 1e-9;

/** Supprime les sommets consécutifs confondus (segments de longueur nulle). */
export function dedupePoints(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > EPS) out.push(p);
  }
  return out;
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return total;
}

/** Position le long du tracé : point, direction (degrés, 0 = vers la droite) et segment porteur. */
export interface PathMark {
  x: number;
  y: number;
  angle: number;
  segment: number;
}

/**
 * Positions régulières le long d'un tracé pour des repères (flèches, pictogrammes) de longueur
 * `length`, espacés d'au moins `spacing`. Chaque repère tient ENTIÈREMENT sur un seul segment et
 * suit sa direction : il ne déborde jamais du chemin dans un virage ou un angle (un repère qui
 * chevaucherait un sommet est décalé sur le segment suivant, ou omis si le segment est trop court).
 */
export function marksAlongPath(points: readonly Point[], spacing: number, length: number): PathMark[] {
  const pts = dedupePoints(points);
  const marks: PathMark[] = [];
  if (pts.length < 2 || spacing <= 0) return marks;
  const half = Math.max(0, length / 2);
  let start = 0; // abscisse curviligne du début du segment courant
  let next = spacing / 2; // position souhaitée du prochain repère
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const end = start + len;
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    while (next <= end - half + EPS && len >= 2 * half) {
      const at = Math.max(next, start + half);
      if (at > end - half + EPS) break;
      const t = (at - start) / len;
      marks.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle, segment: i - 1 });
      next = at + spacing;
    }
    start = end;
  }
  return marks;
}

/**
 * Contour d'une bande de largeur `width` centrée sur le tracé (polygone fermé : bord gauche dans
 * le sens du tracé, puis bord droit en sens inverse). Les deux bords restent à `width / 2` du
 * tracé central : jonctions en onglet dans les virages, biseautées côté extérieur quand l'angle est
 * aigu (l'onglet partirait trop loin), onglet limité côté intérieur pour ne pas dépasser les
 * segments voisins.
 */
export function bandOutline(points: readonly Point[], width: number, miterLimit = 2.5): Point[] {
  const pts = dedupePoints(points);
  const h = width / 2;
  if (pts.length < 2 || h <= 0) return [];
  const dirs: Point[] = [];
  const lens: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x;
    const dy = pts[i]!.y - pts[i - 1]!.y;
    const len = Math.hypot(dx, dy);
    dirs.push({ x: dx / len, y: dy / len });
    lens.push(len);
  }
  const normal = (d: Point) => ({ x: -d.y, y: d.x }); // à gauche du sens de parcours (axe y vers le bas)
  const left: Point[] = [];
  const right: Point[] = [];
  const offset = (p: Point, n: Point, k: number) => ({ x: p.x + n.x * k, y: p.y + n.y * k });

  const n0 = normal(dirs[0]!);
  left.push(offset(pts[0]!, n0, h));
  right.push(offset(pts[0]!, n0, -h));
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const d1 = dirs[i - 1]!;
    const d2 = dirs[i]!;
    const n1 = normal(d1);
    const n2 = normal(d2);
    // > 0 : le côté des normales (côté « gauche » de la liste) est l'INTÉRIEUR du virage.
    const cross = d1.x * d2.y - d1.y * d2.x;
    const mx = n1.x + n2.x;
    const my = n1.y + n2.y;
    const mlen = Math.hypot(mx, my);
    if (Math.abs(cross) < 1e-6 && d1.x * d2.x + d1.y * d2.y > 0) {
      // Segments alignés : un seul point de chaque côté.
      left.push(offset(p, n1, h));
      right.push(offset(p, n1, -h));
      continue;
    }
    // Onglet : m = bissectrice des normales, longueur h / cos(demi-angle).
    const m = mlen < EPS ? n1 : { x: mx / mlen, y: my / mlen };
    const cos = Math.max(EPS, m.x * n2.x + m.y * n2.y);
    const miter = h / cos;
    const outerIsLeft = cross < 0;
    // Côté intérieur : l'onglet est borné par la longueur des segments voisins (demi-tour, segments
    // très courts) pour ne jamais projeter le bord loin du tracé.
    const innerLength = Math.min(miter, Math.max(h, Math.min(lens[i - 1]!, lens[i]!)));
    const inner = offset(p, m, (outerIsLeft ? -1 : 1) * innerLength);
    const outer =
      miter / h <= miterLimit
        ? [offset(p, m, (outerIsLeft ? 1 : -1) * miter)]
        : outerIsLeft
          ? [offset(p, n1, h), offset(p, n2, h)]
          : [offset(p, n1, -h), offset(p, n2, -h)];
    if (outerIsLeft) {
      left.push(...outer);
      right.push(inner);
    } else {
      right.push(...outer);
      left.push(inner);
    }
  }
  const last = pts.at(-1)!;
  const nl = normal(dirs.at(-1)!);
  left.push(offset(last, nl, h));
  right.push(offset(last, nl, -h));
  return [...left, ...right.reverse()];
}

/** Distance d'un point à un segment. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  return Math.hypot(p.x - closestOnSegment(p, a, b).x, p.y - closestOnSegment(p, a, b).y);
}

export function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

export function distanceToPath(p: Point, points: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++)
    best = Math.min(best, distanceToSegment(p, points[i - 1]!, points[i]!));
  return best;
}

/** Point d'intersection de deux segments [a, b] et [c, d], ou null. */
export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < EPS) return null; // parallèles (les chevauchements sont traités à part)
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/** Plus courte distance entre deux segments et le milieu des deux points les plus proches. */
export function segmentsClosest(a: Point, b: Point, c: Point, d: Point): { distance: number; point: Point } {
  const hit = segmentIntersection(a, b, c, d);
  if (hit) return { distance: 0, point: hit };
  const candidates = [
    [a, closestOnSegment(a, c, d)],
    [b, closestOnSegment(b, c, d)],
    [c, closestOnSegment(c, a, b)],
    [d, closestOnSegment(d, a, b)],
  ] as const;
  let best = { distance: Infinity, point: a };
  for (const [p, q] of candidates) {
    const distance = Math.hypot(p.x - q.x, p.y - q.y);
    if (distance < best.distance) best = { distance, point: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } };
  }
  return best;
}
