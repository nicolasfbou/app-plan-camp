/**
 * Exports du plan : PDF (vectoriel, photo intégrée ; une page ou une page par vue), PNG et JPG
 * (image aplatie NOUVELLE : la photo d'origine stockée n'est jamais réencodée ni modifiée), et
 * aperçu d'impression. Tous passent par la même mise en page (`compose.ts`) : l'aperçu est fidèle
 * au fichier produit. Jamais de capture d'écran : le rendu est indépendant du viewport de l'éditeur.
 * Chaque export suit des réglages EFFECTIFS : ceux d'une vue par public, ou ceux du plan de base.
 */
import type { LoadedBackground } from '@/editor/backgroundImage.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { pageSize } from '@/domain/print/paper.ts';
import type { EffectiveSettings } from '@/domain/print/views.ts';
import type { RevisionHistoryRow, RevisionStamp } from '@/domain/print/titleBlock.ts';
import {
  canvasFitFactor,
  createCanvas,
  ExportLimitError,
  fitsCanvas,
  loadSymbolSource,
  preparePhoto,
  type BlobReader,
  type SymbolSource,
} from './assets.ts';
import { CanvasPainter } from './canvasPainter.ts';
import {
  drawPage,
  exportExtent,
  layoutPage,
  modeIncludes,
  type ComposeInput,
  type ExportWarning,
  type PageLayout,
} from './compose.ts';
import { loadExportFonts } from './fonts.ts';

export { ExportLimitError };

export interface ExportSource {
  doc: PlanDocument;
  siteName: string;
  background: LoadedBackground | null;
  readBlob: BlobReader;
  now?: Date;
  /** Révision figée exportée (cartouche : numéro, date, auteur, statut, approbation). */
  revision?: RevisionStamp;
  /** Tableau des révisions imprimé au cartouche (la plus récente en premier). */
  revisionHistory?: RevisionHistoryRow[];
}

export interface ExportResult {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  warnings: ExportWarning[];
  /** Dimensions de l'image produite (PNG / JPG) ou de la première page (PDF, mm). */
  width: number;
  height: number;
  /** Informations sur la photo intégrée au PDF. */
  photo?: { dpi: number; original: boolean };
  pages?: number;
}

const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // accents retirés
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Nom de fichier sûr, dérivé du numéro (ou du nom) du plan, de la vue et de la révision. */
export function exportFileName(
  doc: PlanDocument,
  extension: string,
  viewName?: string,
  revisionLabel?: string,
): string {
  const base = slug(doc.plan.titleBlock.planNumber || doc.plan.name || 'plan') || 'plan';
  const view = viewName ? `-${slug(viewName)}` : '';
  const label = revisionLabel ?? doc.plan.titleBlock.revision;
  const rev = label ? `-rev${label.replace(/[^A-Za-z0-9]/g, '')}` : '';
  return `${base}${view}${rev}.${extension}`;
}

function composeInput(
  src: ExportSource,
  settings: EffectiveSettings,
  page: { width: number; height: number },
  target: ComposeInput['target'],
  overrides: {
    print?: EffectiveSettings['print'];
    legend?: EffectiveSettings['legend'];
    columnWidth?: number;
  } = {},
): ComposeInput {
  return {
    doc: src.doc,
    siteName: src.siteName,
    print: overrides.print ?? settings.print,
    legend: overrides.legend ?? settings.legend,
    page,
    target,
    now: src.now ?? new Date(),
    columnWidth: overrides.columnWidth,
    title: settings.title,
    audienceNote: settings.audienceNote,
    titleBlockPlacement: settings.titleBlockPlacement,
    revision: src.revision,
    revisionHistory: src.revisionHistory,
  };
}

const photoAdjust = (s: EffectiveSettings) => ({
  contrast: s.print.style.photoContrast,
  grayscale: s.print.style.grayscale,
});

// --- PDF -----------------------------------------------------------------------------------------------

/**
 * PDF d'une ou plusieurs pages : une page par jeu de réglages (vues par public), chacune à son
 * format. La police et les images communes ne sont intégrées qu'une fois.
 */
