/**
 * Génère `src/domain/symbols/glyphs.generated.ts` à partir des icônes lucide (licence ISC) déjà
 * présentes dans node_modules. Usage : node scripts/build-glyphs.mjs
 * Le fichier généré est versionné : l'application ne dépend d'aucun réseau pour ses pictogrammes.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = [
  'log-in',
  'log-out',
  'truck',
  'package',
  'forklift',
  'hourglass',
  'users',
  'siren',
  'fire-extinguisher',
  'fuel',
  'zap',
  'flame',
  'biohazard',
  'trash',
  'cog',
  'user-lock',
  'rotate-ccw',
  'person-standing',
  'footprints',
  'arrow-left-right',
];
const glyphs = {};
for (const name of NAMES) {
  const { __iconData } = await import(`../node_modules/lucide-react/dist/esm/icons/${name}.mjs`);
  if (!__iconData) throw new Error(`Icône illisible : ${name}`);
  const node = __iconData.node;
  glyphs[name] = node.map(([tag, attrs]) => {
    const { key: _key, ...rest } = attrs;
    return [tag, rest];
  });
}
const version = JSON.parse(readFileSync('node_modules/lucide-react/package.json', 'utf8')).version;
writeFileSync(
  'src/domain/symbols/glyphs.generated.ts',
  `/**
 * FICHIER GÉNÉRÉ par scripts/build-glyphs.mjs — ne pas modifier à la main.
 * Tracés des icônes lucide ${version} (licence ISC, https://lucide.dev), grille 24 × 24.
 */
export type GlyphNode = readonly [tag: string, attrs: Readonly<Record<string, string>>];

export const GLYPHS: Readonly<Record<string, readonly GlyphNode[]>> = ${JSON.stringify(glyphs, null, 2)};
`,
);
console.log(`${NAMES.length} glyphes écrits.`);
