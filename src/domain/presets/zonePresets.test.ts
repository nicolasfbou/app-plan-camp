import { describe, expect, it } from 'vitest';
import { styleSchema } from '../model/schema.ts';
import { ZONE_PRESETS, findZonePreset } from './zonePresets.ts';

describe('zones prédéfinies', () => {
  it('ont des identifiants uniques et des styles valides', () => {
    const ids = ZONE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of ZONE_PRESETS) expect(styleSchema.safeParse(preset.style).success).toBe(true);
  });

  it('couvrent les zones de camp demandées', () => {
    const names = ZONE_PRESETS.map((p) => p.name.fr);
    for (const expected of [
      'Stationnement',
      'Zone piétonne',
      'Déchets',
      'Propane',
      'Site pour carottes',
      'Zone personnalisée',
    ]) {
      expect(names).toContain(expected);
    }
    expect(findZonePreset('zone.propane')?.name.fr).toBe('Propane');
  });
});
