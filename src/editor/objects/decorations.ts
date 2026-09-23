/**
 * Éléments répétés calculés à l'affichage à partir de la géométrie (jamais stockés) : flèches
 * d'un trajet, pictogrammes d'un corridor, pictogramme et nom d'une zone. Dessinés dans une seule
 * forme Konva par objet (pas un nœud par flèche), à une taille bornée en pixels ÉCRAN : lisibles à
 * tout zoom, sans devenir gigantesques. Quand on dézoome, les repères s'espacent au lieu de se
 * chevaucher.
 */
import { midpointAlong } from '@/domain/model/measure.ts';
import { marksAlongPath } from '@/domain/model/paths.ts';
import type { DisplaySettings, FlowObject, Point, Style } from '@/domain/model/types.ts';
import { rgba } from './konvaStyle.ts';

/** Taille affichée, en pixels image, d'un repère de `imagePx` bornée en pixels écran. */
export function boundedSize(imagePx: number, scale: number, display: DisplaySettings): number {
  const screen = Math.min(display.symbolMaxPx, Math.max(display.symbolMinPx, imagePx * scale));
  return screen / Math.max(scale, 1e-9);
}

/**
 * Taille affichée (pixels image) d'un pictogramme placé : sa taille enregistrée tant qu'elle reste
 * dans les limites à l'écran, sinon la limite (arrondie : pas de re-rendu pour d'infimes écarts).
 */
export function displayedSymbolSize(size: number, scale: number, display: DisplaySettings): number {
  const screen = size * scale;
  if (screen >= display.symbolMinPx && screen <= display.symbolMaxPx) return size;
  // Limite atteinte : zoom arrondi par paliers de 2^(1/8) (≈ 9 %), pour ne pas re-rendre chaque
  // pictogramme à chaque cran de molette ; la taille à l'écran reste à ±9 % de la limite.
  const step = 2 ** (Math.round(Math.log2(Math.max(scale, 1e-9)) * 8) / 8);
  return boundedSize(size, step, display);
}

/** Espacement effectif : au moins ~2,2 repères entre deux repères, pour ne jamais se chevaucher. */
export function effectiveSpacing(spacing: number, markSize: number): number {
  return Math.max(spacing, markSize * 2.2);
}

/** Zone visible, en coordonnées locales de la forme : les repères hors écran ne sont pas dessinés. */
export interface ViewBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const inView = (view: ViewBox | null | undefined, x: number, y: number, margin: number) =>
  !view ||
  (x >= view.minX - margin && x <= view.maxX + margin && y >= view.minY - margin && y <= view.maxY + margin);

type Poly = Point[];

/** Pointe de flèche centrée en `cx` le long de l'axe du repère (polygone en coordonnées image). */
function arrowHead(
  m: Point,
  cos: number,
  sin: number,
  cx: number,
  length: number,
  width: number,
  dir: 1 | -1,
) {
  const at = (u: number, v: number): Point => ({ x: m.x + u * cos - v * sin, y: m.y + u * sin + v * cos });
  const tip = cx + (dir * length) / 2;
  const back = cx - (dir * length) / 2;
  const notch = cx - (dir * length) / 6;
  return [at(tip, 0), at(back, width / 2), at(notch, 0), at(back, -width / 2)];
}

/** Trait central d'une flèche double (rectangle le long de l'axe). */
function shaft(m: Point, cos: number, sin: number, half: number, thickness: number): Poly {
  const at = (u: number, v: number): Point => ({ x: m.x + u * cos - v * sin, y: m.y + u * sin + v * cos });
  return [
    at(-half, -thickness / 2),
    at(half, -thickness / 2),
    at(half, thickness / 2),
    at(-half, thickness / 2),
  ];
}

/** Taille minimale absolue d'une flèche réduite pour tenir sur un segment court (pixels écran). */
const MIN_ARROW_PX = 6;

