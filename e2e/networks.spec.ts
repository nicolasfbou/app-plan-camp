import { readFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
// @ts-expect-error module JavaScript sans déclarations de types
import { inspectPdf } from '../bench/pdf-inspect.mjs';
import { clickOnCanvas, openPlanWithPhoto, storedObjects, waitSaved } from './helpers.ts';

type Layer = { id: string; name: string; tier: string; visible: boolean; opacity: number };

/** Calques enregistrés du plan (après la sauvegarde automatique). */
async function storedLayers(page: Page): Promise<Layer[]> {
  await waitSaved(page);
  return page.evaluate(
    () =>
      new Promise<Layer[]>((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const r = open.result.transaction('plans').objectStore('plans').getAll();
          r.onsuccess = () => {
            resolve((r.result[0] as { document: { layers: Layer[] } }).document.layers);
            open.result.close();
          };
        };
      }),
  );
}

async function drawNetwork(page: Page, network: string, points: [number, number][]) {
  await page.keyboard.press('n');
  await page.locator(`[data-network="${network}"]`).click();
  for (const p of points) await clickOnCanvas(page, p);
  await page.keyboard.press('Enter');
}

/**
 * Réseaux techniques : chaque réseau (eau potable, électricité, propane…) est tracé dans son propre
 * calque, puis superposé aux autres comme un calque ; équipements, étiquette, légende et PDF.
 */
test('réseaux techniques : un calque par réseau, équipements, superposition, étiquette et PDF', async ({
  page,
  browser,
}) => {
  await openPlanWithPhoto(page);
  // Aucun calque de réseau dans un plan neuf.
  expect((await storedLayers(page)).some((l) => l.tier === 'water')).toBe(false);

  // Eau potable : la ligne et son calque sont créés ensemble.
  await drawNetwork(page, 'water', [
    [300, 200],
    [500, 200],
    [500, 400],
  ]);
  await expect(page.getByTestId('notice')).toContainText('Réseau d’eau potable');
  // Propriétés : diamètre, matériau, étiquette affichée sur le plan.
  await page.getByLabel('Diamètre / calibre').fill('50 mm');
  await page.getByLabel('Matériau').fill('PEHD');
  await page.getByLabel('Étiquette sur le plan').check();
  await expect(page.getByTestId('utility-label')).toContainText('Eau · 50 mm · PEHD');

  // Électricité, projetée : son propre calque, trait tireté.
  await page.keyboard.press('n');
  await page.locator('[data-network-status="proposed"]').click();
  await drawNetwork(page, 'electrical', [
    [300, 450],
    [700, 450],
  ]);

  // Équipement du réseau d'eau : placé dans le calque de l'eau.
  await page.keyboard.press('n');
  await page.locator('[data-network="water"]').click();
  await page.locator('[data-symbol="net.water-valve"]').click();
  await expect(page.getByTestId('network-palette')).toBeVisible();
  await clickOnCanvas(page, [500, 300]);

  const layers = await storedLayers(page);
  const water = layers.find((l) => l.tier === 'water')!;
  const electrical = layers.find((l) => l.tier === 'electrical')!;
  expect(water.name).toBe('Réseau d’eau potable');
  expect(electrical.name).toBe('Réseau électrique');
  const objects = Object.values(await storedObjects(page));
  const lines = objects.filter((o) => o.type === 'utility');
  expect(lines).toHaveLength(2);
  expect(lines.find((o) => o.network === 'water')).toMatchObject({
    layerId: water.id,
    nominalSize: '50 mm',
    material: 'PEHD',
    showLabel: true,
    status: 'existing',
  });
  expect(lines.find((o) => o.network === 'electrical')).toMatchObject({
    layerId: electrical.id,
    status: 'proposed',
    style: expect.objectContaining({ dash: 'dashed' }),
  });
  expect(objects.find((o) => o.type === 'icon')).toMatchObject({
    symbolId: 'net.water-valve',
    layerId: water.id,
  });

  // PDF : les deux réseaux dans la légende, étiquette imprimée.
  await page.getByTestId('open-print').click();
  await expect(page.getByTestId('print-dialog')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('print-export').click(),
  ]);
  const pdf = (await inspectPdf(browser, readFileSync((await download.path())!))) as { text: string };
  for (const text of ['RÉSEAUX TECHNIQUES', 'Eau potable', 'Électricité (projeté)', 'Eau · 50 mm · PEHD'])
    expect(pdf.text).toContain(text);
  await page.keyboard.press('Escape');

  // Superposition (onglet Calques) : seulement l'électricité, puis tous les réseaux, opacité.
  await page.getByRole('tab', { name: 'Calques' }).click();
  const overview = page.getByTestId('networks-overview');
  await expect(overview.locator('[data-network-row]')).toHaveCount(2);
  await overview.getByRole('button', { name: 'Afficher seulement le réseau Électricité' }).click();
  let after = await storedLayers(page);
  expect(after.find((l) => l.tier === 'water')!.visible).toBe(false);
  expect(after.find((l) => l.tier === 'electrical')!.visible).toBe(true);
  expect(after.find((l) => l.tier === 'zones')!.visible).toBe(true);
  await overview.getByRole('button', { name: 'Tous les réseaux' }).click();
  await overview.getByLabel('Opacité du réseau Eau potable').fill('40');
  after = await storedLayers(page);
  expect(after.find((l) => l.tier === 'water')).toMatchObject({ visible: true, opacity: 0.4 });

  // Vue imprimable du seul réseau électrique : l'eau y est masquée, l'électricité affichée.
  await overview
    .locator('[data-network-row="electrical"]')
    .getByRole('button', { name: 'Créer une vue imprimable de ce réseau' })
    .click();
  await expect(page.getByTestId('notice')).toContainText('Réseau — Électricité');
});

/** Épaisseur (pixels écran) du trait coupé par la colonne x, mesurée sur le canevas des objets. */
async function strokeThickness(page: Page, x: number, y: number): Promise<number> {
  return page.evaluate(
    async ({ x, y }) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Canevas physiques : fond, objets, sélection. Seuls les objets sont lus.
      const canvas = document.querySelectorAll(
        '[data-testid="canvas-container"] canvas',
      )[1] as HTMLCanvasElement;
      const ratio = canvas.width / canvas.clientWidth;
      const data = canvas
        .getContext('2d')!
        .getImageData(Math.round(x * ratio), Math.round((y - 30) * ratio), 1, Math.round(60 * ratio)).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 128) opaque++;
      return opaque / ratio;
    },
    { x, y },
  );
}

test('ligne de réseau : même épaisseur à l’écran quel que soit le zoom', async ({ page }) => {
  await openPlanWithPhoto(page);
  const box = await page.getByTestId('canvas-container').boundingBox();
  const cx = Math.round(box!.width / 2);
  const cy = Math.round(box!.height / 2);
  await drawNetwork(page, 'water', [
    [cx - 150, cy],
    [cx + 150, cy],
  ]);
  await page.keyboard.press('Escape'); // désélectionne : seul le trait reste sur le canevas
  const before = await strokeThickness(page, cx + 40, cy);
  expect(before).toBeGreaterThanOrEqual(3);
  expect(before).toBeLessThanOrEqual(6);
  // Zoom avant (×4 environ), centré : le trait reste au centre et garde son épaisseur.
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom avant (+)' }).click();
  await expect.poll(() => strokeThickness(page, cx + 40, cy)).toBeCloseTo(before, 0);
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Zoom arrière (−)' }).click();
  await expect.poll(() => strokeThickness(page, cx + 10, cy)).toBeCloseTo(before, 0);
});
