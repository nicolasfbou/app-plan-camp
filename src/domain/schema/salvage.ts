/**
 * Récupération PARTIELLE d'un document de plan endommagé (import en mode « récupération », copie de
 * secours) : chaque partie invalide est retirée ou remplacée par sa valeur par défaut, et chaque
 * perte est décrite. Le résultat n'est jamais présenté comme complet.
 */
import { createPlanDocument } from '../model/factories.ts';
import {
  crossingReviewSchema,
  layerSchema,
  planObjectSchema,
  planSchema,
  planViewSchema,
  readabilityReviewSchema,
  SCHEMA_VERSION,
  symbolAssetSchema,
} from '../model/schema.ts';
import type { PlanDocument } from '../model/types.ts';
import { migrateDocument } from './migrations.ts';
import { parsePlanDocument } from './serialization.ts';

export interface SalvageResult {
  doc: PlanDocument;
  problems: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function salvagePlanDocument(input: unknown): SalvageResult | null {
  const problems: string[] = [];
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isRecord(raw)) return null;
  let migrated: Record<string, unknown>;
  try {
    const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : SCHEMA_VERSION;
    if (version !== raw.schemaVersion) problems.push('Version du format absente : format actuel supposé.');
    migrated = migrateDocument({ ...raw, schemaVersion: version });
  } catch (error) {
    problems.push(`Migration impossible : ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const rawPlan: Record<string, unknown> = { ...(isRecord(migrated.plan) ? migrated.plan : {}) };
  // Vues : filtrées une à une (une vue illisible ne fait pas perdre les autres).
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const rawViews = list(rawPlan.views);
  rawPlan.views = rawViews.filter((v) => planViewSchema.safeParse(v).success);
  if ((rawPlan.views as unknown[]).length !== rawViews.length)
    problems.push(`${rawViews.length - (rawPlan.views as unknown[]).length} vue(s) illisible(s) retirée(s).`);
  const fallback = createPlanDocument({
    siteId: typeof rawPlan.siteId === 'string' && rawPlan.siteId ? rawPlan.siteId : 'recupere',
    name: typeof rawPlan.name === 'string' ? rawPlan.name : 'Plan récupéré',
  });
  // Champs du plan : chaque champ invalide reprend sa valeur par défaut (signalé).
  const plan: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(planSchema.shape)) {
    const value = rawPlan[key];
    if (schema.safeParse(value).success) plan[key] = value;
    else {
      plan[key] = (fallback.plan as Record<string, unknown>)[key];
      problems.push(`Champ du plan « ${key} » illisible : valeur par défaut.`);
    }
  }

  const layers = list(migrated.layers).filter((l) => layerSchema.safeParse(l).success);
  const droppedLayers = list(migrated.layers).length - layers.length;
  if (droppedLayers) problems.push(`${droppedLayers} calque(s) illisible(s) retiré(s).`);
  if (!layers.length) {
    layers.push(...fallback.layers);
    problems.push('Aucun calque lisible : calques par défaut recréés.');
  }
  const layerIds = new Set(layers.map((l) => (l as { id: string }).id));

  const objects: Record<string, unknown> = {};
  let droppedObjects = 0;
  for (const [id, object] of Object.entries(isRecord(migrated.objects) ? migrated.objects : {})) {
    const parsed = planObjectSchema.safeParse(object);
    if (parsed.success && parsed.data.id === id && layerIds.has(parsed.data.layerId)) objects[id] = object;
    else droppedObjects++;
  }
  if (droppedObjects) problems.push(`${droppedObjects} objet(s) illisible(s) retiré(s).`);

  const assets: Record<string, unknown> = {};
  let droppedAssets = 0;
  for (const [id, asset] of Object.entries(isRecord(migrated.assets) ? migrated.assets : {})) {
    if (symbolAssetSchema.safeParse(asset).success) assets[id] = asset;
    else droppedAssets++;
  }
  if (droppedAssets) problems.push(`${droppedAssets} pictogramme(s) importé(s) illisible(s) retiré(s).`);

  const crossingReviews = list(migrated.crossingReviews).filter(
    (r) => crossingReviewSchema.safeParse(r).success,
  );
  const readabilityReviews = list(migrated.readabilityReviews).filter(
    (r) => readabilityReviewSchema.safeParse(r).success,
  );
  if (crossingReviews.length !== list(migrated.crossingReviews).length)
    problems.push('Suivi des croisements partiellement illisible (entrées retirées).');
  if (readabilityReviews.length !== list(migrated.readabilityReviews).length)
    problems.push('Suivi de lisibilité partiellement illisible (entrées retirées).');

  try {
    const doc = parsePlanDocument({
      schemaVersion: SCHEMA_VERSION,
      plan,
      layers,
      objects,
      assets,
      crossingReviews,
      readabilityReviews,
    });
    return { doc, problems };
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}
