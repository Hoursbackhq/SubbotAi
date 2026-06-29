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

// ── Exchange Rates (cached 24h) ──────────────────────────────────────────
let _fxRates = null;
async function getFxRates() {
  if (_fxRates) return _fxRates;
  const cached = localStorage.getItem('fx-rates');
  if (cached) {
    const { ts, rates } = JSON.parse(cached);
    if (Date.now() - ts < 86400000) { _fxRates = rates; return rates; }
  }
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD');
    const json = await resp.json();
    if (json.result === 'success' && json.rates) {
      _fxRates = json.rates;
      _fxRates.USD = 1;
      localStorage.setItem('fx-rates', JSON.stringify({ ts: Date.now(), rates: _fxRates }));
      return _fxRates;
    }
  } catch(e) { console.warn('FX fetch failed, using fallback rates'); }
  // Fallback approximate rates if API fails
  _fxRates = { USD:1, EUR:0.92, GBP:0.79, NGN:1550, KES:153, GHS:15.5, ZAR:18.2 };
  return _fxRates;
}
function convertToTarget(amount, fromCur, toCur, rates) {
  if (!fromCur || !toCur || fromCur === toCur) return amount;
  const fromRate = rates[fromCur] || 1;
  const toRate = rates[toCur] || 1;
  return amount / fromRate * toRate;
}

const FAVICON_DOMAINS = {
  'claude':'anthropic.com','claude pro':'anthropic.com','anthropic':'anthropic.com',
  'chatgpt':'openai.com','chatgpt plus':'openai.com','openai':'openai.com',
  'github copilot':'github.com','copilot':'github.com',
  'cursor':'cursor.com','perplexity':'perplexity.ai','perplexity pro':'perplexity.ai',
  'midjourney':'midjourney.com','notion':'notion.so','notion ai':'notion.so',
  'grammarly':'grammarly.com','figma':'figma.com','linear':'linear.app',
  'vercel':'vercel.com','netlify':'netlify.com','elevenlabs':'elevenlabs.io',
  'openrouter':'openrouter.ai','replit':'replit.com',
  'codeium':'codeium.com','windsurf':'codeium.com','codeium / windsurf':'codeium.com',
  'jasper':'jasper.ai','jasper ai':'jasper.ai','copy.ai':'copy.ai',
  'runway':'runwayml.com','runway ml':'runwayml.com','pika':'pika.art','pika labs':'pika.art',
  'google one':'google.com','google workspace':'google.com','google one / workspace':'google.com',
  'microsoft 365':'microsoft.com','microsoft':'microsoft.com',
  'dropbox':'dropbox.com','spotify':'spotify.com','netflix':'netflix.com',
  'discord':'discord.com','discord nitro':'discord.com',
  'slack':'slack.com','zoom':'zoom.us','loom':'loom.com',
  'superhuman':'superhuman.com','starlink':'starlink.com',
  'canva':'canva.com','namecheap':'namecheap.com',
  'adobe':'adobe.com','adobe creative cloud':'adobe.com',
  'youtube':'youtube.com','youtube premium':'youtube.com',
  'apple':'apple.com','icloud':'apple.com',
  'amazon':'amazon.com','aws':'aws.amazon.com',
  'hulu':'hulu.com','disney+':'disneyplus.com','disneyplus':'disneyplus.com',
};

function subFaviconUrl(sub) {
  const name = (sub.provider || sub.name || '').toLowerCase().trim();
  const nameOnly = (sub.name || '').toLowerCase().trim();
  const domain = FAVICON_DOMAINS[nameOnly] || FAVICON_DOMAINS[name];
  if (domain) return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  const slug = name.replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  if (!slug) return '';
  return `https://www.google.com/s2/favicons?domain=${slug}.com&sz=64`;
}

function faviconImg(sub, sizeClass = 'w-10 h-10') {
  const url = subFaviconUrl(sub);
  if (!url) return `<div class="${sizeClass} rounded-lg bg-panel flex items-center justify-center font-bold text-lg text-primary">${sub.name.charAt(0)}</div>`;
  const initBg = sub.category === 'ai' ? 'text-primary' : 'text-secondary';
  return `<img src="${url}" alt="${sub.name}" class="${sizeClass} rounded-lg bg-panel object-contain" onerror="this.outerHTML='<div class=\\'${sizeClass} rounded-lg bg-panel flex items-center justify-center font-bold text-lg ${initBg}\\'>${sub.name.charAt(0)}</div>'"/>`;
}

// ── GoodDollar contracts (Celo mainnet — from @goodsdks/citizen-sdk) ─────
const GD_IDENTITY   = '0xC361A6E67822a0EDc17D899227dd9FC50BD62F42';
const GD_UBISCHEME  = '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1';
const GD_TOKEN      = '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A';
const GD_FAUCET     = '0x4F93Fa058b03953C851eFaA2e4FC5C34afDFAb84';
const GD_IDENTITY_URL = 'https://goodid.gooddollar.org';
const GD_FV_MSG     = `Sign this message to request verifying your account <account> and to create your own secret unique identifier for your anonymized record.\nYou can use this identifier in the future to delete this anonymized record.\nWARNING: do not sign this message unless you trust the website/application requesting this signature.`;
const GD_FV_LOGIN_MSG = `Sign this message to login into GoodDollar Unique Identity service.\nWARNING: do not sign this message unless you trust the website/application requesting this signature.\nnonce:`;
// Function selectors (keccak256 first 4 bytes)
const SEL_GET_WHITELISTED_ROOT = '0x2d0e9b46'; // getWhitelistedRoot(address)→address
const SEL_CHECK_ENTITLEMENT    = '0x1a787f2e'; // checkEntitlement(address)→uint256
const SEL_CHECK_ENTITLEMENT_NO = '0x98d6621b'; // checkEntitlement()→uint256
const SEL_CLAIM         = '0x4e71d92d'; // claim()→bool
const SEL_BALANCE_OF    = '0x70a08231'; // balanceOf(address)→uint256
const SEL_TRANSFER      = '0xa9059cbb'; // transfer(address,uint256)
const SEL_PERIOD_START  = '0xeda4e6d6'; // periodStart()→uint256
const SEL_CURRENT_DAY   = '0x5c9302c9'; // currentDay()→uint256
const SEL_CAN_TOP       = '0xe97eefd2'; // canTop(address)→bool
const SEL_TOP_WALLET    = '0x3771dcf8'; // topWallet(address)

