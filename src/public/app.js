/**
 * Hushlist Frontend Application
 * Covers all PRD Flows (A, B, C, D), Surprise Protection UI verification,
 * Layered Item Capture, Guest 6-digit verification, "Did you buy it?" return prompts,
 * Group Chip-In contributions, Secret Ideas, Guardian under-13 Child Lists,
 * Amazon Import, CSV/JSON Export, Verifiable Secret Santa, and Admin Console.
 */

const state = {
  activeUserId: localStorage.getItem('hushlist_user_id') || 'usr_justin',
  guestToken: localStorage.getItem('hushlist_guest_token') || '',
  currentUser: null,
  dependents: [],
  personas: [],
  activeTab: 'my-lists',
  selectedListId: null,
  sharedListToken: new URLSearchParams(window.location.search).get('list') || 'justin-winter-2026',
  myLists: [],
  dashboardData: null,
  sharedList: null,
  groups: [],
  notifications: [],
  followsData: null,
  adminData: null,
  sortBy: 'priority', // 'priority', 'price_asc', 'price_desc', 'date_desc'
  filterBy: 'all' // 'all', 'most_wanted', 'available', 'under_50', 'price_drop'
};

// If opened via a shared link (?list=...), jump straight to the Giver / Shared Link tab
if (new URLSearchParams(window.location.search).get('list')) {
  state.activeTab = 'shared-giver';
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-User-Id': state.activeUserId,
    ...(state.guestToken ? { 'X-Guest-Token': state.guestToken } : {}),
    ...(options.headers || {})
  };
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function showToast(msg) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      updateNavTabs();
      refreshAndRender();
    });
  });

  const personaSelect = document.getElementById('persona-select');
  personaSelect.addEventListener('change', async (e) => {
    state.activeUserId = e.target.value;
    localStorage.setItem('hushlist_user_id', state.activeUserId);
    if (state.activeUserId === 'guest') {
      state.activeTab = 'shared-giver';
    }
    updateNavTabs();
    await refreshAndRender();
    showToast(`Switched view to: ${personaSelect.options[personaSelect.selectedIndex].text}`);
  });

  document.getElementById('btn-quick-signup').addEventListener('click', () => openOnboardingModal());

  // GAP-5.5: Global Escape key listener to dismiss any open modal dialog (WCAG 2.2 AA)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('modal-root')?.innerHTML) {
      closeModal();
    }
  });

  // Check if opened via PWA Share Target (?sharedUrl=...)
  const params = new URLSearchParams(window.location.search);
  await refreshAndRender();
  if (params.get('sharedUrl') && state.currentUser) {
    openAddItemModal(state.myLists[0]?.id, params.get('sharedUrl'), params.get('sharedTitle'));
  }
}

function updateNavTabs() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
  });
}

async function refreshAndRender() {
  const session = await api('/api/session');
  state.currentUser = session.current_user;
  state.dependents = session.dependents || [];
  state.personas = session.demo_personas || [];

  renderPersonaSelector();

  const root = document.getElementById('app-root');
  try {
    if (state.activeTab === 'my-lists') {
      if (!state.currentUser) {
        root.innerHTML = renderGuestSignInCallout();
        bindGuestCalloutEvents();
        return;
      }
      const res = await api('/api/lists');
      state.myLists = res.lists || [];
      if (!state.selectedListId || !state.myLists.some(l => l.id === state.selectedListId)) {
        state.selectedListId = state.myLists[0]?.id || null;
      }
      root.innerHTML = renderMyListsTab();
      bindMyListsEvents();
    } else if (state.activeTab === 'dashboard') {
      if (!state.currentUser) {
        root.innerHTML = renderGuestSignInCallout();
        bindGuestCalloutEvents();
        return;
      }
      const [dashRes, folRes] = await Promise.all([
        api('/api/dashboard'),
        api('/api/follows').catch(() => ({ followers_of_me: [], who_i_follow: [] }))
      ]);
      state.dashboardData = dashRes;
      state.followsData = folRes;
      root.innerHTML = renderDashboardTab();
      bindDashboardEvents();
    } else if (state.activeTab === 'my-claims') {
      if (!state.currentUser) {
        root.innerHTML = renderGuestSignInCallout();
        bindGuestCalloutEvents();
        return;
      }
      state.dashboardData = await api('/api/dashboard');
      root.innerHTML = renderMyClaimsTab();
      bindMyClaimsEvents();
    } else if (state.activeTab === 'shared-giver') {
      const allPublicRes = await api('/api/lists?ownerId=');
      const listRes = await api(`/api/lists/${encodeURIComponent(state.sharedListToken)}`);
      state.sharedList = listRes.list;
      root.innerHTML = renderSharedGiverTab(allPublicRes.lists || []);
      bindSharedGiverEvents();
    } else if (state.activeTab === 'groups') {
      const grpRes = await api('/api/groups');
      state.groups = grpRes.groups || [];
      root.innerHTML = renderGroupsTab();
      bindGroupsEvents();
    } else if (state.activeTab === 'inbox') {
      const ntfRes = await api('/api/notifications');
      state.notifications = ntfRes.notifications || [];
      root.innerHTML = renderInboxTab();
      bindInboxEvents();
    } else if (state.activeTab === 'admin') {
      if (!state.currentUser || !state.currentUser.is_admin) {
        root.innerHTML = `<div class="card"><h2>Admin Privileges Required (ADV-2.1)</h2><p>Switch "Viewing As" in the top bar to <strong>Justin Smith (Owner &amp; Admin)</strong> to access the Admin Console, Retailer Adapter configuration, and Audited Claim Overrides.</p></div>`;
        return;
      }
      state.adminData = await api('/api/admin');
      root.innerHTML = renderAdminTab();
      bindAdminEvents();
    }
  } catch (err) {
    root.innerHTML = `<div class="card"><h2 class="card-title">Notice</h2><p>${escapeHtml(err.message)}</p></div>`;
  }
}

