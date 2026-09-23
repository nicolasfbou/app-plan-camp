/** Erreur d'API : statut HTTP + code stable (lu par le client) + message lisible. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'Ressource') => new HttpError(404, 'not-found', `${what} introuvable.`);
export const forbidden = (message = 'Action non autorisée pour votre rôle.') =>
  new HttpError(403, 'forbidden', message);
export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new HttpError(400, 'bad-request', message, details);
