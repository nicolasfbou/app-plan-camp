/**
 * Modèles d'entreprise réutilisables : cartouche (champs d'entreprise, jamais d'approbation), logo,
 * calques, légende, styles des objets, vues par public et réglages d'impression. Un modèle ne
 * contient AUCUN objet ni photo : il s'applique à n'importe quel plan. Les calques y sont désignés
 * par leur catégorie (et leur nom), les vues aussi : un modèle s'adapte au plan qui le reçoit.
 */
import { z } from 'zod';
import { createLayer, newId, nowIso } from '../model/factories.ts';
import { withOverride } from '../model/objectFactory.ts';
import {
  AUDIENCES,
  displaySettingsSchema,
  hexColorSchema,
  legendSettingsSchema,
  printSettingsSchema,
  renderTierSchema,
  styleSchema,
} from '../model/schema.ts';
import type { PlanDocument, PlanView, PrintSettings, RenderTier } from '../model/types.ts';

export const TEMPLATE_FORMAT_VERSION = 1;

/** Réglages d'impression d'un modèle : calques exclus désignés par catégorie, aucun objet exclu. */
const templatePrintSchema = printSettingsSchema
  .omit({ excludedLayerIds: true, excludedObjectIds: true })
  .extend({ excludedTiers: z.array(renderTierSchema) });

export const templateSchema = z.object({
  format: z.literal('campmodele'),
  formatVersion: z.literal(TEMPLATE_FORMAT_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Champs d'entreprise du cartouche (jamais le statut ni l'approbation). */
  titleBlock: z.object({
    company: z.string(),
    client: z.string(),
    preparedBy: z.string(),
    checkedBy: z.string(),
    notes: z.string(),
    placement: z.enum(['side', 'bottom']),
  }),
  /** Logo : octets transportés à part (fichier du modèle), vérifiés à l'import. */
  logo: z
    .object({
      name: z.string(),
      mimeType: z.enum(['image/png', 'image/svg+xml']),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      byteLength: z.number().int().positive(),
    })
    .nullable(),
  layers: z.array(
    z.object({
      name: z.string(),
      tier: renderTierSchema,
      visible: z.boolean(),
      locked: z.boolean(),
      opacity: z.number().min(0).max(1),
    }),
  ),
  legend: legendSettingsSchema,
  /** Couleurs et styles par modèle d'objet (`presetId`). */
  styleOverrides: z.record(z.string(), styleSchema),
  display: displaySettingsSchema,
  units: z.enum(['metric', 'imperial']),
  print: templatePrintSchema,
  views: z.array(
    z.object({
      name: z.string(),
      audience: z.enum(AUDIENCES),
      title: z.string(),
      audienceNote: z.string(),
      titleBlockPlacement: z.enum(['side', 'bottom']),
      legend: legendSettingsSchema,
      print: templatePrintSchema,
    }),
  ),
  /** Couleur d'accent de l'entreprise (facultative, pour l'interface). */
  accent: hexColorSchema.nullable(),
});

export type PlanTemplate = z.infer<typeof templateSchema>;
type TemplatePrint = z.infer<typeof templatePrintSchema>;

function printToTemplate(doc: PlanDocument, print: PrintSettings): TemplatePrint {
  const { excludedLayerIds, excludedObjectIds: _objects, ...rest } = structuredClone(print);
  const tiers = new Set<RenderTier>();
  for (const id of excludedLayerIds) {
    const layer = doc.layers.find((l) => l.id === id);
    if (layer) tiers.add(layer.tier);
  }
  return { ...rest, excludedTiers: [...tiers] };
}

function printFromTemplate(doc: PlanDocument, print: TemplatePrint): PrintSettings {
  const { excludedTiers, ...rest } = structuredClone(print);
  return {
    ...rest,
    excludedLayerIds: doc.layers.filter((l) => excludedTiers.includes(l.tier)).map((l) => l.id),
    excludedObjectIds: [],
  };
}