/**
 * Positions et taille des flèches d'un trajet. Si aucun segment n'est assez long pour une flèche à
 * la taille minimale d'affichage (tracé fait de nombreux segments courts, vu de loin), les flèches
 * sont réduites pour tenir sur les plus longs segments (jamais sous 6 px écran) : le sens de
 * circulation reste visible, et aucune flèche ne déborde du tracé.
 */
export function flowArrowMarks(
  points: readonly Point[],
  arrows: Pick<FlowObject['arrows'], 'size' | 'spacing'>,
  scale: number,
  display: DisplaySettings,
) {
  let length = boundedSize(arrows.size, scale, display);
  let marks = marksAlongPath(points, effectiveSpacing(arrows.spacing, length), length);
  if (!marks.length && points.length >= 2) {
    let longest = 0;
    for (let i = 1; i < points.length; i++)
      longest = Math.max(
        longest,
        Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y),
      );
    const reduced = longest * 0.8;
    if (reduced * scale >= MIN_ARROW_PX) {
      length = reduced;
      marks = marksAlongPath(points, effectiveSpacing(arrows.spacing, length), length);
    }
  }
  return { marks, length };
}

/**
 * Polygones des flèches d'un trajet (sens du tracé, inverse ou double sens), en coordonnées image,
 * et épaisseur du liseré blanc. Partagé par l'éditeur et l'export (même dessin partout).
 */
