import type { z } from 'zod';
import type {
  baseImageRefSchema,
  calibrationSchema,
  crossingReviewSchema,
  displaySettingsSchema,
  legendSettingsSchema,
  printSettingsSchema,
  titleBlockSchema,
  geometrySchema,
  layerSchema,
  planDocumentSchema,
  planObjectSchema,
  planSchema,
  pointSchema,
  renderTierSchema,
  siteSchema,
  styleSchema,
  symbolAssetSchema,
  zoneIconSchema,
} from './schema.ts';

export type Point = z.infer<typeof pointSchema>;
export type Geometry = z.infer<typeof geometrySchema>;
export type Style = z.infer<typeof styleSchema>;
export type RenderTier = z.infer<typeof renderTierSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type PlanObject = z.infer<typeof planObjectSchema>;
export type PlanObjectType = PlanObject['type'];
export type BaseImageRef = z.infer<typeof baseImageRefSchema>;
export type Calibration = z.infer<typeof calibrationSchema>;
export type Plan = z.infer<typeof planSchema>;
export type PlanKind = Plan['kind'];
export type PlanDocument = z.infer<typeof planDocumentSchema>;
export type Site = z.infer<typeof siteSchema>;
export type SymbolAsset = z.infer<typeof symbolAssetSchema>;
export type CrossingReview = z.infer<typeof crossingReviewSchema>;
export type DisplaySettings = z.infer<typeof displaySettingsSchema>;
export type ZoneIcon = z.infer<typeof zoneIconSchema>;
export type FlowObject = Extract<PlanObject, { type: 'flow' }>;
export type CorridorObject = Extract<PlanObject, { type: 'corridor' }>;
export type IconObject = Extract<PlanObject, { type: 'icon' }>;
export type ZoneObject = Extract<PlanObject, { type: 'zone' }>;
export type FlowCategory = FlowObject['category'];
export type LegendSettings = z.infer<typeof legendSettingsSchema>;
export type TitleBlock = z.infer<typeof titleBlockSchema>;
export type PrintSettings = z.infer<typeof printSettingsSchema>;
export type DimensionObject = Extract<PlanObject, { type: 'dimension' }>;
export type StallObject = Extract<PlanObject, { type: 'stall' }>;
export type PlanStatus = TitleBlock['status'];
