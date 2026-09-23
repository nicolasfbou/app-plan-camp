import { readFileSync, writeFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import {
  asciiTempPath,
  clickOnCanvas,
  dragOnCanvas,
  openPlanWithPhoto,
  planNodes,
  settledTransform,
  sha256OfBuffer,
  storedObjects,
  waitForBackground,
  waitSaved,
} from './helpers.ts';

type Pt = { x: number; y: number };
type Obj = Record<string, unknown> & {
  id: string;
  type: string;
  geometry: { kind: string; points?: Pt[]; x?: number; y?: number };
};

/** Document complet enregistré (objets, calques, pictogrammes importés, croisements). */
const storedDocument = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const r = open.result.transaction('plans').objectStore('plans').getAll();
          r.onsuccess = () => {
            resolve((r.result[0] as { document: Record<string, unknown> }).document);
            open.result.close();
          };
        };
      }),
  );

/** Objets enregistrés d'un type, après la sauvegarde automatique. */
async function objectsOfType(page: Page, type: string) {
  await waitSaved(page);
  return Object.values(await storedObjects(page)).filter((o) => o.type === type) as Obj[];
}

/** Position image d'un point écran du canevas (même conversion que l'application). */
async function toImage(page: Page, at: [number, number]): Promise<Pt> {
  const t = await settledTransform(page);
  return { x: (at[0] - t.x) / t.scale, y: (at[1] - t.y) / t.scale };
}

async function drawPath(page: Page, key: string, points: [number, number][]) {
  await page.keyboard.press(key);
  for (const p of points) await clickOnCanvas(page, p);
  await page.keyboard.press('Enter');
}

const FLOW: [number, number][] = [
  [300, 150],
  [420, 150],
  [420, 420],
];
const CORRIDOR: [number, number][] = [
  [250, 60],
  [250, 300],
  [650, 300],
];

test.beforeEach(async ({ page }) => {
  await openPlanWithPhoto(page);
});

