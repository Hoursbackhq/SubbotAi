const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { ethers } = require('ethers');

process.env.SESSION_SECRET = 'test-secret-do-not-use-in-prod';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';

const { issueSessionToken, requireSession, requireInternalToken } = require('../session-auth');
const {
  parsePlan, gdForNaira, adviseDataPlan, forecastData, vtpassRequestId,
  verifyGdTransfer, createBillsRouter, GD_TOKEN,
} = require('../bills');

const TREASURY = '0x000000000000000000000000000000000000beef';
const USER = 'w3a:google:12345';
const DAY = 86400000;

test('parsePlan reads size and validity from VTpass plan names', () => {
  assert.deepEqual(parsePlan('MTN N1000 1.5GB - 30 days'), { gb: 1.5, days: 30 });
  assert.deepEqual(parsePlan('Airtel Data - 100 Naira - 75MB - 1Day'), { gb: 75 / 1024, days: 1 });
  assert.deepEqual(parsePlan('Glo 10GB Monthly'), { gb: 10, days: 30 });
  assert.deepEqual(parsePlan('MTN 2GB Weekly Plan'), { gb: 2, days: 7 });
  assert.deepEqual(parsePlan('GOtv Max'), { gb: null, days: null });
});

test('gdForNaira adds the margin and rounds up to a whole G$', () => {
  assert.equal(gdForNaira(1000, 0.25, 300), 4120); // 4000 G$ + 3%
  assert.equal(gdForNaira(100, 0.3, 0), 334);
});

test('vtpassRequestId starts with Lagos-time YYYYMMDDHHmm', () => {
  const id = vtpassRequestId(new Date('2026-10-26T23:30:00Z')); // 00:30 next day in Lagos
  assert.match(id, /^202610270030[0-9a-f]{12}$/);
});

test('adviseDataPlan finds a cheaper plan for the same usage', () => {
  const now = Date.now();
  const purchases = [0, 7, 14, 21].map(d => ({ gb: 1.5, amountNGN: 1000, at: new Date(now - d * DAY).toISOString() }));
  const plans = [
    { code: 'w', name: 'MTN N1000 1.5GB - 7 days', amount: 1000 },
    { code: 'm', name: 'MTN N3500 10GB - 30 days', amount: 3500 },
  ];
  const a = adviseDataPlan(purchases, plans);
  assert.equal(a.needGB, 6);
  assert.equal(a.spentNGN, 4000);
  assert.equal(a.best.code, 'm');
  assert.equal(a.saving, 500);
});

test('adviseDataPlan reports no saving when the user already buys the best plan', () => {
  const purchases = [{ gb: 10, amountNGN: 3500, at: new Date().toISOString() }];
  const a = adviseDataPlan(purchases, [{ code: 'm', name: '10GB - 30 days', amount: 3500 }]);
  assert.equal(a.saving, 0);
});

test('forecastData uses the last two readings when there was no top-up between them', () => {
  const now = Date.now();
  const f = forecastData([], [
    { mb: 2000, at: new Date(now - 2 * DAY).toISOString() },
    { mb: 1000, at: new Date(now).toISOString() },
  ]);
  assert.equal(f.mbPerDay, 500);
  assert.equal(f.daysLeft, 2);
  assert.equal(f.source, 'reading');
});

test('forecastData falls back to purchases when there are no readings', () => {
  const now = Date.now();
  const f = forecastData([{ gb: 7, amountNGN: 2000, at: new Date(now - 1 * DAY).toISOString() }], []);
  assert.equal(f.mbPerDay, 1024);        // 7GB over the 7-day minimum span
  assert.equal(f.source, 'estimate');
  assert.ok(f.daysLeft > 5.9 && f.daysLeft < 6.1);
});

function transferLog(from, to, value) {
  return {
    address: GD_TOKEN,
    topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
    data: ethers.toBeHex(value, 32),
  };
}

