import { CampPage } from '@/pages/CampPage.tsx';
import { CampsPage } from '@/pages/CampsPage.tsx';
import { EditorPage } from '@/pages/EditorPage.tsx';
import { LeftSidebar } from './LeftSidebar.tsx';
import { PwaUpdateBanner } from './PwaUpdateBanner.tsx';
import { useRoute } from './router.ts';
import { useGlobalShortcuts } from './useGlobalShortcuts.ts';

export function App() {
  useGlobalShortcuts();
  const route = useRoute();

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
    </div>
  );
}