function renderPersonaSelector() {
  const select = document.getElementById('persona-select');
  const adultPersonas = state.personas.filter(p => !p.is_dependent);
  select.innerHTML = [
    ...adultPersonas.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === state.activeUserId ? 'selected' : ''}>${escapeHtml(p.name)} (${p.is_admin ? 'Owner & Admin' : 'Family Member'})</option>`),
    `<option value="guest" ${state.activeUserId === 'guest' ? 'selected' : ''}>Guest Giver (No Account / Phone Link)</option>`
  ].join('');
}

function renderGuestSignInCallout() {
  return `
    <div class="card" style="text-align:center; padding:2.5rem;">
      <h2>You are currently browsing as a Guest Giver (No Account)</h2>
      <p style="color:var(--text-muted); max-width:560px; margin:0.5rem auto 1.5rem;">
        Guests can browse shared wishlists and reserve gifts using only a verified email address on the <strong>Giver / Shared Link View</strong> tab—or you can create your own wishlist in under 60 seconds with no password required!
      </p>
      <div style="display:flex; justify-content:center; gap:0.75rem;">
        <button class="btn btn-primary" id="btn-guest-browse-shared" type="button">Browse Shared Wishlists as Guest</button>
        <button class="btn btn-secondary" id="btn-guest-create-own" type="button">Create My Own Wishlist</button>
      </div>
    </div>
  `;
}

function bindGuestCalloutEvents() {
  document.getElementById('btn-guest-browse-shared')?.addEventListener('click', () => {
    document.querySelector('[data-tab="shared-giver"]')?.click();
  });
  document.getElementById('btn-guest-create-own')?.addEventListener('click', () => {
    document.getElementById('btn-quick-signup')?.click();
  });
}

function applySortAndFilter(items = []) {
  let list = [...items];
  if (state.filterBy === 'most_wanted') {
    list = list.filter(i => i.priority === 'most_wanted');
  } else if (state.filterBy === 'available') {
    list = list.filter(i => !i.claim_summary?.is_fully_claimed && i.status === 'active');
  } else if (state.filterBy === 'under_50') {
    list = list.filter(i => i.price !== null && i.price !== undefined && Number(i.price) <= 50);
  } else if (state.filterBy === 'price_drop') {
    list = list.filter(i => (i.price_drop_percent || 0) > 0);
  }

  const pRank = { most_wanted: 0, high: 1, normal: 2, low: 3 };
  if (state.sortBy === 'price_asc') {
    list.sort((a, b) => (a.price ?? 999999) - (b.price ?? 999999));
  } else if (state.sortBy === 'price_desc') {
    list.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  } else if (state.sortBy === 'date_desc') {
    list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  } else {
    list.sort((a, b) => (pRank[a.priority] ?? 2) - (pRank[b.priority] ?? 2) || (a.sort_order - b.sort_order));
  }
  return list;
}

function renderSortFilterToolbar() {
  return `
    <div class="card" style="padding:0.75rem 1rem; margin-bottom:1rem; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:0.75rem;">
      <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
        <span style="font-size:0.82rem; font-weight:700; color:var(--text-muted);">Filter (LST-5):</span>
        ${[
          ['all', 'All Items'],
          ['most_wanted', '★ Most Wanted'],
          ['under_50', 'Under $50'],
          ['price_drop', '📉 Price Drops'],
          ['available', 'Available Only']
        ].map(([val, label]) => `
          <button type="button" class="btn btn-sm ${state.filterBy === val ? 'btn-primary' : 'btn-secondary'}" data-filter-by="${val}">${label}</button>
        `).join('')}
      </div>
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <label for="sort-by-select" style="font-size:0.82rem; font-weight:700; color:var(--text-muted);">Sort By:</label>
        <select id="sort-by-select" class="form-control" style="width:auto; padding:0.3rem 0.6rem; font-size:0.84rem;">
          <option value="priority" ${state.sortBy === 'priority' ? 'selected' : ''}>Priority (Most Wanted First)</option>
          <option value="price_asc" ${state.sortBy === 'price_asc' ? 'selected' : ''}>Price: Low to High</option>
          <option value="price_desc" ${state.sortBy === 'price_desc' ? 'selected' : ''}>Price: High to Low</option>
          <option value="date_desc" ${state.sortBy === 'date_desc' ? 'selected' : ''}>Date Added (Newest)</option>
        </select>
      </div>
    </div>
  `;
}

function bindSortFilterEvents() {
  document.querySelectorAll('[data-filter-by]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filterBy = btn.dataset.filterBy;
      refreshAndRender();
    });
  });
  document.getElementById('sort-by-select')?.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    refreshAndRender();
  });
}

function renderPriceSparklineSvg(priceHistory = []) {
  if (!Array.isArray(priceHistory) || priceHistory.length < 2) return '';
  const prices = priceHistory.map(p => Number(p.price) || 0).filter(p => p > 0);
  if (prices.length < 2) return '';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = Math.max(1, max - min);
  const w = 110;
  const h = 26;
  const pts = prices.map((p, idx) => {
    const x = Math.round((idx / (prices.length - 1)) * (w - 8)) + 4;
    const y = Math.round(h - 4 - ((p - min) / range) * (h - 8));
    return `${x},${y}`;
  }).join(' ');
  const isDrop = prices[prices.length - 1] < prices[0];
  const stroke = isDrop ? '#059669' : '#4f46e5';
  return `
    <span title="Price history: $${prices[0].toFixed(2)} → $${prices[prices.length - 1].toFixed(2)}" style="display:inline-flex; align-items:center; gap:0.25rem;">
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="Price history sparkline">
        <polyline fill="none" stroke="${stroke}" stroke-width="2.2" points="${pts}" />
      </svg>
    </span>
  `;
}

// ============================================================================
// TAB 1: MY WISHLISTS & DEPENDENT CHILD PROFILES
// ============================================================================
function renderMyListsTab() {
  const activeList = state.myLists.find(l => l.id === state.selectedListId) || state.myLists[0];

  return `
    <div class="banner-shield">
      <div>
        <strong>Surprise Protection Shield Active (D1 &amp; D2):</strong>
        When Surprise Mode is on, you never see who claimed or bought items on your own list, and no home street address is ever stored or exposed.
      </div>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" id="btn-new-list" type="button">+ New Wishlist</button>
        <button class="btn btn-secondary btn-sm" id="btn-new-child" type="button">+ Add Child Profile (Under 13)</button>
        <button class="btn btn-secondary btn-sm" id="btn-amazon-import" type="button">Import Amazon List</button>
        <button class="btn btn-secondary btn-sm" id="btn-ios-shortcut" type="button">📱 iOS Safari Save Button</button>
        <a class="btn btn-secondary btn-sm" href="/api/export?format=csv&asUser=${encodeURIComponent(state.activeUserId)}" download="hushlist-export.csv">Export CSV</a>
        <a class="btn btn-secondary btn-sm" href="/api/export?format=json&asUser=${encodeURIComponent(state.activeUserId)}" download="hushlist-export.json">Export JSON</a>
      </div>
    </div>

    <div style="display:grid; grid-template-columns: 290px 1fr; gap: 1.5rem; align-items:start;">
      <aside class="card" aria-label="Your Wishlists and Dependent Lists">
        <h2 class="card-title" style="margin-bottom:0.75rem;">Your Lists &amp; Dependents</h2>
        <div style="display:flex; flex-direction:column; gap:0.5rem;">
          ${state.myLists.map(l => `
            <button
              type="button"
              class="btn ${l.id === activeList?.id ? 'btn-primary' : 'btn-secondary'}"
              style="justify-content:space-between; text-align:left; width:100%;"
              data-select-list="${escapeHtml(l.id)}"
            >
              <span style="overflow:hidden; text-overflow:ellipsis;">
                ${l.owner_is_dependent ? '🧒 ' : '🎁 '}${escapeHtml(l.name)}
              </span>
              <span class="badge ${l.surprise_mode ? 'badge-surprise' : 'badge-normal'}">
                ${l.items.length}
              </span>
            </button>
          `).join('')}
        </div>

        ${state.dependents.length > 0 ? `
          <hr style="border:none; border-top:1px solid var(--border); margin:1rem 0;" />
          <h3 style="font-size:0.85rem; text-transform:uppercase; color:var(--text-muted); margin:0 0 0.5rem;">Guardian-Managed Kids (D6)</h3>
          ${state.dependents.map(d => `
            <div style="font-size:0.85rem; padding:0.4rem 0; display:flex; justify-content:space-between;">
              <span><strong>${escapeHtml(d.name)}</strong></span>
              <span class="badge badge-normal">No Child Login</span>
            </div>
          `).join('')}
        ` : ''}
      </aside>

      <section>
        ${activeList ? renderActiveListDetail(activeList) : '<div class="card"><p>No lists yet. Click "+ New Wishlist" to create one.</p></div>'}
      </section>
    </div>
  `;
}

function renderActiveListDetail(list) {
  const helperNames = (list.helpers || []).map(h => h.name).join(', ') || 'None assigned';

  return `
    <div class="card" style="margin-bottom:1.25rem;">
      <div class="card-header">
        <div>
          <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
            <h2 class="card-title" style="font-size:1.35rem;">${escapeHtml(list.name)}</h2>
            <span class="badge badge-surprise">${list.surprise_mode ? 'Surprise Mode ON (Zero Spoilers)' : 'Registry Mode (Claims Visible)'}</span>
            ${list.owner_is_dependent ? '<span class="badge badge-available">Guardian View (Claims Visible to Parents)</span>' : ''}
            ${list.archived_at ? '<span class="badge badge-taken">Archived</span>' : ''}
          </div>
          <p style="margin:0.35rem 0 0; font-size:0.88rem; color:var(--text-muted);">
            Occasion: <strong>${escapeHtml(list.occasion)}</strong>
            ${list.event_date ? ` · Event Date: <strong>${escapeHtml(list.event_date)}</strong>` : ''}
            · Visibility: <strong>${escapeHtml(list.visibility)}</strong>
            · Trusted List Helper (LST-4): <strong>${escapeHtml(helperNames)}</strong>
          </p>
        </div>

        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button class="btn btn-primary" id="btn-add-item" data-list-id="${escapeHtml(list.id)}" type="button">+ Add Item (URL or Idea)</button>
          <button class="btn btn-secondary btn-sm" id="btn-share-list" data-share-token="${escapeHtml(list.share_token)}" type="button">Share Link / QR</button>
          <button class="btn btn-secondary btn-sm" id="btn-toggle-surprise" data-list-id="${escapeHtml(list.id)}" data-current="${list.surprise_mode ? '1' : '0'}" type="button">
            ${list.surprise_mode ? 'Switch to Registry Mode' : 'Turn On Surprise Mode'}
          </button>
          ${!list.revealed_at ? `
            <button class="btn btn-secondary btn-sm" id="btn-reveal-list" data-list-id="${escapeHtml(list.id)}" type="button" title="After event date, reveal gifts for thank-you notes (EVT-2)">
              Post-Event Reveal &amp; Thank-Yous
            </button>
          ` : ''}
        </div>
      </div>
    </div>

    ${renderSortFilterToolbar()}

    <div class="grid-3">
      ${applySortAndFilter(list.items).map(item => renderOwnerItemCard(item, list)).join('')}
    </div>
  `;
}

function renderOwnerItemCard(item, list) {
  const priorityLabel = {
    most_wanted: '★ Most Wanted',
    high: 'High Priority',
    normal: 'Wanted',
    low: 'Nice to Have'
  }[item.priority] || 'Wanted';

  const priorityClass = item.priority === 'most_wanted' ? 'badge-most-wanted' : item.priority === 'high' ? 'badge-high' : 'badge-normal';
  const claimInfo = item.claim_summary;
  const otherLists = state.myLists.filter(l => l.id !== list.id && l.owner_id === list.owner_id);

  return `
    <article class="item-card ${item.status === 'received' ? 'taken' : ''}">
      <img class="item-thumb" src="${escapeHtml(item.image || '/api/image-proxy?label=Gift')}" alt="${escapeHtml(item.title)}" loading="lazy" />
      <div class="item-body">
        <div class="item-meta-row">
          <span class="badge ${priorityClass}">${escapeHtml(priorityLabel)}</span>
          <span class="badge badge-normal">${escapeHtml(item.store || item.kind)}</span>
          ${!item.in_stock ? '<span class="badge badge-most-wanted">Out of Stock</span>' : ''}
          ${item.price_drop_percent >= 5 ? `<span class="badge badge-available">📉 -${item.price_drop_percent}% Price Drop</span>` : ''}
          ${item.always_wanted ? '<span class="badge badge-available">∞ Always Wanted</span>' : ''}
          ${item.allow_group_chip_in ? '<span class="badge badge-surprise">Group Chip-In</span>' : ''}
          ${item.status === 'received' ? '<span class="badge badge-available">✓ Received</span>' : ''}
        </div>

        <h3 style="margin:0.15rem 0; font-size:1.02rem;">
          ${item.canonical_url
            ? `<a href="${escapeHtml(item.canonical_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`
            : escapeHtml(item.title)}
        </h3>

        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <span class="price-tag">${item.price !== null && item.price !== undefined ? `$${Number(item.price).toFixed(2)}` : 'Flexible / No Price'}</span>
            ${renderPriceSparklineSvg(item.price_history)}
          </div>
          <span style="font-size:0.82rem; color:var(--text-muted);">Qty wanted: ${item.always_wanted ? '∞' : item.qty_wanted}</span>
        </div>

        ${item.variant ? `<div style="font-size:0.84rem;"><strong>Size / Color:</strong> ${escapeHtml(item.variant)}</div>` : ''}
        ${item.notes ? `<div style="font-size:0.84rem; color:var(--text-muted);">"${escapeHtml(item.notes)}"</div>` : ''}
        ${item.any_similar ? `<div style="font-size:0.8rem; color:var(--emerald); font-weight:600;">✓ Any similar item is welcome</div>` : ''}
        ${item.giving_instructions ? `<div style="font-size:0.8rem; background:var(--surface-alt); padding:0.4rem 0.6rem; border-radius:6px;"><strong>Group Giving Note:</strong> ${escapeHtml(item.giving_instructions)}</div>` : ''}

        ${claimInfo ? `
          <div style="margin-top:0.4rem; padding:0.55rem; background:var(--emerald-soft); border-radius:8px; font-size:0.82rem; color:var(--emerald);">
            <strong>Status (${list.owner_is_dependent ? 'Guardian View' : 'Revealed'}):</strong> ${escapeHtml(claimInfo.availability_label)}
            ${claimInfo.pledged_total > 0 ? ` · $${claimInfo.pledged_total} of $${claimInfo.pledged_target} pledged` : ''}
            ${claimInfo.claims.map(c => `<div>• ${escapeHtml(c.claimer_display)} (${escapeHtml(c.status)})</div>`).join('')}
          </div>
        ` : ''}

        <div style="margin-top:auto; padding-top:0.75rem; display:flex; flex-wrap:wrap; gap:0.4rem;">
          <button class="btn btn-secondary btn-sm" data-edit-item="${escapeHtml(item.id)}" type="button">Edit</button>
          ${item.price && item.store !== 'Amazon' ? `
            <button class="btn btn-secondary btn-sm" data-recheck-price="${escapeHtml(item.id)}" data-current-price="${item.price}" type="button" title="Simulate ITM-6 Price Drop (-15%) Re-Check">📉 Test Price Drop</button>
          ` : ''}
          ${otherLists.length > 0 ? `
            <button class="btn btn-secondary btn-sm" data-move-item="${escapeHtml(item.id)}" data-target-list="${escapeHtml(otherLists[0].id)}" type="button" title="Move item to ${escapeHtml(otherLists[0].name)} while keeping claims intact (LST-5)">Move ⇄</button>
          ` : ''}
          <button class="btn btn-secondary btn-sm" data-got-it="${escapeHtml(item.id)}" type="button" title="Bought it yourself? Silently withdraws reservations without spoiling.">Got It</button>
          ${item.status !== 'received' ? `
            <button class="btn btn-secondary btn-sm" data-mark-received="${escapeHtml(item.id)}" type="button">Mark Received</button>
          ` : `
            <button class="btn btn-emerald btn-sm" data-thank-you="${escapeHtml(item.id)}" data-thanked="${item.thank_you_sent ? '1' : '0'}" type="button">
              ${item.thank_you_sent ? '✓ Thank-You Sent' : 'Send Thank-You (EVT-2)'}
            </button>
          `}
          <button class="btn btn-danger btn-sm" data-delete-item="${escapeHtml(item.id)}" type="button">Delete</button>
        </div>
      </div>
    </article>
  `;
}

function bindMyListsEvents() {
  bindSortFilterEvents();

  document.querySelectorAll('[data-select-list]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedListId = btn.dataset.selectList;
      refreshAndRender();
    });
  });

  const btnNewList = document.getElementById('btn-new-list');
  if (btnNewList) btnNewList.addEventListener('click', () => openNewListModal());

  const btnNewChild = document.getElementById('btn-new-child');
  if (btnNewChild) btnNewChild.addEventListener('click', () => openNewChildModal());

  const btnAmazon = document.getElementById('btn-amazon-import');
  if (btnAmazon) btnAmazon.addEventListener('click', () => openAmazonImportModal(state.selectedListId));

  const btnIos = document.getElementById('btn-ios-shortcut');
  if (btnIos) btnIos.addEventListener('click', () => openIosShortcutModal());

  const btnAddItem = document.getElementById('btn-add-item');
  if (btnAddItem) btnAddItem.addEventListener('click', () => openAddItemModal(btnAddItem.dataset.listId));

  const btnShare = document.getElementById('btn-share-list');
  if (btnShare) btnShare.addEventListener('click', () => openShareModal(btnShare.dataset.shareToken));

  const btnToggleSurprise = document.getElementById('btn-toggle-surprise');
  if (btnToggleSurprise) {
    btnToggleSurprise.addEventListener('click', async () => {
      try {
        const listId = btnToggleSurprise.dataset.listId;
        const nextMode = btnToggleSurprise.dataset.current === '1' ? false : true;
        await api(`/api/lists/${listId}`, {
          method: 'PATCH',
          body: JSON.stringify({ surprise_mode: nextMode })
        });
        showToast(nextMode ? 'Surprise Mode enabled (claims hidden from you)' : 'Registry Mode enabled (claims visible)');
        refreshAndRender();
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  const btnReveal = document.getElementById('btn-reveal-list');
  if (btnReveal) {
    btnReveal.addEventListener('click', async () => {
      try {
        await api(`/api/lists/${btnReveal.dataset.listId}`, {
          method: 'PATCH',
          body: JSON.stringify({ action: 'reveal_purchases', force_post_event_reveal: true })
        });
        showToast('Post-event gifts revealed for your Thank-You Tracker!');
        refreshAndRender();
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  const activeList = state.myLists.find(l => l.id === state.selectedListId) || state.myLists[0];

  document.querySelectorAll('[data-edit-item]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = activeList?.items.find(i => i.id === btn.dataset.editItem);
      if (item) openEditItemModal(item);
    });
  });

  document.querySelectorAll('[data-recheck-price]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const currentPrice = Number(btn.dataset.currentPrice) || 50;
      const droppedPrice = Math.round(currentPrice * 0.85 * 100) / 100; // 15% price drop
      const res = await api(`/api/items/${btn.dataset.recheckPrice}/recheck`, {
        method: 'POST',
        body: JSON.stringify({ new_price: droppedPrice, in_stock: true })
      });
      showToast(`Price re-checked (ITM-6): -$${(currentPrice - droppedPrice).toFixed(2)} (-${res.recheck.drop_percent}%). Any active claimers were notified!`);
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-move-item]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/items/${btn.dataset.moveItem}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'move_to_list', target_list_id: btn.dataset.targetList })
      });
      showToast('Moved item to other list (claims preserved intact per LST-5)!');
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-got-it]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/items/${btn.dataset.gotIt}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'got_it' })
      });
      showToast('Marked as "Got it". (Any active claimers were notified privately without spoilers!)');
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-mark-received]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/items/${btn.dataset.markReceived}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'mark_received', outside_app: false })
      });
      showToast('Item marked as received (EVT-1)!');
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-thank-you]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.thanked !== '1';
      await api(`/api/items/${btn.dataset.thankYou}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'toggle_thank_you', thank_you_sent: next })
      });
      showToast(next ? 'Marked Thank-You Note as Sent!' : 'Thank-You status cleared');
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-delete-item]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/items/${btn.dataset.deleteItem}`, { method: 'DELETE' });
      showToast('Item deleted from your list.');
      refreshAndRender();
    });
  });
}

// ============================================================================
// TAB 2: "PEOPLE I SHOP FOR" TRACKING DASHBOARD (Flow C, TRK-1..4, GVR-5)
// ============================================================================
function renderDashboardTab() {
  const cards = state.dashboardData?.people_i_shop_for || [];
  const followersOfMe = state.followsData?.followers_of_me || [];

  return `
    <div class="banner-shield">
      <div>
        <strong>"People I Shop For" Follower Dashboard (TRK-1..4, FOL-1..2 &amp; GVR-5):</strong>
        Track upcoming occasions, unclaimed priorities, your personal budget per recipient, and private <em>Secret Ideas</em> that the recipient can never see.
      </div>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn btn-primary btn-sm" id="btn-generate-digest" type="button">📬 Generate My Follower Digest (NTF-1)</button>
      </div>
    </div>

    ${followersOfMe.length > 0 ? `
      <div class="card" style="margin-bottom:1.25rem; padding:0.9rem 1.2rem;">
        <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:0.75rem;">
          <div>
            <strong style="font-size:0.92rem;">People Following Your Wishlists (FOL-2):</strong>
            <span style="font-size:0.82rem; color:var(--text-muted);">Removing or blocking a follower revokes their access immediately on their next request.</span>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:0.45rem;">
            ${followersOfMe.map(f => `
              <span class="badge ${f.status === 'blocked' ? 'badge-most-wanted' : 'badge-normal'}" style="display:inline-flex; align-items:center; gap:0.4rem; padding:0.3rem 0.6rem;">
                ${escapeHtml(f.follower_name)} (${escapeHtml(f.status)})
                ${f.status !== 'blocked' ? `
                  <button type="button" class="btn btn-danger btn-sm" style="padding:0.1rem 0.35rem; font-size:0.7rem;" data-block-follow="${escapeHtml(f.id)}">Block</button>
                ` : `
                  <button type="button" class="btn btn-secondary btn-sm" style="padding:0.1rem 0.35rem; font-size:0.7rem;" data-approve-follow="${escapeHtml(f.id)}">Unblock</button>
                `}
              </span>
            `).join('')}
          </div>
        </div>
      </div>
    ` : ''}

    <div class="grid-2">
      ${cards.map(c => {
        const pct = c.budget.limit ? Math.min(100, Math.round((c.budget.spent / c.budget.limit) * 100)) : 0;
        return `
          <section class="card">
            <div class="card-header">
              <div>
                <h2 class="card-title">
                  ${c.person.is_dependent ? '🧒 ' : '👤 '}${escapeHtml(c.person.name)}
                </h2>
                ${c.next_occasion ? `
                  <p style="margin:0.2rem 0 0; font-size:0.86rem; color:var(--primary); font-weight:700;">
                    📅 ${escapeHtml(c.next_occasion.label)} (${escapeHtml(c.next_occasion.date)}) — ${c.next_occasion.days_remaining} days left
                  </p>
                ` : ''}
              </div>
              <span class="badge badge-available">${c.unclaimed_count} Unclaimed Wishes</span>
            </div>

            <!-- Budget Tracker (TRK-4) -->
            <div style="background:var(--surface-alt); padding:0.75rem; border-radius:8px; margin-bottom:0.9rem;">
              <div style="display:flex; justify-content:space-between; font-size:0.85rem; font-weight:700;">
                <span>Budget (${escapeHtml(c.budget.occasion)}): $${c.budget.spent.toFixed(2)} / ${c.budget.limit ? `$${c.budget.limit.toFixed(2)}` : 'No limit set'}</span>
                ${c.budget.over_budget ? '<span class="badge badge-most-wanted">⚠ Over Budget</span>' : ''}
                <button class="btn btn-secondary btn-sm" style="padding:0.15rem 0.5rem;" data-set-budget="${escapeHtml(c.person.id)}" data-person-name="${escapeHtml(c.person.name)}" type="button">Edit Budget</button>
              </div>
              ${c.budget.limit ? `
                <div class="progress-bar">
                  <div class="progress-fill ${c.budget.over_budget ? 'over-budget' : ''}" style="width:${pct}%"></div>
                </div>
              ` : ''}
            </div>

            <!-- Lists & Top Priorities -->
            <div style="margin-bottom:0.85rem;">
              <h3 style="font-size:0.86rem; text-transform:uppercase; color:var(--text-muted); margin:0 0 0.4rem;">Shared Lists</h3>
              <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
                ${c.lists.map(l => `
                  <button class="btn btn-primary btn-sm" data-open-shared="${escapeHtml(l.share_token)}" type="button">
                    Shop "${escapeHtml(l.name)}" (${l.items.length} items) →
                  </button>
                `).join('')}
              </div>
            </div>

            <!-- Secret Ideas for this Person (GVR-5: Invisible to Recipient!) -->
            <div style="border-top:1px solid var(--border); padding-top:0.75rem;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
                <h3 style="font-size:0.86rem; margin:0; color:var(--primary);">🔒 Secret Ideas for ${escapeHtml(c.person.name)} (Hidden from them)</h3>
                <button class="btn btn-secondary btn-sm" data-add-secret="${escapeHtml(c.person.id)}" data-person-name="${escapeHtml(c.person.name)}" type="button">+ Add Secret Idea</button>
              </div>
              ${c.secret_ideas.length === 0 ? `<p style="font-size:0.82rem; color:var(--text-muted); margin:0;">No secret ideas posted yet.</p>` : `
                <ul style="margin:0; padding-left:1.1rem; font-size:0.84rem;">
                  ${c.secret_ideas.map(si => `
                    <li style="margin-bottom:0.3rem;">
                      <strong>${escapeHtml(si.title)}</strong> ${si.estimated_price ? `($${Number(si.estimated_price).toFixed(2)})` : ''}
                      — <em>${escapeHtml(si.note || '')}</em> (by ${escapeHtml(si.author_name)})
                    </li>
                  `).join('')}
                </ul>
              `}
            </div>
          </section>
        `;
      }).join('')}
    </div>
  `;
}

function bindDashboardEvents() {
  document.getElementById('btn-generate-digest')?.addEventListener('click', async () => {
    const res = await api('/api/notifications/digest', { method: 'POST' });
    if (res.digest.already_sent_today) {
      showToast('Daily digest already sent today (max 1 digest/day per Section 16). Check Notification Inbox!');
    } else {
      showToast(`Follower digest generated (${res.digest.events_included} updates)! View it in Notification Inbox.`);
    }
  });

  document.querySelectorAll('[data-block-follow]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/follows/${btn.dataset.blockFollow}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'blocked' })
      });
      showToast('Follower blocked (access revoked immediately per FOL-2).');
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-approve-follow]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/follows/${btn.dataset.approveFollow}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'approved' })
      });
      showToast('Follower access restored.');
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-open-shared]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sharedListToken = btn.dataset.openShared;
      state.activeTab = 'shared-giver';
      updateNavTabs();
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-add-secret]').forEach(btn => {
    btn.addEventListener('click', () => openSecretIdeaModal(btn.dataset.addSecret, btn.dataset.personName));
  });

  document.querySelectorAll('[data-set-budget]').forEach(btn => {
    btn.addEventListener('click', () => openBudgetModal(btn.dataset.setBudget, btn.dataset.personName));
  });
}

// ============================================================================
// TAB 3: MY CLAIMS TRACKER ACROSS EVERYONE (TRK-3, GVR-2, GVR-3)
// ============================================================================
function renderMyClaimsTab() {
  const claims = state.dashboardData?.my_claims_tracker || [];

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">My Claims Tracker Across All Recipients (TRK-3)</h2>
          <p style="margin:0.25rem 0 0; font-size:0.88rem; color:var(--text-muted);">
            Manage reservations, respond to "Did you buy it?" return prompts after clicking out to a store, and track gifts from Reserved → Purchased → Given.
          </p>
        </div>
      </div>

      ${claims.length === 0 ? `<p>You haven't reserved any items yet. Visit "People I Shop For" or "Giver / Shared Link View" to claim a gift!</p>` : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Recipient &amp; List</th>
              <th>Item &amp; Store</th>
              <th>Price / Qty</th>
              <th>Status</th>
              <th>Order Note</th>
              <th>Actions &amp; "Did You Buy It?" (GVR-3)</th>
            </tr>
          </thead>
          <tbody>
            ${claims.map(c => `
              <tr>
                <td>
                  <strong>${escapeHtml(c.recipient_name)}</strong><br/>
                  <span style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(c.list_name)}</span>
                </td>
                <td>
                  <strong>${escapeHtml(c.item_title)}</strong>
                  ${c.item_variant ? `<div style="font-size:0.78rem; color:var(--text-muted);">${escapeHtml(c.item_variant)}</div>` : ''}
                  <span class="badge badge-normal">${escapeHtml(c.item_store || 'Store')}</span>
                </td>
                <td>
                  ${c.item_price ? `$${Number(c.item_price).toFixed(2)}` : '—'} (Qty: ${c.qty})
                </td>
                <td>
                  <span class="badge ${c.status === 'purchased' || c.status === 'given' ? 'badge-available' : c.status === 'withdrawn' ? 'badge-most-wanted' : 'badge-high'}">
                    ${escapeHtml(c.status.toUpperCase())}
                  </span>
                </td>
                <td>${escapeHtml(c.order_note || '—')}</td>
                <td>
                  <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
                    ${c.item_url ? `
                      <a class="btn btn-secondary btn-sm" href="${escapeHtml(c.item_url)}" target="_blank" rel="noopener noreferrer" data-clickout="${escapeHtml(c.id)}" data-store="${escapeHtml(c.item_store || '')}">
                        Go to Store ↗
                      </a>
                    ` : ''}
                    ${c.status === 'reserved' ? `
                      <button class="btn btn-emerald btn-sm" data-claim-state="${escapeHtml(c.id)}" data-next="purchased" type="button">✓ Mark Purchased</button>
                      <button class="btn btn-danger btn-sm" data-claim-state="${escapeHtml(c.id)}" data-next="released" type="button">Release</button>
                    ` : ''}
                    ${c.status === 'purchased' ? `
                      <button class="btn btn-primary btn-sm" data-claim-state="${escapeHtml(c.id)}" data-next="given" type="button">🎁 Mark Wrapped / Given</button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

function bindMyClaimsEvents() {
  document.querySelectorAll('[data-clickout]').forEach(link => {
    link.addEventListener('click', async () => {
      await api(`/api/claims/${link.dataset.clickout}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'click_out', store: link.dataset.store })
      });
    });
  });

  document.querySelectorAll('[data-claim-state]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/claims/${btn.dataset.claimState}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: btn.dataset.next })
      });
      showToast(`Claim updated to "${btn.dataset.next}"!`);
      refreshAndRender();
    });
  });
}

// ============================================================================
// TAB 4: GIVER / SHARED LINK VIEW (Flow B, Guest Verification, Return Prompt, Helper Controls)
// ============================================================================
function renderSharedGiverTab(allLists) {
  const list = state.sharedList;
  if (!list) return `<div class="card"><p>Shared list not found.</p></div>`;

  // Check if current viewer has any claim on this list that was clicked out and needs "Did you buy it?" prompt (GVR-3)
  const pendingReturnClaims = [];
  for (const item of list.items) {
    for (const c of (item.claim_summary?.claims || [])) {
      if (c.is_own_claim && c.status === 'reserved' && c.clicked_out_at && !c.return_prompt_answered) {
        pendingReturnClaims.push({ claim: c, item });
      }
    }
  }

  return `
    <div class="card" style="margin-bottom:1.25rem;">
      <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:1rem;">
        <div>
          <label for="shared-list-picker" style="font-size:0.8rem; font-weight:700; color:var(--text-muted); display:block;">
            Switch Shared Wishlist Link:
          </label>
          <select id="shared-list-picker" class="form-control" style="min-width:300px; font-weight:700;">
            ${allLists.map(l => `
              <option value="${escapeHtml(l.share_token)}" ${l.share_token === list.share_token ? 'selected' : ''}>
                ${escapeHtml(l.name)} (by ${escapeHtml(l.owner_name)})
              </option>
            `).join('')}
          </select>
        </div>

        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span class="badge badge-surprise">Your Role on this List: ${escapeHtml(list.viewer_role.toUpperCase())}</span>
          ${list.can_release_claims ? `<span class="badge badge-available">★ List Helper / Guardian Controls Active (LST-4)</span>` : ''}
          ${!state.currentUser ? `<button class="btn btn-secondary btn-sm" id="btn-shared-make-own" type="button">Make Your Own List (Flow D)</button>` : ''}
        </div>
      </div>
    </div>

    ${renderSortFilterToolbar()}

    ${pendingReturnClaims.map(({ claim, item }) => `
      <div class="banner-shield" style="background:#fffbeb; border-color:#f59e0b;">
        <div>
          <strong>"Did you buy it?" Return Prompt (GVR-3):</strong>
          You visited <strong>${escapeHtml(item.store || 'the store')}</strong> for <strong>"${escapeHtml(item.title)}"</strong>. Did you complete the purchase?
        </div>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-emerald btn-sm" data-return-prompt="${escapeHtml(claim.id)}" data-answer="bought" type="button">Yes, I Bought It!</button>
          <button class="btn btn-secondary btn-sm" data-return-prompt="${escapeHtml(claim.id)}" data-answer="not_yet" type="button">Not Yet (Keep Reserved)</button>
          <button class="btn btn-danger btn-sm" data-return-prompt="${escapeHtml(claim.id)}" data-answer="released" type="button">No, Release Claim</button>
        </div>
      </div>
    `).join('')}

    ${list.viewer_role === 'owner' && list.surprise_mode ? `
      <div class="banner-shield">
        <div>
          <strong>Owner Preview Note:</strong> You are viewing your own list while Surprise Mode is ON. All reservation states, claimer names, and group contributions are completely hidden from you so nothing is spoiled! Switch "Viewing As" in the top bar to <em>Aunt Elena</em>, <em>Maya</em>, or <em>Guest Giver</em> to test claiming.
        </div>
      </div>
    ` : ''}

    <div class="grid-3">
      ${applySortAndFilter(list.items).map(item => renderGiverItemCard(item, list)).join('')}
    </div>
  `;
}

function renderGiverItemCard(item, list) {
  const cs = item.claim_summary;
  const isTaken = cs?.is_fully_claimed;
  const priorityLabel = {
    most_wanted: '★ Most Wanted',
    high: 'High Priority',
    normal: 'Wanted',
    low: 'Nice to Have'
  }[item.priority] || 'Wanted';
  const priorityClass = item.priority === 'most_wanted' ? 'badge-most-wanted' : item.priority === 'high' ? 'badge-high' : 'badge-normal';

  return `
    <article class="item-card ${isTaken ? 'taken' : ''}">
      <img class="item-thumb" src="${escapeHtml(item.image || '/api/image-proxy?label=Gift')}" alt="${escapeHtml(item.title)}" loading="lazy" />
      <div class="item-body">
        <div class="item-meta-row">
          <span class="badge ${priorityClass}">${escapeHtml(priorityLabel)}</span>
          <span class="badge badge-normal">${escapeHtml(item.store || item.kind)}</span>
          ${!item.in_stock ? '<span class="badge badge-most-wanted">Out of Stock</span>' : ''}
          ${item.price_drop_percent >= 5 ? `<span class="badge badge-available">📉 -${item.price_drop_percent}% Price Drop</span>` : ''}
          ${cs ? `
            <span class="badge ${isTaken ? 'badge-taken' : 'badge-available'}">
              ${escapeHtml(cs.availability_label)}
            </span>
          ` : ''}
        </div>

        <h3 style="margin:0.15rem 0; font-size:1.05rem;">${escapeHtml(item.title)}</h3>

        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <span class="price-tag">${item.price !== null && item.price !== undefined ? `$${Number(item.price).toFixed(2)}` : 'Flexible'}</span>
            ${renderPriceSparklineSvg(item.price_history)}
          </div>
          ${cs ? `<span style="font-size:0.82rem; color:var(--text-muted);">${item.always_wanted ? 'Unlimited quantity' : `${cs.qty_remaining} of ${item.qty_wanted} available`}</span>` : ''}
        </div>

        ${item.variant ? `<div style="font-size:0.85rem;"><strong>Size / Color:</strong> ${escapeHtml(item.variant)}</div>` : ''}
        ${item.notes ? `<div style="font-size:0.85rem; color:var(--text-muted);">"${escapeHtml(item.notes)}"</div>` : ''}
        ${item.any_similar ? `<div style="font-size:0.8rem; color:var(--emerald); font-weight:600;">✓ Any similar item is fine</div>` : ''}
        ${item.giving_instructions ? `<div style="font-size:0.8rem; background:var(--surface-alt); padding:0.4rem 0.6rem; border-radius:6px;"><strong>Giving Instructions:</strong> ${escapeHtml(item.giving_instructions)}</div>` : ''}

        <!-- Group Chip-In Progress Bar (GVR-4) -->
        ${cs && item.allow_group_chip_in && item.price > 0 ? `
          <div style="background:var(--surface-alt); padding:0.6rem; border-radius:8px; margin-top:0.3rem;">
            <div style="display:flex; justify-content:space-between; font-size:0.8rem; font-weight:700;">
              <span>Group Chip-In Progress</span>
              <span>$${cs.pledged_total.toFixed(2)} of $${cs.pledged_target.toFixed(2)} pledged</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width:${Math.min(100, Math.round((cs.pledged_total / cs.pledged_target) * 100))}%"></div>
            </div>
            ${cs.contributions.map(cnt => `
              <div style="font-size:0.76rem; color:var(--text-muted);">• ${escapeHtml(cnt.contributor_display)}: $${Number(cnt.pledged_amount).toFixed(2)}</div>
            `).join('')}
          </div>
        ` : ''}

        <!-- Existing Claims visible to Givers / Helpers -->
        ${cs && cs.claims.length > 0 ? `
          <div style="font-size:0.8rem; background:#f8fafc; border:1px solid var(--border); padding:0.5rem; border-radius:8px;">
            ${cs.claims.map(c => `
              <div style="display:flex; justify-content:space-between; align-items:center; gap:0.4rem; margin-bottom:0.25rem;">
                <span>
                  <strong>${escapeHtml(c.claimer_display)}</strong>: ${escapeHtml(c.status)} (${c.qty})
                </span>
                <div style="display:flex; gap:0.25rem;">
                  ${c.is_own_claim && c.status === 'reserved' ? `
                    <button class="btn btn-emerald btn-sm" style="padding:0.15rem 0.45rem; font-size:0.74rem;" data-giver-confirm="${escapeHtml(c.id)}" type="button">Confirm Bought</button>
                  ` : ''}
                  ${(c.is_own_claim || list.can_release_claims) ? `
                    <button class="btn btn-danger btn-sm" style="padding:0.15rem 0.45rem; font-size:0.74rem;" data-giver-release="${escapeHtml(c.id)}" data-is-helper="${list.can_release_claims && !c.is_own_claim ? '1' : '0'}" type="button">
                      ${list.can_release_claims && !c.is_own_claim ? 'Helper Release' : 'Release'}
                    </button>
                  ` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div style="margin-top:auto; padding-top:0.75rem; display:flex; flex-wrap:wrap; gap:0.45rem;">
          ${list.viewer_role !== 'owner' ? `
            ${!isTaken ? `
              <button class="btn btn-primary btn-sm" data-reserve-item="${escapeHtml(item.id)}" type="button">
                Reserve Gift ${!state.currentUser ? '(No Account Needed)' : ''}
              </button>
            ` : ''}
            ${item.allow_group_chip_in && !isTaken ? `
              <button class="btn btn-secondary btn-sm" data-chip-in="${escapeHtml(item.id)}" type="button">Chip In $</button>
            ` : ''}
          ` : ''}

          ${item.canonical_url ? `
            <a class="btn btn-secondary btn-sm" href="${escapeHtml(item.canonical_url)}" target="_blank" rel="noopener noreferrer" data-store-out="${escapeHtml(item.id)}" data-store-name="${escapeHtml(item.store || '')}">
              Go to Store ↗
            </a>
          ` : ''}
        </div>
      </div>
    </article>
  `;
}

function bindSharedGiverEvents() {
  bindSortFilterEvents();
  document.getElementById('btn-shared-make-own')?.addEventListener('click', () => {
    document.getElementById('btn-quick-signup')?.click();
  });

  const picker = document.getElementById('shared-list-picker');
  if (picker) {
    picker.addEventListener('change', () => {
      state.sharedListToken = picker.value;
      refreshAndRender();
    });
  }

  document.querySelectorAll('[data-reserve-item]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.sharedList?.items.find(i => i.id === btn.dataset.reserveItem);
      if (item) openReserveModal(item);
    });
  });

  document.querySelectorAll('[data-chip-in]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.sharedList?.items.find(i => i.id === btn.dataset.chipIn);
      if (item) openChipInModal(item);
    });
  });

  document.querySelectorAll('[data-giver-confirm]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/claims/${btn.dataset.giverConfirm}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'purchased', manage_token: state.guestToken })
      });
      showToast('Purchase confirmed! Thank you for keeping the list accurate.');
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-giver-release]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isHelper = btn.dataset.isHelper === '1';
      await api(`/api/claims/${btn.dataset.giverRelease}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'released',
          actor_type: isHelper ? 'helper' : 'giver',
          manage_token: state.guestToken,
          reason: isHelper ? 'Released by trusted list helper (LST-4)' : 'Released by giver'
        })
      });
      showToast(isHelper ? 'Helper released claim (owner sees nothing!)' : 'Reservation released.');
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-return-prompt]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/claims/${btn.dataset.returnPrompt}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'answer_return_prompt',
          answer: btn.dataset.answer,
          manage_token: state.guestToken
        })
      });
      showToast(`Return prompt recorded: ${btn.dataset.answer}`);
      refreshAndRender();
    });
  });

  document.querySelectorAll('[data-store-out]').forEach(link => {
    link.addEventListener('click', async () => {
      const item = state.sharedList?.items.find(i => i.id === link.dataset.storeOut);
      const ownClaim = item?.claim_summary?.claims?.find(c => c.is_own_claim);
      if (ownClaim) {
        await api(`/api/claims/${ownClaim.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ action: 'click_out', store: link.dataset.storeName })
        });
        setTimeout(() => refreshAndRender(), 400);
      }
    });
  });
}

// ============================================================================
// TAB 5: FAMILY GROUPS & VERIFIABLE SECRET SANTA (SHR-2, EXC-1)
// ============================================================================
function renderGroupsTab() {
  return `
    <div class="banner-shield">
      <div>
        <strong>Private Family Groups &amp; Secret Santa (SHR-2 &amp; EXC-1):</strong>
        Run a Secret Santa gift exchange with partner/spouse exclusions where even the organizer does not see everyone's pairings—verified mathematically via SHA-256 draw commitment!
      </div>
    </div>

    ${state.groups.map(g => `
      <div class="card" style="margin-bottom:1.25rem;">
        <div class="card-header">
          <div>
            <h2 class="card-title">${escapeHtml(g.name)}</h2>
            <p style="margin:0.2rem 0 0; font-size:0.88rem; color:var(--text-muted);">
              ${escapeHtml(g.description || '')} · Invite Code: <code>${escapeHtml(g.invite_code)}</code>
            </p>
          </div>
          <button class="btn btn-primary btn-sm" data-run-santa="${escapeHtml(g.id)}" type="button">🎅 Run New Secret Santa Draw</button>
        </div>

        <div style="margin-bottom:1rem;">
          <h3 style="font-size:0.85rem; text-transform:uppercase; color:var(--text-muted); margin:0 0 0.4rem;">Group Members (${g.members.length})</h3>
          <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
            ${g.members.map(m => `<span class="badge badge-normal">${escapeHtml(m.name)} (${escapeHtml(m.role)})</span>`).join('')}
          </div>
        </div>

        ${g.exchanges.length > 0 ? `
          <div style="border-top:1px solid var(--border); padding-top:0.85rem;">
            <h3 style="font-size:0.95rem; margin:0 0 0.5rem;">Active Secret Santa Exchanges (EXC-1)</h3>
            ${g.exchanges.map(ex => `
              <div style="background:var(--surface-alt); padding:0.85rem; border-radius:8px; margin-bottom:0.5rem;">
                <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
                  <strong>${escapeHtml(ex.name)} (Event: ${escapeHtml(ex.event_date)} · Budget: $${ex.budget_limit})</strong>
                  <span class="badge badge-available">✓ Draw Complete (${ex.participant_count} participants paired)</span>
                </div>
                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.25rem;">
                  Zero-Knowledge Completeness Commitment Hash: <code>${escapeHtml(ex.verification_hash.slice(0, 32))}...</code> (Organizer cannot view all pairs)
                </div>
                ${ex.my_assigned_recipient ? `
                  <div style="margin-top:0.5rem; padding:0.5rem 0.75rem; background:var(--primary-soft); color:var(--primary); border-radius:6px; font-weight:700;">
                    🤫 Your Secret Santa Assignment (Visible only to you): You are gifting to <u>${escapeHtml(ex.my_assigned_recipient.name)}</u>!
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `).join('')}
  `;
}

function bindGroupsEvents() {
  document.querySelectorAll('[data-run-santa]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const groupId = btn.dataset.runSanta;
      await api('/api/secret-santa', {
        method: 'POST',
        body: JSON.stringify({
          group_id: groupId,
          name: 'Winter 2026 Family Secret Santa',
          event_date: '2026-12-25',
          budget_limit: 75,
          // Exclude spouses Justin & Maya from drawing each other
          exclusions: [['usr_justin', 'usr_maya']]
        })
      });
      showToast('Secret Santa draw completed with spouse exclusions! Check your private assignment.');
      refreshAndRender();
    });
  });
}

// ============================================================================
// TAB 6: SPOILER-SAFE NOTIFICATION INBOX (Section 16, NTF-1..3)
// ============================================================================
function renderInboxTab() {
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Spoiler-Checked Notification Outbox (Section 16)</h2>
          <p style="margin:0.25rem 0 0; font-size:0.88rem; color:var(--text-muted);">
            Every outbound email/notification is filtered by <code>notifications.mjs</code>: nothing sent to a list owner ever reveals claims on their own surprise-mode list.
          </p>
        </div>
        ${state.currentUser ? `
          <button class="btn btn-primary btn-sm" id="btn-inbox-digest" type="button">📬 Generate Daily Digest</button>
        ` : ''}
      </div>

      ${state.notifications.length === 0 ? `<p>No notifications for the current viewer yet.</p>` : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Recipient</th>
              <th>Event Type</th>
              <th>Subject &amp; Body</th>
              <th>Policy Info</th>
            </tr>
          </thead>
          <tbody>
            ${state.notifications.map(n => `
              <tr>
                <td style="white-space:nowrap;">${escapeHtml(n.created_at.slice(0, 19).replace('T', ' '))}</td>
                <td>${escapeHtml(n.recipient_email)}</td>
                <td><span class="badge badge-surprise">${escapeHtml(n.event_type)}</span></td>
                <td>
                  <strong>${escapeHtml(n.subject)}</strong>
                  <div style="font-size:0.82rem; color:var(--text-muted); white-space:pre-line;">${escapeHtml(n.body)}</div>
                </td>
                <td>
                  <span class="badge badge-normal">${n.transactional ? 'Transactional' : 'One-Click Unsub'}</span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

function bindInboxEvents() {
  document.getElementById('btn-inbox-digest')?.addEventListener('click', async () => {
    const res = await api('/api/notifications/digest', { method: 'POST' });
    if (res.digest.already_sent_today) {
      showToast('Daily digest already sent today (max 1 digest/day per Section 16).');
    } else {
      showToast(`Follower digest sent (${res.digest.events_included} updates)!`);
    }
    refreshAndRender();
  });
}

// ============================================================================
// TAB 7: ADMIN CONSOLE & RETAILER ADAPTER CONFIG (ADM-1, SAF-1, Section 7 & 18)
// ============================================================================
function renderAdminTab() {
  const adapters = state.adminData?.retailer_adapters || [];
  const events = state.adminData?.analytics_events || [];
  const audit = state.adminData?.claim_audit_log || [];
  const overridable = state.adminData?.overridable_claims || [];

  return `
    <div class="grid-2" style="margin-bottom:1.25rem;">
      <div class="card">
        <h2 class="card-title">Audited Admin Claim Overrides (ADM-1)</h2>
        <p style="font-size:0.84rem; color:var(--text-muted);">
          Force-release stuck or bad claims with a mandatory audit reason written to <code>claim_events</code>. Claims on your own or co-owned surprise-mode lists are strictly hidden (ADV-1.2).
        </p>
        ${overridable.length === 0 ? `<p style="font-size:0.84rem;">No overridable claims on non-owned lists.</p>` : `
          <div style="max-height:220px; overflow-y:auto;">
            <table class="data-table">
              <thead>
                <tr><th>List &amp; Item</th><th>Claimer / Status</th><th>Action</th></tr>
              </thead>
              <tbody>
                ${overridable.map(c => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(c.item_title)}</strong><br/>
                      <span style="font-size:0.76rem; color:var(--text-muted);">${escapeHtml(c.list_name)}</span>
                    </td>
                    <td>${escapeHtml(c.claimer_name || c.guest_email || 'Guest')} (${escapeHtml(c.status)})</td>
                    <td>
                      <button class="btn btn-danger btn-sm" data-admin-override="${escapeHtml(c.id)}" data-item-title="${escapeHtml(c.item_title)}" type="button">Force Release</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <div class="card">
        <h2 class="card-title">Claim Lifecycle Audit Log (ADM-1)</h2>
        <p style="font-size:0.84rem; color:var(--text-muted);">
          Every claim state transition and admin override reason is recorded here (excluding your own surprise-mode lists).
        </p>
        <div style="max-height:220px; overflow-y:auto;">
          <table class="data-table">
            <thead>
              <tr><th>Item</th><th>Transition</th><th>Actor &amp; Reason</th></tr>
            </thead>
            <tbody>
              ${audit.map(a => `
                <tr>
                  <td>${escapeHtml(a.item_title)}</td>
                  <td>${escapeHtml(a.from_state || 'new')} → <strong>${escapeHtml(a.to_state)}</strong></td>
                  <td>${escapeHtml(a.actor)}: ${escapeHtml(a.reason || '')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:1.25rem;">
      <h2 class="card-title">First-Party Privacy Analytics (Section 18)</h2>
      <p style="font-size:0.84rem; color:var(--text-muted);">
        Tracks capture latency, per-field confidence, and purchase confirmation without third-party ad trackers or item titles/URLs in payloads.
      </p>
      <div style="max-height:190px; overflow-y:auto;">
        <table class="data-table">
          <thead>
            <tr><th>Event</th><th>Properties (Zero PII/Titles)</th></tr>
          </thead>
          <tbody>
            ${events.slice(0, 12).map(ev => `
              <tr>
                <td><strong>${escapeHtml(ev.event_name)}</strong></td>
                <td><code style="font-size:0.76rem;">${escapeHtml(ev.properties)}</code></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Top 30 Store Retailer Adapters (Section 7 — Config, Not Code)</h2>
          <p style="margin:0.2rem 0 0; font-size:0.85rem; color:var(--text-muted);">
            Selectors are stored in SQLite config so store layout changes can be updated live without redeploying code. Notice <code>amazon.com</code> is marked <strong>Client-Only (D3)</strong>.
          </p>
        </div>
      </div>
      <div style="max-height:360px; overflow-y:auto;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Store</th>
              <th>Title Selector</th>
              <th>Price Selector</th>
              <th>Policy (D3)</th>
              <th>Success Rate</th>
            </tr>
          </thead>
          <tbody>
            ${adapters.map(a => {
              const rate = a.capture_attempts > 0 ? Math.round((a.capture_successes / a.capture_attempts) * 100) : 100;
              return `
                <tr>
                  <td><code>${escapeHtml(a.domain)}</code></td>
                  <td><strong>${escapeHtml(a.store_name)}</strong></td>
                  <td><code>${escapeHtml(a.title_selector || '')}</code></td>
                  <td><code>${escapeHtml(a.price_selector || '')}</code></td>
                  <td>
                    <span class="badge ${a.client_only ? 'badge-most-wanted' : 'badge-available'}">
                      ${a.client_only ? 'Client Extension Only (D3)' : 'Browser + Server Fallback'}
                    </span>
                  </td>
                  <td><strong>${rate}%</strong> (${a.capture_successes}/${a.capture_attempts})</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function bindAdminEvents() {
  document.querySelectorAll('[data-admin-override]').forEach(btn => {
    btn.addEventListener('click', () => {
      openAdminOverrideModal(btn.dataset.adminOverride, btn.dataset.itemTitle);
    });
  });
}

function openAdminOverrideModal(claimId, itemTitle) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Audited Admin Claim Override (ADM-1)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" aria-label="Close dialog" type="button">✕</button>
        </div>
        <p style="font-size:0.84rem; color:var(--text-muted); margin-top:0;">
          Releasing reservation on <strong>"${escapeHtml(itemTitle)}"</strong>. Every admin override requires an explicit reason recorded in the immutable audit log.
        </p>
        <form id="form-admin-override">
          <div class="form-group">
            <label for="adm-reason">Mandatory Audit Reason *</label>
            <input id="adm-reason" class="form-control" required placeholder="e.g., Duplicate reservation reported by family organizer" />
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-adm">Cancel</button>
            <button type="submit" class="btn btn-danger">Confirm Audited Release</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-adm').addEventListener('click', closeModal);
  document.getElementById('form-admin-override').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/admin/claims/override', {
      method: 'POST',
      body: JSON.stringify({
        claim_id: claimId,
        new_state: 'released',
        reason: document.getElementById('adm-reason').value.trim()
      })
    });
    closeModal();
    showToast('Claim released and recorded in Admin Audit Log!');
    refreshAndRender();
  });
}

function openIosShortcutModal() {
  const origin = window.location.origin;
  const bookmarkletCode = `javascript:void(window.open('${origin}/share-target?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)))`;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">📱 iPhone &amp; iPad Safari Save Button (Section 7 &amp; D4)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" aria-label="Close dialog" type="button">✕</button>
        </div>
        <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">
          Because iOS Safari does not support PWA Web Share Target directly, Hushlist provides a 1-tap <strong>iOS Shortcut / Mobile Bookmarklet</strong> so iPhone users can save any product page in under 5 seconds without needing a native app install!
        </p>
        <div class="form-group">
          <label for="bm-code">1-Tap Bookmarklet / iOS Shortcut Action URL:</label>
          <textarea id="bm-code" class="form-control" rows="3" readonly>${escapeHtml(bookmarkletCode)}</textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
          <button type="button" class="btn btn-secondary" id="btn-copy-bm">Copy Bookmarklet Code</button>
          <button type="button" class="btn btn-primary" id="btn-done-bm">Done</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-done-bm').addEventListener('click', closeModal);
  document.getElementById('btn-copy-bm').addEventListener('click', () => {
    navigator.clipboard?.writeText(bookmarkletCode);
    showToast('iOS Safari Bookmarklet copied to clipboard!');
  });
}

// ============================================================================
// MODALS: ADD ITEM (WITH LAYERED AUTO-CAPTURE), RESERVE (WITH GUEST 6-DIGIT CODE),
// CHIP-IN, AMAZON IMPORT, SECRET IDEA, SHARE QR, ONBOARDING
// ============================================================================
function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

function openAddItemModal(listId, prefillUrl = '', prefillTitle = '') {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-add-title">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title" id="modal-add-title">Add Item to Wishlist (Flow A — Under 10 Seconds)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>

        <div class="form-group" style="background:var(--surface-alt); padding:0.85rem; border-radius:8px;">
          <label for="capture-url">1. Paste Product Link from Any Store (or pick a live sample below to test auto-extraction):</label>
          <div style="display:flex; gap:0.5rem; margin-bottom:0.5rem;">
            <input id="capture-url" class="form-control" type="url" placeholder="https://www.target.com/p/..." value="${escapeHtml(prefillUrl)}" />
            <button id="btn-run-capture" class="btn btn-primary" type="button">Auto-Fill Fields</button>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:0.35rem; font-size:0.78rem;">
            <span style="color:var(--text-muted); font-weight:600;">Quick Sample Links:</span>
            <button type="button" class="btn btn-secondary btn-sm" style="padding:0.15rem 0.45rem;" data-sample="target">Target Espresso Maker</button>
            <button type="button" class="btn btn-secondary btn-sm" style="padding:0.15rem 0.45rem;" data-sample="etsy">Etsy Linen Apron</button>
            <button type="button" class="btn btn-secondary btn-sm" style="padding:0.15rem 0.45rem;" data-sample="rei">REI Camping Hammock</button>
            <button type="button" class="btn btn-secondary btn-sm" style="padding:0.15rem 0.45rem;" data-sample="amazon">Amazon Link (Tests D3 Policy)</button>
          </div>
          <div id="capture-notice" style="margin-top:0.5rem; font-size:0.82rem;"></div>
        </div>

        <form id="form-add-item">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:0.75rem;">
            <div class="form-group">
              <label for="item-kind">Item Type (ITM-4)</label>
              <select id="item-kind" class="form-control">
                <option value="product">Product with Link</option>
                <option value="experience">Experience / Event (No URL needed)</option>
                <option value="cash">Cash / Gift Card Fund</option>
                <option value="idea">General Idea / Any Book or Brand</option>
              </select>
            </div>
            <div class="form-group">
              <label for="item-priority">Priority (ITM-3)</label>
              <select id="item-priority" class="form-control">
                <option value="most_wanted">★ Most Wanted</option>
                <option value="high">High Priority</option>
                <option value="normal" selected>Wanted</option>
                <option value="low">Nice to Have</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label for="item-title">Title * <span id="conf-title" style="font-weight:400; font-size:0.78rem;"></span></label>
            <input id="item-title" class="form-control" required value="${escapeHtml(prefillTitle)}" placeholder="e.g., Breville Bambino Plus Espresso Machine or Pottery Class" />
          </div>

          <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:0.75rem;">
            <div class="form-group">
              <label for="item-price">Price ($) <span id="conf-price" style="font-weight:400; font-size:0.78rem;"></span></label>
              <input id="item-price" class="form-control" type="number" step="0.01" placeholder="89.00" />
            </div>
            <div class="form-group">
              <label for="item-store">Store <span id="conf-store" style="font-weight:400; font-size:0.78rem;"></span></label>
              <input id="item-store" class="form-control" placeholder="Target, Etsy, Local..." />
            </div>
            <div class="form-group">
              <label for="item-qty">Quantity Wanted</label>
              <input id="item-qty" class="form-control" type="number" min="1" value="1" />
            </div>
          </div>

          <div class="form-group">
            <label for="item-variant">Size / Color / Variant (ITM-3) <span id="conf-variant" style="font-weight:400; font-size:0.78rem;"></span></label>
            <input id="item-variant" class="form-control" placeholder="e.g., Size Medium / Sage Green" />
          </div>

          <div class="form-group">
            <label for="item-notes">Notes for Gift-Givers</label>
            <input id="item-notes" class="form-control" placeholder="Any extra details or coupon code..." />
          </div>

          <div style="display:flex; flex-wrap:wrap; gap:1rem; margin-bottom:1rem; font-size:0.86rem;">
            <label><input type="checkbox" id="item-any-similar" /> Any similar item is fine</label>
            <label><input type="checkbox" id="item-chip-in" /> Enable Group Chip-In (split cost across givers)</label>
            <label><input type="checkbox" id="item-always-wanted" /> "Always Wanted" (unlimited quantity)</label>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-item">Cancel</button>
            <button type="submit" class="btn btn-primary">Save to Wishlist</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-item').addEventListener('click', closeModal);

  const samplePayloads = {
    target: {
      url: 'https://www.target.com/p/breville-bambino-plus-espresso/-/A-89101112?utm_source=share',
      html: `<h1 data-test="product-title">Breville Bambino Plus Stainless Espresso Maker</h1><span data-test="product-price">$399.95</span><span data-test="variant-value">Brushed Stainless Steel</span><meta property="og:image" content="https://images.target.com/breville.jpg" />`
    },
    etsy: {
      url: 'https://www.etsy.com/listing/7712345/japanese-washed-linen-crossback-apron?fbclid=123',
      html: `<script type="application/ld+json">{"@type":"Product","name":"Japanese Washed Linen Crossback Pinafore Apron","color":"Moss Green","image":"https://i.etsystatic.com/apron.jpg","offers":{"price":"64.00","priceCurrency":"USD"}}</script>`
    },
    rei: {
      url: 'https://www.rei.com/product/eno-doublenest-hammock-2026',
      html: `<meta property="og:title" content="ENO DoubleNest Print Camping Hammock" /><meta property="product:price:amount" content="74.95" /><meta property="og:image" content="https://rei.com/hammock.jpg" /><meta property="product:color" content="Pine Forest / Charcoal" />`
    },
    amazon: {
      url: 'https://www.amazon.com/dp/B09V3KXJPB?psc=1&pf_rd_r=XYZ123',
      html: null
    }
  };

  let currentSampleHtml = null;
  let lastConfidence = {};

  document.querySelectorAll('[data-sample]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = samplePayloads[btn.dataset.sample];
      document.getElementById('capture-url').value = s.url;
      currentSampleHtml = s.html;
      document.getElementById('btn-run-capture').click();
    });
  });

  document.getElementById('btn-run-capture').addEventListener('click', async () => {
    const rawUrl = document.getElementById('capture-url').value.trim();
    if (!rawUrl) return;
    const noticeEl = document.getElementById('capture-notice');
    noticeEl.textContent = 'Running 4-layer extraction...';
    try {
      const res = await api('/api/capture', {
        method: 'POST',
        body: JSON.stringify({ url: rawUrl, html: currentSampleHtml })
      });
      currentSampleHtml = null;
      const cap = res.capture;
      lastConfidence = cap.field_confidence || {};

      if (cap.title) document.getElementById('item-title').value = cap.title;
      if (cap.price !== null && cap.price !== undefined) document.getElementById('item-price').value = cap.price;
      if (cap.store) document.getElementById('item-store').value = cap.store;
      if (cap.variant) document.getElementById('item-variant').value = cap.variant;

      // Highlight low-confidence fields (< 0.75) per Section 5 & Section 7
      applyConfidenceIndicator('item-title', 'conf-title', lastConfidence.title);
      applyConfidenceIndicator('item-price', 'conf-price', lastConfidence.price);
      applyConfidenceIndicator('item-store', 'conf-store', lastConfidence.store);
      applyConfidenceIndicator('item-variant', 'conf-variant', lastConfidence.variant);

      const msgs = [];
      if (cap.notice) msgs.push(`⚠️ ${cap.notice}`);
      if (res.duplicate_warning) msgs.push(`⚠️ Duplicate Check (ITM-7): ${res.duplicate_warning.message}`);
      if (!cap.notice) msgs.push(`✓ Extracted via layered engine (${Object.values(cap.extraction_layers_used || {}).join(', ') || 'URL'}). Low-confidence fields are highlighted in amber.`);
      noticeEl.innerHTML = msgs.map(m => `<div style="margin-top:0.25rem; font-weight:600;">${escapeHtml(m)}</div>`).join('');
    } catch (err) {
      noticeEl.innerHTML = `<span style="color:var(--rose); font-weight:700;">${escapeHtml(err.message)}</span>`;
    }
  });

  let forceDuplicate = false;
  document.getElementById('form-add-item').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/items', {
        method: 'POST',
        body: JSON.stringify({
          list_id: listId,
          url: document.getElementById('capture-url').value.trim() || null,
          kind: document.getElementById('item-kind').value,
          priority: document.getElementById('item-priority').value,
          title: document.getElementById('item-title').value.trim(),
          price: document.getElementById('item-price').value,
          store: document.getElementById('item-store').value.trim(),
          qty_wanted: document.getElementById('item-qty').value,
          variant: document.getElementById('item-variant').value.trim(),
          notes: document.getElementById('item-notes').value.trim(),
          any_similar: document.getElementById('item-any-similar').checked,
          allow_group_chip_in: document.getElementById('item-chip-in').checked,
          always_wanted: document.getElementById('item-always-wanted').checked,
          field_confidence: lastConfidence,
          force_duplicate: forceDuplicate
        })
      });
      closeModal();
      showToast('Item saved to wishlist!');
      refreshAndRender();
    } catch (err) {
      if (err.status === 409 && err.data?.duplicate_detected) {
        forceDuplicate = true;
        document.getElementById('capture-notice').innerHTML = `<div style="color:var(--amber); font-weight:700;">⚠️ ${escapeHtml(err.message)} Click "Save to Wishlist" again to confirm saving duplicate.</div>`;
      } else {
        showToast(err.message);
      }
    }
  });
}

function applyConfidenceIndicator(inputId, badgeId, score) {
  const input = document.getElementById(inputId);
  const badge = document.getElementById(badgeId);
  if (!input || !badge || score === undefined) return;
  const pct = Math.round(score * 100);
  if (score < 0.75) {
    input.classList.add('low-confidence');
    badge.innerHTML = `<span style="color:var(--amber); font-weight:700;">(Low confidence ${pct}% — please confirm)</span>`;
  } else {
    input.classList.remove('low-confidence');
    badge.innerHTML = `<span style="color:var(--emerald);">(${pct}% confidence)</span>`;
  }
}

function openEditItemModal(item) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Edit Item Details (Section 14 Edge Cases Protected)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <p style="font-size:0.83rem; color:var(--text-muted); margin-top:0;">
          If anyone has already reserved this item, they will automatically receive your updated Size/Color/Notes side-by-side without revealing their claim to you!
        </p>
        <form id="form-edit-item">
          <div class="form-group">
            <label for="edit-title">Title</label>
            <input id="edit-title" class="form-control" required value="${escapeHtml(item.title)}" />
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:0.75rem;">
            <div class="form-group">
              <label for="edit-price">Price ($)</label>
              <input id="edit-price" class="form-control" type="number" step="0.01" value="${item.price ?? ''}" />
            </div>
            <div class="form-group">
              <label for="edit-qty">Quantity Wanted</label>
              <input id="edit-qty" class="form-control" type="number" min="1" value="${item.qty_wanted}" />
            </div>
            <div class="form-group">
              <label for="edit-priority">Priority</label>
              <select id="edit-priority" class="form-control">
                <option value="most_wanted" ${item.priority === 'most_wanted' ? 'selected' : ''}>★ Most Wanted</option>
                <option value="high" ${item.priority === 'high' ? 'selected' : ''}>High</option>
                <option value="normal" ${item.priority === 'normal' ? 'selected' : ''}>Wanted</option>
                <option value="low" ${item.priority === 'low' ? 'selected' : ''}>Nice to Have</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label for="edit-variant">Size / Color / Variant</label>
            <input id="edit-variant" class="form-control" value="${escapeHtml(item.variant || '')}" />
          </div>
          <div class="form-group">
            <label for="edit-notes">Notes</label>
            <input id="edit-notes" class="form-control" value="${escapeHtml(item.notes || '')}" />
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-edit">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Changes</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-edit').addEventListener('click', closeModal);
  document.getElementById('form-edit-item').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: document.getElementById('edit-title').value.trim(),
        price: document.getElementById('edit-price').value ? Number(document.getElementById('edit-price').value) : null,
        qty_wanted: Number(document.getElementById('edit-qty').value),
        priority: document.getElementById('edit-priority').value,
        variant: document.getElementById('edit-variant').value.trim(),
        notes: document.getElementById('edit-notes').value.trim()
      })
    });
    closeModal();
    showToast('Item updated!');
    refreshAndRender();
  });
}

