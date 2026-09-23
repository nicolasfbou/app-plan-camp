/**
 * Blocs de la mise en page : légende et cartouche. Mesurés (hauteur selon la largeur disponible)
 * puis dessinés sur n'importe quelle surface. Les textes ne sont jamais coupés en silence : ce qui
 * ne tient pas est signalé.
 */
import type { LegendGroup, ShownLegendEntry } from '@/domain/print/legend.ts';
import type { TitleBlockRow } from '@/domain/print/titleBlock.ts';
import type { LegendSettings, Point, Style } from '@/domain/model/types.ts';
import { dashArray } from '@/editor/objects/konvaStyle.ts';
import type { SymbolSource } from './assets.ts';
import { MM_PER_PT, rectPath, wrapText, type Painter, type PainterImage } from './painter.ts';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Plus petite taille de texte acceptée à l'impression (points). */
export const MIN_PRINT_PT = 6;

const GROUP_LABELS: Record<LegendGroup, string> = {
  circulation: 'Circulation',
  pedestrians: 'Piétons',
  parking: 'Stationnement',
  deliveries: 'Livraisons',
  safety: 'Sécurité',
  zones: 'Zones',
  buildings: 'Bâtiments',
  signage: 'Signalisation',
  measures: 'Mesures',
  other: 'Autres',
};

// --- Légende -------------------------------------------------------------------------------------------

interface LegendRow {
  kind: 'heading' | 'entry';
  lines: string[];
  entry?: ShownLegendEntry;
  y: number;
  height: number;
}

export interface LegendFit {
  width: number;
  height: number;
  /** Taille du texte des entrées (points). */
  font: number;
  swatch: { width: number; height: number };
  padding: number;
  title: string;
  titleFont: number;
  rows: LegendRow[];
  /** Entrées qui ne tiennent pas dans la hauteur disponible (signalées, jamais masquées en silence). */
  omitted: number;
}

function measureLegendAt(
  p: Painter,
  entries: ShownLegendEntry[],
  settings: LegendSettings,
  width: number,
  f: number,
): LegendFit {
  const compact = settings.mode === 'compact';
  const font = (compact ? 7 : 8) * f;
  const titleFont = (compact ? 8.5 : 10) * f;
  const padding = 2.5 * f;
  const swatch = { width: (compact ? 8 : 10) * f, height: (compact ? 4 : 5) * f };
  const line = font * MM_PER_PT * 1.25;
  const labelWidth = Math.max(10, width - 2 * padding - swatch.width - 2 * f);
  const rows: LegendRow[] = [];
  let y = padding + (settings.title ? titleFont * MM_PER_PT * 1.5 : 0);
  let group: LegendGroup | null = null;
  for (const entry of entries) {
    if (!compact && entry.group !== group) {
      group = entry.group;
      const h = font * 0.85 * MM_PER_PT * 1.6;
      rows.push({ kind: 'heading', lines: [GROUP_LABELS[entry.group]], y, height: h });
      y += h;
    }
    const text = compact ? entry.label : `${entry.label} (${entry.count})`;
    const lines = wrapText(text, labelWidth, (s) => p.textWidth(s, font));
    const h = Math.max(swatch.height, lines.length * line) + 1.4 * f;
    rows.push({ kind: 'entry', lines, entry, y, height: h });
    y += h;
  }
  return {
    width,
    height: y + padding,
    font,
    swatch,
    padding,
    title: settings.title,
    titleFont,
    rows,
    omitted: 0,
  };
}

/**
 * Mesure la légende pour une largeur donnée. Si elle dépasse `maxHeight`, la taille est réduite
 * (jamais sous 6 pt) ; si elle ne tient toujours pas, les dernières entrées sont omises et
 * comptées (`omitted`) pour être signalées.
 */
