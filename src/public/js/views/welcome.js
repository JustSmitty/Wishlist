/** Signed-out landing page and sign-in. */

import { html } from '../dom.js';
import { post } from '../api.js';
import { store, on, onForm, loadSession, navigate, rerender, toast } from '../app.js';
import { icon } from '../parts.js';
import { giftArt } from '../art.js';
import { avatar } from '../dom.js';

const state = { step: 'email', email: '', challengeId: null, demoCode: null, code: '' };

// Messages for the codes the server puts in ?signin_error=. Only these are
// ever shown: the page never displays text taken from its own address.
const SIGNIN_ERRORS = {
  use_code: 'Google could not vouch for that email address, so sign in with an email code instead. Once you are in, you can connect your Google account from Account settings.',
  linked_elsewhere: 'That Google account is already connected to a different Hushlist account, or this Hushlist account is connected to a different Google account.',
  expired: 'That sign-in took too long or was started in another browser. Please try again.',
  cancelled: 'Google sign-in was cancelled.',
  invalid: 'Google sign-in could not be verified. Please try again.',
  google_error: 'Google sign-in did not complete. Please try again, or use an email code.',
  unavailable: 'This account is not available.',
  signed_out: 'Sign in first, then connect your Google account from Account settings.'
};

// Google's own "Sign in with Google" button (light theme, pill), unmodified,
// from the asset bundle linked in Google's branding guidelines. The guidelines
// do not allow redrawing the "G" or using an outdated one.
export const GOOGLE_BUTTON = html`<img class="google-signin__img" src="/icons/google/signin-light-pill.svg" width="180" height="40" alt="Sign in with Google" />`;

function googleButton() {
  if (!store.session.auth?.google) return '';
  const invite = new URLSearchParams(location.search).get('invite');
  const href = `/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`;
  return html`
    <a class="google-signin" href="${href}">${GOOGLE_BUTTON}</a>
    <p class="divider"><span>or</span></p>`;
}

function signInError() {
  const code = new URLSearchParams(location.search).get('signin_error');
  const message = code && Object.hasOwn(SIGNIN_ERRORS, code) ? SIGNIN_ERRORS[code] : null;
  return message ? html`<div class="notice notice--honey" role="alert">${icon('flag')}<div>${message}</div></div>` : '';
}
const SAMPLES = [
  ['a', 'Pour-over kettle', 'product', 'open'], ['b', 'Pottery class', 'experience', 'reserved'], ['c', 'Bookshop fund', 'cash', 'open'], ['d', 'Hori-hori', 'product', 'bought'],
  ['e', 'Sci-fi hardcover', 'idea', 'open'], ['f', 'Rocket set', 'product', 'bought'], ['g', 'Hammock', 'product', 'open'], ['h', 'Matcha bowl', 'product', 'reserved']
];

export default {
  title: () => 'Welcome',
  async load() { return {}; },

  render() {
    const demo = store.session.demo;
    return html`
      <div class="welcome">
        <section class="welcome__pitch">
          <a class="brand" href="/" data-link>${brandMark()}<span><span class="brand__name">Hushlist</span></span></a>
          <h1>Wish out loud.<br />Give <em>in secret.</em></h1>
          <p class="welcome__lead">One wishlist for every shop. The people who love you can see what is taken — and you cannot, until after the day.</p>
          <div class="tiles" aria-hidden="true">
            ${SAMPLES.map(([id, title, kind, wrap]) => html`<div>${giftArt({ id, title, kind }, wrap)}</div>`)}
          </div>
          <ul class="promises">
            <li>${icon('lock')}<span><strong>The surprise is kept for you.</strong> Your account is never shown reservations on your own list: not on pages, not in emails, not in exports.</span></li>
            <li>${icon('gift')}<span><strong>Givers need no account.</strong> One link opens on any phone. An email address is enough to reserve.</span></li>
            <li>${icon('shield')}<span><strong>No address, no ads, no third-party trackers.</strong> Hushlist never stores where you live and never handles the money.</span></li>
          </ul>
        </section>

        <section class="welcome__door" aria-label="Sign in">
          ${signIn()}
          ${demo.enabled ? html`
            <div class="card card--sunk stack">
              <div>
                <p class="eyebrow">Demo</p>
                <h2>Or step into the sample family</h2>
                <p class="muted small">This copy is running in demo mode on your own machine. Pick someone to see Hushlist from their side: Justin cannot see what Aunt Elena bought him, but she can.</p>
              </div>
              <div class="personas">
                ${demo.personas.map(p => html`
                  <button class="persona" type="button" data-action="demo-login" data-user="${p.id}">
                    ${avatar(p.name)}
                    <span><strong>${p.name}</strong><small>${p.is_admin ? 'Owner and administrator' : 'Family member'}</small></span>
                  </button>`)}
              </div>
            </div>` : ''}
        </section>
      </div>`;
  },

  afterRender(root) {
    root.querySelector('[data-autofocus]')?.focus({ preventScroll: true });
  }
};