function openReserveModal(item) {
  const isGuest = !state.currentUser;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Reserve "${escapeHtml(item.title)}" (Flow B)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>

        <form id="form-reserve">
          ${isGuest ? `
            <div style="background:var(--primary-soft); color:var(--primary); padding:0.75rem; border-radius:8px; font-size:0.84rem; margin-bottom:0.85rem;">
              <strong>No Account Required (GVR-1 &amp; GVR-6):</strong> Enter your email to receive a 6-digit verification code. Your reservation holds for 7 days once verified (max 3 open guest claims per list).
            </div>
            <div class="form-group">
              <label for="guest-name">Your Name (optional)</label>
              <input id="guest-name" class="form-control" placeholder="Cousin Sam" />
            </div>
            <div class="form-group">
              <label for="guest-email">Your Email Address *</label>
              <input id="guest-email" class="form-control" type="email" required placeholder="sam@example.com" />
            </div>
          ` : `
            <p style="font-size:0.88rem; margin-top:0;">Reserving as <strong>${escapeHtml(state.currentUser.name)}</strong>. The list owner will never see your reservation while Surprise Mode is on.</p>
          `}

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
            <div class="form-group">
              <label for="claim-qty">Quantity to Reserve</label>
              <input id="claim-qty" class="form-control" type="number" min="1" max="${item.claim_summary?.qty_remaining || 1}" value="1" />
            </div>
            <div class="form-group">
              <label for="claim-note">Private Order Note (optional)</label>
              <input id="claim-note" class="form-control" placeholder="e.g., Order #123" />
            </div>
          </div>

          <div class="form-group" style="font-size:0.85rem;">
            <label><input type="checkbox" id="claim-show-name" checked /> Let other family group givers see my name on this claim (GVR-7 — always hidden from owner &amp; link guests)</label>
          </div>

          <div id="verify-step-box" style="display:none; background:#fffbeb; border:2px solid #f59e0b; padding:0.85rem; border-radius:8px; margin-bottom:0.85rem;"></div>

          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-reserve">Cancel</button>
            <button type="submit" class="btn btn-primary" id="btn-submit-reserve">Reserve Now</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-reserve').addEventListener('click', closeModal);

  let pendingClaimId = null;

  document.getElementById('form-reserve').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (pendingClaimId) {
        const code = document.getElementById('guest-verify-code').value.trim();
        const verifiedRes = await api('/api/claims/verify', {
          method: 'POST',
          body: JSON.stringify({ claim_id: pendingClaimId, code })
        });
        state.guestToken = verifiedRes.claim.manage_token;
        localStorage.setItem('hushlist_guest_token', state.guestToken);
        closeModal();
        showToast('Email verified! Your guest reservation is locked in.');
        refreshAndRender();
        return;
      }

      const res = await api('/api/claims', {
        method: 'POST',
        body: JSON.stringify({
          item_id: item.id,
          guest_email: isGuest ? document.getElementById('guest-email').value.trim() : null,
          guest_name: isGuest ? document.getElementById('guest-name').value.trim() : null,
          qty: Number(document.getElementById('claim-qty').value) || 1,
          order_note: document.getElementById('claim-note').value.trim(),
          show_name_to_givers: document.getElementById('claim-show-name').checked
        })
      });

      if (res.claim.verification_required) {
        pendingClaimId = res.claim.id;
        const box = document.getElementById('verify-step-box');
        box.style.display = 'block';
        box.innerHTML = `
          <div style="font-weight:700; margin-bottom:0.4rem;">Enter the 6-digit verification code sent to your email:</div>
          <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.5rem;">
            (Demo convenience: Your code in the Notification Outbox is <code>${escapeHtml(res.claim.demo_verification_code)}</code>)
          </div>
          <input id="guest-verify-code" class="form-control" required value="${escapeHtml(res.claim.demo_verification_code)}" />
        `;
        document.getElementById('btn-submit-reserve').textContent = 'Verify 6-Digit Code & Hold Claim';
      } else {
        closeModal();
        showToast('Gift reserved! Remember to confirm purchase after buying.');
        refreshAndRender();
      }
    } catch (err) {
      showToast(err.message);
    }
  });
}

