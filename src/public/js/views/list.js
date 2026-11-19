/** A list as givers see it: by share link (signed in or not) or from Gifting. */

import { html, raw, money, dateLong, daysUntil, countdown, plural, safeUrl } from '../dom.js';
import { get, post, patch, del, rememberGuestToken } from '../api.js';
import { store, me, on, onInput, refresh, rerender, toast, openSheet, confirmSheet } from '../app.js';
import { icon, ring, seal, empty, filterChips, sortItems, matchesSearch, sortSelect } from '../parts.js';
import { cardTop, cardFacts } from './home.js';
import { avatar } from '../dom.js';
import { confetti } from '../confetti.js';

const ui = { filter: 'all', sort: 'priority', query: '' };

export default {
  title: (data) => data.list.name,

  async load(params) {
    const { list } = await get(`/api/lists/${encodeURIComponent(params[0])}`);
    return { list };
  },

  render({ list }) {
    const days = daysUntil(list.event_date);
    const active = list.items.filter(i => i.status === 'active');
    const visible = sortItems(active.filter(i => passes(i) && matchesSearch(i, ui.query)), ui.sort);
    const first = list.owner_name.split(' ')[0];
    const isOwner = list.viewer_role === 'owner';
    const pendingPrompts = [];
    for (const item of active) {
      for (const c of item.claim_summary?.claims || []) {
        if (c.is_own_claim && c.status === 'reserved' && c.clicked_out_at && !c.return_prompt_answered) pendingPrompts.push({ claim: c, item });
      }
    }

    return html`
      <section class="card hero" aria-labelledby="list-title">
        <div>
          <div class="row">
            ${avatar(list.owner_name, { child: list.owner_is_dependent })}
            <p class="eyebrow">${list.occasion} · ${list.owner_name}</p>
          </div>
          <h1 class="hero__title" id="list-title">${list.name}</h1>
          <div class="hero__meta">
            <span>${icon('calendar', { size: 17 })} ${list.event_date ? `${dateLong(list.event_date)} · ${countdown(days)}` : 'Whenever'}</span>
            <span>${icon('gift', { size: 17 })} ${plural(active.length, 'wish', 'wishes')}</span>
            ${roleLine(list, first)}
          </div>
          ${list.archived_at ? '' : html`
            <div class="hero__actions">
              ${isOwner ? html`<a class="btn" href="/lists/${list.id}" data-link>${icon('back', { size: 18 })} Back to editing</a>` : ''}
              ${!me() ? html`<a class="btn" href="/welcome" data-link>Make your own list</a>` : ''}
              ${me() && list.viewer_role === 'guest' ? html`<button class="btn" type="button" data-action="follow-owner" data-user="${list.owner_id}">${icon('people', { size: 18 })} Follow ${first}</button>` : ''}
              ${list.can_leave && !isOwner ? html`<button class="btn btn--quiet" type="button" data-action="stop-helping" data-list="${list.id}" data-name="${first}">Stop being ${first}'s helper</button>` : ''}
            </div>`}
        </div>
        <div class="hero__aside">
          ${list.event_date && days !== null && days >= 0 ? ring(days) : seal(true)}
          <p>${isOwner
            ? 'This is what givers see, minus who has taken what.'
            : list.surprise_mode ? `${first} cannot see what you reserve. It stays a surprise.` : `${first} can see who reserves what on this list.`}</p>
        </div>
      </section>

      ${list.archived_at ? html`<div class="notice notice--honey">${icon('box')}<div><strong>This list is closed.</strong>It is not taking reservations right now.</div></div>` : ''}

      ${pendingPrompts.map(({ claim, item }) => html`
        <div class="notice notice--honey">
          ${icon('bag')}
          <div class="grow">
            <strong>Did you buy "${item.title}"?</strong>
            You went to ${item.store || 'the shop'}. Let the others know so nobody buys a second one.
            <div class="row hero__actions">
              <button class="btn btn--sm btn--primary" type="button" data-action="answer-prompt" data-claim="${claim.id}" data-answer="bought">Yes, bought it</button>
              <button class="btn btn--sm" type="button" data-action="answer-prompt" data-claim="${claim.id}" data-answer="not_yet">Not yet</button>
              <button class="btn btn--sm btn--quiet" type="button" data-action="answer-prompt" data-claim="${claim.id}" data-answer="released">Changed my mind</button>
            </div>
          </div>
        </div>`)}

      ${active.length > 0 ? html`
        <div class="toolbar">
          <div class="search">
            ${icon('search', { size: 18 })}
            <label class="sr-only" for="list-search">Search this list</label>
            <input id="list-search" type="search" placeholder="Search this list" value="${ui.query}" data-input="list-search" autocomplete="off" />
          </div>
          ${filterChips([['all', 'All'], ...(list.can_see_claims ? [['available', 'Still available']] : []), ['most_wanted', 'Most wanted'], ['under_50', 'Under $50']], ui.filter, 'list-filter')}
          <span class="grow"></span>
          ${sortSelect(ui.sort, 'list-sort')}
        </div>
        ${visible.length > 0
          ? html`<div class="grid">${visible.map(item => giverCard(item, list))}</div>`
          : html`<p class="muted">Nothing matches. <button class="btn btn--quiet btn--sm" type="button" data-action="list-clear">Clear filters</button></p>`}
      ` : empty({ title: 'No wishes yet', text: `${first} has not added anything to this list yet. Check back soon.`, seed: list.id })}

      ${isOwner ? '' : html`
        <p class="small muted row section-title">
          <span>Something wrong with this list?</span>
          <button class="btn btn--quiet btn--sm" type="button" data-action="report" data-type="list" data-id="${list.id}">${icon('flag', { size: 16 })} Report it</button>
        </p>`}`;
  }
};

