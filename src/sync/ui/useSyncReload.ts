import { useEffect } from 'react';
import { onSync } from '../bus.ts';

/** Relit une liste quand la synchronisation a reçu des changements du serveur. */
export function useSyncReload(reload: () => void) {
  useEffect(() => onSync((m) => m.type === 'pull-applied' && reload()), [reload]);
}
