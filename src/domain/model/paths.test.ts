import { describe, expect, it } from 'vitest';
import { makeDocument } from '@/test/fixtures.ts';
import { detectCrossings, pruneCrossingReviews, reviewFor, setCrossingReview } from './crossings.ts';
import { createCorridorObject, createFlowObject } from './objectFactory.ts';
import { addObject, removeObject } from './operations.ts';
import { bandOutline, distanceToPath, marksAlongPath, pathLength } from './paths.ts';
import type { PlanDocument, Point } from './types.ts';

const P = (x: number, y: number): Point => ({ x, y });

/** Les deux extrémités d'un repère (longueur `length`, orienté selon `angle`) sont sur le tracé. */
function markStaysOnPath(points: Point[], mark: { x: number; y: number; angle: number }, length: number) {
  const r = (mark.angle * Math.PI) / 180;
  const dx = (Math.cos(r) * length) / 2;
  const dy = (Math.sin(r) * length) / 2;
  return (
    distanceToPath(P(mark.x - dx, mark.y - dy), points) < 1e-6 &&
    distanceToPath(P(mark.x + dx, mark.y + dy), points) < 1e-6
  );
}

describe('flèches le long d’un trajet', () => {
  it('tracé droit : régulières, dans le sens du tracé', () => {
    const marks = marksAlongPath([P(0, 0), P(1000, 0)], 100, 20);
    expect(marks).toHaveLength(10);
    expect(marks[0]).toMatchObject({ x: 50, y: 0, angle: 0 });
    for (let i = 1; i < marks.length; i++) expect(marks[i]!.x - marks[i - 1]!.x).toBeCloseTo(100);
  });

  it('virages et angles aigus : chaque flèche tient entièrement sur un segment, jamais hors du chemin', () => {
    const paths = [
      [P(0, 0), P(300, 0), P(300, 300), P(0, 300)], // angles droits
      [P(0, 0), P(400, 10), P(20, 40), P(420, 80)], // zigzag très aigu
      [P(0, 0), P(15, 5), P(30, 0), P(45, 5), P(300, 200)], // segments plus courts qu'une flèche
    ];
    for (const points of paths) {
      const marks = marksAlongPath(points, 60, 24);
      expect(marks.length).toBeGreaterThan(0);
      for (const m of marks) expect(markStaysOnPath(points, m, 24)).toBe(true);
    }
  });

  it('la direction de chaque flèche est celle de son segment', () => {
    const marks = marksAlongPath([P(0, 0), P(200, 0), P(200, 200)], 50, 10);
    expect(marks.filter((m) => m.segment === 0).every((m) => m.angle === 0)).toBe(true);
    expect(marks.filter((m) => m.segment === 1).every((m) => m.angle === 90)).toBe(true);
  });

  it('sommets confondus ignorés ; longueur', () => {
    expect(marksAlongPath([P(0, 0), P(0, 0)], 10, 5)).toEqual([]);
    expect(pathLength([P(0, 0), P(3, 4), P(3, 4)])).toBe(5);
  });
});

