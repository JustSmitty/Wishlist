/**
 * Account deletion.
 *
 * The user row is kept as an anonymous tombstone ("Deleted user") rather than
 * removed. A hard delete would cascade through the user's lists and items and
 * destroy other people's records: the gifts they reserved or bought from those
 * lists, their pledges, and the audit trail. Personal data is erased; the
 * records other people rely on are kept.
 */

import { inTransaction, secretToken, sha256 } from '../db/schema.mjs';
import { conflict } from '../errors.mjs';
import { archiveList, normalizeEmailForCap, recordClaimEvent } from './claims.mjs';
import { removeFromExchanges } from './secret-santa.mjs';

export function deleteAccount(db, userId) {
  return inTransaction(db, () => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(userId);
    if (!user) return { deleted: false };

    if (user.is_admin) {
      const otherAdmins = db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active' AND id != ?"
      ).get(user.id).n;
      const otherUsers = db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND is_dependent = 0 AND id != ?"
      ).get(user.id).n;
      if (otherAdmins === 0 && otherUsers > 0) {
        throw conflict('You are the only administrator. Add another address to HUSHLIST_ADMIN_EMAILS and have that person sign in before deleting this account.');
      }
    }

    // Child profiles with no other guardian cannot be left behind: nobody
    // could manage or close them, and their lists would stay reachable.
    const dependents = db.prepare('SELECT dependent_id FROM guardian_links WHERE guardian_id = ?').all(user.id);
    for (const { dependent_id } of dependents) {
      const others = db.prepare(
        'SELECT COUNT(*) AS n FROM guardian_links WHERE dependent_id = ? AND guardian_id != ?'
      ).get(dependent_id, user.id).n;
      if (others === 0) erasePerson(db, dependent_id);
    }

    erasePerson(db, user.id);
    return { deleted: true };
  });
}

