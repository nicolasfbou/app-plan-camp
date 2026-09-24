/** Préférences d'interface (panneaux réduits, onglet actif). Hors document et hors historique. */
import { create } from 'zustand';

export type RightTab = 'background' | 'layers' | 'properties' | 'analysis' | 'revisions';

interface UiState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: RightTab;
  toggleLeft(): void;
  /** Sur téléphone, referme la barre latérale (elle recouvre le plan). */
  closeLeftOnNarrowScreen(): void;
  toggleRight(): void;
  setRightTab(tab: RightTab): void;
}

/** Petit écran (téléphone) : la barre latérale démarre repliée pour laisser la place au contenu. */
export const narrowScreen = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(max-width: 767px)').matches;

export const useUiStore = create<UiState>()((set) => ({
  leftCollapsed: narrowScreen(),
  rightCollapsed: narrowScreen(),
  rightTab: 'background',
  toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
  closeLeftOnNarrowScreen: () => {
    if (narrowScreen()) set({ leftCollapsed: true });
  },
  toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
  setRightTab: (rightTab) => set({ rightTab }),
}));
