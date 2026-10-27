/**
 * Pay bills with G$ — airtime, data, electricity and TV through VTpass.
 *
 * Flow (batch-treasury model):
 *   1. POST /bills/quote   locks a G$ price for a bill for QUOTE_TTL_MS.
 *   2. The user sends that much G$ to BILLS_TREASURY_ADDRESS (or pays from a jar).
 *   3. POST /bills/pay     checks the G$ Transfer on-chain, then calls VTpass.
 *   G$ collected in the treasury is swapped to cUSD in batches by
 *   scripts/treasury-swap.js — never per payment.
 *
 * Bill jars come in two modes:
 *   - allowance (default): G$ stays in the user's wallet. A jar is an earmark
 *     on that balance. For autopay the user approves the agent wallet to spend
 *     G$; on the due day the agent pulls exactly the bill's price to the
 *     treasury. The total is limited by the approval, and each jar by its own
 *     price ceiling (AUTOPAY_HEADROOM).
 *   - contract: if JARS_CONTRACT_ADDRESS is set, SubBotJars.sol holds G$ per
 *     jar and enforces caps on-chain.
 * Either way the agent only touches a wallet the user proved they own
 * (POST /wallet/link).
 *
 * Kept out of api-bridge.js so it can be unit-tested with fake VTpass/chain deps.
 */
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { ethers } = require('ethers');
const { asyncRoute, storageErrorHandler } = require('./http-errors');

const GD_TOKEN       = '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A';
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const QUOTE_TTL_MS   = 10 * 60 * 1000;
const AUTOPAY_HEADROOM = 1.25; // an autopay jar never pays more than 125% of the price it was set up with
const PRICE_TTL_MS   = 5 * 60 * 1000;

// ── Catalogue ──────────────────────────────────────────────────────────────
// serviceIDs are VTpass's. `verify` = needs merchant-verify (meter/smartcard).
const CATALOG = {
  airtime: {
    label: 'Airtime', input: 'phone',
    providers: [
      { serviceID: 'mtn', name: 'MTN' }, { serviceID: 'airtel', name: 'Airtel' },
      { serviceID: 'glo', name: 'Glo' }, { serviceID: 'etisalat', name: '9mobile' },
    ],
  },
  data: {
    label: 'Data', input: 'phone', variations: true,
    providers: [
      { serviceID: 'mtn-data', name: 'MTN' }, { serviceID: 'airtel-data', name: 'Airtel' },
      { serviceID: 'glo-data', name: 'Glo' }, { serviceID: 'etisalat-data', name: '9mobile' },
    ],
  },
  electricity: {
    label: 'Electricity', input: 'meter', verify: true, meterTypes: ['prepaid', 'postpaid'],
    providers: [
      { serviceID: 'ikeja-electric', name: 'Ikeja (IKEDC)' }, { serviceID: 'eko-electric', name: 'Eko (EKEDC)' },
      { serviceID: 'abuja-electric', name: 'Abuja (AEDC)' }, { serviceID: 'kano-electric', name: 'Kano (KEDCO)' },
      { serviceID: 'kaduna-electric', name: 'Kaduna' }, { serviceID: 'jos-electric', name: 'Jos (JED)' },
      { serviceID: 'ibadan-electric', name: 'Ibadan (IBEDC)' }, { serviceID: 'enugu-electric', name: 'Enugu (EEDC)' },
      { serviceID: 'portharcourt-electric', name: 'Port Harcourt (PHED)' }, { serviceID: 'benin-electric', name: 'Benin (BEDC)' },
      { serviceID: 'aba-electric', name: 'Aba' }, { serviceID: 'yola-electric', name: 'Yola' },
    ],
  },
  tv: {
    label: 'TV', input: 'smartcard', verify: true, variations: true,
    providers: [
      { serviceID: 'gotv', name: 'GOtv' }, { serviceID: 'dstv', name: 'DStv' }, { serviceID: 'startimes', name: 'StarTimes' },
    ],
  },
};

function findService(serviceID) {
  for (const [category, c] of Object.entries(CATALOG)) {
    const p = c.providers.find(x => x.serviceID === serviceID);
    if (p) return { category, ...c, provider: p };
  }
  return null;
}

