/* popup.js — SubBot Extension (view layer for @SubmanagerAgentBot) */

const API            = 'https://subbotai.xyz';

// ── Web3Auth ──────────────────────────────────────────────────────────────────
const W3A_CLIENT_ID = 'BCkzpmFTjh9pTHe7LGNlrg_jo22W7DNHGkkZSbgrQlOeSf7AzRZ1qdZXDRyxplEq5knOTiCjhH-uga6tpnASP1o';
const CELO_CHAIN = {
  chainNamespace: 'eip155',
  chainId: '0xa4ec',        // Celo mainnet = 42220
  rpcTarget: 'https://forno.celo.org',
  displayName: 'Celo',
  blockExplorerUrl: 'https://celoscan.io',
  ticker: 'CELO',
  tickerName: 'CELO',
};

const CURRENCY_SYMBOLS = { USD:'$', EUR:'€', GBP:'£', NGN:'₦', KES:'KSh', GHS:'GH₵', ZAR:'R', 'G$':'G$', cUSD:'cUSD' };
function cSym(code) { return CURRENCY_SYMBOLS[code] || code || '$'; }

function subFaviconUrl(sub) {
  const name = (sub.provider || sub.name || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  if (!name) return '';
  return `https://www.google.com/s2/favicons?domain=${name}.com&sz=64`;
}

function faviconImg(sub, sizeClass = 'w-10 h-10') {
  const url = subFaviconUrl(sub);
  if (!url) return `<div class="${sizeClass} rounded-lg bg-panel flex items-center justify-center font-bold text-lg text-primary">${sub.name.charAt(0)}</div>`;
  const initBg = sub.category === 'ai' ? 'text-primary' : 'text-secondary';
  return `<img src="${url}" alt="${sub.name}" class="${sizeClass} rounded-lg bg-panel object-contain" onerror="this.outerHTML='<div class=\\'${sizeClass} rounded-lg bg-panel flex items-center justify-center font-bold text-lg ${initBg}\\'>${sub.name.charAt(0)}</div>'"/>`;
}

// ── GoodDollar contracts (Celo mainnet) ──────────────────────────────────
const GD_IDENTITY = '0xC361A6E67822a0EDc17D899227dd9FC50BD62F42';
const GD_UBISCHEME = '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1';
const GD_TOKEN = '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A';
// ABI encodings (4-byte selectors)
const SEL_IS_WHITELISTED = '0x3af32abf'; // isWhitelisted(address)
const SEL_CHECK_ENTITLEMENT = '0x0a4d564c'; // checkEntitlement(address)
const SEL_CLAIM = '0x4e71d92d'; // claim()
const SEL_BALANCE_OF = '0x70a08231'; // balanceOf(address)

function padAddr(addr) { return '000000000000000000000000' + addr.slice(2).toLowerCase(); }

async function ethCall(to, data) {
  const r = await fetch('https://forno.celo.org', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await r.json();
  return j.result;
}

async function checkGDStatus(address) {
  const statusEl = document.getElementById('gd-status');
  const claimBtn = document.getElementById('gd-claim-btn');
  const claimableEl = document.getElementById('gd-claimable');
  const verifyLink = document.getElementById('gd-verify-link');
  if (!statusEl || !address) return;

  claimBtn?.classList.add('hidden');
  verifyLink?.classList.add('hidden');

  try {
    // Check whitelisted with Web3Auth address first
    let wlResult = await ethCall(GD_IDENTITY, SEL_IS_WHITELISTED + padAddr(address));
    let isWhitelisted = wlResult && BigInt(wlResult) === 1n;
    let activeAddr = address;

    // If Web3Auth address isn't verified, try injected wallet (MiniPay / MetaMask)
    // — the user's GD-verified address is likely their browser wallet, not Web3Auth
    if (!isWhitelisted && window.ethereum) {
      try {
        const injectedAccounts = await window.ethereum.request({ method: 'eth_accounts' });
        const injectedAddr = injectedAccounts?.[0];
        if (injectedAddr && injectedAddr.toLowerCase() !== address.toLowerCase()) {
          const wl2 = await ethCall(GD_IDENTITY, SEL_IS_WHITELISTED + padAddr(injectedAddr));
          if (wl2 && BigInt(wl2) === 1n) {
            isWhitelisted = true;
            activeAddr = injectedAddr;
            // Store the GD-verified address for claiming
            localStorage.setItem('gd-verified-addr', injectedAddr);
          }
        }
      } catch (_) {}
    }

    // Also check previously stored GD address
    if (!isWhitelisted) {
      const storedGD = localStorage.getItem('gd-verified-addr');
      if (storedGD && storedGD.toLowerCase() !== address.toLowerCase()) {
        const wl3 = await ethCall(GD_IDENTITY, SEL_IS_WHITELISTED + padAddr(storedGD));
        if (wl3 && BigInt(wl3) === 1n) {
          isWhitelisted = true;
          activeAddr = storedGD;
        }
      }
    }

    if (!isWhitelisted) {
      statusEl.innerHTML = 'Not verified. <button id="gd-check-injected" class="text-emerald-500 underline text-xs">Connect GoodDollar wallet</button>';
      verifyLink?.classList.remove('hidden');
      verifyLink?.classList.add('inline-flex');
      // Add click handler for connecting injected wallet
      document.getElementById('gd-check-injected')?.addEventListener('click', connectGDWallet);
      return;
    }

    // Check entitlement using the verified address
    const entResult = await ethCall(GD_UBISCHEME, SEL_CHECK_ENTITLEMENT + padAddr(activeAddr));
    const entitlement = entResult ? BigInt(entResult) : 0n;

    if (entitlement > 0n) {
      const amount = (Number(entitlement) / 1e18).toFixed(2);
      claimableEl.textContent = amount + ' G$';
      statusEl.textContent = 'You have G$ to claim!';
      claimBtn?.classList.remove('hidden');
    } else {
      claimableEl.textContent = '';
      statusEl.textContent = 'Already claimed today. Come back tomorrow!';
    }
  } catch (err) {
    console.error('GD check error:', err);
    statusEl.textContent = 'Could not check eligibility.';
  }
}

async function claimGD() {
  const btn = document.getElementById('gd-claim-btn');
  const statusEl = document.getElementById('gd-status');
  if (!web3authInstance?.provider) { toast('Connect wallet first'); return; }

  btn.textContent = 'Claiming…';
  btn.disabled = true;

  try {
    const accounts = await web3authInstance.provider.request({ method: 'eth_accounts' });
    const from = accounts?.[0];
    if (!from) throw new Error('No account');

    const txHash = await web3authInstance.provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: GD_UBISCHEME, data: SEL_CLAIM, gas: '0x30D40' }], // 200k gas
    });

    statusEl.textContent = 'Confirming…';

    // Poll for receipt
    let receipt = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const resp = await fetch('https://forno.celo.org', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
      });
      const j = await resp.json();
      if (j.result) { receipt = j.result; break; }
    }

    if (receipt?.status === '0x1') {
      statusEl.innerHTML = '<span style="color:#00C58E;font-weight:700">✓ Claimed! G$ incoming.</span>';
      btn.classList.add('hidden');
      document.getElementById('gd-claimable').textContent = '';
      toast('G$ claimed successfully!');
      // Refresh after a moment
      setTimeout(() => checkGDStatus(accounts[0]), 3000);
    } else {
      statusEl.textContent = 'Transaction failed.';
      btn.textContent = 'Retry Claim';
      btn.disabled = false;
    }
  } catch (err) {
    console.error('GD claim error:', err);
    if (err.message?.includes('user') || err.message?.includes('User')) {
      statusEl.textContent = 'Claim cancelled.';
    } else {
      statusEl.textContent = 'Claim failed: ' + (err.message || 'unknown error');
    }
    btn.textContent = 'Retry Claim';
    btn.disabled = false;
  }
}

