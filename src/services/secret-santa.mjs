/**
 * Secret Santa draw within a group.
 *
 * - Only a group organizer can run a draw, for a date that has not passed.
 * - Participants are the group's active adult members.
 * - Exclusions are unordered pairs who must not draw each other. They are
 *   shown to every participant, and a set of exclusions that would leave only
 *   a couple of possible outcomes is refused — otherwise the person choosing
 *   them could work out (or dictate) who has whom.
 * - The draw is uniform: every outcome the rules allow is equally likely.
 *   There is no "avoid A↔B swaps" preference, because any such rule lets a
 *   participant rule out their own recipient as their giver.
 * - Each participant can read only their own recipient. Pairings are stored
 *   server-side; anyone with direct database access can read them, so this is
 *   privacy from the other participants, not a cryptographic guarantee.
 */

import crypto from 'node:crypto';
import { uid, inTransaction } from '../db/schema.mjs';
import { badRequest, forbidden, notFound, conflict } from '../errors.mjs';
import { isGroupOrganizer } from './access.mjs';
import { sendNotification } from './notifications.mjs';
import { cleanText, cleanDate, cleanPrice } from './capture.mjs';

const MAX_PARTICIPANTS = 200;

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
  // One day of slack for time zones ahead of the server's clock.
  if (date < new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10)) {
    throw badRequest('Pick today or a later date for the exchange');
  }
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
  if (members.length > MAX_PARTICIPANTS) {
    throw badRequest(`A draw can include up to ${MAX_PARTICIPANTS} people`);
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

  const options = new Map(members.map(g => [g, members.filter(r => r !== g && !forbiddenPairs.has(`${g}>${r}`))]));

  // With exclusions in play, the rules must leave real uncertainty: at least
  // three different complete draws. Fewer, and whoever chose the exclusions
  // could know or dictate the pairings.
  if (cleanExclusions.length > 0 && !hasAtLeastThreeDraws(members, options)) {
    throw conflict(findAnyAssignment(members, options)
      ? 'Those exclusions leave almost no choice about who gives to whom, so the draw would not be secret. Remove some and try again.'
      : 'Those exclusions leave no valid draw. Remove one and try again.');
  }

  const assignment = drawUniform(members, options);
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
 * A complete valid assignment if one exists, by augmenting-path bipartite
 * matching. Polynomial time: there is no input for which this gives up on a
 * solvable draw or stalls the server. `fixed` pins some givers' recipients;
 * `banned` removes single giver→recipient edges.
 */
function findAnyAssignment(members, options, { fixed = new Map(), banned = new Set() } = {}) {
  const recipientOf = new Map();
  const giverOf = new Map();
  for (const [g, r] of fixed) {
    if (giverOf.has(r)) return null;
    recipientOf.set(g, r);
    giverOf.set(r, g);
  }
  const free = members.filter(g => !fixed.has(g));
  const fixedRecipients = new Set(fixed.values());

  const tryPlace = (giver, seen) => {
    for (const rec of options.get(giver)) {
      if (seen.has(rec) || fixedRecipients.has(rec) || banned.has(`${giver}>${rec}`)) continue;
      seen.add(rec);
      const holder = giverOf.get(rec);
      if (holder === undefined || tryPlace(holder, seen)) {
        recipientOf.set(giver, rec);
        giverOf.set(rec, giver);
        return true;
      }
    }
    return false;
  };

  for (const giver of free) {
    if (!tryPlace(giver, new Set())) return null;
  }
  return recipientOf;
}

/** True when at least three different complete draws satisfy the rules. */
function hasAtLeastThreeDraws(members, options) {
  const first = findAnyAssignment(members, options);
  if (!first) return false;
  // A second draw must differ from the first in at least one pairing.
  let second = null;
  for (const [g, r] of first) {
    second = findAnyAssignment(members, options, { banned: new Set([`${g}>${r}`]) });
    if (second) break;
  }
  if (!second) return false;
  // A third must differ from both: ban one pairing of each.
  for (const [g1, r1] of first) {
    if (second.get(g1) === r1) {
      // Shared pairing: banning it alone excludes both draws at once.
      if (findAnyAssignment(members, options, { banned: new Set([`${g1}>${r1}`]) })) return true;
      continue;
    }
    for (const [g2, r2] of second) {
      if (first.get(g2) === r2) continue;
      if (findAnyAssignment(members, options, { banned: new Set([`${g1}>${r1}`, `${g2}>${r2}`]) })) return true;
    }
  }
  return false;
}

/**
 * A uniformly random valid assignment.
 *
 * Random permutations are drawn and the first one that breaks no rule is
 * kept — which gives every valid outcome exactly the same chance. With few
 * exclusions about one permutation in three is valid, so this ends at once.
 * If the rules are tight enough that none turns up in the allowance, the
 * fallback builds a draw one giver at a time, choosing at random among the
 * recipients that still leave a complete draw possible. That always finishes
 * with a valid draw; it is close to, but not exactly, uniform.
 */
function drawUniform(members, options) {
  const allowed = new Map(members.map(g => [g, new Set(options.get(g))]));
  for (let attempt = 0; attempt < 20000; attempt++) {
    const recipients = shuffled(members);
    if (members.every((g, i) => allowed.get(g).has(recipients[i]))) {
      return new Map(members.map((g, i) => [g, recipients[i]]));
    }
  }

  if (!findAnyAssignment(members, options)) return null;
  const fixed = new Map();
  for (const giver of shuffled(members)) {
    const taken = new Set(fixed.values());
    let placed = false;
    for (const rec of shuffled(options.get(giver).filter(r => !taken.has(r)))) {
      fixed.set(giver, rec);
      if (findAnyAssignment(members, options, { fixed })) { placed = true; break; }
      fixed.delete(giver);
    }
    if (!placed) return null;
  }
  return fixed;
}

/**
 * Takes one person out of every draw they are in without breaking it: the
 * person who was giving to them now gives to the person they were giving to,
 * and is told. Nobody is left without a gift or without someone to give to.
 * A draw that would drop below three people is cancelled and everyone is told.
 */
export function removeFromExchanges(db, userId) {
  const rows = db.prepare(`
    SELECT p.exchange_id, p.recipient_user_id, e.name, e.event_date
    FROM secret_santa_pairings p JOIN secret_santa_exchanges e ON e.id = p.exchange_id
    WHERE p.giver_user_id = ?
  `).all(userId);
  const today = new Date().toISOString().slice(0, 10);

  for (const row of rows) {
    const theirGiver = db.prepare(
      'SELECT giver_user_id FROM secret_santa_pairings WHERE exchange_id = ? AND recipient_user_id = ?'
    ).get(row.exchange_id, userId)?.giver_user_id || null;
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM secret_santa_pairings WHERE exchange_id = ?').get(row.exchange_id).n - 1;
    const live = row.event_date >= today;

    if (remaining < 3 || !theirGiver || theirGiver === row.recipient_user_id) {
      // Too few people left for a secret draw (or the only way to close the
      // gap would have someone giving to themselves).
      const others = db.prepare('SELECT giver_user_id FROM secret_santa_pairings WHERE exchange_id = ? AND giver_user_id != ?')
        .all(row.exchange_id, userId).map(r => r.giver_user_id);
      db.prepare('DELETE FROM secret_santa_pairings WHERE exchange_id = ?').run(row.exchange_id);
      db.prepare('DELETE FROM secret_santa_exchanges WHERE id = ?').run(row.exchange_id);
      if (live) {
        for (const id of others) {
          sendNotification(db, {
            recipientUserId: id,
            eventType: 'secret_santa_changed',
            subject: `"${row.name}" was cancelled`,
            body: `Someone left the circle, which leaves too few people for "${row.name}". An organizer can draw names again.`
          });
        }
      }
      continue;
    }

    db.prepare('DELETE FROM secret_santa_pairings WHERE exchange_id = ? AND giver_user_id = ?').run(row.exchange_id, userId);
    db.prepare('UPDATE secret_santa_pairings SET recipient_user_id = ? WHERE exchange_id = ? AND giver_user_id = ?')
      .run(row.recipient_user_id, row.exchange_id, theirGiver);
    if (live) {
      sendNotification(db, {
        recipientUserId: theirGiver,
        eventType: 'secret_santa_changed',
        subject: `Your person in "${row.name}" has changed`,
        body: `Someone left the circle, so you now have a different person to give to in "${row.name}". Open Circles to see who.`
      });
    }
  }
}
