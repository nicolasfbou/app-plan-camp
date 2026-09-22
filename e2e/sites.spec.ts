import { expect, test } from '@playwright/test';
import {
  createCamp,
  createPlan,
  fixture,
  importBackground,
  openFreshApp,
  waitForBackground,
  waitSaved,
} from './helpers.ts';

test('camps : créer, lister, renommer, supprimer avec confirmation', async ({ page }) => {
  await openFreshApp(page);
  await expect(page.getByText('Aucun camp pour l’instant')).toBeVisible();
  for (const name of ['Camp 105', 'Camp 60', 'Camp 132']) {
    await createCamp(page, name);
    await page.getByRole('link', { name: 'Camps' }).first().click();
  }
  await expect(page.getByTestId('camp-row')).toHaveText([/Camp 105/, /Camp 132/, /Camp 60/]);

  await page.getByRole('button', { name: 'Renommer Camp 60' }).click();
  await page.getByLabel('Nom du camp').fill('Camp 60 Nord');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByTestId('camp-row').filter({ hasText: 'Camp 60 Nord' })).toBeVisible();

  // Suppression : annuler ne supprime rien, confirmer supprime.
  await page.getByRole('button', { name: 'Supprimer Camp 132' }).click();
  await expect(page.getByRole('dialog')).toContainText('irréversible');
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByTestId('camp-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Supprimer Camp 132' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click();
  await expect(page.getByTestId('camp-row')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('camp-row')).toHaveText([/Camp 105/, /Camp 60 Nord/]);
});

test('plans : créer, ouvrir, renommer, dupliquer (photo partagée), supprimer', async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp 105');
  await createPlan(page, 'Plan général');
  await importBackground(page, fixture('quadrants.jpg'));
  await waitForBackground(page);
  await waitSaved(page);
  const sha = await page.getByTestId('bg-sha256').textContent();
  await page.getByRole('link', { name: 'Camp 105' }).click();

  await page.getByRole('button', { name: 'Dupliquer Plan général' }).click();
  await expect(page.getByLabel('Nom de la copie')).toHaveValue('Plan général (copie)');
  await page.getByLabel('Nom de la copie').fill('Circulation hiver');
  await page.getByRole('button', { name: 'Dupliquer', exact: true }).click();
  await expect(page.getByTestId('plan-row')).toHaveText([/Circulation hiver/, /Plan général/]);

  await page.getByRole('button', { name: 'Renommer Plan général' }).click();
  await page.getByLabel('Nom du plan').fill('Sécurité');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByTestId('plan-row')).toHaveText([/Circulation hiver/, /Sécurité/]);

  // Supprimer l'original ne supprime pas la photo encore utilisée par la copie.
  await page.getByRole('button', { name: 'Supprimer Sécurité' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click();
  await expect(page.getByTestId('plan-row')).toHaveCount(1);
  await page.getByRole('link', { name: /Circulation hiver/ }).click();
  await waitForBackground(page);
  await expect(page.getByTestId('bg-sha256')).toHaveText(sha!);
});

test('projet sans image : s’ouvre, propose l’import, aucune erreur', async ({ page }) => {
  const errors = await openFreshApp(page);
  await createCamp(page, 'Nouveau site');
  await createPlan(page, 'Déneigement');
  await waitSaved(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Importer une image ou un PDF' })).toBeVisible();
  await page.getByRole('tab', { name: 'Fond' }).click();
  await expect(page.getByText('Aucun fond importé.')).toBeVisible();
  await expect(page.getByTestId('navigation-controls')).toHaveCount(0);
  expect(errors).toEqual([]);
});
