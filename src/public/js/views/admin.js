/** Admin: reports, reservation overrides, the audit trail, store settings. */

import { html, raw, timeAgo, plural } from '../dom.js';
import { get, post, patch } from '../api.js';
import { store, me, on, refresh, rerender, toast, openSheet } from '../app.js';
import { icon, empty } from '../parts.js';

const ui = { tab: 'reports' };
const TABS = [['reports', 'Reports'], ['holds', 'Reservations'], ['audit', 'Audit trail'], ['stores', 'Stores'], ['activity', 'Activity']];

export default {
  title: () => 'Admin',

  async load() {
    if (!me()?.is_admin) return { forbidden: true };
    return get('/api/admin');
  },

  render(data) {
    if (data.forbidden) {
      return empty({ title: 'Administrators only', text: 'This area is for the people who run this Hushlist.', seed: 'admin' });
    }
    const open = data.abuse_reports.filter(r => r.status === 'open').length;
    return html`
      <header class="page-head">
        <div>
          <p class="eyebrow">Admin</p>
          <h1>Running the place</h1>
          <p>Lists you own in surprise mode are left out of everything here. Being an administrator does not spoil your own surprise.</p>
        </div>
      </header>
      <div class="tabs" role="group" aria-label="Admin sections">
        ${TABS.map(([value, label]) => html`<button type="button" class="chip" aria-pressed="${ui.tab === value}" data-action="admin-tab" data-value="${value}">${label}${value === 'reports' && open ? ` (${open})` : ''}</button>`)}
      </div>
      ${ui.tab === 'reports' ? reports(data.abuse_reports) : ''}
      ${ui.tab === 'holds' ? holds(data.overridable_claims) : ''}
      ${ui.tab === 'audit' ? audit(data.claim_audit_log) : ''}
      ${ui.tab === 'stores' ? stores(data.retailer_adapters) : ''}
      ${ui.tab === 'activity' ? activity(data.analytics_events) : ''}`;
  }
};

const table = (head, rows) => html`<div class="tablewrap"><table class="table"><thead><tr>${head.map(h => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`;

function reports(list) {
  if (list.length === 0) return empty({ title: 'No reports', text: 'When someone reports a list, an item or a person, it appears here.', seed: 'reports' });
  return table(['When', 'About', 'Reason', 'Status', ''], list.map(r => html`
    <tr>
      <td class="nowrap">${timeAgo(r.created_at)}</td>
      <td>${r.target_type}<br /><code>${r.target_id}</code></td>
      <td>${r.reason}${r.resolution_note ? html`<br /><span class="muted small">Note: ${r.resolution_note}</span>` : ''}</td>
      <td><span class="pill ${r.status === 'open' ? 'pill--ribbon' : ''}">${r.status}</span></td>
      <td class="nowrap">${r.status === 'open' ? html`
        <button class="btn btn--sm" type="button" data-action="report-close" data-report="${r.id}" data-status="resolved">Resolve</button>
        <button class="btn btn--sm btn--quiet" type="button" data-action="report-close" data-report="${r.id}" data-status="dismissed">Dismiss</button>` : ''}</td>
    </tr>`));
}

function holds(list) {
  if (list.length === 0) return empty({ title: 'No open reservations', text: 'Reservations you are allowed to release would be listed here.', seed: 'holds' });
  return html`
    <p class="muted small">Releasing a reservation tells the giver why, and is written to the audit trail with your reason.</p>
    ${table(['Item', 'List', 'Held by', 'Status', ''], list.map(c => html`
      <tr>
        <td><strong>${c.item_title}</strong>${c.qty > 1 ? ` × ${c.qty}` : ''}</td>
        <td>${c.list_name}</td>
        <td>${c.claimer_name}</td>
        <td><span class="pill">${c.status.replace('_', ' ')}</span></td>
        <td><button class="btn btn--sm btn--danger" type="button" data-action="admin-release" data-claim="${c.id}" data-title="${c.item_title}">Release</button></td>
      </tr>`))}`;
}

function audit(list) {
  if (list.length === 0) return empty({ title: 'Nothing recorded yet', text: 'Every change to a reservation is written here.', seed: 'audit' });
  return table(['When', 'Item', 'Change', 'By', 'Reason'], list.map(a => html`
    <tr><td class="nowrap">${timeAgo(a.at)}</td><td>${a.item_title}</td><td class="nowrap">${a.from_state || 'new'} → <strong>${a.to_state}</strong></td><td>${a.actor}</td><td>${a.reason || ''}</td></tr>`));
}

