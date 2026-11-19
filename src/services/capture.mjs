/**
 * Section 7 & Section 17: Layered Item Capture, Metadata Extraction, Malicious URL Filter & Amazon Import
 *
 * Extraction Order (first field-level hit wins, each field scored for confidence 0.0 - 1.0):
 * 1. Retailer adapters for the top 30 stores (selectors/patterns maintained as config in `retailer_adapters` table).
 * 2. schema.org `Product` / `Offer` JSON-LD and microdata.
 * 3. Open Graph and product meta tags (`og:title`, `og:image`, `product:price:amount`, `twitter:title`).
 * 4. Heuristics: largest product image, visible price near add-to-cart control, `<title>` / `<h1>`.
 * 5. Manual fallback: user picks/edits; low-confidence fields (< 0.75) are highlighted.
 *
 * Hard Constraint (D3 & Section 7):
 * - Amazon is NEVER fetched server-side. Server fetch requests for amazon.* domains are blocked with a
 *   clear instruction to use the client-side browser extension or paste the browser-extracted payload.
 */

import { uid } from '../db/schema.mjs';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', 'ref', 'ref_',
  'psc', 'spLa', 'pf_rd_r', 'pf_rd_p', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg'
]);

// Section 17 Malicious URL blocklist
const MALICIOUS_DOMAINS = new Set([
  'phishing-gifts.example.com',
  'malware-shop.test',
  'fake-login-retailer.org',
  'crypto-scam-giveaway.net',
  'evil-redirect.invalid'
]);

export function checkUrlSafety(rawUrl) {
  if (!rawUrl) return { safe: true };
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { safe: false, reason: 'Only http and https URLs are permitted' };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (MALICIOUS_DOMAINS.has(host) || host.endsWith('.evil.test') || host.includes('phishing')) {
    return { safe: false, reason: `Domain "${host}" is flagged on the malicious URL blocklist` };
  }

  // ADV-4.2: SSRF protection against localhost, internal domains, IPv6 loopback, and RFC1918 / link-local IPs
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc00:') ||
    host.startsWith('fd00:')
  ) {
    return { safe: false, reason: `SSRF Protection: internal/loopback host "${host}" is not allowed` };
  }

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) {
      return { safe: false, reason: `SSRF Protection: private/reserved IPv4 address "${host}" is not allowed` };
    }
  }

  return { safe: true, hostname: host };
}

/**
 * Resolves and canonicalizes a URL: strips tracking parameters while preserving owner affiliate tags
 * unless configured otherwise (Section 11 hard constraint: do not overwrite affiliate tags a list owner pasted).
 * ADV-4.3: Validates URL safety first and NEVER returns unsafe schemes like javascript: or data:.
 */
export function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  const safety = checkUrlSafety(rawUrl);
  if (!safety.safe) {
    throw new Error(`Unsafe URL blocked: ${safety.reason}`);
  }
  try {
    const u = new URL(String(rawUrl).trim());
    // Amazon ASIN canonicalization
    if (isAmazonDomain(u.hostname)) {
      const asinMatch = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if (asinMatch) {
        const tag = u.searchParams.get('tag');
        return `https://${u.hostname.toLowerCase()}/dp/${asinMatch[1].toUpperCase()}${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`;
      }
    }
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) {
        u.searchParams.delete(key);
      }
    }
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export function isAmazonDomain(hostname = '') {
  const h = hostname.toLowerCase();
  return h === 'amazon.com' || h.endsWith('.amazon.com') ||
         h === 'amazon.co.uk' || h.endsWith('.amazon.co.uk') ||
         h === 'amazon.ca' || h.endsWith('.amazon.ca') ||
         h === 'amazon.de' || h.endsWith('.amazon.de') ||
         h === 'a.co' || h === 'amzn.to';
}

