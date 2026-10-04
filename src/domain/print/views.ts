/**
 * Vues par public. Une vue est un FILTRE (calques, objets exclus, niveau de détail) et un jeu de
 * réglages d'impression (style, légende, titre, cartouche, options d'export) appliqués au plan de
 * base : les objets ne sont jamais copiés, et passer d'une vue à l'autre ne modifie pas le plan.
 */
import { newId } from '../model/factories.ts';
import { PRINT_STYLES } from '../model/planDefaults.ts';
import { NETWORK_TIERS } from '../model/schema.ts';
import type {
  Audience,
  LegendSettings,
  NetworkTier,
  PlanDocument,
  PlanView,
  PrintSettings,
  PrintStyle,
  RenderTier,
} from '../model/types.ts';

export const AUDIENCE_LABELS: Record<Audience, string> = {
  employees: 'Employés',
  suppliers: 'Fournisseurs',
  management: 'Direction',
  safety: 'Sécurité / urgence',
  custom: 'Personnalisée',
};

/**
 * Point de départ proposé pour chaque public (tout reste modifiable ensuite). Les calques sont
 * désignés par catégorie : la vue s'adapte à n'importe quel plan.
 */
export const AUDIENCE_PRESETS: Record<
  Audience,
  {
    hiddenTiers: RenderTier[];
    style: Exclude<PrintStyle['preset'], 'custom'>;
    detail: PrintSettings['detail'];
    legendMode: LegendSettings['mode'];
    note: string;
  }
> = {
  // Employés : piétons, stationnement, rassemblement ; ni livraisons ni réseaux techniques.
  employees: {
    hiddenTiers: ['deliveries', ...NETWORK_TIERS],
    style: 'employees',
    detail: 'standard',
    legendMode: 'compact',
    note: 'Destiné aux employés du camp',
  },
  // Fournisseurs : accès, livraison, débarquement, sécurité ; ni stationnement du personnel ni réseaux.
  suppliers: {
    hiddenTiers: ['parking', ...NETWORK_TIERS],
    style: 'supplier',
    detail: 'standard',
    legendMode: 'compact',
    note: 'Destiné aux fournisseurs et transporteurs',
  },
  // Direction : tout, présentation soignée et légende détaillée.
  management: {
    hiddenTiers: [],
    style: 'client',
    detail: 'full',
    legendMode: 'detailed',
    note: 'Destiné à la direction du camp',
  },
  // Sécurité / urgence : accès, voies d'urgence, rassemblement ; lisible sur le terrain.
  safety: {
    hiddenTiers: ['parking', 'deliveries'],
    style: 'field',
    detail: 'standard',
    legendMode: 'compact',
    note: 'Destiné à la sécurité et aux services d’urgence',
  },
  custom: { hiddenTiers: [], style: 'standard', detail: 'full', legendMode: 'detailed', note: '' },
};

export function styleFromPreset(preset: Exclude<PrintStyle['preset'], 'custom'>): PrintStyle {
  return { preset, ...PRINT_STYLES[preset] };
}

/** Nouvelle vue : réglages du plan de base + point de départ du public choisi. */
export function createView(doc: PlanDocument, audience: Audience, name?: string): PlanView {
  const preset = AUDIENCE_PRESETS[audience];
  const hidden = doc.layers.filter((l) => preset.hiddenTiers.includes(l.tier)).map((l) => l.id);
  const print = structuredClone(doc.plan.print);
  return {
    id: newId(),
    name: name ?? AUDIENCE_LABELS[audience],
    audience,
    title: '',
    audienceNote: preset.note,
    titleBlockPlacement: doc.plan.titleBlock.placement,
    legend: { ...structuredClone(doc.plan.legend), mode: preset.legendMode },
    print: {
      ...print,
      excludedLayerIds: [...new Set([...print.excludedLayerIds, ...hidden])],
      excludedObjectIds: [],
      detail: preset.detail,
      style: styleFromPreset(preset.style),
    },
    network: null,
  };
}

/** Catégories gardées dans la vue d'un réseau, pour se repérer : zones, bâtiments et textes. */
const NETWORK_VIEW_TIERS: readonly RenderTier[] = ['zones', 'buildings', 'texts'];

