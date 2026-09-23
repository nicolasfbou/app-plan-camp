/**
 * Démonstration de la Phase 4 sur la VRAIE photo aérienne du Camp 105 (donnée locale, jamais
 * modifiée). Usage : node bench/camp105-phase4.mjs <photo> <dossier-sortie>
 * Prérequis : `npm run build && npx vite preview --port 4178` (ou APP_URL).
 *
 * AVERTISSEMENT : disposition ILLUSTRATIVE, placée sur des éléments visibles de la photo (routes de
 * gravier, aire dégagée au sud, cuisine, rangée de véhicules garés). Elle doit être validée sur le
 * terrain avant toute utilisation opérationnelle. Ce n'est pas un plan de circulation approuvé.
 *
 * Tout est créé avec les VRAIS outils de l'interface : trajets de véhicules, corridors piétons,
 * zones de stationnement, de débarquement et de sécurité, pictogrammes, étiquettes ; analyse des
 * croisements ; enregistrement, réouverture, attache à tous les zooms, export .campplan et
 * réimport dans un navigateur vide ; captures d'écran.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from '@playwright/test';
import { unzipSync } from 'fflate';

const [photo, outDir] = process.argv.slice(2);
if (!photo || !outDir) throw new Error('Usage : node bench/camp105-phase4.mjs <photo> <dossier>');
const APP = process.env.APP_URL ?? 'http://localhost:4178/';
const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4];
mkdirSync(outDir, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const photoSha = sha(readFileSync(photo));

/** Éléments en pixels IMAGE (photo 4000 × 2250), placés sur ce qui est visible. Illustratif. */
const PLAN = [
  {
    tool: 'flow',
    category: 'general',
    name: 'Circulation générale — route d’accès (exemple)',
    direction: 'both',
    // Route de gravier du sud-ouest → aire dégagée au sud du camp → route de l'est.
    points: [
      [300, 2200],
      [520, 1960],
      [820, 1740],
      [1200, 1735],
      [1700, 1735],
      [2300, 1720],
      [2650, 1580],
      [2900, 1330],
      [3100, 1060],
      [3240, 820],
    ],
  },
  {
    tool: 'flow',
    category: 'delivery',
    name: 'Livraison — accès à la cuisine (exemple)',
    direction: 'forward',
    // Depuis la route du sud, vers le nord, le long du côté est de la rangée centrale.
    points: [
      [2300, 1720],
      [2250, 1400],
      [2200, 1200],
    ],
  },
  {
    tool: 'corridor',
    name: 'Corridor dortoirs → cuisine (exemple)',
    width: 40,
    oriented: true,
    points: [
      [1480, 1235],
      [1700, 1235],
      [1810, 1190],
    ],
  },
  {
    tool: 'corridor',
    name: 'Corridor vers l’aire sud (exemple)',
    width: 40,
    oriented: false,
    // Traverse la route du sud : l'analyse doit signaler le croisement.
    points: [
      [1560, 1420],
      [1560, 1880],
    ],
  },
  {
    tool: 'zone',
    preset: 'zone.parking',
    name: 'Stationnement employés (exemple)',
    points: [
      [1716, 1080],
      [1812, 1410],
    ],
  },
  {
    tool: 'zone',
    preset: 'zone.dropoff',
    name: 'Débarquement des marchandises (exemple)',
    points: [
      [1800, 1575],
      [2060, 1665],
    ],
  },
  {
    tool: 'zone',
    preset: 'zone.delivery',
    name: 'Livraison alimentaire (exemple)',
    points: [
      [2085, 1070],
      [2240, 1185],
    ],
  },
  {
    tool: 'zone',
    preset: 'zone.assembly',
    name: 'Point de rassemblement (exemple)',
    points: [
      [2150, 760],
      [2370, 900],
    ],
  },
  { tool: 'symbol', symbol: 'sign.entrance', at: [680, 2000] },
  { tool: 'symbol', symbol: 'sign.exit', at: [3000, 960] },
  { tool: 'symbol', symbol: 'sign.speed-limit', at: [1000, 1820], text: '20' },
  { tool: 'symbol', symbol: 'sign.stop', at: [2400, 1780] },
  { tool: 'symbol', symbol: 'sign.crosswalk', at: [1640, 1810] },
  { tool: 'symbol', symbol: 'sign.extinguisher', at: [2075, 1030] },
  { tool: 'label', text: 'EXEMPLE ILLUSTRATIF — À VALIDER SUR LE TERRAIN', at: [1900, 330] },
  { tool: 'label', text: 'Route du sud (exemple)', at: [1250, 1830] },
  { tool: 'label', text: 'Corridor piéton (exemple)', at: [1390, 1330] },
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
await page.getByLabel('Nom du plan').fill('Circulation — exemple illustratif (Phase 4)');
await page.getByRole('button', { name: 'Créer' }).click();
await page.getByTestId('import-input').setInputFiles(photo);
await Promise.race([
  page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 }),
  page
    .getByRole('button', { name: 'Ouvrir quand même' })
    .click({ timeout: 120_000 })
    .catch(() => {}),
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
const planId = (await readStored(page)).id;
// Tracé à 30 %, vue d'ensemble du camp et de ses routes.
await setView(planId, 1800, 1400, 0.3);

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
async function setField(label, value) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(String(value));
  await field.press('Enter');
  await field.blur(); // comme un clic ailleurs : le clavier revient au plan
}

