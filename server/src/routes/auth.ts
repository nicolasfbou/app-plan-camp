/** Connexion, déconnexion, identité courante. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';
import { burnPasswordCheck, verifyPassword } from '../auth/passwords.ts';
import {
  cookieOptions,
  createSession,
  LoginThrottle,
  resolveSession,
  revokeSession,
  SESSION_COOKIE,
} from '../auth/sessions.ts';
import { tx } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { Auth } from '../permissions.ts';

const loginBody = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(256),
  organization: z.string().trim().max(60).optional(),
  deviceMode: z.enum(['trusted', 'shared']),
});

async function whoAmI(deps: Deps, auth: Auth) {
  const org = await deps.pool.query<{ id: string; name: string; slug: string }>(
    'SELECT id, name, slug FROM organizations WHERE id = $1',
    [auth.orgId],
  );
  return {
    user: { id: auth.userId, email: auth.email, displayName: auth.displayName },
    organization: org.rows[0],
    role: auth.role,
    deviceMode: auth.deviceMode,
    accessEpoch: auth.accessEpoch,
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/api/auth/login', async (request, reply) => {
    const body = loginBody.parse(request.body);
    const email = body.email.toLowerCase();
    const keys = LoginThrottle.keys(request.ip, email);
    if (deps.throttle.blocked(...keys))
      throw new HttpError(429, 'throttled', 'Trop de tentatives. Réessayez dans quelques minutes.');
    const user = (
      await deps.pool.query<{ id: string; status: string; secret_hash: string | null }>(
        `SELECT u.id, u.status, i.secret_hash FROM users u
           LEFT JOIN user_identities i ON i.user_id = u.id AND i.provider = 'password'
          WHERE u.email = $1`,
        [email],
      )
    ).rows[0];
    const ok = user
      ? await verifyPassword(user.secret_hash, body.password)
      : (await burnPasswordCheck(body.password), false);
    if (!user || !ok || user.status !== 'active') {
      deps.throttle.fail(...keys);
      // Même réponse que le compte existe ou non (pas d'énumération).
      throw new HttpError(401, 'invalid-credentials', 'Courriel ou mot de passe incorrect.');
    }
    deps.throttle.reset(keys[2]!);
    const orgs = (
      await deps.pool.query<{ id: string; name: string; slug: string }>(
        `SELECT o.id, o.name, o.slug FROM memberships m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1 AND m.status = 'active' ORDER BY o.name`,
        [user.id],
      )
    ).rows;
    if (!orgs.length)
      throw new HttpError(
        403,
        'no-organization',
        'Aucun accès actif pour ce compte (accès suspendu ou retiré par un administrateur).',
      );
    const wanted = body.organization?.toLowerCase();
    const chosen = wanted
      ? orgs.find((o) => o.slug === wanted || o.id === wanted)
      : orgs.length === 1
        ? orgs[0]
        : undefined;
    if (!chosen)
      throw new HttpError(409, 'choose-organization', 'Choisissez l’organisation.', {
        organizations: orgs.map(({ name, slug }) => ({ name, slug })),
      });
    const session = await createSession(deps.pool, deps.config, {
      userId: user.id,
      orgId: chosen.id,
      deviceMode: body.deviceMode,
    });
    await tx(deps.pool, { orgId: chosen.id, userId: user.id }, (c) =>
      audit(c, {
        orgId: chosen.id,
        userId: user.id,
        action: 'auth.login',
        targetKind: 'user',
        targetId: user.id,
        requestId: request.id,
        context: { deviceMode: body.deviceMode },
      }),
    );
    reply.setCookie(
      SESSION_COOKIE,
      session.token,
      cookieOptions(deps.config, body.deviceMode, session.expiresAt),
    );
    return whoAmI(deps, (await resolveSession(deps.pool, session.token))!);
  });

  app.get('/api/auth/me', async (request) => whoAmI(deps, requireAuth(request)));

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    await revokeSession(deps.pool, auth.sessionHash);
    await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, (c) =>
      audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: 'auth.logout',
        targetKind: 'user',
        targetId: auth.userId,
        requestId: request.id,
      }),
    );
    reply.clearCookie(SESSION_COOKIE, { path: '/api' });
    return { ok: true };
  });
}