export function brandMark() {
  return html`<svg class="brand__mark" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="29" fill="currentColor"/>
    <path d="M20 36c0-10 5-17 12-17s12 7 12 17M26 43h12" fill="none" stroke="#fffdf8" stroke-width="3.4" stroke-linecap="round"/>
    <circle cx="26" cy="32" r="2" fill="#fffdf8"/><circle cx="38" cy="32" r="2" fill="#fffdf8"/>
  </svg>`;
}

function signIn() {
  if (state.step === 'email') {
    return html`
      <form class="card stack" data-form="signin-email" novalidate>
        <div>
          <h2>Sign in or start a list</h2>
          <p class="muted small">No password. ${store.session.auth?.google ? 'Use your Google account, or we send an 8-digit code to your email.' : 'We send an 8-digit code to your email.'}</p>
        </div>
        ${signInError()}
        ${googleButton()}
        <div class="field">
          <label for="si-email">Email</label>
          <input id="si-email" name="email" type="email" required autocomplete="email" inputmode="email" placeholder="you@example.com" value="${state.email}" />
        </div>
        <button class="btn btn--primary btn--block" type="submit">Send me a code</button>
      </form>`;
  }
  if (state.step === 'code') {
    return html`
      <form class="card stack" data-form="signin-code" novalidate>
        <div>
          <h2>Enter your code</h2>
          <p class="muted small">Sent to <strong>${state.email}</strong>. It works for 10 minutes.</p>
        </div>
        ${state.demoCode ? html`<div class="notice notice--honey">${icon('inbox')}<div>Demo mode does not send email, so the code has been filled in for you.</div></div>` : ''}
        <div class="field">
          <label for="si-code">8-digit code</label>
          <input id="si-code" name="code" class="codebox" required inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]{8}" value="${state.demoCode || ''}" data-autofocus />
        </div>
        <button class="btn btn--primary btn--block" type="submit">Continue</button>
        <button class="btn btn--quiet btn--block" type="button" data-action="signin-restart">Use a different email</button>
      </form>`;
  }
  return html`
    <form class="card stack" data-form="signin-profile" novalidate>
      <div>
        <h2>Nice to meet you</h2>
        <p class="muted small">This is how you appear to the people you share lists with.</p>
      </div>
      <div class="field"><label for="si-name">Your name</label><input id="si-name" name="name" required maxlength="80" autocomplete="name" data-autofocus /></div>
      <div class="field"><label for="si-invite">Invite code <span class="muted">(if someone sent you one)</span></label><input id="si-invite" name="invite_code" maxlength="64" autocomplete="off" autocapitalize="characters" /></div>
      <button class="btn btn--primary btn--block" type="submit">Create my Hushlist</button>
    </form>`;
}

async function enter(message) {
  Object.assign(state, { step: 'email', email: '', challengeId: null, demoCode: null, code: '' });
  await loadSession();
  toast(message);
  await navigate('/', { replace: true });
}

onForm('signin-email', async (form, v) => {
  if (!form.reportValidity()) return;
  const res = await post('/api/auth/start', { email: v.email });
  Object.assign(state, { step: 'code', email: v.email, challengeId: res.challenge_id, demoCode: res.demo_code || null });
  rerender();
});

onForm('signin-code', async (form, v) => {
  if (!form.reportValidity()) return;
  const res = await post('/api/auth/verify', { challenge_id: state.challengeId, code: v.code });
  if (res.needs_profile) {
    Object.assign(state, { step: 'profile', code: v.code });
    rerender();
    return;
  }
  await enter(`Welcome back, ${res.current_user.name.split(' ')[0]}`);
});

onForm('signin-profile', async (form, v) => {
  if (!form.reportValidity()) return;
  const res = await post('/api/auth/verify', { challenge_id: state.challengeId, code: state.code, name: v.name, invite_code: v.invite_code || undefined });
  await enter(res.joined_group ? `Welcome! You have joined ${res.joined_group.name}.` : 'Welcome to Hushlist. Your first list is ready.');
});

on('signin-restart', async () => {
  Object.assign(state, { step: 'email', challengeId: null, demoCode: null, code: '' });
  rerender();
});

on('demo-login', async (el) => {
  const res = await post('/api/auth/demo-login', { user_id: el.dataset.user });
  await enter(`You are now ${res.current_user.name}`);
});