async function connectGDWallet() {
  if (!window.ethereum) {
    toast('No wallet detected. Install MetaMask or use MiniPay.');
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const addr = accounts?.[0];
    if (!addr) { toast('No account found'); return; }

    const wl = await ethCall(GD_IDENTITY, SEL_IS_WHITELISTED + padAddr(addr));
    if (wl && BigInt(wl) === 1n) {
      localStorage.setItem('gd-verified-addr', addr);
      toast('GoodDollar identity verified!');
      checkGDStatus(addr);
    } else {
      toast('This wallet is not GoodDollar verified');
    }
  } catch (err) {
    toast('Could not connect wallet');
  }
}

let web3authInstance = null;
let web3authInitPromise = null;

async function waitForSDK() {
  if (window.Modal) return;
  return new Promise(resolve => {
    const check = setInterval(() => {
      if (window.Modal) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 10000);
  });
}

async function getWeb3Auth() {
  if (web3authInstance) return web3authInstance;
  if (web3authInitPromise) return web3authInitPromise;

  web3authInitPromise = (async () => {
    await waitForSDK();
    if (!window.Modal) throw new Error('Web3Auth SDK failed to load');
    const { Web3Auth, WEB3AUTH_NETWORK } = window.Modal;
    const instance = new Web3Auth({
      clientId: W3A_CLIENT_ID,
      chains: [CELO_CHAIN],
      defaultChainId: '0xa4ec',
      web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_MAINNET,
    });

    try {
      await instance.init();
    } catch (initErr) {
      console.error('Web3Auth init failed:', initErr);
      web3authInitPromise = null;
      throw initErr;
    }
    web3authInstance = instance;
    return instance;
  })();

  return web3authInitPromise;
}

// Storage helpers
function w3aGet(cb) {
  try { cb(JSON.parse(localStorage.getItem('web3auth'))); } catch { cb(null); }
}
function w3aSet(data, cb) {
  localStorage.setItem('web3auth', JSON.stringify(data));
  if (cb) cb();
}
function w3aRemove(cb) {
  localStorage.removeItem('web3auth');
  if (cb) cb();
}

async function openWeb3AuthModal() {
  try {
    const w3a = await getWeb3Auth();
    try { if (w3a.connected) await w3a.logout(); } catch (_) {}
    const provider = await w3a.connect();
    if (!provider) { toast('Login cancelled'); return; }

    // Get wallet address from provider
    const accounts = await provider.request({ method: 'eth_accounts' });
    const address  = accounts?.[0] || '';

    // getUserInfo works for social logins; external wallets may not have it
    let info = {};
    try { info = await w3a.getUserInfo() || {}; } catch (_) {}

    const payload = {
      idToken:       info.idToken      || '',
      email:         info.email        || '',
      name:          info.name         || '',
      profileImage:  info.profileImage || '',
      verifier:      info.verifier     || 'wallet',
      verifierId:    info.verifierId   || address,
      walletAddress: address,
      loginAt:       Date.now(),
    };
    w3aSet(payload);
    renderW3AStatus(payload);

    // Set userId from wallet address (works for both social + external wallets)
    state.userId = address ? `w3a:${payload.verifier}:${address}` : `w3a:${payload.verifier}:${payload.verifierId}`;
    saveState();

    const gotData = await fetchUserData(false);
    toast(gotData ? `Welcome back!` : `Connected: ${address ? address.slice(0,6) + '…' + address.slice(-4) : payload.name || 'user'}`);
    showScreen('dashboard');
    if (address) checkGDStatus(address).catch(() => {});
  } catch (err) {
    console.error('Web3Auth error:', err);
    if (!err.message?.includes('user closed') && !err.message?.includes('User closed')) {
      toast('Login failed — try again');
    }
  }
}

function renderW3AStatus(w3a) {
  const walletStrip = document.getElementById('wallet-strip');
  if (!w3a?.loginAt) {
    document.getElementById('settings-w3a-logged-out')?.classList.remove('hidden');
    document.getElementById('settings-w3a-logged-in')?.classList.add('hidden');
    if (walletStrip) walletStrip.classList.add('hidden');
    return;
  }

  const addr = w3a.walletAddress || '';
  const initial = (w3a.name || w3a.email || addr || '?').charAt(0).toUpperCase();
  const displayName = w3a.name || w3a.email || (addr ? addr.slice(0,6) + '…' + addr.slice(-4) : 'Connected');
  const shortAddr = addr ? addr.slice(0,6) + '…' + addr.slice(-4) : '';

  // Settings screen
  document.getElementById('settings-w3a-logged-out')?.classList.add('hidden');
  const loggedIn = document.getElementById('settings-w3a-logged-in');
  if (loggedIn) {
    loggedIn.classList.remove('hidden');
    document.getElementById('settings-w3a-avatar').textContent = initial;
    document.getElementById('settings-w3a-name').textContent   = displayName;
    document.getElementById('settings-w3a-email').textContent  = addr || w3a.email || '';
    document.getElementById('settings-w3a-userid').textContent = state.userId || '';
  }

  // Dashboard wallet strip
  if (walletStrip && addr) {
    walletStrip.classList.remove('hidden');
    document.getElementById('strip-wallet').textContent = shortAddr;
  }
}

function copyWalletAddress() {
  w3aGet(w3a => {
    const addr = w3a?.walletAddress || '';
    if (!addr) { toast('No wallet connected'); return; }
    navigator.clipboard.writeText(addr).then(() => toast('Wallet address copied!')).catch(() => toast('Copy failed'));
  });
}


async function web3authLogout() {
  try { if (web3authInstance?.connected) await web3authInstance.logout(); web3authInstance = null; web3authInitPromise = null; } catch (_) {}
  w3aRemove(() => {
    renderW3AStatus(null);
    state.userId = null;
    state.subscriptions  = [];
    state.balance        = 0;
    state.txHistory      = [];
    saveState();
    toast('Signed out');
    showScreen('welcome');
  });
}

let state = {
  userId:         null,
  subscriptions:  [],
  budget:         100,
  balance:        0,
  txHistory:      [],
};

// ── User ID ───────────────────────────────────────────────────────────────
function userId() { return state.userId || 'local'; }

// ── State persistence ─────────────────────────────────────────────────────
function saveState() {
  localStorage.setItem('subbot', JSON.stringify(state));
}

async function loadState() {
  try {
    const d = localStorage.getItem('subbot');
    if (d) Object.assign(state, JSON.parse(d));
  } catch (_) {}
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
    case 'refreshData':      refreshData(); break;
    case 'addSub':           showAddSubModal(); break;
    case 'saveManualSub':    saveManualSub(); break;
    case 'filter':           if (filter) setFilter(filter); break;
    case 'saveBudget':       saveBudget(); break;
    case 'exportAction':     exportCSV(); break;
    case 'resetBot':         resetBot(); break;
    case 'closeModal':       if (modal) document.getElementById(modal)?.classList.remove('active'); break;
    case 'copyNeg':          copyNegotiationEmail(); break;
    case 'draftEmail':       draftEmail(el.dataset.service); break;
    case 'togglePref':       togglePref(el); break;
    case 'web3authLogin':    openWeb3AuthModal(); break;
    case 'web3authLogout':   web3authLogout(); break;
    case 'copyWallet':       copyWalletAddress(); break;
    case 'claimGD':          claimGD(); break;
    case 'showSubDetail':    showSubDetail(el.dataset.subId); break;
    case 'deleteSub':        e.stopPropagation(); deleteSub(el.dataset.subId); break;
    case 'editSubFromDetail': editSub(detailSubId); break;
    case 'deleteSubFromDetail': document.getElementById('modal-sub-detail')?.classList.remove('active'); deleteSub(detailSubId); break;
    case 'toggleTheme':      toggleTheme(); break;
    case 'pwaInstall':       installPWA(); break;
    case 'pwaDismiss':       document.getElementById('pwa-install-banner')?.classList.add('hidden'); localStorage.setItem('pwa-dismissed', '1'); break;
    case 'shareApp':         shareApp(); break;
    case 'showGmailModal':   document.getElementById('modal-gmail-scan')?.classList.add('active'); prefillGmailModal(); break;
    case 'runGmailScan':     runGmailScan(); break;
    case 'scanGmail':        runSettingsGmailScan(); break;
    case 'copyVaultAddr':    copyVaultAddr(); break;
    case 'togglePushNotifications': togglePushNotifications(); break;
  }
});


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

