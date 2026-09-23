/**
 * Connexion à une organisation. Le type d'appareil est demandé EXPLICITEMENT (jamais supposé) :
 * personnel / de confiance (données conservées, hors ligne complet) ou partagé (aucun accès sans
 * nouvelle authentification, purge à la déconnexion).
 */
import { LogIn, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type DeviceMode, readProfiles } from '@/app/profile.ts';
import { t } from '@/i18n/index.ts';
import { Notice, PageLayout } from '@/pages/PageLayout.tsx';
import { api, ApiError } from '@/sync/api.ts';
import { Button } from '@/ui/Button.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';
import { login } from './session.ts';

const field = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';

export function LoginPage({
  prefillEmail = '',
  embedded = false,
}: {
  prefillEmail?: string;
  embedded?: boolean;
}) {
  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState('');
  const [deviceMode, setDeviceMode] = useState<DeviceMode | null>(
    () => readProfiles().find((p) => p.email === prefillEmail)?.deviceMode ?? null,
  );
  const [organizations, setOrganizations] = useState<{ name: string; slug: string }[] | null>(null);
  const [organization, setOrganization] = useState('');
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    void api.request('GET', '/api/health').then(
      () => setServerUp(true),
      () => setServerUp(false),
    );
  }, []);

  // Appareil déjà connu pour ce courriel : son type est repris (modifiable).
  const onEmail = (value: string) => {
    setEmail(value);
    const known = readProfiles().find((p) => p.email?.toLowerCase() === value.trim().toLowerCase());
    if (known?.deviceMode) setDeviceMode(known.deviceMode);
  };

  const onSubmit = () =>
    submit(async () => {
      if (!deviceMode) throw new Error(t('account.deviceRequired'));
      try {
        await login({ email, password, deviceMode, ...(organization ? { organization } : {}) });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'choose-organization') {
          setOrganizations((e.body.organizations as { name: string; slug: string }[]) ?? []);
          throw new Error(e.message, { cause: e });
        }
        throw e;
      }
      window.location.hash = '#/';
      window.location.reload();
    });

  const body = (
    <form
      className="mx-auto max-w-lg space-y-4 rounded-lg border border-slate-200 bg-white p-6"
      data-testid="login-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit();
      }}
    >
      {serverUp === false && (
        <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          {t('account.serverUnavailable')}
        </p>
      )}
      <label className="block text-sm font-medium text-slate-800">
        {t('account.email')}
        <input
          className={field}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => onEmail(e.target.value)}
        />
      </label>
      <label className="block text-sm font-medium text-slate-800">
        {t('account.password')}
        <input
          className={field}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {organizations && (
        <label className="block text-sm font-medium text-slate-800">
          {t('account.organizationChoice')}
          <select
            className={field}
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
            required
          >
            <option value="">—</option>
            {organizations.map((o) => (
              <option key={o.slug} value={o.slug}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="space-y-2" data-testid="device-mode">
        <legend className="text-sm font-medium text-slate-800">{t('account.deviceQuestion')}</legend>
        <p className="text-xs text-slate-500">{t('account.deviceQuestionHelp')}</p>
        {(['trusted', 'shared'] as const).map((mode) => (
          <label
            key={mode}
            className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${deviceMode === mode ? 'border-accent bg-sky-50' : 'border-slate-200'}`}
          >
            <input
              type="radio"
              name="device-mode"
              value={mode}
              checked={deviceMode === mode}
              onChange={() => setDeviceMode(mode)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">
                {t(mode === 'trusted' ? 'account.trustedLabel' : 'account.sharedLabel')}
              </span>
              <span className="mt-1 flex gap-1 text-xs text-slate-600">
                {mode === 'trusted' && (
                  <ShieldAlert size={14} className="shrink-0 text-amber-600" aria-hidden />
                )}
                {t(mode === 'trusted' ? 'account.trustedHelp' : 'account.sharedHelp')}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {!embedded && <Button onClick={() => (window.location.hash = '#/')}>{t('common.cancel')}</Button>}
        <Button type="submit" variant="primary" disabled={busy} data-testid="login-submit">
          <LogIn size={16} /> {t('account.submit')}
        </Button>
      </div>
    </form>
  );
  return embedded ? body : <PageLayout title={t('account.loginTitle')}>{body}</PageLayout>;
}

export function ServerUnavailableNotice() {
  return <Notice>{t('account.serverUnavailable')}</Notice>;
}
