import { useEffect, useRef, useState } from 'react';

export type AsyncState<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: Error };

/**
 * Charge une valeur asynchrone. Le chargement est relancé quand `key` change ou quand `reload()`
 * est appelé (après une modification).
 */
export function useAsync<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (value) => !cancelled && setState({ status: 'ready', value }),
      (error: unknown) =>
        !cancelled &&
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  return [state, () => setVersion((v) => v + 1)] as const;
}
