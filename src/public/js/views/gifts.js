/** My gifts: everything you have reserved, bought or given, across everyone. */

import { html, money, plural, daysUntil, countdown, safeUrl } from '../dom.js';
import { get, patch, del } from '../api.js';
import { on, refresh, toast, openSheet, confirmSheet } from '../app.js';
import { icon, empty } from '../parts.js';
import { giftArt } from '../art.js';
import { confetti } from '../confetti.js';

const COLUMNS = [
  ['reserved', 'Reserved', 'reserved', 'Things you have put your name on. Buy them, or release them for someone else.'],
  ['purchased', 'Bought', 'bought', 'Bought and waiting to be wrapped.'],
  ['given', 'Given', 'bought', 'Done. Nice work.']
];

export default {
  title: () => 'My gifts',

  async load() {
    const dash = await get('/api/dashboard');
    return { claims: dash.my_claims_tracker, pledges: dash.my_pledges };
  },

  render({ claims, pledges }) {
    const by = (status) => claims.filter(c => c.status === status);
    const withdrawn = by('withdrawn');
    const total = claims.filter(c => ['reserved', 'purchased', 'given'].includes(c.status))
      .reduce((s, c) => s + (c.item_price || 0) * c.qty, 0) + pledges.reduce((s, p) => s + p.pledged_amount, 0);

    if (claims.length === 0 && pledges.length === 0) {
      return html`
        <header class="page-head"><div><p class="eyebrow">My gifts</p><h1>Nothing reserved yet</h1></div></header>
        ${empty({
          title: 'Your gift tracker starts here',
          text: 'When you reserve something from a list it shows up here, so you can follow it from "reserved" to "given".',
          seed: 'gifts',
          action: html`<a class="btn btn--primary" href="/gifting" data-link>See who you shop for</a>`
        })}`;
    }

    return html`
      <header class="page-head">
        <div>
          <p class="eyebrow">My gifts</p>
          <h1>What you are giving</h1>
          <p>Only you see this page. Recipients never do.</p>
        </div>
      </header>

      <div class="stats">
        <div class="card stat"><div class="stat__num">${by('reserved').length}</div><div class="stat__label">to buy</div></div>
        <div class="card stat"><div class="stat__num">${by('purchased').length}</div><div class="stat__label">to wrap</div></div>
        <div class="card stat"><div class="stat__num">${by('given').length}</div><div class="stat__label">given</div></div>
        <div class="card stat"><div class="stat__num">${money(total) || '$0'}</div><div class="stat__label">across all of it</div></div>
      </div>

      ${withdrawn.length ? html`
        <div class="notice notice--honey">
          ${icon('flag')}
          <div><strong>${plural(withdrawn.length, 'wish', 'wishes')} you reserved ${withdrawn.length === 1 ? 'is' : 'are'} no longer wanted</strong>
          ${withdrawn.map(c => `"${c.item_title}" for ${c.recipient_name}`).join(', ')}. No need to buy ${withdrawn.length === 1 ? 'it' : 'them'}.</div>
        </div>` : ''}

      <div class="board">
        ${COLUMNS.map(([status, label, art, hint]) => html`
          <section class="column" aria-label="${label}">
            <div class="column__head"><h2>${label} <span class="pill">${by(status).length}</span></h2></div>
            ${by(status).length === 0 ? html`<p class="column__empty">${hint}</p>` : by(status).map(c => giftCard(c, art))}
          </section>`)}
      </div>

      ${pledges.length ? html`
        <div class="section-title"><h2>Group gifts you are chipping in to</h2></div>
        <div class="grid">
          ${pledges.map(p => html`
            <article class="card gift">
              <div class="gift__top">
                <span class="gift__thumb">${giftArt({ id: p.item_id, title: p.item_title, kind: p.item_kind })}</span>
                <div class="grow">
                  <div class="gift__title">${p.item_title}</div>
                  <div class="gift__for">for ${p.recipient_name} · ${money(p.pledged_amount)} of ${money(p.item_price)}</div>
                </div>
              </div>
              <div class="row"><a class="btn btn--sm" href="/l/${p.list_id}" data-link>Open the list</a>
                <button class="btn btn--sm btn--quiet" type="button" data-action="gift-withdraw-pledge" data-pledge="${p.id}">Withdraw</button></div>
            </article>`)}
        </div>` : ''}`;
  }
};

