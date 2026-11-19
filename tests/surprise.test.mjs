import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, testDb } from './helpers.mjs';
import { getViewerRole, sanitizeItemForViewer } from '../src/services/surprise.mjs';
import { createClaim, transitionClaimState, addContribution } from '../src/services/claims.mjs';
import { sendNotification } from '../src/services/notifications.mjs';

test('owner payload is byte-identical before and after claims, purchases and pledges', () => {
  const db = testDb();
  const list = db.prepare("SELECT * FROM lists WHERE id = 'lst_justin_holiday'").get();
  const ownerCtx = getViewerRole(db, list, 'usr_justin');
  assert.equal(ownerCtx.role, 'owner');
  assert.equal(ownerCtx.canSeeClaims, false);

  const view = () => JSON.stringify(sanitizeItemForViewer(db, db.prepare("SELECT * FROM items WHERE id = 'itm_j1'").get(), list, ownerCtx, 'usr_justin'));
  const before = view();

  const claim = createClaim(db, { itemId: 'itm_j1', claimerUserId: 'usr_elena', orderNote: 'Secret order #9988' });
  transitionClaimState(db, { claimId: claim.id, newState: 'purchased', actorId: 'usr_elena' });
  addContribution(db, { itemId: 'itm_j1', contributorUserId: 'usr_maya', pledgedAmount: 75, note: 'Secret chip-in' });

  assert.equal(view(), before);
  assert.equal(JSON.parse(view()).claim_summary, undefined);

  const giver = sanitizeItemForViewer(db, db.prepare("SELECT * FROM items WHERE id = 'itm_j1'").get(), list, getViewerRole(db, list, 'usr_elena'), 'usr_elena');
  assert.equal(giver.claim_summary.is_fully_claimed, true);
  assert.equal(giver.claim_summary.pledged_total, 75);

  const blocked = sendNotification(db, {
    recipientUserId: 'usr_justin', eventType: 'claimed_item_changed', listId: list.id, subject: 's', body: 'b'
  });
  assert.equal(blocked.reason, 'spoiler_protection_blocked_owner_notification');
});

test('no owner action returns anything that depends on claims', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');

    // itm_j2 is claimed (seed), itm_j1 is not. Every owner-reachable response must match.
    const strip = (r) => JSON.stringify(r.json).replace(/itm_j[12]/g, 'ITEM').replace(/"(updated_at|checked_at)":"[^"]+"/g, '');

    const priceA = await justin.post('/api/items/itm_j1/recheck', { in_stock: false });
    const priceB = await justin.post('/api/items/itm_j2/recheck', { in_stock: false });
    assert.equal(priceA.json.recheck.claimers_notified, undefined);
    assert.deepEqual(Object.keys(priceA.json.recheck), Object.keys(priceB.json.recheck));
    assert.equal(priceA.json.recheck.out_of_stock_alert, priceB.json.recheck.out_of_stock_alert);

    const editA = await justin.patch('/api/items/itm_j1', { qty_wanted: 1, notes: 'n' });
    const editB = await justin.patch('/api/items/itm_j2', { qty_wanted: 1, notes: 'n' });
    assert.deepEqual(Object.keys(editA.json.item), Object.keys(editB.json.item));

    const delA = await justin.del('/api/items/itm_j1');
    const delB = await justin.del('/api/items/itm_j2');
    assert.equal(strip(delA), strip(delB));

    // The giver, not the owner, hears about it.
    const elena = await app.as('usr_elena');
    const inbox = (await elena.get('/api/notifications')).json.notifications;
    assert.ok(inbox.some(n => n.event_type === 'claimed_item_withdrawn'));
    const ownerInbox = (await justin.get('/api/notifications')).json.notifications;
    assert.ok(!ownerInbox.some(n => /claim/.test(n.event_type)));
  } finally { await app.close(); }
});

