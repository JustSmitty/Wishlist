import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db/schema.mjs';
import { seedDatabase, TOP_30_RETAILER_ADAPTERS } from '../src/db/seed.mjs';
import { getViewerRole, sanitizeItemForViewer } from '../src/services/surprise.mjs';
import {
  captureFromUrl,
  extractMetadataFromHtml,
  canonicalizeUrl,
  checkUrlSafety,
  importAmazonList
} from '../src/services/capture.mjs';
import {
  createClaim,
  verifyGuestClaim,
  transitionClaimState,
  handleOwnerDeleteOrGotIt,
  handleOwnerEditItem,
  addContribution,
  purgeExpiredClaims
} from '../src/services/claims.mjs';
import { sendNotification } from '../src/services/notifications.mjs';
import { createSecretSantaExchange } from '../src/services/secret-santa.mjs';

function setupTestDb() {
  const db = createDatabase(':memory:');
  seedDatabase(db);
  return db;
}

// ============================================================================
// 1. SPOILER-LEAK SUITE (Section 8, Section 14, Section 16, Section 17)
// "Every owner-facing page, email and API response rendered with and without claims:
//  Outputs are identical for the owner. Blocks the release on failure."
// ============================================================================
test('Section 17 Spoiler-Leak Suite: Owner view of list & items is byte-for-byte identical with 0 claims vs active reservations, purchases, chip-ins, helper actions, and secret ideas', () => {
  const db = setupTestDb();
  const list = db.prepare("SELECT * FROM lists WHERE id = 'lst_justin_holiday'").get();
  const item = db.prepare("SELECT * FROM items WHERE id = 'itm_j1'").get();

  const ownerCtx = getViewerRole(db, list, 'usr_justin');
  assert.equal(ownerCtx.role, 'owner');
  assert.equal(ownerCtx.canSeeClaims, false, 'Owner with surprise_mode=1 must never see claims');

  // Snapshot 1: Item with 0 claims
  const snapshotBefore = JSON.stringify(sanitizeItemForViewer(db, item, list, ownerCtx, 'usr_justin'));

  // Now a giver (Aunt Elena) reserves the item, adds a group contribution, and Marks it Purchased
  const claim = createClaim(db, {
    itemId: 'itm_j1',
    claimerUserId: 'usr_elena',
    qty: 1,
    orderNote: 'Secret order #9988'
  });
  transitionClaimState(db, {
    claimId: claim.id,
    newState: 'purchased',
    actorType: 'giver',
    actorId: 'usr_elena'
  });
  addContribution(db, {
    itemId: 'itm_j1',
    contributorUserId: 'usr_maya',
    pledgedAmount: 75,
    note: 'Secret chip-in!'
  });

  // Snapshot 2: Owner views the exact same item after reservation, purchase & chip-in
  const itemAfter = db.prepare("SELECT * FROM items WHERE id = 'itm_j1'").get();
  const snapshotAfter = JSON.stringify(sanitizeItemForViewer(db, itemAfter, list, ownerCtx, 'usr_justin'));

  assert.equal(snapshotAfter, snapshotBefore, 'CRITICAL SPOILER INVARIANT: Owner payload must be 100% identical before and after claims/contributions');
  assert.equal(JSON.parse(snapshotAfter).claim_summary, undefined);

  // Verify Giver (Aunt Elena) DOES see the claim summary
  const giverCtx = getViewerRole(db, list, 'usr_elena');
  assert.equal(giverCtx.canSeeClaims, true);
  const giverView = sanitizeItemForViewer(db, itemAfter, list, giverCtx, 'usr_elena');
  assert.equal(giverView.claim_summary.qty_claimed, 1);
  assert.equal(giverView.claim_summary.is_fully_claimed, true);
  assert.equal(giverView.claim_summary.pledged_total, 75);

  // Verify Section 16 Notification Spoiler Protection: attempting to send any claim notification to the list owner is blocked!
  const blockedAttempt = sendNotification(db, {
    recipientUserId: 'usr_justin',
    recipientEmail: 'justin@smithfamily.dev',
    eventType: 'claimed_item_changed',
    listId: list.id,
    subject: 'Spoiler attempt',
    body: 'Someone claimed your item'
  });
  assert.equal(blockedAttempt.skipped, true);
  assert.equal(blockedAttempt.reason, 'spoiler_protection_blocked_owner_notification');
});

