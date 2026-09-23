import { describe, expect, it } from 'vitest';
import { imageToScreen, screenToImage, type Viewport } from '../viewport/viewport.ts';
import { createAreaObject, createLineObject, createTextObject } from './objectFactory.ts';
import {
  bakeRotation,
  geometryBox,
  geometryCenter,
  moveGeometryTo,
  moveVertex,
  normalizeAngle,
  normalizeTransform,
  resizeGeometry,
  rotatePoint,
  worldVertices,
} from './shapes.ts';
import { makeDocument } from '@/test/fixtures.ts';
import type { PlanObject } from './types.ts';

const doc = makeDocument();
const rect = createAreaObject(
  doc,
  { kind: 'rect', x: 100, y: 200, width: 300, height: 150, cornerRadius: 0 },
  'zone.parking',
);
const ellipse = createAreaObject(doc, { kind: 'ellipse', cx: 50, cy: 60, rx: 40, ry: 20 }, 'zone.custom');
const polygon = createAreaObject(
  doc,
  {
    kind: 'polygon',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ],
  },
  'zone.storage',
);
const polyline = createLineObject(doc, {
  kind: 'polyline',
  curved: false,
  points: [
    { x: 10, y: 10 },
    { x: 60, y: 10 },
    { x: 60, y: 90 },
  ],
});
const label = createTextObject(doc, { x: 500, y: 400 }, { label: true, text: 'DORTOIR 1', fontSize: 24 });

describe('création de chaque géométrie (via les modèles)', () => {
  it('rectangle Stationnement : type, nom, style et calque du modèle', () => {
    expect(rect).toMatchObject({
      type: 'zone',
      name: 'Stationnement employés',
      presetId: 'zone.parking',
      rotation: 0,
      showName: true,
      icon: { symbolId: 'sign.parking' },
    });
    expect(doc.layers.find((l) => l.id === rect.layerId)?.tier).toBe('parking');
    expect(rect.style.fillOpacity).toBeLessThan(0.5); // la photo reste visible dessous
  });

  it('bâtiment : type building, niveau bâtiments', () => {
    const b = createAreaObject(doc, polygon.geometry as never, 'building.dormitory');
    expect(b).toMatchObject({ type: 'building', name: 'Dortoir' });
    expect(doc.layers.find((l) => l.id === b.layerId)?.tier).toBe('buildings');
  });

  it('ligne à 2 points, polyligne, texte, étiquette', () => {
    expect(
      createLineObject(doc, {
        kind: 'polyline',
        curved: false,
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
        ],
      }).name,
    ).toBe('Ligne');
    expect(polyline.name).toBe('Polyligne');
    expect(label).toMatchObject({ type: 'text', text: 'DORTOIR 1', label: { padding: expect.any(Number) } });
    expect(createTextObject(doc, { x: 0, y: 0 }, { label: false, text: 'A', fontSize: 20 })).toMatchObject({
      label: null,
    });
  });
});

describe('boîtes, déplacement, redimensionnement', () => {
  it('boîte et centre', () => {
    expect(geometryBox(ellipse.geometry)).toEqual({ x: 10, y: 40, width: 80, height: 40 });
    expect(geometryCenter(polygon.geometry)).toEqual({ x: 50, y: 25 });
  });

  it('moveGeometryTo place le coin haut-gauche', () => {
    expect(geometryBox(moveGeometryTo(polygon.geometry, 500, 600))).toEqual({
      x: 500,
      y: 600,
      width: 100,
      height: 50,
    });
    expect(moveGeometryTo(ellipse.geometry, 0, 0)).toMatchObject({ cx: 40, cy: 20 });
  });

  it('resizeGeometry garde le coin haut-gauche et met les points à l’échelle', () => {
    expect(resizeGeometry(rect.geometry, 600, 75)).toMatchObject({ x: 100, y: 200, width: 600, height: 75 });
    const p = resizeGeometry(polygon.geometry, 200, 100);
    expect(p.kind === 'polygon' && p.points).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
    ]);
  });
});

