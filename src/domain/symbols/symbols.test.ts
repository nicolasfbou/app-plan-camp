import { describe, expect, it } from 'vitest';
import { makeDocument } from '@/test/fixtures.ts';
import { createIconObject } from '../model/objectFactory.ts';
import { normalizeTransform } from '../model/shapes.ts';
import { CORRIDOR_MARKS, findSymbol, SYMBOL_CATEGORIES, SYMBOLS } from './catalog.ts';
import { checkSymbolFile } from './importSymbol.ts';

const enc = (text: string) => new TextEncoder().encode(text);
const svg = (inner: string, attrs = '') =>
  enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`);

describe('bibliothèque de pictogrammes', () => {
  it('contient au minimum les pictogrammes demandés, classés par catégorie', () => {
    const names = SYMBOLS.map((s) => s.name);
    for (const expected of [
      'Entrée',
      'Sortie',
      'Sens unique',
      'Double sens',
      'Arrêt obligatoire',
      'Limite de vitesse',
      'Stationnement',
      'Stationnement interdit',
      'Piéton',
      'Passage piéton',
      'Accès interdit',
      'Véhicules lourds',
      'Livraison',
      'Débarquement / déchargement',
      'Point de rassemblement',
      "Accès d'urgence",
      'Extincteur',
      'Premiers soins',
      'Génératrice',
      'Carburant',
      'Propane',
      'Matières dangereuses',
      'Déchets',
      'Zone technique',
    ])
      expect(names).toContain(expected);
    const categories = new Set(SYMBOL_CATEGORIES.map((c) => c.id));
    expect(SYMBOLS.every((s) => categories.has(s.category))).toBe(true);
    expect(new Set(SYMBOLS.map((s) => s.id)).size).toBe(SYMBOLS.length);
  });

  it('chaque pictogramme est un SVG autonome, sans script ni ressource externe', () => {
    for (const symbol of [...SYMBOLS, ...CORRIDOR_MARKS]) {
      const text = symbol.svg(symbol.defaultText);
      expect(text.startsWith('<svg')).toBe(true);
      expect(checkSymbolFile(enc(text), `${symbol.id}.svg`)).toEqual({ ok: true, mimeType: 'image/svg+xml' });
    }
  });

  it('texte de la limite de vitesse : échappé, 3 caractères au plus', () => {
    const text = findSymbol('sign.speed-limit')!.svg('<30>&');
    expect(text).not.toContain('<30>');
    expect(text).toContain('&#60;30');
  });
});

describe('import d’un pictogramme personnalisé', () => {
  it('PNG valide accepté ; PNG trop grand ou tronqué refusé', () => {
    const png = (w: number, h: number) => {
      const bytes = new Uint8Array(33);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const view = new DataView(bytes.buffer);
      view.setUint32(16, w);
      view.setUint32(20, h);
      return bytes;
    };
    expect(checkSymbolFile(png(64, 64), 'a.png')).toEqual({ ok: true, mimeType: 'image/png' });
    expect(checkSymbolFile(png(10000, 64), 'a.png').ok).toBe(false);
    expect(checkSymbolFile(png(64, 64).slice(0, 12), 'a.png').ok).toBe(false);
  });

  it('SVG sûr accepté (dégradés et références internes compris)', () => {
    const ok = svg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><use href="#g"/>',
    );
    expect(checkSymbolFile(ok, 'ok.svg').ok).toBe(true);
    expect(
      checkSymbolFile(svg('<style>.a{fill:red}</style><rect class="a" width="1" height="1"/>'), 's.svg').ok,
    ).toBe(true);
  });

  it('SVG dangereux refusé : script, événements, liens externes, HTML intégré, entités', () => {
    const bad = [
      svg('<script>alert(1)</script>'),
      svg('<rect width="1" height="1"/>', ' onload="alert(1)"'),
      svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'),
      svg('<image href="https://exemple.com/x.png" width="1" height="1"/>'),
      svg('<rect style="fill:url(https://exemple.com/x)" width="1" height="1"/>'),
      svg('<foreignObject><div>x</div></foreignObject>'),
      enc('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'),
      svg('<style>@import url(https://exemple.com/a.css);</style>'),
      // Contournements relevés par la revue : entités, animations, échappements CSS, base externe.
      svg('<a><set attributeName="href" to="&#106;avascript:alert(1)"/><rect width="1" height="1"/></a>'),
      svg('<animate attributeName="href" values="https://exemple.com/x.png"/>'),
      svg('<rect width="1" height="1" style="fill:u&#114;l(https://exemple.com/x)"/>'),
      svg('<style>.a{fill:\\75 rl(https://exemple.com/x)}</style>'),
      svg('<style>@\\69mport "https://exemple.com/a.css";</style>'),
      svg('<rect width="1" height="1"/>', ' xml:base="https://exemple.com/"'),
      svg('<image href="data:text/html;base64,PHNjcmlwdD4=" width="1" height="1"/>'),
      svg('<a href="https://exemple.com"><rect width="1" height="1"/></a>'),
    ];
    for (const bytes of bad) expect(checkSymbolFile(bytes, 'x.svg').ok).toBe(false);
  });

  it('autres formats, fichier vide ou trop volumineux : refusés', () => {
    expect(checkSymbolFile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'photo.jpg').ok).toBe(false);
    expect(checkSymbolFile(new Uint8Array(0), 'a.png').ok).toBe(false);
    expect(checkSymbolFile(new Uint8Array(3 * 1024 * 1024), 'a.svg').ok).toBe(false);
    expect(checkSymbolFile(enc('bonjour'), 'a.svg').ok).toBe(false);
  });
});

describe('objet pictogramme', () => {
  it('créé à une taille lisible au zoom courant ; redimensionner = nouvelle taille, proportions gardées', () => {
    const doc = makeDocument();
    const icon = createIconObject(doc, { x: 100, y: 200 }, 'sign.speed-limit', 'Limite', 0.5);
    expect(icon).toMatchObject({ type: 'icon', size: 72, text: '20', geometry: { x: 100, y: 200 } });
    expect(doc.layers.find((l) => l.id === icon.layerId)?.tier).toBe('signage');
    const scaled = normalizeTransform(icon, { x: 150, y: 250, rotation: 30, scaleX: 2, scaleY: 2 });
    expect(scaled).toMatchObject({ size: 144, rotation: 30, geometry: { x: 150, y: 250 } });
  });
});

describe('pictogrammes importés inutilisés', () => {
  it('retirés du plan seulement s’ils ne sont utilisés ni par un pictogramme placé ni par une zone', async () => {
    const { addObject, removeUnusedAssets } = await import('../model/operations.ts');
    const doc = makeDocument();
    const asset = (id: string) => ({
      id,
      name: id,
      blobId: `b-${id}`,
      mimeType: 'image/png' as const,
      byteLength: 1,
      sha256: '0'.repeat(64),
      createdAt: '2026-09-22T12:00:00.000Z',
    });
    doc.assets = { a: asset('a'), b: asset('b'), c: asset('c') };
    addObject(doc, createIconObject(doc, { x: 1, y: 1 }, 'asset:a', 'A'));
    expect(removeUnusedAssets(doc)).toBe(2);
    expect(Object.keys(doc.assets)).toEqual(['a']);
    expect(removeUnusedAssets(doc)).toBe(0);
  });
});