export function flowArrowPolygons(
  flow: Pick<FlowObject, 'arrows'> & { geometry: { points: Point[] } },
  scale: number,
  display: DisplaySettings,
  view?: ViewBox | null,
): { polygons: Poly[]; outline: number } {
  if (!flow.arrows.visible) return { polygons: [], outline: 0 };
  const placed = flowArrowMarks(flow.geometry.points, flow.arrows, scale, display);
  const length = placed.length;
  const width = length * 0.8;
  const polygons: Poly[] = [];
  for (const m of placed.marks) {
    if (!inView(view, m.x, m.y, length)) continue;
    const r = (m.angle * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    if (flow.arrows.direction === 'both') {
      // Double sens : deux pointes opposées reliées par un trait (se lit ↔, pas comme un losange).
      polygons.push(
        arrowHead(m, cos, sin, length * 0.36, length * 0.28, width, 1),
        arrowHead(m, cos, sin, -length * 0.36, length * 0.28, width, -1),
        shaft(m, cos, sin, length * 0.46, width * 0.26),
      );
    } else
      polygons.push(arrowHead(m, cos, sin, 0, length, width, flow.arrows.direction === 'forward' ? 1 : -1));
  }
  return { polygons, outline: length * 0.12 };
}

/** Couleur de remplissage des flèches d'un trajet. */
export const flowArrowColor = (style: Style) => ({
  color: style.stroke ?? '#1d4ed8',
  opacity: Math.max(style.strokeOpacity, 0.6),
});

/**
 * Flèches d'un trajet, posées sur ses segments et orientées selon eux (sens du tracé, inverse ou
 * double sens). Retourne le nombre de flèches dessinées (utile aux tests).
 */
export function drawFlowArrows(
  c: CanvasRenderingContext2D,
  flow: Pick<FlowObject, 'arrows' | 'style'> & { geometry: { points: Point[] } },
  scale: number,
  display: DisplaySettings,
  view?: ViewBox | null,
): number {
  const { polygons, outline } = flowArrowPolygons(flow, scale, display, view);
  if (!polygons.length) return 0;
  c.save();
  c.beginPath();
  for (const poly of polygons) {
    c.moveTo(poly[0]!.x, poly[0]!.y);
    for (const p of poly.slice(1)) c.lineTo(p.x, p.y);
    c.closePath();
  }
  c.lineJoin = 'round';
  c.lineWidth = outline;
  c.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  c.stroke(); // liseré blanc : lisible sur la photo
  const fill = flowArrowColor(flow.style);
  c.fillStyle = rgba(fill.color, fill.opacity)!;
  c.fill();
  c.restore();
  return flow.arrows.direction === 'both' ? polygons.length / 3 : polygons.length;
}

/**
 * Pictogrammes d'un corridor le long de son axe : droits (silhouette) ou orientés dans le sens du
 * déplacement (pas). `objectRotation` sert à garder les silhouettes droites à l'écran.
 */
export function drawCorridorIcons(
  c: CanvasRenderingContext2D,
  points: Point[],
  corridor: { iconSize: number; iconSpacing: number; iconsOriented: boolean },
  objectRotation: number,
  scale: number,
  display: DisplaySettings,
  image: CanvasImageSource | null,
  view?: ViewBox | null,
): void {
  if (!image) return;
  const size = boundedSize(corridor.iconSize, scale, display);
  for (const m of marksAlongPath(points, effectiveSpacing(corridor.iconSpacing, size), size)) {
    if (!inView(view, m.x, m.y, size)) continue;
    c.save();
    c.translate(m.x, m.y);
    // Pas orientés : le tracé « footprints » pointe vers le haut → +90° par rapport à l'axe.
    c.rotate(((corridor.iconsOriented ? m.angle + 90 : -objectRotation) * Math.PI) / 180);
    c.drawImage(image, -size / 2, -size / 2, size, size);
    c.restore();
  }
}

/**
 * Trait de renvoi d'une étiquette vers ce qu'elle désigne (coordonnées locales, pixels image) :
 * part du bord de la boîte de l'étiquette, trait sombre sur liseré blanc, point à l'extrémité
 * (ou arrêt avant `stopAt`, par exemple le bord d'un pictogramme).
 */
export function drawLeader(
  c: CanvasRenderingContext2D,
  box: { cx: number; cy: number; w: number; h: number },
  to: Point,
  scale: number,
  stopAt = 0,
): void {
  const dx = to.x - box.cx;
  const dy = to.y - box.cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const t = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity);
  if (t >= 1) return;
  const from = { x: box.cx + dx * t, y: box.cy + dy * t };
  const end = { x: to.x - (dx / len) * stopAt, y: to.y - (dy / len) * stopAt };
  const w = 1.6 / Math.max(scale, 1e-9);
  c.save();
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(from.x, from.y);
  c.lineTo(end.x, end.y);
  c.lineWidth = w * 2.6;
  c.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  c.stroke();
  c.lineWidth = w;
  c.strokeStyle = '#0f172a';
  c.stroke();
  if (!stopAt) {
    c.beginPath();
    c.arc(to.x, to.y, w * 1.8, 0, Math.PI * 2);
    c.fillStyle = '#0f172a';
    c.fill();
  }
  c.restore();
}

/**
 * Pictogramme et / ou nom d'une zone, toujours droits à l'écran : au centre, ou nom déplacé
 * (`nameOffset`, pixels image) et relié à la zone par une ligne de renvoi.
 */
