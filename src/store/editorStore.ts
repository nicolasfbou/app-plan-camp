/**
 * État de l'éditeur hors document : fond chargé, outil actif, sélection, forme en cours de dessin,
 * presse-papiers interne. Rien ici n'est sauvegardé ni inscrit dans l'historique.
 */
import { create } from 'zustand';
import { DEFAULT_AREA_PRESET_ID } from '@/domain/presets/zonePresets.ts';
import type { PlanObject, Point } from '@/domain/model/types.ts';
import { type LoadedBackground, releaseBackground } from '@/editor/backgroundImage.ts';

export type BackgroundStatus =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ready'; background: LoadedBackground }
  | { kind: 'error'; message: string };

export const DRAWING_TOOLS = [
  'rect',
  'roundedRect',
  'ellipse',
  'polygon',
  'line',
  'polyline',
  'text',
  'label',
] as const;
export type DrawingTool = (typeof DRAWING_TOOLS)[number];
export type Tool = 'select' | 'hand' | DrawingTool;

export const AREA_TOOLS: readonly Tool[] = ['rect', 'roundedRect', 'ellipse', 'polygon'];

/** Forme en cours de création (coordonnées image), affichée dans la couche de surcouche. */
export type Draft =
  | { kind: 'box'; tool: 'rect' | 'roundedRect' | 'ellipse'; start: Point; end: Point }
  | { kind: 'path'; tool: 'polygon' | 'polyline' | 'line'; points: Point[]; cursor: Point | null };

interface EditorState {
  background: BackgroundStatus;
  tool: Tool;
  /** Modèle appliqué par les outils de surface (rectangle, ellipse, polygone). */
  presetId: string;
  selectedId: string | null;
  /** Mode « Modifier les points » d'un polygone / d'une polyligne. */
  vertexEditing: boolean;
  /** Texte en cours d'édition dans le champ superposé. */
  editingTextId: string | null;
  draft: Draft | null;
  clipboard: PlanObject | null;
  pasteCount: number;
  spaceHeld: boolean;
  isPanning: boolean;
  setBackground(status: BackgroundStatus): void;
  setTool(tool: Tool): void;
  setPreset(presetId: string): void;
  select(id: string | null): void;
  setVertexEditing(on: boolean): void;
  setEditingText(id: string | null): void;
  setDraft(draft: Draft | null): void;
  setClipboard(object: PlanObject): void;
  nextPaste(): number;
  setSpaceHeld(held: boolean): void;
  setPanning(panning: boolean): void;
  reset(): void;
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  background: { kind: 'none' },
  tool: 'select',
  presetId: DEFAULT_AREA_PRESET_ID,
  selectedId: null,
  vertexEditing: false,
  editingTextId: null,
  draft: null,
  clipboard: null,
  pasteCount: 0,
  spaceHeld: false,
  isPanning: false,
  setBackground(status) {
    const previous = get().background;
    if (previous.kind === 'ready' && (status.kind !== 'ready' || status.background !== previous.background)) {
      releaseBackground(previous.background);
    }
    set({ background: status });
  },
  setTool: (tool) => set({ tool, draft: null, vertexEditing: false, editingTextId: null }),
  setPreset: (presetId) => set({ presetId }),
  select: (selectedId) =>
    set((s) => ({ selectedId, vertexEditing: selectedId === s.selectedId ? s.vertexEditing : false })),
  setVertexEditing: (vertexEditing) => set({ vertexEditing }),
  setEditingText: (editingTextId) => set({ editingTextId }),
  setDraft: (draft) => set({ draft }),
  setClipboard: (clipboard) => set({ clipboard, pasteCount: 0 }),
  nextPaste() {
    const pasteCount = get().pasteCount + 1;
    set({ pasteCount });
    return pasteCount;
  },
  setSpaceHeld: (spaceHeld) => set({ spaceHeld }),
  setPanning: (isPanning) => set({ isPanning }),
  reset() {
    get().setBackground({ kind: 'none' });
    set({
      tool: 'select',
      selectedId: null,
      vertexEditing: false,
      editingTextId: null,
      draft: null,
      spaceHeld: false,
      isPanning: false,
    });
  },
}));
