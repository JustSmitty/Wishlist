/**
 * Section 6 (GVR-1..8, EVT-1..2) & Section 14: Claim Lifecycle, Concurrency & Edge Cases Engine
 *
 * Implements:
 * - GVR-1: Reserve with or without an account; email required for guests; magic-link token to manage claim.
 * - GVR-2: Claim states: reserved -> purchased -> given, or released / expired / withdrawn; claim expiry.
 * - GVR-3: "Did you buy it?" prompt after click-out to retailer.
 * - GVR-4: Partial quantities and group contributions ("chip in") toward one item.
 * - GVR-6: Guest claim controls: holds only after 6-digit email verification; max 3 open guest claims per guest per list; unverified claims lapse after 30 minutes.
 * - GVR-7: Claimer chooses whether other givers see their name.
 * - GVR-8: Simultaneous claims on the last unit resolve in an IMMEDIATE SQLite transaction to exactly 1 winner; never over-claimed.
 * - Section 14 Edge Cases:
 *   1. Owner deletes reserved item -> claim moves to 'withdrawn'; claimer notified "no longer wanted, no need to buy"; owner sees ordinary delete.
 *   2. Owner deletes purchased item -> item hidden; claim kept as 'purchased' for claimer's records; claimer notified "already bought? keep it as a gift or return it"; owner sees ordinary delete.
 *   3. Owner marks "Got it" -> treated as delete with reason "got_it"; claimers notified as above; owner sees ordinary "got it" confirmation.
 *   4. Owner edits size, color or notes after a claim -> claim kept; claimer gets old & new values side by side; owner sees ordinary edit.
 *   5. Owner lowers quantity below claimed units -> newest unpurchased claims released first; purchased claims kept; affected claimers notified; owner sees ordinary edit.
 *   6. Item sells out / price drops -> claim kept; claimer notified; owner sees nothing regarding claims.
 *   7. List archived with open claims -> reserved claims released; purchased claims kept in history; affected claimers notified.
 *   8. Gift bought outside the app arrives (EVT-1) -> owner marks received; matching item leaves active list; matching claimers notified.
 *   9. Guest never verifies email -> claim lapses after 30 minutes.
 *  10. Giver deletes account -> claims anonymized, state kept so purchase state stays accurate.
 */

import { uid } from '../db/schema.mjs';
import { sendNotification } from './notifications.mjs';
import { getViewerRole, safeJsonParse } from './surprise.mjs';

/**
 * ADV-3.2: Canonicalizes guest email addresses for per-list claim cap counting
 * so Gmail +tags and dot variations (e.g. p.r.a.n.k+1@gmail.com) cannot bypass the 3-claim cap.
 */
export function normalizeEmailForCap(email) {
  if (!email) return '';
  const cleaned = String(email).trim().toLowerCase();
  const [local, domain] = cleaned.split('@');
  if (!domain) return cleaned;
  let baseLocal = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    baseLocal = baseLocal.replace(/\./g, '');
  }
  return `${baseLocal}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`;
}

