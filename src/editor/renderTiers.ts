/**
 * Organisation du Stage Konva en couches de rendu distinctes (un canvas chacune).
 * Modifier un objet ne redessine que la couche de son niveau, jamais la photo ni les autres.
 */
import { RENDER_TIERS } from '@/domain/model/schema.ts';

export const STAGE_LAYERS = ['background', ...RENDER_TIERS, 'overlay'] as const;
export type StageLayerName = (typeof STAGE_LAYERS)[number];

/** Couches qui ne réagissent pas au pointeur (photo) ou qui sont purement visuelles. */
export const NON_INTERACTIVE_LAYERS: ReadonlySet<StageLayerName> = new Set(['background']);
