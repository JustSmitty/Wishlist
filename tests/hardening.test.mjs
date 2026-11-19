import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, testDb } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { startSignIn, completeSignIn, syncAdmins } from '../src/services/auth.mjs';
import { createClaim, transitionClaimState, handleOwnerEditItem } from '../src/services/claims.mjs';
import { sendNotification, dispatchOutbox, generateFollowerDigest, setMailTransport } from '../src/services/notifications.mjs';
import { importAmazonList } from '../src/services/capture.mjs';
import { deleteAccount } from '../src/services/account.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400 * 1000).toISOString().slice(0, 10);

test('configuration: an on/off switch is never decided by a typo, and production cannot run the demo', () => {
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.equal(loadConfig({ HUSHLIST_DEMO: off }).demoMode, false, off);
  }
  for (const on of ['1', 'true', 'on', 'yes']) assert.equal(loadConfig({ HUSHLIST_DEMO: on }).demoMode, true, on);
  assert.equal(loadConfig({}).demoMode, true);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).demoMode, false);
  assert.equal(loadConfig({ NODE_ENV: 'production', HUSHLIST_DEMO: '' }).demoMode, false);
  assert.throws(() => loadConfig({ HUSHLIST_DEMO: 'flase' }), /must be 1 or 0/);
  assert.throws(() => loadConfig({ HUSHLIST_TRUST_PROXY: 'maybe' }), /must be 1 or 0/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', HUSHLIST_DEMO: '1' }), /cannot be on/);
});

test('demo mode refuses anything that arrived through a proxy', async () => {
  const app = await startApp();
  try {
    for (const header of ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Real-IP', 'Forwarded']) {
      const res = await app.guest.get('/api/session', { [header]: '203.0.113.9' });
      assert.equal(res.status, 421, header);
    }
    assert.equal((await app.guest.post('/api/auth/demo-login', { user_id: 'usr_justin' }, { 'X-Forwarded-For': '203.0.113.9' })).status, 421);
  } finally { await app.close(); }
});

test('codes: never readable back through the app, required at every step, and one requester cannot lock an address', async () => {
  const app = await startApp();
  try {
    const maya = await app.as('usr_maya');
    const started = await app.guest.post('/api/auth/start', { email: 'maya@smith.example' });
    const guestClaim = await app.guest.post('/api/claims', { item_id: 'itm_j1', guest_email: 'maya@smith.example' });
    const inbox = JSON.stringify((await maya.get('/api/notifications')).json);
    assert.ok(!inbox.includes(started.json.demo_code));
    assert.ok(!inbox.includes(guestClaim.json.claim.demo_verification_code));
    assert.ok(!/sign-in code|verification code/i.test(inbox), 'code messages are not listed at all');
    const stored = app.db.prepare("SELECT body FROM notifications_outbox WHERE event_type IN ('sign_in_code', 'guest_verification_code')").all();
    assert.ok(stored.length >= 2 && stored.every(r => !/\d{6}/.test(r.body)), 'the stored copy holds no code');

    // New address: the code is needed on the profile step too, not just the challenge id.
    const fresh = await app.guest.post('/api/auth/start', { email: 'fresh@example.com' });
    await app.guest.post('/api/auth/verify', { challenge_id: fresh.json.challenge_id, code: fresh.json.demo_code });
    const noCode = await app.guest.post('/api/auth/verify', { challenge_id: fresh.json.challenge_id, name: 'Intruder' });
    assert.equal(noCode.status, 400);
    assert.equal(noCode.headers.get('set-cookie'), null);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'fresh@example.com'").get().n, 0);
  } finally { await app.close(); }

  // One requester hammering an address is stopped; the owner, asking from elsewhere, is not.
  const db = testDb();
  for (let i = 0; i < 5; i++) startSignIn(db, { email: 'victim@example.com', requester: '198.51.100.7' });
  assert.throws(() => startSignIn(db, { email: 'victim@example.com', requester: '198.51.100.7' }), /Too many codes/);
  const own = startSignIn(db, { email: 'victim@example.com', requester: '203.0.113.50' });
  assert.equal(completeSignIn(db, { challengeId: own.challenge_id, code: own.code, profile: { name: 'Victim', birthday_month: 2, birthday_day: 30 } }).user.birthday_day, null, 'February has no 30th');
});

