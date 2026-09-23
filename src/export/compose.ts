/**
 * Composition d'une page d'export : bandeau de titre, carte (photo + annotations), légende,
 * cartouche, nord et barre d'échelle. Deux temps :
 * 1. `layoutPage` : mise en page (mesures de texte comprises), sans rien dessiner ;
 * 2. `drawPage` : dessin sur une surface (aperçu, PNG, JPG ou PDF), avec la même mise en page.
 * Tout ce qui pourrait tromper le lecteur est signalé : texte trop petit ou coupé, légende ou
 * cartouche trop grands, plan non calibré (pas d'échelle), nord non défini ou à vérifier.
 */
import { metersPerPixel } from '@/domain/model/measure.ts';
import type { LegendSettings, PlanDocument, PrintSettings } from '@/domain/model/types.ts';
import { exportedObjects, shownLegendEntries, type ShownLegendEntry } from '@/domain/print/legend.ts';
import { PAPER } from '@/domain/print/paper.ts';
import { scaleBar, scaleRatioText } from '@/domain/print/scaleBar.ts';
import {
  type RevisionHistoryRow,
  type RevisionStamp,
  STATUS_LABELS,
  titleBlockRows,
} from '@/domain/print/titleBlock.ts';
import type { PhotoRegion, SymbolSource } from './assets.ts';
import {
  drawLegend,
  drawTitleBlock,
  fitLegend,
  fitTitleBlock,
  fitTitleBlockWithin,
  type LegendFit,
  type Rect,
  type TitleBlockFit,
} from './blocks.ts';
import { grayscalePainter, MM_PER_PT, rectPath, type Painter } from './painter.ts';
import { drawPlanObjects, objectBounds, toPage, type MapTransform, type SceneIssue } from './planScene.ts';

export type { Rect };

export interface ExportWarning {
  code:
    | 'small-text'
    | 'cut-text'
    | 'legend-overflow'
    | 'legend-over-building'
    | 'title-block-overflow'
    | 'approval-stale'
    | 'not-calibrated'
    | 'north-undefined'
    | 'north-estimated'
    | 'photo-reduced'
    | 'no-photo'
    | 'empty';
  message: string;
}

export interface ComposeInput {
  doc: PlanDocument;
  siteName: string;
  print: PrintSettings;
  legend: LegendSettings;
  /** Taille de la page (mm). */
  page: { width: number; height: number };
  /** Page papier (nom du format dans l'échelle) ou image (export PNG / JPG « plan seul »). */
  target: 'paper' | 'image';
  now: Date;
  /** Largeur imposée de la colonne latérale (export image), sinon ≈ 22 % de la page. */
  columnWidth?: number;
  /** Vue par public : titre imprimé, mention du public, position du cartouche. */
  title?: string;
  audienceNote?: string;
  titleBlockPlacement?: 'side' | 'bottom';
  /** Export d'une révision figée : numéro, date, auteur, statut et approbation de la révision. */
  revision?: RevisionStamp;
  /** Tableau compact des révisions imprimé au cartouche (la plus récente en premier). */
  revisionHistory?: RevisionHistoryRow[];
}

export interface PageLayout {
  page: { width: number; height: number };
  title: Rect | null;
  /** Cadre de la carte (mm) et correspondance pixels image → mm. */
  map: Rect;
  transform: MapTransform;
  /** Partie de l'image représentée (pixels image). */
  extent: Rect;
  legend: { rect: Rect; fit: LegendFit; overlay: boolean } | null;
  titleBlock: { rect: Rect; fit: TitleBlockFit } | null;
  north: { x: number; y: number; size: number } | null;
  scale: { x: number; y: number; maxMm: number } | null;
  photo: boolean;
  warnings: ExportWarning[];
}

const GAP = 4;
const TITLE_HEIGHT = 11;

/** Mode d'export : ce qui est inclus. */
export function modeIncludes(print: PrintSettings) {
  return {
    photo: print.mode !== 'annotations',
    titleBlock: print.mode !== 'simplified' && print.include.titleBlock,
    legend: print.include.legend,
  };
}

