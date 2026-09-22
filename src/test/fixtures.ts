import { createPlanDocument, createSite, newId } from '@/domain/model/factories.ts';
import type { PlanDocument, PlanObject, Style } from '@/domain/model/types.ts';

export const FIXED_DATE = '2026-01-15T12:00:00.000Z';

export const TEST_STYLE: Style = {
  fill: '#2563eb',
  fillOpacity: 0.3,
  stroke: '#1d4ed8',
  strokeOpacity: 1,
  strokeWidth: 3,
  dash: 'dashed',
  pattern: 'none',
};

export function makeDocument(): PlanDocument {
  return createPlanDocument({ siteId: createSite('Camp 105').id, name: 'Plan général' });
}

export function makeZone(layerId: string, x = 100, y = 200, overrides: Partial<PlanObject> = {}): PlanObject {
  return {
    id: newId(),
    type: 'zone',
    name: 'Stationnement',
    layerId,
    presetId: 'zone.parking',
    style: TEST_STYLE,
    rotation: 0,
    visible: true,
    locked: false,
    zIndex: 0,
    metadata: {},
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    geometry: { kind: 'rect', x, y, width: 300, height: 150, cornerRadius: 0 },
    ...overrides,
  } as PlanObject;
}

/** Document contenant un mélange réaliste d'objets de chaque type. */
export function makeLargeDocument(count: number): PlanDocument {
  const doc = makeDocument();
  const layerId = (tier: string) => doc.layers.find((l) => l.tier === tier)!.id;
  const base = {
    presetId: null,
    style: TEST_STYLE,
    rotation: 0,
    visible: true,
    locked: false,
    metadata: {},
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
  for (let i = 0; i < count; i++) {
    const x = (i % 40) * 150;
    const y = Math.floor(i / 40) * 150;
    const id = newId();
    const line = {
      kind: 'polyline' as const,
      curved: false,
      points: [
        { x, y },
        { x: x + 80, y: y + 40 },
        { x: x + 120, y },
      ],
    };
    const objects: PlanObject[] = [
      makeZone(layerId('zones'), x, y, { id, zIndex: i }),
      {
        ...base,
        id,
        zIndex: i,
        type: 'flow',
        name: `Flux ${i}`,
        layerId: layerId('circulation'),
        geometry: line,
        arrows: { direction: 'forward', size: 18, spacing: 90 },
      },
      {
        ...base,
        id,
        zIndex: i,
        type: 'corridor',
        name: `Corridor ${i}`,
        layerId: layerId('pedestrians'),
        geometry: line,
        width: 24,
        fillMode: 'hatched',
        pedestrianIconSpacing: 120,
      },
      {
        ...base,
        id,
        zIndex: i,
        type: 'text',
        name: `Texte ${i}`,
        layerId: layerId('texts'),
        geometry: { kind: 'point', x, y },
        text: `DORTOIR ${i}`,
        fontFamily: 'Inter',
        fontSize: 28,
        fontWeight: 'bold',
        italic: false,
        align: 'center',
        label: {
          background: '#ffffff',
          backgroundOpacity: 0.9,
          border: '#0f172a',
          borderWidth: 2,
          padding: 6,
          cornerRadius: 4,
        },
      },
    ];
    doc.objects[id] = objects[i % objects.length]!;
  }
  return doc;
}

/** Comparaison octet par octet (rapide, sans passer par un diff de tableau géant). */
export function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
