import { ImageUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { RightPanel } from '@/app/RightPanel.tsx';
import { TopBar } from '@/app/TopBar.tsx';
import { CanvasStage } from '@/editor/CanvasStage.tsx';
import { ImportDialog } from '@/editor/ImportDialog.tsx';
import { NavigationControls } from '@/editor/NavigationControls.tsx';
import { useBackgroundLoader } from '@/editor/session/useBackgroundLoader.ts';
import { usePlanSession } from '@/editor/session/usePlanSession.ts';
import { useViewPersistence } from '@/editor/session/useViewPersistence.ts';
import { viewportActions } from '@/editor/viewportActions.ts';
import { nowIso } from '@/domain/model/factories.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { TextPromptDialog } from '@/ui/TextPromptDialog.tsx';
import { Notice, PageLayout } from './PageLayout.tsx';
import { useAsync } from './useAsync.ts';

export const ACCEPTED_FILES = '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf';

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/** Raccourcis de navigation : + / − zoom, 0 adapter, 1 taille réelle. */
function useNavigationShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const actions: Record<string, () => void> = {
        '+': viewportActions.zoomIn,
        '=': viewportActions.zoomIn,
        '-': viewportActions.zoomOut,
        '0': viewportActions.fit,
        '1': viewportActions.actualSize,
      };
      const action = actions[e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

export function EditorPage({ siteId, planId }: { siteId: string; planId: string }) {
  const { state, saveError } = usePlanSession(planId);
  const [site] = useAsync(() => repository.getSite(siteId), siteId);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [renaming, setRenaming] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const background = useEditorStore((s) => s.background);
  const hasBaseImage = usePlanStore((s) => s.doc?.plan.baseImage != null);
  const planName = usePlanStore((s) => s.doc?.plan.name ?? '');

  useBackgroundLoader();
  useViewPersistence(planId);
  useNavigationShortcuts();

  const openFilePicker = useCallback(() => fileInput.current?.click(), []);
  const closeImport = useCallback(() => setImportFile(null), []);

  if (state.status === 'error') {
    return (
      <PageLayout title={t('plans.title')}>
        <Notice tone="error">{state.message}</Notice>
      </PageLayout>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <TopBar
        siteId={siteId}
        siteName={site.status === 'ready' ? site.value?.name : undefined}
        saveError={saveError}
        onRename={() => setRenaming(true)}
        onImport={openFilePicker}
      />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <CanvasStage />
          {background.kind === 'ready' && <NavigationControls />}
          {state.status === 'ready' && !hasBaseImage && (
            <div className="absolute inset-0 flex items-center justify-center p-8">
              <div className="max-w-md rounded-lg border border-slate-300 bg-white p-6 text-center shadow-sm">
                <ImageUp size={32} className="mx-auto text-accent" aria-hidden />
                <h2 className="mt-2 text-lg font-semibold text-slate-800">
                  {t('canvas.noBackground.title')}
                </h2>
                <p className="mt-2 text-sm text-slate-600">{t('canvas.noBackground.body')}</p>
                <Button variant="primary" className="mt-4" onClick={openFilePicker}>
                  {t('canvas.noBackground.action')}
                </Button>
              </div>
            </div>
          )}
          {background.kind === 'loading' && (
            <p
              role="status"
              className="absolute inset-x-0 top-6 mx-auto w-fit rounded-md bg-white px-4 py-2 text-sm shadow"
            >
              {t('canvas.loading')}
            </p>
          )}
          {background.kind === 'error' && (
            <div
              role="alert"
              className="absolute inset-x-0 top-6 mx-auto max-w-lg rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            >
              <strong className="block">{t('canvas.loadError.title')}</strong>
              {background.message}
            </div>
          )}
        </main>
        <RightPanel />
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_FILES}
        className="hidden"
        data-testid="import-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) setImportFile(file);
        }}
      />
      {importFile && <ImportDialog file={importFile} planId={planId} onClose={closeImport} />}
      {renaming && (
        <TextPromptDialog
          title={t('plans.rename.title')}
          label={t('plans.name')}
          initialValue={planName}
          confirmLabel={t('common.save')}
          onCancel={() => setRenaming(false)}
          onConfirm={(name) => {
            planStore.getState().update(t('history.rename'), (draft) => {
              draft.plan.name = name;
              draft.plan.updatedAt = nowIso();
            });
            setRenaming(false);
          }}
        />
      )}
    </div>
  );
}
