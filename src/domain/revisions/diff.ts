/**
 * Comparaison de deux états d'un plan (révision ↔ révision, révision ↔ brouillon courant).
 *
 * Fonction PURE : les deux documents ne sont jamais modifiés (ils peuvent être figés). Les objets
 * sont appariés par identifiant ; chaque différence est qualifiée (ajout, suppression,
 * déplacement, redimensionnement, tracé, rotation, texte, style, calque, étiquette, ordre,
 * propriétés), avec sa position avant / après pour la comparaison visuelle.
 *
 * Changements AUTOMATIQUES (distingués de ceux de l'utilisateur) : horodatages, renumérotation de
 * l'ordre d'affichage sans changement d'ordre réel, identifiants de fichiers renouvelés (même
 * contenu, même SHA-256), conversion du format de données, lien du brouillon avec sa révision.
 */
import { measureObject, metersPerPixel, polylineLength } from '../model/measure.ts';
import { geometryBox, geometryCenter, rotatePoint } from '../model/shapes.ts';
import type {
  Geometry,
  Layer,
  PlanDocument,
  PlanObject,
  PlanObjectType,
  PlanView,
  Point,
  Style,
} from '../model/types.ts';
import { STATUS_LABELS } from '../print/titleBlock.ts';

export type ObjectChangeKind =
  | 'added'
  | 'removed'
  | 'moved'
  | 'resized'
  | 'reshaped'
  | 'rotated'
  | 'text'
  | 'style'
  | 'layer'
  | 'label'
  | 'order'
  | 'properties';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ObjectChange {
  id: string;
  type: PlanObjectType;
  /** Nom affiché (nom, texte ou type). */
  name: string;
  /** Nature de l'objet pour les phrases (« étiquette » pour un texte sur fond). */
  noun: NounKey;
  kinds: ObjectChangeKind[];
  /** Nature principale (celle du résumé). */
  primary: ObjectChangeKind;
  /** Agrandi (> 1) ou réduit (< 1) : rapport des surfaces ou des longueurs. */
  sizeRatio: number | null;
  details: string[];
  before: Bounds | null;
  after: Bounds | null;
  /** Déplacement du centre (pixels image). */
  shift: Point | null;
}

export type SettingArea =
  'titleBlock' | 'layers' | 'views' | 'print' | 'legend' | 'plan' | 'photo' | 'assets' | 'reviews';

export interface SettingChange {
  area: SettingArea;
  /** Élément concerné (ex. « vue « Fournisseurs » », « calque « Textes » »). */
  subject: string;
  label: string;
  before: string;
  after: string;
}

export interface AutoChange {
  label: string;
  detail: string;
}

export interface PlanDiff {
  objects: ObjectChange[];
  settings: SettingChange[];
  auto: AutoChange[];
  counts: {
    added: number;
    removed: number;
    modified: number;
    settings: number;
    user: number;
    auto: number;
  };
}

export interface DiffOptions {
  /** Versions du format de données des deux états avant conversion (instantanés anciens). */
  schemaVersions?: { before: number; after: number };
  /** Identifiant de la révision « avant » (pour reconnaître un brouillon qui en est issu). */
  beforeRevisionId?: string;
}

// --- Noms ---------------------------------------------------------------------------------------

export type NounKey = PlanObjectType | 'label';
const NOUNS: Record<NounKey, { one: string; many: string; feminine: boolean }> = {
  zone: { one: 'zone', many: 'zones', feminine: true },
  building: { one: 'bâtiment', many: 'bâtiments', feminine: false },
  line: { one: 'ligne', many: 'lignes', feminine: true },
  flow: { one: 'trajet', many: 'trajets', feminine: false },
  corridor: { one: 'corridor piéton', many: 'corridors piétons', feminine: false },
  text: { one: 'texte', many: 'textes', feminine: false },
  label: { one: 'étiquette', many: 'étiquettes', feminine: true },
  icon: { one: 'pictogramme', many: 'pictogrammes', feminine: false },
  dimension: { one: 'cote', many: 'cotes', feminine: true },
  stall: { one: 'case de stationnement', many: 'cases de stationnement', feminine: true },
};

const nounOf = (o: PlanObject): NounKey => (o.type === 'text' && o.label ? 'label' : o.type);

/** Nom affiché : le texte d'un texte ou d'une étiquette (leur nom est générique), sinon le nom. */
function displayName(o: PlanObject): string {
  if (o.type === 'text' && o.text.trim()) {
    const line = o.text.split('\n')[0]!.trim();
    return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
  }
  return o.name.trim();
}

// --- Géométrie ------------------------------------------------------------------------------------

