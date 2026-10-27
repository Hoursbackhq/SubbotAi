const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test-secret-do-not-use-in-prod';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';

const { issueSessionToken, verifySessionToken, requireSession, requireInternalToken } = require('../session-auth');

function mockReq({ body = {}, query = {}, params = {}, headers = {} } = {}) {
  return { body, query, params, headers };
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

test('issueSessionToken / verifySessionToken round-trip', () => {
  const token = issueSessionToken('w3a:google:12345');
  const userId = verifySessionToken(token);
  assert.equal(userId, 'w3a:google:12345');
});

test('verifySessionToken rejects a tampered token', () => {
  const token = issueSessionToken('w3a:google:12345');
  const [payload] = token.split('.');
  const tampered = `${payload}.${Date.now() + 999999}.not-a-real-signature`;
  assert.equal(verifySessionToken(tampered), null);
});

test('verifySessionToken rejects an expired token', () => {
  // Issue a token that already expired by signing with a manually-backdated expiry
  const crypto = require('crypto');
  const expiry = Date.now() - 1000;
  const payload = `${Buffer.from('w3a:google:12345').toString('base64url')}.${expiry}`;
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  assert.equal(verifySessionToken(`${payload}.${sig}`), null);
});

test('verifySessionToken rejects garbage input', () => {
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken('not.enough.parts.here'), null);
});

test('requireSession rejects the anonymous local userId with no token', () => {
  const req = mockReq({ body: { userId: 'local' } });
  const res = mockRes();
  let nextCalled = false;
  requireSession(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireSession rejects a request with no token for a real userId', () => {
  const req = mockReq({ body: { userId: 'w3a:google:12345' } });
  const res = mockRes();
  let nextCalled = false;
  requireSession(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireSession rejects a valid token used for a different userId — the actual IDOR', () => {
  const token = issueSessionToken('w3a:google:attacker');
  const req = mockReq({
    body: { userId: 'w3a:google:victim' },
    headers: { authorization: `Bearer ${token}` },
  });
  const res = mockRes();
  let nextCalled = false;
  requireSession(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireSession allows a token that matches the requested userId', () => {
  const token = issueSessionToken('w3a:google:12345');
  const req = mockReq({
    body: { userId: 'w3a:google:12345' },
    headers: { authorization: `Bearer ${token}` },
  });
  const res = mockRes();
  let nextCalled = false;
  requireSession(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireInternalToken rejects requests with no token', () => {
  const req = mockReq();
  const res = mockRes();
  let nextCalled = false;
  requireInternalToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireInternalToken accepts the configured shared secret', () => {
  const req = mockReq({ headers: { 'x-internal-token': process.env.INTERNAL_SERVICE_TOKEN } });
  const res = mockRes();
  let nextCalled = false;
  requireInternalToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireInternalToken rejects a wrong token', () => {
  const req = mockReq({ headers: { 'x-internal-token': 'wrong-token' } });
  const res = mockRes();
  let nextCalled = false;
  requireInternalToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});