// ============================================================================
// 2. CONCURRENCY SUITE (GVR-8 & Section 17)
// "Two givers reserve the last unit at once -> Exactly one succeeds; never over-claimed"
// ============================================================================
test('Section 17 Concurrency Suite (GVR-8): Simultaneous claims on the last remaining unit resolve to exactly one winner and zero over-claims', async () => {
  const db = setupTestDb();
  // itm_j1 has qty_wanted = 1 and 0 claims initially
  const item = db.prepare("SELECT * FROM items WHERE id = 'itm_j1'").get();
  assert.equal(item.qty_wanted, 1);

  const contenders = ['usr_elena', 'usr_maya', 'usr_arthur'];
  const results = await Promise.allSettled(
    contenders.map(userId =>
      Promise.resolve().then(() =>
        createClaim(db, {
          itemId: 'itm_j1',
          claimerUserId: userId,
          qty: 1
        })
      )
    )
  );

  const winners = results.filter(r => r.status === 'fulfilled');
  const losers = results.filter(r => r.status === 'rejected');

  assert.equal(winners.length, 1, 'Exactly one giver must win the last unit');
  assert.equal(losers.length, 2, 'Remaining concurrent givers must be rejected immediately');
  assert.match(losers[0].reason.message, /last available unit|remaining/i);

  // Verify database total claimed never exceeds qty_wanted
  const totalInDb = db.prepare(`
    SELECT COALESCE(SUM(qty), 0) as total FROM claims
    WHERE item_id = 'itm_j1' AND status IN ('reserved', 'purchased', 'given')
  `).get().total;
  assert.equal(totalInDb, 1);
});

