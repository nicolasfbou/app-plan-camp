/**
 * Analyse de lisibilité du plan IMPRIMÉ (vue et format choisis) : le même moteur de mise en page
 * que le PDF est exécuté sur une surface qui ne dessine rien et relève la boîte de chaque texte et
 * de chaque pictogramme, rattachée à son objet. On en déduit :
 * - les chevauchements texte / texte, texte / pictogramme, pictogramme / pictogramme ;
 * - les textes coupés par le cadre et les textes trop petits pour le format ;
 * - les débordements de mise en page (légende, cartouche, titre).
 * Rien n'est jamais déplacé automatiquement : `proposeLabelPlacement` PROPOSE un emplacement, que
 * l'utilisateur accepte ou refuse.
 */
import { pageSize } from '@/domain/print/paper.ts';
import type { EffectiveSettings } from '@/domain/print/views.ts';
import { exportedObjects } from '@/domain/print/legend.ts';
import { geometryCenter } from '@/domain/model/shapes.ts';
import type { PlanDocument, Point } from '@/domain/model/types.ts';
import type { SymbolSource } from './assets.ts';
import type { Rect } from './blocks.ts';
import { drawPage, layoutPage, type ComposeInput } from './compose.ts';
import {
  MM_PER_PT,
  BASELINE_SHIFT,
  textOrigin,
  type FillSpec,
  type Painter,
  type PainterImage,
  type StrokeSpec,
  type TextSpec,
} from './painter.ts';
import { objectBounds, type MapTransform, type SceneIssue } from './planScene.ts';

export type Measure = (text: string, sizePt: number, bold?: boolean) => number;

interface Recorded {
  owner: string | null;
  kind: 'text' | 'icon';
  text?: string;
  /** Boîte en mm de page. */
  box: Rect;
}

/** Surface d'analyse : aucun dessin, seulement les boîtes des textes et des images. */
class RecordingSurface implements Painter {
  readonly kind = 'canvas' as const;
  readonly items: Recorded[] = [];
  private current: string | null = null;
  constructor(private readonly measure: Measure) {}
  owner(id: string | null) {
    this.current = id;
  }
  path(_s: readonly (readonly Point[])[], _c: boolean, _f: FillSpec | null, _k: StrokeSpec | null) {}
  textWidth(text: string, size: number, bold?: boolean) {
    return this.measure(text, size, bold);
  }
  text(text: string, x: number, y: number, spec: TextSpec) {
    if (!text.trim()) return;
    const w = this.measure(text, spec.size, spec.bold);
    const o = textOrigin(w, x, y, spec);
    const h = spec.size * MM_PER_PT;
    // Boîte du texte (ascendantes à descendantes), pivotée puis englobée.
    const up = h * BASELINE_SHIFT.top;
    const down = h * -BASELINE_SHIFT.bottom;
    const r = ((spec.angle ?? 0) * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const at = (u: number, v: number) => ({ x: o.x + u * cos - v * sin, y: o.y + u * sin + v * cos });
    const pts = [at(0, -up), at(w, -up), at(w, down), at(0, down)];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    this.items.push({
      owner: this.current,
      kind: 'text',
      text,
      box: {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      },
    });
  }
  image(_i: PainterImage, x: number, y: number, width: number, height: number) {
    this.items.push({ owner: this.current, kind: 'icon', box: { x, y, width, height } });
  }
  clip(_s: readonly (readonly Point[])[], draw: () => void) {
    draw();
  }
  withOpacity(_o: number, draw: () => void) {
    draw();
  }
}

/** Pictogrammes « factices » : seule la place qu'ils occupent compte pour l'analyse. */
const PLACEHOLDER: PainterImage = {
  key: 'placeholder',
  drawable: null as unknown as CanvasImageSource,
  width: 1,
  height: 1,
};
const placeholderSymbols: SymbolSource = { get: () => PLACEHOLDER, logo: () => null };

export type ReadabilityKind = 'text-text' | 'text-icon' | 'icon-icon' | 'cut-text' | 'small-text' | 'layout';

export interface ReadabilityIssue {
  /** Clé stable (type + objets) : sert à mémoriser « vérifié » ou « ignoré ». */
  key: string;
  kind: ReadabilityKind;
  objectIds: string[];
  message: string;
  /** Zone concernée, en pixels image (pour y zoomer), si elle est sur la carte. */
  bounds: Rect | null;
  status: 'open' | 'verified' | 'ignored';
  /** Étiquette qu'on peut proposer de déplacer. */
  movable: { objectId: string; kind: 'text' | 'zone-name' } | null;
}

export interface ReadabilityReport {
  issues: ReadabilityIssue[];
  open: number;
  transform: MapTransform;
  map: Rect;
  /** Boîtes relevées sur la carte (pixels image), pour les propositions de placement. */
  labels: { owner: string; kind: 'text' | 'icon'; box: Rect }[];
  page: { width: number; height: number };
}

const TOLERANCE_MM = 0.2;
const overlapArea = (a: Rect, b: Rect, tol = 0) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) - tol) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) - tol);
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

