import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, testDb } from './helpers.mjs';
import {
  createClaim, verifyGuestClaim, transitionClaimState, handleOwnerEditItem, handleOwnerDeleteOrGotIt,
  purgeExpiredClaims, addContribution, normalizeEmailForCap
} from '../src/services/claims.mjs';
import { createSecretSantaExchange } from '../src/services/secret-santa.mjs';
import { importAmazonList } from '../src/services/capture.mjs';

test('the last unit goes to exactly one giver', () => {
  const db = testDb();
  // node:sqlite is synchronous on a single connection, so these run one after
  // another; what this proves is that the check and the insert are one unit.
  const results = ['usr_elena', 'usr_maya', 'usr_arthur'].map(userId => {
    try { return createClaim(db, { itemId: 'itm_j1', claimerUserId: userId }); } catch (err) { return err; }
  });
  assert.equal(results.filter(r => !(r instanceof Error)).length, 1);
  assert.equal(results.filter(r => r instanceof Error && r.status === 409).length, 2);
  assert.equal(db.prepare("SELECT COALESCE(SUM(qty),0) AS n FROM claims WHERE item_id = 'itm_j1' AND status = 'reserved'").get().n, 1);
});

test('quantities must be whole numbers in range', () => {
  const db = testDb();
  for (const qty of [1.5, 0, -1, 1e999, 'two', 1e17]) {
    assert.throws(() => createClaim(db, { itemId: 'itm_m3', claimerUserId: 'usr_elena', qty }), /whole number/, String(qty));
  }
  assert.equal(createClaim(db, { itemId: 'itm_m3', claimerUserId: 'usr_elena', qty: 2 }).qty, 2);
});

test('guest claims: nothing is held, and nothing is disclosed, until the code is entered', async () => {
  const app = await startApp();
  try {
    const created = await app.guest.post('/api/claims', { item_id: 'itm_j1', guest_email: 'Cousin.Sam@example.com', guest_name: 'Sam' });
    assert.equal(created.status, 201);
    assert.equal(created.json.claim.status, 'pending_verification');
    assert.equal(created.json.claim.manage_token, undefined, 'no manage token before verification');
    assert.match(created.json.claim.demo_verification_code, /^\d{6}$/, 'demo mode shows the code in place of an email');

    // The item is still available to others while unverified.
    const elena = await app.as('usr_elena');
    const item = (await elena.get('/api/lists/lst_justin_holiday')).json.list.items.find(i => i.id === 'itm_j1');
    assert.equal(item.claim_summary.qty_claimed, 0);

    // Guests cannot read the outbox, by any parameter.
    for (const path of ['/api/notifications', '/api/notifications?email=cousin.sam@example.com', '/api/notifications?guestToken=%25']) {
      assert.deepEqual((await app.guest.get(path)).json.notifications, [], path);
    }
    assert.deepEqual((await app.guest.withHeaders({ 'X-Guest-Token': '%' }).get('/api/notifications')).json.notifications, []);

    const wrong = await app.guest.post('/api/claims/verify', { claim_id: created.json.claim.id, code: '000000' });
    assert.equal(wrong.status, 400);
    const verified = await app.guest.post('/api/claims/verify', { claim_id: created.json.claim.id, code: created.json.claim.demo_verification_code });
    assert.equal(verified.json.claim.status, 'reserved');
    const token = verified.json.claim.manage_token;
    assert.match(token, /^mng_.{30,}/);

    // Verifying again, or "verifying" someone else's claim, returns nothing.
    for (const claim_id of [created.json.claim.id, 'clm_elena_on_justin', 'clm_nope']) {
      const again = await app.guest.post('/api/claims/verify', { claim_id });
      assert.equal(again.status, 400, claim_id);
      assert.equal(again.json.claim, undefined);
      assert.ok(!JSON.stringify(again.json).includes('mng_'));
    }

    // The manage token works for this guest claim…
    const me = app.guest.withHeaders({ 'X-Guest-Token': token });
    const mine = (await me.get('/api/lists/justin-winter-2026')).json.list.items.find(i => i.id === 'itm_j1').claim_summary.claims[0];
    assert.equal(mine.is_own_claim, true);
    assert.equal((await me.patch(`/api/claims/${mine.id}`, { status: 'purchased' })).json.claim.status, 'purchased');
    // …and never for a member's claim, even with that claim's real token.
    const seedToken = app.db.prepare("SELECT manage_token FROM claims WHERE id = 'clm_elena_on_justin'").get().manage_token;
    const hijack = await app.guest.withHeaders({ 'X-Guest-Token': seedToken }).patch('/api/claims/clm_elena_on_justin', { status: 'released' });
    assert.equal(hijack.status, 403);

    // Another guest sees "taken", no name, no id.
    const other = (await app.guest.get('/api/lists/justin-winter-2026')).json.list.items.find(i => i.id === 'itm_j1').claim_summary.claims[0];
    assert.deepEqual([other.status, other.claimer_display, other.id], ['taken', 'Someone', undefined]);
  } finally { await app.close(); }
});