export function stripHtmlAndEscape(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toProxiedImageUrl(rawImageUrl) {
  if (!rawImageUrl) return null;
  if (rawImageUrl.startsWith('/api/image-proxy') || rawImageUrl.startsWith('data:image/')) {
    return rawImageUrl;
  }
  return `/api/image-proxy?url=${encodeURIComponent(rawImageUrl)}`;
}

/**
 * Extracts structured product metadata from HTML + URL using the 4 automated layers in Section 7.
 * Works identically for client-supplied HTML snapshots, extension DOM dumps, or server-fetched pages.
 */
export function extractMetadataFromHtml(db, url, html = '', clientExtracted = null) {
  const startTime = Date.now();
  const safety = checkUrlSafety(url);
  if (!safety.safe) {
    throw new Error(`Unsafe URL blocked: ${safety.reason}`);
  }

  const canonical = canonicalizeUrl(url);
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    hostname = 'unknown';
  }

  const adapter = db ? db.prepare('SELECT * FROM retailer_adapters WHERE domain = ?').get(hostname) : null;

  const result = {
    title: null,
    image: null,
    price: null,
    currency: 'USD',
    store: adapter ? adapter.store_name : formatStoreName(hostname),
    variant: null,
    in_stock: true,
    canonical_url: canonical,
    original_url: url,
    field_confidence: {
      title: 0,
      image: 0,
      price: 0,
      store: adapter ? 0.99 : 0.85,
      variant: 0
    },
    extraction_layers_used: {}
  };

  // Layer 0: If the client browser extension already extracted high-confidence fields from the live DOM
  if (clientExtracted && typeof clientExtracted === 'object') {
    if (clientExtracted.title) {
      result.title = stripHtmlAndEscape(clientExtracted.title);
      result.field_confidence.title = clientExtracted.field_confidence?.title ?? 0.98;
      result.extraction_layers_used.title = 'client_extension';
    }
    if (clientExtracted.image) {
      result.image = clientExtracted.image;
      result.field_confidence.image = clientExtracted.field_confidence?.image ?? 0.98;
      result.extraction_layers_used.image = 'client_extension';
    }
    if (clientExtracted.price !== undefined && clientExtracted.price !== null && !Number.isNaN(Number(clientExtracted.price))) {
      result.price = Number(clientExtracted.price);
      result.field_confidence.price = clientExtracted.field_confidence?.price ?? 0.98;
      result.extraction_layers_used.price = 'client_extension';
    }
    if (clientExtracted.currency) {
      result.currency = stripHtmlAndEscape(clientExtracted.currency).toUpperCase().slice(0, 3);
    }
    if (clientExtracted.variant) {
      result.variant = stripHtmlAndEscape(clientExtracted.variant);
      result.field_confidence.variant = clientExtracted.field_confidence?.variant ?? 0.95;
      result.extraction_layers_used.variant = 'client_extension';
    }
    if (clientExtracted.store) {
      result.store = stripHtmlAndEscape(clientExtracted.store);
      result.field_confidence.store = 0.99;
    }
  }

  // Layer 1: Retailer Adapter (Top 30 stores configured in DB)
  if (html && adapter) {
    const adapterHits = applyRetailerAdapter(html, adapter);
    if (!result.title && adapterHits.title) {
      result.title = adapterHits.title;
      result.field_confidence.title = 0.97;
      result.extraction_layers_used.title = 'retailer_adapter';
    }
    if (result.price === null && adapterHits.price !== null) {
      result.price = adapterHits.price;
      result.field_confidence.price = 0.97;
      result.extraction_layers_used.price = 'retailer_adapter';
    }
    if (!result.image && adapterHits.image) {
      result.image = adapterHits.image;
      result.field_confidence.image = 0.97;
      result.extraction_layers_used.image = 'retailer_adapter';
    }
    if (!result.variant && adapterHits.variant) {
      result.variant = adapterHits.variant;
      result.field_confidence.variant = 0.95;
      result.extraction_layers_used.variant = 'retailer_adapter';
    }
  }

  // Layer 2: schema.org Product / Offer JSON-LD and Microdata
  if (html) {
    const ldHits = extractJsonLdProduct(html);
    if (!result.title && ldHits.title) {
      result.title = ldHits.title;
      result.field_confidence.title = 0.94;
      result.extraction_layers_used.title = 'json_ld';
    }
    if (result.price === null && ldHits.price !== null) {
      result.price = ldHits.price;
      result.field_confidence.price = 0.94;
      result.extraction_layers_used.price = 'json_ld';
    }
    if (ldHits.currency) {
      result.currency = ldHits.currency;
    }
    if (!result.image && ldHits.image) {
      result.image = ldHits.image;
      result.field_confidence.image = 0.94;
      result.extraction_layers_used.image = 'json_ld';
    }
    if (!result.variant && ldHits.variant) {
      result.variant = ldHits.variant;
      result.field_confidence.variant = 0.90;
      result.extraction_layers_used.variant = 'json_ld';
    }
    if (ldHits.in_stock !== undefined) {
      result.in_stock = ldHits.in_stock;
    }
  }

  // Layer 3: Open Graph and Product Meta Tags
  if (html) {
    const ogHits = extractOpenGraph(html);
    if (!result.title && ogHits.title) {
      result.title = ogHits.title;
      result.field_confidence.title = 0.86;
      result.extraction_layers_used.title = 'open_graph';
    }
    if (result.price === null && ogHits.price !== null) {
      result.price = ogHits.price;
      result.field_confidence.price = 0.86;
      result.extraction_layers_used.price = 'open_graph';
    }
    if (ogHits.currency && result.currency === 'USD') {
      result.currency = ogHits.currency;
    }
    if (!result.image && ogHits.image) {
      result.image = ogHits.image;
      result.field_confidence.image = 0.86;
      result.extraction_layers_used.image = 'open_graph';
    }
    if (!result.variant && ogHits.variant) {
      result.variant = ogHits.variant;
      result.field_confidence.variant = 0.82;
      result.extraction_layers_used.variant = 'open_graph';
    }
  }

  // Layer 4: Heuristics (<h1> / <title>, visible $ price, largest/first product <img>, URL slug fallback)
  if (html) {
    const heurHits = extractHeuristics(html);
    if (!result.title && heurHits.title) {
      result.title = heurHits.title;
      result.field_confidence.title = 0.68;
      result.extraction_layers_used.title = 'heuristics';
    }
    if (result.price === null && heurHits.price !== null) {
      result.price = heurHits.price;
      result.field_confidence.price = 0.65;
      result.extraction_layers_used.price = 'heuristics';
    }
    if (!result.image && heurHits.image) {
      result.image = heurHits.image;
      result.field_confidence.image = 0.65;
      result.extraction_layers_used.image = 'heuristics';
    }
    if (!result.variant && heurHits.variant) {
      result.variant = heurHits.variant;
      result.field_confidence.variant = 0.60;
      result.extraction_layers_used.variant = 'heuristics';
    }
  }

  // URL Slug Smart Fallback if no HTML was provided or site blocked fetch
  if (!result.title && canonical) {
    const slugTitle = inferTitleFromUrl(canonical);
    if (slugTitle) {
      result.title = slugTitle;
      result.field_confidence.title = 0.55;
      result.extraction_layers_used.title = 'url_slug_fallback';
    }
  }

  const isComplete = Boolean(result.title && result.image && result.price !== null);
  if (db && adapter) {
    db.prepare(`
      UPDATE retailer_adapters
      SET capture_attempts = capture_attempts + 1,
          capture_successes = capture_successes + ?,
          updated_at = ?
      WHERE domain = ?
    `).run(isComplete ? 1 : 0, new Date().toISOString(), hostname);
  }

  // Record first-party analytics (Section 18: no item titles or URLs in event payloads!)
  if (db) {
    const latencyMs = Date.now() - startTime;
    db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
      uid('evt'),
      'capture_completed',
      JSON.stringify({
        store_domain: hostname,
        fields_auto_filled: [result.title ? 'title' : null, result.image ? 'image' : null, result.price !== null ? 'price' : null, result.variant ? 'variant' : null].filter(Boolean),
        field_confidence: result.field_confidence,
        complete: isComplete,
        latency_ms: latencyMs
      }),
      new Date().toISOString()
    );
  }

  // Ensure image goes through proxy
  if (result.image) {
    result.proxied_image = toProxiedImageUrl(result.image);
  }

  return result;
}

