/**
 * Import d'un pictogramme personnalisé (PNG ou SVG vérifié). Les octets sont conservés tels quels
 * dans le stockage local ; le plan référence le fichier (`doc.assets`), qui voyage avec le projet
 * dans le fichier .campplan.
 */
import { repository } from '@/app/repository.ts';
import { newId, nowIso } from '@/domain/model/factories.ts';
import { assetSymbolId } from '@/domain/symbols/catalog.ts';
import { checkSymbolFile } from '@/domain/symbols/importSymbol.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';

/** Importe le fichier ; en cas de succès, le pictogramme est prêt à être placé (outil actif). */
export async function importSymbolFile(file: File): Promise<string | null> {
  const editor = useEditorStore.getState();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkSymbolFile(bytes, file.name);
  if (!check.ok) {
    editor.notify(t('tools.symbols.rejected', { reason: check.reason }));
    return null;
  }
  if (!planStore.getState().doc) return null;
  const stored = await repository.putBlob(bytes.slice().buffer, check.mimeType);
  const id = newId();
  const name = file.name.replace(/\.(png|svg)$/i, '') || 'Pictogramme';
  planStore.getState().update('Importer un pictogramme', (d) => {
    d.assets[id] = {
      id,
      name,
      blobId: stored.id,
      mimeType: check.mimeType,
      byteLength: stored.byteLength,
      sha256: stored.sha256,
      createdAt: nowIso(),
    };
  });
  editor.pickSymbol(assetSymbolId(id));
  editor.notify(t('tools.symbols.imported', { name }));
  return id;
}
