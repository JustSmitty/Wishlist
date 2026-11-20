/** Entry point: routes, the app frame, account settings. */

import { html, raw, render, avatar, $ } from './dom.js';
import { post, patch, del, forgetGuestTokens } from './api.js';
import {
  store, me, on, loadSession, configureRouter, installDelegation, navigate, currentAddress, refresh, toast, openSheet, confirmSheet, copyText, reportError
} from './app.js';
import { icon } from './icons.js';
import home, { openAddItem } from './views/home.js';
import list from './views/list.js';
import gifting from './views/gifting.js';
import gifts from './views/gifts.js';
import circles from './views/circles.js';
import inbox from './views/inbox.js';
import admin from './views/admin.js';
import welcome, { brandMark, GOOGLE_BUTTON } from './views/welcome.js';

const NAV = [
  ['/', 'home', 'My lists', 'list'],
  ['/gifting', 'gifting', 'Gifting', 'people'],
  ['/gifts', 'gifts', 'My gifts', 'bag'],
  ['/circles', 'circles', 'Circles', 'circle'],
  ['/inbox', 'inbox', 'Inbox', 'inbox']
];

const routes = [
  { pattern: /^\/$/, view: home, nav: 'home' },
  { pattern: /^\/lists\/([^/]+)$/, view: home, nav: 'home' },
  { pattern: /^\/l\/([^/]+)$/, view: list, nav: 'gifting', public: true },
  { pattern: /^\/gifting$/, view: gifting, nav: 'gifting' },
  { pattern: /^\/gifts$/, view: gifts, nav: 'gifts' },
  { pattern: /^\/circles$/, view: circles, nav: 'circles' },
  { pattern: /^\/inbox$/, view: inbox, nav: 'inbox' },
  { pattern: /^\/admin$/, view: admin, nav: 'admin' },
  { pattern: /^\/welcome$/, view: welcome, public: true, bare: true }
];

let frameKey = null;

