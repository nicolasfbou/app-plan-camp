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

/** Section de la bibliothèque des surfaces (barre latérale). */
export type PresetGroup = 'zones' | 'parking' | 'deliveries' | 'safety' | 'buildings';

export interface ZonePreset {
  id: string;
  /** Type d'objet créé : zone (surface) ou bâtiment (contour). */
  objectType: 'zone' | 'building';
  name: LocalizedText;
  group: PresetGroup;
  /** Catégorie du calque qui reçoit l'objet (sans calque actif). */
  tier: RenderTier;
  style: Style;
  /** Pictogramme affiché au centre de la zone créée (modifiable, supprimable). */
  icon?: string;
  /** Nom de la zone affiché en son centre. */
  showName?: boolean;
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

/** Bordure de délimitation bien visible (livraison, sécurité) : trait plein, plus épais. */
function boundaryStyle(
  fill: string,
  border: string,
  fillOpacity = 0.22,
  pattern: Style['pattern'] = 'none',
): Style {
  return { fill, fillOpacity, stroke: border, strokeOpacity: 1, strokeWidth: 4, dash: 'solid', pattern };
}

function zone(
  id: string,
  fr: string,
  group: PresetGroup,
  style: Style,
  extra: { tier?: RenderTier; icon?: string; showName?: boolean; en?: string } = {},
): ZonePreset {
  return {
    id,
    objectType: 'zone',
    name: { fr, en: extra.en },
    group,
    tier: extra.tier ?? (group === 'buildings' ? 'buildings' : group),
    style,
    icon: extra.icon,
    showName: extra.showName,
  };
}

const ORANGE = '#ea580c';
const RED = '#dc2626';

export const ZONE_PRESETS: readonly ZonePreset[] = [
  // Zones générales
  zone('zone.pedestrian', 'Zone piétonne', 'zones', zoneStyle('#f97316'), {
    tier: 'pedestrians',
    icon: 'sign.pedestrian',
  }),
  zone('zone.vehicle', 'Circulation véhicules', 'zones', zoneStyle('#1d4ed8', 'solid', 0.2), {
    tier: 'circulation',
  }),
  zone('zone.waste', 'Déchets', 'zones', zoneStyle('#b91c1c'), { icon: 'sign.waste' }),
  zone('zone.storage', 'Entreposage', 'zones', zoneStyle('#eab308')),
  zone('zone.generator', 'Génératrice', 'zones', zoneStyle('#7c3aed'), { icon: 'sign.generator' }),
  zone('zone.diesel', 'Diesel', 'zones', zoneStyle('#92400e', 'solid'), { icon: 'sign.fuel' }),
  zone('zone.propane', 'Propane', 'zones', zoneStyle('#be185d', 'solid'), { icon: 'sign.propane' }),
  zone(
    'zone.hazmat',
    'Matières dangereuses',
    'zones',
    { ...zoneStyle(RED, 'solid', 0.25), pattern: 'hatch' },
    {
      icon: 'sign.hazmat',
    },
  ),
  zone('zone.core-site', 'Site pour carottes', 'zones', zoneStyle('#ef4444')),
  zone('zone.snow', 'Zone de neige', 'zones', zoneStyle('#0ea5e9')),
  zone('zone.technical', 'Zone technique', 'zones', zoneStyle('#9333ea'), { icon: 'sign.technical' }),
  zone('zone.custom', 'Zone personnalisée', 'zones', zoneStyle('#6b7280')),
  // Stationnement
  zone('zone.parking', 'Stationnement employés', 'parking', zoneStyle('#2563eb'), {
    icon: 'sign.parking',
    showName: true,
  }),
  zone('zone.parking-visitors', 'Stationnement visiteurs', 'parking', zoneStyle('#0ea5e9'), {
    icon: 'sign.parking',
    showName: true,
  }),
  zone('zone.parking-heavy', 'Stationnement véhicules lourds', 'parking', zoneStyle('#1e3a8a'), {
    icon: 'sign.heavy-vehicles',
    showName: true,
  }),
  zone('zone.parking-service', 'Stationnement véhicules de service', 'parking', zoneStyle('#0891b2'), {
    icon: 'sign.parking',
    showName: true,
  }),
  zone('zone.parking-temporary', 'Stationnement temporaire', 'parking', zoneStyle('#6366f1', 'dotted', 0.2), {
    icon: 'sign.parking',
    showName: true,
  }),
  zone('zone.no-parking', 'Stationnement interdit', 'parking', boundaryStyle(RED, RED, 0.18, 'hatch'), {
    icon: 'sign.no-parking',
  }),
  zone('zone.parking-custom', 'Stationnement (personnalisé)', 'parking', zoneStyle('#64748b'), {
    icon: 'sign.parking',
  }),
  // Livraison et débarquement : bordure de délimitation orange (ou rouge si interdit aux piétons)
  zone('zone.dropoff', 'Débarquement des marchandises', 'deliveries', boundaryStyle('#f59e0b', ORANGE), {
    icon: 'sign.unloading',
    showName: true,
  }),
  zone('zone.delivery', 'Livraison alimentaire', 'deliveries', boundaryStyle('#0891b2', ORANGE), {
    icon: 'sign.delivery',
    showName: true,
  }),
  zone(
    'zone.equipment-unloading',
    'Déchargement des équipements',
    'deliveries',
    boundaryStyle('#a16207', ORANGE),
    {
      icon: 'sign.unloading',
      showName: true,
    },
  ),
  zone('zone.loading', 'Aire de chargement', 'deliveries', boundaryStyle('#d97706', ORANGE), {
    icon: 'sign.delivery',
    showName: true,
  }),
  zone(
    'zone.truck-maneuver',
    'Aire de manœuvre des camions',
    'deliveries',
    boundaryStyle('#78350f', ORANGE, 0.15),
    {
      icon: 'sign.maneuver',
      showName: true,
    },
  ),
  zone('zone.waiting', "Zone d'attente", 'deliveries', boundaryStyle('#64748b', ORANGE, 0.18), {
    icon: 'sign.waiting',
    showName: true,
  }),
  zone('zone.supplier-access', 'Accès fournisseurs', 'deliveries', boundaryStyle('#0369a1', ORANGE, 0.15), {
    icon: 'sign.entrance',
    showName: true,
  }),
  zone(
    'zone.no-pedestrians-ops',
    'Interdit aux piétons pendant les opérations',
    'deliveries',
    boundaryStyle(RED, RED, 0.15, 'hatch'),
    { icon: 'sign.no-pedestrians', showName: true },
  ),
  // Sécurité et accès
  zone('zone.no-access', 'Accès interdit', 'safety', boundaryStyle(RED, RED, 0.2, 'hatch'), {
    icon: 'sign.no-entry',
  }),
  zone(
    'zone.authorized-only',
    'Accès réservé au personnel autorisé',
    'safety',
    boundaryStyle('#f59e0b', ORANGE, 0.18),
    {
      icon: 'sign.authorized',
      showName: true,
    },
  ),
  zone('zone.danger', 'Zone de danger', 'safety', boundaryStyle(RED, RED, 0.25, 'hatch'), {
    icon: 'sign.danger',
  }),
  zone('zone.maneuver', 'Zone de manœuvre', 'safety', boundaryStyle('#f59e0b', ORANGE, 0.18), {
    icon: 'sign.maneuver',
    showName: true,
  }),
  zone('zone.assembly', 'Point de rassemblement', 'safety', boundaryStyle('#16a34a', '#15803d', 0.25), {
    icon: 'sign.assembly',
    showName: true,
  }),
  zone(
    'zone.restricted-traffic',
    'Zone de circulation restreinte',
    'safety',
    boundaryStyle('#eab308', ORANGE, 0.15),
    {
      icon: 'sign.restricted',
      showName: true,
    },
  ),
  zone('zone.reversing', 'Zone de recul', 'safety', boundaryStyle('#f97316', ORANGE, 0.2), {
    icon: 'sign.reversing',
    showName: true,
  }),
  zone('zone.no-parking-area', 'Zone sans stationnement', 'safety', boundaryStyle(RED, RED, 0.12, 'hatch'), {
    icon: 'sign.no-parking',
  }),
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
    group: 'buildings',
    name: { fr: 'Bâtiment', en: 'Building' },
    tier: 'buildings',
    style: buildingStyle('#334155'),
  },
  {
    id: 'building.dormitory',
    objectType: 'building',
    group: 'buildings',
    name: { fr: 'Dortoir', en: 'Dormitory' },
    tier: 'buildings',
    style: buildingStyle('#475569'),
  },
  {
    id: 'building.kitchen',
    objectType: 'building',
    group: 'buildings',
    name: { fr: 'Cuisine / cafétéria', en: 'Kitchen / cafeteria' },
    tier: 'buildings',
    style: buildingStyle('#0f766e'),
  },
  {
    id: 'building.core-shack',
    objectType: 'building',
    group: 'buildings',
    name: { fr: 'Core shack', en: 'Core shack' },
    tier: 'buildings',
    style: buildingStyle('#92400e'),
  },
  {
    id: 'building.office',
    objectType: 'building',
    group: 'buildings',
    name: { fr: 'Bureau', en: 'Office' },
    tier: 'buildings',
    style: buildingStyle('#1d4ed8'),
  },
  {
    id: 'building.warehouse',
    objectType: 'building',
    group: 'buildings',
    name: { fr: 'Entrepôt', en: 'Warehouse' },
    tier: 'buildings',
    style: buildingStyle('#a16207'),
  },
  {
    id: 'building.garage',
    objectType: 'building',
    group: 'buildings',
    name: { fr: 'Garage / atelier', en: 'Garage / workshop' },
    tier: 'buildings',
    style: buildingStyle('#57534e'),
  },
  {
    id: 'building.container',
    objectType: 'building',
    group: 'buildings',
    name: { fr: 'Conteneur', en: 'Container' },
    tier: 'buildings',
    style: buildingStyle('#15803d'),
  },
  {
    id: 'building.generator',
    objectType: 'building',
    group: 'buildings',
    name: { fr: 'Génératrice', en: 'Generator' },
    tier: 'buildings',
    style: buildingStyle('#7c3aed'),
  },
  {
    id: 'building.tank',
    objectType: 'building',
    group: 'buildings',
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
