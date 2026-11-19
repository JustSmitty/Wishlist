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
  db.exec('PRAGMA busy_timeout = 5000;');
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

  const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  if (!cols('auth_challenges').has('requester')) {
    db.exec('ALTER TABLE auth_challenges ADD COLUMN requester TEXT;');
  }
  // Used only to keep an administrator from seeing activity on their own
  // sealed lists; never returned to anyone.
  if (!cols('analytics_events').has('list_id')) {
    db.exec('ALTER TABLE analytics_events ADD COLUMN list_id TEXT;');
  }
  // The earliest date a sealed list may be opened, independent of later
  // edits to its occasion date. Only ever moves later.
  if (!cols('lists').has('sealed_until')) {
    db.exec('ALTER TABLE lists ADD COLUMN sealed_until TEXT;');
  }
  // When the current hold began (a hold can be renewed, so this is not created_at).
  if (!claimCols.has('hold_started_at')) {
    db.exec('ALTER TABLE claims ADD COLUMN hold_started_at TEXT;');
  }
  // Whose name a stored message mentions, so it can be removed with that person.
  if (!cols('notifications_outbox').has('about_user_id')) {
    db.exec('ALTER TABLE notifications_outbox ADD COLUMN about_user_id TEXT;');
  }
  // The Google account (OpenID "sub") linked to this person, if any.
  if (!cols('users').has('google_sub')) {
    db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT;');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;');
  // One row per Google sign-in in progress: what the browser must bring back.
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY,
      browser_hash TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      return_to TEXT NOT NULL DEFAULT '/',
      link_user_id TEXT,
      invite_code TEXT,
      created_at TEXT NOT NULL,
      used_at TEXT
    );
  `);
  // Delivery bookkeeping: retries with back-off, and a final give-up.
  for (const [name, type] of [['attempts', 'INTEGER NOT NULL DEFAULT 0'], ['next_attempt_at', 'TEXT'], ['failed_at', 'TEXT'], ['last_error', 'TEXT']]) {
    if (!cols('notifications_outbox').has(name)) db.exec(`ALTER TABLE notifications_outbox ADD COLUMN ${name} ${type};`);
  }
  // IANA zone reported by the person's browser; used for quiet hours only.
  if (!cols('users').has('time_zone')) {
    db.exec('ALTER TABLE users ADD COLUMN time_zone TEXT;');
  }

  // Blocks used to be follows rows with status 'blocked'. That let the wrong
  // party edit them and tied a block to a follow. They are their own table now.
  const legacyBlocks = db.prepare("SELECT * FROM follows WHERE status = 'blocked'").all();
  for (const f of legacyBlocks) {
    const blocker = f.target_type === 'user'
      ? f.target_id
      : db.prepare('SELECT owner_id FROM lists WHERE id = ?').get(f.target_id)?.owner_id;
    if (blocker && db.prepare('SELECT 1 FROM users WHERE id = ?').get(blocker)) {
      const email = db.prepare('SELECT email FROM users WHERE id = ?').get(f.follower_id)?.email;
      db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, blocked_email_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(blocker, f.follower_id, email ? sha256(email.toLowerCase()) : null, f.created_at);
    }
    db.prepare('DELETE FROM follows WHERE id = ?').run(f.id);
  }

  // Lookups that every list / dashboard request performs. Without these each
  // one is a full table scan.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_id);
    CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id, status);
    CREATE INDEX IF NOT EXISTS idx_claims_item ON claims(item_id, status);
    CREATE INDEX IF NOT EXISTS idx_claims_list ON claims(list_id);
    CREATE INDEX IF NOT EXISTS idx_claims_claimer ON claims(claimer_user_id);
    CREATE INDEX IF NOT EXISTS idx_claim_events_claim ON claim_events(claim_id);
    CREATE INDEX IF NOT EXISTS idx_contributions_item ON contributions(item_id, status);
    CREATE INDEX IF NOT EXISTS idx_price_snapshots_item ON price_snapshots(item_id, checked_at);
    CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_secret_ideas_subject ON secret_ideas(subject_user_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_recipient ON notifications_outbox(recipient_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_list ON events(list_id, at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_claims_status_expiry ON claims(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_challenges_email ON auth_challenges(email, created_at);
    CREATE INDEX IF NOT EXISTS idx_exchanges_group ON secret_santa_exchanges(group_id);
    CREATE INDEX IF NOT EXISTS idx_contributions_list ON contributions(list_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON notifications_outbox(scheduled_for) WHERE sent_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
  `);
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

    -- 22. Sessions. Only the SHA-256 of the bearer token is stored, so a copy
    --     of the database does not let anyone sign in. kind = 'web' (cookie)
    --     or 'api' (browser-extension token).
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'web',
      label TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 24. Blocks. blocked_email_hash lets a block survive the blocked person
    --     deleting their account and signing up again with the same address.
    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id TEXT NOT NULL,
      blocked_id TEXT,
      blocked_email_hash TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_pair ON blocks(blocker_id, blocked_id) WHERE blocked_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(blocked_email_hash);

    -- 23. Passwordless sign-in challenges (8-digit code sent to the email).
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT,
      consumed_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

/** Row identifier. Not a secret: never use one as proof of anything. */
export function uid(prefix = '') {
  const raw = crypto.randomBytes(8).toString('hex');
  return prefix ? `${prefix}_${raw}` : raw;
}

/**
 * Bearer secret (share links, claim manage links, sessions, invite codes).
 * 192 bits from the OS CSPRNG, URL-safe.
 */
export function secretToken(prefix = '') {
  const raw = crypto.randomBytes(24).toString('base64url');
  return prefix ? `${prefix}_${raw}` : raw;
}

/**
 * Uniform 8-digit code for signing in. Five tries per code and a capped number
 * of codes per address bound online guessing; two more digits than the usual
 * six make that bound a hundred times smaller.
 */
export function signInCode() {
  return String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
}

/** Uniform 6-digit code from the CSPRNG (Math.random is not acceptable here). */
export function sixDigitCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const openTransactions = new WeakSet();

/**
 * Runs fn inside BEGIN IMMEDIATE … COMMIT, rolling back on any throw.
 * Re-entrant: a call made while a transaction is already open on this
 * connection joins it instead of issuing a second BEGIN (which SQLite rejects).
 */
export function inTransaction(db, fn) {
  if (openTransactions.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  openTransactions.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  } finally {
    openTransactions.delete(db);
  }
}