/** Draws the frame around the view. Only rebuilt when its shape changes. */
function renderFrame(route) {
  const user = me();
  const app = $('#app');
  const mode = route.bare && !user ? 'bare' : user ? 'shell' : 'guest';
  const key = `${mode}:${user?.id || ''}:${user?.name || ''}`;

  if (key !== frameKey) {
    frameKey = key;
    app.className = `app app--${mode}`;
    if (mode === 'bare') {
      render(app, html`<main id="view" tabindex="-1"></main>`);
    } else if (mode === 'guest') {
      render(app, html`
        <header class="guestbar">
          <a class="brand" href="/welcome" data-link>${brandMark()}<span><span class="brand__name">Hushlist</span></span></a>
          <a class="btn btn--sm" href="/welcome" data-link>Sign in</a>
        </header>
        <main id="view" class="page" tabindex="-1"></main>`);
    } else {
      const demo = store.session.demo.enabled;
      render(app, html`
        <aside class="rail">
          <a class="brand" href="/" data-link>${brandMark()}<span><span class="brand__name">Hushlist</span><span class="brand__tag">give in secret</span></span></a>
          <nav class="nav" aria-label="Main">
            ${NAV.map(([href, id, label, glyph]) => html`<a class="nav__link" href="${href}" data-link data-nav="${id}">${icon(glyph)} ${label}</a>`)}
            ${user.is_admin ? html`<a class="nav__link" href="/admin" data-link data-nav="admin">${icon('shield')} Admin</a>` : ''}
          </nav>
          <div class="rail__foot">
            ${demo ? html`
              <button class="demo-pill" type="button" data-action="demo-switch">
                ${icon('eye', { size: 18 })}
                <span><small>Demo mode</small><strong>Switch person</strong></span>
              </button>` : ''}
            <button class="me" type="button" data-action="account">
              ${avatar(user.name)}
              <span><span class="me__name">${user.name}</span><br /><span class="me__sub">Account and settings</span></span>
            </button>
          </div>
        </aside>
        <div class="stage">
          <header class="topbar">
            <a class="brand" href="/" data-link>${brandMark()}<span><span class="brand__name">Hushlist</span></span></a>
            <div class="row">
              ${demo ? html`<button class="btn btn--sm" type="button" data-action="demo-switch">${icon('eye', { size: 16 })} Demo</button>` : ''}
              <button class="btn btn--quiet btn--icon" type="button" data-action="account" aria-label="Account and settings">${avatar(user.name, { size: 'sm' })}</button>
            </div>
          </header>
          <main id="view" class="page" tabindex="-1"></main>
        </div>
        <nav class="tabbar" aria-label="Main">
          ${NAV.map(([href, id, label, glyph]) => html`<a href="${href}" data-link data-nav="${id}">${icon(glyph, { size: 22 })}<span>${label}</span></a>`)}
        </nav>`);
    }
  }

  for (const link of app.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === route.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

// ---------------------------------------------------------------- account

function applyTheme(choice) {
  try {
    if (choice === 'system') localStorage.removeItem('hushlist_theme');
    else localStorage.setItem('hushlist_theme', choice);
  } catch { /* storage unavailable */ }
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

on('account', () => {
  const user = me();
  let theme = 'system';
  try { theme = localStorage.getItem('hushlist_theme') || 'system'; } catch { /* ignore */ }
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  openSheet({
    title: 'Account and settings',
    size: 'wide',
    submitLabel: 'Save',
    body: html`
      <div class="fields">
        <div class="field"><label for="ac-name">Name</label><input id="ac-name" name="name" required maxlength="80" value="${user.name}" autocomplete="name" /></div>
        <div class="field"><label for="ac-email">Email</label><input id="ac-email" value="${user.email || ''}" readonly /></div>
      </div>
      <div class="fields">
        <div class="field"><label for="ac-month">Birthday month</label>
          <select id="ac-month" name="birthday_month"><option value="">—</option>${months.map((m, i) => html`<option value="${i + 1}" ${user.birthday_month === i + 1 ? raw('selected') : ''}>${m}</option>`)}</select></div>
        <div class="field"><label for="ac-day">Day</label><input id="ac-day" name="birthday_day" type="number" min="1" max="31" inputmode="numeric" value="${user.birthday_day ?? ''}" /></div>
      </div>
      <label class="check"><input type="checkbox" name="follow_approval_required" ${user.follow_approval_required ? raw('checked') : ''} /><span>Ask me before anyone follows me<small>People outside your circles always need your approval. Tick this to approve circle members too.</small></span></label>

      <hr />
      <fieldset class="field">
        <legend class="label">Appearance</legend>
        <div class="seg">
          ${[['system', 'Match device', 'eye'], ['light', 'Paper', 'sun'], ['dark', 'Midnight', 'moon']].map(([value, label, glyph]) => html`
            <label><input type="radio" name="theme" value="${value}" data-input="theme" ${theme === value ? raw('checked') : ''} />${icon(glyph)}<span>${label}</span></label>`)}
        </div>
      </fieldset>

      <hr />
      <h3>Save from any shop</h3>
      <p class="small muted">Two ways to send the page you are looking at to Hushlist.</p>
      <div class="row hero__actions">
        <button class="btn btn--sm" type="button" data-action="copy-bookmarklet">${icon('copy', { size: 16 })} Copy the bookmarklet</button>
        <button class="btn btn--sm" type="button" data-action="extension-token">${icon('lock', { size: 16 })} ${store.session.api_tokens ? 'Replace the extension token' : 'Create an extension token'}</button>
        ${store.session.api_tokens ? html`<button class="btn btn--sm btn--quiet" type="button" data-action="revoke-token">Revoke it</button>` : ''}
      </div>
      <div id="token-box" aria-live="polite"></div>

      ${store.session.auth?.google ? html`
        <hr />
        <h3>Google account</h3>
        ${me().google_connected
          ? html`<p class="small muted">You can sign in with Google. Disconnecting leaves your account as it is; you can still sign in with an email code.</p>
              <button class="btn btn--sm" type="button" data-action="google-disconnect">Disconnect Google</button>`
          : html`<p class="small muted">Connect a Google account so you can sign in with it next time, without waiting for a code.</p>
              <a class="google-signin" href="/api/auth/google/start?link=1" aria-label="Connect your Google account: sign in with Google">${GOOGLE_BUTTON}</a>`}` : ''}

      <hr />
      <h3>Your data</h3>
      <div class="row hero__actions">
        <a class="btn btn--sm" href="/api/export?format=csv" download="hushlist-export.csv">Download as CSV</a>
        <a class="btn btn--sm" href="/api/export?format=json" download="hushlist-export.json">Download as JSON</a>
      </div>
      <p class="small muted">Your lists, your wishes and the gifts you have reserved for others. Never what others have reserved for you.</p>

      <hr />
      <div class="row row--between">
        <button class="btn btn--sm" type="button" data-action="sign-out">${icon('out', { size: 16 })} Sign out</button>
        <button class="btn btn--sm btn--danger" type="button" data-action="delete-account">Delete my account</button>
      </div>`,
    onSubmit: async (v) => {
      const res = await patch('/api/account', {
        name: v.name,
        birthday_month: v.birthday_month ? Number(v.birthday_month) : null,
        birthday_day: v.birthday_day ? Number(v.birthday_day) : null,
        follow_approval_required: v.follow_approval_required
      });
      store.session.current_user = res.current_user;
      toast('Saved');
      await navigate(location.pathname, { replace: true });
    }
  });
});

document.addEventListener('change', (event) => {
  if (event.target.matches?.('input[name="theme"]')) applyTheme(event.target.value);
});

on('copy-bookmarklet', () => {
  const code = `javascript:void(window.open('${location.origin}/share-target?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)))`;
  copyText(code, 'Copied. Make a new bookmark and paste this as its address.');
});

on('extension-token', async (el) => {
  const box = el.closest('form').querySelector('#token-box');
  const { token } = await post('/api/auth/tokens');
  store.session.api_tokens = 1;
  render(box, html`
    <div class="notice notice--honey">${icon('lock')}<div class="grow">
      <strong>Copy this into the extension now. It is shown once.</strong>
      <div class="linkbox"><input readonly value="${token}" aria-label="Extension token" /><button class="btn btn--sm btn--primary" type="button" data-action="copy" data-text="${token}">Copy</button></div>
      Anyone holding it can add to your lists, so treat it like a password. Creating a new one cancels the old one.
    </div></div>`);
});

on('revoke-token', async (el) => {
  await del('/api/auth/tokens');
  store.session.api_tokens = 0;
  el.remove();
  toast('Extension token revoked');
});

on('sign-out', async () => {
  await post('/api/auth/logout');
  forgetGuestTokens();
  document.querySelector('dialog.sheet')?.close();
  await loadSession();
  await navigate('/welcome', { replace: true });
});

on('delete-account', async () => {
  const ok = await confirmSheet({
    title: 'Delete your account?',
    message: 'Your lists are closed and your details erased. Gifts you reserved for others stay reserved, without your name. Children you alone look after are removed too. This cannot be undone.',
    confirmLabel: 'Delete my account', danger: true
  });
  if (!ok) return;
  await del('/api/account', { confirm: true });
  document.querySelector('dialog.sheet')?.close();
  await loadSession();
  toast('Your account has been deleted');
  await navigate('/welcome', { replace: true });
});

on('demo-switch', () => {
  const user = me();
  openSheet({
    title: 'See it as someone else',
    intro: 'Demo mode lets you step into each sample person. The same list looks different to its owner, to family, and to a guest with the link.',
    size: 'narrow', cancelLabel: 'Close',
    body: html`
      <div class="personas">
        ${store.session.demo.personas.map(p => html`
          <button class="persona" type="button" data-action="demo-become" data-user="${p.id}" ${p.id === user?.id ? raw('aria-current="true"') : ''}>
            ${avatar(p.name)}
            <span><strong>${p.name}${p.id === user?.id ? ' (you, now)' : ''}</strong><small>${p.is_admin ? 'Owner and administrator' : 'Family member'}</small></span>
          </button>`)}
        <button class="persona" type="button" data-action="demo-guest">
          <span class="avatar tone-4" aria-hidden="true">?</span>
          <span><strong>A guest with the link</strong><small>Signed out, looking at Justin's shared list</small></span>
        </button>
      </div>`
  });
});

on('demo-become', async (el) => {
  await post('/api/auth/demo-login', { user_id: el.dataset.user });
  document.querySelector('dialog.sheet')?.close();
  await loadSession();
  toast(`You are now ${me().name}`);
  await navigate('/', { replace: true });
});

on('demo-guest', async () => {
  await post('/api/auth/logout');
  forgetGuestTokens();
  document.querySelector('dialog.sheet')?.close();
  await loadSession();
  await navigate('/l/justin-winter-2026', { replace: true });
});

// ---------------------------------------------------------------- boot

async function boot() {
  installDelegation();
  configureRouter(routes, renderFrame);
  try {
    await loadSession();
  } catch (err) {
    render($('#app'), html`<div class="boot"><p>${err.message}</p><button class="btn" type="button" data-action="reload">Try again</button></div>`);
    return;
  }

  const params = new URLSearchParams(location.search);
  const sharedUrl = params.get('sharedUrl');
  await navigate(currentAddress(), { replace: true });

  if (params.get('google') === 'connected' && me()) {
    history.replaceState(null, '', location.pathname);
    toast('Google account connected. You can now sign in with Google.');
  }

  // Arrived from the share sheet or the bookmarklet: open "Add a wish" prefilled.
  if (sharedUrl !== null && me()) {
    history.replaceState(null, '', '/');
    const target = store.current?.data?.active;
    if (target) openAddItem(target.id, { url: sharedUrl, title: params.get('sharedTitle') || '' });
    else toast('Create a list first, then share to Hushlist again.');
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

on('google-disconnect', async () => {
  const ok = await confirmSheet({
    title: 'Disconnect Google?',
    message: 'You will sign in with an email code instead. You can connect Google again at any time.',
    confirmLabel: 'Disconnect'
  });
  if (!ok) return;
  await del('/api/auth/google');
  await loadSession();
  toast('Google account disconnected');
});

on('reload', () => location.reload());
window.addEventListener('unhandledrejection', (event) => { reportError(event.reason); });

boot();
