/**
 * Hushlist Manifest V3 Client-Side DOM Extractor & Popup Controller (Section 7, 9, 11, 15 Flow A)
 * - Runs in the user's own browser tab on click (activeTab permission only).
 * - Extracts selected variant, price, image, and title from live DOM (including Amazon pages per Decision D3).
 * - Never touches or modifies affiliate links (Chrome Web Store policy compliance, Decision D7).
 */

const API_BASE = 'http://localhost:3456';

function extractProductFromLiveDom() {
  const getMeta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || null;
  const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;

  // 1. Check Amazon / Top Retailer DOM selectors first
  let title = getText('#productTitle') || getText('[data-test="product-title"]') || getText('[data-buy-box-listing-title]');
  let priceText = getText('.a-price .a-offscreen') || getText('[data-test="product-price"]') || getText('[itemprop="price"]');
  let image = document.querySelector('#landingImage')?.src || getMeta('meta[property="og:image"]');
  let variant = getText('#variation_color_name .selection') || getText('#variation_size_name .selection') || getText('[data-test="variant-value"]');

  // 2. Check JSON-LD Product
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of nodes) {
        if (n && /Product/i.test(String(n['@type']))) {
          if (!title && n.name) title = n.name;
          if (!image && n.image) image = Array.isArray(n.image) ? n.image[0] : (n.image.url || n.image);
          const offer = Array.isArray(n.offers) ? n.offers[0] : n.offers;
          if (!priceText && offer?.price) priceText = String(offer.price);
        }
      }
    } catch {}
  }

  // 3. Fallback to OpenGraph & Heuristics
  if (!title) title = getMeta('meta[property="og:title"]') || document.querySelector('h1')?.textContent?.trim() || document.title;
  if (!priceText) priceText = getMeta('meta[property="product:price:amount"]');

  const priceNum = priceText ? Number.parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;

  return {
    url: window.location.href,
    title,
    price: Number.isFinite(priceNum) ? priceNum : null,
    image,
    variant,
    store: window.location.hostname.replace(/^www\./, ''),
    field_confidence: {
      title: title ? 0.98 : 0,
      price: Number.isFinite(priceNum) ? 0.96 : 0,
      image: image ? 0.96 : 0,
      variant: variant ? 0.92 : 0.4
    }
  };
}

async function initPopup() {
  const statusEl = document.getElementById('ext-status');
  const listSelect = document.getElementById('ext-list');

  try {
    const listsRes = await fetch(`${API_BASE}/api/lists`, {
      headers: { 'X-User-Id': 'usr_justin' }
    }).then(r => r.json());

    listSelect.innerHTML = (listsRes.lists || []).map(l =>
      `<option value="${l.id}">${l.name}</option>`
    ).join('');
  } catch {
    statusEl.textContent = 'Connect to Hushlist server at http://localhost:3456';
  }

  if (globalThis.chrome?.tabs?.query) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && chrome.scripting) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractProductFromLiveDom
      });
      if (result) populateFields(result);
    }
  }
}

function populateFields(extracted) {
  document.getElementById('ext-title').value = extracted.title || '';
  document.getElementById('ext-price').value = extracted.price ?? '';
  document.getElementById('ext-store').value = extracted.store || '';
  document.getElementById('ext-variant').value = extracted.variant || '';
  if ((extracted.field_confidence?.variant || 0) < 0.75) {
    document.getElementById('ext-variant').classList.add('low-conf');
  }
  window.__lastExtracted = extracted;
}

document.getElementById('ext-save')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('ext-status');
  const ext = window.__lastExtracted || {};
  try {
    const res = await fetch(`${API_BASE}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': 'usr_justin' },
      body: JSON.stringify({
        list_id: document.getElementById('ext-list').value,
        url: ext.url || null,
        title: document.getElementById('ext-title').value.trim(),
        price: document.getElementById('ext-price').value,
        store: document.getElementById('ext-store').value.trim(),
        variant: document.getElementById('ext-variant').value.trim(),
        qty_wanted: Number(document.getElementById('ext-qty').value) || 1,
        priority: document.getElementById('ext-priority').value,
        notes: document.getElementById('ext-notes').value.trim(),
        image: ext.image || null
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    statusEl.style.background = '#d1fae5';
    statusEl.style.color = '#065f46';
    statusEl.textContent = '✓ Saved to Hushlist!';
  } catch (err) {
    statusEl.style.background = '#ffe4e6';
    statusEl.style.color = '#9f1239';
    statusEl.textContent = err.message;
  }
});

initPopup();
