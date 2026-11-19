/**
 * Claim lifecycle.
 *
 *   pending_verification ──code──▶ reserved ──▶ purchased ──▶ given
 *            │                        │             │
 *            └── 30 min ──▶ expired   └──▶ released ◀┘        (owner removes item ▶ withdrawn)
 *
 * Rules enforced here:
 * - An item is never over-claimed: verified active quantity ≤ quantity wanted.
 * - Guests hold nothing until they prove the email address with a 6-digit code;
 *   five wrong codes cancel the claim; unverified claims lapse after 30 minutes.
 *   The per-list cap for people outside the owner's circle is applied when the
 *   code is entered, so only the person who can read the mailbox ever learns
 *   how much that address already holds.
 * - Released, expired and withdrawn are final.
 * - Only the person who made a claim can advance it. Helpers, guardians and
 *   admins can release someone else's claim and nothing more.
 * - Whatever an owner does to a claimed item, the owner's response is the same
 *   as it would be for an unclaimed one.
 */

import { uid, secretToken, sixDigitCode, safeEqual, inTransaction } from '../db/schema.mjs';
import { AppError, badRequest, forbidden, notFound, conflict } from '../errors.mjs';
import { sendNotification } from './notifications.mjs';
import { getViewerRole, ownerCanSeeClaims, safeJsonParse } from './surprise.mjs';
import { cleanText, cleanPrice, cleanInt, cleanDate, canonicalizeUrl } from './capture.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_VERIFY_ATTEMPTS = 5;
const PRIORITIES = ['most_wanted', 'high', 'normal', 'low'];

/**
 * Canonical form of a guest address for the per-list cap, so plus-tags and
 * Gmail dot variants count as one person.
 */