/**
 * Vue imprimable d'un seul réseau technique (« un plan par réseau ») : la photo, les zones,
 * bâtiments et textes pour se repérer, et ce réseau seulement. Comme toute vue, c'est un filtre :
 * rien n'est copié ; les calques de ce réseau créés ensuite y apparaissent, ceux des autres réseaux
 * y restent masqués (voir `hideNewNetworkLayerInViews`).
 */
export function createNetworkView(
  doc: PlanDocument,
  network: NetworkTier,
  name: string,
  note: string,
): PlanView {
  const view = createView(doc, 'custom', name);
  const hidden = doc.layers
    .filter((l) => l.tier !== network && !NETWORK_VIEW_TIERS.includes(l.tier))
    .map((l) => l.id);
  view.title = name;
  view.audienceNote = note;
  view.network = network;
  view.print.excludedLayerIds = [...new Set([...view.print.excludedLayerIds, ...hidden])];
  return view;
}

/**
 * Nouveau calque de réseau : masqué dans les vues qui filtrent les réseaux (vues Employés et
 * Fournisseurs, vue d'un AUTRE réseau, vue qui masque déjà un réseau), pour qu'un réseau tracé
 * plus tard n'apparaisse pas sans prévenir dans une vue préparée sans lui. Les autres vues (et la
 * vue de ce même réseau) l'affichent.
 */
export function hideNewNetworkLayerInViews(doc: PlanDocument, layerId: string): void {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) return;
  const networkLayers = new Set(
    doc.layers.filter((l) => l.id !== layerId && isNetwork(l.tier)).map((l) => l.id),
  );
  for (const view of doc.plan.views) {
    const excluded = view.print.excludedLayerIds;
    const filters =
      view.network !== null
        ? view.network !== layer.tier
        : view.audience === 'employees' ||
          view.audience === 'suppliers' ||
          excluded.some((id) => networkLayers.has(id));
    if (filters && !excluded.includes(layerId)) excluded.push(layerId);
  }
}

const isNetwork = (tier: RenderTier) => (NETWORK_TIERS as readonly string[]).includes(tier);

/** Réglages effectifs d'un export : ceux de la vue, ou ceux du plan de base (`viewId` null). */
export interface EffectiveSettings {
  viewId: string | null;
  /** Nom affiché (« Plan de base » ou nom de la vue). */
  name: string;
  audience: Audience | null;
  print: PrintSettings;
  legend: LegendSettings;
  /** Titre imprimé (jamais vide). */
  title: string;
  audienceNote: string;
  titleBlockPlacement: 'side' | 'bottom';
}

export function effectiveSettings(doc: PlanDocument, viewId: string | null): EffectiveSettings {
  const view = viewId ? doc.plan.views.find((v) => v.id === viewId) : undefined;
  const baseTitle = doc.plan.titleBlock.title || doc.plan.name;
  if (!view)
    return {
      viewId: null,
      name: 'Plan de base',
      audience: null,
      print: doc.plan.print,
      legend: doc.plan.legend,
      title: baseTitle,
      audienceNote: '',
      titleBlockPlacement: doc.plan.titleBlock.placement,
    };
  return {
    viewId: view.id,
    name: view.name,
    audience: view.audience,
    print: view.print,
    // Légende simplifiée par le style : compacte (sans groupes ni nombres).
    legend: view.print.style.simpleLegend ? { ...view.legend, mode: 'compact' } : view.legend,
    title: view.title || baseTitle,
    audienceNote: view.audienceNote,
    titleBlockPlacement: view.titleBlockPlacement,
  };
}

/** Calques et objets masqués par une vue (affichage de l'éditeur ; rien n'est modifié). */
export function viewFilter(doc: PlanDocument, viewId: string | null) {
  const view = viewId ? doc.plan.views.find((v) => v.id === viewId) : undefined;
  return {
    hiddenLayers: new Set(view?.print.excludedLayerIds ?? []),
    hiddenObjects: new Set(view?.print.excludedObjectIds ?? []),
  };
}

/** Réglages modifiables d'une vue ou du plan de base, pour une mise à jour (brouillon immer). */
export function editableSettings(draft: PlanDocument, viewId: string | null) {
  const view = viewId ? draft.plan.views.find((v) => v.id === viewId) : undefined;
  return view
    ? { print: view.print, legend: view.legend, view }
    : { print: draft.plan.print, legend: draft.plan.legend, view: null };
}
