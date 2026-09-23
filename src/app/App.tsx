import { CampPage } from '@/pages/CampPage.tsx';
import { CampsPage } from '@/pages/CampsPage.tsx';
import { EditorPage } from '@/pages/EditorPage.tsx';
import { LeftSidebar } from './LeftSidebar.tsx';
import { PwaUpdateBanner } from './PwaUpdateBanner.tsx';
import { BackupReminder, MaintenanceDialog } from '@/maintenance/MaintenanceDialog.tsx';
import { useMaintenanceStore } from '@/maintenance/maintenanceStore.ts';
import { useRoute } from './router.ts';
import { useGlobalShortcuts } from './useGlobalShortcuts.ts';

export function App() {
  useGlobalShortcuts();
  const route = useRoute();
  const maintenance = useMaintenanceStore();

  return (
    // overflow-clip : l’interface ne défile jamais dans son ensemble (même par focus programmatique),
    // sinon la zone de travail se décalerait sous le pointeur.
    <div className="flex h-full w-full overflow-clip">
      <LeftSidebar showTools={route.name === 'plan'} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {route.name === 'camps' && <CampsPage />}
        {route.name === 'camp' && <CampPage key={route.siteId} siteId={route.siteId} />}
        {route.name === 'plan' && (
          <EditorPage key={route.planId} siteId={route.siteId} planId={route.planId} />
        )}
      </div>
      <PwaUpdateBanner />
      <BackupReminder onOpen={() => maintenance.show('backups')} />
      {maintenance.open && (
        <MaintenanceDialog
          planId={route.name === 'plan' ? route.planId : null}
          initialTab={maintenance.tab}
          onClose={maintenance.hide}
        />
      )}
    </div>
  );
}
