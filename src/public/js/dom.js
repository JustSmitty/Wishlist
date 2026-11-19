/**
 * Rendering helpers.
 *
 * html`` is the only way markup is built in this app. Every interpolated
 * value is escaped unless it is itself the result of html`` (or raw(), used
 * for trusted constants such as icons). Forgetting to escape is therefore not
 * possible; opting out is explicit and greppable.
 */

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function esc(value) {
  if (value === null || value === undefined || value === false) return '';
  return String(value).replace(/[&<>"'`]/g, ch => ESCAPES[ch]);
}

function toHtml(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(toHtml).join('');
  return esc(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Only for markup written in this codebase. Never pass data through this. */
export function raw(trusted) {
  return new SafeHtml(String(trusted));
}

export function render(target, content) {
  target.innerHTML = toHtml(content);
}

/** http(s) and same-site paths only; anything else becomes an inert "#". */
export function safeUrl(value) {
  if (typeof value !== 'string') return '#';
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '#';
  } catch {
    return '#';
  }
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ---------- formatting ----------

const moneyFormatters = new Map();
export function money(amount, currency = 'USD') {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '';
  const code = /^[A-Z]{3}$/.test(currency || '') ? currency : 'USD';
  if (!moneyFormatters.has(code)) {
    try {
      moneyFormatters.set(code, new Intl.NumberFormat(undefined, { style: 'currency', currency: code }));
    } catch {
      moneyFormatters.set(code, new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }));
    }
  }
  const text = moneyFormatters.get(code).format(Number(amount));
  return text.replace(/([.,])00(?=\D*$)/, '');
}

function parseDay(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function dateLong(iso) {
  const d = parseDay(iso);
  return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric' }) : '';
}

export function dateShort(iso) {
  const d = parseDay(iso);
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

export function monthAbbr(iso) {
  const d = parseDay(iso);
  return d ? d.toLocaleDateString(undefined, { month: 'short' }) : '';
}

export function dayOfMonth(iso) {
  const d = parseDay(iso);
  return d ? String(d.getDate()) : '';
}

export function daysUntil(iso) {
  const d = parseDay(iso);
  if (!d) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d - today) / 86400000);
}

export function countdown(days) {
  if (days === null || days === undefined) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${-days} days ago`;
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

export function timeAgo(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** Small stable hash for picking colours and patterns. */
export function hash(text) {
  let h = 2166136261;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatar(name, { size = 'md', child = false } = {}) {
  const tone = (hash(name) % 6) + 1;
  return html`<span class="avatar avatar--${size} tone-${tone}${child ? ' avatar--child' : ''}" aria-hidden="true">${initials(name)}</span>`;
}