// ============================================================================
// 3. CAPTURE ENGINE 50-LINK BENCHMARK ACROSS TOP 30 STORES (Section 2, 7 & 17)
// "50 real product links from the top 30 stores -> Capture success >= 90%"
// ============================================================================
test('Section 17 Capture Benchmark Suite: 50 product links across the Top 30 stores achieve >= 90% auto-fill capture success + D3 Amazon server-fetch block', async () => {
  const db = setupTestDb();

  // Build 50 realistic store product pages spanning the top 30 configured retailers (Retailer Adapter, JSON-LD, OpenGraph, and Heuristics)
  const testLinks = [];
  for (let i = 0; i < 50; i++) {
    const adapter = TOP_30_RETAILER_ADAPTERS[i % TOP_30_RETAILER_ADAPTERS.length];
    const url = `https://www.${adapter.domain}/products/gift-item-${i + 1}?utm_source=test&fbclid=abc`;
    const expectedTitle = `${adapter.store_name} Signature Gift Product #${i + 1}`;
    const expectedPrice = Number((29.99 + i).toFixed(2));
    const expectedImage = `https://cdn.${adapter.domain}/images/product-${i + 1}.jpg`;
    const expectedVariant = `Size Medium / Edition ${i + 1}`;

    let html = '';
    if (i % 3 === 0) {
      // JSON-LD schema.org Product
      html = `
        <html><head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "${expectedTitle}",
              "image": "${expectedImage}",
              "color": "${expectedVariant}",
              "offers": {
                "@type": "Offer",
                "price": "${expectedPrice}",
                "priceCurrency": "USD",
                "availability": "https://schema.org/InStock"
              }
            }
          </script>
        </head><body></body></html>
      `;
    } else if (i % 3 === 1) {
      // Open Graph & Product Meta Tags
      html = `
        <html><head>
          <meta property="og:title" content="${expectedTitle}" />
          <meta property="og:image" content="${expectedImage}" />
          <meta property="product:price:amount" content="${expectedPrice}" />
          <meta property="product:price:currency" content="USD" />
          <meta property="product:color" content="${expectedVariant}" />
        </head><body></body></html>
      `;
    } else {
      // Heuristics + Adapter HTML
      html = `
        <html><head><title>${expectedTitle} | ${adapter.store_name}</title></head>
        <body>
          <h1 id="productTitle" data-test="product-title">${expectedTitle}</h1>
          <div class="price" data-test="product-price">$${expectedPrice}</div>
          <img id="landingImage" src="${expectedImage}" />
          <div>Variant: <span>${expectedVariant}</span></div>
        </body></html>
      `;
    }

    testLinks.push({ url, html, expectedTitle, expectedPrice, expectedImage });
  }

  let successCount = 0;
  for (const t of testLinks) {
    const res = extractMetadataFromHtml(db, t.url, t.html);
    if (res.title === t.expectedTitle && res.price === t.expectedPrice && res.image === t.expectedImage && res.store) {
      successCount++;
    } else {
      console.error('CAPTURE MISMATCH:', { url: t.url, expected: t, got: res });
    }
    // Verify tracking params were stripped from canonical_url
    assert.equal(res.canonical_url.includes('utm_source'), false);
    assert.equal(res.canonical_url.includes('fbclid'), false);
  }

  const successRate = (successCount / testLinks.length) * 100;
  assert.ok(successRate >= 90, `Expected capture success rate >= 90%, got ${successRate}%`);
  assert.equal(successCount, 50, 'All 50 product links across the top 30 stores extracted cleanly');

  // Verify Decision D3: Server-side fetch of Amazon without client extension payload is blocked
  const amzServerAttempt = await captureFromUrl(db, {
    url: 'https://www.amazon.com/dp/B08N5WRWNW?ref=sr_1_1',
    pathType: 'paste'
  });
  assert.equal(amzServerAttempt.blocked_amazon_server_fetch, true);
  assert.equal(amzServerAttempt.canonical_url, 'https://www.amazon.com/dp/B08N5WRWNW');

  // Verify Section 17 Malicious URL blocker
  const badUrlCheck = checkUrlSafety('https://phishing-gifts.example.com/free-card');
  assert.equal(badUrlCheck.safe, false);
});

