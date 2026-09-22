/**
 * Lecture des en-têtes d'image SANS décodage : format réel (d'après les octets, pas l'extension),
 * dimensions stockées et orientation EXIF. Permet d'avertir avant d'allouer une texture énorme.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp';
export type SourceFormat = ImageFormat | 'pdf';

export const MIME_TYPES: Record<SourceFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

export interface ImageHeader {
  format: ImageFormat;
  /** Dimensions telles que stockées dans le fichier (avant orientation). */
  storedWidth: number;
  storedHeight: number;
  /** Orientation EXIF (1 à 8). 1 = aucune transformation. */
  exifOrientation: number;
  /** Dimensions affichées, orientation appliquée : c'est l'espace de coordonnées du projet. */
  width: number;
  height: number;
}

export class ImageHeaderError extends Error {
  override name = 'ImageHeaderError';
}

const ascii = (b: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...b.subarray(offset, offset + length));

export function sniffFormat(bytes: Uint8Array): SourceFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-') return 'pdf';
  return null;
}

/** Orientations 5 à 8 font pivoter l'image d'un quart de tour : largeur et hauteur s'échangent. */
export function orientedSize(width: number, height: number, orientation: number) {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/** Lit la balise Orientation (0x0112) de l'IFD0 d'un bloc TIFF/EXIF. Retourne 1 si absente. */
export function readTiffOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const order = ascii(tiff, 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const le = order === 'II';
  if (view.getUint16(2, le) !== 42) return 1;
  const ifd = view.getUint32(4, le);
  if (ifd + 2 > tiff.length) return 1;
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (view.getUint16(entry, le) === 0x0112) {
      const value = view.getUint16(entry + 8, le);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function readJpeg(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) throw new ImageHeaderError('Structure JPEG invalide.');
    const marker = b[offset + 1]!;
    if (marker === 0xff) {
      offset++; // octet de remplissage
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // fin d'image ou début des données
    const length = view.getUint16(offset + 2);
    const segment = offset + 4;
    if (marker === 0xe1 && ascii(b, segment, 6) === 'Exif\0\0') {
      orientation = readTiffOrientation(b.subarray(segment + 6, offset + 2 + length));
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && segment + 5 <= b.length) {
      return { height: view.getUint16(segment + 1), width: view.getUint16(segment + 3), orientation };
    }
    offset += 2 + length;
  }
  throw new ImageHeaderError('Dimensions JPEG introuvables.');
}

function readPng(b: Uint8Array) {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') throw new ImageHeaderError('En-tête PNG invalide.');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), orientation: 1 };
}

function readWebp(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u24 = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
  let size: { width: number; height: number } | null = null;
  let orientation = 1;
  let offset = 12;
  while (offset + 8 <= b.length) {
    const type = ascii(b, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (type === 'VP8X' && data + 10 <= b.length) {
      size = { width: u24(data + 4) + 1, height: u24(data + 7) + 1 };
    } else if (type === 'VP8 ' && !size && data + 10 <= b.length) {
      size = {
        width: view.getUint16(data + 6, true) & 0x3fff,
        height: view.getUint16(data + 8, true) & 0x3fff,
      };
    } else if (type === 'VP8L' && !size && data + 5 <= b.length) {
      const bits = view.getUint32(data + 1, true);
      size = { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    } else if (type === 'EXIF') {
      let exif = b.subarray(data, data + length);
      if (ascii(exif, 0, 6) === 'Exif\0\0') exif = exif.subarray(6);
      orientation = readTiffOrientation(exif);
    }
    offset = data + length + (length % 2);
  }
  if (!size) throw new ImageHeaderError('Dimensions WEBP introuvables.');
  return { ...size, orientation };
}

export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const format = sniffFormat(bytes);
  if (!format || format === 'pdf')
    throw new ImageHeaderError("Ce fichier n'est pas une image JPG, PNG ou WEBP.");
  let raw: { width: number; height: number; orientation: number };
  try {
    raw = format === 'jpeg' ? readJpeg(bytes) : format === 'png' ? readPng(bytes) : readWebp(bytes);
  } catch (error) {
    if (error instanceof ImageHeaderError) throw error;
    throw new ImageHeaderError('Fichier image tronqué ou corrompu.');
  }
  if (raw.width <= 0 || raw.height <= 0) throw new ImageHeaderError('Dimensions de l’image invalides.');
  return {
    format,
    storedWidth: raw.width,
    storedHeight: raw.height,
    exifOrientation: raw.orientation,
    ...orientedSize(raw.width, raw.height, raw.orientation),
  };
}
