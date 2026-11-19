/** My lists: the owner's (and guardian's) view of their own wishlists. */

import { html, raw, money, dateLong, daysUntil, countdown, plural, safeUrl } from '../dom.js';
import { get, post, patch, del } from '../api.js';
import { store, me, on, onInput, refresh, rerender, navigate, toast, openSheet, confirmSheet, copyText } from '../app.js';
import { icon, PRIORITY, KIND, priceTag, seal, sparkline, empty, filterChips, sortItems, matchesSearch, sortSelect } from '../parts.js';
import { giftArt, swatch } from '../art.js';
import { qrSvg } from '../qr.js';
import { confetti } from '../confetti.js';

const ui = { filter: 'all', sort: 'priority', query: '' };

const VISIBILITY = {
  link: ['Anyone with the link', 'Share one link; no account needed to reserve.'],
  specific: ['Circles you choose', 'Only people in the circles you share it with.'],
  private: ['Only you', 'Hidden from everyone else.']
};
const OCCASIONS = ['Birthday', 'Holiday', 'Wedding', 'Baby', 'Anniversary', 'Housewarming', 'Graduation', 'Just because'];

export default {
  title: (data) => data.active?.name || 'My lists',

  async load(params) {
    const { lists } = await get('/api/lists');
    const active = lists.find(l => l.id === params[0]) || lists.find(l => !l.archived_at) || lists[0] || null;
    return { lists, active };
  },

  render({ lists, active }) {
    const user = me();
    const mine = lists.filter(l => l.owner_id === user.id);
    return html`
      <header class="page-head">
        <div>
          <p class="eyebrow">Your wishlists</p>
          <h1>${greeting()}, ${user.name.split(' ')[0]}</h1>
          <p>${lists.length === 0
            ? 'Start a list, add a few wishes, and share one link.'
            : `${plural(mine.length, 'list')} of your own${lists.length > mine.length ? ` and ${plural(lists.length - mine.length, 'list')} you look after` : ''}.`}</p>
        </div>
        <div class="row">
          <button class="btn" type="button" data-action="new-child">${icon('user', { size: 18 })} Add a child</button>
          <button class="btn btn--primary" type="button" data-action="new-list">${icon('plus', { size: 18 })} New list</button>
        </div>
      </header>

      ${lists.length > 0 ? html`
        <nav class="listbar" aria-label="Your lists">
          ${lists.map(l => html`
            <a class="listchip" href="/lists/${l.id}" data-link ${l.id === active?.id ? raw('aria-current="page"') : ''}>
              ${swatch(l.id)}
              <span>
                <span class="listchip__name">${l.name}</span>
                <span class="listchip__count">${l.owner_id !== user.id ? `${l.owner_name} · ` : ''}${plural(l.items.filter(i => i.status === 'active').length, 'wish', 'wishes')}${l.archived_at ? ' · archived' : ''}</span>
              </span>
            </a>`)}
        </nav>` : ''}

      ${active ? listDetail(active, lists) : empty({
        title: 'No lists yet',
        text: 'A list holds your wishes for one occasion — or just for whenever.',
        seed: 'first-list',
        action: html`<button class="btn btn--primary" type="button" data-action="new-list">${icon('plus', { size: 18 })} Start your first list</button>`
      })}`;
  }
};

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function sealCopy(list) {
  if (list.viewer_role === 'guardian') {
    return [true, `You look after this list, so you can see what has been reserved for ${list.owner_name.split(' ')[0]}.`];
  }
  if (!list.surprise_mode) return [true, 'Open list. You can see who has reserved what.'];
  if (list.revealed_at) return [true, 'Opened after the occasion. You can see who gave what.'];
  const unlock = list.reveal_unlocks_on;
  return [false, unlock
    ? `Sealed. You will not see who is giving what until ${dateLong(unlock)}.`
    : 'Sealed. You will not see who is giving what. Add a date to set when it can be opened.'];
}

