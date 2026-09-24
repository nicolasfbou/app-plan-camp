/**
 * Service de l'application web construite (`dist/`) par la même instance : même origine que
 * l'API. Repli sur `index.html` (routes en `#/…`), en-têtes de sécurité.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

export function registerStatic(app: FastifyInstance, dir: string) {
  const root = resolve(dir);
  app.get('/*', async (request, reply) => {
    let path: string;
    try {
      path = decodeURIComponent(request.url.split('?')[0]!);
    } catch {
      return reply.status(400).send();
    }
    if (path.startsWith('/api/')) return reply.callNotFound();
    let file = resolve(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root + sep) && file !== root) return reply.status(404).send();
    let info = await stat(file).catch(() => null);
    // Fichier absent (ex. morceau JavaScript d'une ancienne construction) : 404, jamais la page
    // d'accueil à la place (un script recevant du HTML échouerait de façon trompeuse).
    if (!info?.isFile() && extname(path) !== '') return reply.status(404).send();
    if (!info?.isFile()) {
      file = join(root, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info) return reply.status(404).send();
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const immutable = /\/assets\//.test(file);
    return reply
      .header('Content-Type', type)
      .header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('X-Frame-Options', 'DENY')
      .send(createReadStream(file));
  });
}