/** Partie de l'image à représenter : l'image entière, ou l'étendue des annotations exportées. */
export function exportExtent(doc: PlanDocument, print: PrintSettings): Rect {
  const base = doc.plan.baseImage;
  const image = base ? { x: 0, y: 0, width: base.width, height: base.height } : null;
  if (print.extent === 'image' && image) return image;
  const boxes = exportedObjects(doc, print.excludedLayerIds, print.excludedObjectIds).map((o) =>
    objectBounds(o, doc),
  );
  if (!boxes.length) return image ?? { x: 0, y: 0, width: 1000, height: 700 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  const pad = Math.max(x1 - x0, y1 - y0) * 0.04 + 10;
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad };
}

function northText(doc: PlanDocument): string {
  const { northStatus, northAngleDeg } = doc.plan;
  const angle = `${Math.round(northAngleDeg)}°`;
  if (northStatus === 'verified') return `Vérifié (${angle} par rapport au haut de l’image)`;
  if (northStatus === 'estimated') return `Estimé (${angle}) — à vérifier`;
  return 'Non défini';
}

function scaleText(input: ComposeInput, k: number): string {
  const cal = input.doc.plan.calibration;
  if (!metersPerPixel(cal)) return 'Plan non calibré — aucune échelle';
  if (input.target === 'image') return 'Voir la barre d’échelle (mesures approximatives)';
  const ratio = scaleRatioText(cal, k);
  return `${ratio} sur ${PAPER[input.print.paper].name} — mesures approximatives`;
}

/** Lignes du cartouche pour une échelle d'impression donnée (mm par pixel image). */
export function composeTitleRows(input: ComposeInput, k: number) {
  return titleBlockRows(input.doc, {
    title: input.title,
    audience: input.audienceNote,
    siteName: input.siteName,
    scaleText: scaleText(input, k),
    northText: northText(input.doc),
    include: input.print.include,
    now: input.now,
    revision: input.revision,
    history: input.revisionHistory,
  });
}

/** Statut imprimé : celui de la révision figée exportée, sinon celui du plan. */
function printedStatus(input: ComposeInput): { approved: boolean; stale: boolean; badge: string } {
  const r = input.revision;
  if (r)
    return {
      approved: r.approved,
      stale: false,
      badge: `RÉVISION ${r.label.toUpperCase()} — ${r.statusLabel.toUpperCase()}${r.approved ? '' : ' — NON APPROUVÉ'}`,
    };
  const block = input.doc.plan.titleBlock;
  const approved = block.status === 'approved';
  const stale = approved && !!block.approvedAt && input.doc.plan.updatedAt > block.approvedAt;
  return {
    approved,
    stale,
    badge: stale
      ? 'APPROUVÉ PUIS MODIFIÉ — À RÉAPPROUVER'
      : approved
        ? 'APPROUVÉ'
        : `${STATUS_LABELS[block.status].toUpperCase()} — NON APPROUVÉ`,
  };
}

function logoAspect(doc: PlanDocument, print: PrintSettings, symbols: SymbolSource | null) {
  const id = doc.plan.titleBlock.logoAssetId;
  if (!id || !print.include.logo || !symbols) return null;
  const image = symbols.logo(id, 10);
  return image ? { aspect: image.width / image.height } : null;
}

/** Carte ajustée dans une boîte (proportions de l'étendue conservées, centrée). */
function fitMap(box: Rect, extent: Rect): { map: Rect; k: number } {
  const k = Math.min(box.width / extent.width, box.height / extent.height);
  const width = extent.width * k;
  const height = extent.height * k;
  return {
    map: { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height },
    k,
  };
}