function listDetail(list, lists) {
  const [open, caption] = sealCopy(list);
  const days = daysUntil(list.event_date);
  const active = list.items.filter(i => i.status === 'active');
  const received = list.items.filter(i => i.status === 'received');
  const visible = sortItems(active.filter(i => passesFilter(i) && matchesSearch(i, ui.query)), ui.sort);
  const canReveal = list.surprise_mode && !list.revealed_at && list.viewer_role === 'owner';

  return html`
    <section class="card hero" aria-labelledby="list-title">
      <div>
        <p class="eyebrow">${list.occasion}${list.owner_id !== me().id ? ` · for ${list.owner_name}` : ''}</p>
        <h2 class="hero__title" id="list-title">${list.name}</h2>
        <div class="hero__meta">
          <span>${icon('calendar', { size: 17 })} ${list.event_date ? `${dateLong(list.event_date)} · ${countdown(days)}` : 'No date yet'}</span>
          <span>${icon(list.visibility === 'private' ? 'lock' : 'eye', { size: 17 })} ${VISIBILITY[list.visibility]?.[0] || list.visibility}</span>
          ${list.shared_with_groups?.length ? html`<span>${icon('circle', { size: 17 })} ${list.shared_with_groups.map(g => g.name).join(', ')}</span>` : ''}
          ${list.helpers?.length ? html`<span>${icon('shield', { size: 17 })} Helper: ${list.helpers.map(h => h.name).join(', ')}</span>` : ''}
        </div>
        <div class="hero__actions">
          ${list.archived_at ? html`
            <button class="btn btn--primary" type="button" data-action="reuse-list" data-list="${list.id}">Reopen for a new occasion</button>` : html`
            <button class="btn btn--primary" type="button" data-action="add-item" data-list="${list.id}">${icon('plus', { size: 18 })} Add a wish</button>
            <button class="btn" type="button" data-action="share-list" data-list="${list.id}">${icon('share', { size: 18 })} Share</button>`}
          <details class="menu menu--left">
            <summary class="btn btn--icon" aria-label="More list options">${icon('more')}</summary>
            <div class="menu__panel" role="menu">
              <button class="menu__item" type="button" role="menuitem" data-action="edit-list" data-list="${list.id}">${icon('edit', { size: 18 })} Edit details</button>
              <a class="menu__item" role="menuitem" href="/l/${list.id}" data-link>${icon('eye', { size: 18 })} See it as givers do</a>
              ${list.archived_at ? '' : html`<button class="menu__item" type="button" role="menuitem" data-action="import-items" data-list="${list.id}">${icon('wand', { size: 18 })} Add several at once</button>`}
              ${canReveal ? html`<button class="menu__item" type="button" role="menuitem" data-action="reveal-list" data-list="${list.id}">${icon('gift', { size: 18 })} Open the list after the occasion</button>` : ''}
              ${list.archived_at ? '' : html`
                <div class="menu__sep"></div>
                <button class="menu__item menu__item--danger" type="button" role="menuitem" data-action="archive-list" data-list="${list.id}">${icon('box', { size: 18 })} Archive this list</button>`}
            </div>
          </details>
        </div>
      </div>
      <div class="hero__aside">
        ${seal(open)}
        <p>${caption}</p>
      </div>
    </section>

    ${list.archived_at ? html`<div class="notice notice--honey">${icon('box')}<div><strong>This list is archived.</strong>Nobody can reserve from it. Reopen it when the next occasion comes round.</div></div>` : ''}

    ${active.length > 0 ? html`
      <div class="toolbar">
        <div class="search">
          ${icon('search', { size: 18 })}
          <label class="sr-only" for="home-search">Search this list</label>
          <input id="home-search" type="search" placeholder="Search this list" value="${ui.query}" data-input="home-search" autocomplete="off" />
        </div>
        ${filterChips([['all', 'All'], ['most_wanted', 'Most wanted'], ['under_50', 'Under $50'], ['price_drop', 'Price drops']], ui.filter, 'home-filter')}
        <span class="grow"></span>
        ${sortSelect(ui.sort, 'home-sort')}
      </div>
      ${visible.length > 0
        ? html`<div class="grid">${visible.map(item => ownerCard(item, list, lists))}</div>`
        : html`<p class="muted">Nothing matches. <button class="btn btn--quiet btn--sm" type="button" data-action="home-clear">Clear filters</button></p>`}
    ` : (list.archived_at ? '' : empty({
      title: 'This list is waiting for its first wish',
      text: 'Paste a link from any shop, or just describe something: a class, a fund, "any book by…".',
      seed: list.id,
      action: html`<button class="btn btn--primary" type="button" data-action="add-item" data-list="${list.id}">${icon('plus', { size: 18 })} Add a wish</button>`
    }))}

    ${received.length > 0 ? html`
      <div class="section-title"><h2>Received</h2><span class="muted small">${plural(received.length, 'gift')} · keep track of thank-yous</span></div>
      <div class="grid">${received.map(item => receivedCard(item))}</div>` : ''}`;
}

function passesFilter(item) {
  if (ui.filter === 'most_wanted') return item.priority === 'most_wanted';
  if (ui.filter === 'under_50') return item.price !== null && item.price <= 50;
  if (ui.filter === 'price_drop') return (item.price_drop_percent || 0) > 0;
  return true;
}

/** Wrapping state from claims — only ever present when this viewer may see claims. */
export function wrapState(item) {
  const cs = item.claim_summary;
  if (!cs || !cs.is_fully_claimed) return 'open';
  return cs.claims.some(c => c.status === 'purchased' || c.status === 'given') ? 'bought' : 'reserved';
}

export function cardTop(item, extra = '') {
  const flag = PRIORITY[item.priority]?.flag;
  return html`
    <div class="wish__art">
      ${giftArt(item, wrapState(item))}
      ${flag ? html`<span class="wish__flag wish__flag--${flag}">${icon('star', { size: 14 })} ${PRIORITY[item.priority].label}</span>` : ''}
      ${extra}
    </div>`;
}

