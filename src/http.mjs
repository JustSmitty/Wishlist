/**
 * Small HTTP helpers shared by the request handler: body parsing, cookies,
 * responses, rate limiting and static files. No framework, no dependencies.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, badRequest } from './errors.mjs';

export const SESSION_COOKIE = 'hl_session';
const MAX_BODY_BYTES = 1024 * 1024;

export function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

/**
 * Reads a JSON object body. Rejects anything that is not a JSON object
 * (null, arrays, strings, numbers), anything over 1 MB, and — because the
 * session cookie is SameSite=Lax and cross-site forms cannot send this
 * content type without a CORS preflight — anything that is not declared as
 * application/json.
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => { if (!done) { done = true; reject(err); } };

    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new AppError('Request body is too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => fail(badRequest('Could not read the request')));
    req.on('end', () => {
      if (done) return;
      done = true;
      if (size === 0) return resolve({});
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') {
        return reject(new AppError('Send the request body as application/json', 415));
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(badRequest('The request body is not valid JSON'));
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(badRequest('The request body must be a JSON object'));
      }
      resolve(parsed);
    });
  });
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds, { secure = false } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** Fixed-window limiter with bounded memory. */
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.lastSweep = Date.now();
  }

  /** Returns true when the call is allowed. */
  allow(key, maxRequests, windowMs = 60_000) {
    const now = Date.now();
    if (now - this.lastSweep > 60_000 || this.buckets.size > 50_000) this.sweep(now);
    const entry = this.buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= maxRequests;
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.buckets) {
      if (now >= entry.resetAt) this.buckets.delete(key);
    }
    // Hard ceiling: under a flood of distinct keys, drop the oldest half.
    if (this.buckets.size > 50_000) {
      let drop = Math.floor(this.buckets.size / 2);
      for (const key of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(key);
      }
    }
    this.lastSweep = now;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Serves a file from publicDir. Paths without a file extension are app routes
 * and get index.html; a missing asset is a real 404 instead of HTML with a
 * 200 status. Returns false if nothing was sent.
 */
export async function serveStatic(req, res, publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw badRequest('Malformed URL');
  }
  if (decoded.includes('\0')) throw badRequest('Malformed URL');

  const isAppRoute = decoded === '/' || path.extname(decoded) === '';
  const relative = isAppRoute ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relative);
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) return false;

  let data;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    // Always revalidate code and markup so a deploy is picked up immediately;
    // fonts and icons are content-stable and can be cached.
    'Cache-Control': ['.woff2', '.png', '.ico'].includes(ext) ? 'public, max-age=604800' : 'no-cache'
  };
  if (path.basename(filePath) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}

export function csvCell(val) {
  let s = String(val ?? '');
  // Spreadsheet applications execute cells that start with these characters.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