function roleLine(list, first) {
  if (list.viewer_role === 'helper') return html`<span>${icon('shield', { size: 17 })} You are ${first}'s helper: you can release a reservation that was made by mistake.</span>`;
  if (list.viewer_role === 'guardian') return html`<span>${icon('shield', { size: 17 })} You look after this list.</span>`;
  if (list.viewer_role === 'guest' && !me()) return html`<span>${icon('user', { size: 17 })} You are visiting by link. No account needed.</span>`;
  if (list.viewer_role === 'guest') return html`<span>${icon('user', { size: 17 })} You are visiting by link, so other givers' names are hidden.</span>`;
  return '';
}

function passes(item) {
  if (ui.filter === 'available') return !item.claim_summary?.is_fully_claimed;
  if (ui.filter === 'most_wanted') return item.priority === 'most_wanted';
  if (ui.filter === 'under_50') return item.price !== null && item.price <= 50;
  return true;
}

function availability(item) {
  const cs = item.claim_summary;
  if (!cs) return '';
  if (cs.is_fully_claimed) return html`<span class="wish__state"><span class="pill">${icon('check', { size: 14 })} Taken</span></span>`;
  if (item.always_wanted) return html`<span class="wish__state"><span class="pill pill--pine">Always welcome</span></span>`;
  if (cs.qty_remaining !== null && cs.qty_remaining < item.qty_wanted) return html`<span class="wish__state"><span class="pill pill--honey">${cs.qty_remaining} of ${item.qty_wanted} left</span></span>`;
  return html`<span class="wish__state"><span class="pill pill--pine">Available</span></span>`;
}