test('extension tokens can add wishes and nothing else, and each credential works only where it belongs', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const token = (await justin.post('/api/auth/tokens')).json.token;
    const ext = app.guest.withHeaders({ Authorization: `Bearer ${token}` });

    assert.equal((await ext.get('/api/lists')).status, 200);
    assert.equal((await ext.post('/api/items', { list_id: 'lst_justin_holiday', title: 'From the extension' })).status, 201);
    for (const [method, path, body] of [
      ['get', '/api/export'], ['get', '/api/admin'], ['get', '/api/notifications'], ['get', '/api/dashboard'],
      ['post', '/api/auth/tokens', {}], ['del', '/api/account', { confirm: true }],
      ['patch', '/api/lists/lst_justin_holiday', { name: 'Renamed' }], ['del', '/api/items/itm_j1']
    ]) {
      assert.equal((await ext[method](path, body)).status, 403, `${method} ${path}`);
    }
    assert.equal(app.db.prepare("SELECT status FROM users WHERE id = 'usr_justin'").get().status, 'active');

    // An extension token presented as a cookie, or a browser session presented as a bearer token, is nobody.
    const asCookie = app.client(`hl_session=${token}`);
    assert.equal((await asCookie.get('/api/session')).json.current_user, null);
    assert.equal((await asCookie.post('/api/auth/tokens')).status, 401);
    const webToken = (await app.guest.post('/api/auth/demo-login', { user_id: 'usr_maya' })).headers.get('set-cookie').split(';')[0].split('=')[1];
    assert.equal((await app.guest.withHeaders({ Authorization: `Bearer ${webToken}` }).get('/api/session')).json.current_user, null);
  } finally { await app.close(); }
});

test('the seal follows the reservations: moving, re-dating or reusing a list never opens them early', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const openable = async (id) => (await justin.patch(`/api/lists/${id}`, { action: 'reveal' })).status === 200 &&
      (await justin.get(`/api/lists/${id}`)).json.list.can_see_claims;

    // An old surprise list whose occasion is long past.
    const old = (await justin.post('/api/lists', { name: 'Last year' })).json.list;
    app.db.prepare('UPDATE lists SET event_date = ? WHERE id = ?').run('2025-01-01', old.id);
    // Moving something onto it (reserved or not: same answer) re-seals it for at least a week…
    const claimed = await justin.patch('/api/items/itm_j2', { action: 'move_to_list', target_list_id: old.id });
    assert.equal(claimed.status, 200);
    assert.equal(await openable(old.id), false);
    const unlock = (await justin.get(`/api/lists/${old.id}`)).json.list.reveal_unlocks_on;
    // …and not before the list it came from could have been opened.
    const sourceUnlock = (await justin.get('/api/lists/lst_justin_holiday')).json.list.reveal_unlocks_on;
    assert.ok(unlock >= sourceUnlock && unlock >= inDays(7), `${unlock} vs ${sourceUnlock}`);
    // The giver is told where the item went.
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM notifications_outbox WHERE recipient_user_id = 'usr_elena' AND subject LIKE '%moved to another list%'").get().n, 1);

    // Pulling the date in does not pull the opening in.
    const before = (await justin.get('/api/lists/lst_justin_holiday')).json.list.reveal_unlocks_on;
    const redated = await justin.patch('/api/lists/lst_justin_holiday', { event_date: today() });
    assert.equal(redated.status, 200);
    assert.equal(redated.json.list.reveal_unlocks_on, before);
    assert.equal(await openable('lst_justin_holiday'), false);

    // Reusing a list never keeps a date that has passed.
    const maya = await app.as('usr_maya');
    app.db.prepare("UPDATE lists SET event_date = '2025-03-03' WHERE id = 'lst_maya_bday'").run();
    await maya.patch('/api/lists/lst_maya_bday', { action: 'archive' });
    const reused = (await maya.patch('/api/lists/lst_maya_bday', { action: 'reuse' })).json.list;
    assert.equal(reused.event_date, null);
    assert.equal((await maya.patch('/api/lists/lst_maya_bday', { action: 'reveal' })).status, 409);
    const dated = (await maya.patch('/api/lists/lst_maya_bday', { event_date: today() })).json.list;
    assert.ok(dated.reveal_unlocks_on >= inDays(7));
  } finally { await app.close(); }
});