export async function exportPdfPages(
  src: ExportSource,
  pagesSettings: EffectiveSettings[],
): Promise<ExportResult> {
  if (!pagesSettings.length) throw new Error('Aucune page à exporter.');
  const [{ jsPDF }, { PdfPainter, registerPdfFonts }, fonts] = await Promise.all([
    import('jspdf'),
    import('./pdfPainter.ts'),
    loadExportFonts(),
  ]);
  const first = pageSize(pagesSettings[0]!.print);
  const orientation = (p: { width: number; height: number }) =>
    p.width > p.height ? 'landscape' : 'portrait';
  const pdf = new jsPDF({
    unit: 'mm',
    format: [first.width, first.height],
    orientation: orientation(first),
    compress: true,
    putOnlyUsedFonts: true,
  });
  registerPdfFonts(pdf, fonts);
  const painter = new PdfPainter(pdf);
  const warnings: ExportWarning[] = [];
  let photoInfo: ExportResult['photo'];
  const base = src.doc.plan.baseImage;
  for (const [index, settings] of pagesSettings.entries()) {
    const page = pageSize(settings.print);
    if (index > 0) pdf.addPage([page.width, page.height], orientation(page));
    const input = composeInput(src, settings, page, 'paper');
    const symbols = await loadSymbolSource(src.doc, src.readBlob, settings.print.dpi / 25.4, {
      grayscale: settings.print.style.grayscale,
    });
    const layout = layoutPage(painter, input, symbols);
    let photo = null;
    if (layout.photo && src.background && base) {
      photo = await preparePhoto(
        src.background,
        base,
        layout.extent,
        layout.extent.width * layout.transform.k,
        {
          dpi: settings.print.dpi,
          quality: settings.print.jpegQuality,
          target: 'pdf',
          readOriginal: () => src.readBlob(base.blobId),
          adjust: photoAdjust(settings),
        },
      );
      // Une image par page distincte (réglages différents) : clé propre à la page.
      if (!photo.original) photo.image = { ...photo.image, key: `photo-${index}` };
      photoInfo ??= { dpi: photo.dpi, original: photo.original };
    }
    const pageWarnings = drawPage(painter, input, layout, { photo, symbols, background: 'white' });
    const prefix = pagesSettings.length > 1 ? `${settings.name} : ` : '';
    warnings.push(...pageWarnings.map((w) => ({ ...w, message: prefix + w.message })));
  }
  const block = src.doc.plan.titleBlock;
  pdf.setProperties({
    title: pagesSettings.length > 1 ? block.title || src.doc.plan.name : pagesSettings[0]!.title,
    subject: src.revision
      ? `${src.siteName} — Révision ${src.revision.label} — ${src.revision.statusLabel}${src.revision.approved ? '' : ' (non approuvé)'}`
      : `${src.siteName} — ${block.status === 'approved' ? 'Approuvé' : 'Non approuvé'}`,
    creator: 'CampPlanner',
    author: src.revision?.author || block.preparedBy || '',
  });
  const bytes = new Uint8Array(pdf.output('arraybuffer'));
  const single = pagesSettings.length === 1 ? pagesSettings[0]! : null;
  return {
    bytes,
    mimeType: 'application/pdf',
    fileName: exportFileName(
      src.doc,
      'pdf',
      single ? (single.viewId ? single.name : undefined) : 'vues',
      src.revision?.label,
    ),
    warnings,
    width: first.width,
    height: first.height,
    photo: photoInfo,
    pages: pagesSettings.length,
  };
}

export function exportPdf(src: ExportSource, settings: EffectiveSettings): Promise<ExportResult> {
  return exportPdfPages(src, [settings]);
}

// --- PNG / JPG -------------------------------------------------------------------------------------------

export interface RasterOptions {
  format: 'png' | 'jpeg';
  /** « page » : la page du PDF en image ; « image » : le plan à la résolution de la photo. */
  framing: 'page' | 'image';
  /** Pixels produits par pixel image (cadrage « image » : 1 = résolution d'origine). */
  scale: number;
}