export function cardFacts(item) {
  return html`
    <p class="wish__store">${item.store || KIND[item.kind]?.short || ''}${item.kind !== 'product' ? ` · ${KIND[item.kind]?.short}` : ''}</p>
    <h3 class="wish__title">${item.canonical_url
      ? html`<a href="${safeUrl(item.canonical_url)}" target="_blank" rel="noopener noreferrer">${item.title} <span class="sr-only">(opens the shop in a new tab)</span></a>`
      : item.title}</h3>
    <div class="wish__priceline">
      ${priceTag(item)}
      ${item.price_drop_percent > 0 ? html`<span class="spark" title="Price has dropped ${item.price_drop_percent}%">${sparkline(item.price_history)} −${item.price_drop_percent}%</span>` : ''}
    </div>
    <div class="wish__facts">
      ${item.variant ? html`<span class="pill">${item.variant}</span>` : ''}
      ${item.always_wanted ? html`<span class="pill pill--pine">Always welcome</span>` : (item.qty_wanted > 1 ? html`<span class="pill">Wants ${item.qty_wanted}</span>` : '')}
      ${item.any_similar ? html`<span class="pill pill--sky">Anything similar is great</span>` : ''}
      ${item.allow_group_chip_in ? html`<span class="pill pill--plum">Group gift</span>` : ''}
      ${!item.in_stock ? html`<span class="pill pill--ribbon">Out of stock</span>` : ''}
    </div>
    ${item.notes ? html`<p class="wish__note">${item.notes}</p>` : ''}`;
}

function ownerCard(item, list, lists) {
  const cs = item.claim_summary; // guardian, registry mode or opened list only
  const others = lists.filter(l => l.id !== list.id && l.owner_id === list.owner_id && !l.archived_at);
  return html`
    <article class="card wish">
      ${cardTop(item)}
      <div class="wish__body">
        ${cardFacts(item)}
        ${item.giving_instructions ? html`<p class="small muted">${icon('lock', { size: 14 })} For your circle only: ${item.giving_instructions}</p>` : ''}
        ${cs ? html`
          <div class="wish__claims">
            ${cs.claims.length === 0 && cs.contributions.length === 0 ? 'Nobody has reserved this yet.' : ''}
            ${cs.claims.map(c => html`<div class="wish__claim"><span><strong>${c.claimer_display}</strong> · ${c.status}${c.qty > 1 ? ` × ${c.qty}` : ''}</span></div>`)}
            ${cs.contributions.map(c => html`<div class="wish__claim"><span><strong>${c.contributor_display}</strong> pledged ${money(c.pledged_amount, c.currency)}</span></div>`)}
          </div>` : ''}
        <div class="wish__foot">
          <button class="btn btn--sm" type="button" data-action="edit-item" data-item="${item.id}">${icon('edit', { size: 16 })} Edit</button>
          <span class="grow"></span>
          <details class="menu menu--up">
            <summary class="btn btn--sm btn--icon btn--quiet" aria-label="More options for ${item.title}">${icon('more')}</summary>
            <div class="menu__panel" role="menu">
              <button class="menu__item" type="button" role="menuitem" data-action="got-it" data-item="${item.id}">${icon('check', { size: 18 })} I got this myself</button>
              <button class="menu__item" type="button" role="menuitem" data-action="mark-received" data-item="${item.id}">${icon('gift', { size: 18 })} It arrived as a gift</button>
              <button class="menu__item" type="button" role="menuitem" data-action="update-price" data-item="${item.id}">${icon('coin', { size: 18 })} Update price or stock</button>
              ${others.length ? html`
                <button class="menu__item" type="button" role="menuitem" data-action="move-item" data-item="${item.id}" data-mode="move">${icon('out', { size: 18 })} Move to another list</button>
                <button class="menu__item" type="button" role="menuitem" data-action="move-item" data-item="${item.id}" data-mode="copy">${icon('copy', { size: 18 })} Copy to another list</button>` : ''}
              <div class="menu__sep"></div>
              <button class="menu__item menu__item--danger" type="button" role="menuitem" data-action="delete-item" data-item="${item.id}">${icon('trash', { size: 18 })} Remove</button>
            </div>
          </details>
        </div>
      </div>
    </article>`;
}

function receivedCard(item) {
  return html`
    <article class="card wish wish--received">
      <div class="wish__art">
        ${giftArt(item, 'bought')}
        <span class="wish__state"><span class="pill pill--pine">${icon('check', { size: 14 })} Received</span></span>
      </div>
      <div class="wish__body">
        <p class="wish__store">${item.store || ''}</p>
        <h3 class="wish__title">${item.title}</h3>
        ${item.thank_you_note ? html`<p class="wish__note">${item.thank_you_note}</p>` : ''}
        <div class="wish__foot">
          <button class="btn btn--sm ${item.thank_you_sent ? 'btn--pine' : ''}" type="button" data-action="thank-you" data-item="${item.id}">
            ${item.thank_you_sent ? html`${icon('check', { size: 16 })} Thanked` : 'Track the thank-you'}
          </button>
        </div>
      </div>
    </article>`;
}