/** Coin de la carte recouvrant le moins d'objets (les bâtiments comptent beaucoup plus). */
function bestCorner(
  input: ComposeInput,
  m: MapTransform,
  map: Rect,
  size: { width: number; height: number },
  only?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
): { rect: Rect; overBuilding: boolean } {
  const inset = 3;
  const corners = {
    'top-left': { x: map.x + inset, y: map.y + inset },
    'top-right': { x: map.x + map.width - size.width - inset, y: map.y + inset },
    'bottom-left': { x: map.x + inset, y: map.y + map.height - size.height - inset },
    'bottom-right': {
      x: map.x + map.width - size.width - inset,
      y: map.y + map.height - size.height - inset,
    },
  };
  const boxes = exportedObjects(input.doc, input.print.excludedLayerIds, input.print.excludedObjectIds).map(
    (o) => {
      const b = objectBounds(o, input.doc);
      const a = toPage(m, { x: b.x, y: b.y });
      return {
        building: o.type === 'building',
        rect: { x: a.x, y: a.y, width: b.width * m.k, height: b.height * m.k },
      };
    },
  );
  const overlap = (r: Rect, s: Rect) =>
    Math.max(0, Math.min(r.x + r.width, s.x + s.width) - Math.max(r.x, s.x)) *
    Math.max(0, Math.min(r.y + r.height, s.y + s.height) - Math.max(r.y, s.y));
  let best: { rect: Rect; score: number; overBuilding: boolean } | null = null;
  for (const [name, at] of Object.entries(corners)) {
    if (only && name !== only) continue;
    const rect = { ...at, ...size };
    let score = 0;
    let overBuilding = false;
    for (const b of boxes) {
      const a = overlap(rect, b.rect);
      if (a > 0 && b.building) overBuilding = true;
      score += a * (b.building ? 50 : 1);
    }
    if (!best || score < best.score) best = { rect, score, overBuilding };
  }
  return best!;
}

