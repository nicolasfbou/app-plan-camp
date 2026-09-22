import type { Geometry } from './types.ts';

/** Translate une géométrie en espace image. Fonction pure : retourne une nouvelle géométrie. */
export function translateGeometry<G extends Geometry>(geometry: G, dx: number, dy: number): G {
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