test.describe('circulation des véhicules', () => {
  test('trajet : les points suivent exactement les clics ; catégorie ; sens inverse ; double sens ; flèches masquées ; annuler', async ({
    page,
  }) => {
    await page.keyboard.press('f');
    await page.locator('[data-flow-category="heavy"]').click();
    const expected = await Promise.all(FLOW.map((p) => toImage(page, p)));
    for (const p of FLOW) await clickOnCanvas(page, p);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('object-type')).toHaveText('Trajet de véhicules');
    await waitSaved(page);
    const [flow] = await objectsOfType(page, 'flow');
    expect(flow).toMatchObject({
      category: 'heavy',
      name: 'Véhicules lourds',
      arrows: { direction: 'forward', visible: true },
    });
    flow!.geometry.points!.forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i]!.x, 6);
      expect(p.y).toBeCloseTo(expected[i]!.y, 6);
    });

    await page.getByRole('button', { name: 'Inverser le sens' }).click();
    await page.getByLabel('Sens de circulation').selectOption('both');
    await page.getByLabel('Afficher les flèches').uncheck();
    await waitSaved(page);
    expect((await objectsOfType(page, 'flow'))[0]).toMatchObject({
      arrows: { direction: 'both', visible: false },
    });
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    await waitSaved(page);
    expect((await objectsOfType(page, 'flow'))[0]).toMatchObject({
      arrows: { direction: 'forward', visible: true },
    });
    await page.keyboard.press('Control+y');
    await waitSaved(page);
    expect((await objectsOfType(page, 'flow'))[0]).toMatchObject({ arrows: { direction: 'backward' } });
  });

  test('sommets du trajet : insérer, déplacer, supprimer ; annuler / rétablir ; sauvegarde et réouverture', async ({
    page,
  }) => {
    await drawPath(page, 'f', FLOW);
    await page.getByRole('button', { name: 'Modifier les points' }).click();
    // Glisser le « + » du premier segment : un sommet de plus, là où on relâche.
    const t = await settledTransform(page);
    const mid = await page.evaluate(() => {
      const n = (
        window as unknown as { Konva: { stages: { find(s: string): { getAbsolutePosition(): Pt }[] }[] } }
      ).Konva.stages[0]!.find('.midpoint-handle')[0]!;
      return n.getAbsolutePosition();
    });
    await dragOnCanvas(page, [mid.x, mid.y], [mid.x, mid.y + 60]);
    let [flow] = await objectsOfType(page, 'flow');
    expect(flow!.geometry.points).toHaveLength(4);
    expect(flow!.geometry.points![1]!.y).toBeCloseTo((mid.y + 60 - t.y) / t.scale, 0);
    // Déplacer le dernier sommet.
    await dragOnCanvas(page, FLOW[2]!, [460, 440]);
    [flow] = await objectsOfType(page, 'flow');
    expect(flow!.geometry.points![3]!.x).toBeCloseTo((460 - t.x) / t.scale, 0);
    // Supprimer le sommet ajouté.
    await clickOnCanvas(page, [mid.x, mid.y + 60]);
    await page.keyboard.press('Delete');
    [flow] = await objectsOfType(page, 'flow');
    expect(flow!.geometry.points).toHaveLength(3);
    await page.keyboard.press('Control+z');
    expect((await objectsOfType(page, 'flow'))[0]!.geometry.points).toHaveLength(4);
    await page.keyboard.press('Control+y');
    await waitSaved(page);
    const before = await objectsOfType(page, 'flow');
    await page.reload();
    await waitForBackground(page);
    expect(await objectsOfType(page, 'flow')).toEqual(before);
    expect(before[0]!.geometry.points).toHaveLength(3);
  });

  test('voie d’urgence : tracée comme un trajet, dans le calque Sécurité et accès', async ({ page }) => {
    await page.getByRole('button', { name: 'Voie d’urgence (trajet)' }).click();
    for (const p of FLOW) await clickOnCanvas(page, p);
    await page.keyboard.press('Enter');
    await waitSaved(page);
    const doc = await storedDocument(page);
    const [flow] = await objectsOfType(page, 'flow');
    const layer = (doc.layers as { id: string; tier: string }[]).find((l) => l.id === flow!.layerId);
    expect(flow).toMatchObject({ category: 'emergency' });
    expect(layer?.tier).toBe('safety');
  });
});

test.describe('corridors piétons', () => {
  test('créer ; largeur ; pictogrammes orientés ; déplacer un sommet sans redessiner ; verrouillage', async ({
    page,
  }) => {
    await drawPath(page, 'c', CORRIDOR);
    await expect(page.getByTestId('object-type')).toHaveText('Corridor piéton');
    await page.getByLabel('Largeur (px image)').fill('24');
    await page.getByLabel('Largeur (px image)').press('Enter');
    await page.getByLabel('Orientés dans le sens du déplacement').check();
    await waitSaved(page);
    let [corridor] = await objectsOfType(page, 'corridor');
    expect(corridor).toMatchObject({ width: 24, iconsOriented: true, showIcons: true });
    // Double clic : mode sommets ; le coin est déplacé, le corridor suit.
    await page.mouse.dblclick(...(await canvasPoint(page, [450, 300])));
    await dragOnCanvas(page, CORRIDOR[1]!, [300, 330]);
    [corridor] = await objectsOfType(page, 'corridor');
    const t = await settledTransform(page);
    expect(corridor!.geometry.points![1]!.x).toBeCloseTo((300 - t.x) / t.scale, 0);
    expect(corridor!.geometry.points).toHaveLength(3);
    // Verrouillé : ni glisser, ni suppression.
    await page.keyboard.press('Escape');
    await page.getByLabel('Verrouillé').check();
    const before = await planNodes(page);
    await dragOnCanvas(page, [450, 330], [500, 380]);
    await page.keyboard.press('Delete');
    expect(await planNodes(page)).toEqual(before);
  });
});

async function canvasPoint(page: Page, at: [number, number]): Promise<[number, number]> {
  const box = (await page.getByTestId('canvas-container').boundingBox())!;
  return [box.x + at[0], box.y + at[1]];
}

