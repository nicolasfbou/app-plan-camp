/**
 * Performance de l'éditeur avec N objets sur une vraie photo (100, 500, 1 000 par défaut).
 * Prérequis : `npm run build && npx vite preview --port 4178`.
 * Usage : node bench/objects-performance.mjs <image> [N1,N2,...]
 * MIX=phase4 : ajoute au mélange des trajets de véhicules (40 sommets, flèches), des corridors
 * piétons (20 sommets, pictogrammes) et des pictogrammes.
 *
 * Les objets (rectangles, ellipses, polygones, polylignes, étiquettes) sont écrits directement
 * dans le plan enregistré, puis le plan est rouvert. Mesures : ouverture, RAM Chromium, fluidité
 * du déplacement de la vue, du zoom molette et du glisser d'un objet, temps de sélection.
 * Chromium sans GPU : mesures de référence de cet environnement, pas une garantie.
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const [imagePath, countsArg] = process.argv.slice(2);
const counts = (countsArg ?? '100,500,1000').split(',').map(Number);
const executablePath = process.env.PW_CHROMIUM_PATH;
const APP = process.env.APP_URL ?? 'http://localhost:4178/';

const rssMb = () =>
  Math.round(
    execSync("ps -eo rss,comm | grep -Ei 'chrome|headless_shell' || true")
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]) / 1024, 0),
  );

function makeObjects(n, layers, width, height) {
  const now = new Date().toISOString();
  const layer = (tier) => layers.find((l) => l.tier === tier).id;
  const style = (color, fill = true) => ({
    fill: fill ? color : null,
    fillOpacity: 0.3,
    stroke: color,
    strokeOpacity: 1,
    strokeWidth: 12,
    dash: 'dashed',
    pattern: 'none',
  });
  const cols = Math.ceil(Math.sqrt(n * (width / height)));
  const cell = width / cols;
  const objects = {};
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * cell + cell * 0.1;
    const y = Math.floor(i / cols) * cell + cell * 0.1;
    const s = cell * 0.7;
    const id = `bench-${i}`;
    const base = {
      groupId: null,
      id,
      name: `Objet ${i}`,
      presetId: null,
      rotation: (i * 7) % 30,
      visible: true,
      locked: false,
      zIndex: i,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    const kind = i % (process.env.MIX === 'phase4' ? 8 : 5);
    const zigzag = (count, amplitude) =>
      Array.from({ length: count }, (_, k) => ({
        x: x + (s * k) / (count - 1),
        y: y + (k % 2 ? amplitude : 0) + s * 0.1,
      }));
    if (kind === 5) {
      objects[id] = {
        ...base,
        type: 'flow',
        layerId: layer('circulation'),
        style: style('#1d4ed8', false),
        geometry: { kind: 'polyline', curved: false, points: zigzag(40, s * 0.3) },
        category: 'general',
        arrows: { direction: i % 3 ? 'forward' : 'both', visible: true, size: s * 0.08, spacing: s * 0.2 },
      };
      continue;
    }
    if (kind === 6) {
      objects[id] = {
        ...base,
        type: 'corridor',
        layerId: layer('pedestrians'),
        style: { ...style('#f97316'), dash: 'dashed' },
        geometry: { kind: 'polyline', curved: false, points: zigzag(20, s * 0.4) },
        width: s * 0.1,
        showIcons: true,
        iconSpacing: s * 0.3,
        iconSize: s * 0.08,
        iconsOriented: i % 2 === 0,
      };
      continue;
    }
    if (kind === 7) {
      const symbols = [
        'sign.stop',
        'sign.parking',
        'sign.pedestrian',
        'sign.extinguisher',
        'sign.speed-limit',
      ];
      objects[id] = {
        ...base,
        type: 'icon',
        layerId: layer('signage'),
        style: { ...style('#000000'), fillOpacity: 1 },
        geometry: { kind: 'point', x: x + s / 2, y: y + s / 2 },
        symbolId: symbols[i % symbols.length],
        size: s * 0.4,
        text: i % symbols.length === 4 ? '20' : null,
      };
      continue;
    }
    if (kind === 0)
      objects[id] = {
        ...base,
        type: 'zone',
        layerId: layer('zones'),
        style: style('#2563eb'),
        geometry: { kind: 'rect', x, y, width: s, height: s * 0.6, cornerRadius: 0 },
        icon: process.env.MIX === 'phase4' ? { symbolId: 'sign.parking', size: s * 0.25 } : null,
        showName: process.env.MIX === 'phase4',
      };
    else if (kind === 1)
      objects[id] = {
        ...base,
        type: 'zone',
        layerId: layer('zones'),
        style: style('#f97316'),
        geometry: { kind: 'ellipse', cx: x + s / 2, cy: y + s / 2, rx: s / 2, ry: s / 3 },
        icon: null,
        showName: false,
      };
    else if (kind === 2)
      objects[id] = {
        ...base,
        type: 'building',
        layerId: layer('buildings'),
        style: style('#334155'),
        geometry: {
          kind: 'polygon',
          points: [
            { x, y },
            { x: x + s, y },
            { x: x + s, y: y + s * 0.7 },
            { x: x + s * 0.4, y: y + s },
          ],
        },
      };
    else if (kind === 3)
      objects[id] = {
        ...base,
        type: 'line',
        layerId: layer('circulation'),
        style: style('#dc2626', false),
        geometry: {
          kind: 'polyline',
          curved: false,
          points: [
            { x, y },
            { x: x + s * 0.5, y: y + s * 0.8 },
            { x: x + s, y: y + s * 0.2 },
          ],
        },
      };
    else
      objects[id] = {
        ...base,
        type: 'text',
        layerId: layer('texts'),
        style: { ...style('#0f172a'), fillOpacity: 1 },
        geometry: { kind: 'point', x: x + s / 2, y: y + s / 2 },
        text: `DORTOIR ${i}`,
        fontFamily: 'Inter, Arial, sans-serif',
        fontSize: s * 0.12,
        fontWeight: 'bold',
        italic: false,
        align: 'center',
        label: {
          background: '#ffffff',
          backgroundOpacity: 0.9,
          border: '#0f172a',
          borderWidth: 2,
          padding: 6,
          cornerRadius: 4,
        },
      };
  }
  return objects;
}

async function frameStats(page, action) {
  await page.evaluate(() => {
    window.__frames = [];
    window.__stop = false;
    let last = performance.now();
    const loop = (now) => {
      window.__frames.push(now - last);
      last = now;
      if (!window.__stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await action();
  const frames = await page.evaluate(() => {
    window.__stop = true;
    return window.__frames.slice(2);
  });
  frames.sort((a, b) => a - b);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  return { avg, p95: frames[Math.floor(frames.length * 0.95)], fps: 1000 / avg };
}

const rows = [];
for (const n of counts) {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(APP);
  await page.getByRole('button', { name: 'Nouveau camp' }).click();
  await page.getByLabel('Nom du camp').fill('Camp');
  await page.getByRole('button', { name: 'Créer' }).click();
  await page.getByRole('button', { name: 'Nouveau plan' }).click();
  await page.getByRole('button', { name: 'Créer' }).click();
  await page.getByTestId('import-input').setInputFiles(imagePath);
  // Très grande image : l'application demande confirmation avant de l'ouvrir.
  await Promise.race([
    page.getByTestId('navigation-controls').waitFor({ timeout: 180_000 }),
    page
      .getByRole('button', { name: 'Ouvrir quand même' })
      .click({ timeout: 180_000 })
      .catch(() => {}),
  ]);
  await page.getByTestId('navigation-controls').waitFor({ timeout: 180_000 });
  await page
    .getByTestId('save-status')
    .filter({ hasText: /^Enregistré$/ })
    .waitFor();

  // Injection des objets dans le plan enregistré.
  const planRecord = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('campplanner');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('plans').objectStore('plans').getAll();
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            resolve(get.result[0]);
            open.result.close();
          };
        };
      }),
  );
  const doc = planRecord.document;
  doc.objects = makeObjects(n, doc.layers, doc.plan.baseImage.width, doc.plan.baseImage.height);
  await page.evaluate(
    (record) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('campplanner');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('plans', 'readwrite');
          tx.objectStore('plans').put(record);
          tx.oncomplete = () => {
            resolve();
            open.result.close();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    planRecord,
  );

  let t = Date.now();
  await page.reload();
  await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
  await page.waitForFunction((n) => window.Konva.stages[0]?.find('.plan-object').length === n, n);
  const openMs = Date.now() - t;
  await page.keyboard.press('0');
  await page.waitForTimeout(1000);
  const ram = rssMb();

  const box = await page.getByTestId('canvas-container').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Déplacement de la vue (outil Main).
  await page.keyboard.press('h');
  const pan = await frameStats(page, async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++)
      await page.mouse.move(cx + Math.sin(i / 6) * 200, cy + Math.cos(i / 6) * 120);
    await page.mouse.up();
  });
  await page.keyboard.press('0');

  // Zoom molette.
  const zoom = await frameStats(page, async () => {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, i < 10 ? -100 : 100);
    await page.waitForTimeout(200);
  });
  await page.keyboard.press('0');
  await page.keyboard.press('v');
  // Attendre la fin de l'animation « adapter » : la cible doit être mesurée sur une vue stable.
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const s = window.Konva.stages[0];
        const a = [s.x(), s.y(), s.scaleX()].join();
        setTimeout(() => resolve(a === [s.x(), s.y(), s.scaleX()].join()), 200);
      }),
  );

  // Sélection (clic) puis glisser d'un objet.
  const target = await page.evaluate(() => {
    const node = window.Konva.stages[0].findOne('#bench-0');
    const r = node.getClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  t = await page.evaluate(() => performance.now());
  await page.mouse.click(box.x + target.x, box.y + target.y);
  await page.getByTestId('properties-panel').waitFor();
  const selectMs = (await page.evaluate(() => performance.now())) - t;
  const drag = await frameStats(page, async () => {
    await page.mouse.move(box.x + target.x, box.y + target.y);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++)
      await page.mouse.move(box.x + target.x + i * 3, box.y + target.y + Math.sin(i / 5) * 40);
    await page.mouse.up();
  });

  const after = await page.evaluate(() => window.Konva.stages[0].findOne('#bench-0').getClientRect());
  if (Math.abs(after.x + after.width / 2 - target.x) < 100)
    throw new Error("L'objet n'a pas été déplacé : mesure invalide.");
  rows.push({
    objets: n,
    'ouverture (ms)': openMs,
    'RAM (Mo)': ram,
    'vue : ips (p95 ms)': `${pan.fps.toFixed(0)} (${pan.p95.toFixed(0)})`,
    'zoom : ips (p95 ms)': `${zoom.fps.toFixed(0)} (${zoom.p95.toFixed(0)})`,
    'glisser objet : ips (p95 ms)': `${drag.fps.toFixed(0)} (${drag.p95.toFixed(0)})`,
    'sélection (ms)': Math.round(selectMs),
  });
  await browser.close();
}
console.log(`Photo : ${imagePath}`);
console.table(rows);