function applyRetailerAdapter(html, adapter) {
  const hits = { title: null, price: null, image: null, variant: null };

  // Support data-adapter attributes or id/class matching in HTML
  if (adapter.title_selector) {
    hits.title = matchSelectorContent(html, adapter.title_selector);
  }
  if (adapter.price_selector) {
    const rawPrice = matchSelectorContent(html, adapter.price_selector);
    hits.price = parsePriceNumber(rawPrice);
  }
  if (adapter.image_selector) {
    hits.image = matchSelectorImage(html, adapter.image_selector);
  }
  if (adapter.variant_selector) {
    hits.variant = matchSelectorContent(html, adapter.variant_selector);
  }
  return hits;
}

function matchSelectorContent(html, selector) {
  for (const part of selector.split(',').map(s => s.trim())) {
    const tokens = part.split(/\s+/);
    const leaf = tokens[tokens.length - 1];
    if (leaf.startsWith('#')) {
      const id = escapeRegex(leaf.slice(1));
      const re = new RegExp(`<[^>]+id=["']${id}["'][^>]*>([^<]+)<\\/`, 'i');
      const m = html.match(re);
      if (m && stripHtmlAndEscape(m[1])) return stripHtmlAndEscape(m[1]);
    } else if (leaf.startsWith('.') || leaf.includes('.')) {
      const cls = escapeRegex(leaf.split('.').pop());
      const re = new RegExp(`<[^>]+class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([^<]+)<\\/`, 'i');
      const m = html.match(re);
      if (m && stripHtmlAndEscape(m[1])) return stripHtmlAndEscape(m[1]);
    } else if (leaf.startsWith('[') && leaf.endsWith(']')) {
      const attr = escapeRegex(leaf.slice(1, -1));
      const re = new RegExp(`<[^>]+${attr}[^>]*>([^<]+)<\\/`, 'i');
      const m = html.match(re);
      if (m && stripHtmlAndEscape(m[1])) return stripHtmlAndEscape(m[1]);
    }
  }
  return null;
}

