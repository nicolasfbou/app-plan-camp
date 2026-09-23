/**
 * Bibliothèque de pictogrammes des plans de camp. Chaque pictogramme est un SVG autonome (grille
 * 64 × 64) construit à partir de formes de panneau simples et de tracés lucide (licence ISC).
 * Ce sont des données : ajouter un pictogramme = ajouter une entrée.
 *
 * Les pictogrammes s'inspirent des codes usuels (couleurs, formes) mais ne reproduisent aucun
 * panneau officiel : ils servent à la lecture du plan, pas à la signalisation réelle.
 */
import { GLYPHS } from './glyphs.generated.ts';

export const SYMBOL_CATEGORIES = [
  { id: 'traffic', name: 'Circulation' },
  { id: 'parking', name: 'Stationnement' },
  { id: 'pedestrians', name: 'Piétons' },
  { id: 'deliveries', name: 'Livraison et débarquement' },
  { id: 'safety', name: 'Accès et sécurité' },
  { id: 'emergency', name: 'Urgence et secours' },
  { id: 'energy', name: 'Énergie et matières' },
] as const;
export type SymbolCategory = (typeof SYMBOL_CATEGORIES)[number]['id'];

export interface SymbolDef {
  id: string;
  name: string;
  category: SymbolCategory;
  /** Texte modifiable affiché dans le pictogramme (ex. limite de vitesse). */
  defaultText?: string;
  svg(text?: string | null): string;
}

const WHITE = '#ffffff';
const BLUE = '#1d4ed8';
const GREEN = '#15803d';
const RED = '#dc2626';
const YELLOW = '#facc15';
const INK = '#111827';

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function svg(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${content}</svg>`;
}

/** Tracé lucide (grille 24) placé dans un carré de `size` à (x, y). */
function glyph(name: string, color: string, x = 14, y = 14, size = 36, width = 2.2): string {
  const nodes = GLYPHS[name];
  if (!nodes) throw new Error(`Glyphe inconnu : ${name}`);
  const inner = nodes
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${escapeXml(v)}"`)
          .join(' ')}/>`,
    )
    .join('');
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
}

function label(text: string, size: number, color: string, y = 32): string {
  return `<text x="32" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${size}" fill="${color}">${escapeXml(text)}</text>`;
}

const square = (fill: string) =>
  `<rect x="3" y="3" width="58" height="58" rx="9" fill="${fill}" stroke="${WHITE}" stroke-width="3"/>`;
const ring = (fill = WHITE) =>
  `<circle cx="32" cy="32" r="27" fill="${fill}" stroke="${RED}" stroke-width="7"/><circle cx="32" cy="32" r="30.5" fill="none" stroke="${WHITE}" stroke-width="1.5"/>`;
const slash = `<line x1="14" y1="14" x2="50" y2="50" stroke="${RED}" stroke-width="7"/>`;
const triangle = `<path d="M32 4 L61 57 H3 Z" fill="${YELLOW}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`;
const inTriangle = (name: string) => glyph(name, INK, 20, 26, 24, 2.4);

function def(
  id: string,
  name: string,
  category: SymbolCategory,
  build: (text?: string | null) => string,
  defaultText?: string,
): SymbolDef {
  return { id, name, category, defaultText, svg: (text) => svg(build(text)) };
}

