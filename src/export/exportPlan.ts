/**
 * Exports du plan : PDF (vectoriel, photo intégrée), PNG et JPG (image aplatie NOUVELLE : la photo
 * d'origine stockée n'est jamais réencodée ni modifiée), et aperçu d'impression. Tous passent par
 * la même mise en page (`compose.ts`) : l'aperçu est fidèle au fichier produit. Jamais de capture
 * d'écran : le rendu est indépendant du viewport de l'éditeur.
 */
import type { LoadedBackground } from '@/editor/backgroundImage.ts';
import type { LegendSettings, PlanDocument, PrintSettings } from '@/domain/model/types.ts';
import { pageSize } from '@/domain/print/paper.ts';
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
}

export interface ExportResult {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  warnings: ExportWarning[];
  /** Dimensions de l'image produite (PNG / JPG) ou de la page (PDF, mm). */
  width: number;
  height: number;
  /** Informations sur la photo intégrée au PDF. */
  photo?: { dpi: number; original: boolean };
}

/** Nom de fichier sûr, dérivé du nom du plan et de sa révision. */
export function exportFileName(doc: PlanDocument, extension: string): string {
  const base = (doc.plan.titleBlock.planNumber || doc.plan.name || 'plan')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // accents retirés
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const rev = doc.plan.titleBlock.revision
    ? `-rev${doc.plan.titleBlock.revision.replace(/[^A-Za-z0-9]/g, '')}`
    : '';
  return `${base || 'plan'}${rev}.${extension}`;
}

function composeInput(
  src: ExportSource,
  print: PrintSettings,
  legend: LegendSettings,
  page: { width: number; height: number },
  target: ComposeInput['target'],
  columnWidth?: number,
): ComposeInput {
  return {
    doc: src.doc,
    siteName: src.siteName,
    print,
    legend,
    page,
    target,
    now: src.now ?? new Date(),
    columnWidth,
  };
}

// --- PDF -----------------------------------------------------------------------------------------------

export async function exportPdf(
  src: ExportSource,
  print: PrintSettings,
  legend: LegendSettings,
): Promise<ExportResult> {
  const [{ jsPDF }, { PdfPainter, registerPdfFonts }, fonts] = await Promise.all([
    import('jspdf'),
    import('./pdfPainter.ts'),
    loadExportFonts(),
  ]);
  const page = pageSize(print);
  const pdf = new jsPDF({
    unit: 'mm',
    format: [page.width, page.height],
    orientation: page.width > page.height ? 'landscape' : 'portrait',
    compress: true,
    putOnlyUsedFonts: true,
  });
  registerPdfFonts(pdf, fonts);
  const painter = new PdfPainter(pdf);
  const input = composeInput(src, print, legend, page, 'paper');
  const symbols = await loadSymbolSource(src.doc, src.readBlob, print.dpi / 25.4);
  const layout = layoutPage(painter, input, symbols);
  const base = src.doc.plan.baseImage;
  let photo = null;
  if (layout.photo && src.background && base) {
    photo = await preparePhoto(
      src.background,
      base,
      layout.extent,
      layout.extent.width * layout.transform.k,
      {
        dpi: print.dpi,
        quality: print.jpegQuality,
        target: 'pdf',
        readOriginal: () => src.readBlob(base.blobId),
      },
    );
  }
  const warnings = drawPage(painter, input, layout, { photo, symbols, background: 'white' });
  const block = src.doc.plan.titleBlock;
  pdf.setProperties({
    title: block.title || src.doc.plan.name,
    subject: `${src.siteName} — ${block.status === 'approved' ? 'Approuvé' : 'Non approuvé'}`,
    creator: 'CampPlanner',
    author: block.preparedBy || '',
  });
  const bytes = new Uint8Array(pdf.output('arraybuffer'));
  return {
    bytes,
    mimeType: 'application/pdf',
    fileName: exportFileName(src.doc, 'pdf'),
    warnings,
    width: page.width,
    height: page.height,
    photo: photo ? { dpi: photo.dpi, original: photo.original } : undefined,
  };
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
  print: PrintSettings,
  legend: LegendSettings,
  options: RasterOptions,
): RasterPlan {
  if (options.framing === 'page') {
    const page = pageSize(print);
    return { page, pxPerMm: print.dpi / 25.4, input: composeInput(src, print, legend, page, 'paper') };
  }
  // Plan à la résolution de la photo : une légende « automatique » va à côté (jamais de repli qui
  // réduirait la carte sous la résolution demandée).
  if (legend.placement === 'map-auto') legend = { ...legend, placement: 'side' };
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
  const imagePrint = { ...print, marginMm: margin };
  return {
    page,
    pxPerMm: options.scale / k,
    input: composeInput(src, imagePrint, legend, page, 'image', IMAGE_COLUMN_MM),
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
  print: PrintSettings,
  legend: LegendSettings,
  options: RasterOptions,
): Promise<ExportResult> {
  await loadExportFonts();
  const plan = rasterPlan(src, print, legend, options);
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
  const symbols = await loadSymbolSource(src.doc, src.readBlob, plan.pxPerMm);
  const { layout, warnings } = await paint(
    painter,
    src,
    plan.input,
    symbols,
    plan.pxPerMm,
    options.format === 'png' ? print.background : 'white',
  );
  void layout;
  const type = options.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await canvasBlob(canvas, type, options.format === 'jpeg' ? print.jpegQuality : undefined);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  canvas.width = 0; // libère la mémoire tout de suite
  canvas.height = 0;
  return {
    bytes,
    mimeType: type,
    fileName: exportFileName(src.doc, options.format === 'png' ? 'png' : 'jpg'),
    warnings,
    width: size.width,
    height: size.height,
  };
}

/** Mise en page et dessin sur un canevas (aperçu et exports image). */
async function paint(
  painter: CanvasPainter,
  src: ExportSource,
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
  print: PrintSettings,
  legend: LegendSettings,
  box: { maxWidth: number; maxHeight: number; pixelRatio: number },
  raster?: RasterOptions,
): Promise<PreviewResult> {
  await loadExportFonts();
  const plan = raster
    ? rasterPlan(src, print, legend, raster)
    : { page: pageSize(print), input: composeInput(src, print, legend, pageSize(print), 'paper') };
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
  const symbols = await loadSymbolSource(src.doc, src.readBlob, pxPerMm);
  const { layout, warnings } = await paint(
    painter,
    src,
    plan.input,
    symbols,
    pxPerMm,
    raster?.format === 'png' ? print.background : 'white',
  );
  return { layout, warnings, page };
}
