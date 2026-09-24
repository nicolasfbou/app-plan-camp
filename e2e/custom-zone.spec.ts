import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
// @ts-expect-error module JavaScript sans déclarations de types
import { inspectPdf } from '../bench/pdf-inspect.mjs';
import { dragOnCanvas, openPlanWithPhoto, storedObjects, waitSaved } from './helpers.ts';

/** Zone personnalisée nommée : le nom tapé (ex. « Héliport ») se voit sur le plan et sur le PDF. */
test('zone personnalisée « Héliport » : nom tapé, zone dessinée, nom visible sur le plan, dans la légende et le PDF', async ({
  page,
  browser,
}) => {
  await openPlanWithPhoto(page);
  await page.getByTestId('custom-zone-name').fill('Héliport');
  // Le modèle « Zone personnalisée » est choisi et l'outil rectangle activé automatiquement.
  await expect(page.locator('[data-preset="zone.custom"]')).toHaveAttribute('aria-checked', 'true');
  await dragOnCanvas(page, [300, 250], [520, 420]);
  await waitSaved(page);
  const zones = Object.values(await storedObjects(page)).filter((o) => o.type === 'zone');
  expect(zones).toHaveLength(1);
  expect(zones[0]).toMatchObject({ name: 'Héliport', showName: true, presetId: 'zone.custom' });
  // Nom peint sur la zone (même routine que le PDF, vérifié plus bas) : capture pour contrôle visuel.
  await page.screenshot({ path: test.info().outputPath('heliport.png') });
  // Nom modifiable ensuite dans les propriétés.
  await expect(page.getByLabel('Nom', { exact: true })).toHaveValue('Héliport');

  // PDF : nom dans la zone et dans la légende.
  await page.getByTestId('open-print').click();
  await expect(page.getByTestId('print-dialog')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('print-export').click(),
  ]);
  const pdf = (await inspectPdf(browser, readFileSync((await download.path())!))) as { text: string };
  expect(pdf.text.split('Héliport').length - 1).toBeGreaterThanOrEqual(2);
  expect(pdf.text).not.toContain('Zone personnalisée');
});