export function fitLegend(
  p: Painter,
  entries: ShownLegendEntry[],
  settings: LegendSettings,
  width: number,
  maxHeight: number,
): LegendFit {
  const minF = MIN_PRINT_PT / (settings.mode === 'compact' ? 7 : 8);
  let f = settings.sizeFactor;
  let fit = measureLegendAt(p, entries, settings, width, f);
  while (fit.height > maxHeight && f > minF) {
    f = Math.max(minF, f * 0.9);
    fit = measureLegendAt(p, entries, settings, width, f);
  }
  if (fit.height <= maxHeight) return fit;
  // Toujours trop haute : on garde les entrées qui tiennent, et on compte les autres.
  const noteHeight = fit.font * MM_PER_PT * 1.6;
  const kept = fit.rows.filter((r) => r.y + r.height <= maxHeight - fit.padding - noteHeight);
  const keptEntries = kept.filter((r) => r.kind === 'entry').length;
  const omitted = entries.length - keptEntries;
  const last = kept.at(-1);
  return {
    ...fit,
    rows: kept.filter((r, i) => !(r.kind === 'heading' && i === kept.length - 1)),
    omitted,
    height: Math.min(maxHeight, (last ? last.y + last.height : fit.padding) + noteHeight + fit.padding),
  };
}

/** Échantillon d'une entrée de légende : mêmes couleurs, traits et pictogrammes que le plan. */
function drawSwatch(p: Painter, entry: ShownLegendEntry, box: Rect, symbols: SymbolSource | null) {
  const s = entry.swatch;
  const mid = box.y + box.height / 2;
  const lineStroke = (style: Style, width: number) => ({
    color: style.stroke ?? '#0f172a',
    opacity: Math.max(style.strokeOpacity, 0.4),
    width,
    dash: dashArray({ ...style, strokeWidth: width * 1.2 })?.map((v) => v) ?? null,
    cap: style.dash === 'dotted' ? ('round' as const) : ('butt' as const),
  });
  const area = (style: Style, rect: Rect) => {
    const outline = rectPath(rect.x, rect.y, rect.width, rect.height);
    if (style.fill)
      p.path([outline], true, { color: style.fill, opacity: Math.max(style.fillOpacity, 0.15) }, null);
    if (style.pattern !== 'none') hatch(p, [outline], rect, style, 1.4);
    if (style.stroke)
      p.path([outline], true, null, {
        ...lineStroke(style, 0.35),
        opacity: Math.max(style.strokeOpacity, 0.6),
      });
  };
  switch (s.kind) {
    case 'flow': {
      const stroke = lineStroke(s.style, Math.min(1.2, box.height * 0.22));
      p.path(
        [
          [
            { x: box.x, y: mid },
            { x: box.x + box.width, y: mid },
          ],
        ],
        false,
        null,
        stroke,
      );
      const a = box.height * 0.8;
      const cx = box.x + box.width / 2;
      const head = (dir: 1 | -1, at: number): Point[] => [
        { x: at + (dir * a) / 2, y: mid },
        { x: at - (dir * a) / 2, y: mid - a * 0.4 },
        { x: at - (dir * a) / 6, y: mid },
        { x: at - (dir * a) / 2, y: mid + a * 0.4 },
      ];
      const heads =
        s.direction === 'both'
          ? [head(1, cx + a * 0.45), head(-1, cx - a * 0.45)]
          : [head(s.direction === 'forward' ? 1 : -1, cx)];
      p.path(
        heads,
        true,
        { color: s.style.stroke ?? '#1d4ed8', opacity: Math.max(s.style.strokeOpacity, 0.6) },
        {
          color: '#ffffff',
          opacity: 0.95,
          width: a * 0.1,
          join: 'round',
        },
      );
      break;
    }
    case 'line':
    case 'dimension': {
      p.path(
        [
          [
            { x: box.x, y: mid },
            { x: box.x + box.width, y: mid },
          ],
        ],
        false,
        null,
        lineStroke(s.style, 0.45),
      );
      if (s.kind === 'dimension')
        p.path(
          [
            [
              { x: box.x, y: mid - box.height * 0.35 },
              { x: box.x, y: mid + box.height * 0.35 },
            ],
            [
              { x: box.x + box.width, y: mid - box.height * 0.35 },
              { x: box.x + box.width, y: mid + box.height * 0.35 },
            ],
          ],
          false,
          null,
          lineStroke({ ...s.style, dash: 'solid' }, 0.35),
        );
      break;
    }
    case 'band':
      area(s.style, { x: box.x, y: box.y + box.height * 0.2, width: box.width, height: box.height * 0.6 });
      break;
    case 'area': {
      area(s.style, box);
      const icon = s.symbolId ? symbols?.get(s.symbolId, null, box.height * 0.8, 0) : null;
      if (icon) {
        const size = box.height * 0.8;
        p.image(icon, box.x + (box.width - size) / 2, box.y + box.height * 0.1, size, size);
      }
      break;
    }
    case 'stall': {
      // Cases (traits blancs) sur fond d'enrobé : lisibles aussi sur la page blanche.
      p.path([rectPath(box.x, box.y, box.width, box.height)], true, { color: '#64748b', opacity: 1 }, null);
      const w = box.width / 3;
      p.path(
        [0, 1, 2].map((i) =>
          rectPath(box.x + i * w + w * 0.12, box.y + box.height * 0.12, w * 0.76, box.height * 0.76),
        ),
        true,
        null,
        { color: s.style.stroke ?? '#ffffff', opacity: 1, width: 0.3 },
      );
      break;
    }
    case 'symbol': {
      const size = box.height * 1.2;
      const icon = symbols?.get(s.symbolId, s.text, size, 0);
      if (icon) p.image(icon, box.x + (box.width - size) / 2, mid - size / 2, size, size);
      break;
    }
  }
}