test('five wrong codes cancel a guest claim; unverified claims lapse after 30 minutes', () => {
  const db = testDb();
  const claim = createClaim(db, { itemId: 'itm_j1', guestEmail: 'brute@example.com' });
  for (let i = 0; i < 4; i++) assert.throws(() => verifyGuestClaim(db, { claimId: claim.id, code: '000000' }), /not right/);
  assert.throws(() => verifyGuestClaim(db, { claimId: claim.id, code: '000000' }), /Too many wrong codes/);
  assert.throws(() => verifyGuestClaim(db, { claimId: claim.id, code: claim.verification_code }), /window has passed/);

  const late = createClaim(db, { itemId: 'itm_j3', guestEmail: 'late@example.com' });
  purgeExpiredClaims(db, new Date(Date.now() + 31 * 60 * 1000).toISOString());
  assert.equal(db.prepare('SELECT status FROM claims WHERE id = ?').get(late.id).status, 'expired');
});

test('guest cap: aliases count as one person, "given" still counts, pending requests cannot lock out the real owner', () => {
  const db = testDb();
  assert.equal(normalizeEmailForCap('S.y.b.i.l+3@GoogleMail.com'), 'sybil@gmail.com');
  const hold = (itemId, email) => {
    const c = createClaim(db, { itemId, guestEmail: email });
    return verifyGuestClaim(db, { claimId: c.id, code: c.verification_code });
  };
  const first = hold('itm_j1', 'sybil+1@gmail.com');
  hold('itm_j3', 's.ybil@gmail.com');
  hold('itm_j4', 'sybil@googlemail.com');
  // Advancing a claim to "given" does not free a slot.
  db.prepare("UPDATE claims SET status = 'given' WHERE id = ?").run(first.id);
  assert.throws(() => createClaim(db, { itemId: 'itm_j4', guestEmail: 'sy.bil+9@gmail.com' }), /up to 3 items/);

  // An attacker filing unverified requests under someone's address only evicts their own stale ones.
  for (let i = 0; i < 6; i++) createClaim(db, { itemId: 'itm_m3', guestEmail: `Victim+${i}@example.com` });
  const real = createClaim(db, { itemId: 'itm_m3', guestEmail: 'victim@example.com' });
  assert.equal(real.status, 'pending_verification');
});