function openChipInModal(item) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Chip In Toward "${escapeHtml(item.title)}" (GVR-4)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">
          Split an expensive gift across multiple givers. No platform fees or payment lock-in (Decision D5)—coordinate directly with the family group!
        </p>
        <form id="form-chip-in">
          <div class="form-group">
            <label for="pledge-amount">Your Pledged Contribution ($)</label>
            <input id="pledge-amount" class="form-control" type="number" min="1" step="1" required value="50" />
          </div>
          <div class="form-group">
            <label for="pledge-note">Note for Co-Givers</label>
            <input id="pledge-note" class="form-control" placeholder="Happy to order it once we hit the target!" />
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-chip">Cancel</button>
            <button type="submit" class="btn btn-primary">Pledge Contribution</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-chip').addEventListener('click', closeModal);
  document.getElementById('form-chip-in').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/contributions', {
      method: 'POST',
      body: JSON.stringify({
        item_id: item.id,
        pledged_amount: Number(document.getElementById('pledge-amount').value),
        note: document.getElementById('pledge-note').value.trim()
      })
    });
    closeModal();
    showToast('Contribution pledged!');
    refreshAndRender();
  });
}

function openAmazonImportModal(listId) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Import &amp; Re-Sync Public Amazon Wishlist (IMP-1)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">
          Switching from Amazon Lists shouldn't be a manual re-entry chore. Re-syncing automatically skips items already on your list and reports imported, skipped, and failed items item-by-item.
        </p>
        <form id="form-amazon-import">
          <div class="form-group">
            <label for="amz-url">Amazon Wishlist URL</label>
            <input id="amz-url" class="form-control" value="https://www.amazon.com/hz/wishlist/ls/3SMITHFAMILY2026" />
          </div>
          <div class="form-group">
            <label for="amz-json">Captured Amazon Wishlist Items (JSON from Extension or Paste)</label>
            <textarea id="amz-json" class="form-control" rows="6">[
  {
    "title": "Kindle Paperwhite Signature Edition (32 GB)",
    "url": "https://www.amazon.com/dp/B09TMN58KL",
    "price": 189.99,
    "variant": "Metallic Jade / Without Lockscreen Ads",
    "priority": "most_wanted"
  },
  {
    "title": "AeroPress Clear Coffee Press",
    "url": "https://www.amazon.com/dp/B0C3K12345",
    "price": 49.95,
    "variant": "Clear Tritan",
    "priority": "high"
  }
]</textarea>
          </div>
          <div id="amz-report" style="margin-bottom:0.85rem; font-size:0.84rem;"></div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-amz">Close</button>
            <button type="submit" class="btn btn-primary">Run Import / Re-Sync</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-amz').addEventListener('click', () => { closeModal(); refreshAndRender(); });
  document.getElementById('form-amazon-import').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const items = JSON.parse(document.getElementById('amz-json').value);
      const res = await api('/api/import/amazon', {
        method: 'POST',
        body: JSON.stringify({
          list_id: listId,
          amazon_list_url: document.getElementById('amz-url').value.trim(),
          items
        })
      });
      const r = res.report;
      document.getElementById('amz-report').innerHTML = `
        <div style="background:var(--emerald-soft); color:var(--emerald); padding:0.75rem; border-radius:8px;">
          <strong>Import Summary Report:</strong><br/>
          ✓ Imported: <strong>${r.imported.length}</strong> (${r.imported.map(i => escapeHtml(i.title)).join(', ') || 'none'})<br/>
          ⏭ Skipped Duplicates: <strong>${r.skipped.length}</strong> (${r.skipped.map(i => escapeHtml(i.title)).join(', ') || 'none'})<br/>
          ✕ Failed: <strong>${r.failed.length}</strong>
        </div>
      `;
      showToast(`Imported ${r.imported.length} items (${r.skipped.length} duplicates skipped)`);
    } catch (err) {
      showToast('Invalid JSON or import error: ' + err.message);
    }
  });
}

