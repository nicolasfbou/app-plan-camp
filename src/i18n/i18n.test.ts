import { describe, expect, it } from 'vitest';
import { fr } from './fr.ts';
import { t } from './index.ts';

describe('i18n', () => {
  it('traduit une clé en français', () => {
    expect(t('save.saved')).toBe('Enregistré');
  });

  it('n’a aucune traduction vide', () => {
    for (const value of Object.values(fr)) expect(value.trim()).not.toBe('');
  });
});