const CREDITS_CONTRACT = '0xdF61E8D2a22e456a87998Ab78d00E57d099660e8'; // SubBotCredits on Celo mainnet
const ACTION_COSTS = { scan: 0.10, audit: 0.05, negotiate: 0.10, export: 0.05 };
const SEL_APPROVE     = '0x095ea7b3'; // approve(address,uint256)

function padAddr(addr) { return '000000000000000000000000' + addr.slice(2).toLowerCase(); }

async function ethCall(to, data, from) {
  const params = from ? { from, to, data } : { to, data };
  const r = await fetch('https://forno.celo.org', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [params, 'latest'] }),
  });
  const j = await r.json();
  if (j.error) return null;
  return j.result;
}

// ── Pay-per-action: check backend credits → prompt deposit if needed ─────
async function payForAction(action) {
  const cost = ACTION_COSTS[action];
  if (!cost) return true; // free action

  // Try backend credits first (SubBotCredits contract, agent-signed)
  try {
    const uid = userId();
    const chargeResp = await fetch(`${API}/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid, action }),
      signal: AbortSignal.timeout(15000),
    });
    const chargeData = await chargeResp.json();
    if (chargeData.ok && chargeData.mode === 'credits') {
      toast(`Paid ${cost.toFixed(2)} G$ for ${action}`);
      state.txHistory = [{ type: 'deduct', action, amount: cost, ts: new Date().toISOString(), txHash: chargeData.txHash }, ...(state.txHistory || [])].slice(0, 200);
      saveState();
      fetchCreditsBalance();
      return true;
    }
    // Free tier — allowed through
    if (chargeData.ok && chargeData.mode === 'free') {
      return true;
    }
  } catch (_) {}

  // No credits — redirect user to deposit screen instead of sending G$ directly
  toast(`Insufficient credits — deposit G$ first (need ${cost.toFixed(2)} G$)`);
  showScreen('credits');
  return false;
}

// ── SubBotCredits helpers (deposit / withdraw / balance via backend) ──────
async function fetchCreditsBalance() {
  const uid = userId();
  try {
    const r = await fetch(`${API}/credits/${encodeURIComponent(uid)}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const d = await r.json();
    const bal = parseFloat(d.balance) || 0;
    const balStr = bal.toFixed(2);
    // Update all credit balance displays
    const el = document.getElementById('credits-contract-balance');
    if (el) el.textContent = balStr;
    const opsEl = document.getElementById('credits-ops-remaining');
    if (opsEl) opsEl.textContent = d.opsRemaining || 0;
    // Update dashboard strip
    const stripEl = document.getElementById('strip-balance');
    if (stripEl) stripEl.textContent = balStr + ' G$';
  } catch (_) {}
}

async function depositToCredits() {
  const amountInput = document.getElementById('credits-deposit-amount');
  const amount = parseFloat(amountInput?.value);
  if (!amount || amount <= 0) { toast('Enter an amount'); return; }

  const { provider, from } = await getGDProvider();
  if (!provider || !from) { toast('Connect wallet first'); return; }

  const uid = userId();
  const creditsAddr = CREDITS_CONTRACT;
  if (!creditsAddr) { toast('Credits contract not configured'); return; }

  const costWei = BigInt(Math.round(amount * 1e18));
  const amountHex = costWei.toString(16).padStart(64, '0');

  toast('Approving G$…');
  await gdTopGasIfNeeded(from);

  // Step 1: approve(creditsContract, amount)
  const approveData = SEL_APPROVE + padAddr(creditsAddr) + amountHex;
  try {
    const approveTx = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: GD_TOKEN, data: approveData, gas: '0x4C4B40' }],
    });
    toast('Waiting for approval…');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const resp = await fetch('https://forno.celo.org', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [approveTx] }),
      });
      const j = await resp.json();
      if (j.result) { if (j.result.status !== '0x1') { toast('Approval failed'); return; } break; }
    }
  } catch (err) {
    if (err.code === 4001) { toast('Approval cancelled'); return; }
    toast('Approval failed'); return;
  }

  // Step 2: deposit(userId, amount) — encode string + uint256
  toast('Depositing to credits…');
  const uidBytes = new TextEncoder().encode(uid);
  const uidHex = Array.from(uidBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  // ABI encode: deposit(string,uint256) — selector 0x8e27d719
  // Layout: offset to string (0x40), uint256 amount, string length, string data
  const stringOffset = '0000000000000000000000000000000000000000000000000000000000000040';
  const amountPadded = costWei.toString(16).padStart(64, '0');
  const stringLen = uidBytes.length.toString(16).padStart(64, '0');
  const stringData = uidHex.padEnd(Math.ceil(uidHex.length / 64) * 64, '0');
  // deposit(string,uint256) selector = keccak("deposit(string,uint256)") first 4 bytes
  // = 0x6f7bc9be (precomputed)
  const depositData = '0x8e27d719' + stringOffset + amountPadded + stringLen + stringData;

  try {
    const depositTx = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: creditsAddr, data: depositData, gas: '0x7A120' }],
    });
    toast('Confirming deposit…');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const resp = await fetch('https://forno.celo.org', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [depositTx] }),
      });
      const j = await resp.json();
      if (j.result) {
        if (j.result.status === '0x1') {
          toast(`Deposited ${amount.toFixed(2)} G$ to credits!`);
          if (amountInput) amountInput.value = '';
          fetchCreditsBalance();
          fetchGDWalletBalance();
          return;
        } else { toast('Deposit failed'); return; }
      }
    }
    toast('Deposit timed out');
  } catch (err) {
    if (err.code === 4001) { toast('Deposit cancelled'); return; }
    toast('Deposit failed'); console.error(err);
  }
}

