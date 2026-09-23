/**
 * Modèles d'entreprise : liste, enregistrement du plan ouvert comme modèle, application au plan
 * ouvert, export / import d'un fichier `.campmodele` (pour passer d'un ordinateur à l'autre).
 */
import { Download, FileUp, LayoutTemplate, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoredTemplate } from '@/persistence/ProjectRepository.ts';
import { TEMPLATE_EXTENSION } from '@/persistence/templateFile.ts';
import { formatDateTime, t } from '@/i18n/index.ts';
import { TextField, Toggle } from '@/panels/fields.tsx';
import { usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { ConfirmDialog } from '@/ui/ConfirmDialog.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { repository } from './repository.ts';
import {
  applyTemplateToOpenPlan,
  exportTemplate,
  importTemplateFile,
  savePlanAsTemplate,
} from './templateActions.ts';

export function TemplatesDialog({ onClose }: { onClose(): void }) {
  const doc = usePlanStore((s) => s.doc);
  const [templates, setTemplates] = useState<StoredTemplate[] | null>(null);
  const [name, setName] = useState('');
  const [restyle, setRestyle] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleting, setDeleting] = useState<StoredTemplate | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reload = useCallback(() => void repository.listTemplates().then(setTemplates), []);
  useEffect(reload, [reload]);

  const run = async (action: () => Promise<string>) => {
    try {
      setMessage({ ok: true, text: await action() });
      reload();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Modal
      open
      wide
      title={t('templates.title')}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t('print.close')}</Button>}
    >
      <div className="space-y-4" data-testid="templates-dialog">
        <p className="text-sm text-slate-600">{t('templates.help')}</p>
        {doc && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const tpl = await savePlanAsTemplate(doc, name);
                setName('');
                return t('templates.saved', { name: tpl.name });
              });
            }}
          >
            <div className="flex-1">
              <TextField label={t('templates.saveAs')} value={name} onChange={setName} />
            </div>
            <Button type="submit" variant="primary" disabled={!name.trim()} data-testid="template-save">
              <Save size={16} /> {t('templates.save')}
            </Button>
          </form>
        )}
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            {t('templates.list')}
          </h3>
          <Button onClick={() => fileInput.current?.click()}>
            <FileUp size={16} /> {t('templates.import')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={`${TEMPLATE_EXTENSION},application/zip,application/octet-stream`}
            className="hidden"
            data-testid="template-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file)
                void run(async () =>
                  t('templates.imported', { name: (await importTemplateFile(file)).name }),
                );
            }}
          />
        </div>
        {doc && <Toggle label={t('templates.restyle')} checked={restyle} onChange={setRestyle} />}
        {templates === null ? (
          <p className="text-sm text-slate-500">…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-slate-500">{t('templates.empty')}</p>
        ) : (
          <ul
            className="divide-y divide-slate-200 rounded-md border border-slate-200"
            data-testid="templates-list"
          >
            {templates.map(({ template }) => (
              <li key={template.id} className="flex items-center gap-2 p-2" data-template={template.name}>
                <LayoutTemplate size={18} className="shrink-0 text-slate-500" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-800">{template.name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {t('templates.summary', {
                      views: template.views.length,
                      layers: template.layers.length,
                      date: formatDateTime(template.updatedAt),
                    })}
                  </p>
                </div>
                {doc && (
                  <Button
                    onClick={() =>
                      void run(async () => {
                        await applyTemplateToOpenPlan(template.id, restyle);
                        return t('templates.applied', { name: template.name });
                      })
                    }
                    data-testid="template-apply"
                  >
                    {t('templates.apply')}
                  </Button>
                )}
                <Button
                  title={t('templates.export')}
                  aria-label={t('templates.exportOf', { name: template.name })}
                  onClick={() =>
                    void run(async () =>
                      t('templates.exported', { file: (await exportTemplate(template.id)) ?? '' }),
                    )
                  }
                >
                  <Download size={16} />
                </Button>
                <Button
                  title={t('templates.delete')}
                  aria-label={t('templates.deleteOf', { name: template.name })}
                  onClick={() => setDeleting({ template, logo: null })}
                >
                  <Trash2 size={16} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {message && (
          <p
            role="status"
            className={`text-sm ${message.ok ? 'text-emerald-800' : 'text-red-700'}`}
            data-testid="templates-message"
          >
            {message.text}
          </p>
        )}
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('templates.delete')}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await repository.deleteTemplate(deleting.template.id);
            setDeleting(null);
            reload();
          }}
        >
          {t('templates.deleteBody', { name: deleting.template.name })}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
