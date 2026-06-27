/* popup.js — SubBot Extension (view layer for @SubmanagerAgentBot) */

const API            = 'https://portal-subscription-manager-production.up.railway.app';
const BOT_USERNAME   = 'SubmanagerAgentBot';
// TODO: replace with your real project Celo wallet address
const PROJECT_WALLET = '0xA6F46Dcaa07C6b56D02379Ec3b2AafDFe3BA0DfA';

// ── Web3Auth ──────────────────────────────────────────────────────────────────
const IS_EXTENSION = !!(
  typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function'
);
const WEB3AUTH_LOGIN_PAGE = IS_EXTENSION
  ? chrome.runtime.getURL('web3auth-login.html')
  : '/web3auth-login.html';

// Unified storage helpers — chrome.storage in extension, localStorage on web
function w3aGet(cb) {
  if (IS_EXTENSION) {
    chrome.storage.local.get('web3auth', d => cb(d.web3auth || null));
  } else {
    try { cb(JSON.parse(localStorage.getItem('web3auth'))); } catch { cb(null); }
  }
}
function w3aSet(data, cb) {
  if (IS_EXTENSION) {
    chrome.storage.local.set({ web3auth: data }, cb);
  } else {
    localStorage.setItem('web3auth', JSON.stringify(data));
    if (cb) cb();
  }
}
function w3aRemove(cb) {
  if (IS_EXTENSION) {
    chrome.storage.local.remove('web3auth', cb);
  } else {
    localStorage.removeItem('web3auth');
    if (cb) cb();
  }
}

function openWeb3AuthTab() {
  if (IS_EXTENSION) {
    chrome.tabs.create({ url: WEB3AUTH_LOGIN_PAGE, active: true });
  } else {
    window.open(WEB3AUTH_LOGIN_PAGE, 'web3auth_login', 'width=480,height=640,left=200,top=100');
  }

  // Listen for the result via BroadcastChannel (web) or storage polling (extension)
  if (!IS_EXTENSION) {
    const handleW3AResult = async w3a => {
      if (!w3a?.idToken) return;
      w3aSet(w3a, async () => {
        renderW3AStatus(w3a);
        await syncWeb3AuthUser(w3a);
      });
    };

    // Primary: BroadcastChannel
    const bc = new BroadcastChannel('web3auth_result');
    bc.onmessage = e => { bc.close(); handleW3AResult(e.data); };
    setTimeout(() => bc.close(), 180000);

    // Fallback: postMessage from popup window
    const onMsg = e => {
      if (e.data?.type === 'web3auth_result') {
        window.removeEventListener('message', onMsg);
        handleW3AResult(e.data.data);
      }
    };
    window.addEventListener('message', onMsg);
  } else {
    // Extension: popup stays open; poll chrome.storage for the result
    const checkInterval = setInterval(() => {
      w3aGet(w3a => {
        if (w3a?.idToken && w3a?.loginAt && (Date.now() - w3a.loginAt) < 30000) {
          clearInterval(checkInterval);
          renderW3AStatus(w3a);
          syncWeb3AuthUser(w3a);
        }
      });
    }, 800);
    setTimeout(() => clearInterval(checkInterval), 180000);
  }
}

function renderW3AStatus(w3a) {
  if (!w3a?.idToken) {
    // Logged out state — setup screen
    document.getElementById('w3a-status')?.classList.add('hidden');
    document.getElementById('w3a-dashboard-btn')?.classList.add('hidden');
    document.getElementById('w3a-login-btn')?.classList.remove('hidden');

    // Settings screen
    document.getElementById('settings-w3a-logged-out')?.classList.remove('hidden');
    document.getElementById('settings-w3a-logged-in')?.classList.add('hidden');
    return;
  }

  const initial = (w3a.name || w3a.email || '?').charAt(0).toUpperCase();

  // Setup screen status
  const statusEl = document.getElementById('w3a-status');
  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.classList.add('flex');
    document.getElementById('w3a-avatar').textContent = initial;
    document.getElementById('w3a-name').textContent   = w3a.name  || 'Web3Auth User';
    document.getElementById('w3a-email').textContent  = w3a.email || w3a.verifierId || '';
    document.getElementById('w3a-login-btn')?.classList.add('hidden');
    document.getElementById('w3a-dashboard-btn')?.classList.remove('hidden');
  }

  // Settings screen
  document.getElementById('settings-w3a-logged-out')?.classList.add('hidden');
  const loggedIn = document.getElementById('settings-w3a-logged-in');
  if (loggedIn) {
    loggedIn.classList.remove('hidden');
    document.getElementById('settings-w3a-avatar').textContent = initial;
    document.getElementById('settings-w3a-name').textContent   = w3a.name  || 'Web3Auth User';
    document.getElementById('settings-w3a-email').textContent  = w3a.email || '';
    document.getElementById('settings-w3a-userid').textContent = `w3a:${w3a.verifier}:${w3a.verifierId}`;
  }
}