async function draw(a) {
  if (a.tool === 'flow') {
    await page.keyboard.press('f');
    await page.locator(`[data-flow-category="${a.category}"]`).click();
  } else if (a.tool === 'corridor') await page.keyboard.press('c');
  else if (a.tool === 'zone') await page.locator(`[data-preset="${a.preset}"]`).click();
  else if (a.tool === 'symbol') {
    await page.keyboard.press('s');
    await page.locator(`[data-symbol="${a.symbol}"]`).click();
  } else {
    // Étiquette : créée au zoom de travail (60 %), taille lisible sans masquer les bâtiments.
    await setView(planId, a.at[0], a.at[1], 0.6);
    await page.keyboard.press('g');
  }

  if (a.tool === 'zone') {
    const [s, e] = [await toScreen(a.points[0]), await toScreen(a.points[1])];
    await page.mouse.move(...s);
    await page.mouse.down();
    await page.mouse.move(...e, { steps: 8 });
    await page.mouse.up();
  } else if (a.tool === 'flow' || a.tool === 'corridor') {
    for (const p of a.points) await page.mouse.click(...(await toScreen(p)));
    await page.keyboard.press('Enter');
  } else {
    await page.mouse.click(...(await toScreen(a.at)));
    if (a.tool === 'label') {
      await page.getByTestId('text-editor').fill(a.text);
      await page.keyboard.press('Enter');
    }
  }
  await page.getByRole('tab', { name: 'Propriétés' }).click();
  if (a.name) await setField('Nom', a.name);
  if (a.direction && a.direction !== 'forward')
    await page.getByLabel('Sens de circulation').selectOption(a.direction);
  if (a.width) await setField('Largeur (px image)', a.width);
  if (a.oriented) await page.getByLabel('Orientés dans le sens du déplacement').check();
  if (a.tool === 'symbol' && a.text) await setField('Texte affiché', a.text);
  await page.keyboard.press('Escape');
}

for (const a of PLAN) await draw(a);

// Analyse des croisements : le corridor vers l'aire sud traverse la route.
await page.getByRole('tab', { name: 'Analyse' }).click();
await page.getByLabel('Afficher les croisements sur le plan').check();
const crossingText = await page.getByTestId('crossing-count').textContent();
await page.getByTestId('crossing-item').first().click();
await page.getByRole('button', { name: 'Point de vigilance' }).click();
await page.getByLabel('Note').fill('Exemple : passage piéton balisé à étudier sur le terrain.');
await page.getByLabel('Note').blur();
await waitSaved();

