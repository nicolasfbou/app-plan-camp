import { expect, test } from '@playwright/test';
import {
  createCamp,
  createPlan,
  fixture,
  importBackground,
  openFreshApp,
  waitForBackground,
} from './helpers.ts';

test('éditeur : 3 canevas physiques, 6 groupes logiques d’annotation', async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp');
  await createPlan(page, 'Plan');
  await importBackground(page, fixture('quadrants.png'));
  await waitForBackground(page);
  await expect(page.getByTestId('canvas-container').locator('canvas')).toHaveCount(3);
  const groups = await page.evaluate(() => {
    const K = (
      window as unknown as {
        Konva: { stages: { findOne(s: string): { getChildren(): { name(): string }[] } }[] };
      }
    ).Konva;
    return K.stages[0]!.findOne('.content')
      .getChildren()
      .map((g) => g.name());
  });
  expect(groups).toEqual(['zones', 'buildings', 'circulation', 'pedestrians', 'signage', 'texts']);
});

test('les panneaux latéraux se réduisent et la zone de travail s’agrandit', async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp');
  await createPlan(page, 'Plan');
  const canvas = page.getByTestId('canvas-container');
  const initialWidth = (await canvas.boundingBox())!.width;
  await page.getByRole('button', { name: /panneau des outils/ }).click();
  await page.getByRole('button', { name: /panneau des propriétés/ }).click();
  await expect(page.getByTestId('left-sidebar')).toHaveCount(0);
  await expect(page.getByTestId('right-panel')).toHaveCount(0);
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(initialWidth + 400);
});

test('aucun outil de dessin n’est présenté comme disponible', async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp');
  await createPlan(page, 'Plan');
  const sidebar = page.getByTestId('left-sidebar');
  await expect(sidebar.getByRole('button')).toHaveText(['Main']);
  await expect(sidebar).toContainText('Les outils de dessin arriveront à la phase 2.');
});

test('est installable : manifeste PWA et service worker', async ({ page }) => {
  await page.goto('/');
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await page.request.get(manifestHref!)).json();
  expect(manifest).toMatchObject({ name: 'CampPlanner', display: 'standalone', lang: 'fr' });
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined))
    .toBe(true);
});
