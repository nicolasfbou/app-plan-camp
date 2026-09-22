import { nanoid } from 'nanoid';
import { t } from '../../i18n/index.ts';
import { RENDER_TIERS, SCHEMA_VERSION } from './schema.ts';
import type { Layer, PlanDocument, PlanKind, RenderTier, Site } from './types.ts';

export const newId = (): string => nanoid(12);
export const nowIso = (): string => new Date().toISOString();

export function createSite(name: string): Site {
  const now = nowIso();
  return { id: newId(), name, notes: '', createdAt: now, updatedAt: now };
}

export function createLayer(tier: RenderTier, name: string): Layer {
  return { id: newId(), name, tier, visible: true, locked: false, opacity: 1 };
}

/** Un calque par niveau de rendu, nommés dans la langue de l'interface (renommables ensuite). */
export function createDefaultLayers(): Layer[] {
  return RENDER_TIERS.map((tier) => createLayer(tier, t(`layer.default.${tier}`)));
}

export function createPlanDocument(params: { siteId: string; name: string; kind?: PlanKind }): PlanDocument {
  const now = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    plan: {
      id: newId(),
      siteId: params.siteId,
      name: params.name,
      kind: params.kind ?? 'general',
      baseImage: null,
      calibration: null,
      northAngleDeg: 0,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
    layers: createDefaultLayers(),
    objects: {},
  };
}