test.describe('stationnement, livraison, sécurité', () => {
  test('zones spécialisées : modèle, calque, pictogramme et nom ; bordure de délimitation', async ({
    page,
  }) => {
    await page.locator('[data-preset="zone.parking-visitors"]').click();
    await dragOnCanvas(page, [100, 100], [260, 200]);
    await page.locator('[data-preset="zone.truck-maneuver"]').click();
    await dragOnCanvas(page, [300, 100], [460, 200]);
    await page.keyboard.press('p');
    await page.locator('[data-preset="zone.danger"]').click();
    for (const p of [
      [500, 250],
      [640, 260],
      [600, 380],
    ] as [number, number][])
      await clickOnCanvas(page, p);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Rouge', exact: true }).click();
    await waitSaved(page);
    const doc = await storedDocument(page);
    const tierOf = (id: string) =>
      (doc.layers as { id: string; tier: string }[]).find((l) => l.id === id)?.tier;
    const zones = await objectsOfType(page, 'zone');
    const byPreset = Object.fromEntries(zones.map((z) => [z.presetId as string, z]));
    expect(byPreset['zone.parking-visitors']).toMatchObject({
      showName: true,
      icon: { symbolId: 'sign.parking' },
    });
    expect(tierOf(byPreset['zone.parking-visitors']!.layerId as string)).toBe('parking');
    expect(tierOf(byPreset['zone.truck-maneuver']!.layerId as string)).toBe('deliveries');
    expect(byPreset['zone.danger']).toMatchObject({
      geometry: { kind: 'polygon' },
      style: { stroke: '#dc2626', dash: 'solid' },
    });
    expect(tierOf(byPreset['zone.danger']!.layerId as string)).toBe('safety');
    // Pictogramme retiré puis nom masqué : la zone reste modifiable.
    await page.getByLabel('Pictogramme de la zone').selectOption({ label: 'Aucun' });
    await page.getByLabel('Afficher le nom dans la zone').uncheck();
    await waitSaved(page);
    expect((await objectsOfType(page, 'zone')).find((z) => z.presetId === 'zone.danger')).toMatchObject({
      icon: null,
      showName: false,
    });
  });
});

test.describe('pictogrammes', () => {
  test('placer, redimensionner, tourner, déplacer, dupliquer, supprimer', async ({ page }) => {
    await page.keyboard.press('s');
    await page.getByRole('radio', { name: 'Limite de vitesse' }).click();
    await clickOnCanvas(page, [300, 250]);
    await expect(page.getByTestId('object-type')).toHaveText('Pictogramme');
    await page.getByLabel('Texte affiché').fill('30');
    await page.getByLabel('Taille (px image)').fill('40');
    await page.getByLabel('Taille (px image)').press('Enter');
    await page.getByLabel('Rotation').fill('45');
    await page.getByLabel('Rotation').press('Enter');
    await waitSaved(page);
    const [icon] = await objectsOfType(page, 'icon');
    const at = await toImage(page, [300, 250]);
    expect(icon).toMatchObject({ symbolId: 'sign.speed-limit', text: '30', size: 40, rotation: 45 });
    expect(icon!.geometry.x).toBeCloseTo(at.x, 6);
    await dragOnCanvas(page, [300, 250], [360, 270]);
    await page.keyboard.press('Control+d');
    await expect.poll(async () => (await objectsOfType(page, 'icon')).length).toBe(2);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await objectsOfType(page, 'icon')).length).toBe(1);
    const moved = (await objectsOfType(page, 'icon'))[0]!;
    const t = await settledTransform(page);
    expect(moved.geometry.x).toBeCloseTo(at.x + 60 / t.scale, 0);
  });

  test('pictogramme importé (SVG vérifié) : placé et conservé ; SVG dangereux refusé', async ({ page }) => {
    await page.keyboard.press('s');
    const bad = asciiTempPath('danger.svg');
    writeFileSync(bad, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await page.getByTestId('symbol-input').setInputFiles(bad);
    await expect(page.getByTestId('notice')).toContainText('refusé');
    const good = asciiTempPath('borne.svg');
    writeFileSync(
      good,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a0"/></svg>',
    );
    await page.getByTestId('symbol-input').setInputFiles(good);
    await expect(page.getByTestId('notice')).toContainText('importé');
    await clickOnCanvas(page, [400, 250]);
    await waitSaved(page);
    const doc = await storedDocument(page);
    const assets = Object.values(doc.assets as Record<string, { id: string; sha256: string; name: string }>);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ name: 'borne', sha256: sha256OfBuffer(readFileSync(good)) });
    expect((await objectsOfType(page, 'icon'))[0]).toMatchObject({
      symbolId: `asset:${assets[0]!.id}`,
      name: 'borne',
    });
    await page.reload();
    await waitForBackground(page);
    await expect.poll(async () => (await planNodes(page)).length).toBe(1);
    // L'image importée est bien dessinée (pas l'emplacement de remplacement).
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { Konva: { stages: { find(s: string): unknown[] }[] } }
            ).Konva.stages[0]!.find('Image').length,
        ),
      )
      .toBeGreaterThan(0);
  });
});

