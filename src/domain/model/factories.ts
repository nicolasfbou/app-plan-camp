import { nanoid } from 'nanoid';
import { t } from '../../i18n/index.ts';
import { RENDER_TIERS, SCHEMA_VERSION } from './schema.ts';
import { planDefaults } from './planDefaults.ts';
import type { Layer, PlanDocument, PlanKind, RenderTier, Site } from './types.ts';

export const newId = (): string => nanoid(12);
export const nowIso = (): string => new Date().toISOString();

export function createSite(name: string): Site {
  const now = nowIso();
  return { id: newId(), name, notes: '', createdAt: now, updatedAt: now };
}

/** Limites d'affichage par défaut des flèches et pictogrammes répétés (pixels écran). */
export const DEFAULT_DISPLAY = { symbolMinPx: 12, symbolMaxPx: 44 } as const;

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
      display: { ...DEFAULT_DISPLAY },
      ...planDefaults(),
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
    layers: createDefaultLayers(),
    objects: {},
    assets: {},
    crossingReviews: [],
    readabilityReviews: [],
  };
}

/**
 * Copie d'un plan dans le même camp : nouvel identifiant et nouvelles dates. Les objets et
 * calques sont copiés ; la photo d'origine est partagée (même fichier, même empreinte).
 */
export function duplicatePlanDocument(doc: PlanDocument, name: string): PlanDocument {
  const now = nowIso();
  const copy = structuredClone(doc);
  copy.plan = { ...copy.plan, id: newId(), name, createdAt: now, updatedAt: now };
  // Une copie n'hérite jamais d'une approbation : elle repart en brouillon.
  copy.plan.titleBlock = { ...copy.plan.titleBlock, status: 'draft', approvedAt: null };
  return copy;
}

/**
 * Variante d'un plan (ex. Circulation été → Circulation hiver) : TOUT est copié au départ (objets,
 * calques, vues, réglages), puis les deux plans sont indépendants. La photo d'origine est partagée
 * (même fichier). L'origine est tracée ; la variante repart en brouillon.
 */
export function createVariant(doc: PlanDocument, name: string, kind: PlanKind): PlanDocument {
  const copy = duplicatePlanDocument(doc, name);
  copy.plan.kind = kind;
  copy.plan.variantOf = {
    planId: doc.plan.id,
    planName: doc.plan.name,
    kind: doc.plan.kind,
    createdAt: copy.plan.createdAt,
  };
  // Les décisions de lisibilité ne valent que pour le plan d'origine.
  copy.readabilityReviews = [];
  return copy;
}
