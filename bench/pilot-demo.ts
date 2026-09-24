/**
 * Déploiement pilote — projet de démonstration Camp 105 : COPIE du projet de la phase 7, produite
 * avec les fonctions de l'application (import, duplication, export), jamais par édition à la main.
 *
 *   npx tsx --tsconfig server/tsconfig.json bench/pilot-demo.ts <source.campplan> <photo> <sortie.campplan>
 *
 * - La photo d'origine est seulement LUE : son SHA-256 est vérifié avant, après, et dans la copie.
 * - Le plan est marqué « EXEMPLE ILLUSTRATIF — À VALIDER SUR LE TERRAIN » ; son statut est
 *   « À valider sur le terrain », JAMAIS « Approuvé » ; aucune révision n'est reprise.
 * - Aucune échelle, aucune orientation n'est ajoutée (le plan source n'en a pas).
 */
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { duplicatePlanDocument } from '@/domain/model/factories.ts';
import { exportCampplan, importCampplan, readCampplan } from '@/persistence/campplan.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';

const [source, photo, output] = process.argv.slice(2);
if (!source || !photo || !output)
  throw new Error('Usage : pilot-demo.ts <source.campplan> <photo> <sortie.campplan>');

const MENTION = 'EXEMPLE ILLUSTRATIF — À VALIDER SUR LE TERRAIN';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const photoBefore = sha(readFileSync(photo));

const repo = new IndexedDbRepository(`pilote-${Date.now()}`);
const content = await readCampplan(new Uint8Array(readFileSync(source)));
const imported = await importCampplan(repo, content, {
  target: { kind: 'new-site', name: 'Camp 105 — pilote' },
  mode: 'copy',
  planName: content.doc.plan.name,
});
const original = (await repo.openPlan(imported.planId))!.doc;
const copy = duplicatePlanDocument(original, `Camp 105 — ${MENTION}`);
copy.plan.titleBlock = {
  ...copy.plan.titleBlock,
  title: `Plan de circulation — ${MENTION}`,
  status: 'field-validation',
  approvedBy: '',
  approvedAt: null,
  checkedBy: '',
  revision: '',
  preparedBy: 'CampPlanner — déploiement pilote',
  notes: `${MENTION}. Les positions des zones, trajets, corridors et stationnements sont des exemples de test, pas un plan de circulation approuvé. Aucune échelle ni orientation : la calibration et le nord réels ne sont pas connus.`,
};
await repo.savePlan(copy);
const exported = await exportCampplan(repo, copy.plan.id);
writeFileSync(output, exported.bytes);

// Vérification de la copie relue depuis le fichier produit.
const check = await readCampplan(new Uint8Array(readFileSync(output)));
const photoInCopy = [...check.files.values()].find((f) => f.mimeType === 'image/jpeg');
const report = {
  fichier: output,
  plan: check.doc.plan.name,
  titre: check.doc.plan.titleBlock.title,
  statut: check.doc.plan.titleBlock.status,
  approuve: check.doc.plan.titleBlock.status === 'approved' || check.doc.plan.titleBlock.approvedAt !== null,
  revisions: check.revisions.length,
  objets: Object.keys(check.doc.objects).length,
  nord: check.doc.plan.northStatus,
  calibration: check.doc.plan.calibration ?? null,
  photoOriginaleAvant: photoBefore,
  photoOriginaleApres: sha(readFileSync(photo)),
  photoDansLaCopie: photoInCopy ? sha(photoInCopy.bytes) : null,
};
console.log(JSON.stringify(report, null, 2));
const ok =
  report.photoOriginaleAvant === report.photoOriginaleApres &&
  report.photoDansLaCopie === report.photoOriginaleAvant &&
  !report.approuve &&
  report.revisions === 0 &&
  report.plan.includes(MENTION);
if (!ok) throw new Error('Copie de démonstration non conforme.');