// ---------------------------------------------------------------- helpers

const data = () => store.current?.data || { lists: [], active: null };
const findItem = (id) => {
  for (const list of data().lists) {
    const item = list.items.find(i => i.id === id);
    if (item) return { item, list };
  }
  return null;
};
const findList = (id) => data().lists.find(l => l.id === id);

on('home-filter', (el) => { ui.filter = el.dataset.value; rerender(); });
on('home-clear', () => { ui.filter = 'all'; ui.query = ''; rerender(); });
onInput('home-sort', (el) => { ui.sort = el.value; rerender(); });
onInput('home-search', (el) => { ui.query = el.value; rerender(); });

// ---------------------------------------------------------------- lists

async function circleChoices() {
  try {
    const { groups } = await get('/api/groups');
    const people = new Map();
    for (const g of groups) for (const m of g.members) if (m.id !== me().id) people.set(m.id, m.name);
    return { groups, people: [...people].map(([id, name]) => ({ id, name })) };
  } catch {
    return { groups: [], people: [] };
  }
}

function listFields(list, { groups, people }, isNew) {
  const owners = [{ id: me().id, name: 'Me' }, ...store.session.dependents.map(d => ({ id: d.id, name: d.name }))];
  return html`
    ${isNew && owners.length > 1 ? html`
      <div class="field">
        <label for="lf-owner">Whose list is it?</label>
        <select id="lf-owner" name="owner_id">${owners.map(o => html`<option value="${o.id}">${o.name}</option>`)}</select>
      </div>` : ''}
    <div class="field">
      <label for="lf-name">Name</label>
      <input id="lf-name" name="name" required maxlength="120" value="${list?.name || ''}" placeholder="Birthday wishes" />
    </div>
    <div class="fields">
      <div class="field">
        <label for="lf-occasion">Occasion</label>
        <select id="lf-occasion" name="occasion">
          ${[...new Set([...(list?.occasion ? [list.occasion] : []), ...OCCASIONS])].map(o => html`<option ${o === (list?.occasion || 'Birthday') ? raw('selected') : ''}>${o}</option>`)}
        </select>
      </div>
      <div class="field">
        <label for="lf-date">Date <span class="muted">(optional)</span></label>
        <input id="lf-date" name="event_date" type="date" value="${list?.event_date || ''}" min="${new Date().toISOString().slice(0, 10)}" />
      </div>
    </div>
    <fieldset class="field">
      <legend class="label">Who can see it</legend>
      ${Object.entries(VISIBILITY).map(([value, [label, hint]]) => html`
        <label class="check">
          <input type="radio" name="visibility" value="${value}" ${(list?.visibility || 'link') === value ? raw('checked') : ''} />
          <span>${label}<small>${hint}</small></span>
        </label>`)}
    </fieldset>
    ${isNew && groups.length ? html`
      <fieldset class="field">
        <legend class="label">Share with your circles</legend>
        ${groups.map(g => html`<label class="check"><input type="checkbox" name="group:${g.id}" checked /><span>${g.name}</span></label>`)}
      </fieldset>` : ''}
    ${people.length ? html`
      <div class="field">
        <label for="lf-helper">Trusted helper <span class="muted">(optional)</span></label>
        <select id="lf-helper" name="helper_user_id">
          <option value="">Nobody</option>
          ${people.map(p => html`<option value="${p.id}" ${list?.helpers?.some(h => h.id === p.id) ? raw('selected') : ''}>${p.name}</option>`)}
        </select>
        <span class="field__hint">A helper can see reservations and tidy up mistakes, so you never have to look.</span>
      </div>` : ''}
    ${isNew ? html`
      <label class="check">
        <input type="checkbox" name="surprise_mode" checked />
        <span>Keep it a surprise<small>You will not see who reserved what until a week after the date. This cannot be switched off once the list has wishes on it.</small></span>
      </label>` : ''}`;
}

on('new-list', async () => {
  const choices = await circleChoices();
  openSheet({
    title: 'Start a list',
    body: listFields(null, choices, true),
    submitLabel: 'Create list',
    onSubmit: async (v) => {
      const group_ids = Object.keys(v).filter(k => k.startsWith('group:') && v[k]).map(k => k.slice(6));
      const { list } = await post('/api/lists', {
        owner_id: v.owner_id || undefined, name: v.name, occasion: v.occasion, event_date: v.event_date || null,
        visibility: v.visibility, surprise_mode: v.surprise_mode, helper_user_id: v.helper_user_id || null, group_ids
      });
      toast('List created');
      await navigate(`/lists/${list.id}`);
    }
  });
});

