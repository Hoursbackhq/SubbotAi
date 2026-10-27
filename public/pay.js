/* pay.js — Pay tab: bills in G$, bill jars, data forecast. Loaded after popup.js and uses its globals
   (API, apiFetch, userId, state, toast, getGDProvider, gdTopGasIfNeeded, ethCall, GD_TOKEN, checkGDStatus). */

const JARS_ABI = [
  'function deposit(uint256[] jarIds, uint256[] amounts)',
  'function withdraw(uint256 jarId, uint256 amount)',
  'function setCap(uint256 jarId, uint256 capPerPeriod)',
  'function setStreamSplit(uint256[] jarIds, uint16[] bps)',
];
const ERC20_ABI = ['function transfer(address to, uint256 amount)', 'function approve(address spender, uint256 amount)', 'function allowance(address owner, address spender) view returns (uint256)'];
// Allowance-mode autopay approves this many bill cycles at once, with headroom for price moves.
const AUTOPAY_CYCLES = 3, AUTOPAY_HEADROOM = 1.25;
// Superfluid CFAv1Forwarder — same address on every network Superfluid runs on.
const CFA_FORWARDER = '0xcfA132E353cB4E398080B9700609bb008eceB125';
const FORWARDER_ABI = ['function setFlowrate(address token, address receiver, int96 flowrate)'];
const USSD = { mtn: '*323#', airtel: '*323#', glo: '*127*0#', etisalat: '*228#' };
const PRESETS = { airtime: [100, 200, 500, 1000], electricity: [1000, 2000, 5000, 10000] };

const pay = { catalog: null, jars: [], wallet: null, contract: null, mode: 'allowance', spender: null, walletGD: 0, allowanceGD: 0, bill: null, quote: null, jarEditing: null, jarFunding: null, insights: null };
const iface = (abi) => new ethers.Interface(abi);
const fmtGD = n => Math.round(Number(n) || 0).toLocaleString('en-NG');
const fmtNGN = n => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const $ = id => document.getElementById(id);

function signedIn() { return userId() !== 'local'; }

async function payFetch(path, opts = {}) {
  const r = await apiFetch(`${API}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.status) throw new Error(j.error || `Request failed (${r.status})`);
  return { ...j, httpStatus: r.status };
}
const post = (path, body) => payFetch(path, { method: 'POST', body: JSON.stringify({ userId: userId(), ...body }) });

// ── Chain helpers ──────────────────────────────────────────────────────────
async function waitReceipt(hash) {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const r = await fetch('https://forno.celo.org', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }) });
    const j = await r.json();
    if (j.result) { if (j.result.status !== '0x1') throw new Error('Transaction failed on-chain'); return j.result; }
  }
  throw new Error('Still confirming — check Receipts in a minute');
}

async function sendTx(provider, from, to, data) {
  await gdTopGasIfNeeded(from).catch(() => {});
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] });
  await waitReceipt(hash);
  return hash;
}

async function wallet() {
  const { provider, from } = await getGDProvider();
  if (!provider || !from) throw new Error('Connect your wallet first');
  return { provider, from };
}

// The backend only accepts payments from a wallet this account has signed for.
async function ensureLinked(provider, from) {
  if (pay.wallet && pay.wallet.toLowerCase() === from.toLowerCase()) return;
  const { message } = await post('/wallet/link-nonce', {});
  const hexMsg = '0x' + Array.from(new TextEncoder().encode(message)).map(b => b.toString(16).padStart(2, '0')).join('');
  const signature = await provider.request({ method: 'personal_sign', params: [hexMsg, from] });
  const r = await post('/wallet/link', { address: from, signature });
  pay.wallet = r.wallet;
}

async function gdBalanceOf(addr) {
  const r = await ethCall(GD_TOKEN, '0x70a08231' + padAddr(addr));
  return r ? Number(BigInt(r)) / 1e18 : 0;
}

// ── Screen ─────────────────────────────────────────────────────────────────
async function refreshPay() {
  if (!pay.catalog) {
    try { pay.catalog = await payFetch('/bills/catalog'); } catch (_) {}
  }
  $('pay-sandbox')?.classList.toggle('hidden', !pay.catalog?.sandbox);
  pay.contract = pay.catalog?.jarsContract || null;

  let addr = null;
  try { addr = JSON.parse(localStorage.getItem('web3auth'))?.walletAddress; } catch (_) {}
  $('pay-connect').classList.toggle('hidden', Boolean(addr && signedIn()));
  if (addr) {
    gdBalanceOf(addr).then(b => {
      $('pay-gd-balance').textContent = fmtGD(b);
      if (pay.catalog?.ngnPerGD) $('pay-gd-naira').textContent = `≈ ${fmtNGN(b * pay.catalog.ngnPerGD)}`;
    }).catch(() => {});
    checkGDStatus(addr).catch(() => {});
  }
  if (!signedIn()) { renderJars(); renderHistory([]); return; }
  loadJars();
  payFetch(`/bills/history?userId=${encodeURIComponent(userId())}`).then(r => renderHistory(r.payments || [])).catch(() => renderHistory([]));
  payFetch(`/data/insights?userId=${encodeURIComponent(userId())}`).then(renderData).catch(() => {});
}
// popup.js calls refreshCredits() when this tab opens.
refreshCredits = refreshPay;

function renderHistory(payments) {
  const div = $('bills-history');
  if (!payments.length) {
    div.innerHTML = `<div class="flex items-center gap-3 py-3"><img src="art/spots/receipt.webp" alt="" class="w-14 h-14 object-contain opacity-80"/><p class="text-sm text-muted">Bills you pay show up here, with tokens for light.</p></div>`;
    return;
  }
  const statusText = { delivered: ['Paid', 'text-ok'], pending: ['Processing', 'text-muted'], refund_due: ['Refund due', 'text-due'] };
  div.innerHTML = payments.map((p, i) => {
    const [label, cls] = statusText[p.status] || [p.status, 'text-muted'];
    const date = new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<div class="py-3 ${i ? 'rule-t' : ''}">
      <div class="flex justify-between gap-3"><p class="text-[15px] text-main truncate">${escapeHtml(p.planName)}</p><p class="font-mono text-sm text-main shrink-0">${fmtNGN(p.amountNGN)}</p></div>
      <div class="flex justify-between gap-3 font-mono text-xs mt-0.5"><span class="text-muted">${date} · ${escapeHtml(p.billersCode)}${p.source === 'jar' ? ' · from jar' : p.source === 'autopay' ? ' · autopay' : ''}</span><span class="${cls}">${escapeHtml(label)} · ${fmtGD(p.amountGD)} G$</span></div>
      ${p.token ? `<p class="font-mono text-xs text-main mt-1 break-all">Token ${escapeHtml(String(p.token).replace(/^Token\s*:\s*/i, ''))}</p>` : ''}
    </div>`;
  }).join('');
}



