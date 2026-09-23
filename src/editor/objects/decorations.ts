/**
 * Éléments répétés calculés à l'affichage à partir de la géométrie (jamais stockés) : flèches
 * d'un trajet, pictogrammes d'un corridor, pictogramme et nom d'une zone. Dessinés dans une seule
 * forme Konva par objet (pas un nœud par flèche), à une taille bornée en pixels ÉCRAN : lisibles à
 * tout zoom, sans devenir gigantesques. Quand on dézoome, les repères s'espacent au lieu de se
 * chevaucher.
 */
import { marksAlongPath } from '@/domain/model/paths.ts';
import type { DisplaySettings, FlowObject, Point, Style } from '@/domain/model/types.ts';
import { rgba } from './konvaStyle.ts';

/** Taille affichée, en pixels image, d'un repère de `imagePx` bornée en pixels écran. */
export function boundedSize(imagePx: number, scale: number, display: DisplaySettings): number {
  const screen = Math.min(display.symbolMaxPx, Math.max(display.symbolMinPx, imagePx * scale));
  return screen / Math.max(scale, 1e-9);
}

/** Espacement effectif : au moins ~2,2 repères entre deux repères, pour ne jamais se chevaucher. */
export function effectiveSpacing(spacing: number, markSize: number): number {
  return Math.max(spacing, markSize * 2.2);
}

function arrowHead(c: CanvasRenderingContext2D, cx: number, length: number, width: number, dir: 1 | -1) {
  const tip = cx + (dir * length) / 2;
  const back = cx - (dir * length) / 2;
  const notch = cx - (dir * length) / 6;
  c.moveTo(tip, 0);
  c.lineTo(back, width / 2);
  c.lineTo(notch, 0);
  c.lineTo(back, -width / 2);
  c.closePath();
}

/**
 * Flèches d'un trajet, posées sur ses segments et orientées selon eux (sens du tracé, inverse ou
 * double sens). Retourne le nombre de flèches dessinées (utile aux tests).
 */
export function drawFlowArrows(
  c: CanvasRenderingContext2D,
  flow: Pick<FlowObject, 'arrows' | 'style'> & { geometry: { points: Point[] } },
  scale: number,
  display: DisplaySettings,
): number {
  if (!flow.arrows.visible) return 0;
  const length = boundedSize(flow.arrows.size, scale, display);
  const marks = marksAlongPath(flow.geometry.points, effectiveSpacing(flow.arrows.spacing, length), length);
  const color = rgba(flow.style.stroke ?? '#1d4ed8', Math.max(flow.style.strokeOpacity, 0.6))!;
  c.save();
  c.lineJoin = 'round';
  for (const m of marks) {
    c.save();
    c.translate(m.x, m.y);
    c.rotate((m.angle * Math.PI) / 180);
    c.beginPath();
    const width = length * 0.8;
    if (flow.arrows.direction === 'both') {
      arrowHead(c, length * 0.27, length * 0.46, width, 1);
      arrowHead(c, -length * 0.27, length * 0.46, width, -1);
    } else arrowHead(c, 0, length, width, flow.arrows.direction === 'forward' ? 1 : -1);
    c.lineWidth = length * 0.12;
    c.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    c.stroke(); // liseré blanc : lisible sur la photo
    c.fillStyle = color;
    c.fill();
    c.restore();
  }
  c.restore();
  return marks.length;
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
  image: HTMLImageElement | null,
): void {
  if (!image) return;
  const size = boundedSize(corridor.iconSize, scale, display);
  for (const m of marksAlongPath(points, effectiveSpacing(corridor.iconSpacing, size), size)) {
    c.save();
    c.translate(m.x, m.y);
    // Pas orientés : le tracé « footprints » pointe vers le haut → +90° par rapport à l'axe.
    c.rotate(((corridor.iconsOriented ? m.angle + 90 : -objectRotation) * Math.PI) / 180);
    c.drawImage(image, -size / 2, -size / 2, size, size);
    c.restore();
  }
}

/** Pictogramme et / ou nom d'une zone, en son centre, toujours droits à l'écran. */
export function drawZoneBadge(
  c: CanvasRenderingContext2D,
  center: Point,
  options: { iconSize: number | null; name: string | null; rotation: number },
  scale: number,
  display: DisplaySettings,
  image: HTMLImageElement | null,
): void {
  const size = options.iconSize ? boundedSize(options.iconSize, scale, display) : 0;
  c.save();
  c.translate(center.x, center.y);
  c.rotate((-options.rotation * Math.PI) / 180);
  const fontPx = Math.max(11, Math.min(display.symbolMaxPx * 0.42, (size * scale || 30) * 0.42));
  const font = fontPx / Math.max(scale, 1e-9);
  const textY = options.name && size ? size / 2 + font * 0.75 : 0;
  if (image && size) c.drawImage(image, -size / 2, -size / 2 - (options.name ? font * 0.35 : 0), size, size);
  if (options.name) {
    c.font = `600 ${font}px Inter, "Segoe UI", Arial, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = font * 0.28;
    c.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    c.strokeText(options.name, 0, textY);
    c.fillStyle = '#0f172a';
    c.fillText(options.name, 0, textY);
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
