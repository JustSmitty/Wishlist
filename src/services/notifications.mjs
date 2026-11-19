/**
 * Notification outbox.
 *
 * Invariant: nothing addressed to the owner or a co-owner of an unrevealed
 * surprise-mode list may reveal whether an item on that list is claimed.
 *
 * Delivery: messages are written to notifications_outbox and delivered by
 * dispatchOutbox(), which the server runs after each request and on a timer.
 * That keeps delivery outside the database transaction that produced the
 * message (nothing is sent for work that was rolled back) and is what makes
 * "send later" real: a message held for quiet hours is sent when its time
 * comes. A failed delivery is retried with growing gaps and given up on after
 * eight tries, three days, or a permanent refusal from the mail server.
 *
 * Transports: SMTP (any provider), the server log, or none (demo mode, where
 * the outbox is shown in the app). A transport may be synchronous or async.
 *
 * The one exception is a message carrying a one-time code. Its real text is
 * never stored, so it is handed to the transport straight away; if that
 * fails the person asks for a new code.
 */

import { uid } from '../db/schema.mjs';
import { getViewerRole, safeJsonParse } from './surprise.mjs';

const TRANSACTIONAL_EVENTS = new Set([
  'sign_in_code',
  'guest_verification_code',
  'claimed_item_changed',
  'claimed_item_withdrawn',
  'claim_expiring',
  'did_you_buy_it',
  'list_revealed'
]);

// Events that exist only because a claim exists.
const SPOILER_EVENT_TYPES = new Set([
  'claimed_item_changed',
  'claimed_item_withdrawn',
  'claim_expiring',
  'did_you_buy_it',
  'claimed_item_price_drop',
  'claimed_item_out_of_stock',
  'claim_confirmed',
  'list_revealed'
]);

let mailTransport = null;

/** fn({ to, subject, body, eventType }) — called once per message that is due now; may return a promise. */
export function setMailTransport(fn) {
  mailTransport = typeof fn === 'function' ? fn : null;
}

const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
let dispatching = null;