test.describe('séparation piétons / véhicules', () => {
  test('croisement détecté ; point de vigilance, note, masquage ; conservé après réouverture', async ({
    page,
  }) => {
    await drawPath(page, 'f', FLOW);
    await drawPath(page, 'c', CORRIDOR);
    await page.getByRole('tab', { name: 'Analyse' }).click();
    await expect(page.getByTestId('analysis-disclaimer')).toContainText('pas une certification de sécurité');
    await expect(page.getByTestId('crossing-count')).toContainText('1 croisement');
    await page.getByLabel('Afficher les croisements sur le plan').check();
    // Le marqueur est au croisement des deux tracés : (420, 300) à l'écran.
    const marker = await page.evaluate(() => {
      const n = (
        window as unknown as { Konva: { stages: { find(s: string): { getAbsolutePosition(): Pt }[] }[] } }
      ).Konva.stages[0]!.find('.crossing-marker')[0]!;
      return n.getAbsolutePosition();
    });
    expect(marker.x).toBeCloseTo(420, 0);
    expect(marker.y).toBeCloseTo(300, 0);
    await clickOnCanvas(page, [marker.x, marker.y]);
    await expect(page.getByTestId('crossing-details')).toContainText('À examiner');
    await page.getByRole('button', { name: 'Point de vigilance' }).click();
    await page.getByLabel('Note').fill('Prévoir un passage balisé');
    await expect(page.getByTestId('crossing-details')).toContainText('Point de vigilance');
    await page.getByRole('button', { name: 'Vérifié : masquer' }).click();
    await expect(page.getByTestId('crossing-count')).toContainText('1 vérifié(s), masqué(s)');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { Konva: { stages: { find(s: string): unknown[] }[] } }
            ).Konva.stages[0]!.find('.crossing-marker').length,
        ),
      )
      .toBe(0);
    await waitSaved(page);
    await page.reload();
    await waitForBackground(page);
    const reviews = (await storedDocument(page)).crossingReviews as { status: string; note: string }[];
    expect(reviews).toEqual([
      expect.objectContaining({ status: 'verified', note: 'Prévoir un passage balisé' }),
    ]);
  });
});

test.describe('calques et catégories', () => {
  test('afficher seulement la circulation, puis plusieurs catégories', async ({ page }) => {
    await drawPath(page, 'f', FLOW);
    await drawPath(page, 'c', CORRIDOR);
    await page.locator('[data-preset="zone.parking"]').click();
    await dragOnCanvas(page, [500, 380], [650, 440]);
    await page.getByRole('tab', { name: 'Calques' }).click();
    await waitSaved(page);
    const stored = await storedObjects(page);
    const types = async () => {
      return (await planNodes(page)).map((n) => stored[n.id]!.type).sort();
    };
    expect(await types()).toEqual(['corridor', 'flow', 'zone']);
    await page.getByRole('button', { name: 'Afficher seulement la catégorie Circulation véhicules' }).click();
    await expect.poll(types).toEqual(['flow']);
    await page.getByTestId('category-filter').getByLabel('Corridors piétons', { exact: true }).check();
    await expect.poll(types).toEqual(['corridor', 'flow']);
    await page.getByRole('button', { name: 'Tout afficher' }).click();
    await expect.poll(types).toEqual(['corridor', 'flow', 'zone']);
  });
});

