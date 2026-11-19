/**
 * Hushlist browser extension popup.
 *
 * - Reads the product details from the tab you are on, only when you click
 *   the toolbar button (activeTab). Nothing runs in the background.
 * - Talks to your Hushlist with a token you paste in once. The token is kept
 *   in the browser's extension storage and sent as an Authorization header.
 * - Builds every piece of UI with DOM methods and textContent, so text that
 *   comes back from the server can never be interpreted as markup.
 */

const $ = (id) => document.getElementById(id);
const store = globalThis.chrome?.storage?.local;
let extracted = null;
let config = { server: '', token: '' };

function setStatus(message, kind = '') {
  const el = $('status');
  el.textContent = message || '';
  el.className = kind;
}

function loadConfig() {
  return new Promise((resolve) => {
    if (!store) return resolve({});
    store.get(['server', 'token'], (items) => resolve(items || {}));
  });
}

function saveConfig(next) {
  return new Promise((resolve) => {
    if (!store) return resolve();
    store.set(next, resolve);
  });
}

async function call(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(config.server + path, {
      method,
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error(`Could not reach Hushlist at ${config.server}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data?.error || `Hushlist answered ${res.status}`);
  return data;
}

/** Runs inside the page. Must be self-contained. */
function readProductFromPage() {
  const meta = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || null;
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() || null;

  let title = text('#productTitle') || text('[data-test="product-title"]') || text('[data-buy-box-listing-title]');
  let priceText = text('.a-price .a-offscreen') || text('[data-test="product-price"]') || text('[itemprop="price"]');
  let image = document.querySelector('#landingImage')?.src || meta('meta[property="og:image"]');
  const variant = text('#variation_color_name .selection') || text('#variation_size_name .selection') || text('[data-test="variant-value"]');

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent);
      const nodes = Array.isArray(parsed) ? parsed : (parsed?.['@graph'] || [parsed]);
      for (const node of nodes) {
        if (!node || !/Product/i.test(String(node['@type']))) continue;
        if (!title && node.name) title = String(node.name);
        if (!image && node.image) image = Array.isArray(node.image) ? node.image[0] : (node.image.url || node.image);
        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        if (!priceText && offer?.price) priceText = String(offer.price);
      }
    } catch { /* malformed JSON-LD is common */ }
  }

  if (!title) title = meta('meta[property="og:title"]') || document.querySelector('h1')?.textContent?.trim() || document.title;
  if (!priceText) priceText = meta('meta[property="product:price:amount"]');
  const price = priceText ? Number.parseFloat(String(priceText).replace(/[^0-9.]/g, '')) : NaN;

  return {
    url: location.href,
    title: title ? String(title).slice(0, 300) : '',
    price: Number.isFinite(price) ? price : null,
    image: typeof image === 'string' ? image : null,
    variant: variant ? String(variant).slice(0, 200) : '',
    store: location.hostname.replace(/^www\./, ''),
    confidence: { title: title ? 0.98 : 0, price: Number.isFinite(price) ? 0.96 : 0, variant: variant ? 0.92 : 0 }
  };
}

async function readActiveTab() {
  if (!globalThis.chrome?.tabs?.query || !chrome.scripting) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readProductFromPage });
    return result || null;
  } catch {
    // Browser pages, the extension store and PDFs cannot be read.
    return null;
  }
}

function showSettings(message = '') {
  $('save').hidden = true;
  $('settings').hidden = false;
  $('set-server').value = config.server || 'http://localhost:3456';
  $('set-token').value = '';
  setStatus(message, message ? 'err' : '');
}

async function showSave() {
  let lists;
  try {
    ({ lists } = await call('/api/lists'));
  } catch (err) {
    return showSettings(err.message);
  }
  const usable = (lists || []).filter(l => !l.archived_at);
  if (usable.length === 0) return showSettings('That token did not open any lists. Create a new one in Hushlist and paste it here.');

  const select = $('ext-list');
  select.replaceChildren(...usable.map((l) => {
    const option = document.createElement('option');
    option.value = l.id;
    option.textContent = l.name; // text, never markup
    return option;
  }));

  $('settings').hidden = true;
  $('save').hidden = false;
  setStatus('');

  extracted = await readActiveTab();
  if (!extracted) {
    setStatus('This page could not be read. You can still type the details in.', '');
    return;
  }
  $('ext-title').value = extracted.title || '';
  $('ext-price').value = extracted.price ?? '';
  $('ext-store').value = extracted.store || '';
  $('ext-variant').value = extracted.variant || '';
  $('ext-variant').classList.toggle('unsure', Boolean(extracted.variant) && extracted.confidence.variant < 0.75);
}

$('open-settings').addEventListener('click', () => showSettings());

$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  let server;
  try {
    const url = new URL($('set-server').value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad scheme');
    server = url.origin;
  } catch {
    return setStatus('Enter the address as http://… or https://…', 'err');
  }
  config = { server, token: $('set-token').value.trim() };
  await saveConfig(config);
  await showSave();
});

$('save').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const captured = extracted || {};
    await call('/api/items', {
      method: 'POST',
      body: {
        list_id: $('ext-list').value,
        url: captured.url || null,
        title: $('ext-title').value.trim(),
        price: $('ext-price').value === '' ? null : Number($('ext-price').value),
        store: $('ext-store').value.trim(),
        variant: $('ext-variant').value.trim(),
        qty_wanted: Number($('ext-qty').value) || 1,
        priority: $('ext-priority').value,
        notes: $('ext-notes').value.trim(),
        image: captured.image || null,
        field_confidence: captured.confidence || undefined
      }
    });
    setStatus('Added to your list.', 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    if (button) button.disabled = false;
  }
});

(async () => {
  const saved = await loadConfig();
  config = { server: saved.server || '', token: saved.token || '' };
  if (!config.server || !config.token) return showSettings();
  await showSave();
})();
