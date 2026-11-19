import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createDatabase(dbPath = process.env.HUSHLIST_DB || path.join(process.cwd(), 'data', 'hushlist.sqlite')) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  runMigrations(db);
  return db;
}

function runMigrations(db) {
  const claimCols = new Set(db.prepare("PRAGMA table_info(claims)").all().map(c => c.name));
  if (!claimCols.has('verification_attempts')) {
    db.exec('ALTER TABLE claims ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0;');
  }
  if (!claimCols.has('expiry_warned')) {
    db.exec('ALTER TABLE claims ADD COLUMN expiry_warned INTEGER NOT NULL DEFAULT 0;');
  }
}

export function initSchema(db) {
  db.exec(`
    -- 1. Users (Adult accounts and Guardian-managed under-13 dependent profiles, D6)
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      avatar_url TEXT,
      birthday_month INTEGER,
      birthday_day INTEGER,
      is_dependent INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', -- active, suspended, deleted
      auth_credential_id TEXT,
      default_claim_expiry_days INTEGER NOT NULL DEFAULT 7,
      follow_approval_required INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- 2. GuardianLink (Many-to-many guardian <-> dependent under-13 child profile, ACC-3, D6)
    CREATE TABLE IF NOT EXISTS guardian_links (
      guardian_id TEXT NOT NULL,
      dependent_id TEXT NOT NULL,
      relationship TEXT DEFAULT 'Parent/Guardian',
      created_at TEXT NOT NULL,
      PRIMARY KEY (guardian_id, dependent_id),
      FOREIGN KEY (guardian_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (dependent_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 3. Groups & GroupMembers (Family or friend circles, SHR-2)
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      invite_code TEXT UNIQUE NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', -- organizer, member
      joined_at TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 4. Lists (Unlimited lists per user, co-owners, occasion, surprise mode, LST-1..5)
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      co_owner_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of user IDs (LST-3)
      name TEXT NOT NULL,
      occasion TEXT NOT NULL DEFAULT 'Birthday',
      event_date TEXT,
      cover_image TEXT,
      visibility TEXT NOT NULL DEFAULT 'link', -- private, specific, link (LST-2)
      surprise_mode INTEGER NOT NULL DEFAULT 1, -- 1 = surprise on (D1), 0 = registry mode
      share_token TEXT UNIQUE NOT NULL,
      guest_claim_cap INTEGER NOT NULL DEFAULT 3, -- GVR-6
      claim_expiry_days INTEGER NOT NULL DEFAULT 7, -- GVR-2
      revealed_at TEXT, -- Set when owner opts in after event_date + 7 days (Section 8, EVT-2)
      archived_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 5. ListShares (User or Group permissions, including 'helper' for LST-4 / D9)
    CREATE TABLE IF NOT EXISTS list_shares (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      grantee_type TEXT NOT NULL, -- 'user' or 'group'
      grantee_id TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'viewer', -- 'viewer', 'helper', 'co_owner'
      ship_to_approved INTEGER NOT NULL DEFAULT 0, -- P1 optional owner-approved reveal
      created_at TEXT NOT NULL,
      UNIQUE(list_id, grantee_type, grantee_id),
      FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
    );

    -- 6. Follows (Follow a person or a single list, FOL-1, FOL-2)
    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY,
      follower_id TEXT NOT NULL,
      target_type TEXT NOT NULL, -- 'user' or 'list'
      target_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved', -- 'pending', 'approved', 'blocked'
      created_at TEXT NOT NULL,
      UNIQUE(follower_id, target_type, target_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 7. Items (ITM-1..9)
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'product', -- 'product', 'experience', 'cash', 'idea'
      title TEXT NOT NULL,
      canonical_url TEXT,
      original_url TEXT,
      store TEXT,
      image TEXT,
      price REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      variant TEXT, -- size / color
      qty_wanted INTEGER NOT NULL DEFAULT 1,
      always_wanted INTEGER NOT NULL DEFAULT 0, -- ITM-8 consumables/gift cards
      allow_group_chip_in INTEGER NOT NULL DEFAULT 0, -- GVR-4
      priority TEXT NOT NULL DEFAULT 'normal', -- 'most_wanted', 'high', 'normal', 'low'
      notes TEXT,
      any_similar INTEGER NOT NULL DEFAULT 0, -- ITM-3
      giving_instructions TEXT, -- ITM-9 shown only to signed-in group members, never public links
      alternate_sources TEXT NOT NULL DEFAULT '[]', -- ITM-5 JSON array of {store, url, price}
      field_confidence TEXT NOT NULL DEFAULT '{}', -- JSON {title, image, price, store, variant}
      in_stock INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', -- 'active', 'deleted', 'got_it', 'received'
      received_at TEXT,
      received_outside_app INTEGER NOT NULL DEFAULT 0,
      thank_you_sent INTEGER NOT NULL DEFAULT 0, -- EVT-2
      thank_you_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
    );

    -- 8. PriceSnapshots (ITM-6)
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      price REAL,
      in_stock INTEGER NOT NULL DEFAULT 1,
      checked_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );

    -- 9. Claims (GVR-1..8, Section 14)
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      claimer_user_id TEXT, -- null for guest
      guest_email TEXT,
      guest_name TEXT,
      verified INTEGER NOT NULL DEFAULT 0, -- GVR-6: 1 once verified or signed-in user
      verification_code TEXT,
      verification_expires_at TEXT,
      verification_attempts INTEGER NOT NULL DEFAULT 0, -- ADV-3.1: max 5 attempts before lockout
      manage_token TEXT UNIQUE NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'reserved', -- 'pending_verification', 'reserved', 'purchased', 'given', 'released', 'expired', 'withdrawn'
      show_name_to_givers INTEGER NOT NULL DEFAULT 1, -- GVR-7
      expires_at TEXT,
      order_note TEXT,
      clicked_out_at TEXT, -- GVR-3 tracks click-out for "Did you buy it?" prompt
      return_prompt_answered TEXT, -- 'bought', 'not_yet', 'released'
      expiry_warned INTEGER NOT NULL DEFAULT 0, -- GVR-2: 48h advance warning sent
      thank_you_sent INTEGER NOT NULL DEFAULT 0, -- EVT-2
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
    );

    -- 10. ClaimEvents (Audit trail for claim transitions, Section 10 & 14)
    CREATE TABLE IF NOT EXISTS claim_events (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL, -- 'giver', 'helper', 'admin', 'expiry', 'system', 'owner_indirect'
      actor_id TEXT,
      reason TEXT,
      at TEXT NOT NULL,
      FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
    );

    -- 11. Contributions (GVR-4 group chip-in pledges; no platform money movement D5)
    CREATE TABLE IF NOT EXISTS contributions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      contributor_user_id TEXT,
      guest_email TEXT,
      guest_name TEXT,
      pledged_amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pledged', -- 'pledged', 'paid_off_platform', 'withdrawn'
      show_name_to_givers INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );

    -- 12. SecretIdeas (GVR-5 private gift ideas for someone else, hidden from subject)
    CREATE TABLE IF NOT EXISTS secret_ideas (
      id TEXT PRIMARY KEY,
      subject_user_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      estimated_price REAL,
      note TEXT,
      claimed_by_user_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 13. Occasions (TRK-2 upcoming occasions timeline)
    CREATE TABLE IF NOT EXISTS occasions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL, -- 'Birthday', 'Holiday', 'Anniversary', 'Other'
      label TEXT NOT NULL,
      date TEXT NOT NULL, -- YYYY-MM-DD
      recurs INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 14. Budgets (TRK-4 budget per person per occasion, private to owner)
    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      occasion TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL,
      UNIQUE(owner_id, subject_user_id, occasion),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 15. Events (General audit trail and follower digest source, Section 10)
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      list_id TEXT,
      action TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      is_spoiler INTEGER NOT NULL DEFAULT 0, -- 1 if event involves claims/secret ideas
      at TEXT NOT NULL
    );

    -- 16. Invitations (ACC-1, Flow D)
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      inviter_id TEXT NOT NULL,
      target_type TEXT NOT NULL, -- 'group' or 'list'
      target_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'link',
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_by TEXT,
      created_at TEXT NOT NULL
    );

    -- 17. NotificationPreferences & NotificationOutbox (Section 16, NTF-1..3)
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      enabled INTEGER NOT NULL DEFAULT 1,
      digest_frequency TEXT NOT NULL DEFAULT 'daily', -- 'daily', 'weekly'
      time_zone TEXT NOT NULL DEFAULT 'America/New_York',
      quiet_hours_start INTEGER NOT NULL DEFAULT 21, -- 9 PM
      quiet_hours_end INTEGER NOT NULL DEFAULT 8, -- 8 AM
      UNIQUE(user_id, event_type, channel),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications_outbox (
      id TEXT PRIMARY KEY,
      recipient_user_id TEXT,
      recipient_email TEXT NOT NULL,
      event_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      transactional INTEGER NOT NULL DEFAULT 0,
      unsubscribe_token TEXT,
      scheduled_for TEXT NOT NULL,
      sent_at TEXT,
      created_at TEXT NOT NULL
    );

    -- 18. AbuseReports (SAF-1, ADM-1)
    CREATE TABLE IF NOT EXISTS abuse_reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT,
      target_type TEXT NOT NULL, -- 'list', 'item', 'user'
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', -- 'open', 'resolved', 'dismissed'
      resolved_by TEXT,
      resolution_note TEXT,
      created_at TEXT NOT NULL
    );

    -- 19. SecretSantaExchanges & Pairings (EXC-1: organizer cannot see pairings by default)
    CREATE TABLE IF NOT EXISTS secret_santa_exchanges (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      event_date TEXT NOT NULL,
      budget_limit REAL DEFAULT 50,
      exclusions TEXT NOT NULL DEFAULT '[]', -- JSON array of [userA, userB] pairs
      verification_hash TEXT NOT NULL, -- Cryptographic commitment proving draw completeness without leaking pairs
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secret_santa_pairings (
      exchange_id TEXT NOT NULL,
      giver_user_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      PRIMARY KEY (exchange_id, giver_user_id),
      FOREIGN KEY (exchange_id) REFERENCES secret_santa_exchanges(id) ON DELETE CASCADE
    );

    -- 20. RetailerAdapters (Section 7 & 17: selectors maintained as config, not code)
    CREATE TABLE IF NOT EXISTS retailer_adapters (
      domain TEXT PRIMARY KEY,
      store_name TEXT NOT NULL,
      title_selector TEXT,
      price_selector TEXT,
      image_selector TEXT,
      variant_selector TEXT,
      client_only INTEGER NOT NULL DEFAULT 0, -- 1 for amazon.* (D3)
      capture_attempts INTEGER NOT NULL DEFAULT 0,
      capture_successes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    -- 21. AnalyticsEvents (Section 18: first-party only, no item titles or URLs in payload)
    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
}

export function uid(prefix = '') {
  const raw = crypto.randomBytes(8).toString('hex');
  return prefix ? `${prefix}_${raw}` : raw;
}