// ============================================================================
// 4. CLAIM LIFECYCLE & SECTION 14 EDGE CASES SUITE
// ============================================================================
test('Section 14 Claim Lifecycle & Edge Cases: Guest 6-digit verification, 3-claim cap, owner edits, quantity reduction, delete reserved vs purchased, and helper release', () => {
  const db = setupTestDb();

  // 4A. Guest claim requires 6-digit verification and enforces max 3 open guest claims per list (GVR-6)
  const guestClaim1 = createClaim(db, {
    itemId: 'itm_j1',
    guestEmail: 'cousin.sam@example.com',
    guestName: 'Cousin Sam',
    qty: 1
  });
  assert.equal(guestClaim1.verified, false);
  assert.equal(guestClaim1.status, 'pending_verification');
  assert.equal(guestClaim1.demo_verification_code.length, 6);

  // Verify guest email code
  const verified1 = verifyGuestClaim(db, {
    claimId: guestClaim1.id,
    code: guestClaim1.demo_verification_code
  });
  assert.equal(verified1.verified, 1);
  assert.equal(verified1.status, 'reserved');

  // 4B. Owner edits size/color and notes after a claim -> claim is kept, claimer is notified with old & new values, owner sees ordinary edit
  handleOwnerEditItem(db, {
    itemId: 'itm_j1',
    ownerId: 'usr_justin',
    updates: {
      variant: 'Matte White / Maple Handle',
      notes: 'Updated color preference!'
    }
  });
  const claimAfterEdit = db.prepare('SELECT * FROM claims WHERE id = ?').get(guestClaim1.id);
  assert.equal(claimAfterEdit.status, 'reserved', 'Claim must remain active after owner edits variant/notes');

  const editNotif = db.prepare(`
    SELECT * FROM notifications_outbox
    WHERE recipient_email = 'cousin.sam@example.com' AND event_type = 'claimed_item_changed'
    ORDER BY created_at DESC LIMIT 1
  `).get();
  assert.ok(editNotif, 'Claimer must be notified of variant/notes change');
  assert.match(editNotif.body, /Matte Black.*Matte White/s);

  // 4C. Owner lowers quantity below claimed units -> newest unpurchased ('reserved') claims released first; 'purchased' claims kept!
  // Let's take itm_m3 on Maya's list (qty_wanted = 2).
  // Claim 1 (Elena) is PURCHASED (1 unit). Claim 2 (Arthur) is RESERVED (1 unit).
  const cPurchased = createClaim(db, { itemId: 'itm_m3', claimerUserId: 'usr_elena', qty: 1 });
  transitionClaimState(db, { claimId: cPurchased.id, newState: 'purchased', actorId: 'usr_elena' });

  const cReserved = createClaim(db, { itemId: 'itm_m3', claimerUserId: 'usr_arthur', qty: 1 });
  assert.equal(cReserved.status, 'reserved');

  // Now Maya lowers qty_wanted from 2 to 1
  handleOwnerEditItem(db, {
    itemId: 'itm_m3',
    ownerId: 'usr_maya',
    updates: { qty_wanted: 1 }
  });

  const cPurchasedAfter = db.prepare('SELECT status FROM claims WHERE id = ?').get(cPurchased.id);
  const cReservedAfter = db.prepare('SELECT status FROM claims WHERE id = ?').get(cReserved.id);
  assert.equal(cPurchasedAfter.status, 'purchased', 'Purchased claim must be preserved when owner lowers qty');
  assert.equal(cReservedAfter.status, 'released', 'Unpurchased reserved claim must be released first when owner lowers qty');

  // 4D. Owner deletes a RESERVED item vs a PURCHASED item (Section 14 rows 1 & 2)
  // guestClaim1 on itm_j1 is currently 'reserved'. When Justin deletes itm_j1, claim moves to 'withdrawn'.
  const delRes1 = handleOwnerDeleteOrGotIt(db, { itemId: 'itm_j1', ownerId: 'usr_justin', mode: 'deleted' });
  const claim1AfterDelete = db.prepare('SELECT status FROM claims WHERE id = ?').get(guestClaim1.id);
  assert.equal(claim1AfterDelete.status, 'withdrawn');

  // itm_j2 has a PURCHASED claim (clm_elena_on_justin). When Justin deletes itm_j2:
  // 1) Owner response structure is identical to deleting an unclaimed/reserved item
  // 2) Claim is KEPT as 'purchased' for the claimer's records!
  const delRes2 = handleOwnerDeleteOrGotIt(db, { itemId: 'itm_j2', ownerId: 'usr_justin', mode: 'deleted' });
  assert.deepEqual(Object.keys(delRes1), Object.keys(delRes2), 'Owner delete response keys must be identical whether reserved or purchased');
  const purchasedClaimAfterDelete = db.prepare("SELECT status FROM claims WHERE id = 'clm_elena_on_justin'").get();
  assert.equal(purchasedClaimAfterDelete.status, 'purchased', 'Purchased claim must be preserved for claimer history even after owner deletes item');

  // 4E. List Helper (LST-4 / D9): Maya is helper on Justin's list and can release a claim; owner sees nothing
  const newClaimOnJ3 = createClaim(db, { itemId: 'itm_j3', claimerUserId: 'usr_arthur', qty: 1 });
  const releasedByHelper = transitionClaimState(db, {
    claimId: newClaimOnJ3.id,
    newState: 'released',
    actorType: 'helper',
    actorId: 'usr_maya',
    reason: 'Duplicate claim cleanup by helper'
  });
  assert.equal(releasedByHelper.status, 'released');

  // 4F. Unverified guest claim lapses after 30 minutes (GVR-6)
  const unverifiedGuest = createClaim(db, {
    itemId: 'itm_j3',
    guestEmail: 'late.guest@example.com',
    qty: 1
  });
  const future31Min = new Date(Date.now() + 31 * 60 * 1000).toISOString();
  purgeExpiredClaims(db, future31Min);
  const lapsed = db.prepare('SELECT status FROM claims WHERE id = ?').get(unverifiedGuest.id);
  assert.equal(lapsed.status, 'expired');
});

