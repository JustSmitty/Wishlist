/**
 * Section 8 & Section 14 Surprise Protection & Authorization Engine
 *
 * Enforces the core rule of Hushlist:
 * - When surprise_mode = 1 (default for personal lists), the list owner (and co-owners)
 *   MUST NEVER see claim counts, claim states, who claimed, helper actions, or secret ideas.
 * - Deleting or editing a claimed item must look identical to the owner as doing so to an
 *   unclaimed item.
 * - Even after an owner deletes/marks "got it", the response must look identical whether
 *   the item was claimed or not.
 */

export function getViewerRole(db, list, viewerUserId = null, guestClaimToken = null) {
  if (!list) return { role: 'none', canView: false };

  const coOwners = safeJsonParse(list.co_owner_ids, []);

  // 1. Check if viewer is Owner or Co-owner
  if (viewerUserId && (list.owner_id === viewerUserId || coOwners.includes(viewerUserId))) {
    // Check if owner is actually a Guardian viewing their under-13 dependent's list (Section 8 row 3: Guardians are usually givers too and CAN see claims)
    const ownerUser = db.prepare('SELECT is_dependent FROM users WHERE id = ?').get(list.owner_id);
    if (ownerUser && ownerUser.is_dependent === 1 && list.owner_id !== viewerUserId) {
      return { role: 'guardian', canView: true, canEdit: true, canSeeClaims: true, canSeeClaimerNames: true, canReleaseClaims: true };
    }
    const isRevealed = Boolean(list.revealed_at) || list.surprise_mode === 0;
    return {
      role: 'owner',
      canView: true,
      canEdit: true,
      canSeeClaims: isRevealed,
      canSeeClaimerNames: isRevealed,
      canReleaseClaims: false
    };
  }

  // 2. Check if viewer is Guardian of the list owner (ACC-3, D6, Section 8)
  if (viewerUserId) {
    const guardianLink = db.prepare(
      'SELECT 1 FROM guardian_links WHERE guardian_id = ? AND dependent_id = ?'
    ).get(viewerUserId, list.owner_id);
    if (guardianLink) {
      return {
        role: 'guardian',
        canView: true,
        canEdit: true,
        canSeeClaims: true,
        canSeeClaimerNames: true,
        canReleaseClaims: true
      };
    }
  }

  // 3. Check if viewer is a named List Helper (LST-4, D9)
  if (viewerUserId) {
    const helperShare = db.prepare(
      "SELECT * FROM list_shares WHERE list_id = ? AND grantee_type = 'user' AND grantee_id = ? AND permission = 'helper'"
    ).get(list.id, viewerUserId);
    if (helperShare) {
      return {
        role: 'helper',
        canView: true,
        canEdit: false,
        canSeeClaims: true,
        canSeeClaimerNames: true,
        canReleaseClaims: true
      };
    }
  }

  // 4. Check if viewer is a Group member or directly shared user or approved Follower
  if (viewerUserId) {
    const directShare = db.prepare(
      "SELECT * FROM list_shares WHERE list_id = ? AND grantee_type = 'user' AND grantee_id = ?"
    ).get(list.id, viewerUserId);

    const groupShare = db.prepare(`
      SELECT ls.* FROM list_shares ls
      JOIN group_members gm ON gm.group_id = ls.grantee_id
      WHERE ls.list_id = ? AND ls.grantee_type = 'group' AND gm.user_id = ?
    `).get(list.id, viewerUserId);

    const isSharedGroupMember = db.prepare(`
      SELECT 1 FROM group_members gm1
      JOIN group_members gm2 ON gm1.group_id = gm2.group_id
      WHERE gm1.user_id = ? AND gm2.user_id = ?
    `).get(list.owner_id, viewerUserId);

    const approvedFollow = db.prepare(`
      SELECT 1 FROM follows
      WHERE follower_id = ? AND status = 'approved'
        AND ((target_type = 'user' AND target_id = ?) OR (target_type = 'list' AND target_id = ?))
    `).get(viewerUserId, list.owner_id, list.id);

    const blockedFollow = db.prepare(`
      SELECT 1 FROM follows
      WHERE follower_id = ? AND status = 'blocked'
        AND ((target_type = 'user' AND target_id = ?) OR (target_type = 'list' AND target_id = ?))
    `).get(viewerUserId, list.owner_id, list.id);

    if (blockedFollow) {
      return { role: 'blocked', canView: false };
    }

    if (directShare || groupShare || (list.visibility !== 'private' && (isSharedGroupMember || approvedFollow || list.visibility === 'link'))) {
      return {
        role: 'follower',
        isGroupMember: Boolean(groupShare || isSharedGroupMember || directShare),
        canView: true,
        canEdit: false,
        canSeeClaims: true,
        canSeeClaimerNames: true, // Subject to GVR-7 per-claim flag
        canReleaseClaims: false
      };
    }
  }

  // 5. Guest via link (no account or signed out)
  if (list.visibility === 'link') {
    return {
      role: 'guest',
      isGroupMember: false,
      canView: true,
      canEdit: false,
      canSeeClaims: true, // Guests see "Available / Taken" only, plus own claim via guestClaimToken
      canSeeClaimerNames: false,
      canReleaseClaims: false,
      guestClaimToken
    };
  }

  return { role: 'none', canView: false };
}

/**
 * Sanitizes an item and its claims/contributions for the given viewer context.
 * Guarantees ZERO spoiler leakage when role === 'owner' and canSeeClaims === false.
 */