test('archived lists are closed: nothing on them is edited, repriced, reordered or moved', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const other = (await justin.post('/api/lists', { name: 'Other' })).json.list;
    await justin.patch('/api/lists/lst_justin_holiday', { action: 'archive' });
    assert.equal((await justin.patch('/api/items/itm_j1', { title: 'Edited' })).status, 409);
    assert.equal((await justin.post('/api/items/itm_j1/recheck', { new_price: 1 })).status, 409);
    assert.equal((await justin.patch('/api/items/itm_j1', { action: 'reorder', sort_order: 3 })).status, 409);
    assert.equal((await justin.patch('/api/items/itm_j1', { action: 'move_to_list', target_list_id: other.id })).status, 409);
    assert.equal((await justin.patch('/api/lists/lst_justin_holiday', { visibility: 'private' })).status, 409);
    assert.equal((await justin.patch('/api/items/itm_j1', { action: 'copy_to_list', target_list_id: other.id })).status, 201, 'copying out is fine');
    // A duplicate on an archived list no longer blocks adding the same thing somewhere open.
    const archivedTitle = app.db.prepare("SELECT title FROM items WHERE id = 'itm_j3'").get().title;
    assert.equal((await justin.post('/api/items', { list_id: other.id, title: archivedTitle })).status, 201);
  } finally { await app.close(); }
});