function matchSelectorImage(html, selector) {
  for (const part of selector.split(',').map(s => s.trim())) {
    if (part.startsWith('#')) {
      const id = escapeRegex(part.slice(1));
      const re = new RegExp(`<img[^>]+id=["']${id}["'][^>]+src=["']([^"']+)["']`, 'i');
      const m = html.match(re) || html.match(new RegExp(`<img[^>]+src=["']([^"']+)["'][^>]+id=["']${id}["']`, 'i'));
      if (m) return m[1];
    } else if (part.startsWith('.')) {
      const cls = escapeRegex(part.slice(1));
      const re = new RegExp(`<img[^>]+class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]+src=["']([^"']+)["']`, 'i');
      const m = html.match(re) || html.match(new RegExp(`<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*\\b${cls}\\b[^"']*["']`, 'i'));
      if (m) return m[1];
    }
  }
  return null;
}

function extractJsonLdProduct(html) {
  const hits = { title: null, price: null, currency: null, image: null, variant: null, in_stock: undefined };
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
      for (const node of candidates) {
        if (!node || typeof node !== 'object') continue;
        const type = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type'] || '');
        if (/Product/i.test(type)) {
          if (!hits.title && node.name) hits.title = stripHtmlAndEscape(node.name);
          if (!hits.image && node.image) {
            const img = Array.isArray(node.image) ? node.image[0] : node.image;
            hits.image = typeof img === 'object' ? img.url || img.contentUrl : String(img);
          }
          if (!hits.variant && (node.color || node.size)) {
            hits.variant = [node.color, node.size].filter(Boolean).map(stripHtmlAndEscape).join(' / ');
          }
          const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
          if (offers && typeof offers === 'object') {
            const p = offers.price ?? offers.lowPrice ?? offers.highPrice;
            if (hits.price === null && p !== undefined) hits.price = parsePriceNumber(String(p));
            if (offers.priceCurrency) hits.currency = String(offers.priceCurrency).toUpperCase();
            if (offers.availability) {
              hits.in_stock = !/OutOfStock|SoldOut|Discontinued/i.test(String(offers.availability));
            }
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  }
  return hits;
}

function extractOpenGraph(html) {
  const hits = { title: null, price: null, currency: null, image: null, variant: null };
  const getMeta = (names) => {
    for (const name of names) {
      const esc = escapeRegex(name);
      const re1 = new RegExp(`<meta[^>]+(?:property|name)=(["'])${esc}\\1[^>]+content=(["'])([\\s\\S]*?)\\2`, 'i');
      const re2 = new RegExp(`<meta[^>]+content=(["'])([\\s\\S]*?)\\1[^>]+(?:property|name)=(["'])${esc}\\3`, 'i');
      const m1 = html.match(re1);
      if (m1 && m1[3]) return stripHtmlAndEscape(m1[3]);
      const m2 = html.match(re2);
      if (m2 && m2[2]) return stripHtmlAndEscape(m2[2]);
    }
    return null;
  };

  hits.title = getMeta(['og:title', 'twitter:title', 'product:title']);
  hits.image = getMeta(['og:image', 'og:image:secure_url', 'twitter:image']);
  const rawPrice = getMeta(['product:price:amount', 'og:price:amount', 'twitter:data1']);
  if (rawPrice) hits.price = parsePriceNumber(rawPrice);
  const rawCurr = getMeta(['product:price:currency', 'og:price:currency']);
  if (rawCurr) hits.currency = rawCurr.toUpperCase();
  hits.variant = getMeta(['product:color', 'product:size']);
  return hits;
}

function extractHeuristics(html) {
  const hits = { title: null, price: null, image: null, variant: null };
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) hits.title = stripHtmlAndEscape(h1Match[1]);
  if (!hits.title) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) hits.title = stripHtmlAndEscape(titleMatch[1].split(/\s+[|\-–—]\s+/)[0]);
  }

  const priceMatch = html.match(/\$\s?([0-9]{1,5}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
  if (priceMatch) {
    hits.price = parsePriceNumber(priceMatch[1]);
  }

  const imgMatch = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);
  if (imgMatch) {
    hits.image = imgMatch[1];
  }

  const variantMatch = html.match(/(?:Size|Color|Variant)\s*:\s*<[^>]+>([^<]{1,40})<\//i);
  if (variantMatch) {
    hits.variant = stripHtmlAndEscape(variantMatch[1]);
  }
  return hits;
}

export function parsePriceNumber(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const val = Number.parseFloat(cleaned);
  return Number.isFinite(val) ? Math.round(val * 100) / 100 : null;
}

function formatStoreName(hostname) {
  if (!hostname || hostname === 'unknown') return 'Custom Store';
  const parts = hostname.replace(/^www\./, '').split('.');
  const base = parts[0] || hostname;
  const special = {
    amazon: 'Amazon',
    target: 'Target',
    etsy: 'Etsy',
    walmart: 'Walmart',
    bestbuy: 'Best Buy',
    rei: 'REI',
    nike: 'Nike',
    apple: 'Apple',
    lego: 'LEGO',
    sephora: 'Sephora',
    nordstrom: 'Nordstrom',
    crateandbarrel: 'Crate & Barrel',
    'williams-sonoma': 'Williams Sonoma',
    bookshop: 'Bookshop.org',
    patagonia: 'Patagonia',
    uniqlo: 'Uniqlo',
    ikea: 'IKEA',
    wayfair: 'Wayfair',
    anthropologie: 'Anthropologie',
    lululemon: 'lululemon',
    chewy: 'Chewy',
    homedepot: 'Home Depot',
    lowes: "Lowe's",
    macys: "Macy's",
    kohls: "Kohl's",
    bhphotovideo: 'B&H Photo',
    adidas: 'Adidas',
    zappos: 'Zappos',
    potterybarn: 'Pottery Barn',
     Barnesandnoble: 'Barnes & Noble'
  };
  return special[base.toLowerCase()] || (base.charAt(0).toUpperCase() + base.slice(1));
}

function inferTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const candidate = segments.find(s => s.length > 6 && s.includes('-')) || segments[segments.length - 1];
    if (!candidate) return null;
    return candidate
      .replace(/\.(html|htm|php|aspx)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  } catch {
    return null;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Server-side URL capture entry point (Section 7 & Decision D3).
 * HARD RULE D3: Amazon is NEVER fetched server-side.
 */
export async function captureFromUrl(db, { url, htmlSnapshot = null, clientExtracted = null, pathType = 'paste' }) {
  const safety = checkUrlSafety(url);
  if (!safety.safe) {
    throw new Error(`Security Block: ${safety.reason}`);
  }

  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');

  if (db) {
    db.prepare('INSERT INTO analytics_events (id, event_name, properties, created_at) VALUES (?, ?, ?, ?)').run(
      uid('evt'),
      'capture_attempted',
      JSON.stringify({ path: pathType, store_domain: hostname }),
      new Date().toISOString()
    );
  }

  // Enforce Decision D3: Never fetch Amazon server-side
  if (isAmazonDomain(hostname) && pathType !== 'extension' && !clientExtracted && !htmlSnapshot) {
    return {
      blocked_amazon_server_fetch: true,
      canonical_url: canonicalizeUrl(url),
      original_url: url,
      store: 'Amazon',
      title: inferTitleFromUrl(url) || 'Amazon Item (Captured via URL - confirm details or use Hushlist Browser Extension)',
      image: null,
      price: null,
      currency: 'USD',
      variant: null,
      field_confidence: { title: 0.4, image: 0, price: 0, store: 1.0, variant: 0 },
      notice: 'Per Amazon Conditions of Use (Decision D3), Hushlist never fetches Amazon pages server-side. Use the Hushlist Browser Extension on the Amazon product tab for 1-click full extraction, or confirm the fields below.'
    };
  }

  return extractMetadataFromHtml(db, url, htmlSnapshot || '', clientExtracted);
}

/**
 * IMP-1: Import a public Amazon list (or exported HTML/JSON payload) with re-sync support.
 * Returns a detailed report of imported, skipped (duplicates), and failed items.
 */
export function importAmazonList(db, { listId, ownerId, amazonListUrl, itemsPayload = [] }) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ? AND owner_id = ?').get(listId, ownerId);
  if (!list) {
    throw new Error('Target list not found or unauthorized');
  }

  const existingItems = db.prepare("SELECT canonical_url, LOWER(title) as ltitle FROM items WHERE list_id = ? AND status = 'active'").all(listId);
  const existingUrls = new Set(existingItems.map(i => i.canonical_url).filter(Boolean));
  const existingTitles = new Set(existingItems.map(i => i.ltitle).filter(Boolean));

  const report = {
    source_url: amazonListUrl || 'extension_import',
    imported: [],
    skipped: [],
    failed: []
  };

  const now = new Date().toISOString();

  for (const raw of itemsPayload) {
    try {
      if (!raw || (!raw.title && !raw.url)) {
        report.failed.push({ raw, reason: 'Missing title and URL' });
        continue;
      }
      const canonical = raw.url ? canonicalizeUrl(raw.url) : null;
      const cleanTitle = stripHtmlAndEscape(raw.title || inferTitleFromUrl(raw.url || ''));
      if (!cleanTitle) {
        report.failed.push({ raw, reason: 'Could not extract product title' });
        continue;
      }
      if ((canonical && existingUrls.has(canonical)) || existingTitles.has(cleanTitle.toLowerCase())) {
        report.skipped.push({ title: cleanTitle, url: canonical, reason: 'Already on list (duplicate skipped on re-sync)' });
        continue;
      }

      const itemId = uid('itm');
      const price = parsePriceNumber(raw.price);
      const confidence = {
        title: 0.95,
        image: raw.image ? 0.95 : 0,
        price: price !== null ? 0.95 : 0,
        store: 1.0,
        variant: raw.variant ? 0.9 : 0
      };

      db.prepare(`
        INSERT INTO items (
          id, list_id, kind, title, canonical_url, original_url, store, image, price, currency,
          variant, qty_wanted, priority, notes, field_confidence, created_at, updated_at
        ) VALUES (?, ?, 'product', ?, ?, ?, 'Amazon', ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        itemId,
        listId,
        cleanTitle,
        canonical,
        raw.url || canonical,
        raw.image ? toProxiedImageUrl(raw.image) : null,
        price,
        raw.variant ? stripHtmlAndEscape(raw.variant) : null,
        Number(raw.qty_wanted) > 0 ? Number(raw.qty_wanted) : 1,
        raw.priority || 'normal',
        raw.notes ? stripHtmlAndEscape(raw.notes) : 'Imported from Amazon List',
        JSON.stringify(confidence),
        now,
        now
      );

      if (canonical) existingUrls.add(canonical);
      existingTitles.add(cleanTitle.toLowerCase());
      report.imported.push({ id: itemId, title: cleanTitle, price, url: canonical });
    } catch (err) {
      report.failed.push({ raw, reason: err.message });
    }
  }

  return report;
}

/**
 * ITM-6, NTF-1 & Section 7 / 16: Automated Price-Drop (>= 10%) and Back-in-Stock Re-Check Engine.
 * - Excludes Amazon items from server re-checks (Decision D3).
 * - Stores full price history in `price_snapshots`.
 * - Fires immediate notifications to active claimers on a price drop >= 10% or out-of-stock transition.
 * - Records non-spoiler events for follower digests (NTF-1).
 */
export function recheckItemPriceAndStock(db, { itemId, newPrice, newInStock = true, sendNotificationFn = null }) {
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'active'").get(itemId);
  if (!item) throw new Error('Active item not found');

  if (item.canonical_url) {
    try {
      const host = new URL(item.canonical_url).hostname.toLowerCase();
      if (isAmazonDomain(host)) {
        throw new Error('Decision D3 Policy: Amazon items are excluded from server-side price re-checks');
      }
    } catch (err) {
      if (err.message.includes('Decision D3')) throw err;
    }
  }

  const nowIso = new Date().toISOString();
  const parsedPrice = newPrice !== undefined && newPrice !== null ? parsePriceNumber(newPrice) : item.price;
  const inStockFlag = newInStock ? 1 : 0;

  const oldPrice = item.price;
  const oldInStock = item.in_stock;

  db.prepare('INSERT INTO price_snapshots (id, item_id, price, in_stock, checked_at) VALUES (?, ?, ?, ?, ?)').run(
    uid('ps'), item.id, parsedPrice, inStockFlag, nowIso
  );

  db.prepare('UPDATE items SET price = ?, in_stock = ?, updated_at = ? WHERE id = ?').run(
    parsedPrice, inStockFlag, nowIso, item.id
  );

  const dropPct = (oldPrice && parsedPrice && parsedPrice < oldPrice)
    ? Math.round(((oldPrice - parsedPrice) / oldPrice) * 1000) / 10
    : 0;
  const isSignificantDrop = dropPct >= 10;
  const backInStock = oldInStock === 0 && inStockFlag === 1;
  const wentOutOfStock = oldInStock === 1 && inStockFlag === 0;

  const activeClaims = db.prepare(`
    SELECT * FROM claims
    WHERE item_id = ? AND status IN ('reserved', 'purchased') AND verified = 1
  `).all(item.id);

  let claimersNotified = 0;
  if (sendNotificationFn && (isSignificantDrop || wentOutOfStock)) {
    for (const c of activeClaims) {
      if (isSignificantDrop) {
        sendNotificationFn(db, {
          recipientUserId: c.claimer_user_id,
          recipientEmail: c.guest_email,
          eventType: 'claimed_item_price_drop',
          listId: item.list_id,
          subject: `Price drop (${dropPct}% off) on "${item.title}"!`,
          body: `Good news! An item you claimed ("${item.title}") dropped from $${Number(oldPrice).toFixed(2)} to $${Number(parsedPrice).toFixed(2)} (-${dropPct}%).`
        });
        claimersNotified++;
      }
      if (wentOutOfStock) {
        sendNotificationFn(db, {
          recipientUserId: c.claimer_user_id,
          recipientEmail: c.guest_email,
          eventType: 'claimed_item_out_of_stock',
          listId: item.list_id,
          subject: `Out-of-stock alert for "${item.title}"`,
          body: `"${item.title}" appears to be out of stock at ${item.store || 'the retailer'}. Your reservation is kept until expiry.`
        });
        claimersNotified++;
      }
    }
  }

  if (isSignificantDrop || backInStock) {
    db.prepare(`
      INSERT INTO events (id, actor_id, entity_type, entity_id, list_id, action, details, is_spoiler, at)
      VALUES (?, NULL, 'item', ?, ?, ?, ?, 0, ?)
    `).run(
      uid('ev'),
      item.id,
      item.list_id,
      isSignificantDrop ? 'price_drop' : 'back_in_stock',
      JSON.stringify({
        title: item.title,
        old_price: oldPrice,
        new_price: parsedPrice,
        drop_percent: dropPct,
        in_stock: Boolean(inStockFlag)
      }),
      nowIso
    );
  }

  return {
    item_id: item.id,
    old_price: oldPrice,
    new_price: parsedPrice,
    drop_percent: dropPct,
    significant_drop_alert: isSignificantDrop,
    back_in_stock_alert: backInStock,
    out_of_stock_alert: wentOutOfStock,
    claimers_notified: claimersNotified
  };
}