const before = (await readStored(page)).document;
const objects = Object.values(before.objects);
const layerName = (id) => before.layers.find((l) => l.id === id)?.name;
console.log(`Objets créés : ${objects.length} · calques : ${before.layers.map((l) => l.name).join(', ')}`);
console.table(
  objects
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((o) => ({
      nom: o.name,
      type: o.type,
      calque: layerName(o.layerId),
      sommets: o.geometry.points?.length ?? '',
    })),
);
console.log(
  `Analyse : ${crossingText} ; décisions enregistrées : ${JSON.stringify(before.crossingReviews.map((r) => ({ status: r.status, note: r.note })))}`,
);

// Captures : plan complet (panneau Calques), puis gros plan d'un trajet et de ses propriétés.
await setView(planId, 1800, 1400, 0.3);
await page.getByRole('tab', { name: 'Calques' }).click();
await page.waitForTimeout(6500); // laisse disparaître la notification « hors ligne »
await page.screenshot({ path: `${outDir}/camp105-phase4-plan-complet.png` });

await setView(planId, 1850, 1560, 0.9);
await page.getByRole('tab', { name: 'Calques' }).click();
await page.getByRole('button', { name: 'Livraison — accès à la cuisine (exemple)', exact: true }).click();
await page.getByRole('tab', { name: 'Propriétés' }).click();
// Panneau positionné sur la section « Trajet » (catégorie, sens, flèches).
await page.locator('#right-panel-content').evaluate((panel) => {
  const title = [...panel.querySelectorAll('h3')].find((h) => h.textContent === 'Trajet');
  if (title) panel.scrollTop += title.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/camp105-phase4-trajet-proprietes.png` });

await page.getByRole('tab', { name: 'Analyse' }).click();
await page.getByLabel('Afficher les croisements sur le plan').check();
await page.getByTestId('crossing-item').first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/camp105-phase4-analyse.png` });

// Rouvrir : identique.
await page.reload();
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const reopened = (await readStored(page)).document;
const same = ['objects', 'layers', 'crossingReviews', 'assets'].every((k) =>
  isDeepStrictEqual(reopened[k], before[k]),
);
console.log(`Réouverture : ${same ? 'IDENTIQUE (objets, calques, croisements)' : 'DIFFÉRENCES'}`);

// Attache au même pixel de la photo : premier sommet (ou centre) de chaque objet, à chaque zoom.
function anchorOf(o) {
  const g = o.geometry;
  if (g.points) return { local: g.points[0], image: g.points[0], rotated: o.rotation !== 0 };
  if (g.kind === 'rect') return { local: null, image: { x: g.x + g.width / 2, y: g.y + g.height / 2 } };
  return { local: null, image: { x: g.x, y: g.y } };
}
let worst = 0;
let checks = 0;
for (const zoom of ZOOMS) {
  await setView(planId, 1800, 1400, zoom);
  await page.waitForFunction(
    (n) => window.Konva.stages[0]?.find('.plan-object').length === n,
    objects.length,
  );
  for (const o of objects) {
    const a = anchorOf(o);
    const shown = await page.evaluate(
      ({ id, local }) => {
        const s = window.Konva.stages[0];
        const n = s.findOne(`#${id}`);
        const p = local ? n.getAbsoluteTransform().point(local) : n.getAbsolutePosition();
        return { p, t: { x: s.x(), y: s.y(), scale: s.scaleX() } };
      },
      { id: o.id, local: a.local },
    );
    const error = Math.hypot(
      shown.p.x - (a.image.x * shown.t.scale + shown.t.x),
      shown.p.y - (a.image.y * shown.t.scale + shown.t.y),
    );
    worst = Math.max(worst, error);
    checks++;
  }
}
console.log(
  `Attache : ${checks} vérifications (${ZOOMS.length} zooms), écart maximal ${worst.toFixed(4)} px écran`,
);