describe('contour d’un corridor', () => {
  const h = 10;

  it('droit : un rectangle de la largeur demandée', () => {
    expect(bandOutline([P(0, 0), P(100, 0)], 2 * h)).toEqual([P(0, 10), P(100, 10), P(100, -10), P(0, -10)]);
  });

  it('angle droit, dans les deux sens : coin intérieur et coin extérieur exacts', () => {
    const round = (o: Point[]) => o.map((p) => P(Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6));
    // Virage vers le bas : intérieur (90, 10), extérieur en onglet (110, -10).
    expect(round(bandOutline([P(0, 0), P(100, 0), P(100, 100)], 2 * h))).toEqual([
      P(0, 10),
      P(90, 10),
      P(90, 100),
      P(110, 100),
      P(110, -10),
      P(0, -10),
    ]);
    // Virage vers le haut : symétrique.
    expect(round(bandOutline([P(0, 0), P(100, 0), P(100, -100)], 2 * h))).toEqual([
      P(0, 10),
      P(110, 10),
      P(110, -100),
      P(90, -100),
      P(90, -10),
      P(0, -10),
    ]);
  });

  it('angle aigu : biseau à l’extérieur (pas de pointe démesurée), bords à une demi-largeur', () => {
    const points = [P(0, 0), P(200, 0), P(20, 30)];
    const outline = bandOutline(points, 2 * h);
    expect(outline).toHaveLength(7);
    // Les points du coin (près du sommet (200, 0)) restent tout près : pas de pointe démesurée.
    const corner = outline.filter((p) => p.x > 150);
    expect(corner).toHaveLength(2);
    for (const p of corner) expect(Math.hypot(p.x - 200, p.y)).toBeLessThanOrEqual(h + 1e-6);
    // Tous les points du contour sont exactement à une demi-largeur du tracé.
    for (const p of outline) expect(distanceToPath(p, points)).toBeCloseTo(h, 6);
  });

  it('demi-tour exact : aucune pointe hors du tracé (bout carré)', () => {
    for (const points of [
      [P(0, 0), P(100, 0), P(50, 0)],
      [P(0, 0), P(100, 0), P(50, 0.5)],
      [P(0, 0), P(0, 100), P(0, 20)],
    ]) {
      const outline = bandOutline(points, 10);
      for (const p of outline) expect(distanceToPath(p, points)).toBeLessThanOrEqual(5 * Math.SQRT2 + 1e-6);
    }
  });

  it('demi-tour et segments très courts : contour fini et borné', () => {
    for (const points of [
      [P(0, 0), P(100, 0), P(0, 0.0001)],
      [P(0, 0), P(2, 0), P(2, 2), P(200, 2)],
    ]) {
      const outline = bandOutline(points, 2 * h);
      expect(outline.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
      expect(Math.max(...outline.map((p) => distanceToPath(p, points)))).toBeLessThanOrEqual(2 * h + 1e-6);
    }
  });
});

describe('croisements piétons / véhicules', () => {
  let doc: PlanDocument;
  const flow = (points: Point[]) => {
    const o = createFlowObject(doc, points, 'general');
    addObject(doc, o);
    return o;
  };
  const corridor = (points: Point[], width = 20) => {
    const o = createCorridorObject(doc, points, 1, width);
    addObject(doc, o);
    return o;
  };
  const setup = () => (doc = makeDocument());

  it('un trajet qui coupe un corridor : un marqueur au point de croisement', () => {
    setup();
    const c = corridor([P(0, 100), P(400, 100)]);
    const f = flow([P(200, 0), P(200, 300)]);
    const crossings = detectCrossings(doc);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toMatchObject({
      flowId: f.id,
      corridorId: c.id,
      kind: 'crossing',
      point: P(200, 100),
    });
  });

  it('éloigné : rien ; longe le corridor dans sa largeur : chevauchement signalé', () => {
    setup();
    corridor([P(0, 100), P(400, 100)], 20);
    flow([P(0, 150), P(400, 150)]);
    expect(detectCrossings(doc)).toHaveLength(0);
    flow([P(100, 105), P(130, 105)]);
    expect(detectCrossings(doc).map((c) => c.kind)).toEqual(['overlap']);
  });

  it('la rotation des objets est prise en compte', () => {
    setup();
    corridor([P(0, 100), P(400, 100)]);
    const f = flow([P(100, 0), P(300, 0)]); // parallèle, 100 px au-dessus
    expect(detectCrossings(doc)).toHaveLength(0);
    doc.objects[f.id]!.rotation = 90; // pivoté autour de (200, 0) : devient vertical
    expect(detectCrossings(doc)).toHaveLength(1);
  });

  it('deux croisements voisins : chacun sa décision (vérifier l’un ne masque jamais l’autre)', () => {
    setup();
    corridor([P(0, 100), P(400, 100)], 20);
    flow([P(100, 0), P(100, 200), P(130, 200), P(130, 0)]);
    const crossings = detectCrossings(doc);
    expect(crossings).toHaveLength(2);
    setCrossingReview(doc, crossings[0]!, { status: 'verified' });
    expect(reviewFor(doc, crossings[0]!)?.status).toBe('verified');
    expect(reviewFor(doc, crossings[1]!)).toBeUndefined();
    setCrossingReview(doc, crossings[1]!, { status: 'vigilance' });
    expect(doc.crossingReviews).toHaveLength(2);
    expect(reviewFor(doc, crossings[0]!)?.status).toBe('verified');
    expect(reviewFor(doc, crossings[1]!)?.status).toBe('vigilance');
  });

  it('point de vigilance, note, masquage : conservés si le tracé bouge un peu, supprimés avec l’objet', () => {
    setup();
    const c = corridor([P(0, 100), P(400, 100)]);
    const f = flow([P(200, 0), P(200, 300)]);
    const [crossing] = detectCrossings(doc);
    setCrossingReview(doc, crossing!, { status: 'vigilance', note: 'Prévoir un passage balisé' });
    // Le trajet est décalé de 15 px : la décision suit.
    const moved = doc.objects[f.id]!;
    if (moved.geometry.kind === 'polyline') moved.geometry.points = [P(215, 0), P(215, 300)];
    const [again] = detectCrossings(doc);
    expect(reviewFor(doc, again!)).toMatchObject({ status: 'vigilance', note: 'Prévoir un passage balisé' });
    // Très loin : ce n'est plus le même croisement.
    if (moved.geometry.kind === 'polyline') moved.geometry.points = [P(380, 0), P(380, 300)];
    expect(reviewFor(doc, detectCrossings(doc)[0]!)).toBeUndefined();
    removeObject(doc, c.id);
    expect(pruneCrossingReviews(doc)).toBe(0); // déjà retirée avec le corridor
    expect(doc.crossingReviews).toEqual([]);
  });
});
