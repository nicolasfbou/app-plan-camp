import { useRegisterSW } from 'virtual:pwa-register/react';
import { t } from '@/i18n/index.ts';

/**
 * Le service worker ne recharge jamais la page de lui-même (un plan pourrait être en cours
 * d'édition) : l'utilisateur choisit quand appliquer la mise à jour.
 */
export function PwaUpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh && !offlineReady) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md bg-slate-900 px-4 py-2 text-sm text-white shadow-lg"
    >
      <span>{needRefresh ? t('pwa.updateAvailable') : t('pwa.offlineReady')}</span>
      {needRefresh && (
        <button
          type="button"
          className="rounded bg-accent px-2 py-1 font-medium"
          onClick={() => void updateServiceWorker(true)}
        >
          {t('pwa.reload')}
        </button>
      )}
      <button
        type="button"
        className="rounded px-2 py-1 text-slate-300 hover:text-white"
        onClick={() => {
          setNeedRefresh(false);
          setOfflineReady(false);
        }}
      >
        {needRefresh ? t('pwa.dismiss') : t('pwa.close')}
      </button>
    </div>
  );
}