/** Analyse la lisibilité du plan tel qu'il serait imprimé avec ces réglages. */
export function analyzeReadability(
  doc: PlanDocument,
  settings: EffectiveSettings,
  measure: Measure,
  siteName = '',
): ReadabilityReport {
  const surface = new RecordingSurface(measure);
  const page = pageSize(settings.print);
  const input: ComposeInput = {
    doc,
    siteName,
    print: settings.print,
    legend: settings.legend,
    page,
    target: 'paper',
    now: new Date(),
    title: settings.title,
    audienceNote: settings.audienceNote,
    titleBlockPlacement: settings.titleBlockPlacement,
  };
  const layout = layoutPage(surface, input, placeholderSymbols);
  let sceneIssues: SceneIssue[] = [];
  const warnings = drawPage(surface, input, layout, {
    photo: null,
    symbols: placeholderSymbols,
    background: 'white',
    onSceneIssues: (issues) => (sceneIssues = issues),
  });
  const m = layout.transform;
  const toImage = (r: Rect): Rect => ({
    x: (r.x - m.x) / m.k + m.originX,
    y: (r.y - m.y) / m.k + m.originY,
    width: r.width / m.k,
    height: r.height / m.k,
  });
  const reviews = new Map(doc.readabilityReviews.map((r) => [r.key, r.status]));
  const name = (id: string) => {
    const o = doc.objects[id];
    if (!o) return '?';
    return o.type === 'text' ? `« ${o.text.split('\n')[0]!.slice(0, 40)} »` : o.name;
  };
  const movableOf = (id: string): ReadabilityIssue['movable'] => {
    const o = doc.objects[id];
    if (o?.type === 'text') return { objectId: id, kind: 'text' };
    if (o?.type === 'zone' && o.showName) return { objectId: id, kind: 'zone-name' };
    return null;
  };
  const issues: ReadabilityIssue[] = [];
  const add = (issue: Omit<ReadabilityIssue, 'status'>) =>
    issues.push({ ...issue, status: reviews.get(issue.key) ?? 'open' });

  // Chevauchements entre objets différents (sur la carte).
  // Seuls les éléments visibles dans le cadre de la carte comptent (le reste est coupé à l'impression).
  const onMap = surface.items.filter((i) => i.owner && overlapArea(i.box, layout.map) > 0);
  const pairs = new Map<string, { kind: ReadabilityKind; ids: [string, string]; box: Rect }>();
  for (let i = 0; i < onMap.length; i++)
    for (let j = i + 1; j < onMap.length; j++) {
      const a = onMap[i]!;
      const b = onMap[j]!;
      if (a.owner === b.owner || overlapArea(a.box, b.box, TOLERANCE_MM) <= 0) continue;
      const kind: ReadabilityKind =
        a.kind === 'text' && b.kind === 'text'
          ? 'text-text'
          : a.kind === 'icon' && b.kind === 'icon'
            ? 'icon-icon'
            : 'text-icon';
      // Texte en premier (c'est lui qu'on proposera de déplacer).
      const ids = (a.kind === 'icon' && b.kind === 'text' ? [b.owner!, a.owner!] : [a.owner!, b.owner!]) as [
        string,
        string,
      ];
      const sorted = kind === 'text-icon' ? ids : ([...ids].sort() as [string, string]);
      const key = `${kind}:${sorted.join('+')}`;
      const box = union(a.box, b.box);
      const existing = pairs.get(key);
      pairs.set(key, { kind, ids: sorted, box: existing ? union(existing.box, box) : box });
    }
  const LABELS: Record<string, string> = {
    'text-text': 'Textes qui se chevauchent',
    'text-icon': 'Texte sur un pictogramme',
    'icon-icon': 'Pictogrammes qui se chevauchent',
  };
  for (const [key, p] of pairs) {
    const movable = movableOf(p.ids[0]) ?? movableOf(p.ids[1]);
    add({
      key,
      kind: p.kind,
      objectIds: p.ids,
      message: `${LABELS[p.kind]} : ${name(p.ids[0])} et ${name(p.ids[1])}`,
      bounds: toImage(p.box),
      movable,
    });
  }
  // Textes trop petits ou coupés par le cadre (relevés par la scène).
  for (const s of sceneIssues) {
    const box = onMap
      .filter((i) => i.owner === s.objectId)
      .reduce<Rect | null>((acc, i) => (acc ? union(acc, i.box) : i.box), null);
    add({
      key: `${s.kind}:${s.objectId}`,
      kind: s.kind,
      objectIds: [s.objectId],
      message:
        s.kind === 'small-text'
          ? `Texte trop petit à l’impression (< 6 pt) : ${s.name}`
          : `Texte coupé par le cadre de la carte : ${s.name}`,
      bounds: box ? toImage(box) : null,
      movable: s.kind === 'cut-text' ? movableOf(s.objectId) : null,
    });
  }
  // Débordements de mise en page (légende, cartouche, titre).
  for (const w of warnings)
    if (
      ['legend-overflow', 'title-block-overflow', 'legend-over-building'].includes(w.code) ||
      (w.code === 'cut-text' && w.message.startsWith('Titre'))
    )
      add({
        key: `layout:${settings.viewId ?? 'base'}:${w.code}`,
        kind: 'layout',
        objectIds: [],
        message: w.message,
        bounds: null,
        movable: null,
      });

  return {
    issues,
    open: issues.filter((i) => i.status === 'open').length,
    transform: m,
    map: layout.map,
    labels: onMap.map((i) => ({ owner: i.owner!, kind: i.kind, box: toImage(i.box) })),
    page,
  };
}

