/** État de l'éditeur hors document : fond chargé, outil actif, touches maintenues. */
import { create } from 'zustand';
import { type LoadedBackground, releaseBackground } from '@/editor/backgroundImage.ts';

export type BackgroundStatus =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ready'; background: LoadedBackground }
  | { kind: 'error'; message: string };

/** Phase 1 : seul l'outil main (navigation) existe. Les outils de dessin arrivent en phase 2. */
export type Tool = 'hand';

interface EditorState {
  background: BackgroundStatus;
  tool: Tool;
  spaceHeld: boolean;
  isPanning: boolean;
  setBackground(status: BackgroundStatus): void;
  setSpaceHeld(held: boolean): void;
  setPanning(panning: boolean): void;
  reset(): void;
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  background: { kind: 'none' },
  tool: 'hand',
  spaceHeld: false,
  isPanning: false,
  setBackground(status) {
    const previous = get().background;
    if (previous.kind === 'ready' && (status.kind !== 'ready' || status.background !== previous.background)) {
      releaseBackground(previous.background);
    }
    set({ background: status });
  },
  setSpaceHeld: (spaceHeld) => set({ spaceHeld }),
  setPanning: (isPanning) => set({ isPanning }),
  reset() {
    get().setBackground({ kind: 'none' });
    set({ spaceHeld: false, isPanning: false });
  },
}));
