import type { z } from 'zod';
import type {
  baseImageRefSchema,
  calibrationSchema,
  geometrySchema,
  layerSchema,
  planDocumentSchema,
  planObjectSchema,
  planSchema,
  pointSchema,
  renderTierSchema,
  siteSchema,
  styleSchema,
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