test('verifyGdTransfer accepts a big-enough G$ transfer to the treasury only', async () => {
  const from = '0x00000000000000000000000000000000000a11ce';
  const provider = { getTransactionReceipt: async () => ({ status: 1, logs: [transferLog(from, TREASURY, 100n)] }) };
  assert.equal((await verifyGdTransfer(provider, '0x1', TREASURY, 100n)).ok, true);
  assert.equal((await verifyGdTransfer(provider, '0x1', TREASURY, 101n)).ok, false);
  assert.equal((await verifyGdTransfer(provider, '0x1', '0x000000000000000000000000000000000000dead', 1n)).ok, false);
  const failed = { getTransactionReceipt: async () => ({ status: 0, logs: [] }) };
  assert.equal((await verifyGdTransfer(failed, '0x1', TREASURY, 1n)).ok, false);
  // someone else's payment can't be claimed
  assert.equal((await verifyGdTransfer(provider, '0x1', TREASURY, 100n, from)).ok, true);
  assert.equal((await verifyGdTransfer(provider, '0x1', TREASURY, 100n, '0x000000000000000000000000000000000000b0b0')).ok, false);
});

// ── Router, with fake VTpass + chain ─────────────────────────────────────────
const PAYER = '0x00000000000000000000000000000000000a11ce';

