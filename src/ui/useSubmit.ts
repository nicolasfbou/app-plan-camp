import { useState } from 'react';

/**
 * Exécute une action asynchrone une seule fois à la fois (pas de double soumission) et
 * conserve son message d'erreur pour l'afficher au lieu de l'ignorer.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (action: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, submit };
}
