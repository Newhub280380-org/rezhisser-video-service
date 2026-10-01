'use strict';

// Connection settings of the Owl Browser client (instance URL + access
// token). Pure Node.js so it can be tested without Electron. The token is
// written to disk only encrypted (Electron safeStorage); when encryption is
// unavailable it is kept in memory for the current session only. Environment
// variables OWL_BROWSER_URL / OWL_BROWSER_TOKEN take precedence.

const fs = require('node:fs');
const path = require('node:path');
const { normalizeApiBase, DEFAULT_OWL_URL } = require('./owl-api.js');

const MAX_TOKEN_CHARS = 4096;

function cleanToken(value) {
  const token = String(value === undefined || value === null ? '' : value).trim();
  if (token.length > MAX_TOKEN_CHARS || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new Error('Токен содержит недопустимые символы или слишком длинный.');
  }
  return token;
}

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadSettings(file, { decrypt = null, env = {} } = {}) {
  const stored = readFile(file);
  let url = DEFAULT_OWL_URL;
  try {
    if (typeof stored.url === 'string') {
      normalizeApiBase(stored.url);
      url = stored.url;
    }
  } catch {}
  let token = '';
  if (decrypt && typeof stored.encryptedToken === 'string' && stored.encryptedToken) {
    try {
      token = cleanToken(decrypt(Buffer.from(stored.encryptedToken, 'base64')));
    } catch {
      token = '';
    }
  }
  const envUrl = String(env.OWL_BROWSER_URL || '').trim();
  if (envUrl) {
    normalizeApiBase(envUrl);
    url = envUrl;
  }
  const envToken = String(env.OWL_BROWSER_TOKEN || '').trim();
  if (envToken) token = cleanToken(envToken);
  return { url, token };
}

// Returns { url, token, persisted } where persisted says whether the token
// was saved to disk (false when encryption is unavailable).
function saveSettings(file, { url, token }, { encrypt = null } = {}) {
  const value = String(url === undefined || url === null ? '' : url).trim() || DEFAULT_OWL_URL;
  normalizeApiBase(value);
  const secret = cleanToken(token);
  const data = { url: value };
  let persisted = false;
  if (secret && encrypt) {
    data.encryptedToken = Buffer.from(encrypt(secret)).toString('base64');
    persisted = true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryFile, file);
  return { url: value, token: secret, persisted: persisted || !secret };
}

function publicSettings({ url, token }) {
  return { url, apiBase: normalizeApiBase(url), hasToken: Boolean(token) };
}

module.exports = { loadSettings, saveSettings, publicSettings, cleanToken };