test('state machine: only real transitions, only by the claimer; helpers and guardians can release and nothing else', async () => {
  const db = testDb();
  const c = createClaim(db, { itemId: 'itm_j3', claimerUserId: 'usr_arthur' });
  const move = (newState, actorId = 'usr_arthur', extra = {}) => transitionClaimState(db, { claimId: c.id, newState, actorId, ...extra });

  assert.throws(() => move('given'), /cannot be changed/, 'reserved → given skips a step');
  assert.throws(() => move('bogus'), /cannot be changed/);
  assert.equal(move('purchased').status, 'purchased');
  assert.equal(move('given').status, 'given');
  assert.throws(() => move('reserved'), /cannot be changed/);
  assert.equal(move('purchased').status, 'purchased', 'undo of an accidental "given"');

  // Maya is helper on Justin's list.
  assert.throws(() => move('given', 'usr_maya', { orderNote: 'rewritten' }), /only release/);
  assert.throws(() => move('released', 'usr_elena'), /cannot change/);
  const released = move('released', 'usr_maya', { orderNote: 'rewritten', reason: 'Duplicate' });
  assert.equal(released.status, 'released');
  assert.equal(released.order_note, null, "a helper cannot rewrite the giver's note");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications_outbox WHERE recipient_user_id = 'usr_arthur' AND event_type = 'claimed_item_changed'").get().n, 1);
  assert.throws(() => move('purchased'), /closed/);
  assert.throws(() => move('released'), /closed/);

  // A hold that has run out cannot be confirmed just because nobody looked.
  const stale = createClaim(db, { itemId: 'itm_j1', claimerUserId: 'usr_elena' });
  db.prepare('UPDATE claims SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', stale.id);
  assert.throws(() => transitionClaimState(db, { claimId: stale.id, newState: 'purchased', actorId: 'usr_elena' }), /closed/);
});

test('owner edits: notes diff reaches the giver, lowering quantity or ending "always wanted" releases newest holds first', () => {
  const db = testDb();
  const bought = createClaim(db, { itemId: 'itm_m3', claimerUserId: 'usr_elena' });
  transitionClaimState(db, { claimId: bought.id, newState: 'purchased', actorId: 'usr_elena' });
  const held = createClaim(db, { itemId: 'itm_m3', claimerUserId: 'usr_arthur' });

  handleOwnerEditItem(db, { itemId: 'itm_m3', ownerId: 'usr_maya', updates: { qty_wanted: 1, variant: 'Signed edition' } });
  const status = (id) => db.prepare('SELECT status FROM claims WHERE id = ?').get(id).status;
  assert.equal(status(bought.id), 'purchased');
  assert.equal(status(held.id), 'released');
  assert.match(db.prepare("SELECT body FROM notifications_outbox WHERE recipient_user_id = 'usr_elena' AND event_type = 'claimed_item_changed'").get().body, /Hardcover or Signed Edition.*Signed edition/s);

  // itm_j4 is "always wanted": three people hold it, then the owner sets a limit of 1.
  const a = createClaim(db, { itemId: 'itm_j4', claimerUserId: 'usr_elena' });
  const b = createClaim(db, { itemId: 'itm_j4', claimerUserId: 'usr_maya' });
  const c = createClaim(db, { itemId: 'itm_j4', claimerUserId: 'usr_arthur' });
  handleOwnerEditItem(db, { itemId: 'itm_j4', ownerId: 'usr_justin', updates: { always_wanted: false } });
  assert.deepEqual([a, b, c].map(x => status(x.id)).sort(), ['released', 'released', 'reserved']);

  // Validation on the edit path.
  const edit = (updates) => handleOwnerEditItem(db, { itemId: 'itm_j1', ownerId: 'usr_justin', updates });
  assert.equal(edit({ price: null }).price, null, 'a blank price is "no price", not $0');
  assert.equal(edit({ price: '' }).price, null);
  assert.throws(() => edit({ price: 'abc' }), /valid price/);
  assert.throws(() => edit({ price: -5 }), /valid price/);
  assert.throws(() => edit({ title: '   ' }), /title/);
  assert.equal(edit({ title: '&lt;b&gt;Kettle&lt;/b&gt;', priority: 'urgent!!', qty_wanted: 1e17 }).title, 'Kettle');
  assert.equal(db.prepare("SELECT priority, qty_wanted FROM items WHERE id = 'itm_j1'").get().qty_wanted, 999);
  assert.throws(() => handleOwnerEditItem(db, { itemId: 'itm_j1', ownerId: 'usr_elena', updates: { title: 'x' } }), /cannot change/);
});

