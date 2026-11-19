import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, uid } from './db/schema.mjs';
import { seedDatabase } from './db/seed.mjs';
import { getViewerRole, sanitizeItemForViewer, safeJsonParse } from './services/surprise.mjs';
import {
  captureFromUrl,
  canonicalizeUrl,
  checkUrlSafety,
  stripHtmlAndEscape,
  toProxiedImageUrl,
  importAmazonList,
  recheckItemPriceAndStock
} from './services/capture.mjs';
import {
  createClaim,
  verifyGuestClaim,
  transitionClaimState,
  handleOwnerDeleteOrGotIt,
  handleOwnerEditItem,
  addContribution,
  purgeExpiredClaims
} from './services/claims.mjs';
import { sendNotification, generateFollowerDigest } from './services/notifications.mjs';
import { createSecretSantaExchange } from './services/secret-santa.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, 'public');

export function createApp(customDb = null) {
  const db = customDb || createDatabase();
  seedDatabase(db);

  // ADV-3.1 & Section 17: Sliding-window rate limiter on claim, verify, invite, follow & auth endpoints
  const rateBuckets = new Map();
  function checkRateLimit(key, maxRequests = 40, windowMs = 60_000) {
    const now = Date.now();
    const entry = rateBuckets.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      rateBuckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= maxRequests;
  }

  async function handleRequest(req, res) {
    // Security headers & Strict Content Security Policy (Section 17 & ADV-4.1: no inline scripts)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'sameorigin'"
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id, X-Guest-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost:3456'}`);
    const pathname = urlObj.pathname;
    const method = req.method;

    // Resolve current authenticated user (or null if Guest mode)
    const headerUserId = req.headers['x-user-id'] || urlObj.searchParams.get('asUser');
    const guestClaimToken = req.headers['x-guest-token'] || urlObj.searchParams.get('guestToken') || null;
    const currentUser = (headerUserId && headerUserId !== 'guest')
      ? db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(headerUserId)
      : null;

    try {
      // =========================================================================
      // 1. IMAGE PROXY (Section 9 & 17: Untrusted images served through proxy)
      // =========================================================================
      if (pathname === '/api/image-proxy' && method === 'GET') {
        const label = urlObj.searchParams.get('label') || 'Wishlist Item';
        const rawUrl = urlObj.searchParams.get('url') || '';
        const theme = urlObj.searchParams.get('theme') || 'indigo';
        const svg = renderProductBadgeSvg(label || rawUrl, theme);
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(svg);
        return;
      }

      // =========================================================================
      // 2. PWA SHARE TARGET (Section 6 ITM-1 & Section 7 Android Share Sheet)
      // =========================================================================
      if (pathname === '/share-target' && method === 'GET') {
        const sharedUrl = urlObj.searchParams.get('url') || urlObj.searchParams.get('text') || '';
        const sharedTitle = urlObj.searchParams.get('title') || '';
        res.writeHead(302, {
          Location: `/?sharedUrl=${encodeURIComponent(sharedUrl)}&sharedTitle=${encodeURIComponent(sharedTitle)}`
        });
        res.end();
        return;
      }

      // =========================================================================
      // 3. AUTH, USERS, DEPENDENTS (ACC-1, ACC-2, ACC-3, D6)
      // =========================================================================
      if (pathname === '/api/session' && method === 'GET') {
        const allPersonas = db.prepare(`
          SELECT id, name, email, birthday_month, birthday_day, is_dependent, is_admin
          FROM users WHERE status = 'active'
          ORDER BY is_dependent ASC, is_admin DESC, name ASC
        `).all();
        const dependents = currentUser ? db.prepare(`
          SELECT u.*, gl.relationship
          FROM guardian_links gl
          JOIN users u ON u.id = gl.dependent_id
          WHERE gl.guardian_id = ? AND u.status = 'active'
        `).all(currentUser.id) : [];

        return sendJson(res, 200, {
          current_user: currentUser || null,
          is_guest: !currentUser,
          dependents,
          demo_personas: allPersonas
        });
      }

      // ACC-1 & Flow D: Invite Sign-Up (Passwordless Magic-Link / Passkey in < 60s)
      if (pathname === '/api/auth/signup' && method === 'POST') {
        const body = await readBody(req);
        const name = stripHtmlAndEscape(body.name);
        const email = (body.email || '').trim().toLowerCase();
        if (!name || !email || !email.includes('@')) {
          return sendJson(res, 400, { error: 'Valid display name and email are required' });
        }
        let user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
        const nowIso = new Date().toISOString();
        if (!user) {
          const userId = uid('usr');
          db.prepare(`
            INSERT INTO users (id, name, email, birthday_month, birthday_day, is_dependent, is_admin, status, auth_credential_id, created_at)
            VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?, ?)
          `).run(
            userId,
            name,
            email,
            Number(body.birthday_month) || null,
            Number(body.birthday_day) || null,
            body.auth_method === 'passkey' ? `passkey_${uid()}` : `magic_${uid()}`,
            nowIso
          );
          user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

          // Create a default personal list with Surprise Mode ON (D1)
          const listId = uid('lst');
          db.prepare(`
            INSERT INTO lists (id, owner_id, name, occasion, visibility, surprise_mode, share_token, created_at)
            VALUES (?, ?, ?, 'Birthday', 'link', 1, ?, ?)
          `).run(listId, userId, `${name}'s Wishlist`, uid('tok'), nowIso);

          // If invited to a group or by an inviter, auto-join group and follow inviter (Flow D)
          if (body.group_id || body.invite_code) {
            const grp = body.group_id
              ? db.prepare('SELECT * FROM groups WHERE id = ?').get(body.group_id)
              : db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(body.invite_code);
            if (grp) {
              db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
                grp.id, userId, 'member', nowIso
              );
              db.prepare('INSERT OR IGNORE INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                uid('shr'), listId, 'group', grp.id, 'viewer', nowIso
              );
              db.prepare('INSERT OR IGNORE INTO follows (id, follower_id, target_type, target_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                uid('fol'), userId, 'user', grp.created_by, 'approved', nowIso
              );
            }
          }
        }
        return sendJson(res, 201, { user });
      }

      // ACC-3 & D6: Guardian creates an under-13 dependent child profile (no email or login credentials collected)
      if (pathname === '/api/dependents' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const body = await readBody(req);
        const childName = stripHtmlAndEscape(body.name);
        if (!childName) return sendJson(res, 400, { error: 'Child display name is required' });

        const nowIso = new Date().toISOString();
        const childId = uid('usr_dep');
        // D6: Under-13 profile has is_dependent=1, email=NULL, auth_credential_id=NULL
        db.prepare(`
          INSERT INTO users (id, name, email, birthday_month, birthday_day, is_dependent, is_admin, status, created_at)
          VALUES (?, ?, NULL, ?, ?, 1, 0, 'active', ?)
        `).run(
          childId,
          childName,
          Number(body.birthday_month) || null,
          Number(body.birthday_day) || null,
          nowIso
        );

        db.prepare(`
          INSERT INTO guardian_links (guardian_id, dependent_id, relationship, created_at)
          VALUES (?, ?, ?, ?)
        `).run(currentUser.id, childId, stripHtmlAndEscape(body.relationship || 'Parent / Guardian'), nowIso);

        // Co-guardian optional link
        if (body.co_guardian_id) {
          db.prepare(`
            INSERT OR IGNORE INTO guardian_links (guardian_id, dependent_id, relationship, created_at)
            VALUES (?, ?, 'Parent / Guardian', ?)
          `).run(body.co_guardian_id, childId, nowIso);
        }

        // Create default birthday list for the child
        const listId = uid('lst');
        db.prepare(`
          INSERT INTO lists (id, owner_id, name, occasion, event_date, visibility, surprise_mode, share_token, created_at)
          VALUES (?, ?, ?, 'Birthday', ?, 'link', 1, ?, ?)
        `).run(listId, childId, `${childName}'s Wishlist`, body.event_date || null, uid('kid'), nowIso);

        return sendJson(res, 201, {
          dependent: db.prepare('SELECT * FROM users WHERE id = ?').get(childId),
          list: db.prepare('SELECT * FROM lists WHERE id = ?').get(listId)
        });
      }

      // Section 8 & 14: User deletes account -> claims they made on others' lists are anonymized, not deleted!
      if (pathname === '/api/account' && method === 'DELETE') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const nowIso = new Date().toISOString();
        db.prepare(`
          UPDATE claims
          SET claimer_user_id = NULL, guest_name = 'Former User (Anonymized)', guest_email = 'anonymized@hushlist.local', updated_at = ?
          WHERE claimer_user_id = ?
        `).run(nowIso, currentUser.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(currentUser.id);
        return sendJson(res, 200, { deleted: true, claims_anonymized: true });
      }

      // =========================================================================
      // 4. LISTS CRUD, ARCHIVE-AND-REUSE, HELPERS, REVEAL (LST-1..5, EVT-1..2)
      // =========================================================================
      if (pathname === '/api/lists' && method === 'GET') {
        const ownerFilter = urlObj.searchParams.get('ownerId');
        const shareToken = urlObj.searchParams.get('shareToken');

        let rows = [];
        if (shareToken) {
          const l = db.prepare('SELECT * FROM lists WHERE share_token = ?').get(shareToken);
          if (l) rows = [l];
        } else if (ownerFilter) {
          rows = db.prepare('SELECT * FROM lists WHERE owner_id = ? ORDER BY created_at DESC').all(ownerFilter);
        } else if (currentUser) {
          // Return user's own lists + co-owned lists + dependent child lists they guard
          rows = db.prepare(`
            SELECT l.*, u.name AS owner_name, u.is_dependent AS owner_is_dependent
            FROM lists l
            JOIN users u ON u.id = l.owner_id
            WHERE l.owner_id = ?
               OR l.co_owner_ids LIKE ?
               OR l.owner_id IN (SELECT dependent_id FROM guardian_links WHERE guardian_id = ?)
            ORDER BY l.archived_at IS NOT NULL ASC, l.created_at DESC
          `).all(currentUser.id, `%"${currentUser.id}"%`, currentUser.id);
        } else {
          rows = db.prepare("SELECT l.*, u.name AS owner_name FROM lists l JOIN users u ON u.id = l.owner_id WHERE l.visibility = 'link'").all();
        }

        const enriched = rows
          .map(list => formatListResponse(db, list, currentUser?.id || null, guestClaimToken))
          .filter(Boolean);

        return sendJson(res, 200, { lists: enriched });
      }

      if (pathname === '/api/lists' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const body = await readBody(req);
        const ownerId = body.owner_id || currentUser.id;

        // Verify currentUser is either ownerId or a guardian of ownerId
        if (ownerId !== currentUser.id) {
          const isGuardian = db.prepare('SELECT 1 FROM guardian_links WHERE guardian_id = ? AND dependent_id = ?').get(currentUser.id, ownerId);
          if (!isGuardian) return sendJson(res, 403, { error: 'Not authorized to create list for this profile' });
        }

        const listId = uid('lst');
        const nowIso = new Date().toISOString();
        const surpriseMode = body.surprise_mode === undefined ? 1 : (body.surprise_mode ? 1 : 0);
        const coOwners = Array.isArray(body.co_owner_ids) ? JSON.stringify(body.co_owner_ids) : '[]';

        db.prepare(`
          INSERT INTO lists (
            id, owner_id, co_owner_ids, name, occasion, event_date, cover_image,
            visibility, surprise_mode, share_token, guest_claim_cap, claim_expiry_days, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          listId,
          ownerId,
          coOwners,
          stripHtmlAndEscape(body.name || 'My Wishlist'),
          stripHtmlAndEscape(body.occasion || 'Birthday'),
          body.event_date || null,
          body.cover_image || null,
          body.visibility || 'link',
          surpriseMode,
          uid('shr'),
          Number(body.guest_claim_cap) || 3,
          Number(body.claim_expiry_days) || 7,
          nowIso
        );

        // Optional helper assignment (LST-4)
        if (body.helper_user_id) {
          db.prepare(`
            INSERT OR REPLACE INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at)
            VALUES (?, ?, 'user', ?, 'helper', ?)
          `).run(uid('ls'), listId, body.helper_user_id, nowIso);
        }

        // Optional group share
        if (body.group_id) {
          db.prepare(`
            INSERT OR REPLACE INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at)
            VALUES (?, ?, 'group', ?, 'viewer', ?)
          `).run(uid('ls'), listId, body.group_id, nowIso);
        }

        const created = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
        return sendJson(res, 201, { list: formatListResponse(db, created, currentUser.id, null) });
      }

      // Single list read: GET /api/lists/:id
      const listMatch = pathname.match(/^\/api\/lists\/([^/]+)$/);
      if (listMatch && method === 'GET') {
        const listIdOrToken = listMatch[1];
        const list = db.prepare('SELECT * FROM lists WHERE id = ? OR share_token = ?').get(listIdOrToken, listIdOrToken);
        if (!list) return sendJson(res, 404, { error: 'List not found' });

        // Set noindex header for shared lists (Section 8 Rule: Share links use unguessable IDs, are noindex)
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');

        const formatted = formatListResponse(db, list, currentUser?.id || null, guestClaimToken);
        if (!formatted) return sendJson(res, 403, { error: 'You do not have permission to view this private list' });
        return sendJson(res, 200, { list: formatted });
      }

      // Update list settings / visibility / helpers / archive-and-reuse / post-event reveal
      if (listMatch && method === 'PATCH') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const listId = listMatch[1];
        const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
        if (!list) return sendJson(res, 404, { error: 'List not found' });

        const viewerCtx = getViewerRole(db, list, currentUser.id);
        if (!viewerCtx.canEdit) return sendJson(res, 403, { error: 'Unauthorized to edit list' });

        const body = await readBody(req);
        const nowIso = new Date().toISOString();

        // LST-1 & Section 14 Edge Case 7: Archive-and-reuse
        if (body.action === 'archive') {
          db.prepare('UPDATE lists SET archived_at = ? WHERE id = ?').run(nowIso, list.id);
          // Reserved claims released; purchased claims kept in history; affected claimers notified
          const reservedClaims = db.prepare(`
            SELECT c.*, i.title AS item_title FROM claims c
            JOIN items i ON i.id = c.item_id
            WHERE c.list_id = ? AND c.status IN ('pending_verification', 'reserved')
          `).all(list.id);

          for (const rc of reservedClaims) {
            db.prepare("UPDATE claims SET status = 'released', updated_at = ? WHERE id = ?").run(nowIso, rc.id);
            sendNotification(db, {
              recipientUserId: rc.claimer_user_id,
              recipientEmail: rc.guest_email,
              eventType: 'claimed_item_withdrawn',
              listId: list.id,
              subject: `List "${list.name}" was archived`,
              body: `Your unpurchased reservation for "${rc.item_title}" was released because the owner archived the list.`
            });
          }
          return sendJson(res, 200, { list: formatListResponse(db, db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id), currentUser.id) });
        }

        if (body.action === 'reuse_clear_claims') {
          db.prepare('UPDATE lists SET archived_at = NULL, revealed_at = NULL, event_date = ? WHERE id = ?').run(
            body.event_date || list.event_date, list.id
          );
          db.prepare("UPDATE claims SET status = 'released', updated_at = ? WHERE list_id = ? AND status IN ('reserved', 'purchased')").run(nowIso, list.id);
          return sendJson(res, 200, { list: formatListResponse(db, db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id), currentUser.id) });
        }

        // Section 8, EVT-2 & ADV-1.1: Owner chooses to reveal purchased gifts after event + 7 days (or if force_override_post_event is confirmed)
        if (body.action === 'reveal_purchases') {
          if (list.surprise_mode === 1 && list.event_date && !body.force_post_event_reveal) {
            const eventPlus7Ms = new Date(list.event_date + 'T00:00:00Z').getTime() + 7 * 86400 * 1000;
            if (Date.now() < eventPlus7Ms) {
              return sendJson(res, 400, {
                error: `Anti-Spoil Protection (Section 8): Post-event gift reveal unlocks 7 days after your event date (${list.event_date}). Pass force_post_event_reveal: true only if the occasion has already occurred.`
              });
            }
          }
          db.prepare('UPDATE lists SET revealed_at = ? WHERE id = ?').run(nowIso, list.id);
          return sendJson(res, 200, { list: formatListResponse(db, db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id), currentUser.id) });
        }

        // ADV-1.1: Prevent mid-season surprise_mode 1 -> 0 -> 1 peeking once active claims exist
        if (body.surprise_mode !== undefined && list.surprise_mode === 1 && !body.surprise_mode) {
          const activeClaimsCount = db.prepare(`
            SELECT COUNT(*) as cnt FROM claims
            WHERE list_id = ? AND status IN ('reserved', 'purchased', 'given') AND verified = 1
          `).get(list.id).cnt;
          if (activeClaimsCount > 0) {
            return sendJson(res, 400, {
              error: 'Anti-Spoil Protection (ADV-1.1): Cannot switch from Surprise Mode to Registry Mode after givers have already reserved items on this list. Use Archive & Reuse to start a fresh registry list.'
            });
          }
        }

        // Assign/update List Helper (LST-4)
        if (body.helper_user_id !== undefined) {
          db.prepare("DELETE FROM list_shares WHERE list_id = ? AND permission = 'helper'").run(list.id);
          if (body.helper_user_id) {
            db.prepare(`
              INSERT OR REPLACE INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at)
              VALUES (?, ?, 'user', ?, 'helper', ?)
            `).run(uid('ls'), list.id, body.helper_user_id, nowIso);
          }
        }

        db.prepare(`
          UPDATE lists
          SET name = ?, occasion = ?, event_date = ?, visibility = ?, surprise_mode = ?
          WHERE id = ?
        `).run(
          body.name !== undefined ? stripHtmlAndEscape(body.name) : list.name,
          body.occasion !== undefined ? stripHtmlAndEscape(body.occasion) : list.occasion,
          body.event_date !== undefined ? body.event_date : list.event_date,
          body.visibility !== undefined ? body.visibility : list.visibility,
          body.surprise_mode !== undefined ? (body.surprise_mode ? 1 : 0) : list.surprise_mode,
          list.id
        );

        return sendJson(res, 200, { list: formatListResponse(db, db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id), currentUser.id) });
      }

      // =========================================================================
      // 5. ITEM CAPTURE & ITEMS CRUD (ITM-1..9, Section 7 & Section 14)
      // =========================================================================
      if (pathname === '/api/capture' && method === 'POST') {
        const body = await readBody(req);
        if (!body.url) return sendJson(res, 400, { error: 'URL is required for capture' });

        const extracted = await captureFromUrl(db, {
          url: body.url,
          htmlSnapshot: body.html || null,
          clientExtracted: body.client_extracted || null,
          pathType: body.path_type || 'paste'
        });

        // ITM-7 Duplicate detection on save across the owner's active lists
        let duplicateWarning = null;
        if (currentUser && extracted.canonical_url) {
          const dup = db.prepare(`
            SELECT i.id, i.title, l.name AS list_name
            FROM items i
            JOIN lists l ON l.id = i.list_id
            WHERE l.owner_id = ? AND i.status = 'active'
              AND (i.canonical_url = ? OR LOWER(i.title) = LOWER(?))
            LIMIT 1
          `).get(currentUser.id, extracted.canonical_url, extracted.title || '');
          if (dup) {
            duplicateWarning = {
              existing_item_id: dup.id,
              existing_title: dup.title,
              list_name: dup.list_name,
              message: `"${dup.title}" is already on your list "${dup.list_name}". You can still save it anyway.`
            };
          }
        }

        return sendJson(res, 200, {
          capture: extracted,
          duplicate_warning: duplicateWarning
        });
      }

      // Add Item to a List (ITM-1..9)
      if (pathname === '/api/items' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required to add items' });
        const body = await readBody(req);
        const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(body.list_id);
        if (!list) return sendJson(res, 404, { error: 'List not found' });

        const viewerCtx = getViewerRole(db, list, currentUser.id);
        if (!viewerCtx.canEdit) return sendJson(res, 403, { error: 'Unauthorized to add items to this list' });

        if (body.url) {
          const safety = checkUrlSafety(body.url);
          if (!safety.safe) {
            return sendJson(res, 400, { error: `Blocked malicious URL: ${safety.reason}` });
          }
        }

        const canonical = body.url ? canonicalizeUrl(body.url) : null;
        const cleanTitle = stripHtmlAndEscape(body.title);
        if (!cleanTitle) return sendJson(res, 400, { error: 'Item title is required' });

        // ITM-7 Duplicate detection unless force_duplicate is true
        if (!body.force_duplicate) {
          const dup = db.prepare(`
            SELECT i.id, i.title, l.name AS list_name
            FROM items i
            JOIN lists l ON l.id = i.list_id
            WHERE l.owner_id = ? AND i.status = 'active'
              AND ((? IS NOT NULL AND i.canonical_url = ?) OR LOWER(i.title) = LOWER(?))
            LIMIT 1
          `).get(list.owner_id, canonical, canonical, cleanTitle);

          if (dup) {
            return sendJson(res, 409, {
              duplicate_detected: true,
              existing_item: dup,
              error: `Duplicate detected: "${dup.title}" is already on "${dup.list_name}". Confirm to save anyway.`
            });
          }
        }

        const itemId = uid('itm');
        const nowIso = new Date().toISOString();
        const kind = ['product', 'experience', 'cash', 'idea'].includes(body.kind) ? body.kind : 'product';
        const price = body.price !== undefined && body.price !== '' && body.price !== null ? Number(body.price) : null;
        const proxiedImg = body.image
          ? toProxiedImageUrl(body.image)
          : `/api/image-proxy?label=${encodeURIComponent(cleanTitle.slice(0, 28))}&theme=${kind === 'experience' ? 'amber' : kind === 'cash' ? 'rose' : 'indigo'}`;

        db.prepare(`
          INSERT INTO items (
            id, list_id, kind, title, canonical_url, original_url, store, image, price, currency,
            variant, qty_wanted, always_wanted, allow_group_chip_in, priority, notes,
            any_similar, giving_instructions, alternate_sources, field_confidence, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          itemId,
          list.id,
          kind,
          cleanTitle,
          canonical,
          body.url || null,
          stripHtmlAndEscape(body.store || (kind === 'experience' ? 'Experience / Local' : kind === 'cash' ? 'Cash / Gift Fund' : 'Any Store')),
          proxiedImg,
          price,
          stripHtmlAndEscape(body.currency || 'USD'),
          body.variant ? stripHtmlAndEscape(body.variant) : null,
          Math.max(1, Number(body.qty_wanted) || 1),
          body.always_wanted ? 1 : 0,
          body.allow_group_chip_in ? 1 : 0,
          ['most_wanted', 'high', 'normal', 'low'].includes(body.priority) ? body.priority : 'normal',
          body.notes ? stripHtmlAndEscape(body.notes) : null,
          body.any_similar ? 1 : 0,
          body.giving_instructions ? stripHtmlAndEscape(body.giving_instructions) : null,
          JSON.stringify(Array.isArray(body.alternate_sources) ? body.alternate_sources : []),
          JSON.stringify(body.field_confidence || { title: 1, image: 1, price: 1, store: 1, variant: 1 }),
          Number(body.sort_order) || 0,
          nowIso,
          nowIso
        );

        if (price !== null) {
          db.prepare('INSERT INTO price_snapshots (id, item_id, price, in_stock, checked_at) VALUES (?, ?, ?, 1, ?)').run(
            uid('ps'), itemId, price, nowIso
          );
        }

        // Log non-spoiler event for follower digest (NTF-1)
        db.prepare(`
          INSERT INTO events (id, actor_id, entity_type, entity_id, list_id, action, details, is_spoiler, at)
          VALUES (?, ?, 'item', ?, ?, 'item_added', ?, 0, ?)
        `).run(uid('ev'), currentUser.id, itemId, list.id, JSON.stringify({ title: cleanTitle, priority: body.priority }), nowIso);

        db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
          uid('ae'), 'item_saved', JSON.stringify({ list_type: list.occasion, item_kind: kind }), nowIso
        );

        const created = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
        return sendJson(res, 201, {
          item: sanitizeItemForViewer(db, created, list, viewerCtx, currentUser.id)
        });
      }

      // ITM-6: Automated / On-Demand Price & Stock Re-Check (Excludes Amazon per D3)
      const recheckMatch = pathname.match(/^\/api\/items\/([^/]+)\/recheck$/);
      if (recheckMatch && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const itemId = recheckMatch[1];
        const body = await readBody(req);
        const report = recheckItemPriceAndStock(db, {
          itemId,
          newPrice: body.new_price,
          newInStock: body.in_stock !== false,
          sendNotificationFn: sendNotification
        });
        return sendJson(res, 200, { recheck: report });
      }

      // Edit Item, Move/Copy/Reorder Item (LST-5), Mark Received (EVT-1), or Thank-You Note (EVT-2)
      const itemMatch = pathname.match(/^\/api\/items\/([^/]+)$/);
      if (itemMatch && method === 'PATCH') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const itemId = itemMatch[1];
        const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
        if (!item) return sendJson(res, 404, { error: 'Item not found' });

        const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(item.list_id);
        const viewerCtx = getViewerRole(db, list, currentUser.id);
        // ADV-1.3 & ADV-2.4: Enforce viewerCtx.canEdit at the top of PATCH /api/items/:id before any action branch!
        if (!viewerCtx.canEdit) {
          return sendJson(res, 403, { error: 'Unauthorized: only the list owner, co-owner, or guardian can modify items' });
        }

        const body = await readBody(req);
        const nowIso = new Date().toISOString();

        // Owner marks "Got it" (Section 14 row 3)
        if (body.action === 'got_it') {
          const resObj = handleOwnerDeleteOrGotIt(db, { itemId, ownerId: currentUser.id, mode: 'got_it' });
          return sendJson(res, 200, { result: resObj });
        }

        // EVT-1: Post-event reconciliation — owner marks gift received (including bought outside app)
        if (body.action === 'mark_received') {
          db.prepare(`
            UPDATE items
            SET status = 'received', received_at = ?, received_outside_app = ?, updated_at = ?
            WHERE id = ?
          `).run(nowIso, body.outside_app ? 1 : 0, nowIso, itemId);

          // Notify matching claimers
          const matchingClaims = db.prepare("SELECT * FROM claims WHERE item_id = ? AND status IN ('reserved', 'purchased')").all(itemId);
          for (const mc of matchingClaims) {
            db.prepare("UPDATE claims SET status = 'given', updated_at = ? WHERE id = ?").run(nowIso, mc.id);
            sendNotification(db, {
              recipientUserId: mc.claimer_user_id,
              recipientEmail: mc.guest_email,
              eventType: 'claim_confirmed',
              listId: list.id,
              subject: `"${item.title}" was marked as received!`,
              body: `The recipient marked "${item.title}" as received and removed it from their active wishlist.`
            });
          }
          // ADV-1.3: Return constant spoiler-free response structure
          return sendJson(res, 200, { received: true, item_id: itemId, updated_at: nowIso });
        }

        // EVT-2: Thank-you tracker update
        if (body.action === 'toggle_thank_you') {
          db.prepare('UPDATE items SET thank_you_sent = ?, thank_you_note = ?, updated_at = ? WHERE id = ?').run(
            body.thank_you_sent ? 1 : 0,
            body.thank_you_note ? stripHtmlAndEscape(body.thank_you_note) : null,
            nowIso,
            itemId
          );
          return sendJson(res, 200, { updated: true });
        }

        // LST-5: Move item to another list while keeping all its claims intact!
        if (body.action === 'move_to_list' && body.target_list_id) {
          const targetList = db.prepare('SELECT * FROM lists WHERE id = ? AND owner_id = ?').get(body.target_list_id, list.owner_id);
          if (!targetList) return sendJson(res, 400, { error: 'Invalid target list' });
          db.prepare('UPDATE items SET list_id = ?, updated_at = ? WHERE id = ?').run(targetList.id, nowIso, itemId);
          db.prepare('UPDATE claims SET list_id = ?, updated_at = ? WHERE item_id = ?').run(targetList.id, nowIso, itemId);
          db.prepare('UPDATE contributions SET list_id = ? WHERE item_id = ?').run(targetList.id, itemId);
          return sendJson(res, 200, { moved: true, target_list_id: targetList.id });
        }

        // LST-5: Copy item to another list (fresh copy without copying claims)
        if (body.action === 'copy_to_list' && body.target_list_id) {
          const targetList = db.prepare('SELECT * FROM lists WHERE id = ? AND owner_id = ?').get(body.target_list_id, list.owner_id);
          if (!targetList) return sendJson(res, 400, { error: 'Invalid target list' });
          const copyId = uid('itm');
          db.prepare(`
            INSERT INTO items (
              id, list_id, kind, title, canonical_url, original_url, store, image, price, currency,
              variant, qty_wanted, always_wanted, allow_group_chip_in, priority, notes,
              any_similar, giving_instructions, alternate_sources, field_confidence, sort_order, created_at, updated_at
            )
            SELECT ?, ?, kind, title, canonical_url, original_url, store, image, price, currency,
                   variant, qty_wanted, always_wanted, allow_group_chip_in, priority, notes,
                   any_similar, giving_instructions, alternate_sources, field_confidence, sort_order, ?, ?
            FROM items WHERE id = ?
          `).run(copyId, targetList.id, nowIso, nowIso, itemId);
          return sendJson(res, 201, { copied: true, new_item_id: copyId, target_list_id: targetList.id });
        }

        // LST-5: Reorder item (update sort_order)
        if (body.action === 'reorder' && body.sort_order !== undefined) {
          db.prepare('UPDATE items SET sort_order = ?, updated_at = ? WHERE id = ?').run(Number(body.sort_order) || 0, nowIso, itemId);
          return sendJson(res, 200, { reordered: true, sort_order: Number(body.sort_order) || 0 });
        }

        // Standard owner edit (triggers Section 14 Edge Cases 4 & 5 automatically)
        const updated = handleOwnerEditItem(db, {
          itemId,
          ownerId: currentUser.id,
          updates: body
        });
        return sendJson(res, 200, {
          item: sanitizeItemForViewer(db, updated, list, viewerCtx, currentUser.id)
        });
      }

      // Delete Item (Section 14 Edge Cases 1 & 2)
      if (itemMatch && method === 'DELETE') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const itemId = itemMatch[1];
        const resObj = handleOwnerDeleteOrGotIt(db, { itemId, ownerId: currentUser.id, mode: 'deleted' });
        return sendJson(res, 200, { result: resObj });
      }

      // =========================================================================
      // 6. CLAIMS, GUEST VERIFICATION, CLICK-OUT, GROUP CHIP-IN (GVR-1..8)
      // =========================================================================
      if (pathname === '/api/claims' && method === 'POST') {
        const clientIp = req.socket?.remoteAddress || 'local';
        if (!checkRateLimit(`claims:${clientIp}`, 30, 60_000)) {
          return sendJson(res, 429, { error: 'Rate limit exceeded on claim creation. Please wait a minute.' });
        }
        const body = await readBody(req);
        const claim = createClaim(db, {
          itemId: body.item_id,
          claimerUserId: currentUser ? currentUser.id : null,
          guestEmail: body.guest_email || null,
          guestName: body.guest_name || null,
          qty: body.qty || 1,
          showNameToGivers: body.show_name_to_givers !== false,
          orderNote: body.order_note ? stripHtmlAndEscape(body.order_note) : null
        });
        return sendJson(res, 201, { claim });
      }

      if (pathname === '/api/claims/verify' && method === 'POST') {
        const clientIp = req.socket?.remoteAddress || 'local';
        if (!checkRateLimit(`verify:${clientIp}`, 25, 60_000)) {
          return sendJson(res, 429, { error: 'Too many verification requests. Please wait a minute.' });
        }
        const body = await readBody(req);
        const verifiedClaim = verifyGuestClaim(db, {
          claimId: body.claim_id,
          code: body.code
        });
        return sendJson(res, 200, { claim: verifiedClaim });
      }

      const claimMatch = pathname.match(/^\/api\/claims\/([^/]+)$/);
      if (claimMatch && method === 'PATCH') {
        const claimId = claimMatch[1];
        const body = await readBody(req);
        const existingClaim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
        if (!existingClaim) return sendJson(res, 404, { error: 'Claim not found' });

        const effToken = body.manage_token || guestClaimToken;
        const isOwnClaimer = (currentUser && existingClaim.claimer_user_id === currentUser.id) ||
                             (effToken && existingClaim.manage_token === effToken);

        // GVR-3 & ADV-2.3: Require claim ownership before mutating click_out or return_prompt_answered
        if (body.action === 'click_out') {
          if (!isOwnClaimer) {
            return sendJson(res, 403, { error: 'Unauthorized: only the claimer can record a store click-out on this reservation' });
          }
          const nowIso = new Date().toISOString();
          db.prepare('UPDATE claims SET clicked_out_at = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, claimId);
          db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
            uid('ae'), 'click_out', JSON.stringify({ store_domain: body.store || 'retailer' }), nowIso
          );
          return sendJson(res, 200, { clicked_out_at: nowIso });
        }

        if (body.action === 'answer_return_prompt') {
          if (!isOwnClaimer) {
            return sendJson(res, 403, { error: 'Unauthorized: only the claimer can answer the return prompt' });
          }
          const answer = body.answer; // 'bought', 'not_yet', 'released'
          const nowIso = new Date().toISOString();
          db.prepare('UPDATE claims SET return_prompt_answered = ?, updated_at = ? WHERE id = ?').run(answer, nowIso, claimId);
          db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
            uid('ae'), 'return_prompt_answered', JSON.stringify({ answer }), nowIso
          );
          if (answer === 'bought') {
            const updated = transitionClaimState(db, {
              claimId,
              newState: 'purchased',
              actorId: currentUser?.id || null,
              manageToken: effToken,
              reason: 'Confirmed via Did You Buy It return prompt'
            });
            return sendJson(res, 200, { claim: updated });
          } else if (answer === 'released') {
            const updated = transitionClaimState(db, {
              claimId,
              newState: 'released',
              actorId: currentUser?.id || null,
              manageToken: effToken,
              reason: 'Released via Did You Buy It return prompt'
            });
            return sendJson(res, 200, { claim: updated });
          }
          return sendJson(res, 200, { claim: db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId) });
        }

        const updated = transitionClaimState(db, {
          claimId,
          newState: body.status,
          actorType: body.actor_type || 'giver',
          actorId: currentUser?.id || null,
          manageToken: effToken,
          reason: body.reason || null,
          orderNote: body.order_note !== undefined ? stripHtmlAndEscape(body.order_note) : undefined
        });
        return sendJson(res, 200, { claim: updated });
      }

      // GVR-4: Group Chip-In Contribution
      if (pathname === '/api/contributions' && method === 'POST') {
        const body = await readBody(req);
        const contrib = addContribution(db, {
          itemId: body.item_id,
          contributorUserId: currentUser ? currentUser.id : null,
          guestEmail: body.guest_email || null,
          guestName: body.guest_name || null,
          pledgedAmount: body.pledged_amount,
          showNameToGivers: body.show_name_to_givers !== false,
          note: body.note ? stripHtmlAndEscape(body.note) : null
        });
        return sendJson(res, 201, { contribution: contrib });
      }

      // =========================================================================
      // 7. "PEOPLE I SHOP FOR" TRACKING DASHBOARD, MY CLAIMS, SECRET IDEAS (TRK-1..4, GVR-5)
      // =========================================================================
      if (pathname === '/api/dashboard' && method === 'GET') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required for tracking dashboard' });

        // Followed people + dependents
        const followedUsers = db.prepare(`
          SELECT DISTINCT u.id, u.name, u.email, u.birthday_month, u.birthday_day, u.is_dependent
          FROM users u
          WHERE u.status = 'active' AND u.id != ? AND (
            u.id IN (SELECT target_id FROM follows WHERE follower_id = ? AND target_type = 'user' AND status = 'approved')
            OR u.id IN (SELECT dependent_id FROM guardian_links WHERE guardian_id = ?)
            OR u.id IN (
              SELECT gm2.user_id FROM group_members gm1
              JOIN group_members gm2 ON gm1.group_id = gm2.group_id
              WHERE gm1.user_id = ?
            )
          )
          ORDER BY u.name ASC
        `).all(currentUser.id, currentUser.id, currentUser.id, currentUser.id);

        const peopleCards = followedUsers.map(person => {
          const personLists = db.prepare('SELECT * FROM lists WHERE owner_id = ? AND archived_at IS NULL').all(person.id);
          const visibleLists = [];
          let unclaimedCount = 0;
          let topPriorities = [];

          for (const l of personLists) {
            const formatted = formatListResponse(db, l, currentUser.id, null);
            if (formatted) {
              visibleLists.push(formatted);
              for (const it of formatted.items) {
                if (it.status === 'active' && !it.claim_summary?.is_fully_claimed) {
                  unclaimedCount++;
                  if (it.priority === 'most_wanted' || it.priority === 'high') {
                    topPriorities.push({ id: it.id, title: it.title, price: it.price, store: it.store, priority: it.priority, list_id: l.id });
                  }
                }
              }
            }
          }

          // Next upcoming occasion & countdown (TRK-2)
          const occasions = db.prepare('SELECT * FROM occasions WHERE user_id = ? ORDER BY date ASC').all(person.id);
          const nextOccasion = computeNextOccasion(person, occasions);

          // Budget & spend roll-up from currentUser's claims & contributions for this person (TRK-4)
          const budgetRow = db.prepare('SELECT * FROM budgets WHERE owner_id = ? AND subject_user_id = ? LIMIT 1').get(currentUser.id, person.id);
          const myClaimsForPerson = db.prepare(`
            SELECT c.*, i.title AS item_title, i.price AS item_price, i.store AS item_store, l.name AS list_name
            FROM claims c
            JOIN items i ON i.id = c.item_id
            JOIN lists l ON l.id = c.list_id
            WHERE c.claimer_user_id = ? AND l.owner_id = ? AND c.status IN ('reserved', 'purchased', 'given')
          `).all(currentUser.id, person.id);

          const myContribsForPerson = db.prepare(`
            SELECT c.*, i.title AS item_title, l.name AS list_name
            FROM contributions c
            JOIN items i ON i.id = c.item_id
            JOIN lists l ON l.id = c.list_id
            WHERE c.contributor_user_id = ? AND l.owner_id = ? AND c.status IN ('pledged', 'paid_off_platform')
          `).all(currentUser.id, person.id);

          const totalSpent = myClaimsForPerson.reduce((s, c) => s + ((c.item_price || 0) * (c.qty || 1)), 0) +
                             myContribsForPerson.reduce((s, c) => s + (c.pledged_amount || 0), 0);

          // GVR-5: Secret ideas for this person (NEVER returned if person.id === currentUser.id!)
          const secretIdeas = person.id !== currentUser.id
            ? db.prepare(`
                SELECT si.*, u.name AS author_name
                FROM secret_ideas si
                JOIN users u ON u.id = si.author_id
                WHERE si.subject_user_id = ?
                ORDER BY si.created_at DESC
              `).all(person.id)
            : [];

          return {
            person: {
              id: person.id,
              name: person.name,
              birthday_month: person.birthday_month,
              birthday_day: person.birthday_day,
              is_dependent: Boolean(person.is_dependent)
            },
            next_occasion: nextOccasion,
            unclaimed_count: unclaimedCount,
            top_priorities: topPriorities.slice(0, 3),
            lists: visibleLists,
            my_claims: myClaimsForPerson,
            my_contributions: myContribsForPerson,
            budget: {
              limit: budgetRow ? budgetRow.amount : null,
              occasion: budgetRow ? budgetRow.occasion : (nextOccasion?.kind || 'Birthday'),
              spent: Math.round(totalSpent * 100) / 100,
              over_budget: budgetRow ? totalSpent > budgetRow.amount : false
            },
            secret_ideas: secretIdeas
          };
        });

        // All of currentUser's claims across everyone (TRK-3)
        const allMyClaims = db.prepare(`
          SELECT c.*, i.title AS item_title, i.price AS item_price, i.store AS item_store,
                 i.canonical_url AS item_url, i.variant AS item_variant,
                 l.name AS list_name, l.occasion AS list_occasion, u.name AS recipient_name, u.id AS recipient_id
          FROM claims c
          JOIN items i ON i.id = c.item_id
          JOIN lists l ON l.id = c.list_id
          JOIN users u ON u.id = l.owner_id
          WHERE c.claimer_user_id = ? AND c.status IN ('reserved', 'purchased', 'given', 'withdrawn')
          ORDER BY c.updated_at DESC
        `).all(currentUser.id);

        return sendJson(res, 200, {
          people_i_shop_for: peopleCards,
          my_claims_tracker: allMyClaims
        });
      }

      // GVR-5 & ADV-1.5 / ADV-4.3: Add a Secret Idea for someone else (Recipient can NEVER see or add for themselves)
      if (pathname === '/api/secret-ideas' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const body = await readBody(req);
        if (!body.subject_user_id || body.subject_user_id === currentUser.id) {
          return sendJson(res, 400, { error: 'Secret ideas must be for another person, never yourself' });
        }
        // Check if currentUser is blocked by subject_user_id (FOL-2)
        const isBlocked = db.prepare(`
          SELECT 1 FROM follows
          WHERE follower_id = ? AND target_type = 'user' AND target_id = ? AND status = 'blocked'
        `).get(currentUser.id, body.subject_user_id);
        if (isBlocked) {
          return sendJson(res, 403, { error: 'You do not have permission to post secret ideas for this user' });
        }

        const safeUrl = body.url ? canonicalizeUrl(body.url) : null;
        const id = uid('sec');
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO secret_ideas (id, subject_user_id, author_id, title, url, estimated_price, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          body.subject_user_id,
          currentUser.id,
          stripHtmlAndEscape(body.title),
          safeUrl,
          body.estimated_price ? Number(body.estimated_price) : null,
          body.note ? stripHtmlAndEscape(body.note) : null,
          nowIso
        );
        return sendJson(res, 201, { secret_idea: db.prepare('SELECT * FROM secret_ideas WHERE id = ?').get(id) });
      }

      // FOL-1, FOL-2 & NTF-2: Follow / Approve / Remove or Block Follower Endpoints
      if (pathname === '/api/follows' && method === 'GET') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const followersOfMe = db.prepare(`
          SELECT f.*, u.name AS follower_name, u.email AS follower_email
          FROM follows f
          JOIN users u ON u.id = f.follower_id
          WHERE f.target_type = 'user' AND f.target_id = ?
          ORDER BY f.created_at DESC
        `).all(currentUser.id);

        const whoIFollow = db.prepare(`
          SELECT f.*, u.name AS target_name
          FROM follows f
          JOIN users u ON u.id = f.target_id
          WHERE f.follower_id = ? AND f.target_type = 'user'
          ORDER BY f.created_at DESC
        `).all(currentUser.id);

        return sendJson(res, 200, { followers_of_me: followersOfMe, who_i_follow: whoIFollow });
      }

      if (pathname === '/api/follows' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const body = await readBody(req);
        const targetId = body.target_id;
        const targetType = body.target_type === 'list' ? 'list' : 'user';
        if (!targetId || (targetType === 'user' && targetId === currentUser.id)) {
          return sendJson(res, 400, { error: 'Invalid follow target' });
        }

        const existing = db.prepare(
          'SELECT * FROM follows WHERE follower_id = ? AND target_type = ? AND target_id = ?'
        ).get(currentUser.id, targetType, targetId);
        if (existing && existing.status === 'blocked') {
          return sendJson(res, 403, { error: 'Unable to follow this user' });
        }

        let ownerUser = null;
        if (targetType === 'user') {
          ownerUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
        } else {
          const l = db.prepare('SELECT * FROM lists WHERE id = ?').get(targetId);
          if (l) ownerUser = db.prepare('SELECT * FROM users WHERE id = ?').get(l.owner_id);
        }
        if (!ownerUser) return sendJson(res, 404, { error: 'Target not found' });

        const initialStatus = ownerUser.follow_approval_required ? 'pending' : 'approved';
        const followId = existing?.id || uid('fol');
        const nowIso = new Date().toISOString();

        db.prepare(`
          INSERT INTO follows (id, follower_id, target_type, target_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(follower_id, target_type, target_id)
          DO UPDATE SET status = excluded.status
        `).run(followId, currentUser.id, targetType, targetId, initialStatus, nowIso);

        // NTF-2: Non-spoiler notification to owner ("New follower or follow request")
        sendNotification(db, {
          recipientUserId: ownerUser.id,
          recipientEmail: ownerUser.email,
          eventType: 'new_follower',
          subject: initialStatus === 'pending'
            ? `${currentUser.name} requested to follow your wishlists`
            : `${currentUser.name} is now following your wishlists`,
          body: `${currentUser.name} ${initialStatus === 'pending' ? 'sent a follow request' : 'started following your shared wishlists'} on Hushlist.`
        });

        db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
          uid('ae'), 'follow_created', JSON.stringify({ target_type: targetType, status: initialStatus }), nowIso
        );

        return sendJson(res, 201, { follow: db.prepare('SELECT * FROM follows WHERE id = ?').get(followId) });
      }

      const followMatch = pathname.match(/^\/api\/follows\/([^/]+)$/);
      if (followMatch && (method === 'PATCH' || method === 'DELETE')) {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const followId = followMatch[1];
        const fol = db.prepare('SELECT * FROM follows WHERE id = ?').get(followId);
        if (!fol) return sendJson(res, 404, { error: 'Follow record not found' });

        // Verify currentUser is either the follower or the target owner (FOL-2)
        const isTargetOwner = (fol.target_type === 'user' && fol.target_id === currentUser.id);
        if (fol.follower_id !== currentUser.id && !isTargetOwner) {
          return sendJson(res, 403, { error: 'Unauthorized to modify this follow relationship' });
        }

        if (method === 'DELETE') {
          db.prepare('DELETE FROM follows WHERE id = ?').run(followId);
          return sendJson(res, 200, { removed: true });
        }

        const body = await readBody(req);
        const newStatus = ['approved', 'blocked', 'pending'].includes(body.status) ? body.status : 'approved';
        db.prepare('UPDATE follows SET status = ? WHERE id = ?').run(newStatus, followId);
        return sendJson(res, 200, { follow: db.prepare('SELECT * FROM follows WHERE id = ?').get(followId) });
      }

      // NTF-1: Trigger Daily/Weekly Follower Digest (At most 1 per day, zero owner spoilers)
      if (pathname === '/api/notifications/digest' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const digestResult = generateFollowerDigest(db, { followerUserId: currentUser.id });
        return sendJson(res, 200, { digest: digestResult });
      }

      // TRK-4: Set budget per person per occasion
      if (pathname === '/api/budgets' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const body = await readBody(req);
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO budgets (id, owner_id, subject_user_id, occasion, amount, currency, created_at)
          VALUES (?, ?, ?, ?, ?, 'USD', ?)
          ON CONFLICT(owner_id, subject_user_id, occasion)
          DO UPDATE SET amount = excluded.amount
        `).run(
          uid('bdg'),
          currentUser.id,
          body.subject_user_id,
          stripHtmlAndEscape(body.occasion || 'Birthday'),
          Number(body.amount) || 100,
          nowIso
        );
        return sendJson(res, 200, { saved: true });
      }

      // =========================================================================
      // 8. AMAZON IMPORT & CSV / JSON EXPORT (IMP-1, IMP-2)
      // =========================================================================
      if (pathname === '/api/import/amazon' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const body = await readBody(req);
        const report = importAmazonList(db, {
          listId: body.list_id,
          ownerId: currentUser.id,
          amazonListUrl: body.amazon_list_url,
          itemsPayload: body.items || []
        });
        return sendJson(res, 200, { report });
      }

      // IMP-2: Export all lists, items and claims (CSV and JSON, one click from settings)
      if (pathname === '/api/export' && method === 'GET') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const format = urlObj.searchParams.get('format') || 'json';

        const myLists = db.prepare('SELECT * FROM lists WHERE owner_id = ?').all(currentUser.id);
        const myItems = db.prepare(`
          SELECT i.*, l.name AS list_name
          FROM items i
          JOIN lists l ON l.id = i.list_id
          WHERE l.owner_id = ? AND i.status != 'deleted'
        `).all(currentUser.id);

        // NOTE: Export of own lists NEVER includes claims on own surprise-mode lists!
        // Only includes claims the user themselves made on OTHER people's lists.
        const claimsIMade = db.prepare(`
          SELECT c.id, c.status, c.qty, c.order_note, c.created_at, i.title AS item_title, i.store, i.price, u.name AS recipient_name
          FROM claims c
          JOIN items i ON i.id = c.item_id
          JOIN lists l ON l.id = c.list_id
          JOIN users u ON u.id = l.owner_id
          WHERE c.claimer_user_id = ?
        `).all(currentUser.id);

        if (format === 'csv') {
          const header = 'RecordType,ListOrRecipient,Title,Kind,Store,Price,Currency,Variant,Qty,Priority,URL,Notes\n';
          const itemLines = myItems.map(i =>
            ['WishlistItem', i.list_name, i.title, i.kind, i.store, i.price ?? '', i.currency, i.variant ?? '', i.qty_wanted, i.priority, i.canonical_url ?? '', i.notes ?? '']
              .map(csvEscape).join(',')
          );
          const claimLines = claimsIMade.map(c =>
            ['MyClaim', c.recipient_name, c.item_title, c.status, c.store ?? '', c.price ?? '', 'USD', '', c.qty, '', '', c.order_note ?? '']
              .map(csvEscape).join(',')
          );
          const csv = header + [...itemLines, ...claimLines].join('\n');
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="hushlist-export.csv"'
          });
          res.end(csv);
          return;
        }

        const payload = {
          exported_at: new Date().toISOString(),
          user: { id: currentUser.id, name: currentUser.name, email: currentUser.email },
          lists: myLists,
          items: myItems,
          my_claims_for_others: claimsIMade
        };
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="hushlist-export.json"'
        });
        res.end(JSON.stringify(payload, null, 2));
        return;
      }

      // =========================================================================
      // 9. GROUPS & SECRET SANTA DRAW (SHR-2, EXC-1)
      // =========================================================================
      if (pathname === '/api/groups' && method === 'GET') {
        const groups = db.prepare('SELECT * FROM groups ORDER BY created_at DESC').all().map(g => {
          const members = db.prepare(`
            SELECT u.id, u.name, u.email, gm.role, gm.joined_at
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ?
          `).all(g.id);

          const exchanges = db.prepare('SELECT * FROM secret_santa_exchanges WHERE group_id = ? ORDER BY created_at DESC').all(g.id).map(ex => {
            // EXC-1: Organizer does NOT see all pairings! Each user ONLY sees their own assigned recipient.
            const myAssignment = currentUser ? db.prepare(`
              SELECT u.id, u.name
              FROM secret_santa_pairings ssp
              JOIN users u ON u.id = ssp.recipient_user_id
              WHERE ssp.exchange_id = ? AND ssp.giver_user_id = ?
            `).get(ex.id, currentUser.id) : null;

            const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM secret_santa_pairings WHERE exchange_id = ?').get(ex.id).cnt;

            return {
              id: ex.id,
              name: ex.name,
              event_date: ex.event_date,
              budget_limit: ex.budget_limit,
              verification_hash: ex.verification_hash,
              participant_count: totalCount,
              draw_complete_verified: totalCount === members.length,
              my_assigned_recipient: myAssignment || null
            };
          });

          return { ...g, members, exchanges };
        });

        return sendJson(res, 200, { groups });
      }

      if (pathname === '/api/secret-santa' && method === 'POST') {
        if (!currentUser) return sendJson(res, 401, { error: 'Sign in required' });
        const body = await readBody(req);
        const exchange = createSecretSantaExchange(db, {
          groupId: body.group_id,
          name: stripHtmlAndEscape(body.name || 'Family Secret Santa'),
          eventDate: body.event_date || '2026-12-25',
          budgetLimit: body.budget_limit || 50,
          exclusions: Array.isArray(body.exclusions) ? body.exclusions : [],
          createdBy: currentUser.id
        });
        return sendJson(res, 201, { exchange });
      }

      // =========================================================================
      // 10. NOTIFICATIONS, ABUSE REPORTS, ADMIN CONSOLE (NTF-1..3, SAF-1, ADM-1)
      // =========================================================================
      if (pathname === '/api/notifications' && method === 'GET') {
        // Filter outbox so a signed-in user never sees notifications addressed to other people that could spoil their own list
        let rows = [];
        if (currentUser) {
          rows = db.prepare(`
            SELECT * FROM notifications_outbox
            WHERE recipient_user_id = ? OR LOWER(recipient_email) = LOWER(?)
            ORDER BY created_at DESC LIMIT 50
          `).all(currentUser.id, currentUser.email || '');
        } else {
          // ADV-1.4: Guest view scopes verification codes to the guest's manageToken or requested email, not global outbox!
          const guestEmailFilter = urlObj.searchParams.get('email');
          if (guestEmailFilter) {
            rows = db.prepare(`
              SELECT * FROM notifications_outbox
              WHERE event_type = 'guest_verification_code' AND LOWER(recipient_email) = LOWER(?)
              ORDER BY created_at DESC LIMIT 5
            `).all(guestEmailFilter.trim());
          } else if (guestClaimToken) {
            rows = db.prepare(`
              SELECT * FROM notifications_outbox
              WHERE event_type = 'guest_verification_code' AND body LIKE ?
              ORDER BY created_at DESC LIMIT 5
            `).all(`%${guestClaimToken}%`);
          }
        }
        return sendJson(res, 200, { notifications: rows });
      }

      if (pathname === '/api/reports' && method === 'POST') {
        const body = await readBody(req);
        const reportId = uid('rep');
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO abuse_reports (id, reporter_id, target_type, target_id, reason, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'open', ?)
        `).run(
          reportId,
          currentUser?.id || null,
          body.target_type || 'item',
          body.target_id,
          stripHtmlAndEscape(body.reason || 'Reported via UI'),
          nowIso
        );

        // Optional block follower (SAF-1)
        if (currentUser && body.target_type === 'user') {
          db.prepare(`
            UPDATE follows SET status = 'blocked'
            WHERE follower_id = ? AND target_id = ?
          `).run(body.target_id, currentUser.id);
        }

        return sendJson(res, 201, { report_id: reportId, status: 'open' });
      }

      if (pathname === '/api/admin' && method === 'GET') {
        // ADV-2.1: Enforce Admin Role Check
        if (!currentUser || !currentUser.is_admin) {
          return sendJson(res, 403, { error: 'Admin privileges required (ADV-2.1)' });
        }

        const adapters = db.prepare('SELECT * FROM retailer_adapters ORDER BY store_name ASC').all();
        const reports = db.prepare('SELECT * FROM abuse_reports ORDER BY created_at DESC').all();
        // ADV-1.2: Exclude both owner_id AND co_owner_ids for the current admin's own surprise-mode lists!
        const claimAudit = db.prepare(`
          SELECT ce.*, i.title AS item_title, c.status AS current_claim_status
          FROM claim_events ce
          JOIN claims c ON c.id = ce.claim_id
          JOIN items i ON i.id = c.item_id
          WHERE i.list_id NOT IN (
            SELECT id FROM lists
            WHERE surprise_mode = 1 AND (owner_id = ? OR co_owner_ids LIKE ?)
          )
          ORDER BY ce.at DESC LIMIT 50
        `).all(currentUser.id, `%"${currentUser.id}"%`);

        const overridableClaims = db.prepare(`
          SELECT c.id, c.item_id, c.status, c.qty, c.guest_email, u.name AS claimer_name,
                 i.title AS item_title, l.name AS list_name
          FROM claims c
          JOIN items i ON i.id = c.item_id
          JOIN lists l ON l.id = c.list_id
          LEFT JOIN users u ON u.id = c.claimer_user_id
          WHERE c.status IN ('reserved', 'purchased', 'pending_verification')
            AND l.id NOT IN (
              SELECT id FROM lists
              WHERE surprise_mode = 1 AND (owner_id = ? OR co_owner_ids LIKE ?)
            )
          ORDER BY c.updated_at DESC
        `).all(currentUser.id, `%"${currentUser.id}"%`);

        const analytics = db.prepare('SELECT * FROM analytics_events ORDER BY created_at DESC LIMIT 100').all();

        return sendJson(res, 200, {
          retailer_adapters: adapters,
          abuse_reports: reports,
          claim_audit_log: claimAudit,
          overridable_claims: overridableClaims,
          analytics_events: analytics
        });
      }

      // ADM-1: Audited Admin Claim Override with Mandatory Reason
      if (pathname === '/api/admin/claims/override' && method === 'POST') {
        if (!currentUser || !currentUser.is_admin) {
          return sendJson(res, 403, { error: 'Admin privileges required' });
        }
        const body = await readBody(req);
        if (!body.claim_id || !body.reason || !String(body.reason).trim()) {
          return sendJson(res, 400, { error: 'claim_id and a non-empty audit reason are required for admin overrides (ADM-1)' });
        }
        const updated = transitionClaimState(db, {
          claimId: body.claim_id,
          newState: body.new_state || 'released',
          actorType: 'admin',
          actorId: currentUser.id,
          reason: stripHtmlAndEscape(body.reason)
        });
        return sendJson(res, 200, { claim: updated });
      }

      // ADM-1 & SAF-1: Admin resolves or dismisses an abuse report
      const reportMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)$/);
      if (reportMatch && method === 'PATCH') {
        if (!currentUser || !currentUser.is_admin) {
          return sendJson(res, 403, { error: 'Admin privileges required' });
        }
        const reportId = reportMatch[1];
        const body = await readBody(req);
        db.prepare(`
          UPDATE abuse_reports
          SET status = ?, resolved_by = ?, resolution_note = ?
          WHERE id = ?
        `).run(
          body.status || 'resolved',
          currentUser.id,
          stripHtmlAndEscape(body.resolution_note || 'Reviewed by admin'),
          reportId
        );
        return sendJson(res, 200, { report: db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(reportId) });
      }

      if (pathname === '/api/admin/adapters' && method === 'POST') {
        if (!currentUser || !currentUser.is_admin) {
          return sendJson(res, 403, { error: 'Admin privileges required (ADV-2.1)' });
        }
        const body = await readBody(req);
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO retailer_adapters (
            domain, store_name, title_selector, price_selector, image_selector, variant_selector, client_only, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain) DO UPDATE SET
            store_name = excluded.store_name,
            title_selector = excluded.title_selector,
            price_selector = excluded.price_selector,
            image_selector = excluded.image_selector,
            variant_selector = excluded.variant_selector,
            client_only = excluded.client_only,
            updated_at = excluded.updated_at
        `).run(
          body.domain.toLowerCase().trim(),
          stripHtmlAndEscape(body.store_name),
          body.title_selector || null,
          body.price_selector || null,
          body.image_selector || null,
          body.variant_selector || null,
          body.client_only ? 1 : 0,
          nowIso
        );
        return sendJson(res, 200, { saved: true });
      }

      // =========================================================================
      // 11. STATIC FRONTEND & PWA ASSETS
      // =========================================================================
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        const relativeTarget = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        let filePath = path.resolve(PUBLIC_DIR, relativeTarget);
        // ADV-4.4: Strict path.sep boundary check against sibling directory traversal
        if (
          (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) ||
          !fs.existsSync(filePath) ||
          fs.statSync(filePath).isDirectory()
        ) {
          filePath = path.join(PUBLIC_DIR, 'index.html');
        }
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.webmanifest': 'application/manifest+json; charset=utf-8',
          '.svg': 'image/svg+xml; charset=utf-8'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8' });
        res.end(fs.readFileSync(filePath));
        return;
      }

      return sendJson(res, 404, { error: `Route not found: ${method} ${pathname}` });
    } catch (err) {
      const status = /Unauthorized|permission/i.test(err.message) ? 403 : 400;
      return sendJson(res, status, { error: err.message });
    }
  }

  const server = http.createServer(handleRequest);
  return { server, db, handleRequest };
}

function formatListResponse(db, list, viewerUserId = null, guestClaimToken = null) {
  purgeExpiredClaims(db);
  const viewerCtx = getViewerRole(db, list, viewerUserId, guestClaimToken);
  if (!viewerCtx.canView) return null;

  const owner = db.prepare('SELECT id, name, birthday_month, birthday_day, is_dependent FROM users WHERE id = ?').get(list.owner_id);
  const helperShares = db.prepare(`
    SELECT u.id, u.name
    FROM list_shares ls
    JOIN users u ON u.id = ls.grantee_id
    WHERE ls.list_id = ? AND ls.grantee_type = 'user' AND ls.permission = 'helper'
  `).all(list.id);

  const rawItems = db.prepare(`
    SELECT * FROM items
    WHERE list_id = ? AND status IN ('active', 'received')
    ORDER BY
      CASE priority
        WHEN 'most_wanted' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        ELSE 3
      END ASC,
      sort_order ASC,
      created_at ASC
  `).all(list.id);

  const items = rawItems.map(item => sanitizeItemForViewer(db, item, list, viewerCtx, viewerUserId));

  // CRITICAL SPOILER RULE (Section 8):
  // Owner-side surfaces must NEVER leak claim counts, helper actions, or claimed status!
  const response = {
    id: list.id,
    owner_id: list.owner_id,
    owner_name: owner?.name || 'List Owner',
    owner_is_dependent: Boolean(owner?.is_dependent),
    co_owner_ids: safeJsonParse(list.co_owner_ids, []),
    name: list.name,
    occasion: list.occasion,
    event_date: list.event_date,
    visibility: list.visibility,
    surprise_mode: Boolean(list.surprise_mode),
    share_token: list.share_token,
    share_url: `/?list=${encodeURIComponent(list.share_token)}`,
    revealed_at: list.revealed_at,
    archived_at: list.archived_at,
    created_at: list.created_at,
    viewer_role: viewerCtx.role,
    can_edit: Boolean(viewerCtx.canEdit),
    can_see_claims: Boolean(viewerCtx.canSeeClaims),
    can_release_claims: Boolean(viewerCtx.canReleaseClaims),
    helpers: helperShares,
    items
  };

  return response;
}

function computeNextOccasion(person, occasions = []) {
  const now = new Date();
  let best = null;

  for (const occ of occasions) {
    const d = new Date(occ.date + 'T12:00:00Z');
    const diffDays = Math.ceil((d.getTime() - now.getTime()) / (86400 * 1000));
    if (diffDays >= -7 && (!best || diffDays < best.days_remaining)) {
      best = { label: occ.label, kind: occ.kind, date: occ.date, days_remaining: Math.max(0, diffDays) };
    }
  }

  if (!best && person.birthday_month && person.birthday_day) {
    const year = now.getFullYear();
    let d = new Date(Date.UTC(year, person.birthday_month - 1, person.birthday_day, 12, 0, 0));
    if (d.getTime() < now.getTime() - 86400 * 1000) {
      d = new Date(Date.UTC(year + 1, person.birthday_month - 1, person.birthday_day, 12, 0, 0));
    }
    const diffDays = Math.max(0, Math.ceil((d.getTime() - now.getTime()) / (86400 * 1000)));
    best = {
      label: `${person.name}'s Birthday`,
      kind: 'Birthday',
      date: d.toISOString().slice(0, 10),
      days_remaining: diffDays
    };
  }
  return best;
}

