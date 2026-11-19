/** Gifting: the people you shop for — occasions, budgets, top wishes, secret ideas. */

import { html, raw, money, plural, avatar, monthAbbr, dayOfMonth, countdown, safeUrl } from '../dom.js';
import { get, post, patch, del } from '../api.js';
import { store, on, refresh, toast, openSheet, confirmSheet } from '../app.js';
import { icon, ring, empty, PRIORITY } from '../parts.js';
import { swatch } from '../art.js';

export default {
  title: () => 'Gifting',

  async load() {
    const [dash, follows] = await Promise.all([get('/api/dashboard'), get('/api/follows')]);
    return { people: dash.people_i_shop_for, follows };
  },

  render({ people, follows }) {
    const upcoming = people.filter(p => p.next_occasion).sort((a, b) => a.next_occasion.days_remaining - b.next_occasion.days_remaining);
    const sorted = [...people].sort((a, b) => (a.next_occasion?.days_remaining ?? 9999) - (b.next_occasion?.days_remaining ?? 9999));
    const requests = follows.followers_of_me.filter(f => f.status === 'pending');
    const others = follows.followers_of_me.filter(f => f.status !== 'pending');
    const blocked = follows.blocked || [];
    const forWhom = (f) => (f.for_user_id && f.for_user_id !== store.session.current_user.id)
      ? (store.session.dependents.find(d => d.id === f.for_user_id)?.name || 'your child')
      : null;

    return html`
      <header class="page-head">
        <div>
          <p class="eyebrow">Gifting</p>
          <h1>People you shop for</h1>
          <p>Everyone in your circles and anyone you follow. Budgets and secret ideas here are yours and your circle's — never shown to the person they are about.</p>
        </div>
        <button class="btn" type="button" data-action="send-digest">${icon('inbox', { size: 18 })} Send me today's digest</button>
      </header>

      ${requests.length ? html`
        <div class="card stack">
          <h2>${plural(requests.length, 'follow request')}</h2>
          <p class="muted small">Followers see the lists shared by link on their Gifting page. They do not see secret ideas or payment details.</p>
          ${requests.map(f => html`
            <div class="row row--between">
              <span class="row">${avatar(f.follower_name, { size: 'sm' })}<span><strong>${f.follower_name}</strong>${forWhom(f) ? html` <span class="muted small">wants to follow ${forWhom(f)}</span>` : ''}</span></span>
              <span class="row">
                <button class="btn btn--sm btn--primary" type="button" data-action="follow-set" data-follow="${f.id}" data-status="approved">Approve</button>
                <button class="btn btn--sm" type="button" data-action="follow-remove" data-follow="${f.id}">Decline</button>
                <button class="btn btn--sm btn--quiet" type="button" data-action="block-person" data-user="${f.follower_id}" data-for="${f.for_user_id}" data-name="${f.follower_name}">Block</button>
              </span>
            </div>`)}
        </div>` : ''}

      ${upcoming.length ? html`
        <div class="section-title"><h2>Coming up</h2></div>
        <div class="timeline" tabindex="0" role="list" aria-label="Upcoming occasions">
          ${upcoming.map(p => html`
            <div class="occasion" role="listitem">
              <div class="cal" aria-hidden="true"><span class="cal__month">${monthAbbr(p.next_occasion.date)}</span><span class="cal__day">${dayOfMonth(p.next_occasion.date)}</span></div>
              <div><strong>${p.next_occasion.label}</strong><span class="occasion__when">${countdown(p.next_occasion.days_remaining)}</span></div>
            </div>`)}
        </div>` : ''}

      ${sorted.length ? html`<div class="grid grid--wide">${sorted.map(personCard)}</div>` : empty({
        title: 'Nobody here yet',
        text: 'Join or start a circle, or open a list someone shared with you and follow them.',
        seed: 'gifting',
        action: html`<a class="btn btn--primary" href="/circles" data-link>Go to circles</a>`
      })}

      ${others.length ? html`
        <details class="card card--flat section-title">
          <summary class="row"><strong>People who follow you</strong> <span class="pill">${others.length}</span></summary>
          <div class="stack">
            <p class="muted small">Blocking someone ends their access straight away, including any list they help with or co-own with you.</p>
            ${others.map(f => html`
              <div class="row row--between">
                <span class="row">${avatar(f.follower_name, { size: 'sm' })}<span>${f.follower_name}${forWhom(f) ? html` <span class="muted small">follows ${forWhom(f)}</span>` : ''}</span></span>
                <span class="row">
                  <button class="btn btn--sm btn--quiet" type="button" data-action="follow-remove" data-follow="${f.id}" data-done="Removed">Remove</button>
                  <button class="btn btn--sm btn--quiet" type="button" data-action="block-person" data-user="${f.follower_id}" data-for="${f.for_user_id}" data-name="${f.follower_name}">Block</button>
                </span>
              </div>`)}
          </div>
        </details>` : ''}

      ${blocked.length ? html`
        <details class="card card--flat section-title">
          <summary class="row"><strong>People you have blocked</strong> <span class="pill">${blocked.length}</span></summary>
          <div class="stack">
            <p class="muted small">A blocked person cannot open your lists, follow you, or name you on theirs. Reporting someone blocks them too.</p>
            ${blocked.map(b => {
              const child = b.blocker_id !== store.session.current_user.id ? (store.session.dependents.find(d => d.id === b.blocker_id)?.name || 'your child') : null;
              return html`
              <div class="row row--between">
                <span class="row">${avatar(b.blocked_name, { size: 'sm' })}<span>${b.blocked_name}${child ? html` <span class="muted small">blocked for ${child}</span>` : ''}</span></span>
                <button class="btn btn--sm" type="button" data-action="unblock-person" data-user="${b.blocked_id}" data-for="${b.blocker_id}">Unblock</button>
              </div>`;
            })}
          </div>
        </details>` : ''}`;
  }
};

