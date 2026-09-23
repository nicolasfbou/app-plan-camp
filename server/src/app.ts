/**
 * Application HTTP (Fastify). Toutes les routes sont sous `/api` ; en production, la même
 * instance sert aussi l'application web (même origine : cookies `SameSite=Strict`, pas de CORS).
 *
 * Défenses générales :
 * - authentification obligatoire (sauf santé, connexion, invitation) ;
 * - requêtes d'écriture : en-tête `X-CampPlanner: 1` exigé (anti-CSRF, force une pré-vérification
 *   CORS que le serveur n'accorde jamais) ;
 * - organisation, utilisateur et rôle TOUJOURS tirés de la session, jamais de la requête ;
 * - erreurs renvoyées sous une forme stable `{ error, message }`, sans détail interne.
 */
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ZodError } from 'zod';
import { LoginThrottle, resolveSession, SESSION_COOKIE } from './auth/sessions.ts';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';
import type { Auth } from './permissions.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCampRoutes } from './routes/camps.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerMemberRoutes } from './routes/members.ts';
import { registerPlanRoutes } from './routes/plans.ts';
import { registerRevisionRoutes } from './routes/revisions.ts';
import { registerSyncRoutes } from './routes/sync.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerStatic } from './static.ts';
import type { ObjectStorage } from './storage/storage.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

export interface Deps {
  config: ServerConfig;
  pool: pg.Pool;
  storage: ObjectStorage;
  throttle: LoginThrottle;
}

const PUBLIC_ROUTES = [/^\/api\/health$/, /^\/api\/auth\/login$/, /^\/api\/invitations\/[^/]+(\/accept)?$/];

export function requireAuth(request: FastifyRequest): Auth {
  if (!request.auth) throw new HttpError(401, 'unauthenticated', 'Connexion requise.');
  return request.auth;
}

export async function buildApp(
  deps: Omit<Deps, 'throttle'> & { throttle?: LoginThrottle },
): Promise<FastifyInstance> {
  const full: Deps = { ...deps, throttle: deps.throttle ?? new LoginThrottle() };
  const app = Fastify({
    logger: false,
    trustProxy: deps.config.trustProxy,
    bodyLimit: deps.config.maxPlanBytes,
    // Identifiant de requête journalisé dans l'audit.
    genReqId: () => crypto.randomUUID(),
  });
  await app.register(cookie);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const path = request.url.split('?')[0]!;
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers['x-campplanner'] !== '1')
      throw new HttpError(403, 'csrf', 'En-tête de requête manquant.');
    request.auth = await resolveSession(full.pool, request.cookies[SESSION_COOKIE]);
    if (!request.auth && !PUBLIC_ROUTES.some((r) => r.test(path)))
      throw new HttpError(401, 'unauthenticated', 'Connexion requise.');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError)
      return reply
        .status(error.status)
        .send({ error: error.code, message: error.message, ...(error.details ?? {}) });
    if (error instanceof ZodError)
      return reply.status(400).send({
        error: 'bad-request',
        message: 'Requête invalide.',
        issues: error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (fastifyError.statusCode === 413)
      return reply.status(413).send({ error: 'too-large', message: 'Envoi trop volumineux.' });
    if (fastifyError.statusCode && fastifyError.statusCode < 500)
      return reply
        .status(fastifyError.statusCode)
        .send({ error: 'bad-request', message: fastifyError.message ?? 'Requête invalide.' });
    // Violation d'un garde-fou de la base (RLS, révision immuable, ajout seul) : refus, pas 500.
    const pgCode = (error as { code?: string }).code;
    // Écriture concurrente (même nouvel élément créé deux fois en même temps) : conflit, jamais 500.
    if (pgCode === '23505' || pgCode === '40001')
      return reply.status(409).send({
        error: 'concurrent',
        message: 'Modifié en même temps ailleurs : resynchronisez puis réessayez.',
      });
    if (pgCode === '42501')
      return reply.status(403).send({ error: 'forbidden', message: 'Opération refusée par le serveur.' });
    request.log.error(error);
    console.error('[campplanner]', request.method, request.url, error);
    return reply.status(500).send({ error: 'internal', message: 'Erreur interne du serveur.' });
  });

  app.get('/api/health', async () => ({ ok: true, service: 'campplanner', api: 1 }));
  registerAuthRoutes(app, full);
  registerMemberRoutes(app, full);
  registerFileRoutes(app, full);
  registerCampRoutes(app, full);
  registerPlanRoutes(app, full);
  registerRevisionRoutes(app, full);
  registerTemplateRoutes(app, full);
  registerSyncRoutes(app, full);
  if (deps.config.staticDir) registerStatic(app, deps.config.staticDir);
  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send({ error: 'not-found', message: `Route inconnue : ${request.method} ${request.url}` }),
  );
  return app;
}