on('edit-list', async (el) => {
  const list = findList(el.dataset.list);
  const choices = await circleChoices();
  openSheet({
    title: 'List details',
    body: html`
      ${listFields(list, choices, false)}
      ${list.surprise_mode && !list.revealed_at ? html`
        <div class="notice">${icon('lock')}<div><strong>Surprise mode is on.</strong>${list.items.length === 0
          ? html`This list is still empty, so you can <button class="btn btn--sm" type="button" data-action="surprise-off" data-list="${list.id}">switch it off</button> if you would rather see reservations as they happen.`
          : 'It stays on now that the list has wishes: people may already have reserved things expecting it to be a surprise.'}</div></div>` : ''}`,
    onSubmit: async (v) => {
      await patch(`/api/lists/${list.id}`, {
        name: v.name, occasion: v.occasion, event_date: v.event_date || null,
        visibility: v.visibility, ...(v.helper_user_id !== undefined ? { helper_user_id: v.helper_user_id || null } : {})
      });
      toast('Saved');
      await refresh();
    }
  });
});

on('surprise-off', async (el) => {
  await patch(`/api/lists/${el.dataset.list}`, { surprise_mode: false });
  document.querySelector('dialog.sheet')?.close();
  toast('Surprise mode is off for this list');
  await refresh();
});

on('archive-list', async (el) => {
  const list = findList(el.dataset.list);
  const ok = await confirmSheet({
    title: `Archive "${list.name}"?`,
    message: 'Nobody will be able to reserve from it. Anyone holding something they have not bought yet is told it has been released. You can reopen the list later.',
    confirmLabel: 'Archive', danger: true
  });
  if (!ok) return;
  await patch(`/api/lists/${list.id}`, { action: 'archive' });
  toast('List archived');
  await refresh();
});

on('reuse-list', (el) => {
  const list = findList(el.dataset.list);
  openSheet({
    title: 'Reopen this list',
    intro: 'It becomes shareable again and is sealed for the new occasion.',
    size: 'narrow',
    body: html`<div class="field"><label for="ru-date">New date <span class="muted">(optional)</span></label>
      <input id="ru-date" name="event_date" type="date" min="${new Date().toISOString().slice(0, 10)}" /></div>`,
    submitLabel: 'Reopen',
    onSubmit: async (v) => {
      await patch(`/api/lists/${list.id}`, { action: 'reuse', event_date: v.event_date || null });
      toast('List reopened');
      await refresh();
    }
  });
});

on('reveal-list', async (el) => {
  const list = findList(el.dataset.list);
  const unlock = list.reveal_unlocks_on;
  const today = new Date().toISOString().slice(0, 10);
  if (!unlock || today < unlock) {
    openSheet({
      title: 'Still sealed',
      size: 'narrow',
      cancelLabel: 'Got it',
      body: html`<div class="notice">${icon('lock')}<div>${unlock
        ? html`<strong>You can open this list on ${dateLong(unlock)}.</strong>That is a week after the occasion, so no surprise is spoiled early. There is no way to open it sooner.`
        : html`<strong>This list has no date.</strong>Add the date of the occasion under "Edit details". The list can be opened a week after it.`}</div></div>`
    });
    return;
  }
  const ok = await confirmSheet({
    title: 'Open the list?',
    message: 'You will see who gave what, which makes thank-you notes easy. Everyone who reserved or chipped in is told that the list has been opened. This cannot be undone.',
    confirmLabel: 'Open it'
  });
  if (!ok) return;
  await patch(`/api/lists/${list.id}`, { action: 'reveal' });
  confetti();
  toast('The list is open');
  await refresh();
});

on('share-list', (el) => {
  const list = findList(el.dataset.list);
  const url = `${location.origin}/l/${encodeURIComponent(list.share_token)}`;
  const linkWorks = list.visibility === 'link';
  let code = '';
  try { code = qrSvg(url, { label: `QR code for ${list.name}` }); } catch { /* link too long for a code */ }
  openSheet({
    title: 'Share this list',
    intro: linkWorks
      ? 'Anyone with this link can see the list and reserve a gift. No app, no account.'
      : 'This link only works for people the list is already shared with.',
    size: 'narrow',
    cancelLabel: 'Done',
    body: html`
      ${linkWorks ? '' : html`<div class="notice notice--honey">${icon('lock')}<div>This list is set to "${VISIBILITY[list.visibility][0]}". Change that under "Edit details" to share it by link.</div></div>`}
      ${linkWorks && code ? raw(code) : ''}
      <div class="field">
        <label for="share-url">Link</label>
        <div class="linkbox">
          <input id="share-url" readonly value="${url}" />
          <button class="btn btn--primary" type="button" data-action="copy" data-text="${url}">${icon('copy', { size: 18 })} Copy</button>
        </div>
      </div>
      ${navigator.share ? html`<button class="btn btn--block" type="button" data-action="native-share" data-url="${url}" data-title="${list.name}">${icon('share', { size: 18 })} Send it another way</button>` : ''}`
  });
});

on('copy', (el) => copyText(el.dataset.text, 'Link copied'));
on('native-share', async (el) => {
  try { await navigator.share({ title: el.dataset.title, url: el.dataset.url }); } catch { /* dismissed */ }
});