export function normalizeEmailForCap(email) {
  if (!email) return '';
  const cleaned = String(email).trim().toLowerCase();
  const at = cleaned.lastIndexOf('@');
  if (at < 1) return cleaned;
  let local = cleaned.slice(0, at).split('+')[0];
  let domain = cleaned.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** What a claimer may be told about their own claim. Never includes secrets. */
export function publicClaim(c) {
  if (!c) return null;
  return {
    id: c.id,
    item_id: c.item_id,
    list_id: c.list_id,
    status: c.status,
    verified: Boolean(c.verified),
    qty: c.qty,
    show_name_to_givers: Boolean(c.show_name_to_givers),
    expires_at: c.expires_at,
    order_note: c.order_note,
    clicked_out_at: c.clicked_out_at,
    return_prompt_answered: c.return_prompt_answered,
    updated_at: c.updated_at
  };
}

export function purgeExpiredClaims(db, nowIso = new Date().toISOString()) {
  const nowMs = new Date(nowIso).getTime();

  const lapsedGuests = db.prepare(`
    SELECT id FROM claims
    WHERE verified = 0 AND status = 'pending_verification' AND verification_expires_at <= ?
  `).all(nowIso);
  for (const c of lapsedGuests) {
    db.prepare("UPDATE claims SET status = 'expired', verification_code = NULL, updated_at = ? WHERE id = ?").run(nowIso, c.id);
    recordClaimEvent(db, c.id, 'pending_verification', 'expired', 'expiry', null, 'Email not verified within 30 minutes', nowIso);
  }

  const warnHorizonIso = new Date(nowMs + 48 * 3600 * 1000).toISOString();
  const dueForWarning = db.prepare(`
    SELECT c.*, i.title AS item_title FROM claims c
    JOIN items i ON i.id = c.item_id
    WHERE c.status = 'reserved' AND c.verified = 1 AND c.expiry_warned = 0
      AND c.expires_at IS NOT NULL AND c.expires_at > ? AND c.expires_at <= ?
  `).all(nowIso, warnHorizonIso);
  for (const c of dueForWarning) {
    db.prepare('UPDATE claims SET expiry_warned = 1 WHERE id = ?').run(c.id);
    // A hold shorter than three days would get its "48 hours left" warning
    // seconds after it was made. Those are left alone.
    if (new Date(c.expires_at).getTime() - new Date(c.hold_started_at || c.created_at).getTime() < 72 * 3600 * 1000) continue;
    const hoursLeft = Math.max(1, Math.round((new Date(c.expires_at).getTime() - nowMs) / 3600 / 1000));
    sendNotification(db, {
      recipientUserId: c.claimer_user_id,
      recipientEmail: c.guest_email,
      eventType: 'claim_expiring',
      listId: c.list_id,
      subject: `Your hold on "${c.item_title}" ends in ${hoursLeft >= 36 ? 'two days' : `${hoursLeft} hours`}`,
      body: `Mark "${c.item_title}" as bought, or release it so someone else can give it.`
    });
  }

  const expiredReserved = db.prepare(`
    SELECT c.*, i.title AS item_title FROM claims c
    JOIN items i ON i.id = c.item_id
    WHERE c.status = 'reserved' AND c.verified = 1 AND c.expires_at IS NOT NULL AND c.expires_at <= ?
  `).all(nowIso);
  for (const c of expiredReserved) {
    db.prepare("UPDATE claims SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso, c.id);
    recordClaimEvent(db, c.id, 'reserved', 'expired', 'expiry', null, 'Hold ended without a purchase being confirmed', nowIso);
    sendNotification(db, {
      recipientUserId: c.claimer_user_id,
      recipientEmail: c.guest_email,
      eventType: 'claim_expiring',
      listId: c.list_id,
      subject: `Your hold on "${c.item_title}" has ended`,
      body: `Your hold on "${c.item_title}" ran out and the item is available to others again.`
    });
  }
}

function activeQuantity(db, itemId, exceptClaimId = null) {
  return db.prepare(`
    SELECT COALESCE(SUM(qty), 0) AS total
    FROM claims
    WHERE item_id = ? AND verified = 1 AND status IN ('reserved', 'purchased', 'given') AND id IS NOT ?
  `).get(itemId, exceptClaimId).total;
}

function pledgedTotal(db, itemId) {
  return db.prepare(`
    SELECT COALESCE(SUM(pledged_amount), 0) AS total FROM contributions
    WHERE item_id = ? AND status IN ('pledged', 'paid_off_platform')
  `).get(itemId).total;
}

/** A shared gift whose pledges already cover its price. */
function isFullyFunded(db, item) {
  return Boolean(item.allow_group_chip_in && item.price > 0 && pledgedTotal(db, item.id) >= item.price);
}

/**
 * How many units one outside person already holds on a list. A person is an
 * email address: reservations made as a guest and reservations made after
 * signing up with the same address are the same person's.
 */
function heldByOutsider(db, listId, { userId = null, email = null, exceptClaimId = null }) {
  const norm = normalizeEmailForCap(email);
  return db.prepare(`
    SELECT c.id, c.qty, c.claimer_user_id, COALESCE(u.email, c.guest_email) AS email
    FROM claims c LEFT JOIN users u ON u.id = c.claimer_user_id
    WHERE c.list_id = ? AND c.verified = 1 AND c.status IN ('reserved', 'purchased', 'given')
  `).all(listId)
    .filter(c => c.id !== exceptClaimId &&
      ((userId && c.claimer_user_id === userId) || (norm && normalizeEmailForCap(c.email) === norm)))
    .reduce((sum, c) => sum + (c.qty || 1), 0);
}

function money(amount, currency) {
  return `${Number(amount).toFixed(2)} ${currency || 'USD'}`;
}

function logAnalytics(db, name, properties, listId, atIso) {
  db.prepare('INSERT INTO analytics_events (id, event_name, properties, list_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uid('evt'), name, JSON.stringify(properties), listId, atIso);
}

/**
 * Reserve an item. Runs in one IMMEDIATE transaction so the availability
 * check and the insert cannot be separated by another writer.
 *
 * Returns the public claim plus, for guests, `verification_code`. The caller
 * decides whether that code may be shown (demo mode) — it must never be
 * returned to a browser otherwise.
 */
export function createClaim(db, {
  itemId,
  claimerUserId = null,
  guestEmail = null,
  guestName = null,
  qty = 1,
  showNameToGivers = true,
  orderNote = null
}) {
  const requestedQty = Number(qty ?? 1);
  if (!Number.isInteger(requestedQty) || requestedQty < 1 || requestedQty > 99) {
    throw badRequest('Quantity must be a whole number between 1 and 99');
  }
  const isGuest = !claimerUserId;
  const email = isGuest ? String(guestEmail ?? '').trim().toLowerCase() : null;
  if (isGuest && (email.length > 254 || !EMAIL_RE.test(email))) {
    throw badRequest('A valid email address is required to reserve as a guest');
  }

  return inTransaction(db, () => {
    const now = new Date();
    const nowIso = now.toISOString();
    purgeExpiredClaims(db, nowIso);

    const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'active'").get(String(itemId ?? ''));
    if (!item) throw notFound('That item is no longer on the list');

    const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id);
    if (!list || list.archived_at) throw conflict('This list is closed');

    const coOwners = safeJsonParse(list.co_owner_ids, []);
    if (claimerUserId && (claimerUserId === list.owner_id || coOwners.includes(claimerUserId))) {
      throw forbidden('You cannot reserve items on your own list');
    }

    const viewerCtx = getViewerRole(db, list, claimerUserId);
    if (!viewerCtx.canView) throw forbidden('You do not have access to this list');

    // People outside the owner's circle — guests, and signed-in strangers who
    // only have the link — can hold a limited number of items per list.
    // "given" still counts: otherwise a holder could advance each claim and
    // start again until the whole list was taken.
    //
    // For a guest the cap is applied when the code is entered, not here. At
    // this point nobody has shown they can read the mailbox, so an answer
    // that depended on what the address already holds would tell any link
    // holder whether — and roughly how much — that person had reserved.
    const cap = list.guest_claim_cap || 3;
    if (!isGuest && viewerCtx.role === 'guest') {
      const me = db.prepare('SELECT email FROM users WHERE id = ?').get(claimerUserId);
      if (heldByOutsider(db, list.id, { userId: claimerUserId, email: me?.email }) + requestedQty > cap) {
        throw conflict(`You can hold up to ${cap} items on this list unless you are in the owner's circle.`);
      }
    }

    if (isFullyFunded(db, item)) throw conflict('This gift is already fully funded by people chipping in');

    if (!item.always_wanted) {
      const remaining = item.qty_wanted - activeQuantity(db, item.id);
      if (requestedQty > remaining) {
        throw conflict(remaining <= 0
          ? 'Someone just reserved the last one'
          : `Only ${remaining} left to reserve`);
      }
    }

    const claimId = uid('clm');
    const manageToken = secretToken('mng');
    const expiryDays = list.claim_expiry_days || 7;
    const expiresAt = new Date(now.getTime() + expiryDays * 86400 * 1000).toISOString();
    const verified = isGuest ? 0 : 1;
    const status = verified ? 'reserved' : 'pending_verification';
    const verificationCode = isGuest ? sixDigitCode() : null;
    const verificationExpiresAt = isGuest ? new Date(now.getTime() + 30 * 60 * 1000).toISOString() : null;

    db.prepare(`
      INSERT INTO claims (
        id, item_id, list_id, claimer_user_id, guest_email, guest_name,
        verified, verification_code, verification_expires_at, manage_token,
        qty, status, show_name_to_givers, expires_at, order_note, created_at, updated_at, hold_started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claimId, item.id, list.id, claimerUserId,
      email, isGuest ? (cleanText(guestName, 80) || null) : null,
      verified, verificationCode, verificationExpiresAt, manageToken,
      requestedQty, status, showNameToGivers ? 1 : 0, expiresAt,
      cleanText(orderNote, 500) || null, nowIso, nowIso, nowIso
    );

    recordClaimEvent(db, claimId, null, status, 'giver', claimerUserId, 'Claim created', nowIso);
    logAnalytics(db, 'claim_created', { guest_or_account: isGuest ? 'guest' : 'account', quantity: requestedQty }, list.id, nowIso);

    if (isGuest) {
      sendNotification(db, {
        recipientEmail: email,
        eventType: 'guest_verification_code',
        listId: list.id,
        subject: 'Your Hushlist verification code',
        // No list or item text here: this goes to an address nobody has
        // proved they own, so it must not carry words chosen by a stranger.
        body: `Enter ${verificationCode} within 30 minutes to confirm your reservation on Hushlist. If you did not ask for this, ignore this message.`,
        storedBody: 'A verification code was sent. It works for 30 minutes.'
      });
    }

    return {
      ...publicClaim(db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId)),
      verification_required: isGuest,
      verification_expires_at: verificationExpiresAt,
      ...(isGuest ? { verification_code: verificationCode } : {})
    };
  });
}

/**
 * Confirms a guest's 6-digit code. Only a correct code returns anything about
 * the claim; on success the guest receives the manage token that lets this
 * browser update or release the claim later.
 */
export function verifyGuestClaim(db, { claimId, code }) {
  const nowIso = new Date().toISOString();
  purgeExpiredClaims(db, nowIso);

  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(String(claimId ?? ''));
  // One message for "no such claim", "not a guest claim" and "already verified":
  // this endpoint is unauthenticated and must not confirm anything about a claim id.
  if (!claim || claim.claimer_user_id || claim.verified === 1) {
    throw badRequest('That reservation cannot be verified. Start again from the list.');
  }
  if (claim.status !== 'pending_verification' || !claim.verification_code) {
    throw badRequest('The 30-minute window has passed. Reserve the item again.');
  }

  if (!safeEqual(claim.verification_code, String(code ?? '').trim())) {
    const attempts = (claim.verification_attempts || 0) + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      db.prepare(`
        UPDATE claims SET verification_attempts = ?, status = 'expired', verification_code = NULL, updated_at = ?
        WHERE id = ?
      `).run(attempts, nowIso, claim.id);
      recordClaimEvent(db, claim.id, 'pending_verification', 'expired', 'system', null, 'Too many wrong codes', nowIso);
      throw badRequest('Too many wrong codes. The reservation was cancelled.');
    }
    db.prepare('UPDATE claims SET verification_attempts = ?, updated_at = ? WHERE id = ?').run(attempts, nowIso, claim.id);
    const left = MAX_VERIFY_ATTEMPTS - attempts;
    throw badRequest(`That code is not right (${left} attempt${left === 1 ? '' : 's'} left)`);
  }

  let refusal = null;
  const result = inTransaction(db, () => {
    const close = (reason, error) => {
      db.prepare("UPDATE claims SET status = 'released', verification_code = NULL, updated_at = ? WHERE id = ?").run(nowIso, claim.id);
      recordClaimEvent(db, claim.id, 'pending_verification', 'released', 'system', null, reason, nowIso);
      refusal = error;
      return null;
    };

    const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'active'").get(claim.item_id);
    const list = item ? db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id) : null;
    // The list may have been closed, made private or had this item moved
    // since the code was sent. The checks made at the start are made again.
    if (!item || !list || list.archived_at || !getViewerRole(db, list, null).canView) {
      return close('List or item no longer available at verification', notFound('That item is no longer available'));
    }

    if (!item.always_wanted && activeQuantity(db, item.id) + claim.qty > item.qty_wanted) {
      return close('Item was taken before verification', conflict('Someone else reserved this while you were verifying'));
    }
    if (isFullyFunded(db, item)) {
      return close('Item was fully funded before verification', conflict('This gift was fully funded while you were verifying'));
    }

    // The cap, counted in units, for this address on this list. Said only
    // here, to someone who has just proved they can read that mailbox.
    const cap = list.guest_claim_cap || 3;
    if (heldByOutsider(db, list.id, { email: claim.guest_email, exceptClaimId: claim.id }) + claim.qty > cap) {
      return close('Over the per-list limit for guests', conflict(`Guests can hold up to ${cap} items on a list. Sign in to reserve more.`));
    }

    const expiresAt = new Date(Date.now() + (list.claim_expiry_days || 7) * 86400 * 1000).toISOString();
    db.prepare(`
      UPDATE claims SET verified = 1, status = 'reserved', verification_code = NULL, list_id = ?,
             expires_at = ?, hold_started_at = ?, updated_at = ?
      WHERE id = ?
    `).run(list.id, expiresAt, nowIso, nowIso, claim.id);
    recordClaimEvent(db, claim.id, 'pending_verification', 'reserved', 'giver', null, 'Guest email verified', nowIso);
    return db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
  });

  if (refusal) throw refusal;
  return { ...publicClaim(result), manage_token: result.manage_token };
}

const CLAIMER_TRANSITIONS = {
  reserved: ['purchased', 'released'],
  purchased: ['given', 'reserved', 'released'],
  given: ['purchased']
};

/**
 * Changes a claim's state.
 *
 * - The claimer (signed-in owner of the claim, or a guest presenting the
 *   manage token of a guest claim) may follow CLAIMER_TRANSITIONS.
 * - A helper, guardian or admin acting on someone else's claim may only
 *   release it, cannot touch the claimer's note, and is told only that it
 *   was released (never the claimer's note or shopping history).
 * - `asAdmin` is set by the admin route after it has checked the session; it
 *   is re-checked here against the database and requires a reason.
 */
export function transitionClaimState(db, {
  claimId,
  newState,
  actorId = null,
  manageToken = null,
  asAdmin = false,
  reason = null,
  orderNote = undefined
}) {
  // Holds that have run out are closed first, so a lapsed reservation cannot
  // be confirmed just because nobody has loaded the list since.
  purgeExpiredClaims(db);

  return inTransaction(db, () => {
    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(String(claimId ?? ''));
    if (!claim) throw notFound('Reservation not found');

    const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(claim.list_id);

    // An admin must not be able to act on (or learn about) claims on a list
    // they own while it is in surprise mode. Same answer as "no such claim".
    if (asAdmin && list && !ownerCanSeeClaims(list) && getViewerRole(db, list, actorId).role === 'owner') {
      throw notFound('Reservation not found');
    }
    const actor = actorId ? db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(actorId) : null;

    const isClaimer = Boolean(
      (actor && claim.claimer_user_id === actor.id) ||
      // A manage token only ever speaks for a guest claim.
      (!claim.claimer_user_id && manageToken && safeEqual(claim.manage_token, manageToken))
    );

    let actorType = null;
    if (isClaimer) {
      actorType = 'giver';
    } else if (asAdmin) {
      if (!actor || actor.is_admin !== 1) throw forbidden('Admin privileges required');
      if (!reason || !String(reason).trim()) throw badRequest('An audit reason is required');
      actorType = 'admin';
    } else if (actor && list) {
      // The same decision that governs what this person can see on the list,
      // so a helper who was removed or blocked loses this at the same moment.
      const ctx = getViewerRole(db, list, actor.id);
      if (ctx.canReleaseClaims) actorType = ctx.role;
    }
    if (!actorType) throw forbidden('You cannot change this reservation');

    if (actorType === 'giver') {
      if (claim.status === 'pending_verification') {
        throw badRequest('Verify your email first');
      }
      const allowed = CLAIMER_TRANSITIONS[claim.status] || [];
      if (!allowed.includes(newState)) {
        throw conflict(['released', 'expired', 'withdrawn'].includes(claim.status)
          ? 'This reservation is closed. Reserve the item again if it is still available.'
          : `A ${claim.status} reservation cannot be changed to ${cleanText(newState, 20) || 'that'}`);
      }
    } else {
      if (newState !== 'released') throw forbidden('You can only release this reservation');
      if (!['pending_verification', 'reserved', 'purchased'].includes(claim.status)) {
        throw conflict('This reservation is already closed');
      }
    }

    const nowIso = new Date().toISOString();
    const noteToSave = (actorType === 'giver' && orderNote !== undefined)
      ? (cleanText(orderNote, 500) || null)
      : claim.order_note;

    // Going back from "bought" to "reserved" makes a new hold, so it has to
    // pass what a new hold would: the item is still wanted, the list is open,
    // there is room for it, and it gets a full hold period of its own.
    let expiresAt = claim.expires_at;
    let holdStartedAt = claim.hold_started_at;
    let warned = claim.expiry_warned;
    if (actorType === 'giver' && newState === 'reserved') {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(claim.item_id);
      if (!item || item.status !== 'active' || !list || list.archived_at) {
        throw conflict('This item is no longer open on the list. Keep it as bought, or release it.');
      }
      if (!item.always_wanted && activeQuantity(db, item.id, claim.id) + claim.qty > item.qty_wanted) {
        throw conflict('Fewer of these are wanted now. Keep it as bought, or release it.');
      }
      expiresAt = new Date(Date.now() + (list.claim_expiry_days || 7) * 86400 * 1000).toISOString();
      holdStartedAt = nowIso;
      warned = 0;
    }

    db.prepare(`
      UPDATE claims SET status = ?, order_note = ?, verification_code = NULL, expires_at = ?, hold_started_at = ?,
             expiry_warned = ?, updated_at = ?
      WHERE id = ?
    `).run(newState, noteToSave, expiresAt, holdStartedAt, warned, nowIso, claim.id);

    const cleanReason = cleanText(reason, 300) || null;
    recordClaimEvent(db, claim.id, claim.status, newState, actorType, actor?.id || null, cleanReason || `Changed to ${newState}`, nowIso);

    logAnalytics(db, 'claim_state_changed', { from: claim.status, to: newState, actor: actorType }, claim.list_id, nowIso);

    if (actorType !== 'giver') {
      const item = db.prepare('SELECT title FROM items WHERE id = ?').get(claim.item_id);
      sendNotification(db, {
        recipientUserId: claim.claimer_user_id,
        recipientEmail: claim.guest_email,
        eventType: 'claimed_item_changed',
        listId: claim.list_id,
        subject: `Your hold on "${item?.title || 'an item'}" was released`,
        body: `${actorType === 'admin' ? 'An administrator' : 'Someone helping with the list'} released your reservation${cleanReason ? ` (${cleanReason})` : ''}.`
      });
      return { id: claim.id, status: newState };
    }

    return publicClaim(db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id));
  });
}

function requireEditor(db, item, actorId) {
  const list = item ? db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id) : null;
  if (!item || !list) throw notFound('Item not found');
  if (!getViewerRole(db, list, actorId).canEdit) throw forbidden('You cannot change items on this list');
  return list;
}

/**
 * Owner deletes an item or marks it "got it myself".
 * Reserved claims become withdrawn and the giver is told not to buy; purchased
 * claims are kept for the giver's records. The return value is the same
 * whether zero or many claims existed.
 */
export function handleOwnerDeleteOrGotIt(db, { itemId, ownerId, mode = 'deleted' }) {
  return inTransaction(db, () => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(String(itemId ?? ''));
    const list = requireEditor(db, item, ownerId);

    const nowIso = new Date().toISOString();
    const targetStatus = mode === 'got_it' ? 'got_it' : 'deleted';
    const constant = { id: item.id, list_id: item.list_id, status: targetStatus };

    if (item.status === 'deleted' || item.status === 'got_it') return constant;

    db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run(targetStatus, nowIso, item.id);

    const claims = db.prepare(`
      SELECT * FROM claims
      WHERE item_id = ? AND status IN ('pending_verification', 'reserved', 'purchased')
    `).all(item.id);

    for (const c of claims) {
      if (c.status === 'purchased') {
        recordClaimEvent(db, c.id, 'purchased', 'purchased', 'system', null, `Owner removed item (${targetStatus}); kept for the giver`, nowIso);
        sendNotification(db, {
          recipientUserId: c.claimer_user_id,
          recipientEmail: c.guest_email,
          eventType: 'claimed_item_withdrawn',
          listId: list.id,
          subject: `Heads up about "${item.title}"`,
          body: `"${item.title}" was taken off the list. If you already bought it you can still give it or return it — your record is kept under your gifts.`
        });
      } else {
        db.prepare("UPDATE claims SET status = 'withdrawn', verification_code = NULL, updated_at = ? WHERE id = ?").run(nowIso, c.id);
        recordClaimEvent(db, c.id, c.status, 'withdrawn', 'system', null, `Owner marked item ${targetStatus}`, nowIso);
        // An address nobody has confirmed gets no mail about the list.
        if (c.status === 'pending_verification') continue;
        sendNotification(db, {
          recipientUserId: c.claimer_user_id,
          recipientEmail: c.guest_email,
          eventType: 'claimed_item_withdrawn',
          listId: list.id,
          subject: `"${item.title}" is no longer needed`,
          body: `"${item.title}" was taken off the list, so there is no need to buy it. Your reservation has been cancelled.`
        });
      }
    }

    const pledges = db.prepare("SELECT * FROM contributions WHERE item_id = ? AND status = 'pledged'").all(item.id);
    for (const p of pledges) {
      db.prepare("UPDATE contributions SET status = 'withdrawn' WHERE id = ?").run(p.id);
      sendNotification(db, {
        recipientUserId: p.contributor_user_id,
        recipientEmail: p.guest_email,
        eventType: 'claimed_item_withdrawn',
        listId: list.id,
        subject: `"${item.title}" is no longer needed`,
        body: `"${item.title}" was taken off the list, so your pledge toward it was cancelled.`
      });
    }

    return constant;
  });
}

/**
 * Owner edits an item. Claims are kept; givers are told what changed. If the
 * quantity drops below what is claimed, the newest unpurchased holds are
 * released first and purchased ones are never touched.
 */
export function handleOwnerEditItem(db, { itemId, ownerId, updates }) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw badRequest('Nothing to update');

  return inTransaction(db, () => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(String(itemId ?? ''));
    const list = requireEditor(db, item, ownerId);
    if (item.status !== 'active' && item.status !== 'received') throw notFound('Item not found');

    const has = (key) => updates[key] !== undefined;
    const nowIso = new Date().toISOString();

    const newTitle = has('title') ? cleanText(updates.title, 300) : item.title;
    if (!newTitle) throw badRequest('Give the item a title');

    let newPrice = item.price;
    if (has('price')) {
      const blank = updates.price === null || updates.price === '';
      newPrice = blank ? null : cleanPrice(updates.price);
      if (!blank && newPrice === null) throw badRequest('Enter a valid price');
    }

    let newUrl = item.canonical_url;
    if (has('url')) newUrl = updates.url ? canonicalizeUrl(updates.url) : null;

    const newVariant = has('variant') ? (cleanText(updates.variant, 200) || null) : item.variant;
    const newNotes = has('notes') ? (cleanText(updates.notes, 2000) || null) : item.notes;
    const newStore = has('store') ? (cleanText(updates.store, 120) || item.store) : item.store;
    const newPriority = has('priority') && PRIORITIES.includes(updates.priority) ? updates.priority : item.priority;
    const newQtyWanted = has('qty_wanted') ? cleanInt(updates.qty_wanted, 1, 999, item.qty_wanted) : item.qty_wanted;
    const flag = (key, current) => (has(key) ? (updates[key] ? 1 : 0) : current);
    const newAnySimilar = flag('any_similar', item.any_similar);
    const newAlwaysWanted = flag('always_wanted', item.always_wanted);
    const newAllowChipIn = flag('allow_group_chip_in', item.allow_group_chip_in);
    const newGivingInstructions = has('giving_instructions')
      ? (cleanText(updates.giving_instructions, 500) || null)
      : item.giving_instructions;

    db.prepare(`
      UPDATE items
      SET title = ?, canonical_url = ?, store = ?, variant = ?, notes = ?, price = ?, priority = ?, qty_wanted = ?,
          any_similar = ?, always_wanted = ?, allow_group_chip_in = ?, giving_instructions = ?, updated_at = ?
      WHERE id = ?
    `).run(
      newTitle, newUrl, newStore, newVariant, newNotes, newPrice, newPriority, newQtyWanted,
      newAnySimilar, newAlwaysWanted, newAllowChipIn, newGivingInstructions, nowIso, item.id
    );

    if (newPrice !== item.price && newPrice !== null) {
      const hasHistory = db.prepare('SELECT 1 FROM price_snapshots WHERE item_id = ? LIMIT 1').get(item.id);
      if (!hasHistory && item.price !== null) {
        db.prepare('INSERT INTO price_snapshots (id, item_id, price, in_stock, checked_at) VALUES (?, ?, ?, ?, ?)')
          .run(uid('ps'), item.id, item.price, item.in_stock, item.created_at);
      }
      db.prepare('INSERT INTO price_snapshots (id, item_id, price, in_stock, checked_at) VALUES (?, ?, ?, ?, ?)')
        .run(uid('ps'), item.id, newPrice, item.in_stock, nowIso);
    }

    // Anyone holding or funding this item is told when what they are buying
    // changes: the name, the link, the price, the size or the notes.
    const diffLines = [];
    if (item.title !== newTitle) diffLines.push(`Name: "${item.title}" → "${newTitle}"`);
    if ((item.canonical_url || '') !== (newUrl || '')) diffLines.push(newUrl ? `Link changed to: ${newUrl}` : 'The link was removed');
    if (item.price !== newPrice) {
      diffLines.push(`Price: ${item.price === null ? 'none' : money(item.price, item.currency)} → ${newPrice === null ? 'none' : money(newPrice, item.currency)}`);
    }
    if ((item.variant || '') !== (newVariant || '')) diffLines.push(`Size / colour: "${item.variant || 'none'}" → "${newVariant || 'none'}"`);
    if ((item.notes || '') !== (newNotes || '')) diffLines.push(`Notes: "${item.notes || 'none'}" → "${newNotes || 'none'}"`);

    const pledges = db.prepare("SELECT * FROM contributions WHERE item_id = ? AND status = 'pledged'").all(item.id);
    const chipInEnded = item.allow_group_chip_in === 1 && (newAllowChipIn === 0 || !(newPrice > 0));
    if (chipInEnded) {
      // Pledges toward a gift that can no longer be funded are cancelled, and
      // the people who made them are told.
      for (const p of pledges) {
        db.prepare("UPDATE contributions SET status = 'withdrawn' WHERE id = ?").run(p.id);
        sendNotification(db, {
          recipientUserId: p.contributor_user_id,
          recipientEmail: p.guest_email,
          eventType: 'claimed_item_withdrawn',
          listId: list.id,
          subject: `Chipping in for "${newTitle}" was switched off`,
          body: `"${newTitle}" is no longer set up as a shared gift, so your pledge of ${money(p.pledged_amount, p.currency)} was cancelled.`
        });
      }
    }

    if (diffLines.length > 0) {
      const holders = db.prepare(`
        SELECT claimer_user_id AS user_id, guest_email FROM claims
        WHERE item_id = ? AND status IN ('reserved', 'purchased') AND verified = 1
      `).all(item.id);
      const funders = chipInEnded ? [] : pledges.map(p => ({ user_id: p.contributor_user_id, guest_email: p.guest_email }));
      const seen = new Set();
      for (const r of [...holders, ...funders]) {
        const key = r.user_id || r.guest_email;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        sendNotification(db, {
          recipientUserId: r.user_id,
          recipientEmail: r.guest_email,
          eventType: 'claimed_item_changed',
          listId: list.id,
          subject: `Details changed on "${newTitle}"`,
          body: `A gift you are giving was updated:\n${diffLines.join('\n')}`
        });
      }
    }

    const limitTightened = newQtyWanted < item.qty_wanted || (item.always_wanted === 1 && newAlwaysWanted === 0);
    if (limitTightened && !newAlwaysWanted) {
      const allActive = db.prepare(`
        SELECT * FROM claims
        WHERE item_id = ? AND status IN ('reserved', 'purchased', 'given') AND verified = 1
        ORDER BY CASE WHEN status = 'reserved' THEN 0 ELSE 1 END ASC, created_at DESC
      `).all(item.id);
      let totalClaimed = allActive.reduce((s, c) => s + c.qty, 0);
      for (const c of allActive) {
        if (totalClaimed <= newQtyWanted) break;
        if (c.status !== 'reserved') continue;
        db.prepare("UPDATE claims SET status = 'released', updated_at = ? WHERE id = ?").run(nowIso, c.id);
        recordClaimEvent(db, c.id, 'reserved', 'released', 'system', null, 'Quantity wanted was lowered', nowIso);
        totalClaimed -= c.qty;
        sendNotification(db, {
          recipientUserId: c.claimer_user_id,
          recipientEmail: c.guest_email,
          eventType: 'claimed_item_changed',
          listId: list.id,
          subject: `Fewer wanted: "${newTitle}"`,
          body: `Fewer of "${newTitle}" are wanted now, so your unpurchased reservation was released.`
        });
      }
    }

    return db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
  });
}

/**
 * Owner marks an item as received. Gifts recorded as bought become "given".
 * A hold that was never marked bought is not a gift: it is cancelled, and its
 * holder is told there is no need to buy. The reply is the same whatever
 * claims existed.
 */
export function markItemReceived(db, { itemId, actorId, outsideApp = false }) {
  // Holds that have already run out are closed first, so one cannot be
  // turned into a recorded gift.
  purgeExpiredClaims(db);

  return inTransaction(db, () => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(String(itemId ?? ''));
    const list = requireEditor(db, item, actorId);
    const constant = { received: true, item_id: item.id };
    if (item.status !== 'active') return constant;

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE items SET status = 'received', received_at = ?, received_outside_app = ?, updated_at = ? WHERE id = ?
    `).run(nowIso, outsideApp ? 1 : 0, nowIso, item.id);

    const matching = db.prepare("SELECT * FROM claims WHERE item_id = ? AND status IN ('pending_verification', 'reserved', 'purchased')").all(item.id);
    for (const c of matching) {
      if (c.status !== 'purchased') {
        db.prepare("UPDATE claims SET status = 'withdrawn', verification_code = NULL, updated_at = ? WHERE id = ?").run(nowIso, c.id);
        recordClaimEvent(db, c.id, c.status, 'withdrawn', 'system', null, 'Item was marked received', nowIso);
        if (c.status === 'reserved') {
          sendNotification(db, {
            recipientUserId: c.claimer_user_id,
            recipientEmail: c.guest_email,
            eventType: 'claimed_item_withdrawn',
            listId: list.id,
            subject: `"${item.title}" is no longer needed`,
            body: `"${item.title}" was marked as received, so there is no need to buy it. Your reservation has been cancelled. If you did buy it, it is yours to give or return.`
          });
        }
        continue;
      }
      db.prepare("UPDATE claims SET status = 'given', updated_at = ? WHERE id = ?").run(nowIso, c.id);
      recordClaimEvent(db, c.id, c.status, 'given', 'system', null, 'Item was marked received', nowIso);
      sendNotification(db, {
        recipientUserId: c.claimer_user_id,
        recipientEmail: c.guest_email,
        eventType: 'claim_confirmed',
        listId: list.id,
        subject: `"${item.title}" arrived`,
        body: `"${item.title}" was marked as received.`
      });
    }

    // Pledges stay on record (the money may already have changed hands) but
    // can no longer be withdrawn; the people who made them are told.
    const pledges = db.prepare("SELECT * FROM contributions WHERE item_id = ? AND status = 'pledged'").all(item.id);
    for (const p of pledges) {
      sendNotification(db, {
        recipientUserId: p.contributor_user_id,
        recipientEmail: p.guest_email,
        eventType: 'claim_confirmed',
        listId: list.id,
        subject: `"${item.title}" arrived`,
        body: `"${item.title}" was marked as received. If you have not yet settled your share of ${money(p.pledged_amount, p.currency)}, arrange it with whoever bought it.`
      });
    }
    return constant;
  });
}

/**
 * Closes a list: open holds are released and open pledges cancelled, purchases
 * are kept. Each person gets one message naming everything of theirs that was
 * affected; addresses that never confirmed a code get none.
 */
export function archiveList(db, list, { reason = 'the list was archived' } = {}) {
  return inTransaction(db, () => {
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE lists SET archived_at = COALESCE(archived_at, ?) WHERE id = ?').run(nowIso, list.id);

    const perPerson = new Map();
    const note = (userId, email, line) => {
      const key = userId || (email ? `mail:${email.toLowerCase()}` : null);
      if (!key) return;
      if (!perPerson.has(key)) perPerson.set(key, { userId, email, lines: [] });
      perPerson.get(key).lines.push(line);
    };

    const open = db.prepare(`
      SELECT c.*, i.title AS item_title FROM claims c
      JOIN items i ON i.id = c.item_id
      WHERE c.list_id = ? AND c.status IN ('pending_verification', 'reserved')
    `).all(list.id);
    for (const c of open) {
      db.prepare("UPDATE claims SET status = 'released', verification_code = NULL, updated_at = ? WHERE id = ?").run(nowIso, c.id);
      recordClaimEvent(db, c.id, c.status, 'released', 'system', null, `Released because ${reason}`, nowIso);
      if (c.status === 'reserved') note(c.claimer_user_id, c.guest_email, `• Your hold on "${c.item_title}" was released.`);
    }

    const pledges = db.prepare(`
      SELECT c.*, i.title AS item_title FROM contributions c
      JOIN items i ON i.id = c.item_id
      WHERE c.list_id = ? AND c.status = 'pledged'
    `).all(list.id);
    for (const p of pledges) {
      db.prepare("UPDATE contributions SET status = 'withdrawn' WHERE id = ?").run(p.id);
      note(p.contributor_user_id, p.guest_email, `• Your pledge of ${money(p.pledged_amount, p.currency)} toward "${p.item_title}" was cancelled.`);
    }

    for (const person of perPerson.values()) {
      sendNotification(db, {
        recipientUserId: person.userId,
        recipientEmail: person.email,
        eventType: 'claimed_item_withdrawn',
        listId: list.id,
        subject: `"${list.name}" was closed`,
        body: `"${list.name}" was closed because ${reason}. Anything you had already marked as bought is still in your gifts.\n${person.lines.join('\n')}`
      });
    }
  });
}

/**
 * Re-opens an archived list for a new occasion. Archiving already released
 * the open holds; gifts that were bought stay recorded and stay taken.
 *
 * The old date never carries over. A re-opened list takes the new date, or
 * none at all — and a surprise list with no date cannot be opened. Whatever
 * opening date the list had promised before is kept as a floor.
 */
export function reuseList(db, list, { eventDate = null } = {}) {
  if (!list.archived_at) throw conflict('Archive the list first');
  const promised = [list.sealed_until, cleanDate(list.event_date) ? addDays(list.event_date, 7) : null].filter(Boolean).sort().pop() || null;
  const sealed = list.surprise_mode === 1 && !list.revealed_at;
  db.prepare('UPDATE lists SET archived_at = NULL, event_date = ?, sealed_until = ? WHERE id = ?')
    .run(eventDate || null, sealed ? promised : list.sealed_until, list.id);
}

function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86400 * 1000).toISOString().slice(0, 10);
}

