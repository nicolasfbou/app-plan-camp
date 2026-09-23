/** Préférences d'interface (panneaux réduits, onglet actif). Hors document et hors historique. */
import { create } from 'zustand';

export type RightTab = 'background' | 'layers' | 'properties' | 'analysis';

interface UiState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: RightTab;
  toggleLeft(): void;
  toggleRight(): void;
  setRightTab(tab: RightTab): void;
}

export const useUiStore = create<UiState>()((set) => ({
  leftCollapsed: false,
  rightCollapsed: false,
  rightTab: 'background',
  toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
  toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
  setRightTab: (rightTab) => set({ rightTab }),
}));