// ── VTpass client ──────────────────────────────────────────────────────────
function createVtpassClient({ env = process.env, fetchImpl = fetch } = {}) {
  const live = env.VTPASS_ENV === 'live';
  const base = live ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
  const configured = Boolean(env.VTPASS_API_KEY && env.VTPASS_SECRET_KEY && env.VTPASS_PUBLIC_KEY);

  async function call(method, route, body) {
    if (!configured) throw new Error('VTpass keys not configured');
    const headers = { 'api-key': env.VTPASS_API_KEY, 'Content-Type': 'application/json' };
    if (method === 'GET') headers['public-key'] = env.VTPASS_PUBLIC_KEY;
    else headers['secret-key'] = env.VTPASS_SECRET_KEY;
    const r = await fetchImpl(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.response_description || `VTpass HTTP ${r.status}`);
    return j;
  }

  return {
    live, configured,
    async variations(serviceID) {
      const j = await call('GET', `/service-variations?serviceID=${encodeURIComponent(serviceID)}`);
      const list = j.content?.variations || j.content?.varations || []; // VTpass spells it both ways
      return list.map(v => ({ code: v.variation_code, name: v.name, amount: Number(v.variation_amount) }));
    },
    async verify(serviceID, billersCode, type) {
      const j = await call('POST', '/merchant-verify', { serviceID, billersCode, type });
      if (j.code !== '000' || j.content?.error) throw new Error(j.content?.error || 'Could not verify that number');
      return {
        name: j.content.Customer_Name || j.content.customer_name || '',
        address: j.content.Address || '',
        renewalAmount: Number(j.content.Renewal_Amount) || null,
      };
    },
    async pay(order) {
      const j = await call('POST', '/pay', order);
      const status = j.content?.transactions?.status;
      return {
        ok: j.code === '000' || j.code === '099',
        pending: j.code === '099' || status === 'pending' || status === 'initiated',
        code: j.code,
        status: status || (j.code === '000' ? 'delivered' : 'failed'),
        message: j.response_description,
        vtpassTxId: j.content?.transactions?.transactionId || null,
        token: j.token || j.purchased_code || j.mainToken || null,
      };
    },
    async requery(request_id) {
      return call('POST', '/requery', { request_id });
    },
  };
}

// VTpass wants request_id to start with the Lagos-time YYYYMMDDHHmm.
function vtpassRequestId(now = new Date()) {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000); // WAT = UTC+1, no DST
  const stamp = lagos.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return stamp + crypto.randomBytes(6).toString('hex');
}

// ── G$ price ───────────────────────────────────────────────────────────────
function createPriceFeed({ env = process.env, fetchImpl = fetch } = {}) {
  let cache = null;
  return async function ngnPerGD() {
    if (env.GD_NGN_PRICE) return Number(env.GD_NGN_PRICE);
    if (cache && Date.now() - cache.ts < PRICE_TTL_MS) return cache.price;
    const r = await fetchImpl('https://api.coingecko.com/api/v3/simple/price?ids=gooddollar&vs_currencies=ngn', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const price = Number(j?.gooddollar?.ngn);
    if (!price) throw new Error('G$ price unavailable');
    cache = { price, ts: Date.now() };
    return price;
  };
}

// G$ amount for a naira bill, margin on top, rounded up to a whole G$.
function gdForNaira(amountNGN, ngnPerGD, marginBps) {
  const raw = amountNGN / ngnPerGD * (1 + marginBps / 10000);
  return Math.ceil(raw);
}

// ── On-chain payment check ─────────────────────────────────────────────────
// A payment counts when the receipt has a G$ Transfer of at least the quoted
// amount from the user's own linked wallet to the treasury. Checking the sender
// matters: every transfer is public, so without it anyone could claim someone
// else's payment by submitting its tx hash first.
async function verifyGdTransfer(provider, txHash, treasury, minWei, payer) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return { ok: false, reason: 'Transaction not found yet — try again in a few seconds' };
  if (receipt.status !== 1) return { ok: false, reason: 'Transaction failed on-chain' };
  const to = treasury.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== GD_TOKEN.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const dest = ethers.getAddress('0x' + log.topics[2].slice(26)).toLowerCase();
    if (dest !== to) continue;
    const src = ethers.getAddress('0x' + log.topics[1].slice(26));
    if (payer && src.toLowerCase() !== payer.toLowerCase()) continue;
    const value = BigInt(log.data);
    if (value >= minWei) return { ok: true, from: src, value };
  }
  return { ok: false, reason: 'No G$ transfer of the quoted amount from your wallet to the SubBot treasury in that transaction' };
}

// ── Data bundles ───────────────────────────────────────────────────────────
// Pull size + validity out of VTpass plan names like
// "MTN N1000 1.5GB - 30 days" or "Airtel Data - 100 Naira - 75MB - 1Day".
function parsePlan(name = '') {
  const size = name.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB)/i);
  let gb = null;
  if (size) gb = Number(size[1]) * ({ tb: 1024, gb: 1, mb: 1 / 1024 })[size[2].toLowerCase()];
  let days = null;
  const d = name.match(/(\d+)\s*-?\s*days?/i);
  if (d) days = Number(d[1]);
  else if (/month/i.test(name)) days = 30;
  else if (/week/i.test(name)) days = 7;
  else if (/daily|\bday\b|24\s*hrs?/i.test(name)) days = 1;
  const m = name.match(/(\d+)\s*months?/i);
  if (m) days = Number(m[1]) * 30;
  return { gb, days };
}

