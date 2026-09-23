/**
 * Catégories de trajets de véhicules. Données : couleur, style et tailles par défaut (en pixels
 * ÉCRAN au zoom où l'on dessine, convertis en pixels image à la création). Tout reste modifiable.
 *
 * « Véhicules d'urgence » sert aussi aux voies d'urgence : c'est une catégorie de tracé, jamais une
 * affirmation que la voie est praticable ou sécuritaire.
 */
import type { FlowCategory, RenderTier, Style } from '../model/types.ts';

export interface FlowPreset {
  category: FlowCategory;
  id: string;
  name: string;
  tier: RenderTier;
  style: Style;
  /** Tailles par défaut, en pixels écran au zoom de création. */
  arrowSizePx: number;
  arrowSpacingPx: number;
}

const flowStyle = (color: string, width = 4, dash: Style['dash'] = 'solid'): Style => ({
  fill: null,
  fillOpacity: 0,
  stroke: color,
  strokeOpacity: 0.95,
  strokeWidth: width,
  dash,
  pattern: 'none',
});

const preset = (
  category: FlowCategory,
  name: string,
  style: Style,
  tier: RenderTier = 'circulation',
): FlowPreset => ({
  category,
  id: `flow.${category}`,
  name,
  tier,
  style,
  arrowSizePx: 16,
  arrowSpacingPx: 110,
});

export const FLOW_PRESETS: readonly FlowPreset[] = [
  preset('light', 'Véhicules légers', flowStyle('#2563eb')),
  preset('heavy', 'Véhicules lourds', flowStyle('#7c2d12', 6)),
  preset('delivery', 'Livraison', flowStyle('#d97706')),
  preset('service', 'Véhicules de service', flowStyle('#0d9488')),
  preset('emergency', "Véhicules d'urgence / voie d'urgence", flowStyle('#dc2626', 5, 'dashed'), 'safety'),
  preset('general', 'Circulation générale', flowStyle('#1d4ed8')),
  preset('custom', 'Trajet personnalisé', flowStyle('#6b7280')),
];

export const DEFAULT_FLOW_CATEGORY: FlowCategory = 'general';

export function findFlowPreset(category: FlowCategory): FlowPreset {
  return (
    FLOW_PRESETS.find((p) => p.category === category) ?? FLOW_PRESETS.find((p) => p.category === 'general')!
  );
}