export function sanitizeItemForViewer(db, item, list, viewerCtx, viewerUserId = null) {
  const baseItem = {
    id: item.id,
    list_id: item.list_id,
    kind: item.kind,
    title: item.title,
    canonical_url: item.canonical_url,
    original_url: item.original_url,
    store: item.store,
    image: item.image,
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

  // Attach price history snapshots for Price History Sparkline & Price-Drop Badges (ITM-6)
  const priceHistory = db.prepare(`
    SELECT price, in_stock, checked_at
    FROM price_snapshots
    WHERE item_id = ?
    ORDER BY checked_at ASC
  `).all(item.id);
  baseItem.price_history = priceHistory;
  if (priceHistory.length >= 2) {
    const firstPrice = priceHistory[0].price;
    const latestPrice = priceHistory[priceHistory.length - 1].price;
    if (firstPrice > 0 && latestPrice < firstPrice) {
      baseItem.price_drop_percent = Math.round(((firstPrice - latestPrice) / firstPrice) * 1000) / 10;
    }
  }

  // ITM-9: Cash/gift-card giving instructions (payment handles) ONLY shown to owner, guardian, helper, or signed-in group members; never on public links
  if (viewerCtx.role === 'owner' || viewerCtx.role === 'guardian' || viewerCtx.role === 'helper' || viewerCtx.isGroupMember) {
    baseItem.giving_instructions = item.giving_instructions || null;
  } else {
    baseItem.giving_instructions = null;
  }

  // CRITICAL SPOILER PROTECTION:
  // If viewer is the owner and surprise mode is active (canSeeClaims === false),
  // return ONLY the owner-authored fields. Never query or attach any claim/contribution fields!
  if (!viewerCtx.canSeeClaims) {
    if (item.status === 'received') {
      baseItem.received_at = item.received_at;
      baseItem.thank_you_sent = Boolean(item.thank_you_sent);
      baseItem.thank_you_note = item.thank_you_note;
    }
    return baseItem;
  }

  // Otherwise, viewer is a Giver (follower, group member, guardian, helper, guest) OR owner with surprise_mode off / post-event revealed
  const activeClaims = db.prepare(`
    SELECT c.*, u.name AS user_name
    FROM claims c
    LEFT JOIN users u ON u.id = c.claimer_user_id
    WHERE c.item_id = ? AND c.status IN ('reserved', 'purchased', 'given') AND c.verified = 1
    ORDER BY c.created_at ASC
  `).all(item.id);

  const contributions = db.prepare(`
    SELECT c.*, u.name AS user_name
    FROM contributions c
    LEFT JOIN users u ON u.id = c.contributor_user_id
    WHERE c.item_id = ? AND c.status IN ('pledged', 'paid_off_platform')
    ORDER BY c.created_at ASC
  `).all(item.id);

  const qtyClaimed = activeClaims.reduce((sum, c) => sum + (c.qty || 1), 0);
  const pledgedTotal = contributions.reduce((sum, c) => sum + (c.pledged_amount || 0), 0);
  const isFullyClaimed = !baseItem.always_wanted && (
    qtyClaimed >= baseItem.qty_wanted ||
    (baseItem.allow_group_chip_in && baseItem.price > 0 && pledgedTotal >= baseItem.price)
  );

  const sanitizedClaims = activeClaims.map(c => {
    const isOwnClaim = (viewerUserId && c.claimer_user_id === viewerUserId) ||
                       (viewerCtx.guestClaimToken && c.manage_token === viewerCtx.guestClaimToken);
    // GVR-7: Claimer chooses whether other givers see their name; never shown to link guests unless own claim
    const canSeeName = isOwnClaim ||
                       viewerCtx.role === 'helper' ||
                       viewerCtx.role === 'guardian' ||
                       (viewerCtx.canSeeClaimerNames && Boolean(c.show_name_to_givers));

    return {
      id: c.id,
      qty: c.qty,
      status: viewerCtx.role === 'guest' && !isOwnClaim ? 'taken' : c.status,
      is_own_claim: Boolean(isOwnClaim),
      claimer_display: canSeeName ? (c.user_name || c.guest_name || c.guest_email || 'A gift-giver') : 'Anonymous Giver',
      expires_at: (isOwnClaim || viewerCtx.role === 'helper' || viewerCtx.role === 'guardian') ? c.expires_at : undefined,
      clicked_out_at: isOwnClaim ? c.clicked_out_at : undefined,
      return_prompt_answered: isOwnClaim ? c.return_prompt_answered : undefined,
      order_note: isOwnClaim ? c.order_note : undefined,
      thank_you_sent: Boolean(c.thank_you_sent)
    };
  });

  const sanitizedContributions = contributions.map(c => {
    const isOwn = viewerUserId && c.contributor_user_id === viewerUserId;
    const canSeeName = isOwn || viewerCtx.role === 'helper' || viewerCtx.role === 'guardian' ||
                       (viewerCtx.canSeeClaimerNames && Boolean(c.show_name_to_givers));
    return {
      id: c.id,
      pledged_amount: c.pledged_amount,
      currency: c.currency,
      status: c.status,
      is_own: Boolean(isOwn),
      contributor_display: canSeeName ? (c.user_name || c.guest_name || 'A contributor') : 'Anonymous Contributor'
    };
  });

  return {
    ...baseItem,
    claim_summary: {
      qty_claimed: qtyClaimed,
      qty_remaining: baseItem.always_wanted ? 999 : Math.max(0, baseItem.qty_wanted - qtyClaimed),
      is_fully_claimed: isFullyClaimed,
      availability_label: isFullyClaimed ? 'Taken' : (qtyClaimed > 0 ? `${qtyClaimed} of ${baseItem.qty_wanted} claimed` : 'Available'),
      pledged_total: pledgedTotal,
      pledged_target: baseItem.price || 0,
      claims: sanitizedClaims,
      contributions: sanitizedContributions
    }
  };
}

export function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