function openNewListModal() {
  const owners = [
    { id: state.currentUser.id, name: `${state.currentUser.name} (Personal List)` },
    ...state.dependents.map(d => ({ id: d.id, name: `${d.name} (Guardian-Managed Child List)` }))
  ];
  const helperCandidates = state.personas.filter(p => !p.is_dependent && p.id !== state.currentUser.id);

  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Create New Wishlist (LST-1..4)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <form id="form-new-list">
          <div class="form-group">
            <label for="nl-owner">List For</label>
            <select id="nl-owner" class="form-control">
              ${owners.map(o => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="nl-name">List Name *</label>
            <input id="nl-name" class="form-control" required placeholder="Spring Birthday Wishes" />
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
            <div class="form-group">
              <label for="nl-occasion">Occasion</label>
              <select id="nl-occasion" class="form-control">
                <option value="Birthday">Birthday</option>
                <option value="Holiday">Holiday</option>
                <option value="Anniversary">Anniversary</option>
                <option value="Housewarming">Housewarming</option>
              </select>
            </div>
            <div class="form-group">
              <label for="nl-date">Event Date</label>
              <input id="nl-date" class="form-control" type="date" value="2026-12-25" />
            </div>
          </div>
          <div class="form-group">
            <label for="nl-helper">Trusted List Helper (LST-4 / Decision D9 — can view &amp; release bad claims without spoiling you)</label>
            <select id="nl-helper" class="form-control">
              <option value="">None</option>
              ${helperCandidates.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="nl-surprise" checked /> Surprise Mode ON by default (Decision D1 — hide all claims from me)</label>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-nl">Cancel</button>
            <button type="submit" class="btn btn-primary">Create Wishlist</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-nl').addEventListener('click', closeModal);
  document.getElementById('form-new-list').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/lists', {
      method: 'POST',
      body: JSON.stringify({
        owner_id: document.getElementById('nl-owner').value,
        name: document.getElementById('nl-name').value.trim(),
        occasion: document.getElementById('nl-occasion').value,
        event_date: document.getElementById('nl-date').value,
        helper_user_id: document.getElementById('nl-helper').value || null,
        surprise_mode: document.getElementById('nl-surprise').checked,
        group_id: 'grp_smith'
      })
    });
    state.selectedListId = res.list.id;
    closeModal();
    showToast('New wishlist created!');
    refreshAndRender();
  });
}

function openNewChildModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Create Guardian-Managed Child Profile (ACC-3 &amp; COPPA D6)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <p style="font-size:0.84rem; color:var(--text-muted); margin-top:0;">
          Per Decision D6 (COPPA compliance), under-13 profiles have no child login or email address. Guardians manage the list and can see claims to coordinate family gifts.
        </p>
        <form id="form-new-child">
          <div class="form-group">
            <label for="child-name">Child Display Name *</label>
            <input id="child-name" class="form-control" required placeholder="Sophie Smith (Age 6)" />
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
            <div class="form-group">
              <label for="child-bmonth">Birthday Month (1-12)</label>
              <input id="child-bmonth" class="form-control" type="number" min="1" max="12" value="5" />
            </div>
            <div class="form-group">
              <label for="child-bday">Birthday Day (1-31)</label>
              <input id="child-bday" class="form-control" type="number" min="1" max="31" value="19" />
            </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-child">Cancel</button>
            <button type="submit" class="btn btn-primary">Create Child Profile &amp; List</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-child').addEventListener('click', closeModal);
  document.getElementById('form-new-child').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/dependents', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('child-name').value.trim(),
        birthday_month: Number(document.getElementById('child-bmonth').value),
        birthday_day: Number(document.getElementById('child-bday').value)
      })
    });
    state.selectedListId = res.list.id;
    closeModal();
    showToast(`Child profile & wishlist created for ${res.dependent.name}!`);
    refreshAndRender();
  });
}

