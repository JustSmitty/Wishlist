/**
 * Section 16 & NTF-1..3: Spoiler-Checked Notification Engine
 *
 * HARD INVARIANT:
 * Every notification is checked against one rule: NOTHING sent to a list owner
 * (or co-owner) may reveal whether an item on their own list is claimed while
 * surprise_mode is on.
 */

import { uid } from '../db/schema.mjs';
import { safeJsonParse } from './surprise.mjs';

const TRANSACTIONAL_EVENTS = new Set([
  'guest_verification_code',
  'claimed_item_changed',
  'claimed_item_withdrawn',
  'claim_expiring',
  'did_you_buy_it'
]);

const SPOILER_EVENT_TYPES = new Set([
  'claimed_item_changed',
  'claimed_item_withdrawn',
  'claim_expiring',
  'did_you_buy_it',
  'claimed_item_price_drop',
  'claimed_item_out_of_stock',
  'claim_confirmed'
]);

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
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(recipientUserId);
    if (u) recipientEmail = u.email;
  }
  if (!recipientEmail) return { skipped: true, reason: 'no_email' };

  // CRITICAL SPOILER CHECK (Section 16):
  // Verify recipient is NOT the owner or co-owner of a surprise-mode list for any claim/spoiler notification
  if (listId) {
    const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
    if (list && list.surprise_mode === 1 && !list.revealed_at) {
      const coOwners = safeJsonParse(list.co_owner_ids, []);
      const ownerUser = db.prepare('SELECT email FROM users WHERE id = ?').get(list.owner_id);
      const isRecipientOwner =
        (recipientUserId && (recipientUserId === list.owner_id || coOwners.includes(recipientUserId))) ||
        (ownerUser && ownerUser.email && ownerUser.email.toLowerCase() === recipientEmail.toLowerCase());

      if (isRecipientOwner && SPOILER_EVENT_TYPES.has(eventType)) {
        // Record spoiler block & refuse to send
        return { skipped: true, reason: 'spoiler_protection_blocked_owner_notification' };
      }
    }
  }

  const isTransactional = TRANSACTIONAL_EVENTS.has(eventType);

  // Check NTF-3 preferences for non-transactional messages
  let scheduledFor = new Date().toISOString();
  if (recipientUserId && !isTransactional) {
    const pref = db.prepare(
      'SELECT * FROM notification_preferences WHERE user_id = ? AND event_type = ? AND channel = ?'
    ).get(recipientUserId, eventType, channel);

    if (pref && pref.enabled === 0) {
      return { skipped: true, reason: 'disabled_by_user_preference' };
    }

    // Quiet hours check (9 PM to 8 AM local by default, NTF-3)
    const quietStart = pref ? pref.quiet_hours_start : 21;
    const quietEnd = pref ? pref.quiet_hours_end : 8;
    const now = new Date();
    const hour = now.getHours();
    if (hour >= quietStart || hour < quietEnd) {
      const nextMorning = new Date(now);
      if (hour >= quietStart) {
        nextMorning.setDate(nextMorning.getDate() + 1);
      }
      nextMorning.setHours(quietEnd, 0, 0, 0);
      scheduledFor = nextMorning.toISOString();
    }
  }

  const id = uid('ntf');
  const unsubToken = isTransactional ? null : uid('unsub');
  const nowStr = new Date().toISOString();

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
    scheduledFor,
    nowStr,
    nowStr
  );

  return { id, sent: true, transactional: isTransactional, scheduled_for: scheduledFor, unsubscribe_token: unsubToken };
}

/**
 * NTF-1 & Section 16: Follower Digest Generator
 * Compiles changes to followed lists (new items, removed items, price drops, priority changes)
 * while strictly enforcing the Section 16 Spoiler Rule:
 * "Digest never includes claims on the reader's own lists" and "At most one digest per user per day".
 */
export function generateFollowerDigest(db, { followerUserId }) {
  const follower = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(followerUserId);
  if (!follower || !follower.email) {
    throw new Error('Active user with email is required for follower digest');
  }

  // Enforce at most one digest per user per day (Section 16 rule)
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const existingToday = db.prepare(`
    SELECT * FROM notifications_outbox
    WHERE recipient_user_id = ? AND event_type = 'follower_digest' AND created_at LIKE ?
    LIMIT 1
  `).get(follower.id, `${todayPrefix}%`);

  if (existingToday) {
    return { already_sent_today: true, notification: existingToday };
  }

  // Gather non-spoiler events on followed people's lists (NEVER on the follower's own or co-owned lists!)
  const recentEvents = db.prepare(`
    SELECT e.*, l.name AS list_name, l.owner_id, u.name AS owner_name
    FROM events e
    JOIN lists l ON l.id = e.list_id
    JOIN users u ON u.id = l.owner_id
    WHERE e.is_spoiler = 0
      AND l.owner_id != ?
      AND l.co_owner_ids NOT LIKE ?
      AND (
        l.owner_id IN (SELECT target_id FROM follows WHERE follower_id = ? AND target_type = 'user' AND status = 'approved')
        OR l.id IN (SELECT target_id FROM follows WHERE follower_id = ? AND target_type = 'list' AND status = 'approved')
        OR l.owner_id IN (
          SELECT gm2.user_id FROM group_members gm1
          JOIN group_members gm2 ON gm1.group_id = gm2.group_id
          WHERE gm1.user_id = ?
        )
      )
    ORDER BY e.at DESC
    LIMIT 25
  `).all(follower.id, `%"${follower.id}"%`, follower.id, follower.id, follower.id);

  const lines = recentEvents.map(ev => {
    const details = safeJsonParse(ev.details, {});
    if (ev.action === 'price_drop') {
      return `• Price Drop (${details.drop_percent}% off) on ${ev.owner_name}'s list "${ev.list_name}": ${details.title} ($${details.old_price} -> $${details.new_price})`;
    }
    if (ev.action === 'back_in_stock') {
      return `• Back in Stock on ${ev.owner_name}'s list "${ev.list_name}": ${details.title}`;
    }
    return `• New update on ${ev.owner_name}'s list "${ev.list_name}": ${details.title || ev.action}`;
  });

  if (lines.length === 0) {
    lines.push('• All followed wishlists are up to date — check your upcoming occasion countdowns in Hushlist.');
  }

  const sent = sendNotification(db, {
    recipientUserId: follower.id,
    recipientEmail: follower.email,
    eventType: 'follower_digest',
    subject: `Your Hushlist Daily Digest (${recentEvents.length} wishlist update${recentEvents.length === 1 ? '' : 's'})`,
    body: `Updates for the people you shop for:\n${lines.join('\n')}`
  });

  return {
    already_sent_today: false,
    events_included: recentEvents.length,
    notification: sent
  };
}