on('new-child', () => {
  openSheet({
    title: 'Add a child',
    intro: 'Children do not get a sign-in or an email address. You look after their list, and as their guardian you can see what has been reserved.',
    body: html`
      <div class="field"><label for="ch-name">Name</label><input id="ch-name" name="name" required maxlength="80" placeholder="Sophie" /></div>
      <div class="fields">
        <div class="field"><label for="ch-month">Birthday month</label>
          <select id="ch-month" name="birthday_month"><option value="">—</option>${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => html`<option value="${i + 1}">${m}</option>`)}</select></div>
        <div class="field"><label for="ch-day">Day</label><input id="ch-day" name="birthday_day" type="number" min="1" max="31" inputmode="numeric" /></div>
      </div>`,
    submitLabel: 'Add child',
    onSubmit: async (v) => {
      const res = await post('/api/dependents', {
        name: v.name, birthday_month: v.birthday_month ? Number(v.birthday_month) : null, birthday_day: v.birthday_day ? Number(v.birthday_day) : null
      });
      store.session.dependents.push({ id: res.dependent.id, name: res.dependent.name });
      toast(`${res.dependent.name}'s list is ready`);
      await navigate(`/lists/${res.list.id}`);
    }
  });
});

// ---------------------------------------------------------------- items

function itemFields(item = {}, { isNew = false, prefillUrl = '' } = {}) {
  const kind = item.kind || 'product';
  return html`
    ${isNew ? html`
      <div class="field">
        <label for="it-url">Link <span class="muted">(optional)</span></label>
        <div class="linkbox">
          <input id="it-url" name="url" type="url" inputmode="url" placeholder="Paste a link from any shop" value="${prefillUrl}" autocomplete="off" />
          <button class="btn" type="button" data-action="capture">${icon('wand', { size: 18 })} Fill in</button>
        </div>
        <div id="capture-note" class="field__hint" aria-live="polite"></div>
      </div>` : ''}
    <fieldset class="field">
      <legend class="label">What kind of wish</legend>
      <div class="seg">
        ${Object.entries(KIND).map(([value, k]) => html`
          <label><input type="radio" name="kind" value="${value}" ${value === kind ? raw('checked') : ''} ${isNew ? '' : raw('disabled')} />${icon(k.icon)}<span>${k.short}</span></label>`)}
      </div>
    </fieldset>
    <div class="field">
      <label for="it-title">What is it?</label>
      <input id="it-title" name="title" required maxlength="300" value="${item.title || ''}" placeholder="Pour-over kettle, pottery class, any book by…" />
      <span class="field__hint" data-conf="title"></span>
    </div>
    <div class="fields">
      <div class="field">
        <label for="it-price">Price <span class="muted">(optional)</span></label>
        <input id="it-price" name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${item.price ?? ''}" placeholder="0.00" />
        <span class="field__hint" data-conf="price"></span>
      </div>
      <div class="field">
        <label for="it-store">Where from</label>
        <input id="it-store" name="store" maxlength="120" value="${item.store || ''}" placeholder="Any shop" />
      </div>
      <div class="field">
        <label for="it-qty">How many</label>
        <input id="it-qty" name="qty_wanted" type="number" min="1" max="999" inputmode="numeric" value="${item.qty_wanted || 1}" />
      </div>
    </div>
    <div class="fields">
      <div class="field">
        <label for="it-variant">Size, colour, edition</label>
        <input id="it-variant" name="variant" maxlength="200" value="${item.variant || ''}" placeholder="Medium · sage green" />
        <span class="field__hint" data-conf="variant"></span>
      </div>
      <div class="field">
        <label for="it-priority">How much do you want it?</label>
        <select id="it-priority" name="priority">
          ${Object.entries(PRIORITY).map(([value, p]) => html`<option value="${value}" ${(item.priority || 'normal') === value ? raw('selected') : ''}>${p.label}</option>`)}
        </select>
      </div>
    </div>
    <div class="field">
      <label for="it-notes">Note for givers <span class="muted">(optional)</span></label>
      <textarea id="it-notes" name="notes" maxlength="2000" placeholder="Anything that helps: sizing, where to find it, why you love it.">${item.notes || ''}</textarea>
    </div>
    <label class="check"><input type="checkbox" name="any_similar" ${item.any_similar ? raw('checked') : ''} /><span>Anything similar is great<small>It does not have to be this exact one.</small></span></label>
    <label class="check"><input type="checkbox" name="allow_group_chip_in" ${item.allow_group_chip_in ? raw('checked') : ''} /><span>Let people chip in together<small>For bigger gifts. Needs a price. Hushlist tracks pledges; it never handles money.</small></span></label>
    <label class="check"><input type="checkbox" name="always_wanted" ${item.always_wanted ? raw('checked') : ''} /><span>Always welcome<small>Never shows as taken — good for gift cards, wine, socks.</small></span></label>
    <div class="field">
      <label for="it-giving">How to give it <span class="muted">(only your circle sees this)</span></label>
      <input id="it-giving" name="giving_instructions" maxlength="500" value="${item.giving_instructions || ''}" placeholder="Payment handle, or which shop sells the gift card" />
    </div>`;
}

