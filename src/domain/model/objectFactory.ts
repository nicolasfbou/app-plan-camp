/**
 * Création des objets à partir d'un outil de dessin et d'une géométrie en coordonnées image.
 * Les valeurs par défaut viennent des modèles (presets) ; tout reste modifiable ensuite.
 */
import { findZonePreset } from '../presets/zonePresets.ts';
import { newId, nowIso } from './factories.ts';
import type { Geometry, Layer, PlanDocument, PlanObject, RenderTier, Style } from './types.ts';

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
  const width = style.strokeWidth / Math.max(zoom, 1e-6);
  return { ...style, strokeWidth: Math.round(width * 10) / 10 };
}

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
    : { ...common, type: 'zone', geometry };
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