function harness({ receiptValue = 0n, vtpassOk = true, linked = PAYER, autopay = null, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bills-'));
  const userDir = uid => { const d = path.join(dir, uid.replace(/[^a-zA-Z0-9:_.\-]/g, '_')); fs.mkdirSync(d, { recursive: true }); return d; };
  const readJSON = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d));
  const paid = [];
  const vtpass = {
    live: false, configured: true,
    variations: async () => [{ code: 'mtn-1gb', name: 'MTN N1000 1.5GB - 30 days', amount: 1000 }],
    verify: async () => ({ name: 'ADA OBI' }),
    pay: async order => { paid.push(order); return vtpassOk ? { ok: true, status: 'delivered', token: null } : { ok: false, status: 'failed', message: 'down' }; },
  };
  const provider = { getTransactionReceipt: async () => ({ status: 1, logs: [transferLog('0x00000000000000000000000000000000000a11ce', TREASURY, receiptValue)] }) };
  const app = express();
  app.use(express.json());
  app.use(createBillsRouter({
    userDir, readJSON, writeJSON, withFileLock: (_f, fn) => fn(), requireSession, requireInternalToken,
    provider, vtpass, ngnPerGD: async () => 0.25, usedTxFile: path.join(dir, 'used.json'),
    env: { BILLS_TREASURY_ADDRESS: TREASURY, BILLS_MARGIN_BPS: '300' },
    getAutopay: () => autopay, ...(now ? { now } : {}),
  }));
  if (linked) writeJSON(path.join(userDir(USER), 'web3auth-meta.json'), { userId: USER, wallet: linked });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${issueSessionToken(USER)}` };
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify({ userId: USER, ...body }) });
  const get = p => fetch(base + p, { headers: auth });
  const runDue = () => fetch(base + '/jars/run-due', { method: 'POST', headers: { 'x-internal-token': 'test-internal-token' } });
  return { server, base, post, get, runDue, paid, dir, readJSON, userDir };
}

test('quote prices the plan server-side and pay checks the on-chain transfer', async (t) => {
  const h = harness({ receiptValue: ethers.parseUnits('4120', 18) });
  t.after(() => h.server.close());
  const q = await (await h.post('/bills/quote', { serviceID: 'mtn-data', phone: '08031234567', variation_code: 'mtn-1gb', amountNGN: 1 })).json();
  assert.equal(q.amountNGN, 1000); // client amount ignored for plans
  assert.equal(q.amountGD, 4120);

  const tx = '0x' + 'ab'.repeat(32);
  const r = await h.post('/bills/pay', { quoteId: q.quoteId, txHash: tx });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.status, 'delivered');
  assert.equal(h.paid[0].serviceID, 'mtn-data');
  assert.equal(h.paid[0].variation_code, 'mtn-1gb');

  // the bundle shows up as a subscription and as a data purchase
  const subs = h.readJSON(path.join(h.userDir(USER), 'scanned-subscriptions.json'));
  assert.equal(subs.subscriptions[0].category, 'data');
  const bills = h.readJSON(path.join(h.userDir(USER), 'bills.json'));
  assert.equal(bills.dataPurchases[0].gb, 1.5);
});

test('pay rejects an underpaid transfer', async (t) => {
  const h = harness({ receiptValue: ethers.parseUnits('100', 18) });
  t.after(() => h.server.close());
  const q = await (await h.post('/bills/quote', { serviceID: 'mtn', phone: '08031234567', amountNGN: 1000 })).json();
  const r = await h.post('/bills/pay', { quoteId: q.quoteId, txHash: '0x' + 'cd'.repeat(32) });
  assert.equal(r.status, 402);
  assert.equal(h.paid.length, 0);
});

test('pay rejects a transfer from a wallet the user has not linked', async (t) => {
  const h = harness({ receiptValue: ethers.parseUnits('100000', 18), linked: '0x000000000000000000000000000000000000b0b0' });
  t.after(() => h.server.close());
  const q = await (await h.post('/bills/quote', { serviceID: 'mtn', phone: '08031234567', amountNGN: 500 })).json();
  const r = await h.post('/bills/pay', { quoteId: q.quoteId, txHash: '0x' + '34'.repeat(32) });
  assert.equal(r.status, 402);
  assert.equal(h.paid.length, 0);
});

test('a tx hash can only pay one bill', async (t) => {
  const h = harness({ receiptValue: ethers.parseUnits('100000', 18) });
  t.after(() => h.server.close());
  const tx = '0x' + 'ef'.repeat(32);
  const q1 = await (await h.post('/bills/quote', { serviceID: 'mtn', phone: '08031234567', amountNGN: 500 })).json();
  assert.equal((await h.post('/bills/pay', { quoteId: q1.quoteId, txHash: tx })).status, 200);
  const q2 = await (await h.post('/bills/quote', { serviceID: 'mtn', phone: '08031234567', amountNGN: 500 })).json();
  assert.equal((await h.post('/bills/pay', { quoteId: q2.quoteId, txHash: tx })).status, 409);
});

test('a failed delivery is flagged for refund, not lost', async (t) => {
  const h = harness({ receiptValue: ethers.parseUnits('100000', 18), vtpassOk: false });
  t.after(() => h.server.close());
  const q = await (await h.post('/bills/quote', { serviceID: 'mtn', phone: '08031234567', amountNGN: 500 })).json();
  const r = await h.post('/bills/pay', { quoteId: q.quoteId, txHash: '0x' + '12'.repeat(32) });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).status, 'refund_due');
});

test('bills need a signed-in user and validate the number', async (t) => {
  const h = harness();
  t.after(() => h.server.close());
  const anon = await fetch(h.base + '/bills/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'local', serviceID: 'mtn', phone: '08031234567', amountNGN: 500 }) });
  assert.equal(anon.status, 401);
  const bad = await h.post('/bills/quote', { serviceID: 'mtn', phone: '12345', amountNGN: 500 });
  assert.equal(bad.status, 400);
  const tiny = await h.post('/bills/quote', { serviceID: 'mtn', phone: '08031234567', amountNGN: 10 });
  assert.equal(tiny.status, 400);
});

test('jars validate due day and keep daily-claim splits at or under 100%', async (t) => {
  const h = harness();
  t.after(() => h.server.close());
  const ok = await h.post('/jars', { jar: { label: 'GOtv', serviceID: 'gotv', billersCode: '7012345678', variation_code: 'gotv-max', dueDay: 14, splitPct: 60 } });
  assert.equal(ok.status, 200);
  const badDay = await h.post('/jars', { jar: { serviceID: 'gotv', dueDay: 31 } });
  assert.equal(badDay.status, 400);
  const over = await h.post('/jars', { jar: { serviceID: 'mtn-data', autoTopUp: true, splitPct: 50 } });
  assert.equal(over.status, 400);
});

test('paying from a jar requires a linked wallet', async (t) => {
  const h = harness();
  t.after(() => h.server.close());
  const q = await (await h.post('/bills/quote', { serviceID: 'mtn', phone: '08031234567', amountNGN: 500 })).json();
  const r = await h.post('/bills/pay', { quoteId: q.quoteId, jarId: 1 });
  assert.equal(r.status, 503); // no jars contract in this harness
});

test('wallet link verifies the signature', async (t) => {
  const h = harness();
  t.after(() => h.server.close());
  const w = ethers.Wallet.createRandom();
  const { message } = await (await h.post('/wallet/link-nonce', {})).json();
  const sig = await w.signMessage(message);
  const r = await h.post('/wallet/link', { address: w.address, signature: sig });
  assert.equal(r.status, 200);
  const { message: m2 } = await (await h.post('/wallet/link-nonce', {})).json();
  const other = ethers.Wallet.createRandom();
  const bad = await h.post('/wallet/link', { address: w.address, signature: await other.signMessage(m2) });
  assert.equal(bad.status, 401);
});

// ── Allowance autopay (no jars contract) ─────────────────────────────────────
function fakeAutopay({ balanceGD = 100000, allowanceGD = 100000 } = {}) {
  const pulls = [];
  let n = 0;
  return {
    pulls, spender: '0x000000000000000000000000000000000000a9e7',
    balanceOf: async () => ethers.parseUnits(String(balanceGD), 18),
    allowance: async () => ethers.parseUnits(String(allowanceGD), 18),
    pull: async (owner, to, amountWei) => {
      pulls.push({ owner, to, amountWei });
      return { hash: '0x' + (++n).toString(16).padStart(64, '0'), wait: async () => ({ status: 1 }) };
    },
  };
}
// 10:00 on the 14th in Lagos
const DUE_DAY_NOW = () => new Date('2026-10-14T09:00:00Z');

test('allowance jars earmark the wallet balance, soonest bill first', async (t) => {
  const autopay = fakeAutopay({ balanceGD: 5000 });
  const h = harness({ autopay, now: DUE_DAY_NOW });
  t.after(() => h.server.close());
  await h.post('/jars', { jar: { label: 'Later', serviceID: 'mtn', billersCode: '08031234567', amountNGN: 1000, dueDay: 20 } });
  await h.post('/jars', { jar: { label: 'Soon', serviceID: 'mtn', billersCode: '08031234567', amountNGN: 1000, dueDay: 15 } });
  const r = await (await h.get(`/jars?userId=${encodeURIComponent(USER)}`)).json();
  assert.equal(r.mode, 'allowance');
  assert.equal(r.spender, autopay.spender);
  const soon = r.jars.find(j => j.label === 'Soon'), later = r.jars.find(j => j.label === 'Later');
  assert.equal(soon.targetGD, 4120);
  assert.equal(soon.balanceGD, 4120);   // filled first
  assert.equal(soon.dueInDays, 1);
  assert.equal(later.balanceGD, 880);   // what's left
  assert.equal(later.shortGD, 3240);
});

test('autopay pulls the bill price to the treasury on the due day, once per cycle', async (t) => {
  const autopay = fakeAutopay();
  const h = harness({ autopay, now: DUE_DAY_NOW });
  t.after(() => h.server.close());
  await h.post('/jars', { jar: { label: 'On', serviceID: 'mtn', billersCode: '08031234567', amountNGN: 1000, dueDay: 14, autopay: true } });
  await h.post('/jars', { jar: { label: 'Off', serviceID: 'mtn', billersCode: '08031234567', amountNGN: 1000, dueDay: 14 } });
  const r = await (await h.runDue()).json();
  assert.equal(autopay.pulls.length, 1);        // jar without autopay is left alone
  assert.equal(autopay.pulls[0].owner, PAYER);
  assert.equal(autopay.pulls[0].to, TREASURY);
  assert.equal(autopay.pulls[0].amountWei, ethers.parseUnits('4120', 18));
  assert.equal(r.results[0].status, 'delivered');
  assert.equal(h.paid.length, 1);
  await h.runDue();
  assert.equal(autopay.pulls.length, 1);        // already paid this month
  const bills = h.readJSON(path.join(h.userDir(USER), 'bills.json'));
  assert.equal(bills.payments[0].source, 'autopay');
});

test('autopay skips when the approval or balance is too small', async (t) => {
  const autopay = fakeAutopay({ allowanceGD: 100 });
  const h = harness({ autopay, now: DUE_DAY_NOW });
  t.after(() => h.server.close());
  await h.post('/jars', { jar: { serviceID: 'mtn', billersCode: '08031234567', amountNGN: 1000, dueDay: 14, autopay: true } });
  const r = await (await h.runDue()).json();
  assert.equal(r.results[0].status, 'skipped');
  assert.match(r.results[0].reason, /approval/);
  assert.equal(autopay.pulls.length, 0);
  assert.equal(h.paid.length, 0);
});

test('autopay never pays more than the jar was set up for', async (t) => {
  const autopay = fakeAutopay();
  const h = harness({ autopay, now: DUE_DAY_NOW });
  t.after(() => h.server.close());
  // plan now costs ₦1000 but the jar was set up when it was ₦700
  await h.post('/jars', { jar: { serviceID: 'mtn-data', billersCode: '08031234567', variation_code: 'mtn-1gb', amountNGN: 700, dueDay: 14, autopay: true } });
  const r = await (await h.runDue()).json();
  assert.equal(r.results[0].status, 'skipped');
  assert.equal(autopay.pulls.length, 0);
});