function openSecretIdeaModal(subjectUserId, personName) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Add Secret Gift Idea for ${escapeHtml(personName)} (GVR-5)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <p style="font-size:0.84rem; color:var(--text-muted); margin-top:0;">
          Other followers shopping for ${escapeHtml(personName)} can see this idea, but <strong>${escapeHtml(personName)} will never see or infer it</strong>.
        </p>
        <form id="form-secret">
          <div class="form-group">
            <label for="sec-title">Idea Title *</label>
            <input id="sec-title" class="form-control" required placeholder="Surprise Concert Tickets or Vintage Watch" />
          </div>
          <div class="form-group">
            <label for="sec-price">Estimated Cost ($)</label>
            <input id="sec-price" class="form-control" type="number" step="0.01" placeholder="75.00" />
          </div>
          <div class="form-group">
            <label for="sec-note">Note for Other Family Shoppers</label>
            <input id="sec-note" class="form-control" placeholder="She mentioned wanting this last week!" />
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-sec">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Secret Idea</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-sec').addEventListener('click', closeModal);
  document.getElementById('form-secret').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/secret-ideas', {
      method: 'POST',
      body: JSON.stringify({
        subject_user_id: subjectUserId,
        title: document.getElementById('sec-title').value.trim(),
        estimated_price: document.getElementById('sec-price').value,
        note: document.getElementById('sec-note').value.trim()
      })
    });
    closeModal();
    showToast(`Secret idea saved (hidden from ${personName})!`);
    refreshAndRender();
  });
}