function itemPayload(v) {
  return {
    title: v.title, price: v.price === '' ? null : Number(v.price), store: v.store, qty_wanted: Number(v.qty_wanted) || 1,
    variant: v.variant, priority: v.priority, notes: v.notes, any_similar: v.any_similar,
    allow_group_chip_in: v.allow_group_chip_in, always_wanted: v.always_wanted, giving_instructions: v.giving_instructions
  };
}

let lastConfidence = null;

export function openAddItem(listId, { url = '', title = '' } = {}) {
  lastConfidence = null;
  let force = false;
  const sheet = openSheet({
    title: 'Add a wish',
    size: 'wide',
    body: itemFields({ title }, { isNew: true, prefillUrl: url }),
    submitLabel: 'Add to list',
    onSubmit: async (v, s) => {
      try {
        await post('/api/items', {
          ...itemPayload(v), list_id: listId, url: v.url || null, kind: v.kind || 'product',
          field_confidence: lastConfidence || undefined, force_duplicate: force
        });
      } catch (err) {
        if (err.status === 409 && err.data?.duplicate_detected && !force) {
          force = true;
          s.setError(`${err.message} Add it anyway?`);
          s.setSubmitLabel('Add anyway');
          return false;
        }
        throw err;
      }
      toast('Added to your list');
      await refresh();
    }
  });
  if (url) sheet.form.querySelector('[data-action="capture"]')?.click();
  return sheet;
}

on('add-item', (el) => openAddItem(el.dataset.list));

on('capture', async (el) => {
  const form = el.closest('form');
  const note = form.querySelector('#capture-note');
  const url = form.elements.url.value.trim();
  if (!url) { note.textContent = 'Paste a link first.'; return; }
  note.textContent = 'Reading the link…';
  let res;
  try {
    res = await post('/api/capture', { url });
  } catch (err) {
    note.textContent = err.message;
    return;
  }
  const cap = res.capture;
  lastConfidence = cap.field_confidence || null;
  const fill = (name, value) => { if (value !== null && value !== undefined && value !== '' && !form.elements[name].value) form.elements[name].value = value; };
  fill('title', cap.title);
  fill('price', cap.price);
  fill('variant', cap.variant);
  if (cap.store) form.elements.store.value = cap.store;
  if (cap.canonical_url) form.elements.url.value = cap.canonical_url;

  for (const field of ['title', 'price', 'variant']) {
    const input = form.elements[field];
    const hint = form.querySelector(`[data-conf="${field}"]`);
    const score = cap.field_confidence?.[field];
    const unsure = Boolean(input.value) && typeof score === 'number' && score > 0 && score < 0.75;
    input.classList.toggle('is-unsure', unsure);
    hint.className = `field__hint${unsure ? ' field__hint--warn' : ''}`;
    hint.textContent = unsure ? 'This is a guess — please check it.' : '';
  }

  const layers = Object.values(cap.extraction_layers_used || {});
  const messages = [];
  if (cap.notice) messages.push(cap.notice);
  else if (layers.length === 0 || layers.every(l => l === 'url_slug_fallback')) {
    messages.push('Hushlist does not open shop pages itself, so only the link could be read. Fill in the rest by hand, or use the browser extension on the product page.');
  } else {
    messages.push('Details filled in. Check them before saving.');
  }
  if (res.duplicate_warning) messages.push(`You already have "${res.duplicate_warning.title}" on "${res.duplicate_warning.list_name}".`);
  note.textContent = messages.join(' ');
});

on('edit-item', (el) => {
  const { item } = findItem(el.dataset.item);
  openSheet({
    title: 'Edit wish',
    intro: 'If someone has already reserved this, they are told what changed. You are not told whether anyone has.',
    size: 'wide',
    body: html`
      <div class="field">
        <label for="it-url">Link <span class="muted">(optional)</span></label>
        <input id="it-url" name="url" type="url" inputmode="url" value="${item.canonical_url || ''}" autocomplete="off" />
      </div>
      ${itemFields(item)}`,
    onSubmit: async (v) => {
      await patch(`/api/items/${item.id}`, { ...itemPayload(v), url: v.url || null });
      toast('Saved');
      await refresh();
    }
  });
});

on('delete-item', async (el) => {
  const { item } = findItem(el.dataset.item);
  const ok = await confirmSheet({
    title: 'Remove this wish?',
    message: `"${item.title}" comes off the list. If someone had reserved it, they are told not to buy it.`,
    confirmLabel: 'Remove', danger: true
  });
  if (!ok) return;
  await del(`/api/items/${item.id}`);
  toast('Removed');
  await refresh();
});

