/**
 * Réseaux techniques (eau potable, égouts, électricité, propane…). Données : nom, couleur, trait,
 * flèches et disposition par défaut de chaque réseau ; tout reste modifiable objet par objet.
 *
 * Couleurs : code usuel de repérage des réseaux enfouis (rouge électricité, jaune gaz et propane,
 * orange télécommunications, bleu eau potable, vert égouts, violet autres). Un tracé sur la photo
 * n'est jamais un relevé : avant de creuser, une localisation officielle des réseaux reste requise.
 */
import { NETWORK_TIERS } from '../model/schema.ts';
import type {
  NetworkTier,
  RenderTier,
  Style,
  UtilityObject,
  UtilityPlacement,
  UtilityStatus,
} from '../model/types.ts';

export interface NetworkPreset {
  network: NetworkTier;
  /** Modèle d'objet (`presetId`, styles d'entreprise). */
  id: string;
  name: string;
  /** Nom court, en tête de l'étiquette d'une ligne (« Eau · 50 mm · PEHD »). */
  short: string;
  style: Style;
  /** Flèches de sens d'écoulement affichées par défaut (réseaux gravitaires). */
  arrows: boolean;
  placement: UtilityPlacement;
  /** Tailles par défaut, en pixels écran au zoom de création. */
  arrowSizePx: number;
  arrowSpacingPx: number;
}

const lineStyle = (color: string): Style => ({
  fill: null,
  fillOpacity: 0,
  stroke: color,
  strokeOpacity: 1,
  strokeWidth: 4,
  dash: 'solid',
  pattern: 'none',
});

const preset = (
  network: NetworkTier,
  name: string,
  short: string,
  color: string,
  extra: Partial<Pick<NetworkPreset, 'arrows' | 'placement'>> = {},
): NetworkPreset => ({
  network,
  id: `network.${network}`,
  name,
  short,
  style: lineStyle(color),
  arrows: extra.arrows ?? false,
  placement: extra.placement ?? 'underground',
  arrowSizePx: 14,
  arrowSpacingPx: 120,
});

export const NETWORK_PRESETS: readonly NetworkPreset[] = [
  preset('water', 'Eau potable', 'Eau', '#2563eb'),
  preset('sewer', 'Égout sanitaire', 'Égout', '#15803d', { arrows: true }),
  preset('storm', 'Égout pluvial / drainage', 'Pluvial', '#0d9488', { arrows: true }),
  preset('electrical', 'Électricité', 'Élec.', '#dc2626'),
  preset('propane', 'Propane / gaz', 'Propane', '#ca8a04'),
  preset('telecom', 'Télécom / données', 'Télécom', '#ea580c'),
  preset('other-network', 'Autre réseau', 'Réseau', '#9333ea'),
];

export const DEFAULT_NETWORK: NetworkTier = 'water';

export function findNetworkPreset(network: NetworkTier): NetworkPreset {
  return NETWORK_PRESETS.find((p) => p.network === network) ?? NETWORK_PRESETS.at(-1)!;
}

export function isNetworkTier(tier: RenderTier | string): tier is NetworkTier {
  return (NETWORK_TIERS as readonly string[]).includes(tier);
}

export const STATUS_LABELS: Record<UtilityStatus, string> = {
  existing: 'existant',
  proposed: 'projeté',
  abandoned: 'abandonné',
};

export const PLACEMENT_LABELS: Record<UtilityPlacement, string> = {
  underground: 'enfoui',
  aerial: 'aérien',
  surface: 'en surface',
};

/** Trait associé à un état : existant plein, projeté tireté, abandonné pointillé. */
export const STATUS_DASH: Record<UtilityStatus, Style['dash']> = {
  existing: 'solid',
  proposed: 'dashed',
  abandoned: 'dotted',
};

const decimal = (value: number) =>
  new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 }).format(Math.round(value * 100) / 100);

/**
 * Texte de l'étiquette d'une ligne de réseau : nom court, diamètre, matériau, profondeur (ou
 * « aérien »), état s'il n'est pas « existant ». Ex. « Eau · 50 mm · PEHD · prof. 2,1 m ».
 */
export function utilityLabel(
  o: Pick<UtilityObject, 'network' | 'nominalSize' | 'material' | 'depthMeters' | 'placement' | 'status'>,
): string {
  const parts = [findNetworkPreset(o.network).short, o.nominalSize.trim(), o.material.trim()];
  if (o.placement === 'underground' && o.depthMeters !== null)
    parts.push(`prof. ${decimal(o.depthMeters)} m`);
  if (o.placement !== 'underground') parts.push(PLACEMENT_LABELS[o.placement]);
  if (o.status !== 'existing') parts.push(STATUS_LABELS[o.status]);
  return parts.filter(Boolean).join(' · ');
}
