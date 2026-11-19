import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

test('lists cannot be discovered: guests and strangers get nothing without the link', async () => {
  const app = await startApp();
  try {
    assert.deepEqual((await app.guest.get('/api/lists')).json.lists, []);
    assert.deepEqual((await app.guest.get('/api/lists?ownerId=usr_leo')).json.lists, []);
    assert.equal((await app.guest.get('/api/session')).json.demo.personas.some(p => p.email), false);

    // Private means private: even a circle member with an explicit share and the id cannot open it.
    const justin = await app.as('usr_justin');
    const secret = (await justin.post('/api/lists', { name: 'Surprise for Maya', visibility: 'private', group_id: 'grp_smith' })).json.list;
    await justin.post('/api/items', { list_id: secret.id, title: 'Diamond necklace' });
    const maya = await app.as('usr_maya');
    const denied = await maya.get(`/api/lists/${secret.id}`);
    const missing = await maya.get('/api/lists/lst_does_not_exist');
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.json, missing.json, '"not allowed" looks exactly like "not found"');
    assert.equal((await app.guest.get(`/api/lists/${secret.share_token}`)).status, 404);

    // …and its items do not leak through the digest.
    const digest = await maya.post('/api/notifications/digest');
    assert.equal(digest.status, 200);
    const inbox = (await maya.get('/api/notifications')).json.notifications;
    assert.ok(!JSON.stringify(inbox).includes('Diamond'));

    // "specific" lists are for explicit shares; a signed-in stranger with the link sees the guest projection of link lists only.
    const specific = (await justin.post('/api/lists', { name: 'Close family', visibility: 'specific', group_id: 'grp_smith' })).json.list;
    assert.equal((await maya.get(`/api/lists/${specific.id}`)).json.list.viewer_role, 'follower');
    const mallory = await app.signUp('mallory@example.com', 'Mallory');
    assert.equal((await mallory.get(`/api/lists/${specific.id}`)).status, 404);
    const viaLink = (await mallory.get('/api/lists/justin-winter-2026')).json.list;
    assert.equal(viaLink.viewer_role, 'guest');
    const cash = viaLink.items.find(i => i.id === 'itm_j4');
    assert.equal(cash.giving_instructions, null, 'payment handles are for the circle');
    // Someone with only the link learns "taken" and how many are left — no row
    // per reservation, no pledges, no amounts.
    const sweater = viaLink.items.find(i => i.id === 'itm_j2');
    assert.deepEqual(sweater.claim_summary, { qty_remaining: 0, is_fully_claimed: true, claims: [], contributions: [] });
    // The link is the credential: the list's id alone opens nothing for them.
    assert.equal((await mallory.get('/api/lists/lst_justin_holiday')).status, 404);
    assert.equal((await app.guest.get('/api/lists/lst_justin_holiday')).status, 404);

    // A stranger with the link can hold a limited number of items.
    const taken = [];
    for (const id of ['itm_j1', 'itm_j3', 'itm_j4', 'itm_j4']) taken.push((await mallory.post('/api/claims', { item_id: id })).status);
    assert.deepEqual(taken, [201, 201, 201, 409]);
  } finally { await app.close(); }
});

test('circles: invite code is the only way in; ids, roles and collaborators cannot be assigned from request bodies', async () => {
  const app = await startApp();
  try {
    const mallory = await app.signUp('mallory@example.com', 'Mallory', { group_id: 'grp_smith' });
    assert.deepEqual((await mallory.get('/api/groups')).json.groups, [], 'a group id in the sign-up body does nothing');
    assert.equal((await mallory.post('/api/groups/join', { invite_code: 'WRONG' })).status, 404);

    // Naming people as co-owner / helper / co-guardian needs a shared circle.
    assert.equal((await mallory.post('/api/lists', { name: 'x', co_owner_ids: ['usr_justin'] })).status, 400);
    assert.equal((await mallory.post('/api/lists', { name: 'x', helper_user_id: 'usr_justin' })).status, 400);
    assert.equal((await mallory.post('/api/lists', { name: 'x', group_id: 'grp_smith' })).status, 403);
    assert.equal((await mallory.post('/api/dependents', { name: 'Kid', co_guardian_id: 'usr_elena' })).status, 400);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Kid'").get().n, 0, 'nothing half-created');
    assert.equal((await mallory.post('/api/lists', { name: 'x', owner_id: 'usr_leo' })).status, 403);
    for (const visibility of ['public', '', 7]) {
      assert.equal((await mallory.post('/api/lists', { name: 'v', visibility })).json.list.visibility, 'link');
    }

    // With the invite code she is in, and sees the circle's lists.
    const joined = await mallory.post('/api/groups/join', { invite_code: 'SMITH-FAMILY' });
    assert.equal(joined.json.group.id, 'grp_smith');
    assert.equal((await mallory.get('/api/lists/lst_justin_holiday')).json.list.viewer_role, 'follower');
  } finally { await app.close(); }
});

