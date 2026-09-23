/**
 * Objets du plan dessinés sur une surface d'export, en coordonnées de page. Mêmes règles que
 * l'éditeur (ordre des calques, opacités, contours de corridors, flèches, pictogrammes, hachures),
 * mais sans viewport : l'« échelle d'affichage » est celle du papier (pixels CSS imprimés par pixel
 * image), pour que les repères bornés aient sur la page la taille qu'ils ont à l'écran.
 */
import { corridorWidthPx, formatLength, polylineLength, midpointAlong } from '@/domain/model/measure.ts';
import { objectsInRenderOrder } from '@/domain/model/operations.ts';
import { bandOutline, marksAlongPath } from '@/domain/model/paths.ts';
import { geometryBox, geometryCenter, rotatePoint } from '@/domain/model/shapes.ts';
import type { DisplaySettings, PlanDocument, PlanObject, Point, Style } from '@/domain/model/types.ts';
import { MM_PER_CSS_PX } from '@/domain/print/paper.ts';
import {
  boundedSize,
  displayedSymbolSize,
  effectiveSpacing,
  flowArrowColor,
  flowArrowPolygons,
} from '@/editor/objects/decorations.ts';
import { dashArray } from '@/editor/objects/konvaStyle.ts';
import type { SymbolSource } from './assets.ts';
import { hatch, MIN_PRINT_PT, type Rect } from './blocks.ts';
import { MM_PER_PT, roundedRectPath, type Painter, type StrokeSpec } from './painter.ts';

/** Passage pixels image → mm de page (sans rotation : le plan n'est jamais pivoté). */
export interface MapTransform {
  /** Coin haut-gauche de la carte sur la page (mm). */
  x: number;
  y: number;
  /** Pixel image représenté en haut à gauche de la carte. */
  originX: number;
  originY: number;
  /** mm de page par pixel image. */
  k: number;
}

export const toPage = (m: MapTransform, p: Point): Point => ({
  x: m.x + (p.x - m.originX) * m.k,
  y: m.y + (p.y - m.originY) * m.k,
});

/** Échelle d'affichage équivalente : pixels CSS imprimés par pixel image. */
export const printScale = (m: MapTransform) => m.k / MM_PER_CSS_PX;

export interface SceneIssue {
  kind: 'small-text' | 'cut-text';
  objectId: string;
  name: string;
}

/** Calques exportés : visibles dans l'éditeur et retenus dans les réglages d'impression. */
export function exportedLayerIds(doc: PlanDocument, excluded: readonly string[]): Set<string> {
  const skip = new Set(excluded);
  return new Set(doc.layers.filter((l) => l.visible && !skip.has(l.id)).map((l) => l.id));
}

/** Contour (pixels image, rotation appliquée) d'une surface ou d'un tracé. */
export function objectOutline(o: PlanObject): Point[] {
  const g = o.geometry;
  const c = geometryCenter(g);
  const rot = (pts: Point[]) => (o.rotation ? pts.map((p) => rotatePoint(p, c, o.rotation)) : pts);
  switch (g.kind) {
    case 'rect':
      return rot(roundedRectPath(g.x, g.y, g.width, g.height, g.cornerRadius));
    case 'ellipse':
      return rot(
        Array.from({ length: 96 }, (_, i) => {
          const a = (i / 96) * Math.PI * 2;
          return { x: g.cx + g.rx * Math.cos(a), y: g.cy + g.ry * Math.sin(a) };
        }),
      );
    case 'polygon':
    case 'polyline':
      return rot(g.points);
    case 'point':
      return [{ x: g.x, y: g.y }];
  }
}

