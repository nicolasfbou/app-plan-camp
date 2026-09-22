import { CanvasStage } from '@/editor/CanvasStage.tsx';
import { LeftSidebar } from './LeftSidebar.tsx';
import { PwaUpdateBanner } from './PwaUpdateBanner.tsx';
import { RightPanel } from './RightPanel.tsx';
import { TopBar } from './TopBar.tsx';
import { useGlobalShortcuts } from './useGlobalShortcuts.ts';

export function App() {
  useGlobalShortcuts();
  return (
    <div className="flex h-full w-full overflow-hidden">
      <LeftSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1">
            <CanvasStage />
          </main>
          <RightPanel />
        </div>
      </div>
      <PwaUpdateBanner />
    </div>
  );
}
