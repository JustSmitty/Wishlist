/**
 * Secret Santa draw within a group.
 *
 * - Only a group organizer can run a draw.
 * - Participants are the group's active adult members.
 * - Exclusions are unordered pairs who must not draw each other.
 * - Each participant can read only their own recipient. Pairings are stored
 *   server-side; anyone with direct database access can read them, so this is
 *   privacy from the other participants, not a cryptographic guarantee.
 */

import crypto from 'node:crypto';
import { uid, inTransaction } from '../db/schema.mjs';
import { badRequest, forbidden, notFound, conflict } from '../errors.mjs';
import { isGroupOrganizer } from './access.mjs';
import { cleanText, cleanDate, cleanPrice } from './capture.mjs';

export function createSecretSantaExchange(db, {
  groupId,
  name,
  eventDate,
  budgetLimit = 50,
  exclusions = [],
  createdBy
}) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(String(groupId ?? ''));
  if (!group) throw notFound('Circle not found');
  if (!isGroupOrganizer(db, group.id, createdBy)) {
    throw forbidden('Only an organizer of this circle can draw names');
  }

  const date = cleanDate(eventDate);
  if (!date) throw badRequest('Pick a valid exchange date');
  const budget = cleanPrice(budgetLimit, 100_000);
  if (budget === null) throw badRequest('Enter a valid budget');
  const cleanName = cleanText(name, 120) || 'Secret Santa';

  const members = db.prepare(`
    SELECT u.id FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ? AND u.status = 'active' AND u.is_dependent = 0
    ORDER BY u.id
  `).all(group.id).map(m => m.id);

  if (members.length < 3) {
    throw badRequest('A draw needs at least 3 people in the circle');
  }

  if (!Array.isArray(exclusions) || exclusions.length > 200) throw badRequest('Too many exclusions');
  const memberSet = new Set(members);
  const forbiddenPairs = new Set();
  const cleanExclusions = [];
  for (const pair of exclusions) {
    if (!Array.isArray(pair) || pair.length !== 2) throw badRequest('Each exclusion must name two people');
    const [a, b] = pair;
    if (!memberSet.has(a) || !memberSet.has(b) || a === b) {
      throw badRequest('Exclusions must name two different people in this circle');
    }
    forbiddenPairs.add(`${a}>${b}`);
    forbiddenPairs.add(`${b}>${a}`);
    cleanExclusions.push([a, b]);
  }

  // Prefer a draw with no "A gives to B and B gives to A" pairs. If the
  // exclusions make that impossible, a valid draw with mutual pairs is still
  // better than refusing a solvable request.
  const assignment = findAssignment(members, forbiddenPairs, true) || findAssignment(members, forbiddenPairs, false);
  if (!assignment) {
    throw conflict('Those exclusions leave no valid draw. Remove one and try again.');
  }

  const exchangeId = uid('ss');
  const nowIso = new Date().toISOString();

  inTransaction(db, () => {
    db.prepare(`
      INSERT INTO secret_santa_exchanges (
        id, group_id, name, event_date, budget_limit, exclusions, verification_hash, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exchangeId, group.id, cleanName, date, budget, JSON.stringify(cleanExclusions),
      // Legacy NOT NULL column. It was presented as a verifiable commitment,
      // but its salt was discarded so nothing could ever be checked against it.
      crypto.randomBytes(16).toString('hex'),
      createdBy, nowIso
    );
    const insertPairing = db.prepare(
      'INSERT INTO secret_santa_pairings (exchange_id, giver_user_id, recipient_user_id) VALUES (?, ?, ?)'
    );
    for (const [giverId, recipientId] of assignment) insertPairing.run(exchangeId, giverId, recipientId);
  });

  return {
    id: exchangeId,
    group_id: group.id,
    name: cleanName,
    event_date: date,
    budget_limit: budget,
    participant_count: members.length,
    created_at: nowIso
  };
}

/** Unbiased Fisher–Yates shuffle driven by the OS CSPRNG. */
function shuffled(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Randomised backtracking search for a derangement that respects the forbidden
 * pairs. Complete: if any valid assignment exists under the given rules it is
 * found (within a generous step budget). Givers with the fewest options are
 * placed first to keep it fast.
 */
function findAssignment(memberIds, forbiddenPairs, avoidMutual) {
  const options = new Map(memberIds.map(g => [
    g, memberIds.filter(r => r !== g && !forbiddenPairs.has(`${g}>${r}`))
  ]));
  const order = shuffled(memberIds).sort((a, b) => options.get(a).length - options.get(b).length);
  const taken = new Set();
  const result = new Map();
  let steps = 0;

  function place(idx) {
    if (idx === order.length) return true;
    // Bound the work so a hostile set of exclusions cannot stall the server.
    if (++steps > 250_000) return false;
    const giver = order[idx];
    for (const rec of shuffled(options.get(giver))) {
      if (taken.has(rec)) continue;
      if (avoidMutual && result.get(rec) === giver) continue;
      taken.add(rec);
      result.set(giver, rec);
      if (place(idx + 1)) return true;
      taken.delete(rec);
      result.delete(giver);
    }
    return false;
  }

  return place(0) ? result : null;
}