function personCard(p) {
  const first = p.person.name.split(' ')[0];
  const budget = p.budget;
  return html`
    <section class="card person" aria-label="${p.person.name}">
      <div class="person__head">
        ${avatar(p.person.name, { size: 'lg', child: p.person.is_dependent })}
        <div class="grow">
          <h2 class="person__name">${p.person.name}</h2>
          <p class="person__when">${p.next_occasion ? `${p.next_occasion.label} · ${countdown(p.next_occasion.days_remaining)}` : 'No occasion on the calendar'}</p>
        </div>
        ${p.next_occasion ? ring(p.next_occasion.days_remaining, { small: true }) : ''}
      </div>

      <div class="meter">
        <div class="meter__top">
          <span>${budget.limit ? `${money(budget.spent)} of ${money(budget.limit)} budget` : `${money(budget.spent) || '$0'} planned so far`}${budget.not_counted_currencies?.length ? html` <span class="muted small">(gifts priced in ${budget.not_counted_currencies.join(', ')} are not counted)</span>` : ''}</span>
          <button class="btn btn--quiet btn--sm" type="button" data-action="set-budget" data-user="${p.person.id}" data-name="${first}" data-occasion="${budget.occasion}" data-limit="${budget.limit ?? ''}">${budget.limit ? 'Change' : 'Set a budget'}</button>
        </div>
        ${budget.limit ? html`<progress class="${budget.over_budget ? 'is-over' : ''}" max="${budget.limit}" value="${Math.min(budget.spent, budget.limit)}"></progress>` : ''}
        ${budget.over_budget ? html`<span class="small"><span class="pill pill--ribbon">Over budget by ${money(budget.spent - budget.limit)}</span></span>` : ''}
      </div>

      ${p.lists.length ? html`
        <div>
          <p class="eyebrow">Lists</p>
          <div class="mini">
            ${p.lists.map(l => html`
              <a class="mini__row" href="/l/${l.id}" data-link>
                <span class="mini__thumb">${swatch(l.id)}</span>
                <span class="grow"><span class="mini__title">${l.name}</span><span class="small muted">${l.unclaimed_count} of ${plural(l.item_count, 'wish', 'wishes')} still open</span></span>
                ${icon('next', { size: 18 })}
              </a>`)}
          </div>
        </div>` : html`<p class="muted small">${first} has not shared a list with you yet.</p>`}

      ${p.top_priorities.length ? html`
        <div>
          <p class="eyebrow">Still open and most wanted</p>
          <div class="mini">
            ${p.top_priorities.map(t => html`
              <a class="mini__row" href="/l/${t.list_id}" data-link>
                <span class="mini__thumb">${swatch(`${t.id}|${t.title}`)}</span>
                <span class="grow"><span class="mini__title">${t.title}</span><span class="small muted">${[t.store, money(t.price)].filter(Boolean).join(' · ')}</span></span>
                <span class="pill ${t.priority === 'most_wanted' ? 'pill--ribbon' : 'pill--honey'}">${PRIORITY[t.priority].label}</span>
              </a>`)}
          </div>
        </div>` : ''}

      ${p.can_share_secret_ideas ? html`
        <div class="secrets">
          <div class="secrets__head">
            <span class="row">${icon('lock', { size: 17 })} Secret ideas for ${first}</span>
            <button class="btn btn--sm" type="button" data-action="add-secret" data-user="${p.person.id}" data-name="${first}">${icon('plus', { size: 16 })} Add</button>
          </div>
          ${p.secret_ideas.length === 0 ? html`<p class="small">Spotted something ${first} would love? Jot it down. ${first} can never see it; the circle you choose can.</p>` : ''}
          ${p.secret_ideas.map(s => html`
            <div class="secret">
              <strong>${s.url ? html`<a href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</strong>
              ${s.estimated_price ? html` · ${money(s.estimated_price)}` : ''}
              ${s.note ? html`<div class="muted">${s.note}</div>` : ''}
              <div class="secret__meta">
                <span>from ${s.is_mine ? 'you' : s.author_name} · ${s.circle ? `seen by ${s.circle.name}` : 'only you can see this so far'}</span>
                ${s.is_mine && (!s.circle || p.secret_idea_circles.length > 1) ? html`<button class="btn btn--quiet btn--sm" type="button" data-action="move-secret" data-secret="${s.id}" data-user="${p.person.id}">${s.circle ? 'Change circle' : 'Choose a circle'}</button>` : ''}
                ${s.is_mine ? html`<button class="btn btn--quiet btn--sm" type="button" data-action="remove-secret" data-secret="${s.id}">Remove</button>` : ''}
              </div>
            </div>`)}
        </div>` : ''}
    </section>`;
}

on('send-digest', async () => {
  const { digest } = await post('/api/notifications/digest');
  toast(digest.already_sent_today ? 'Today\'s digest was already sent. One a day, at most.' : `Digest sent with ${plural(digest.events_included, 'update')}. It is in your inbox.`);
});

on('follow-set', async (el) => {
  await patch(`/api/follows/${el.dataset.follow}`, { status: el.dataset.status });
  toast('Approved');
  await refresh();
});

on('block-person', async (el) => {
  const ok = await confirmSheet({
    title: `Block ${el.dataset.name}?`,
    message: 'They lose access to your lists straight away, stop helping with or co-owning any list with you, and cannot follow you again unless you unblock them. They are not told.',
    confirmLabel: 'Block', danger: true
  });
  if (!ok) return;
  await post('/api/blocks', { user_id: el.dataset.user, for_user_id: el.dataset.for || undefined });
  toast('Blocked');
  await refresh();
});

on('unblock-person', async (el) => {
  await del(`/api/blocks/${encodeURIComponent(el.dataset.user)}?for=${encodeURIComponent(el.dataset.for)}`);
  toast('Unblocked. They can ask to follow you again.');
  await refresh();
});

on('follow-remove', async (el) => {
  await del(`/api/follows/${el.dataset.follow}`);
  toast(el.dataset.done || 'Declined');
  await refresh();
});

on('set-budget', (el) => {
  openSheet({
    title: `Budget for ${el.dataset.name}`,
    intro: 'Only you see this. Reserved gifts and pledges count toward it.',
    size: 'narrow',
    body: html`
      <div class="field"><label for="bd-amount">Amount</label>
        <input id="bd-amount" name="amount" type="number" min="1" step="1" inputmode="decimal" required value="${el.dataset.limit || 100}" /></div>
      <div class="field"><label for="bd-occasion">For</label>
        <select id="bd-occasion" name="occasion">${[...new Set([el.dataset.occasion, 'Birthday', 'Holiday', 'Anniversary', 'Other'])].map(o => html`<option ${o === el.dataset.occasion ? raw('selected') : ''}>${o}</option>`)}</select></div>`,
    onSubmit: async (v) => {
      await post('/api/budgets', { subject_user_id: el.dataset.user, occasion: v.occasion, amount: Number(v.amount) });
      toast('Budget saved');
      await refresh();
    }
  });
});

const circlesFor = (userId) => store.current?.data?.people.find(p => p.person.id === userId)?.secret_idea_circles || [];
const circlePicker = (circles, selected = null) => circles.length > 1 ? html`
  <div class="field"><label for="se-circle">Who can see it</label>
    <select id="se-circle" name="group_id" required>
      ${selected ? '' : html`<option value="">Choose a circle</option>`}
      ${circles.map(c => html`<option value="${c.id}" ${c.id === selected ? raw('selected') : ''}>${c.name}</option>`)}
    </select>
    <span class="field__hint">Only people in that circle see this idea.</span></div>` : '';

on('add-secret', (el) => {
  const circles = circlesFor(el.dataset.user);
  openSheet({
    title: `A secret idea for ${el.dataset.name}`,
    intro: circles.length === 1 ? `${circles[0].name} can see it. ${el.dataset.name} never can.` : `The circle you choose can see it. ${el.dataset.name} never can.`,
    body: html`
      ${circlePicker(circles)}
      <div class="field"><label for="se-title">The idea</label><input id="se-title" name="title" required maxlength="200" placeholder="Tickets to that concert she mentioned" /></div>
      <div class="fields">
        <div class="field"><label for="se-price">Roughly how much <span class="muted">(optional)</span></label><input id="se-price" name="estimated_price" type="number" min="0" step="0.01" inputmode="decimal" /></div>
        <div class="field"><label for="se-url">Link <span class="muted">(optional)</span></label><input id="se-url" name="url" type="url" inputmode="url" /></div>
      </div>
      <div class="field"><label for="se-note">Note <span class="muted">(optional)</span></label><input id="se-note" name="note" maxlength="500" placeholder="She pointed it out at the market" /></div>`,
    submitLabel: 'Save idea',
    onSubmit: async (v) => {
      await post('/api/secret-ideas', { subject_user_id: el.dataset.user, title: v.title, estimated_price: v.estimated_price || null, url: v.url || null, note: v.note, group_id: v.group_id || undefined });
      toast('Idea saved. Mum\'s the word.');
      await refresh();
    }
  });
});

on('move-secret', (el) => {
  const circles = circlesFor(el.dataset.user);
  const idea = store.current.data.people.flatMap(p => p.secret_ideas).find(s => s.id === el.dataset.secret);
  openSheet({
    title: 'Who can see this idea', size: 'narrow', submitLabel: 'Save',
    body: circles.length > 1 ? circlePicker(circles, idea?.circle?.id) : html`<input type="hidden" name="group_id" value="${circles[0]?.id || ''}" /><p>Share it with ${circles[0]?.name}?</p>`,
    onSubmit: async (v) => {
      await patch(`/api/secret-ideas/${el.dataset.secret}`, { group_id: v.group_id });
      toast('Saved');
      await refresh();
    }
  });
});

on('remove-secret', async (el) => {
  await del(`/api/secret-ideas/${el.dataset.secret}`);
  toast('Removed');
  await refresh();
});
