import { InvitationPage } from '@/account/InvitationPage.tsx';
import { LockedScreen } from '@/account/LockedScreen.tsx';
import { LoginPage } from '@/account/LoginPage.tsx';
import { OrganizationPage } from '@/account/OrganizationPage.tsx';
import { WorkspaceBar } from '@/account/WorkspaceBar.tsx';
import { CampPage } from '@/pages/CampPage.tsx';
import { CampsPage } from '@/pages/CampsPage.tsx';
import { EditorPage } from '@/pages/EditorPage.tsx';
import { LeftSidebar } from './LeftSidebar.tsx';
import { PwaUpdateBanner } from './PwaUpdateBanner.tsx';
import { BackupReminder, MaintenanceDialog } from '@/maintenance/MaintenanceDialog.tsx';
import { useMaintenanceStore } from '@/maintenance/maintenanceStore.ts';
import { ACTIVE_PROFILE, isUnlocked } from './profile.ts';
import { useRoute } from './router.ts';
import { useGlobalShortcuts } from './useGlobalShortcuts.ts';

export function App() {
  useGlobalShortcuts();
  const route = useRoute();
  const maintenance = useMaintenanceStore();
  // Appareil partagé sans authentification dans cette session : aucun projet accessible.
  const locked = !isUnlocked(ACTIVE_PROFILE);
  const publicRoute = route.name === 'login' || route.name === 'invitation';

  return (
    // overflow-clip : l’interface ne défile jamais dans son ensemble (même par focus programmatique),
    // sinon la zone de travail se décalerait sous le pointeur.
    <div className="relative flex h-full w-full overflow-clip">
      {!locked && <LeftSidebar showTools={route.name === 'plan'} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!locked && route.name !== 'plan' && <WorkspaceBar />}
        {route.name === 'login' && <LoginPage />}
        {route.name === 'invitation' && <InvitationPage token={route.token} />}
        {locked && !publicRoute && <LockedScreen />}
        {!locked && route.name === 'organization' && <OrganizationPage />}
        {!locked && route.name === 'camps' && <CampsPage />}
        {!locked && route.name === 'camp' && <CampPage key={route.siteId} siteId={route.siteId} />}
        {!locked && route.name === 'plan' && (
          <EditorPage key={route.planId} siteId={route.siteId} planId={route.planId} />
        )}
      </div>
      <PwaUpdateBanner />
      {!locked && <BackupReminder onOpen={() => maintenance.show('backups')} />}
      {!locked && maintenance.open && (
        <MaintenanceDialog
          planId={route.name === 'plan' ? route.planId : null}
          initialTab={maintenance.tab}
          onClose={maintenance.hide}
        />
      )}
    </div>
  );
}