// ── Onboarding ────────────────────────────────────────────────────────────

// ── Dashboard ─────────────────────────────────────────────────────────────
function refreshDashboard() {
  const subs    = state.subscriptions.filter(s => s.status === 'active');
  const monthly = subs.reduce((sum, s) => sum + (s.monthly_cost_usd || s.monthly_cost || 0), 0);
  const budget  = state.budget || 100;
  const pct     = Math.min(100, Math.round(monthly / budget * 100));
  // Detect dominant currency
  const currencies = subs.map(s => s.currency || 'USD');
  const mainCur = currencies.sort((a,b) => currencies.filter(v=>v===b).length - currencies.filter(v=>v===a).length)[0] || 'USD';
  const sym = cSym(mainCur);

  document.getElementById('dash-spend').textContent  = sym + monthly.toFixed(0);
  document.getElementById('dash-budget').textContent = '/ ' + sym + budget;
  document.getElementById('dash-pct').textContent    = pct + '%';
  const ring = document.getElementById('budget-ring');
  if (ring) {
    ring.setAttribute('stroke-dashoffset', 376.99 * (1 - pct / 100));
    ring.classList.toggle('text-error', pct >= 100);
  }

  document.getElementById('stat-count').textContent    = subs.length;
  document.getElementById('stat-annual').textContent   = sym + (monthly * 12).toFixed(0);

  const now  = new Date();
  const soon = subs.filter(s => s.next_renewal && (new Date(s.next_renewal) - now) / 86400000 <= 30).length;
  document.getElementById('stat-renewals').textContent = soon;

  const hdr = document.getElementById('header-status');
  if (hdr) {
    hdr.textContent = subs.length ? `● ${subs.length} subs` : '● No data';
  }

  const strip = document.getElementById('strip-balance');
  if (strip) strip.textContent = (state.balance || 0).toFixed(2) + ' G$';

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
        <div><p class="text-sm font-semibold">${s.name}</p><p class="text-[10px] text-muted font-mono">${dateStr} · ${cSym(s.currency)}${s.monthly_cost}</p></div>
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
    const cost    = s.monthly_cost_usd || s.monthly_cost || 0;
    const sym     = cSym(s.currency);
    return `<div class="h-[72px] glass rounded-xl px-3 flex items-center gap-3 border border-edge hover:bg-panel/40 transition-all cursor-pointer" data-action="showSubDetail" data-sub-id="${s.id}">
      <div class="flex-shrink-0">${faviconImg(s)}</div>
      <div class="flex-1 min-w-0">
        <div class="flex justify-between items-start">
          <h3 class="font-semibold text-sm truncate">${s.name}</h3>
          <span class="font-mono text-sm font-medium">${sym}${cost}<span class="text-[10px] text-muted">/mo</span></span>
        </div>
        <div class="flex items-center gap-2 mt-0.5">
          <span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary/10 text-secondary">${s.category || 'SaaS'}</span>
          <span class="${hColor} text-[10px] font-mono">♥ ${health}</span>
          ${s.next_renewal ? `<span class="text-[10px] text-muted ml-auto">Renew: ${new Date(s.next_renewal).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>` : ''}
        </div>
      </div>
      <button data-action="deleteSub" data-sub-id="${s.id}" class="flex-shrink-0 p-1.5 rounded-lg hover:bg-error/10 text-muted hover:text-error transition-colors" title="Delete">
        <i class="fa-solid fa-trash-can text-xs"></i>
      </button>
    </div>`;
  }).join('');
}

