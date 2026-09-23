import {
  Copy,
  Download,
  GitBranch,
  LayoutTemplate,
  Map as MapIcon,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { TemplatesDialog } from '@/app/TemplatesDialog.tsx';
import { createPlanFromTemplate } from '@/app/templateActions.ts';
import { VariantDialog } from '@/app/VariantDialog.tsx';
import { downloadBytes } from '@/app/download.ts';
import { exportCampplan } from '@/persistence/campplan.ts';
import { useState } from 'react';
import { createPlanDocument, duplicatePlanDocument, nowIso } from '@/domain/model/factories.ts';
import type { StoredTemplate } from '@/persistence/ProjectRepository.ts';
import { PLAN_KINDS } from '@/domain/model/schema.ts';
import type { PlanKind } from '@/domain/model/types.ts';
import { formatDateTime, t } from '@/i18n/index.ts';
import type { PlanSummary } from '@/persistence/ProjectRepository.ts';
import { repository } from '@/app/repository.ts';
import { navigate, routeHref } from '@/app/router.ts';
import { Button } from '@/ui/Button.tsx';
import { ProtectedDeleteDialog } from '@/revisions/ProtectedDeleteDialog.tsx';
import { IconButton } from '@/ui/IconButton.tsx';
import { TextPromptDialog } from '@/ui/TextPromptDialog.tsx';
import { ListRow } from './ListRow.tsx';
import { Notice, PageLayout } from './PageLayout.tsx';
import { useAsync } from './useAsync.ts';

type Dialog =
  | { kind: 'create' }
  | { kind: 'templates' }
  | { kind: 'rename' | 'duplicate' | 'delete' | 'variant'; plan: PlanSummary }
  | null;

async function requirePlan(id: string) {
  const doc = await repository.loadPlan(id);
  if (!doc) throw new Error(t('plans.notFound'));
  return doc;
}

export function CampPage({ siteId }: { siteId: string }) {
  const [state, reload] = useAsync(async () => {
    const site = await repository.getSite(siteId);
    return site ? { site, plans: await repository.listPlans(siteId) } : null;
  }, siteId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [kind, setKind] = useState<PlanKind>('general');
  const [templates, setTemplates] = useState<StoredTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const close = () => setDialog(null);

  const breadcrumb = (
    <a href={routeHref({ name: 'camps' })} className="hover:underline">
      {t('nav.camps')}
    </a>
  );

  if (state.status === 'loading') return null;
  if (state.status === 'error' || state.value === null) {
    return (
      <PageLayout breadcrumb={breadcrumb} title={t('plans.title')}>
        <Notice tone="error">{state.status === 'error' ? state.error.message : t('camps.notFound')}</Notice>
      </PageLayout>
    );
  }
  const { site, plans } = state.value;

  return (
    <PageLayout
      breadcrumb={breadcrumb}
      title={site.name}
      subtitle={t('plans.title')}
      action={
        <div className="flex gap-2">
          <Button onClick={() => setDialog({ kind: 'templates' })}>
            <LayoutTemplate size={16} /> {t('templates.open')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setKind('general');
              setTemplateId('');
              void repository.listTemplates().then(setTemplates);
              setDialog({ kind: 'create' });
            }}
          >
            <Plus size={16} /> {t('plans.new')}
          </Button>
        </div>
      }
    >
      {plans.length === 0 && <Notice>{t('plans.empty')}</Notice>}
      {plans.length > 0 && (
        <ul className="space-y-2" aria-label={t('plans.title')}>
          {plans.map((plan) => (
            <ListRow
              key={plan.id}
              testId="plan-row"
              href={routeHref({ name: 'plan', siteId, planId: plan.id })}
              icon={<MapIcon size={20} />}
              title={plan.name}
              subtitle={`${t(`planKind.${plan.kind}`)} · ${t('common.updatedAt', { date: formatDateTime(plan.updatedAt) })}`}
              actions={
                <>
                  <IconButton
                    label={`${t('common.rename')} ${plan.name}`}
                    onClick={() => setDialog({ kind: 'rename', plan })}
                  >
                    <Pencil size={16} />
                  </IconButton>
                  <IconButton
                    label={t('campplan.exportOf', { name: plan.name })}
                    onClick={() =>
                      void exportCampplan(repository, plan.id).then(
                        ({ bytes, fileName }) => downloadBytes(bytes, fileName, 'application/octet-stream'),
                        (e: unknown) =>
                          window.alert(
                            t('campplan.exportError', {
                              message: e instanceof Error ? e.message : String(e),
                            }),
                          ),
                      )
                    }
                  >
                    <Download size={16} />
                  </IconButton>
                  <IconButton
                    label={t('variant.rowLabel', { name: plan.name })}
                    onClick={() => setDialog({ kind: 'variant', plan })}
                  >
                    <GitBranch size={16} />
                  </IconButton>
                  <IconButton
                    label={`${t('common.duplicate')} ${plan.name}`}
                    onClick={() => setDialog({ kind: 'duplicate', plan })}
                  >
                    <Copy size={16} />
                  </IconButton>
                  <IconButton
                    label={`${t('common.delete')} ${plan.name}`}
                    onClick={() => setDialog({ kind: 'delete', plan })}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </>
              }
            />
          ))}
        </ul>
      )}

      {dialog?.kind === 'create' && (
        <TextPromptDialog
          title={t('plans.new')}
          label={t('plans.name')}
          initialValue={t(`planKind.${kind}`)}
          confirmLabel={t('common.create')}
          onCancel={close}
          onConfirm={async (name) => {
            const doc = templateId
              ? await createPlanFromTemplate({ siteId, name, kind, templateId })
              : createPlanDocument({ siteId, name, kind });
            if (!templateId) await repository.savePlan(doc);
            await repository.saveSite({ ...site, updatedAt: nowIso() });
            close();
            navigate({ name: 'plan', siteId, planId: doc.plan.id });
          }}
        >
          <label className="block">
            <span className="mb-1 block font-medium text-slate-800">{t('plans.kind')}</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as PlanKind)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {PLAN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`planKind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block font-medium text-slate-800">{t('templates.choose')}</span>
            <select
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              data-testid="plan-template"
            >
              <option value="">{t('templates.none')}</option>
              {templates.map(({ template }) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
        </TextPromptDialog>
      )}
      {dialog?.kind === 'templates' && <TemplatesDialog onClose={close} />}
      {dialog?.kind === 'variant' && (
        <VariantDialog
          planId={dialog.plan.id}
          planName={dialog.plan.name}
          onClose={close}
          onCreated={(id) => navigate({ name: 'plan', siteId, planId: id })}
        />
      )}
      {dialog?.kind === 'rename' && (
        <TextPromptDialog
          title={t('plans.rename.title')}
          label={t('plans.name')}
          initialValue={dialog.plan.name}
          confirmLabel={t('common.save')}
          onCancel={close}
          onConfirm={async (name) => {
            // Version contrôlée : si le plan est ouvert et modifié ailleurs, conflit plutôt qu'écrasement.
            const opened = await repository.openPlan(dialog.plan.id);
            if (!opened) throw new Error(t('plans.notFound'));
            await repository.savePlan(
              { ...opened.doc, plan: { ...opened.doc.plan, name, updatedAt: nowIso() } },
              { expectedVersion: opened.version },
            );
            close();
            reload();
          }}
        />
      )}
      {dialog?.kind === 'duplicate' && (
        <TextPromptDialog
          title={t('plans.duplicate.title')}
          label={t('plans.duplicate.name')}
          initialValue={t('plans.copyName', { name: dialog.plan.name })}
          confirmLabel={t('common.duplicate')}
          onCancel={close}
          onConfirm={async (name) => {
            await repository.savePlan(duplicatePlanDocument(await requirePlan(dialog.plan.id), name));
            close();
            reload();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ProtectedDeleteDialog
          title={t('plans.delete.title')}
          planIds={async () => [dialog.plan.id]}
          confirmName={dialog.plan.name}
          onCancel={close}
          onConfirm={async () => {
            await repository.deletePlan(dialog.plan.id);
            close();
            reload();
          }}
        >
          {t('plans.delete.body', { name: dialog.plan.name })}
        </ProtectedDeleteDialog>
      )}
    </PageLayout>
  );
}
