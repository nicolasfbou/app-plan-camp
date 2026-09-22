import { FolderInput, Pencil, Plus, TentTree, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { ImportProjectDialog } from './ImportProjectDialog.tsx';
import { createSite, nowIso } from '@/domain/model/factories.ts';
import type { Site } from '@/domain/model/types.ts';
import { formatDateTime, t, tPlural } from '@/i18n/index.ts';
import { repository } from '@/app/repository.ts';
import { navigate, routeHref } from '@/app/router.ts';
import { Button } from '@/ui/Button.tsx';
import { ConfirmDialog } from '@/ui/ConfirmDialog.tsx';
import { IconButton } from '@/ui/IconButton.tsx';
import { TextPromptDialog } from '@/ui/TextPromptDialog.tsx';
import { ListRow } from './ListRow.tsx';
import { Notice, PageLayout } from './PageLayout.tsx';
import { useAsync } from './useAsync.ts';

interface SiteWithCount {
  site: Site;
  planCount: number;
}

type Dialog =
  { kind: 'create' } | { kind: 'rename'; site: Site } | { kind: 'delete'; entry: SiteWithCount } | null;

async function loadSites(): Promise<SiteWithCount[]> {
  const sites = await repository.listSites();
  return Promise.all(
    sites.map(async (site) => ({ site, planCount: (await repository.listPlans(site.id)).length })),
  );
}

export function CampsPage() {
  const [state, reload] = useAsync(loadSites, 'camps');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const close = () => setDialog(null);

  return (
    <PageLayout
      title={t('camps.title')}
      subtitle={t('camps.subtitle')}
      action={
        <div className="flex gap-2">
          <Button onClick={() => importInput.current?.click()}>
            <FolderInput size={16} /> {t('campplan.importButton')}
          </Button>
          <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
            <Plus size={16} /> {t('camps.new')}
          </Button>
        </div>
      }
    >
      {state.status === 'error' && <Notice tone="error">{state.error.message}</Notice>}
      {state.status === 'ready' && state.value.length === 0 && <Notice>{t('camps.empty')}</Notice>}
      {state.status === 'ready' && state.value.length > 0 && (
        <ul className="space-y-2" aria-label={t('camps.title')}>
          {state.value.map((entry) => (
            <ListRow
              key={entry.site.id}
              testId="camp-row"
              href={routeHref({ name: 'camp', siteId: entry.site.id })}
              icon={<TentTree size={20} />}
              title={entry.site.name}
              subtitle={`${tPlural('camps.planCount', entry.planCount)} · ${t('common.updatedAt', { date: formatDateTime(entry.site.updatedAt) })}`}
              actions={
                <>
                  <IconButton
                    label={`${t('common.rename')} ${entry.site.name}`}
                    onClick={() => setDialog({ kind: 'rename', site: entry.site })}
                  >
                    <Pencil size={16} />
                  </IconButton>
                  <IconButton
                    label={`${t('common.delete')} ${entry.site.name}`}
                    onClick={() => setDialog({ kind: 'delete', entry })}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </>
              }
            />
          ))}
        </ul>
      )}

      <input
        ref={importInput}
        type="file"
        accept=".campplan"
        className="hidden"
        data-testid="campplan-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) setImportFile(file);
        }}
      />
      {importFile && (
        <ImportProjectDialog
          file={importFile}
          onClose={() => {
            setImportFile(null);
            reload();
          }}
        />
      )}
      {dialog?.kind === 'create' && (
        <TextPromptDialog
          title={t('camps.new')}
          label={t('camps.name')}
          initialValue=""
          confirmLabel={t('common.create')}
          onCancel={close}
          onConfirm={async (name) => {
            const site = createSite(name);
            await repository.saveSite(site);
            close();
            navigate({ name: 'camp', siteId: site.id });
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <TextPromptDialog
          title={t('camps.rename.title')}
          label={t('camps.name')}
          initialValue={dialog.site.name}
          confirmLabel={t('common.save')}
          onCancel={close}
          onConfirm={async (name) => {
            await repository.saveSite({ ...dialog.site, name, updatedAt: nowIso() });
            close();
            reload();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          danger
          title={t('camps.delete.title')}
          confirmLabel={t('common.delete')}
          onCancel={close}
          onConfirm={async () => {
            await repository.deleteSite(dialog.entry.site.id);
            close();
            reload();
          }}
        >
          {t('camps.delete.body', { name: dialog.entry.site.name, count: dialog.entry.planCount })}
        </ConfirmDialog>
      )}
    </PageLayout>
  );
}
