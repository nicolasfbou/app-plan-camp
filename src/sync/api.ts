/**
 * Client de l'API serveur (même origine, cookie de session HttpOnly géré par le navigateur).
 * Toute erreur devient `ApiError` : statut 0 = réseau (hors ligne, serveur injoignable).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get network() {
    return this.status === 0;
  }
}

export interface ApiOptions {
  body?: unknown;
  raw?: Blob | ArrayBuffer | Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type Fetch = typeof fetch;

export class Api {
  constructor(
    private readonly fetchImpl: Fetch = (...args) => fetch(...args),
    private readonly base = '',
  ) {}

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: ApiOptions = {},
  ): Promise<T> {
    const res = await this.send(method, path, options);
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    if (!res.ok)
      throw new ApiError(
        res.status,
        String(data.error ?? 'http'),
        String(data.message ?? `Erreur serveur (${res.status}).`),
        data,
      );
    return data as T;
  }

  /** Téléchargement binaire (fichiers). */
  async bytes(path: string): Promise<ArrayBuffer> {
    const res = await this.send('GET', path);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(
        res.status,
        String(data.error ?? 'http'),
        String(data.message ?? `Erreur ${res.status}`),
      );
    }
    return res.arrayBuffer();
  }

  private async send(method: string, path: string, options: ApiOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { 'X-CampPlanner': '1', ...options.headers };
    let body: BodyInit | undefined;
    if (options.raw) {
      headers['Content-Type'] = 'application/octet-stream';
      body =
        options.raw instanceof Uint8Array ? new Blob([options.raw as BlobPart]) : (options.raw as BodyInit);
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
      });
    } catch (error) {
      throw new ApiError(0, 'network', 'Serveur injoignable (hors ligne ?).', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const api = new Api();

// --- Types des réponses ------------------------------------------------------------------------

export interface MeResponse {
  user: { id: string; email: string; displayName: string };
  organization: { id: string; name: string; slug: string };
  role: 'admin' | 'manager' | 'editor' | 'reader';
  deviceMode: 'trusted' | 'shared';
}

export interface ServerPlan {
  campId: string;
  serverVersion: number;
  updatedAt: string;
  updatedBy: string;
  deleted: boolean;
  document: unknown;
}

export interface ServerRevision {
  id: string;
  planId: string;
  meta: unknown;
  verificationType: 'local_unverified' | 'authenticated_server' | null;
  approvedAt: string | null;
  approvedBy: { id: string; name: string } | null;
  snapshot?: string;
  deleted: boolean;
}

export interface Change {
  seq: number;
  kind: 'camp' | 'plan' | 'revision' | 'template';
  id: string;
  serverVersion: number;
  deleted: boolean;
}
