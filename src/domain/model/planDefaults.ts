/**
 * Valeurs par défaut des réglages du plan professionnel (phase 5) : légende, cartouche, mise en
 * page. Utilisées à la création d'un plan et par la migration 3 → 4.
 */
import type { LegendSettings, PrintSettings, TitleBlock } from './types.ts';

export const DEFAULT_LEGEND: LegendSettings = {
  visible: true,
  title: 'Légende',
  // À côté du plan : la légende ne cache jamais la photo par défaut.
  placement: 'side',
  mode: 'detailed',
  sizeFactor: 1,
  hidden: [],
  labels: {},
};

export const DEFAULT_TITLE_BLOCK: TitleBlock = {
  campName: '',
  title: '',
  client: '',
  company: '',
  preparedBy: '',
  checkedBy: '',
  approvedBy: '',
  date: '',
  planNumber: '',
  revision: 'A',
  notes: '',
  status: 'draft',
  approvedAt: null,
  logoAssetId: null,
  placement: 'side',
};

export const DEFAULT_PRINT: PrintSettings = {
  paper: 'tabloid',
  orientation: 'landscape',
  marginMm: 10,
  mode: 'complete',
  dpi: 200,
  jpegQuality: 0.9,
  extent: 'image',
  background: 'white',
  include: {
    title: true,
    legend: true,
    titleBlock: true,
    logo: true,
    north: true,
    scaleBar: true,
    date: true,
    revision: true,
    notes: true,
  },
  excludedLayerIds: [],
};

/** Copies indépendantes (jamais d'objet par défaut partagé entre plans). */
export const planDefaults = () => ({
  northStatus: 'undefined' as const,
  units: 'metric' as const,
  legend: structuredClone(DEFAULT_LEGEND),
  titleBlock: structuredClone(DEFAULT_TITLE_BLOCK),
  print: structuredClone(DEFAULT_PRINT),
});