test('items: only editors of the list — and of the destination — can change, price, move or copy', async () => {
  const app = await startApp();
  try {
    const elena = await app.as('usr_elena');
    const justin = await app.as('usr_justin');
    assert.equal((await elena.post('/api/items/itm_j1/recheck', { new_price: 1 })).status, 403);
    assert.equal(app.db.prepare("SELECT price FROM items WHERE id = 'itm_j1'").get().price, 195);
    assert.equal((await elena.patch('/api/items/itm_j1', { action: 'mark_received' })).status, 403);
    assert.equal((await elena.del('/api/items/itm_j1')).status, 403);
    assert.equal((await app.guest.post('/api/capture', { url: 'https://www.rei.com/product/x' })).status, 401);

    // Elena co-owns list A of Justin's; that gives her nothing on his list B.
    const a = (await justin.post('/api/lists', { name: 'A', co_owner_ids: ['usr_elena'] })).json.list;
    assert.equal((await elena.patch(`/api/lists/${a.id}`, { action: 'accept_invite' })).status, 200);
    const b = (await justin.post('/api/lists', { name: 'B', visibility: 'private' })).json.list;
    const item = (await elena.post('/api/items', { list_id: a.id, title: 'Shared thing' })).json.item;
    for (const action of ['move_to_list', 'copy_to_list']) {
      assert.equal((await elena.patch(`/api/items/${item.id}`, { action, target_list_id: b.id })).status, 400, action);
    }
    assert.equal((await justin.get(`/api/lists/${b.id}`)).json.list.items.length, 0);

    // Numbers that would poison storage are clamped or refused.
    const big = await justin.post('/api/items', { list_id: a.id, title: 'Clamp me', qty_wanted: 1e17, sort_order: 1e30, price: 12.345 });
    assert.equal(big.json.item.qty_wanted, 999);
    assert.equal(big.json.item.price, 12.35);
    assert.equal((await justin.post('/api/items', { list_id: a.id, title: 'Negative', price: -50 })).status, 400);
    assert.equal((await justin.post('/api/items', { list_id: a.id, title: 'Scheme', url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await justin.get('/api/lists')).status, 200);
  } finally { await app.close(); }
});

test('follows and blocks: the followed person decides; a block is its own record that only the blocker can lift', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const elena = await app.as('usr_elena');

    // A follow row can only ever be pending or approved, and only the followed person changes it.
    assert.equal((await justin.patch('/api/follows/fol_6', { status: 'blocked' })).status, 400);
    assert.equal((await elena.patch('/api/follows/fol_6', { status: 'approved' })).status, 403);

    assert.equal((await justin.post('/api/blocks', { user_id: 'usr_elena' })).status, 200);
    assert.equal((await elena.get('/api/lists/lst_justin_holiday')).status, 404);
    assert.equal((await elena.get('/api/lists/justin-winter-2026')).status, 404, 'not even with the link');
    assert.equal((await elena.del('/api/follows/fol_6')).status, 404, 'the follow is gone');
    assert.equal((await elena.post('/api/follows', { target_id: 'usr_justin' })).status, 404);
    assert.equal((await elena.post('/api/claims', { item_id: 'itm_j1' })).status, 403);
    assert.equal((await elena.post('/api/secret-ideas', { subject_user_id: 'usr_justin', title: 'x' })).status, 403);
    assert.equal((await elena.del('/api/blocks/usr_elena?for=usr_justin')).status, 403, 'the blocked person cannot lift it');
    const dash = (await elena.get('/api/dashboard')).json;
    assert.ok(!dash.people_i_shop_for.some(p => p.person.id === 'usr_justin'), 'blocked people do not see you on their dashboard');
    assert.deepEqual((await justin.get('/api/follows')).json.blocked.map(b => b.blocked_id), ['usr_elena']);

    assert.equal((await justin.del('/api/blocks/usr_elena')).status, 200);
    assert.equal((await elena.get('/api/lists/lst_justin_holiday')).status, 200);

    // Reporting someone blocks them even if they never followed — and the
    // reporter cannot turn that record into a follow in either direction.
    const mallory = await app.signUp('mallory@example.com', 'Mallory');
    assert.equal((await justin.post('/api/reports', { target_type: 'user', target_id: mallory.user.id, reason: 'spam' })).status, 201);
    assert.equal((await mallory.post('/api/follows', { target_id: 'usr_justin' })).status, 404);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ? OR target_id = ?').get(mallory.user.id, mallory.user.id).n, 0);
    // Reports need a real, visible target; reporting a person needs an account.
    assert.equal((await app.guest.post('/api/reports', { target_type: 'user', target_id: 'usr_justin', reason: 'x' })).status, 404);
    assert.equal((await app.guest.post('/api/reports', { target_type: 'list', target_id: 'lst_nope', reason: 'x' })).status, 404);
    assert.equal((await app.guest.post('/api/reports', { target_type: 'list', target_id: 'lst_justin_holiday', reason: 'x' })).status, 201);

    // Follows of a child profile go to the guardians, who can manage them and block in the child's name.
    const stranger = await app.signUp('stranger@example.com', 'Stranger');
    const f = await stranger.post('/api/follows', { target_id: 'usr_leo' });
    assert.equal(f.json.follow.status, 'pending');
    assert.equal((await stranger.get('/api/follows')).json.who_i_follow[0].target_name, null, 'a pending request does not reveal the name behind an id');
    assert.ok((await justin.get('/api/follows')).json.followers_of_me.some(x => x.id === f.json.follow.id && x.for_user_id === 'usr_leo'));
    assert.equal((await stranger.post('/api/blocks', { user_id: 'usr_justin', for_user_id: 'usr_leo' })).status, 403);
    assert.equal((await justin.post('/api/blocks', { user_id: stranger.user.id, for_user_id: 'usr_leo' })).status, 200);
    assert.equal((await stranger.post('/api/follows', { target_id: 'usr_leo' })).status, 404);
    assert.equal((await stranger.post('/api/follows', { target_id: 'usr_justin' })).status, 201, "a block made for the child is the child's, not the guardian's");
    // A list can only be followed by someone who can open it.
    const priv = (await justin.post('/api/lists', { name: 'P', visibility: 'private' })).json.list;
    assert.equal((await stranger.post('/api/follows', { target_type: 'list', target_id: priv.id })).status, 404);
    // Budgets are for people you actually shop for.
    assert.equal((await stranger.post('/api/budgets', { subject_user_id: 'usr_maya', amount: 10 })).status, 400);
  } finally { await app.close(); }
});

