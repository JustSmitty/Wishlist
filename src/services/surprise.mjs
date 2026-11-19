/**
 * Surprise protection and list authorization.
 *
 * The rule the whole product hangs on: while a list is in surprise mode and
 * has not been revealed, its owner and co-owners must learn nothing about
 * claims on it — not who, not how many, not whether. That has to hold for
 * every response an owner can obtain, including error messages and the side
 * effects of their own actions.
 *
 * Roles returned by getViewerRole:
 *   owner     owner or co-owner. Sees claims only in registry mode or after reveal.
 *   guardian  guardian of the child the list belongs to. Sees and can release claims.
 *   helper    named by the owner. Sees and can release claims, cannot edit.
 *   follower  someone the list is shared with, in the owner's circle, or an
 *             approved follower. Sees claims; sees giver names only if in the circle.
 *   guest     anyone else holding the link (signed in or not). Sees only
 *             whether an item is still available and how many are left, plus
 *             their own claim. No other reservation, pledge or amount.
 */

import { safeEqual } from '../db/schema.mjs';
import {
  isGuardianOf, isBlockedBy, sharesGroup, inSameCircle, hasApprovedFollow
} from './access.mjs';

const NONE = Object.freeze({ role: 'none', canView: false });

/** True when the list's owner is allowed to see claims on it. */
export function ownerCanSeeClaims(list) {
  return Boolean(list.revealed_at) || list.surprise_mode === 0;
}

export function getViewerRole(db, list, viewerUserId = null, guestClaimToken = null) {
  if (!list) return NONE;

  const owner = db.prepare('SELECT id, is_dependent, status FROM users WHERE id = ?').get(list.owner_id);
  if (!owner || owner.status !== 'active') return NONE;

  const coOwners = safeJsonParse(list.co_owner_ids, []);
  const guardianRole = {
    role: 'guardian', canView: true, canEdit: true,
    canSeeClaims: true, canSeeClaimerNames: true, canReleaseClaims: true, isGroupMember: true
  };

  if (viewerUserId && (list.owner_id === viewerUserId || coOwners.includes(viewerUserId))) {
    // A guardian named as co-owner of their child's list is still a giver.
    // A co-owner who is not a guardian is an owner like any other.
    if (owner.is_dependent === 1 && isGuardianOf(db, viewerUserId, list.owner_id)) return guardianRole;
    const visible = ownerCanSeeClaims(list);
    return {
      role: 'owner', canView: true, canEdit: true,
      canSeeClaims: visible, canSeeClaimerNames: visible, canReleaseClaims: false, isGroupMember: true
    };
  }

  if (viewerUserId && isGuardianOf(db, viewerUserId, list.owner_id)) return guardianRole;

  if (viewerUserId) {
    if (isBlockedBy(db, viewerUserId, list.owner_id)) {
      return { role: 'blocked', canView: false };
    }

    const helperShare = db.prepare(
      "SELECT 1 FROM list_shares WHERE list_id = ? AND grantee_type = 'user' AND grantee_id = ? AND permission = 'helper'"
    ).get(list.id, viewerUserId);
    if (helperShare) {
      return {
        role: 'helper', canView: true, canEdit: false,
        canSeeClaims: true, canSeeClaimerNames: true, canReleaseClaims: true, isGroupMember: true
      };
    }

    // "private" means the owner (and a named helper) only. Shares do not apply.
    if (list.visibility === 'private') return NONE;

    const directShare = db.prepare(
      "SELECT 1 FROM list_shares WHERE list_id = ? AND grantee_type = 'user' AND grantee_id = ?"
    ).get(list.id, viewerUserId);
    const groupShare = db.prepare(`
      SELECT 1 FROM list_shares ls
      JOIN group_members gm ON gm.group_id = ls.grantee_id
      WHERE ls.list_id = ? AND ls.grantee_type = 'group' AND gm.user_id = ?
    `).get(list.id, viewerUserId);

    const giver = (inCircle) => ({
      role: 'follower', isGroupMember: inCircle, canView: true, canEdit: false,
      canSeeClaims: true, canSeeClaimerNames: inCircle, canReleaseClaims: false
    });

    if (directShare || groupShare) return giver(true);

    // "specific" lists are for explicit shares only. Following is not a grant.
    if (list.visibility === 'link') {
      if (inSameCircle(db, viewerUserId, list.owner_id) || sharesGroup(db, viewerUserId, list.owner_id)) return giver(true);
      if (hasApprovedFollow(db, viewerUserId, { userId: list.owner_id, listId: list.id })) return giver(false);
    }
  }

  // Anyone else holding the link, signed in or not, gets the guest projection.
  if (list.visibility === 'link') {
    return {
      role: 'guest', isSignedIn: Boolean(viewerUserId), isGroupMember: false,
      canView: true, canEdit: false,
      canSeeClaims: true, canSeeClaimerNames: false, canReleaseClaims: false,
      guestClaimToken
    };
  }

  return NONE;
}

