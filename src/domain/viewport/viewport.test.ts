import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  type Viewport,
  fitToScreen,
  panBy,
  projectToScreen,
  screenToProject,
  wheelZoomFactor,
  zoomAt,
  zoomToActualSize,
} from './viewport.ts';

const v: Viewport = { scale: 0.25, x: 120, y: -40 };

describe('conversion coordonnées écran ↔ image', () => {
  it('projette un point image vers l’écran', () => {
    expect(projectToScreen(v, { x: 4000, y: 3000 })).toEqual({ x: 1120, y: 710 });
  });

  it('screenToProject est l’inverse exact de projectToScreen', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 7999.5, y: 5999.25 },
      { x: -12, y: 33.3 },
    ]) {
      const back = screenToProject(v, projectToScreen(v, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });
});

describe('zoom autour du curseur', () => {
  it('garde le point image sous le curseur immobile', () => {
    const cursor = { x: 640, y: 380 };
    const before = screenToProject(v, cursor);
    for (const factor of [2, 0.5, 1.1, 7.3]) {
      const zoomed = zoomAt(v, cursor, factor);
      const after = screenToProject(zoomed, cursor);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it('borne l’échelle entre MIN_SCALE et MAX_SCALE sans perdre l’ancrage', () => {
    const cursor = { x: 10, y: 10 };
    const before = screenToProject(v, cursor);
    const huge = zoomAt(v, cursor, 1e6);
    expect(huge.scale).toBe(MAX_SCALE);
    expect(screenToProject(huge, cursor).x).toBeCloseTo(before.x, 9);
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
    const a = projectToScreen(v, p);
    const b = projectToScreen(moved, p);
    expect(b.x - a.x).toBeCloseTo(35);
    expect(b.y - a.y).toBeCloseTo(-12);
  });
});

describe('adapter à l’écran / 100 %', () => {
  it('fitToScreen centre une photo 8000×6000 dans la zone de travail', () => {
    const fit = fitToScreen({ width: 8000, height: 6000 }, { width: 1200, height: 800 }, 20);
    expect(fit.scale).toBeCloseTo(760 / 6000);
    const topLeft = projectToScreen(fit, { x: 0, y: 0 });
    const bottomRight = projectToScreen(fit, { x: 8000, y: 6000 });
    expect(topLeft.y).toBeCloseTo(20);
    expect(bottomRight.y).toBeCloseTo(780);
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(600);
  });

  it('zoomToActualSize donne 1 pixel écran par pixel image en gardant le centre', () => {
    const screen = { width: 1000, height: 600 };
    const centerBefore = screenToProject(v, { x: 500, y: 300 });
    const actual = zoomToActualSize(v, screen);
    expect(actual.scale).toBe(1);
    expect(screenToProject(actual, { x: 500, y: 300 }).x).toBeCloseTo(centerBefore.x);
  });
});
