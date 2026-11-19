/**
 * App core: session, navigation, event delegation, dialogs and toasts.
 * Views import from here; this file imports no view.
 */

import { html, raw, render, esc, $ } from './dom.js';
import { get, patch, ApiError, forgetGuestTokens } from './api.js';
import { icon } from './icons.js';

export const store = {
  session: { current_user: null, is_guest: true, dependents: [], demo: { enabled: false, personas: [] }, api_tokens: 0 },
  current: null // { view, params, data }
};

export const me = () => store.session.current_user;

export async function loadSession() {
  store.session = await get('/api/session');
  // Once someone is signed in, guest tokens kept by this browser are dropped.
  if (store.session.current_user) forgetGuestTokens();
  reportTimeZone();
  return store.session;
}

/**
 * Tells the server which time zone this person is in, so messages that can
 * wait are held during their night rather than the server's. Best effort.
 */
function reportTimeZone() {
  const user = store.session.current_user;
  if (!user) return;
  let zone = null;
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { /* unavailable */ }
  if (!zone || zone === user.time_zone) return;
  user.time_zone = zone;
  patch('/api/account', { time_zone: zone }).catch(() => {});
}

// ---------------------------------------------------------------- toasts

export function toast(message, kind = 'ok') {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast--error' : ''}`;
  if (kind === 'error') el.setAttribute('role', 'alert');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4200);
}

export function reportError(err) {
  if (!(err instanceof ApiError)) console.error(err);
  toast(err?.message || 'Something went wrong', 'error');
}

// ---------------------------------------------------------------- actions

const clickHandlers = new Map();
const formHandlers = new Map();
const inputHandlers = new Map();

/** Register a handler for elements carrying data-action="name". */
export function on(name, handler) { clickHandlers.set(name, handler); }
/** Register a handler for <form data-form="name">. Receives (form, values). */
export function onForm(name, handler) { formHandlers.set(name, handler); }
/** Register a handler for controls carrying data-input="name" (input/change). */
export function onInput(name, handler) { inputHandlers.set(name, handler); }

async function guarded(el, fn) {
  if (el?.getAttribute?.('aria-busy') === 'true') return;
  const busyTarget = el?.matches?.('button, .btn') ? el : null;
  busyTarget?.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (err) {
    reportError(err);
  } finally {
    busyTarget?.removeAttribute('aria-busy');
  }
}

export function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') values[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) values[el.name] = el.value; }
    else values[el.name] = typeof el.value === 'string' ? el.value.trim() : el.value;
  }
  return values;
}

export function installDelegation() {
  document.addEventListener('click', (event) => {
    // Close any open menu when clicking elsewhere (or on one of its items).
    for (const menu of document.querySelectorAll('details.menu[open]')) {
      const summary = menu.querySelector('summary');
      if (!summary.contains(event.target)) menu.removeAttribute('open');
    }

    const link = event.target.closest?.('a[data-link]');
    if (link && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      navigate(link.getAttribute('href'));
      return;
    }

    const el = event.target.closest?.('[data-action]');
    if (!el || el.disabled) return;
    const handler = clickHandlers.get(el.dataset.action);
    if (!handler) return;
    if (el.tagName === 'A' && el.getAttribute('href') === '#') event.preventDefault();
    guarded(el, () => handler(el, event));
  });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest?.('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const handler = formHandlers.get(form.dataset.form);
    if (!handler) return;
    const submitter = event.submitter || form.querySelector('[type="submit"]');
    guarded(submitter, () => handler(form, formValues(form), submitter));
  });

  const onInputEvent = (event) => {
    const el = event.target.closest?.('[data-input]');
    if (!el) return;
    const handler = inputHandlers.get(el.dataset.input);
    if (handler) Promise.resolve(handler(el, event)).catch(reportError);
  };
  document.addEventListener('input', onInputEvent);
  document.addEventListener('change', (event) => { if (event.target.matches?.('select, input[type="checkbox"], input[type="radio"]')) onInputEvent(event); });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = document.querySelector('details.menu[open]');
    if (open) { open.removeAttribute('open'); open.querySelector('summary')?.focus(); }
  });

  window.addEventListener('popstate', () => routeTo(currentAddress(), { push: false }));
}

// ---------------------------------------------------------------- routing

let routes = [];
let renderFrame = () => {};

export function configureRouter(table, frameRenderer) {
  routes = table;
  renderFrame = frameRenderer;
}

export function navigate(path, { replace = false } = {}) {
  return routeTo(path, { push: !replace, replace });
}

function match(pathname) {
  for (const route of routes) {
    const m = route.pattern.exec(pathname);
    if (m) return { route, params: m.slice(1).map(decodeURIComponent) };
  }
  return null;
}

/**
 * The address bar as an in-app path. A path that begins with two slashes (or a
 * backslash) would be read as another site's address if it were resolved as a
 * link, so leading slashes are collapsed to one first.
 */
export function currentAddress() {
  return '/' + location.pathname.replace(/^[/\\]+/, '') + location.search;
}

