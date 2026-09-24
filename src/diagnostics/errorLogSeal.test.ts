/**
 * Journal d'erreurs et déconnexion d'un poste partagé (phase 9.1) : un onglet figé, dont la vue de
 * localStorage est périmée, peut réécrire le journal APRÈS son effacement. Ces entrées ne
 * redeviennent jamais visibles, et sont retirées physiquement au balayage suivant.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { logEvent, pruneErrorLog, readErrorLog, sealErrorLog } from './errorLog';

beforeEach(() => localStorage.clear());

describe('journal scellé à la déconnexion', () => {
  it('réécriture tardive d’anciennes entrées et d’entrées d’un espace effacé : ignorées puis retirées', () => {
    logEvent('app', 'avant', { now: new Date('2026-09-24T10:00:00Z') });
    sealErrorLog(new Date('2026-09-24T10:00:05Z'));
    localStorage.setItem('campplanner.purgedDatabases', JSON.stringify(['campplanner-org-x']));
    // Onglet figé : réécrit sa vue périmée (ancienne entrée + une entrée de l'espace effacé).
    const stale = [
      { at: '2026-09-24T10:00:00.000Z', category: 'app', level: 'error', message: 'avant' },
      { message: 'sans date' },
      {
        at: '2026-09-24T10:00:06.000Z',
        category: 'lock',
        level: 'info',
        message: 'Plan ouvert ailleurs : lecture seule.',
        space: 'campplanner-org-x',
      },
    ];
    localStorage.setItem('campplanner.errorLog', JSON.stringify(stale));
    expect(readErrorLog()).toEqual([]);
    pruneErrorLog();
    expect(localStorage.getItem('campplanner.errorLog')).toBeNull();
  });

  it('entrées postérieures de l’espace local : conservées', () => {
    sealErrorLog(new Date('2026-09-24T10:00:05Z'));
    logEvent('app', 'après', { now: new Date('2026-09-24T10:00:10Z') });
    pruneErrorLog();
    expect(readErrorLog().map((e) => e.message)).toEqual(['après']);
  });
});