// Export .campplan.
await setView(planId, 1800, 1400, 0.3);
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
]);
const archive = join(outDir, 'camp-105-phase4-demo.campplan');
await download.saveAs(archive);
const bytes = readFileSync(archive);
const entries = unzipSync(new Uint8Array(bytes));
const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
const photoEntry = manifest.files.find((f) => f.role === 'background');
console.log(
  `Archive : ${(bytes.length / 1e6).toFixed(2)} Mo · format v${manifest.formatVersion}, schéma ${manifest.schemaVersion} · ` +
    `photo ${photoEntry?.sha256 === photoSha ? '= original (SHA-256 identique)' : 'DIFFÉRENTE'}`,
);

// Réimport dans un navigateur au stockage VIDE (chemin ASCII : Chromium ignore les accents).
const asciiCopy = join(tmpdir(), `camp105-p4-${Date.now()}.campplan`);
copyFileSync(archive, asciiCopy);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const fresh = await context.newPage();
await fresh.goto(APP);
await fresh.getByText('Aucun camp pour l’instant').waitFor();
await fresh.getByTestId('campplan-input').setInputFiles(asciiCopy);
await fresh.getByTestId('import-verified').waitFor({ timeout: 60_000 });
await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
await fresh.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const imported = (await readStored(fresh)).document;
const identical = ['objects', 'layers', 'crossingReviews'].every((k) =>
  isDeepStrictEqual(imported[k], before[k]),
);
await fresh.getByRole('tab', { name: 'Fond' }).click();
await fresh.getByRole('button', { name: 'Vérifier l’intégrité' }).click();
await fresh.getByTestId('integrity-ok').waitFor({ timeout: 60_000 });
const importedSha = await fresh.getByTestId('bg-sha256').textContent();
const [original] = await Promise.all([
  fresh.waitForEvent('download'),
  fresh.getByRole('button', { name: 'Télécharger l’original' }).click(),
]);
const originalSha = sha(readFileSync(await original.path()));
// Toujours modifiable après réimport : largeur d'un corridor changée depuis le panneau.
await fresh.getByRole('tab', { name: 'Calques' }).click();
await fresh.getByRole('button', { name: 'Corridor dortoirs → cuisine (exemple)', exact: true }).click();
await fresh.getByRole('tab', { name: 'Propriétés' }).click();
await fresh.getByLabel('Largeur (px image)').fill('48');
await fresh.getByLabel('Largeur (px image)').press('Enter');
await fresh
  .getByTestId('save-status')
  .filter({ hasText: /^Enregistré$/ })
  .waitFor({ timeout: 30_000 });
const editedWidth = Object.values((await readStored(fresh)).document.objects).find(
  (o) => o.name === 'Corridor dortoirs → cuisine (exemple)',
).width;
await context.close();
await browser.close();

const report = {
  objets: objects.length,
  types: objects.reduce((acc, o) => ({ ...acc, [o.type]: (acc[o.type] ?? 0) + 1 }), {}),
  calques: before.layers.map((l) => l.name),
  analyse: crossingText,
  reouvertureIdentique: same,
  attache: { verifications: checks, ecartMaxPxEcran: worst },
  archive: {
    octets: bytes.length,
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
  },
  reimport: {
    identique: identical,
    shaFond: importedSha,
    shaOriginalTelecharge: originalSha,
    largeurModifiee: editedWidth,
  },
  shaPhotoSource: photoSha,
  shaPhotoSourceApres: sha(readFileSync(photo)),
};
writeFileSync(join(outDir, 'camp105-phase4-rapport.json'), JSON.stringify(report, null, 2));
console.log(
  `Réimport (stockage vide) : ${identical ? 'IDENTIQUE' : 'DIFFÉRENT'} · SHA fond ${importedSha === photoSha ? 'IDENTIQUE' : 'DIFFÉRENT'} · ` +
    `original téléchargé ${originalSha === photoSha ? 'IDENTIQUE' : 'DIFFÉRENT'} · toujours modifiable : largeur ${editedWidth}`,
);
console.log(`Photo source inchangée : ${report.shaPhotoSourceApres === photoSha ? 'oui' : 'NON'}`);
if (
  !same ||
  !identical ||
  worst > 0.5 ||
  importedSha !== photoSha ||
  originalSha !== photoSha ||
  editedWidth !== 48
)
  process.exit(1);
