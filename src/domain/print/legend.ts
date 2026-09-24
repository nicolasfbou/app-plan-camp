/**
 * Légende automatique : une entrée par catégorie RÉELLEMENT présente dans le plan exporté (objets
 * visibles des calques inclus), avec exactement les couleurs, styles de trait et pictogrammes
 * utilisés. Deux objets d'un même modèle mais de styles différents donnent deux entrées.
 */
import { findZonePreset, type PresetGroup } from '../presets/zonePresets.ts';
import { assetIdOf, findSymbol, isAssetSymbol } from '../symbols/catalog.ts';
import type { FlowObject, LegendSettings, PlanDocument, PlanObject, Style } from '../model/types.ts';

export type LegendSwatch =
  | { kind: 'flow'; style: Style; direction: FlowObject['arrows']['direction'] }
  | { kind: 'line'; style: Style }
  | { kind: 'band'; style: Style }
  | { kind: 'area'; style: Style; symbolId: string | null }
  | { kind: 'stall'; style: Style }
  | { kind: 'dimension'; style: Style }
  | { kind: 'symbol'; symbolId: string; text: string | null };

export interface LegendEntry {
  key: string;
  group: LegendGroup;
  /** Intitulé proposé (modifiable dans les réglages de la légende). */
  defaultLabel: string;
  count: number;
  swatch: LegendSwatch;
}

export type LegendGroup = 'circulation' | 'pedestrians' | PresetGroup | 'signage' | 'measures' | 'other';

const GROUP_ORDER: LegendGroup[] = [
  'circulation',
  'pedestrians',
  'parking',
  'deliveries',
  'safety',
  'zones',
  'buildings',
  'signage',
  'measures',
  'other',
];

const FLOW_LABELS: Record<FlowObject['category'], string> = {
  general: 'Circulation véhicules',
  light: 'Circulation véhicules légers',
  heavy: 'Circulation véhicules lourds',
  delivery: 'Circulation de livraison',
  service: 'Circulation véhicules de service',
  emergency: "Voie d'urgence",
  custom: 'Trajet personnalisé',
};

const styleKey = (s: Style) => `${s.fill}|${s.fillOpacity}|${s.stroke}|${s.dash}|${s.pattern}`;
/** « Stationnement employés (exemple) » → intitulé du modèle, sans les précisions entre parenthèses. */
const cleanName = (name: string) => name.replace(/\s*\((exemple|hypothèse|test)\)\s*$/i, '').trim();

function entryFor(o: PlanObject, doc: PlanDocument): Omit<LegendEntry, 'count'> | null {
  switch (o.type) {
    case 'flow': {
      return {
        key: `flow:${o.category}:${styleKey(o.style)}:${o.arrows.direction === 'both' ? 'both' : 'one'}`,
        group: o.category === 'emergency' ? 'safety' : 'circulation',
        defaultLabel: `${FLOW_LABELS[o.category]}${o.arrows.direction === 'both' ? ' (double sens)' : ''}`,
        swatch: { kind: 'flow', style: o.style, direction: o.arrows.direction },
      };
    }
    case 'corridor':
      return {
        key: `corridor:${styleKey(o.style)}`,
        group: 'pedestrians',
        defaultLabel: 'Corridor piéton',
        swatch: { kind: 'band', style: o.style },
      };
    case 'zone':
    case 'building': {
      // Zone personnalisée : légendée sous SON nom (ex. « Héliport »), pas sous le nom du modèle.
      const custom = o.presetId === 'zone.custom';
      const preset = o.presetId && !custom ? findZonePreset(o.presetId) : undefined;
      return {
        key: `${o.type}:${custom ? `custom:${cleanName(o.name)}` : (o.presetId ?? cleanName(o.name))}:${styleKey(o.style)}:${o.type === 'zone' ? (o.icon?.symbolId ?? '') : ''}`,
        group: preset?.group ?? (o.type === 'building' ? 'buildings' : 'zones'),
        defaultLabel: preset?.name.fr ?? cleanName(o.name),
        swatch: {
          kind: 'area',
          style: o.style,
          symbolId: o.type === 'zone' ? (o.icon?.symbolId ?? null) : null,
        },
      };
    }
    case 'stall':
      return {
        key: `stall:${styleKey(o.style)}`,
        group: 'parking',
        defaultLabel: 'Case de stationnement',
        swatch: { kind: 'stall', style: o.style },
      };
    case 'icon': {
      const name = isAssetSymbol(o.symbolId)
        ? (doc.assets[assetIdOf(o.symbolId)]?.name ?? 'Pictogramme')
        : (findSymbol(o.symbolId)?.name ?? 'Pictogramme');
      return {
        // Le texte fait partie du pictogramme (ex. « 20 » ou « 50 » km/h) : deux entrées distinctes.
        key: `icon:${o.symbolId}:${o.text ?? ''}`,
        group: 'signage',
        defaultLabel: name,
        swatch: { kind: 'symbol', symbolId: o.symbolId, text: o.text },
      };
    }
    case 'line':
      return {
        key: `line:${styleKey(o.style)}`,
        group: 'other',
        defaultLabel: 'Ligne',
        swatch: { kind: 'line', style: o.style },
      };
    case 'dimension':
      return {
        key: 'dimension',
        group: 'measures',
        defaultLabel: 'Cote (distance mesurée)',
        swatch: { kind: 'dimension', style: o.style },
      };
    default:
      return null; // textes et étiquettes : pas d'entrée de légende
  }
}

/** Objets exportés : visibles, sur un calque visible et non exclu des réglages d'impression. */
export function exportedObjects(
  doc: PlanDocument,
  excludedLayerIds: readonly string[],
  excludedObjectIds: readonly string[] = [],
): PlanObject[] {
  const excluded = new Set(excludedLayerIds);
  const objects = new Set(excludedObjectIds);
  const layers = new Set(doc.layers.filter((l) => l.visible && !excluded.has(l.id)).map((l) => l.id));
  return Object.values(doc.objects).filter((o) => o.visible && layers.has(o.layerId) && !objects.has(o.id));
}

/** Toutes les entrées possibles du plan exporté (avant les choix de l'utilisateur). */
export function legendEntries(
  doc: PlanDocument,
  excludedLayerIds: readonly string[] = [],
  excludedObjectIds: readonly string[] = [],
  detail: 'full' | 'standard' | 'simplified' = 'full',
): LegendEntry[] {
  const byKey = new Map<string, LegendEntry>();
  for (const o of exportedObjects(doc, excludedLayerIds, excludedObjectIds)) {
    if (o.type === 'dimension' && detail !== 'full') continue; // cotes non imprimées
    const entry = entryFor(o, doc);
    if (!entry) continue;
    const existing = byKey.get(entry.key);
    if (existing) existing.count++;
    else byKey.set(entry.key, { ...entry, count: 1 });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.defaultLabel.localeCompare(b.defaultLabel, 'fr'),
  );
}

export interface ShownLegendEntry extends LegendEntry {
  label: string;
}

/** Entrées affichées : catégories non masquées, intitulés personnalisés appliqués. */
export function shownLegendEntries(
  doc: PlanDocument,
  settings: LegendSettings,
  excludedLayerIds: readonly string[] = [],
  excludedObjectIds: readonly string[] = [],
  detail: 'full' | 'standard' | 'simplified' = 'full',
): ShownLegendEntry[] {
  const hidden = new Set(settings.hidden);
  return legendEntries(doc, excludedLayerIds, excludedObjectIds, detail)
    .filter((e) => !hidden.has(e.key))
    .map((e) => ({ ...e, label: settings.labels[e.key]?.trim() || e.defaultLabel }));
}
