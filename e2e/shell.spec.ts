import { expect, test } from '@playwright/test';

test.describe('fondation de l’application', () => {
  test('affiche la mise en page desktop et un Stage Konva à 8 couches', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');

    await expect(page.getByTestId('left-sidebar')).toBeVisible();
    await expect(page.getByTestId('right-panel')).toBeVisible();
    await expect(page.getByText('Aucun plan ouvert').first()).toBeVisible();

    // Une couche Konva = un <canvas> : fond, 6 niveaux de rendu, surcouche d'interaction.
    const canvases = page.getByTestId('canvas-container').locator('canvas');
    await expect(canvases).toHaveCount(8);

    // Sans plan, rien ne prétend fonctionner : annuler/rétablir sont désactivés.
    await expect(page.getByRole('button', { name: /Annuler/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Rétablir/ })).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('les panneaux latéraux se réduisent et la zone de travail s’agrandit', async ({ page }) => {
    await page.goto('/');
    const canvas = page.getByTestId('canvas-container');
    const initialWidth = (await canvas.boundingBox())!.width;

    await page.getByRole('button', { name: /panneau des outils/ }).click();
    await page.getByRole('button', { name: /panneau des propriétés/ }).click();
    await expect(page.getByTestId('left-sidebar')).toHaveCount(0);
    await expect(page.getByTestId('right-panel')).toHaveCount(0);

    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(initialWidth + 400);
    // Le Stage suit la taille de son conteneur.
    const stageWidth = await canvas
      .locator('canvas')
      .first()
      .evaluate((c) => c.clientWidth);
    expect(stageWidth).toBe(Math.floor((await canvas.boundingBox())!.width));
  });

  test('les onglets du panneau droit fonctionnent', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Calques' }).click();
    await expect(page.getByRole('tab', { name: 'Calques' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(/Les calques apparaîtront ici/)).toBeVisible();
  });

  test('est installable : manifeste PWA et service worker', async ({ page }) => {
    await page.goto('/');
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBeTruthy();
    const manifest = await (await page.request.get(manifestHref!)).json();
    expect(manifest).toMatchObject({ name: 'CampPlanner', display: 'standalone', lang: 'fr' });
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined))
      .toBe(true);
  });
});
