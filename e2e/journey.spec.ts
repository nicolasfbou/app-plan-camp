import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  createCamp,
  createPlan,
  fixture,
  importBackground,
  openFreshApp,
  sha256OfBuffer,
  sha256OfFile,
  stageTransform,
  waitForBackground,
  waitSaved,
} from './helpers.ts';

test('parcours principal : camp → plan → photo → fermer → recharger → rouvrir à l’identique', async ({
  page,
}) => {
  const errors = await openFreshApp(page);
  const file = fixture('quadrants.png');
  const expectedSha = sha256OfFile(file);

  await createCamp(page, 'Camp 105');
  await createPlan(page, 'Plan général');
  await expect(page.getByText('Importez la photo aérienne du camp')).toBeVisible();

  // Import : la photo s'affiche en « adapter à l'écran », centrée.
  await importBackground(page, file);
  await waitForBackground(page);
  await expect(page.getByTestId('bg-dimensions')).toHaveText('320 × 200 px');
  await expect(page.getByTestId('bg-sha256')).toHaveText(expectedSha);
  await waitSaved(page);

  const box = (await page.getByTestId('canvas-container').boundingBox())!;
  const fit = await stageTransform(page);
  const imageCenter = { x: fit.x + 160 * fit.scale, y: fit.y + 100 * fit.scale };
  expect(imageCenter.x).toBeCloseTo(box.width / 2, 0);
  expect(imageCenter.y).toBeCloseTo(box.height / 2, 0);

  // Fermer le plan, recharger complètement la page, rouvrir le camp puis le plan.
  await page.getByRole('link', { name: 'Camps' }).first().click();
  await expect(page.getByTestId('camp-row')).toHaveCount(1);
  await page.reload();
  await page.getByRole('link', { name: /Camp 105/ }).click();
  await page.getByRole('link', { name: /Plan général/ }).click();
  await waitForBackground(page);

  // Image identique : empreinte, dimensions, octets téléchargés.
  await expect(page.getByTestId('bg-sha256')).toHaveText(expectedSha);
  await expect(page.getByTestId('bg-dimensions')).toHaveText('320 × 200 px');
  await page.getByRole('button', { name: 'Vérifier l’intégrité' }).click();
  await expect(page.getByTestId('integrity-ok')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Télécharger l’original' }).click(),
  ]);
  const downloaded = readFileSync(await download.path());
  expect(sha256OfBuffer(downloaded)).toBe(expectedSha);
  expect(downloaded.equals(readFileSync(file))).toBe(true);

  // Le zoom fonctionne après réouverture.
  await page.getByRole('button', { name: /Taille réelle/ }).click();
  await expect(page.getByTestId('zoom-level')).toHaveText('100 %');
  await page.getByRole('button', { name: /Adapter à l’écran/ }).click();
  expect((await stageTransform(page)).scale).toBeCloseTo(fit.scale, 5);

  // Recharger directement l'URL du plan (reprise après fermeture ou plantage).
  await page.reload();
  await waitForBackground(page);
  await expect(page.getByTestId('bg-sha256')).toHaveText(expectedSha);
  expect(errors).toEqual([]);
});

test('le nom du plan se renomme dans l’éditeur et la modification est sauvegardée', async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp 60');
  await createPlan(page, 'Plan général');
  await page.getByRole('button', { name: 'Plan général' }).click();
  await page.getByLabel('Nom du plan').fill('Circulation hiver');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByTestId('plan-title')).toHaveText('Circulation hiver');
  await waitSaved(page);
  await page.reload();
  await expect(page.getByTestId('plan-title')).toHaveText('Circulation hiver');
});

test('renommer dans l’éditeur est annulable', async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp 60');
  await createPlan(page, 'Plan général');
  await page.getByRole('button', { name: 'Plan général' }).click();
  await page.getByLabel('Nom du plan').fill('Sécurité');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByTestId('plan-title')).toHaveText('Sécurité');
  await page.getByRole('button', { name: /Annuler \(Ctrl\+Z\)/ }).click();
  await expect(page.getByTestId('plan-title')).toHaveText('Plan général');
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('plan-title')).toHaveText('Sécurité');
});
