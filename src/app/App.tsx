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
    <div className="flex h-full w-full overflow-hidden">
      <LeftSidebar showTools={route.name === 'plan'} />
      <div className="flex min-w-0 flex-1 flex-col">
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
