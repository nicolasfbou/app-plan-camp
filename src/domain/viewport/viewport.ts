/**
 * Transformation viewport : coordonnées projet (pixels image) → coordonnées écran.
 *
 *   écran = projet × scale + (x, y)
 *
 * Le viewport est un état d'affichage pur. Il n'est jamais écrit dans les objets du plan :
 * zoomer ou se déplacer ne modifie aucune donnée du projet.
 */
import type { Point } from '../model/types.ts';

export interface Viewport {
  /** Pixels écran par pixel image. 1 = 100 %. */
  scale: number;
  /** Position écran de l'origine de l'image. */
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 0.01;
export const MAX_SCALE = 32;

export const IDENTITY_VIEWPORT: Viewport = { scale: 1, x: 0, y: 0 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function projectToScreen(v: Viewport, p: Point): Point {
  return { x: p.x * v.scale + v.x, y: p.y * v.scale + v.y };
}

export function screenToProject(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
}

/**
 * Zoom d'un facteur autour d'un point écran (typiquement le curseur) :
 * le point de l'image situé sous ce point écran reste sous ce point écran.
 */
export function zoomAt(v: Viewport, screenPoint: Point, factor: number): Viewport {
  const scale = clampScale(v.scale * factor);
  const anchor = screenToProject(v, screenPoint);
  return { scale, x: screenPoint.x - anchor.x * scale, y: screenPoint.y - anchor.y * scale };
}

export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { ...v, x: v.x + dx, y: v.y + dy };
}

/** Adapte l'image entière à l'écran, centrée, avec une marge en pixels écran. */
export function fitToScreen(content: Size, screen: Size, padding = 24): Viewport {
  const availW = Math.max(1, screen.width - padding * 2);
  const availH = Math.max(1, screen.height - padding * 2);
  const scale = clampScale(Math.min(availW / content.width, availH / content.height));
  return {
    scale,
    x: (screen.width - content.width * scale) / 2,
    y: (screen.height - content.height * scale) / 2,
  };
}

/** Zoom 100 % (1 pixel image = 1 pixel écran) en conservant le point image au centre de l'écran. */
export function zoomToActualSize(v: Viewport, screen: Size): Viewport {
  const center = { x: screen.width / 2, y: screen.height / 2 };
  return zoomAt(v, center, 1 / v.scale);
}

/** Facteur de zoom pour un cran de molette (deltaY négatif = zoom avant). */
export function wheelZoomFactor(deltaY: number, sensitivity = 0.0015): number {
  return Math.exp(-deltaY * sensitivity);
}
