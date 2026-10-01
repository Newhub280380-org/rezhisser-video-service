'use strict';

// User accounts: scrypt password hashes and HS256 JWT access tokens, using
// only node:crypto. Tokens carry the user's token_version so a password reset
// invalidates every previously issued token.

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const MIN_SECRET = 32;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@.]{2,63}$/;

class AccountError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.status = status;
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new AccountError('invalid_email', 'Укажите email.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AccountError('invalid_email', 'Некорректный email.');
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD || value.length > MAX_PASSWORD) {
    throw new AccountError('weak_password', `Пароль должен быть от ${MIN_PASSWORD} до ${MAX_PASSWORD} символов.`);
  }
  return value;
}

function scrypt(password, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// A valid hash of a random password, used to keep login timing the same
// whether or not the email exists.
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N > 1 << 20) return false;
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password, Buffer.from(parts[4], 'base64'), { ...SCRYPT, N, r, p, keylen: expected.length });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createTokenService({ secret, ttlSeconds = 7 * 24 * 3600, now = Date.now }) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET} characters long.`);
  }
  const key = Buffer.from(secret);
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });

  function sign(data) {
    return crypto.createHmac('sha256', key).update(data).digest();
  }

  return {
    issue(user) {
      const iat = Math.floor(now() / 1000);
      const payload = b64urlJson({ sub: user.id, tv: user.tokenVersion, iat, exp: iat + ttlSeconds });
      const body = `${header}.${payload}`;
      return { token: `${body}.${sign(body).toString('base64url')}`, expiresAt: new Date((iat + ttlSeconds) * 1000).toISOString() };
    },
    // Returns the payload of a valid, unexpired token, or null.
    verify(token) {
      if (typeof token !== 'string' || token.length > 2048) return null;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== header) return null;
      const given = Buffer.from(parts[2], 'base64url');
      const expected = sign(`${parts[0]}.${parts[1]}`);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!payload || typeof payload.sub !== 'string' || !Number.isInteger(payload.exp)) return null;
      if (payload.exp * 1000 <= now()) return null;
      return payload;
    },
  };
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value, extra] = header.trim().split(/\s+/);
  if (extra !== undefined || !value || scheme.toLowerCase() !== 'bearer') return null;
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  AccountError,
  normalizeEmail,
  validatePassword,
  hashPassword,
  verifyPassword,
  getDummyHash,
  createTokenService,
  bearerToken,
  hashResetToken,
  MIN_SECRET,
};