test('people on a list: only the owner chooses them, they are told, they can leave, and a block removes them', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const elena = await app.as('usr_elena');
    const arthur = await app.as('usr_arthur');
    const list = (await justin.post('/api/lists', { name: 'Shared', co_owner_ids: ['usr_elena'], helper_user_id: 'usr_maya' })).json.list;
    const privateList = (await justin.post('/api/lists', { name: 'Private plans', visibility: 'private' })).json.list;
    await justin.post('/api/items', { list_id: privateList.id, title: 'Engagement ring' });
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM notifications_outbox WHERE recipient_user_id = 'usr_elena' AND event_type = 'added_to_list'").get().n, 1);

    // A co-owner edits wishes, not people or reach.
    assert.equal((await elena.patch(`/api/lists/${list.id}`, { name: 'Renamed by Elena' })).status, 200);
    for (const change of [{ helper_user_id: 'usr_arthur' }, { helper_user_id: null }, { co_owner_ids: ['usr_elena', 'usr_arthur'] }, { visibility: 'private' }, { action: 'reveal' }]) {
      assert.equal((await elena.patch(`/api/lists/${list.id}`, change)).status, 403, JSON.stringify(change));
    }
    // …and learns nothing about the owner's other lists from the duplicate check.
    const dup = await elena.post('/api/items', { list_id: list.id, title: 'Engagement ring' });
    assert.equal(dup.status, 201);

    // The owner cannot make themselves the helper of their own sealed list.
    assert.equal((await justin.patch(`/api/lists/${list.id}`, { helper_user_id: 'usr_justin' })).status, 400);
    assert.equal((await justin.patch(`/api/lists/${list.id}`, { helper_user_id: 'usr_elena' })).status, 400, 'nor a co-owner');

    // Untyped input is ignored rather than crashing.
    assert.equal((await justin.patch(`/api/lists/${list.id}`, { group_ids: [{}], co_owner_ids: [null, 7, 'usr_elena'] })).status, 200);
    assert.equal((await justin.post('/api/lists', { name: 'Odd', group_ids: [{}], co_owner_ids: 'usr_elena' })).status, 201);

    // Circles a list is shared with can be changed after the fact.
    const shared = (await justin.patch(`/api/lists/${list.id}`, { group_ids: ['grp_smith'] })).json.list;
    assert.deepEqual(shared.shared_with_groups.map(g => g.id), ['grp_smith']);
    assert.deepEqual((await justin.patch(`/api/lists/${list.id}`, { group_ids: [] })).json.list.shared_with_groups, []);
    assert.equal((await arthur.patch(`/api/lists/${list.id}`, { group_ids: ['grp_smith'] })).status, 403);

    // Taking a list off link sharing retires the old link.
    const oldToken = shared.share_token;
    await justin.patch(`/api/lists/${list.id}`, { visibility: 'specific' });
    const relinked = (await justin.patch(`/api/lists/${list.id}`, { visibility: 'link' })).json.list;
    assert.notEqual(relinked.share_token, oldToken);
    assert.equal((await app.guest.get(`/api/lists/${oldToken}`)).status, 404);

    // Someone named on a list can step away; a stranger cannot "leave" to probe.
    assert.equal((await arthur.patch(`/api/lists/${list.id}`, { action: 'leave' })).status, 404);
    assert.equal((await elena.patch(`/api/lists/${list.id}`, { action: 'leave' })).status, 200);
    assert.equal((await elena.patch(`/api/lists/${list.id}`, { name: 'x' })).status, 403);

    // Blocking ends helper and co-owner roles, in both directions, and stops new ones.
    await justin.patch(`/api/lists/${list.id}`, { co_owner_ids: ['usr_arthur'] });
    await justin.post('/api/blocks', { user_id: 'usr_arthur' });
    await justin.post('/api/blocks', { user_id: 'usr_maya' });
    const after = (await justin.get(`/api/lists/${list.id}`)).json.list;
    assert.deepEqual([after.co_owner_ids, after.helpers], [[], []]);
    assert.equal((await arthur.get(`/api/lists/${list.id}`)).status, 404);
    assert.equal((await arthur.post('/api/lists', { name: 'Gotcha', co_owner_ids: ['usr_justin'] })).status, 400, 'a blocked person cannot attach themselves to the blocker');
    assert.equal((await justin.patch(`/api/lists/${list.id}`, { helper_user_id: 'usr_maya' })).status, 400);
    // A guardian is never cut off from their own child by another guardian's block.
    assert.equal((await (await app.as('usr_maya')).get('/api/lists/lst_leo_bday')).json.list.viewer_role, 'guardian');
  } finally { await app.close(); }
});

