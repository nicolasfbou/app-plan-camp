/**
 * Internationalisation minimale : dictionnaires plats typés par clé.
 * Pour ajouter l'anglais : créer `en.ts` typé `Messages` et l'ajouter à `catalogs`.
 * Les textes saisis par l'utilisateur sur le plan ne passent jamais par ici.
 */
import { fr, type MessageKey, type Messages } from './fr.ts';

export type Locale = 'fr';
export type { MessageKey };

const catalogs: Record<Locale, Messages> = { fr };

let currentLocale: Locale = 'fr';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Traduit une clé ; `{nom}` dans le texte est remplacé par `vars.nom`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = catalogs[currentLocale][key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

type PluralBase<K extends string> = K extends `${infer B}.one` ? B : never;

/** Pluriel français : 0 → `.zero` si défini, sinon `.one` ; 1 → `.one` ; ≥ 2 → `.other`. */
export function tPlural(base: PluralBase<MessageKey>, count: number): string {
  const zero = `${base}.zero` as MessageKey;
  if (count === 0 && zero in catalogs[currentLocale]) return t(zero, { count });
  return t((count <= 1 ? `${base}.one` : `${base}.other`) as MessageKey, { count });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-CA', { dateStyle: 'long', timeStyle: 'short' });
}

export function formatInteger(value: number): string {
  return value.toLocaleString('fr-CA');
}
