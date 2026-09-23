/**
 * Essai de la Phase 3 sur la VRAIE photo aérienne du Camp 105 (donnée locale, jamais modifiée).
 * Usage : node bench/camp105-phase3.mjs <photo> <dossier-sortie>
 * Prérequis : `npm run build && npx vite preview --port 4178`.
 *
 * AVERTISSEMENT : les emplacements des zones, du chemin et des étiquettes sont des EXEMPLES DE
 * TEST choisis à l'œil sur la photo. Ce n'est PAS un plan de circulation approuvé ; l'usage réel
 * des bâtiments (dortoirs, cuisine…) est une hypothèse.
 *
 * 1. crée le camp et le plan, importe la photo ;
 * 2. crée un calque « Dortoirs (test) », le rend actif, y trace les dortoirs ; puis les autres
 *    bâtiments, le stationnement, le débarquement, la zone piétonne, un chemin de circulation et
 *    des étiquettes — tout AVEC LES VRAIS OUTILS de l'interface ;
 * 3. enregistre, rouvre, compare les objets (identiques au pixel image près) ;
 * 4. vérifie l'attache au même pixel de la photo à 12,5 → 400 % ;
 * 5. exporte le .campplan, le réimporte dans un navigateur au stockage VIDE, compare tout
 *    (objets, calques, SHA-256 de la photo et de l'original téléchargé) ;
 * 6. capture l'éditeur avec le panneau des calques.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { unzipSync } from 'fflate';

const [photo, outDir] = process.argv.slice(2);
if (!photo || !outDir) throw new Error('Usage : node bench/camp105-phase3.mjs <photo> <dossier>');
const APP = process.env.APP_URL ?? 'http://localhost:4178/';
const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4];
mkdirSync(outDir, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const photoSha = sha(readFileSync(photo));

/** Annotations en pixels IMAGE (photo 4000 × 2250). Exemples de test uniquement. */
const DORTOIRS = [
  {
    name: 'Dortoir A (hypothèse)',
    points: [
      [1200, 1204],
      [1470, 1256],
    ],
  },
  {
    name: 'Dortoir B (hypothèse)',
    points: [
      [1200, 1284],
      [1470, 1340],
    ],
  },
  {
    name: 'Dortoir C (hypothèse)',
    points: [
      [1820, 950],
      [2040, 1000],
    ],
  },
  {
    name: 'Dortoir D (hypothèse)',
    points: [
      [1820, 1254],
      [2040, 1304],
    ],
  },
  {
    name: 'Dortoir E (hypothèse)',
    points: [
      [1820, 1356],
      [2036, 1402],
    ],
  },
];
const OTHERS = [
  {
    preset: 'building.kitchen',
    tool: 'rect',
    name: 'Cuisine / cafétéria (hypothèse)',
    points: [
      [1814, 1060],
      [2070, 1176],
    ],
  },
  {
    preset: 'building.office',
    tool: 'rect',
    name: 'Bureaux (hypothèse)',
    points: [
      [2372, 932],
      [2606, 1076],
    ],
  },
  {
    preset: 'building.generic',
    tool: 'rect',
    name: 'Bâtiment toit vert',
    points: [
      [2412, 646],
      [2626, 772],
    ],
  },
  {
    preset: 'building.warehouse',
    tool: 'rect',
    name: 'Dôme / entrepôt (hypothèse)',
    points: [
      [1864, 476],
      [2090, 556],
    ],
  },
  {
    preset: 'building.garage',
    tool: 'rect',
    name: 'Garage / atelier (hypothèse)',
    points: [
      [1806, 1430],
      [2056, 1544],
    ],
  },
  {
    preset: 'zone.parking',
    tool: 'rect',
    name: 'Stationnement — exemple de test',
    points: [
      [1716, 1080],
      [1812, 1410],
    ],
  },
  {
    preset: 'zone.dropoff',
    tool: 'rect',
    name: 'Débarquement — exemple de test',
    points: [
      [1680, 1580],
      [2040, 1652],
    ],
  },
  {
    preset: 'zone.pedestrian',
    tool: 'polygon',
    name: 'Zone piétonne — exemple de test',
    points: [
      [1490, 900],
      [1700, 880],
      [1705, 1400],
      [1490, 1420],
    ],
  },
  {
    tool: 'polyline',
    name: 'Chemin de circulation — exemple de test',
    points: [
      [1000, 1690],
      [1660, 1590],
      [2200, 1560],
      [2300, 1200],
      [2300, 840],
    ],
  },
  { tool: 'label', text: 'DORTOIRS (hypothèse)', at: [1335, 1172] },
  { tool: 'label', text: 'CUISINE (hypothèse)', at: [2250, 1118] },
  { tool: 'label', text: 'STATIONNEMENT (test)', at: [1600, 1455] },
  { tool: 'label', text: 'DÉBARQUEMENT (test)', at: [1860, 1700] },
  { tool: 'label', text: 'CIRCULATION (exemple)', at: [2480, 1380] },
  { tool: 'label', text: 'EXEMPLE DE TEST — NON APPROUVÉ', at: [1900, 330] },
  { tool: 'text', text: 'Camp 105 — essai Phase 3', at: [1380, 1830] },
];

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
page.on('pageerror', (e) => console.error('Erreur de page :', e.message));
await page.goto(APP);
await page.getByRole('button', { name: 'Nouveau camp' }).click();
await page.getByLabel('Nom du camp').fill('Camp 105');
await page.getByRole('button', { name: 'Créer' }).click();
await page.getByRole('button', { name: 'Nouveau plan' }).click();
await page.getByLabel('Nom du plan').fill('Essai Phase 3 — exemple de test');
await page.getByRole('button', { name: 'Créer' }).click();
await page.getByTestId('import-input').setInputFiles(photo);
const openAnyway = page.getByRole('button', { name: 'Ouvrir quand même' });
await Promise.race([
  page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 }),
  openAnyway.click({ timeout: 120_000 }).catch(() => {}),
]);
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });

const readStored = (p) =>
  p.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const r = open.result.transaction('plans').objectStore('plans').getAll();
          r.onsuccess = () => {
            resolve(r.result[0]);
            open.result.close();
          };
        };
      }),
  );
/** Vue enregistrée (centre en pixels image, zoom) puis réouverture du plan : comme un utilisateur. */
async function setView(planId, cx, cy, zoom) {
  await page.evaluate(
    ({ planId, cx, cy, zoom }) =>
      new Promise((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const tx = open.result.transaction('viewPrefs', 'readwrite');
          tx.objectStore('viewPrefs').put({ planId, centerX: cx, centerY: cy, scale: zoom });
          tx.oncomplete = () => {
            resolve();
            open.result.close();
          };
        };
      }),
    { planId, cx, cy, zoom },
  );
  await page.reload();
  await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
}
// Tracé à 55 %, centré sur le camp (étiquettes à une taille lisible, pas démesurées).
const planId = (await readStored(page)).id;
await setView(planId, 1900, 1150, 0.55);

const box = await page.getByTestId('canvas-container').boundingBox();
const transform = () =>
  page.evaluate(() => {
    const s = window.Konva.stages[0];
    return { x: s.x(), y: s.y(), scale: s.scaleX() };
  });
const toScreen = async ([x, y]) => {
  const t = await transform();
  return [box.x + x * t.scale + t.x, box.y + y * t.scale + t.y];
};
const waitSaved = () =>
  page
    .getByTestId('save-status')
    .filter({ hasText: /^Enregistré$/ })
    .waitFor({ timeout: 30_000 });

async function draw(a) {
  if (a.preset)
    await page.evaluate((id) => document.querySelector(`[data-preset="${id}"]`)?.click(), a.preset);
  const key = { rect: 'r', polygon: 'p', polyline: 'k', label: 'g', text: 't' }[a.tool];
  await page.keyboard.press(key);
  if (a.tool === 'rect') {
    const [s, e] = [await toScreen(a.points[0]), await toScreen(a.points[1])];
    await page.mouse.move(...s);
    await page.mouse.down();
    await page.mouse.move(...e, { steps: 8 });
    await page.mouse.up();
  } else if (a.tool === 'polygon' || a.tool === 'polyline') {
    for (const p of a.points) await page.mouse.click(...(await toScreen(p)));
    await page.keyboard.press('Enter');
  } else {
    await page.mouse.click(...(await toScreen(a.at)));
    await page.getByTestId('text-editor').fill(a.text);
    await page.keyboard.press('Enter');
  }
  if (a.name) {
    await page.getByRole('tab', { name: 'Propriétés' }).click();
    const field = page.getByLabel('Nom', { exact: true });
    await field.fill(a.name);
    await field.press('Enter');
    await field.blur(); // comme un clic ailleurs : le clavier revient au plan
  }
  await page.keyboard.press('Escape');
}