test('stabilité des coordonnées : trajets, corridors et pictogrammes restent au même pixel de la photo à tous les zooms', async ({
  page,
}) => {
  await drawPath(page, 'f', FLOW);
  await drawPath(page, 'c', CORRIDOR);
  await page.keyboard.press('s');
  await page.getByRole('radio', { name: 'Arrêt obligatoire' }).click();
  await clickOnCanvas(page, [560, 150]);
  await waitSaved(page);
  const stored = await storedObjects(page);
  const check = async () => {
    const t = await settledTransform(page);
    const anchors = await page.evaluate(
      (docs) => {
        const K = (
          window as unknown as {
            Konva: { stages: { findOne(s: string): { getAbsoluteTransform(): { point(p: Pt): Pt } } }[] };
          }
        ).Konva;
        return docs.map(({ id, p }) => K.stages[0]!.findOne(`#${id}`).getAbsoluteTransform().point(p));
      },
      Object.values(stored).map((o) => {
        const g = (o as Obj).geometry;
        return { id: o.id as string, p: g.points ? g.points[0]! : { x: 0, y: 0 } };
      }),
    );
    Object.values(stored).forEach((o, i) => {
      const g = (o as Obj).geometry;
      const p = g.points ? g.points[0]! : { x: g.x!, y: g.y! };
      expect(anchors[i]!.x).toBeCloseTo(p.x * t.scale + t.x, 1);
      expect(anchors[i]!.y).toBeCloseTo(p.y * t.scale + t.y, 1);
    });
    expect(await storedObjects(page)).toEqual(stored);
  };
  await page.keyboard.press('1');
  await check();
  for (const key of ['+', '+', '+', '+', '+', '+']) await page.keyboard.press(key);
  await check();
  await page.keyboard.press('1');
  for (const key of ['-', '-', '-', '-', '-', '-', '-', '-', '-']) await page.keyboard.press(key);
  await check();
});

