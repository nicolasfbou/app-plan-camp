/**
 * Organisation du rendu Konva : 3 couches PHYSIQUES (un canvas chacune) seulement.
 *
 * - `background` : la photo d'origine, verrouillée ;
 * - `content`    : un `Konva.Group` par calque du plan, dans l'ordre des calques ; chaque groupe
 *                  porte la catégorie logique de son calque (`tier-zones`, `tier-buildings`…) ;
 * - `overlay`    : sélection, poignées, formes en cours, rectangle de sélection.
 *
 * Les 8 catégories logiques (fond, 6 catégories d'annotation, sélection/UI) restent séparées dans
 * les données (`Layer.tier`) et dans l'arbre Konva. Mesure (bench/konva-layers.mjs, ARCHITECTURE.md
 * §11) : 8 canvas coûtaient +320 Mo à 1x et +1,1 Go en HiDPI, avec une fluidité 2 à 2,5 fois moindre.
 */
export const STAGE_LAYERS = ['background', 'content', 'overlay'] as const;
export type StageLayerName = (typeof STAGE_LAYERS)[number];