/** Hachures d'une surface (lignes réelles limitées au contour : vectorielles dans le PDF). */
export function hatch(
  p: Painter,
  outline: Point[][],
  box: Rect,
  style: Style,
  spacing: number,
  angleDeg = 0,
) {
  const color = style.stroke ?? style.fill ?? '#000000';
  const opacity = Math.max(0.5, style.strokeOpacity * 0.85);
  const lines: Point[][] = [];
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = Math.hypot(box.width, box.height) / 2 + spacing;
  const directions = style.pattern === 'crosshatch' ? [-45, 45] : [-45];
  for (const d of directions) {
    const a = ((d + angleDeg) * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    for (let t = -r; t <= r; t += spacing) {
      // Droite de direction u, décalée de t perpendiculairement.
      const px = cx - uy * t;
      const py = cy + ux * t;
      lines.push([
        { x: px - ux * r, y: py - uy * r },
        { x: px + ux * r, y: py + uy * r },
      ]);
    }
  }
  p.clip(outline, () =>
    p.path(lines, false, null, { color, opacity, width: spacing * (3 / 32) * Math.SQRT2 }),
  );
}

export function drawLegend(
  p: Painter,
  fit: LegendFit,
  rect: Rect,
  symbols: SymbolSource | null,
  framed: boolean,
) {
  const box = rectPath(rect.x, rect.y, rect.width, rect.height);
  p.path(
    [box],
    true,
    { color: '#ffffff', opacity: framed ? 0.94 : 1 },
    { color: '#334155', opacity: 1, width: 0.25 },
  );
  const x = rect.x + fit.padding;
  if (fit.title)
    p.text(fit.title, x, rect.y + fit.padding, {
      size: fit.titleFont,
      bold: true,
      color: '#0f172a',
      baseline: 'top',
    });
  const line = fit.font * MM_PER_PT * 1.25;
  for (const row of fit.rows) {
    const y = rect.y + row.y;
    if (row.kind === 'heading') {
      p.text(row.lines[0]!.toUpperCase(), x, y + row.height * 0.62, {
        size: fit.font * 0.85,
        bold: true,
        color: '#475569',
        baseline: 'alphabetic',
      });
      continue;
    }
    const swatchBox = {
      x,
      y: y + (row.height - 1.4 * (fit.font / 8) - fit.swatch.height) / 2,
      ...fit.swatch,
    };
    drawSwatch(p, row.entry!, swatchBox, symbols);
    const textX = x + fit.swatch.width + 2 * (fit.font / 8);
    const textTop = y + (row.height - row.lines.length * line) / 2;
    row.lines.forEach((l, i) =>
      p.text(l, textX, textTop + (i + 0.5) * line, { size: fit.font, color: '#0f172a', baseline: 'middle' }),
    );
  }
  if (fit.omitted > 0)
    p.text(
      `… ${fit.omitted} entrée${fit.omitted > 1 ? 's' : ''} non affichée${fit.omitted > 1 ? 's' : ''} (place insuffisante)`,
      x,
      rect.y + rect.height - fit.padding,
      { size: Math.max(MIN_PRINT_PT, fit.font * 0.85), color: '#b45309', baseline: 'bottom' },
    );
}

// --- Cartouche -------------------------------------------------------------------------------------------

/** Champs affichés sur toute la largeur du cartouche. */
const WIDE_FIELDS = new Set(['Camp', 'Titre', 'Notes']);

interface TitleCell {
  label: string;
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  highlight?: 'approved' | 'pending';
}

export interface TitleBlockFit {
  width: number;
  height: number;
  cells: TitleCell[];
  logo: { width: number; height: number } | null;
  font: number;
  labelFont: number;
  padding: number;
}

/**
 * Mesure le cartouche : cellules « intitulé / valeur » sur `columns` colonnes (Camp, Titre et Notes
 * sur toute la largeur), logo en tête. Les valeurs sont renvoyées à la ligne, jamais coupées.
 */
export function fitTitleBlock(
  p: Painter,
  rows: TitleBlockRow[],
  width: number,
  columns: number,
  logo: { aspect: number } | null,
  status: 'approved' | 'pending',
  sizeFactor = 1,
): TitleBlockFit {
  const font = 7.5 * sizeFactor;
  const labelFont = 6 * sizeFactor;
  const padding = 2;
  const gap = 1.5;
  const inner = width - 2 * padding;
  const colWidth = (inner - gap * (columns - 1)) / columns;
  const line = font * MM_PER_PT * 1.2;
  const labelH = labelFont * MM_PER_PT * 1.4;
  const cells: TitleCell[] = [];
  let y = padding;
  let logoFit: TitleBlockFit['logo'] = null;
  if (logo) {
    const h = Math.min(14, inner / Math.max(logo.aspect, 0.2));
    logoFit = { width: Math.min(inner, h * logo.aspect), height: h };
    y += h + gap;
  }
  let col = 0;
  let rowHeight = 0;
  const flush = () => {
    y += rowHeight + (rowHeight ? gap : 0);
    col = 0;
    rowHeight = 0;
  };
  for (const r of rows) {
    const wide = WIDE_FIELDS.has(r.label) || columns === 1;
    if (wide && col > 0) flush();
    const w = wide ? inner : colWidth;
    const lines = wrapText(r.value, w, (s) => p.textWidth(s, font, r.label === 'Titre'));
    const h = labelH + lines.length * line + 0.8;
    cells.push({
      label: r.label,
      lines,
      x: padding + (wide ? 0 : col * (colWidth + gap)),
      y,
      width: w,
      height: h,
      highlight: r.label === 'Statut' ? status : undefined,
    });
    rowHeight = Math.max(rowHeight, h);
    if (wide) flush();
    else if (++col >= columns) flush();
  }
  if (col > 0) flush();
  return { width, height: y - gap + padding, cells, logo: logoFit, font, labelFont, padding };
}

export function drawTitleBlock(p: Painter, fit: TitleBlockFit, rect: Rect, logo: PainterImage | null) {
  p.path(
    [rectPath(rect.x, rect.y, rect.width, rect.height)],
    true,
    { color: '#ffffff', opacity: 1 },
    {
      color: '#0f172a',
      opacity: 1,
      width: 0.35,
    },
  );
  if (fit.logo && logo)
    p.image(logo, rect.x + fit.padding, rect.y + fit.padding, fit.logo.width, fit.logo.height);
  const line = fit.font * MM_PER_PT * 1.2;
  const labelH = fit.labelFont * MM_PER_PT * 1.4;
  for (const cell of fit.cells) {
    const x = rect.x + cell.x;
    const y = rect.y + cell.y;
    // Séparateur discret au-dessus de chaque cellule.
    p.path(
      [
        [
          { x, y: y - 0.6 },
          { x: x + cell.width, y: y - 0.6 },
        ],
      ],
      false,
      null,
      {
        color: '#cbd5e1',
        opacity: 1,
        width: 0.15,
      },
    );
    p.text(cell.label.toUpperCase(), x, y + labelH * 0.75, {
      size: fit.labelFont,
      bold: true,
      color: '#64748b',
    });
    const color =
      cell.highlight === 'approved' ? '#047857' : cell.highlight === 'pending' ? '#b45309' : '#0f172a';
    cell.lines.forEach((l, i) =>
      p.text(l, x, y + labelH + (i + 0.8) * line, {
        size: fit.font,
        bold: cell.label === 'Titre' || !!cell.highlight,
        color,
      }),
    );
  }
}
