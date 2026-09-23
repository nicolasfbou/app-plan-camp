/**
 * Export groupé : à partir du même plan, un PDF par vue (réunis dans une archive .zip), ou un seul
 * PDF d'une page par vue. Chaque page suit exactement les réglages de sa vue.
 */
import { zipSync } from 'fflate';
import { effectiveSettings } from '@/domain/print/views.ts';
import { exportFileName, exportPdf, exportPdfPages, type ExportSource } from './exportPlan.ts';

export type BatchMode = 'separate' | 'combined';

/** Exporte les vues choisies ; retourne le fichier produit et les avertissements. */
export async function batchExport(
  source: ExportSource,
  viewIds: (string | null)[],
  mode: BatchMode,
): Promise<{ bytes: Uint8Array; fileName: string; mimeType: string; files: string[]; warnings: string[] }> {
  const all = viewIds.map((id) => effectiveSettings(source.doc, id));
  if (mode === 'combined') {
    const r = await exportPdfPages(source, all);
    return {
      bytes: r.bytes,
      fileName: r.fileName,
      mimeType: r.mimeType,
      files: [r.fileName],
      warnings: r.warnings.map((w) => w.message),
    };
  }
  const entries: Record<string, Uint8Array> = {};
  const warnings: string[] = [];
  for (const settings of all) {
    const r = await exportPdf(source, settings);
    let name = r.fileName;
    for (let n = 2; entries[name]; n++) name = r.fileName.replace(/\.pdf$/, `-${n}.pdf`);
    // PDF déjà compressés : archivés sans recompression.
    entries[name] = r.bytes;
    warnings.push(...r.warnings.map((w) => `${settings.name} : ${w.message}`));
  }
  return {
    bytes: zipSync(entries, { level: 0 }),
    fileName: exportFileName(source.doc, 'zip', 'vues'),
    mimeType: 'application/zip',
    files: Object.keys(entries),
    warnings,
  };
}