/** Longueur (mm) du plus grand côté de la carte en cadrage « image » : tailles de texte comparables au Tabloïd. */
const IMAGE_MAP_MM = 400;
const IMAGE_COLUMN_MM = 85;
const IMAGE_MARGIN_MM = 6;

interface RasterPlan {
  page: { width: number; height: number };
  pxPerMm: number;
  input: ComposeInput;
}

/** Page et résolution d'un export image. */
export function rasterPlan(
  src: ExportSource,
  settings: EffectiveSettings,
  options: RasterOptions,
): RasterPlan {
  const { print } = settings;
  if (options.framing === 'page') {
    const page = pageSize(print);
    return { page, pxPerMm: print.dpi / 25.4, input: composeInput(src, settings, page, 'paper') };
  }
  // Plan à la résolution de la photo : une légende « automatique » va à côté (jamais de repli qui
  // réduirait la carte sous la résolution demandée).
  const legend =
    settings.legend.placement === 'map-auto'
      ? { ...settings.legend, placement: 'side' as const }
      : settings.legend;
  const extent = exportExtent(src.doc, print);
  // mm de « page » par pixel image : carte d'environ 400 mm, mais au moins 4 px par mm pour que la
  // légende et le cartouche restent lisibles sur une petite photo.
  const k = Math.min(IMAGE_MAP_MM / Math.max(extent.width, extent.height), options.scale / 4);
  const map = { width: extent.width * k, height: extent.height * k };
  const inc = modeIncludes(print);
  const column = (inc.legend && legend.visible && legend.placement === 'side') || inc.titleBlock;
  const framed = column || print.include.title;
  const margin = framed ? IMAGE_MARGIN_MM : 0;
  const title = print.include.title ? 11 + 2 : 0;
  const page = {
    width: map.width + 2 * margin + (column ? IMAGE_COLUMN_MM + 4 : 0),
    height: map.height + 2 * margin + title,
  };
  // Les réglages de marge et de colonne de la page image priment sur ceux du papier.
  return {
    page,
    pxPerMm: options.scale / k,
    input: composeInput(src, settings, page, 'image', {
      print: { ...print, marginMm: margin },
      legend,
      columnWidth: IMAGE_COLUMN_MM,
    }),
  };
}

/** Dimensions en pixels d'un export image, et facteur maximal accepté par le navigateur. */
export function rasterSize(plan: RasterPlan): {
  width: number;
  height: number;
  fits: boolean;
  maxFactor: number;
} {
  const width = Math.round(plan.page.width * plan.pxPerMm);
  const height = Math.round(plan.page.height * plan.pxPerMm);
  return { width, height, fits: fitsCanvas(width, height), maxFactor: canvasFitFactor(width, height) };
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new ExportLimitError('Encodage de l’image impossible (mémoire insuffisante).', null)),
      type,
      quality,
    ),
  );
}

export async function exportRaster(
  src: ExportSource,
  settings: EffectiveSettings,
  options: RasterOptions,
): Promise<ExportResult> {
  await loadExportFonts();
  const { print } = settings;
  const plan = rasterPlan(src, settings, options);
  const size = rasterSize(plan);
  if (!size.fits) {
    // Jamais d'échec silencieux : on indique la résolution maximale possible.
    const factor = Math.floor(size.maxFactor * 100) / 100;
    const suggestion =
      options.framing === 'page'
        ? Math.max(72, Math.floor(print.dpi * factor))
        : Math.max(0.05, Math.floor(options.scale * factor * 100) / 100);
    throw new ExportLimitError(
      `Image de ${size.width} × ${size.height} px : trop grande pour le navigateur (max. ${16384} px de côté, ${120} millions de pixels). ` +
        (options.framing === 'page'
          ? `Résolution proposée : ${suggestion} ppp.`
          : `Facteur proposé : × ${suggestion}.`),
      suggestion,
    );
  }
  const canvas = createCanvas(size.width, size.height);
  const painter = new CanvasPainter(canvas.getContext('2d')!, plan.pxPerMm);
  const symbols = await loadSymbolSource(src.doc, src.readBlob, plan.pxPerMm, {
    grayscale: print.style.grayscale,
  });
  const { warnings } = await paint(
    painter,
    src,
    settings,
    plan.input,
    symbols,
    plan.pxPerMm,
    options.format === 'png' ? print.background : 'white',
  );
  const type = options.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await canvasBlob(canvas, type, options.format === 'jpeg' ? print.jpegQuality : undefined);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  canvas.width = 0; // libère la mémoire tout de suite
  canvas.height = 0;
  return {
    bytes,
    mimeType: type,
    fileName: exportFileName(
      src.doc,
      options.format === 'png' ? 'png' : 'jpg',
      settings.viewId ? settings.name : undefined,
      src.revision?.label,
    ),
    warnings,
    width: size.width,
    height: size.height,
  };
}

