/**
 * Organisation du rendu Konva.
 *
 * Les 8 catégories LOGIQUES restent séparées (fond, 6 niveaux d'annotation, sélection/UI) :
 * - dans les données, chaque calque porte son niveau (`Layer.tier`) ;
 * - dans le Stage, chaque niveau d'annotation est un `Konva.Group` nommé.
 *
 * Elles sont réparties sur 3 couches PHYSIQUES (un canvas chacune) seulement. Mesure sur une vraie
 * photo de 18 MP (bench/konva-layers.mjs, voir ARCHITECTURE.md §11) : 8 canvas coûtaient
 * +320 Mo à 1x et +1,1 Go en écran HiDPI, avec une fluidité 2 à 2,5 fois moindre.
 */
import { RENDER_TIERS } from '@/domain/model/schema.ts';

export const STAGE_LAYERS = ['background', 'content', 'overlay'] as const;
export type StageLayerName = (typeof STAGE_LAYERS)[number];

/** Catégories logiques d'annotation, dessinées dans cet ordre (de bas en haut) dans `content`. */
export const CONTENT_GROUPS = RENDER_TIERS;
