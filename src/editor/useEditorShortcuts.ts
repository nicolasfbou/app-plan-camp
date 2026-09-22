/**
 * Raccourcis clavier de l'éditeur. Jamais actifs pendant la saisie dans un champ ni quand une
 * boîte de dialogue est ouverte : le canevas ne vole jamais le focus ni les touches d'un champ.
 *
 * V Sélection · H Main · R Rectangle · U Rectangle arrondi · E Ellipse · P Polygone · L Ligne
 * K Polyligne · T Texte · G Étiquette · Suppr / Retour arrière Supprimer · Échap Annuler / désélectionner
 * Entrée Terminer le polygone · Ctrl+C / Ctrl+V / Ctrl+D Copier / coller / dupliquer
 * Flèches : déplacer de 1 px image (Maj : 10 px image).
 */
import { useEffect } from 'react';
import { type Tool, useEditorStore } from '@/store/editorStore.ts';
import { editActions } from './editActions.ts';
import { finishPathDraft } from './useDrawingTools.ts';

export const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  r: 'rect',
  u: 'roundedRect',
  e: 'ellipse',
  p: 'polygon',
  l: 'line',
  k: 'polyline',
  t: 'text',
  g: 'label',
};

export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/** Contrôle d'interface ayant le focus (bouton, onglet, choix…), hors champs de saisie. */
function isControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('button, a, [role="radio"], [role="tab"], [role="slider"]') !== null
  );
}

export function useEditorShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('dialog[open]')) return;
      const editor = useEditorStore.getState();
      if (editor.editingTextId) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && !e.shiftKey && !e.altKey) {
        // Le raccourci n'est intercepté que s'il agit : sinon la copie native du navigateur reste possible.
        const actions: Record<string, { enabled: boolean; run(): void }> = {
          c: { enabled: editor.selectedId !== null, run: editActions.copySelected },
          v: { enabled: editor.clipboard !== null, run: editActions.paste },
          d: { enabled: editor.selectedId !== null, run: editActions.duplicateSelected },
        };
        const action = actions[key];
        if (action?.enabled) {
          e.preventDefault();
          action.run();
        }
        return;
      }
      if (mod || e.altKey) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          if (editor.draft) editor.setDraft(null);
          else if (editor.vertexEditing) editor.setVertexEditing(false);
          else if (editor.selectedId) editor.select(null);
          else if (editor.tool !== 'select') editor.setTool('select');
          return;
        case 'Enter':
          if (editor.draft?.kind === 'path') {
            e.preventDefault();
            finishPathDraft();
          }
          return;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (editor.draft?.kind === 'path') {
            const points = editor.draft.points.slice(0, -1);
            editor.setDraft(points.length ? { ...editor.draft, points } : null);
          } else {
            editActions.deleteSelected();
          }
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          // Sur un bouton, un onglet ou une liste de choix, les flèches gardent leur rôle de navigation.
          if (!editor.selectedId || isControlTarget(e.target)) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          editActions.nudge(dx, dy);
          return;
        }
      }
      const tool = !e.shiftKey ? TOOL_KEYS[key] : undefined;
      if (tool) {
        e.preventDefault();
        editor.setTool(tool);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
