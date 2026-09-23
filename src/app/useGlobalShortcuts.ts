import { useEffect } from 'react';
import { planStore } from '@/store/planStore.ts';
import { isTypingTarget } from '@/ui/keyboard.ts';

/** Raccourcis globaux : Ctrl+Z annuler ; Ctrl+Y ou Ctrl+Shift+Z rétablir. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Dans un champ texte, Ctrl+Z annule la saisie ; sur une case à cocher, il annule l'action.
      if (isTypingTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        planStore.getState().undo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        planStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
