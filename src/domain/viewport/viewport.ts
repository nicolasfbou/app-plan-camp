/**
 * Transformation viewport : coordonnées projet (pixels image) → coordonnées écran.
 *
 *   écran = image × scale + (x, y)   (coordonnées projet = pixels de l'image affichée)
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

export function imageToScreen(v: Viewport, p: Point): Point {
  return { x: p.x * v.scale + v.x, y: p.y * v.scale + v.y };
}

export function screenToImage(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
}

/**
 * Zoom d'un facteur autour d'un point écran (typiquement le curseur) :
 * le point de l'image situé sous ce point écran reste sous ce point écran.
 */
export function zoomAt(v: Viewport, screenPoint: Point, factor: number): Viewport {
  const scale = clampScale(v.scale * factor);
  const anchor = screenToImage(v, screenPoint);
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

/**
 * Zoom 100 % (1 pixel image = 1 pixel CSS) en conservant le point image au centre de l'écran.
 * La position est arrondie au pixel entier pour que chaque pixel de la photo tombe exactement
 * sur un pixel écran (aucun rééchantillonnage, aucun flou de demi-pixel).
 */
export function zoomToActualSize(v: Viewport, screen: Size): Viewport {
  const center = { x: screen.width / 2, y: screen.height / 2 };
  const zoomed = zoomAt(v, center, 1 / v.scale);
  return { scale: 1, x: Math.round(zoomed.x), y: Math.round(zoomed.y) };
}

/** Recentre l'image dans l'écran sans changer le niveau de zoom. */
export function centerContent(v: Viewport, content: Size, screen: Size): Viewport {
  return {
    scale: v.scale,
    x: (screen.width - content.width * v.scale) / 2,
    y: (screen.height - content.height * v.scale) / 2,
  };
}

/** Facteur des boutons + / −. */
export const BUTTON_ZOOM_STEP = 1.25;

/** Zoom par bouton, centré sur le milieu de la zone de travail. */
export function zoomByStep(v: Viewport, screen: Size, direction: 1 | -1): Viewport {
  const factor = direction > 0 ? BUTTON_ZOOM_STEP : 1 / BUTTON_ZOOM_STEP;
  return zoomAt(v, { x: screen.width / 2, y: screen.height / 2 }, factor);
}

/**
 * Pincement à deux doigts (écran tactile) : le point entre les doigts suit leur milieu,
 * et l'échelle suit l'écartement.
 */
export function pinch(
  v: Viewport,
  previous: { center: Point; distance: number },
  current: { center: Point; distance: number },
): Viewport {
  const panned = panBy(v, current.center.x - previous.center.x, current.center.y - previous.center.y);
  if (previous.distance <= 0) return panned;
  return zoomAt(panned, current.center, current.distance / previous.distance);
}

// ---------------------------------------------------------------------------
// Molette de souris / trackpad
// ---------------------------------------------------------------------------

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lignes, 2 = pages. */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type WheelIntent = { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number };

/**
 * Interprète un événement molette :
 * - pincement trackpad (le navigateur l'envoie avec ctrlKey) ou Ctrl+molette → zoom fin ;
 * - molette de souris (crans verticaux francs, ou mode ligne/page) → zoom, comme Google Maps ;
 * - défilement à deux doigts du trackpad (petits deltas, souvent avec composante horizontale) → pan.
 */
export function interpretWheel(e: WheelInput): WheelIntent {
  const lineScale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  const dx = e.deltaX * lineScale;
  const dy = e.deltaY * lineScale;
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: wheelZoomFactor(dy, 0.01) };
  const looksLikeMouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50);
  if (looksLikeMouseWheel) return { kind: 'zoom', factor: wheelZoomFactor(dy) };
  return { kind: 'pan', dx: -dx, dy: -dy };
}

// ---------------------------------------------------------------------------
// Préférence d'affichage (hors données du projet)
// ---------------------------------------------------------------------------

/** Vue mémorisée indépendamment de la taille de fenêtre : point image au centre + échelle. */
export interface ViewCenter {
  centerX: number;
  centerY: number;
  scale: number;
}

export function toViewCenter(v: Viewport, screen: Size): ViewCenter {
  const center = screenToImage(v, { x: screen.width / 2, y: screen.height / 2 });
  return { centerX: center.x, centerY: center.y, scale: v.scale };
}

export function fromViewCenter(view: ViewCenter, screen: Size): Viewport {
  const scale = clampScale(view.scale);
  return { scale, x: screen.width / 2 - view.centerX * scale, y: screen.height / 2 - view.centerY * scale };
}

/** Facteur de zoom pour un cran de molette (deltaY négatif = zoom avant). */
export function wheelZoomFactor(deltaY: number, sensitivity = 0.0015): number {
  return Math.exp(-deltaY * sensitivity);
}
