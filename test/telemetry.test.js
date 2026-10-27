const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const express = require('express');
const { createTelemetryRouter } = require('../telemetry');

test('analytics escapes submitted and persisted telemetry while retaining client badges', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subbot-telemetry-'));
  const file = path.join(dir, 'telemetry.ndjson');
  const payload = '<img src=x onerror="alert(1)"> & \'quoted\'';
  const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;';
  fs.writeFileSync(file, JSON.stringify({
    event: 'login', userId: 'persisted', email: payload, session: 'old', ts: Date.now(),
  }) + '\n');
  const app = express();
  app.use(express.json());
  app.use(createTelemetryRouter({ file, key: 'test-key' }));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const body of [
    { event: 'login', userId: '__proto__', email: payload, pwa: true },
    { event: 'subs_loaded', userId: '__proto__', count: payload },
    { event: 'screen_view', screen: payload },
    { event: 'action', action: payload },
  ]) {
    const response = await fetch(`${base}/telemetry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const unauthorized = await fetch(`${base}/telemetry/stats`);
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  const response = await fetch(`${base}/telemetry/stats?key=test-key`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.equal(html.includes(payload), false);
  assert.equal(html.split(escaped).length - 1, 5, 'email, persisted email, count, screen and action must all be escaped');
  assert.ok(html.includes('<span class="badge pwa">PWA</span>'));
  assert.ok(html.includes('<span class="badge web">Browser</span>'));
});
