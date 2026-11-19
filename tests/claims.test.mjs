import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, testDb } from './helpers.mjs';
import {
  createClaim, verifyGuestClaim, transitionClaimState, handleOwnerEditItem, handleOwnerDeleteOrGotIt,
  purgeExpiredClaims, addContribution, normalizeEmailForCap, markItemReceived, archiveList
} from '../src/services/claims.mjs';
import { createSecretSantaExchange } from '../src/services/secret-santa.mjs';
import { blockUser } from '../src/services/access.mjs';
import { deleteAccount } from '../src/services/account.mjs';
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

    // Another guest sees that it is taken and nothing about who or how.
    const other = (await app.guest.get('/api/lists/justin-winter-2026')).json.list.items.find(i => i.id === 'itm_j1').claim_summary;
    assert.deepEqual(other, { qty_remaining: 0, is_fully_claimed: true, claims: [], contributions: [] });
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
  // The cap is applied when the code is entered. Asking is answered the same
  // way whatever the address already holds, so a link holder cannot use the
  // request to find out who has reserved on a list.
  const fourth = createClaim(db, { itemId: 'itm_j4', guestEmail: 'sy.bil+9@gmail.com' });
  const fresh = createClaim(db, { itemId: 'itm_j4', guestEmail: 'nobody-yet@example.com' });
  assert.deepEqual(Object.keys(fourth).sort(), Object.keys(fresh).sort());
  assert.equal(fourth.status, 'pending_verification');
  assert.throws(() => verifyGuestClaim(db, { claimId: fourth.id, code: fourth.verification_code }), /up to 3 items/);
  assert.equal(db.prepare('SELECT status FROM claims WHERE id = ?').get(fourth.id).status, 'released');

  // The cap counts units, and is checked again for every code entered.
  const a = createClaim(db, { itemId: 'itm_j4', guestEmail: 'queue@example.com', qty: 2 });
  const b = createClaim(db, { itemId: 'itm_j4', guestEmail: 'queue@example.com', qty: 2 });
  verifyGuestClaim(db, { claimId: a.id, code: a.verification_code });
  assert.throws(() => verifyGuestClaim(db, { claimId: b.id, code: b.verification_code }), /up to 3 items/);

  // Someone who reserved as a guest and then signs up is still the same person.
  db.prepare("INSERT INTO users (id, name, email, created_at) VALUES ('usr_sybil', 'Sybil', 'sybil@gmail.com', ?)").run(new Date().toISOString());
  assert.throws(() => createClaim(db, { itemId: 'itm_j4', claimerUserId: 'usr_sybil' }), /up to 3 items/);

  // Unverified requests are never cancelled by later ones: nobody can make
  // the real owner of an address lose a reservation they are confirming.
  const real = createClaim(db, { itemId: 'itm_m3', guestEmail: 'victim@example.com' });
  for (let i = 0; i < 6; i++) createClaim(db, { itemId: 'itm_m3', guestEmail: `Victim+${i}@example.com` });
  assert.equal(verifyGuestClaim(db, { claimId: real.id, code: real.verification_code }).status, 'reserved');

  // A code entered after the list was closed or taken off link sharing holds nothing.
  const late = createClaim(db, { itemId: 'itm_m3', guestEmail: 'late@example.com' });
  db.prepare("UPDATE lists SET visibility = 'private' WHERE id = 'lst_maya_bday'").run();
  assert.throws(() => verifyGuestClaim(db, { claimId: late.id, code: late.verification_code }), /no longer available/);
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
  db.prepare("UPDATE claims SET order_note = 'Order #4471, hidden in the garage' WHERE id = ?").run(c.id);
  const released = move('released', 'usr_maya', { orderNote: 'rewritten', reason: 'Duplicate' });
  assert.deepEqual(released, { id: c.id, status: 'released' }, "a helper is told it was released, never the giver's note");
  assert.equal(db.prepare('SELECT order_note FROM claims WHERE id = ?').get(c.id).order_note, 'Order #4471, hidden in the garage', "and cannot rewrite it");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications_outbox WHERE recipient_user_id = 'usr_arthur' AND event_type = 'claimed_item_changed'").get().n, 1);
  assert.throws(() => move('purchased'), /closed/);
  assert.throws(() => move('released'), /closed/);

  // A hold that has run out cannot be confirmed just because nobody looked.
  const stale = createClaim(db, { itemId: 'itm_j1', claimerUserId: 'usr_elena' });
  db.prepare('UPDATE claims SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', stale.id);
  assert.throws(() => transitionClaimState(db, { claimId: stale.id, newState: 'purchased', actorId: 'usr_elena' }), /closed/);

  // A helper the owner has blocked can no longer release anything.
  const held = createClaim(db, { itemId: 'itm_j1', claimerUserId: 'usr_arthur' });
  blockUser(db, 'usr_justin', 'usr_maya');
  assert.throws(() => transitionClaimState(db, { claimId: held.id, newState: 'released', actorId: 'usr_maya' }), /cannot change/);

  // Undoing "bought" makes a new hold: full period, and only while there is room and the list is open.
  const undo = (id) => transitionClaimState(db, { claimId: id, newState: 'reserved', actorId: 'usr_arthur' });
  transitionClaimState(db, { claimId: held.id, newState: 'purchased', actorId: 'usr_arthur' });
  db.prepare("UPDATE claims SET expires_at = '2020-01-01T00:00:00.000Z', expiry_warned = 1 WHERE id = ?").run(held.id);
  const again = undo(held.id);
  assert.ok(again.expires_at > new Date().toISOString(), 'the hold period starts again');
  assert.equal(db.prepare('SELECT expiry_warned FROM claims WHERE id = ?').get(held.id).expiry_warned, 0);
  transitionClaimState(db, { claimId: held.id, newState: 'purchased', actorId: 'usr_arthur' });
  db.prepare("UPDATE lists SET archived_at = ? WHERE id = 'lst_justin_holiday'").run(new Date().toISOString());
  assert.throws(() => undo(held.id), /no longer open/);
});