test('surprise mode cannot be switched off, moved around or revealed early', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const maya = await app.as('usr_maya');

    // Same refusal whether or not the list has claims: Maya adds an item to a
    // brand-new, unclaimed surprise list and gets the identical answer.
    const withClaims = await justin.patch('/api/lists/lst_justin_holiday', { surprise_mode: false });
    const fresh = (await maya.post('/api/lists', { name: 'Fresh' })).json.list;
    await maya.post('/api/items', { list_id: fresh.id, title: 'Unclaimed thing' });
    const withoutClaims = await maya.patch(`/api/lists/${fresh.id}`, { surprise_mode: false });
    assert.equal(withClaims.status, 409);
    assert.deepEqual(withClaims.json, withoutClaims.json);

    // An empty list may still be switched (nothing can have been claimed).
    const empty = (await maya.post('/api/lists', { name: 'Empty' })).json.list;
    assert.equal((await maya.patch(`/api/lists/${empty.id}`, { surprise_mode: false })).json.list.surprise_mode, false);

    // Early reveal: no client flag unlocks it.
    for (const body of [{ action: 'reveal' }, { action: 'reveal', force_post_event_reveal: true }, { action: 'reveal_purchases', force_post_event_reveal: true }]) {
      const res = await justin.patch('/api/lists/lst_justin_holiday', body);
      assert.equal((await justin.get('/api/lists/lst_justin_holiday')).json.list.can_see_claims, false, JSON.stringify(body));
      if (body.action === 'reveal') assert.equal(res.json.code, 'reveal_locked');
    }

    // The occasion date cannot be moved into the past or made unparseable to slip the lock.
    for (const event_date of ['2020-01-01', 'soon', '2026-02-30']) {
      assert.equal((await justin.patch('/api/lists/lst_justin_holiday', { event_date })).status, 400, event_date);
    }
    assert.equal((await justin.patch('/api/lists/lst_justin_holiday', { event_date: null })).status, 400);

    // A list with no date is locked too.
    assert.equal((await maya.patch(`/api/lists/${fresh.id}`, { action: 'reveal' })).status, 409);

    // Moving a sealed item onto a registry-mode list would unseal its claims.
    const registry = (await justin.post('/api/lists', { name: 'Registry', surprise_mode: false })).json.list;
    const claimed = await justin.patch('/api/items/itm_j2', { action: 'move_to_list', target_list_id: registry.id });
    const unclaimed = await justin.patch('/api/items/itm_j1', { action: 'move_to_list', target_list_id: registry.id });
    assert.equal(claimed.status, 409);
    assert.deepEqual(claimed.json, unclaimed.json, 'the refusal is the same for claimed and unclaimed items');
    assert.equal((await justin.patch('/api/items/itm_j1', { action: 'copy_to_list', target_list_id: registry.id })).status, 201);
    const copied = (await justin.get(`/api/lists/${registry.id}`)).json.list.items;
    assert.equal(copied.length, 1);
    assert.equal(copied[0].claim_summary.qty_claimed, 0, 'a copy carries no claims');
  } finally { await app.close(); }
});

test('after the unlock date the owner can open the list, and givers are told', async () => {
  const app = await startApp();
  try {
    // Simulate "the party was 8 days ago" directly in storage.
    const past = new Date(Date.now() - 8 * 86400 * 1000).toISOString().slice(0, 10);
    app.db.prepare("UPDATE lists SET event_date = ? WHERE id = 'lst_justin_holiday'").run(past);

    const justin = await app.as('usr_justin');
    const opened = await justin.patch('/api/lists/lst_justin_holiday', { action: 'reveal' });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.list.can_see_claims, true);
    const sweater = opened.json.list.items.find(i => i.id === 'itm_j2');
    assert.equal(sweater.claim_summary.claims[0].claimer_display, 'Aunt Elena Vance');

    const elena = await app.as('usr_elena');
    assert.ok((await elena.get('/api/notifications')).json.notifications.some(n => n.event_type === 'list_revealed'));
  } finally { await app.close(); }
});

test('admin console and admin override exclude the admin\'s own sealed lists', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const admin = (await justin.get('/api/admin')).json;
    assert.ok(!admin.overridable_claims.some(c => c.id === 'clm_elena_on_justin'));
    assert.ok(admin.overridable_claims.some(c => c.id === 'clm_justin_on_elena' || c.id === 'clm_arthur_on_leo'));

    const own = await justin.post('/api/admin/claims/override', { claim_id: 'clm_elena_on_justin', reason: 'peek' });
    const missing = await justin.post('/api/admin/claims/override', { claim_id: 'clm_does_not_exist', reason: 'peek' });
    assert.equal(own.status, 404);
    assert.deepEqual(own.json, missing.json);

    const other = await justin.post('/api/admin/claims/override', { claim_id: 'clm_arthur_on_leo', reason: 'Duplicate reported by the family' });
    assert.deepEqual(other.json.claim, { id: 'clm_arthur_on_leo', status: 'released' });
    assert.equal((await justin.post('/api/admin/claims/override', { claim_id: 'clm_justin_on_elena' })).status, 400, 'a reason is mandatory');

    const elena = await app.as('usr_elena');
    assert.equal((await elena.get('/api/admin')).status, 403);
  } finally { await app.close(); }
});

test('secret ideas: circle members only, never the subject, strangers cannot read or write', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const maya = await app.as('usr_maya');
    const card = (d, id) => d.json.people_i_shop_for.find(p => p.person.id === id);

    assert.ok(card(await justin.get('/api/dashboard'), 'usr_maya').secret_ideas.length >= 1);
    const mayaDash = await maya.get('/api/dashboard');
    assert.equal(card(mayaDash, 'usr_maya'), undefined, 'nobody appears on their own dashboard');
    assert.ok(!JSON.stringify(mayaDash.json).includes('Botanical'), 'the idea about Maya is nowhere in her payload');
    assert.equal((await maya.post('/api/secret-ideas', { subject_user_id: 'usr_maya', title: 'x' })).status, 403);

    const mallory = await app.signUp('mallory@example.com', 'Mallory');
    assert.equal((await mallory.post('/api/secret-ideas', { subject_user_id: 'usr_maya', title: 'rumour' })).status, 403);
    const follow = await mallory.post('/api/follows', { target_id: 'usr_maya' });
    assert.equal(follow.json.follow.status, 'pending', 'following a stranger needs their approval');
    assert.equal((await mallory.get('/api/dashboard')).json.people_i_shop_for.length, 0);
  } finally { await app.close(); }
});
