import { describe, expect, it } from 'vitest';
import {
  centerContent,
  fromViewCenter,
  interpretWheel,
  pinch,
  toViewCenter,
  zoomByStep,
  MAX_SCALE,
  MIN_SCALE,
  type Viewport,
  fitToScreen,
  panBy,
  imageToScreen,
  screenToImage,
  wheelZoomFactor,
  zoomAt,
  zoomToActualSize,
} from './viewport.ts';

const v: Viewport = { scale: 0.25, x: 120, y: -40 };

describe('conversion coordonnées écran ↔ image', () => {
  it('projette un point image vers l’écran', () => {
    expect(imageToScreen(v, { x: 4000, y: 3000 })).toEqual({ x: 1120, y: 710 });
  });

  it('screenToImage est l’inverse exact de imageToScreen', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 7999.5, y: 5999.25 },
      { x: -12, y: 33.3 },
    ]) {
      const back = screenToImage(v, imageToScreen(v, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });
});

describe('zoom autour du curseur', () => {
  it('garde le point image sous le curseur immobile', () => {
    const cursor = { x: 640, y: 380 };
    const before = screenToImage(v, cursor);
    for (const factor of [2, 0.5, 1.1, 7.3]) {
      const zoomed = zoomAt(v, cursor, factor);
      const after = screenToImage(zoomed, cursor);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it('borne l’échelle entre MIN_SCALE et MAX_SCALE sans perdre l’ancrage', () => {
    const cursor = { x: 10, y: 10 };
    const before = screenToImage(v, cursor);
    const huge = zoomAt(v, cursor, 1e6);
    expect(huge.scale).toBe(MAX_SCALE);
    expect(screenToImage(huge, cursor).x).toBeCloseTo(before.x, 9);
    expect(zoomAt(v, cursor, 1e-6).scale).toBe(MIN_SCALE);
  });

  it('un cran de molette avant puis arrière revient à l’état initial', () => {
    const cursor = { x: 300, y: 200 };
    const back = zoomAt(zoomAt(v, cursor, wheelZoomFactor(-100)), cursor, wheelZoomFactor(100));
    expect(back.scale).toBeCloseTo(v.scale, 12);
    expect(back.x).toBeCloseTo(v.x, 9);
    expect(back.y).toBeCloseTo(v.y, 9);
  });
});

describe('pan', () => {
  it('déplace l’image du nombre de pixels écran demandé, sans changer l’échelle', () => {
    const moved = panBy(v, 35, -12);
    expect(moved).toEqual({ scale: v.scale, x: 155, y: -52 });
    const p = { x: 500, y: 500 };
    const a = imageToScreen(v, p);
    const b = imageToScreen(moved, p);
    expect(b.x - a.x).toBeCloseTo(35);
    expect(b.y - a.y).toBeCloseTo(-12);
  });
});

describe('adapter à l’écran / 100 %', () => {
  it('fitToScreen centre une photo 8000×6000 dans la zone de travail', () => {
    const fit = fitToScreen({ width: 8000, height: 6000 }, { width: 1200, height: 800 }, 20);
    expect(fit.scale).toBeCloseTo(760 / 6000);
    const topLeft = imageToScreen(fit, { x: 0, y: 0 });
    const bottomRight = imageToScreen(fit, { x: 8000, y: 6000 });
    expect(topLeft.y).toBeCloseTo(20);
    expect(bottomRight.y).toBeCloseTo(780);
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(600);
  });

  it('zoomToActualSize donne 1 pixel écran par pixel image en gardant le centre', () => {
    const screen = { width: 1000, height: 600 };
    const centerBefore = screenToImage(v, { x: 500, y: 300 });
    const actual = zoomToActualSize(v, screen);
    expect(actual.scale).toBe(1);
    expect(screenToImage(actual, { x: 500, y: 300 }).x).toBeCloseTo(centerBefore.x);
  });
});

describe('zooms successifs autour du curseur', () => {
  it('une suite de zooms avant et arrière à des positions différentes reste exacte', () => {
    let current: Viewport = { scale: 0.21, x: 24, y: 140 };
    const steps: [{ x: number; y: number }, number][] = [
      [{ x: 400, y: 300 }, 1.4],
      [{ x: 400, y: 300 }, 1.4],
      [{ x: 900, y: 120 }, 2.5],
      [{ x: 50, y: 700 }, 0.3],
      [{ x: 640, y: 480 }, 8],
      [{ x: 640, y: 480 }, 1 / 8],
    ];
    for (const [cursor, factor] of steps) {
      const imagePointBefore = screenToImage(current, cursor);
      current = zoomAt(current, cursor, factor);
      const imagePointAfter = screenToImage(current, cursor);
      expect(imagePointAfter.x).toBeCloseTo(imagePointBefore.x, 8);
      expect(imagePointAfter.y).toBeCloseTo(imagePointBefore.y, 8);
    }
  });

  it('zoom avant puis zoom arrière identiques ramènent la même vue', () => {
    const cursor = { x: 777, y: 333 };
    const back = zoomAt(zoomAt(v, cursor, 3), cursor, 1 / 3);
    expect(back.scale).toBeCloseTo(v.scale, 12);
    expect(back.x).toBeCloseTo(v.x, 9);
    expect(back.y).toBeCloseTo(v.y, 9);
  });

  it('boutons + / − : zoom centré sur la zone de travail', () => {
    const screen = { width: 1200, height: 800 };
    const center = { x: 600, y: 400 };
    const before = screenToImage(v, center);
    const zoomed = zoomByStep(v, screen, 1);
    expect(zoomed.scale).toBeCloseTo(v.scale * 1.25);
    expect(screenToImage(zoomed, center).x).toBeCloseTo(before.x);
    expect(zoomByStep(zoomed, screen, -1).scale).toBeCloseTo(v.scale);
  });
});

describe('100 % exact au pixel et recentrage', () => {
  it('zoomToActualSize place l’image sur des pixels entiers', () => {
    const actual = zoomToActualSize({ scale: 0.2137, x: 13.37, y: 7.77 }, { width: 1333, height: 777 });
    expect(actual.scale).toBe(1);
    expect(Number.isInteger(actual.x)).toBe(true);
    expect(Number.isInteger(actual.y)).toBe(true);
  });

  it('recentrer garde le zoom et centre l’image', () => {
    const centered = centerContent(
      { scale: 0.5, x: -999, y: 42 },
      { width: 4000, height: 3000 },
      { width: 1000, height: 800 },
    );
    expect(centered.scale).toBe(0.5);
    const middle = imageToScreen(centered, { x: 2000, y: 1500 });
    expect(middle).toEqual({ x: 500, y: 400 });
  });

  it('fit conserve le ratio : aucune déformation ni recadrage', () => {
    const image = { width: 4896, height: 3672 };
    const screen = { width: 1072, height: 952 };
    const fit = fitToScreen(image, screen);
    const tl = imageToScreen(fit, { x: 0, y: 0 });
    const br = imageToScreen(fit, { x: image.width, y: image.height });
    expect((br.x - tl.x) / (br.y - tl.y)).toBeCloseTo(image.width / image.height, 10);
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(screen.width);
    expect(br.y).toBeLessThanOrEqual(screen.height);
  });
});

describe('pincement tactile', () => {
  it('le point entre les doigts suit leur milieu et l’échelle suit l’écartement', () => {
    const start = { center: { x: 500, y: 400 }, distance: 100 };
    const end = { center: { x: 520, y: 390 }, distance: 250 };
    const anchor = screenToImage(v, start.center);
    const after = pinch(v, start, end);
    expect(after.scale).toBeCloseTo(v.scale * 2.5);
    const p = imageToScreen(after, anchor);
    expect(p.x).toBeCloseTo(520);
    expect(p.y).toBeCloseTo(390);
  });
});

describe('molette de souris ou trackpad', () => {
  const wheel = (
    deltaX: number,
    deltaY: number,
    extra: Partial<{ deltaMode: number; ctrlKey: boolean }> = {},
  ) => interpretWheel({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, metaKey: false, ...extra });

  it('cran de molette : zoom (avant si deltaY < 0)', () => {
    const up = wheel(0, -100);
    const down = wheel(0, 100);
    expect(up.kind).toBe('zoom');
    expect(up.kind === 'zoom' && up.factor).toBeGreaterThan(1);
    expect(down.kind === 'zoom' && down.factor).toBeLessThan(1);
    expect(wheel(0, 3, { deltaMode: 1 }).kind).toBe('zoom');
  });

  it('pincement trackpad (ctrlKey) : zoom fin', () => {
    const w = wheel(0, -4, { ctrlKey: true });
    expect(w.kind).toBe('zoom');
    expect(w.kind === 'zoom' && w.factor).toBeCloseTo(Math.exp(0.04));
  });

  it('défilement à deux doigts : déplacement', () => {
    expect(wheel(12, 6)).toEqual({ kind: 'pan', dx: -12, dy: -6 });
    expect(wheel(0, 8)).toEqual({ kind: 'pan', dx: -0, dy: -8 });
  });
});

describe('préférence de vue (hors projet)', () => {
  it('restaure le même point au centre, quelle que soit la taille de la fenêtre', () => {
    const saved = toViewCenter(v, { width: 1200, height: 800 });
    const restored = fromViewCenter(saved, { width: 1600, height: 1000 });
    expect(restored.scale).toBe(v.scale);
    const center = screenToImage(restored, { x: 800, y: 500 });
    expect(center.x).toBeCloseTo(saved.centerX);
    expect(center.y).toBeCloseTo(saved.centerY);
  });
});