/** Boîte englobante approximative (pixels image, rotation comprise). */
export function approxBounds(o: PlanObject): Bounds {
  const g = o.geometry;
  let pts: Point[];
  if (o.type === 'icon') {
    const h = o.size / 2;
    pts = [
      { x: o.geometry.x - h, y: o.geometry.y - h },
      { x: o.geometry.x + h, y: o.geometry.y + h },
    ];
  } else if (o.type === 'text') {
    const lines = o.text.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * o.fontSize * 0.55 + (o.label?.padding ?? 0) * 2;
    const h = lines.length * o.fontSize * 1.2 + (o.label?.padding ?? 0) * 2;
    pts = [
      { x: o.geometry.x - w / 2, y: o.geometry.y - h / 2 },
      { x: o.geometry.x + w / 2, y: o.geometry.y + h / 2 },
    ];
  } else {
    const box = geometryBox(g);
    const pad = o.type === 'corridor' ? o.width / 2 : 0;
    pts = [
      { x: box.x - pad, y: box.y - pad },
      { x: box.x + box.width + pad, y: box.y - pad },
      { x: box.x + box.width + pad, y: box.y + box.height + pad },
      { x: box.x - pad, y: box.y + box.height + pad },
    ];
    if (o.rotation) {
      const c = geometryCenter(g);
      pts = pts.map((p) => rotatePoint(p, c, o.rotation));
    }
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const EPS = 0.01;
const near = (a: number, b: number) => Math.abs(a - b) <= EPS;

type GeometryChange =
  | { kind: 'moved'; dx: number; dy: number }
  | { kind: 'resized'; ratio: number }
  | { kind: 'reshaped'; ratio: number | null }
  | null;

/** Translation commune de deux listes de points (null si ce n'est pas une translation). */
function translation(a: readonly Point[], b: readonly Point[]): Point | null {
  if (a.length !== b.length || !a.length) return null;
  const dx = b[0]!.x - a[0]!.x;
  const dy = b[0]!.y - a[0]!.y;
  return a.every((p, i) => near(b[i]!.x - p.x, dx) && near(b[i]!.y - p.y, dy)) ? { x: dx, y: dy } : null;
}

function sizeOf(o: PlanObject): number | null {
  if (o.type === 'icon') return o.size;
  const m = measureObject(o);
  return m.area ?? m.length ?? null;
}

function geometryChange(a: PlanObject, b: PlanObject): GeometryChange {
  const ga: Geometry = a.geometry;
  const gb: Geometry = b.geometry;
  if (JSON.stringify(ga) === JSON.stringify(gb)) {
    if (a.type === 'icon' && b.type === 'icon' && !near(a.size, b.size))
      return { kind: 'resized', ratio: b.size / a.size };
    if (a.type === 'corridor' && b.type === 'corridor' && !near(a.width, b.width))
      return { kind: 'resized', ratio: b.width / a.width };
    return null;
  }
  const sa = sizeOf(a);
  const sb = sizeOf(b);
  const ratio = sa && sb ? sb / sa : null;
  if (ga.kind !== gb.kind) return { kind: 'reshaped', ratio };
  let shift: Point | null = null;
  switch (ga.kind) {
    case 'rect': {
      const r = gb as typeof ga;
      if (near(ga.width, r.width) && near(ga.height, r.height) && near(ga.cornerRadius, r.cornerRadius))
        shift = { x: r.x - ga.x, y: r.y - ga.y };
      else if (!near(ga.cornerRadius, r.cornerRadius) && near(ga.width, r.width) && near(ga.height, r.height))
        return { kind: 'reshaped', ratio: null };
      break;
    }
    case 'ellipse': {
      const e = gb as typeof ga;
      if (near(ga.rx, e.rx) && near(ga.ry, e.ry)) shift = { x: e.cx - ga.cx, y: e.cy - ga.cy };
      break;
    }
    case 'point': {
      const p = gb as typeof ga;
      shift = { x: p.x - ga.x, y: p.y - ga.y };
      break;
    }
    case 'polygon':
    case 'polyline': {
      const other = gb as typeof ga;
      const curvedSame = ga.kind !== 'polyline' || ga.curved === (other as typeof ga).curved;
      if (curvedSame) shift = translation(ga.points, other.points);
      break;
    }
  }
  if (shift) {
    if (a.type === 'icon' && b.type === 'icon' && !near(a.size, b.size))
      return { kind: 'resized', ratio: b.size / a.size };
    if (a.type === 'corridor' && b.type === 'corridor' && !near(a.width, b.width))
      return { kind: 'resized', ratio: b.width / a.width };
    return { kind: 'moved', dx: shift.x, dy: shift.y };
  }
  if (ga.kind === 'polyline') return { kind: 'reshaped', ratio };
  if (ratio !== null && Math.abs(ratio - 1) > 0.005) return { kind: 'resized', ratio };
  return { kind: 'reshaped', ratio };
}

// --- Valeurs affichées ----------------------------------------------------------------------------

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (Array.isArray(value)) return value.length ? `${value.length} élément(s)` : 'aucun';
  if (typeof value === 'object') return 'défini';
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

const pct = (ratio: number) => `${ratio >= 1 ? '+' : '−'}${Math.round(Math.abs(ratio - 1) * 100)} %`;

/** Différences feuille à feuille entre deux valeurs JSON (tableaux comparés en entier). */
function leafDiffs(
  a: unknown,
  b: unknown,
  path: string[] = [],
): { path: string; before: unknown; after: unknown }[] {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => leafDiffs(a[k], b[k], [...path, k]));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path: path.join('.'), before: a, after: b }];
}

const STYLE_LABELS: Record<keyof Style, string> = {
  fill: 'remplissage',
  fillOpacity: 'opacité du remplissage',
  stroke: 'contour',
  strokeOpacity: 'opacité du contour',
  strokeWidth: 'épaisseur du trait',
  dash: 'type de trait',
  pattern: 'motif',
};

