/**
 * Création des objets à partir d'un outil de dessin et d'une géométrie en coordonnées image.
 * Les valeurs par défaut viennent des modèles (presets) ; tout reste modifiable ensuite.
 */
import { findFlowPreset } from '../presets/flowPresets.ts';
import { findZonePreset } from '../presets/zonePresets.ts';
import { findSymbol } from '../symbols/catalog.ts';
import { newId, nowIso } from './factories.ts';
import type {
  FlowCategory,
  Geometry,
  Layer,
  PlanDocument,
  PlanObject,
  Point,
  RenderTier,
  Style,
} from './types.ts';

export type AreaGeometry = Extract<Geometry, { kind: 'rect' | 'ellipse' | 'polygon' }>;
export type LineGeometry = Extract<Geometry, { kind: 'polyline' }>;

export const LINE_STYLE: Style = {
  fill: null,
  fillOpacity: 0,
  stroke: '#f97316',
  strokeOpacity: 1,
  strokeWidth: 4,
  dash: 'solid',
  pattern: 'none',
};

export const TEXT_STYLE: Style = {
  fill: '#0f172a',
  fillOpacity: 1,
  stroke: null,
  strokeOpacity: 1,
  strokeWidth: 0,
  dash: 'solid',
  pattern: 'none',
};

/** Un calque accepte de nouveaux objets s'il est visible et non verrouillé. */
export function isLayerUsable(layer: Layer): boolean {
  return layer.visible && !layer.locked;
}

/**
 * Calque du niveau demandé qui recevra un nouvel objet quand aucun calque actif n'est choisi : le
 * plus BAS des calques visibles et déverrouillés de ce niveau, c'est-à-dire normalement le calque
 * d'origine (un calque créé ou dupliqué se place au-dessus : il ne « capte » donc pas les objets
 * sans avoir été rendu actif). S'il n'y en a aucun, le premier calque du niveau est retourné ;
 * l'appelant doit alors refuser la création (voir `isLayerUsable`).
 */
export function layerForTier(doc: PlanDocument, tier: RenderTier): Layer {
  const ofTier = doc.layers.filter((l) => l.tier === tier);
  const layer = ofTier.find(isLayerUsable) ?? ofTier[0] ?? doc.layers.at(-1);
  if (!layer) throw new Error('Le plan ne contient aucun calque.');
  return layer;
}

/** Niveau de rendu naturel d'un type d'objet (pour coller dans un autre plan). */
export function tierForType(type: PlanObject['type']): RenderTier {
  const tiers: Record<PlanObject['type'], RenderTier> = {
    zone: 'zones',
    building: 'buildings',
    line: 'circulation',
    flow: 'circulation',
    corridor: 'pedestrians',
    dimension: 'texts',
    stall: 'parking',
    text: 'texts',
    icon: 'signage',
  };
  return tiers[type];
}

/** zIndex placé au-dessus de tous les objets du calque. */
export function topZIndex(doc: PlanDocument, layerId: string): number {
  let max = -1;
  for (const o of Object.values(doc.objects)) if (o.layerId === layerId && o.zIndex > max) max = o.zIndex;
  return max + 1;
}

