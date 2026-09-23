/**
 * Mesures de performance des révisions (exécutées seulement avec PERF=1) :
 *   PERF=1 PERF_OUT=<dossier> npx vitest run src/domain/revisions/revisions.perf.test.ts
 * 5, 10 et 20 révisions de 300 et 600 objets : création, liste (métadonnées seulement),
 * chargement d'un instantané, comparaison première ↔ dernière, export et import `.campplan`.
 * Avec PERF_OUT : écrit les mesures (JSON) et un `.campplan` de 20 révisions × 600 objets.
 */
import { describe, expect, it } from 'vitest';
import { createSite } from '@/domain/model/factories.ts';
import { exportCampplan, importCampplan, readCampplan } from '@/persistence/campplan.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { createRevisionFromDraft, revisionMetas } from '@/persistence/revisions.ts';
import { makeLargeDocument } from '@/test/fixtures.ts';
import { diffPlans } from './diff.ts';
import { nextRevisionLabel } from './revision.ts';

// Environnement Node du lanceur de tests (sans dépendre des types Node dans l'application).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const writeFile = async (name: string, data: Uint8Array | string) => {
  const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as {
    writeFileSync(path: string, data: Uint8Array | string): void;
  };
  fs.writeFileSync(`${env.PERF_OUT}/${name}`, data);
};

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;

describe.skipIf(!env.PERF)('performance des révisions', () => {
  it('5, 10, 20 révisions × 300 et 600 objets', async () => {
    const results: Record<string, unknown>[] = [];
    for (const objects of [300, 600])
      for (const count of [5, 10, 20]) {
        const repo = new IndexedDbRepository(`perf-${crypto.randomUUID()}`);
        const site = createSite('Camp perf');
        await repo.saveSite(site);
        const doc = makeLargeDocument(objects);
        doc.plan.siteId = site.id;
        await repo.savePlan(doc);
        const creation: number[] = [];
        for (let i = 0; i < count; i++) {
          // Chaque révision : quelques objets déplacés et renommés (brouillon qui évolue).
          for (const o of Object.values(doc.objects).slice(i * 5, i * 5 + 5)) {
            if (o.geometry.kind === 'point') o.geometry.x += 12;
            else if (o.geometry.kind === 'rect') o.geometry.x += 12;
            o.name = `${o.name} (r${i})`;
          }
          await repo.savePlan(doc);
          const labels = (await revisionMetas(repo, doc.plan.id)).map((m) => m.label);
          const t0 = performance.now();
          await createRevisionFromDraft(repo, doc, {
            label: nextRevisionLabel(labels),
            description: `Révision ${i + 1}`,
            author: 'Banc d’essai',
            date: '2026-10-01',
            reason: '',
            comments: '',
            status: 'review',
          });
          creation.push(ms(t0));
        }
        let t0 = performance.now();
        const list = await repo.listRevisions(doc.plan.id);
        const listMs = ms(t0);
        t0 = performance.now();
        const first = await repo.loadRevision(list[0]!.id);
        const loadMs = ms(t0);
        const last = await repo.loadRevision(list.at(-1)!.id);
        t0 = performance.now();
        const diff = diffPlans(first.doc, last.doc);
        const diffMs = ms(t0);
        t0 = performance.now();
        const { bytes } = await exportCampplan(repo, doc.plan.id);
        const exportMs = ms(t0);
        const empty = new IndexedDbRepository(`perf-${crypto.randomUUID()}`);
        t0 = performance.now();
        const content = await readCampplan(bytes);
        const { planId } = await importCampplan(empty, content, {
          target: { kind: 'new-site', name: 'Camp perf' },
          mode: 'copy',
          planName: 'Plan',
        });
        const importMs = ms(t0);
        expect(await revisionMetas(empty, planId)).toHaveLength(count);
        empty.close();
        const metaBytes = JSON.stringify(list.map((e) => e.meta)).length;
        const row = {
          objets: objects,
          revisions: count,
          creationMoyenneMs: Math.round((creation.reduce((a, b) => a + b, 0) / count) * 10) / 10,
          creationDerniereMs: creation.at(-1),
          listeMs: listMs,
          metadonneesListeesOctets: metaBytes,
          instantaneOctets: list[0]!.meta!.snapshot.byteLength,
          chargementInstantaneMs: loadMs,
          comparaisonPremiereDerniereMs: diffMs,
          changementsDetectes: diff.counts.user,
          exportCampplanMs: exportMs,
          campplanOctets: bytes.length,
          importNavigateurVideMs: importMs,
        };
        results.push(row);
        console.info(JSON.stringify(row));
        if (env.PERF_OUT && objects === 600 && count === 20)
          await writeFile('perf-20-revisions-600-objets.campplan', bytes);
        repo.close();
      }
    if (env.PERF_OUT) await writeFile('perf-revisions.json', JSON.stringify(results, null, 2));
    // Lister ne lit que les métadonnées : bien plus petit que les instantanés.
    for (const r of results)
      expect(r.metadonneesListeesOctets as number).toBeLessThan(
        (r.instantaneOctets as number) * (r.revisions as number),
      );
  }, 600_000);
});
