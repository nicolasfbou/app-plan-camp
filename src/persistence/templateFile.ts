/**
 * Fichier de modèle d'entreprise `.campmodele` (ZIP) pour passer un modèle d'un ordinateur à
 * l'autre : `manifest.json`, `modele.json` (validé), logo facultatif (vérifié : type, taille,
 * empreinte SHA-256). Aucun objet, aucune photo : un modèle ne contient que des réglages.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { sha256Hex } from '@/domain/image/hash.ts';
import { ProjectFormatError } from '@/domain/schema/migrations.ts';
import { checkSymbolFile } from '@/domain/symbols/importSymbol.ts';
import { templateSchema, type PlanTemplate } from '@/domain/templates/template.ts';

export const TEMPLATE_EXTENSION = '.campmodele';
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const manifestSchema = z.object({
  format: z.literal('campmodele'),
  formatVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  app: z.string(),
  template: z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  logo: z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
});

export interface TemplateContent {
  template: PlanTemplate;
  logo: Uint8Array | null;
}

export function templateFileName(name: string): string {
  const safe = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '-')
    .trim()
    .slice(0, 80);
  return `${safe || 'modele'}${TEMPLATE_EXTENSION}`;
}

export async function writeTemplateFile(content: TemplateContent): Promise<Uint8Array> {
  const json = strToU8(JSON.stringify(templateSchema.parse(content.template), null, 2));
  const files: Zippable = { 'modele.json': json };
  let logo: z.infer<typeof manifestSchema>['logo'] = null;
  if (content.template.logo && content.logo) {
    const path = `logo${content.template.logo.mimeType === 'image/svg+xml' ? '.svg' : '.png'}`;
    files[path] = [content.logo, { level: 0 }];
    logo = { path, sha256: await sha256Hex(content.logo.slice().buffer) };
  }
  const manifest = {
    format: 'campmodele' as const,
    formatVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    app: 'CampPlanner',
    template: { path: 'modele.json', sha256: await sha256Hex(json.slice().buffer) },
    logo,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}

/** Lit et vérifie un fichier de modèle ; lève `ProjectFormatError` avec un message clair. */
export async function readTemplateFile(bytes: Uint8Array): Promise<TemplateContent> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (f.originalSize > MAX_ENTRY_BYTES)
          throw new ProjectFormatError('Fichier de modèle trop volumineux.');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ProjectFormatError) throw e;
    throw new ProjectFormatError('Ce fichier n’est pas un modèle CampPlanner (.campmodele) lisible.');
  }
  const parse = (name: string): unknown => {
    const entry = entries[name];
    if (!entry) throw new ProjectFormatError(`Fichier de modèle incomplet : « ${name} » manque.`);
    try {
      return JSON.parse(strFromU8(entry));
    } catch {
      throw new ProjectFormatError(`« ${name} » est illisible.`);
    }
  };
  const manifest = manifestSchema.safeParse(parse('manifest.json'));
  if (!manifest.success) throw new ProjectFormatError('Ce fichier n’est pas un modèle CampPlanner reconnu.');
  const json = entries[manifest.data.template.path];
  if (!json || (await sha256Hex(json.slice().buffer)) !== manifest.data.template.sha256)
    throw new ProjectFormatError('Le modèle est corrompu (empreinte différente).');
  const template = templateSchema.safeParse(parse(manifest.data.template.path));
  if (!template.success) throw new ProjectFormatError('Le contenu du modèle est invalide.');
  let logo: Uint8Array | null = null;
  if (template.data.logo) {
    const file = manifest.data.logo ? entries[manifest.data.logo.path] : undefined;
    if (!file) throw new ProjectFormatError('Le logo du modèle est manquant.');
    const sha = await sha256Hex(file.slice().buffer);
    if (sha !== manifest.data.logo!.sha256 || sha !== template.data.logo.sha256)
      throw new ProjectFormatError('Le logo du modèle est corrompu (empreinte différente).');
    const check = checkSymbolFile(
      file,
      template.data.logo.mimeType === 'image/svg+xml' ? 'logo.svg' : 'logo.png',
    );
    if (!check.ok || check.mimeType !== template.data.logo.mimeType)
      throw new ProjectFormatError(`Logo du modèle refusé : ${check.ok ? 'type inattendu' : check.reason}`);
    logo = file;
  }
  return { template: template.data, logo };
}