// ── Subscription Detail ──────────────────────────────────────────────────
let detailSubId = null;

function showSubDetail(id) {
  const sub = state.subscriptions.find(s => s.id === id);
  if (!sub) return;
  detailSubId = id;
  const content = document.getElementById('sub-detail-content');
  const cost = sub.monthly_cost_usd || sub.monthly_cost || 0;
  const sym = cSym(sub.currency);
  const health = sub.health_score || 0;
  const hColor = health >= 80 ? 'text-tertiary' : health >= 50 ? 'text-amber-400' : 'text-error';
  const created = sub.created_at ? new Date(sub.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const renewal = sub.next_renewal ? new Date(sub.next_renewal).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  content.innerHTML = `
    <div class="flex items-center gap-3 mb-2">
      ${faviconImg(sub, 'w-12 h-12')}
      <div>
        <h3 class="text-lg font-bold">${sub.name}</h3>
        <p class="text-xs text-muted">${sub.provider || sub.name}</p>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-2">
      <div class="bg-panel rounded-lg p-2.5"><p class="text-[10px] text-muted uppercase tracking-wider">Cost</p><p class="text-sm font-bold font-mono">${sym}${cost}/mo</p></div>
      <div class="bg-panel rounded-lg p-2.5"><p class="text-[10px] text-muted uppercase tracking-wider">Category</p><p class="text-sm font-semibold capitalize">${sub.category || 'Other'}</p></div>
      <div class="bg-panel rounded-lg p-2.5"><p class="text-[10px] text-muted uppercase tracking-wider">Renewal</p><p class="text-sm font-mono">${renewal}</p></div>
      <div class="bg-panel rounded-lg p-2.5"><p class="text-[10px] text-muted uppercase tracking-wider">Health</p><p class="text-sm font-bold font-mono ${hColor}">♥ ${health}/100</p></div>
      <div class="bg-panel rounded-lg p-2.5"><p class="text-[10px] text-muted uppercase tracking-wider">Currency</p><p class="text-sm font-mono">${sub.currency || 'USD'}</p></div>
      <div class="bg-panel rounded-lg p-2.5"><p class="text-[10px] text-muted uppercase tracking-wider">Added</p><p class="text-sm font-mono">${created}</p></div>
    </div>`;
  document.getElementById('modal-sub-detail')?.classList.add('active');
}

// ── Delete Subscription ──────────────────────────────────────────────────
async function deleteSub(id) {
  const sub = state.subscriptions.find(s => s.id === id);
  if (!sub) return;
  if (!confirm(`Delete "${sub.name}"?`)) return;

  state.subscriptions = state.subscriptions.filter(s => s.id !== id);
  saveState();

  try {
    await fetch(`${API}/delete-sub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subId: id, userId: userId() }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (_) {}

  toast(`${sub.name} deleted`);
  renderSubs();
  refreshDashboard();
}

// ── Edit Subscription ────────────────────────────────────────────────────
let editingSubId = null;

function editSub(id) {
  const sub = state.subscriptions.find(s => s.id === id);
  if (!sub) return;
  editingSubId = id;

  document.getElementById('add-sub-title').textContent = 'Edit Subscription';
  document.getElementById('add-sub-save-btn').textContent = 'Save Changes';
  document.getElementById('add-sub-name').value = sub.name || '';
  document.getElementById('add-sub-provider').value = sub.provider || '';
  document.getElementById('add-sub-cost').value = sub.monthly_cost || '';
  document.getElementById('add-sub-currency').value = sub.currency || 'USD';
  document.getElementById('add-sub-renewal').value = sub.next_renewal || '';
  document.getElementById('add-sub-category').value = sub.category || 'saas';

  document.getElementById('modal-sub-detail')?.classList.remove('active');
  document.getElementById('modal-add-sub')?.classList.add('active');
}

// ── Audit ─────────────────────────────────────────────────────────────────
function runAudit() {
  const subs    = state.subscriptions.filter(s => s.status === 'active');
  const monthly = subs.reduce((sum, s) => sum + (s.monthly_cost_usd || s.monthly_cost || 0), 0);
  const currencies = subs.map(s => s.currency || 'USD');
  const mainCur = currencies.sort((a,b) => currencies.filter(v=>v===b).length - currencies.filter(v=>v===a).length)[0] || 'USD';
  const sym = cSym(mainCur);
  document.getElementById('audit-monthly').textContent = sym + monthly.toFixed(2);
  document.getElementById('audit-annual').textContent  = sym + (monthly * 12).toFixed(2);

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
      <span class="text-xs font-mono mx-2">${cSym(s.currency)}${s.monthly_cost_usd || s.monthly_cost}</span>
      <div class="w-16 bg-panel rounded-full h-1.5 mr-2"><div class="${bc} h-1.5 rounded-full" style="width:${h}%"></div></div>
      <span class="text-[10px] whitespace-nowrap">${badge}</span>
    </div>`;
  }).join('') || '<p class="text-xs text-muted text-center py-3">No data.</p>';

  const wins = [];
  overlaps.forEach(([cat, names]) => {
    const catSubs = subs.filter(s => s.category === cat);
    const minCost = Math.min(...catSubs.map(s => s.monthly_cost_usd || s.monthly_cost || 0));
    wins.push(`Cancel one of your ${names.length} ${cat} tools — save ~${minCost}/mo`);
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
            <span class="font-mono text-sm">${cSym(s.currency)}${s.monthly_cost}</span>
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
    const amt       = isDeposit ? `+${tx.amount?.toFixed(2)} G$` : `-${tx.amount?.toFixed(2)} G$`;
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

// ── Manual add ────────────────────────────────────────────────────────────
function showAddSubModal() {
  editingSubId = null;
  document.getElementById('add-sub-title').textContent = 'Add Subscription';
  document.getElementById('add-sub-save-btn').textContent = 'Add Subscription';
  ['add-sub-name', 'add-sub-provider', 'add-sub-cost', 'add-sub-renewal'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const cur = document.getElementById('add-sub-currency');
  if (cur) cur.value = 'USD';
  document.getElementById('add-sub-category').value = 'saas';
  document.getElementById('modal-add-sub')?.classList.add('active');
}

async function saveManualSub() {
  const name = document.getElementById('add-sub-name')?.value?.trim();
  const cost = parseFloat(document.getElementById('add-sub-cost')?.value);
  if (!name) { toast('Name is required'); return; }
  if (isNaN(cost) || cost < 0) { toast('Enter a valid cost'); return; }

  const sub = {
    id:              editingSubId || ('manual-' + Date.now()),
    name,
    provider:        document.getElementById('add-sub-provider')?.value?.trim() || name,
    category:        document.getElementById('add-sub-category')?.value || 'saas',
    monthly_cost:    cost,
    monthly_cost_usd: cost,
    currency:        (document.getElementById('add-sub-currency')?.value?.trim() || 'USD').toUpperCase(),
    next_renewal:    document.getElementById('add-sub-renewal')?.value || null,
    status:          'active',
    health_score:    editingSubId ? (state.subscriptions.find(s => s.id === editingSubId)?.health_score || 70) : 70,
    source:          'manual',
  };

  if (editingSubId) {
    // Update existing
    state.subscriptions = state.subscriptions.map(s => s.id === editingSubId ? { ...s, ...sub } : s);
    try {
      await fetch(`${API}/update-sub`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub, userId: userId() }),
        signal: AbortSignal.timeout(4000),
      });
    } catch (_) {}
    toast(`${name} updated!`);
  } else {
    // Add new
    try {
      await fetch(`${API}/add-sub`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub, userId: userId() }),
        signal: AbortSignal.timeout(4000),
      });
    } catch (_) {}
    state.subscriptions = [...(state.subscriptions || []), sub];
    toast(`${name} added!`);
  }

  editingSubId = null;
  saveState();
  document.getElementById('modal-add-sub')?.classList.remove('active');
  renderSubs();
  refreshDashboard();
  scheduleRenewalNotifications();

  // Immediate renewal alert if within 7 days
  if (sub.next_renewal) {
    const days = Math.ceil((new Date(sub.next_renewal) - new Date()) / 86400000);
    if (days >= 0 && days <= 7) {
      setTimeout(() => {
        toast(`⚠️ ${sub.name} renews in ${days} day${days === 1 ? '' : 's'}!`);
        showAlertBadge();
      }, 500);
    }
  }
}

