/**
 * Images de l'export : pictogrammes (rastérisés à la résolution d'impression, orientés), logo du
 * cartouche et photo de fond. La photo d'origine n'est JAMAIS modifiée : si ses octets JPEG peuvent
 * être intégrés tels quels au PDF, ils le sont ; sinon une COPIE est recadrée / réduite puis
 * encodée pour l'export (l'original stocké reste intact).
 */
import type { LoadedBackground } from '@/editor/backgroundImage.ts';
import { assetIdOf, isAssetSymbol, symbolDataUrl } from '@/domain/symbols/catalog.ts';
import type { BaseImageRef, PlanDocument, SymbolAsset } from '@/domain/model/types.ts';
import { adjustPixels, type PainterImage } from './painter.ts';

/** Limites d'un canevas que les navigateurs créent de façon fiable (côté, surface). */
export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_PIXELS = 120_000_000;

export class ExportLimitError extends Error {
  override name = 'ExportLimitError';
  constructor(
    message: string,
    /** Résolution proposée qui respecte les limites (même unité que la demande). */
    readonly suggestion: number | null,
  ) {
    super(message);
  }
}

export function fitsCanvas(width: number, height: number): boolean {
  return width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE && width * height <= MAX_CANVAS_PIXELS;
}

/** Facteur maximal (≤ 1) à appliquer à une taille pour qu'elle tienne dans un canevas. */
export function canvasFitFactor(width: number, height: number): number {
  return Math.min(
    1,
    MAX_CANVAS_SIDE / Math.max(width, 1),
    MAX_CANVAS_SIDE / Math.max(height, 1),
    Math.sqrt(MAX_CANVAS_PIXELS / Math.max(width * height, 1)),
  );
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (!fitsCanvas(w, h))
    throw new ExportLimitError(`Image de ${w} × ${h} px : dépasse les limites du navigateur.`, null);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  if (!canvas.getContext('2d'))
    throw new ExportLimitError(`Mémoire insuffisante pour une image de ${w} × ${h} px.`, null);
  return canvas;
}

// --- Pictogrammes ------------------------------------------------------------------------------------

export interface SymbolSource {
  /** Pictogramme prêt, orienté, rastérisé pour occuper `sizeMm` à la résolution de l'export. */
  get(symbolId: string, text: string | null, sizeMm: number, rotationDeg: number): PainterImage | null;
  /** Logo du cartouche (pictogramme importé), proportions d'origine. */
  logo(assetId: string, heightMm: number): PainterImage | null;
}

/** Numéro unique des images de pictogrammes (clé d'image du PDF, unique même entre pages). */
let rasterSerial = 0;

export type BlobReader = (blobId: string) => Promise<Uint8Array | null>;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function assetImage(asset: SymbolAsset, readBlob: BlobReader): Promise<HTMLImageElement | null> {
  const bytes = await readBlob(asset.blobId).catch(() => null);
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: asset.mimeType }));
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Pictogrammes utilisés par l'export (objets, zones, corridors, légende, logo). */
export function usedSymbols(doc: PlanDocument): { id: string; text: string | null }[] {
  const out = new Map<string, { id: string; text: string | null }>();
  const add = (id: string, text: string | null = null) => out.set(`${id}\u0000${text ?? ''}`, { id, text });
  for (const o of Object.values(doc.objects)) {
    if (o.type === 'icon') add(o.symbolId, o.text);
    if (o.type === 'zone' && o.icon) add(o.icon.symbolId);
    if (o.type === 'corridor' && o.showIcons) add(o.iconsOriented ? 'mark.footprints' : 'mark.walker');
  }
  return [...out.values()];
}

/**
 * Charge les pictogrammes utilisés, puis les rastérise à la demande (synchrone) à la résolution de
 * l'export : `pxPerMm` pixels par millimètre de page.
 */