function giverCard(item, list) {
  const cs = item.claim_summary;
  const taken = Boolean(cs?.is_fully_claimed);
  const mine = cs?.claims.find(c => c.is_own_claim);
  const myPledge = cs?.contributions.find(c => c.is_own);
  const canGive = list.viewer_role !== 'owner' && !list.archived_at;
  // Pledges are for people the owner has a connection with, so someone who
  // only holds the link is not shown them (the server does not send them).
  const showChipIn = cs && item.allow_group_chip_in && item.price > 0 && cs.pledged_target !== undefined;
  const chipInHint = cs && item.allow_group_chip_in && item.price > 0 && !showChipIn && !taken;

  return html`
    <article class="card wish${taken ? ' wish--taken' : ''}">
      ${cardTop(item, availability(item))}
      <div class="wish__body">
        ${cardFacts(item)}
        ${item.giving_instructions ? html`<div class="notice notice--pine">${icon('coin')}<div><strong>How to give it</strong>${item.giving_instructions}</div></div>` : ''}

        ${showChipIn ? html`
          <div class="meter">
            <div class="meter__top"><span>Group gift</span><span>${money(cs.pledged_total, item.currency)} of ${money(cs.pledged_target, item.currency)}</span></div>
            <progress max="${cs.pledged_target}" value="${Math.min(cs.pledged_total, cs.pledged_target)}">${Math.round((cs.pledged_total / cs.pledged_target) * 100)}%</progress>
            ${cs.contributions.length ? html`<div class="small muted">${cs.contributions.map(c => `${c.contributor_display} ${money(c.pledged_amount, c.currency)}`).join(' · ')}</div>` : ''}
          </div>` : ''}

        ${chipInHint ? html`<p class="small muted">${icon('coin', { size: 14 })} This is a group gift. People in ${list.owner_name.split(' ')[0]}'s circle, and followers they have approved, can chip in toward it.</p>` : ''}

        ${cs && cs.claims.length > 0 ? html`
          <div class="wish__claims">
            ${cs.claims.map(c => html`
              <div class="wish__claim">
                <span><strong>${c.is_own_claim ? 'You' : c.claimer_display}</strong> ${c.is_own_claim ? 'have' : 'has'} ${c.status === 'reserved' ? 'reserved' : c.status === 'taken' ? 'reserved' : c.status === 'purchased' ? 'bought' : 'given'} ${c.qty > 1 ? `${c.qty} of these` : 'this'}</span>
                ${!c.is_own_claim && list.can_release_claims && c.id && c.status !== 'given' ? html`
                  <button class="btn btn--sm btn--quiet" type="button" data-action="helper-release" data-claim="${c.id}" data-who="${c.claimer_display}" data-title="${item.title}">Release</button>` : ''}
              </div>`)}
          </div>` : ''}

        ${canGive ? html`
          <div class="wish__foot">
            ${mine ? html`
              ${mine.status === 'reserved' ? html`<button class="btn btn--sm btn--primary" type="button" data-action="claim-state" data-claim="${mine.id}" data-next="purchased">${icon('check', { size: 16 })} I have bought it</button>` : ''}
              ${mine.status === 'purchased' ? html`<span class="pill pill--pine">${icon('check', { size: 14 })} You bought this</span>` : ''}
              ${mine.status !== 'given' ? html`<button class="btn btn--sm btn--quiet" type="button" data-action="release-own" data-claim="${mine.id}" data-title="${item.title}">Release</button>` : ''}
            ` : (!taken ? html`
              <button class="btn btn--sm btn--primary" type="button" data-action="reserve" data-item="${item.id}">${icon('gift', { size: 16 })} Reserve</button>` : '')}
            ${showChipIn && !taken && !mine ? (myPledge
              ? html`<button class="btn btn--sm btn--quiet" type="button" data-action="withdraw-pledge" data-pledge="${myPledge.id}">Withdraw my ${money(myPledge.pledged_amount, myPledge.currency)}</button>`
              : html`<button class="btn btn--sm" type="button" data-action="chip-in" data-item="${item.id}">${icon('coin', { size: 16 })} Chip in</button>`) : ''}
            ${item.canonical_url ? html`
              <a class="btn btn--sm btn--quiet" href="${safeUrl(item.canonical_url)}" target="_blank" rel="noopener noreferrer" data-action="store-out" data-claim="${mine?.id || ''}">Shop ${icon('external', { size: 15 })}</a>` : ''}
          </div>` : ''}
      </div>
    </article>`;
}

const currentList = () => store.current?.data?.list;
const findItem = (id) => currentList()?.items.find(i => i.id === id);

on('list-filter', (el) => { ui.filter = el.dataset.value; rerender(); });
on('list-clear', () => { ui.filter = 'all'; ui.query = ''; rerender(); });
onInput('list-sort', (el) => { ui.sort = el.value; rerender(); });
onInput('list-search', (el) => { ui.query = el.value; rerender(); });

on('reserve', (el) => {
  const item = findItem(el.dataset.item);
  const list = currentList();
  const guest = !me();
  const remaining = item.always_wanted ? 99 : (item.claim_summary?.qty_remaining ?? item.qty_wanted);
  const first = list.owner_name.split(' ')[0];
  let pendingId = null;

  openSheet({
    title: `Reserve "${item.title}"`,
    intro: list.surprise_mode
      ? `${first} will not see this. Other givers will see that it is taken, so nobody doubles up.`
      : `${first} and the other givers will see that this is taken.`,
    submitLabel: 'Reserve it',
    body: html`
      <div data-step="details">
        ${guest ? html`
          <div class="fields">
            <div class="field"><label for="rs-name">Your name</label><input id="rs-name" name="guest_name" maxlength="80" autocomplete="name" placeholder="Cousin Sam" /></div>
            <div class="field"><label for="rs-email">Your email</label><input id="rs-email" name="guest_email" type="email" required autocomplete="email" placeholder="you@example.com" />
              <span class="field__hint">We send a 6-digit code to confirm it is you. ${first} never sees your address.</span></div>
          </div>` : ''}
        <div class="fields">
          ${remaining > 1 ? html`<div class="field"><label for="rs-qty">How many</label><input id="rs-qty" name="qty" type="number" min="1" max="${remaining}" value="1" inputmode="numeric" /></div>` : ''}
          <div class="field"><label for="rs-note">Note to self <span class="muted">(only you see it)</span></label><input id="rs-note" name="order_note" maxlength="500" placeholder="Order number, where you hid it…" /></div>
        </div>
        <label class="check"><input type="checkbox" name="show_name" checked /><span>Show my name to other givers in ${first}'s circle<small>${first} never sees it while the list is sealed.</small></span></label>
      </div>
      <div data-step="verify" hidden>
        <div class="field">
          <label for="rs-code">6-digit code</label>
          <input id="rs-code" name="code" class="codebox" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" />
          <span class="field__hint" data-code-hint>Check your email. The code works for 30 minutes.</span>
        </div>
      </div>`,
    onSubmit: async (v, sheet) => {
      if (pendingId) {
        const res = await post('/api/claims/verify', { claim_id: pendingId, code: v.code });
        rememberGuestToken(res.claim.manage_token);
        confetti();
        toast('Reserved. Thank you!');
        await refresh();
        return;
      }
      const { claim } = await post('/api/claims', {
        item_id: item.id, qty: Number(v.qty) || 1, order_note: v.order_note,
        show_name_to_givers: v.show_name, guest_email: v.guest_email, guest_name: v.guest_name
      });
      if (claim.verification_required) {
        pendingId = claim.id;
        sheet.form.querySelector('[data-step="details"]').hidden = true;
        sheet.form.querySelector('[data-step="verify"]').hidden = false;
        const code = sheet.form.elements.code;
        code.required = true;
        if (claim.demo_verification_code) {
          // Demo mode only: there is no mailbox to deliver to.
          code.value = claim.demo_verification_code;
          sheet.form.querySelector('[data-code-hint]').textContent = 'Demo mode does not send email, so the code has been filled in for you.';
        }
        sheet.setSubmitLabel('Confirm');
        code.focus();
        return false;
      }
      confetti();
      toast('Reserved. Mark it as bought once you have it.');
      await refresh();
    }
  });
});

on('claim-state', async (el) => {
  await patch(`/api/claims/${el.dataset.claim}`, { status: el.dataset.next });
  if (el.dataset.next === 'purchased') confetti(el);
  toast(el.dataset.next === 'purchased' ? 'Marked as bought' : 'Updated');
  await refresh();
});

on('release-own', async (el) => {
  const ok = await confirmSheet({
    title: 'Release this reservation?',
    message: `"${el.dataset.title}" becomes available to other givers again.`,
    confirmLabel: 'Release'
  });
  if (!ok) return;
  await patch(`/api/claims/${el.dataset.claim}`, { status: 'released' });
  toast('Released');
  await refresh();
});

on('helper-release', (el) => {
  openSheet({
    title: 'Release this reservation?',
    intro: `${el.dataset.who} is told that their hold on "${el.dataset.title}" was released. The list owner is not told anything.`,
    size: 'narrow', danger: true, submitLabel: 'Release it',
    body: html`<div class="field"><label for="hr-reason">Reason <span class="muted">(shared with ${el.dataset.who})</span></label>
      <input id="hr-reason" name="reason" maxlength="300" required placeholder="Reserved twice by mistake" /></div>`,
    onSubmit: async (v) => {
      await patch(`/api/claims/${el.dataset.claim}`, { status: 'released', reason: v.reason });
      toast('Released');
      await refresh();
    }
  });
});

on('answer-prompt', async (el) => {
  await patch(`/api/claims/${el.dataset.claim}`, { action: 'answer_return_prompt', answer: el.dataset.answer });
  if (el.dataset.answer === 'bought') confetti(el);
  await refresh();
});

on('store-out', (el) => {
  // Fire-and-forget: remember that this giver went to the shop, so we can ask
  // "did you buy it?" when they come back. The link itself opens normally.
  if (el.dataset.claim) {
    patch(`/api/claims/${el.dataset.claim}`, { action: 'click_out' }).then(() => setTimeout(refresh, 600)).catch(() => {});
  }
});

on('chip-in', (el) => {
  if (!me()) {
    openSheet({
      title: 'Chipping in needs an account', size: 'narrow', cancelLabel: 'Not now',
      body: html`<p>Group gifts are organised between people who know each other, so pledges are tied to an account. It takes a minute: just your email.</p>
        <p><a class="btn btn--primary" href="/welcome" data-link data-sheet-close>Sign in or sign up</a></p>`
    });
    return;
  }
  const item = findItem(el.dataset.item);
  const cs = item.claim_summary;
  const left = Math.max(0, Math.round((cs.pledged_target - cs.pledged_total) * 100) / 100);
  openSheet({
    title: `Chip in for "${item.title}"`,
    intro: `${money(left, item.currency)} still needed. Hushlist keeps track of pledges; you settle up between yourselves.`,
    size: 'narrow', submitLabel: 'Pledge',
    body: html`
      <div class="field"><label for="ci-amount">Your pledge</label>
        <input id="ci-amount" name="amount" type="number" min="1" max="${left}" step="0.01" inputmode="decimal" required value="${Math.min(left, 25)}" /></div>
      <div class="field"><label for="ci-note">Note for the other givers <span class="muted">(optional)</span></label>
        <input id="ci-note" name="note" maxlength="300" placeholder="Happy to place the order once we get there" /></div>
      <label class="check"><input type="checkbox" name="show_name" checked /><span>Show my name to other givers</span></label>`,
    onSubmit: async (v) => {
      await post('/api/contributions', { item_id: item.id, pledged_amount: Number(v.amount), note: v.note, show_name_to_givers: v.show_name });
      confetti();
      toast('Pledged. Thank you!');
      await refresh();
    }
  });
});

on('withdraw-pledge', async (el) => {
  const ok = await confirmSheet({ title: 'Withdraw your pledge?', message: 'The amount goes back to "still needed".', confirmLabel: 'Withdraw' });
  if (!ok) return;
  await del(`/api/contributions/${el.dataset.pledge}`);
  toast('Pledge withdrawn');
  await refresh();
});

on('stop-helping', async (el) => {
  const ok = await confirmSheet({
    title: 'Stop helping with this list?',
    message: `You will see it like any other giver. ${el.dataset.name} can ask you again later.`,
    confirmLabel: 'Stop helping'
  });
  if (!ok) return;
  await patch(`/api/lists/${el.dataset.list}`, { action: 'leave' });
  toast('You are no longer the helper for this list');
  await refresh();
});

on('follow-owner', async (el) => {
  const { follow } = await post('/api/follows', { target_id: el.dataset.user });
  toast(follow.status === 'approved' ? 'Following. Their lists now appear under Gifting.' : 'Request sent. They need to approve it.');
});

on('report', (el) => {
  openSheet({
    title: 'Report a problem',
    intro: 'An administrator will take a look. Reports are not shown to the list owner.',
    size: 'narrow', submitLabel: 'Send report',
    body: html`<div class="field"><label for="rp-reason">What is wrong?</label>
      <textarea id="rp-reason" name="reason" required maxlength="1000" placeholder="A dangerous link, something abusive, a list that is not what it claims to be…"></textarea></div>`,
    onSubmit: async (v) => {
      await post('/api/reports', { target_type: el.dataset.type, target_id: el.dataset.id, reason: v.reason });
      toast('Thank you. The report has been sent.');
    }
  });
});