// ── Data ───────────────────────────────────────────────────────────────────
function renderData(r) {
  pay.insights = r;
  const card = $('data-card');
  if (!r.forecast && !r.advice) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const f = r.forecast;
  $('data-days').textContent = f ? (f.daysLeft >= 10 ? Math.round(f.daysLeft) : f.daysLeft) : '—';
  $('data-days').classList.toggle('text-due', Boolean(f && f.daysLeft < 2));
  $('data-detail').textContent = f
    ? `~${f.balanceMB >= 1024 ? (f.balanceMB / 1024).toFixed(1) + ' GB' : f.balanceMB + ' MB'} left · you use ~${f.mbPerDay} MB a day${f.source === 'estimate' ? ' · estimated from what you buy' : ''}`
    : 'Update your balance to see how long it lasts.';
  const net = (r.serviceID || '').replace('-data', '');
  $('data-ussd').textContent = USSD[net] || '*323#';
  const adv = $('data-advice');
  const a = r.advice;
  if (a && a.saving > 0) {
    adv.classList.remove('hidden');
    adv.innerHTML = `<p class="text-sm text-main">This month you paid <b>${fmtNGN(a.spentNGN)}</b> for ${a.needGB} GB (${fmtNGN(a.perGB)}/GB).</p>
      <p class="text-sm text-main mt-1">${escapeHtml(a.best.name)}${a.best.times > 1 ? ` × ${a.best.times}` : ''} covers the same for <b>${fmtNGN(a.best.cost)}</b>. You'd save <b class="text-ok">${fmtNGN(a.saving)}</b>.</p>
      <button data-action="buyAdvisedPlan" class="btn-act px-4 py-2.5 text-sm mt-3">Switch to this plan</button>`;
  } else if (a) {
    adv.classList.remove('hidden');
    adv.innerHTML = `<p class="text-sm text-muted">You're already on the cheapest plan for how much you use (${fmtNGN(a.perGB)}/GB).</p>`;
  } else adv.classList.add('hidden');
}

async function saveDataReading() {
  const v = parseFloat($('data-reading').value);
  if (!(v >= 0)) { toast('Enter what your balance shows'); return; }
  const mb = $('data-reading-unit').value === 'GB' ? v * 1024 : v;
  try {
    await post('/data/reading', { mb });
    $('modal-data-reading').classList.remove('active');
    toast('Balance saved');
    payFetch(`/data/insights?userId=${encodeURIComponent(userId())}`).then(renderData);
  } catch (e) { toast(e.message); }
}

