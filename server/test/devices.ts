/**
 * « Appareils » de test : base IndexedDB (fake-indexeddb) + dépôt synchronisé + moteur, reliés au
 * serveur en processus par un `fetch` simulé (cookie de session, coupures réseau à la demande).
 */
import 'fake-indexeddb/auto';
import type { FastifyInstance } from 'fastify';
import { newId } from '@/domain/model/factories.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { Api, type Fetch } from '@/sync/api.ts';
import { SyncEngine } from '@/sync/engine.ts';
import { SyncingRepository } from '@/sync/syncingRepository.ts';
import type { Harness } from './harness.ts';
import { PASSWORD } from './harness.ts';

export interface NetworkControl {
  online: boolean;
  /** Coupe la connexion PENDANT la prochaine requête correspondante (la requête n'arrive pas). */
  failNext?: (method: string, url: string) => boolean;
  /** La requête arrive et s'exécute, mais la réponse est perdue (double envoi au retour). */
  loseNextResponse?: (method: string, url: string) => boolean;
  /**
   * Point de synchronisation déterministe : attendu AVANT l'envoi de la requête (requête « en
   * vol » tant que la promesse n'est pas résolue ; si elle est rejetée, la requête échoue comme
   * une coupure réseau).
   */
  beforeRequest?: (method: string, url: string) => Promise<void> | undefined;
  requests: string[];
  /** Requêtes envoyées avec leurs en-têtes (vérification des en-têtes de période et de génération). */
  sent?: { method: string; url: string; headers: Record<string, string> }[];
  /** Autre serveur (ex. serveur restauré depuis une sauvegarde) : remplace celui du départ. */
  app?: FastifyInstance;
}

export function injectFetch(app: FastifyInstance, getCookie: () => string, net: NetworkControl): Fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    net.requests.push(`${method} ${url}`);
    const gate = net.beforeRequest?.(method, url);
    if (gate) await gate.catch(() => Promise.reject(new TypeError('network interrupted')));
    if (!net.online) throw new TypeError('Failed to fetch');
    if (net.failNext?.(method, url)) {
      net.failNext = undefined;
      throw new TypeError('network interrupted');
    }
    let payload: Buffer | undefined;
    if (init.body !== undefined && init.body !== null)
      payload = Buffer.from(await new Response(init.body as BodyInit).arrayBuffer());
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    net.sent?.push({ method, url, headers: { ...headers } });
    const cookie = getCookie();
    if (cookie) headers.cookie = cookie;
    const r = await (net.app ?? app).inject({
      method: method as 'GET',
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    if (net.loseNextResponse?.(method, url)) {
      net.loseNextResponse = undefined;
      throw new TypeError('response lost');
    }
    return new Response(r.rawPayload.length ? new Uint8Array(r.rawPayload) : null, {
      status: r.statusCode,
      headers: r.headers as Record<string, string>,
    });
  }) as Fetch;
}

export async function device(h: Harness, email: string, orgId: string) {
  // (déclaré avant la connexion : `net.app` peut rediriger vers un autre serveur)
  const net: NetworkControl = { online: true, requests: [] };
  let cookie = '';
  /** Période d'accès connue de l'appareil (comme `Profile.accessEpoch`). */
  let epoch: number | undefined;
  const login = async () => {
    const r = await (net.app ?? h.app).inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-campplanner': '1' },
      payload: { email, password: PASSWORD, deviceMode: 'trusted' },
    });
    if (r.statusCode !== 200) throw new Error(`login ${email}: ${r.statusCode} ${r.body}`);
    cookie = `cp_session=${r.cookies.find((c) => c.name === 'cp_session')!.value}`;
    epoch = r.json().accessEpoch;
  };
  await login();
  const api = new Api(injectFetch(h.app, () => cookie, net));
  const dbName = `device-${newId()}`;
  const accessEpoch = () => epoch;
  const repo = new SyncingRepository(dbName, orgId, api, undefined, undefined, accessEpoch);
  const raw = new IndexedDbRepository(dbName);
  const open = new Set<string>();
  const engine = new SyncEngine({
    raw,
    api,
    orgId,
    openPlanIds: async () => open,
    post: () => undefined,
    accessEpoch,
  });
  return {
    net,
    api,
    repo,
    raw,
    engine,
    open,
    /** Nouvelle connexion (après une session révoquée) : période d'accès relue. */
    relogin: login,
    epoch: () => epoch,
    sync: () => engine.runOnce(),
    close() {
      repo.close();
      raw.close();
    },
  };
}
