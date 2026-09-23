/** Règles clavier communes : quand une touche appartient à un champ de saisie et non au plan. */

/** Types de champ qui ne reçoivent pas de texte : les raccourcis du plan y restent actifs. */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'range']);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}