test('circles: organizers hold the invite, can renew it and remove people; joining shares nothing by itself', async () => {
  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const elena = await app.as('usr_elena');
    const mine = (await justin.get('/api/groups')).json.groups[0];
    assert.equal(mine.invite_code, 'SMITH-FAMILY');
    assert.equal((await elena.get('/api/groups')).json.groups[0].invite_code, null);
    assert.equal((await elena.post('/api/groups/grp_smith/invite')).status, 404);

    // A list scoped to one circle stays scoped to it when its owner joins another.
    const book = (await elena.post('/api/groups', { name: 'Book club' })).json.group;
    const bookCode = (await elena.get('/api/groups')).json.groups.find(g => g.id === book.id).invite_code;
    const familyOnly = (await justin.post('/api/lists', { name: 'Family only', visibility: 'specific', group_ids: ['grp_smith'] })).json.list;
    const reader = await app.signUp('reader@example.com', 'Reader', { invite_code: bookCode });
    assert.equal((await justin.post('/api/groups/join', { invite_code: bookCode.toLowerCase() })).status, 200);
    assert.equal((await reader.get(`/api/lists/${familyOnly.id}`)).status, 404);
    assert.deepEqual((await justin.get(`/api/lists/${familyOnly.id}`)).json.list.shared_with_groups.map(g => g.id), ['grp_smith']);

    // A child's list is shared with the circles the guardian picks, not all of them.
    const kid = (await justin.post('/api/dependents', { name: 'Kid', group_ids: ['grp_smith'] })).json;
    assert.deepEqual(kid.list.shared_with_groups.map(g => g.id), ['grp_smith']);
    assert.equal((await reader.get(`/api/lists/${kid.list.id}`)).status, 404);
    assert.equal((await reader.post('/api/dependents', { name: 'Other kid', group_ids: ['grp_smith'] })).status, 403);

    // Renewing the invite retires the old one; removing a member ends their access.
    const renewed = (await justin.post('/api/groups/grp_smith/invite')).json.invite_code;
    assert.notEqual(renewed, 'SMITH-FAMILY');
    const mallory = await app.signUp('mallory@example.com', 'Mallory');
    assert.equal((await mallory.post('/api/groups/join', { invite_code: 'SMITH-FAMILY' })).status, 404);
    assert.equal((await mallory.post('/api/groups/join', { invite_code: renewed })).status, 200);
    assert.equal((await mallory.get('/api/lists/lst_leo_bday')).status, 200);
    assert.equal((await elena.del(`/api/groups/grp_smith/members/${mallory.user.id}`)).status, 403);
    assert.equal((await justin.del(`/api/groups/grp_smith/members/${mallory.user.id}`)).status, 200);
    assert.equal((await mallory.get('/api/lists/lst_leo_bday')).status, 404);

    // Blocked by an organizer: the code stops working for them, even after closing the account and signing up again.
    await justin.post('/api/blocks', { user_id: mallory.user.id });
    const wrong = await mallory.post('/api/groups/join', { invite_code: 'NOT-A-CODE' });
    const blocked = await mallory.post('/api/groups/join', { invite_code: renewed });
    assert.deepEqual([blocked.status, blocked.json], [wrong.status, wrong.json]);
    await mallory.del('/api/account', { confirm: true });
    const again = await app.signUp('mallory@example.com', 'Mallory Again', { invite_code: renewed });
    assert.deepEqual((await again.get('/api/groups')).json.groups, []);
    assert.equal((await again.get('/api/lists/justin-winter-2026')).status, 404, 'the block came back with the address');

    // Leaving: anyone can; if the last organizer goes, the longest-standing member takes over.
    assert.equal((await justin.del('/api/groups/grp_smith/members/usr_justin')).status, 200);
    const organizers = app.db.prepare("SELECT user_id FROM group_members WHERE group_id = 'grp_smith' AND role = 'organizer'").all();
    assert.equal(organizers.length, 1);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM list_shares WHERE grantee_id = 'grp_smith' AND list_id = 'lst_justin_holiday'").get().n, 0, 'their shares with the circle leave with them');
  } finally { await app.close(); }
});

test('closing an account leaves no trace of the person and no loose ends for others', async () => {
  const app = await startApp();
  try {
    const guest = await app.guest.post('/api/claims', { item_id: 'itm_m3', guest_email: 'nina@example.com', guest_name: 'Nina Real' });
    const verified = await app.guest.post('/api/claims/verify', { claim_id: guest.json.claim.id, code: guest.json.claim.demo_verification_code });
    const nina = await app.signUp('nina@example.com', 'Nina Real');
    const listId = (await nina.get('/api/lists')).json.lists[0].id;
    await nina.post('/api/items', { list_id: listId, title: 'Bike', notes: 'Call Nina Real on 555-0100', giving_instructions: 'Venmo @nina-real', allow_group_chip_in: true, price: 100 });
    const club = (await nina.post('/api/groups', { name: "Nina's club" })).json.group;
    const code = (await nina.get('/api/groups')).json.groups[0].invite_code;
    const friend = await app.signUp('friend@example.com', 'Friend', { invite_code: code });

    assert.equal((await nina.del('/api/account', { confirm: true })).status, 200);
    const dump = JSON.stringify({
      users: app.db.prepare('SELECT * FROM users').all(),
      lists: app.db.prepare('SELECT * FROM lists').all(),
      items: app.db.prepare('SELECT * FROM items').all(),
      claims: app.db.prepare('SELECT guest_name, guest_email, order_note FROM claims').all(),
      outbox: app.db.prepare('SELECT * FROM notifications_outbox').all(),
      challenges: app.db.prepare('SELECT * FROM auth_challenges').all()
    });
    for (const trace of ['Nina', 'nina@example.com', '555-0100', 'nina-real']) assert.ok(!dump.includes(trace), trace);

    // The guest reservation made with the same address is anonymised, and its old manage link is dead.
    const old = app.guest.withHeaders({ 'X-Guest-Token': verified.json.claim.manage_token });
    assert.equal((await old.patch(`/api/claims/${guest.json.claim.id}`, { status: 'released' })).status, 403);
    // The circle they organised still has an organizer.
    assert.equal((await friend.get('/api/groups')).json.groups.find(g => g.id === club.id).my_role, 'organizer');
  } finally { await app.close(); }
});