// ── Bills ──────────────────────────────────────────────────────────────────
function chip(label, on, attrs) {
  return `<button ${attrs} class="px-3.5 py-2 rounded-full text-sm font-medium border ${on ? 'bg-main text-app border-main' : 'border-edge text-main'}">${escapeHtml(label)}</button>`;
}

async function openBill(cat, preset = {}) {
  if (!signedIn()) { toast('Sign in to pay bills'); openWeb3AuthModal?.(); return; }
  if (!pay.catalog) { try { pay.catalog = await payFetch('/bills/catalog'); } catch (_) { toast('Bills are unavailable right now'); return; } }
  const c = pay.catalog.catalog[cat];
  pay.bill = { cat, c, serviceID: preset.serviceID || c.providers[0].serviceID, meterType: 'prepaid', customer: null, variation: preset.variation_code || null };
  pay.quote = null;
  $('bill-title').textContent = { airtime: 'Buy airtime', data: 'Buy data', electricity: 'Pay for light', tv: 'Pay for TV' }[cat];
  $('bill-number-label').textContent = { phone: 'Phone number', meter: 'Meter number', smartcard: 'Smartcard / IUC number' }[c.input];
  $('bill-number').value = preset.billersCode || localStorage.getItem(`bill-last-${cat}`) || '';
  $('bill-amount').value = '';
  $('bill-customer').classList.add('hidden');
  $('bill-metertype-wrap').classList.toggle('hidden', cat !== 'electricity');
  $('bill-amount-wrap').classList.toggle('hidden', Boolean(c.variations));
  $('bill-plan-wrap').classList.toggle('hidden', !c.variations);
  $('bill-presets').innerHTML = (PRESETS[cat] || []).map(n => chip(fmtNGN(n), false, `data-action="billPreset" data-amount="${n}"`)).join('');
  renderBillProviders();
  renderBillSource();
  resetBillQuote();
  $('modal-bill').classList.add('active');
  if (c.variations) loadPlans();
}

function renderBillProviders() {
  const b = pay.bill;
  $('bill-providers').innerHTML = b.c.providers.map(p => chip(p.name, p.serviceID === b.serviceID, `data-action="billProvider" data-service="${p.serviceID}"`)).join('');
  $('bill-metertype').innerHTML = ['prepaid', 'postpaid'].map(t => chip(t[0].toUpperCase() + t.slice(1), t === b.meterType, `data-action="billMeterType" data-type="${t}"`)).join('');
}

function renderBillSource() {
  // In allowance mode jars are earmarks on the same wallet, so there's nothing separate to pay from.
  const jars = pay.mode !== 'contract' ? [] : pay.jars.filter(j => j.serviceID === pay.bill.serviceID && j.balanceGD > 0);
  $('bill-source-wrap').classList.toggle('hidden', !jars.length);
  $('bill-source').innerHTML = `<option value="">My wallet</option>` + jars.map(j => `<option value="${j.id}">${escapeHtml(j.label)} jar · ${fmtGD(j.balanceGD)} G$</option>`).join('');
}

