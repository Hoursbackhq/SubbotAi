const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { request, scratch } = require('./helpers/security-harness.cjs');
const { ethers } = require('ethers');
const { createBillsRouter, GD_TOKEN } = require('../bills');
const { requireSession, requireInternalToken, issueSessionToken } = require('../session-auth');
const { withFileLock } = require('../file-lock');
const { userPath } = require('../user-path');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const uid = 'w3a:google:payments';
const token = issueSessionToken(uid);
const payer = '0x0000000000000000000000000000000000000001';
const treasury = '0x0000000000000000000000000000000000000002';

function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, 'bills-'));
  const userDir = id => { const p = userPath(root, id); fs.mkdirSync(p, { recursive: true }); return p; };
  const readJSON = p => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : null;
  const writeJSON = (p, data) => fs.writeFileSync(p, JSON.stringify(data));
  const paid = [], bindings = [];
  let bound = ethers.ZeroAddress;
  const credits = {
    securityVersion: async () => 2n,
    depositors: async () => bound,
    bindDepositor: async (id, wallet) => { bindings.push([id, wallet]); bound = wallet; return { wait: async () => {} }; },
    getAddress: async () => treasury,
  };
  const router = createBillsRouter({
    userDir, readJSON, writeJSON, withFileLock, requireSession, requireInternalToken,
    getCreditsContract: () => credits,
    provider: { getTransactionReceipt: async () => ({ status: 1, logs: [{
      address: GD_TOKEN,
      topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(payer, 32), ethers.zeroPadValue(treasury, 32)],
      data: ethers.toBeHex(ethers.parseEther('4120')),
    }] }) },
    vtpass: { live: true, configured: true, pay: async order => { paid.push(order); return { ok: true }; } },
    ngnPerGD: async () => 0.25,
    env: { BILLS_TREASURY_ADDRESS: treasury }, usedTxFile: path.join(root, 'used.json'),
  });
  const call = (route, body = {}, auth = token) => request('post', route, { body: { userId: uid, ...body }, token: auth, router });
  const link = () => writeJSON(path.join(userDir(uid), 'web3auth-meta.json'), { userId: uid, wallet: payer });
  return { call, link, paid, bindings, credits };
}

test('credit registration requires both a session and a previously verified wallet', async () => {
  const f = fixture();
  assert.equal((await f.call('/credits/register', {}, null)).statusCode, 401);
  assert.equal((await f.call('/credits/register')).statusCode, 403);
  f.link();
  const response = await f.call('/credits/register', { wallet: treasury });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(f.bindings, [[uid, payer]], 'request wallet must not override the signed wallet link');
  assert.equal(response.body.creditsAddress, treasury);
  await f.call('/credits/register');
  assert.equal(f.bindings.length, 1, 'existing binding must not spend gas again');
});

test('credit registration rejects old deployments and another bound wallet', async () => {
  const f = fixture(); f.link();
  f.credits.securityVersion = async () => 1n;
  assert.equal((await f.call('/credits/register')).statusCode, 503);
  f.credits.securityVersion = async () => { throw new Error('method not deployed'); };
  assert.equal((await f.call('/credits/register')).statusCode, 503);
  f.credits.securityVersion = async () => 2n;
  f.credits.depositors = async () => treasury;
  assert.equal((await f.call('/credits/register')).statusCode, 409);
  assert.equal(f.bindings.length, 0);
});

test('bill payments require a linked payer and reject replay of the same transfer', async () => {
  const f = fixture();
  const quote = () => f.call('/bills/quote', { serviceID: 'mtn', billersCode: '08012345678', amountNGN: 1000 });
  const first = await quote();
  assert.equal(first.statusCode, 200);
  const txHash = '0x' + 'a'.repeat(64);
  assert.equal((await f.call('/bills/pay', { quoteId: first.body.quoteId, txHash })).statusCode, 403);
  f.link();
  const paid = await f.call('/bills/pay', { quoteId: first.body.quoteId, txHash });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.body.status, 'delivered');
  const second = await quote();
  assert.equal((await f.call('/bills/pay', { quoteId: second.body.quoteId, txHash })).statusCode, 409);
  assert.equal(f.paid.length, 1);
});
