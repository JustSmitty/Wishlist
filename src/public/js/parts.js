/** Small shared pieces of UI used by several views. */

import { html, raw, money, daysUntil, countdown, dateLong } from './dom.js';
import { icon } from './icons.js';
import { giftArt } from './art.js';

export const PRIORITY = {
  most_wanted: { label: 'Most wanted', flag: 'most' },
  high: { label: 'Would love', flag: 'high' },
  normal: { label: 'Wanted', flag: null },
  low: { label: 'Nice to have', flag: null }
};

export const KIND = {
  product: { label: 'Something to buy', short: 'Product', icon: 'box' },
  experience: { label: 'An experience', short: 'Experience', icon: 'ticket' },
  cash: { label: 'A fund', short: 'Fund', icon: 'coin' },
  idea: { label: 'An idea', short: 'Idea', icon: 'bulb' }
};

export function priceTag(item) {
  if (item.price === null || item.price === undefined) {
    return html`<span class="tag tag--empty">${item.kind === 'cash' ? 'Any amount' : 'No set price'}</span>`;
  }
  return html`<span class="tag">${money(item.price, item.currency)}</span>`;
}

/** Wax seal: closed (sealed list) or open (claims visible). */
export function seal(open = false) {
  const mark = open
    ? '<path d="M22 30l7 7 14-15" fill="none" stroke="#fffdf8" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M21 35c0-9 5-15 11-15s11 6 11 15M27 41h10" fill="none" stroke="#fffdf8" stroke-width="3.2" stroke-linecap="round"/><circle cx="27" cy="31" r="1.8" fill="#fffdf8"/><circle cx="37" cy="31" r="1.8" fill="#fffdf8"/>';
  return raw(`<svg class="seal${open ? ' seal--open' : ''}" viewBox="0 0 64 64" aria-hidden="true">
    <path fill="currentColor" d="M32 3l5.2 4.3 6.7-.9 2.6 6.2 6.2 2.6-.9 6.7L56 27l-2.3 6.3 2.3 6.3-4.2 5.2.9 6.7-6.2 2.6-2.6 6.2-6.7-.9L32 63.7l-5.2-4.3-6.7.9-2.6-6.2-6.2-2.6.9-6.7L8 39.6l2.3-6.3L8 27l4.2-5.1-.9-6.7 6.2-2.6 2.6-6.2 6.7.9z"/>
    <circle cx="32" cy="33" r="20" fill="#000" fill-opacity=".12"/>
    ${mark}
  </svg>`);
}

/** Countdown ring. Fills as the day approaches (full at 0 days, empty at 60+). */
export function ring(days, { small = false, label = null } = {}) {
  const r = 34;
  const circumference = 2 * Math.PI * r;
  const clamped = days === null || days === undefined ? 0 : Math.max(0, Math.min(1, 1 - days / 60));
  const arc = (circumference * clamped).toFixed(1);
  const shown = days === null || days === undefined ? '–' : days < 0 ? '✓' : String(days);
  const unit = days === null || days === undefined ? 'no date' : days < 0 ? 'passed' : days === 1 ? 'day' : 'days';
  return html`
    <div class="ring${small ? ' ring--sm' : ''}" role="img" aria-label="${label || (days === null || days === undefined ? 'No date set' : days < 0 ? 'Date has passed' : `${days} ${unit} to go`)}">
      ${raw(`<svg viewBox="0 0 80 80" aria-hidden="true"><circle class="ring__track" cx="40" cy="40" r="${r}" fill="none" stroke-width="7"/><circle class="ring__arc" cx="40" cy="40" r="${r}" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${arc} ${circumference.toFixed(1)}"/></svg>`)}
      <div class="ring__label" aria-hidden="true"><span class="ring__num">${shown}</span><span class="ring__unit">${unit}</span></div>
    </div>`;
}

export function whenLine(iso) {
  const days = daysUntil(iso);
  if (days === null) return '';
  return `${dateLong(iso)} · ${countdown(days)}`;
}

export function sparkline(history = []) {
  const prices = history.map(p => Number(p.price)).filter(p => Number.isFinite(p) && p > 0);
  if (prices.length < 2) return '';
  // A loop, not Math.min(...prices): spreading a long array overflows the stack.
  let min = Infinity;
  let max = -Infinity;
  for (const p of prices) { if (p < min) min = p; if (p > max) max = p; }
  const range = max - min || 1;
  const points = prices.map((p, i) => `${(2 + (i / (prices.length - 1)) * 52).toFixed(1)},${(15 - ((p - min) / range) * 12).toFixed(1)}`).join(' ');
  return raw(`<svg viewBox="0 0 56 18" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${points}"/></svg>`);
}

export function empty({ title, text, seed = 'empty', action = null }) {
  return html`
    <div class="card card--sunk empty">
      <div class="empty__art">${giftArt({ id: seed, title: seed, kind: 'product' })}</div>
      <h2>${title}</h2>
      <p>${text}</p>
      ${action || ''}
    </div>`;
}

export function filterChips(options, active, action) {
  return html`<div class="chips" role="group" aria-label="Filter">
    ${options.map(([value, label]) => html`<button type="button" class="chip" aria-pressed="${active === value ? 'true' : 'false'}" data-action="${action}" data-value="${value}">${label}</button>`)}
  </div>`;
}

export function sortItems(items, sortBy) {
  const rank = { most_wanted: 0, high: 1, normal: 2, low: 3 };
  const list = [...items];
  if (sortBy === 'price_asc') list.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  else if (sortBy === 'price_desc') list.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  else if (sortBy === 'newest') list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  else list.sort((a, b) => (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2) || a.sort_order - b.sort_order);
  return list;
}

export function matchesSearch(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [item.title, item.store, item.notes, item.variant].some(v => String(v || '').toLowerCase().includes(q));
}

export function sortSelect(value, inputName) {
  const options = [['priority', 'Most wanted first'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['newest', 'Newest first']];
  return html`
    <label class="sr-only" for="sort-${inputName}">Sort</label>
    <select id="sort-${inputName}" data-input="${inputName}" class="nowrap">
      ${options.map(([v, l]) => html`<option value="${v}" ${v === value ? raw('selected') : ''}>${l}</option>`)}
    </select>`;
}

export { icon };