/** Mise en page complète (aucun dessin). `symbols` sert seulement aux proportions du logo. */
export function layoutPage(p: Painter, input: ComposeInput, symbols: SymbolSource | null): PageLayout {
  const { doc, print, page } = input;
  // Style « légende simplifiée » : compacte, sans groupes ni nombres.
  const legendSettings = print.style.simpleLegend
    ? { ...input.legend, mode: 'compact' as const }
    : input.legend;
  const warnings: ExportWarning[] = [];
  const inc = modeIncludes(print);
  const margin = print.marginMm;
  const content = { x: margin, y: margin, width: page.width - 2 * margin, height: page.height - 2 * margin };
  const title = print.include.title
    ? { x: content.x, y: content.y, width: content.width, height: TITLE_HEIGHT }
    : null;
  const body = {
    x: content.x,
    y: content.y + (title ? TITLE_HEIGHT + GAP / 2 : 0),
    width: content.width,
    height: content.height - (title ? TITLE_HEIGHT + GAP / 2 : 0),
  };
  const entries: ShownLegendEntry[] =
    inc.legend && legendSettings.visible
      ? shownLegendEntries(doc, legendSettings, print.excludedLayerIds, print.excludedObjectIds, print.detail)
      : [];
  const wantLegend = entries.length > 0;
  const tbPlacement =
    input.target === 'image' ? 'side' : (input.titleBlockPlacement ?? doc.plan.titleBlock.placement);
  const sideLegend = wantLegend && legendSettings.placement === 'side';
  const sideTitle = inc.titleBlock && tbPlacement === 'side';
  const columnWidth = input.columnWidth ?? Math.min(95, Math.max(55, body.width * 0.22), body.width * 0.4);
  const hasColumn = sideLegend || sideTitle;
  const extent = exportExtent(doc, print);
  const logo = logoAspect(doc, print, symbols);
  const status = printedStatus(input).approved ? ('approved' as const) : ('pending' as const);

  // Cartouche en bas : sa hauteur est réservée avec une échelle provisoire ; son texte est recalculé
  // à la fin avec l'échelle DÉFINITIVE de la carte (l'échelle imprimée est toujours exacte).
  let mapBox: Rect = { ...body, width: body.width - (hasColumn ? columnWidth + GAP : 0) };
  let titleBlock: PageLayout['titleBlock'] = null;
  if (inc.titleBlock && tbPlacement === 'bottom') {
    const width = body.width;
    const columns = Math.max(2, Math.floor(width / 48));
    const guess = fitMap({ ...mapBox, height: mapBox.height * 0.8 }, extent).k;
    const fit = fitTitleBlock(p, composeTitleRows(input, guess), width, columns, logo, status);
    // Une ligne de marge : le texte définitif de l'échelle peut être un peu plus long.
    const height = Math.min(fit.height + fit.font * MM_PER_PT * 1.2, body.height * 0.45);
    titleBlock = { rect: { x: body.x, y: body.y + body.height - height, width, height }, fit };
    mapBox = { ...mapBox, height: body.height - height - GAP };
  }
  let { map, k } = fitMap(mapBox, extent);
  const column: Rect | null = hasColumn
    ? {
        x: body.x + body.width - columnWidth,
        y: body.y,
        width: columnWidth,
        height: titleBlock ? body.height - titleBlock.rect.height - GAP : body.height,
      }
    : null;
  let legendSpace: Rect | null = sideLegend ? column : null;
  if (sideTitle && column) {
    const fit = fitTitleBlock(p, composeTitleRows(input, k), column.width, 2, logo, status);
    const height = Math.min(fit.height, column.height * (sideLegend ? 0.7 : 1));
    titleBlock = {
      rect: { x: column.x, y: column.y + column.height - height, width: column.width, height },
      fit,
    };
    if (legendSpace) legendSpace = { ...column, height: column.height - height - GAP };
  }
  const transform: MapTransform = { x: map.x, y: map.y, originX: extent.x, originY: extent.y, k };

  let legend: PageLayout['legend'] = null;
  if (wantLegend && legendSpace) {
    const fit = fitLegend(p, entries, legendSettings, legendSpace.width, legendSpace.height);
    legend = {
      rect: { x: legendSpace.x, y: legendSpace.y, width: legendSpace.width, height: fit.height },
      fit,
      overlay: false,
    };
  } else if (wantLegend) {
    const width = Math.min(75, map.width * 0.4);
    const fit = fitLegend(p, entries, legendSettings, width, map.height * 0.6);
    const corner = bestCorner(
      input,
      transform,
      map,
      { width, height: fit.height },
      legendSettings.placement === 'map-auto' ? undefined : (legendSettings.placement as 'top-left'),
    );
    if (corner.overBuilding) {
      if (legendSettings.placement === 'map-auto' && column && titleBlock && sideTitle) {
        // Aucun coin libre : la légende rejoint la colonne du cartouche (la carte ne change pas).
        const space = { ...column, height: titleBlock.rect.y - column.y - GAP };
        const f2 = fitLegend(p, entries, legendSettings, space.width, space.height);
        legend = { rect: { ...space, height: f2.height }, fit: f2, overlay: false };
      } else if (legendSettings.placement === 'map-auto') {
        // Aucun coin libre : la légende passe à côté du plan plutôt que de cacher un bâtiment.
        const box = { ...mapBox, width: mapBox.width - columnWidth - GAP };
        ({ map, k } = fitMap(box, extent));
        Object.assign(transform, { x: map.x, y: map.y, k });
        const side = { x: box.x + box.width + GAP, y: mapBox.y, width: columnWidth, height: mapBox.height };
        const f2 = fitLegend(p, entries, legendSettings, side.width, side.height);
        legend = { rect: { ...side, height: f2.height }, fit: f2, overlay: false };
      } else {
        warnings.push({
          code: 'legend-over-building',
          message:
            'La légende posée sur la carte recouvre un bâtiment : choisissez un autre coin ou « À côté du plan ».',
        });
        legend = { rect: corner.rect, fit, overlay: true };
      }
    } else legend = { rect: corner.rect, fit, overlay: true };
  }
  if (legend && legend.fit.omitted > 0)
    warnings.push({
      code: 'legend-overflow',
      message: `Légende : ${legend.fit.omitted} entrée(s) ne tiennent pas (signalées sur le plan). Réduisez la taille, passez en mode compact ou agrandissez le format.`,
    });

  // Cartouche définitif : échelle de la carte telle qu'elle sera imprimée ; texte réduit, puis
  // raccourci de façon visible s'il ne tient pas (jamais dessiné hors de la page).
  if (titleBlock) {
    const { rect } = titleBlock;
    const columns = rect.width > 120 ? Math.max(2, Math.floor(rect.width / 48)) : 2;
    const fit = fitTitleBlockWithin(
      p,
      composeTitleRows(input, k),
      rect.width,
      columns,
      logo,
      status,
      rect.height,
    );
    const height = Math.min(rect.height, fit.height);
    titleBlock = { rect: { ...rect, y: rect.y + rect.height - height, height }, fit };
    if (fit.truncated)
      warnings.push({
        code: 'title-block-overflow',
        message:
          'Cartouche trop long pour la place disponible : la fin des notes n’est pas imprimée (mention « suite non imprimée » sur le plan). Agrandissez le format, placez le cartouche en bas ou raccourcissez les notes.',
      });
  }
  if (printedStatus(input).stale)
    warnings.push({
      code: 'approval-stale',
      message:
        'Plan modifié après son approbation : le bandeau l’indique ; faites approuver la nouvelle version.',
    });

  // Nord : jamais supposé. Affiché seulement s'il a été orienté (estimé ou vérifié).
  let north: PageLayout['north'] = null;
  if (print.include.north) {
    if (doc.plan.northStatus === 'undefined')
      warnings.push({
        code: 'north-undefined',
        message: 'Nord non défini : aucune flèche du nord n’est imprimée (orientez-le dans l’onglet Fond).',
      });
    else {
      const size = Math.min(16, Math.max(9, Math.min(map.width, map.height) * 0.08));
      // Assez loin du bord pour que la mention « Nord estimé — à vérifier » tienne dans la carte.
      const inset = doc.plan.northStatus === 'estimated' ? Math.max(size / 2, 17) : size / 2;
      north = { x: map.x + map.width - inset - 4, y: map.y + size / 2 + 4, size };
      if (
        legend?.overlay &&
        legend.rect.x + legend.rect.width > north.x - size &&
        legend.rect.y < north.y + size
      )
        north.y = legend.rect.y + legend.rect.height + size / 2 + 3;
      if (doc.plan.northStatus === 'estimated')
        warnings.push({
          code: 'north-estimated',
          message: 'Nord estimé : la flèche porte la mention « à vérifier ».',
        });
    }
  }
  // Échelle : seulement si le plan est calibré (jamais de fausse échelle).
  let scale: PageLayout['scale'] = null;
  if (!metersPerPixel(doc.plan.calibration))
    warnings.push({
      code: 'not-calibrated',
      message: 'Plan non calibré : aucune barre d’échelle, mesures en pixels.',
    });
  else if (print.include.scaleBar)
    scale = { x: map.x + 4, y: map.y + map.height - 4, maxMm: Math.min(60, map.width * 0.3) };
  if (
    legend?.overlay &&
    scale &&
    legend.rect.x < scale.x + scale.maxMm &&
    legend.rect.y + legend.rect.height > scale.y - 10
  )
    scale.x = legend.rect.x + legend.rect.width + 4;

  if (inc.photo && !doc.plan.baseImage)
    warnings.push({
      code: 'no-photo',
      message: 'Aucune photo de fond : seules les annotations sont exportées.',
    });
  if (!Object.values(doc.objects).length)
    warnings.push({ code: 'empty', message: 'Le plan ne contient aucune annotation.' });

  return {
    page,
    title,
    map,
    transform,
    extent,
    legend,
    titleBlock,
    north,
    scale,
    photo: inc.photo && !!doc.plan.baseImage,
    warnings,
  };
}