// --- Placement assisté ---------------------------------------------------------------------------------

export interface PlacementProposal {
  objectId: string;
  kind: 'text' | 'zone-name';
  /** Nouveau centre de l'étiquette (pixels image). */
  at: Point;
  /** Ligne de renvoi vers ce point, ou null. */
  leaderTo: Point | null;
  width: number;
  height: number;
  /** Chevauchement restant (0 = aucun). */
  remainingOverlap: number;
}

/**
 * Cherche un emplacement plus lisible pour une étiquette (texte ou nom de zone) : autour de ce
 * qu'elle désigne, en évitant les autres textes, les pictogrammes et les bâtiments ; ligne de
 * renvoi si elle s'en éloigne. Ne modifie rien : retourne une proposition (ou null).
 */
export function proposeLabelPlacement(
  doc: PlanDocument,
  report: ReadabilityReport,
  objectId: string,
  settings: EffectiveSettings,
): PlacementProposal | null {
  const object = doc.objects[objectId];
  if (!object || (object.type !== 'text' && !(object.type === 'zone' && object.showName))) return null;
  const kind = object.type === 'text' ? 'text' : 'zone-name';
  const own = report.labels.filter((l) => l.owner === objectId && l.kind === 'text');
  if (!own.length) return null;
  const box = own.reduce((acc, l) => union(acc, l.box), own[0]!.box);
  const w = box.width;
  const h = box.height;
  const current = { x: box.x + w / 2, y: box.y + h / 2 };
  // Ce que l'étiquette désigne : le centre de la zone, ou l'ancre actuelle du texte.
  const anchor =
    object.type === 'zone'
      ? geometryCenter(object.geometry)
      : (object.leaderTo ?? { x: object.geometry.x, y: object.geometry.y });
  // Obstacles : autres textes et pictogrammes (dont le propre pictogramme d'une zone), bâtiments.
  const obstacles: { box: Rect; weight: number }[] = [
    ...report.labels
      .filter((l) => l.owner !== objectId || l.kind === 'icon')
      .map((l) => ({ box: l.box, weight: 4 })),
    ...exportedObjects(doc, settings.print.excludedLayerIds, settings.print.excludedObjectIds)
      .filter((o) => o.type === 'building')
      .map((o) => ({ box: objectBounds(o, doc), weight: 1 })),
  ];
  const extent = doc.plan.baseImage
    ? { x: 0, y: 0, width: doc.plan.baseImage.width, height: doc.plan.baseImage.height }
    : null;
  const cost = (c: Point) => {
    const r = { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h };
    let overlap = 0;
    for (const o of obstacles) overlap += overlapArea(r, o.box) * o.weight;
    if (extent && (r.x < extent.x || r.y < extent.y || r.x + w > extent.width || r.y + h > extent.height))
      overlap += w * h * 10;
    return overlap;
  };
  const size = Math.max(w, h);
  let best = { at: current, overlap: cost(current), distance: 0 };
  const start = best.overlap;
  if (start === 0) return null; // déjà lisible
  for (const radius of [0.6, 1, 1.5, 2.2, 3, 4.5, 6].map((f) => f * size)) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      // Ellipse autour de l'ancre (étiquettes plus larges que hautes).
      const c = {
        x: anchor.x + Math.cos(a) * (radius + w / 2),
        y: anchor.y + Math.sin(a) * (radius * 0.6 + h / 2),
      };
      const overlap = cost(c);
      const distance = Math.hypot(c.x - anchor.x, c.y - anchor.y);
      // Moins de chevauchement d'abord ; à égalité, le plus proche de ce qu'il désigne.
      if (
        overlap < best.overlap - 1e-9 ||
        (Math.abs(overlap - best.overlap) < 1e-9 && distance < best.distance)
      )
        best = { at: c, overlap, distance };
    }
    if (best.overlap === 0) break;
  }
  if (best.overlap >= start) return null; // rien de mieux que l'emplacement actuel
  const far = Math.hypot(best.at.x - anchor.x, best.at.y - anchor.y) > size * 0.9;
  return {
    objectId,
    kind,
    at: best.at,
    leaderTo: kind === 'zone-name' || far ? anchor : null,
    width: w,
    height: h,
    remainingOverlap: best.overlap,
  };
}