test('administrators: the configured list decides, and nothing about their own sealed lists reaches the console', async () => {
  const db = testDb();
  syncAdmins(db, new Set());
  assert.equal(db.prepare("SELECT is_admin FROM users WHERE id = 'usr_justin'").get().is_admin, 1, 'an empty list changes nothing');
  syncAdmins(db, new Set(['maya@smith.example']));
  assert.deepEqual(db.prepare("SELECT id FROM users WHERE is_admin = 1").all().map(u => u.id), ['usr_maya']);

  const app = await startApp();
  try {
    const justin = await app.as('usr_justin');
    const elena = await app.as('usr_elena');
    const before = (await justin.get('/api/admin')).json;
    // Activity on the admin's own sealed list…
    const claim = (await elena.post('/api/claims', { item_id: 'itm_j1', qty: 1 })).json.claim;
    await elena.patch(`/api/claims/${claim.id}`, { status: 'purchased' });
    const after = (await justin.get('/api/admin')).json;
    // …changes nothing the admin can see: not the audit log, not the activity feed, not the row counts.
    assert.deepEqual(after.analytics_events, before.analytics_events);
    assert.deepEqual(after.claim_audit_log, before.claim_audit_log);
    assert.deepEqual(after.overridable_claims, before.overridable_claims);
    // Activity elsewhere still shows.
    await elena.post('/api/claims', { item_id: 'itm_m3' });
    assert.equal((await justin.get('/api/admin')).json.analytics_events.length, before.analytics_events.length + 1);
  } finally { await app.close(); }
});

