import { AlertTriangle, FileWarning } from 'lucide-react';
import { useEffect, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { navigate } from '@/app/router.ts';
import { formatBytes } from '@/domain/image/sizeAssessment.ts';
import type { Site } from '@/domain/model/types.ts';
import { formatDateTime, formatInteger, t } from '@/i18n/index.ts';
import {
  availablePlanName,
  type CampplanContent,
  CampplanError,
  importCampplan,
  readCampplan,
} from '@/persistence/campplan.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';

type State =
  | { kind: 'reading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      content: CampplanContent;
      sites: Site[];
      existing: { name: string; siteId: string; siteName: string } | null;
    };

const NEW_SITE = '__new__';

/**
 * Import d'un projet `.campplan`. Le fichier est entièrement vérifié AVANT toute écriture. Un plan
 * déjà présent n'est jamais écrasé en silence : par défaut une copie est créée ; le remplacement
 * exige un choix explicite et une case de confirmation.
 */
export function ImportProjectDialog({ file, onClose }: { file: File; onClose(): void }) {
  const [state, setState] = useState<State>({ kind: 'reading' });
  const [siteChoice, setSiteChoice] = useState<string>(NEW_SITE);
  const [planName, setPlanName] = useState('');
  const [mode, setMode] = useState<'copy' | 'replace'>('copy');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const content = await readCampplan(new Uint8Array(await file.arrayBuffer()));
      const sites = await repository.listSites();
      // Lu sans validation : même un plan existant illisible est signalé (jamais écrasé en silence).
      const summary = await repository.getPlanSummary(content.doc.plan.id);
      const existing = summary
        ? {
            name: summary.name,
            siteId: summary.siteId,
            siteName: sites.find((s) => s.id === summary.siteId)?.name ?? '',
          }
        : null;
      if (cancelled) return;
      const sameName = sites.find((s) => s.name === content.manifest.site.name);
      setSiteChoice(sameName?.id ?? NEW_SITE);
      setState({ kind: 'ready', content, sites, existing });
    })().catch((e: unknown) => {
      if (!cancelled)
        setState({ kind: 'error', message: e instanceof CampplanError ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Nom proposé : celui du fichier, rendu distinct s'il existe déjà dans le camp choisi.
  useEffect(() => {
    if (state.kind !== 'ready') return;
    let cancelled = false;
    const base = state.content.doc.plan.name;
    (siteChoice === NEW_SITE ? Promise.resolve([]) : repository.listPlans(siteChoice)).then((plans) => {
      if (!cancelled)
        setPlanName(
          mode === 'replace'
            ? base
            : availablePlanName(
                base,
                plans.map((p) => p.name),
              ),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [state, siteChoice, mode]);

  if (state.kind === 'reading') {
    return (
      <Modal open title={t('campplan.import.title')} onClose={() => undefined}>
        <p role="status">{t('campplan.import.reading')}</p>
      </Modal>
    );
  }
  if (state.kind === 'error') {
    return (
      <Modal
        open
        title={t('campplan.import.errorTitle')}
        onClose={onClose}
        footer={<Button onClick={onClose}>{t('common.close')}</Button>}
      >
        <p role="alert" className="flex gap-2 text-red-800">
          <FileWarning size={18} className="shrink-0" aria-hidden />
          {state.message}
        </p>
      </Modal>
    );
  }

  const { content, sites, existing } = state;
  const { manifest, doc } = content;
  const image = doc.plan.baseImage;
  const replacing = mode === 'replace' && existing !== null;
  const canSubmit = planName.trim() !== '' && (mode === 'copy' || confirmReplace) && !busy;

  const run = () =>
    submit(async () => {
      const { siteId, planId } = await importCampplan(repository, content, {
        target:
          siteChoice === NEW_SITE
            ? { kind: 'new-site', name: manifest.site.name || t('campplan.import.defaultSite') }
            : { kind: 'existing-site', siteId: siteChoice },
        mode,
        planName: planName.trim(),
      });
      onClose();
      navigate({ name: 'plan', siteId, planId });
    });

  return (
    <Modal
      open
      wide
      title={t('campplan.import.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={mode === 'replace' ? 'danger' : 'primary'}
            disabled={!canSubmit}
            onClick={() => void run()}
          >
            {mode === 'replace' ? t('campplan.import.replaceAction') : t('campplan.import.action')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="import-project">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-slate-50 p-3">
          <dt className="text-slate-500">{t('campplan.import.site')}</dt>
          <dd className="font-medium">{manifest.site.name || '—'}</dd>
          <dt className="text-slate-500">{t('campplan.import.plan')}</dt>
          <dd className="font-medium">{doc.plan.name}</dd>
          <dt className="text-slate-500">{t('campplan.import.content')}</dt>
          <dd>
            {t('campplan.import.counts', {
              objects: formatInteger(manifest.counts.objects),
              layers: manifest.counts.layers,
            })}
          </dd>
          <dt className="text-slate-500">{t('campplan.import.photo')}</dt>
          <dd>
            {image
              ? `${image.fileName} · ${formatInteger(image.width)} × ${formatInteger(image.height)} px · ${formatBytes(image.byteLength)}`
              : t('bg.empty')}
          </dd>
          <dt className="text-slate-500">{t('campplan.import.revisions')}</dt>
          <dd data-testid="import-revisions">
            {content.revisions.length
              ? content.revisions.map((r) => r.meta.label).join(', ')
              : t('campplan.import.noRevisions')}
          </dd>
          <dt className="text-slate-500">{t('campplan.import.exportedAt')}</dt>
          <dd>{formatDateTime(manifest.exportedAt)}</dd>
        </dl>
        <p className="text-xs text-emerald-700" data-testid="import-verified">
          {t('campplan.import.verified')}
        </p>

        <label className="block">
          <span className="mb-1 block font-medium text-slate-800">{t('campplan.import.destination')}</span>
          <select
            // Un remplacement reste dans le camp du plan remplacé.
            value={replacing && existing ? existing.siteId : siteChoice}
            disabled={replacing}
            onChange={(e) => setSiteChoice(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2"
          >
            <option value={NEW_SITE}>
              {t('campplan.import.newSite', { name: manifest.site.name || t('campplan.import.defaultSite') })}
            </option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {replacing && existing && (
            <span className="mt-1 block text-xs text-slate-600">
              {t('campplan.import.replaceSite', { site: existing.siteName })}
            </span>
          )}
        </label>

        {existing && (
          <fieldset className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
            <legend className="flex items-center gap-1 px-1 font-medium text-amber-900">
              <AlertTriangle size={16} aria-hidden />{' '}
              {t('campplan.import.exists', { name: existing.name, site: existing.siteName })}
            </legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="import-mode"
                checked={mode === 'copy'}
                onChange={() => setMode('copy')}
              />
              {t('campplan.import.asCopy')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="import-mode"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
              />
              {t('campplan.import.replace')}
            </label>
            {mode === 'replace' && (
              <label className="flex items-center gap-2 text-red-800">
                <input
                  type="checkbox"
                  checked={confirmReplace}
                  onChange={(e) => setConfirmReplace(e.target.checked)}
                />
                {t('campplan.import.confirmReplace')}
              </label>
            )}
          </fieldset>
        )}

        <label className="block">
          <span className="mb-1 block font-medium text-slate-800">{t('plans.name')}</span>
          <input
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