on('got-it', async (el) => {
  const { item } = findItem(el.dataset.item);
  const ok = await confirmSheet({
    title: 'You got this yourself?',
    message: `"${item.title}" comes off the list so nobody buys a second one. If someone had reserved it, they are told — you are not.`,
    confirmLabel: 'Yes, I have it'
  });
  if (!ok) return;
  await patch(`/api/items/${item.id}`, { action: 'got_it' });
  toast('Taken off the list');
  await refresh();
});

on('mark-received', async (el) => {
  const { item } = findItem(el.dataset.item);
  await patch(`/api/items/${item.id}`, { action: 'mark_received' });
  confetti(el);
  toast('Lovely. Moved to Received.');
  await refresh();
});

on('thank-you', (el) => {
  const { item } = findItem(el.dataset.item);
  openSheet({
    title: 'Thank-you',
    size: 'narrow',
    body: html`
      <label class="check"><input type="checkbox" name="thank_you_sent" ${item.thank_you_sent ? raw('checked') : ''} /><span>I have said thank you</span></label>
      <div class="field"><label for="ty-note">Note to self <span class="muted">(optional)</span></label>
        <textarea id="ty-note" name="thank_you_note" maxlength="1000" placeholder="Who it was from, what to mention…">${item.thank_you_note || ''}</textarea></div>`,
    onSubmit: async (v) => {
      await patch(`/api/items/${item.id}`, { action: 'toggle_thank_you', thank_you_sent: v.thank_you_sent, thank_you_note: v.thank_you_note });
      await refresh();
    }
  });
});

on('update-price', (el) => {
  const { item } = findItem(el.dataset.item);
  openSheet({
    title: 'Update price or stock',
    intro: 'People who follow this list hear about meaningful price drops.',
    size: 'narrow',
    body: html`
      <div class="field"><label for="up-price">Price now</label>
        <input id="up-price" name="new_price" type="number" min="0" step="0.01" inputmode="decimal" value="${item.price ?? ''}" /></div>
      <label class="check"><input type="checkbox" name="in_stock" ${item.in_stock ? raw('checked') : ''} /><span>In stock</span></label>`,
    onSubmit: async (v) => {
      await post(`/api/items/${item.id}/recheck`, { new_price: v.new_price === '' ? null : Number(v.new_price), in_stock: v.in_stock });
      toast('Updated');
      await refresh();
    }
  });
});

on('move-item', (el) => {
  const { item, list } = findItem(el.dataset.item);
  const copy = el.dataset.mode === 'copy';
  const targets = data().lists.filter(l => l.id !== list.id && l.owner_id === list.owner_id && !l.archived_at);
  openSheet({
    title: copy ? 'Copy to another list' : 'Move to another list',
    size: 'narrow',
    body: html`<div class="field"><label for="mv-target">List</label>
      <select id="mv-target" name="target">${targets.map(t => html`<option value="${t.id}">${t.name}</option>`)}</select></div>`,
    submitLabel: copy ? 'Copy' : 'Move',
    onSubmit: async (v) => {
      await patch(`/api/items/${item.id}`, { action: copy ? 'copy_to_list' : 'move_to_list', target_list_id: v.target });
      toast(copy ? 'Copied' : 'Moved');
      await refresh();
    }
  });
});

on('import-items', (el) => {
  const listId = el.dataset.list;
  openSheet({
    title: 'Add several at once',
    intro: 'One wish per line: a name, a link, or both. A price like $24.99 is picked up too. Lines already on the list are skipped.',
    size: 'wide',
    body: html`
      <div class="field">
        <label for="im-text">Wishes</label>
        <textarea id="im-text" name="text" rows="8" required placeholder="Kindle Paperwhite https://www.amazon.com/dp/B09TMN58KL $189.99&#10;AeroPress coffee maker $49.95&#10;https://www.rei.com/product/camp-chair"></textarea>
      </div>
      <div id="im-report" aria-live="polite"></div>`,
    submitLabel: 'Add them',
    onSubmit: async (v, sheet) => {
      const items = v.text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 200).map(line => {
        const url = (line.match(/https?:\/\/\S+/) || [])[0] || null;
        const price = (line.match(/[$€£]\s?\d[\d.,]*/) || [])[0] || null;
        const title = line.replace(url || '', '').replace(price || '', '').replace(/[\s|—–-]+$/g, '').replace(/^[\s|—–-]+/g, '').trim();
        return { title: title || null, url, price };
      });
      const { report } = await post('/api/import/amazon', { list_id: listId, amazon_list_url: 'pasted list', items });
      const summary = `${report.imported.length} added, ${report.skipped.length} already on the list`;
      await refresh();
      if (report.failed.length === 0) {
        toast(`${summary}.`);
        return undefined;
      }
      // Keep the sheet open so the lines that failed can be fixed and retried.
      const box = sheet.form.querySelector('#im-report');
      const note = document.createElement('div');
      note.className = 'notice notice--honey';
      note.textContent = `${summary}, ${report.failed.length} could not be read: ${report.failed.map(f => `${f.title} (${f.reason})`).join('; ')}.`;
      box.replaceChildren(note);
      return false;
    }
  });
});
