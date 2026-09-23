import { ImageUp } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { RightPanel } from '@/app/RightPanel.tsx';
import { TopBar } from '@/app/TopBar.tsx';
import { CanvasStage } from '@/editor/CanvasStage.tsx';
import { ImportDialog } from '@/editor/ImportDialog.tsx';
import { NavigationControls } from '@/editor/NavigationControls.tsx';
import { NoticeBanner } from '@/editor/NoticeBanner.tsx';
import { ViewBanner } from '@/editor/ViewBanner.tsx';
import { TextEditorOverlay } from '@/editor/TextEditorOverlay.tsx';
import { CalibrationDialog } from '@/panels/ScalePanel.tsx';
import { useEditorShortcuts } from '@/editor/useEditorShortcuts.ts';
import { isTypingTarget } from '@/ui/keyboard.ts';
import { useUiStore } from '@/store/uiStore.ts';
import { useBackgroundLoader } from '@/editor/session/useBackgroundLoader.ts';
import { usePlanSession } from '@/editor/session/usePlanSession.ts';
import { useViewPersistence } from '@/editor/session/useViewPersistence.ts';
import { viewportActions } from '@/editor/viewportActions.ts';
import { nowIso } from '@/domain/model/factories.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { downloadBytes } from '@/app/download.ts';
import { exportCampplan } from '@/persistence/campplan.ts';
import { Button } from '@/ui/Button.tsx';
import { TextPromptDialog } from '@/ui/TextPromptDialog.tsx';
import { TemplatesDialog } from '@/app/TemplatesDialog.tsx';
import { VariantDialog } from '@/app/VariantDialog.tsx';
import { navigate } from '@/app/router.ts';
import { RevisionDialogsHost } from '@/revisions/RevisionDialogs.tsx';
import { useRevisionsStore } from '@/revisions/revisionsStore.ts';
import { saveNow } from '@/app/saveNow.ts';
import { Notice, PageLayout } from './PageLayout.tsx';
import { useAsync } from './useAsync.ts';

// Mise en page et export : chargés seulement à l'ouverture (jsPDF, polices, moteur d'export).
const PrintDialog = lazy(() =>
  import('@/export/ui/PrintDialog.tsx').then((m) => ({ default: m.PrintDialog })),
);

export const ACCEPTED_FILES = '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf';

/** Raccourcis de navigation : + / − zoom, 0 adapter, 1 taille réelle. */
function useNavigationShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('dialog[open]') || useEditorStore.getState().editingTextId) return;
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
  const [printing, setPrinting] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const background = useEditorStore((s) => s.background);
  const pendingCalibration = useEditorStore((s) => s.pendingCalibration);
  const hasBaseImage = usePlanStore((s) => s.doc?.plan.baseImage != null);
  const planName = usePlanStore((s) => s.doc?.plan.name ?? '');

  useBackgroundLoader();
  useViewPersistence(planId);

  // Révisions figées du plan (métadonnées seulement).
  useEffect(() => {
    void useRevisionsStore.getState().load(planId);
    return () => void useRevisionsStore.getState().load(null);
  }, [planId]);
  useNavigationShortcuts();
  useEditorShortcuts();

  // Un objet disparu (annulation de sa création, suppression) ne reste ni sélectionné ni en édition.
  useEffect(
    () =>
      planStore.subscribe((state, previous) => {
        const editor = useEditorStore.getState();
        const objects = state.doc?.objects ?? {};
        const remaining = editor.selectedIds.filter((id) => objects[id]);
        if (remaining.length !== editor.selectedIds.length) editor.select(remaining);
        if (editor.editingTextId && !objects[editor.editingTextId]) editor.setEditingText(null);
        // Vue supprimée (ou annulée) : retour au plan de base, jamais un filtre fantôme.
        if (editor.activeViewId && !state.doc?.plan.views.some((v) => v.id === editor.activeViewId))
          editor.setActiveView(null);
        // Toute modification du plan périme une proposition de placement d'étiquette.
        if (editor.labelProposal && state.doc !== previous.doc) editor.setLabelProposal(null);
      }),
    [],
  );

  // Sélectionner un objet affiche ses propriétés.
  useEffect(
    () =>
      useEditorStore.subscribe((state, previous) => {
        // (depuis l'onglet « Fond » seulement : on ne quitte pas l'onglet Calques en y travaillant)
        const ui = useUiStore.getState();
        if (state.selectedIds.length > 0 && previous.selectedIds.length === 0 && ui.rightTab === 'background')
          ui.setRightTab('properties');
      }),
    [],
  );

  // Ctrl+P : la mise en page du plan (et non l'impression de l'écran par le navigateur).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        if (planStore.getState().doc) setPrinting(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const openFilePicker = useCallback(() => fileInput.current?.click(), []);

  /** Export .campplan : les modifications en attente sont d'abord écrites, pour un fichier à jour. */
  const exportPlan = useCallback(async () => {
    try {
      await saveNow();
      const { bytes, fileName } = await exportCampplan(repository, planId);
      downloadBytes(bytes, fileName, 'application/octet-stream');
    } catch (e) {
      useEditorStore
        .getState()
        .notify(t('campplan.exportError', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [planId]);
  const closeImport = useCallback(() => setImportFile(null), []);

  if (state.status === 'error') {
    return (
      <PageLayout title={t('plans.title')}>
        <Notice tone="error">{state.message}</Notice>
      </PageLayout>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TopBar
        siteId={siteId}
        siteName={site.status === 'ready' ? site.value?.name : undefined}
        saveError={saveError}
        onRename={() => setRenaming(true)}
        onImport={openFilePicker}
        onExport={() => void exportPlan()}
        onPrint={() => setPrinting(true)}
        onTemplates={() => setTemplatesOpen(true)}
        onVariant={() => void saveNow().then(() => setVariantOpen(true))}
        onRevision={() => {
          useUiStore.getState().setRightTab('revisions');
          useRevisionsStore.getState().open({ kind: 'create' });
        }}
      />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <CanvasStage />
          {background.kind === 'ready' && <NavigationControls />}
          <TextEditorOverlay />
          {pendingCalibration && <CalibrationDialog {...pendingCalibration} />}
          <NoticeBanner />
          <ViewBanner />
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
      {printing && (
        <Suspense fallback={null}>
          <PrintDialog
            siteName={site.status === 'ready' ? (site.value?.name ?? '') : ''}
            onClose={() => setPrinting(false)}
          />
        </Suspense>
      )}
      {templatesOpen && <TemplatesDialog onClose={() => setTemplatesOpen(false)} />}
      {state.status === 'ready' && (
        <RevisionDialogsHost siteName={site.status === 'ready' ? (site.value?.name ?? '') : ''} />
      )}
      {variantOpen && (
        <VariantDialog
          planId={planId}
          planName={planName}
          onClose={() => setVariantOpen(false)}
          onCreated={(id) => navigate({ name: 'plan', siteId, planId: id })}
        />
      )}
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
