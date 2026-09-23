/**
 * Valeurs par défaut des réglages du plan professionnel (phase 5) : légende, cartouche, mise en
 * page. Utilisées à la création d'un plan et par la migration 3 → 4.
 */
import type { LegendSettings, PrintSettings, PrintStyle, TitleBlock } from './types.ts';

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

/**
 * Préréglages de style d'impression (rendu seulement). « standard » ne change rien au rendu.
 */
export const PRINT_STYLES: Record<Exclude<PrintStyle['preset'], 'custom'>, Omit<PrintStyle, 'preset'>> = {
  standard: {
    photoDim: 0,
    photoContrast: 1,
    grayscale: false,
    strokeScale: 1,
    minTextPt: 0, // standard : aucun agrandissement (rendu inchangé)
    iconScale: 1,
    simpleLegend: false,
  },
  // Terrain : lisible dans un véhicule ou en plein soleil : traits et pictogrammes renforcés.
  field: {
    photoDim: 0.2,
    photoContrast: 1.1,
    grayscale: false,
    strokeScale: 1.5,
    minTextPt: 9,
    iconScale: 1.4,
    simpleLegend: true,
  },
  // Présentation client : photo nette, rendu fidèle, légende détaillée.
  client: {
    photoDim: 0.05,
    photoContrast: 1.05,
    grayscale: false,
    strokeScale: 1,
    minTextPt: 7,
    iconScale: 1,
    simpleLegend: false,
  },
  // Fournisseur : photo atténuée, accès et livraisons ressortent.
  supplier: {
    photoDim: 0.35,
    photoContrast: 1,
    grayscale: false,
    strokeScale: 1.3,
    minTextPt: 8,
    iconScale: 1.25,
    simpleLegend: true,
  },
  // Employés : affichage mural, gros pictogrammes.
  employees: {
    photoDim: 0.25,
    photoContrast: 1,
    grayscale: false,
    strokeScale: 1.25,
    minTextPt: 9,
    iconScale: 1.4,
    simpleLegend: true,
  },
  // Noir et blanc : impression ou photocopie monochrome.
  bw: {
    photoDim: 0.35,
    photoContrast: 1.2,
    grayscale: true,
    strokeScale: 1.35,
    minTextPt: 7,
    iconScale: 1.1,
    simpleLegend: false,
  },
};

export const DEFAULT_STYLE: PrintStyle = { preset: 'standard', ...PRINT_STYLES.standard };

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
  excludedObjectIds: [],
  detail: 'full',
  style: DEFAULT_STYLE,
};

/** Copies indépendantes (jamais d'objet par défaut partagé entre plans). */
export const planDefaults = () => ({
  northStatus: 'undefined' as const,
  units: 'metric' as const,
  legend: structuredClone(DEFAULT_LEGEND),
  titleBlock: structuredClone(DEFAULT_TITLE_BLOCK),
  print: structuredClone(DEFAULT_PRINT),
  views: [],
  variantOf: null,
  styleOverrides: {},
});
