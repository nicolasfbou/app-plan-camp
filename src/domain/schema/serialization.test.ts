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
    expect(SCHEMA_VERSION).toBe(5);
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

describe('migration réelle 1 → 3 (regroupement)', () => {
  it('un plan enregistré au format 1 s’ouvre au format actuel, chaque objet reçoit groupId: null', () => {
    const v2 = makeLargeDocument(12);
    // Reconstitue exactement un document de la phase 2 : format 1, sans groupId.
    const v1 = JSON.parse(JSON.stringify(v2)) as Record<string, unknown> & {
      objects: Record<string, Record<string, unknown>>;
    };
    v1.schemaVersion = 1;
    for (const object of Object.values(v1.objects)) delete object.groupId;
    const migrated = parsePlanDocument(JSON.stringify(v1));
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Object.values(migrated.objects).every((o) => o.groupId === null)).toBe(true);
    expect(migrated).toEqual(v2);
  });
});

describe('migration réelle 2 → 3 (circulation et zones opérationnelles)', () => {
  /** Document exactement au format 2 (phase 3) : 6 calques, anciens champs des corridors, etc. */
  function phase3Document(): Record<string, unknown> {
    const layer = (id: string, name: string, tier: string) => ({
      id,
      name,
      tier,
      visible: true,
      locked: false,
      opacity: 1,
    });
    const base = {
      presetId: null,
      style: {
        fill: '#2563eb',
        fillOpacity: 0.3,
        stroke: '#2563eb',
        strokeOpacity: 1,
        strokeWidth: 3,
        dash: 'solid',
        pattern: 'none',
      },
      rotation: 0,
      visible: true,
      locked: false,
      zIndex: 0,
      groupId: null,
      metadata: {},
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    };
    const line = {
      kind: 'polyline',
      curved: false,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
    };
    return {
      schemaVersion: 2,
      plan: {
        id: 'plan1',
        siteId: 'site1',
        name: 'Plan',
        kind: 'general',
        baseImage: null,
        calibration: null,
        northAngleDeg: 0,
        metadata: {},
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
      },
      layers: [
        layer('L1', 'Zones', 'zones'),
        layer('L2', 'Bâtiments', 'buildings'),
        layer('L3', 'Circulation véhicules', 'circulation'),
        layer('L4', 'Piétons', 'pedestrians'),
        layer('L5', 'Signalisation', 'signage'),
        layer('L6', 'Textes', 'texts'),
      ],
      objects: {
        z: {
          ...base,
          id: 'z',
          name: 'Zone',
          layerId: 'L1',
          type: 'zone',
          geometry: { kind: 'rect', x: 1, y: 2, width: 3, height: 4, cornerRadius: 0 },
        },
        f: {
          ...base,
          id: 'f',
          name: 'Flux',
          layerId: 'L3',
          type: 'flow',
          geometry: line,
          arrows: { direction: 'both', size: 10, spacing: 50 },
        },
        c: {
          ...base,
          id: 'c',
          name: 'Corridor',
          layerId: 'L4',
          type: 'corridor',
          geometry: line,
          width: 20,
          fillMode: 'hatched',
          pedestrianIconSpacing: null,
        },
        i: {
          ...base,
          id: 'i',
          name: 'Icône',
          layerId: 'L5',
          type: 'icon',
          geometry: { kind: 'point', x: 5, y: 5 },
          symbolId: 'sign.stop',
          size: 30,
        },
      },
    };
  }

  it('ajoute les calques Stationnement, Livraison et Sécurité au-dessus des zones ; géométries inchangées', () => {
    const v2 = phase3Document();
    const doc = parsePlanDocument(JSON.stringify(v2));
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.layers.map((l) => l.tier)).toEqual([
      'zones',
      'parking',
      'deliveries',
      'safety',
      'buildings',
      'circulation',
      'pedestrians',
      'signage',
      'texts',
    ]);
    expect(doc.layers[0]!.id).toBe('L1');
    const objects = v2.objects as Record<string, { geometry: unknown }>;
    for (const id of ['z', 'f', 'c', 'i']) expect(doc.objects[id]!.geometry).toEqual(objects[id]!.geometry);
    expect(doc.objects.z).toMatchObject({ icon: null, showName: false });
    expect(doc.objects.f).toMatchObject({
      category: 'general',
      arrows: { direction: 'both', visible: true, size: 10, spacing: 50 },
    });
    expect(doc.objects.c).toMatchObject({ width: 20, showIcons: false });
    expect(doc.objects.c).not.toHaveProperty('fillMode');
    expect(doc.objects.i).toMatchObject({ text: null });
    expect(doc).toMatchObject({
      assets: {},
      crossingReviews: [],
      plan: { display: { symbolMinPx: 12, symbolMaxPx: 44 } },
    });
    // Réenregistré puis relu : identique (la migration n'est appliquée qu'une fois).
    expect(parsePlanDocument(serializePlanDocument(doc))).toEqual(doc);
  });
});