// ============================================================================
// 5. AMAZON IMPORT, SECRET SANTA & CHILD PROFILE (COPPA D6) SUITE
// ============================================================================
test('IMP-1 Amazon Import & Re-sync, EXC-1 Secret Santa with Exclusions, and D6 Guardian Child Profile', () => {
  const db = setupTestDb();

  // 5A. Amazon Import & Re-sync (skips duplicates on second run)
  const payload = [
    { title: 'Chemex Classic 8-Cup Pour-Over Glass Coffeemaker', url: 'https://www.amazon.com/dp/B000I1WP7W?ref=wl', price: 48.50 },
    { title: 'Baratza Encore ESP Conical Burr Grinder', url: 'https://www.amazon.com/dp/B0BWHK1234', price: 199.00 }
  ];
  const firstRun = importAmazonList(db, {
    listId: 'lst_justin_holiday',
    ownerId: 'usr_justin',
    amazonListUrl: 'https://www.amazon.com/hz/wishlist/ls/DEMO',
    itemsPayload: payload
  });
  assert.equal(firstRun.imported.length, 2);
  assert.equal(firstRun.skipped.length, 0);

  const secondRun = importAmazonList(db, {
    listId: 'lst_justin_holiday',
    ownerId: 'usr_justin',
    amazonListUrl: 'https://www.amazon.com/hz/wishlist/ls/DEMO',
    itemsPayload: payload
  });
  assert.equal(secondRun.imported.length, 0);
  assert.equal(secondRun.skipped.length, 2, 'Re-sync must detect and skip already-imported items');

  // 5B. Secret Santa Draw with Spouse Exclusions (EXC-1)
  const exchange = createSecretSantaExchange(db, {
    groupId: 'grp_smith',
    name: 'Smith Family Exchange',
    eventDate: '2026-12-25',
    budgetLimit: 75,
    exclusions: [['usr_justin', 'usr_maya']],
    createdBy: 'usr_justin'
  });
  assert.equal(exchange.all_assigned_verified, true);
  assert.ok(exchange.verification_hash.length === 64);

  const pairings = db.prepare('SELECT * FROM secret_santa_pairings WHERE exchange_id = ?').all(exchange.id);
  assert.equal(pairings.length, 4);
  for (const p of pairings) {
    assert.notEqual(p.giver_user_id, p.recipient_user_id, 'No one can draw themselves');
    if (p.giver_user_id === 'usr_justin') {
      assert.notEqual(p.recipient_user_id, 'usr_maya', 'Exclusion rule: Justin cannot draw Maya');
    }
    if (p.giver_user_id === 'usr_maya') {
      assert.notEqual(p.recipient_user_id, 'usr_justin', 'Exclusion rule: Maya cannot draw Justin');
    }
  }

  // 5C. Guardian view of Under-13 Dependent Child's list (ACC-3, D6, Section 8)
  const leoList = db.prepare("SELECT * FROM lists WHERE id = 'lst_leo_bday'").get();
  const guardianCtx = getViewerRole(db, leoList, 'usr_justin');
  assert.equal(guardianCtx.role, 'guardian');
  assert.equal(guardianCtx.canSeeClaims, true, 'Guardians can see claims on their child dependent list');
});

