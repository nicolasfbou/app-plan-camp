/** Acceptation d'une invitation (création du compte, ou compte existant qui rejoint l'organisation). */
import { useEffect, useState } from 'react';
import { t } from '@/i18n/index.ts';
import { Notice, PageLayout } from '@/pages/PageLayout.tsx';
import { api } from '@/sync/api.ts';
import { Button } from '@/ui/Button.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';

interface Invitation {
  organization: string;
  email: string;
  role: 'admin' | 'manager' | 'editor' | 'reader';
  existingAccount: boolean;
}

const field = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';

export function InvitationPage({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    void api
      .request<Invitation>('GET', `/api/invitations/${encodeURIComponent(token)}`)
      .then(setInvitation, (e: Error) => setLoadError(e.message));
  }, [token]);

  if (loadError)
    return (
      <PageLayout title={t('account.loginTitle')}>
        <Notice tone="error">{loadError}</Notice>
      </PageLayout>
    );
  if (!invitation) return <PageLayout title="…">{null}</PageLayout>;
  return (
    <PageLayout title={t('account.invitationTitle', { org: invitation.organization })}>
      {done ? (
        <div
          className="space-y-3 rounded-lg border border-slate-200 bg-white p-6"
          data-testid="invitation-done"
        >
          <p>{t('account.accepted')}</p>
          <Button variant="primary" onClick={() => (window.location.hash = '#/connexion')}>
            {t('account.submit')}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(async () => {
              await api.request('POST', `/api/invitations/${encodeURIComponent(token)}/accept`, {
                body: invitation.existingAccount ? { password } : { displayName, password },
              });
              setDone(true);
            });
          }}
        >
          <p className="text-sm text-slate-700">
            {invitation.existingAccount
              ? t('account.invitationExisting', { email: invitation.email, org: invitation.organization })
              : t('account.invitationNew', {
                  email: invitation.email,
                  role: t(`account.role.${invitation.role}`),
                })}
          </p>
          {!invitation.existingAccount && (
            <label className="block text-sm font-medium">
              {t('account.displayName')}
              <input
                className={field}
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
          )}
          <label className="block text-sm font-medium">
            {t('account.password')}
            <input
              className={field}
              type="password"
              required
              minLength={invitation.existingAccount ? 1 : 12}
              autoComplete={invitation.existingAccount ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!invitation.existingAccount && (
              <span className="text-xs text-slate-500">{t('account.passwordRule')}</span>
            )}
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy}>
              {t('account.accept')}
            </Button>
          </div>
        </form>
      )}
    </PageLayout>
  );
}