/**
 * Pledge toward a shared gift. Signed-in givers only: a pledge counts toward
 * "fully funded", so an unverifiable guest pledge could mark an item as taken.
 */
export function addContribution(db, {
  itemId,
  contributorUserId,
  pledgedAmount,
  showNameToGivers = true,
  note = null
}) {
  if (!contributorUserId) throw new AppError('Sign in to chip in', 401);
  const amount = cleanPrice(pledgedAmount, 100_000);
  if (amount === null || amount <= 0) throw badRequest('Enter an amount greater than zero');

  return inTransaction(db, () => {
    const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'active'").get(String(itemId ?? ''));
    if (!item) throw notFound('That item is no longer on the list');
    if (!item.allow_group_chip_in) throw badRequest('Chipping in is not turned on for this item');

    const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id);
    if (!list || list.archived_at) throw conflict('This list is closed');

    const coOwners = safeJsonParse(list.co_owner_ids, []);
    if (contributorUserId === list.owner_id || coOwners.includes(contributorUserId)) {
      throw forbidden('You cannot chip in on your own list');
    }
    const ctx = getViewerRole(db, list, contributorUserId);
    if (!ctx.canView) throw forbidden('You do not have access to this list');
    // A pledge counts toward "fully funded", which takes the gift away from
    // everyone else. That is for people the owner has a connection with, not
    // for anyone who happens to hold the link.
    if (ctx.role === 'guest') {
      throw forbidden("Chipping in is for people in the owner's circle or approved followers. You can still reserve the gift.");
    }
    // Without a price there is no goal, so a pledge could never be bounded.
    if (!(item.price > 0)) throw badRequest('This item needs a price before people can chip in');
    // One person buying it outright and others funding it are alternatives.
    if (!item.always_wanted && activeQuantity(db, item.id) >= item.qty_wanted) {
      throw conflict('This gift has already been reserved');
    }
    {
      const currentPledged = db.prepare(`
        SELECT COALESCE(SUM(pledged_amount), 0) AS total
        FROM contributions
        WHERE item_id = ? AND status IN ('pledged', 'paid_off_platform')
      `).get(item.id).total;
      const remaining = Math.max(0, Math.round((item.price - currentPledged) * 100) / 100);
      if (remaining <= 0) throw conflict('This gift is already fully funded');
      if (amount > remaining) throw conflict(`Only ${money(remaining, item.currency)} is still needed`);
    }

    const id = uid('cnt');
    db.prepare(`
      INSERT INTO contributions (
        id, item_id, list_id, contributor_user_id, pledged_amount, currency, status, show_name_to_givers, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pledged', ?, ?, ?)
    `).run(
      id, item.id, item.list_id, contributorUserId, amount, item.currency || 'USD',
      showNameToGivers ? 1 : 0, cleanText(note, 300) || null, new Date().toISOString()
    );
    return publicContribution(db.prepare('SELECT * FROM contributions WHERE id = ?').get(id));
  });
}

export function withdrawContribution(db, { contributionId, actorId }) {
  const row = db.prepare('SELECT * FROM contributions WHERE id = ?').get(String(contributionId ?? ''));
  if (!row || row.contributor_user_id !== actorId) throw notFound('Pledge not found');
  if (row.status !== 'pledged') throw conflict('This pledge can no longer be withdrawn');
  const item = db.prepare('SELECT status FROM items WHERE id = ?').get(row.item_id);
  if (item?.status === 'received') throw conflict('This gift has already arrived, so the pledge stays on record');
  db.prepare("UPDATE contributions SET status = 'withdrawn' WHERE id = ?").run(row.id);
  return { id: row.id, status: 'withdrawn' };
}

function publicContribution(c) {
  return { id: c.id, item_id: c.item_id, pledged_amount: c.pledged_amount, currency: c.currency, status: c.status, note: c.note };
}

export function recordClaimEvent(db, claimId, fromState, toState, actor, actorId, reason, atIso = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO claim_events (id, claim_id, from_state, to_state, actor, actor_id, reason, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uid('ce'), claimId, fromState, toState, actor, actorId, reason, atIso);
}