export function purgeExpiredClaims(db, nowIso = new Date().toISOString()) {
  const nowMs = new Date(nowIso).getTime();

  // 1. Lapse unverified guest claims older than 30 minutes (GVR-6, Section 14)
  const lapsedGuests = db.prepare(`
    SELECT * FROM claims
    WHERE verified = 0 AND status = 'pending_verification' AND verification_expires_at <= ?
  `).all(nowIso);

  for (const c of lapsedGuests) {
    db.prepare("UPDATE claims SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso, c.id);
    recordClaimEvent(db, c.id, 'pending_verification', 'expired', 'expiry', null, 'Guest did not verify email within 30 minutes', nowIso);
  }

  // 2. Send 48-hour advance expiry warning for unconfirmed 'reserved' claims (GVR-2 & GAP-5.4)
  const warnHorizonIso = new Date(nowMs + 48 * 3600 * 1000).toISOString();
  const dueForWarning = db.prepare(`
    SELECT c.*, i.title AS item_title FROM claims c
    JOIN items i ON i.id = c.item_id
    WHERE c.status = 'reserved' AND c.verified = 1 AND c.expiry_warned = 0
      AND c.expires_at IS NOT NULL AND c.expires_at > ? AND c.expires_at <= ?
  `).all(nowIso, warnHorizonIso);

  for (const c of dueForWarning) {
    db.prepare('UPDATE claims SET expiry_warned = 1, updated_at = ? WHERE id = ?').run(nowIso, c.id);
    sendNotification(db, {
      recipientUserId: c.claimer_user_id,
      recipientEmail: c.guest_email,
      eventType: 'claim_expiring',
      listId: c.list_id,
      subject: `Reminder: Your reservation for "${c.item_title}" expires in 48 hours`,
      body: `Please confirm whether you purchased "${c.item_title}" or release the reservation so another gift-giver can get it.`
    });
  }

  // 3. Auto-release unconfirmed 'reserved' claims past expires_at (GVR-2)
  const expiredReserved = db.prepare(`
    SELECT c.*, i.title AS item_title FROM claims c
    JOIN items i ON i.id = c.item_id
    WHERE c.status = 'reserved' AND c.verified = 1 AND c.expires_at IS NOT NULL AND c.expires_at <= ?
  `).all(nowIso);

  for (const c of expiredReserved) {
    db.prepare("UPDATE claims SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso, c.id);
    recordClaimEvent(db, c.id, 'reserved', 'expired', 'expiry', null, 'Reservation expired without purchase confirmation', nowIso);
    sendNotification(db, {
      recipientUserId: c.claimer_user_id,
      recipientEmail: c.guest_email,
      eventType: 'claim_expiring',
      listId: c.list_id,
      subject: `Reservation expired: ${c.item_title}`,
      body: `Your reservation for "${c.item_title}" expired and was auto-released so others can gift it.`
    });
  }
}

/**
 * Creates a reservation atomically (GVR-1, GVR-6, GVR-8).
 * Uses `BEGIN IMMEDIATE` transaction so simultaneous claims on the last unit serialize and resolve to 1 winner.
 */
export function createClaim(db, {
  itemId,
  claimerUserId = null,
  guestEmail = null,
  guestName = null,
  qty = 1,
  showNameToGivers = true,
  orderNote = null,
  autoVerifyGuest = false // Used only if verification code is supplied inline
}) {
  const requestedQty = Math.max(1, Number(qty) || 1);

  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    purgeExpiredClaims(db, nowIso);

    const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'active'").get(itemId);
    if (!item) {
      throw new Error('Item is no longer available for claiming');
    }

    const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id);
    if (!list || list.archived_at) {
      throw new Error('List is archived or unavailable');
    }

    // Prevent list owner from claiming on their own list (owners use "Got it" instead)
    const coOwners = safeJsonParse(list.co_owner_ids, []);
    if (claimerUserId && (claimerUserId === list.owner_id || coOwners.includes(claimerUserId))) {
      throw new Error('List owners cannot reserve items on their own list');
    }

    // ADV-2.5: Enforce row-level list visibility check before permitting a claim
    const viewerCtx = getViewerRole(db, list, claimerUserId);
    if (!viewerCtx.canView) {
      throw new Error('Unauthorized to view or reserve items on this private list');
    }

    const isGuest = !claimerUserId;
    if (isGuest && (!guestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail))) {
      throw new Error('A valid email address is required for guest reservations');
    }

    // GVR-6 & ADV-3.2: Max 3 open guest claims per normalized guest email per list
    if (isGuest) {
      const cap = list.guest_claim_cap || 3;
      const normTarget = normalizeEmailForCap(guestEmail);
      const activeGuestClaims = db.prepare(`
        SELECT guest_email, qty
        FROM claims
        WHERE list_id = ? AND guest_email IS NOT NULL
          AND status IN ('pending_verification', 'reserved', 'purchased')
      `).all(list.id);

      const openGuestCount = activeGuestClaims
        .filter(c => normalizeEmailForCap(c.guest_email) === normTarget)
        .reduce((sum, c) => sum + (c.qty || 1), 0);

      if (openGuestCount + requestedQty > cap) {
        throw new Error(`Guest claim limit reached: maximum ${cap} open reservations per list for guest email ${guestEmail}`);
      }
    }

    // GVR-8 Concurrency Check: Check remaining quantity against verified active claims
    if (!item.always_wanted) {
      const activeClaimed = db.prepare(`
        SELECT COALESCE(SUM(qty), 0) AS total
        FROM claims
        WHERE item_id = ? AND verified = 1 AND status IN ('reserved', 'purchased', 'given')
      `).get(item.id).total;

      const remaining = item.qty_wanted - activeClaimed;
      if (requestedQty > remaining) {
        // Record analytics event for over_claim_detected attempt prevented
        db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
          uid('evt'),
          'over_claim_detected',
          JSON.stringify({ prevented: true, requested: requestedQty, remaining }),
          nowIso
        );
        throw new Error(
          remaining <= 0
            ? 'Someone just claimed the last available unit of this item!'
            : `Only ${remaining} unit(s) remaining for this item`
        );
      }
    }

    const claimId = uid('clm');
    const manageToken = uid('mng');
    const expiryDays = list.claim_expiry_days || 7;
    const expiresAt = new Date(now.getTime() + expiryDays * 86400 * 1000).toISOString();

    const verified = (!isGuest || autoVerifyGuest) ? 1 : 0;
    const status = verified ? 'reserved' : 'pending_verification';
    const verificationCode = isGuest && !autoVerifyGuest
      ? String(Math.floor(100000 + Math.random() * 900000))
      : null;
    const verificationExpiresAt = isGuest && !autoVerifyGuest
      ? new Date(now.getTime() + 30 * 60 * 1000).toISOString() // 30 minutes per GVR-6
      : null;

    db.prepare(`
      INSERT INTO claims (
        id, item_id, list_id, claimer_user_id, guest_email, guest_name,
        verified, verification_code, verification_expires_at, manage_token,
        qty, status, show_name_to_givers, expires_at, order_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claimId,
      item.id,
      list.id,
      claimerUserId,
      guestEmail ? guestEmail.trim().toLowerCase() : null,
      guestName ? guestName.trim() : null,
      verified,
      verificationCode,
      verificationExpiresAt,
      manageToken,
      requestedQty,
      status,
      showNameToGivers ? 1 : 0,
      expiresAt,
      orderNote,
      nowIso,
      nowIso
    );

    recordClaimEvent(db, claimId, null, status, 'giver', claimerUserId || guestEmail, 'Claim initiated', nowIso);

    db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
      uid('evt'),
      'claim_created',
      JSON.stringify({ guest_or_account: isGuest ? 'guest' : 'account', verified: Boolean(verified), quantity: requestedQty }),
      nowIso
    );

    if (isGuest && !verified) {
      sendNotification(db, {
        recipientEmail: guestEmail,
        eventType: 'guest_verification_code',
        listId: list.id,
        subject: `Your Hushlist verification code: ${verificationCode}`,
        body: `Enter code ${verificationCode} within 30 minutes to hold your reservation for "${item.title}". Manage link: /claim/${manageToken}`
      });
    }

    db.exec('COMMIT');

    return {
      id: claimId,
      item_id: item.id,
      list_id: list.id,
      status,
      verified: Boolean(verified),
      qty: requestedQty,
      manage_token: manageToken,
      expires_at: expiresAt,
      verification_required: !verified,
      verification_expires_at: verificationExpiresAt,
      // Expose code in dev/demo response header or notification inspector so guest flow is testable in 1 click
      demo_verification_code: verificationCode
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

/**
 * Verifies a guest's 6-digit email verification code and locks in the reservation (GVR-6, GVR-8).
 */
export function verifyGuestClaim(db, { claimId, code }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const nowIso = new Date().toISOString();
    purgeExpiredClaims(db, nowIso);

    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    if (!claim) throw new Error('Reservation not found');
    if (claim.verified === 1) {
      db.exec('COMMIT');
      return { ...claim, already_verified: true };
    }
    if (claim.status === 'expired' || claim.status === 'released' || claim.status === 'withdrawn') {
      throw new Error('Verification window (30 minutes) has expired or claim was locked');
    }

    // ADV-3.1: Enforce 5-attempt brute-force lockout on 6-digit guest verification codes
    if (String(claim.verification_code) !== String(code || '').trim()) {
      const nextAttempts = (claim.verification_attempts || 0) + 1;
      if (nextAttempts >= 5) {
        db.prepare(`
          UPDATE claims
          SET verification_attempts = ?, status = 'expired', verification_code = NULL, updated_at = ?
          WHERE id = ?
        `).run(nextAttempts, nowIso, claim.id);
        recordClaimEvent(db, claim.id, 'pending_verification', 'expired', 'system', claim.guest_email, 'Locked after 5 failed verification attempts', nowIso);
        db.exec('COMMIT');
        throw new Error('Too many failed verification attempts (max 5). Reservation has been cancelled.');
      }
      db.prepare('UPDATE claims SET verification_attempts = ?, updated_at = ? WHERE id = ?').run(nextAttempts, nowIso, claim.id);
      db.exec('COMMIT');
      throw new Error(`Invalid 6-digit verification code (${5 - nextAttempts} attempt(s) remaining)`);
    }

    const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'active'").get(claim.item_id);
    if (!item) throw new Error('Item is no longer available');

    if (!item.always_wanted) {
      const activeClaimed = db.prepare(`
        SELECT COALESCE(SUM(qty), 0) AS total
        FROM claims
        WHERE item_id = ? AND verified = 1 AND status IN ('reserved', 'purchased', 'given')
      `).get(item.id).total;

      if (activeClaimed + claim.qty > item.qty_wanted) {
        db.prepare("UPDATE claims SET status = 'released', updated_at = ? WHERE id = ?").run(nowIso, claim.id);
        db.exec('COMMIT');
        throw new Error('Another giver verified a claim for the last unit while your verification was pending');
      }
    }

    db.prepare(`
      UPDATE claims
      SET verified = 1, status = 'reserved', verification_code = NULL, updated_at = ?
      WHERE id = ?
    `).run(nowIso, claim.id);

    recordClaimEvent(db, claim.id, 'pending_verification', 'reserved', 'giver', claim.guest_email, 'Guest email verified', nowIso);
    db.exec('COMMIT');

    return db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

/**
 * Updates claim status (reserved -> purchased -> given, or released) by giver, helper (LST-4), or admin (ADM-1).
 * ADV-2.2: Never trusts client-supplied `actorType === 'admin'`; verifies actual user `is_admin` in DB.
 * ADV-3.3: Prevents terminal states (`released`, `expired`, `withdrawn`) from transitioning back to active states without a new quantity check.
 */
export function transitionClaimState(db, {
  claimId,
  newState,
  actorType = 'giver', // 'giver', 'helper', 'admin', 'system'
  actorId = null,
  manageToken = null,
  reason = null,
  orderNote = undefined
}) {
  const validStates = new Set(['reserved', 'purchased', 'given', 'released']);
  if (!validStates.has(newState)) {
    throw new Error(`Invalid target claim state: ${newState}`);
  }

  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) throw new Error('Claim not found');

  // ADV-3.3: Block复活/reactivation of terminal claims ('released', 'expired', 'withdrawn') or unverified claims
  if (['released', 'expired', 'withdrawn'].includes(claim.status) && newState !== 'released') {
    throw new Error(`Cannot transition a ${claim.status} claim back to ${newState}; please create a new reservation`);
  }
  if (claim.status === 'pending_verification' && newState !== 'released') {
    throw new Error('Guest email must be verified with the 6-digit code before confirming purchase');
  }

  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(claim.list_id);

  // ADV-2.2: Verify actual admin status from DB, never from untrusted request body
  const actorUser = actorId ? db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(actorId) : null;
  const isVerifiedAdmin = Boolean(actorUser && actorUser.is_admin === 1 && actorType === 'admin');
  if (actorType === 'admin' && !isVerifiedAdmin) {
    throw new Error('Unauthorized: Admin privileges required for admin claim override');
  }

  // ADM-1: Every admin override MUST include a non-empty audit reason
  if (isVerifiedAdmin && (!reason || !String(reason).trim())) {
    throw new Error('Admin claim overrides require an audit reason (ADM-1)');
  }

  const isOwnGiver = (actorId && claim.claimer_user_id === actorId) || (manageToken && claim.manage_token === manageToken);
  let isAuthorized = isOwnGiver || isVerifiedAdmin;
  let resolvedActorType = isVerifiedAdmin ? 'admin' : 'giver';

  if (!isAuthorized && actorId) {
    // Check if actor is a named List Helper (LST-4) or Guardian of child list
    const helperShare = db.prepare(
      "SELECT 1 FROM list_shares WHERE list_id = ? AND grantee_type = 'user' AND grantee_id = ? AND permission = 'helper'"
    ).get(claim.list_id, actorId);
    const guardianLink = list ? db.prepare(
      'SELECT 1 FROM guardian_links WHERE guardian_id = ? AND dependent_id = ?'
    ).get(actorId, list.owner_id) : null;

    if (helperShare || guardianLink) {
      isAuthorized = true;
      resolvedActorType = helperShare ? 'helper' : 'giver';
    }
  }

  if (!isAuthorized) {
    throw new Error('Unauthorized to modify this claim');
  }

  const nowIso = new Date().toISOString();
  const noteToSave = orderNote !== undefined ? orderNote : claim.order_note;

  db.prepare(`
    UPDATE claims
    SET status = ?, order_note = ?, updated_at = ?
    WHERE id = ?
  `).run(newState, noteToSave, nowIso, claim.id);

  recordClaimEvent(db, claim.id, claim.status, newState, resolvedActorType, actorId || claim.guest_email, reason || `Changed to ${newState}`, nowIso);

  db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
    uid('evt'),
    'claim_state_changed',
    JSON.stringify({ from: claim.status, to: newState, actor: resolvedActorType }),
    nowIso
  );

  // If a helper or admin released someone else's claim, notify the claimer (never the owner!)
  if ((resolvedActorType === 'helper' || resolvedActorType === 'admin') && newState === 'released') {
    const item = db.prepare('SELECT title FROM items WHERE id = ?').get(claim.item_id);
    sendNotification(db, {
      recipientUserId: claim.claimer_user_id,
      recipientEmail: claim.guest_email,
      eventType: 'claimed_item_changed',
      listId: claim.list_id,
      subject: `Your reservation for "${item?.title || 'item'}" was released`,
      body: `A list ${resolvedActorType} released your reservation${reason ? ` (${reason})` : ''}.`
    });
  }

  return db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
}

/**
 * Section 14 Edge Case 1, 2, 3: Owner deletes an item or marks "Got it" themselves.
 * - If claim is 'reserved': claim moves to 'withdrawn', claimer told "no longer wanted, no need to buy".
 * - If claim is 'purchased' or 'given': item is hidden, claim kept as 'purchased'/'given' for claimer's records,
 *   claimer told "already bought? keep it as a gift or return it".
 * - Owner response is IDENTICAL whether 0 or N claims existed!
 */
export function handleOwnerDeleteOrGotIt(db, { itemId, ownerId, mode = 'deleted' }) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) throw new Error('Item not found');

  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id);
  const coOwners = safeJsonParse(list?.co_owner_ids, []);
  const isGuardian = db.prepare('SELECT 1 FROM guardian_links WHERE guardian_id = ? AND dependent_id = ?').get(ownerId, list?.owner_id);
  if (!list || (list.owner_id !== ownerId && !coOwners.includes(ownerId) && !isGuardian)) {
    throw new Error('Unauthorized');
  }

  const nowIso = new Date().toISOString();
  const targetStatus = mode === 'got_it' ? 'got_it' : 'deleted';

  db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run(targetStatus, nowIso, item.id);

  // Process any active claims silently behind the scenes without leaking anything to the owner
  const claims = db.prepare(`
    SELECT * FROM claims
    WHERE item_id = ? AND status IN ('pending_verification', 'reserved', 'purchased')
  `).all(item.id);

  for (const c of claims) {
    if (c.status === 'reserved' || c.status === 'pending_verification') {
      db.prepare("UPDATE claims SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(nowIso, c.id);
      recordClaimEvent(db, c.id, c.status, 'withdrawn', 'system', null, `Owner marked item ${targetStatus}`, nowIso);
      sendNotification(db, {
        recipientUserId: c.claimer_user_id,
        recipientEmail: c.guest_email,
        eventType: 'claimed_item_withdrawn',
        listId: list.id,
        subject: `Update on "${item.title}": no longer needed`,
        body: `The list owner removed "${item.title}" from their list (no longer wanted, no need to buy). Your reservation has been withdrawn.`
      });
    } else if (c.status === 'purchased') {
      // Keep as 'purchased' for the claimer's records!
      recordClaimEvent(db, c.id, 'purchased', 'purchased', 'system', null, `Owner removed item (${targetStatus}); kept in claimer history`, nowIso);
      sendNotification(db, {
        recipientUserId: c.claimer_user_id,
        recipientEmail: c.guest_email,
        eventType: 'claimed_item_withdrawn',
        listId: list.id,
        subject: `Heads up about "${item.title}"`,
        body: `The list owner removed "${item.title}" from their list. Already bought? You can still give it as a gift or return it—we kept your purchase record in "My Claims".`
      });
    }
  }

  // Return a constant, spoiler-free response to the owner
  return {
    id: item.id,
    list_id: item.list_id,
    status: targetStatus,
    updated_at: nowIso
  };
}

/**
 * Section 14 Edge Case 4 & 5: Owner edits size, color, notes, or lowers quantity below claimed units.
 * - Edits to size/color/notes keep claims and notify claimers with old & new values side by side.
 * - Lowering qty_wanted below claimed units releases newest unpurchased ('reserved') claims first while keeping 'purchased' claims.
 * - Owner sees an ordinary edit response with zero mention of claims.
 */
export function handleOwnerEditItem(db, { itemId, ownerId, updates }) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) throw new Error('Item not found');

  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id);
  const coOwners = safeJsonParse(list?.co_owner_ids, []);
  const isGuardian = db.prepare('SELECT 1 FROM guardian_links WHERE guardian_id = ? AND dependent_id = ?').get(ownerId, list?.owner_id);
  if (!list || (list.owner_id !== ownerId && !coOwners.includes(ownerId) && !isGuardian)) {
    throw new Error('Unauthorized');
  }

  const nowIso = new Date().toISOString();
  const newTitle = updates.title !== undefined ? updates.title : item.title;
  const newVariant = updates.variant !== undefined ? updates.variant : item.variant;
  const newNotes = updates.notes !== undefined ? updates.notes : item.notes;
  const newPrice = updates.price !== undefined ? Number(updates.price) : item.price;
  const newPriority = updates.priority !== undefined ? updates.priority : item.priority;
  const newQtyWanted = updates.qty_wanted !== undefined ? Math.max(1, Number(updates.qty_wanted)) : item.qty_wanted;
  const newAnySimilar = updates.any_similar !== undefined ? (updates.any_similar ? 1 : 0) : item.any_similar;
  const newAlwaysWanted = updates.always_wanted !== undefined ? (updates.always_wanted ? 1 : 0) : item.always_wanted;
  const newAllowChipIn = updates.allow_group_chip_in !== undefined ? (updates.allow_group_chip_in ? 1 : 0) : item.allow_group_chip_in;
  const newGivingInstructions = updates.giving_instructions !== undefined ? updates.giving_instructions : item.giving_instructions;

  db.prepare(`
    UPDATE items
    SET title = ?, variant = ?, notes = ?, price = ?, priority = ?, qty_wanted = ?,
        any_similar = ?, always_wanted = ?, allow_group_chip_in = ?, giving_instructions = ?, updated_at = ?
    WHERE id = ?
  `).run(
    newTitle, newVariant, newNotes, newPrice, newPriority, newQtyWanted,
    newAnySimilar, newAlwaysWanted, newAllowChipIn, newGivingInstructions, nowIso, item.id
  );

  // Edge Case 4: Did size/color (variant) or notes change?
  const variantChanged = (item.variant || '') !== (newVariant || '');
  const notesChanged = (item.notes || '') !== (newNotes || '');
  if (variantChanged || notesChanged) {
    const activeClaims = db.prepare(`
      SELECT * FROM claims WHERE item_id = ? AND status IN ('reserved', 'purchased') AND verified = 1
    `).all(item.id);

    const diffLines = [];
    if (variantChanged) diffLines.push(`Size/Color: "${item.variant || 'none'}" -> "${newVariant || 'none'}"`);
    if (notesChanged) diffLines.push(`Notes: "${item.notes || 'none'}" -> "${newNotes || 'none'}"`);

    for (const c of activeClaims) {
      sendNotification(db, {
        recipientUserId: c.claimer_user_id,
        recipientEmail: c.guest_email,
        eventType: 'claimed_item_changed',
        listId: list.id,
        subject: `Details updated on "${newTitle}"`,
        body: `The list owner updated details on an item you claimed:\n${diffLines.join('\n')}`
      });
    }
  }

  // Edge Case 5: Did owner lower quantity below currently claimed units?
  if (newQtyWanted < item.qty_wanted && !newAlwaysWanted) {
    const allActive = db.prepare(`
      SELECT * FROM claims
      WHERE item_id = ? AND status IN ('reserved', 'purchased', 'given') AND verified = 1
      ORDER BY CASE WHEN status = 'reserved' THEN 0 ELSE 1 END ASC, created_at DESC
    `).all(item.id);

    let totalClaimed = allActive.reduce((s, c) => s + c.qty, 0);
    for (const c of allActive) {
      if (totalClaimed <= newQtyWanted) break;
      // Release newest unpurchased ('reserved') claims first; never release 'purchased' or 'given'
      if (c.status === 'reserved') {
        db.prepare("UPDATE claims SET status = 'released', updated_at = ? WHERE id = ?").run(nowIso, c.id);
        recordClaimEvent(db, c.id, 'reserved', 'released', 'system', null, 'Owner lowered quantity wanted below claimed units', nowIso);
        totalClaimed -= c.qty;
        sendNotification(db, {
          recipientUserId: c.claimer_user_id,
          recipientEmail: c.guest_email,
          eventType: 'claimed_item_changed',
          listId: list.id,
          subject: `Quantity reduced on "${newTitle}"`,
          body: `The owner reduced the requested quantity for "${newTitle}", so your unpurchased reservation was released.`
        });
      }
    }
  }

  return db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
}

/**
 * GVR-4: Add a group contribution ("chip in") toward an expensive item.
 * ADV-1.5, ADV-2.5, ADV-3.4:
 * - Enforces BEGIN IMMEDIATE transaction.
 * - Requires item.allow_group_chip_in === 1.
 * - Rejects self-contribution by the list owner or co-owners.
 * - Enforces list visibility (`getViewerRole().canView`).
 * - Caps pledged amount so a prankster cannot pledge $1,000,000 or over-fund beyond remaining target.
 */
export function addContribution(db, {
  itemId,
  contributorUserId = null,
  guestEmail = null,
  guestName = null,
  pledgedAmount,
  showNameToGivers = true,
  note = null
}) {
  const amount = Number(pledgedAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Pledged contribution amount must be greater than 0');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'active'").get(itemId);
    if (!item) throw new Error('Item not found');
    if (!item.allow_group_chip_in) {
      throw new Error('Group chip-in is not enabled on this item');
    }

    const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id);
    if (!list || list.archived_at) throw new Error('List is archived or unavailable');

    const coOwners = safeJsonParse(list.co_owner_ids, []);
    if (contributorUserId && (contributorUserId === list.owner_id || coOwners.includes(contributorUserId))) {
      throw new Error('List owners cannot pledge contributions to their own list items');
    }

    const viewerCtx = getViewerRole(db, list, contributorUserId);
    if (!viewerCtx.canView) {
      throw new Error('Unauthorized to view or contribute to this list');
    }

    if (!contributorUserId && (!guestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail))) {
      throw new Error('A signed-in account or valid email is required to pledge a contribution');
    }

    if (item.price && item.price > 0) {
      const currentPledged = db.prepare(`
        SELECT COALESCE(SUM(pledged_amount), 0) AS total
        FROM contributions
        WHERE item_id = ? AND status IN ('pledged', 'paid_off_platform')
      `).get(item.id).total;

      const remainingTarget = Math.max(0, Math.round((item.price - currentPledged) * 100) / 100);
      if (remainingTarget <= 0) {
        throw new Error('This item has already reached its full group chip-in goal!');
      }
      if (amount > remainingTarget) {
        throw new Error(`Pledge exceeds remaining chip-in goal ($${remainingTarget.toFixed(2)} remaining)`);
      }
    }

    const id = uid('cnt');
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO contributions (
        id, item_id, list_id, contributor_user_id, guest_email, guest_name,
        pledged_amount, currency, status, show_name_to_givers, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pledged', ?, ?, ?)
    `).run(
      id, item.id, item.list_id, contributorUserId, guestEmail, guestName,
      amount, item.currency || 'USD', showNameToGivers ? 1 : 0, note, nowIso
    );

    db.exec('COMMIT');
    return db.prepare('SELECT * FROM contributions WHERE id = ?').get(id);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function recordClaimEvent(db, claimId, fromState, toState, actor, actorId, reason, atIso = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO claim_events (id, claim_id, from_state, to_state, actor, actor_id, reason, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uid('ce'), claimId, fromState, toState, actor, actorId, reason, atIso);
}