// --- Dessin ------------------------------------------------------------------------------------------

function drawNorth(p: Painter, n: NonNullable<PageLayout['north']>, angle: number, estimated: boolean) {
  const r = n.size / 2;
  p.path(
    [
      Array.from({ length: 48 }, (_, i) => ({
        x: n.x + r * Math.cos((i / 48) * 2 * Math.PI),
        y: n.y + r * Math.sin((i / 48) * 2 * Math.PI),
      })),
    ],
    true,
    { color: '#ffffff', opacity: 0.92 },
    { color: '#0f172a', opacity: 1, width: 0.3 },
  );
  const a = (angle * Math.PI) / 180;
  const at = (u: number, v: number) => ({
    x: n.x + u * Math.cos(a) - v * Math.sin(a),
    y: n.y + u * Math.sin(a) + v * Math.cos(a),
  });
  // Flèche : pointe vers le nord (angle horaire depuis le haut de l'image).
  const tip = at(0, -r * 0.62);
  const tail = at(0, r * 0.62);
  p.path(
    [[tip, at(r * 0.3, r * 0.45), at(0, r * 0.2), at(-r * 0.3, r * 0.45)]],
    true,
    { color: '#0f172a', opacity: 1 },
    null,
  );
  p.path([[tip, tail]], false, null, { color: '#0f172a', opacity: 1, width: 0.25 });
  const label = at(0, -r * 0.62 - 3.2);
  p.text('N', label.x, label.y, {
    size: 9,
    bold: true,
    color: '#0f172a',
    align: 'center',
    baseline: 'middle',
    halo: { color: '#ffffff', width: 0.6 },
  });
  if (estimated)
    p.text('Nord estimé — à vérifier', n.x, n.y + r + 3, {
      size: 6.5,
      bold: true,
      color: '#b45309',
      align: 'center',
      baseline: 'middle',
      halo: { color: '#ffffff', width: 0.5 },
    });
}