export async function loadSymbolSource(
  doc: PlanDocument,
  readBlob: BlobReader,
  pxPerMm: number,
  options: { grayscale?: boolean } = {},
): Promise<SymbolSource> {
  const images = new Map<string, HTMLImageElement>();
  const keyOf = (id: string, text: string | null) =>
    isAssetSymbol(id) ? `${id}:${doc.assets[assetIdOf(id)]?.sha256 ?? ''}` : `${id}:${text ?? ''}`;
  await Promise.all(
    usedSymbols(doc).map(async ({ id, text }) => {
      const asset = isAssetSymbol(id) ? doc.assets[assetIdOf(id)] : undefined;
      const image = asset
        ? await assetImage(asset, readBlob)
        : await loadImage(symbolDataUrl(id, text) ?? 'data:,');
      if (image) images.set(keyOf(id, text), image);
    }),
  );
  const logoId = doc.plan.titleBlock.logoAssetId;
  const logoAsset = logoId ? doc.assets[logoId] : undefined;
  const logoImage = logoAsset ? await assetImage(logoAsset, readBlob) : null;

  const rasters = new Map<string, PainterImage>();
  const raster = (
    key: string,
    image: HTMLImageElement,
    sizeMm: number,
    rotation: number,
    fit: 'square' | 'natural',
  ) => {
    // Résolution : celle de l'export, bornée (un pictogramme n'a pas besoin de plus de 1 024 px).
    const px = Math.max(24, Math.min(1024, Math.round(sizeMm * pxPerMm)));
    const rot = Math.round(rotation / 2) * 2; // pas de 2° : réutilisation des images identiques
    const cacheKey = `${key}@${px}@${rot}@${options.grayscale ? 'g' : 'c'}`;
    const cached = rasters.get(cacheKey);
    if (cached) return cached;
    const w = image.naturalWidth || 1;
    const h = image.naturalHeight || 1;
    const cw = fit === 'natural' ? Math.max(1, Math.round((px * w) / h)) : px;
    const canvas = createCanvas(cw, px);
    const c = canvas.getContext('2d')!;
    c.translate(cw / 2, px / 2);
    c.rotate((rot * Math.PI) / 180);
    // Proportions d'origine conservées (jamais étiré), centré dans le carré.
    const dw = fit === 'natural' ? cw : px * Math.min(1, w / h);
    const dh = fit === 'natural' ? px : px * Math.min(1, h / w);
    c.drawImage(image, -dw / 2, -dh / 2, dw, dh);
    if (options.grayscale) {
      const pixels = c.getImageData(0, 0, cw, px);
      adjustPixels(pixels.data, 1, true);
      c.putImageData(pixels, 0, 0);
    }
    const out: PainterImage = { key: `sym-${++rasterSerial}`, drawable: canvas, width: cw, height: px };
    rasters.set(cacheKey, out);
    return out;
  };
  return {
    get(symbolId, text, sizeMm, rotationDeg) {
      const key = keyOf(symbolId, text);
      const image = images.get(key);
      return image ? raster(key, image, sizeMm, rotationDeg, 'square') : null;
    },
    logo(assetId, heightMm) {
      return logoImage && assetId === logoId
        ? raster(`logo:${assetId}`, logoImage, heightMm, 0, 'natural')
        : null;
    },
  };
}

// --- Photo de fond -----------------------------------------------------------------------------------

export interface PhotoRegion {
  image: PainterImage;
  /** Partie de la photo représentée, en pixels image (espace projet). */
  rect: { x: number; y: number; width: number; height: number };
  /** Résolution effective sur le papier (points par pouce), et si elle a été réduite. */
  dpi: number;
  reducedForLimits: boolean;
  /** Octets d'origine intégrés sans réencodage. */
  original: boolean;
}

/** Niveau de la pyramide d'affichage le plus léger ayant au moins `needFactor` de la résolution. */
function levelFor(background: LoadedBackground, needFactor: number) {
  let best = background.levels[0]!;
  for (const level of background.levels)
    if (level.factor >= needFactor && level.factor < best.factor) best = level;
  return best;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new ExportLimitError('Encodage JPEG impossible (mémoire insuffisante).', null));
        else void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
      },
      'image/jpeg',
      quality,
    ),
  );
}

/**
 * Photo pour l'export : partie `crop` (pixels image) dessinée sur `mmWidth` de papier à `dpi`.
 * - `preview` : copie d'affichage légère, jamais encodée.
 * - PDF : octets d'origine si JPEG sans rotation EXIF, entier, et pas plus fin que nécessaire ;
 *   sinon copie recadrée / réduite encodée en JPEG (`quality`).
 */