// Calque personnalisé « Dortoirs (test) », actif pendant le tracé des dortoirs.
await page.getByRole('tab', { name: 'Calques' }).click();
await page.getByRole('button', { name: 'Nouveau calque' }).click();
await page.getByLabel('Nom du calque').fill('Dortoirs (test)');
await page.getByRole('dialog').getByLabel('Catégorie').selectOption('buildings');
await page.getByRole('button', { name: 'Créer', exact: true }).click();
for (const d of DORTOIRS) await draw({ ...d, preset: 'building.dormitory', tool: 'rect' });
await page.getByRole('tab', { name: 'Calques' }).click();
await page.getByRole('button', { name: /^Dortoirs \(test\)/ }).click(); // n'est plus le calque actif
// Sélection multiple (Maj + clic dans la liste du calque), groupe, couleur commune : une action chacun.
await page.getByRole('button', { name: DORTOIRS[0].name, exact: true }).click();
await page.keyboard.down('Shift');
for (const d of DORTOIRS.slice(1)) await page.getByRole('button', { name: d.name, exact: true }).click();
await page.keyboard.up('Shift');
await page.keyboard.press('Control+g');
await page.getByRole('tab', { name: 'Propriétés' }).click();
const count = await page.getByTestId('selection-count').textContent();
await page.getByRole('button', { name: 'Remplissage : Violet' }).click();
await page.getByRole('button', { name: 'Couleur du trait : Violet' }).click();
console.log(`Dortoirs : « ${count} », couleur violette appliquée au groupe`);
await page.keyboard.press('Escape');
for (const a of OTHERS) await draw(a);
await waitSaved();

const before = (await readStored(page)).document;
const objects = Object.values(before.objects);
const layerName = (id) => before.layers.find((l) => l.id === id)?.name;
console.log(`Objets créés : ${objects.length} · calques : ${before.layers.map((l) => l.name).join(', ')}`);
console.table(
  objects
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((o) => ({ nom: o.name, type: o.type, calque: layerName(o.layerId), forme: o.geometry.kind })),
);

// Rouvrir : le plan est identique.
await page.reload();
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const reopened = (await readStored(page)).document;
const same =
  isDeepStrictEqual(reopened.objects, before.objects) && isDeepStrictEqual(reopened.layers, before.layers);
console.log(`Réouverture : ${same ? 'objets et calques IDENTIQUES' : 'DIFFÉRENCES'}`);

// Capture : éditeur centré sur le camp, panneau des calques, un dortoir sélectionné.
await setView(planId, 1900, 1150, 0.55);
await page.getByRole('tab', { name: 'Calques' }).click();
await page.getByRole('button', { name: 'Dortoir C (hypothèse)', exact: true }).click();
await page.waitForTimeout(6500); // laisse disparaître la notification « hors ligne »
await page.screenshot({ path: `${outDir}/camp105-editeur-calques.png` });

