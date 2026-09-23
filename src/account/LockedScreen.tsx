/**
 * Espace d'un appareil PARTAGÉ sans authentification valide dans cette session du navigateur :
 * aucun projet n'est accessible (la base de l'espace n'est même pas ouverte) tant que la personne
 * ne s'est pas reconnectée.
 */
import { Lock, Trash2 } from 'lucide-react';
import { ACTIVE_PROFILE, setActiveProfile } from '@/app/profile.ts';
import { t } from '@/i18n/index.ts';
import { PageLayout } from '@/pages/PageLayout.tsx';
import { Button } from '@/ui/Button.tsx';
import { LoginPage } from './LoginPage.tsx';
import { pendingChanges, purgeProfile } from './session.ts';

function backToLocal() {
  setActiveProfile('local');
  window.location.hash = '#/';
  window.location.reload();
}

/** Navigateur fermé sans déconnexion : n'importe qui peut effacer l'espace (rien n'est lisible). */
async function eraseDevice() {
  const org = ACTIVE_PROFILE.orgName ?? '';
  if (!window.confirm(t('account.eraseDeviceConfirm', { org }))) return;
  const count = await pendingChanges(ACTIVE_PROFILE).catch(() => 0);
  if (count > 0 && !window.confirm(t('account.eraseDevicePending', { count }))) return;
  await purgeProfile(ACTIVE_PROFILE);
  backToLocal();
}

export function LockedScreen() {
  return (
    <PageLayout title={t('account.lockedTitle')}>
      <div className="space-y-4" data-testid="locked-screen">
        <p className="flex items-center gap-2 text-sm text-slate-700">
          <Lock size={16} aria-hidden /> {t('account.lockedBody', { org: ACTIVE_PROFILE.orgName ?? '' })}
        </p>
        <LoginPage prefillEmail={ACTIVE_PROFILE.email ?? ''} embedded />
        <div className="flex flex-wrap gap-2">
          <Button onClick={backToLocal}>{t('account.backToLocal')}</Button>
          <Button variant="danger" onClick={() => void eraseDevice()} data-testid="erase-device">
            <Trash2 size={16} aria-hidden /> {t('account.eraseDevice')}
          </Button>
        </div>
      </div>
    </PageLayout>
  );
}