function base(doc: PlanDocument, tier: RenderTier, name: string, style: Style, presetId: string | null) {
  const layer = layerForTier(doc, tier);
  const now = nowIso();
  return {
    id: newId(),
    name,
    layerId: layer.id,
    presetId,
    style,
    rotation: 0,
    visible: true,
    locked: false,
    zIndex: topZIndex(doc, layer.id),
    groupId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Les épaisseurs des modèles sont exprimées en pixels ÉCRAN au zoom où l'on dessine, puis
 * converties en pixels image (`zoom` = échelle du viewport) : un trait de 3 px reste bien visible
 * qu'on dessine à 20 % ou à 200 %. La valeur stockée est en pixels image (liée à la photo).
 */
function scaledStyle(style: Style, zoom: number): Style {
  return { ...style, strokeWidth: screenToImage(style.strokeWidth, zoom) };
}

/** Taille en pixels écran au zoom courant → pixels image (arrondie au dixième). */
function screenToImage(px: number, zoom: number): number {
  return Math.round((px / Math.max(zoom, 1e-6)) * 10) / 10;
}

/** Taille par défaut d'un pictogramme de zone, en pixels écran au zoom de création. */
const ZONE_ICON_PX = 34;

export function createAreaObject(
  doc: PlanDocument,
  geometry: AreaGeometry,
  presetId: string,
  zoom = 1,
): PlanObject {
  const preset = findZonePreset(presetId) ?? findZonePreset('zone.custom')!;
  const common = base(doc, preset.tier, preset.name.fr, scaledStyle(preset.style, zoom), preset.id);
  return preset.objectType === 'building'
    ? { ...common, type: 'building', geometry }
    : {
        ...common,
        type: 'zone',
        geometry,
        icon: preset.icon ? { symbolId: preset.icon, size: screenToImage(ZONE_ICON_PX, zoom) } : null,
        showName: preset.showName ?? false,
      };
}

export function createLineObject(doc: PlanDocument, geometry: LineGeometry, zoom = 1): PlanObject {
  const name = geometry.points.length === 2 ? 'Ligne' : 'Polyligne';
  return { ...base(doc, 'circulation', name, scaledStyle(LINE_STYLE, zoom), null), type: 'line', geometry };
}

export function createTextObject(
  doc: PlanDocument,
  at: { x: number; y: number },
  options: { label: boolean; text: string; fontSize: number },
): PlanObject {
  const name = options.label ? 'Étiquette' : 'Texte';
  return {
    ...base(doc, 'texts', name, { ...TEXT_STYLE }, null),
    type: 'text',
    geometry: { kind: 'point', x: at.x, y: at.y },
    text: options.text,
    fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
    fontSize: options.fontSize,
    fontWeight: options.label ? 'bold' : 'normal',
    italic: false,
    align: 'center',
    label: options.label
      ? {
          background: '#ffffff',
          backgroundOpacity: 0.92,
          border: '#0f172a',
          borderWidth: options.fontSize / 12,
          padding: options.fontSize * 0.35,
          cornerRadius: options.fontSize * 0.2,
        }
      : null,
  };
}

/** Trajet de véhicules : les points suivent exactement les clics ; flèches calculées à l'affichage. */
export function createFlowObject(
  doc: PlanDocument,
  points: Point[],
  category: FlowCategory,
  zoom = 1,
): PlanObject {
  const preset = findFlowPreset(category);
  return {
    ...base(doc, preset.tier, preset.name, scaledStyle(preset.style, zoom), preset.id),
    type: 'flow',
    geometry: { kind: 'polyline', points, curved: false },
    category: preset.category,
    arrows: {
      direction: 'forward',
      visible: true,
      size: screenToImage(preset.arrowSizePx, zoom),
      spacing: screenToImage(preset.arrowSpacingPx, zoom),
    },
  };
}

export const CORRIDOR_STYLE: Style = {
  fill: '#f97316',
  fillOpacity: 0.35,
  stroke: '#c2410c',
  strokeOpacity: 1,
  strokeWidth: 2,
  dash: 'dashed',
  pattern: 'none',
};

/** Corridor piéton centré sur le tracé ; largeur en pixels IMAGE (pas en mètres). */
export function createCorridorObject(doc: PlanDocument, points: Point[], zoom = 1, widthPx = 26): PlanObject {
  const width = screenToImage(widthPx, zoom);
  return {
    ...base(doc, 'pedestrians', 'Corridor piéton', scaledStyle(CORRIDOR_STYLE, zoom), 'corridor.pedestrian'),
    type: 'corridor',
    geometry: { kind: 'polyline', points, curved: false },
    width,
    widthMeters: null,
    showIcons: true,
    iconSpacing: Math.round(width * 6 * 10) / 10,
    iconSize: Math.round(width * 0.75 * 10) / 10,
    iconsOriented: false,
  };
}

export const DIMENSION_STYLE: Style = {
  fill: null,
  fillOpacity: 0,
  stroke: '#0f172a',
  strokeOpacity: 1,
  strokeWidth: 2,
  dash: 'solid',
  pattern: 'none',
};

/** Cote : distance mesurée le long des points cliqués (affichée en mètres si le plan est calibré). */
export function createDimensionObject(doc: PlanDocument, points: Point[], zoom = 1): PlanObject {
  return {
    ...base(doc, 'texts', 'Cote', scaledStyle(DIMENSION_STYLE, zoom), 'dimension'),
    type: 'dimension',
    geometry: { kind: 'polyline', points, curved: false },
  };
}

/** Pictogramme placé en `at` (centre), de la bibliothèque ou importé. */
export function createIconObject(
  doc: PlanDocument,
  at: Point,
  symbolId: string,
  name: string,
  zoom = 1,
  sizePx = 36,
): PlanObject {
  const symbol = findSymbol(symbolId);
  return {
    ...base(doc, 'signage', name, { ...TEXT_STYLE, fill: null }, symbolId),
    type: 'icon',
    geometry: { kind: 'point', x: at.x, y: at.y },
    symbolId,
    size: screenToImage(sizePx, zoom),
    text: symbol?.defaultText ?? null,
  };
}
