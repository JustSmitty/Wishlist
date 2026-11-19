/**
 * Seed data: the retailer adapter configuration (always) and the sample
 * "Smith family" (demo mode only). Sample addresses use the reserved
 * .example domain so they can never belong to a real person.
 */

import { inTransaction, secretToken } from './schema.mjs';

export const TOP_30_RETAILER_ADAPTERS = [
  { domain: 'amazon.com', store_name: 'Amazon', title_selector: '#productTitle', price_selector: '.a-price-whole', image_selector: '#landingImage', variant_selector: '#variation_color_name .selection, #variation_size_name .selection', client_only: 1 },
  { domain: 'target.com', store_name: 'Target', title_selector: '[data-test="product-title"]', price_selector: '[data-test="product-price"]', image_selector: '.slideDeckPicture img', variant_selector: '[data-test="variant-value"]', client_only: 0 },
  { domain: 'etsy.com', store_name: 'Etsy', title_selector: '[data-buy-box-listing-title]', price_selector: '[data-buy-box-region="price"] p', image_selector: '.carousel-image', variant_selector: '#variation-selector-0', client_only: 0 },
  { domain: 'walmart.com', store_name: 'Walmart', title_selector: '#main-title', price_selector: '[itemprop="price"]', image_selector: '.db-hero-image', variant_selector: '.variant-selected', client_only: 0 },
  { domain: 'bestbuy.com', store_name: 'Best Buy', title_selector: '.sku-title h1', price_selector: '.priceView-customer-price span', image_selector: '.primary-image', variant_selector: '.variation-header-value', client_only: 0 },
  { domain: 'rei.com', store_name: 'REI', title_selector: '#product-page-title', price_selector: '#buy-box-product-price', image_selector: '.media-center-carousel__image', variant_selector: '.color-thumb--selected', client_only: 0 },
  { domain: 'nike.com', store_name: 'Nike', title_selector: '#pdp_product_title', price_selector: '[data-test="product-price"]', image_selector: '.hero-image', variant_selector: '[data-test="colorway-title"]', client_only: 0 },
  { domain: 'apple.com', store_name: 'Apple', title_selector: '.rf-pdp-title', price_selector: '.rc-prices-fullprice', image_selector: '.rf-pdp-inline-image', variant_selector: '.colornav-link.current', client_only: 0 },
  { domain: 'lego.com', store_name: 'LEGO', title_selector: '[data-test="product-overview-name"]', price_selector: '[data-test="product-price"]', image_selector: '.ProductImage', variant_selector: '.set-number', client_only: 0 },
  { domain: 'sephora.com', store_name: 'Sephora', title_selector: '[data-at="product_name"]', price_selector: '[data-comp="Price"]', image_selector: '.css-hero-img', variant_selector: '[data-at="selected_swatch_label"]', client_only: 0 },
  { domain: 'nordstrom.com', store_name: 'Nordstrom', title_selector: '#product-page-product-title-lockup', price_selector: '#current-price-string', image_selector: '#product-media-image', variant_selector: '.selected-filter-value', client_only: 0 },
  { domain: 'crateandbarrel.com', store_name: 'Crate & Barrel', title_selector: '.product-name', price_selector: '.regPrice', image_selector: '.shop-product-image', variant_selector: '.selected-sku-title', client_only: 0 },
  { domain: 'williams-sonoma.com', store_name: 'Williams Sonoma', title_selector: '.pip-summary h1', price_selector: '.price-amount', image_selector: '.hero-image', variant_selector: '.subset-attributes', client_only: 0 },
  { domain: 'bookshop.org', store_name: 'Bookshop.org', title_selector: '#book-title', price_selector: '.price-value', image_selector: '.book-cover', variant_selector: '.book-format', client_only: 0 },
  { domain: 'patagonia.com', store_name: 'Patagonia', title_selector: '#product-title', price_selector: '.price .value', image_selector: '.pdp-hero-image', variant_selector: '.selected-color-name', client_only: 0 },
  { domain: 'uniqlo.com', store_name: 'Uniqlo', title_selector: '.pdp-title', price_selector: '.pdp-price', image_selector: '.pdp-main-image', variant_selector: '.chip-selected', client_only: 0 },
  { domain: 'ikea.com', store_name: 'IKEA', title_selector: '.pip-header-section__title--big', price_selector: '.pip-temp-price__integer', image_selector: '.pip-image', variant_selector: '.pip-header-section__description-text', client_only: 0 },
  { domain: 'wayfair.com', store_name: 'Wayfair', title_selector: '[data-hb-id="Heading"]', price_selector: '.SFPrice', image_selector: '.ProductDetailImageCarousel img', variant_selector: '.OptionName', client_only: 0 },
  { domain: 'anthropologie.com', store_name: 'Anthropologie', title_selector: '.c-pwa-product-meta-heading', price_selector: '.c-pwa-product-price__current', image_selector: '.c-pwa-image-viewer__img', variant_selector: '.c-pwa-swatch__label', client_only: 0 },
  { domain: 'lululemon.com', store_name: 'lululemon', title_selector: '.pdp-title', price_selector: '.price', image_selector: '.pdp-carousel-image', variant_selector: '.color-selection', client_only: 0 },
  { domain: 'chewy.com', store_name: 'Chewy', title_selector: '#product-title', price_selector: '[data-testid="advertised-price"]', image_selector: '#product-main-image', variant_selector: '.variation-selected', client_only: 0 },
  { domain: 'homedepot.com', store_name: 'Home Depot', title_selector: '.product-details__badge-title--wrapper h1', price_selector: '.price-format__main-price', image_selector: '.mediagallery__mainimage', variant_selector: '.sku-variant', client_only: 0 },
  { domain: 'lowes.com', store_name: "Lowe's", title_selector: '.product-brand-description', price_selector: '.main-price', image_selector: '.pdp-main-image', variant_selector: '.selected-variant', client_only: 0 },
  { domain: 'macys.com', store_name: "Macy's", title_selector: '[data-auto="product-name"]', price_selector: '.lowest-sale-price', image_selector: '.main-image-img', variant_selector: '.color-header-name', client_only: 0 },
  { domain: 'kohls.com', store_name: "Kohl's", title_selector: '.product-title', price_selector: '.pdpprice-row2-main-text', image_selector: '.pdp-hero-image', variant_selector: '.pdp-product-swatch', client_only: 0 },
  { domain: 'bhphotovideo.com', store_name: 'B&H Photo', title_selector: '[data-selenium="productTitle"]', price_selector: '[data-selenium="pricingPrice"]', image_selector: '[data-selenium="inlineMediaMainImage"]', variant_selector: '[data-selenium="selectedVariation"]', client_only: 0 },
  { domain: 'adidas.com', store_name: 'Adidas', title_selector: '[data-auto-id="product-title"]', price_selector: '.gl-price-item', image_selector: '.pdp-image', variant_selector: '.color-label', client_only: 0 },
  { domain: 'zappos.com', store_name: 'Zappos', title_selector: '#overview h1', price_selector: '[itemprop="price"]', image_selector: '#stage-image', variant_selector: '#color-selected', client_only: 0 },
  { domain: 'potterybarn.com', store_name: 'Pottery Barn', title_selector: '.pip-summary h1', price_selector: '.price-amount', image_selector: '.hero-image', variant_selector: '.subset-attributes', client_only: 0 },
  { domain: 'barnesandnoble.com', store_name: 'Barnes & Noble', title_selector: 'h1.pdp-header-title', price_selector: '#pdp-cur-price', image_selector: '#pdpMainImage', variant_selector: '.format-selected', client_only: 0 }
];