async function withdrawCredits() {
  const { provider, from } = await getGDProvider();
  if (!provider || !from) { toast('Connect wallet first'); return; }

  const uid = userId();
  const creditsAddr = CREDITS_CONTRACT;
  if (!creditsAddr) { toast('Credits contract not configured'); return; }

  toast('Withdrawing credits…');
  await gdTopGasIfNeeded(from);

  // withdraw(string userId, uint256 amount) — amount=0 means withdraw all
  const uidBytes = new TextEncoder().encode(uid);
  const uidHex = Array.from(uidBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const stringOffset = '0000000000000000000000000000000000000000000000000000000000000040';
  const amountPadded = '0'.padStart(64, '0'); // 0 = withdraw all
  const stringLen = uidBytes.length.toString(16).padStart(64, '0');
  const stringData = uidHex.padEnd(Math.ceil(uidHex.length / 64) * 64, '0');
  // withdraw(string,uint256) selector = 0x9e2bf22c (precomputed)
  const withdrawData = '0x30b39a62' + stringOffset + amountPadded + stringLen + stringData;

  try {
    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: creditsAddr, data: withdrawData, gas: '0x7A120' }],
    });
    toast('Confirming withdrawal…');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const resp = await fetch('https://forno.celo.org', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
      });
      const j = await resp.json();
      if (j.result) {
        if (j.result.status === '0x1') {
          toast('G$ withdrawn from credits!');
          fetchCreditsBalance();
          fetchGDWalletBalance();
          return;
        } else { toast('Withdrawal failed'); return; }
      }
    }
    toast('Withdrawal timed out');
  } catch (err) {
    if (err.code === 4001) { toast('Withdrawal cancelled'); return; }
    toast('Withdrawal failed'); console.error(err);
  }
}

// ── GoodDollar helpers (SDK-pattern, direct in-app claim) ────────────────

// Get the wallet provider and address (Web3Auth or injected)
async function getGDProvider() {
  let provider = null, from = null;
  // Ensure Web3Auth is initialized (reconnects session after page refresh)
  if (!web3authInstance) {
    try { await getWeb3Auth(); } catch (_) {}
  }
  if (web3authInstance?.connected && web3authInstance.provider) {
    provider = web3authInstance.provider;
    const accounts = await provider.request({ method: 'eth_accounts' });
    from = accounts?.[0];
  }
  if (!provider && window.ethereum) {
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accounts?.[0]) { provider = window.ethereum; from = accounts[0]; }
    } catch (_) {}
  }
  return { provider, from };
}

// getWhitelistedRoot(address) → returns root address (zero = not whitelisted)
async function gdGetWhitelistedRoot(address) {
  const result = await ethCall(GD_IDENTITY, SEL_GET_WHITELISTED_ROOT + padAddr(address));
  if (!result || result === '0x' + '0'.repeat(64)) return null;
  return '0x' + result.slice(26); // extract address from 32-byte return
}