export function drawZoneBadge(
  c: CanvasRenderingContext2D,
  center: Point,
  options: { iconSize: number | null; name: string | null; rotation: number; nameOffset?: Point | null },
  scale: number,
  display: DisplaySettings,
  image: CanvasImageSource | null,
): void {
  const size = options.iconSize ? boundedSize(options.iconSize, scale, display) : 0;
  c.save();
  c.translate(center.x, center.y);
  c.rotate((-options.rotation * Math.PI) / 180);
  const fontPx = Math.max(11, Math.min(display.symbolMaxPx * 0.42, (size * scale || 30) * 0.42));
  const font = fontPx / Math.max(scale, 1e-9);
  const moved = options.name && options.nameOffset ? options.nameOffset : null;
  const textY = options.name && size ? size / 2 + font * 0.75 : 0;
  c.font = `600 ${font}px Inter, "Segoe UI", Arial, sans-serif`;
  if (moved && options.name) {
    const w = c.measureText(options.name).width;
    drawLeader(c, { cx: moved.x, cy: moved.y, w, h: font }, { x: 0, y: 0 }, scale, size / 2);
  }
  if (image && size)
    c.drawImage(image, -size / 2, -size / 2 - (options.name && !moved ? font * 0.35 : 0), size, size);
  if (options.name) {
    const at = moved ?? { x: 0, y: textY };
    c.font = `600 ${font}px Inter, "Segoe UI", Arial, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = font * 0.28;
    c.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    c.strokeText(options.name, at.x, at.y);
    c.fillStyle = '#0f172a';
    c.fillText(options.name, at.x, at.y);
  }
  c.restore();
}

// --- Hachures ------------------------------------------------------------------------------------

const patterns = new Map<string, HTMLCanvasElement>();

/**
 * Motif de hachures (diagonales ou croisées) sur le fond de la zone, en canevas répété. La taille
 * du motif est en pixels image (il suit la photo comme le reste du dessin).
 */
export function hatchPattern(style: Style): HTMLCanvasElement | null {
  if (style.pattern === 'none' || typeof document === 'undefined') return null;
  const key = `${style.pattern}:${style.fill}:${style.fillOpacity}:${style.stroke}:${style.strokeOpacity}`;
  const cached = patterns.get(key);
  if (cached) return cached;
  const cell = 32;
  const canvas = document.createElement('canvas');
  canvas.width = cell;
  canvas.height = cell;
  const c = canvas.getContext('2d');
  if (!c) return null;
  const fill = rgba(style.fill, style.fillOpacity);
  if (fill) {
    c.fillStyle = fill;
    c.fillRect(0, 0, cell, cell);
  }
  c.strokeStyle = rgba(style.stroke ?? style.fill ?? '#000000', Math.max(0.5, style.strokeOpacity * 0.85))!;
  c.lineWidth = 3;
  c.beginPath();
  for (const k of [-1, 0, 1]) {
    c.moveTo(k * cell, cell);
    c.lineTo(k * cell + cell, 0);
    if (style.pattern === 'crosshatch') {
      c.moveTo(k * cell, 0);
      c.lineTo(k * cell + cell, cell);
    }
  }
  c.stroke();
  patterns.set(key, canvas);
  return canvas;
}

/**
 * Cote : traits perpendiculaires aux extrémités et valeur mesurée au milieu du tracé, lisible
 * (taille bornée à l'écran, liseré blanc) et toujours droite.
 */
export function drawDimensionMarks(
  c: CanvasRenderingContext2D,
  points: Point[],
  label: string,
  style: Style,
  objectRotation: number,
  scale: number,
  display: DisplaySettings,
): void {
  if (points.length < 2) return;
  const tick = boundedSize(10, scale, display) * 0.6;
  const color = rgba(style.stroke ?? '#0f172a', style.strokeOpacity) ?? '#0f172a';
  c.save();
  c.strokeStyle = color;
  c.lineWidth = Math.max(style.strokeWidth, 1 / scale);
  c.beginPath();
  for (const [a, b] of [
    [points[0]!, points[1]!],
    [points.at(-1)!, points.at(-2)!],
  ] as const) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    c.moveTo(a.x - nx * tick, a.y - ny * tick);
    c.lineTo(a.x + nx * tick, a.y + ny * tick);
  }
  c.stroke();
  const { point } = midpointAlong(points);
  const font = Math.max(11, Math.min(display.symbolMaxPx * 0.4, 14)) / Math.max(scale, 1e-9);
  c.translate(point.x, point.y);
  c.rotate((-objectRotation * Math.PI) / 180);
  c.font = `600 ${font}px Inter, "Segoe UI", Arial, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'bottom';
  c.lineJoin = 'round';
  c.lineWidth = font * 0.3;
  c.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  c.strokeText(label, 0, -font * 0.25);
  c.fillStyle = color;
  c.fillText(label, 0, -font * 0.25);
  c.restore();
}