export const SYMBOLS: readonly SymbolDef[] = [
  // Circulation
  def('sign.entrance', 'Entrée', 'traffic', () => square(GREEN) + glyph('log-in', WHITE)),
  def('sign.exit', 'Sortie', 'traffic', () => square(BLUE) + glyph('log-out', WHITE)),
  def(
    'sign.one-way',
    'Sens unique',
    'traffic',
    () => square(BLUE) + `<path d="M12 26 H36 V16 L54 32 L36 48 V38 H12 Z" fill="${WHITE}"/>`,
  ),
  def(
    'sign.two-way',
    'Double sens',
    'traffic',
    () => square(BLUE) + glyph('arrow-left-right', WHITE, 12, 12, 40, 2.6),
  ),
  def(
    'sign.stop',
    'Arrêt obligatoire',
    'traffic',
    () =>
      `<path d="M21 3 H43 L61 21 V43 L43 61 H21 L3 43 V21 Z" fill="${RED}" stroke="${WHITE}" stroke-width="3"/>` +
      label('STOP', 17, WHITE),
  ),
  def(
    'sign.speed-limit',
    'Limite de vitesse',
    'traffic',
    (text) => ring() + label((text || '20').slice(0, 3), (text || '20').length > 2 ? 18 : 24, INK),
    '20',
  ),
  def('sign.heavy-vehicles', 'Véhicules lourds', 'traffic', () => square(BLUE) + glyph('truck', WHITE)),
  def(
    'sign.restricted',
    'Circulation restreinte',
    'traffic',
    () => ring() + glyph('truck', INK, 18, 18, 28, 2.4),
  ),
  // Stationnement
  def('sign.parking', 'Stationnement', 'parking', () => square(BLUE) + label('P', 42, WHITE, 34)),
  def('sign.no-parking', 'Stationnement interdit', 'parking', () => ring(BLUE) + slash),
  // Piétons
  def('sign.pedestrian', 'Piéton', 'pedestrians', () => square(BLUE) + glyph('person-standing', WHITE)),
  def(
    'sign.crosswalk',
    'Passage piéton',
    'pedestrians',
    () =>
      square(BLUE) +
      glyph('person-standing', WHITE, 18, 8, 28) +
      [14, 26, 38, 50]
        .map((x) => `<rect x="${x - 4}" y="41" width="6" height="14" fill="${WHITE}"/>`)
        .join(''),
  ),
  def(
    'sign.no-pedestrians',
    'Interdit aux piétons',
    'pedestrians',
    () => ring() + glyph('person-standing', INK, 18, 18, 28, 2.4) + slash,
  ),
  // Livraison et débarquement
  def('sign.delivery', 'Livraison', 'deliveries', () => square(BLUE) + glyph('package', WHITE)),
  def(
    'sign.unloading',
    'Débarquement / déchargement',
    'deliveries',
    () => square(BLUE) + glyph('forklift', WHITE),
  ),
  def('sign.waiting', "Zone d'attente", 'deliveries', () => square(BLUE) + glyph('hourglass', WHITE)),
  // Accès et sécurité
  def(
    'sign.no-entry',
    'Accès interdit',
    'safety',
    () =>
      `<circle cx="32" cy="32" r="29" fill="${RED}"/><rect x="12" y="27" width="40" height="10" fill="${WHITE}"/>`,
  ),
  def(
    'sign.authorized',
    'Personnel autorisé seulement',
    'safety',
    () => square(BLUE) + glyph('user-lock', WHITE),
  ),
  def('sign.danger', 'Danger', 'safety', () => triangle + label('!', 30, INK, 40)),
  def('sign.maneuver', 'Manœuvre de véhicules', 'safety', () => triangle + inTriangle('truck')),
  def('sign.reversing', 'Zone de recul', 'safety', () => triangle + inTriangle('rotate-ccw')),
  def('sign.assembly', 'Point de rassemblement', 'safety', () => square(GREEN) + glyph('users', WHITE)),
  def('sign.emergency-access', "Accès d'urgence", 'emergency', () => square(RED) + glyph('siren', WHITE)),
  // Urgence et secours
  def('sign.extinguisher', 'Extincteur', 'emergency', () => square(RED) + glyph('fire-extinguisher', WHITE)),
  def(
    'sign.first-aid',
    'Premiers soins',
    'emergency',
    () => square(GREEN) + `<path d="M26 14 H38 V26 H50 V38 H38 V50 H26 V38 H14 V26 H26 Z" fill="${WHITE}"/>`,
  ),
  // Énergie et matières
  def('sign.generator', 'Génératrice', 'energy', () => triangle + inTriangle('zap')),
  def('sign.fuel', 'Carburant', 'energy', () => triangle + inTriangle('fuel')),
  def('sign.propane', 'Propane', 'energy', () => triangle + inTriangle('flame')),
  def('sign.hazmat', 'Matières dangereuses', 'energy', () => triangle + inTriangle('biohazard')),
  def('sign.waste', 'Déchets', 'energy', () => square(GREEN) + glyph('trash', WHITE)),
  def('sign.technical', 'Zone technique', 'energy', () => square('#475569') + glyph('cog', WHITE)),
];

/**
 * Repères internes des corridors piétons (pas dans la bibliothèque) : silhouette droite, ou pas
 * orientés dans le sens du déplacement (le tracé lucide « footprints » pointe vers le haut).
 */
export const CORRIDOR_MARKS: readonly SymbolDef[] = [
  def(
    'mark.walker',
    'Piéton',
    'pedestrians',
    () =>
      `<circle cx="32" cy="32" r="29" fill="${WHITE}" stroke="${INK}" stroke-width="3"/>` +
      glyph('person-standing', INK, 14, 14, 36, 2.4),
  ),
  def(
    'mark.footprints',
    'Pas',
    'pedestrians',
    () => glyph('footprints', WHITE, 8, 8, 48, 4.5) + glyph('footprints', INK, 8, 8, 48, 2.2),
  ),
];

const BY_ID = new Map([...SYMBOLS, ...CORRIDOR_MARKS].map((s) => [s.id, s]));

export function findSymbol(id: string): SymbolDef | undefined {
  return BY_ID.get(id);
}

export const ASSET_SYMBOL_PREFIX = 'asset:';
export const isAssetSymbol = (symbolId: string) => symbolId.startsWith(ASSET_SYMBOL_PREFIX);
export const assetSymbolId = (assetId: string) => `${ASSET_SYMBOL_PREFIX}${assetId}`;
export const assetIdOf = (symbolId: string) => symbolId.slice(ASSET_SYMBOL_PREFIX.length);

/** SVG d'un pictogramme de la bibliothèque, en URL de données (affichage via une image). */
export function symbolDataUrl(id: string, text?: string | null): string | null {
  const symbol = findSymbol(id);
  return symbol ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(symbol.svg(text))}` : null;
}