async function routeTo(url, { push = true, replace = false } = {}) {
  // The router only ever shows pages of this app. Anything that resolves to
  // another site is treated as an unknown page, never followed.
  let target = new URL(String(url).replace(/^[/\\]+/, '/'), location.origin);
  if (target.origin !== location.origin) target = new URL('/', location.origin);

  // Older share links used /?list=<token>.
  const legacy = target.pathname === '/' ? target.searchParams.get('list') : null;
  if (legacy) return routeTo(`/l/${encodeURIComponent(legacy)}`, { replace: true });

  let found = match(target.pathname) || match('/');
  if (!me() && !found.route.public) {
    found = match('/welcome');
    target.pathname = '/welcome';
  }

  const href = target.pathname + target.search;
  if (replace) history.replaceState(null, '', href);
  else if (push && href !== location.pathname + location.search) history.pushState(null, '', href);

  store.current = { view: found.route.view, route: found.route, params: found.params, query: target.searchParams, data: null };
  renderFrame(found.route);
  await refresh({ scrollTop: true });
}

/** Re-fetch the current view's data and draw it. */
export async function refresh({ scrollTop = false } = {}) {
  const current = store.current;
  if (!current) return;
  const target = $('#view');
  if (!target) return;
  try {
    const data = await current.view.load(current.params, current.query);
    if (store.current !== current) return; // navigated away meanwhile
    current.data = data;
    render(target, current.view.render(data, current.params));
    document.title = `${current.view.title?.(data) || current.route.title || 'Hushlist'} · Hushlist`;
    current.view.afterRender?.(target, data);
  } catch (err) {
    if (store.current !== current) return;
    render(target, errorState(err));
  }
  $('#app')?.removeAttribute('aria-busy');
  if (scrollTop) {
    window.scrollTo(0, 0);
    target.focus({ preventScroll: true });
  }
}

/** Redraw from data already loaded (filters, sorting, search). */
export function rerender() {
  const current = store.current;
  const target = $('#view');
  if (!current?.data || !target) return;
  const active = document.activeElement;
  const restore = active?.id && target.contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  render(target, current.view.render(current.data, current.params));
  current.view.afterRender?.(target, current.data);
  if (restore) {
    const el = document.getElementById(restore.id);
    el?.focus({ preventScroll: true });
    try { if (restore.start !== null) el?.setSelectionRange(restore.start, restore.end); } catch { /* not a text field */ }
  }
}

function errorState(err) {
  const notFound = err?.status === 404;
  return html`
    <div class="card empty">
      <h2>${notFound ? 'Nothing here' : 'That did not load'}</h2>
      <p>${err?.message || 'Something went wrong.'}</p>
      <div class="row">
        ${notFound ? '' : html`<button class="btn" type="button" data-action="retry">Try again</button>`}
        <a class="btn btn--quiet" href="/" data-link>Go home</a>
      </div>
    </div>`;
}

on('retry', () => refresh());

// ---------------------------------------------------------------- dialogs

/**
 * Opens a modal sheet built on the native <dialog>: focus is trapped and
 * restored by the browser, Escape closes it, and the backdrop is inert.
 *
 * onSubmit(values, sheet) may throw to show an inline error; returning false
 * keeps the sheet open.
 */
export function openSheet({
  title, intro = null, body, submitLabel = 'Save', cancelLabel = 'Cancel',
  onSubmit = null, size = '', danger = false, afterOpen = null, extraFoot = null
}) {
  const root = $('#dialog-root');
  const dialog = document.createElement('dialog');
  const titleId = `sheet-${Math.random().toString(36).slice(2, 9)}`;
  dialog.className = `sheet${size ? ` sheet--${size}` : ''}`;
  dialog.setAttribute('aria-labelledby', titleId);

  render(dialog, html`
    <form method="dialog" class="sheet__form" novalidate>
      <div class="sheet__head">
        <div>
          <h2 id="${titleId}">${title}</h2>
          ${intro ? html`<p>${intro}</p>` : ''}
        </div>
        <button class="btn btn--quiet btn--icon btn--sm" type="button" data-sheet-close aria-label="Close">${icon('close')}</button>
      </div>
      <div class="sheet__body">${body}</div>
      <div class="sheet__foot">
        <span class="sheet__error" role="alert" hidden></span>
        ${extraFoot || ''}
        ${cancelLabel ? html`<button class="btn btn--quiet" type="button" data-sheet-close>${cancelLabel}</button>` : ''}
        ${onSubmit ? html`<button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" type="submit">${submitLabel}</button>` : ''}
      </div>
    </form>`);

  const form = dialog.querySelector('form');
  const errorEl = dialog.querySelector('.sheet__error');
  const sheet = {
    el: dialog,
    form,
    close: () => dialog.close(),
    setError: (message) => { errorEl.textContent = message || ''; errorEl.hidden = !message; },
    setSubmitLabel: (label) => { const b = form.querySelector('[type="submit"]'); if (b) b.textContent = label; }
  };

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-sheet-close]')) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!onSubmit) return dialog.close();
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]');
    if (button.getAttribute('aria-busy') === 'true') return;
    button.setAttribute('aria-busy', 'true');
    sheet.setError('');
    try {
      const keepOpen = (await onSubmit(formValues(form), sheet)) === false;
      if (!keepOpen) dialog.close();
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      sheet.setError(err?.message || 'Something went wrong');
    } finally {
      button.removeAttribute('aria-busy');
    }
  });

  root.appendChild(dialog);
  dialog.showModal();
  afterOpen?.(sheet);
  return sheet;
}

/** Resolves true if confirmed, false if dismissed. */
export function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false, body = null }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const sheet = openSheet({
      title, intro: message, body: body || '', size: 'narrow', danger, submitLabel: confirmLabel,
      onSubmit: () => { confirmed = true; }
    });
    sheet.el.addEventListener('close', () => resolve(confirmed));
  });
}

export async function copyText(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Copy failed — select the text and copy it by hand', 'error');
  }
}

export { html, raw, esc };