/** Boîte englobante (pixels image, rotation comprise) d'un objet, repères non compris. */
export function objectBounds(o: PlanObject, doc: PlanDocument): Rect {
  let pts = objectOutline(o);
  if (o.type === 'corridor' && o.geometry.kind === 'polyline')
    pts = bandOutline(o.geometry.points, corridorWidthPx(o, doc.plan.calibration)).map((p) =>
      rotatePoint(p, geometryCenter(o.geometry), o.rotation),
    );
  if (o.type === 'icon') {
    const h = o.size / 2;
    pts = [
      { x: o.geometry.x - h, y: o.geometry.y - h },
      { x: o.geometry.x + h, y: o.geometry.y + h },
    ];
  }
  if (o.type === 'text') {
    const box = geometryBox(o.geometry);
    const lines = o.text.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * o.fontSize * 0.55 + (o.label?.padding ?? 0) * 2;
    const h = lines.length * o.fontSize * 1.2 + (o.label?.padding ?? 0) * 2;
    pts = [
      { x: box.x - w / 2, y: box.y - h / 2 },
      { x: box.x + w / 2, y: box.y + h / 2 },
    ];
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function strokeOf(style: Style, k: number, join: StrokeSpec['join'] = 'round'): StrokeSpec | null {
  if (!style.stroke || style.strokeWidth <= 0) return null;
  return {
    color: style.stroke,
    opacity: style.strokeOpacity,
    width: style.strokeWidth * k,
    dash: dashArray(style)?.map((v) => v * k) ?? null,
    cap: style.dash === 'dotted' ? 'round' : 'butt',
    join,
  };
}

/** Réglages de rendu issus du style d'impression et de la vue (n'agissent que sur le rendu). */
export interface SceneOptions {
  strokeScale: number;
  minTextPt: number;
  iconScale: number;
  detail: 'full' | 'standard' | 'simplified';
  excludedObjectIds: readonly string[];
}

export const DEFAULT_SCENE: SceneOptions = {
  strokeScale: 1,
  minTextPt: 0,
  iconScale: 1,
  detail: 'full',
  excludedObjectIds: [],
};

interface SceneContext {
  p: Painter;
  doc: PlanDocument;
  m: MapTransform;
  frame: Rect;
  symbols: SymbolSource | null;
  issues: SceneIssue[];
  opts: SceneOptions;
  /** Limites d'affichage des repères, multipliées par le facteur des pictogrammes. */
  display: DisplaySettings;
}

/** Épaisseur de trait mise à l'échelle du style (mm de page par pixel image × facteur). */
const sk = (ctx: SceneContext) => ctx.m.k * ctx.opts.strokeScale;

/**
 * Ligne de renvoi d'une étiquette vers ce qu'elle désigne : trait sombre sur liseré blanc, point
 * à l'extrémité. Part du bord de la boîte de l'étiquette.
 */
function leader(
  ctx: SceneContext,
  box: { cx: number; cy: number; w: number; h: number },
  to: Point,
  stopAt = 0,
  rotation = 0,
) {
  const dx = to.x - box.cx;
  const dy = to.y - box.cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  // Bord de l'étiquette dans son propre repère (pivoté), comme dans l'éditeur.
  const local = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -rotation);
  const t = Math.min(
    local.x ? box.w / 2 / Math.abs(local.x) : Infinity,
    local.y ? box.h / 2 / Math.abs(local.y) : Infinity,
  );
  if (t >= 1) return; // l'ancre est sous l'étiquette
  const from = { x: box.cx + dx * t, y: box.cy + dy * t };
  const end = { x: to.x - (dx / len) * stopAt, y: to.y - (dy / len) * stopAt };
  const w = Math.max(0.25, 0.25 * ctx.opts.strokeScale);
  ctx.p.path([[from, end]], false, null, { color: '#ffffff', opacity: 0.95, width: w * 2.6, cap: 'round' });
  ctx.p.path([[from, end]], false, null, { color: '#0f172a', opacity: 1, width: w, cap: 'round' });
  const r = w * 1.6;
  if (!stopAt)
    ctx.p.path(
      [
        Array.from({ length: 12 }, (_, i) => ({
          x: to.x + r * Math.cos((i / 12) * 2 * Math.PI),
          y: to.y + r * Math.sin((i / 12) * 2 * Math.PI),
        })),
      ],
      true,
      { color: '#0f172a', opacity: 1 },
      { color: '#ffffff', opacity: 0.95, width: w },
    );
}

/** Texte posé sur la carte : signale un texte trop petit ou coupé par le cadre de la carte. */
function checkText(ctx: SceneContext, o: PlanObject, box: Rect, pt: number) {
  const f = ctx.frame;
  const inside =
    box.x >= f.x - 0.01 &&
    box.y >= f.y - 0.01 &&
    box.x + box.width <= f.x + f.width + 0.01 &&
    box.y + box.height <= f.y + f.height + 0.01;
  const outside =
    box.x > f.x + f.width || box.y > f.y + f.height || box.x + box.width < f.x || box.y + box.height < f.y;
  // Un texte est désigné par son contenu (plus parlant que « Étiquette »).
  const name = o.type === 'text' ? `« ${o.text.split('\n')[0]!.slice(0, 40)} »` : o.name;
  if (!inside && !outside) ctx.issues.push({ kind: 'cut-text', objectId: o.id, name });
  if (!outside && pt < MIN_PRINT_PT) ctx.issues.push({ kind: 'small-text', objectId: o.id, name });
}

function drawArea(ctx: SceneContext, o: PlanObject) {
  const { p, m } = ctx;
  const outline = objectOutline(o).map((q) => toPage(m, q));
  const s = o.style;
  const closed = o.geometry.kind !== 'polyline';
  if (closed && s.fill && s.fillOpacity > 0)
    p.path([outline], true, { color: s.fill, opacity: s.fillOpacity }, null);
  if (closed && s.pattern !== 'none') {
    const xs = outline.map((q) => q.x);
    const ys = outline.map((q) => q.y);
    const box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    const cell = Math.max(s.strokeWidth * 5, 6) * m.k;
    hatch(p, [outline], box, s, cell / Math.SQRT2, o.rotation);
  }
  const stroke = strokeOf(s, sk(ctx), o.type === 'stall' ? 'miter' : 'round');
  if (stroke) p.path([outline], closed, null, stroke);
}

function drawFlow(ctx: SceneContext, o: Extract<PlanObject, { type: 'flow' }>) {
  const { p, m } = ctx;
  const c = geometryCenter(o.geometry);
  const world = (q: Point) => toPage(m, o.rotation ? rotatePoint(q, c, o.rotation) : q);
  const stroke = strokeOf(o.style, sk(ctx));
  if (stroke) p.path([o.geometry.points.map(world)], false, null, stroke);
  const { polygons, outline } = flowArrowPolygons(o, printScale(m), ctx.display);
  if (!polygons.length) return;
  const fill = flowArrowColor(o.style);
  p.path(
    polygons.map((poly) => poly.map(world)),
    true,
    null,
    { color: '#ffffff', opacity: 0.95, width: outline * m.k, join: 'round' },
  );
  p.path(
    polygons.map((poly) => poly.map(world)),
    true,
    fill,
    null,
  );
}

function drawCorridor(ctx: SceneContext, o: Extract<PlanObject, { type: 'corridor' }>) {
  const { p, m, doc, symbols } = ctx;
  const c = geometryCenter(o.geometry);
  const world = (q: Point) => toPage(m, o.rotation ? rotatePoint(q, c, o.rotation) : q);
  const outline = bandOutline(o.geometry.points, corridorWidthPx(o, doc.plan.calibration)).map(world);
  if (outline.length < 3) return;
  const s = o.style;
  if (s.fill && s.fillOpacity > 0) p.path([outline], true, { color: s.fill, opacity: s.fillOpacity }, null);
  if (s.pattern !== 'none') {
    const xs = outline.map((q) => q.x);
    const ys = outline.map((q) => q.y);
    const box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    hatch(p, [outline], box, s, (Math.max(s.strokeWidth * 5, 6) * m.k) / Math.SQRT2, o.rotation);
  }
  const stroke = strokeOf(s, sk(ctx), 'miter');
  if (stroke) p.path([outline], true, null, stroke);
  if (!o.showIcons || !symbols || ctx.opts.detail === 'simplified') return;
  const scale = printScale(m);
  const size = boundedSize(o.iconSize * ctx.opts.iconScale, scale, ctx.display);
  const id = o.iconsOriented ? 'mark.footprints' : 'mark.walker';
  for (const mark of marksAlongPath(o.geometry.points, effectiveSpacing(o.iconSpacing, size), size)) {
    const at = world(mark);
    const rotation = o.iconsOriented ? mark.angle + 90 + o.rotation : 0;
    const sizeMm = size * m.k;
    // Image pivotée : le carré qui la contient est agrandi pour ne rien couper.
    const r = (rotation * Math.PI) / 180;
    const box = sizeMm * (Math.abs(Math.cos(r)) + Math.abs(Math.sin(r)));
    const image = symbols.get(id, null, box, rotation);
    if (image) p.image(image, at.x - box / 2, at.y - box / 2, box, box);
  }
}

function drawIcon(ctx: SceneContext, o: Extract<PlanObject, { type: 'icon' }>) {
  const { p, m, symbols } = ctx;
  const size = displayedSymbolSize(o.size * ctx.opts.iconScale, printScale(m), ctx.display) * m.k;
  const r = (o.rotation * Math.PI) / 180;
  const box = size * (Math.abs(Math.cos(r)) + Math.abs(Math.sin(r)));
  const at = toPage(m, { x: o.geometry.x, y: o.geometry.y });
  const image = symbols?.get(o.symbolId, o.text, box, o.rotation);
  if (image) p.image(image, at.x - box / 2, at.y - box / 2, box, box, o.style.fillOpacity);
}

function drawText(ctx: SceneContext, o: Extract<PlanObject, { type: 'text' }>) {
  const { p } = ctx;
  if (!o.label && ctx.opts.detail === 'simplified') return; // simplifié : pas de textes libres
  // Taille minimale du style : texte (et étiquette) agrandis proportionnellement.
  const basePt = (o.fontSize * ctx.m.k) / MM_PER_PT;
  const f = Math.max(1, ctx.opts.minTextPt / basePt);
  const m = { ...ctx.m, k: ctx.m.k * f };
  const center = toPage(ctx.m, { x: o.geometry.x, y: o.geometry.y });
  const pt = basePt * f;
  const bold = o.fontWeight === 'bold';
  const lines = (o.text || ' ').split('\n');
  const widths = lines.map((l) => p.textWidth(l, pt, bold));
  const textW = Math.max(...widths);
  const lh = o.fontSize * 1.2 * m.k;
  const textH = lines.length * lh;
  const pad = (o.label?.padding ?? 0) * m.k;
  const w = textW + 2 * pad;
  const h = textH + 2 * pad;
  if (o.leaderTo) leader(ctx, { cx: center.x, cy: center.y, w, h }, toPage(ctx.m, o.leaderTo), 0, o.rotation);
  const rot = (q: Point) => (o.rotation ? rotatePoint(q, center, o.rotation) : q);
  if (o.label) {
    const rect = roundedRectPath(center.x - w / 2, center.y - h / 2, w, h, o.label.cornerRadius * m.k).map(
      rot,
    );
    p.path(
      [rect],
      true,
      { color: o.label.background, opacity: o.label.backgroundOpacity },
      o.label.border && o.label.borderWidth > 0
        ? { color: o.label.border, opacity: 1, width: o.label.borderWidth * m.k, join: 'round' }
        : null,
    );
  }
  const color = o.style.fill ?? '#000000';
  lines.forEach((line, i) => {
    const lx =
      o.align === 'left' ? center.x - textW / 2 : o.align === 'right' ? center.x + textW / 2 : center.x;
    const at = rot({ x: lx, y: center.y - textH / 2 + (i + 0.5) * lh });
    p.text(line, at.x, at.y, {
      size: pt,
      bold,
      color,
      opacity: o.style.fillOpacity,
      align: o.align,
      baseline: 'middle',
      angle: o.rotation,
    });
  });
  const corners = [
    { x: center.x - w / 2, y: center.y - h / 2 },
    { x: center.x + w / 2, y: center.y - h / 2 },
    { x: center.x + w / 2, y: center.y + h / 2 },
    { x: center.x - w / 2, y: center.y + h / 2 },
  ].map(rot);
  const xs = corners.map((q) => q.x);
  const ys = corners.map((q) => q.y);
  checkText(
    ctx,
    o,
    {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    pt,
  );
}

function drawDimension(ctx: SceneContext, o: Extract<PlanObject, { type: 'dimension' }>) {
  const { p, m, doc } = ctx;
  if (ctx.opts.detail !== 'full') return; // cotes : plan détaillé seulement
  const c = geometryCenter(o.geometry);
  const pts = o.geometry.points.map((q) => toPage(m, o.rotation ? rotatePoint(q, c, o.rotation) : q));
  const color = o.style.stroke ?? '#0f172a';
  const width = Math.max(o.style.strokeWidth * sk(ctx), 0.2);
  p.path([pts], false, null, { color, opacity: o.style.strokeOpacity, width, join: 'round' });
  const scale = printScale(m);
  const tick = boundedSize(10, scale, ctx.display) * 0.6 * m.k;
  const ticks: Point[][] = [];
  for (const [a, b] of [
    [pts[0]!, pts[1]!],
    [pts.at(-1)!, pts.at(-2)!],
  ] as const) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    ticks.push([
      { x: a.x - nx * tick, y: a.y - ny * tick },
      { x: a.x + nx * tick, y: a.y + ny * tick },
    ]);
  }
  p.path(ticks, false, null, { color, opacity: o.style.strokeOpacity, width });
  const label = formatLength(polylineLength(o.geometry.points), doc.plan.calibration, doc.plan.units);
  const pt = Math.max(
    ctx.opts.minTextPt,
    (Math.max(11, Math.min(ctx.display.symbolMaxPx * 0.4, 14)) * MM_PER_CSS_PX) / MM_PER_PT,
  );
  const fontMm = pt * MM_PER_PT;
  const mid = midpointAlong(pts).point;
  const y = mid.y - fontMm * 0.25;
  p.text(label, mid.x, y, {
    size: pt,
    bold: true,
    color,
    align: 'center',
    baseline: 'bottom',
    halo: { color: '#ffffff', opacity: 0.95, width: fontMm * 0.15 },
  });
  const w = p.textWidth(label, pt, true);
  checkText(ctx, o, { x: mid.x - w / 2, y: y - fontMm, width: w, height: fontMm }, pt);
}

/**
 * Pictogramme et / ou nom d'une zone, toujours droits : au centre, ou nom déplacé (`nameOffset`)
 * et relié à la zone par une ligne de renvoi.
 */
function drawZoneBadge(ctx: SceneContext, o: Extract<PlanObject, { type: 'zone' }>) {
  const { p, m, symbols } = ctx;
  const scale = printScale(m);
  const display = ctx.display;
  const size = o.icon ? boundedSize(o.icon.size * ctx.opts.iconScale, scale, display) * m.k : 0;
  const anchor = geometryCenter(o.geometry);
  const center = toPage(m, anchor);
  const fontPx = Math.max(11, Math.min(display.symbolMaxPx * 0.42, ((size / m.k) * scale || 30) * 0.42));
  const pt = Math.max(ctx.opts.minTextPt, (fontPx * MM_PER_CSS_PX) / MM_PER_PT);
  const fontMm = pt * MM_PER_PT;
  // Standard et simplifié : noms de zones masqués (la légende les identifie).
  const name = o.showName && ctx.opts.detail === 'full' ? o.name : null;
  const moved =
    name && o.nameOffset ? toPage(m, { x: anchor.x + o.nameOffset.x, y: anchor.y + o.nameOffset.y }) : null;
  const textAt = moved ?? { x: center.x, y: center.y + (name && size ? size / 2 + fontMm * 0.75 : 0) };
  if (name) {
    const w = p.textWidth(name, pt, true);
    if (moved) leader(ctx, { cx: moved.x, cy: moved.y, w, h: fontMm }, center, size / 2);
  }
  if (o.icon && size) {
    const image = symbols?.get(o.icon.symbolId, null, size, 0);
    const dy = name && !moved ? fontMm * 0.35 : 0;
    if (image) p.image(image, center.x - size / 2, center.y - size / 2 - dy, size, size);
  }
  if (name) {
    p.text(name, textAt.x, textAt.y, {
      size: pt,
      bold: true,
      color: '#0f172a',
      align: 'center',
      baseline: 'middle',
      halo: { color: '#ffffff', opacity: 0.92, width: fontMm * 0.14 },
    });
    const w = p.textWidth(name, pt, true);
    checkText(ctx, o, { x: textAt.x - w / 2, y: textAt.y - fontMm / 2, width: w, height: fontMm }, pt);
  }
}

/**
 * Dessine les objets des calques exportés (ordre et opacité des calques), limités au cadre de la
 * carte. Retourne les textes trop petits ou coupés par le cadre.
 */
export function drawPlanObjects(
  p: Painter,
  doc: PlanDocument,
  m: MapTransform,
  frame: Rect,
  symbols: SymbolSource | null,
  excludedLayerIds: readonly string[],
  options: Partial<SceneOptions> = {},
): SceneIssue[] {
  const opts = { ...DEFAULT_SCENE, ...options };
  const display = {
    symbolMinPx: doc.plan.display.symbolMinPx * opts.iconScale,
    symbolMaxPx: doc.plan.display.symbolMaxPx * opts.iconScale,
  };
  const ctx: SceneContext = { p, doc, m, frame, symbols, issues: [], opts, display };
  const layers = exportedLayerIds(doc, excludedLayerIds);
  const excludedObjects = new Set(opts.excludedObjectIds);
  const ordered = objectsInRenderOrder(doc).filter(
    (o) => o.visible && layers.has(o.layerId) && !excludedObjects.has(o.id),
  );
  const frameOutline = [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.width, y: frame.y },
    { x: frame.x + frame.width, y: frame.y + frame.height },
    { x: frame.x, y: frame.y + frame.height },
  ];
  p.clip([frameOutline], () => {
    for (const layer of doc.layers) {
      if (!layers.has(layer.id)) continue;
      const objects = ordered.filter((o) => o.layerId === layer.id);
      if (!objects.length) continue;
      p.withOpacity(layer.opacity, () => {
        for (const o of objects) {
          p.owner?.(o.id);
          switch (o.type) {
            case 'flow':
              drawFlow(ctx, o);
              break;
            case 'corridor':
              drawCorridor(ctx, o);
              break;
            case 'icon':
              drawIcon(ctx, o);
              break;
            case 'text':
              drawText(ctx, o);
              break;
            case 'dimension':
              drawDimension(ctx, o);
              break;
            default:
              drawArea(ctx, o);
              if (o.type === 'zone' && (o.icon || o.showName)) drawZoneBadge(ctx, o);
          }
        }
      });
    }
    p.owner?.(null);
  });
  return ctx.issues;
}
