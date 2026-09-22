import { expect, test } from '@playwright/test';
import { createCamp, createPlan, fixture, importBackground, openFreshApp } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp test');
  await createPlan(page, 'Plan');
});

test('fichier invalide (texte renommé en .jpg) : message clair, rien n’est importé', async ({ page }) => {
  await importBackground(page, fixture('not-an-image.jpg'));
  const dialog = page.getByRole('dialog', { name: 'Import impossible' });
  await expect(dialog).toContainText('Format non pris en charge');
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  await expect(page.getByText('Importez la photo aérienne du camp')).toBeVisible();
});

test('PDF invalide : message clair', async ({ page }) => {
  await importBackground(page, fixture('broken.pdf'));
  await expect(page.getByRole('dialog', { name: 'Import impossible' })).toContainText(
    'PDF est illisible ou corrompu',
  );
});

test('image énorme : alerte détaillée AVANT tout décodage, annulation sans plantage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await importBackground(page, fixture('huge-header.png'));
  const dialog = page.getByRole('dialog', { name: 'Image potentiellement trop grande pour le navigateur' });
  const details = dialog.getByTestId('size-warning');
  await expect(details).toContainText('40 000 px');
  await expect(details).toContainText('30 000 px');
  await expect(details).toContainText('1 200 MP');
  await expect(details).toContainText('33 octets');
  await expect(details).toContainText('Go'); // mémoire décodée ≈ 4,5 Go
  await expect(details).toContainText('manquer de mémoire');
  await expect(details).toContainText('limite des canevas');
  await expect(details).toContainText('ni compressée ni réduite');
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByText('Importez la photo aérienne du camp')).toBeVisible();
  expect(errors).toEqual([]);
});
