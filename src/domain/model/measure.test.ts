import { describe, expect, it } from 'vitest';
import { makeDocument } from '@/test/fixtures.ts';
import {
  calibrationUncertainty,
  corridorWidthPx,
  formatArea,
  formatLength,
  measureObject,
  metersPerPixel,
  polygonArea,
  roundToUncertainty,
} from './measure.ts';
import { createAreaObject, createCorridorObject } from './objectFactory.ts';
import { generateStalls, layoutStalls, stallCount, zoneOutline } from './parking.ts';
import { addObject } from './operations.ts';
import type { Calibration, Point } from './types.ts';

const P = (x: number, y: number): Point => ({ x, y });
// 50 m entre deux points distants de 500 px : 0,1 m par pixel.
const cal: Calibration = { p1: P(0, 0), p2: P(300, 400), distanceMeters: 50 };

describe('calibration et conversions', () => {
  it('mètres par pixel ; sans calibration : rien', () => {
    expect(metersPerPixel(cal)).toBeCloseTo(0.1);
    expect(metersPerPixel(null)).toBeNull();
    expect(metersPerPixel({ ...cal, p2: P(0, 0) })).toBeNull();
  });

  it('incertitude : au moins 2 % ; plus grande si les points sont proches', () => {
    expect(calibrationUncertainty(cal)).toBe(0.02);
    expect(calibrationUncertainty({ ...cal, p2: P(20, 0) })).toBeCloseTo(0.1);
  });

  it('arrondi honnête : jamais plus de chiffres que la précision ne le permet', () => {
    expect(roundToUncertainty(123.456, 0.02)).toEqual({ value: 123, decimals: 0 });
    expect(roundToUncertainty(1234.5, 0.02)).toEqual({ value: 1230, decimals: 0 });
    expect(roundToUncertainty(1.537, 0.02)).toEqual({ value: 1.54, decimals: 2 });
  });

  it('longueurs et surfaces affichées : m / m², pieds, pixels sans calibration', () => {
    expect(formatLength(1234.5, cal)).toBe('≈ 123 m');
    expect(formatLength(1234.5, null)).toBe(`1${' '}235 px`.replace(' ', formatSep()));
    expect(formatLength(1000, cal, 'imperial')).toBe('≈ 328 pi');
    // 100 × 50 px = 5 000 px² = 50 m² (± 4 %).
    expect(formatArea(5000, cal)).toBe('≈ 50 m²');
  });
});

/** Séparateur de milliers de fr-CA (espace insécable fine ou normale selon la plateforme). */
function formatSep(): string {
  return new Intl.NumberFormat('fr-CA').format(1000).charAt(1);
}

describe('mesures des objets', () => {
  it('rectangle, polygone, ellipse, tracé', () => {
    const doc = makeDocument();
    const rect = createAreaObject(
      doc,
      { kind: 'rect', x: 0, y: 0, width: 100, height: 50, cornerRadius: 0 },
      'zone.custom',
    );
    expect(measureObject(rect)).toEqual({ perimeter: 300, area: 5000 });
    expect(polygonArea([P(0, 0), P(10, 0), P(10, 10), P(0, 10)])).toBe(100);
    const ellipse = createAreaObject(doc, { kind: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 10 }, 'zone.custom');
    expect(measureObject(ellipse).perimeter).toBeCloseTo(2 * Math.PI * 10, 6);
    expect(measureObject(ellipse).area).toBeCloseTo(Math.PI * 100, 6);
    const corridor = createCorridorObject(doc, [P(0, 0), P(30, 40), P(30, 100)]);
    expect(measureObject(corridor).length).toBe(110);
  });

  it('largeur physique d’un corridor : convertie selon la calibration ; recalculée si elle change ; jamais pour une largeur en pixels', () => {
    expect(corridorWidthPx({ width: 20, widthMeters: 1.5 }, cal)).toBeCloseTo(15);
    expect(corridorWidthPx({ width: 20, widthMeters: 1.5 }, { ...cal, distanceMeters: 100 })).toBeCloseTo(
      7.5,
    );
    expect(corridorWidthPx({ width: 20, widthMeters: null }, cal)).toBe(20);
    expect(corridorWidthPx({ width: 20, widthMeters: 1.5 }, null)).toBe(20);
  });
});

describe('générateur de cases de stationnement', () => {
  it('rectangle : rangées de cases entières, toutes dans la zone', () => {
    const outline = [P(0, 0), P(100, 0), P(100, 60), P(0, 60)];
    const stalls = layoutStalls(outline, { width: 10, length: 20, rows: 2, aisle: 15, angleDeg: 0 });
    expect(stalls).toHaveLength(20);
    for (const s of stalls) {
      expect(s.center.x - 5).toBeGreaterThanOrEqual(-1e-9);
      expect(s.center.x + 5).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it('zone irrégulière (en L) : aucune case ne dépasse du contour', () => {
    const L = [P(0, 0), P(100, 0), P(100, 30), P(40, 30), P(40, 100), P(0, 100)];
    const stalls = layoutStalls(L, { width: 10, length: 20, rows: 4, aisle: 5, angleDeg: 0 });
    expect(stalls.length).toBeGreaterThan(0);
    for (const s of stalls) {
      // Aucune case dans l'encoche (x > 40 et y > 30).
      const inNotch = s.center.x + 5 > 40 + 1e-6 && s.center.y + 10 > 30 + 1e-6;
      expect(inNotch).toBe(false);
    }
  });

  it('orientation : cases pivotées avec les rangées', () => {
    const outline = [P(0, 0), P(200, 0), P(200, 200), P(0, 200)];
    const stalls = layoutStalls(outline, { width: 10, length: 20, rows: 1, aisle: 0, angleDeg: 30 });
    expect(stalls.length).toBeGreaterThan(0);
    expect(stalls.every((s) => s.rotation === 30)).toBe(true);
  });

  it('dans le document : cases indépendantes rattachées à la zone ; régénérer remplace, les cases détachées restent', () => {
    const doc = makeDocument();
    const zone = createAreaObject(
      doc,
      { kind: 'rect', x: 0, y: 0, width: 100, height: 40, cornerRadius: 0 },
      'zone.parking',
    );
    addObject(doc, zone);
    expect(zoneOutline(zone)).toHaveLength(4);
    expect(generateStalls(doc, zone.id, { width: 10, length: 20, rows: 1, aisle: 0, angleDeg: 0 }, 1)).toBe(
      10,
    );
    expect(stallCount(doc, zone.id)).toBe(10);
    const one = Object.values(doc.objects).find((o) => o.type === 'stall')!;
    if (one.type === 'stall') one.parentZoneId = null; // détachée
    expect(generateStalls(doc, zone.id, { width: 20, length: 20, rows: 1, aisle: 0, angleDeg: 0 }, 1)).toBe(
      5,
    );
    expect(Object.values(doc.objects).filter((o) => o.type === 'stall')).toHaveLength(6);
  });
});