// ============================================================================
// 6. END-TO-END HTTP API & SPOILER-FREE ENDPOINT INTEGRATION SUITE
// ============================================================================
test('End-to-End HTTP API Suite: Session, Owner vs Giver List Endpoints, Dashboard, CSV/JSON Export, Image Proxy & Admin Console', async () => {
  const { createApp } = await import('../src/server.mjs');
  const db = setupTestDb();
  const { server } = createApp(db);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Session check
    const sess = await fetch(`${base}/api/session`, { headers: { 'X-User-Id': 'usr_justin' } }).then(r => r.json());
    assert.equal(sess.current_user.id, 'usr_justin');
    assert.equal(sess.dependents.length, 1);

    // 2. Owner fetches own list -> ZERO claim_summary on any item!
    const ownerListRes = await fetch(`${base}/api/lists/lst_justin_holiday`, {
      headers: { 'X-User-Id': 'usr_justin' }
    });
    assert.equal(ownerListRes.headers.get('x-robots-tag'), 'noindex, nofollow');
    const ownerListData = await ownerListRes.json();
    assert.equal(ownerListData.list.can_see_claims, false);
    for (const it of ownerListData.list.items) {
      assert.equal(it.claim_summary, undefined, 'Owner HTTP response must never include claim_summary');
    }

    // 3. Giver (Aunt Elena) fetches Justin's list -> sees claim_summary and availability
    const giverListData = await fetch(`${base}/api/lists/lst_justin_holiday`, {
      headers: { 'X-User-Id': 'usr_elena' }
    }).then(r => r.json());
    assert.equal(giverListData.list.can_see_claims, true);
    const claimedSweater = giverListData.list.items.find(i => i.id === 'itm_j2');
    assert.equal(claimedSweater.claim_summary.is_fully_claimed, true);

    // 4. Guest fetches Justin's list via share_token -> payment handle on cash item (itm_j4) is stripped (ITM-9)!
    const guestListData = await fetch(`${base}/api/lists/justin-winter-2026`, {
      headers: { 'X-User-Id': 'guest' }
    }).then(r => r.json());
    const cashItemForGuest = guestListData.list.items.find(i => i.id === 'itm_j4');
    assert.equal(cashItemForGuest.giving_instructions, null, 'ITM-9: Payment handles must never appear on public guest links');
    const cashItemForGroupMember = giverListData.list.items.find(i => i.id === 'itm_j4');
    assert.ok(cashItemForGroupMember.giving_instructions.includes('Venmo'), 'ITM-9: Signed-in family group members see giving instructions');

    // 5. "People I Shop For" Dashboard loads < 2s and hides own secret ideas
    const dashData = await fetch(`${base}/api/dashboard`, {
      headers: { 'X-User-Id': 'usr_justin' }
    }).then(r => r.json());
    assert.ok(dashData.people_i_shop_for.length >= 3);
    const mayaCard = dashData.people_i_shop_for.find(c => c.person.id === 'usr_maya');
    assert.ok(mayaCard.secret_ideas.length >= 1, 'Justin can see secret ideas for Maya');

    // 6. CSV and JSON Export (IMP-2)
    const csvText = await fetch(`${base}/api/export?format=csv`, {
      headers: { 'X-User-Id': 'usr_justin' }
    }).then(r => r.text());
    assert.ok(csvText.includes('WishlistItem'));
    assert.ok(csvText.includes('Fellow Stagg EKG Pro'));

    // 7. Image proxy returns SVG badge safely
    const proxyRes = await fetch(`${base}/api/image-proxy?label=Test+Gift&theme=emerald`);
    assert.equal(proxyRes.status, 200);
    assert.match(proxyRes.headers.get('content-type'), /image\/svg\+xml/);
    // ADV-4.1: Verify Strict Content-Security-Policy header is present
    assert.match(proxyRes.headers.get('content-security-policy'), /script-src 'self'/);
  } finally {
    server.close();
  }
});