/** Mise en page et dessin sur un canevas (aperçu et exports image). */
async function paint(
  painter: CanvasPainter,
  src: ExportSource,
  settings: EffectiveSettings,
  input: ComposeInput,
  symbols: SymbolSource,
  pxPerMm: number,
  background: 'white' | 'transparent',
): Promise<{ layout: PageLayout; warnings: ExportWarning[] }> {
  const layout = layoutPage(painter, input, symbols);
  const base = src.doc.plan.baseImage;
  const photo =
    layout.photo && src.background && base
      ? await preparePhoto(src.background, base, layout.extent, layout.extent.width * layout.transform.k, {
          dpi: pxPerMm * 25.4,
          quality: 1,
          target: 'preview',
          adjust: photoAdjust(settings),
        })
      : null;
  const transparent = background === 'transparent' && input.print.mode === 'annotations';
  const warnings = drawPage(painter, input, layout, {
    photo,
    symbols,
    background: transparent ? 'transparent' : 'white',
  });
  return { layout, warnings };
}

// --- Aperçu -------------------------------------------------------------------------------------------------

export interface PreviewResult {
  layout: PageLayout;
  warnings: ExportWarning[];
  page: { width: number; height: number };
}

/**
 * Aperçu fidèle : la même page que le PDF (ou l'image), dessinée dans `canvas` à `maxWidth` ×
 * `maxHeight` pixels CSS au plus (densité de l'écran comprise).
 */
export async function renderPreview(
  canvas: HTMLCanvasElement,
  src: ExportSource,
  settings: EffectiveSettings,
  box: { maxWidth: number; maxHeight: number; pixelRatio: number },
  raster?: RasterOptions,
): Promise<PreviewResult> {
  await loadExportFonts();
  const plan = raster
    ? rasterPlan(src, settings, raster)
    : {
        page: pageSize(settings.print),
        input: composeInput(src, settings, pageSize(settings.print), 'paper'),
      };
  const { page } = plan;
  const cssPerMm = Math.min(box.maxWidth / page.width, box.maxHeight / page.height);
  const pxPerMm = cssPerMm * box.pixelRatio;
  canvas.width = Math.max(1, Math.round(page.width * pxPerMm));
  canvas.height = Math.max(1, Math.round(page.height * pxPerMm));
  canvas.style.width = `${Math.round(page.width * cssPerMm)}px`;
  canvas.style.height = `${Math.round(page.height * cssPerMm)}px`;
  const c = canvas.getContext('2d');
  if (!c) throw new ExportLimitError('Aperçu impossible : mémoire insuffisante.', null);
  c.clearRect(0, 0, canvas.width, canvas.height);
  const painter = new CanvasPainter(c, pxPerMm);
  const symbols = await loadSymbolSource(src.doc, src.readBlob, pxPerMm, {
    grayscale: settings.print.style.grayscale,
  });
  const { layout, warnings } = await paint(
    painter,
    src,
    settings,
    plan.input,
    symbols,
    pxPerMm,
    raster?.format === 'png' ? settings.print.background : 'white',
  );
  return { layout, warnings, page };
}
