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

import net from 'node:net';
import { uid, inTransaction } from '../db/schema.mjs';
import { AppError, badRequest, forbidden, notFound } from '../errors.mjs';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga'
]);

// Only meaningful on Amazon. Elsewhere "ref" can be a real page parameter.
const AMAZON_TRACKING_PARAMS = new Set([
  'ref', 'ref_', 'psc', 'spLa', 'pf_rd_r', 'pf_rd_p', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg'
]);

// Placeholder denylist. These are reserved example names; a real deployment
// should replace this with a maintained feed (HUSHLIST_BLOCKED_DOMAINS adds more).
const BLOCKED_DOMAINS = new Set([
  'phishing-gifts.example.com',
  'malware-shop.test',
  'fake-login-retailer.org',
  'crypto-scam-giveaway.net',
  'evil-redirect.invalid',
  ...String(process.env.HUSHLIST_BLOCKED_DOMAINS || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
]);

// Addresses that must never be stored as a link or (if server-side fetching is
// ever added) requested: loopback, private, link-local, CGNAT, multicast,
// documentation and other reserved ranges. BlockList also matches the
// IPv4-mapped IPv6 form (::ffff:a.b.c.d) against the IPv4 rules.
const RESERVED_ADDRESSES = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
]) RESERVED_ADDRESSES.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]
]) RESERVED_ADDRESSES.addSubnet(addr, prefix, 'ipv6');

export function checkUrlSafety(rawUrl) {
  if (!rawUrl) return { safe: true };
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    return { safe: false, reason: 'Invalid URL format' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { safe: false, reason: 'Only http and https URLs are permitted' };
  }
  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'URLs that embed a username or password are not permitted' };
  }
  // WHATWG URL parsing has already normalised decimal / hex / octal IPv4
  // spellings to dotted form and lower-cased the host.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if ([...BLOCKED_DOMAINS].some(d => host === d || host.endsWith(`.${d}`))) {
    return { safe: false, reason: `Domain "${host}" is on the blocked list` };
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.') && net.isIP(host) === 0
  ) {
    return { safe: false, reason: `Internal host "${host}" is not allowed` };
  }

  const family = net.isIP(host);
  if (family !== 0 && RESERVED_ADDRESSES.check(host, family === 6 ? 'ipv6' : 'ipv4')) {
    return { safe: false, reason: `Private or reserved address "${host}" is not allowed` };
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
    throw badRequest(`Unsafe URL blocked: ${safety.reason}`);
  }
  try {
    const u = new URL(String(rawUrl).trim());
    u.hostname = u.hostname.replace(/\.$/, '');
    const onAmazon = isAmazonDomain(u.hostname);
    // Amazon ASIN canonicalization
    if (onAmazon) {
      const asinMatch = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if (asinMatch) {
        const tag = u.searchParams.get('tag');
        return `https://${u.hostname.toLowerCase()}/dp/${asinMatch[1].toUpperCase()}${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`;
      }
    }
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key) || key.startsWith('utm_') || (onAmazon && AMAZON_TRACKING_PARAMS.has(key))) {
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
  const h = String(hostname).toLowerCase().replace(/^www\./, '');
  // amazon.com, amazon.co.uk, amazon.com.au, smile.amazon.de, … plus the short-link hosts.
  return /(^|\.)amazon\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(h) ||
         ['a.co', 'amzn.to', 'amzn.eu', 'amzn.asia', 'amzn.com'].includes(h);
}

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

/**
 * Reduces untrusted input to plain single-line text: entities decoded, markup
 * removed, control characters dropped, whitespace collapsed, length capped.
 *
 * The result is plain text, NOT HTML-safe text. Every place that puts it into
 * a page must still escape it for that context (the front end does this
 * automatically through its html`` template).
 */
export function cleanText(val, maxLength = 500) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'string' && typeof val !== 'number') return '';
  // Bound the work before doing any of it.
  let text = String(val).slice(0, Math.min(20000, maxLength * 8 + 512));
  // Decode first and repeat until stable, so "&lt;b&gt;" or "<scr<script>ipt>"
  // cannot survive as markup after one pass.
  for (let i = 0; i < 4; i++) {
    const before = text;
    text = stripTags(text
      .replace(/&#(\d{1,7});/g, (_, n) => safeCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
      .replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()]));
    if (text === before) break;
  }
  return text
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