// Cheapest way to cover `needGB` over 30 days with one repeated plan.
function adviseDataPlan(purchases, plans) {
  const windowStart = Date.now() - 30 * 86400000;
  const recent = purchases.filter(p => new Date(p.at).getTime() >= windowStart && p.gb);
  if (!recent.length) return null;
  const needGB  = recent.reduce((s, p) => s + p.gb, 0);
  const spentNGN = recent.reduce((s, p) => s + p.amountNGN, 0);
  let best = null;
  for (const plan of plans) {
    const { gb, days } = parsePlan(plan.name);
    if (!gb || !days || !plan.amount) continue;
    const times = Math.max(Math.ceil(30 / days), Math.ceil(needGB / gb));
    const cost  = times * plan.amount;
    if (!best || cost < best.cost) best = { plan, times, cost, gb, days };
  }
  if (!best) return null;
  const saving = spentNGN - best.cost;
  return {
    needGB: Math.round(needGB * 100) / 100,
    spentNGN,
    perGB: Math.round(spentNGN / needGB),
    best: { code: best.plan.code, name: best.plan.name, amount: best.plan.amount, times: best.times, cost: best.cost, perGB: Math.round(best.cost / (best.gb * best.times)) },
    saving: saving >= 100 && saving / spentNGN >= 0.05 ? saving : 0,
  };
}

// Days of data left: from the last two balance readings if there was no top-up
// between them, otherwise from what the user buys per day.
function forecastData(purchases, readings) {
  const sortedR = [...readings].sort((a, b) => new Date(a.at) - new Date(b.at));
  const last = sortedR[sortedR.length - 1];
  let mbPerDay = null;
  if (sortedR.length >= 2) {
    const prev = sortedR[sortedR.length - 2];
    const topUpBetween = purchases.some(p => new Date(p.at) > new Date(prev.at) && new Date(p.at) <= new Date(last.at));
    const days = (new Date(last.at) - new Date(prev.at)) / 86400000;
    if (!topUpBetween && days >= 0.25 && prev.mb > last.mb) mbPerDay = (prev.mb - last.mb) / days;
  }
  const recent = purchases.filter(p => p.gb && Date.now() - new Date(p.at) <= 30 * 86400000);
  if (!mbPerDay && recent.length) {
    const first = Math.min(...recent.map(p => new Date(p.at).getTime()));
    const spanDays = Math.max(7, (Date.now() - first) / 86400000);
    mbPerDay = recent.reduce((s, p) => s + p.gb * 1024, 0) / spanDays;
  }
  if (!mbPerDay) return null;

  let balanceMB = null, source = 'estimate';
  const lastPurchase = recent.sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  if (last && (!lastPurchase || new Date(last.at) >= new Date(lastPurchase.at))) {
    balanceMB = last.mb - mbPerDay * ((Date.now() - new Date(last.at)) / 86400000);
    source = 'reading';
  } else if (lastPurchase) {
    balanceMB = lastPurchase.gb * 1024 - mbPerDay * ((Date.now() - new Date(lastPurchase.at)) / 86400000);
  }
  if (balanceMB === null) return null;
  balanceMB = Math.max(0, balanceMB);
  return { mbPerDay: Math.round(mbPerDay), balanceMB: Math.round(balanceMB), daysLeft: Math.round(balanceMB / mbPerDay * 10) / 10, source };
}

// ── Allowance autopay ──────────────────────────────────────────────────────
// G$ is pulled with transferFrom by the agent wallet (the spender the user approved).
function createGdAutopay(signer, token = GD_TOKEN) {
  const gd = new ethers.Contract(token, [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  ], signer);
  return {
    spender: signer.address,
    balanceOf: owner => gd.balanceOf(owner),
    allowance: owner => gd.allowance(owner, signer.address),
    pull: (owner, to, amountWei) => gd.transferFrom(owner, to, amountWei),
  };
}

