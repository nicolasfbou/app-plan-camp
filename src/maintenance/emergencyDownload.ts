import { repository } from '@/app/repository.ts';
import { downloadBytes } from '@/app/download.ts';
import { saveNow } from '@/app/saveNow.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import { exportEmergency } from '@/persistence/emergency.ts';
import { planStore, selectIsDirty } from '@/store/planStore.ts';

/** Copie de secours téléchargée tout de suite (fonctionne même si le reste est en erreur). */
export async function downloadEmergencyCopy(
  planId: string,
): Promise<{ complete: boolean; problems: string[]; fileName: string }> {
  try {
    await saveNow();
  } catch (error) {
    // Écriture impossible (stockage plein, conflit, lecture seule) : le document en mémoire est
    // exporté (rien de ce qui est à l'écran n'est perdu), avec la version enregistrée jointe.
    logEvent('export', error, { context: 'copie de secours : document en mémoire utilisé' });
  }
  const state = planStore.getState();
  const memoryDoc = state.doc?.plan.id === planId && selectIsDirty(state) ? state.doc : null;
  const r = await exportEmergency(repository, planId, { memoryDoc });
  downloadBytes(r.bytes, r.fileName, 'application/octet-stream');
  if (!r.complete)
    logEvent('export', `Copie de secours incomplète : ${r.problems.join(' ; ')}`, {
      level: 'warn',
      context: `plan ${planId}`,
    });
  return r;
}
