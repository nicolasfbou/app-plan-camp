/**
 * Raccourcis clavier de l'éditeur. Jamais actifs pendant la saisie dans un champ ni quand une
 * boîte de dialogue est ouverte : le canevas ne vole jamais le focus ni les touches d'un champ.
 *
 * V Sélection · H Main · R Rectangle · U Rectangle arrondi · E Ellipse · P Polygone · L Ligne
 * K Polyligne · T Texte · G Étiquette · Suppr / Retour arrière Supprimer · Échap Annuler / désélectionner
 * Entrée Terminer le polygone · Ctrl+C / Ctrl+V / Ctrl+D Copier / coller / dupliquer · Ctrl+A Tout
 * sélectionner · Ctrl+G / Ctrl+Maj+G Grouper / dégrouper
 * Flèches : déplacer de 1 px image (Maj : 10 px image).
 */
import { useEffect } from 'react';
import { type Tool, useEditorStore } from '@/store/editorStore.ts';
import { isTypingTarget } from '@/ui/keyboard.ts';
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
  f: 'flow',
  c: 'corridor',
  s: 'symbol',
  m: 'measure',
};

/** Contrôle d'interface ayant le focus (bouton, onglet, choix…), hors champs de saisie. */
function isControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('button, a, input, [role="radio"], [role="tab"], [role="slider"]') !== null
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

      const hasSelection = editor.selectedIds.length > 0;
      if (mod && e.shiftKey && !e.altKey && key === 'g') {
        if (hasSelection) {
          e.preventDefault();
          editActions.ungroup();
        }
        return;
      }
      if (mod && !e.shiftKey && !e.altKey) {
        // Le raccourci n'est intercepté que s'il agit : sinon la copie native du navigateur reste possible.
        const actions: Record<string, { enabled: boolean; run(): void }> = {
          c: { enabled: hasSelection, run: editActions.copySelected },
          v: { enabled: editor.clipboard.length > 0, run: editActions.paste },
          d: { enabled: hasSelection, run: editActions.duplicateSelected },
          a: { enabled: editor.tool === 'select', run: editActions.selectAll },
          g: { enabled: editor.selectedIds.length > 1, run: editActions.group },
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
          if (editor.marquee) editor.setMarquee(null);
          else if (editor.draft) editor.setDraft(null);
          else if (editor.vertexEditing) editor.setVertexEditing(false);
          else if (hasSelection) editor.select(null);
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
          // Une case à cocher ou un curseur du panneau a le focus : jamais de suppression d'objets.
          if (e.target instanceof HTMLInputElement) return;
          e.preventDefault();
          if (editor.draft?.kind === 'path') {
            const points = editor.draft.points.slice(0, -1);
            editor.setDraft(points.length ? { ...editor.draft, points } : null);
          } else if (!editActions.deleteSelectedVertex()) {
            // En mode « Modifier les points », Suppr retire le sommet sélectionné ; sinon la sélection.
            if (!editor.vertexEditing) editActions.deleteSelected();
          }
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          // Sur un bouton, un onglet ou une liste de choix, les flèches gardent leur rôle de navigation.
          if (!hasSelection || isControlTarget(e.target)) return;
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
