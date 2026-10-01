'use strict';

// Desktop app configuration and navigation rules. Pure Node.js (no Electron
// imports) so it can be tested with `npm test` from the repository root.
//
// Two modes:
//   cloud — REZHISSER_URL=https://your-service.example opens the deployed
//           cloud service (accounts, tasks and Owl Browser runs live there).
//   local — without REZHISSER_URL the bundled server starts on 127.0.0.1 with
//           a local data folder; Owl Browser runs are real only when
//           OWL_BROWSER_URL + OWL_BROWSER_TOKEN are set, otherwise simulated.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const START_PATHS = new Set(['/', '/studio', '/automation']);
const DEFAULT_START_PATH = '/automation';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseServiceUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('REZHISSER_URL must be a URL such as https://rezhisser-video-service.onrender.com');
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('REZHISSER_URL must use https:// (http:// is allowed only for localhost).');
  }
  if (url.username || url.password) throw new Error('REZHISSER_URL must not contain credentials.');
  return url.origin;
}

function startPathOf(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_START_PATH;
  const pathname = String(value).trim();
  if (!START_PATHS.has(pathname)) {
    throw new Error(`REZHISSER_START_PATH must be one of: ${Array.from(START_PATHS).join(', ')}`);
  }
  return pathname;
}

function resolveDesktopConfig(env = process.env) {
  const startPath = startPathOf(env.REZHISSER_START_PATH);
  const raw = String(env.REZHISSER_URL || '').trim();
  if (raw) return { mode: 'cloud', origin: parseServiceUrl(raw), startPath };
  return { mode: 'local', origin: null, startPath };
}

// Pages of the service stay in the app window; everything else (payment
// pages, docs, external links) opens in the system browser. Non-web schemes
// are never opened.
function classifyNavigation(target, origin) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return 'deny';
  }
  if (origin && url.origin === origin) return 'internal';
  if (url.protocol === 'https:' || url.protocol === 'http:') return 'external';
  return 'deny';
}

// Stable JWT secret for the local server so sign-ins survive app restarts.
function loadOrCreateSecret(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      return existing;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    if (process.platform !== 'win32') fs.chmodSync(temporaryFile, 0o600);
    fs.writeFileSync(descriptor, secret, 'utf8');
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryFile, file);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporaryFile); } catch {}
    throw error;
  }
  return secret;
}

function localServerOptions(userDataDir) {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: '',
    dataDir: path.join(userDataDir, 'data'),
    jwtSecret: loadOrCreateSecret(path.join(userDataDir, 'jwt-secret')),
  };
}

// Starts the bundled service (src/server.js createApp) on 127.0.0.1 with a
// random port. Resolves to { app, origin, close }.
async function startLocalServer({ createApp, userDataDir, options = {} }) {
  const app = createApp({ ...localServerOptions(userDataDir), ...options });
  if (app.config.autoMigrate) await app.db.migrate();
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(app.config.port, app.config.host, resolve);
  });
  await Promise.all([app.pipeline.resume(), app.automation.resume()]);
  const { port } = app.server.address();
  let closed = false;
  return {
    app,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      app.closeProviders();
      const stopped = new Promise((resolve) => app.server.close(() => resolve()));
      if (typeof app.server.closeAllConnections === 'function') app.server.closeAllConnections();
      await stopped;
      await app.db.close().catch(() => null);
    },
  };
}

module.exports = {
  resolveDesktopConfig,
  classifyNavigation,
  loadOrCreateSecret,
  localServerOptions,
  startLocalServer,
  DEFAULT_START_PATH,
  START_PATHS,
};
