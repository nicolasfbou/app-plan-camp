/** Préférences d'interface (panneaux réduits, onglet actif). Hors document et hors historique. */
import { create } from 'zustand';

export type RightTab = 'properties' | 'layers';

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
  rightTab: 'properties',
  toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
  toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
  setRightTab: (rightTab) => set({ rightTab }),
}));
