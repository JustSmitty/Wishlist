/** Inbox: messages Hushlist has addressed to you. */

import { html, timeAgo } from '../dom.js';
import { get, post } from '../api.js';
import { store, on, refresh, toast } from '../app.js';
import { icon, empty } from '../parts.js';

const LABELS = {
  follower_digest: ['Digest', 'inbox'],
  new_follower: ['Followers', 'people'],
  claimed_item_changed: ['A gift you reserved', 'edit'],
  claimed_item_withdrawn: ['A gift you reserved', 'flag'],
  claim_expiring: ['Your hold', 'calendar'],
  claimed_item_price_drop: ['Price drop', 'coin'],
  claimed_item_out_of_stock: ['Stock', 'box'],
  claim_confirmed: ['Arrived', 'check'],
  list_revealed: ['List opened', 'gift'],
  sign_in_code: ['Sign-in', 'lock'],
  guest_verification_code: ['Verification', 'lock']
};

export default {
  title: () => 'Inbox',

  async load() {
    return get('/api/notifications');
  },

  render({ notifications }) {
    const demo = store.session.demo.enabled;
    return html`
      <header class="page-head">
        <div>
          <p class="eyebrow">Inbox</p>
          <h1>Messages for you</h1>
          <p>Nothing here ever tells you who is giving you what. That is checked on every message before it is written.</p>
        </div>
        <button class="btn" type="button" data-action="inbox-digest">${icon('inbox', { size: 18 })} Send me today's digest</button>
      </header>

      <div class="notice">${icon('inbox')}<div>${demo
        ? html`<strong>Demo mode does not send email.</strong>Everything Hushlist would have emailed you is shown here instead.`
        : html`<strong>This build has no email provider connected.</strong>Messages are kept here, and the server writes them to its log.`}</div></div>

      <div class="section-title"></div>
      ${notifications.length === 0 ? empty({ title: 'All quiet', text: 'Updates about gifts you have reserved and lists you follow will land here.', seed: 'inbox' })
        : notifications.map(n => {
          const [label, glyph] = Object.hasOwn(LABELS, n.event_type) ? LABELS[n.event_type] : ['Update', 'inbox'];
          return html`
            <article class="card letter">
              <div class="letter__stamp">${icon(glyph, { size: 22 })}</div>
              <div>
                <h3>${n.subject}</h3>
                <p class="letter__body">${n.body}</p>
              </div>
              <div class="stack small muted">
                <span class="pill">${label}</span>
                <span class="nowrap">${timeAgo(n.created_at)}</span>
                ${n.sent_at ? '' : html`<span class="pill pill--honey" title="Held back during quiet hours">Scheduled</span>`}
              </div>
            </article>`;
        })}`;
  }
};

on('inbox-digest', async () => {
  const { digest } = await post('/api/notifications/digest');
  toast(digest.already_sent_today ? 'Today\'s digest was already sent. One a day, at most.' : 'Digest sent.');
  await refresh();
});