/**
 * Removes tags, comments and whole <script>/<style> blocks in a single
 * left-to-right scan. Deliberately not a regex: the obvious patterns
 * (/<[^>]+>/, /<script[\s\S]*?<\/script>/) take quadratic time on input such
 * as a long run of "<", which is enough to stall the server.
 */
export function stripTags(text) {
  let out = '';
  let pos = 0;
  let moreClosers = true;
  const lower = text.toLowerCase();
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) break;
    out += text.slice(pos, lt);
    const next = text.charCodeAt(lt + 1);
    const isTagStart = (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 47 /* / */ || next === 33 /* ! */;
    if (!isTagStart || !moreClosers) {
      out += '<';
      pos = lt + 1;
      continue;
    }
    let end;
    if (lower.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      end = close === -1 ? -1 : close + 3;
    } else if (lower.startsWith('<script', lt) || lower.startsWith('<style', lt)) {
      const name = lower.startsWith('<script', lt) ? '</script' : '</style';
      const close = lower.indexOf(name, lt);
      const gt = close === -1 ? -1 : text.indexOf('>', close);
      end = gt === -1 ? -1 : gt + 1;
      if (end === -1) {
        // Unterminated block: drop just the opening tag if it closes.
        const openEnd = text.indexOf('>', lt);
        end = openEnd === -1 ? -1 : openEnd + 1;
      }
    } else {
      const gt = text.indexOf('>', lt);
      end = gt === -1 ? -1 : gt + 1;
    }
    if (end === -1) {
      // No closing ">" anywhere ahead: nothing further can be a tag.
      moreClosers = false;
      out += '<';
      pos = lt + 1;
      continue;
    }
    out += ' ';
    pos = end;
  }
  return out + text.slice(pos);
}

function safeCodePoint(n) {
  if (!Number.isInteger(n) || n < 0x20 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return ' ';
  return String.fromCodePoint(n);
}

/** Multi-line variant for notes: keeps line breaks, otherwise the same rules. */
export function cleanMultilineText(val, maxLength = 2000) {
  if (val === null || val === undefined) return '';
  return String(val).slice(0, 20000).split(/\r?\n/).map(line => cleanText(line, maxLength)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLength);
}

/** Finite, non-negative money amount rounded to cents, else null. */
export function cleanPrice(val, max = 10_000_000) {
  if (val === null || val === undefined || val === '') return null;
  const n = typeof val === 'number' ? val : Number(String(val).trim());
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 100) / 100;
}

