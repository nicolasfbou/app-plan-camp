import { create } from 'zustand';
import type { MaintenanceTab } from './MaintenanceDialog.tsx';

/** Ouverture de « Santé et sauvegardes » depuis n'importe quelle page. */
export const useMaintenanceStore = create<{
  open: boolean;
  tab: MaintenanceTab | undefined;
  show(tab?: MaintenanceTab): void;
  hide(): void;
}>()((set) => ({
  open: false,
  tab: undefined,
  show: (tab) => set({ open: true, tab }),
  hide: () => set({ open: false }),
}));