function showAlertBadge() {
  const alertNav = document.querySelector('[data-screen="alerts"]');
  if (!alertNav && !document.getElementById('alert-badge')) return;
  if (alertNav && !document.getElementById('alert-badge')) {
    const badge = document.createElement('span');
    badge.id = 'alert-badge';
    badge.className = 'absolute -top-1 -right-1 w-2.5 h-2.5 bg-error rounded-full animate-pulse';
    alertNav.style.position = 'relative';
    alertNav.appendChild(badge);
  }
}

// ── Export ────────────────────────────────────────────────────────────────
async function exportCSV() {
  try {
    const r = await fetch(`${API}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: userId() }) });
    if (r.ok) { toast('CSV exported!'); return; }
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
    state = { userId: null, subscriptions: [], budget: 100, balance: 0, txHistory: [] };
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

// ── Share ─────────────────────────────────────────────────────────────────
async function shareApp() {
  const shareData = {
    title: 'SubBot — AI Subscription Manager',
    text: 'Track, audit, and optimise your SaaS spend with SubBot. Free on Celo.',
    url: 'https://subbotai.xyz',
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; } catch (_) {}
  }
  navigator.clipboard.writeText('Check out SubBot — AI subscription manager on Celo: https://subbotai.xyz')
    .then(() => toast('Link copied!'))
    .catch(() => toast('Copy failed'));
}

// ── Gmail Scan ───────────────────────────────────────────────────────────
function prefillGmailModal() {
  // Pre-fill from settings inputs if available
  const se = document.getElementById('settings-email')?.value;
  const sp = document.getElementById('settings-password')?.value;
  if (se) document.getElementById('gmail-scan-email').value = se;
  if (sp) document.getElementById('gmail-scan-password').value = sp;
}

async function runGmailScan() {
  const email    = document.getElementById('gmail-scan-email')?.value?.trim();
  const password = document.getElementById('gmail-scan-password')?.value?.trim();
  if (!email || !password) { toast('Email and App Password required'); return; }

  const btn = document.querySelector('[data-action="runGmailScan"]');
  const origText = btn?.innerHTML;
  if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-sm"></i> Scanning…'; btn.disabled = true; }

  try {
    const r = await fetch(`${API}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, userId: userId() }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Scan failed');

    const found = data.subscriptions || [];
    if (found.length) {
      // Merge with existing subs (avoid duplicates by name)
      const existing = new Set(state.subscriptions.map(s => s.name.toLowerCase()));
      let added = 0;
      found.forEach(s => {
        if (!existing.has(s.name.toLowerCase())) {
          s.id = s.id || ('scan-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
          s.status = s.status || 'active';
          s.source = 'gmail';
          state.subscriptions.push(s);
          added++;
        }
      });
      saveState();
      toast(`Found ${found.length} subs, ${added} new added!`);
    } else {
      toast('No subscriptions found in Gmail');
    }

    // Save credentials for future scans
    if (document.getElementById('settings-email')) document.getElementById('settings-email').value = email;
    if (document.getElementById('settings-password')) document.getElementById('settings-password').value = password;

    document.getElementById('modal-gmail-scan')?.classList.remove('active');
    renderSubs();
    refreshDashboard();
    scheduleRenewalNotifications();
  } catch (err) {
    console.error('Gmail scan error:', err);
    toast('Scan failed — check email and app password');
  } finally {
    if (btn) { btn.innerHTML = origText; btn.disabled = false; }
  }
}

async function runSettingsGmailScan() {
  const email    = document.getElementById('settings-email')?.value?.trim();
  const password = document.getElementById('settings-password')?.value?.trim();
  if (!email || !password) { toast('Enter email and App Password first'); return; }

  // Copy to modal and run
  document.getElementById('gmail-scan-email').value = email;
  document.getElementById('gmail-scan-password').value = password;
  await runGmailScan();
}

function copyVaultAddr() {
  const addr = document.getElementById('vault-addr')?.textContent;
  if (!addr || addr === 'Loading…') { toast('No address'); return; }
  navigator.clipboard.writeText(addr).then(() => toast('Address copied!')).catch(() => toast('Copy failed'));
}

// ── Theme Toggle ─────────────────────────────────────────────────────────
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('subbot-theme', isDark ? 'dark' : 'light');
}

