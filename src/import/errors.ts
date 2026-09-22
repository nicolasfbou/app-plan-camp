/** Erreur d'import présentable telle quelle à l'utilisateur. */
export class ImportError extends Error {
  override name = 'ImportError';
}
