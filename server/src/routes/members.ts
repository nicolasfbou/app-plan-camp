/**
 * Membres de l'organisation, invitations (aucune inscription libre), journal d'audit.
 * Le jeton d'invitation n'est montré qu'une fois à l'administrateur (lien à transmettre) et
 * n'est stocké que haché.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../auth/passwords.ts';
import { LoginThrottle, newToken, sha256 } from '../auth/sessions.ts';
import { type Client, tx } from '../db.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { type Auth, requirePermission, ROLES } from '../permissions.ts';

const INVITATION_DAYS = 7;

export function registerMemberRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/members', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'members.read');
    const r = await deps.pool.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", m.role, m.status,
              u.status AS "accountStatus", m.created_at AS "memberSince"
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 ORDER BY u.display_name`,
      [auth.orgId],
    );
    return { members: r.rows };
  });

  /** Crée une invitation (jeton à usage unique, seul son SHA-256 est stocké). */
  const createInvitation = async (
    c: Client,
    auth: Auth,
    email: string,
    role: (typeof ROLES)[number],
    requestId: string,
    action: 'member.invite' | 'member.invite.resend',
  ) => {
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86400_000);
    const id = (
      await c.query<{ id: string }>(
        `INSERT INTO invitations (token_hash, organization_id, email, role, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [sha256(token), auth.orgId, email, role, auth.userId, expiresAt],
      )
    ).rows[0]!.id;
    await audit(c, {
      orgId: auth.orgId,
      userId: auth.userId,
      action,
      targetKind: 'invitation',
      targetId: id,
      requestId,
      context: { role },
    });
    return {
      id,
      token,
      link: `${deps.config.publicOrigin}/#/invitation/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  };

  app.post('/api/invitations', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'members.manage');
    const body = z
      .object({ email: z.string().trim().toLowerCase().email().max(320), role: z.enum(ROLES) })
      .parse(request.body);
    return tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const member = await c.query(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND u.email = $2`,
        [auth.orgId, body.email],
      );
      if (member.rowCount) throw new HttpError(409, 'already-member', 'Cette personne est déjà membre.');
      return createInvitation(c, auth, body.email, body.role, request.id, 'member.invite');
    });
  });

  /** Invitations de l'organisation (en attente, expirées, révoquées ; acceptées exclues). */
  app.get('/api/invitations', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'members.manage');
    const r = await deps.pool.query(
      `SELECT i.id, i.email, i.role, i.created_at AS "createdAt", i.expires_at AS "expiresAt",
              i.revoked_at AS "revokedAt", u.display_name AS "invitedBy",
              CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                   WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END AS status
         FROM invitations i JOIN users u ON u.id = i.invited_by
        WHERE i.organization_id = $1 AND i.accepted_at IS NULL
          AND i.created_at > now() - interval '90 days'
        ORDER BY i.created_at DESC`,
      [auth.orgId],
    );
    return { invitations: r.rows };
  });

  const pendingInvitation = async (c: Client, auth: Auth, id: string) => {
    if (!z.string().uuid().safeParse(id).success) throw notFound('Invitation');
    const inv = (
      await c.query<{
        email: string;
        role: (typeof ROLES)[number];
        accepted_at: Date | null;
        revoked_at: Date | null;
      }>(
        'SELECT email, role, accepted_at, revoked_at FROM invitations WHERE organization_id = $2 AND id = $1 FOR UPDATE',
        [id, auth.orgId],
      )
    ).rows[0];
    if (!inv) throw notFound('Invitation');
    if (inv.accepted_at) throw new HttpError(409, 'invitation-accepted', 'Invitation déjà acceptée.');
    return inv;
  };

  const revoke = async (c: Client, auth: Auth, id: string) =>
    c.query(
      'UPDATE invitations SET revoked_at = now(), revoked_by = $3 WHERE organization_id = $2 AND id = $1 AND revoked_at IS NULL',
      [id, auth.orgId, auth.userId],
    );

  /** Révocation : le lien cesse immédiatement de fonctionner (refusé par le serveur). */
  app.delete<{ Params: { id: string } }>('/api/invitations/:id', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'members.manage');
    await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const inv = await pendingInvitation(c, auth, request.params.id);
      if (inv.revoked_at) return;
      await revoke(c, auth, request.params.id);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: 'member.invite.revoke',
        targetKind: 'invitation',
        targetId: request.params.id,
        requestId: request.id,
      });
    });
    return { ok: true };
  });

  /** Renvoi : l'ancien lien est révoqué, un nouveau jeton est émis (nouvelle échéance). */
  app.post<{ Params: { id: string } }>('/api/invitations/:id/resend', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'members.manage');
    return tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const inv = await pendingInvitation(c, auth, request.params.id);
      await revoke(c, auth, request.params.id);
      return createInvitation(c, auth, inv.email, inv.role, request.id, 'member.invite.resend');
    });
  });

  const invitationOf = async (token: string) => {
    const r = await deps.pool.query<{
      organization_id: string;
      email: string;
      role: string;
      name: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT i.organization_id, i.email, i.role, o.name, i.expires_at, i.accepted_at, i.revoked_at
         FROM invitations i JOIN organizations o ON o.id = i.organization_id WHERE i.token_hash = $1`,
      [sha256(token)],
    );
    const inv = r.rows[0];
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at.getTime() < Date.now())
      throw new HttpError(404, 'invitation-invalid', 'Invitation invalide, expirée ou déjà utilisée.');
    return inv;
  };

  app.get<{ Params: { token: string } }>('/api/invitations/:token', async (request) => {
    const inv = await invitationOf(request.params.token);
    const existing = await deps.pool.query('SELECT 1 FROM users WHERE email = $1', [inv.email]);
    return {
      organization: inv.name,
      email: inv.email,
      role: inv.role,
      existingAccount: (existing.rowCount ?? 0) > 0,
    };
  });

  app.post<{ Params: { token: string } }>('/api/invitations/:token/accept', async (request) => {
    const inv = await invitationOf(request.params.token);
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(200).optional(),
        password: z.string().min(1).max(256),
      })
      .parse(request.body);
    const existing = (
      await deps.pool.query<{ id: string; secret_hash: string | null }>(
        `SELECT u.id, i.secret_hash FROM users u
           LEFT JOIN user_identities i ON i.user_id = u.id AND i.provider = 'password'
          WHERE u.email = $1`,
        [inv.email],
      )
    ).rows[0];
    let newAccount: { displayName: string; hash: string } | null = null;
    if (existing) {
      // Compte existant (autre organisation) : il prouve son identité, aucun second compte.
      // Mêmes limites que la connexion, et l'invitation est annulée après 5 échecs : l'invitation
      // ne doit pas servir à deviner le mot de passe d'un compte d'une autre organisation.
      const keys = LoginThrottle.keys(request.ip, inv.email.toLowerCase());
      if (deps.throttle.blocked(...keys))
        throw new HttpError(429, 'throttled', 'Trop de tentatives. Réessayez dans quelques minutes.');
      if (!(await verifyPassword(existing.secret_hash, body.password))) {
        deps.throttle.fail(...keys);
        await tx(deps.pool, { orgId: inv.organization_id, userId: null }, async (c) => {
          const r = await c.query<{ id: string; failed_attempts: number }>(
            `UPDATE invitations SET failed_attempts = failed_attempts + 1,
                    revoked_at = CASE WHEN failed_attempts + 1 >= 5 THEN now() ELSE revoked_at END
              WHERE token_hash = $1 RETURNING id, failed_attempts`,
            [sha256(request.params.token)],
          );
          const row = r.rows[0];
          if (row && row.failed_attempts === 5)
            await audit(c, {
              orgId: inv.organization_id,
              userId: null,
              action: 'member.invite.locked',
              targetKind: 'invitation',
              targetId: row.id,
              requestId: request.id,
              context: { reason: 'Trop de mots de passe faux pour un compte existant' },
            });
        });
        throw new HttpError(401, 'invalid-credentials', 'Mot de passe du compte existant incorrect.');
      }
    } else {
      const policy = checkPasswordPolicy(body.password);
      if (policy) throw badRequest(policy);
      if (!body.displayName) throw badRequest('Nom obligatoire.');
      newAccount = { displayName: body.displayName, hash: await hashPassword(body.password) };
    }
    // Compte, identité, adhésion, invitation consommée et audit : tout ou rien.
    await tx(deps.pool, { orgId: inv.organization_id, userId: existing?.id ?? null }, async (c) => {
      let userId = existing?.id;
      if (!userId) {
        userId = (
          await c.query<{ id: string }>(
            'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
            [inv.email, newAccount!.displayName],
          )
        ).rows[0]!.id;
        await c.query(
          "INSERT INTO user_identities (user_id, provider, subject, secret_hash) VALUES ($1, 'password', '', $2)",
          [userId, newAccount!.hash],
        );
      }
      const used = await c.query(
        'UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL',
        [sha256(request.params.token), userId],
      );
      if (!used.rowCount) throw new HttpError(409, 'invitation-invalid', 'Invitation déjà utilisée.');
      await c.query(
        `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [inv.organization_id, userId, inv.role],
      );
      await audit(c, {
        orgId: inv.organization_id,
        userId,
        action: 'member.join',
        targetKind: 'user',
        targetId: userId,
        requestId: request.id,
        context: { role: inv.role },
      });
    });
    return { ok: true, email: inv.email };
  });

  app.patch<{ Params: { userId: string } }>('/api/members/:userId', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'members.manage');
    const body = z
      .object({ role: z.enum(ROLES).optional(), status: z.enum(['active', 'disabled']).optional() })
      .parse(request.body);
    const target = z.string().uuid().safeParse(request.params.userId);
    if (!target.success) throw notFound('Membre');
    await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const current = (
        await c.query<{ role: string; status: string }>(
          'SELECT role, status FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE',
          [auth.orgId, target.data],
        )
      ).rows[0];
      if (!current) throw notFound('Membre');
      const role = body.role ?? current.role;
      const status = body.status ?? current.status;
      if (
        (current.role === 'admin' && role !== 'admin') ||
        (current.role === 'admin' && status === 'disabled')
      ) {
        const admins = await c.query(
          "SELECT count(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'admin' AND status = 'active'",
          [auth.orgId],
        );
        if (admins.rows[0].n <= 1)
          throw new HttpError(
            409,
            'last-admin',
            'L’organisation doit garder au moins un administrateur actif.',
          );
      }
      // Suspension : nouvelle période d'accès (anciennes sessions et opérations hors ligne créées
      // pendant la période révoquée ne seront plus jamais acceptées automatiquement).
      await c.query(
        `UPDATE memberships SET role = $3, status = $4,
                access_epoch = access_epoch + CASE WHEN $4 = 'disabled' AND status = 'active' THEN 1 ELSE 0 END
          WHERE organization_id = $1 AND user_id = $2`,
        [auth.orgId, target.data, role, status],
      );
      // Accès retiré : ses sessions sur CETTE organisation sont révoquées immédiatement.
      if (status === 'disabled')
        await c.query(
          'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND organization_id = $2 AND revoked_at IS NULL',
          [target.data, auth.orgId],
        );
      if (role !== current.role)
        await audit(c, {
          orgId: auth.orgId,
          userId: auth.userId,
          action: 'member.role',
          targetKind: 'user',
          targetId: target.data,
          requestId: request.id,
          context: { from: current.role, to: role },
        });
      if (status !== current.status)
        await audit(c, {
          orgId: auth.orgId,
          userId: auth.userId,
          action: status === 'disabled' ? 'member.disable' : 'member.enable',
          targetKind: 'user',
          targetId: target.data,
          requestId: request.id,
        });
    });
    return { ok: true };
  });

  app.get<{ Querystring: { before?: string; limit?: string } }>('/api/audit', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'audit.read');
    const limit = Math.min(Math.max(Number(request.query.limit ?? 100) || 100, 1), 500);
    const before = Number(request.query.before ?? 0) || null;
    const rows = await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, (c) =>
      c.query(
        `SELECT a.id, a.action, a.target_kind AS "targetKind", a.target_id AS "targetId", a.at,
                a.context, a.user_id AS "userId", u.display_name AS "userName"
           FROM audit_events a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.organization_id = $3 AND ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT $2`,
        [before, limit, auth.orgId],
      ),
    );
    return { events: rows.rows };
  });
}
