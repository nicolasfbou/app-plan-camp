/**
 * Vérification serveur d'un fichier reçu (jamais confiance au client) : type RÉEL déterminé par
 * les octets (pas par l'extension ni l'en-tête déclaré), taille, et pour un SVG les mêmes règles
 * que le client (motifs interdits + liste blanche d'éléments et d'attributs), appliquées ici sur
 * un analyseur XML serveur.
 */
import { DOMParser } from '@xmldom/xmldom';
import { checkSymbolFile, unsafeSvgContent } from '@/domain/symbols/importSymbol.ts';

export const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'image/svg+xml',
] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

export function sniffType(head: Uint8Array): AllowedType | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => head[at + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, 512)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return 'image/svg+xml';
  return null;
}

/** `null` si le SVG est sûr ; sinon la raison du refus. */
export function unsafeSvg(bytes: Uint8Array): string | null {
  const check = checkSymbolFile(bytes, 'fichier.svg');
  if (!check.ok) return check.reason;
  let failure: string | null = null;
  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser({
      onError: (level: string, message: string) => {
        if (level !== 'warning') failure ??= `SVG mal formé (${message.slice(0, 80)})`;
      },
    }).parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml');
  } catch (error) {
    return `SVG mal formé (${error instanceof Error ? error.message.slice(0, 80) : 'erreur'})`;
  }
  if (failure) return failure;
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') return 'SVG mal formé.';
  return unsafeSvgContent(root as unknown as Element);
}
