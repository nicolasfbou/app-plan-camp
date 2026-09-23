/**
 * Actions sur les modèles d'entreprise : enregistrer le plan ouvert comme modèle, l'appliquer à un
 * plan, créer un plan à partir d'un modèle, exporter / importer un fichier `.campmodele`.
 */
import { newId, nowIso, createPlanDocument } from '@/domain/model/factories.ts';
import type { PlanDocument, PlanKind } from '@/domain/model/types.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import { applyTemplate, templateFromPlan, type PlanTemplate } from '@/domain/templates/template.ts';
import type { StoredTemplate } from '@/persistence/ProjectRepository.ts';
import { readTemplateFile, templateFileName, writeTemplateFile } from '@/persistence/templateFile.ts';
import { planStore } from '@/store/planStore.ts';
import { downloadBytes } from './download.ts';
import { repository } from './repository.ts';

/** Enregistre les réglages du plan (jamais ses objets ni sa photo) comme modèle d'entreprise. */
export async function savePlanAsTemplate(
  doc: PlanDocument,
  name: string,
  description = '',
): Promise<PlanTemplate> {
  const logoId = doc.plan.titleBlock.logoAssetId;
  const asset = logoId ? doc.assets[logoId] : undefined;
  const blob = asset ? await repository.getBlob(asset.blobId) : undefined;
  const logoBytes = blob ? new Uint8Array(blob.bytes) : null;
  const template = templateFromPlan(doc, name.trim() || doc.plan.name, {
    description,
    logo:
      asset && logoBytes
        ? {
            name: asset.name,
            mimeType: asset.mimeType as 'image/png' | 'image/svg+xml',
            sha256: await sha256Hex(logoBytes.slice().buffer),
            byteLength: logoBytes.byteLength,
          }
        : null,
  });
  await repository.saveTemplate({ template, logo: logoBytes });
  return template;
}

/** Enregistre le logo du modèle dans le stockage et le déclare dans le plan. */
async function storeLogo(
  entry: StoredTemplate,
  target: PlanDocument,
): Promise<{ id: string; asset: PlanDocument['assets'][string] } | null> {
  if (!entry.template.logo || !entry.logo) return null;
  // Logo déjà présent dans le plan (même empreinte) : réutilisé, jamais dupliqué.
  const existing = Object.values(target.assets).find((a) => a.sha256 === entry.template.logo!.sha256);
  if (existing) return { id: existing.id, asset: existing };
  const stored = await repository.putBlob(entry.logo.slice().buffer, entry.template.logo.mimeType);
  const id = newId();
  return {
    id,
    asset: {
      id,
      name: entry.template.logo.name,
      blobId: stored.id,
      mimeType: entry.template.logo.mimeType,
      byteLength: stored.byteLength,
      sha256: stored.sha256,
      createdAt: nowIso(),
    },
  };
}

/** Applique un modèle au plan ouvert (une action, annulable). */
export async function applyTemplateToOpenPlan(
  templateId: string,
  restyleExisting: boolean,
): Promise<boolean> {
  const entry = await repository.getTemplate(templateId);
  const open = planStore.getState().doc;
  if (!entry || !open) return false;
  const logo = await storeLogo(entry, open);
  planStore.getState().update(`Appliquer le modèle ${entry.template.name}`, (d) => {
    if (logo) d.assets[logo.id] = logo.asset;
    applyTemplate(d, entry.template, { restyleExisting, logoAssetId: logo?.id ?? null });
  });
  return true;
}

/** Nouveau plan (vide, sans photo) préparé avec un modèle. */
export async function createPlanFromTemplate(params: {
  siteId: string;
  name: string;
  kind: PlanKind;
  templateId: string;
}): Promise<PlanDocument> {
  const doc = createPlanDocument({ siteId: params.siteId, name: params.name, kind: params.kind });
  const entry = await repository.getTemplate(params.templateId);
  if (entry) {
    const logo = await storeLogo(entry, doc);
    if (logo) doc.assets[logo.id] = logo.asset;
    applyTemplate(doc, entry.template, { restyleExisting: false, logoAssetId: logo?.id ?? null });
  }
  await repository.savePlan(doc);
  return doc;
}

export async function exportTemplate(id: string): Promise<string | null> {
  const entry = await repository.getTemplate(id);
  if (!entry) return null;
  const bytes = await writeTemplateFile(entry);
  const name = templateFileName(entry.template.name);
  downloadBytes(bytes, name, 'application/octet-stream');
  return name;
}

/** Importe un fichier `.campmodele` (vérifié) ; un modèle de même identifiant est remplacé. */
export async function importTemplateFile(file: File): Promise<PlanTemplate> {
  const content = await readTemplateFile(new Uint8Array(await file.arrayBuffer()));
  await repository.saveTemplate(content);
  return content.template;
}

export async function renameTemplate(id: string, name: string): Promise<void> {
  const entry = await repository.getTemplate(id);
  if (!entry || !name.trim()) return;
  await repository.saveTemplate({
    ...entry,
    template: { ...entry.template, name: name.trim(), updatedAt: nowIso() },
  });
}