test('.campplan : trajets, corridor, zones, pictogrammes (dont importé), croisement et étiquette réimportés à l’identique dans un navigateur vide, toujours modifiables', async ({
  page,
  browser,
}) => {
  await drawPath(page, 'f', FLOW);
  await drawPath(page, 'f', [
    [100, 420],
    [640, 420],
  ]);
  await drawPath(page, 'c', CORRIDOR);
  await page.locator('[data-preset="zone.parking"]').click();
  await dragOnCanvas(page, [500, 60], [640, 130]);
  await page.locator('[data-preset="zone.dropoff"]').click();
  await dragOnCanvas(page, [480, 330], [640, 400]);
  await page.locator('[data-preset="zone.no-access"]').click();
  await dragOnCanvas(page, [60, 200], [180, 280]);
  await page.keyboard.press('s');
  await page.getByRole('radio', { name: 'Extincteur' }).click();
  await clickOnCanvas(page, [200, 330]);
  await page.keyboard.press('s');
  const svg = asciiTempPath('perso.svg');
  writeFileSync(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#7c3aed"/></svg>',
  );
  await page.getByTestId('symbol-input').setInputFiles(svg);
  await clickOnCanvas(page, [120, 60]);
  await page.keyboard.press('g');
  await clickOnCanvas(page, [560, 200]);
  await page.getByTestId('text-editor').fill('STATIONNEMENT (test)');
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Analyse' }).click();
  await page.getByTestId('crossing-item').first().click();
  await page.getByRole('button', { name: 'Point de vigilance' }).click();
  await waitSaved(page);
  const before = await storedDocument(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
  ]);
  const file = asciiTempPath('phase4.campplan');
  await download.saveAs(file);
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto('/');
  await fresh.getByTestId('campplan-input').setInputFiles(file);
  await expect(fresh.getByTestId('import-verified')).toBeVisible();
  await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
  await waitForBackground(fresh);
  const after = await storedDocument(fresh);
  expect(after.objects).toEqual(before.objects);
  expect(after.layers).toEqual(before.layers);
  expect(after.crossingReviews).toEqual(before.crossingReviews);
  const assets = (d: Record<string, unknown>) =>
    Object.values(d.assets as Record<string, { sha256: string; name: string; blobId: string }>).map(
      ({ sha256, name }) => ({ sha256, name }),
    );
  expect(assets(after)).toEqual(assets(before));
  expect(Object.keys(before.objects as object)).toHaveLength(9);
  // Toujours modifiable : le trajet est sélectionné, puis déplacé depuis le panneau des propriétés.
  await fresh.getByRole('tab', { name: 'Calques' }).click();
  const flow = Object.values(before.objects as Record<string, Obj>).find((o) => o.type === 'flow')!;
  await fresh
    .getByRole('button', { name: flow.name as string, exact: true })
    .first()
    .click();
  await fresh.getByRole('tab', { name: 'Propriétés' }).click();
  await fresh.getByLabel('X', { exact: true }).fill('5');
  await fresh.getByLabel('X', { exact: true }).press('Enter');
  await waitSaved(fresh);
  const edited = Object.values((await storedDocument(fresh)).objects as Record<string, Obj>).filter(
    (o) => o.type === 'flow',
  );
  expect(edited.some((o) => Math.min(...o.geometry.points!.map((p) => p.x)) === 5)).toBe(true);
  await context.close();
});

test('un plan de la phase 3 (format 2) s’ouvre : nouveaux calques ajoutés, objets intacts et modifiables', async ({
  page,
}) => {
  await drawPath(page, 'f', FLOW);
  await page.keyboard.press('r');
  await dragOnCanvas(page, [500, 60], [640, 130]);
  await waitSaved(page);
  const before = await storedObjects(page);
  // Réécrit l'enregistrement exactement au format 2 : 6 calques, anciens champs, sans les nouveautés.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const tx = open.result.transaction('plans', 'readwrite');
          const store = tx.objectStore('plans');
          const req = store.getAll();
          req.onsuccess = () => {
            type Raw = Record<string, unknown> & { type?: string; arrows?: Record<string, unknown> };
            const record = req.result[0] as {
              document: {
                schemaVersion: number;
                layers: { tier: string }[];
                plan: Record<string, unknown>;
                objects: Record<string, Raw>;
                assets?: unknown;
                crossingReviews?: unknown;
              };
            };
            const d = record.document;
            d.schemaVersion = 2;
            d.layers = d.layers.filter((l) => !['parking', 'deliveries', 'safety'].includes(l.tier));
            delete d.assets;
            delete d.crossingReviews;
            delete d.plan.display;
            for (const o of Object.values(d.objects)) {
              if (o.type === 'zone') {
                delete o.icon;
                delete o.showName;
              }
              if (o.type === 'flow') {
                delete o.category;
                delete o.arrows!.visible;
              }
            }
            store.put(record);
          };
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
  );
  await page.reload();
  await waitForBackground(page);
  expect(await planNodes(page)).toHaveLength(2);
  await page.getByRole('tab', { name: 'Calques' }).click();
  await expect(page.getByTestId('layer-row')).toHaveCount(9);
  await clickOnCanvas(page, [570, 95]);
  await page.keyboard.press('ArrowRight');
  await waitSaved(page);
  const after = await storedObjects(page);
  for (const [id, o] of Object.entries(before)) {
    if (o.type === 'flow')
      expect(after[id]).toMatchObject({
        geometry: o.geometry,
        category: 'general',
        arrows: { visible: true },
      });
    else expect(after[id]).toMatchObject({ icon: null, showName: false });
  }
});
