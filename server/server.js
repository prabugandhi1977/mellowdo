import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi } from './app.js';
import { createMailer } from './mailer.js';

const WEB = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

export function createApp(db = openDb(), opts = {}) {
  const api = createApi(db, { mailer: createMailer(), ...opts });
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (req.method !== 'GET') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 1e5) { res.writeHead(413).end(); return; }
          chunks.push(c);
        }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; }
        catch { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Bad JSON"}'); return; }
      }
      const { status, json } = await api(req.method, url.pathname, req.headers, body);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      return;
    }
    // static files (SPA fallback to index.html)
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (rel === '/' || rel === '\\') rel = '/index.html';
    try {
      const data = await readFile(join(WEB, rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' }).end(data);
    } catch {
      const data = await readFile(join(WEB, 'index.html'));
      res.writeHead(200, { 'content-type': TYPES['.html'] }).end(data);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 3300;
  if (process.env.NODE_ENV === 'production' && (!process.env.RESEND_API_KEY || !process.env.AUTH_SECRET)) {
    console.error('Production needs RESEND_API_KEY (to email sign-in codes) and AUTH_SECRET (any long random string).');
    process.exit(1);
  }
  createApp().listen(port, () => console.log(`MellowDo running on http://localhost:${port}`));
}
