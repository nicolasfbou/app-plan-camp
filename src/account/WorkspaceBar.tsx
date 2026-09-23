/**
 * Barre de l'espace de travail : espace actif (local / organisation), état de synchronisation,
 * connexion, organisation (membres, audit), déconnexion. Toujours visible hors de l'éditeur.
 */
import { Building2, LogIn, LogOut, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  ACTIVE_PROFILE,
  LOCAL_PROFILE,
  readProfiles,
  setActiveProfile,
  type Profile,
} from '@/app/profile.ts';
import { t } from '@/i18n/index.ts';
import { SyncIndicator } from '@/sync/ui/SyncIndicator.tsx';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';
import { logout, pendingChanges, purgeProfile } from './session.ts';

const profileLabel = (p: Profile) =>
  p.kind === 'local'
    ? t('account.localSpace')
    : t('account.orgSpace', { org: p.orgName ?? '', user: p.userName ?? '' });

function reloadHome() {
  window.location.hash = '#/';
  window.location.reload();
}

export function WorkspaceBar() {
  const profiles = [LOCAL_PROFILE, ...readProfiles()];
  const active = ACTIVE_PROFILE;
  const [dialog, setDialog] = useState<null | { kind: 'logout' | 'remove'; pending: number }>(null);
  const manage = active.role === 'admin' || active.role === 'manager';

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-1.5 text-sm"
      data-testid="workspace-bar"
    >
      <label className="flex items-center gap-2">
        <span className="text-slate-500">{t('account.space')}</span>
        <select
          data-testid="workspace-select"
          className="rounded-md border border-slate-300 px-2 py-1"
          value={active.id}
          onChange={(e) => {
            setActiveProfile(e.target.value);
            reloadHome();
          }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {profileLabel(p)}
              {p.kind === 'org'
                ? ` · ${t(p.deviceMode === 'shared' ? 'account.deviceShared' : 'account.deviceTrusted')}`
                : ''}
            </option>
          ))}
        </select>
      </label>
      {active.kind === 'org' && <SyncIndicator />}
      <div className="ml-auto flex items-center gap-2">
        {active.kind === 'org' && manage && (
          <Button onClick={() => (window.location.hash = '#/organisation')} data-testid="open-organization">
            <Building2 size={14} /> {t('account.organization')}
          </Button>
        )}
        <Button onClick={() => (window.location.hash = '#/connexion')} data-testid="open-login">
          <LogIn size={14} /> {t('account.login')}
        </Button>
        {active.kind === 'org' && (
          <>
            <Button
              data-testid="logout"
              onClick={() =>
                void pendingChanges(active).then((pending) => setDialog({ kind: 'logout', pending }))
              }
            >
              <LogOut size={14} /> {t('account.logout')}
            </Button>
            {active.deviceMode === 'trusted' && (
              <Button
                aria-label={t('account.removeSpace')}
                title={t('account.removeSpace')}
                onClick={() =>
                  void pendingChanges(active).then((pending) => setDialog({ kind: 'remove', pending }))
                }
              >
                <Trash2 size={14} />
              </Button>
            )}
          </>
        )}
      </div>
      {dialog && <LogoutDialog kind={dialog.kind} pending={dialog.pending} onClose={() => setDialog(null)} />}
    </div>
  );
}

function LogoutDialog({
  kind,
  pending,
  onClose,
}: {
  kind: 'logout' | 'remove';
  pending: number;
  onClose(): void;
}) {
  const profile = ACTIVE_PROFILE;
  const { busy, error, submit } = useSubmit();
  const destructive = kind === 'remove' || profile.deviceMode === 'shared';
  const [confirmed, setConfirmed] = useState(!destructive || pending === 0);
  return (
    <Modal
      open
      title={kind === 'remove' ? t('account.removeSpace') : t('account.logout')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            disabled={busy || !confirmed}
            data-testid="logout-confirm"
            onClick={() =>
              void submit(async () => {
                if (kind === 'remove') {
                  await purgeProfile(profile);
                  setActiveProfile('local');
                } else await logout(profile);
                reloadHome();
              })
            }
          >
            {destructive && pending > 0
              ? t('account.logoutAnyway')
              : kind === 'remove'
                ? t('account.removeSpace')
                : t('account.logout')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm" data-testid="logout-dialog">
        <p>
          {kind === 'remove'
            ? t('account.removeConfirm', { org: profile.orgName ?? '', count: pending })
            : profile.deviceMode === 'shared'
              ? pending > 0
                ? t('account.logoutSharedPending', { count: pending })
                : t('account.logoutShared')
              : t('account.logoutTrusted')}
        </p>
        {destructive && pending > 0 && (
          <label className="flex items-start gap-2 text-red-800">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1"
            />
            <span>{t('account.logoutAnyway')}</span>
          </label>
        )}
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