function erasePerson(db, userId) {
  const nowIso = new Date().toISOString();
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const email = person?.email ? person.email.toLowerCase() : null;

  // Lists: close them (open holds released, open pledges cancelled, givers
  // told once each), keep purchases. What the person wrote on them goes; the
  // item names stay, because other people's gift records point at them.
  const lists = db.prepare('SELECT * FROM lists WHERE owner_id = ?').all(userId);
  for (const list of lists) {
    archiveList(db, list, { reason: 'its owner closed their account', label: 'a wishlist you were giving from' });
    db.prepare(`
      UPDATE lists SET name = 'Closed wishlist', visibility = 'private', co_owner_ids = '[]', cover_image = NULL, share_token = ?
      WHERE id = ?
    `).run(secretToken('shr'), list.id);
    db.prepare('DELETE FROM list_shares WHERE list_id = ?').run(list.id);
    db.prepare(`
      UPDATE items SET notes = NULL, giving_instructions = NULL, thank_you_note = NULL WHERE list_id = ?
    `).run(list.id);
    db.prepare("DELETE FROM follows WHERE target_type = 'list' AND target_id = ?").run(list.id);
  }

  // Gifts this person reserved for others: the state stays accurate, the
  // identity and their private note go. That includes reservations made as a
  // guest with the same address before they had an account. Each record gets
  // a new manage token so no link the person held still opens it.
  const theirClaims = db.prepare(`
    SELECT id, status, claimer_user_id, guest_email FROM claims
    WHERE claimer_user_id = ? OR (claimer_user_id IS NULL AND guest_email IS NOT NULL)
  `).all(userId).filter(c => c.claimer_user_id === userId ||
    (email && normalizeEmailForCap(c.guest_email) === normalizeEmailForCap(email)));
  for (const c of theirClaims) {
    db.prepare(`
      UPDATE claims
      SET claimer_user_id = NULL, guest_name = 'Former member', guest_email = NULL, order_note = NULL,
          show_name_to_givers = 0, verification_code = NULL, manage_token = ?, updated_at = ?
      WHERE id = ?
    `).run(secretToken('mng'), nowIso, c.id);
    // A hold they never bought would otherwise keep the item tied up, with
    // nobody left who could release it.
    if (c.status === 'reserved' || c.status === 'pending_verification') {
      db.prepare("UPDATE claims SET status = 'released', updated_at = ? WHERE id = ?").run(nowIso, c.id);
      recordClaimEvent(db, c.id, c.status, 'released', 'system', null, 'Released because the giver closed their account', nowIso);
    }
  }
  // Pledges not yet settled are cancelled; settled ones stay, anonymised.
  db.prepare("UPDATE contributions SET status = 'withdrawn' WHERE contributor_user_id = ? AND status = 'pledged'").run(userId);
  db.prepare(`
    UPDATE contributions
    SET contributor_user_id = NULL, guest_name = 'Former member', guest_email = NULL, note = NULL, show_name_to_givers = 0
    WHERE contributor_user_id = ?
  `).run(userId);

  // Remove them as co-owner anywhere else.
  const coOwned = db.prepare('SELECT id, co_owner_ids FROM lists WHERE co_owner_ids LIKE ?').all(`%"${userId}"%`);
  for (const l of coOwned) {
    let ids = [];
    try { ids = JSON.parse(l.co_owner_ids).filter(id => id !== userId); } catch { /* malformed: reset */ }
    db.prepare('UPDATE lists SET co_owner_ids = ? WHERE id = ?').run(JSON.stringify(ids), l.id);
  }

  // Any draw they are part of is closed up around them, not broken.
  removeFromExchanges(db, userId);

  // A circle is never left without an organizer.
  const circles = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId).map(r => r.group_id);
  db.prepare('DELETE FROM group_members WHERE user_id = ?').run(userId);
  for (const groupId of circles) {
    const organizers = db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND role = 'organizer'").get(groupId).n;
    if (organizers > 0) continue;
    const next = db.prepare(`
      SELECT gm.user_id FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ? AND u.status = 'active' AND u.is_dependent = 0 ORDER BY gm.joined_at ASC LIMIT 1
    `).get(groupId);
    if (next) db.prepare("UPDATE group_members SET role = 'organizer' WHERE group_id = ? AND user_id = ?").run(groupId, next.user_id);
    else db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
  }

  // Blocks other people placed on this person survive as a hash of the
  // address, so closing the account and signing up again does not lift them.
  // Blocks this person placed go with them.
  db.prepare('DELETE FROM blocks WHERE blocker_id = ?').run(userId);
  if (email) {
    db.prepare('UPDATE blocks SET blocked_id = NULL, blocked_email_hash = ? WHERE blocked_id = ?').run(sha256(email), userId);
  } else {
    db.prepare('DELETE FROM blocks WHERE blocked_id = ?').run(userId);
  }

  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM guardian_links WHERE guardian_id = ? OR dependent_id = ?').run(userId, userId);
  db.prepare("DELETE FROM list_shares WHERE grantee_type = 'user' AND grantee_id = ?").run(userId);
  db.prepare("DELETE FROM follows WHERE follower_id = ? OR (target_type = 'user' AND target_id = ?)").run(userId, userId);
  db.prepare('DELETE FROM secret_ideas WHERE subject_user_id = ? OR author_id = ?').run(userId, userId);
  db.prepare('DELETE FROM budgets WHERE owner_id = ? OR subject_user_id = ?').run(userId, userId);
  db.prepare('DELETE FROM occasions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM notification_preferences WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM notifications_outbox WHERE recipient_user_id = ? OR about_user_id = ?').run(userId, userId);
  if (email) {
    db.prepare('DELETE FROM notifications_outbox WHERE LOWER(recipient_email) = ?').run(email);
    db.prepare('DELETE FROM auth_challenges WHERE email = ?').run(email);
  }
  db.prepare('UPDATE abuse_reports SET reporter_id = NULL WHERE reporter_id = ?').run(userId);
  db.prepare('UPDATE events SET actor_id = NULL WHERE actor_id = ?').run(userId);

  db.prepare(`
    UPDATE users
    SET name = 'Deleted user', email = NULL, avatar_url = NULL, birthday_month = NULL, birthday_day = NULL,
        is_admin = 0, status = 'deleted', auth_credential_id = NULL, time_zone = NULL
    WHERE id = ?
  `).run(userId);
}
