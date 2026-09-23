/**
 * Images de comparaison entre deux états d'un plan (jamais modifiés) :
 * - « avant » et « après » : photo + annotations de chaque état, à la même échelle ;
 * - « superposition » : photo atténuée, ancienne version des objets changés ou supprimés en gris,
 *   nouvelle version en couleur, et repères numérotés (vert : ajouté ; rouge pointillé : supprimé ;
 *   orange : déplacé, avec l'ancienne position et une flèche ; bleu : modifié).
 * Même moteur de dessin que les exports (mêmes styles, pictogrammes, flèches).
 */
import type { PlanDocument } from '@/domain/model/types.ts';
import { approxBounds, type Bounds, type ObjectChange, type PlanDiff } from '@/domain/revisions/diff.ts';
import type { LoadedBackground } from '@/editor/backgroundImage.ts';
import { createCanvas, loadSymbolSource, type BlobReader } from '@/export/assets.ts';
import { CanvasPainter } from '@/export/canvasPainter.ts';
import { loadExportFonts } from '@/export/fonts.ts';
import { grayscalePainter } from '@/export/painter.ts';
import { drawPlanObjects, type MapTransform } from '@/export/planScene.ts';

export const MARKER_COLORS = {
  added: '#16a34a',
  removed: '#dc2626',
  moved: '#ea580c',
  modified: '#2563eb',
} as const;

export const markerColor = (c: ObjectChange) =>
  c.primary === 'added'
    ? MARKER_COLORS.added
    : c.primary === 'removed'
      ? MARKER_COLORS.removed
      : c.primary === 'moved'
        ? MARKER_COLORS.moved
        : MARKER_COLORS.modified;

export interface ComparisonImages {
  before: HTMLCanvasElement;
  after: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  /** Partie de l'image représentée (pixels image). */
  extent: Bounds;
  /** Pixels du canevas par pixel image. */
  scale: number;
}

/** Longueur (mm) du plus grand côté de la carte : proportions des repères comparables à un tirage. */
const MAP_MM = 400;

function extentOf(before: PlanDocument, after: PlanDocument): Bounds {
  const image = after.plan.baseImage ?? before.plan.baseImage;
  if (image) return { x: 0, y: 0, width: image.width, height: image.height };
  const boxes = [...Object.values(before.objects), ...Object.values(after.objects)].map(approxBounds);
  if (!boxes.length) return { x: 0, y: 0, width: 1000, height: 700 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  const pad = Math.max(x1 - x0, y1 - y0) * 0.05 + 20;
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad };
}

function drawPhoto(
  c: CanvasRenderingContext2D,
  background: LoadedBackground | null,
  extent: Bounds,
  scale: number,
  dim: number,
) {
  const { width, height } = c.canvas;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, width, height);
  if (background) {
    // Niveau de la pyramide juste assez fin pour l'échelle demandée.
    const level =
      [...background.levels].sort((a, b) => a.factor - b.factor).find((l) => l.factor >= scale) ??
      background.levels[0]!;
    const f = level.factor;
    c.drawImage(
      level.bitmap,
      extent.x * f,
      extent.y * f,
      extent.width * f,
      extent.height * f,
      0,
      0,
      width,
      height,
    );
  }
  if (dim > 0) {
    c.fillStyle = `rgba(255,255,255,${dim})`;
    c.fillRect(0, 0, width, height);
  }
}

export interface ComparisonInput {
  before: PlanDocument;
  after: PlanDocument;
  diff: PlanDiff;
  backgroundBefore: LoadedBackground | null;
  backgroundAfter: LoadedBackground | null;
  readBlob: BlobReader;
  /** Plus grand côté des images produites (pixels). */
  maxSide?: number;
}

