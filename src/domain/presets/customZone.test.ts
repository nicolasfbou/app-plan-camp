/**
 * Zones personnalisées nommées (ex. « Héliport ») : le nom saisi est celui de la zone, il est
 * affiché dans la zone, et chaque nom a sa propre entrée de légende.
 */
import { describe, expect, it } from 'vitest';
import { createPlanDocument } from '@/domain/model/factories.ts';
import { createAreaObject } from '@/domain/model/objectFactory.ts';
import { addObject } from '@/domain/model/operations.ts';
import { legendEntries } from '@/domain/print/legend.ts';

const rect = { kind: 'rect' as const, x: 10, y: 10, width: 100, height: 80, cornerRadius: 0 };

describe('zone personnalisée nommée', () => {
  it('porte le nom saisi, affiché dans la zone ; sans nom : forme simple sans étiquette', () => {
    const doc = createPlanDocument({ siteId: 'site1', name: 'Plan' });
    const heli = createAreaObject(doc, rect, 'zone.custom', 1, '  Héliport ');
    expect(heli.name).toBe('Héliport');
    expect(heli.type === 'zone' && heli.showName).toBe(true);
    // Sans nom (forme simple, modèle par défaut) : aucune étiquette ajoutée.
    const plain = createAreaObject(doc, rect, 'zone.custom', 1, '');
    expect(plain.name).toBe('Zone personnalisée');
    expect(plain.type === 'zone' && plain.showName).toBe(false);
    // Le nom saisi ne s'applique qu'aux zones personnalisées.
    expect(createAreaObject(doc, rect, 'zone.parking', 1, 'Héliport').name).toBe('Stationnement employés');
  });

  it('légende : une entrée par nom (Héliport, Zone de rassemblement), regroupées par nom', () => {
    const doc = createPlanDocument({ siteId: 'site1', name: 'Plan' });
    for (const name of ['Héliport', 'Héliport', 'Zone de rassemblement'])
      addObject(doc, createAreaObject(doc, rect, 'zone.custom', 1, name));
    const entries = legendEntries(doc).map((e) => [e.defaultLabel, e.count]);
    expect(entries).toEqual(
      expect.arrayContaining([
        ['Héliport', 2],
        ['Zone de rassemblement', 1],
      ]),
    );
    expect(entries.some(([label]) => label === 'Zone personnalisée')).toBe(false);
  });
});
