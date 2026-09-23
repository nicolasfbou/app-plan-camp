import { expect, test } from '@playwright/test';
import {
  createCamp,
  createPlan,
  fixture,
  importBackground,
  openFreshApp,
  waitForBackground,
} from './helpers.ts';

test('éditeur : 3 canevas physiques ; un groupe Konva par calque, portant sa catégorie logique', async ({
  page,
}) => {
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
  expect(groups).toEqual([
    'user-layer tier-zones',
    'user-layer tier-parking',
    'user-layer tier-deliveries',
    'user-layer tier-safety',
    'user-layer tier-buildings',
    'user-layer tier-circulation',
    'user-layer tier-pedestrians',
    'user-layer tier-signage',
    'user-layer tier-texts',
  ]);
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

test('la palette contient exactement les outils livrés (phases 2 et 4)', async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp');
  await createPlan(page, 'Plan');
  const toolbar = page.getByRole('toolbar', { name: 'Outils' });
  const names = await toolbar
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(names).toEqual([
    'Sélection',
    'Main',
    'Rectangle',
    'Rectangle arrondi',
    'Ellipse / cercle',
    'Polygone',
    'Ligne',
    'Polyligne',
    'Texte',
    'Étiquette',
    'Circulation véhicules',
    'Corridor piéton',
    'Pictogramme',
  ]);
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
