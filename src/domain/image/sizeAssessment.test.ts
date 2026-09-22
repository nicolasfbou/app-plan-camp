import { describe, expect, it } from 'vitest';
import { assessImageSize, formatBytes } from './sizeAssessment.ts';
import { defaultPdfDpi, pdfPagePixelSize } from './pdfRaster.ts';

describe('seuils de taille d’image', () => {
  it('normal : photo de drone 20 MP et image 50 MP', () => {
    expect(assessImageSize(5472, 3648).level).toBe('normal');
    expect(assessImageSize(8660, 5773).level).toBe('normal'); // ≈ 50 MP
  });

  it('grande : au-delà de 50 MP, ou un côté au-delà de 16 384 px', () => {
    const big = assessImageSize(10000, 8000);
    expect(big).toMatchObject({ level: 'large', reasons: ['megapixels'] });
    expect(big.decodedBytes).toBe(10000 * 8000 * 4);
    expect(assessImageSize(20000, 2000)).toMatchObject({ level: 'large', reasons: ['side'] });
  });

  it('dangereuse : au-delà de 120 MP ou d’un côté de 32 767 px', () => {
    expect(assessImageSize(30000, 30000)).toMatchObject({
      level: 'dangerous',
      reasons: ['megapixels-critical', 'side'],
    });
    expect(assessImageSize(40000, 1000)).toMatchObject({ level: 'dangerous', reasons: ['side-critical'] });
  });

  it('formate les tailles en français', () => {
    expect(formatBytes(7_896_834)).toBe('7,5 Mo');
    expect(formatBytes(512)).toBe('512 octets');
  });
});

describe('rendu PDF', () => {
  it('convertit les points PDF en pixels selon la résolution', () => {
    // Page lettre : 612 × 792 points.
    expect(pdfPagePixelSize(612, 792, 72)).toEqual({ width: 612, height: 792 });
    expect(pdfPagePixelSize(612, 792, 300)).toEqual({ width: 2550, height: 3300 });
  });

  it('choisit la résolution la plus fine qui reste sous 50 MP', () => {
    expect(defaultPdfDpi(612, 792)).toBe(300); // lettre à 300 ppp ≈ 8,4 MP
    expect(defaultPdfDpi(2384, 3370)).toBe(150); // A0 : 300 ppp ≈ 155 MP, 200 ≈ 69 MP, 150 ≈ 39 MP
  });
});
