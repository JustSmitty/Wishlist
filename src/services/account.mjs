/**
 * Account deletion.
 *
 * The user row is kept as an anonymous tombstone ("Deleted user") rather than
 * removed. A hard delete would cascade through the user's lists and items and
 * destroy other people's records: the gifts they reserved or bought from those
 * lists, their pledges, and the audit trail. Personal data is erased; the
 * records other people rely on are kept.
 */

import { inTransaction } from '../db/schema.mjs';
import { conflict } from '../errors.mjs';
import { archiveList } from './claims.mjs';

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
        throw conflict('You are the only administrator. Make someone else an administrator before deleting this account.');
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

  // Lists: close them, release open holds (givers are told), keep purchases.
  const lists = db.prepare('SELECT * FROM lists WHERE owner_id = ?').all(userId);
  for (const list of lists) {
    archiveList(db, list, { reason: 'the list owner closed their account' });
    db.prepare("UPDATE lists SET visibility = 'private', co_owner_ids = '[]' WHERE id = ?").run(list.id);
    db.prepare('DELETE FROM list_shares WHERE list_id = ?').run(list.id);
    db.prepare("UPDATE contributions SET status = 'withdrawn' WHERE list_id = ? AND status = 'pledged'").run(list.id);
  }

  // Gifts this person reserved for others: the state stays accurate, the
  // identity and their private note go.
  db.prepare(`
    UPDATE claims
    SET claimer_user_id = NULL, guest_name = 'Former member', guest_email = NULL, order_note = NULL,
        show_name_to_givers = 0, updated_at = ?
    WHERE claimer_user_id = ?
  `).run(nowIso, userId);
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

  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM guardian_links WHERE guardian_id = ? OR dependent_id = ?').run(userId, userId);
  db.prepare('DELETE FROM group_members WHERE user_id = ?').run(userId);
  db.prepare("DELETE FROM list_shares WHERE grantee_type = 'user' AND grantee_id = ?").run(userId);
  db.prepare("DELETE FROM follows WHERE follower_id = ? OR (target_type = 'user' AND target_id = ?)").run(userId, userId);
  db.prepare('DELETE FROM secret_ideas WHERE subject_user_id = ? OR author_id = ?').run(userId, userId);
  db.prepare('DELETE FROM budgets WHERE owner_id = ? OR subject_user_id = ?').run(userId, userId);
  db.prepare('DELETE FROM occasions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM notification_preferences WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM notifications_outbox WHERE recipient_user_id = ?').run(userId);
  db.prepare('DELETE FROM secret_santa_pairings WHERE giver_user_id = ? OR recipient_user_id = ?').run(userId, userId);
  db.prepare('UPDATE abuse_reports SET reporter_id = NULL WHERE reporter_id = ?').run(userId);

  db.prepare(`
    UPDATE users
    SET name = 'Deleted user', email = NULL, avatar_url = NULL, birthday_month = NULL, birthday_day = NULL,
        is_admin = 0, status = 'deleted', auth_credential_id = NULL
    WHERE id = ?
  `).run(userId);
}
