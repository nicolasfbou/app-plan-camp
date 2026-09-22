import { describe, expect, it } from 'vitest';
import {
  ImageHeaderError,
  orientedSize,
  readImageHeader,
  readTiffOrientation,
  sniffFormat,
} from './header.ts';

// --- Constructeurs d'octets minimaux, fidèles aux spécifications des formats -------------------

const bytes = (...parts: (number[] | Uint8Array | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : [...p])));
const u16be = (n: number) => [(n >> 8) & 255, n & 255];
const u32be = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >> 8) & 255];
const u32le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

function tiff(orientation: number, littleEndian = true) {
  const u16 = littleEndian ? u16le : u16be;
  const u32 = littleEndian ? u32le : u32be;
  return bytes(
    littleEndian ? 'II' : 'MM',
    u16(42),
    u32(8),
    u16(1),
    u16(0x0112),
    u16(3),
    u32(1),
    u16(orientation),
    [0, 0],
    u32(0),
  );
}

function jpeg(width: number, height: number, orientation?: number) {
  const app1 = orientation
    ? bytes([0xff, 0xe1], u16be(2 + 6 + tiff(orientation).length), 'Exif\0\0', tiff(orientation))
    : bytes();
  const app0 = bytes([0xff, 0xe0], u16be(16), 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof0 = bytes(
    [0xff, 0xc0],
    u16be(17),
    [8],
    u16be(height),
    u16be(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  );
  return bytes([0xff, 0xd8], app0, app1, sof0, [0xff, 0xda, 0, 2], [0xff, 0xd9]);
}

function png(width: number, height: number) {
  return bytes(
    [0x89],
    'PNG\r\n\x1a\n',
    u32be(13),
    'IHDR',
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0],
    [0, 0, 0, 0],
  );
}

function webpChunk(type: string, data: Uint8Array) {
  return bytes(type, u32le(data.length), data, data.length % 2 ? [0] : []);
}

function webp(chunks: Uint8Array[]) {
  const body = bytes(...chunks);
  return bytes('RIFF', u32le(4 + body.length), 'WEBP', body);
}

const vp8 = (w: number, h: number) =>
  webpChunk('VP8 ', bytes([0, 0, 0], [0x9d, 0x01, 0x2a], u16le(w), u16le(h)));
const vp8l = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return webpChunk('VP8L', bytes([0x2f], u32le(bits)));
};
const vp8x = (w: number, h: number) =>
  webpChunk(
    'VP8X',
    bytes(
      [0x08, 0, 0, 0],
      [(w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16],
      [(h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16],
    ),
  );

// --- Tests -------------------------------------------------------------------------------------

describe('détection du format réel (octets, pas extension)', () => {
  it('reconnaît JPG, PNG, WEBP et PDF', () => {
    expect(sniffFormat(jpeg(10, 10))).toBe('jpeg');
    expect(sniffFormat(png(10, 10))).toBe('png');
    expect(sniffFormat(webp([vp8(10, 10)]))).toBe('webp');
    expect(sniffFormat(bytes('%PDF-1.7\n'))).toBe('pdf');
  });

  it('rejette un fichier quelconque renommé en .jpg', () => {
    expect(sniffFormat(bytes('Ceci est un fichier texte.'))).toBeNull();
    expect(() => readImageHeader(bytes('GIF89a...'))).toThrow(ImageHeaderError);
  });
});

describe('dimensions lues sans décodage', () => {
  it('JPG', () => {
    expect(readImageHeader(jpeg(4896, 3672))).toMatchObject({
      format: 'jpeg',
      width: 4896,
      height: 3672,
      exifOrientation: 1,
    });
  });

  it('PNG', () => {
    expect(readImageHeader(png(8000, 6000))).toMatchObject({ format: 'png', width: 8000, height: 6000 });
  });

  it('WEBP avec perte, sans perte et étendu', () => {
    expect(readImageHeader(webp([vp8(1920, 1080)]))).toMatchObject({ width: 1920, height: 1080 });
    expect(readImageHeader(webp([vp8l(5000, 3000)]))).toMatchObject({ width: 5000, height: 3000 });
    expect(readImageHeader(webp([vp8x(16383, 9000), vp8(16383, 9000)]))).toMatchObject({
      width: 16383,
      height: 9000,
    });
  });

  it('rejette un JPEG tronqué avant ses dimensions', () => {
    expect(() => readImageHeader(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toThrow(ImageHeaderError);
  });

  it('rejette un PNG sans IHDR', () => {
    expect(() => readImageHeader(bytes([0x89], 'PNG\r\n\x1a\n', 'garbage'))).toThrow(ImageHeaderError);
  });
});

describe('orientation EXIF', () => {
  it('lit l’orientation en petit et grand boutisme', () => {
    expect(readTiffOrientation(tiff(6, true))).toBe(6);
    expect(readTiffOrientation(tiff(3, false))).toBe(3);
    expect(readTiffOrientation(bytes('xx'))).toBe(1);
  });

  it('un JPEG orienté à 90° (6) a ses dimensions affichées échangées', () => {
    const header = readImageHeader(jpeg(4000, 3000, 6));
    expect(header).toMatchObject({
      storedWidth: 4000,
      storedHeight: 3000,
      exifOrientation: 6,
      width: 3000,
      height: 4000,
    });
  });

  it('l’orientation 3 (180°) ne change pas les dimensions', () => {
    expect(readImageHeader(jpeg(4000, 3000, 3))).toMatchObject({
      width: 4000,
      height: 3000,
      exifOrientation: 3,
    });
  });

  it('WEBP avec bloc EXIF', () => {
    const header = readImageHeader(webp([vp8x(400, 200), webpChunk('EXIF', tiff(8)), vp8(400, 200)]));
    expect(header).toMatchObject({ exifOrientation: 8, width: 200, height: 400 });
  });

  it('orientedSize échange uniquement pour 5 à 8', () => {
    for (const o of [1, 2, 3, 4]) expect(orientedSize(4, 3, o)).toEqual({ width: 4, height: 3 });
    for (const o of [5, 6, 7, 8]) expect(orientedSize(4, 3, o)).toEqual({ width: 3, height: 4 });
  });
});
