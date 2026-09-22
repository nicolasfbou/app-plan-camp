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
  /** Objets sélectionnés (vide = aucune sélection). */
  selectedIds: string[];
  /** Mode « Modifier les points » d'un polygone / d'une polyligne (sélection d'un seul objet). */
  vertexEditing: boolean;
  /** Sommet sélectionné en mode « Modifier les points » (Suppr le retire). */
  selectedVertex: number | null;
  /** Calque qui reçoit les nouveaux objets s'il est visible et déverrouillé (sinon : selon le modèle). */
  activeLayerId: string | null;
  /** Rectangle de sélection en cours (coordonnées image). */
  marquee: { start: Point; end: Point } | null;
  /** Texte en cours d'édition dans le champ superposé. */
  editingTextId: string | null;
  draft: Draft | null;
  clipboard: PlanObject[];
  pasteCount: number;
  spaceHeld: boolean;
  isPanning: boolean;
  /** Message bref à l'utilisateur (action refusée, etc.). */
  notice: string | null;
  notify(message: string | null): void;
  setBackground(status: BackgroundStatus): void;
  setTool(tool: Tool): void;
  setPreset(presetId: string): void;
  /** Remplace la sélection (un identifiant, une liste, ou null pour tout désélectionner). */
  select(ids: string | readonly string[] | null): void;
  /** Ajoute ou retire des objets de la sélection (Maj + clic). */
  toggleSelection(ids: readonly string[]): void;
  setVertexEditing(on: boolean): void;
  setSelectedVertex(index: number | null): void;
  setActiveLayer(layerId: string | null): void;
  setMarquee(marquee: { start: Point; end: Point } | null): void;
  setEditingText(id: string | null): void;
  setDraft(draft: Draft | null): void;
  setClipboard(objects: PlanObject[]): void;
  nextPaste(): number;
  setSpaceHeld(held: boolean): void;
  setPanning(panning: boolean): void;
  reset(): void;
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  background: { kind: 'none' },
  tool: 'select',
  presetId: DEFAULT_AREA_PRESET_ID,
  selectedIds: [],
  vertexEditing: false,
  selectedVertex: null,
  activeLayerId: null,
  marquee: null,
  editingTextId: null,
  draft: null,
  clipboard: [],
  pasteCount: 0,
  spaceHeld: false,
  isPanning: false,
  notice: null,
  notify: (notice) => set({ notice }),
  setBackground(status) {
    const previous = get().background;
    if (previous.kind === 'ready' && (status.kind !== 'ready' || status.background !== previous.background)) {
      releaseBackground(previous.background);
    }
    set({ background: status });
  },
  setTool: (tool) => set({ tool, draft: null, vertexEditing: false, editingTextId: null }),
  setPreset: (presetId) => set({ presetId }),
  select(ids) {
    const selectedIds = ids === null ? [] : typeof ids === 'string' ? [ids] : [...new Set(ids)];
    set((s) => {
      const same =
        selectedIds.length === 1 && s.selectedIds.length === 1 && selectedIds[0] === s.selectedIds[0];
      return {
        selectedIds,
        vertexEditing: same ? s.vertexEditing : false,
        selectedVertex: same ? s.selectedVertex : null,
      };
    });
  },
  toggleSelection(ids) {
    const current = new Set(get().selectedIds);
    const allIn = ids.every((id) => current.has(id));
    for (const id of ids) {
      if (allIn) current.delete(id);
      else current.add(id);
    }
    set({ selectedIds: [...current], vertexEditing: false, selectedVertex: null });
  },
  setVertexEditing: (vertexEditing) => set({ vertexEditing, selectedVertex: null }),
  setSelectedVertex: (selectedVertex) => set({ selectedVertex }),
  setActiveLayer: (activeLayerId) => set({ activeLayerId }),
  setMarquee: (marquee) => set({ marquee }),
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
      selectedIds: [],
      vertexEditing: false,
      selectedVertex: null,
      activeLayerId: null,
      marquee: null,
      editingTextId: null,
      draft: null,
      spaceHeld: false,
      isPanning: false,
    });
  },
}));

/** Identifiant de l'objet sélectionné s'il est seul, sinon null. */
export const selectSingleId = (s: { selectedIds: string[] }): string | null =>
  s.selectedIds.length === 1 ? s.selectedIds[0]! : null;