test('received, archived and edited items: every giver ends up with the truth, once', () => {
  const db = testDb();
  const count = (userId, like) => db.prepare('SELECT COUNT(*) AS n FROM notifications_outbox WHERE recipient_user_id = ? AND subject LIKE ?').get(userId, like).n;
  const status = (id) => db.prepare('SELECT status FROM claims WHERE id = ?').get(id).status;

  // Marked received: a gift recorded as bought is given; a hold that was never bought is cancelled, not "given".
  const bought = createClaim(db, { itemId: 'itm_j4', claimerUserId: 'usr_elena' });
  transitionClaimState(db, { claimId: bought.id, newState: 'purchased', actorId: 'usr_elena' });
  const onlyHeld = createClaim(db, { itemId: 'itm_j4', claimerUserId: 'usr_arthur' });
  const pending = createClaim(db, { itemId: 'itm_j4', guestEmail: 'unverified@example.com' });
  markItemReceived(db, { itemId: 'itm_j4', actorId: 'usr_justin' });
  assert.deepEqual([status(bought.id), status(onlyHeld.id), status(pending.id)], ['given', 'withdrawn', 'withdrawn']);
  assert.equal(count('usr_arthur', '%no longer needed%'), 1);

  // Title, link and price edits reach the people giving the item.
  const c = createClaim(db, { itemId: 'itm_j1', claimerUserId: 'usr_elena' });
  handleOwnerEditItem(db, { itemId: 'itm_j1', ownerId: 'usr_justin', updates: { title: 'Kettle, the big one', price: 250 } });
  const mail = db.prepare("SELECT body FROM notifications_outbox WHERE recipient_user_id = 'usr_elena' AND subject LIKE '%Kettle, the big one%'").get().body;
  assert.match(mail, /Name:.*Kettle, the big one/);
  assert.match(mail, /Price: 195\.00 USD → 250\.00 USD/);

  // Switching chip-in off cancels the pledges and says so.
  handleOwnerEditItem(db, { itemId: 'itm_m1', ownerId: 'usr_maya', updates: { allow_group_chip_in: false } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contributions WHERE item_id = 'itm_m1' AND status = 'pledged'").get().n, 0);
  assert.equal(count('usr_justin', '%switched off%'), 1);

  // Archiving: one message per person however many holds they had; none to an address nobody confirmed.
  createClaim(db, { itemId: 'itm_j3', guestEmail: 'never-confirmed@example.com' });
  const second = createClaim(db, { itemId: 'itm_j3', claimerUserId: 'usr_elena' });
  const before = db.prepare("SELECT COUNT(*) AS n FROM notifications_outbox WHERE recipient_email = 'never-confirmed@example.com' AND event_type != 'guest_verification_code'").get().n;
  archiveList(db, db.prepare("SELECT * FROM lists WHERE id = 'lst_justin_holiday'").get());
  assert.deepEqual([status(c.id), status(second.id)], ['released', 'released']);
  assert.equal(count('usr_elena', '%was closed%'), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications_outbox WHERE recipient_email = 'never-confirmed@example.com' AND event_type != 'guest_verification_code'").get().n, before);

  // A one-day hold does not get a "48 hours left" warning the moment it is made.
  const shortHold = createClaim(db, { itemId: 'itm_m3', claimerUserId: 'usr_arthur' });
  db.prepare('UPDATE claims SET expires_at = ? WHERE id = ?').run(new Date(Date.now() + 24 * 3600 * 1000).toISOString(), shortHold.id);
  purgeExpiredClaims(db);
  assert.equal(count('usr_arthur', '%ends in%'), 0);
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

    // Chipping in is for people the owner has a connection with: a stranger
    // holding the link cannot mark gifts as funded.
    const mallory = await app.signUp('mallory@example.com', 'Mallory');
    assert.equal((await mallory.post('/api/contributions', { item_id: 'itm_m1', pledged_amount: 1 })).status, 403);

    // Buying outright and funding together are alternatives, in both directions.
    db.prepare("UPDATE items SET price = 40, allow_group_chip_in = 1 WHERE id = 'itm_j3'").run();
    assert.equal((await maya.post('/api/contributions', { item_id: 'itm_j3', pledged_amount: 40 })).status, 201);
    assert.equal((await arthur.post('/api/claims', { item_id: 'itm_j3' })).status, 409, 'fully funded: nothing left to reserve');
    db.prepare("UPDATE items SET allow_group_chip_in = 1 WHERE id = 'itm_j1'").run();
    assert.equal((await arthur.post('/api/claims', { item_id: 'itm_j1' })).status, 201);
    assert.equal((await maya.post('/api/contributions', { item_id: 'itm_j1', pledged_amount: 5 })).status, 409, 'reserved: nothing left to fund');

    // Once the gift has arrived a pledge stays on record.
    const elena = await app.as('usr_elena');
    db.prepare("UPDATE items SET status = 'received' WHERE id = 'itm_m1'").run();
    assert.equal((await elena.del('/api/contributions/cnt_2')).status, 409);
  } finally { await app.close(); }
});

test('Secret Santa: organizers only, fair draws, no dictated pairings, one live draw, survives someone leaving', async () => {
  const db = testDb();
  const draw = (extra = {}) => createSecretSantaExchange(db, {
    groupId: 'grp_smith', name: 'Winter', eventDate: '2099-12-25', budgetLimit: 75, createdBy: 'usr_justin', ...extra
  });
  const pairsOf = (id) => db.prepare('SELECT giver_user_id AS g, recipient_user_id AS r FROM secret_santa_pairings WHERE exchange_id = ?').all(id);

  assert.throws(() => draw({ createdBy: 'usr_elena' }), /organizer/);
  assert.throws(() => draw({ exclusions: [['usr_justin', 'usr_nobody']] }), /two different people/);
  assert.throws(() => draw({ eventDate: 'soon' }), /valid/);
  assert.throws(() => draw({ eventDate: '2020-12-25' }), /today or a later date/);

  // Exclusions that pin the outcome down are refused: whoever chose them would know every pairing.
  assert.throws(() => draw({ exclusions: [['usr_justin', 'usr_elena'], ['usr_justin', 'usr_arthur'], ['usr_maya', 'usr_elena'], ['usr_maya', 'usr_arthur']] }), /would not be secret/);
  assert.throws(() => draw({ exclusions: [['usr_justin', 'usr_maya'], ['usr_justin', 'usr_elena'], ['usr_justin', 'usr_arthur']] }), /no valid draw/);

  // Every allowed outcome is equally likely. Four people have nine possible draws.
  const seen = new Map();
  const rounds = 1800;
  for (let i = 0; i < rounds; i++) {
    const pairs = pairsOf(draw().id);
    assert.equal(pairs.length, 4);
    assert.equal(new Set(pairs.map(p => p.r)).size, 4, 'everyone receives exactly once');
    for (const p of pairs) assert.notEqual(p.g, p.r);
    const key = pairs.map(p => `${p.g}>${p.r}`).sort().join(' ');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  assert.equal(seen.size, 9, 'including the outcomes where two people draw each other');
  const expected = rounds / 9;
  const chi2 = [...seen.values()].reduce((sum, n) => sum + (n - expected) ** 2 / expected, 0);
  assert.ok(chi2 < 40, `draws are uniform (chi-square ${chi2.toFixed(1)} on 8 degrees of freedom)`);

  // An ordinary exclusion is respected.
  for (let i = 0; i < 30; i++) {
    const pairs = pairsOf(draw({ exclusions: [['usr_justin', 'usr_maya']] }).id);
    assert.ok(!pairs.some(p => (p.g === 'usr_justin' && p.r === 'usr_maya') || (p.g === 'usr_maya' && p.r === 'usr_justin')));
  }

  // Someone closing their account does not leave a hole in the draw.
  db.prepare("INSERT INTO users (id, name, email, created_at) VALUES ('usr_fifth', 'Fifth', 'fifth@example.com', ?)").run(new Date().toISOString());
  db.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES ('grp_smith', 'usr_fifth', 'member', ?)").run(new Date().toISOString());
  const five = draw();
  deleteAccount(db, 'usr_fifth');
  const after = pairsOf(five.id);
  assert.equal(after.length, 4);
  assert.deepEqual(after.map(p => p.g).sort(), after.map(p => p.r).sort(), 'everyone still gives once and receives once');
  for (const p of after) assert.notEqual(p.g, p.r);
  assert.ok(!JSON.stringify(after).includes('usr_fifth'));

  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const body = { group_id: 'grp_smith', name: 'Winter', event_date: '2099-12-25', exclusions: [['usr_justin', 'usr_maya']] };
    assert.equal((await justin.post('/api/secret-santa', { ...body, event_date: '2020-01-01' })).status, 400, 'a past date cannot be used to draw again and again');
    assert.equal((await justin.post('/api/secret-santa', body)).status, 201);
    assert.equal((await justin.post('/api/secret-santa', body)).status, 409, 'no re-rolling');
    const mallory = await app.signUp('mallory@example.com', 'Mallory');
    const outsider = await mallory.post('/api/secret-santa', { ...body, group_id: 'grp_smith' });
    const nowhere = await mallory.post('/api/secret-santa', { ...body, group_id: 'grp_nope' });
    assert.deepEqual([outsider.status, outsider.json], [nowhere.status, nowhere.json], 'a circle you are not in looks like one that does not exist');

    const groups = (await justin.get('/api/groups')).json.groups;
    const ex = groups[0].exchanges[0];
    assert.ok(ex.my_assigned_recipient.id && ex.my_assigned_recipient.id !== 'usr_maya');
    assert.ok(!JSON.stringify(groups).includes('@'), 'no email addresses in the circle payload');
    // The rules of the draw are visible to everyone in it, not only to whoever set them.
    const elena = await app.as('usr_elena');
    const hers = (await elena.get('/api/groups')).json.groups[0];
    assert.deepEqual(hers.exchanges[0].exclusions, [['Justin Smith', 'Maya Smith']]);
    assert.equal(hers.invite_code, null, 'the invite code stays with the organizers');
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
