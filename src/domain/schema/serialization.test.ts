import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../model/schema.ts';
import { makeDocument, makeLargeDocument, makeZone } from '@/test/fixtures.ts';
import { ProjectFormatError, migrateDocument } from './migrations.ts';
import { parsePlanDocument, serializePlanDocument } from './serialization.ts';

describe('sérialisation du projet', () => {
  it('aller-retour sans perte sur un document contenant tous les types d’objets', () => {
    const doc = makeLargeDocument(40);
    const restored = parsePlanDocument(serializePlanDocument(doc));
    expect(restored).toEqual(doc);
  });

  it('écrit la version du format', () => {
    const json = JSON.parse(serializePlanDocument(makeDocument()));
    expect(json.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('n’enregistre aucune donnée de viewport dans le document', () => {
    const json = serializePlanDocument(makeLargeDocument(10));
    expect(json).not.toMatch(/"(viewport|scale|zoom|pan)"/);
  });

  it('rejette un JSON illisible', () => {
    expect(() => parsePlanDocument('{pas du json')).toThrow(ProjectFormatError);
  });

  it('rejette un objet qui référence un calque inexistant', () => {
    const doc = makeDocument();
    const zone = makeZone('calque-fantome');
    doc.objects[zone.id] = zone;
    expect(() => parsePlanDocument(serializePlanDocument(doc))).toThrow(/calque inexistant/);
  });

  it('rejette une géométrie invalide avec un message localisé', () => {
    const doc = makeDocument();
    const zone = makeZone(doc.layers[0]!.id);
    doc.objects[zone.id] = { ...zone, geometry: { kind: 'polygon', points: [{ x: 0, y: 0 }] } } as never;
    expect(() => parsePlanDocument(serializePlanDocument(doc))).toThrow(ProjectFormatError);
  });

  it('rejette un identifiant d’objet incohérent avec sa clé', () => {
    const doc = makeDocument();
    const zone = makeZone(doc.layers[0]!.id);
    doc.objects['autre-cle'] = zone;
    expect(() => parsePlanDocument(serializePlanDocument(doc))).toThrow(/incohérent/);
  });
});

describe('migration du schemaVersion', () => {
  it('accepte un document déjà à la version courante', () => {
    const doc = makeDocument();
    expect(migrateDocument(structuredClone(doc))).toEqual(doc);
  });

  it('refuse un document sans version', () => {
    const { schemaVersion: _removed, ...rest } = makeDocument();
    expect(() => parsePlanDocument(rest)).toThrow(/Version du format/);
  });

  it('refuse un document venant d’une version plus récente du logiciel', () => {
    expect(() => parsePlanDocument({ ...makeDocument(), schemaVersion: SCHEMA_VERSION + 1 })).toThrow(
      /version plus récente/,
    );
  });

  it('enchaîne les migrations dans l’ordre jusqu’à la version cible', () => {
    const calls: number[] = [];
    const migrations = {
      1: (d: Record<string, unknown>) => (calls.push(1), { ...d, renamed: d.old, old: undefined }),
      2: (d: Record<string, unknown>) => (calls.push(2), { ...d, added: true }),
    };
    const result = migrateDocument({ schemaVersion: 1, old: 'x' }, migrations, 3);
    expect(calls).toEqual([1, 2]);
    expect(result).toMatchObject({ schemaVersion: 3, renamed: 'x', added: true });
  });

  it('signale une migration manquante', () => {
    expect(() => migrateDocument({ schemaVersion: 1 }, {}, 2)).toThrow(
      /Migration manquante du format 1 vers 2/,
    );
  });
});

describe('migration réelle 1 → 2 (regroupement)', () => {
  it('un plan enregistré au format 1 s’ouvre en format 2, chaque objet reçoit groupId: null', () => {
    const v2 = makeLargeDocument(12);
    // Reconstitue exactement un document de la phase 2 : format 1, sans groupId.
    const v1 = JSON.parse(JSON.stringify(v2)) as Record<string, unknown> & {
      objects: Record<string, Record<string, unknown>>;
    };
    v1.schemaVersion = 1;
    for (const object of Object.values(v1.objects)) delete object.groupId;
    const migrated = parsePlanDocument(JSON.stringify(v1));
    expect(migrated.schemaVersion).toBe(2);
    expect(Object.values(migrated.objects).every((o) => o.groupId === null)).toBe(true);
    expect(migrated).toEqual(v2);
  });
});