test('delete / got-it is idempotent, withdraws holds and pledges, keeps purchases; received items stay received', async () => {
  const app = await startApp();
  try {
    const maya = await app.as('usr_maya');
    const first = await maya.del('/api/items/itm_m1');   // has $270 of pledges
    const second = await maya.del('/api/items/itm_m1');
    assert.deepEqual(first.json, second.json);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM contributions WHERE item_id = 'itm_m1' AND status = 'pledged'").get().n, 0);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM notifications_outbox WHERE recipient_user_id = 'usr_justin' AND subject LIKE '%Le Creuset%'").get().n, 1, 'told once, not once per click');

    await maya.del('/api/items/itm_m2');                 // Justin already bought this one
    assert.equal(app.db.prepare("SELECT status FROM claims WHERE id = 'clm_justin_on_maya'").get().status, 'purchased');
    await maya.patch('/api/items/itm_m2', { action: 'mark_received' });
    assert.equal(app.db.prepare("SELECT status FROM items WHERE id = 'itm_m2'").get().status, 'deleted', 'a deleted item is not resurrected');
  } finally { await app.close(); }
});

test('chip-in: members only, needs a price, capped at what is still needed, can be withdrawn', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.guest.post('/api/contributions', { item_id: 'itm_m1', pledged_amount: 150, guest_email: 'x@x.xx' })).status, 401);
    const arthur = await app.as('usr_arthur');
    assert.equal((await arthur.post('/api/contributions', { item_id: 'itm_m1', pledged_amount: 500 })).status, 409);
    for (const pledged_amount of [0, -5, 1e300, 'lots']) {
      assert.equal((await arthur.post('/api/contributions', { item_id: 'itm_m1', pledged_amount })).status, 400, String(pledged_amount));
    }
    const pledge = await arthur.post('/api/contributions', { item_id: 'itm_m1', pledged_amount: 50 });
    assert.equal(pledge.status, 201);
    assert.equal((await arthur.del(`/api/contributions/${pledge.json.contribution.id}`)).json.status, 'withdrawn');

    const maya = await app.as('usr_maya');
    assert.equal((await maya.post('/api/contributions', { item_id: 'itm_m1', pledged_amount: 20 })).status, 403, 'not on your own list');

    const db = app.db;
    db.prepare("UPDATE items SET price = NULL, allow_group_chip_in = 1 WHERE id = 'itm_e1'").run();
    assert.throws(() => addContribution(db, { itemId: 'itm_e1', contributorUserId: 'usr_justin', pledgedAmount: 10 }), /needs a price/);
  } finally { await app.close(); }
});

test('Secret Santa: organizers only, valid draws, solvable exclusion sets succeed, one live draw per circle', async () => {
  const db = testDb();
  const draw = (extra = {}) => createSecretSantaExchange(db, {
    groupId: 'grp_smith', name: 'Winter', eventDate: '2099-12-25', budgetLimit: 75, createdBy: 'usr_justin', ...extra
  });

  assert.throws(() => draw({ createdBy: 'usr_elena' }), /organizer/);
  assert.throws(() => draw({ exclusions: [['usr_justin', 'usr_nobody']] }), /two different people/);
  assert.throws(() => draw({ eventDate: 'soon' }), /valid/);

  // Exclusions that leave only the "two mutual pairs" solution must still succeed.
  for (let i = 0; i < 25; i++) {
    const ex = draw({ exclusions: [['usr_justin', 'usr_elena'], ['usr_justin', 'usr_arthur'], ['usr_maya', 'usr_elena'], ['usr_maya', 'usr_arthur']] });
    const pairs = db.prepare('SELECT giver_user_id AS g, recipient_user_id AS r FROM secret_santa_pairings WHERE exchange_id = ?').all(ex.id);
    assert.equal(pairs.length, 4);
    assert.equal(new Set(pairs.map(p => p.r)).size, 4, 'everyone receives exactly once');
    for (const p of pairs) assert.notEqual(p.g, p.r);
    assert.equal(pairs.find(p => p.g === 'usr_justin').r, 'usr_maya');
  }
  assert.throws(() => draw({ exclusions: [['usr_justin', 'usr_maya'], ['usr_justin', 'usr_elena'], ['usr_justin', 'usr_arthur']] }), /no valid draw/);

  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const body = { group_id: 'grp_smith', name: 'Winter', event_date: '2099-12-25', exclusions: [['usr_justin', 'usr_maya']] };
    assert.equal((await justin.post('/api/secret-santa', body)).status, 201);
    assert.equal((await justin.post('/api/secret-santa', body)).status, 409, 'no re-rolling');
    const mallory = await app.signUp('mallory@example.com', 'Mallory');
    assert.equal((await mallory.post('/api/secret-santa', { ...body, group_id: 'grp_smith' })).status, 403);

    const groups = (await justin.get('/api/groups')).json.groups;
    const ex = groups[0].exchanges[0];
    assert.ok(ex.my_assigned_recipient.id && ex.my_assigned_recipient.id !== 'usr_maya');
    assert.ok(!JSON.stringify(groups).includes('@'), 'no email addresses in the circle payload');
    assert.deepEqual((await app.guest.get('/api/groups')).json.groups, []);
    assert.deepEqual((await mallory.get('/api/groups')).json.groups, []);
  } finally { await app.close(); }
});

