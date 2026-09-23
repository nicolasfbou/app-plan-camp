/**
 * Organisation : membres (rôles, suspension — administrateur), invitations, journal d'audit
 * (administrateur, gestionnaire). Tout est revérifié par le serveur.
 */
import { useCallback, useEffect, useState } from 'react';
import { ACTIVE_PROFILE } from '@/app/profile.ts';
import { formatDateTime, t } from '@/i18n/index.ts';
import { Notice, PageLayout } from '@/pages/PageLayout.tsx';
import { api } from '@/sync/api.ts';
import { Button } from '@/ui/Button.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';

type Role = 'admin' | 'manager' | 'editor' | 'reader';
const ROLES: Role[] = ['admin', 'manager', 'editor', 'reader'];

interface Member {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
}

interface AuditEvent {
  id: number;
  action: string;
  targetKind: string;
  targetId: string;
  at: string;
  userName: string | null;
  context: Record<string, unknown>;
}

export function OrganizationPage() {
  const isAdmin = ACTIVE_PROFILE.role === 'admin';
  const [members, setMembers] = useState<Member[] | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [link, setLink] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit();

  const load = useCallback(() => {
    void api.request<{ members: Member[] }>('GET', '/api/members').then(
      (r) => {
        setMembers(r.members);
        setLoadError(null);
      },
      (e: Error) => setLoadError(e.message),
    );
    void api.request<{ events: AuditEvent[] }>('GET', '/api/audit?limit=200').then(
      (r) => setEvents(r.events),
      () => setEvents([]),
    );
  }, []);
  useEffect(load, [load]);

  const update = (userId: string, patch: Partial<Pick<Member, 'role' | 'status'>>) =>
    submit(async () => {
      await api.request('PATCH', `/api/members/${userId}`, { body: patch });
      load();
    });

  return (
    <PageLayout title={`${t('org.title')} — ${ACTIVE_PROFILE.orgName ?? ''}`}>
      {loadError && <Notice tone="error">{loadError}</Notice>}
      <section className="mb-6 space-y-2" data-testid="org-members">
        <h2 className="text-lg font-semibold">{t('org.members')}</h2>
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {(members ?? []).map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              data-testid="member-row"
            >
              <span>
                <strong>{m.displayName}</strong> <span className="text-slate-500">{m.email}</span>
              </span>
              <span className="flex items-center gap-2">
                {isAdmin ? (
                  <select
                    value={m.role}
                    aria-label={`Rôle de ${m.displayName}`}
                    className="rounded border border-slate-300 px-2 py-1"
                    onChange={(e) => void update(m.id, { role: e.target.value as Role })}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`account.role.${r}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{t(`account.role.${m.role}`)}</span>
                )}
                <span className={m.status === 'active' ? 'text-emerald-700' : 'text-red-700'}>
                  {t(`org.status.${m.status}`)}
                </span>
                {isAdmin && (
                  <Button
                    onClick={() =>
                      void update(m.id, { status: m.status === 'active' ? 'disabled' : 'active' })
                    }
                  >
                    {m.status === 'active' ? t('org.disable') : t('org.enable')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {isAdmin && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(async () => {
                const r = await api.request<{ link: string }>('POST', '/api/invitations', {
                  body: { email, role },
                });
                setLink(r.link);
                setEmail('');
              });
            }}
          >
            <label className="text-sm">
              {t('account.email')}
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`account.role.${r}`)}
                </option>
              ))}
            </select>
            <Button type="submit" variant="primary" disabled={busy}>
              {t('org.invite')}
            </Button>
          </form>
        )}
        {link && (
          <p className="break-all rounded bg-slate-100 p-2 text-xs" data-testid="invitation-link">
            {t('org.inviteLink')} {link}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </section>
      <section className="space-y-2" data-testid="audit-log">
        <h2 className="text-lg font-semibold">{t('org.audit')}</h2>
        <table className="w-full border-collapse bg-white text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th className="p-1">Date (serveur)</th>
              <th className="p-1">Utilisateur</th>
              <th className="p-1">Action</th>
              <th className="p-1">Cible</th>
              <th className="p-1">Contexte</th>
            </tr>
          </thead>
          <tbody>
            {(events ?? []).map((e) => (
              <tr
                key={e.id}
                className="border-b border-slate-100"
                data-testid="audit-row"
                data-action={e.action}
              >
                <td className="p-1 whitespace-nowrap">{formatDateTime(e.at)}</td>
                <td className="p-1">{e.userName ?? '—'}</td>
                <td className="p-1 font-mono">{e.action}</td>
                <td className="p-1 font-mono">
                  {e.targetKind}:{e.targetId.slice(0, 16)}
                </td>
                <td className="p-1 font-mono text-slate-600">{JSON.stringify(e.context)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </PageLayout>
  );
}