function drawScaleBar(p: Painter, doc: PlanDocument, s: NonNullable<PageLayout['scale']>, k: number) {
  const bar = scaleBar(doc.plan.calibration, k, s.maxMm, doc.plan.units);
  if (!bar) return;
  const h = 1.8;
  const y = s.y - 5;
  const bg = rectPath(s.x - 2, y - 5.5, bar.mm + 10, 13);
  p.path([bg], true, { color: '#ffffff', opacity: 0.9 }, null);
  const n = bar.ticks.length - 1;
  const seg = bar.mm / n;
  for (let i = 0; i < n; i++)
    p.path(
      [rectPath(s.x + i * seg, y, seg, h)],
      true,
      { color: i % 2 ? '#ffffff' : '#0f172a', opacity: 1 },
      { color: '#0f172a', opacity: 1, width: 0.2 },
    );
  const fmt = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 });
  bar.ticks.forEach((v, i) => {
    if (i % (n > 4 ? 1 : 1) !== 0) return;
    p.text(fmt.format(v), s.x + i * seg, y - 1, {
      size: 6,
      color: '#0f172a',
      align: 'center',
      baseline: 'bottom',
    });
  });
  p.text(bar.unit, s.x + bar.mm + 2.5, y + h / 2, {
    size: 6.5,
    bold: true,
    color: '#0f172a',
    baseline: 'middle',
  });
  p.text('Échelle approximative (photo non géoréférencée)', s.x, y + h + 3.2, {
    size: 6,
    color: '#334155',
    baseline: 'middle',
  });
}

export interface DrawAssets {
  photo: PhotoRegion | null;
  symbols: SymbolSource | null;
  /** Fond de page : blanc, ou transparent (PNG annotations seules). */
  background: 'white' | 'transparent';
  /** Reçoit les textes trop petits ou coupés, objet par objet (analyse de lisibilité). */
  onSceneIssues?: (issues: SceneIssue[]) => void;
}