function giftCard(c, art) {
  const holdDays = c.status === 'reserved' ? daysUntil(c.expires_at) : null;
  const eventDays = daysUntil(c.list_event_date);
  return html`
    <article class="card gift">
      <div class="gift__top">
        <span class="gift__thumb">${giftArt({ id: c.item_id, title: c.item_title, kind: c.item_kind }, art)}</span>
        <div class="grow">
          <div class="gift__title">${c.item_title}${c.qty > 1 ? ` × ${c.qty}` : ''}</div>
          <div class="gift__for">for <a href="/l/${c.list_id}" data-link>${c.recipient_name}</a>${c.item_price ? ` · ${money(c.item_price * c.qty)}` : ''}</div>
          <div class="row small">
            ${eventDays !== null && eventDays >= 0 && c.status !== 'given' ? html`<span class="pill pill--sky">needed ${countdown(eventDays)}</span>` : ''}
            ${holdDays !== null ? html`<span class="pill ${holdDays <= 2 ? 'pill--ribbon' : ''}">hold ends ${countdown(holdDays)}</span>` : ''}
            ${c.item_status !== 'active' && c.item_status !== 'received' ? html`<span class="pill pill--honey">taken off the list</span>` : ''}
          </div>
        </div>
      </div>
      ${c.order_note ? html`<p class="gift__note">${c.order_note}</p>` : ''}
      <div class="row">
        ${c.status === 'reserved' ? html`<button class="btn btn--sm btn--primary" type="button" data-action="gift-state" data-claim="${c.id}" data-next="purchased">${icon('check', { size: 16 })} Bought it</button>` : ''}
        ${c.status === 'purchased' ? html`<button class="btn btn--sm btn--primary" type="button" data-action="gift-state" data-claim="${c.id}" data-next="given">${icon('gift', { size: 16 })} Given</button>` : ''}
        ${c.item_url && c.status === 'reserved' ? html`<a class="btn btn--sm" href="${safeUrl(c.item_url)}" target="_blank" rel="noopener noreferrer" data-action="gift-out" data-claim="${c.id}">Shop ${icon('external', { size: 15 })}</a>` : ''}
        <span class="grow"></span>
        <details class="menu menu--up">
          <summary class="btn btn--sm btn--icon btn--quiet" aria-label="More options for ${c.item_title}">${icon('more')}</summary>
          <div class="menu__panel" role="menu">
            <button class="menu__item" type="button" role="menuitem" data-action="gift-note" data-claim="${c.id}" data-note="${c.order_note || ''}">${icon('edit', { size: 18 })} ${c.order_note ? 'Edit my note' : 'Add a note'}</button>
            ${c.status === 'purchased' ? html`<button class="menu__item" type="button" role="menuitem" data-action="gift-state" data-claim="${c.id}" data-next="reserved">${icon('back', { size: 18 })} Not bought after all</button>` : ''}
            ${c.status === 'given' ? html`<button class="menu__item" type="button" role="menuitem" data-action="gift-state" data-claim="${c.id}" data-next="purchased">${icon('back', { size: 18 })} Not given yet</button>` : ''}
            ${c.status !== 'given' ? html`<button class="menu__item menu__item--danger" type="button" role="menuitem" data-action="gift-release" data-claim="${c.id}" data-title="${c.item_title}">${icon('close', { size: 18 })} Release it</button>` : ''}
          </div>
        </details>
      </div>
    </article>`;
}

on('gift-state', async (el) => {
  await patch(`/api/claims/${el.dataset.claim}`, { status: el.dataset.next });
  if (el.dataset.next === 'purchased' || el.dataset.next === 'given') confetti(el);
  await refresh();
});

on('gift-release', async (el) => {
  const ok = await confirmSheet({ title: 'Release this gift?', message: `"${el.dataset.title}" goes back to being available for someone else to give.`, confirmLabel: 'Release', danger: true });
  if (!ok) return;
  await patch(`/api/claims/${el.dataset.claim}`, { status: 'released' });
  toast('Released');
  await refresh();
});

on('gift-out', (el) => {
  patch(`/api/claims/${el.dataset.claim}`, { action: 'click_out' }).catch(() => {});
});

on('gift-note', (el) => {
  openSheet({
    title: 'Note to self', intro: 'Order numbers, hiding places. Only you see it.', size: 'narrow',
    body: html`<div class="field"><label for="gn-note">Note</label><textarea id="gn-note" name="note" maxlength="500">${el.dataset.note}</textarea></div>`,
    onSubmit: async (v) => {
      await patch(`/api/claims/${el.dataset.claim}`, { action: 'set_note', order_note: v.note });
      toast('Saved');
      await refresh();
    }
  });
});

on('gift-withdraw-pledge', async (el) => {
  const ok = await confirmSheet({ title: 'Withdraw your pledge?', message: 'The amount goes back to "still needed".', confirmLabel: 'Withdraw' });
  if (!ok) return;
  await del(`/api/contributions/${el.dataset.pledge}`);
  toast('Pledge withdrawn');
  await refresh();
});
