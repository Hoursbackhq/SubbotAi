const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { request, signedJWT, scratch, root, pythonCalls } = require('./helpers/security-harness.cjs');
const { issueSessionToken, verifySessionToken } = require('../session-auth');
const { runPython } = require('../run-python');
const { createTaskLimiter } = require('../task-limits');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const actor = 'w3a:google:attacker';
const token = issueSessionToken(actor);

test('verified JWT claims determine the account regardless of client identity hints', async () => {
  const response = await request('post', '/auth/verify-web3auth', {
    body: { idToken: signedJWT({}), verifier: 'google', verifierId: 'victim' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.userId, actor);
  assert.equal(verifySessionToken(response.body.sessionToken), actor);
});

test('current signed identity-claim names are supported without client hints', async () => {
  const response = await request('post', '/auth/verify-web3auth', {
    body: { idToken: signedJWT({ verifier: undefined, verifierId: undefined, groupedAuthConnectionId: 'google', userId: 'attacker' }) },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.userId, actor);
});

test('account punctuation cannot alias another user directory; verified legacy data remains readable', () => {
  const { userPath } = require('../user-path');
  const base = path.join(scratch, 'path-fixture');
  const alice = 'w3a:google:a+b@example.test';
  const bob = 'w3a:google:a_b@example.test';
  const legacy = path.join(base, 'w3a:google:a_b_example.test');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'web3auth-meta.json'), JSON.stringify({ userId: alice }));
  assert.equal(userPath(base, alice), legacy);
  assert.notEqual(userPath(base, bob), legacy);
  assert.notEqual(userPath(base, alice), userPath(base, bob));
  assert.equal(path.dirname(userPath(base, 'w3a:google:../../escape')), base);
});

test('JWT rejects expired, missing-expiry, future and tampered tokens', async () => {
  const valid = signedJWT({});
  for (const jwt of [signedJWT({ exp: 1 }), signedJWT({ exp: null }), signedJWT({ iss: 'https://wrong.example' }), signedJWT({ nbf: Date.now() }), valid.slice(0, -10) + 'invalidsig']) {
    const response = await request('post', '/auth/verify-web3auth', { body: { idToken: jwt } });
    assert.equal(response.statusCode, 401);
  }
});

test('mixed body/query/path IDs cannot bypass authentication', async () => {
  for (const options of [
    { body: { userId: 'local' }, query: { userId: actor } },
    { body: { userId: actor }, query: { userId: 'w3a:google:victim' }, token },
    { query: { userId: [actor, 'victim'] }, token },
    { query: { userId: 'local' } },
  ]) {
    const response = await request('get', '/subs', options);
    assert.ok([400, 401].includes(response.statusCode));
  }
  const response = await request('get', '/credits/:userId', { query: { userId: actor }, params: { userId: 'victim' }, token });
  assert.equal(response.statusCode, 400);
});

test('signed-in subscriptions work and anonymous writes or tasks are rejected', async () => {
  for (const route of ['/add-sub', '/audit', '/negotiate', '/import-statement']) {
    const response = await request('post', route, { body: { userId: 'local', sub: { name: 'test' }, serviceName: 'test', csvText: 'test' } });
    assert.equal(response.statusCode, 401);
  }
  const response = await request('post', '/add-sub', { body: { userId: actor, sub: { id: 'normal', name: 'Normal bill' } }, token });
  assert.equal(response.statusCode, 200);
  const subs = await request('get', '/subs', { query: { userId: actor }, token });
  assert.equal(subs.body.subscriptions[0].name, 'Normal bill');
});

test('negotiation forwards malicious service text as one Python argument', async () => {
  const serviceName = 'Demo $(printf injected) " ; printf injected #';
  await request('post', '/add-sub', { body: { userId: actor, sub: { id: 'probe', name: serviceName } }, token });
  const response = await request('post', '/negotiate', { body: { userId: actor, serviceName }, token });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(pythonCalls.at(-1).slice(0, 2).map(x => JSON.parse(JSON.stringify(x))), [
    'negotiate.py', ['--user-id', actor, '--service', serviceName],
  ]);
});

test('Python runner never enables a shell or interpolates arguments', async () => {
  let invocation;
  const service = '$(printf harmless)"; echo harmless';
  const result = await runPython('negotiate.py', ['--service', service], { spawnImpl: (...args) => {
    invocation = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = () => queueMicrotask(() => { child.stdout.emit('data', '{}'); child.emit('close', 0); });
    return child;
  }});
  assert.equal(result, '{}');
  assert.equal(invocation[0], 'python3');
  assert.equal(invocation[2].shell, false);
  assert.equal(invocation[1].at(-1), service);
});

test('task budgets bound concurrent work, hourly use and recover after errors', async () => {
  let clock = 0;
  const run = createTaskLimiter({ maxActive: 1, perHour: 2, now: () => clock });
  let release;
  const first = run('alice', () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(run('alice', () => {}), { status: 429 });
  await assert.rejects(run('bob', () => {}), { status: 503 });
  release(); await first;
  await assert.rejects(run('alice', () => { throw new Error('task failed'); }), /task failed/);
  await assert.rejects(run('alice', () => {}), { status: 429 });
  clock = 3600001;
  assert.equal(await run('alice', () => 'recovered'), 'recovered');
});

function viewPrelude(source) { return source.slice(0, source.indexOf('/* popup.js')); }

test('subscription list and details escape malicious names, attributes and history', () => {
  const src = fs.readFileSync(path.join(root, 'public/popup.js'), 'utf8');
  const render = src.slice(src.indexOf('function renderSubs()'), src.indexOf('// ── Delete Subscription'));
  const list = { innerHTML: '', classList: { add() {} } };
  const payload = '<img src=x onerror="window.auditProof=1">';
  const id = 'x" onmouseover="auditProof=1';
  const document = { getElementById: () => list, querySelector: () => ({}) };
  const context = vm.createContext({ document, URL, location: { origin: 'https://example.test' }, state: { subscriptions: [{ id, name: payload, provider: payload, category: payload, status: 'active', monthly_cost: 1, health_score: 50, price_history: [{ date: payload, amount: payload }], cancel_url: 'javascript:alert(1)' }] }, currentFilter: 'all', searchQ: '', faviconImg: () => '', cSym: () => '$' });
  vm.runInContext(viewPrelude(src) + render + '\nrenderSubs();', context);
  assert.equal(list.innerHTML.includes(payload), false);
  assert.ok(list.innerHTML.includes('&lt;img'));
  assert.ok(list.innerHTML.includes('data-sub-id="x&quot; onmouseover=&quot;'));
  vm.runInContext(`showSubDetail(${JSON.stringify(id)});`, context);
  assert.equal(list.innerHTML.includes(payload), false);
  assert.equal(list.innerHTML.includes('javascript:'), false);
});

test('login token messages target only the same origin', () => {
  const source = fs.readFileSync(path.join(root, 'public/web3auth-login.html'), 'utf8');
  const fn = source.slice(source.indexOf('function storeAndBroadcast'), source.indexOf('async function login('));
  let sent;
  vm.runInNewContext(fn + '\nstoreAndBroadcast({idToken:"dummy"});', {
    localStorage: { setItem() {} }, window: { location: { origin: 'https://example.test' }, opener: { postMessage(data, target) { sent = { data, target }; } } },
  });
  assert.equal(sent.target, 'https://example.test');
});
