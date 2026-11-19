/** Thin fetch wrapper. The session lives in an HttpOnly cookie the page cannot read. */

const GUEST_TOKEN_KEY = 'hushlist_guest_token';

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

/**
 * Manage tokens for reservations made as a guest in this browser, one per
 * reservation, newest last. Sent only while nobody is signed in (the server
 * ignores them otherwise) and forgotten at sign-in and sign-out, so they do
 * not pass to the next person on a shared computer.
 */
export function guestToken() {
  try {
    return (localStorage.getItem(GUEST_TOKEN_KEY) || '').split(',').filter(Boolean).slice(-20).join(',');
  } catch { return ''; }
}

export function rememberGuestToken(token) {
  if (typeof token !== 'string' || !token || token.includes(',')) return;
  try {
    const kept = guestToken().split(',').filter(t => t && t !== token);
    localStorage.setItem(GUEST_TOKEN_KEY, [...kept, token].slice(-20).join(','));
  } catch { /* private mode */ }
}

export function forgetGuestTokens() {
  try { localStorage.removeItem(GUEST_TOKEN_KEY); } catch { /* private mode */ }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = guestToken();
  if (token) headers['X-Guest-Token'] = token;

  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Could not reach Hushlist. Check your connection and try again.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON */ }
  if (!res.ok) {
    throw new ApiError(data?.error || `Something went wrong (${res.status})`, res.status, data);
  }
  return data ?? {};
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const patch = (path, body = {}) => api(path, { method: 'PATCH', body });
export const del = (path, body) => api(path, { method: 'DELETE', body });
