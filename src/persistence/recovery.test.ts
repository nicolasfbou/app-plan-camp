import { beforeEach, describe, expect, it } from 'vitest';
import { makeLargeDocument } from '@/test/fixtures.ts';
import { clearRecovery, readRecovery, writeRecovery } from './recovery.ts';

beforeEach(() => localStorage.clear());

describe('journal de récupération', () => {
  it('écrit puis relit exactement le document', () => {
    const doc = makeLargeDocument(50);
    writeRecovery(doc);
    expect(readRecovery(doc.plan.id)).toEqual(doc);
    clearRecovery(doc.plan.id);
    expect(readRecovery(doc.plan.id)).toBeNull();
  });

  it('ignore et efface un journal corrompu', () => {
    localStorage.setItem('campplanner.recovery.abc', '{pas du json');
    expect(readRecovery('abc')).toBeNull();
    expect(localStorage.getItem('campplanner.recovery.abc')).toBeNull();
  });

  it('ignore un journal appartenant à un autre plan', () => {
    const doc = makeLargeDocument(1);
    localStorage.setItem('campplanner.recovery.autre', JSON.stringify(doc));
    expect(readRecovery('autre')).toBeNull();
  });
});