const PRINT_LABELS: Record<string, string> = {
  paper: 'format du papier',
  orientation: 'orientation',
  marginMm: 'marges',
  mode: 'mode d’export',
  dpi: 'résolution',
  jpegQuality: 'qualité JPEG',
  extent: 'étendue',
  background: 'fond',
  'include.title': 'titre imprimé',
  'include.legend': 'légende imprimée',
  'include.titleBlock': 'cartouche imprimé',
  'include.logo': 'logo imprimé',
  'include.north': 'flèche du nord imprimée',
  'include.scaleBar': 'barre d’échelle imprimée',
  'include.date': 'date imprimée',
  'include.revision': 'révision imprimée',
  'include.notes': 'notes imprimées',
  excludedLayerIds: 'calques exclus',
  excludedObjectIds: 'éléments exclus',
  detail: 'niveau de détail',
  'style.preset': 'style d’impression',
  'style.photoDim': 'atténuation de la photo',
  'style.photoContrast': 'contraste de la photo',
  'style.grayscale': 'noir et blanc',
  'style.strokeScale': 'épaisseur des traits',
  'style.minTextPt': 'taille minimale des textes',
  'style.iconScale': 'taille des pictogrammes',
  'style.simpleLegend': 'légende simplifiée',
};

const LEGEND_LABELS: Record<string, string> = {
  visible: 'légende affichée',
  title: 'titre de la légende',
  placement: 'position de la légende',
  mode: 'mode de la légende',
  sizeFactor: 'taille de la légende',
  hidden: 'entrées masquées',
  labels: 'intitulés personnalisés',
};

export const TITLE_BLOCK_LABELS: Record<string, string> = {
  campName: 'Camp',
  title: 'Titre',
  client: 'Client',
  company: 'Entreprise',
  preparedBy: 'Préparé par',
  checkedBy: 'Vérifié par',
  approvedBy: 'Approuvé par',
  date: 'Date',
  planNumber: 'N° de plan',
  revision: 'Révision',
  notes: 'Notes',
  status: 'Statut',
  approvedAt: 'Date d’approbation',
  logoAssetId: 'Logo',
  placement: 'Position du cartouche',
};

const VIEW_LABELS: Record<string, string> = {
  name: 'nom',
  audience: 'public',
  title: 'titre imprimé',
  audienceNote: 'mention du public',
  titleBlockPlacement: 'position du cartouche',
};

const labelFor = (path: string, table: Record<string, string>) => table[path] ?? path;

// --- Objets ----------------------------------------------------------------------------------------

/** Rang de chaque objet au sein de son calque, parmi les objets présents des deux côtés. */
function ranks(doc: PlanDocument, common: Set<string>): Map<string, number> {
  const byLayer = new Map<string, PlanObject[]>();
  for (const o of Object.values(doc.objects))
    if (common.has(o.id)) byLayer.set(o.layerId, [...(byLayer.get(o.layerId) ?? []), o]);
  const result = new Map<string, number>();
  for (const list of byLayer.values())
    list
      .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))
      .forEach((o, i) => result.set(o.id, i));
  return result;
}

const PRIORITY: ObjectChangeKind[] = [
  'added',
  'removed',
  'resized',
  'reshaped',
  'moved',
  'rotated',
  'text',
  'style',
  'layer',
  'label',
  'order',
  'properties',
];

const IGNORED_FIELDS = new Set([
  'id',
  'type',
  'geometry',
  'style',
  'rotation',
  'layerId',
  'zIndex',
  'name',
  'text',
  'leaderTo',
  'nameOffset',
  'createdAt',
  'updatedAt',
  'size',
  'width',
]);

const TEXT_STYLE_FIELDS = new Set(['fontFamily', 'fontSize', 'fontWeight', 'italic', 'align', 'label']);

const PROPERTY_LABELS: Record<string, string> = {
  visible: 'visibilité',
  locked: 'verrouillage',
  presetId: 'modèle d’objet',
  groupId: 'groupe',
  metadata: 'propriétés',
  icon: 'pictogramme de la zone',
  showName: 'nom affiché',
  category: 'catégorie',
  arrows: 'flèches',
  widthMeters: 'largeur physique',
  showIcons: 'pictogrammes du corridor',
  iconSpacing: 'espacement des pictogrammes',
  iconSize: 'taille des pictogrammes',
  iconsOriented: 'orientation des pictogrammes',
  symbolId: 'symbole',
  parentZoneId: 'zone d’origine',
  fontFamily: 'police',
  fontSize: 'taille du texte',
  fontWeight: 'graisse',
  italic: 'italique',
  align: 'alignement',
  label: 'fond de l’étiquette',
};

function distanceText(shift: Point, before: PlanDocument, after: PlanDocument): string {
  const px = Math.hypot(shift.x, shift.y);
  // Distance physique seulement si les deux états ont la MÊME calibration (jamais inventée).
  const cal = before.plan.calibration;
  const same = JSON.stringify(cal) === JSON.stringify(after.plan.calibration);
  const mpp = same ? metersPerPixel(cal) : null;
  return mpp ? `environ ${Math.round(px * mpp * 10) / 10} m` : `${Math.round(px)} px (image)`;
}

/**
 * Déplacement du centre qui ne s'explique pas par un simple redimensionnement (poignée tirée d'un
 * côté : le centre bouge au plus de la moitié du changement de taille).
 */