// Generate face verification link (SDK pattern: sign login + identifier messages, lz-compress)
function toHexMsg(str) {
  return '0x' + Array.from(new TextEncoder().encode(str)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function gdGenerateFVLink(provider, address, firstName) {
  const nonce = Math.floor(Date.now() / 1000).toString();

  // 1. Sign login message (required by GoodID — "sg" param)
  const loginMsg = GD_FV_LOGIN_MSG + nonce;
  const loginSig = await provider.request({
    method: 'personal_sign',
    params: [toHexMsg(loginMsg), address],
  });

  // 2. Sign identifier message (required — "fvsig" param)
  const fvMsg = GD_FV_MSG.replace('<account>', address);
  const fvSig = await provider.request({
    method: 'personal_sign',
    params: [toHexMsg(fvMsg), address],
  });

  if (!fvSig || !loginSig) throw new Error('Missing signature for Face Verification.');

  const params = {
    account: address,
    nonce,
    fvsig: fvSig,
    sg: loginSig,
    firstname: firstName || 'User',
    chain: 42220,
    rdu: window.location.href,
  };

  const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(params));
  const url = new URL(GD_IDENTITY_URL);
  url.searchParams.append('lz', compressed);
  return url.toString();
}

// Check next claim time from UBI scheme
async function gdNextClaimTime() {
  const DAY = 86400;
  const pResult = await ethCall(GD_UBISCHEME, SEL_PERIOD_START);
  const dResult = await ethCall(GD_UBISCHEME, SEL_CURRENT_DAY);
  if (!pResult || !dResult) return null;
  const periodStart = Number(BigInt(pResult));
  const currentDay = Number(BigInt(dResult));
  const ref = periodStart + currentDay * DAY;
  const now = Math.floor(Date.now() / 1000);
  if (now < ref) return new Date(ref * 1000);
  return new Date((ref + DAY) * 1000);
}

// Top wallet with gas via GoodDollar backend faucet (no gas needed to call)
async function gdTopGasIfNeeded(address) {
  try {
    // Check if user has low CELO balance
    const balResp = await fetch('https://forno.celo.org', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
    });
    const balJson = await balResp.json();
    const celoBal = balJson.result ? Number(BigInt(balJson.result)) : 0;
    // If user has more than 0.005 CELO, skip faucet
    if (celoBal > 5e15) return;

    // Call GoodDollar backend faucet — free, no gas required
    await fetch('https://goodserver.gooddollar.org/verify/topWallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId: 42220, account: address }),
    });
    // Wait a moment for the top-up tx to land
    await new Promise(r => setTimeout(r, 3000));
  } catch (_) {} // best-effort
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
    // Use getWhitelistedRoot (SDK pattern) — returns root address or null
    const root = await gdGetWhitelistedRoot(address);

    // Also check G$ token balance
    const balResult = await ethCall(GD_TOKEN, SEL_BALANCE_OF + padAddr(address));
    const gdBalance = balResult ? Number(BigInt(balResult)) / 1e18 : 0;

    if (!root) {
      // Not whitelisted — offer face verification
      statusEl.innerHTML =
        `<span class="block mb-2 text-xs font-medium text-main">Verify your identity to claim G$</span>` +
        `<span class="text-[10px] text-muted block mb-2">Complete a one-time face verification to start claiming daily G$ UBI.</span>`;
      verifyLink?.classList.remove('hidden');
      verifyLink?.classList.add('inline-flex');
      verifyLink.textContent = '';
      verifyLink.innerHTML = '<i class="fa-solid fa-face-smile text-sm mr-1"></i> Start Face Verification';
      verifyLink.href = '#';
      verifyLink.onclick = async (e) => {
        e.preventDefault();
        try {
          const { provider, from } = await getGDProvider();
          if (!provider || !from) { toast('Connect wallet first'); return; }
          // Get user name from Web3Auth if available
          let firstName = 'User';
          try {
            const info = await web3authInstance?.getUserInfo();
            firstName = info?.name?.split(' ')[0] || 'User';
          } catch (_) {}
          toast('Sign the verification messages…');
          const fvUrl = await gdGenerateFVLink(provider, from, firstName);
          window.open(fvUrl, '_blank');
          toast('Complete verification, then return here');
        } catch (err) {
          if (err.code === 4001) { toast('Signing cancelled'); return; }
          toast('Could not start verification');
          console.error('FV link error:', err);
        }
      };
      return;
    }

    // Whitelisted — check entitlement using root address (SDK pattern)
    const checkAddr = root.toLowerCase() !== address.toLowerCase() ? root : address;
    const entResult = await ethCall(GD_UBISCHEME, SEL_CHECK_ENTITLEMENT + padAddr(checkAddr));

    if (entResult === null) {
      // checkEntitlement reverted — check localStorage for today's claim
      const claimedToday = localStorage.getItem('gd-claim-date') === new Date().toDateString();
      claimableEl.textContent = gdBalance > 0 ? gdBalance.toFixed(2) + ' G$' : '';
      if (claimedToday) {
        const nextClaim = await gdNextClaimTime();
        const timeStr = nextClaim ? nextClaim.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'tomorrow';
        statusEl.textContent = `Already claimed today. Next claim ~${timeStr}`;
      } else {
        // Try no-arg checkEntitlement as fallback
        const entNoArg = await ethCall(GD_UBISCHEME, SEL_CHECK_ENTITLEMENT_NO);
        if (entNoArg && BigInt(entNoArg) > 0n) {
          const amount = (Number(BigInt(entNoArg)) / 1e18).toFixed(2);
          claimableEl.textContent = amount + ' G$';
          statusEl.textContent = 'You have G$ to claim!';
          claimBtn?.classList.remove('hidden');
        } else {
          statusEl.textContent = 'Verified ✓ · No claimable G$ right now';
        }
      }
    } else {
      const entitlement = BigInt(entResult);
      if (entitlement > 0n) {
        const amount = (Number(entitlement) / 1e18).toFixed(2);
        claimableEl.textContent = amount + ' G$';
        statusEl.textContent = 'You have G$ to claim!';
        claimBtn?.classList.remove('hidden');
      } else {
        claimableEl.textContent = gdBalance > 0 ? gdBalance.toFixed(2) + ' G$' : '';
        const nextClaim = await gdNextClaimTime();
        const timeStr = nextClaim ? nextClaim.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'tomorrow';
        statusEl.textContent = `Already claimed today. Next claim ~${timeStr}`;
        localStorage.setItem('gd-claim-date', new Date().toDateString());
      }
    }
  } catch (err) {
    console.error('GD check error:', err);
    statusEl.textContent = 'Could not check eligibility.';
  }
}