export function cleanInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Real calendar date in YYYY-MM-DD form, else null. */
export function cleanDate(val) {
  if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return null;
  const d = new Date(`${val}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== val) return null;
  const year = d.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? val : null;
}

/**
 * Remote images are never requested by the server and are not shown by the
 * app (the content security policy allows same-origin images only). The source
 * URL is kept, wrapped in the local placeholder path, so a real image proxy
 * can be added later without a data migration.
 */
export function toProxiedImageUrl(rawImageUrl) {
  if (!rawImageUrl || typeof rawImageUrl !== 'string') return null;
  if (rawImageUrl.startsWith('/api/image-proxy')) return rawImageUrl.slice(0, 2048);
  if (!checkUrlSafety(rawImageUrl).safe) return null;
  return `/api/image-proxy?url=${encodeURIComponent(rawImageUrl.trim())}`;
}

/**
 * Extracts structured product metadata from HTML + URL using the 4 automated layers in Section 7.
 * Works identically for client-supplied HTML snapshots, extension DOM dumps, or server-fetched pages.
 */
export function extractMetadataFromHtml(db, url, html = '', clientExtracted = null) {
  const startTime = Date.now();
  html = typeof html === 'string' ? html.slice(0, 512_000) : '';
  const lowerHtml = html.toLowerCase();
  const tags = html ? tokenizeTags(html) : [];
  const safety = checkUrlSafety(url);
  if (!safety.safe) {
    throw badRequest(`Unsafe URL blocked: ${safety.reason}`);
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
      result.title = cleanText(clientExtracted.title);
      result.field_confidence.title = confidence(clientExtracted.field_confidence?.title, 0.98);
      result.extraction_layers_used.title = 'client_extension';
    }
    if (typeof clientExtracted.image === 'string' && checkUrlSafety(clientExtracted.image).safe) {
      result.image = clientExtracted.image;
      result.field_confidence.image = confidence(clientExtracted.field_confidence?.image, 0.98);
      result.extraction_layers_used.image = 'client_extension';
    }
    if (cleanPrice(clientExtracted.price) !== null) {
      result.price = cleanPrice(clientExtracted.price);
      result.field_confidence.price = confidence(clientExtracted.field_confidence?.price, 0.98);
      result.extraction_layers_used.price = 'client_extension';
    }
    if (clientExtracted.currency) {
      result.currency = cleanText(clientExtracted.currency).toUpperCase().slice(0, 3);
    }
    if (clientExtracted.variant) {
      result.variant = cleanText(clientExtracted.variant);
      result.field_confidence.variant = confidence(clientExtracted.field_confidence?.variant, 0.95);
      result.extraction_layers_used.variant = 'client_extension';
    }
    if (clientExtracted.store) {
      result.store = cleanText(clientExtracted.store);
      result.field_confidence.store = 0.99;
    }
  }

  // Layer 1: Retailer Adapter (Top 30 stores configured in DB)
  if (html && adapter) {
    const adapterHits = applyRetailerAdapter(html, tags, adapter);
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
    const ldHits = extractJsonLdProduct(html, lowerHtml, tags);
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
    const ogHits = extractOpenGraph(tags);
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
    const heurHits = extractHeuristics(html, lowerHtml, tags);
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

function confidence(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Keeps only known fields with numeric 0..1 scores. */
export function cleanFieldConfidence(input) {
  const out = {};
  for (const key of ['title', 'image', 'price', 'store', 'variant']) {
    out[key] = confidence(input?.[key], 1);
  }
  return out;
}

/**
 * Everything below reads untrusted HTML. Two rules keep it linear-time:
 * the page is tokenised once into tags with a bounded pattern, and block
 * contents are located with indexOf rather than lazy [\s\S]*? spans.
 */
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b([^<>]{0,4000})>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const MAX_TAGS = 20000;

function parseAttributes(raw) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = ATTR_RE.exec(raw)) !== null && guard++ < 64) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/** One pass over the document: [{ name, attrs, end }] where end is the index after ">". */
function tokenizeTags(html) {
  const tags = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html)) !== null && tags.length < MAX_TAGS) {
    tags.push({ name: m[1].toLowerCase(), attrs: parseAttributes(m[2]), end: TAG_RE.lastIndex });
  }
  return tags;
}

/** Text between a tag and the next "<", capped. */
function textAfter(html, tag) {
  const stop = html.indexOf('<', tag.end);
  const raw = html.slice(tag.end, stop === -1 ? Math.min(html.length, tag.end + 500) : Math.min(stop, tag.end + 500));
  return cleanText(raw, 300);
}

/** Inner content of the first <name>…</name> at or after the given tag, capped. */
function blockContent(html, lowerHtml, tag, maxLength = 200000) {
  const close = lowerHtml.indexOf(`</${tag.name}`, tag.end);
  if (close === -1) return null;
  return html.slice(tag.end, Math.min(close, tag.end + maxLength));
}

function selectorLeafMatcher(selectorPart) {
  const tokens = selectorPart.trim().split(/\s+/);
  const leaf = tokens[tokens.length - 1] || '';
  if (leaf.startsWith('[') && leaf.endsWith(']')) {
    const inner = leaf.slice(1, -1);
    const eq = inner.indexOf('=');
    const name = (eq === -1 ? inner : inner.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? null : inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    return (tag) => name in tag.attrs && (value === null || tag.attrs[name] === value);
  }
  const idAt = leaf.indexOf('#');
  if (idAt !== -1) {
    const id = leaf.slice(idAt + 1).split('.')[0];
    return (tag) => tag.attrs.id === id;
  }
  if (leaf.includes('.')) {
    const cls = leaf.split('.').filter(Boolean).pop();
    return (tag) => typeof tag.attrs.class === 'string' && tag.attrs.class.split(/\s+/).includes(cls);
  }
  return () => false;
}

function matchSelectorContent(html, tags, selector) {
  for (const part of String(selector).split(',')) {
    const matches = selectorLeafMatcher(part);
    for (const tag of tags) {
      if (!matches(tag)) continue;
      const text = textAfter(html, tag);
      if (text) return text;
    }
  }
  return null;
}

function matchSelectorImage(tags, selector) {
  for (const part of String(selector).split(',')) {
    const matches = selectorLeafMatcher(part);
    for (const tag of tags) {
      if (tag.name === 'img' && matches(tag) && tag.attrs.src) return tag.attrs.src;
    }
  }
  return null;
}

function applyRetailerAdapter(html, tags, adapter) {
  const hits = { title: null, price: null, image: null, variant: null };
  if (adapter.title_selector) hits.title = matchSelectorContent(html, tags, adapter.title_selector);
  if (adapter.price_selector) hits.price = parsePriceNumber(matchSelectorContent(html, tags, adapter.price_selector));
  if (adapter.image_selector) hits.image = matchSelectorImage(tags, adapter.image_selector);
  if (adapter.variant_selector) hits.variant = matchSelectorContent(html, tags, adapter.variant_selector);
  return hits;
}

function extractJsonLdProduct(html, lowerHtml, tags) {
  const hits = { title: null, price: null, currency: null, image: null, variant: null, in_stock: undefined };
  let blocks = 0;
  for (const tag of tags) {
    if (tag.name !== 'script' || String(tag.attrs.type || '').toLowerCase() !== 'application/ld+json') continue;
    if (++blocks > 20) break;
    const content = blockContent(html, lowerHtml, tag);
    if (!content) continue;
    try {
      const parsed = JSON.parse(content.trim());
      const candidates = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed]);
      for (const node of candidates.slice(0, 50)) {
        if (!node || typeof node !== 'object') continue;
        const type = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type'] || '');
        if (!/Product/i.test(type)) continue;
        if (!hits.title && node.name) hits.title = cleanText(node.name, 300);
        if (!hits.image && node.image) {
          const img = Array.isArray(node.image) ? node.image[0] : node.image;
          const url = img && typeof img === 'object' ? (img.url || img.contentUrl) : img;
          if (typeof url === 'string') hits.image = url;
        }
        if (!hits.variant && (node.color || node.size)) {
          hits.variant = [node.color, node.size].filter(Boolean).map(v => cleanText(v, 100)).join(' / ');
        }
        const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        if (offers && typeof offers === 'object') {
          const p = offers.price ?? offers.lowPrice ?? offers.highPrice;
          if (hits.price === null && p !== undefined) hits.price = parsePriceNumber(typeof p === 'number' ? p : String(p));
          if (typeof offers.priceCurrency === 'string' && /^[A-Za-z]{3}$/.test(offers.priceCurrency)) {
            hits.currency = offers.priceCurrency.toUpperCase();
          }
          if (offers.availability) {
            hits.in_stock = !/OutOfStock|SoldOut|Discontinued/i.test(String(offers.availability));
          }
        }
      }
    } catch {
      // Malformed JSON-LD is common; ignore the block.
    }
  }
  return hits;
}

function extractOpenGraph(tags) {
  const meta = new Map();
  for (const tag of tags) {
    if (tag.name !== 'meta') continue;
    const key = String(tag.attrs.property || tag.attrs.name || '').toLowerCase();
    if (key && tag.attrs.content !== undefined && !meta.has(key)) meta.set(key, tag.attrs.content);
  }
  const first = (names, max = 300) => {
    for (const name of names) {
      const value = cleanText(meta.get(name), max);
      if (value) return value;
    }
    return null;
  };

  const hits = { title: null, price: null, currency: null, image: null, variant: null };
  hits.title = first(['og:title', 'twitter:title', 'product:title']);
  hits.image = first(['og:image', 'og:image:secure_url', 'twitter:image'], 2048);
  const rawPrice = first(['product:price:amount', 'og:price:amount', 'twitter:data1']);
  if (rawPrice) hits.price = parsePriceNumber(rawPrice);
  const rawCurr = first(['product:price:currency', 'og:price:currency']);
  if (rawCurr && /^[A-Za-z]{3}$/.test(rawCurr)) hits.currency = rawCurr.toUpperCase();
  hits.variant = first(['product:color', 'product:size']);
  return hits;
}

function extractHeuristics(html, lowerHtml, tags) {
  const hits = { title: null, price: null, image: null, variant: null };

  const h1 = tags.find(t => t.name === 'h1');
  if (h1) hits.title = cleanText(blockContent(html, lowerHtml, h1, 2000), 300) || null;
  if (!hits.title) {
    const titleTag = tags.find(t => t.name === 'title');
    const raw = titleTag ? blockContent(html, lowerHtml, titleTag, 2000) : null;
    if (raw) hits.title = cleanText(raw.split(/\s+[|\-–—]\s+/)[0], 300) || null;
  }

  const priceMatch = html.match(/\$\s?([0-9]{1,5}(?:,[0-9]{3}){0,3}(?:\.[0-9]{2})?)/);
  if (priceMatch) hits.price = parsePriceNumber(priceMatch[1]);

  const img = tags.find(t => t.name === 'img' && /^https?:\/\/[^\s]+\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(t.attrs.src || ''));
  if (img) hits.image = img.attrs.src;

  const label = html.match(/(?:Size|Color|Colour|Variant)\s*:\s*<[a-zA-Z][^<>]{0,200}>([^<]{1,40})</i);
  if (label) hits.variant = cleanText(label[1], 100) || null;
  return hits;
}

/**
 * Reads one price out of free text. Understands "1,299.00", "1.299,00",
 * "1 299,00 €" and prefers the number next to a currency symbol. When a
 * string holds several numbers ("$12.99 - $15.99") the first is used; digits
 * from different numbers are never glued together.
 */
export function parsePriceNumber(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return cleanPrice(input);
  const text = String(input).slice(0, 200);
  const NUM = String.raw`\d{1,3}(?:[ \u00a0.,\u2019']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,3})?`;
  const nearSymbol = text.match(new RegExp(`[$€£¥]\\s*(${NUM})`)) || text.match(new RegExp(`(${NUM})\\s*(?:[$€£¥]|USD|EUR|GBP|CAD|AUD)`, 'i'));
  const token = nearSymbol ? nearSymbol[1] : (text.match(new RegExp(NUM)) || [])[0];
  if (!token) return null;

  let digits = token.replace(/[ \u00a0\u2019']/g, '');
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: whichever comes last is the decimal separator.
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    digits = digits.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    const decimals = digits.length - lastComma - 1;
    digits = (digits.indexOf(',') === lastComma && decimals <= 2) ? digits.replace(',', '.') : digits.split(',').join('');
  } else if (lastDot !== -1 && digits.indexOf('.') !== lastDot) {
    digits = digits.split('.').join('');
  }
  return cleanPrice(Number(digits));
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
    barnesandnoble: 'Barnes & Noble'
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

/**
 * Server-side URL capture entry point (Section 7 & Decision D3).
 * HARD RULE D3: Amazon is NEVER fetched server-side.
 */
export async function captureFromUrl(db, { url, htmlSnapshot = null, clientExtracted = null, pathType = 'paste' }) {
  const safety = checkUrlSafety(url);
  if (!safety.safe) {
    throw badRequest(`That link can't be used: ${safety.reason}`);
  }

  const parsedUrl = new URL(String(url).trim());
  const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
  if (!['paste', 'extension', 'share', 'import'].includes(pathType)) pathType = 'paste';
  if (clientExtracted !== null && (typeof clientExtracted !== 'object' || Array.isArray(clientExtracted))) clientExtracted = null;
  if (htmlSnapshot !== null && typeof htmlSnapshot !== 'string') htmlSnapshot = null;

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
      title: '',
      image: null,
      price: null,
      currency: 'USD',
      variant: null,
      field_confidence: { title: 0, image: 0, price: 0, store: 1.0, variant: 0 },
      extraction_layers_used: {},
      notice: 'Hushlist does not read Amazon pages from the server. Type the details here, or use the browser extension on the product page to fill them in.'
    };
  }

  return extractMetadataFromHtml(db, url, htmlSnapshot || '', clientExtracted);
}

/**
 * IMP-1: Import a public Amazon list (or exported HTML/JSON payload) with re-sync support.
 * Returns a detailed report of imported, skipped (duplicates), and failed items.
 */
const MAX_IMPORT_ITEMS = 200;

export function importAmazonList(db, { listId, canEdit, amazonListUrl, itemsPayload = [] }) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(String(listId ?? ''));
  if (!list) throw notFound('List not found');
  if (!canEdit(list)) throw forbidden('You cannot add items to this list');
  if (!Array.isArray(itemsPayload)) throw badRequest('Items must be a list');
  if (itemsPayload.length > MAX_IMPORT_ITEMS) {
    throw badRequest(`Import at most ${MAX_IMPORT_ITEMS} items at a time`);
  }

  const existingItems = db.prepare("SELECT canonical_url, LOWER(title) as ltitle FROM items WHERE list_id = ? AND status = 'active'").all(list.id);
  const existingUrls = new Set(existingItems.map(i => i.canonical_url).filter(Boolean));
  const existingTitles = new Set(existingItems.map(i => i.ltitle).filter(Boolean));

  const report = {
    source_url: cleanText(amazonListUrl, 300) || 'pasted items',
    imported: [],
    skipped: [],
    failed: []
  };

  const now = new Date().toISOString();

  inTransaction(db, () => {
    itemsPayload.forEach((raw, index) => {
      const label = cleanText(raw?.title, 120) || `Row ${index + 1}`;
      try {
        if (!raw || typeof raw !== 'object' || (!raw.title && !raw.url)) {
          report.failed.push({ title: label, reason: 'Missing title and link' });
          return;
        }
        const canonical = raw.url ? canonicalizeUrl(raw.url) : null;
        const cleanTitle = cleanText(raw.title || inferTitleFromUrl(canonical || ''), 300);
        if (!cleanTitle) {
          report.failed.push({ title: label, reason: 'Could not work out a title' });
          return;
        }
        if ((canonical && existingUrls.has(canonical)) || existingTitles.has(cleanTitle.toLowerCase())) {
          report.skipped.push({ title: cleanTitle, reason: 'Already on this list' });
          return;
        }

        const itemId = uid('itm');
        const price = cleanPrice(typeof raw.price === 'string' ? parsePriceNumber(raw.price) : raw.price);
        const fromAmazon = canonical ? isAmazonDomain(new URL(canonical).hostname) : true;
        const itemConfidence = {
          title: 0.95,
          image: 0,
          price: price !== null ? 0.95 : 0,
          store: fromAmazon ? 1.0 : 0.85,
          variant: raw.variant ? 0.9 : 0
        };

        db.prepare(`
          INSERT INTO items (
            id, list_id, kind, title, canonical_url, original_url, store, image, price, currency,
            variant, qty_wanted, priority, notes, field_confidence, created_at, updated_at
          ) VALUES (?, ?, 'product', ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          itemId,
          list.id,
          cleanTitle,
          canonical,
          canonical,
          fromAmazon ? 'Amazon' : formatStoreName(new URL(canonical).hostname),
          toProxiedImageUrl(raw.image),
          price,
          cleanText(raw.variant, 200) || null,
          cleanInt(raw.qty_wanted, 1, 999, 1),
          ['most_wanted', 'high', 'normal', 'low'].includes(raw.priority) ? raw.priority : 'normal',
          cleanText(raw.notes, 2000) || null,
          JSON.stringify(itemConfidence),
          now,
          now
        );

        if (canonical) existingUrls.add(canonical);
        existingTitles.add(cleanTitle.toLowerCase());
        report.imported.push({ id: itemId, title: cleanTitle, price });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        report.failed.push({ title: label, reason: err.message });
      }
    });
  });

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
  if (!item) throw notFound('Item not found');

  const nowIso = new Date().toISOString();
  const cleaned = newPrice !== undefined && newPrice !== null && newPrice !== '' ? cleanPrice(newPrice) : item.price;
  if (newPrice !== undefined && newPrice !== null && newPrice !== '' && cleaned === null) {
    throw badRequest('Enter a valid price');
  }
  const parsedPrice = cleaned;
  const inStockFlag = newInStock ? 1 : 0;

  const oldPrice = item.price;
  const oldInStock = item.in_stock;

  // Items that pre-date price tracking have no starting point; record the
  // price they had so the history (and any drop) is measured from it.
  const hasHistory = db.prepare('SELECT 1 FROM price_snapshots WHERE item_id = ? LIMIT 1').get(item.id);
  if (!hasHistory && oldPrice !== null) {
    db.prepare('INSERT INTO price_snapshots (id, item_id, price, in_stock, checked_at) VALUES (?, ?, ?, ?, ?)').run(
      uid('ps'), item.id, oldPrice, oldInStock, item.created_at
    );
  }
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

  // Nothing derived from claims may be returned: the caller is usually the
  // list owner, and "N people were notified" would reveal that the item is taken.
  return {
    item_id: item.id,
    old_price: oldPrice,
    new_price: parsedPrice,
    drop_percent: dropPct,
    significant_drop_alert: isSignificantDrop,
    back_in_stock_alert: backInStock,
    out_of_stock_alert: wentOutOfStock
  };
}