function openBudgetModal(subjectUserId, personName) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Set Personal Budget for ${escapeHtml(personName)} (TRK-4)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <form id="form-budget">
          <div class="form-group">
            <label for="bdg-amount">Budget Amount ($)</label>
            <input id="bdg-amount" class="form-control" type="number" min="1" required value="200" />
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-bdg">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Private Budget</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-bdg').addEventListener('click', closeModal);
  document.getElementById('form-budget').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/budgets', {
      method: 'POST',
      body: JSON.stringify({
        subject_user_id: subjectUserId,
        occasion: 'Birthday',
        amount: Number(document.getElementById('bdg-amount').value)
      })
    });
    closeModal();
    showToast('Personal budget updated!');
    refreshAndRender();
  });
}

function openShareModal(shareToken) {
  const fullUrl = `${window.location.origin}/?list=${encodeURIComponent(shareToken)}`;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal" style="text-align:center;">
        <div class="card-header">
          <h2 class="card-title">Share Wishlist Link or QR Code (SHR-1)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <p style="font-size:0.86rem; color:var(--text-muted);">
          Opens on any phone browser with no app install and no account required to reserve. Marked <code>noindex</code> for privacy.
        </p>
        <div style="margin:1rem auto; width:160px; height:160px; border:2px solid var(--border); border-radius:12px; display:flex; align-items:center; justify-content:center; background:#fff;">
          <svg viewBox="0 0 100 100" width="130" height="130" aria-label="QR Code for Wishlist">
            <rect x="5" y="5" width="30" height="30" fill="#0f172a"/>
            <rect x="10" y="10" width="20" height="20" fill="#fff"/>
            <rect x="15" y="15" width="10" height="10" fill="#4f46e5"/>
            <rect x="65" y="5" width="30" height="30" fill="#0f172a"/>
            <rect x="70" y="10" width="20" height="20" fill="#fff"/>
            <rect x="75" y="15" width="10" height="10" fill="#4f46e5"/>
            <rect x="5" y="65" width="30" height="30" fill="#0f172a"/>
            <rect x="10" y="70" width="20" height="20" fill="#fff"/>
            <rect x="15" y="75" width="10" height="10" fill="#4f46e5"/>
            <rect x="42" y="42" width="16" height="16" fill="#0f172a"/>
            <rect x="65" y="65" width="12" height="12" fill="#0f172a"/>
            <rect x="82" y="82" width="12" height="12" fill="#4f46e5"/>
          </svg>
        </div>
        <div style="display:flex; gap:0.5rem; margin-bottom:1rem;">
          <input id="share-url-input" class="form-control" readonly value="${escapeHtml(fullUrl)}" />
          <button class="btn btn-primary" id="btn-copy-link" type="button">Copy Link</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    navigator.clipboard?.writeText(fullUrl);
    showToast('Share link copied to clipboard!');
  });
}

function openOnboardingModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="card-header">
          <h2 class="card-title">Join Hushlist by Invite (Flow D &amp; ACC-1 — Under 60 Seconds)</h2>
          <button class="btn btn-secondary btn-sm" id="btn-close-modal" type="button">✕</button>
        </div>
        <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">
          Passwordless sign-up via Passkey or Magic Link. Automatically connects you to the Smith Family Circle group!
        </p>
        <form id="form-signup">
          <div class="form-group">
            <label for="su-name">Your Display Name *</label>
            <input id="su-name" class="form-control" required placeholder="Cousin Jordan" />
          </div>
          <div class="form-group">
            <label for="su-email">Your Email Address *</label>
            <input id="su-email" class="form-control" type="email" required placeholder="jordan@example.com" />
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:0.75rem;">
            <div class="form-group">
              <label for="su-bmonth">Birthday Month</label>
              <input id="su-bmonth" class="form-control" type="number" min="1" max="12" value="8" />
            </div>
            <div class="form-group">
              <label for="su-bday">Birthday Day</label>
              <input id="su-bday" class="form-control" type="number" min="1" max="31" value="22" />
            </div>
            <div class="form-group">
              <label for="su-invite">Family Group Invite</label>
              <input id="su-invite" class="form-control" value="SMITH-2026" />
            </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-su">Cancel</button>
            <button type="submit" class="btn btn-primary">Create Account with Passkey / Magic Link</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-su').addEventListener('click', closeModal);
  document.getElementById('form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('su-name').value.trim(),
        email: document.getElementById('su-email').value.trim(),
        birthday_month: Number(document.getElementById('su-bmonth').value),
        birthday_day: Number(document.getElementById('su-bday').value),
        invite_code: document.getElementById('su-invite').value.trim(),
        auth_method: 'passkey'
      })
    });
    state.activeUserId = res.user.id;
    localStorage.setItem('hushlist_user_id', state.activeUserId);
    state.activeTab = 'my-lists';
    updateNavTabs();
    closeModal();
    showToast(`Welcome to Hushlist, ${res.user.name}! You've joined the Smith Family Circle.`);
    refreshAndRender();
  });
}

init();