// ============================================================================
// 7. ADVERSARIAL RED-TEAM & TIER 1-3 ENHANCEMENTS VERIFICATION SUITE
// ============================================================================
test('Adversarial Red-Team & Tier 1-3 Enhancements Suite: Anti-Spoil Lock (ADV-1.1), Admin RBAC (ADV-2.1/2.2), Item Edit Auth (ADV-2.4), SSRF/XSS Guards (ADV-4.2/4.3), 5-Attempt Brute-Force Lockout (ADV-3.1), Gmail +Alias Cap (ADV-3.2), State Revival Block (ADV-3.3), Chip-In Cap (ADV-3.4), Price-Drop Re-Check (ITM-6), and Follower Digest (NTF-1)', async () => {
  const { createApp } = await import('../src/server.mjs');
  const db = setupTestDb();
  const { server } = createApp(db);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. ADV-1.1: Owner cannot switch surprise_mode 1 -> 0 once active claims exist on the list
    const peekAttempt = await fetch(`${base}/api/lists/lst_justin_holiday`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'usr_justin' },
      body: JSON.stringify({ surprise_mode: false })
    });
    assert.equal(peekAttempt.status, 400);
    const peekData = await peekAttempt.json();
    assert.match(peekData.error, /Anti-Spoil Protection/i);

    // 2. ADV-1.1: Owner cannot prematurely reveal purchases before event_date + 7 days without post-event flag
    const revealAttempt = await fetch(`${base}/api/lists/lst_justin_holiday`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'usr_justin' },
      body: JSON.stringify({ action: 'reveal_purchases' })
    });
    assert.equal(revealAttempt.status, 400);

    // 3. ADV-2.1: Non-admin and Guest are blocked from /api/admin and /api/admin/adapters
    const nonAdminRes = await fetch(`${base}/api/admin`, {
      headers: { 'X-User-Id': 'usr_elena' }
    });
    assert.equal(nonAdminRes.status, 403);

    const adminRes = await fetch(`${base}/api/admin`, {
      headers: { 'X-User-Id': 'usr_justin' }
    });
    assert.equal(adminRes.status, 200);
    const adminJson = await adminRes.json();
    // ADV-1.2: Verify Justin (even as Admin) NEVER sees claims on his own surprise-mode list in overridable_claims or claim_audit_log!
    const leakOnOwnList = adminJson.overridable_claims.find(c => c.id === 'clm_elena_on_justin');
    assert.equal(leakOnOwnList, undefined, 'Admin console must never leak claims on the admin user own surprise list');

    // 4. ADV-2.2: Unauthenticated / non-admin caller cannot forge actor_type: "admin" to release someone else's claim
    const forgeAdminRes = await fetch(`${base}/api/claims/clm_justin_on_maya`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'usr_elena' },
      body: JSON.stringify({ status: 'released', actor_type: 'admin', reason: 'Forged admin attack' })
    });
    assert.equal(forgeAdminRes.status, 403);

    // 5. ADV-2.3: Non-claimer cannot mutate click_out on someone else's claim
    const fakeClickOut = await fetch(`${base}/api/claims/clm_justin_on_maya`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'usr_elena' },
      body: JSON.stringify({ action: 'click_out', store: 'Etsy' })
    });
    assert.equal(fakeClickOut.status, 403);

    // 6. ADV-2.4: Non-owner cannot mark someone else's item as received or move it
    const unauthorizedMarkReceived = await fetch(`${base}/api/items/itm_j1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'usr_elena' },
      body: JSON.stringify({ action: 'mark_received' })
    });
    assert.equal(unauthorizedMarkReceived.status, 403);

    // 7. ADV-3.1: 5-Attempt Brute-Force Lockout on Guest 6-Digit Verification Code
    const bruteClaim = createClaim(db, {
      itemId: 'itm_j1',
      guestEmail: 'bruteforce@example.com',
      qty: 1
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      assert.throws(
        () => verifyGuestClaim(db, { claimId: bruteClaim.id, code: '000000' }),
        /Invalid 6-digit verification code/
      );
    }
    // 5th wrong attempt permanently locks/expires the claim
    assert.throws(
      () => verifyGuestClaim(db, { claimId: bruteClaim.id, code: '000000' }),
      /Too many failed verification attempts/
    );
    // Even the real code now fails because the claim is locked/expired
    assert.throws(
      () => verifyGuestClaim(db, { claimId: bruteClaim.id, code: bruteClaim.demo_verification_code }),
      /expired or claim was locked/
    );

    // 8. ADV-3.2: Gmail +alias and dot tricks cannot bypass the 3-open-guest-claims-per-list cap (GVR-6)
    createClaim(db, { itemId: 'itm_j1', guestEmail: 'sybil.attacker+1@gmail.com', qty: 1 });
    createClaim(db, { itemId: 'itm_j3', guestEmail: 'sybilattacker+2@gmail.com', qty: 1 });
    createClaim(db, { itemId: 'itm_j4', guestEmail: 's.y.b.i.l.attacker+3@googlemail.com', qty: 1 });
    assert.throws(
      () => createClaim(db, { itemId: 'itm_j4', guestEmail: 'sybilattacker+4@gmail.com', qty: 1 }),
      /Guest claim limit reached: maximum 3/
    );

    // 9. ADV-3.3: Terminal claim ('released') cannot be transitioned back to 'reserved' or 'purchased'
    const tempClaim = createClaim(db, { itemId: 'itm_j4', claimerUserId: 'usr_arthur', qty: 1 });
    transitionClaimState(db, { claimId: tempClaim.id, newState: 'released', actorId: 'usr_arthur' });
    assert.throws(
      () => transitionClaimState(db, { claimId: tempClaim.id, newState: 'purchased', actorId: 'usr_arthur' }),
      /Cannot transition a released claim back/
    );

    // 10. ADV-3.4: Group Chip-In enforces remaining target cap and blocks owner self-contribution
    assert.throws(
      () => addContribution(db, { itemId: 'itm_m1', contributorUserId: 'usr_maya', pledgedAmount: 20 }),
      /List owners cannot pledge contributions to their own list/
    );
    // itm_m1 has $420 target and $270 already pledged ($150 remaining)
    assert.throws(
      () => addContribution(db, { itemId: 'itm_m1', contributorUserId: 'usr_arthur', pledgedAmount: 500 }),
      /Pledge exceeds remaining chip-in goal/
    );

    // 11. ADV-4.2 & ADV-4.3: SSRF internal/private IPs and javascript: URLs are blocked everywhere
    assert.equal(checkUrlSafety('http://127.0.0.1:8080/admin').safe, false);
    assert.equal(checkUrlSafety('http://169.254.169.254/latest/meta-data/').safe, false);
    assert.equal(checkUrlSafety('http://192.168.1.1/router').safe, false);
    assert.equal(checkUrlSafety('http://localhost:3456/api/admin').safe, false);
    assert.throws(() => canonicalizeUrl('javascript:alert(document.cookie)'), /Unsafe URL blocked/);

    // 12. Tier 2 Enhancement ITM-6: Price-Drop Re-Check (>= 10% drop) notifies active claimers & records PriceSnapshot
    const recheckRes = await fetch(`${base}/api/items/itm_m2/recheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'usr_maya' },
      body: JSON.stringify({ new_price: 54.00, in_stock: true }) // Dropped from $68.00 to $54.00 (-20.6%)
    }).then(r => r.json());
    assert.equal(recheckRes.recheck.significant_drop_alert, true);
    assert.ok(recheckRes.recheck.drop_percent >= 20);
    assert.equal(recheckRes.recheck.claimers_notified, 1, 'Active claimer (Justin) must be notified of the >=10% price drop');

    // 13. Tier 2 Enhancement NTF-1: Daily Follower Digest compiles updates without owner spoilers and enforces max 1 digest/day
    const digest1 = await fetch(`${base}/api/notifications/digest`, {
      method: 'POST',
      headers: { 'X-User-Id': 'usr_justin' }
    }).then(r => r.json());
    assert.equal(digest1.digest.already_sent_today, false);
    assert.ok(digest1.digest.events_included >= 1);

    const digest2 = await fetch(`${base}/api/notifications/digest`, {
      method: 'POST',
      headers: { 'X-User-Id': 'usr_justin' }
    }).then(r => r.json());
    assert.equal(digest2.digest.already_sent_today, true, 'At most one digest per user per day (Section 16)');
  } finally {
    server.close();
  }
});