export function consoleMailTransport({ to, subject, body }) {
  // Addresses and text come from people; control characters must not reach
  // the operator's terminal as anything but visible escapes.
  const visible = (text) => String(text).replace(/[\x00-\x09\x0b-\x1f\x7f\x9b]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  console.log(`[mail:console] to=${visible(to)}\n  subject: ${visible(subject)}\n  ${visible(body).replace(/\n/g, '\n  ')}`);
}

export function sendNotification(db, {
  recipientUserId = null,
  recipientEmail,
  eventType,
  subject,
  body,
  storedBody = null,
  aboutUserId = null,
  listId = null,
  channel = 'email'
}) {
  if (!recipientEmail && recipientUserId) {
    const u = db.prepare("SELECT email FROM users WHERE id = ? AND status = 'active'").get(recipientUserId);
    if (u) recipientEmail = u.email;
  }
  if (!recipientEmail) return { skipped: true, reason: 'no_email' };

  // A message about a list usually names it, and a list is usually named
  // after its owner. Recording whose list it was lets the message be removed
  // from other people's inboxes if that person closes their account.
  // (Pass aboutUserId: false for a message that deliberately names nobody.)
  if (aboutUserId === null && listId) {
    aboutUserId = db.prepare('SELECT owner_id FROM lists WHERE id = ?').get(listId)?.owner_id || null;
  }
  if (aboutUserId === false) aboutUserId = null;

  if (listId && SPOILER_EVENT_TYPES.has(eventType)) {
    const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
    if (list && list.surprise_mode === 1 && !list.revealed_at) {
      const ownerIds = [list.owner_id, ...safeJsonParse(list.co_owner_ids, [])];
      const ownerEmails = ownerIds
        .map(id => db.prepare('SELECT email FROM users WHERE id = ?').get(id)?.email)
        .filter(Boolean)
        .map(e => e.toLowerCase());
      const isRecipientOwner =
        (recipientUserId && ownerIds.includes(recipientUserId)) ||
        ownerEmails.includes(String(recipientEmail).toLowerCase());
      if (isRecipientOwner) {
        return { skipped: true, reason: 'spoiler_protection_blocked_owner_notification' };
      }
    }
  }

  const isTransactional = TRANSACTIONAL_EVENTS.has(eventType);
  const now = new Date();
  let scheduledFor = now;

  if (recipientUserId && !isTransactional) {
    const pref = db.prepare(
      'SELECT * FROM notification_preferences WHERE user_id = ? AND event_type = ? AND channel = ?'
    ).get(recipientUserId, eventType, channel);

    if (pref && pref.enabled === 0) {
      return { skipped: true, reason: 'disabled_by_user_preference' };
    }

    // Quiet hours are judged on the recipient's own clock. If their time zone
    // is not known, nothing is held back: guessing would delay mail by hours
    // for most of the world.
    const zone = db.prepare('SELECT time_zone FROM users WHERE id = ?').get(recipientUserId)?.time_zone;
    const minuteNow = zone ? minuteOfDayInZone(now, zone) : null;
    if (minuteNow !== null) {
      const quietStart = (pref ? pref.quiet_hours_start : 21) * 60;
      const quietEnd = (pref ? pref.quiet_hours_end : 8) * 60;
      const inQuietHours = quietStart > quietEnd
        ? (minuteNow >= quietStart || minuteNow < quietEnd)
        : (minuteNow >= quietStart && minuteNow < quietEnd);
      if (inQuietHours) {
        const minutesUntilEnd = (quietEnd - minuteNow + 1440) % 1440 || 1440;
        scheduledFor = new Date(now.getTime() + minutesUntilEnd * 60 * 1000);
        scheduledFor.setUTCSeconds(0, 0);
      }
    }
  }

  const id = uid('ntf');
  const unsubToken = isTransactional ? null : uid('unsub');
  const nowIso = now.toISOString();
  const dueNow = scheduledFor.getTime() <= now.getTime();
  const immediate = storedBody !== null;

  db.prepare(`
    INSERT INTO notifications_outbox (
      id, recipient_user_id, recipient_email, event_type, subject, body,
      channel, transactional, unsubscribe_token, scheduled_for, sent_at, created_at, about_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    recipientUserId,
    recipientEmail,
    eventType,
    subject,
    storedBody ?? body,
    channel,
    isTransactional ? 1 : 0,
    unsubToken,
    scheduledFor.toISOString(),
    immediate ? nowIso : null,
    nowIso,
    aboutUserId
  );

  if (immediate && mailTransport) {
    const transport = mailTransport;
    // Not awaited: the person is waiting for the page, not for the mail server.
    Promise.resolve()
      .then(() => transport({ to: recipientEmail, subject, body, eventType }))
      .catch(err => console.error(`[mail] could not send ${eventType}:`, err.message));
  }

  return { id, sent: dueNow, transactional: isTransactional, scheduled_for: scheduledFor.toISOString() };
}

/**
 * Delivers every stored message whose time has come. Safe to call often: it
 * is one indexed query when there is nothing to do, and a call made while a
 * delivery run is in progress waits for that run instead of starting another
 * (which could send the same message twice). Resolves to the number sent.
 */
export function dispatchOutbox(db, now = new Date()) {
  if (dispatching) return dispatching.then(() => 0);
  dispatching = runDispatch(db, now).finally(() => { dispatching = null; });
  return dispatching;
}

async function runDispatch(db, now) {
  const nowIso = now.toISOString();
  const giveUpBefore = new Date(now.getTime() - 3 * 86400 * 1000).toISOString();
  const due = db.prepare(`
    SELECT id, recipient_email, event_type, subject, body, attempts FROM notifications_outbox
    WHERE sent_at IS NULL AND failed_at IS NULL AND scheduled_for <= ? AND scheduled_for > ?
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY scheduled_for ASC LIMIT 100
  `).all(nowIso, giveUpBefore, nowIso);
  let sent = 0;
  for (const row of due) {
    // Checked again just before sending: the row may have been removed (an
    // account closed) while earlier messages in this run were being sent.
    if (!db.prepare('SELECT 1 FROM notifications_outbox WHERE id = ? AND sent_at IS NULL').get(row.id)) continue;
    const transport = mailTransport;
    try {
      if (transport) await transport({ to: row.recipient_email, subject: row.subject, body: row.body, eventType: row.event_type });
      db.prepare('UPDATE notifications_outbox SET sent_at = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), row.id);
      sent++;
    } catch (err) {
      const attempts = (row.attempts || 0) + 1;
      const giveUp = Boolean(err?.permanent) || attempts >= MAX_ATTEMPTS;
      const retryAt = new Date(now.getTime() + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60_000).toISOString();
      db.prepare('UPDATE notifications_outbox SET attempts = ?, next_attempt_at = ?, failed_at = ?, last_error = ? WHERE id = ?')
        .run(attempts, giveUp ? null : retryAt, giveUp ? new Date().toISOString() : null, String(err?.message || err).slice(0, 300), row.id);
      console.error(`[mail] delivery ${giveUp ? 'given up' : 'will be retried'} (${row.event_type}):`, err?.message || err);
    }
  }
  return sent;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes since local midnight in the given zone (so :30 and :45 zones are right), or null. */
function minuteOfDayInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone
    }).formatToParts(date);
    const get = (type) => Number(parts.find(p => p.type === type).value);
    return get('hour') * 60 + get('minute');
  } catch {
    return null;
  }
}

/**
 * Follower digest: changes since the reader's last digest on lists they
 * follow. At most one in any twenty hours. Never includes the reader's own lists, a
 * list the reader could not open right now (private, blocked, share removed),
 * or an item that has since been removed or moved elsewhere.
 */
export function generateFollowerDigest(db, { followerUserId }) {
  const follower = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(followerUserId);
  if (!follower || !follower.email) {
    return { already_sent_today: false, events_included: 0, notification: { skipped: true, reason: 'no_email' } };
  }

  const now = new Date();
  const last = db.prepare(`
    SELECT created_at FROM notifications_outbox
    WHERE recipient_user_id = ? AND event_type = 'follower_digest'
    ORDER BY created_at DESC LIMIT 1
  `).get(follower.id)?.created_at || null;

  // One a day, measured on the clock rather than the calendar, so two cannot
  // be had a minute apart either side of midnight.
  if (last && now.getTime() - new Date(last).getTime() < 20 * 3600 * 1000) {
    return { already_sent_today: true };
  }

  // Everything after the previous digest; for a first digest, the last two weeks.
  const since = last || new Date(now.getTime() - 14 * 86400 * 1000).toISOString();

  const candidates = db.prepare(`
    SELECT e.*, l.name AS list_name, u.name AS owner_name, i.title AS item_title, i.currency AS item_currency
    FROM events e
    JOIN lists l ON l.id = e.list_id
    JOIN users u ON u.id = l.owner_id
    JOIN items i ON i.id = e.entity_id AND i.list_id = e.list_id AND i.status = 'active'
    WHERE e.is_spoiler = 0
      AND e.entity_type = 'item'
      AND e.at > ?
      AND l.archived_at IS NULL
      AND l.owner_id != ?
      AND (
        l.owner_id IN (SELECT target_id FROM follows WHERE follower_id = ? AND target_type = 'user' AND status = 'approved')
        OR l.id IN (SELECT target_id FROM follows WHERE follower_id = ? AND target_type = 'list' AND status = 'approved')
        OR l.owner_id IN (
          SELECT gm2.user_id FROM group_members gm1
          JOIN group_members gm2 ON gm1.group_id = gm2.group_id
          WHERE gm1.user_id = ?
        )
        OR l.owner_id IN (SELECT dependent_id FROM guardian_links WHERE guardian_id = ?)
      )
    ORDER BY e.at DESC
  `).iterate(since, follower.id, follower.id, follower.id, follower.id, follower.id);

  // Access is decided list by list before anything counts toward the limit,
  // so lists the reader cannot open do not crowd out the ones they can.
  const listCache = new Map();
  const recentEvents = [];
  let scanned = 0;
  for (const ev of candidates) {
    if (++scanned > 5000) break;
    if (!listCache.has(ev.list_id)) {
      const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(ev.list_id);
      const ctx = getViewerRole(db, list, follower.id);
      // An owner/co-owner never gets their own list in a digest.
      listCache.set(ev.list_id, Boolean(ctx.canView) && ctx.role !== 'owner');
    }
    if (listCache.get(ev.list_id)) recentEvents.push(ev);
    if (recentEvents.length >= 25) break;
  }

  const lines = recentEvents.map(ev => {
    const details = safeJsonParse(ev.details, {});
    const title = ev.item_title;
    const cur = ev.item_currency || 'USD';
    if (ev.action === 'price_drop') {
      return `• Price drop (${details.drop_percent}% off) on ${ev.owner_name}'s list "${ev.list_name}": ${title} (${Number(details.old_price).toFixed(2)} → ${Number(details.new_price).toFixed(2)} ${cur})`;
    }
    if (ev.action === 'back_in_stock') {
      return `• Back in stock on ${ev.owner_name}'s list "${ev.list_name}": ${title}`;
    }
    return `• New on ${ev.owner_name}'s list "${ev.list_name}": ${title}`;
  });

  if (lines.length === 0) {
    lines.push('• Nothing new on the lists you follow.');
  }

  const sent = sendNotification(db, {
    recipientUserId: follower.id,
    recipientEmail: follower.email,
    eventType: 'follower_digest',
    subject: `Your Hushlist digest (${recentEvents.length} update${recentEvents.length === 1 ? '' : 's'})`,
    body: `Updates for the people you shop for:\n${lines.join('\n')}`
  });

  return {
    already_sent_today: false,
    events_included: recentEvents.length,
    notification: sent
  };
}