async function syncWeb3AuthUser(w3a) {
  // Verify the token with the backend and load user data
  try {
    const res = await fetch(`${API}/auth/verify-web3auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: w3a.idToken, verifier: w3a.verifier, verifierId: w3a.verifierId }),
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const userId = `w3a:${w3a.verifier}:${w3a.verifierId}`;
      state.telegramUserId = userId; // reuse existing userId field for API calls
      saveState();
      const gotData = await fetchUserData(false);
      toast(gotData ? `Welcome back, ${w3a.name || 'user'}!` : `Logged in as ${w3a.name || 'user'}`);
      showScreen('dashboard');
    } else {
      toast('Web3Auth verification failed — please try again');
    }
  } catch (_) {
    // Backend verification unavailable — still allow local use
    const userId = `w3a:${w3a.verifier}:${w3a.verifierId}`;
    state.telegramUserId = userId;
    saveState();
    toast(`Logged in as ${w3a.name || 'user'} (offline mode)`);
    showScreen('dashboard');
  }
}

async function web3authLogout() {
  w3aRemove(() => {
    renderW3AStatus(null);
    state.telegramUserId = null;
    state.subscriptions  = [];
    state.balance        = 0;
    state.txHistory      = [];
    saveState();
    toast('Signed out of Web3Auth');
    showScreen('welcome');
  });
}

let state = {
  telegramUserId: null,
  subscriptions:  [],
  budget:         100,
  balance:        0,
  txHistory:      [],
};

// ── User ID ───────────────────────────────────────────────────────────────
function userId() { return state.telegramUserId || 'local'; }

// ── State persistence ─────────────────────────────────────────────────────
function saveState() {
  try { chrome.storage.local.set({ subbot: state }); } catch(e) {
    localStorage.setItem('subbot', JSON.stringify(state));
  }
}

async function loadState() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get('subbot', data => {
        if (data.subbot) Object.assign(state, data.subbot);
        resolve();
      });
    } catch(e) {
      const d = localStorage.getItem('subbot');
      if (d) Object.assign(state, JSON.parse(d));
      resolve();
    }
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Router ────────────────────────────────────────────────────────────────
const ONBOARDING = new Set(['welcome', 'setup']);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');

  const header = document.getElementById('app-header');
  const nav    = document.getElementById('app-nav');
  if (ONBOARDING.has(name)) {
    header.classList.add('hidden');
    nav.classList.add('hidden');
  } else {
    header.classList.remove('hidden');
    nav.classList.remove('hidden');
  }

  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active-tab', t.dataset.tab === name);
  });

  if (name === 'dashboard')     refreshDashboard();
  if (name === 'subscriptions') renderSubs();
  if (name === 'credits')       refreshCredits();
  if (name === 'alerts')        renderAlerts();
  if (name === 'settings')      refreshSettings();
  if (name === 'audit')         runAudit();
}

// ── Event delegation ──────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const overlay = e.target.closest('.modal-overlay');
  if (overlay && !e.target.closest('[data-modal-content]')) {
    overlay.classList.remove('active');
    return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const target = el.dataset.target;
  const modal  = el.dataset.modal;
  const filter = el.dataset.filter;

  switch (action) {
    case 'nav':              showScreen(target); break;
    case 'setupPair':        setupAndPair(); break;
    case 'openBot':          openBot(); break;
    case 'refreshData':      refreshData(); break;
    case 'addSub':           showAddSubModal(); break;
    case 'saveManualSub':    saveManualSub(); break;
    case 'filter':           if (filter) setFilter(filter); break;
    case 'saveBudget':       saveBudget(); break;
    case 'saveTgId':         saveTgId(); break;
    case 'exportAction':     exportCSV(); break;
    case 'resetBot':         resetBot(); break;
    case 'showQR':           showQRModal(); break;
    case 'copyProjectAddr':  copyProjectAddr(); break;
    case 'closeModal':       if (modal) document.getElementById(modal)?.classList.remove('active'); break;
    case 'copyNeg':          copyNegotiationEmail(); break;
    case 'draftEmail':       draftEmail(el.dataset.service); break;
    case 'togglePref':       togglePref(el); break;
    case 'web3authLogin':    openWeb3AuthTab(); break;
    case 'web3authLogout':   web3authLogout(); break;
    case 'web3authDashboard': showScreen('dashboard'); break;
  }
});

// ── QR ────────────────────────────────────────────────────────────────────
function drawQR(canvasId, text) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const c = document.getElementById(canvasId);
    if (c) c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  };
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}&color=000000&bgcolor=ffffff`;
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function copyProjectAddr() {
  navigator.clipboard.writeText(PROJECT_WALLET).then(() => toast('Address copied!'));
}

function showQRModal() {
  drawQR('qr-canvas', PROJECT_WALLET);
  const addrEl = document.getElementById('qr-addr');
  if (addrEl) addrEl.textContent = PROJECT_WALLET;
  document.getElementById('modal-qr')?.classList.add('active');
}

// ── Fetch data from bot via bridge ────────────────────────────────────────
async function fetchUserData(silent = true) {
  let gotData = false;
  try {
    const r = await fetch(`${API}/subs?userId=${userId()}`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      if (d.subscriptions?.length) {
        state.subscriptions = d.subscriptions;
        gotData = true;
      }
    }
  } catch(e) {}

  try {
    const r = await fetch(`${API}/history?userId=${userId()}`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const txs = d.transactions || [];
      state.txHistory = txs;
      // Compute balance from ledger
      state.balance = txs.reduce((sum, tx) => {
        return tx.type === 'deposit' ? sum + (tx.amount || 0) : sum - (tx.amount || 0);
      }, 0);
      state.balance = Math.max(0, parseFloat(state.balance.toFixed(4)));
    }
  } catch(e) {}

  saveState();
  return gotData;
}

async function refreshData() {
  toast('Refreshing…');
  await fetchUserData(false);
  refreshDashboard();
  renderSubs();
  toast('Data refreshed');
}

function openBot() {
  window.open(`https://t.me/${BOT_USERNAME}`, '_blank');
}

// ── Onboarding ────────────────────────────────────────────────────────────
async function setupAndPair() {
  const val = document.getElementById('setup-tg-id')?.value?.trim();
  if (!val || !/^\d+$/.test(val)) { toast('Enter your numeric Telegram ID'); return; }

  const btn = document.getElementById('setup-btn');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

  state.telegramUserId = val;
  saveState();

  const gotData = await fetchUserData(false);

  if (btn) { btn.textContent = 'Open Dashboard'; btn.disabled = false; }

  if (gotData) {
    toast(`Loaded ${state.subscriptions.length} subscription(s)!`);
  } else {
    toast('Paired! Ask your bot to scan Gmail first.');
  }
  showScreen('dashboard');
}

// ── Dashboard ─────────────────────────────────────────────────────────────
function refreshDashboard() {
  const subs    = state.subscriptions.filter(s => s.status === 'active');
  const monthly = subs.reduce((sum, s) => sum + (s.monthly_cost_usd || s.monthly_cost || 0), 0);
  const budget  = state.budget || 100;
  const pct     = Math.min(100, Math.round(monthly / budget * 100));

  document.getElementById('dash-spend').textContent  = '$' + monthly.toFixed(0);
  document.getElementById('dash-budget').textContent = '/ $' + budget;
  document.getElementById('dash-pct').textContent    = pct + '%';
  const ring = document.getElementById('budget-ring');
  if (ring) {
    ring.setAttribute('stroke-dashoffset', 376.99 * (1 - pct / 100));
    ring.classList.toggle('text-error', pct >= 100);
  }

  document.getElementById('stat-count').textContent    = subs.length;
  document.getElementById('stat-annual').textContent   = '$' + (monthly * 12).toFixed(0);

  const now  = new Date();
  const soon = subs.filter(s => s.next_renewal && (new Date(s.next_renewal) - now) / 86400000 <= 30).length;
  document.getElementById('stat-renewals').textContent = soon;

  const hdr = document.getElementById('header-status');
  if (hdr) {
    hdr.textContent = subs.length ? `● ${subs.length} subs` : '● No data';
  }

  const strip = document.getElementById('strip-balance');
  if (strip) strip.textContent = (state.balance || 0).toFixed(2) + ' cUSD';

  // Renewals list
  const renewalDiv = document.getElementById('renewals-list');
  if (!renewalDiv) return;
  const upcoming = subs
    .filter(s => s.next_renewal)
    .sort((a, b) => new Date(a.next_renewal) - new Date(b.next_renewal))
    .slice(0, 3);

  if (!upcoming.length) {
    renewalDiv.innerHTML = '<div class="text-xs text-muted text-center py-3">No upcoming renewals.</div>';
    return;
  }
  renewalDiv.innerHTML = upcoming.map(s => {
    const days    = Math.ceil((new Date(s.next_renewal) - now) / 86400000);
    const color   = days <= 3 ? 'bg-error shadow-[0_0_8px_rgba(255,180,171,0.6)]' : days <= 7 ? 'bg-amber-400' : 'bg-tertiary';
    const dateStr = new Date(s.next_renewal).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<div class="bg-panel p-3 rounded-xl flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-1.5 h-1.5 rounded-full ${color}"></div>
        <div><p class="text-sm font-semibold">${s.name}</p><p class="text-[10px] text-muted font-mono">${dateStr} · $${s.monthly_cost}</p></div>
      </div>
      <i class="fa-solid fa-chevron-right text-muted text-[10px]"></i>
    </div>`;
  }).join('');
}

// ── Subscriptions ─────────────────────────────────────────────────────────
let currentFilter = 'all', searchQ = '';

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-chip').forEach(c => {
    const on = c.dataset.filter === f;
    c.classList.toggle('bg-primary-container', on);
    c.classList.toggle('text-on-primary', on);
    c.classList.toggle('bg-panel', !on);
    c.classList.toggle('text-muted', !on);
    c.classList.toggle('border', !on);
    c.classList.toggle('border-edge', !on);
  });
  renderSubs();
}

function renderSubs() {
  const list = document.getElementById('subs-list');
  if (!list) return;
  let subs = state.subscriptions.filter(s => s.status === 'active');
  if (currentFilter !== 'all') subs = subs.filter(s => (s.category || '').toLowerCase() === currentFilter);
  if (searchQ) subs = subs.filter(s => s.name.toLowerCase().includes(searchQ));
  if (!subs.length) {
    list.innerHTML = '<div class="text-xs text-muted text-center py-6">No subscriptions found.</div>';
    return;
  }
  list.innerHTML = subs.map(s => {
    const health  = s.health_score || 0;
    const hColor  = health >= 80 ? 'text-tertiary' : health >= 50 ? 'text-amber-400' : 'text-error';
    const initBg  = s.category === 'ai' ? 'bg-panel text-primary' : 'bg-panel text-secondary';
    const cost    = s.monthly_cost_usd || s.monthly_cost || 0;
    const cur     = (s.currency && s.currency !== 'USD') ? ` (${s.currency})` : '';
    return `<div class="h-[72px] glass rounded-xl px-3 flex items-center gap-3 border border-edge hover:bg-panel/40 transition-all cursor-pointer">
      <div class="w-10 h-10 rounded-lg ${initBg} flex items-center justify-center font-bold text-lg flex-shrink-0">${s.name.charAt(0)}</div>
      <div class="flex-1 min-w-0">
        <div class="flex justify-between items-start">
          <h3 class="font-semibold text-sm truncate">${s.name}</h3>
          <span class="font-mono text-sm font-medium">$${cost}<span class="text-[10px] text-muted">/mo${cur}</span></span>
        </div>
        <div class="flex items-center gap-2 mt-0.5">
          <span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary/10 text-secondary">${s.category || 'SaaS'}</span>
          <span class="${hColor} text-[10px] font-mono">♥ ${health}</span>
          ${s.next_renewal ? `<span class="text-[10px] text-muted ml-auto">Renew: ${new Date(s.next_renewal).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Audit ─────────────────────────────────────────────────────────────────
function runAudit() {
  const subs    = state.subscriptions.filter(s => s.status === 'active');
  const monthly = subs.reduce((sum, s) => sum + (s.monthly_cost_usd || s.monthly_cost || 0), 0);
  document.getElementById('audit-monthly').textContent = '$' + monthly.toFixed(2);
  document.getElementById('audit-annual').textContent  = '$' + (monthly * 12).toFixed(2);

  const cats = {};
  subs.forEach(s => { const c = s.category || 'other'; cats[c] = (cats[c] || []).concat(s.name); });
  const overlaps = Object.entries(cats).filter(([, names]) => names.length > 1);
  document.getElementById('audit-overlaps').textContent = overlaps.length;

  const avgHealth = subs.length ? Math.round(subs.reduce((s, x) => s + (x.health_score || 0), 0) / subs.length) : 0;
  document.getElementById('audit-health').textContent = avgHealth + '/100';

  const oDiv = document.getElementById('overlaps-list');
  oDiv.innerHTML = overlaps.length
    ? overlaps.map(([cat, names]) => `<div class="bg-panel p-3 rounded-xl border-l-2 border-error/50 text-xs"><p class="font-medium">${cat.toUpperCase()} overlap</p><p class="text-muted mt-0.5">${names.join(' + ')}</p></div>`).join('')
    : '<p class="text-xs text-muted text-center py-2">No overlaps detected. 🎉</p>';

  const rows = document.getElementById('health-rows');
  rows.innerHTML = subs.map(s => {
    const h     = s.health_score || 0;
    const badge = h >= 80 ? '✅ Keep' : h >= 50 ? '⚠️ Reconsider' : '❌ Cancel';
    const bc    = h >= 80 ? 'bg-tertiary' : h >= 50 ? 'bg-amber-400' : 'bg-error';
    return `<div class="flex items-center justify-between px-3 py-2.5">
      <span class="text-xs truncate flex-1">${s.name}</span>
      <span class="text-xs font-mono mx-2">$${s.monthly_cost_usd || s.monthly_cost}</span>
      <div class="w-16 bg-panel rounded-full h-1.5 mr-2"><div class="${bc} h-1.5 rounded-full" style="width:${h}%"></div></div>
      <span class="text-[10px] whitespace-nowrap">${badge}</span>
    </div>`;
  }).join('') || '<p class="text-xs text-muted text-center py-3">No data.</p>';

  const wins = [];
  overlaps.forEach(([cat, names]) => {
    const catSubs = subs.filter(s => s.category === cat);
    const minCost = Math.min(...catSubs.map(s => s.monthly_cost_usd || s.monthly_cost || 0));
    wins.push(`Cancel one of your ${names.length} ${cat} tools — save $${minCost}/mo`);
  });
  subs.filter(s => (s.health_score || 0) < 50).forEach(s => wins.push(`${s.name} has a low health score (${s.health_score}). Consider cancelling.`));

  const qd = document.getElementById('quick-wins');
  qd.innerHTML = wins.length
    ? wins.map(w => `<div class="bg-panel p-3 rounded-xl border-l-2 border-primary text-xs">${w}</div>`).join('')
    : '<p class="text-xs text-muted text-center py-2">No easy wins — you\'re well optimised!</p>';
}

// ── Alerts ────────────────────────────────────────────────────────────────
function renderAlerts() {
  const now      = new Date();
  const subs     = state.subscriptions.filter(s => s.status === 'active' && s.next_renewal);
  const upcoming = subs.filter(s => new Date(s.next_renewal) >= now).sort((a, b) => new Date(a.next_renewal) - new Date(b.next_renewal));

  const tl = document.getElementById('alerts-timeline');
  if (!tl) return;
  if (!upcoming.length) {
    tl.innerHTML = '<p class="text-xs text-muted text-center py-3">No upcoming renewals.</p>';
  } else {
    tl.innerHTML = upcoming.map(s => {
      const days     = Math.ceil((new Date(s.next_renewal) - now) / 86400000);
      const dotColor = days <= 3 ? 'bg-error ring-error/20 pulse-dot' : days <= 7 ? 'bg-amber-400 ring-amber-400/20' : 'bg-tertiary ring-tertiary/20';
      const urgLabel = days <= 3
        ? `<span class="text-[10px] text-error font-medium">⚠️ Renews in ${days} day${days === 1 ? '' : 's'}</span>`
        : `<span class="text-[10px] text-secondary">Renews in ${days} days</span>`;
      const d = new Date(s.next_renewal);
      return `<div class="relative flex items-start gap-4">
        <div class="flex flex-col items-end pt-1 w-8 flex-shrink-0">
          <span class="font-mono text-[10px] text-muted font-bold">${d.toLocaleString('en-US', { month: 'short' })}</span>
          <span class="font-mono text-lg text-main leading-none">${d.getDate()}</span>
        </div>
        <div class="relative z-10 mt-2.5 flex-shrink-0"><div class="w-3 h-3 rounded-full ${dotColor} ring-4"></div></div>
        <div class="flex-1 bg-panel rounded-xl p-3 border border-edge">
          <div class="flex justify-between items-start">
            <div><h3 class="text-sm font-semibold">${s.name}</h3><p class="text-[10px] text-muted">${s.provider || ''}</p></div>
            <span class="font-mono text-sm">$${s.monthly_cost}</span>
          </div>
          <div class="mt-1.5">${urgLabel}</div>
        </div>
      </div>`;
    }).join('');
  }

  const neg = document.getElementById('negotiate-list');
  if (!neg) return;
  const eligible = state.subscriptions.filter(s => (s.health_score || 0) < 70 && s.status === 'active');
  neg.innerHTML = eligible.length
    ? eligible.map(s => `<div class="bg-panel rounded-2xl p-4 border border-edge">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-10 h-10 rounded-lg bg-panel flex items-center justify-center font-bold">${s.name.charAt(0)}</div>
          <div><h3 class="text-sm font-semibold">${s.name}</h3><p class="text-[10px] text-tertiary">Eligible for discount</p></div>
        </div>
        <button data-action="draftEmail" data-service="${s.name}" class="w-full py-2 px-4 rounded-xl border border-secondary text-secondary text-xs font-semibold flex items-center justify-center gap-2">
          <i class="fa-solid fa-envelope text-sm"></i> Draft Email
        </button>
      </div>`).join('')
    : '<p class="text-xs text-muted text-center py-3">All subscriptions look healthy!</p>';
}

function draftEmail(serviceName) {
  const body = `Subject: Cancellation Request – Possible Retention Offer?\n\nHi team,\n\nI've been a loyal ${serviceName} subscriber but I'm reviewing my AI/SaaS budget. Before I cancel, I wanted to reach out — do you have any retention offers or discounts available for existing subscribers?\n\nThank you,\n[Your Name]`;
  document.getElementById('neg-to').value      = `support@${serviceName.toLowerCase().replace(/\s/g, '')}.com`;
  document.getElementById('neg-subject').value = `Cancellation / Discount Request — ${serviceName}`;
  document.getElementById('neg-body').value    = body;
  document.getElementById('modal-negotiate')?.classList.add('active');
}

function copyNegotiationEmail() {
  const to   = document.getElementById('neg-to').value;
  const subj = document.getElementById('neg-subject').value;
  const body = document.getElementById('neg-body').value;
  navigator.clipboard.writeText(`To: ${to}\nSubject: ${subj}\n\n${body}`).then(() => {
    toast('Email copied!');
    document.getElementById('modal-negotiate')?.classList.remove('active');
  });
}

// ── Credits ───────────────────────────────────────────────────────────────
function refreshCredits() {
  document.getElementById('credits-balance').textContent = (state.balance || 0).toFixed(2);
  const addrEl = document.getElementById('qr-addr');
  if (addrEl) addrEl.textContent = shortAddr(PROJECT_WALLET);
  drawQR('credits-qr', PROJECT_WALLET);
  renderTxHistory();
}

function renderTxHistory() {
  const div = document.getElementById('tx-history');
  if (!div) return;
  if (!state.txHistory?.length) {
    div.innerHTML = '<p class="text-xs text-muted text-center py-3">No transactions yet.</p>';
    return;
  }
  const icons = { scan: 'fa-satellite-dish', audit: 'fa-chart-pie', negotiate: 'fa-envelope', deduct: 'fa-credit-card', deposit: 'fa-wallet', export: 'fa-download' };
  div.innerHTML = state.txHistory.slice(0, 20).map(tx => {
    const isDeposit = tx.type === 'deposit';
    const icon      = icons[tx.action || tx.type] || 'fa-credit-card';
    const amt       = isDeposit ? `+${tx.amount?.toFixed(2)} cUSD` : `-${tx.amount?.toFixed(2)} cUSD`;
    const amtColor  = isDeposit ? 'text-tertiary' : 'text-error';
    const label     = tx.action ? (tx.action.charAt(0).toUpperCase() + tx.action.slice(1)) : 'Deposit';
    const date      = new Date(tx.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<div class="flex items-center justify-between p-3 rounded-xl bg-panel border border-edge">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center"><i class="fa-solid ${icon} text-primary text-sm"></i></div>
        <div><p class="text-xs font-medium">${label}</p><p class="text-[10px] text-muted font-mono">${date}</p></div>
      </div>
      <span class="text-xs font-mono font-bold ${amtColor}">${amt}</span>
    </div>`;
  }).join('');
}

// ── Settings ──────────────────────────────────────────────────────────────
function refreshSettings() {
  // Web3Auth status
  w3aGet(w3a => renderW3AStatus(w3a));

  const tgId = state.telegramUserId;
  const isTgId = tgId && !tgId.startsWith('w3a:');

  const tgInput = document.getElementById('settings-tg-id');
  if (tgInput && isTgId) tgInput.value = tgId;

  const tgStatus = document.getElementById('tg-pair-status');
  if (tgStatus) {
    if (isTgId) {
      tgStatus.textContent = `Paired — ID: ${tgId}`;
      tgStatus.className   = 'text-[10px] text-tertiary';
    } else {
      tgStatus.textContent = '';
    }
  }

  const bInput = document.getElementById('budget-input');
  if (bInput) bInput.value = state.budget || 100;
}

async function saveBudget() {
  const v = parseFloat(document.getElementById('budget-input').value);
  if (!isNaN(v) && v > 0) {
    state.budget = v;
    saveState();
    try { await fetch(`${API}/budget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budget: v, userId: userId() }) }); } catch(e) {}
    toast('Budget saved!');
  }
}

async function saveTgId() {
  const val = document.getElementById('settings-tg-id')?.value?.trim();
  if (!val || !/^\d+$/.test(val)) { toast('Enter a valid numeric Telegram ID'); return; }
  state.telegramUserId = val;
  saveState();

  const gotData = await fetchUserData(false);
  if (gotData) {
    toast(`Synced — ${state.subscriptions.length} subscription(s) loaded.`);
    refreshDashboard();
    renderSubs();
  } else {
    toast('Paired! Ask your bot to scan Gmail first.');
  }

  const tgStatus = document.getElementById('tg-pair-status');
  if (tgStatus) {
    tgStatus.textContent = `Paired — ID: ${val}`;
    tgStatus.className   = 'text-[10px] text-tertiary';
  }
}

// ── Manual add ────────────────────────────────────────────────────────────
function showAddSubModal() {
  ['add-sub-name', 'add-sub-provider', 'add-sub-cost', 'add-sub-renewal'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const cur = document.getElementById('add-sub-currency');
  if (cur) cur.value = 'USD';
  document.getElementById('modal-add-sub')?.classList.add('active');
}

async function saveManualSub() {
  const name = document.getElementById('add-sub-name')?.value?.trim();
  const cost = parseFloat(document.getElementById('add-sub-cost')?.value);
  if (!name) { toast('Name is required'); return; }
  if (isNaN(cost) || cost < 0) { toast('Enter a valid cost'); return; }

  const sub = {
    id:              'manual-' + Date.now(),
    name,
    provider:        document.getElementById('add-sub-provider')?.value?.trim() || name,
    category:        document.getElementById('add-sub-category')?.value || 'saas',
    monthly_cost:    cost,
    monthly_cost_usd: cost,
    currency:        (document.getElementById('add-sub-currency')?.value?.trim() || 'USD').toUpperCase(),
    next_renewal:    document.getElementById('add-sub-renewal')?.value || null,
    status:          'active',
    health_score:    70,
    source:          'manual',
  };

  // Save to bridge (persists for all devices with same userId)
  try {
    await fetch(`${API}/add-sub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sub, userId: userId() }),
      signal: AbortSignal.timeout(4000),
    });
  } catch(e) {}

  // Also update local state immediately
  state.subscriptions = [...(state.subscriptions || []), sub];
  saveState();
  document.getElementById('modal-add-sub')?.classList.remove('active');
  toast(`${name} added!`);
  renderSubs();
  refreshDashboard();
}

// ── Export ────────────────────────────────────────────────────────────────
async function exportCSV() {
  try {
    const r = await fetch(`${API}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: userId() }) });
    if (r.ok) { toast('CSV sent to Telegram!'); return; }
  } catch(e) {}

  // Fallback: generate in browser
  const subs = state.subscriptions;
  const csv  = 'Name,Provider,Category,Monthly Cost,Currency,Renewal,Status,Health\n' +
    subs.map(s => `${s.name},${s.provider},${s.category},${s.monthly_cost},${s.currency},${s.next_renewal},${s.status},${s.health_score}`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'subbot-subscriptions.csv';
  a.click();
  toast('CSV downloaded!');
}

// ── Reset ─────────────────────────────────────────────────────────────────
function resetBot() {
  if (confirm('Reset all SubBot data? This cannot be undone.')) {
    state = { telegramUserId: null, subscriptions: [], budget: 100, balance: 0, txHistory: [] };
    saveState();
    w3aRemove(() => {
      renderW3AStatus(null);
      showScreen('welcome');
    });
  }
}

// ── Prefs toggle ──────────────────────────────────────────────────────────
function togglePref(btn) {
  const on = btn.dataset.on !== 'true';
  btn.dataset.on = String(on);
  btn.classList.toggle('bg-primary/20', on);
  btn.classList.toggle('bg-panel', !on);
  const dot = btn.querySelector('div');
  dot.classList.toggle('bg-primary', on);
  dot.classList.toggle('bg-outline', !on);
  dot.classList.toggle('ml-auto', on);
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  await loadState();

  const searchInput = document.getElementById('sub-search');
  if (searchInput) searchInput.addEventListener('input', () => { searchQ = searchInput.value.toLowerCase(); renderSubs(); });

  // Draw project wallet QR on credits screen (static, always the same)
  drawQR('credits-qr', PROJECT_WALLET);
  document.querySelectorAll('.project-addr-short').forEach(el => el.textContent = shortAddr(PROJECT_WALLET));

  // Load Web3Auth state — clear if token is older than 23h (tokens expire at 24h)
  const TOKEN_TTL = 23 * 60 * 60 * 1000;
  const w3a = await new Promise(r => w3aGet(r));
  if (w3a?.idToken && (Date.now() - (w3a.loginAt || 0)) < TOKEN_TTL) {
    renderW3AStatus(w3a);
    if (!state.telegramUserId || state.telegramUserId.startsWith('w3a:')) {
      state.telegramUserId = `w3a:${w3a.verifier}:${w3a.verifierId}`;
      fetchUserData().catch(() => {});
      showScreen('dashboard');
      return;
    }
  } else {
    if (w3a?.idToken) w3aRemove(); // expired — clear silently
    renderW3AStatus(null);
  }

  if (state.telegramUserId) {
    // Already paired via Telegram — refresh in background, show dashboard
    fetchUserData().catch(() => {});
    showScreen('dashboard');
  } else {
    showScreen('welcome');
  }

  // Background sync every 60s
  setInterval(() => fetchUserData().catch(() => {}), 60000);
}

document.addEventListener('DOMContentLoaded', init);