/**
 * Retailer adapters are configuration, not demo data: every install gets them.
 * Counters start at zero — they are measurements, not marketing.
 */
export function seedRetailerAdapters(db) {
  const nowIso = new Date().toISOString();
  const insertAdapter = db.prepare(`
    INSERT OR IGNORE INTO retailer_adapters (
      domain, store_name, title_selector, price_selector, image_selector, variant_selector,
      client_only, capture_attempts, capture_successes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
  `);
  for (const a of TOP_30_RETAILER_ADAPTERS) {
    insertAdapter.run(
      a.domain, a.store_name, a.title_selector, a.price_selector, a.image_selector, a.variant_selector,
      a.client_only, nowIso
    );
  }
}

/** Adapters plus the sample family. Used by demo mode and by the tests. */
export function seedDatabase(db) {
  seedRetailerAdapters(db);
  seedDemoData(db);
}

/**
 * The sample "Smith family". Only ever loaded in demo mode: it contains an
 * admin account with a well-known id.
 */
export function seedDemoData(db) {
  const existingUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (existingUsers > 0) return;
  // All or nothing: a failure part-way must not leave a half-built family
  // that the "already seeded" check above would then never repair.
  inTransaction(db, () => insertDemoData(db));
}

function insertDemoData(db) {

  const now = new Date();
  const nowIso = now.toISOString();

  // Occasions are placed relative to today so the sample data never goes stale.
  const inDays = (n) => new Date(now.getTime() + n * 86400 * 1000).toISOString().slice(0, 10);
  const monthDay = (iso) => [Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
  const mayaDay = inDays(10);
  const leoDay = inDays(16);
  const justinDay = inDays(25);
  const holidayDay = inDays(36);
  const elenaDay = inDays(60);
  const arthurDay = inDays(106);

  // 2. Seed Users (Adults + Under-13 Dependent Child Profile)
  const insertUser = db.prepare(`
    INSERT INTO users (
      id, name, email, avatar_url, birthday_month, birthday_day,
      is_dependent, is_admin, status, default_claim_expiry_days, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 7, ?)
  `);

  // Justin Smith (Primary user & Admin)
  insertUser.run('usr_justin', 'Justin Smith', 'justin@smith.example', null, ...monthDay(justinDay), 0, 1, nowIso);
  // Maya Smith (Partner / Co-owner & List Helper)
  insertUser.run('usr_maya', 'Maya Smith', 'maya@smith.example', null, ...monthDay(mayaDay), 0, 0, nowIso);
  // Aunt Elena (Relative / Active Follower & Gift-Giver)
  insertUser.run('usr_elena', 'Aunt Elena Vance', 'elena@vance.example', null, ...monthDay(elenaDay), 0, 0, nowIso);
  // Grandpa Arthur (Older relative persona)
  insertUser.run('usr_arthur', 'Grandpa Arthur', 'arthur@smith.example', null, ...monthDay(arthurDay), 0, 0, nowIso);
  // Leo Smith (Under-13 Dependent Child Profile — no email/login per D6!)
  insertUser.run('usr_leo', 'Leo Smith', null, null, ...monthDay(leoDay), 1, 0, nowIso);

  // Guardian Links for Leo (Many-to-many: both Justin and Maya are guardians)
  const insertGuardian = db.prepare(`
    INSERT INTO guardian_links (guardian_id, dependent_id, relationship, created_at)
    VALUES (?, ?, ?, ?)
  `);
  insertGuardian.run('usr_justin', 'usr_leo', 'Parent / Guardian', nowIso);
  insertGuardian.run('usr_maya', 'usr_leo', 'Parent / Guardian', nowIso);

  // 3. Seed Family Group ("Smith Family Circle")
  db.prepare(`
    INSERT INTO groups (id, name, description, invite_code, created_by, created_at)
    VALUES ('grp_smith', 'Smith Family Circle', 'Birthdays, holidays and the kids — no duplicate gifts, no spoiled surprises.', 'SMITH-FAMILY', 'usr_justin', ?)
  `).run(nowIso);

  const insertMember = db.prepare('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
  insertMember.run('grp_smith', 'usr_justin', 'organizer', nowIso);
  insertMember.run('grp_smith', 'usr_maya', 'organizer', nowIso);
  insertMember.run('grp_smith', 'usr_elena', 'member', nowIso);
  insertMember.run('grp_smith', 'usr_arthur', 'member', nowIso);

  // 4. Seed Follows (Everyone follows each other in the family)
  const insertFollow = db.prepare(`
    INSERT INTO follows (id, follower_id, target_type, target_id, status, created_at)
    VALUES (?, ?, 'user', ?, 'approved', ?)
  `);
  insertFollow.run('fol_1', 'usr_justin', 'usr_maya', nowIso);
  insertFollow.run('fol_2', 'usr_justin', 'usr_elena', nowIso);
  insertFollow.run('fol_3', 'usr_justin', 'usr_arthur', nowIso);
  insertFollow.run('fol_4', 'usr_justin', 'usr_leo', nowIso);
  insertFollow.run('fol_5', 'usr_maya', 'usr_justin', nowIso);
  insertFollow.run('fol_6', 'usr_elena', 'usr_justin', nowIso);
  insertFollow.run('fol_7', 'usr_elena', 'usr_maya', nowIso);
  insertFollow.run('fol_8', 'usr_elena', 'usr_leo', nowIso);
  insertFollow.run('fol_9', 'usr_arthur', 'usr_justin', nowIso);
  insertFollow.run('fol_10', 'usr_arthur', 'usr_leo', nowIso);

  // 5. Seed Occasions (TRK-2)
  const insertOccasion = db.prepare(`
    INSERT INTO occasions (id, user_id, kind, label, date, recurs, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);
  insertOccasion.run('occ_maya_bday', 'usr_maya', 'Birthday', "Maya's birthday", mayaDay, nowIso);
  insertOccasion.run('occ_leo_bday', 'usr_leo', 'Birthday', "Leo's 9th birthday", leoDay, nowIso);
  insertOccasion.run('occ_justin_bday', 'usr_justin', 'Birthday', "Justin's birthday", justinDay, nowIso);
  insertOccasion.run('occ_winter', 'usr_justin', 'Holiday', 'Winter holidays', holidayDay, nowIso);
  insertOccasion.run('occ_elena_bday', 'usr_elena', 'Birthday', "Aunt Elena's birthday", elenaDay, nowIso);

  // 6. Seed Budgets (TRK-4)
  const insertBudget = db.prepare(`
    INSERT INTO budgets (id, owner_id, subject_user_id, occasion, amount, currency, created_at)
    VALUES (?, ?, ?, ?, ?, 'USD', ?)
  `);
  insertBudget.run('bdg_1', 'usr_justin', 'usr_maya', 'Birthday', 250, nowIso);
  insertBudget.run('bdg_2', 'usr_justin', 'usr_leo', 'Birthday', 150, nowIso);
  insertBudget.run('bdg_3', 'usr_justin', 'usr_elena', 'Holiday', 100, nowIso);
  insertBudget.run('bdg_4', 'usr_elena', 'usr_justin', 'Birthday', 150, nowIso);

  // 7. Seed Lists
  const insertList = db.prepare(`
    INSERT INTO lists (
      id, owner_id, co_owner_ids, name, occasion, event_date, cover_image,
      visibility, surprise_mode, share_token, guest_claim_cap, claim_expiry_days, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, 7, ?)
  `);

  // Justin's Personal List (Surprise mode ON by default - D1)
  insertList.run(
    'lst_justin_holiday', 'usr_justin', '[]', "Justin's birthday & winter wishlist",
    'Birthday', justinDay, null, 'link', 1, 'justin-winter-2026', nowIso
  );

  // Maya's Birthday List (Surprise mode ON)
  insertList.run(
    'lst_maya_bday', 'usr_maya', '[]', "Maya's birthday & cozy reads",
    'Birthday', mayaDay, null, 'link', 1, 'maya-birthday-2026', nowIso
  );

  // Leo's 9th Birthday List (Guardian-managed under-13 list)
  insertList.run(
    'lst_leo_bday', 'usr_leo', '[]', "Leo's 9th birthday: LEGO & space",
    // A child's list is shared with the family circle, not by public link.
    'Birthday', leoDay, null, 'specific', 1, secretToken('shr'), nowIso
  );

  // Aunt Elena's Holiday List
  insertList.run(
    'lst_elena_holiday', 'usr_elena', '[]', "Elena's kitchen & garden wishes",
    'Holiday', holidayDay, null, 'link', 1, 'elena-holiday-2026', nowIso
  );

  // List Helpers (LST-4 / D9): Maya is helper on Justin's list; Justin is helper on Maya's list
  const insertShare = db.prepare(`
    INSERT INTO list_shares (id, list_id, grantee_type, grantee_id, permission, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertShare.run('shr_1', 'lst_justin_holiday', 'user', 'usr_maya', 'helper', nowIso);
  insertShare.run('shr_2', 'lst_justin_holiday', 'group', 'grp_smith', 'viewer', nowIso);
  insertShare.run('shr_3', 'lst_maya_bday', 'user', 'usr_justin', 'helper', nowIso);
  insertShare.run('shr_4', 'lst_maya_bday', 'group', 'grp_smith', 'viewer', nowIso);
  insertShare.run('shr_5', 'lst_leo_bday', 'group', 'grp_smith', 'viewer', nowIso);
  insertShare.run('shr_6', 'lst_elena_holiday', 'group', 'grp_smith', 'viewer', nowIso);

  // 8. Seed Items across Lists (Products, Experiences, Cash/Gift Cards, Ideas, Group Chip-in)
  const insertItem = db.prepare(`
    INSERT INTO items (
      id, list_id, kind, title, canonical_url, original_url, store, image, price, currency,
      variant, qty_wanted, always_wanted, allow_group_chip_in, priority, notes,
      any_similar, giving_instructions, field_confidence, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const hiConf = JSON.stringify({ title: 0.98, image: 0.96, price: 0.98, store: 0.99, variant: 0.95 });

  // Justin's Items (Note: Aunt Elena & Maya have claimed some of these, which Justin CANNOT see when viewing as himself!)
  insertItem.run(
    'itm_j1', 'lst_justin_holiday', 'product',
    'Fellow Stagg EKG Pro Electric Pour-Over Kettle',
    'https://www.crateandbarrel.com/fellow-stagg-ekg-pro-kettle/s12345',
    'https://www.crateandbarrel.com/fellow-stagg-ekg-pro-kettle/s12345',
    'Crate & Barrel', '/api/image-proxy?label=Fellow+Stagg+EKG+Pro&theme=slate', 195.00,
    'Matte Black / Walnut Handle', 1, 0, 1, 'most_wanted',
    'For morning pour-over coffee in the office.', 0, null, hiConf, 1, nowIso, nowIso
  );

  insertItem.run(
    'itm_j2', 'lst_justin_holiday', 'product',
    'Patagonia Better Sweater Quarter-Zip Fleece',
    'https://www.rei.com/product/patagonia-better-sweater-123',
    'https://www.rei.com/product/patagonia-better-sweater-123',
    'REI', '/api/image-proxy?label=Patagonia+Better+Sweater&theme=forest', 139.00,
    'Size: Large / Color: Stonewash', 1, 0, 0, 'high',
    'Large fits best.', 0, null, hiConf, 2, nowIso, nowIso
  );

  insertItem.run(
    'itm_j3', 'lst_justin_holiday', 'experience',
    'Handmade Pasta & Sauce Making Workshop for Two',
    null, null, 'Local Culinary Studio', '/api/image-proxy?label=Pasta+Making+Workshop&theme=amber', 120.00,
    'Weekend Evening Session', 1, 0, 1, 'most_wanted',
    'No URL needed — any local culinary class gift voucher works!', 1, null, hiConf, 3, nowIso, nowIso
  );

  insertItem.run(
    'itm_j4', 'lst_justin_holiday', 'cash',
    'Indie Bookstore & Espresso Fund',
    null, null, 'Bookshop.org / Local Cafe', '/api/image-proxy?label=Bookstore+%26+Coffee+Fund&theme=rose', 25.00,
    'Any denomination', 1, 1, 0, 'normal',
    'Always appreciated year-round for weekend reads.', 1,
    'Venmo @justin-smith-example, or a gift card from any local indie bookstore', hiConf, 4, nowIso, nowIso
  );

  // Maya's Items
  insertItem.run(
    'itm_m1', 'lst_maya_bday', 'product',
    'Le Creuset Signature Enameled Cast Iron Dutch Oven (5.5 Qt)',
    'https://www.williams-sonoma.com/products/le-creuset-signature-round-wide-dutch-oven',
    'https://www.williams-sonoma.com/products/le-creuset-signature-round-wide-dutch-oven',
    'Williams Sonoma', '/api/image-proxy?label=Le+Creuset+5.5Qt+Olive&theme=emerald', 420.00,
    'Color: Olive / 5.5 Quart', 1, 0, 1, 'most_wanted',
    'Group chip-in enabled! Olive or Thyme green preferred.', 0, null, hiConf, 1, nowIso, nowIso
  );

  insertItem.run(
    'itm_m2', 'lst_maya_bday', 'product',
    'Hand-Thrown Ceramic Matcha Bowl with Bamboo Whisk Set',
    'https://www.etsy.com/listing/99887766/ceramic-matcha-bowl-set',
    'https://www.etsy.com/listing/99887766/ceramic-matcha-bowl-set',
    'Etsy', '/api/image-proxy?label=Ceramic+Matcha+Bowl+Set&theme=teal', 68.00,
    'Speckled Cream Glaze', 1, 0, 0, 'most_wanted',
    'From studio ceramicist KyotoClayWorks.', 0, null, hiConf, 2, nowIso, nowIso
  );

  insertItem.run(
    'itm_m3', 'lst_maya_bday', 'idea',
    'Any Sci-Fi Hardcover by Becky Chambers or Ted Chiang',
    'https://bookshop.org/p/books/psalm-for-the-wild-built',
    'https://bookshop.org/p/books/psalm-for-the-wild-built',
    'Bookshop.org', '/api/image-proxy?label=Sci-Fi+Hardcover+Reads&theme=indigo', 26.00,
    'Hardcover or Signed Edition', 2, 0, 0, 'high',
    'Used copies from local shops are wonderful too!', 1, null, hiConf, 3, nowIso, nowIso
  );

  // Leo's Items (Under-13 Child List)
  insertItem.run(
    'itm_l1', 'lst_leo_bday', 'product',
    'LEGO Icons NASA Artemis Space Launch System Set',
    'https://www.lego.com/en-us/product/nasa-artemis-space-launch-system-10341',
    'https://www.lego.com/en-us/product/nasa-artemis-space-launch-system-10341',
    'LEGO', '/api/image-proxy?label=LEGO+NASA+Artemis+Rocket&theme=blue', 99.99,
    'Set #10341', 1, 0, 1, 'most_wanted',
    'Leo has been talking about this rocket every day for weeks!', 0, null, hiConf, 1, nowIso, nowIso
  );

  insertItem.run(
    'itm_l2', 'lst_leo_bday', 'product',
    'National Geographic Kids Ultimate Space Atlas',
    'https://www.target.com/p/nat-geo-space-atlas/-/A-88221100',
    'https://www.target.com/p/nat-geo-space-atlas/-/A-88221100',
    'Target', '/api/image-proxy?label=NatGeo+Space+Atlas&theme=purple', 24.99,
    'Hardcover', 1, 0, 0, 'high',
    'Great for bedtime reading.', 0, null, hiConf, 2, nowIso, nowIso
  );

  // Elena's Items
  insertItem.run(
    'itm_e1', 'lst_elena_holiday', 'product',
    'Japanese Forged Hori-Hori Garden Knife with Leather Sheath',
    'https://www.etsy.com/listing/11223344/japanese-hori-hori-garden-knife',
    'https://www.etsy.com/listing/11223344/japanese-hori-hori-garden-knife',
    'Etsy', '/api/image-proxy?label=Hori-Hori+Garden+Knife&theme=forest', 54.00,
    'Walnut Handle + Sheath', 1, 0, 0, 'most_wanted',
    'For spring bulb planting.', 0, null, hiConf, 1, nowIso, nowIso
  );

  // 9. Seed Claims & Group Contributions
  // - Aunt Elena reserved & purchased Justin's Patagonia Better Sweater (Justin MUST NOT see this in surprise mode!)
  // - Justin reserved & purchased Maya's Matcha Bowl Set (shows in Justin's "My Claims" tracker!)
  // - Justin & Elena both chipped in toward Maya's Le Creuset Dutch Oven ($270 of $420 pledged)
  // - Grandpa Arthur reserved Leo's NatGeo Space Atlas
  const futureExpiry = new Date(now.getTime() + 7 * 86400 * 1000).toISOString();
  const insertClaim = db.prepare(`
    INSERT INTO claims (
      id, item_id, list_id, claimer_user_id, guest_email, guest_name,
      verified, manage_token, qty, status, show_name_to_givers,
      expires_at, order_note, clicked_out_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `);

  insertClaim.run(
    'clm_elena_on_justin', 'itm_j2', 'lst_justin_holiday', 'usr_elena',
    secretToken('mng'), 1, 'purchased', futureExpiry, 'Ordered from REI #98112 - wrapped in blue paper', nowIso, nowIso, nowIso
  );

  insertClaim.run(
    'clm_justin_on_maya', 'itm_m2', 'lst_maya_bday', 'usr_justin',
    secretToken('mng'), 1, 'purchased', futureExpiry, 'Etsy order #44519 — arriving next week', nowIso, nowIso, nowIso
  );

  insertClaim.run(
    'clm_justin_on_elena', 'itm_e1', 'lst_elena_holiday', 'usr_justin',
    secretToken('mng'), 1, 'reserved', futureExpiry, 'Planning to order this weekend', nowIso, nowIso, nowIso
  );

  insertClaim.run(
    'clm_arthur_on_leo', 'itm_l2', 'lst_leo_bday', 'usr_arthur',
    secretToken('mng'), 1, 'purchased', futureExpiry, 'Picked up at Target', nowIso, nowIso, nowIso
  );

  // Group Contributions toward Maya's Le Creuset Dutch Oven ($420 target)
  const insertContrib = db.prepare(`
    INSERT INTO contributions (
      id, item_id, list_id, contributor_user_id, pledged_amount, currency, status, show_name_to_givers, note, created_at
    ) VALUES (?, ?, ?, ?, ?, 'USD', 'pledged', 1, ?, ?)
  `);
  insertContrib.run('cnt_1', 'itm_m1', 'lst_maya_bday', 'usr_justin', 170.00, 'Covering the main share!', nowIso);
  insertContrib.run('cnt_2', 'itm_m1', 'lst_maya_bday', 'usr_elena', 100.00, 'Happy Birthday Maya!', nowIso);

  // 10. Seed Secret Ideas (GVR-5: Private gift ideas for someone else — invisible to subject!)
  const insertSecret = db.prepare(`
    INSERT INTO secret_ideas (
      id, subject_user_id, author_id, title, url, estimated_price, note, claimed_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Secret idea ABOUT Maya authored by Aunt Elena (Justin can see it; Maya can NEVER see it!)
  insertSecret.run(
    'sec_maya_1', 'usr_maya', 'usr_elena',
    'Framed Vintage Botanical Print from our Portland Trip',
    'https://www.etsy.com/listing/554433/vintage-pacific-northwest-fern-print',
    85.00,
    'She mentioned loving the fern prints at the market — keep it secret!',
    'usr_elena',
    nowIso
  );
  // Secret idea ABOUT Justin authored by Maya (Justin can NEVER see it!)
  insertSecret.run(
    'sec_justin_1', 'usr_justin', 'usr_maya',
    'Surprise Tickets to Symphony Sci-Fi Film Score Night',
    null,
    140.00,
    'Already checked his calendar for that weekend.',
    'usr_maya',
    nowIso
  );

  // 11. Seed Price History Snapshots (ITM-6)
  const insertSnap = db.prepare(`
    INSERT INTO price_snapshots (id, item_id, price, in_stock, checked_at)
    VALUES (?, ?, ?, 1, ?)
  `);
  insertSnap.run('ps_1', 'itm_m1', 460.00, new Date(now.getTime() - 7 * 86400 * 1000).toISOString());
  insertSnap.run('ps_2', 'itm_m1', 420.00, nowIso); // Price drop of ~9%!
}
