/**
 * Vérification d'un pictogramme importé (PNG ou SVG) AVANT tout enregistrement. Les octets
 * acceptés sont conservés tels quels. Un SVG est de toute façon affiché comme une image (aucun
 * script exécuté, aucune ressource externe chargée) ; on refuse en plus tout SVG contenant du
 * contenu actif ou des références externes, pour qu'il reste sûr s'il est réutilisé ailleurs.
 */
export const MAX_SYMBOL_BYTES = 2 * 1024 * 1024;
export const MAX_SYMBOL_DIMENSION = 4096;

export type SymbolCheck =
  { ok: true; mimeType: 'image/png' | 'image/svg+xml' } | { ok: false; reason: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Motifs interdits dans un SVG (insensible à la casse). */
const FORBIDDEN_SVG: readonly [RegExp, string][] = [
  [/<!DOCTYPE|<!ENTITY/i, 'déclarations DOCTYPE / ENTITY'],
  [/<script\b/i, 'script'],
  [/<foreignObject\b/i, 'contenu HTML intégré (foreignObject)'],
  [/<(iframe|embed|object|audio|video|canvas|meta|link)\b/i, 'élément actif ou externe'],
  [/\son[a-z]+\s*=/i, 'gestionnaire d’événement (on…)'],
  [/javascript:/i, 'lien javascript:'],
  [/@import/i, 'feuille de style externe'],
  [/url\(\s*(?!['"]?\s*#)/i, 'ressource externe (url)'],
  [/\b(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg|gif|webp);base64,)/i, 'lien externe (href)'],
];

export function checkSymbolFile(bytes: Uint8Array, fileName: string): SymbolCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: 'Fichier vide.' };
  if (bytes.byteLength > MAX_SYMBOL_BYTES)
    return { ok: false, reason: 'Fichier trop volumineux (2 Mo au maximum).' };

  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    // En-tête IHDR : largeur et hauteur (octets 16 à 23, big-endian).
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 24) return { ok: false, reason: 'PNG tronqué.' };
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (!width || !height || width > MAX_SYMBOL_DIMENSION || height > MAX_SYMBOL_DIMENSION)
      return {
        ok: false,
        reason: `Dimensions refusées (${width} × ${height}, maximum ${MAX_SYMBOL_DIMENSION} px).`,
      };
    return { ok: true, mimeType: 'image/png' };
  }

  if (/\.svg$/i.test(fileName) || looksLikeText(bytes)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: 'SVG illisible (encodage UTF-8 attendu).' };
    }
    if (!/<svg[\s>]/i.test(text)) return { ok: false, reason: 'Ce fichier n’est pas un SVG.' };
    for (const [pattern, what] of FORBIDDEN_SVG)
      if (pattern.test(text))
        return { ok: false, reason: `SVG refusé pour des raisons de sécurité : ${what}.` };
    if (typeof DOMParser !== 'undefined') {
      const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (
        parsed.getElementsByTagName('parsererror').length ||
        parsed.documentElement.nodeName.toLowerCase() !== 'svg'
      )
        return { ok: false, reason: 'SVG mal formé.' };
      const problem = unsafeSvgContent(parsed.documentElement);
      if (problem) return { ok: false, reason: `SVG refusé pour des raisons de sécurité : ${problem}.` };
    }
    return { ok: true, mimeType: 'image/svg+xml' };
  }
  return { ok: false, reason: 'Format non pris en charge : PNG ou SVG uniquement.' };
}

function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 256);
  return head.every((b) => b === 9 || b === 10 || b === 13 || b >= 32);
}

/**
 * Liste blanche appliquée au document SVG analysé (entités et échappements déjà décodés) :
 * éléments de dessin seulement (aucune animation, aucun script, aucun contenu HTML), attributs sans
 * gestionnaire d'événement ni base externe, liens et `url()` uniquement internes (`#…`) ou images
 * intégrées, feuilles de style sans import ni échappement.
 */
const SAFE_ELEMENTS = new Set(
  [
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'textPath',
    'defs',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'pattern',
    'use',
    'symbol',
    'title',
    'desc',
    'metadata',
    'image',
    'style',
    'marker',
    'filter',
    'feGaussianBlur',
    'feOffset',
    'feBlend',
    'feColorMatrix',
    'feFlood',
    'feComposite',
    'feMerge',
    'feMergeNode',
    'feDropShadow',
  ].map((n) => n.toLowerCase()),
);
const SAFE_LINK = /^(#|data:image\/(png|jpeg|gif|webp);base64,)/i;

function unsafeCss(css: string): string | null {
  if (/\\/.test(css)) return 'échappement CSS';
  if (/@/.test(css)) return 'règle CSS @';
  if (/expression\s*\(/i.test(css)) return 'expression CSS';
  for (const m of css.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi))
    if (!m[2]!.trim().startsWith('#')) return 'ressource externe (url)';
  if (/url\(/i.test(css.replace(/url\(\s*(['"]?)\s*#[^)]*\)/gi, ''))) return 'ressource externe (url)';
  return null;
}

export function unsafeSvgContent(root: Element): string | null {
  const all = [root, ...Array.from(root.getElementsByTagName('*'))];
  for (const el of all) {
    const name = (el.localName || el.nodeName).toLowerCase();
    if (!SAFE_ELEMENTS.has(name)) return `élément non autorisé (${name})`;
    if (name === 'style') {
      const problem = unsafeCss(el.textContent ?? '');
      if (problem) return problem;
    }
    for (const attr of Array.from(el.attributes)) {
      const attrName = attr.name.toLowerCase();
      const value = attr.value;
      if (attrName.startsWith('on')) return `gestionnaire d’événement (${attr.name})`;
      if (attrName === 'xml:base' || attrName === 'base') return 'base externe (xml:base)';
      if (/javascript:/i.test(value.replace(/\s+/g, ''))) return 'lien javascript:';
      if ((attrName === 'href' || attrName.endsWith(':href')) && !SAFE_LINK.test(value.trim()))
        return 'lien externe (href)';
      const problem = unsafeCss(value);
      if (problem && (attrName === 'style' || /url\(|\\|@/i.test(value))) return problem;
    }
  }
  return null;
}