describe('normalisation du Transformer (aucune échelle stockée)', () => {
  it('rectangle : width 100 × scaleX 2 devient width 200', () => {
    const r = normalizeTransform(rect, { x: 250, y: 275, rotation: 0, scaleX: 2, scaleY: 1 });
    expect(r.geometry).toMatchObject({ width: 600, height: 150, x: -50, y: 200 });
    expect(r).not.toHaveProperty('scaleX');
  });

  it('rotation conservée comme angle, autour du centre', () => {
    const r = normalizeTransform(rect, { x: 250, y: 275, rotation: 390, scaleX: 1, scaleY: 1 });
    expect(r.rotation).toBe(30);
    expect(geometryCenter(r.geometry)).toEqual({ x: 250, y: 275 });
  });

  it('ellipse : rayons mis à l’échelle, centre déplacé', () => {
    const e = normalizeTransform(ellipse, { x: 0, y: 0, rotation: 0, scaleX: 0.5, scaleY: 3 });
    expect(e.geometry).toEqual({ kind: 'ellipse', cx: 0, cy: 0, rx: 20, ry: 60 });
  });

  it('polygone : points mis à l’échelle autour du centre, le rendu est inchangé', () => {
    const t = { x: 70, y: 40, rotation: 45, scaleX: 2, scaleY: 0.5 };
    const p = normalizeTransform(polygon, t);
    // Rendu attendu d'un point : centre + R(rot) · S(scale) · (p − ancien centre).
    const c = geometryCenter(polygon.geometry);
    const expected = (pt: { x: number; y: number }) =>
      rotatePoint(
        { x: t.x + (pt.x - c.x) * t.scaleX, y: t.y + (pt.y - c.y) * t.scaleY },
        { x: t.x, y: t.y },
        t.rotation,
      );
    const before = (polygon.geometry as { points: { x: number; y: number }[] }).points.map(expected);
    worldVertices(p).forEach((v, i) => {
      expect(v.x).toBeCloseTo(before[i]!.x, 9);
      expect(v.y).toBeCloseTo(before[i]!.y, 9);
    });
    expect(p.rotation).toBe(45);
  });

  it('texte / étiquette : l’échelle devient une taille de police', () => {
    const t = normalizeTransform(label, { x: 10, y: 20, rotation: -15, scaleX: 2, scaleY: 2 });
    expect(t).toMatchObject({ fontSize: 48, rotation: -15, geometry: { x: 10, y: 20 } });
    expect(t.type === 'text' && t.label?.padding).toBeCloseTo(
      (label as Extract<PlanObject, { type: 'text' }>).label!.padding * 2,
    );
  });

  it('angles normalisés dans ]-180, 180]', () => {
    expect(normalizeAngle(270)).toBe(-90);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(720)).toBe(0);
  });
});

describe('édition des sommets', () => {
  it('déplacer un sommet sans rotation', () => {
    const m = moveVertex(polyline, 1, { x: 70, y: 0 });
    expect(m.geometry.kind === 'polyline' && m.geometry.points[1]).toEqual({ x: 70, y: 0 });
  });

  it('avec rotation : la rotation est d’abord intégrée, les autres sommets ne bougent pas à l’écran', () => {
    const rotated = { ...polygon, rotation: 90 } as PlanObject;
    const before = worldVertices(rotated);
    const edited = moveVertex(rotated, 0, { x: -500, y: -500 });
    expect(edited.rotation).toBe(0);
    const after = worldVertices(edited);
    expect(after[0]).toEqual({ x: -500, y: -500 });
    for (const i of [1, 2]) {
      expect(after[i]!.x).toBeCloseTo(before[i]!.x, 9);
      expect(after[i]!.y).toBeCloseTo(before[i]!.y, 9);
    }
    expect(worldVertices(bakeRotation(rotated))).toEqual(
      before.map((p) => ({ x: expect.closeTo(p.x, 9), y: expect.closeTo(p.y, 9) })),
    );
  });
});

describe('géométrie ↔ écran à différents zooms', () => {
  it('un coin de rectangle retombe exactement sur le même pixel image à tous les zooms', () => {
    const corner = { x: 100, y: 200 };
    for (const scale of [0.125, 0.25, 0.5, 1, 2, 4]) {
      const v: Viewport = { scale, x: 37.5, y: -12.25 };
      const screen = imageToScreen(v, corner);
      const back = screenToImage(v, screen);
      expect(back.x).toBeCloseTo(corner.x, 9);
      expect(back.y).toBeCloseTo(corner.y, 9);
    }
    // La géométrie stockée ne dépend jamais du zoom.
    expect(rect.geometry).toEqual({ kind: 'rect', x: 100, y: 200, width: 300, height: 150, cornerRadius: 0 });
  });
});
