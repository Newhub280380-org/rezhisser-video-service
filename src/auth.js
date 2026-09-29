'use strict';

// Private-beta access control for billable actions.
//
// - One operator-provided secret (BETA_ACCESS_KEY, min 24 chars) is exchanged
//   for a random server-side session stored in memory.
// - The session id travels only in an HttpOnly, SameSite=Strict cookie.
// - State-changing requests on a session also need the per-session CSRF token
//   (X-CSRF-Token header) and a same-origin Origin header.
// - Login attempts are rate limited per IP and globally.
//
// This is NOT a user-account system: everyone with the key shares the same
// privileges. Sessions are lost on restart and are not shared between
// instances.

const crypto = require('node:crypto');

const COOKIE_NAME = 'rv_session';
const MIN_KEY_LENGTH = 24;

function digest(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest();
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

function createAuth({ accessKey, sessionTtlMs = 8 * 60 * 60 * 1000, now = Date.now } = {}) {
  const key = typeof accessKey === 'string' ? accessKey.trim() : '';
  if (key && key.length < MIN_KEY_LENGTH) {
    throw new Error(`BETA_ACCESS_KEY must be at least ${MIN_KEY_LENGTH} characters long.`);
  }
  const configured = key.length > 0;
  const hmacSecret = crypto.randomBytes(32);
  const expected = configured ? digest(hmacSecret, key) : null;
  const sessions = new Map();

  function prune() {
    const t = now();
    for (const [id, session] of sessions) if (session.expiresAt <= t) sessions.delete(id);
  }

  return {
    configured,
    cookieName: COOKIE_NAME,
    verifyKey(candidate) {
      if (!configured || typeof candidate !== 'string' || candidate.length > 512) return false;
      return crypto.timingSafeEqual(digest(hmacSecret, candidate.trim()), expected);
    },
    createSession() {
      prune();
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
      const id = crypto.randomBytes(32).toString('base64url');
      const session = {
        id,
        csrfToken: crypto.randomBytes(32).toString('base64url'),
        createdAt: now(),
        expiresAt: now() + sessionTtlMs,
      };
      sessions.set(id, session);
      return session;
    },
    getSession(req) {
      if (!configured) return null;
      const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
      if (!id || id.length > 128) return null;
      const session = sessions.get(id);
      if (!session) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(id);
        return null;
      }
      return session;
    },
    destroySession(session) {
      if (session) sessions.delete(session.id);
    },
    checkCsrf(req, session) {
      const header = req.headers['x-csrf-token'];
      if (!session || typeof header !== 'string') return false;
      const given = Buffer.from(header);
      const expectedToken = Buffer.from(session.csrfToken);
      if (given.length !== expectedToken.length) return false;
      return crypto.timingSafeEqual(given, expectedToken);
    },
    sessionCookie(session, secure) {
      const maxAge = Math.max(0, Math.floor((session.expiresAt - now()) / 1000));
      return `${COOKIE_NAME}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    },
    clearCookie(secure) {
      return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
    },
    sessionCount() {
      prune();
      return sessions.size;
    },
  };
}

module.exports = { createAuth, parseCookies, COOKIE_NAME, MIN_KEY_LENGTH };