async function claimGD() {
  const btn = document.getElementById('gd-claim-btn');
  const statusEl = document.getElementById('gd-status');

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-sm"></i> Claiming…';
  btn.disabled = true;

  try {
    const { provider, from } = await getGDProvider();
    if (!provider || !from) {
      toast('Connect wallet first');
      btn.innerHTML = '<i class="fa-solid fa-hand-holding-dollar text-sm"></i> Claim G$';
      btn.disabled = false;
      return;
    }

    // Verify entitlement before sending tx
    const root = await gdGetWhitelistedRoot(from);
    if (!root) {
      statusEl.textContent = 'Wallet not verified — complete face verification first.';
      btn.innerHTML = '<i class="fa-solid fa-hand-holding-dollar text-sm"></i> Claim G$';
      btn.disabled = false;
      return;
    }

    const checkAddr = root.toLowerCase() !== from.toLowerCase() ? root : from;
    const entCheck = await ethCall(GD_UBISCHEME, SEL_CHECK_ENTITLEMENT + padAddr(checkAddr));
    const entNoArg = entCheck === null ? await ethCall(GD_UBISCHEME, SEL_CHECK_ENTITLEMENT_NO) : entCheck;
    if (!entNoArg || BigInt(entNoArg) === 0n) {
      localStorage.setItem('gd-claim-date', new Date().toDateString());
      statusEl.textContent = 'No claimable G$ right now. Come back tomorrow!';
      btn.classList.add('hidden');
      return;
    }

    // Top up gas via faucet if needed (best-effort)
    statusEl.textContent = 'Checking gas…';
    await gdTopGasIfNeeded(from);

    // Estimate gas dynamically (claim() can need 300k+)
    statusEl.textContent = 'Sign the claim transaction…';
    let gasLimit = '0x7A120'; // 500k default
    try {
      const estResp = await fetch('https://forno.celo.org', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_estimateGas',
          params: [{ from, to: GD_UBISCHEME, data: SEL_CLAIM }] }),
      });
      const estJson = await estResp.json();
      if (estJson.result) {
        // Add 20% buffer to estimated gas
        const est = Number(BigInt(estJson.result));
        gasLimit = '0x' + Math.ceil(est * 1.2).toString(16);
      }
    } catch (_) {}

    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: GD_UBISCHEME, data: SEL_CLAIM, gas: gasLimit }],
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
      localStorage.setItem('gd-claim-date', new Date().toDateString());
      statusEl.innerHTML = '<span class="text-emerald-500 font-bold">✓ Claimed! G$ added to your wallet.</span>';
      btn.classList.add('hidden');
      document.getElementById('gd-claimable').textContent = '';
      toast('G$ claimed successfully!');
      setTimeout(() => { fetchGDWalletBalance(); checkGDStatus(from); }, 3000);
    } else {
      statusEl.textContent = 'Transaction failed — try again.';
      btn.innerHTML = '<i class="fa-solid fa-hand-holding-dollar text-sm"></i> Retry';
      btn.disabled = false;
    }
  } catch (err) {
    console.error('GD claim error:', err);
    if (err.message?.includes('user') || err.message?.includes('User') || err.code === 4001) {
      statusEl.textContent = 'Claim cancelled.';
    } else {
      statusEl.textContent = 'Claim failed: ' + (err.message || 'unknown error');
    }
    btn.innerHTML = '<i class="fa-solid fa-hand-holding-dollar text-sm"></i> Retry';
    btn.disabled = false;
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
    let address = accounts?.[0] || '';

    // For external wallets (MetaMask etc), also try window.ethereum directly
    // Web3Auth may wrap the provider and return a derived address
    if (window.ethereum && window.ethereum !== provider) {
      try {
        const directAccounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (directAccounts?.[0] && directAccounts[0].toLowerCase() !== address.toLowerCase()) {
          console.log('[SubBot] Web3Auth provider address:', address, '| MetaMask address:', directAccounts[0]);
          // Prefer the MetaMask address if it's GD-verified
          const root = await gdGetWhitelistedRoot(directAccounts[0]);
          if (root) {
            localStorage.setItem('gd-verified-addr', directAccounts[0]);
          }
        }
      } catch (_) {}
    }

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
    showScreen('dashboard');
    if (gotData) {
      toast('Welcome back!');
    } else {
      // First-time user — show onboarding modal
      if (!localStorage.getItem('subbot_onboarded')) {
        setTimeout(() => document.getElementById('modal-welcome')?.classList.add('active'), 400);
      } else {
        toast(`Connected: ${address ? address.slice(0,6) + '…' + address.slice(-4) : payload.name || 'user'}`);
      }
    }
    // Check GD status with the login address, then also try stored GD address
    if (address) {
      const storedGD = localStorage.getItem('gd-verified-addr');
      if (storedGD && storedGD.toLowerCase() !== address.toLowerCase()) {
        checkGDStatus(storedGD).catch(() => {});
      } else {
        checkGDStatus(address).catch(() => {});
      }
    }
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
  budgetCurrency: 'USD',
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
  rollRenewals();
}

// Flag subs with past renewal dates as needing confirmation
function rollRenewals() {
  const now = new Date();
  let changed = false;
  (state.subscriptions || []).forEach(s => {
    if (!s.next_renewal || s.status !== 'active') return;
    if (s.renewal_pending) return; // already flagged
    const d = new Date(s.next_renewal);
    if (d < now) { s.renewal_pending = true; changed = true; }
  });
  if (changed) saveState();
}