function stores(list) {
  return html`
    <div class="row row--between">
      <p class="muted small">How Hushlist reads product pages for each shop when the browser extension sends one. ${plural(list.length, 'shop')}.</p>
      <button class="btn btn--sm btn--primary" type="button" data-action="adapter-edit">${icon('plus', { size: 16 })} Add a shop</button>
    </div>
    ${table(['Shop', 'Domain', 'Title', 'Price', 'Read by', 'Complete captures', ''], list.map(a => html`
      <tr>
        <td><strong>${a.store_name}</strong></td>
        <td><code>${a.domain}</code></td>
        <td><code>${a.title_selector || '—'}</code></td>
        <td><code>${a.price_selector || '—'}</code></td>
        <td>${a.client_only ? html`<span class="pill pill--honey">Extension only</span>` : html`<span class="pill">Extension</span>`}</td>
        <td>${a.capture_attempts > 0 ? `${a.capture_successes} of ${a.capture_attempts}` : html`<span class="muted">none yet</span>`}</td>
        <td><button class="btn btn--sm btn--quiet" type="button" data-action="adapter-edit" data-domain="${a.domain}">Edit</button></td>
      </tr>`))}`;
}

function activity(list) {
  if (list.length === 0) return empty({ title: 'No activity yet', text: 'Counts of what people do — never item names, links or who did it.', seed: 'activity' });
  return html`
    <p class="muted small">First-party only. No item names, no links, no identities.</p>
    ${table(['When', 'Event', 'Details'], list.map(e => html`<tr><td class="nowrap">${timeAgo(e.created_at)}</td><td>${e.event_name.replace(/_/g, ' ')}</td><td><code>${e.properties}</code></td></tr>`))}`;
}

on('admin-tab', (el) => { ui.tab = el.dataset.value; rerender(); });

on('report-close', (el) => {
  openSheet({
    title: el.dataset.status === 'resolved' ? 'Resolve report' : 'Dismiss report', size: 'narrow',
    body: html`<div class="field"><label for="rc-note">Note <span class="muted">(optional)</span></label><textarea id="rc-note" name="note" maxlength="500"></textarea></div>`,
    submitLabel: el.dataset.status === 'resolved' ? 'Resolve' : 'Dismiss',
    onSubmit: async (v) => {
      await patch(`/api/admin/reports/${el.dataset.report}`, { status: el.dataset.status, resolution_note: v.note });
      await refresh();
    }
  });
});

on('admin-release', (el) => {
  openSheet({
    title: 'Release this reservation', intro: `"${el.dataset.title}". The giver is told, with your reason.`, size: 'narrow', danger: true, submitLabel: 'Release',
    body: html`<div class="field"><label for="ar-reason">Reason</label><input id="ar-reason" name="reason" required maxlength="300" placeholder="Reported as a duplicate" /></div>`,
    onSubmit: async (v) => {
      await post('/api/admin/claims/override', { claim_id: el.dataset.claim, reason: v.reason });
      toast('Released and recorded');
      await refresh();
    }
  });
});

on('adapter-edit', (el) => {
  const a = store.current.data.retailer_adapters.find(x => x.domain === el.dataset.domain) || {};
  const field = (name, label, placeholder = '') => html`<div class="field"><label for="ad-${name}">${label}</label><input id="ad-${name}" name="${name}" maxlength="300" value="${a[name] || ''}" placeholder="${placeholder}" /></div>`;
  openSheet({
    title: a.domain ? `Edit ${a.store_name}` : 'Add a shop',
    body: html`
      <div class="fields">
        <div class="field"><label for="ad-domain">Domain</label><input id="ad-domain" name="domain" required maxlength="253" value="${a.domain || ''}" placeholder="example-shop.com" ${a.domain ? raw('readonly') : ''} /></div>
        <div class="field"><label for="ad-store">Shop name</label><input id="ad-store" name="store_name" required maxlength="80" value="${a.store_name || ''}" /></div>
      </div>
      <p class="small muted">Selectors: an id (<code>#title</code>), a class (<code>.price</code>) or an attribute (<code>[data-test="price"]</code>). Separate alternatives with commas.</p>
      ${field('title_selector', 'Title')}
      ${field('price_selector', 'Price')}
      ${field('image_selector', 'Image')}
      ${field('variant_selector', 'Size / colour')}
      <label class="check"><input type="checkbox" name="client_only" ${a.client_only ? raw('checked') : ''} /><span>Extension only<small>Never read this shop's pages any other way.</small></span></label>`,
    onSubmit: async (v) => {
      await post('/api/admin/adapters', v);
      toast('Saved');
      await refresh();
    }
  });
});
