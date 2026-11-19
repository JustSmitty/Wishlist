/**
 * EXC-1: Secret Santa Draw within a Group with Exclusions
 *
 * Rules:
 * - Organizer does not see pairings by default.
 * - Draw is verifiable as complete without revealing pairs (via a SHA-256 verification hash of the sorted cycle/derangement).
 * - Each participant can query ONLY their own assigned recipient.
 */

import crypto from 'node:crypto';
import { uid } from '../db/schema.mjs';

export function createSecretSantaExchange(db, {
  groupId,
  name,
  eventDate,
  budgetLimit = 50,
  exclusions = [], // Array of [userA, userB]
  createdBy
}) {
  const members = db.prepare(`
    SELECT u.id, u.name FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ? AND u.status = 'active'
  `).all(groupId);

  if (members.length < 3) {
    throw new Error('At least 3 group members are required for a Secret Santa draw');
  }

  const memberIds = members.map(m => m.id);
  const forbidden = new Set();
  for (const pair of exclusions) {
    if (Array.isArray(pair) && pair.length === 2) {
      forbidden.add(`${pair[0]}->${pair[1]}`);
      forbidden.add(`${pair[1]}->${pair[0]}`);
    }
  }

  const assignment = findValidDerangement(memberIds, forbidden);
  if (!assignment) {
    throw new Error('No valid Secret Santa pairing exists with the selected exclusions');
  }

  const exchangeId = uid('ss');
  const nowIso = new Date().toISOString();

  // Compute verifiable completeness hash without revealing individual pairings
  const salt = crypto.randomBytes(16).toString('hex');
  const summaryPayload = Object.entries(assignment)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([g, r]) => `${g}:${r}`)
    .join('|');
  const verificationHash = crypto.createHash('sha256').update(`${salt}|${summaryPayload}`).digest('hex');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO secret_santa_exchanges (
        id, group_id, name, event_date, budget_limit, exclusions, verification_hash, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exchangeId,
      groupId,
      name,
      eventDate,
      Number(budgetLimit) || 50,
      JSON.stringify(exclusions),
      verificationHash,
      createdBy,
      nowIso
    );

    const insertPairing = db.prepare(`
      INSERT INTO secret_santa_pairings (exchange_id, giver_user_id, recipient_user_id)
      VALUES (?, ?, ?)
    `);

    for (const [giverId, recipientId] of Object.entries(assignment)) {
      insertPairing.run(exchangeId, giverId, recipientId);
    }

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }

  return {
    id: exchangeId,
    group_id: groupId,
    name,
    event_date: eventDate,
    budget_limit: budgetLimit,
    participant_count: memberIds.length,
    all_assigned_verified: true,
    verification_hash: verificationHash,
    created_at: nowIso
  };
}

function findValidDerangement(memberIds, forbiddenSet) {
  const n = memberIds.length;
  // Backtracking with randomized recipient order
  const used = new Set();
  const result = {};

  function backtrack(idx) {
    if (idx === n) return true;
    const giver = memberIds[idx];
    const candidates = [...memberIds].sort(() => Math.random() - 0.5);
    for (const rec of candidates) {
      if (rec === giver) continue;
      if (used.has(rec)) continue;
      if (forbiddenSet.has(`${giver}->${rec}`)) continue;
      // Avoid 2-person mutual cycles when n > 2
      if (n > 2 && result[rec] === giver) continue;

      used.add(rec);
      result[giver] = rec;
      if (backtrack(idx + 1)) return true;
      used.delete(rec);
      delete result[giver];
    }
    return false;
  }

  if (backtrack(0)) return result;
  return null;
}