async function loadPlans() {
  const sel = $('bill-plan');
  sel.innerHTML = '<option>Loading plans…</option>';
  try {
    const { variations } = await payFetch(`/bills/variations?serviceID=${pay.bill.serviceID}`);
    sel.innerHTML = variations.map(v => `<option value="${escapeHtml(v.code)}" ${v.code === pay.bill.variation ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('');
  } catch (e) { sel.innerHTML = '<option value="">Plans unavailable</option>'; }
}

function resetBillQuote() {
  pay.quote = null;
  $('bill-quote').classList.add('hidden');
  $('bill-error').classList.add('hidden');
  $('bill-go').textContent = 'Get price';
  $('bill-go').disabled = false;
}

function billError(msg) { $('bill-error').textContent = msg; $('bill-error').classList.remove('hidden'); }

async function billGo() {
  const b = pay.bill, btn = $('bill-go');
  const number = $('bill-number').value.replace(/\s+/g, '');
  btn.disabled = true;
  $('bill-error').classList.add('hidden');
  try {
    if (!pay.quote) {
      if (b.c.verify && !b.customer) {
        btn.textContent = 'Checking number…';
        b.customer = await post('/bills/verify', { serviceID: b.serviceID, billersCode: number, type: b.meterType });
        $('bill-customer').innerHTML = `<span class="text-ok">✓</span> <span class="text-main">${escapeHtml(b.customer.name || 'Customer found')}</span>`;
        $('bill-customer').classList.remove('hidden');
      }
      btn.textContent = 'Getting price…';
      const q = await post('/bills/quote', {
        serviceID: b.serviceID, billersCode: number, phone: number, meterType: b.meterType,
        variation_code: $('bill-plan').value || undefined, amountNGN: Number($('bill-amount').value),
      });
      pay.quote = q;
      localStorage.setItem(`bill-last-${b.cat}`, number);
      $('bill-quote').innerHTML = `<div class="flex justify-between"><span class="text-muted">${escapeHtml(q.planName)}</span><span class="text-main">${fmtNGN(q.amountNGN)}</span></div>
        <div class="flex justify-between"><span class="text-muted">In G$ (incl. ${(q.feeBps / 100).toFixed(1)}% fee)</span><span class="text-main">${fmtGD(q.amountGD)} G$</span></div>
        <div class="flex justify-between"><span class="text-muted">Price held until</span><span class="text-main">${new Date(q.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>`;
      $('bill-quote').classList.remove('hidden');
      btn.textContent = `Pay ${fmtGD(q.amountGD)} G$`;
      btn.disabled = false;
      return;
    }

    const jarId = $('bill-source').value;
    let result;
    if (jarId) {
      btn.textContent = 'Paying from jar…';
      result = await post('/bills/pay', { quoteId: pay.quote.quoteId, jarId: Number(jarId) });
    } else if (pay.catalog.sandbox && !pay.catalog.treasury) {
      btn.textContent = 'Paying (sandbox)…';
      result = await post('/bills/pay', { quoteId: pay.quote.quoteId });
    } else {
      const { provider, from } = await wallet();
      btn.textContent = 'Confirm in your wallet…';
      await ensureLinked(provider, from);
      btn.textContent = 'Sending G$…';
      const data = iface(ERC20_ABI).encodeFunctionData('transfer', [pay.quote.treasury || pay.catalog.treasury, BigInt(pay.quote.amountWei)]);
      const txHash = await sendTx(provider, from, GD_TOKEN, data);
      btn.textContent = 'Paying your bill…';
      result = await post('/bills/pay', { quoteId: pay.quote.quoteId, txHash });
    }
    $('modal-bill').classList.remove('active');
    showBillDone(result);
    track('action', { action: 'bill_paid', category: b.cat, status: result.status });
    refreshPay();
  } catch (e) {
    if (e.code === 4001) billError('Cancelled in your wallet.');
    else billError(e.message);
    if (/expired/i.test(e.message)) resetBillQuote();
    btn.textContent = pay.quote ? `Pay ${fmtGD(pay.quote.amountGD)} G$` : 'Get price';
    btn.disabled = false;
  }
}

function showBillDone(r) {
  const ok = r.status === 'delivered' || r.status === 'pending';
  $('bill-done-art').src = ok ? 'art/spots/receipt.webp' : 'art/spots/unplugged.webp';
  $('bill-done-title').textContent = r.status === 'delivered' ? 'Paid' : r.status === 'pending' ? 'Processing' : 'Not delivered';
  $('bill-done-sub').textContent = ok
    ? `${r.planName} · ${fmtNGN(r.amountNGN)} for ${fmtGD(r.amountGD)} G$`
    : (r.error || 'The provider could not deliver this bill. Your G$ is flagged for a refund.');
  const token = r.token ? String(r.token).replace(/^Token\s*:\s*/i, '') : '';
  $('bill-done-token').classList.toggle('hidden', !token);
  $('bill-done-token-val').textContent = token;
  $('modal-bill-done').classList.add('active');
}

// ── Jars ───────────────────────────────────────────────────────────────────
async function loadJars() {
  try {
    const r = await payFetch(`/jars?userId=${encodeURIComponent(userId())}`);
    pay.jars = r.jars || []; pay.wallet = r.wallet; pay.contract = r.contract || null;
    pay.mode = r.mode || 'allowance'; pay.spender = r.spender || null;
    pay.walletGD = r.walletGD || 0; pay.allowanceGD = r.allowanceGD || 0;
  } catch (_) { pay.jars = []; }
  renderJars();
}

function renderJars() {
  const div = $('jars-list');
  if (!pay.jars.length) {
    div.innerHTML = `<button data-action="openJar" class="press w-full glass rounded-2xl p-4 flex items-center gap-4 text-left">
      <img src="art/spots/jar.webp" alt="" class="w-16 h-16 object-contain shrink-0"/>
      <span><span class="font-semibold text-main block">Start a bill jar</span><span class="text-sm text-muted">${pay.mode === 'contract' ? 'Each daily claim fills it a little. It pays GOtv, light or data on the day it\'s due.' : 'Set G$ aside for GOtv, light or data. Turn on autopay and it pays itself on the due day.'}</span></span></button>`;
    return;
  }
  if (pay.mode !== 'contract') { renderAllowanceJars(div); return; }
  const est = j => pay.catalog?.ngnPerGD && j.amountNGN ? Math.ceil(j.amountNGN / pay.catalog.ngnPerGD * (1 + (pay.catalog.marginBps || 300) / 10000)) : null;
  div.innerHTML = pay.jars.map(j => {
    const target = est(j);
    const pct = target ? Math.min(100, Math.round(j.balanceGD / target * 100)) : 0;
    const lit = Math.round(pct / 5);
    const when = j.autoTopUp ? 'tops up when data runs low' : `due on the ${ordinal(j.dueDay)}`;
    return `<div class="glass rounded-2xl p-4">
      <div class="flex items-start gap-3">
        <img src="art/spots/jar.webp" alt="" class="w-12 h-12 object-contain shrink-0"/>
        <div class="flex-1 min-w-0">
          <div class="flex justify-between gap-2"><p class="font-semibold text-main truncate">${escapeHtml(j.label)}</p><button data-action="openJar" data-jar="${j.id}" class="mono-label hover:text-main">Edit</button></div>
          <p class="font-mono text-sm text-main mt-0.5">${fmtGD(j.balanceGD)}${target ? ` / ${fmtGD(target)}` : ''} G$</p>
        </div>
      </div>
      ${target ? `<div class="seg-bar mt-3">${Array.from({ length: 20 }, (_, i) => `<i class="${i < lit ? 'on' : ''}"></i>`).join('')}</div>` : ''}
      <div class="flex justify-between items-center mt-3">
        <p class="font-mono text-xs text-muted">${when}${j.splitPct ? ` · ${j.splitPct}% of daily claim` : ''}</p>
        ${pay.contract ? `<button data-action="openJarFund" data-jar="${j.id}" class="btn-line px-3.5 py-1.5 text-xs whitespace-nowrap shrink-0">Add G$</button>` : ''}
      </div>
    </div>`;
  }).join('') + (pay.contract ? '' : `<p class="font-mono text-xs text-muted">Jars save your plan now; G$ goes in once the jar contract is live.</p>`);
}

function dueText(j) {
  if (j.autoTopUp) return 'tops up when data runs low';
  if (j.dueInDays === 0) return 'due today';
  if (j.dueInDays === 1) return 'due tomorrow';
  return `due on the ${ordinal(j.dueDay)}${j.dueInDays != null && j.dueInDays <= 7 ? ` · in ${j.dueInDays}d` : ''}`;
}

// Allowance mode: G$ never leaves the wallet until a bill is paid; jars just earmark it.
function renderAllowanceJars(div) {
  const autopayJars = pay.jars.filter(j => j.autopay);
  div.innerHTML = pay.jars.map(j => {
    const target = j.targetGD;
    const lit = target ? Math.round(Math.min(100, j.balanceGD / target * 100) / 5) : 0;
    const short = j.shortGD > 0;
    const status = !j.autopay ? ''
      : short ? `<span class="text-due">short ${fmtGD(j.shortGD)} G$</span>`
      : j.targetGD && pay.allowanceGD < j.targetGD ? `<span class="text-due">autopay limit used up</span>`
      : `<span class="text-ok">autopay on</span>`;
    const action = !j.autopay
      ? `<button data-action="enableAutopay" data-jar="${j.id}" class="btn-line px-3.5 py-1.5 text-xs whitespace-nowrap shrink-0">Turn on autopay</button>`
      : (j.targetGD && pay.allowanceGD < j.targetGD ? `<button data-action="enableAutopay" data-jar="${j.id}" class="btn-line px-3.5 py-1.5 text-xs whitespace-nowrap shrink-0">Renew</button>` : '');
    return `<div class="glass rounded-2xl p-4">
      <div class="flex items-start gap-3">
        <img src="art/spots/jar.webp" alt="" class="w-12 h-12 object-contain shrink-0"/>
        <div class="flex-1 min-w-0">
          <div class="flex justify-between gap-2"><p class="font-semibold text-main truncate">${escapeHtml(j.label)}</p><button data-action="openJar" data-jar="${j.id}" class="mono-label hover:text-main">Edit</button></div>
          <p class="font-mono text-sm text-main mt-0.5">${fmtGD(j.balanceGD)}${target ? ` / ${fmtGD(target)}` : ''} G$ <span class="text-muted">set aside</span></p>
        </div>
      </div>
      ${target ? `<div class="seg-bar mt-3">${Array.from({ length: 20 }, (_, i) => `<i class="${i < lit ? 'on' : ''}"></i>`).join('')}</div>` : ''}
      <div class="flex justify-between items-center gap-3 mt-3">
        <p class="font-mono text-xs text-muted">${dueText(j)}${status ? ' · ' + status : ''}</p>
        ${action}
      </div>
    </div>`;
  }).join('') + `<div class="rule-t pt-3 mt-1 flex justify-between items-start gap-3">
    <p class="text-xs text-muted">Your G$ stays in your wallet. ${autopayJars.length
      ? `Autopay can take up to <span class="font-mono text-main">${fmtGD(pay.allowanceGD)} G$</span>, only for these bills, only on the due day.`
      : 'Turn on autopay and SubBot pays the bill on its due day, never more than its price.'}</p>
    ${autopayJars.length ? `<button data-action="revokeAutopay" class="mono-label text-due shrink-0">Stop all</button>` : ''}
  </div>`;
}

async function setJarAutopay(j, on) {
  await post('/jars', { jar: { ...j, autopay: on } });
}

async function enableAutopay(id) {
  const j = pay.jars.find(x => x.id === Number(id));
  if (!j) return;
  if (!pay.spender) { toast('Autopay is not available yet'); return; }
  if (!j.targetGD) { toast('Set the bill amount first'); openJar(j.id); return; }
  try {
    const { provider, from } = await wallet();
    await ensureLinked(provider, from);
    // Approve enough for a few cycles of every autopay jar, so one approval lasts a while.
    const perCycle = pay.jars.filter(x => x.autopay || x.id === j.id).reduce((s, x) => s + (x.targetGD || 0), 0);
    const need = ethers.parseUnits(String(Math.ceil(perCycle * AUTOPAY_HEADROOM * AUTOPAY_CYCLES)), 18);
    const current = await ethCall(GD_TOKEN, iface(ERC20_ABI).encodeFunctionData('allowance', [from, pay.spender]));
    if (!current || BigInt(current) < need) {
      toast('Confirm the autopay limit in your wallet…');
      await sendTx(provider, from, GD_TOKEN, iface(ERC20_ABI).encodeFunctionData('approve', [pay.spender, need]));
    }
    if (!j.autopay) await setJarAutopay(j, true);
    toast(`Autopay on for ${j.label}`);
    track('action', { action: 'autopay_on' });
    loadJars();
  } catch (e) { toast(e.code === 4001 ? 'Cancelled' : e.message); }
}

async function revokeAutopay() {
  try {
    const { provider, from } = await wallet();
    toast('Confirm in your wallet…');
    await sendTx(provider, from, GD_TOKEN, iface(ERC20_ABI).encodeFunctionData('approve', [pay.spender, 0n]));
    for (const j of pay.jars.filter(x => x.autopay)) await setJarAutopay(j, false);
    toast('Autopay stopped. SubBot can no longer take G$.');
    track('action', { action: 'autopay_off' });
    loadJars();
  } catch (e) { toast(e.code === 4001 ? 'Cancelled' : e.message); }
}

function streamRow() {
  return `<div class="rule-t pt-4 mt-1 flex items-center gap-3">
    <div class="flex-1"><p class="font-medium text-main">Stream G$ into jars</p><p class="text-xs text-muted">Fills every jar by its share, second by second.</p></div>
    <input id="stream-per-day" type="number" inputmode="numeric" min="1" placeholder="G$/day" class="w-24 bg-field border border-edge rounded-xl py-2 px-2.5 font-mono text-main"/>
    <button data-action="startStream" class="btn-line px-3 py-2 text-xs">Start</button>
  </div>`;
}

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

function jarServiceOptions(selected) {
  const c = pay.catalog?.catalog || {};
  return Object.entries(c).map(([cat, def]) => `<optgroup label="${def.label}">` +
    def.providers.map(p => `<option value="${p.serviceID}" data-cat="${cat}" ${p.serviceID === selected ? 'selected' : ''}>${escapeHtml(p.name)}${cat === 'airtime' || cat === 'data' ? ' ' + def.label.toLowerCase() : ''}</option>`).join('') + '</optgroup>').join('');
}

async function openJar(id) {
  if (!signedIn()) { toast('Sign in to make a jar'); return; }
  if (!pay.catalog) { try { pay.catalog = await payFetch('/bills/catalog'); } catch (_) { return; } }
  const j = pay.jars.find(x => x.id === Number(id)) || null;
  pay.jarEditing = j;
  $('jar-title').textContent = j ? 'Edit jar' : 'New bill jar';
  $('jar-label').value = j?.label || '';
  $('jar-service').innerHTML = jarServiceOptions(j?.serviceID || 'gotv');
  $('jar-number').value = j?.billersCode || '';
  $('jar-amount').value = j?.amountNGN || '';
  $('jar-due').value = j?.dueDay || '';
  $('jar-auto').checked = Boolean(j?.autoTopUp);
  const contractMode = pay.mode === 'contract';
  $('jar-intro').textContent = contractMode
    ? 'Set G$ aside for one bill. Your daily claim fills it, and it pays the bill on the day it\'s due.'
    : 'Set G$ aside for one bill. It stays in your wallet until the bill is due.';
  $('jar-split-wrap').classList.toggle('hidden', !contractMode);
  $('jar-autopay-wrap').classList.toggle('hidden', contractMode || !j?.autopay);
  $('jar-autopay').checked = Boolean(j?.autopay);
  $('jar-split').value = j?.splitPct ?? (contractMode ? 50 : 0);
  $('jar-split-val').textContent = $('jar-split').value + '%';
  $('jar-error').classList.add('hidden');
  $('jar-delete').classList.toggle('hidden', !j);
  await syncJarForm(j?.variation_code);
  $('modal-jar').classList.add('active');
}

async function syncJarForm(selectedPlan) {
  const opt = $('jar-service').selectedOptions[0];
  const cat = opt?.dataset.cat;
  const def = pay.catalog.catalog[cat];
  $('jar-number-label').textContent = { phone: 'Phone number', meter: 'Meter number', smartcard: 'Smartcard / IUC number' }[def.input];
  $('jar-plan-wrap').classList.toggle('hidden', !def.variations);
  $('jar-amount-wrap').classList.toggle('hidden', Boolean(def.variations));
  $('jar-auto-wrap').classList.toggle('hidden', cat !== 'data');
  $('jar-due-wrap').classList.toggle('hidden', cat === 'data' && $('jar-auto').checked);
  if (def.variations) {
    $('jar-plan').innerHTML = '<option>Loading plans…</option>';
    try {
      const { variations } = await payFetch(`/bills/variations?serviceID=${opt.value}`);
      $('jar-plan').innerHTML = variations.map(v => `<option value="${escapeHtml(v.code)}" data-amount="${v.amount}" ${v.code === selectedPlan ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('');
    } catch (_) { $('jar-plan').innerHTML = '<option value="">Plans unavailable</option>'; }
  }
}

async function saveJar() {
  const opt = $('jar-service').selectedOptions[0];
  const planOpt = $('jar-plan').selectedOptions[0];
  const isPlan = !$('jar-plan-wrap').classList.contains('hidden');
  const jar = {
    id: pay.jarEditing?.id, label: $('jar-label').value, serviceID: opt.value,
    billersCode: $('jar-number').value, variation_code: isPlan ? planOpt?.value : null,
    meterType: opt.dataset.cat === 'electricity' ? 'prepaid' : null,
    amountNGN: isPlan ? Number(planOpt?.dataset.amount) : Number($('jar-amount').value),
    dueDay: Number($('jar-due').value), splitPct: pay.mode === 'contract' ? Number($('jar-split').value) : 0, autoTopUp: $('jar-auto').checked,
    lastPaid: pay.jarEditing?.lastPaid,
    autopay: pay.mode !== 'contract' && Boolean(pay.jarEditing?.autopay) && $('jar-autopay').checked,
  };
  try {
    await post('/jars', { jar });
    $('modal-jar').classList.remove('active');
    toast(pay.jarEditing ? 'Jar updated' : 'Jar created');
    track('action', { action: pay.jarEditing ? 'jar_edit' : 'jar_create' });
    loadJars();
  } catch (e) { $('jar-error').textContent = e.message; $('jar-error').classList.remove('hidden'); }
}

async function deleteJar() {
  const j = pay.jarEditing;
  if (!j) return;
  if (j.balanceGD > 0) { $('jar-error').textContent = 'Take the G$ out of this jar first.'; $('jar-error').classList.remove('hidden'); return; }
  await post('/jars/delete', { jarId: j.id }).catch(() => {});
  $('modal-jar').classList.remove('active');
  loadJars();
}

function openJarFund(id) {
  pay.jarFunding = pay.jars.find(j => j.id === Number(id));
  $('jar-fund-title').textContent = `${pay.jarFunding.label}`;
  $('jar-fund-amount').value = '';
  $('modal-jar-fund').classList.add('active');
}

// The agent can only pay out up to this cap per cycle; a little headroom covers price moves.
function capFor(j) {
  const ngnPerGD = pay.catalog?.ngnPerGD;
  if (!ngnPerGD || !j.amountNGN) return null;
  return ethers.parseUnits(String(Math.ceil(j.amountNGN / ngnPerGD * 1.25)), 18);
}

async function depositToJars(provider, from, ids, amountsWei) {
  const total = amountsWei.reduce((a, b) => a + b, 0n);
  const allowance = await ethCall(GD_TOKEN, iface(ERC20_ABI).encodeFunctionData('allowance', [from, pay.contract]));
  if (!allowance || BigInt(allowance) < total) {
    await sendTx(provider, from, GD_TOKEN, iface(ERC20_ABI).encodeFunctionData('approve', [pay.contract, total]));
  }
  await sendTx(provider, from, pay.contract, iface(JARS_ABI).encodeFunctionData('deposit', [ids.map(BigInt), amountsWei]));
}

async function fundJar() {
  const j = pay.jarFunding;
  const amt = parseFloat($('jar-fund-amount').value);
  if (!(amt > 0)) { toast('Enter how much G$'); return; }
  try {
    const { provider, from } = await wallet();
    await ensureLinked(provider, from);
    toast('Confirm in your wallet…');
    await depositToJars(provider, from, [j.id], [ethers.parseUnits(String(amt), 18)]);
    const cap = capFor(j);
    if (cap && !(j.capGD > 0)) {
      toast('One more: let SubBot pay this bill from the jar');
      await sendTx(provider, from, pay.contract, iface(JARS_ABI).encodeFunctionData('setCap', [BigInt(j.id), cap]));
    }
    $('modal-jar-fund').classList.remove('active');
    toast(`Added ${fmtGD(amt)} G$`);
    track('action', { action: 'jar_fund' });
    loadJars();
  } catch (e) { toast(e.code === 4001 ? 'Cancelled' : e.message); }
}

async function withdrawJar() {
  const j = pay.jarFunding;
  const amt = parseFloat($('jar-fund-amount').value);
  try {
    const { provider, from } = await wallet();
    toast('Confirm in your wallet…');
    const wei = amt > 0 ? ethers.parseUnits(String(amt), 18) : 0n; // 0 = everything
    await sendTx(provider, from, pay.contract, iface(JARS_ABI).encodeFunctionData('withdraw', [BigInt(j.id), wei]));
    $('modal-jar-fund').classList.remove('active');
    toast('G$ back in your wallet');
    loadJars();
  } catch (e) { toast(e.code === 4001 ? 'Cancelled' : e.message); }
}

// Split a fresh daily claim across jars by their share. Called by claimGD() in popup.js.
async function afterClaim(from, claimedWei) {
  if (!pay.contract || !claimedWei) return;
  if (!pay.jars.length) await loadJars();
  const shares = pay.jars.filter(j => j.splitPct > 0);
  if (!shares.length) return;
  const amounts = shares.map(j => BigInt(claimedWei) * BigInt(j.splitPct) / 100n);
  if (amounts.every(a => a === 0n)) return;
  try {
    const { provider } = await wallet();
    toast('Putting today\'s G$ into your jars…');
    await depositToJars(provider, from, shares.map(j => j.id), amounts);
    toast('Jars filled');
    loadJars();
  } catch (e) { toast(e.code === 4001 ? 'Jars skipped today' : 'Could not fill jars: ' + e.message); }
}

async function startStream() {
  toast('Stream funding is unavailable. Add G$ to a jar instead.');
}

// ── Events ─────────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'openBill': openBill(el.dataset.cat); break;
    case 'billProvider': pay.bill.serviceID = el.dataset.service; pay.bill.customer = null; pay.bill.variation = null; renderBillProviders(); renderBillSource(); resetBillQuote(); if (pay.bill.c.variations) loadPlans(); break;
    case 'billMeterType': pay.bill.meterType = el.dataset.type; pay.bill.customer = null; renderBillProviders(); resetBillQuote(); break;
    case 'billPreset': $('bill-amount').value = el.dataset.amount; resetBillQuote(); break;
    case 'billGo': billGo(); break;
    case 'copyToken': navigator.clipboard?.writeText($('bill-done-token-val').textContent).then(() => toast('Token copied')); break;
    case 'openJar': openJar(el.dataset.jar); break;
    case 'saveJar': saveJar(); break;
    case 'deleteJar': deleteJar(); break;
    case 'openJarFund': openJarFund(el.dataset.jar); break;
    case 'fundJar': fundJar(); break;
    case 'withdrawJar': withdrawJar(); break;
    case 'startStream': startStream(); break;
    case 'enableAutopay': enableAutopay(el.dataset.jar); break;
    case 'revokeAutopay': revokeAutopay(); break;
    case 'openDataReading': $('modal-data-reading').classList.add('active'); break;
    case 'saveDataReading': saveDataReading(); break;
    case 'buyAdvisedPlan': if (pay.insights?.advice) openBill('data', { serviceID: pay.insights.serviceID, variation_code: pay.insights.advice.best.code }); break;
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'bill-number' && pay.bill) { pay.bill.customer = null; $('bill-customer').classList.add('hidden'); resetBillQuote(); }
  if (e.target.id === 'bill-amount') resetBillQuote();
  if (e.target.id === 'jar-split') $('jar-split-val').textContent = e.target.value + '%';
});
document.addEventListener('change', e => {
  if (e.target.id === 'bill-plan') resetBillQuote();
  if (e.target.id === 'jar-service') syncJarForm();
  if (e.target.id === 'jar-auto') $('jar-due-wrap').classList.toggle('hidden', e.target.checked);
});