// Attache au même pixel de la photo, à chaque zoom (préférence de vue centrée sur l'objet).
function centerOf(g) {
  if (g.kind === 'rect') return [g.x + g.width / 2, g.y + g.height / 2];
  if (g.kind === 'point') return [g.x, g.y];
  if (g.kind === 'ellipse') return [g.cx, g.cy];
  const xs = g.points.map((p) => p.x);
  const ys = g.points.map((p) => p.y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}
let worst = 0;
let checks = 0;
for (const zoom of ZOOMS) {
  for (const object of objects) {
    if (object.geometry.kind === 'text') continue;
    const [cx, cy] = centerOf(object.geometry);
    await setView(planId, cx, cy, zoom);
    await page.waitForFunction(
      (n) => window.Konva.stages[0]?.find('.plan-object').length === n,
      objects.length,
    );
    const shown = await page.evaluate((id) => {
      const s = window.Konva.stages[0];
      const n = s.findOne(`#${id}`);
      return {
        x: n.getAbsolutePosition().x,
        y: n.getAbsolutePosition().y,
        t: { x: s.x(), y: s.y(), scale: s.scaleX() },
      };
    }, object.id);
    const error = Math.hypot(
      shown.x - (cx * shown.t.scale + shown.t.x),
      shown.y - (cy * shown.t.scale + shown.t.y),
    );
    worst = Math.max(worst, error);
    checks++;
    if (object.name.startsWith('Dortoir C') && [0.25, 1, 4].includes(zoom))
      await page.getByTestId('canvas-container').screenshot({
        path: `${outDir}/camp105-zoom-${zoom * 100}.png`,
      });
  }
}
console.log(
  `Attache : ${checks} vérifications (${ZOOMS.length} zooms), écart maximal ${worst.toFixed(4)} px écran`,
);

// Export .campplan.
await page.keyboard.press('0');
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
]);
const archive = join(outDir, 'camp-105-demo.campplan');
await download.saveAs(archive);
const bytes = readFileSync(archive);
const entries = unzipSync(new Uint8Array(bytes));
const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
console.log(
  `Archive : ${(bytes.length / 1e6).toFixed(2)} Mo · fichiers : ${Object.keys(entries).join(', ')}`,
);
const photoEntry = manifest.files.find((f) => f.role === 'background');
console.log(
  `Manifeste : format ${manifest.format} v${manifest.formatVersion}, schéma ${manifest.schemaVersion}, ` +
    `photo ${photoEntry?.sha256 === photoSha ? '= original (SHA-256 identique)' : 'DIFFÉRENTE'}`,
);

// Réimport dans un navigateur au stockage VIDE (chemin ASCII : Chromium ignore les accents).
const asciiCopy = join(tmpdir(), `camp105-${Date.now()}.campplan`);
copyFileSync(archive, asciiCopy);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const fresh = await context.newPage();
await fresh.goto(APP);
await fresh.getByText('Aucun camp pour l’instant').waitFor();
await fresh.getByTestId('campplan-input').setInputFiles(asciiCopy);
await fresh.getByTestId('import-verified').waitFor({ timeout: 60_000 });
const summary = await fresh.getByTestId('import-project').innerText();
await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
await fresh.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const imported = (await readStored(fresh)).document;
const identical =
  isDeepStrictEqual(imported.objects, before.objects) && isDeepStrictEqual(imported.layers, before.layers);
await fresh.getByRole('tab', { name: 'Fond' }).click();
await fresh.getByRole('button', { name: 'Vérifier l’intégrité' }).click();
await fresh.getByTestId('integrity-ok').waitFor({ timeout: 60_000 });
const importedSha = await fresh.getByTestId('bg-sha256').textContent();
const [original] = await Promise.all([
  fresh.waitForEvent('download'),
  fresh.getByRole('button', { name: 'Télécharger l’original' }).click(),
]);
const originalSha = sha(readFileSync(await original.path()));
await fresh.getByRole('tab', { name: 'Calques' }).click();
await fresh.waitForTimeout(6500);
await fresh.screenshot({ path: `${outDir}/camp105-reimporte.png` });
await context.close();
await browser.close();

const report = {
  objets: objects.length,
  calques: before.layers.map((l) => l.name),
  reouvertureIdentique: same,
  attache: { verifications: checks, ecartMaxPxEcran: worst },
  archive: {
    octets: bytes.length,
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
  },
  reimport: {
    resume: summary,
    objetsEtCalquesIdentiques: identical,
    shaFond: importedSha,
    shaOriginalTelecharge: originalSha,
  },
  shaPhotoSource: photoSha,
  shaPhotoSourceApres: sha(readFileSync(photo)),
};
writeFileSync(join(outDir, 'camp105-rapport.json'), JSON.stringify(report, null, 2));
console.log(
  `Réimport (stockage vide) : objets et calques ${identical ? 'IDENTIQUES' : 'DIFFÉRENTS'} · ` +
    `SHA fond ${importedSha === photoSha ? 'IDENTIQUE' : 'DIFFÉRENT'} · original téléchargé ${originalSha === photoSha ? 'IDENTIQUE' : 'DIFFÉRENT'}`,
);
console.log(`Photo source inchangée : ${report.shaPhotoSourceApres === photoSha ? 'oui' : 'NON'}`);
if (!same || !identical || worst > 0.5 || importedSha !== photoSha || originalSha !== photoSha)
  process.exit(1);
