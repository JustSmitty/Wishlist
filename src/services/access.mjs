/**
 * Relationship predicates shared by every route and service.
 *
 * Keeping them in one place matters: the earlier code re-derived "who is
 * related to whom" separately for list reads, the dashboard, the digest and
 * secret ideas, and the copies had drifted apart (a block applied in one
 * place and not the others).
 */

import { sha256 } from '../db/schema.mjs';

export function getActiveUser(db, userId) {
  if (!userId || typeof userId !== 'string') return null;
  return db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(userId) || null;
}

export function isGuardianOf(db, guardianId, dependentId) {
  if (!guardianId || !dependentId) return false;
  return Boolean(db.prepare(
    'SELECT 1 FROM guardian_links WHERE guardian_id = ? AND dependent_id = ?'
  ).get(guardianId, dependentId));
}

export function sharesGroup(db, userA, userB) {
  if (!userA || !userB || userA === userB) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM group_members a
    JOIN group_members b ON a.group_id = b.group_id
    WHERE a.user_id = ? AND b.user_id = ?
  `).get(userA, userB));
}

export function isGroupMember(db, groupId, userId) {
  if (!groupId || !userId) return false;
  return Boolean(db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId));
}

export function isGroupOrganizer(db, groupId, userId) {
  if (!groupId || !userId) return false;
  return Boolean(db.prepare(
    "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND role = 'organizer'"
  ).get(groupId, userId));
}

// ---------------------------------------------------------------- blocks

/**
 * True when `subjectId` has blocked `viewerId`.
 *
 * A block belongs to exactly one person. A guardian who blocks someone for
 * themselves has not blocked them for their child: that is a separate block
 * made in the child's name, so one guardian cannot silently cut relatives —
 * or the other guardian — off from the child. A guardian is never blocked
 * from their own child.
 */
export function isBlockedBy(db, viewerId, subjectId) {
  if (!viewerId || !subjectId || viewerId === subjectId) return false;
  if (isGuardianOf(db, viewerId, subjectId)) return false;
  return Boolean(db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(subjectId, viewerId));
}

export function eitherBlocked(db, a, b) {
  return isBlockedBy(db, a, b) || isBlockedBy(db, b, a);
}

/**
 * Blocks a person and removes every standing tie between the two: follows,
 * helper roles and co-ownership in both directions. Blocking is the only
 * safety control people have, so it has to end access that was granted
 * earlier, not just stop new access.
 */
export function blockUser(db, blockerId, blockedId) {
  if (!blockerId || !blockedId || blockerId === blockedId) return;
  const email = db.prepare('SELECT email FROM users WHERE id = ?').get(blockedId)?.email || null;
  db.prepare(`
    INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, blocked_email_hash, created_at) VALUES (?, ?, ?, ?)
  `).run(blockerId, blockedId, email ? sha256(email.toLowerCase()) : null, new Date().toISOString());

  db.prepare("DELETE FROM follows WHERE follower_id = ? AND target_type = 'user' AND target_id = ?").run(blockedId, blockerId);
  db.prepare("DELETE FROM follows WHERE follower_id = ? AND target_type = 'list' AND target_id IN (SELECT id FROM lists WHERE owner_id = ?)").run(blockedId, blockerId);

  for (const [owner, other] of [[blockerId, blockedId], [blockedId, blockerId]]) {
    db.prepare(`
      DELETE FROM list_shares
      WHERE grantee_type = 'user' AND grantee_id = ? AND list_id IN (SELECT id FROM lists WHERE owner_id = ?)
    `).run(other, owner);
    removeCoOwner(db, owner, other);
  }
}

export function unblockUser(db, blockerId, blockedId) {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
}

/** Removes `userId` as co-owner from lists owned by `ownerId` (or from every list when ownerId is null). */
export function removeCoOwner(db, ownerId, userId) {
  const rows = ownerId
    ? db.prepare('SELECT id, co_owner_ids FROM lists WHERE owner_id = ? AND co_owner_ids LIKE ?').all(ownerId, `%"${userId}"%`)
    : db.prepare('SELECT id, co_owner_ids FROM lists WHERE co_owner_ids LIKE ?').all(`%"${userId}"%`);
  for (const row of rows) {
    let ids = [];
    try { ids = JSON.parse(row.co_owner_ids).filter(id => id !== userId); } catch { /* malformed: reset */ }
    db.prepare('UPDATE lists SET co_owner_ids = ? WHERE id = ?').run(JSON.stringify(ids), row.id);
  }
}

/** Re-attaches blocks that were placed on an address before its account was deleted. */
export function reapplyBlocksForEmail(db, userId, email) {
  if (!email) return;
  db.prepare('UPDATE OR IGNORE blocks SET blocked_id = ? WHERE blocked_id IS NULL AND blocked_email_hash = ?')
    .run(userId, sha256(String(email).toLowerCase()));
}

// ---------------------------------------------------------------- circles

/**
 * "In the same circle": shares a group with the person, or — for a child
 * profile, which cannot join groups — is a guardian or shares a group with one.
 * This is the relationship that unlocks giver names, payment handles and
 * secret ideas. Following someone does not.
 */
export function inSameCircle(db, viewerId, subjectId) {
  if (!viewerId || !subjectId || viewerId === subjectId) return false;
  if (isBlockedBy(db, viewerId, subjectId)) return false;
  if (sharesGroup(db, viewerId, subjectId)) return true;
  if (isGuardianOf(db, viewerId, subjectId)) return true;
  return Boolean(db.prepare(`
    SELECT 1 FROM guardian_links gl
    JOIN group_members g ON g.user_id = gl.guardian_id
    JOIN group_members me ON me.group_id = g.group_id
    WHERE gl.dependent_id = ? AND me.user_id = ?
  `).get(subjectId, viewerId));
}

export function hasApprovedFollow(db, followerId, { userId = null, listId = null } = {}) {
  if (!followerId) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM follows
    WHERE follower_id = ? AND status = 'approved'
      AND ((target_type = 'user' AND target_id = ?) OR (target_type = 'list' AND target_id = ?))
  `).get(followerId, userId, listId));
}

/**
 * People who may be named as helper / co-owner / co-guardian by `actorId`:
 * active adults in a shared circle, with no block between the two in either
 * direction.
 */
export function canNameAsCollaborator(db, actorId, otherId) {
  const other = getActiveUser(db, otherId);
  if (!other || other.is_dependent || other.id === actorId) return false;
  if (eitherBlocked(db, actorId, otherId)) return false;
  return sharesGroup(db, actorId, otherId);
}