test('mail: held for quiet hours on the recipient\'s own clock and then actually sent; a digest never repeats itself', () => {
  const db = testDb();
  const sent = [];
  setMailTransport((m) => sent.push(m));
  try {
    // No known time zone: nothing is held back on a guess.
    const plain = sendNotification(db, { recipientUserId: 'usr_elena', eventType: 'new_follower', subject: 'a', body: 'b' });
    assert.equal(plain.sent, true);
    assert.equal(sent.length, 0, 'nothing leaves before the work is committed');
    assert.equal(dispatchOutbox(db), 1);
    assert.equal(sent.length, 1);
    assert.equal(dispatchOutbox(db), 0, 'and it is sent once');

    // A zone where it is the middle of the night right now, including a half-hour zone.
    const zones = ['Asia/Kolkata', 'Asia/Kathmandu', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'];
    const localHour = (zone) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }).format(new Date()));
    const asleep = zones.find(z => localHour(z) >= 22 || localHour(z) < 7);
    assert.ok(asleep, 'some zone is asleep');
    db.prepare("UPDATE users SET time_zone = ? WHERE id = 'usr_arthur'").run(asleep);
    const held = sendNotification(db, { recipientUserId: 'usr_arthur', eventType: 'new_follower', subject: 'night', body: 'b' });
    assert.equal(held.sent, false);
    assert.equal(dispatchOutbox(db), 0);
    assert.equal(dispatchOutbox(db, new Date(new Date(held.scheduled_for).getTime() + 1000)), 1, 'sent when quiet hours end');
    assert.equal(sent.at(-1).subject, 'night');
    const wakeHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: asleep }).format(new Date(held.scheduled_for)));
    const wakeMinute = Number(new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: asleep }).format(new Date(held.scheduled_for)));
    // 08:00 on their clock, not the server's (an hour either side only on the night the clocks change).
    assert.ok([7, 8, 9].includes(wakeHour) && wakeMinute === 0, `${wakeHour}:${wakeMinute} in ${asleep}`);
    // Things that cannot wait are never held.
    assert.equal(sendNotification(db, { recipientUserId: 'usr_arthur', eventType: 'claimed_item_withdrawn', subject: 'now', body: 'b' }).sent, true);
  } finally { setMailTransport(null); }

  // Digest: what is new since the last one, for items that are still there.
  const d1 = testDb();
  const add = (title, listId = 'lst_justin_holiday') => importAmazonList(d1, {
    listId, canEdit: () => true, itemsPayload: [{ title, price: '$10.00' }], actorId: 'usr_justin'
  }).imported[0];
  const kept = add('Digest kettle');
  const gone = add('Digest ghost');
  d1.prepare("UPDATE items SET status = 'deleted' WHERE id = ?").run(gone.id);
  const first = generateFollowerDigest(d1, { followerUserId: 'usr_elena' });
  const body = d1.prepare('SELECT body FROM notifications_outbox WHERE id = ?').get(first.notification.id).body;
  assert.match(body, /Digest kettle/);
  assert.ok(!body.includes('Digest ghost'), 'removed items are not announced');
  assert.equal(d1.prepare('SELECT COUNT(*) AS n FROM price_snapshots WHERE item_id = ?').get(kept.id).n, 1, 'imports start a price history');
  // Next day: only what happened since.
  d1.prepare("UPDATE notifications_outbox SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 86400 * 1000 - 5000).toISOString(), first.notification.id);
  d1.prepare("UPDATE events SET at = ? WHERE at <= ?").run(new Date(Date.now() - 2 * 86400 * 1000).toISOString(), new Date().toISOString());
  add('Digest newcomer');
  const second = generateFollowerDigest(d1, { followerUserId: 'usr_elena' });
  const body2 = d1.prepare('SELECT body FROM notifications_outbox WHERE id = ?').get(second.notification.id).body;
  assert.match(body2, /Digest newcomer/);
  assert.ok(!body2.includes('Digest kettle'), 'yesterday\'s news is not repeated');
});

test('limits hold on every way in: imports and moves cannot overfill a list', () => {
  const db = testDb();
  const rows = Array.from({ length: 200 }, (_, i) => ({ title: `Bulk item ${i}` }));
  const run = (prefix) => importAmazonList(db, {
    listId: 'lst_justin_holiday', canEdit: () => true, itemsPayload: rows.map(r => ({ title: `${prefix} ${r.title}` })), maxItemsPerList: 500
  });
  run('a'); run('b');
  const third = run('c');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE list_id = 'lst_justin_holiday' AND status IN ('active', 'received')").get().n, 500);
  assert.ok(third.failed.length > 0 && third.failed.every(f => /full/.test(f.reason)));

  // A null quantity is "not given", not "one": it must not release anyone's hold.
  const d2 = testDb();
  const hold = createClaim(d2, { itemId: 'itm_j4', claimerUserId: 'usr_elena' });
  d2.prepare("UPDATE items SET always_wanted = 0, qty_wanted = 5 WHERE id = 'itm_j4'").run();
  const second = createClaim(d2, { itemId: 'itm_j4', claimerUserId: 'usr_arthur' });
  const edited = handleOwnerEditItem(d2, { itemId: 'itm_j4', ownerId: 'usr_justin', updates: { qty_wanted: null, notes: 'x' } });
  assert.equal(edited.qty_wanted, 5);
  assert.deepEqual([hold.id, second.id].map(id => d2.prepare('SELECT status FROM claims WHERE id = ?').get(id).status), ['reserved', 'reserved']);
  transitionClaimState(d2, { claimId: hold.id, newState: 'purchased', actorId: 'usr_elena' });
  deleteAccount(d2, 'usr_arthur');
  assert.equal(d2.prepare('SELECT guest_name FROM claims WHERE id = ?').get(second.id).guest_name, 'Former member');
});