// ── Router ─────────────────────────────────────────────────────────────────
function createBillsRouter(deps) {
  const express = require('express');
  const {
    userDir, readJSON, writeJSON, withFileLock, requireSession, requireInternalToken,
    provider, getJarsContract = () => null, getCreditsContract = () => null, getAutopay = () => null, env = process.env,
    vtpass = createVtpassClient({ env }), ngnPerGD = createPriceFeed({ env }),
    usedTxFile, now = () => new Date(),
  } = deps;
  const router     = express.Router();
  const treasury   = env.BILLS_TREASURY_ADDRESS || '';
  const marginBps  = Number(env.BILLS_MARGIN_BPS || 300);
  // Sandbox demos without real G$: only possible while VTpass itself is in sandbox.
  const skipChain  = env.BILLS_CHAIN_CHECK === 'off' && !vtpass.live;
  const quotes     = new Map(); // quoteId → quote (short-lived; losing them on restart only forces a re-quote)

  const billsFile = uid => path.join(userDir(uid), 'bills.json');
  const jarsFile  = uid => path.join(userDir(uid), 'jars.json');
  const metaFile  = uid => path.join(userDir(uid), 'web3auth-meta.json');
  const linkedWallet = uid => readJSON(metaFile(uid))?.wallet || null;
  const jarMode = () => getJarsContract() ? 'contract' : 'allowance';

  function requireUser(req, res, next) {
    const uid = req.body?.userId || req.query?.userId;
    if (!uid || uid === 'local') return res.status(401).json({ error: 'Sign in to pay bills' });
    next();
  }

  async function recordBill(uid, entry) {
    const file = billsFile(uid);
    await withFileLock(file, () => {
      const data = readJSON(file) || { payments: [], dataPurchases: [], dataReadings: [] };
      data.payments = [entry, ...data.payments.filter(p => p.id !== entry.id)].slice(0, 500);
      if (entry.category === 'data' && entry.status !== 'failed' && !data.dataPurchases.some(p => p.id === entry.id)) {
        const { gb, days } = parsePlan(entry.planName);
        data.dataPurchases.unshift({ id: entry.id, serviceID: entry.serviceID, gb, days, amountNGN: entry.amountNGN, at: entry.createdAt });
        data.dataPurchases = data.dataPurchases.slice(0, 200);
      }
      writeJSON(file, data);
    });
  }

  // A bundle is a subscription too: keep one "data" sub per line, renewing when the plan expires.
  async function upsertDataSub(uid, entry) {
    const { days } = parsePlan(entry.planName);
    const file = path.join(userDir(uid), 'scanned-subscriptions.json');
    await withFileLock(file, () => {
      const data = readJSON(file) || { subscriptions: [], cancellation_history: [], monthly_budget: null };
      const id = `data-${entry.serviceID}-${entry.billersCode}`;
      const renew = new Date(new Date(entry.createdAt).getTime() + (days || 30) * 86400000).toISOString().slice(0, 10);
      const sub = {
        id, name: `${entry.providerName} data · ${entry.billersCode.slice(-4)}`, provider: entry.providerName,
        monthly_cost: Math.round(entry.amountNGN * 30 / (days || 30)), currency: 'NGN', category: 'data',
        next_renewal: renew, status: 'active', source: 'bills', plan: entry.planName,
      };
      data.subscriptions = [...data.subscriptions.filter(s => s.id !== id), sub];
      writeJSON(file, data);
    });
  }

  router.get('/bills/catalog', async (req, res) => {
    let price = null;
    try { price = await ngnPerGD(); } catch (_) {}
    res.json({
      ngnPerGD: price,
      catalog: CATALOG,
      treasury, marginBps,
      sandbox: !vtpass.live, enabled: vtpass.configured && Boolean(treasury || skipChain),
      jarsContract: env.JARS_CONTRACT_ADDRESS || null,
      jarMode: jarMode(),
    });
  });

  router.get('/bills/variations', async (req, res) => {
    const svc = findService(req.query.serviceID);
    if (!svc || !svc.variations) return res.status(400).json({ error: 'Unknown plan list' });
    try { res.json({ variations: await vtpass.variations(svc.provider.serviceID) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  router.post('/bills/verify', requireSession, requireUser, async (req, res) => {
    const { serviceID, billersCode, type } = req.body;
    const svc = findService(serviceID);
    if (!svc || !svc.verify) return res.status(400).json({ error: 'Nothing to verify for this bill' });
    if (!/^\d{6,14}$/.test(String(billersCode || ''))) return res.status(400).json({ error: 'Enter the full meter or smartcard number' });
    try { res.json(await vtpass.verify(serviceID, String(billersCode), type)); }
    catch (e) { res.status(422).json({ error: e.message }); }
  });

  // Quote: work out the naira amount server-side (never trust a client price
  // for plans), convert to G$ and hold it for 10 minutes.
  async function makeQuote({ userId, serviceID, billersCode, phone, variation_code, amountNGN, meterType }) {
    const svc = findService(serviceID);
    if (!svc) throw Object.assign(new Error('Unknown bill'), { status: 400 });
    const target = String(billersCode || phone || '').replace(/\s+/g, '');
    if (svc.input === 'phone' && !/^0[789][01]\d{8}$/.test(target)) throw Object.assign(new Error('Enter an 11-digit Nigerian phone number'), { status: 400 });
    if (svc.input !== 'phone' && !/^\d{6,14}$/.test(target)) throw Object.assign(new Error('Enter the full meter or smartcard number'), { status: 400 });

    let amount = Number(amountNGN), planName = svc.label;
    if (svc.variations) {
      const plans = await vtpass.variations(serviceID);
      const plan  = plans.find(p => p.code === variation_code);
      if (!plan) throw Object.assign(new Error('Pick a plan'), { status: 400 });
      amount = plan.amount; planName = plan.name;
    } else if (svc.category === 'electricity') {
      if (!svc.meterTypes.includes(meterType)) throw Object.assign(new Error('Pick prepaid or postpaid'), { status: 400 });
      planName = `${svc.provider.name} ${meterType}`;
    }
    if (!Number.isFinite(amount) || amount < 50 || amount > 100000) throw Object.assign(new Error('Amount must be between ₦50 and ₦100,000'), { status: 400 });

    const price = await ngnPerGD();
    const amountGD = gdForNaira(amount, price, marginBps);
    const quote = {
      id: crypto.randomBytes(12).toString('hex'), userId, serviceID, category: svc.category,
      providerName: svc.provider.name, billersCode: target, phone: svc.input === 'phone' ? target : String(phone || ''),
      variation_code: svc.variations ? variation_code : (svc.category === 'electricity' ? meterType : undefined),
      planName, amountNGN: amount, ngnPerGD: price, marginBps, amountGD,
      amountWei: ethers.parseUnits(String(amountGD), 18).toString(),
      expiresAt: new Date(now().getTime() + QUOTE_TTL_MS).toISOString(),
    };
    quotes.set(quote.id, quote);
    return quote;
  }

  router.post('/bills/quote', requireSession, requireUser, async (req, res) => {
    try {
      const q = await makeQuote(req.body);
      res.json({ quoteId: q.id, amountNGN: q.amountNGN, amountGD: q.amountGD, amountWei: q.amountWei, planName: q.planName, feeBps: q.marginBps, treasury, expiresAt: q.expiresAt });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  async function deliver(quote, payment) {
    const request_id = vtpassRequestId(now());
    const order = { request_id, serviceID: quote.serviceID, amount: quote.amountNGN, phone: quote.phone || quote.billersCode };
    if (quote.category !== 'airtime') order.billersCode = quote.billersCode;
    if (quote.variation_code) order.variation_code = quote.variation_code;
    if (quote.category === 'tv') order.subscription_type = 'change';
    if (quote.category === 'electricity' && !/^0[789][01]\d{8}$/.test(order.phone)) order.phone = env.BILLS_FALLBACK_PHONE || '08011111111';

    let result;
    try { result = await vtpass.pay(order); }
    catch (e) { result = { ok: false, status: 'failed', message: e.message }; }

    const entry = {
      id: quote.id, request_id, createdAt: now().toISOString(),
      category: quote.category, serviceID: quote.serviceID, providerName: quote.providerName,
      billersCode: quote.billersCode, planName: quote.planName, amountNGN: quote.amountNGN, amountGD: quote.amountGD,
      source: payment.source, jarId: payment.jarId ?? null, txHash: payment.txHash || null, from: payment.from || null,
      status: result.ok ? (result.pending ? 'pending' : 'delivered') : 'refund_due',
      token: result.token, vtpassTxId: result.vtpassTxId || null, message: result.message || null,
    };
    await recordBill(quote.userId, entry);
    if (quote.category === 'data' && result.ok) await upsertDataSub(quote.userId, entry).catch(() => {});
    return entry;
  }

  function markTxUsed(txHash) {
    const used = readJSON(usedTxFile) || {};
    if (used[txHash]) return false;
    used[txHash] = Date.now();
    writeJSON(usedTxFile, used);
    return true;
  }

  router.post('/bills/pay', requireSession, requireUser, asyncRoute(async (req, res) => {
    const { userId, quoteId, txHash, jarId } = req.body;
    const quote = quotes.get(quoteId);
    if (!quote || quote.userId !== userId) return res.status(404).json({ error: 'Quote expired — get a new price' });
    const late = now() > new Date(quote.expiresAt);

    let payment;
    if (jarId !== undefined && jarId !== null) {
      if (late) return res.status(410).json({ error: 'Quote expired — get a new price' });
      if (!getJarsContract()) return res.status(503).json({ error: 'Bill jars are not live yet' });
      const owner = linkedWallet(userId);
      if (!owner) return res.status(403).json({ error: 'Link your wallet before paying from a jar' });
      quotes.delete(quoteId);
      try {
        const tx = await getJarsContract().payBill(owner, BigInt(jarId), BigInt(quote.amountWei), quote.id);
        await tx.wait();
        payment = { source: 'jar', jarId: Number(jarId), txHash: tx.hash, from: owner };
      } catch (e) {
        return res.status(402).json({ error: /cap|Insufficient/i.test(e.message) ? 'Not enough G$ in that jar (or over its limit)' : 'Jar payment failed' });
      }
    } else if (skipChain) {
      quotes.delete(quoteId);
      payment = { source: 'sandbox' };
    } else {
      if (!treasury) return res.status(503).json({ error: 'Bill payments are not configured' });
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) return res.status(400).json({ error: 'txHash required' });
      const payer = linkedWallet(userId);
      if (!payer) return res.status(403).json({ error: 'Link your wallet before paying' });
      // A tx sent before expiry still counts if it lands a little late; the price was locked when they signed.
      if (late && now() - new Date(quote.expiresAt) > QUOTE_TTL_MS) return res.status(410).json({ error: 'Quote expired — contact support with your tx hash' });
      let check;
      try { check = await verifyGdTransfer(provider, txHash, treasury, BigInt(quote.amountWei), payer); }
      catch (e) { return res.status(502).json({ error: 'Could not read the transaction — try again' }); }
      if (!check.ok) return res.status(402).json({ error: check.reason });
      if (!markTxUsed(txHash.toLowerCase())) return res.status(409).json({ error: 'That payment was already used' });
      quotes.delete(quoteId);
      payment = { source: 'wallet', txHash, from: check.from };
    }

    const entry = await deliver(quote, payment);
    const status = entry.status === 'refund_due' ? 502 : 200;
    res.status(status).json({
      ...entry,
      error: entry.status === 'refund_due' ? 'The provider could not deliver this bill. Your G$ is safe — it has been flagged for a refund.' : undefined,
    });
  }));

  router.get('/bills/history', requireSession, requireUser, (req, res) => {
    const data = readJSON(billsFile(req.query.userId)) || { payments: [] };
    res.json({ payments: data.payments.slice(0, 50) });
  });

  // ── Wallet link (needed for jars) ─────────────────────────────────────────
  const linkNonces = new Map();
  router.post('/wallet/link-nonce', requireSession, requireUser, (req, res) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    linkNonces.set(req.body.userId, { nonce, expiresAt: Date.now() + 5 * 60 * 1000 });
    res.json({ message: `Link this wallet to SubBot bill jars\n\nNonce: ${nonce}` });
  });
  router.post('/wallet/link', requireSession, requireUser, asyncRoute(async (req, res) => {
    const { userId, address, signature } = req.body;
    const entry = linkNonces.get(userId);
    linkNonces.delete(userId);
    if (!entry || Date.now() > entry.expiresAt) return res.status(401).json({ error: 'Link request expired — try again' });
    let recovered;
    try { recovered = ethers.verifyMessage(`Link this wallet to SubBot bill jars\n\nNonce: ${entry.nonce}`, signature); }
    catch (e) { return res.status(401).json({ error: 'Invalid signature' }); }
    if (recovered.toLowerCase() !== String(address || '').toLowerCase()) return res.status(401).json({ error: 'Signature does not match wallet' });
    const file = metaFile(userId);
    await withFileLock(file, () => writeJSON(file, { ...(readJSON(file) || { userId }), wallet: recovered }));
    res.json({ ok: true, wallet: recovered });
  }));

  // ── Jars (metadata off-chain, balances on-chain) ──────────────────────────
  router.post('/credits/register', requireSession, requireUser, asyncRoute(async (req, res) => {
    const contract = getCreditsContract();
    if (!contract) return res.status(503).json({ error: 'Credits are not configured' });
    try {
      if (await contract.securityVersion() < 2n) throw new Error('Old contract');
    } catch (_) {
      return res.status(503).json({ error: 'Credits contract upgrade required' });
    }
    const wallet = linkedWallet(req.userId);
    if (!wallet) return res.status(403).json({ error: 'Verify your wallet before depositing credits' });
    const key = ethers.keccak256(ethers.toUtf8Bytes(req.userId));
    const bound = await contract.depositors(key);
    if (bound !== ethers.ZeroAddress && bound.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(409).json({ error: 'Credits are bound to a different wallet' });
    }
    if (bound === ethers.ZeroAddress) {
      const tx = await contract.bindDepositor(req.userId, wallet);
      await tx.wait();
    }
    res.json({ creditsAddress: await contract.getAddress(), wallet });
  }));

  function cleanJar(j, id) {
    const svc = findService(j.serviceID);
    if (!svc) throw Object.assign(new Error('Pick which bill this jar pays'), { status: 400 });
    const label = String(j.label || '').trim().slice(0, 40) || `${svc.provider.name} ${svc.label}`;
    const dueDay = j.autoTopUp ? null : Number(j.dueDay);
    if (!j.autoTopUp && !(dueDay >= 1 && dueDay <= 28)) throw Object.assign(new Error('Pick a due day between 1 and 28'), { status: 400 });
    const splitPct = Math.max(0, Math.min(100, Math.round(Number(j.splitPct) || 0)));
    return {
      id, label, serviceID: svc.provider.serviceID, category: svc.category,
      billersCode: String(j.billersCode || '').replace(/\s+/g, ''), variation_code: j.variation_code || null,
      meterType: j.meterType || null, amountNGN: Number(j.amountNGN) || null, dueDay, splitPct,
      autoTopUp: Boolean(j.autoTopUp && svc.category === 'data'), lastPaid: j.lastPaid || null,
      autopay: Boolean(j.autopay),
    };
  }

  async function onchainBalances(owner, ids) {
    if (!getJarsContract() || !owner || !ids.length) return {};
    const out = {};
    await Promise.all(ids.map(async id => {
      try {
        const j = await getJarsContract().jarOf(owner, BigInt(id));
        out[id] = { balanceGD: Number(ethers.formatUnits(j.balance, 18)), capGD: Number(ethers.formatUnits(j.capPerPeriod, 18)) };
      } catch (_) {}
    }));
    return out;
  }

  // Days until a jar is next due (Lagos time); data top-up jars sort last.
  function daysUntilDue(jar) {
    if (!jar.dueDay) return Infinity;
    const lagos = new Date(now().getTime() + 3600000);
    const today = lagos.getUTCDate();
    const paidThisCycle = (jar.lastPaid || '').startsWith(lagos.toISOString().slice(0, 7));
    if (jar.dueDay > today || (jar.dueDay === today && !paidThisCycle)) return jar.dueDay - today;
    const daysInMonth = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth() + 1, 0)).getUTCDate();
    return daysInMonth - today + jar.dueDay;
  }

  // Allowance mode: the wallet balance is earmarked across jars, soonest bill first.
  async function earmarks(owner, jars) {
    const price = await ngnPerGD().catch(() => null);
    let walletGD = 0, allowanceGD = 0;
    if (owner && getAutopay()) {
      try {
        const [b, a] = await Promise.all([getAutopay().balanceOf(owner), getAutopay().allowance(owner)]);
        walletGD = Number(ethers.formatUnits(b, 18));
        allowanceGD = Number(ethers.formatUnits(a, 18));
      } catch (_) {}
    }
    let left = walletGD;
    const out = {};
    for (const j of [...jars].sort((a, b) => daysUntilDue(a) - daysUntilDue(b))) {
      const targetGD = price && j.amountNGN ? gdForNaira(j.amountNGN, price, marginBps) : null;
      const balanceGD = targetGD ? Math.min(left, targetGD) : 0;
      left -= balanceGD;
      out[j.id] = { balanceGD, targetGD, dueInDays: Number.isFinite(daysUntilDue(j)) ? daysUntilDue(j) : null, shortGD: targetGD ? Math.max(0, targetGD - balanceGD) : 0 };
    }
    return { walletGD, allowanceGD, jars: out };
  }

  router.get('/jars', requireSession, requireUser, async (req, res) => {
    const uid  = req.query.userId;
    const jars = readJSON(jarsFile(uid))?.jars || [];
    const wallet = linkedWallet(uid);
    if (jarMode() === 'contract') {
      const bal = await onchainBalances(wallet, jars.map(j => j.id));
      return res.json({ mode: 'contract', wallet, contract: env.JARS_CONTRACT_ADDRESS, jars: jars.map(j => ({ ...j, ...(bal[j.id] || { balanceGD: 0 }) })) });
    }
    const e = await earmarks(wallet, jars);
    res.json({
      mode: 'allowance', wallet, contract: null, spender: getAutopay()?.spender || null,
      walletGD: e.walletGD, allowanceGD: e.allowanceGD,
      jars: jars.map(j => ({ ...j, ...(e.jars[j.id] || { balanceGD: 0 }) })),
    });
  });

  router.post('/jars', requireSession, requireUser, async (req, res) => {
    const { userId, jar } = req.body;
    const file = jarsFile(userId);
    try {
      const saved = await withFileLock(file, () => {
        const data = readJSON(file) || { nextId: 1, jars: [] };
        const id = jar?.id ?? data.nextId++;
        const clean = cleanJar(jar || {}, id);
        data.jars = [...data.jars.filter(j => j.id !== id), clean].sort((a, b) => a.id - b.id);
        const total = data.jars.reduce((s, j) => s + j.splitPct, 0);
        if (total > 100) throw Object.assign(new Error('Daily-claim splits add up to more than 100%'), { status: 400 });
        writeJSON(file, data);
        return clean;
      });
      res.json({ ok: true, jar: saved });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  router.post('/jars/delete', requireSession, requireUser, asyncRoute(async (req, res) => {
    const { userId, jarId } = req.body;
    const file = jarsFile(userId);
    await withFileLock(file, () => {
      const data = readJSON(file) || { nextId: 1, jars: [] };
      data.jars = data.jars.filter(j => j.id !== Number(jarId));
      writeJSON(file, data);
    });
    res.json({ ok: true });
  }));

  // ── Data: readings, forecast, advice ──────────────────────────────────────
  router.post('/data/reading', requireSession, requireUser, asyncRoute(async (req, res) => {
    const { userId } = req.body;
    const mb = Number(req.body.mb);
    if (!Number.isFinite(mb) || mb < 0 || mb > 10 * 1024 * 1024) return res.status(400).json({ error: 'Enter your balance in MB or GB' });
    const file = billsFile(userId);
    await withFileLock(file, () => {
      const data = readJSON(file) || { payments: [], dataPurchases: [], dataReadings: [] };
      data.dataReadings = [{ mb, at: now().toISOString() }, ...(data.dataReadings || [])].slice(0, 60);
      writeJSON(file, data);
    });
    res.json({ ok: true });
  }));

  router.get('/data/insights', requireSession, requireUser, async (req, res) => {
    const data = readJSON(billsFile(req.query.userId)) || { dataPurchases: [], dataReadings: [] };
    const purchases = data.dataPurchases || [];
    const forecast = forecastData(purchases, data.dataReadings || []);
    let advice = null;
    const lastSvc = purchases[0]?.serviceID;
    if (lastSvc) {
      try { advice = adviseDataPlan(purchases.filter(p => p.serviceID === lastSvc), await vtpass.variations(lastSvc)); }
      catch (_) {}
    }
    res.json({ forecast, advice, serviceID: lastSvc || null, purchases: purchases.slice(0, 10) });
  });

  // ── Due jars (cron) ───────────────────────────────────────────────────────
  // Pays bill jars on their due day (Lagos time) and data jars when the
  // forecast says less than a day is left. Idempotent per cycle.
  router.post('/jars/run-due', requireInternalToken, async (req, res) => {
    const mode = jarMode();
    if (mode === 'allowance' && (!getAutopay() || !treasury)) return res.json({ ok: true, results: [], note: 'autopay not configured' });
    const results = [];
    const root = path.dirname(userDir('probe'));
    const lagos = new Date(now().getTime() + 3600000);
    const day = lagos.getUTCDate(), cycle = lagos.toISOString().slice(0, 7);
    for (const directory of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
      const uid = readJSON(path.join(root, directory.name, 'web3auth-meta.json'))?.userId;
      if (!uid || uid === 'local') continue;
      const file = jarsFile(uid);
      const data = readJSON(file);
      if (!data?.jars?.length) continue;
      const owner = linkedWallet(uid);
      if (!owner) continue;
      for (const jar of data.jars) {
        if (mode === 'allowance' && !jar.autopay) continue;
        let due = false;
        if (jar.autoTopUp) {
          const b = readJSON(billsFile(uid)) || {};
          const f = forecastData((b.dataPurchases || []).filter(p => p.serviceID === jar.serviceID), b.dataReadings || []);
          due = f && f.daysLeft < 1 && (!jar.lastPaid || now() - new Date(jar.lastPaid) > 86400000);
        } else {
          due = jar.dueDay === day && !(jar.lastPaid || '').startsWith(cycle);
        }
        if (!due) continue;
        try {
          const q = await makeQuote({ userId: uid, serviceID: jar.serviceID, billersCode: jar.billersCode, phone: jar.billersCode, variation_code: jar.variation_code, amountNGN: jar.amountNGN, meterType: jar.meterType });
          quotes.delete(q.id);
          let payment;
          if (mode === 'contract') {
            const tx = await getJarsContract().payBill(owner, BigInt(jar.id), BigInt(q.amountWei), q.id);
            await tx.wait();
            payment = { source: 'jar', jarId: jar.id, txHash: tx.hash, from: owner };
          } else {
            // Never pull more than the jar was set up for (plus headroom for price moves).
            if (!jar.amountNGN || q.amountNGN > jar.amountNGN * AUTOPAY_HEADROOM) throw new Error('price above this jar\'s limit');
            const amountWei = BigInt(q.amountWei);
            const [bal, allowance] = await Promise.all([getAutopay().balanceOf(owner), getAutopay().allowance(owner)]);
            if (bal < amountWei) throw new Error('not enough G$ in wallet');
            if (allowance < amountWei) throw new Error('autopay approval used up');
            const tx = await getAutopay().pull(owner, treasury, amountWei);
            await tx.wait();
            markTxUsed(tx.hash.toLowerCase());
            payment = { source: 'autopay', jarId: jar.id, txHash: tx.hash, from: owner };
          }
          const entry = await deliver(q, payment);
          await withFileLock(file, () => {
            const fresh = readJSON(file) || data;
            fresh.jars = fresh.jars.map(j => j.id === jar.id ? { ...j, lastPaid: now().toISOString() } : j);
            writeJSON(file, fresh);
          });
          results.push({ uid, jarId: jar.id, status: entry.status });
        } catch (e) {
          results.push({ uid, jarId: jar.id, status: 'skipped', reason: e.message });
        }
      }
    }
    res.json({ ok: true, results });
  });

  router.use(storageErrorHandler);
  return router;
}

module.exports = {
  CATALOG, findService, createVtpassClient, vtpassRequestId, createPriceFeed, gdForNaira,
  verifyGdTransfer, parsePlan, adviseDataPlan, forecastData, createBillsRouter, createGdAutopay, GD_TOKEN,
};
