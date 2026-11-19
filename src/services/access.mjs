/**
 * Relationship predicates shared by every route and service.
 *
 * Keeping them in one place matters: the earlier code re-derived "who is
 * related to whom" separately for list reads, the dashboard, the digest and
 * secret ideas, and the copies had drifted apart (a block applied in one
 * place and not the others).
 */

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

/**
 * True when `subjectId` (or, for a child profile, one of the child's
 * guardians) has blocked `viewerId`. A block is a follows row with
 * status = 'blocked' and it exists whether or not the viewer ever followed.
 */
export function isBlockedBy(db, viewerId, subjectId) {
  if (!viewerId || !subjectId) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM follows
    WHERE follower_id = ? AND target_type = 'user' AND status = 'blocked'
      AND (target_id = ? OR target_id IN (SELECT guardian_id FROM guardian_links WHERE dependent_id = ?))
  `).get(viewerId, subjectId, subjectId));
}

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

/** People who may be named as helper / co-owner / co-guardian by `actorId`. */
export function canNameAsCollaborator(db, actorId, otherId) {
  const other = getActiveUser(db, otherId);
  if (!other || other.is_dependent) return false;
  return sharesGroup(db, actorId, otherId);
}