/**
 * Shapes one item for one viewer. For an owner who may not see claims this
 * returns owner-authored fields only and performs no claim query at all, so
 * the payload cannot differ with claim state.
 */
export function sanitizeItemForViewer(db, item, list, viewerCtx, viewerUserId = null) {
  const baseItem = {
    id: item.id,
    list_id: item.list_id,
    kind: item.kind,
    title: item.title,
    canonical_url: item.canonical_url,
    store: item.store,
    price: item.price,
    currency: item.currency,
    variant: item.variant,
    qty_wanted: item.qty_wanted,
    always_wanted: Boolean(item.always_wanted),
    allow_group_chip_in: Boolean(item.allow_group_chip_in),
    priority: item.priority,
    notes: item.notes,
    any_similar: Boolean(item.any_similar),
    alternate_sources: safeJsonParse(item.alternate_sources, []),
    field_confidence: safeJsonParse(item.field_confidence, {}),
    in_stock: Boolean(item.in_stock),
    sort_order: item.sort_order,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at
  };

  // Bounded: the starting point plus the most recent changes.
  const first = db.prepare('SELECT price, in_stock, checked_at FROM price_snapshots WHERE item_id = ? ORDER BY checked_at ASC LIMIT 1').get(item.id);
  const recent = db.prepare(`
    SELECT price, in_stock, checked_at FROM price_snapshots
    WHERE item_id = ? ORDER BY checked_at DESC LIMIT 59
  `).all(item.id).reverse();
  const priceHistory = first && recent.length && recent[0].checked_at !== first.checked_at ? [first, ...recent] : recent;
  baseItem.price_history = priceHistory;
  if (priceHistory.length >= 2) {
    const firstPrice = priceHistory[0].price;
    const latestPrice = priceHistory[priceHistory.length - 1].price;
    if (firstPrice > 0 && latestPrice !== null && latestPrice < firstPrice) {
      baseItem.price_drop_percent = Math.round(((firstPrice - latestPrice) / firstPrice) * 1000) / 10;
    }
  }

  // Payment handles and similar giving instructions never go to link guests.
  const mayReadInstructions = ['owner', 'guardian', 'helper'].includes(viewerCtx.role) || viewerCtx.isGroupMember;
  baseItem.giving_instructions = mayReadInstructions ? (item.giving_instructions || null) : null;

  if (viewerCtx.role === 'owner' || viewerCtx.role === 'guardian') {
    if (item.status === 'received') {
      baseItem.received_at = item.received_at;
      baseItem.thank_you_sent = Boolean(item.thank_you_sent);
      baseItem.thank_you_note = item.thank_you_note;
    }
  }

  if (!viewerCtx.canSeeClaims) return baseItem;

  const activeClaims = db.prepare(`
    SELECT c.*, u.name AS user_name
    FROM claims c
    LEFT JOIN users u ON u.id = c.claimer_user_id
    WHERE c.item_id = ? AND c.status IN ('reserved', 'purchased', 'given') AND c.verified = 1
      AND (c.status != 'reserved' OR c.expires_at IS NULL OR c.expires_at > ?)
    ORDER BY c.created_at ASC
  `).all(item.id, new Date().toISOString());

  const contributions = db.prepare(`
    SELECT c.*, u.name AS user_name
    FROM contributions c
    LEFT JOIN users u ON u.id = c.contributor_user_id
    WHERE c.item_id = ? AND c.status IN ('pledged', 'paid_off_platform')
    ORDER BY c.created_at ASC
  `).all(item.id);

  const qtyClaimed = activeClaims.reduce((sum, c) => sum + (c.qty || 1), 0);
  const pledgedTotal = Math.round(contributions.reduce((sum, c) => sum + (c.pledged_amount || 0), 0) * 100) / 100;
  const isFullyClaimed = !baseItem.always_wanted && (
    qtyClaimed >= baseItem.qty_wanted ||
    (baseItem.allow_group_chip_in && baseItem.price > 0 && pledgedTotal >= baseItem.price)
  );

  const privileged = viewerCtx.role === 'helper' || viewerCtx.role === 'guardian';

  const sanitizedClaims = activeClaims.map(c => {
    const isOwnClaim = Boolean(
      (viewerUserId && c.claimer_user_id === viewerUserId) ||
      (!c.claimer_user_id && holdsManageToken(c.manage_token, viewerCtx.guestClaimToken))
    );
    const canSeeName = isOwnClaim || privileged || (viewerCtx.canSeeClaimerNames && Boolean(c.show_name_to_givers));
    // A guest's email address is never used as a display name.
    const name = c.user_name || c.guest_name || 'A guest';

    return {
      // The id is only useful to someone who can act on the claim.
      id: (isOwnClaim || viewerCtx.canReleaseClaims) ? c.id : undefined,
      qty: c.qty,
      status: viewerCtx.role === 'guest' && !isOwnClaim ? 'taken' : c.status,
      is_own_claim: isOwnClaim,
      claimer_display: canSeeName ? name : 'Someone',
      expires_at: (isOwnClaim || privileged) ? c.expires_at : undefined,
      clicked_out_at: isOwnClaim ? c.clicked_out_at : undefined,
      return_prompt_answered: isOwnClaim ? c.return_prompt_answered : undefined,
      order_note: isOwnClaim ? c.order_note : undefined
    };
  });

  const sanitizedContributions = contributions.map(c => {
    const isOwn = Boolean(viewerUserId && c.contributor_user_id === viewerUserId);
    const canSeeName = isOwn || privileged || (viewerCtx.canSeeClaimerNames && Boolean(c.show_name_to_givers));
    return {
      id: isOwn ? c.id : undefined,
      pledged_amount: c.pledged_amount,
      currency: c.currency,
      status: c.status,
      is_own: isOwn,
      note: (isOwn || viewerCtx.isGroupMember || privileged) ? c.note : undefined,
      contributor_display: canSeeName ? (c.user_name || c.guest_name || 'A contributor') : 'Someone'
    };
  });

  // Someone who only holds the link learns what they need to choose a gift
  // and nothing about anyone else's: no rows for other people's reservations,
  // no pledges, no amounts.
  if (viewerCtx.role === 'guest') {
    return {
      ...baseItem,
      claim_summary: {
        qty_remaining: baseItem.always_wanted ? null : Math.max(0, baseItem.qty_wanted - qtyClaimed),
        is_fully_claimed: isFullyClaimed,
        claims: sanitizedClaims.filter(c => c.is_own_claim),
        contributions: []
      }
    };
  }

  return {
    ...baseItem,
    claim_summary: {
      qty_claimed: qtyClaimed,
      qty_remaining: baseItem.always_wanted ? null : Math.max(0, baseItem.qty_wanted - qtyClaimed),
      is_fully_claimed: isFullyClaimed,
      pledged_total: pledgedTotal,
      pledged_target: baseItem.price || 0,
      claims: sanitizedClaims,
      contributions: sanitizedContributions
    }
  };
}

/**
 * True when one of the manage tokens a guest's browser presented is this
 * claim's. A browser keeps one token per reservation it made.
 */
export function holdsManageToken(claimToken, presented) {
  if (!claimToken || !presented) return false;
  const list = Array.isArray(presented) ? presented : [presented];
  let found = false;
  for (const token of list) if (safeEqual(claimToken, token)) found = true;
  return found;
}

export function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    const parsed = JSON.parse(str);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