function renderProductBadgeSvg(label, theme = 'indigo') {
  const palettes = {
    indigo: ['#312e81', '#4f46e5', '#e0e7ff'],
    emerald: ['#064e3b', '#10b981', '#d1fae5'],
    forest: ['#14532d', '#16a34a', '#dcfce7'],
    amber: ['#78350f', '#d97706', '#fef3c7'],
    rose: ['#881337', '#e11d48', '#ffe4e6'],
    teal: ['#134e4a', '#0d9488', '#ccfbf1'],
    blue: ['#1e3a8a', '#2563eb', '#dbeafe'],
    purple: ['#581c87', '#9333ea', '#f3e8ff'],
    slate: ['#0f172a', '#334155', '#f1f5f9']
  };
  const [c1, c2, textCol] = palettes[theme] || palettes.indigo;
  const safeText = stripHtmlAndEscape(label).slice(0, 32);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="280" viewBox="0 0 400 280">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${c1}"/>
        <stop offset="100%" stop-color="${c2}"/>
      </linearGradient>
    </defs>
    <rect width="400" height="280" rx="18" fill="url(#g)"/>
    <circle cx="340" cy="50" r="70" fill="rgba(255,255,255,0.08)"/>
    <circle cx="60" cy="230" r="90" fill="rgba(255,255,255,0.06)"/>
    <text x="32" y="95" fill="rgba(255,255,255,0.6)" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="600" letter-spacing="1.5">HUSHLIST VERIFIED PROXY</text>
    <text x="32" y="148" fill="${textCol}" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="700">${safeText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>
    <rect x="32" y="185" width="76" height="6" rx="3" fill="rgba(255,255,255,0.35)"/>
  </svg>`;
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Start server if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const port = Number(process.env.PORT) || 3456;
  const { server } = createApp();
  server.listen(port, () => {
    console.log(`Hushlist Universal Wishlist server running on http://localhost:${port}`);
  });
}