/** Dessine la page. Retourne les avertissements de mise en page et de rendu (textes). */
export function drawPage(
  surface: Painter,
  input: ComposeInput,
  layout: PageLayout,
  assets: DrawAssets,
): ExportWarning[] {
  // Noir et blanc : toutes les couleurs converties en niveaux de gris (photo et pictogrammes : à la préparation).
  const p = input.print.style.grayscale ? grayscalePainter(surface) : surface;
  const { doc, print } = input;
  const warnings = [...layout.warnings];
  const { page, map, transform } = layout;
  if (assets.background === 'white')
    p.path([rectPath(0, 0, page.width, page.height)], true, { color: '#ffffff', opacity: 1 }, null);

  if (layout.title) {
    const t = layout.title;
    const block = doc.plan.titleBlock;
    const { approved, stale, badge } = printedStatus(input);
    const badgeWidth = p.textWidth(badge, 8, true);
    p.text(badge, t.x + t.width, t.y + t.height / 2, {
      size: 8,
      bold: true,
      color: approved && !stale ? '#047857' : '#b45309',
      align: 'right',
      baseline: 'middle',
    });
    // Titre mesuré : réduit jusqu'à 9 pt, puis raccourci (signalé) ; jamais sur le statut.
    const room = t.width - badgeWidth - 6;
    let text = input.title || block.title || doc.plan.name;
    let size = 14;
    while (size > 9 && p.textWidth(text, size, true) > room) size -= 0.5;
    if (p.textWidth(text, size, true) > room) {
      while (text.length > 1 && p.textWidth(`${text}…`, size, true) > room) text = text.slice(0, -1);
      text = `${text.trimEnd()}…`;
      warnings.push({
        code: 'cut-text',
        message:
          'Titre trop long pour le bandeau : il est raccourci (le titre complet figure dans le cartouche).',
      });
    }
    p.text(text, t.x, t.y + t.height / 2, { size, bold: true, color: '#0f172a', baseline: 'middle' });
    p.path(
      [
        [
          { x: t.x, y: t.y + t.height },
          { x: t.x + t.width, y: t.y + t.height },
        ],
      ],
      false,
      null,
      { color: '#0f172a', opacity: 1, width: 0.4 },
    );
  }

  const frame = rectPath(map.x, map.y, map.width, map.height);
  if (layout.photo && assets.photo) {
    const ph = assets.photo;
    const a = toPage(transform, { x: ph.rect.x, y: ph.rect.y });
    const w = ph.rect.width * transform.k;
    const h = ph.rect.height * transform.k;
    p.clip([frame], () => {
      p.image(ph.image, a.x, a.y, w, h);
      // Voile blanc du style (rendu seulement) : les annotations ressortent sur la photo.
      if (print.style.photoDim > 0)
        p.path([rectPath(a.x, a.y, w, h)], true, { color: '#ffffff', opacity: print.style.photoDim }, null);
    });
    if (ph.reducedForLimits)
      warnings.push({
        code: 'photo-reduced',
        message: `Photo intégrée à ≈ ${Math.round(ph.dpi)} ppp (limite de mémoire du navigateur).`,
      });
  }
  const issues: SceneIssue[] = drawPlanObjects(
    p,
    doc,
    transform,
    map,
    assets.symbols,
    print.excludedLayerIds,
    {
      strokeScale: print.style.strokeScale,
      minTextPt: print.style.minTextPt,
      iconScale: print.style.iconScale,
      detail: print.detail,
      excludedObjectIds: print.excludedObjectIds,
    },
  );
  assets.onSceneIssues?.(issues);
  p.path([frame], true, null, { color: '#0f172a', opacity: 1, width: 0.35 });

  if (layout.legend)
    drawLegend(p, layout.legend.fit, layout.legend.rect, assets.symbols, layout.legend.overlay);
  if (layout.titleBlock) {
    const id = doc.plan.titleBlock.logoAssetId;
    const logo =
      id && layout.titleBlock.fit.logo
        ? (assets.symbols?.logo(id, layout.titleBlock.fit.logo.height) ?? null)
        : null;
    drawTitleBlock(p, layout.titleBlock.fit, layout.titleBlock.rect, logo);
  }
  if (layout.north) drawNorth(p, layout.north, doc.plan.northAngleDeg, doc.plan.northStatus === 'estimated');
  if (layout.scale) drawScaleBar(p, doc, layout.scale, transform.k);

  const small = [...new Set(issues.filter((i) => i.kind === 'small-text').map((i) => i.name))];
  const cut = [...new Set(issues.filter((i) => i.kind === 'cut-text').map((i) => i.name))];
  if (small.length)
    warnings.push({
      code: 'small-text',
      message: `Texte trop petit pour ce format (< 6 pt) : ${small.slice(0, 5).join(', ')}${small.length > 5 ? '…' : ''}.`,
    });
  if (cut.length)
    warnings.push({
      code: 'cut-text',
      message: `Texte coupé par le cadre de la carte : ${cut.slice(0, 5).join(', ')}${cut.length > 5 ? '…' : ''}.`,
    });
  return warnings;
}

/** Taille de texte (points) d'une valeur en mm : utile aux tests. */
export const ptOf = (mm: number) => mm / MM_PER_PT;
