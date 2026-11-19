/**
 * Notification outbox.
 *
 * Invariant: nothing addressed to the owner or a co-owner of an unrevealed
 * surprise-mode list may reveal whether an item on that list is claimed.
 *
 * Delivery: this build has no email provider. Rows are written to
 * notifications_outbox and handed to an optional transport. In demo mode the
 * outbox is shown in the app; otherwise the default transport prints to the
 * server log. Wire a real provider in with setMailTransport().
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

/** fn({ to, subject, body, eventType }) — called once per message that is due now. */
export function setMailTransport(fn) {
  mailTransport = typeof fn === 'function' ? fn : null;
}

export function consoleMailTransport({ to, subject, body }) {
  console.log(`[mail:console] to=${to}\n  subject: ${subject}\n  ${String(body).replace(/\n/g, '\n  ')}`);
}

export function sendNotification(db, {
  recipientUserId = null,
  recipientEmail,
  eventType,
  subject,
  body,
  listId = null,
  channel = 'email'
}) {
  if (!recipientEmail && recipientUserId) {
    const u = db.prepare("SELECT email FROM users WHERE id = ? AND status = 'active'").get(recipientUserId);
    if (u) recipientEmail = u.email;
  }
  if (!recipientEmail) return { skipped: true, reason: 'no_email' };

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

    // Quiet hours are evaluated in the recipient's time zone, not the server's.
    const quietStart = pref ? pref.quiet_hours_start : 21;
    const quietEnd = pref ? pref.quiet_hours_end : 8;
    const hour = hourInZone(now, pref?.time_zone);
    const inQuietHours = quietStart > quietEnd
      ? (hour >= quietStart || hour < quietEnd)
      : (hour >= quietStart && hour < quietEnd);
    if (inQuietHours) {
      const hoursUntilEnd = (quietEnd - hour + 24) % 24 || 24;
      scheduledFor = new Date(now.getTime() + hoursUntilEnd * 3600 * 1000);
      scheduledFor.setUTCMinutes(0, 0, 0);
    }
  }

  const id = uid('ntf');
  const unsubToken = isTransactional ? null : uid('unsub');
  const nowIso = now.toISOString();
  const dueNow = scheduledFor.getTime() <= now.getTime();

  db.prepare(`
    INSERT INTO notifications_outbox (
      id, recipient_user_id, recipient_email, event_type, subject, body,
      channel, transactional, unsubscribe_token, scheduled_for, sent_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    recipientUserId,
    recipientEmail,
    eventType,
    subject,
    body,
    channel,
    isTransactional ? 1 : 0,
    unsubToken,
    scheduledFor.toISOString(),
    dueNow ? nowIso : null,
    nowIso
  );

  if (dueNow && mailTransport) {
    try {
      mailTransport({ to: recipientEmail, subject, body, eventType });
    } catch (err) {
      console.error('[mail] transport failed:', err.message);
    }
  }

  return { id, sent: dueNow, transactional: isTransactional, scheduled_for: scheduledFor.toISOString() };
}

function hourInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hourCycle: 'h23', timeZone: timeZone || undefined
    }).formatToParts(date);
    return Number(parts.find(p => p.type === 'hour').value);
  } catch {
    return date.getHours();
  }
}

/**
 * Follower digest: recent changes on lists the reader follows. At most one per
 * UTC day. Never includes the reader's own lists, and never includes a list
 * the reader could not open right now (private, blocked, share removed).
 */
export function generateFollowerDigest(db, { followerUserId }) {
  const follower = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(followerUserId);
  if (!follower || !follower.email) {
    return { already_sent_today: false, events_included: 0, notification: { skipped: true, reason: 'no_email' } };
  }

  const todayPrefix = new Date().toISOString().slice(0, 10);
  const existingToday = db.prepare(`
    SELECT id FROM notifications_outbox
    WHERE recipient_user_id = ? AND event_type = 'follower_digest' AND created_at LIKE ?
    LIMIT 1
  `).get(follower.id, `${todayPrefix}%`);

  if (existingToday) {
    return { already_sent_today: true };
  }

  const candidates = db.prepare(`
    SELECT e.*, l.name AS list_name, u.name AS owner_name
    FROM events e
    JOIN lists l ON l.id = e.list_id
    JOIN users u ON u.id = l.owner_id
    WHERE e.is_spoiler = 0
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
    LIMIT 200
  `).all(follower.id, follower.id, follower.id, follower.id, follower.id);

  const listCache = new Map();
  const recentEvents = [];
  for (const ev of candidates) {
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
    if (ev.action === 'price_drop') {
      return `• Price drop (${details.drop_percent}% off) on ${ev.owner_name}'s list "${ev.list_name}": ${details.title} ($${details.old_price} → $${details.new_price})`;
    }
    if (ev.action === 'back_in_stock') {
      return `• Back in stock on ${ev.owner_name}'s list "${ev.list_name}": ${details.title}`;
    }
    return `• New on ${ev.owner_name}'s list "${ev.list_name}": ${details.title || ev.action}`;
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