export async function preparePhoto(
  background: LoadedBackground,
  base: BaseImageRef,
  crop: { x: number; y: number; width: number; height: number },
  mmWidth: number,
  options: {
    dpi: number;
    quality: number;
    target: 'preview' | 'pdf';
    readOriginal?: () => Promise<Uint8Array | null>;
    /** Réglage du rendu (style d'impression) : appliqué à une copie, jamais à l'original. */
    adjust?: { contrast: number; grayscale: boolean };
  },
): Promise<PhotoRegion> {
  const x0 = Math.max(0, Math.floor(crop.x));
  const y0 = Math.max(0, Math.floor(crop.y));
  const x1 = Math.min(background.width, Math.ceil(crop.x + crop.width));
  const y1 = Math.min(background.height, Math.ceil(crop.y + crop.height));
  const rect = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  const inches = (mmWidth * (rect.width / Math.max(crop.width, 1e-9))) / 25.4;
  const wanted = Math.max(1, inches * options.dpi); // pixels souhaités en largeur
  const factor = Math.min(1, wanted / rect.width);
  const nativeDpi = rect.width / Math.max(inches, 1e-9);

  const adjusted = !!options.adjust && (options.adjust.contrast !== 1 || options.adjust.grayscale);
  if (options.target === 'preview') {
    const level = levelFor(background, factor);
    if (adjusted) {
      // Copie réglée du niveau d'affichage (contraste, gris) : l'original n'est pas touché.
      const copy = createCanvas(level.bitmap.width, level.bitmap.height);
      const c = copy.getContext('2d')!;
      c.drawImage(level.bitmap, 0, 0);
      const pixels = c.getImageData(0, 0, copy.width, copy.height);
      adjustPixels(pixels.data, options.adjust!.contrast, options.adjust!.grayscale);
      c.putImageData(pixels, 0, 0);
      return {
        image: {
          key: `photo-preview-adj-${level.factor}`,
          drawable: copy,
          width: copy.width,
          height: copy.height,
        },
        rect: { x: 0, y: 0, width: background.width, height: background.height },
        dpi: Math.min(options.dpi, nativeDpi),
        reducedForLimits: false,
        original: false,
      };
    }
    return {
      image: {
        key: `photo-preview-${level.factor}`,
        drawable: level.bitmap,
        width: level.bitmap.width,
        height: level.bitmap.height,
      },
      rect: { x: 0, y: 0, width: background.width, height: background.height },
      dpi: Math.min(options.dpi, nativeDpi),
      reducedForLimits: false,
      original: false,
    };
  }

  const whole =
    rect.x === 0 && rect.y === 0 && rect.width === background.width && rect.height === background.height;
  if (
    whole &&
    !adjusted &&
    base.mimeType === 'image/jpeg' &&
    base.exifOrientation === 1 &&
    base.source.kind === 'image' &&
    factor > 0.75 && // l'original n'est pas beaucoup plus fin que nécessaire
    options.readOriginal
  ) {
    const bytes = await options.readOriginal();
    if (bytes)
      return {
        image: {
          key: 'photo',
          drawable: background.levels[0]!.bitmap,
          width: background.width,
          height: background.height,
          jpeg: bytes,
        },
        rect,
        dpi: nativeDpi,
        reducedForLimits: false,
        original: true,
      };
  }
  // Copie recadrée / réduite (l'original reste intact), dans les limites du navigateur.
  const fit = canvasFitFactor(rect.width * factor, rect.height * factor);
  const w = Math.max(1, Math.round(rect.width * factor * fit));
  const h = Math.max(1, Math.round(rect.height * factor * fit));
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d')!;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  const level = levelFor(background, w / rect.width);
  c.drawImage(
    level.bitmap,
    rect.x * level.factor,
    rect.y * level.factor,
    rect.width * level.factor,
    rect.height * level.factor,
    0,
    0,
    w,
    h,
  );
  if (adjusted) {
    const pixels = c.getImageData(0, 0, w, h);
    adjustPixels(pixels.data, options.adjust!.contrast, options.adjust!.grayscale);
    c.putImageData(pixels, 0, 0);
  }
  const jpeg = await canvasToJpeg(canvas, options.quality);
  return {
    image: { key: 'photo', drawable: canvas, width: w, height: h, jpeg },
    rect,
    dpi: w / Math.max(inches, 1e-9),
    reducedForLimits: fit < 1,
    original: false,
  };
}