test('import: editors only, capped, duplicates skipped, bad rows reported without echoing input', () => {
  const db = testDb();
  const canEdit = (list) => list.owner_id === 'usr_justin';
  const items = [
    { title: 'Chemex Classic', url: 'https://www.amazon.com/dp/B000I1WP7W?ref=wl', price: '$48.50', qty_wanted: 1e17, priority: 'whatever' },
    { title: 'Bad link', url: 'javascript:alert(1)' },
    null
  ];
  const first = importAmazonList(db, { listId: 'lst_justin_holiday', canEdit, itemsPayload: items });
  assert.deepEqual([first.imported.length, first.skipped.length, first.failed.length], [1, 0, 2]);
  assert.equal(first.failed[0].raw, undefined);
  const row = db.prepare("SELECT price, qty_wanted, priority, canonical_url FROM items WHERE title = 'Chemex Classic'").get();
  assert.deepEqual({ ...row }, { price: 48.5, qty_wanted: 999, priority: 'normal', canonical_url: 'https://www.amazon.com/dp/B000I1WP7W' });
  assert.equal(importAmazonList(db, { listId: 'lst_justin_holiday', canEdit, itemsPayload: items }).skipped.length, 1);
  assert.throws(() => importAmazonList(db, { listId: 'lst_maya_bday', canEdit, itemsPayload: items }), /cannot add/);
  assert.throws(() => importAmazonList(db, { listId: 'lst_justin_holiday', canEdit, itemsPayload: new Array(201).fill({ title: 'x' }) }), /at most 200/);
});

test('a price update on an item with no history records where it started, so the drop is visible', async () => {
  const app = await startApp();
  try {
    const maya = await app.as('usr_maya');
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM price_snapshots WHERE item_id = 'itm_m2'").get().n, 0);
    const res = await maya.post('/api/items/itm_m2/recheck', { new_price: 54, in_stock: true });
    assert.equal(res.json.recheck.drop_percent, 20.6);
    assert.equal(res.json.recheck.significant_drop_alert, true);
    const item = (await maya.get('/api/lists/lst_maya_bday')).json.list.items.find(i => i.id === 'itm_m2');
    assert.deepEqual(item.price_history.map(p => p.price), [68, 54]);
    assert.equal(item.price_drop_percent, 20.6);
    // The giver who reserved it hears about the drop; the owner's response said nothing about them.
    const justin = await app.as('usr_justin');
    assert.ok((await justin.get('/api/notifications')).json.notifications.some(n => n.event_type === 'claimed_item_price_drop'));
    assert.equal((await maya.post('/api/items/itm_m2/recheck', { new_price: 'free' })).status, 400);
  } finally { await app.close(); }
});
