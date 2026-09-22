import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  backgroundPixels,
  createCamp,
  createPlan,
  fixture,
  importBackground,
  openFreshApp,
  sha256OfBuffer,
  sha256OfFile,
  stageTransform,
  waitForBackground,
} from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp test');
  await createPlan(page, 'Plan');
});

for (const [file, format] of [
  ['quadrants.jpg', 'JPEG'],
  ['quadrants.png', 'PNG'],
  ['quadrants.webp', 'WEBP'],
] as const) {
  test(`import ${format} : original conservé à l’octet près`, async ({ page }) => {
    await importBackground(page, fixture(file));
    await waitForBackground(page);
    const panel = page.getByTestId('background-panel');
    await expect(panel).toContainText(format);
    await expect(page.getByTestId('bg-dimensions')).toHaveText('320 × 200 px');
    await expect(page.getByTestId('bg-sha256')).toHaveText(sha256OfFile(fixture(file)));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Télécharger l’original' }).click(),
    ]);
    expect(readFileSync(await download.path()).equals(readFileSync(fixture(file)))).toBe(true);
  });
}

test('orientation EXIF : affichée redressée, original NON réécrit', async ({ page }) => {
  const file = fixture('rotated-exif6.jpg');
  await importBackground(page, file);
  await waitForBackground(page);
  // Stocké 200 × 320, affiché (et coordonnées du projet) 320 × 200.
  await expect(page.getByTestId('bg-dimensions')).toHaveText('320 × 200 px');
  await expect(page.getByTestId('background-panel')).toContainText('EXIF 6');
  await expect(page.getByTestId('bg-sha256')).toHaveText(sha256OfFile(file));

  // À 100 %, le quadrant rouge est bien en haut à gauche, le jaune en bas à droite.
  await page.keyboard.press('1');
  const { x, y } = await stageTransform(page);
  const [r, g, b] = await backgroundPixels(page, x + 40, y + 30, 1, 1);
  expect(r).toBeGreaterThan(200);
  expect(g).toBeLessThan(60);
  expect(b).toBeLessThan(60);
  const [r2, g2, b2] = await backgroundPixels(page, x + 280, y + 170, 1, 1);
  expect(r2).toBeGreaterThan(200);
  expect(g2).toBeGreaterThan(200);
  expect(b2).toBeLessThan(60);
});

test('qualité : à 100 % chaque pixel affiché est exactement le pixel du fichier (aucun décalage, filtre ni couleur modifiée)', async ({
  page,
}) => {
  await importBackground(page, fixture('quadrants.png'));
  await waitForBackground(page);
  await page.keyboard.press('1');
  await expect(page.getByTestId('zoom-level')).toHaveText('100 %');
  const { x, y, scale } = await stageTransform(page);
  expect(scale).toBe(1);
  expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);

  const expected = (ix: number, iy: number) => {
    if (ix >= 150 && ix < 170 && iy >= 90 && iy < 110) return (ix + iy) % 2 ? [0, 0, 0] : [255, 255, 255];
    if (iy < 100) return ix < 160 ? [255, 0, 0] : [0, 255, 0];
    return ix < 160 ? [0, 0, 255] : [255, 255, 0];
  };
  const pixels = await backgroundPixels(page, x, y, 320, 200);
  let mismatches = 0;
  for (let iy = 0; iy < 200; iy++) {
    for (let ix = 0; ix < 320; ix++) {
      const o = (iy * 320 + ix) * 4;
      const [er, eg, eb] = expected(ix, iy);
      if (pixels[o] !== er || pixels[o + 1] !== eg || pixels[o + 2] !== eb || pixels[o + 3] !== 255)
        mismatches++;
    }
  }
  expect(mismatches).toBe(0);

  // À 200 %, chaque pixel devient un bloc net de 2 × 2 (pas de flou d'interpolation).
  await page.getByRole('button', { name: /Zoom avant/ }).click();
  await page.getByRole('button', { name: /Zoom avant/ }).click();
  await page.getByRole('button', { name: /Zoom avant/ }).click();
  await page.getByRole('button', { name: /Zoom avant/ }).click();
  const zoomed = await stageTransform(page);
  const ix = 151; // ligne du damier : pixel noir/blanc isolé
  const iy = 91;
  const sx = zoomed.x + (ix + 0.5) * zoomed.scale;
  const sy = zoomed.y + (iy + 0.5) * zoomed.scale;
  const [cr, cg, cb] = await backgroundPixels(page, Math.floor(sx), Math.floor(sy), 1, 1);
  const [er, eg, eb] = expected(ix, iy);
  expect([cr, cg, cb]).toEqual([er, eg, eb]);
});

test('import PDF : choix de page et de résolution, PDF d’origine conservé', async ({ page }) => {
  const file = fixture('plan-2-pages.pdf');
  await importBackground(page, file);
  const dialog = page.getByRole('dialog', { name: 'Choisir la page du PDF' });
  await expect(dialog).toContainText('2 pages');
  await dialog.getByRole('radio', { name: 'Page 2' }).click();
  await dialog.getByLabel('Résolution du rendu').selectOption('72');
  await expect(page.getByTestId('pdf-output-size')).toContainText('612 × 792 px');
  await dialog.getByRole('button', { name: 'Créer le fond' }).click();
  await waitForBackground(page);

  await expect(page.getByTestId('bg-dimensions')).toHaveText('612 × 792 px');
  const source = page.getByTestId('bg-pdf-source');
  await expect(source).toContainText('Page 2 sur 2');
  await expect(source).toContainText('72 ppp');
  await expect(source).toContainText(sha256OfFile(file));

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Télécharger le PDF d’origine' }).click(),
  ]);
  expect(sha256OfBuffer(readFileSync(await download.path()))).toBe(sha256OfFile(file));

  // Page 2 : rectangle vert au centre, marges blanches.
  await page.keyboard.press('1');
  const { x, y } = await stageTransform(page);
  const [r, g, b] = await backgroundPixels(page, x + 306, y + 396, 1, 1);
  expect(r).toBeLessThan(20);
  expect(g).toBeGreaterThan(130);
  expect(b).toBeLessThan(20);
});