function applyTheme() {
  const saved = localStorage.getItem('subbot-theme');
  const isDark = saved !== 'light';
  document.documentElement.classList.toggle('dark', isDark);
}

// ── PWA Install ──────────────────────────────────────────────────────────
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (localStorage.getItem('pwa-dismissed') !== '1') {
    document.getElementById('pwa-install-banner')?.classList.remove('hidden');
  }
});

async function installPWA() {
  if (!deferredInstallPrompt) { toast('Install not available'); return; }
  deferredInstallPrompt.prompt();
  const result = await deferredInstallPrompt.userChoice;
  if (result.outcome === 'accepted') {
    toast('SubBot installed!');
    document.getElementById('pwa-install-banner')?.classList.add('hidden');
  }
  deferredInstallPrompt = null;
}

// ── Push Notifications ───────────────────────────────────────────────────
function requestNotificationPermission() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem('push-asked')) return;
  setTimeout(() => {
    if (Notification.permission !== 'default') return;
    localStorage.setItem('push-asked', '1');
    Notification.requestPermission();
  }, 5000);
}

function scheduleRenewalNotifications() {
  if (!('serviceWorker' in navigator)) return;
  if (Notification.permission !== 'granted') return;
  if (localStorage.getItem('push-enabled') === 'false') return;
  navigator.serviceWorker.ready.then(reg => {
    if (!reg.active) return;
    const subs = (state.subscriptions || []).filter(s => s.status === 'active' && s.next_renewal);
    reg.active.postMessage({ type: 'schedule-renewals', subs });
  });
}