/** Modèle tiré d'un plan (ses réglages, jamais ses objets ni sa photo). */
export function templateFromPlan(
  doc: PlanDocument,
  name: string,
  options: { description?: string; logo?: PlanTemplate['logo']; now?: string } = {},
): PlanTemplate {
  const now = options.now ?? nowIso();
  const b = doc.plan.titleBlock;
  return {
    format: 'campmodele',
    formatVersion: TEMPLATE_FORMAT_VERSION,
    id: newId(),
    name,
    description: options.description ?? '',
    createdAt: now,
    updatedAt: now,
    titleBlock: {
      company: b.company,
      client: b.client,
      preparedBy: b.preparedBy,
      checkedBy: b.checkedBy,
      notes: b.notes,
      placement: b.placement,
    },
    logo: options.logo ?? null,
    layers: doc.layers.map(({ name: n, tier, visible, locked, opacity }) => ({
      name: n,
      tier,
      visible,
      locked,
      opacity,
    })),
    legend: structuredClone(doc.plan.legend),
    styleOverrides: structuredClone(doc.plan.styleOverrides),
    display: { ...doc.plan.display },
    units: doc.plan.units,
    print: printToTemplate(doc, doc.plan.print),
    views: doc.plan.views.map((v) => ({
      name: v.name,
      audience: v.audience,
      title: v.title,
      audienceNote: v.audienceNote,
      titleBlockPlacement: v.titleBlockPlacement,
      legend: structuredClone(v.legend),
      print: printToTemplate(doc, v.print),
    })),
    accent: null,
  };
}

export interface ApplyTemplateOptions {
  /** Restyle aussi les objets existants dont le modèle d'objet a un style d'entreprise. */
  restyleExisting: boolean;
  /** Identifiant du logo déjà enregistré dans `doc.assets` (null = pas de logo). */
  logoAssetId: string | null;
  now?: string;
}

/**
 * Applique un modèle à un plan (une action pour l'appelant). Jamais : suppression d'objet ou de
 * calque, modification de la photo, du statut ou de l'approbation. Calques manquants ajoutés ;
 * vues du modèle ajoutées (ou remplacées si une vue porte le même nom).
 */
export function applyTemplate(
  doc: PlanDocument,
  template: PlanTemplate,
  options: ApplyTemplateOptions,
): void {
  const now = options.now ?? nowIso();
  // Calques : réglages repris pour les calques de même catégorie et de même nom ; manquants ajoutés.
  for (const tl of template.layers) {
    const existing =
      doc.layers.find((l) => l.tier === tl.tier && l.name === tl.name) ??
      (doc.layers.filter((l) => l.tier === tl.tier).length === 1
        ? doc.layers.find((l) => l.tier === tl.tier)
        : undefined);
    if (existing) Object.assign(existing, { visible: tl.visible, locked: tl.locked, opacity: tl.opacity });
    else {
      const layer = createLayer(tl.tier, tl.name);
      Object.assign(layer, { visible: tl.visible, locked: tl.locked, opacity: tl.opacity });
      // Inséré après le dernier calque de même catégorie (sinon en haut).
      const index = doc.layers.map((l) => l.tier).lastIndexOf(tl.tier);
      doc.layers.splice(index >= 0 ? index + 1 : doc.layers.length, 0, layer);
    }
  }
  const b = doc.plan.titleBlock;
  // Champs d'entreprise : un champ vide du modèle ne remplace jamais celui du plan (ex. notes).
  const { placement, ...fields } = template.titleBlock;
  for (const [key, value] of Object.entries(fields) as [keyof typeof fields, string][])
    if (value.trim()) b[key] = value;
  b.placement = placement;
  // Logo du modèle s'il en a un ; sinon le logo du plan est conservé.
  if (template.logo) b.logoAssetId = options.logoAssetId;
  doc.plan.legend = structuredClone(template.legend);
  doc.plan.styleOverrides = structuredClone(template.styleOverrides);
  doc.plan.display = { ...template.display };
  doc.plan.units = template.units;
  doc.plan.print = printFromTemplate(doc, template.print);
  for (const tv of template.views) {
    const view: PlanView = {
      id: newId(),
      name: tv.name,
      audience: tv.audience,
      title: tv.title,
      audienceNote: tv.audienceNote,
      titleBlockPlacement: tv.titleBlockPlacement,
      legend: structuredClone(tv.legend),
      print: printFromTemplate(doc, tv.print),
    };
    const i = doc.plan.views.findIndex((v) => v.name === tv.name);
    if (i >= 0) doc.plan.views[i] = { ...view, id: doc.plan.views[i]!.id };
    else doc.plan.views.push(view);
  }
  if (options.restyleExisting)
    for (const o of Object.values(doc.objects)) {
      const style = o.presetId ? template.styleOverrides[o.presetId] : undefined;
      if (style && !o.locked) {
        o.style = withOverride(o.style, style);
        o.updatedAt = now;
      }
    }
  doc.plan.metadata = {
    ...doc.plan.metadata,
    template: { id: template.id, name: template.name, appliedAt: now },
  };
  doc.plan.updatedAt = now;
}
