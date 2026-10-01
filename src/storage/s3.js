'use strict';

// S3-compatible object storage (Backblaze B2, AWS S3, MinIO, Cloudflare R2)
// with AWS Signature Version 4, implemented on node:crypto + fetch.

const crypto = require('node:crypto');
const { assertHttpsBase } = require('../http-client.js');

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const KEY_PATTERN = /^[A-Za-z0-9!_.*'()/-]{1,512}$/;

class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// RFC 3986 encoding as required by SigV4 (slashes kept in object keys).
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(value) {
  return value.split('/').map(encodeRfc3986).join('/');
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secret, dateStamp, region) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), 's3'), 'aws4_request');
}

function createS3Storage({
  endpoint,
  region = 'us-east-1',
  bucket,
  accessKeyId,
  secretAccessKey,
  forcePathStyle = true,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 120000,
  maxObjectBytes = 300 * 1024 * 1024,
}) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const base = new URL(assertHttpsBase(endpoint, 'S3_ENDPOINT'));
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('S3_BUCKET is not a valid bucket name.');
  const host = forcePathStyle ? base.host : `${bucket}.${base.host}`;
  const origin = `${base.protocol}//${host}`;

  function objectPath(key) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.split('/').some((part) => part === '..' || part === '.')) {
      throw new StorageError('invalid_key', 'Invalid object key.');
    }
    return forcePathStyle ? `/${bucket}/${encodePath(key)}` : `/${encodePath(key)}`;
  }

  function scope(dateStamp) {
    return `${dateStamp}/${region}/s3/aws4_request`;
  }

  function signature(dateStamp, stringToSign) {
    return hmac(signingKey(secretAccessKey, dateStamp, region), stringToSign).toString('hex');
  }

  function authorizationHeaders(method, canonicalPath, payloadHash, extraHeaders = {}) {
    const date = now();
    const stamp = amzDate(date);
    const dateStamp = stamp.slice(0, 8);
    const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp, ...extraHeaders };
    const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [method, canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope(dateStamp), sha256Hex(canonicalRequest)].join('\n');
    const { host: _host, ...sendHeaders } = headers;
    return {
      ...sendHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope(dateStamp)}, SignedHeaders=${signedHeaders}, Signature=${signature(dateStamp, stringToSign)}`,
    };
  }

  async function send(method, key, { body, contentType } = {}) {
    const canonicalPath = objectPath(key);
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    const extra = contentType ? { 'content-type': contentType } : {};
    const headers = authorizationHeaders(method, canonicalPath, payloadHash, extra);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${origin}${canonicalPath}`, { method, headers, body, signal: controller.signal, redirect: 'error' });
      await res.arrayBuffer().catch(() => null);
      return res.status;
    } catch {
      throw new StorageError('storage_unreachable', 'Object storage is unreachable.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    bucket,
    async putObject(key, body, contentType = 'application/octet-stream') {
      const status = await send('PUT', key, { body, contentType });
      if (status < 200 || status >= 300) throw new StorageError('storage_error', `PutObject failed with HTTP ${status}.`);
      return { key, bytes: body.length };
    },
    async deleteObject(key) {
      const status = await send('DELETE', key);
      if ((status < 200 || status >= 300) && status !== 404) {
        throw new StorageError('storage_error', `DeleteObject failed with HTTP ${status}.`);
      }
      return true;
    },
    // Pre-signed GET URL (query-string authentication), default 1 hour.
    presignGet(key, expiresSeconds = 3600, { downloadName } = {}) {
      const canonicalPath = objectPath(key);
      const date = now();
      const stamp = amzDate(date);
      const dateStamp = stamp.slice(0, 8);
      const params = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${accessKeyId}/${scope(dateStamp)}`,
        'X-Amz-Date': stamp,
        'X-Amz-Expires': String(Math.min(604800, Math.max(1, Math.floor(expiresSeconds)))),
        'X-Amz-SignedHeaders': 'host',
      };
      if (downloadName) params['response-content-disposition'] = `attachment; filename="${downloadName.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
      const query = Object.keys(params)
        .sort()
        .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(params[name])}`)
        .join('&');
      const canonicalRequest = ['GET', canonicalPath, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
      const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope(dateStamp), sha256Hex(canonicalRequest)].join('\n');
      return `${origin}${canonicalPath}?${query}&X-Amz-Signature=${signature(dateStamp, stringToSign)}`;
    },
    // Downloads a provider result (https only, size-capped) into the bucket.
    async copyFromUrl(url, key, contentType = 'video/mp4') {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new StorageError('invalid_source', 'Source URL is invalid.');
      }
      if (parsed.protocol !== 'https:') throw new StorageError('invalid_source', 'Source URL must use https.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let buffer;
      try {
        const res = await fetchImpl(parsed.toString(), { signal: controller.signal });
        if (!res.ok) throw new StorageError('source_error', `Source download failed with HTTP ${res.status}.`);
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxObjectBytes) throw new StorageError('source_too_large', 'Video is too large.');
        buffer = Buffer.from(await res.arrayBuffer());
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError('source_unreachable', 'Could not download the generated video.');
      } finally {
        clearTimeout(timer);
      }
      if (buffer.length === 0 || buffer.length > maxObjectBytes) throw new StorageError('source_too_large', 'Video is empty or too large.');
      return this.putObject(key, buffer, contentType);
    },
  };
}

module.exports = { createS3Storage, StorageError, encodeRfc3986 };
