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
    name: { fr: 'Stationnement', en: 'Parking' },
    tier: 'zones',
    style: zoneStyle('#2563eb'),
  },
  {
    id: 'zone.pedestrian',
    name: { fr: 'Zone piétonne', en: 'Pedestrian area' },
    tier: 'pedestrians',
    style: zoneStyle('#f97316'),
  },
  {
    id: 'zone.vehicle',
    name: { fr: 'Circulation véhicules', en: 'Vehicle traffic' },
    tier: 'circulation',
    style: zoneStyle('#1d4ed8', 'solid', 0.2),
  },
  {
    id: 'zone.delivery',
    name: { fr: 'Livraison', en: 'Delivery' },
    tier: 'zones',
    style: zoneStyle('#0891b2'),
  },
  {
    id: 'zone.dropoff',
    name: { fr: 'Débarquement', en: 'Drop-off' },
    tier: 'zones',
    style: zoneStyle('#dc2626'),
  },
  { id: 'zone.waste', name: { fr: 'Déchets', en: 'Waste' }, tier: 'zones', style: zoneStyle('#b91c1c') },
  {
    id: 'zone.storage',
    name: { fr: 'Entreposage', en: 'Storage' },
    tier: 'zones',
    style: zoneStyle('#eab308'),
  },
  {
    id: 'zone.generator',
    name: { fr: 'Génératrice', en: 'Generator' },
    tier: 'zones',
    style: zoneStyle('#7c3aed'),
  },
  {
    id: 'zone.diesel',
    name: { fr: 'Diesel', en: 'Diesel' },
    tier: 'zones',
    style: zoneStyle('#92400e', 'solid'),
  },
  {
    id: 'zone.propane',
    name: { fr: 'Propane', en: 'Propane' },
    tier: 'zones',
    style: zoneStyle('#be185d', 'solid'),
  },
  {
    id: 'zone.hazmat',
    name: { fr: 'Matières dangereuses', en: 'Hazardous materials' },
    tier: 'zones',
    style: { ...zoneStyle('#dc2626', 'solid', 0.25), pattern: 'hatch' },
  },
  {
    id: 'zone.core-site',
    name: { fr: 'Site pour carottes', en: 'Core storage site' },
    tier: 'zones',
    style: zoneStyle('#ef4444'),
  },
  {
    id: 'zone.snow',
    name: { fr: 'Déneigement', en: 'Snow removal' },
    tier: 'zones',
    style: zoneStyle('#0ea5e9'),
  },
  {
    id: 'zone.technical',
    name: { fr: 'Zone technique', en: 'Technical area' },
    tier: 'zones',
    style: zoneStyle('#9333ea'),
  },
  {
    id: 'zone.custom',
    name: { fr: 'Zone personnalisée', en: 'Custom area' },
    tier: 'zones',
    style: zoneStyle('#6b7280'),
  },
];

export function findZonePreset(id: string): ZonePreset | undefined {
  return ZONE_PRESETS.find((preset) => preset.id === id);
}
