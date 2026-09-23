import { repository } from '@/app/repository.ts';
import { downloadBytes } from '@/app/download.ts';
import { saveNow } from '@/app/saveNow.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import { exportEmergency } from '@/persistence/emergency.ts';

/** Copie de secours téléchargée tout de suite (fonctionne même si le reste est en erreur). */
export async function downloadEmergencyCopy(
  planId: string,
): Promise<{ complete: boolean; problems: string[]; fileName: string }> {
  try {
    await saveNow();
  } catch (error) {
    // Écriture impossible (conflit, lecture seule) : la copie part de ce qui est enregistré.
    logEvent('export', error, { context: 'copie de secours : dernière version enregistrée utilisée' });
  }
  const r = await exportEmergency(repository, planId);
  downloadBytes(r.bytes, r.fileName, 'application/octet-stream');
  if (!r.complete)
    logEvent('export', `Copie de secours incomplète : ${r.problems.join(' ; ')}`, {
      level: 'warn',
      context: r.fileName,
    });
  return r;
}
