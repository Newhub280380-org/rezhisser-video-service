'use strict';

// Serves the bundled single-page UI from ./public. Only the files listed in
// ROUTES can be served (no path joins with user input, no directory listing).

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ROUTES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/assets/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/assets/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

// Strict CSP: no inline scripts/styles, no third-party origins. Generated
// videos are loaded from the provider's https delivery URL (media-src https:).
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  'media-src https:',
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function createStaticHandler({ dir = PUBLIC_DIR } = {}) {
  const cache = new Map();
  for (const [route, entry] of Object.entries(ROUTES)) {
    cache.set(route, { ...entry, body: fs.readFileSync(path.join(dir, entry.file)) });
  }
  return {
    routes: Object.keys(ROUTES),
    // Returns true when the request was handled.
    handle(req, res, pathname) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const entry = cache.get(pathname);
      if (!entry) return false;
      res.writeHead(200, {
        'Content-Type': entry.type,
        'Content-Length': entry.body.length,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : entry.body);
      return true;
    },
  };
}

module.exports = { createStaticHandler, CONTENT_SECURITY_POLICY, ROUTES, PUBLIC_DIR };