function togglePushNotifications() {
  if (!('Notification' in window)) { toast('Notifications not supported'); return; }
  const current = localStorage.getItem('push-enabled') !== 'false';
  if (current) {
    localStorage.setItem('push-enabled', 'false');
    toast('Push notifications disabled');
  } else {
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          localStorage.setItem('push-enabled', 'true');
          toast('Push notifications enabled');
          scheduleRenewalNotifications();
        } else {
          toast('Permission denied by browser');
        }
        renderPushToggle();
      });
      return;
    } else if (Notification.permission === 'denied') {
      toast('Blocked — enable in browser settings');
      return;
    }
    localStorage.setItem('push-enabled', 'true');
    toast('Push notifications enabled');
    scheduleRenewalNotifications();
  }
  renderPushToggle();
}

function renderPushToggle() {
  const btn = document.getElementById('push-toggle-btn');
  if (!btn) return;
  const enabled = ('Notification' in window) && Notification.permission === 'granted' && localStorage.getItem('push-enabled') !== 'false';
  btn.textContent = enabled ? 'Disable' : 'Enable';
  btn.className = enabled
    ? 'px-4 py-1.5 rounded-lg bg-error/10 text-error text-xs font-bold active:scale-95 transition-all'
    : 'px-4 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-bold active:scale-95 transition-all';
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  applyTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  await loadState();

  // Migrate legacy telegramUserId to userId
  if (state.telegramUserId && !state.userId) {
    state.userId = state.telegramUserId;
    delete state.telegramUserId;
    saveState();
  }

  const searchInput = document.getElementById('sub-search');
  if (searchInput) searchInput.addEventListener('input', () => { searchQ = searchInput.value.toLowerCase(); renderSubs(); });


  // Check for existing session
  const w3a = await new Promise(r => w3aGet(r));
  if (w3a?.loginAt && state.userId) {
    // Already connected — go straight to dashboard
    renderW3AStatus(w3a);
    fetchUserData().catch(() => {});
    showScreen('dashboard');
    if (w3a.walletAddress) checkGDStatus(w3a.walletAddress).catch(() => {});
  } else {
    // Not connected — show welcome, then open Web3Auth modal once SDK is ready
    w3aRemove();
    renderW3AStatus(null);
    showScreen('welcome');
    waitForSDK().then(() => openWeb3AuthModal());
  }

  // Show startup renewal alerts for subs due within 3 days
  setTimeout(() => {
    const now = new Date();
    const urgent = state.subscriptions.filter(s =>
      s.status === 'active' && s.next_renewal &&
      Math.ceil((new Date(s.next_renewal) - now) / 86400000) <= 3 &&
      Math.ceil((new Date(s.next_renewal) - now) / 86400000) >= 0
    );
    if (urgent.length) {
      toast(`⚠️ ${urgent.length} subscription${urgent.length > 1 ? 's' : ''} renew${urgent.length === 1 ? 's' : ''} within 3 days!`);
      showAlertBadge();
    }
  }, 2000);

  // Push notifications
  requestNotificationPermission();
  scheduleRenewalNotifications();
  renderPushToggle();

  // Handle SW messages (e.g. notification click → navigate to alerts)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'nav' && e.data.screen) showScreen(e.data.screen);
      if (e.data?.type === 'refresh-data') fetchUserData().catch(() => {});
    });
  }

  // Background sync every 60s
  setInterval(() => fetchUserData().catch(() => {}), 60000);
}

document.addEventListener('DOMContentLoaded', init);