async function confirmRenewal(id) {
  const sub = state.subscriptions.find(s => s.id === id);
  if (!sub) return;
  const d = new Date(sub.next_renewal);
  const now = new Date();
  while (d < now) d.setMonth(d.getMonth() + 1);
  sub.next_renewal = d.toISOString().slice(0, 10);
  delete sub.renewal_pending;
  saveState();
  try { await fetch(`${API}/update-sub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: { id: sub.id, next_renewal: sub.next_renewal }, userId: userId() }) }); } catch (_) {}
  toast(`${sub.name} renewed — next: ${sub.next_renewal}`);
  refreshDashboard();
}

async function confirmCancellation(id) {
  const sub = state.subscriptions.find(s => s.id === id);
  if (!sub) return;
  sub.status = 'cancelled';
  delete sub.renewal_pending;
  saveState();
  try { await fetch(`${API}/update-sub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: { id: sub.id, status: 'cancelled' }, userId: userId() }) }); } catch (_) {}
  toast(`${sub.name} marked as cancelled`);
  refreshDashboard();
  renderSubs();
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
  if (name === 'audit')         runAudit(false);
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
    case 'depositCredits':   depositToCredits(); break;
    case 'withdrawCredits':  withdrawCredits(); break;
    case 'togglePushNotifications': togglePushNotifications(); break;
    case 'confirmScanSubs':  confirmScanSubs(); break;
    case 'scanSelectAll':    document.querySelectorAll('#scan-results-list input[type="checkbox"]').forEach(cb => cb.checked = true); break;
    case 'scanSelectNone':   document.querySelectorAll('#scan-results-list input[type="checkbox"]').forEach(cb => cb.checked = false); break;
    case 'scanAnotherEmail': scanAnotherEmail(); break;
    case 'welcomeAddManual': localStorage.setItem('subbot_onboarded','1'); document.getElementById('modal-welcome')?.classList.remove('active'); showScreen('subscriptions'); setTimeout(showAddSubModal, 300); break;
    case 'welcomeScanEmail': localStorage.setItem('subbot_onboarded','1'); document.getElementById('modal-welcome')?.classList.remove('active'); showScreen('settings'); setTimeout(() => { document.getElementById('modal-gmail-scan')?.classList.add('active'); prefillGmailModal(); }, 300); break;
    case 'welcomeBudget':    localStorage.setItem('subbot_onboarded','1'); document.getElementById('modal-welcome')?.classList.remove('active'); showScreen('settings'); break;
    case 'welcomeDismiss':   localStorage.setItem('subbot_onboarded','1'); document.getElementById('modal-welcome')?.classList.remove('active'); break;
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
        // Merge: use backend data but preserve client-only flags like renewal_pending
        const localMap = {};
        (state.subscriptions || []).forEach(s => { if (s.id) localMap[s.id] = s; });
        state.subscriptions = d.subscriptions.map(s => {
          const local = localMap[s.id];
          // If local copy has a newer next_renewal (user confirmed renewal), keep it
          if (local && local.next_renewal && s.next_renewal && local.next_renewal > s.next_renewal) {
            s.next_renewal = local.next_renewal;
          }
          return s;
        });
        gotData = true;
      }
      if (d.monthly_budget != null) state.budget = d.monthly_budget;
      if (d.budget_currency) state.budgetCurrency = d.budget_currency;
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

  rollRenewals();
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
async function refreshDashboard() {
  const subs    = state.subscriptions.filter(s => s.status === 'active');
  const budgetCur = state.budgetCurrency || 'USD';
  const budgetSym = cSym(budgetCur);
  const budget  = state.budget || 100;
  const rates   = await getFxRates();

  // Convert every sub's cost to budget currency, then sum
  const monthly = subs.reduce((sum, s) => {
    const cost = s.monthly_cost || 0;
    const cur  = s.currency || 'USD';
    return sum + convertToTarget(cost, cur, budgetCur, rates);
  }, 0);

  const pct = Math.min(100, Math.round(monthly / budget * 100));

  document.getElementById('dash-spend').textContent  = budgetSym + monthly.toFixed(0);
  document.getElementById('dash-budget').textContent = '/ ' + budgetSym + budget;
  document.getElementById('dash-pct').textContent    = pct + '%';
  const ring = document.getElementById('budget-ring');
  if (ring) {
    ring.setAttribute('stroke-dashoffset', 376.99 * (1 - pct / 100));
    ring.classList.toggle('text-error', pct >= 100);
  }

  // Push notification when budget exceeded (once per day)
  if (pct >= 100 && Notification.permission === 'granted') {
    const today = new Date().toDateString();
    if (localStorage.getItem('budget-exceeded-date') !== today) {
      localStorage.setItem('budget-exceeded-date', today);
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'budget-exceeded',
          title: 'SubBot · Budget Exceeded',
          body: `Monthly spend (${budgetSym}${monthly.toFixed(0)}) has passed your ${budgetSym}${budget} budget`,
        });
      }
    }
  }

  document.getElementById('stat-count').textContent    = subs.length;
  document.getElementById('stat-annual').textContent   = budgetSym + (monthly * 12).toFixed(0);

  const now  = new Date();
  const soon = subs.filter(s => s.next_renewal && (new Date(s.next_renewal) - now) / 86400000 <= 30).length;
  document.getElementById('stat-renewals').textContent = soon;

  const hdr = document.getElementById('header-status');
  if (hdr) {
    hdr.textContent = subs.length ? `● ${subs.length} subs` : '● No data';
  }

  // Update strip balance from credits contract
  fetchCreditsBalance();

  // Renewal confirmation prompts
  const pending = subs.filter(s => s.renewal_pending);
  const pendingDiv = document.getElementById('renewal-prompts');
  if (pendingDiv) {
    pendingDiv.innerHTML = pending.map(s => {
      const sym = cSym(s.currency);
      return `<div class="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5 mb-2">
        <div class="flex-1 min-w-0">
          <p class="text-xs font-bold text-main truncate">${s.name}</p>
          <p class="text-[10px] text-muted">Renewal passed · ${sym}${(s.monthly_cost || 0).toLocaleString()}/mo</p>
        </div>
        <button onclick="confirmRenewal('${s.id}')" class="px-2.5 py-1.5 rounded-lg bg-emerald-500 text-white text-[10px] font-bold active:scale-95">Renewed</button>
        <button onclick="confirmCancellation('${s.id}')" class="px-2.5 py-1.5 rounded-lg bg-error/10 text-error text-[10px] font-bold active:scale-95">Cancelled</button>
      </div>`;
    }).join('');
  }

  // Renewals list
  const renewalDiv = document.getElementById('renewals-list');
  if (!renewalDiv) return;
  const upcoming = subs
    .filter(s => s.next_renewal && !s.renewal_pending)
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
    c.classList.toggle('bg-primary/20', on);
    c.classList.toggle('text-primary', on);
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
    const cost    = s.monthly_cost || 0;
    const sym     = cSym(s.currency);
    return `<div class="h-[72px] glass rounded-xl px-3 flex items-center gap-3 border border-edge hover:bg-panel/40 transition-all cursor-pointer" data-action="showSubDetail" data-sub-id="${s.id}">
      <div class="flex-shrink-0">${faviconImg(s)}</div>
      <div class="flex-1 min-w-0">
        <div class="flex justify-between items-start">
          <h3 class="font-semibold text-sm truncate">${s.name}</h3>
          <span class="font-mono text-sm font-medium">${sym}${cost.toLocaleString()}<span class="text-[10px] text-muted">/mo</span></span>
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
  const cost = sub.monthly_cost || 0;
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
async function runAudit(requirePayment = true) {
  if (requirePayment) {
    const paid = await payForAction('audit');
    if (!paid) return;
  }
  const subs    = state.subscriptions.filter(s => s.status === 'active');
  const budgetCur = state.budgetCurrency || 'USD';
  const sym = cSym(budgetCur);
  const rates = await getFxRates();
  const monthly = subs.reduce((sum, s) => sum + convertToTarget(s.monthly_cost || 0, s.currency || 'USD', budgetCur, rates), 0);
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
      <span class="text-xs font-mono mx-2">${cSym(s.currency)}${(s.monthly_cost || 0).toLocaleString()}</span>
      <div class="w-16 bg-panel rounded-full h-1.5 mr-2"><div class="${bc} h-1.5 rounded-full" style="width:${h}%"></div></div>
      <span class="text-[10px] whitespace-nowrap">${badge}</span>
    </div>`;
  }).join('') || '<p class="text-xs text-muted text-center py-3">No data.</p>';

  const wins = [];
  overlaps.forEach(([cat, names]) => {
    const catSubs = subs.filter(s => s.category === cat);
    const cheapest = catSubs.reduce((a, b) => (a.monthly_cost || 0) < (b.monthly_cost || 0) ? a : b);
    wins.push(`Cancel one of your ${names.length} ${cat} tools — save ~${cSym(cheapest.currency)}${(cheapest.monthly_cost || 0).toLocaleString()}/mo`);
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

async function draftEmail(serviceName) {
  const paid = await payForAction('negotiate');
  if (!paid) return;

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
  fetchGDWalletBalance();
  fetchCreditsBalance();
  renderTxHistory();
}

async function fetchGDWalletBalance() {
  const el = document.getElementById('gd-wallet-balance');

  // Use stored GD address, or Web3Auth address, or injected wallet
  const storedGD = localStorage.getItem('gd-verified-addr');
  let addr = storedGD;
  if (!addr) {
    try {
      const w3a = JSON.parse(localStorage.getItem('web3auth'));
      addr = w3a?.walletAddress;
    } catch (_) {}
  }
  if (!addr) return;

  try {
    const result = await ethCall(GD_TOKEN, SEL_BALANCE_OF + padAddr(addr));
    if (result) {
      const balance = Number(BigInt(result)) / 1e18; // G$ has 18 decimals
      if (el) el.textContent = balance.toFixed(2);
    }
  } catch (_) {
    if (el) el.textContent = '—';
  }
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
  const bCur = document.getElementById('budget-currency');
  if (bCur) bCur.value = state.budgetCurrency || 'USD';

  // Show user UUID
  const uuidEl = document.getElementById('settings-uuid');
  if (uuidEl) uuidEl.textContent = userId() || '—';

  // Show configured email
  const emailDisplay = document.getElementById('settings-email-display');
  const emailInput = document.getElementById('settings-email');
  if (emailDisplay && emailInput?.value) emailDisplay.textContent = emailInput.value;
}

async function saveBudget() {
  const v = parseFloat(document.getElementById('budget-input').value);
  if (!isNaN(v) && v > 0) {
    state.budget = v;
    state.budgetCurrency = document.getElementById('budget-currency')?.value || 'USD';
    saveState();
    try { await fetch(`${API}/budget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budget: v, budgetCurrency: state.budgetCurrency, userId: userId() }) }); } catch(e) {}
    toast('Budget saved!');
    refreshDashboard();
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
    monthly_cost_usd: null,
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
  const alertNav = document.querySelector('[data-tab="alerts"]');
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
  const paid = await payForAction('export');
  if (!paid) return;

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
    state = { userId: null, subscriptions: [], budget: 100, budgetCurrency: 'USD', balance: 0, txHistory: [] };
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
  const text = 'Check out SubBot — AI subscription manager on Celo: https://subbotai.xyz';
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'SubBot — AI Subscription Manager',
        text: 'Track, audit, and optimise your SaaS spend with SubBot. Free on Celo.',
        url: 'https://subbotai.xyz',
      });
      return;
    } catch (e) {
      // User cancelled share sheet — fall through to clipboard
      if (e.name === 'AbortError') return;
    }
  }
  // Clipboard fallback — try modern API, then textarea fallback
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied!');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('Link copied!');
  }
}

// ── Gmail Scan ───────────────────────────────────────────────────────────
function prefillGmailModal() {
  // Pre-fill email only — password is never stored, entered fresh per scan
  const se = document.getElementById('settings-email')?.value;
  if (se) document.getElementById('gmail-scan-email').value = se;
  document.getElementById('gmail-scan-password').value = '';
}

async function runGmailScan() {
  const email    = document.getElementById('gmail-scan-email')?.value?.trim();
  const password = document.getElementById('gmail-scan-password')?.value?.trim();
  if (!email || !password) { toast('Email and App Password required'); return; }

  // Pay for scan
  const paid = await payForAction('scan');
  if (!paid) return;

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
    if (!found.length) {
      toast('No subscriptions found in Gmail');
      document.getElementById('modal-gmail-scan')?.classList.remove('active');
      return;
    }

    // Save email for future scans (never persist password)
    if (document.getElementById('settings-email')) document.getElementById('settings-email').value = email;
    const emailDisp = document.getElementById('settings-email-display');
    if (emailDisp) emailDisp.textContent = email;
    // Clear password from scan modal — never keep in DOM
    const scanPwField = document.getElementById('gmail-scan-password');
    if (scanPwField) scanPwField.value = '';

    document.getElementById('modal-gmail-scan')?.classList.remove('active');

    // Show confirmation modal
    showScanConfirmModal(found);
  } catch (err) {
    console.error('Gmail scan error:', err);
    toast('Scan failed — check email and app password');
  } finally {
    if (btn) { btn.innerHTML = origText; btn.disabled = false; }
  }
}

async function runSettingsGmailScan() {
  // Open the scan modal — password is always entered there, never stored in settings
  document.getElementById('modal-gmail-scan')?.classList.add('active');
  prefillGmailModal();
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

// ── Scan Confirmation ────────────────────────────────────────────────────
let pendingScanSubs = [];

function showScanConfirmModal(found) {
  const existing = new Set(state.subscriptions.map(s => s.name.toLowerCase()));
  const pendingNames = new Set(pendingScanSubs.map(s => s.name.toLowerCase()));
  const newSubs = found.filter(s => !pendingNames.has(s.name.toLowerCase())).map(s => {
    s.id = s.id || ('scan-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    s.status = s.status || 'active';
    s.source = 'gmail';
    return s;
  });
  pendingScanSubs = [...pendingScanSubs, ...newSubs];

  const list = document.getElementById('scan-results-list');
  list.innerHTML = pendingScanSubs.map((s, i) => {
    const alreadyExists = existing.has(s.name.toLowerCase());
    const cur = cSym(s.currency);
    const cost = s.monthly_cost ? `${cur}${s.monthly_cost.toLocaleString()}` : '—';
    const statusBadge = s.status === 'cancelled'
      ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-error/10 text-error font-bold">Cancelled</span>'
      : '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 font-bold">Active</span>';
    const dupBadge = alreadyExists
      ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500 font-bold">Already tracked</span>'
      : '';

    return `<label class="flex items-center gap-3 p-3 bg-panel rounded-xl border border-edge cursor-pointer hover:bg-panel-hover transition-colors">
      <input type="checkbox" value="${i}" ${!alreadyExists && s.status !== 'cancelled' ? 'checked' : ''} class="w-4 h-4 rounded accent-primary flex-shrink-0"/>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          ${faviconImg(s, 'w-6 h-6')}
          <span class="text-xs font-bold text-main truncate">${s.name}</span>
        </div>
        <div class="flex items-center gap-1.5 mt-1">
          ${statusBadge} ${dupBadge}
          <span class="text-[10px] text-muted font-mono">${cost}/mo</span>
        </div>
      </div>
    </label>`;
  }).join('');

  toast(`Found ${found.length} subscription${found.length === 1 ? '' : 's'}!`);
  document.getElementById('modal-scan-confirm')?.classList.add('active');
}

function scanAnotherEmail() {
  // Keep the confirm modal data but open scan modal for another account
  document.getElementById('modal-scan-confirm')?.classList.remove('active');
  document.getElementById('gmail-scan-email').value = '';
  document.getElementById('gmail-scan-password').value = '';
  document.getElementById('modal-gmail-scan')?.classList.add('active');
}

function confirmScanSubs() {
  const checked = document.querySelectorAll('#scan-results-list input[type="checkbox"]:checked');
  const indices = new Set([...checked].map(cb => parseInt(cb.value)));
  let added = 0;
  const existing = new Set(state.subscriptions.map(s => s.name.toLowerCase()));

  indices.forEach(i => {
    const s = pendingScanSubs[i];
    if (s && !existing.has(s.name.toLowerCase())) {
      state.subscriptions.push(s);
      existing.add(s.name.toLowerCase());
      added++;
    }
  });

  if (added) {
    saveState();
    renderSubs();
    refreshDashboard();
    scheduleRenewalNotifications();
    toast(`${added} subscription${added === 1 ? '' : 's'} added!`);
  } else {
    toast('No new subscriptions added');
  }

  pendingScanSubs = [];
  document.getElementById('modal-scan-confirm')?.classList.remove('active');
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
    : 'px-4 py-1.5 rounded-lg bg-primary text-white text-xs font-bold active:scale-95 transition-all';
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

  // Re-check GD status when user returns from face verification tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      w3aGet(w3a => {
        if (w3a?.walletAddress) checkGDStatus(w3a.walletAddress).catch(() => {});
      });
    }
  });

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
