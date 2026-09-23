/**
 * Espace d'un appareil PARTAGÉ sans authentification valide dans cette session du navigateur :
 * aucun projet n'est accessible (la base de l'espace n'est même pas ouverte) tant que la personne
 * ne s'est pas reconnectée.
 */
import { Lock } from 'lucide-react';
import { ACTIVE_PROFILE, setActiveProfile } from '@/app/profile.ts';
import { t } from '@/i18n/index.ts';
import { PageLayout } from '@/pages/PageLayout.tsx';
import { Button } from '@/ui/Button.tsx';
import { LoginPage } from './LoginPage.tsx';

export function LockedScreen() {
  return (
    <PageLayout title={t('account.lockedTitle')}>
      <div className="space-y-4" data-testid="locked-screen">
        <p className="flex items-center gap-2 text-sm text-slate-700">
          <Lock size={16} aria-hidden /> {t('account.lockedBody', { org: ACTIVE_PROFILE.orgName ?? '' })}
        </p>
        <LoginPage prefillEmail={ACTIVE_PROFILE.email ?? ''} embedded />
        <Button
          onClick={() => {
            setActiveProfile('local');
            window.location.hash = '#/';
            window.location.reload();
          }}
        >
          {t('account.backToLocal')}
        </Button>
      </div>
    </PageLayout>
  );
}
