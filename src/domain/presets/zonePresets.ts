/**
 * Bibliothèque de zones prédéfinies. Ce sont des données, pas du code : les composants lisent
 * cette liste, ils ne connaissent aucune zone en dur. Ajouter une zone = ajouter une entrée.
 * Les modèles utilisateur (V2) produiront des entrées de même forme.
 */
import type { RenderTier, Style } from '../model/types.ts';

export interface LocalizedText {
  fr: string;
  en?: string;
}

export interface ZonePreset {
  id: string;
  /** Type d'objet créé : zone (surface) ou bâtiment (contour). */
  objectType: 'zone' | 'building';
  name: LocalizedText;
  /** Niveau de rendu par défaut de la zone créée. */
  tier: RenderTier;
  style: Style;
}

function zoneStyle(color: string, dash: Style['dash'] = 'dashed', fillOpacity = 0.3): Style {
  return {
    fill: color,
    fillOpacity,
    stroke: color,
    strokeOpacity: 1,
    strokeWidth: 3,
    dash,
    pattern: 'none',
  };
}

export const ZONE_PRESETS: readonly ZonePreset[] = [
  {
    id: 'zone.parking',
    objectType: 'zone',
    name: { fr: 'Stationnement', en: 'Parking' },
    tier: 'zones',
    style: zoneStyle('#2563eb'),
  },
  {
    id: 'zone.pedestrian',
    objectType: 'zone',
    name: { fr: 'Zone piétonne', en: 'Pedestrian area' },
    tier: 'pedestrians',
    style: zoneStyle('#f97316'),
  },
  {
    id: 'zone.vehicle',
    objectType: 'zone',
    name: { fr: 'Circulation véhicules', en: 'Vehicle traffic' },
    tier: 'circulation',
    style: zoneStyle('#1d4ed8', 'solid', 0.2),
  },
  {
    id: 'zone.delivery',
    objectType: 'zone',
    name: { fr: 'Livraison', en: 'Delivery' },
    tier: 'zones',
    style: zoneStyle('#0891b2'),
  },
  {
    id: 'zone.dropoff',
    objectType: 'zone',
    name: { fr: 'Zone de débarquement', en: 'Drop-off' },
    tier: 'zones',
    style: zoneStyle('#dc2626'),
  },
  {
    id: 'zone.waste',
    objectType: 'zone',
    name: { fr: 'Déchets', en: 'Waste' },
    tier: 'zones',
    style: zoneStyle('#b91c1c'),
  },
  {
    id: 'zone.storage',
    objectType: 'zone',
    name: { fr: 'Entreposage', en: 'Storage' },
    tier: 'zones',
    style: zoneStyle('#eab308'),
  },
  {
    id: 'zone.generator',
    objectType: 'zone',
    name: { fr: 'Génératrice', en: 'Generator' },
    tier: 'zones',
    style: zoneStyle('#7c3aed'),
  },
  {
    id: 'zone.diesel',
    objectType: 'zone',
    name: { fr: 'Diesel', en: 'Diesel' },
    tier: 'zones',
    style: zoneStyle('#92400e', 'solid'),
  },
  {
    id: 'zone.propane',
    objectType: 'zone',
    name: { fr: 'Propane', en: 'Propane' },
    tier: 'zones',
    style: zoneStyle('#be185d', 'solid'),
  },
  {
    id: 'zone.hazmat',
    objectType: 'zone',
    name: { fr: 'Matières dangereuses', en: 'Hazardous materials' },
    tier: 'zones',
    style: { ...zoneStyle('#dc2626', 'solid', 0.25), pattern: 'hatch' },
  },
  {
    id: 'zone.core-site',
    objectType: 'zone',
    name: { fr: 'Site pour carottes', en: 'Core storage site' },
    tier: 'zones',
    style: zoneStyle('#ef4444'),
  },
  {
    id: 'zone.snow',
    objectType: 'zone',
    name: { fr: 'Zone de neige', en: 'Snow area' },
    tier: 'zones',
    style: zoneStyle('#0ea5e9'),
  },
  {
    id: 'zone.technical',
    objectType: 'zone',
    name: { fr: 'Zone technique', en: 'Technical area' },
    tier: 'zones',
    style: zoneStyle('#9333ea'),
  },
  {
    id: 'zone.custom',
    objectType: 'zone',
    name: { fr: 'Zone personnalisée', en: 'Custom area' },
    tier: 'zones',
    style: zoneStyle('#6b7280'),
  },
];

const buildingStyle = (color: string): Style => ({
  fill: color,
  fillOpacity: 0.2,
  stroke: color,
  strokeOpacity: 1,
  strokeWidth: 3,
  dash: 'solid',
  pattern: 'none',
});

/** Contours de bâtiments existants (visibles sur la photo) : on dessine le contour et on nomme. */
export const BUILDING_PRESETS: readonly ZonePreset[] = [
  {
    id: 'building.generic',
    objectType: 'building',
    name: { fr: 'Bâtiment', en: 'Building' },
    tier: 'buildings',
    style: buildingStyle('#334155'),
  },
  {
    id: 'building.dormitory',
    objectType: 'building',
    name: { fr: 'Dortoir', en: 'Dormitory' },
    tier: 'buildings',
    style: buildingStyle('#475569'),
  },
  {
    id: 'building.kitchen',
    objectType: 'building',
    name: { fr: 'Cuisine / cafétéria', en: 'Kitchen / cafeteria' },
    tier: 'buildings',
    style: buildingStyle('#0f766e'),
  },
  {
    id: 'building.core-shack',
    objectType: 'building',
    name: { fr: 'Core shack', en: 'Core shack' },
    tier: 'buildings',
    style: buildingStyle('#92400e'),
  },
  {
    id: 'building.office',
    objectType: 'building',
    name: { fr: 'Bureau', en: 'Office' },
    tier: 'buildings',
    style: buildingStyle('#1d4ed8'),
  },
  {
    id: 'building.warehouse',
    objectType: 'building',
    name: { fr: 'Entrepôt', en: 'Warehouse' },
    tier: 'buildings',
    style: buildingStyle('#a16207'),
  },
  {
    id: 'building.garage',
    objectType: 'building',
    name: { fr: 'Garage / atelier', en: 'Garage / workshop' },
    tier: 'buildings',
    style: buildingStyle('#57534e'),
  },
  {
    id: 'building.container',
    objectType: 'building',
    name: { fr: 'Conteneur', en: 'Container' },
    tier: 'buildings',
    style: buildingStyle('#15803d'),
  },
  {
    id: 'building.generator',
    objectType: 'building',
    name: { fr: 'Génératrice', en: 'Generator' },
    tier: 'buildings',
    style: buildingStyle('#7c3aed'),
  },
  {
    id: 'building.tank',
    objectType: 'building',
    name: { fr: 'Réservoir', en: 'Tank' },
    tier: 'buildings',
    style: buildingStyle('#be185d'),
  },
];

/** Tous les modèles applicables aux outils de surface (rectangle, ellipse, polygone). */
export const AREA_PRESETS: readonly ZonePreset[] = [...ZONE_PRESETS, ...BUILDING_PRESETS];

export const DEFAULT_AREA_PRESET_ID = 'zone.custom';

export function findZonePreset(id: string): ZonePreset | undefined {
  return AREA_PRESETS.find((preset) => preset.id === id);
}
