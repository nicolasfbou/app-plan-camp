import { beforeEach, describe, expect, it } from 'vitest';
import { makeLargeDocument } from '@/test/fixtures.ts';
import { clearRecovery, clearRecoveryIfCovered, readRecovery, writeRecovery } from './recovery.ts';

beforeEach(() => localStorage.clear());

describe('journal de récupération', () => {
  it('écrit puis relit exactement le document, avec sa date', () => {
    const doc = makeLargeDocument(50);
    writeRecovery(doc, undefined, 1000);
    expect(readRecovery(doc.plan.id)).toEqual({ doc, writtenAt: 1000 });
    clearRecovery(doc.plan.id);
    expect(readRecovery(doc.plan.id)).toBeNull();
  });

  it('une sauvegarde commencée AVANT le journal ne l’efface pas ; une sauvegarde commencée après, oui', () => {
    const doc = makeLargeDocument(3);
    writeRecovery(doc, undefined, 2000);
    clearRecoveryIfCovered(doc.plan.id, 1999);
    expect(readRecovery(doc.plan.id)).not.toBeNull();
    clearRecoveryIfCovered(doc.plan.id, 2000);
    expect(readRecovery(doc.plan.id)).toBeNull();
  });

  it('ignore et efface un journal corrompu ou sans date', () => {
    localStorage.setItem('campplanner.recovery.abc', '{pas du json');
    expect(readRecovery('abc')).toBeNull();
    expect(localStorage.getItem('campplanner.recovery.abc')).toBeNull();
    const doc = makeLargeDocument(1);
    localStorage.setItem(`campplanner.recovery.${doc.plan.id}`, JSON.stringify({ document: doc }));
    expect(readRecovery(doc.plan.id)).toBeNull();
  });

  it('ignore un journal appartenant à un autre plan', () => {
    const doc = makeLargeDocument(1);
    localStorage.setItem('campplanner.recovery.autre', JSON.stringify({ writtenAt: 1, document: doc }));
    expect(readRecovery('autre')).toBeNull();
  });
});
