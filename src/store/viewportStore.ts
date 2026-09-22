/**
 * État d'affichage : viewport (zoom/pan) et taille de la zone de travail.
 * Volontairement séparé du plan : ces valeurs ne sont ni sauvegardées dans les objets,
 * ni inscrites dans l'historique annuler/rétablir.
 */
import { create } from 'zustand';
import { IDENTITY_VIEWPORT, type Size, type Viewport } from '@/domain/viewport/viewport.ts';

interface ViewportState {
  viewport: Viewport;
  stageSize: Size;
  setViewport(viewport: Viewport): void;
  setStageSize(size: Size): void;
}

export const useViewportStore = create<ViewportState>()((set) => ({
  viewport: IDENTITY_VIEWPORT,
  stageSize: { width: 0, height: 0 },
  setViewport: (viewport) => set({ viewport }),
  setStageSize: (stageSize) => set({ stageSize }),
}));
