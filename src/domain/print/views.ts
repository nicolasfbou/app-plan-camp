/**
 * Vues par public. Une vue est un FILTRE (calques, objets exclus, niveau de détail) et un jeu de
 * réglages d'impression (style, légende, titre, cartouche, options d'export) appliqués au plan de
 * base : les objets ne sont jamais copiés, et passer d'une vue à l'autre ne modifie pas le plan.
 */
import { newId } from '../model/factories.ts';
import { PRINT_STYLES } from '../model/planDefaults.ts';
import type {
  Audience,
  LegendSettings,
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
  // Employés : piétons, stationnement, rassemblement ; les livraisons ne les concernent pas.
  employees: {
    hiddenTiers: ['deliveries'],
    style: 'employees',
    detail: 'standard',
    legendMode: 'compact',
    note: 'Destiné aux employés du camp',
  },
  // Fournisseurs : accès, livraison, débarquement, sécurité ; pas le stationnement du personnel.
  suppliers: {
    hiddenTiers: ['parking'],
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
  };
}

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