test("deleting an account erases the person and keeps other people's records", async () => {
  const app = await startApp();
  try {
    const db = app.db;
    const count = (sql, ...args) => db.prepare(sql).get(...args).n;

    // The only administrator cannot vanish and leave the install without one.
    const justin = await app.as('usr_justin');
    assert.equal((await justin.del('/api/account', { confirm: true })).status, 409);
    assert.equal((await justin.del('/api/account', {})).status, 400, 'explicit confirmation required');

    // Maya deletes. Justin had bought her matcha bowl and pledged toward the dutch oven.
    const maya = await app.as('usr_maya');
    assert.equal((await maya.del('/api/account', { confirm: true })).status, 200);
    assert.equal((await maya.get('/api/session')).json.current_user, null);

    const row = db.prepare("SELECT * FROM users WHERE id = 'usr_maya'").get();
    assert.deepEqual([row.name, row.email, row.status, row.birthday_month], ['Deleted user', null, 'deleted', null]);
    assert.equal(db.prepare("SELECT status FROM claims WHERE id = 'clm_justin_on_maya'").get().status, 'purchased', "Justin's purchase record survives");
    assert.ok((await justin.get('/api/dashboard')).json.my_claims_tracker.some(c => c.id === 'clm_justin_on_maya'));
    assert.equal(count("SELECT COUNT(*) AS n FROM secret_ideas WHERE subject_user_id = 'usr_maya' OR author_id = 'usr_maya'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM group_members WHERE user_id = 'usr_maya'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM follows WHERE follower_id = 'usr_maya' OR target_id = 'usr_maya'"), 0);
    assert.equal((await app.guest.get('/api/lists/maya-birthday-2026')).status, 404, 'her share link stops working');
    assert.equal(count("SELECT COUNT(*) AS n FROM guardian_links WHERE dependent_id = 'usr_leo'"), 1, 'Leo keeps his other guardian');

    // Gifts she had reserved for others stay accurate but anonymous.
    const elena = await app.as('usr_elena');
    const claim = (await elena.post('/api/claims', { item_id: 'itm_l1', order_note: 'my private note' })).json.claim;
    await elena.del('/api/account', { confirm: true });
    const anon = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
    // A hold she never bought is released (nobody is left who could release it)…
    assert.deepEqual([anon.status, anon.claimer_user_id, anon.guest_email, anon.order_note, anon.guest_name], ['released', null, null, null, 'Former member']);
    // …while something she had already bought stays on record, anonymously.
    const kept = db.prepare("SELECT status, claimer_user_id, guest_name, order_note FROM claims WHERE id = 'clm_elena_on_justin'").get();
    assert.deepEqual({ ...kept }, { status: 'purchased', claimer_user_id: null, guest_name: 'Former member', order_note: null });

    // A child with no remaining guardian is erased with the last one.
    const solo = await app.signUp('solo@example.com', 'Solo Parent');
    const kid = (await solo.post('/api/dependents', { name: 'Only Child' })).json;
    await solo.del('/api/account', { confirm: true });
    assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(kid.dependent.id).status, 'deleted');
    assert.equal((await app.guest.get(`/api/lists/${kid.list.share_token}`)).status, 404);
  } finally { await app.close(); }
});