export async function renderComparison(input: ComparisonInput): Promise<ComparisonImages> {
  await loadExportFonts();
  const { before, after, diff } = input;
  const extent = extentOf(before, after);
  const maxSide = input.maxSide ?? 2400;
  const scale = Math.min(1, maxSide / Math.max(extent.width, extent.height));
  const width = Math.max(1, Math.round(extent.width * scale));
  const height = Math.max(1, Math.round(extent.height * scale));
  const k = MAP_MM / Math.max(extent.width, extent.height); // mm par pixel image
  const pxPerMm = scale / k;
  const m: MapTransform = { x: 0, y: 0, originX: extent.x, originY: extent.y, k };
  const frame = { x: 0, y: 0, width: extent.width * k, height: extent.height * k };
  const [symbolsBefore, symbolsAfter] = await Promise.all([
    loadSymbolSource(before, input.readBlob, pxPerMm),
    loadSymbolSource(after, input.readBlob, pxPerMm),
  ]);

  const state = (doc: PlanDocument, bg: LoadedBackground | null, symbols: typeof symbolsBefore) => {
    const canvas = createCanvas(width, height);
    const c = canvas.getContext('2d')!;
    drawPhoto(c, bg, extent, scale, 0);
    drawPlanObjects(new CanvasPainter(c, pxPerMm), doc, m, frame, symbols, []);
    return canvas;
  };
  const beforeCanvas = state(before, input.backgroundBefore, symbolsBefore);
  const afterCanvas = state(after, input.backgroundAfter, symbolsAfter);

  // Superposition.
  const overlay = createCanvas(width, height);
  const c = overlay.getContext('2d')!;
  drawPhoto(c, input.backgroundAfter ?? input.backgroundBefore, extent, scale, 0.5);
  const ghostIds = new Set(diff.objects.filter((o) => o.primary !== 'added').map((o) => o.id));
  const painter = new CanvasPainter(c, pxPerMm);
  // Ancienne version (gris, atténuée) des seuls objets changés ou supprimés.
  painter.withOpacity(0.55, () =>
    drawPlanObjects(grayscalePainter(painter), before, m, frame, symbolsBefore, [], {
      excludedObjectIds: Object.keys(before.objects).filter((id) => !ghostIds.has(id)),
    }),
  );
  drawPlanObjects(painter, after, m, frame, symbolsAfter, []);
  drawMarkers(c, diff, extent, scale);
  return { before: beforeCanvas, after: afterCanvas, overlay, extent, scale };
}

/** Repères numérotés (numéro = rang dans la liste des changements d'objets). */
function drawMarkers(c: CanvasRenderingContext2D, diff: PlanDiff, extent: Bounds, scale: number) {
  const unit = Math.max(2, Math.round(Math.max(c.canvas.width, c.canvas.height) / 900));
  const toCanvas = (b: Bounds, pad: number) => ({
    x: (b.x - extent.x) * scale - pad,
    y: (b.y - extent.y) * scale - pad,
    w: b.width * scale + 2 * pad,
    h: b.height * scale + 2 * pad,
  });
  const box = (b: Bounds, color: string, dashed: boolean) => {
    const r = toCanvas(b, unit * 3);
    c.save();
    c.strokeStyle = color;
    c.lineWidth = unit * 1.5;
    c.setLineDash(dashed ? [unit * 4, unit * 3] : []);
    c.strokeRect(r.x, r.y, Math.max(r.w, unit * 6), Math.max(r.h, unit * 6));
    c.restore();
    return r;
  };
  diff.objects.forEach((change, index) => {
    const color = markerColor(change);
    let anchor: { x: number; y: number };
    if (change.primary === 'removed' && change.before) {
      const r = box(change.before, color, true);
      anchor = { x: r.x, y: r.y };
    } else if (change.primary === 'moved' && change.before && change.after) {
      const old = box(change.before, '#64748b', true);
      const r = box(change.after, color, false);
      const from = { x: old.x + old.w / 2, y: old.y + old.h / 2 };
      const to = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      arrow(c, from, to, color, unit);
      anchor = { x: r.x, y: r.y };
    } else if (change.after) {
      const r = box(change.after, color, false);
      anchor = { x: r.x, y: r.y };
    } else return;
    badge(c, anchor, String(index + 1), color, unit);
  });
}

function arrow(
  c: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  unit: number,
) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < unit * 4) return;
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  const head = unit * 6;
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = unit * 1.5;
  c.beginPath();
  c.moveTo(from.x, from.y);
  c.lineTo(to.x - Math.cos(a) * head * 0.8, to.y - Math.sin(a) * head * 0.8);
  c.stroke();
  c.beginPath();
  c.moveTo(to.x, to.y);
  c.lineTo(to.x - Math.cos(a - 0.45) * head, to.y - Math.sin(a - 0.45) * head);
  c.lineTo(to.x - Math.cos(a + 0.45) * head, to.y - Math.sin(a + 0.45) * head);
  c.closePath();
  c.fill();
  c.restore();
}

function badge(
  c: CanvasRenderingContext2D,
  at: { x: number; y: number },
  text: string,
  color: string,
  unit: number,
) {
  const r = unit * 6;
  const x = Math.max(r, Math.min(c.canvas.width - r, at.x));
  const y = Math.max(r, Math.min(c.canvas.height - r, at.y));
  c.save();
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = color;
  c.fill();
  c.lineWidth = unit;
  c.strokeStyle = '#ffffff';
  c.stroke();
  c.fillStyle = '#ffffff';
  c.font = `bold ${Math.round(r * 1.1)}px Arial, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x, y + unit * 0.3);
  c.restore();
}