function extraShift(a: PlanObject, b: PlanObject): Point | null {
  const ba = approxBounds(a);
  const bb = approxBounds(b);
  const dx = bb.x + bb.width / 2 - (ba.x + ba.width / 2);
  const dy = bb.y + bb.height / 2 - (ba.y + ba.height / 2);
  const centered = a.type === 'icon' || a.type === 'corridor';
  const allowX = centered ? 0.5 : Math.abs(bb.width - ba.width) / 2 + 0.5;
  const allowY = centered ? 0.5 : Math.abs(bb.height - ba.height) / 2 + 0.5;
  return Math.abs(dx) > allowX || Math.abs(dy) > allowY ? { x: dx, y: dy } : null;
}

function compareObject(
  a: PlanObject,
  b: PlanObject,
  before: PlanDocument,
  after: PlanDocument,
  rankA: Map<string, number>,
  rankB: Map<string, number>,
): { change: ObjectChange | null; timestampOnly: boolean; renumbered: boolean } {
  const kinds: ObjectChangeKind[] = [];
  const details: string[] = [];
  let sizeRatio: number | null = null;
  let shift: Point | null = null;
  const geo = geometryChange(a, b);
  // Redimensionné ET déplacé : les deux sont signalés (flèche de déplacement comprise).
  const moveToo = geo && geo.kind !== 'moved' ? extraShift(a, b) : null;
  if (geo?.kind === 'moved') {
    kinds.push('moved');
    shift = { x: geo.dx, y: geo.dy };
    details.push(`déplacé de ${distanceText(shift, before, after)}`);
  } else if (geo?.kind === 'resized') {
    kinds.push('resized');
    sizeRatio = geo.ratio;
    details.push(`${geo.ratio >= 1 ? 'agrandi' : 'réduit'} (${pct(geo.ratio)})`);
  } else if (geo?.kind === 'reshaped') {
    kinds.push('reshaped');
    sizeRatio = geo.ratio;
    const g = b.geometry;
    const what = g.kind === 'polyline' ? 'tracé modifié' : 'forme modifiée';
    const len =
      g.kind === 'polyline' && a.geometry.kind === 'polyline'
        ? ` (${a.geometry.points.length} → ${g.points.length} points, longueur ${pct(polylineLength(g.points) / Math.max(1e-9, polylineLength(a.geometry.points)))})`
        : '';
    details.push(what + len);
  }
  if (moveToo) {
    kinds.push('moved');
    shift = moveToo;
    details.push(`déplacé de ${distanceText(moveToo, before, after)}`);
  }
  if (!near(a.rotation, b.rotation)) {
    kinds.push('rotated');
    details.push(`rotation ${Math.round(a.rotation)}° → ${Math.round(b.rotation)}°`);
  }
  if (a.name !== b.name) {
    kinds.push('text');
    details.push(`nom « ${show(a.name)} » → « ${show(b.name)} »`);
  }
  const textA = 'text' in a ? a.text : null;
  const textB = 'text' in b ? b.text : null;
  if (JSON.stringify(textA) !== JSON.stringify(textB)) {
    if (!kinds.includes('text')) kinds.push('text');
    details.push(`texte « ${show(textA)} » → « ${show(textB)} »`);
  }
  const styleDiffs = leafDiffs(a.style, b.style);
  const textStyle =
    a.type === 'text' && b.type === 'text'
      ? [...TEXT_STYLE_FIELDS].filter(
          (k) =>
            JSON.stringify((a as Record<string, unknown>)[k]) !==
            JSON.stringify((b as Record<string, unknown>)[k]),
        )
      : [];
  if (styleDiffs.length || textStyle.length) {
    kinds.push('style');
    for (const d of styleDiffs)
      details.push(`${labelFor(d.path, STYLE_LABELS)} ${show(d.before)} → ${show(d.after)}`);
    for (const k of textStyle) details.push(`${PROPERTY_LABELS[k] ?? k} modifié(e)`);
  }
  if (a.layerId !== b.layerId) {
    kinds.push('layer');
    const name = (doc: PlanDocument, id: string) => doc.layers.find((l) => l.id === id)?.name ?? '?';
    details.push(`calque « ${name(before, a.layerId)} » → « ${name(after, b.layerId)} »`);
  }
  const leaderA = 'leaderTo' in a ? a.leaderTo : 'nameOffset' in a ? a.nameOffset : null;
  const leaderB = 'leaderTo' in b ? b.leaderTo : 'nameOffset' in b ? b.nameOffset : null;
  if (JSON.stringify(leaderA) !== JSON.stringify(leaderB)) {
    kinds.push('label');
    details.push(leaderB ? 'étiquette déplacée (ligne de renvoi)' : 'étiquette remise en place');
  }
  const orderChanged = a.layerId === b.layerId && rankA.get(a.id) !== rankB.get(a.id);
  if (orderChanged) {
    kinds.push('order');
    details.push('ordre d’affichage modifié');
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const props = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter(
    (k) =>
      !IGNORED_FIELDS.has(k) && !TEXT_STYLE_FIELDS.has(k) && JSON.stringify(ra[k]) !== JSON.stringify(rb[k]),
  );
  if (props.length) {
    kinds.push('properties');
    details.push(...props.map((k) => `${PROPERTY_LABELS[k] ?? k} modifié(e)`));
  }
  if (!kinds.length)
    return {
      change: null,
      timestampOnly: a.updatedAt !== b.updatedAt,
      renumbered: a.zIndex !== b.zIndex && !orderChanged,
    };
  const primary = PRIORITY.find((k) => kinds.includes(k))!;
  return {
    change: {
      id: b.id,
      type: b.type,
      name: displayName(b) || displayName(a),
      noun: nounOf(b),
      kinds,
      primary,
      sizeRatio,
      details,
      before: approxBounds(a),
      after: approxBounds(b),
      shift,
    },
    timestampOnly: false,
    renumbered: false,
  };
}

// --- Réglages ---------------------------------------------------------------------------------------

function compareLayers(a: Layer[], b: Layer[], out: SettingChange[]) {
  const byId = new Map(a.map((l) => [l.id, l]));
  for (const l of b) {
    const old = byId.get(l.id);
    const subject = `calque « ${l.name} »`;
    if (!old) {
      out.push({ area: 'layers', subject, label: 'calque ajouté', before: '—', after: l.name });
      continue;
    }
    if (old.name !== l.name)
      out.push({ area: 'layers', subject, label: 'calque renommé', before: old.name, after: l.name });
    if (old.visible !== l.visible)
      out.push({
        area: 'layers',
        subject,
        label: 'visibilité',
        before: show(old.visible),
        after: show(l.visible),
      });
    if (old.locked !== l.locked)
      out.push({
        area: 'layers',
        subject,
        label: 'verrouillage',
        before: show(old.locked),
        after: show(l.locked),
      });
    if (old.tier !== l.tier)
      out.push({ area: 'layers', subject, label: 'catégorie du calque', before: old.tier, after: l.tier });
    if (!near(old.opacity, l.opacity))
      out.push({
        area: 'layers',
        subject,
        label: 'opacité',
        before: show(old.opacity),
        after: show(l.opacity),
      });
  }
  for (const l of a)
    if (!b.some((x) => x.id === l.id))
      out.push({
        area: 'layers',
        subject: `calque « ${l.name} »`,
        label: 'calque supprimé',
        before: l.name,
        after: '—',
      });
  const orderA = a.filter((l) => b.some((x) => x.id === l.id)).map((l) => l.id);
  const orderB = b.filter((l) => a.some((x) => x.id === l.id)).map((l) => l.id);
  if (orderA.join() !== orderB.join())
    out.push({
      area: 'layers',
      subject: 'calques',
      label: 'ordre des calques',
      before: 'précédent',
      after: 'modifié',
    });
}

function describeExcluded(path: string, value: unknown, doc: PlanDocument): string {
  if (!Array.isArray(value)) return show(value);
  if (path.endsWith('excludedLayerIds'))
    return value.length
      ? value.map((id) => doc.layers.find((l) => l.id === id)?.name ?? '?').join(', ')
      : 'aucun';
  return show(value);
}

function comparePrint(
  subject: string,
  a: PlanDocument['plan']['print'],
  b: PlanDocument['plan']['print'],
  before: PlanDocument,
  after: PlanDocument,
  out: SettingChange[],
) {
  for (const d of leafDiffs(a, b))
    out.push({
      area: 'print',
      subject,
      label: labelFor(d.path, PRINT_LABELS),
      before: describeExcluded(d.path, d.before, before),
      after: describeExcluded(d.path, d.after, after),
    });
}

function compareViews(before: PlanDocument, after: PlanDocument, out: SettingChange[]) {
  const a = before.plan.views;
  const b = after.plan.views;
  for (const v of b) {
    const old = a.find((x) => x.id === v.id);
    const subject = `vue « ${v.name} »`;
    if (!old) {
      out.push({ area: 'views', subject, label: 'vue ajoutée', before: '—', after: v.name });
      continue;
    }
    for (const key of ['name', 'audience', 'title', 'audienceNote', 'titleBlockPlacement'] as const)
      if (old[key] !== v[key])
        out.push({
          area: 'views',
          subject,
          label: VIEW_LABELS[key]!,
          before: show(old[key]),
          after: show(v[key]),
        });
    for (const d of leafDiffs(old.legend, v.legend))
      out.push({
        area: 'views',
        subject,
        label: labelFor(d.path, LEGEND_LABELS),
        before: show(d.before),
        after: show(d.after),
      });
    const printChanges: SettingChange[] = [];
    comparePrint(subject, old.print, v.print, before, after, printChanges);
    out.push(...printChanges.map((c) => ({ ...c, area: 'views' as const })));
  }
  const orderA = a.filter((v) => b.some((x) => x.id === v.id)).map((v) => v.id);
  const orderB = b.filter((v) => a.some((x) => x.id === v.id)).map((v) => v.id);
  if (orderA.join() !== orderB.join())
    out.push({
      area: 'views',
      subject: 'vues',
      label: 'ordre des vues',
      before: 'précédent',
      after: 'modifié',
    });
  for (const v of a)
    if (!b.some((x: PlanView) => x.id === v.id))
      out.push({
        area: 'views',
        subject: `vue « ${v.name} »`,
        label: 'vue supprimée',
        before: v.name,
        after: '—',
      });
}

function compareTitleBlock(before: PlanDocument, after: PlanDocument, out: SettingChange[]) {
  const a = before.plan.titleBlock;
  const b = after.plan.titleBlock;
  for (const d of leafDiffs(a, b)) {
    const value = (v: unknown) =>
      d.path === 'status' ? (STATUS_LABELS[v as keyof typeof STATUS_LABELS] ?? show(v)) : show(v);
    out.push({
      area: 'titleBlock',
      subject: 'cartouche',
      label: labelFor(d.path, TITLE_BLOCK_LABELS),
      before: value(d.before),
      after: value(d.after),
    });
  }
}

function comparePlan(before: PlanDocument, after: PlanDocument, out: SettingChange[], auto: AutoChange[]) {
  const a = before.plan;
  const b = after.plan;
  const push = (label: string, x: unknown, y: unknown) =>
    out.push({ area: 'plan', subject: 'plan', label, before: show(x), after: show(y) });
  if (a.name !== b.name) push('nom du plan', a.name, b.name);
  if (a.kind !== b.kind) push('type de plan', a.kind, b.kind);
  if (JSON.stringify(a.calibration) !== JSON.stringify(b.calibration))
    out.push({
      area: 'plan',
      subject: 'plan',
      label: 'calibration',
      before: a.calibration ? `${a.calibration.distanceMeters} m` : 'non calibré',
      after: b.calibration ? `${b.calibration.distanceMeters} m` : 'non calibré',
    });
  if (a.northStatus !== b.northStatus || !near(a.northAngleDeg, b.northAngleDeg))
    push(
      'nord',
      `${a.northStatus} ${Math.round(a.northAngleDeg)}°`,
      `${b.northStatus} ${Math.round(b.northAngleDeg)}°`,
    );
  if (a.units !== b.units) push('unités', a.units, b.units);
  for (const d of leafDiffs(a.display, b.display)) push(`affichage : ${d.path}`, d.before, d.after);
  const styleKeys = [...new Set([...Object.keys(a.styleOverrides), ...Object.keys(b.styleOverrides)])].filter(
    (k) => JSON.stringify(a.styleOverrides[k]) !== JSON.stringify(b.styleOverrides[k]),
  );
  if (styleKeys.length)
    push('styles d’entreprise', `${Object.keys(a.styleOverrides).length}`, `${styleKeys.length} modifié(s)`);
  if (JSON.stringify(a.metadata) !== JSON.stringify(b.metadata)) push('propriétés du plan', '', 'modifiées');
  if (JSON.stringify(a.variantOf) !== JSON.stringify(b.variantOf))
    push('origine (variante)', a.variantOf?.planName, b.variantOf?.planName);
  for (const d of leafDiffs(a.legend, b.legend))
    out.push({
      area: 'legend',
      subject: 'légende',
      label: labelFor(d.path, LEGEND_LABELS),
      before: show(d.before),
      after: show(d.after),
    });
  comparePrint('plan de base', a.print, b.print, before, after, out);

  // Photo : un contenu différent (SHA-256) est un vrai changement ; un identifiant renouvelé non.
  const ia = a.baseImage;
  const ib = b.baseImage;
  if ((ia?.sha256 ?? null) !== (ib?.sha256 ?? null))
    out.push({
      area: 'photo',
      subject: 'photo',
      label: ia && ib ? 'photo remplacée' : ib ? 'photo ajoutée' : 'photo retirée',
      before: ia ? `${ia.fileName} (${ia.sha256.slice(0, 12)}…)` : '—',
      after: ib ? `${ib.fileName} (${ib.sha256.slice(0, 12)}…)` : '—',
    });
  else if (ia && ib && JSON.stringify(ia) !== JSON.stringify(ib))
    auto.push({
      label: 'Référence de la photo renouvelée',
      detail: 'Même fichier (SHA-256 identique) ; identifiant local ou date d’import différents.',
    });
  if (JSON.stringify(a.draftBase) !== JSON.stringify(b.draftBase))
    auto.push({
      label: 'Lien avec la révision de base',
      detail: `${a.draftBase ? `révision ${a.draftBase.label}` : 'aucune révision'} → ${b.draftBase ? `révision ${b.draftBase.label}` : 'aucune révision'} (enregistré à la création d’une révision)`,
    });
}

function compareAssets(before: PlanDocument, after: PlanDocument, out: SettingChange[], auto: AutoChange[]) {
  let renewed = 0;
  for (const [id, asset] of Object.entries(after.assets)) {
    const old = before.assets[id];
    if (!old)
      out.push({
        area: 'assets',
        subject: `pictogramme importé « ${asset.name} »`,
        label: 'ajouté',
        before: '—',
        after: asset.name,
      });
    else if (old.sha256 !== asset.sha256)
      out.push({
        area: 'assets',
        subject: `pictogramme importé « ${asset.name} »`,
        label: 'fichier remplacé',
        before: old.sha256.slice(0, 12),
        after: asset.sha256.slice(0, 12),
      });
    else if (old.name !== asset.name)
      out.push({
        area: 'assets',
        subject: `pictogramme importé « ${asset.name} »`,
        label: 'renommé',
        before: old.name,
        after: asset.name,
      });
    else if (old.blobId !== asset.blobId) renewed++;
  }
  for (const [id, asset] of Object.entries(before.assets))
    if (!after.assets[id])
      out.push({
        area: 'assets',
        subject: `pictogramme importé « ${asset.name} »`,
        label: 'retiré',
        before: asset.name,
        after: '—',
      });
  if (renewed)
    auto.push({
      label: 'Références de pictogrammes renouvelées',
      detail: `${renewed} fichier(s), contenu identique (SHA-256).`,
    });
}

function compareReviews(before: PlanDocument, after: PlanDocument, out: SettingChange[]) {
  const crossA = new Map(before.crossingReviews.map((r) => [r.id, `${r.status}|${r.note}`]));
  const crossChanged = after.crossingReviews.filter(
    (r) => crossA.get(r.id) !== `${r.status}|${r.note}`,
  ).length;
  const crossRemoved = before.crossingReviews.filter(
    (r) => !after.crossingReviews.some((x) => x.id === r.id),
  ).length;
  if (crossChanged + crossRemoved)
    out.push({
      area: 'reviews',
      subject: 'suivi des croisements',
      label: 'décisions',
      before: String(before.crossingReviews.length),
      after: `${crossChanged} ajoutée(s) ou modifiée(s), ${crossRemoved} retirée(s)`,
    });
  const readA = new Map(before.readabilityReviews.map((r) => [r.key, r.status]));
  const readChanged = after.readabilityReviews.filter((r) => readA.get(r.key) !== r.status).length;
  const readRemoved = before.readabilityReviews.filter(
    (r) => !after.readabilityReviews.some((x) => x.key === r.key),
  ).length;
  if (readChanged + readRemoved)
    out.push({
      area: 'reviews',
      subject: 'suivi de lisibilité',
      label: 'décisions',
      before: String(before.readabilityReviews.length),
      after: `${readChanged} ajoutée(s) ou modifiée(s), ${readRemoved} retirée(s)`,
    });
}

// --- Comparaison ----------------------------------------------------------------------------------

export function diffPlans(before: PlanDocument, after: PlanDocument, options: DiffOptions = {}): PlanDiff {
  const objects: ObjectChange[] = [];
  const settings: SettingChange[] = [];
  const auto: AutoChange[] = [];
  const common = new Set(Object.keys(before.objects).filter((id) => after.objects[id]));
  const rankA = ranks(before, common);
  const rankB = ranks(after, common);
  let timestamps = 0;
  let renumbered = 0;

  for (const b of Object.values(after.objects)) {
    const a = before.objects[b.id];
    if (!a) {
      objects.push({
        id: b.id,
        type: b.type,
        name: displayName(b),
        noun: nounOf(b),
        kinds: ['added'],
        primary: 'added',
        sizeRatio: null,
        details: [],
        before: null,
        after: approxBounds(b),
        shift: null,
      });
      continue;
    }
    const result = compareObject(a, b, before, after, rankA, rankB);
    if (result.change) objects.push(result.change);
    else {
      if (result.timestampOnly) timestamps++;
      if (result.renumbered) renumbered++;
    }
  }
  for (const a of Object.values(before.objects))
    if (!after.objects[a.id])
      objects.push({
        id: a.id,
        type: a.type,
        name: displayName(a),
        noun: nounOf(a),
        kinds: ['removed'],
        primary: 'removed',
        sizeRatio: null,
        details: [],
        before: approxBounds(a),
        after: null,
        shift: null,
      });
  objects.sort(
    (x, y) =>
      PRIORITY.indexOf(x.primary) - PRIORITY.indexOf(y.primary) ||
      x.noun.localeCompare(y.noun) ||
      x.name.localeCompare(y.name, 'fr'),
  );

  compareTitleBlock(before, after, settings);
  // Brouillon issu de la révision « avant » : l'approbation n'est jamais héritée (statut remis à
  // « Brouillon » automatiquement) — ce n'est pas un changement de l'utilisateur.
  if (
    options.beforeRevisionId &&
    after.plan.draftBase?.revisionId === options.beforeRevisionId &&
    before.plan.titleBlock.status === 'approved' &&
    after.plan.titleBlock.status === 'draft'
  ) {
    for (let i = settings.length - 1; i >= 0; i--)
      if (
        settings[i]!.area === 'titleBlock' &&
        (settings[i]!.label === TITLE_BLOCK_LABELS.status ||
          settings[i]!.label === TITLE_BLOCK_LABELS.approvedAt)
      )
        settings.splice(i, 1);
    auto.push({
      label: 'Statut du brouillon remis à « Brouillon »',
      detail: 'Un brouillon issu d’une révision n’hérite jamais de son approbation.',
    });
  }
  compareLayers(before.layers, after.layers, settings);
  compareViews(before, after, settings);
  comparePlan(before, after, settings, auto);
  compareAssets(before, after, settings, auto);
  compareReviews(before, after, settings);

  if (timestamps)
    auto.push({ label: 'Horodatages mis à jour', detail: `${timestamps} objet(s) sans autre changement.` });
  if (renumbered)
    auto.push({
      label: 'Ordre d’affichage renuméroté',
      detail: `${renumbered} objet(s), ordre réel inchangé.`,
    });
  const v = options.schemaVersions;
  if (v && v.before !== v.after)
    auto.push({
      label: 'Format de données converti',
      detail: `Instantané du format ${v.before} lu au format ${v.after} (valeurs neutres ajoutées, rendu inchangé).`,
    });

  const added = objects.filter((o) => o.primary === 'added').length;
  const removed = objects.filter((o) => o.primary === 'removed').length;
  return {
    objects,
    settings,
    auto,
    counts: {
      added,
      removed,
      modified: objects.length - added - removed,
      settings: settings.length,
      user: objects.length + settings.length,
      auto: auto.length,
    },
  };
}

// --- Résumé ------------------------------------------------------------------------------------------

const PARTICIPLES: Record<ObjectChangeKind, string> = {
  added: 'ajouté',
  removed: 'supprimé',
  moved: 'déplacé',
  resized: 'agrandi',
  reshaped: 'modifié',
  rotated: 'pivoté',
  text: 'renommé',
  style: 'modifié',
  layer: 'changé de calque',
  label: 'étiquette déplacée',
  order: 'réordonné',
  properties: 'modifié',
};

const SUFFIX: Partial<Record<ObjectChangeKind, string>> = {
  style: ' (style)',
  properties: ' (propriétés)',
};

function participle(kind: ObjectChangeKind, feminine: boolean, plural: boolean, grow: boolean): string {
  if (kind === 'layer' || kind === 'label') return PARTICIPLES[kind];
  const base = kind === 'resized' && !grow ? 'réduit' : PARTICIPLES[kind];
  return base + (feminine ? 'e' : '') + (plural ? 's' : '') + (SUFFIX[kind] ?? '');
}

/** Phrases courtes du résumé (changements de l'utilisateur), ex. « 2 trajets modifiés ». */
export function summarizeDiff(diff: PlanDiff): string[] {
  const groups = new Map<string, ObjectChange[]>();
  for (const c of diff.objects) {
    const grow = c.primary !== 'resized' || (c.sizeRatio ?? 1) >= 1;
    const key = `${c.noun}|${c.primary}|${grow}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const lines: string[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const noun = NOUNS[first.noun];
    const grow = first.primary !== 'resized' || (first.sizeRatio ?? 1) >= 1;
    if (
      first.primary === 'reshaped' &&
      (first.type === 'flow' ||
        first.type === 'line' ||
        first.type === 'corridor' ||
        first.type === 'dimension')
    ) {
      lines.push(
        list.length === 1 && first.name
          ? `${noun.one[0]!.toUpperCase()}${noun.one.slice(1)} « ${first.name} » : tracé modifié`
          : `${list.length} ${list.length > 1 ? noun.many : noun.one} ${participle('reshaped', noun.feminine, list.length > 1, true)} (tracé)`,
      );
      continue;
    }
    // Le texte d'un texte ou d'une étiquette change : « modifié (texte) », pas « renommé ».
    const textual = first.primary === 'text' && (first.noun === 'text' || first.noun === 'label');
    const verb = textual
      ? `${participle('style', noun.feminine, list.length > 1, grow).replace(' (style)', '')} (texte)`
      : participle(first.primary, noun.feminine, list.length > 1, grow);
    const extra =
      first.primary === 'resized' && list.length === 1 && first.sizeRatio ? ` (${pct(first.sizeRatio)})` : '';
    if (list.length === 1 && first.name)
      lines.push(`${noun.one[0]!.toUpperCase()}${noun.one.slice(1)} « ${first.name} » ${verb}${extra}`);
    else lines.push(`${list.length} ${list.length > 1 ? noun.many : noun.one} ${verb}${extra}`);
  }
  const byArea = (area: SettingArea) => diff.settings.filter((s) => s.area === area);
  const labels = (list: SettingChange[]) => [...new Set(list.map((s) => s.label))].slice(0, 4).join(', ');
  const tb = byArea('titleBlock');
  if (tb.length) lines.push(`Cartouche mis à jour (${labels(tb)})`);
  const layers = byArea('layers');
  if (layers.length)
    lines.push(
      layers.length === 1
        ? `${cap(layers[0]!.subject)} : ${layers[0]!.label}`
        : `Calques : ${layers.length} changements (${labels(layers)})`,
    );
  const views = byArea('views');
  for (const subject of [...new Set(views.map((s) => s.subject))]) {
    const list = views.filter((s) => s.subject === subject);
    const whole = list.find((s) => s.label === 'vue ajoutée' || s.label === 'vue supprimée');
    lines.push(
      whole
        ? `${cap(subject)} ${whole.label.replace('vue ', '')}`
        : `${cap(subject)} modifiée (${labels(list)})`,
    );
  }
  const print = byArea('print');
  if (print.length) lines.push(`Paramètres d’impression modifiés (${labels(print)})`);
  const legend = byArea('legend');
  if (legend.length) lines.push(`Légende modifiée (${labels(legend)})`);
  for (const s of [...byArea('plan'), ...byArea('photo'), ...byArea('assets'), ...byArea('reviews')])
    lines.push(`${cap(s.subject === 'plan' ? s.label : `${s.subject} : ${s.label}`)}`);
  return lines;
}

const cap = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** Résumé enregistré avec une révision (changements depuis la précédente). */
export function changeSummary(diff: PlanDiff, sinceLabel: string) {
  return {
    sinceLabel,
    user: diff.counts.user,
    auto: diff.counts.auto,
    lines: summarizeDiff(diff).slice(0, 20),
  };
}

/** Libellé court d'une nature de changement (liste, filtres). */
export const CHANGE_KIND_LABELS: Record<ObjectChangeKind, string> = {
  added: 'Ajouté',
  removed: 'Supprimé',
  moved: 'Déplacé',
  resized: 'Redimensionné',
  reshaped: 'Tracé / forme modifiés',
  rotated: 'Pivoté',
  text: 'Texte modifié',
  style: 'Style modifié',
  layer: 'Changé de calque',
  label: 'Étiquette déplacée',
  order: 'Ordre modifié',
  properties: 'Propriétés modifiées',
};

export const AREA_LABELS: Record<SettingArea, string> = {
  titleBlock: 'Cartouche',
  layers: 'Calques',
  views: 'Vues par public',
  print: 'Paramètres d’impression',
  legend: 'Légende',
  plan: 'Plan',
  photo: 'Photo',
  assets: 'Pictogrammes importés',
  reviews: 'Suivi',
};

export const nounLabel = (key: NounKey, plural = false) => (plural ? NOUNS[key].many : NOUNS[key].one);
