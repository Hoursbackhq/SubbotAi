const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { once } = require('events');
const express = require('express');
const { withFileLock } = require('../file-lock');
const { asyncRoute, storageErrorHandler } = require('../http-errors');

const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const shortWait = { timeoutMs: 50, retryMs: 5 };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subbot-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'scanned-subscriptions.json') };
}

test('concurrent writers preserve every read-modify-write update', async t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, '0');
  await Promise.all(Array.from({ length: 20 }, () => withFileLock(file, async () => {
    const old = Number(fs.readFileSync(file));
    await new Promise(resolve => setTimeout(resolve, 2));
    fs.writeFileSync(file, String(old + 1));
  }, { retryMs: 5 })));
  assert.equal(Number(fs.readFileSync(file)), 20);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('timeout never runs the write or removes an old lock owned by another writer', async t => {
  const { file } = fixture(t);
  fs.writeFileSync(`${file}.lock`, 'another writer');
  fs.utimesSync(`${file}.lock`, new Date(0), new Date(0));
  let called = false;
  await assert.rejects(withFileLock(file, () => { called = true; }, shortWait), { code: 'ELOCKTIMEOUT' });
  assert.equal(called, false);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'another writer');
});

test('a failed write releases its own lock', async t => {
  const { file } = fixture(t);
  await assert.rejects(withFileLock(file, () => { throw new Error('failed write'); }), /failed write/);
  await withFileLock(file, () => fs.writeFileSync(file, 'recovered'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'recovered');
});

test('Python import respects a Node lock and merges safely once it is released', async t => {
  const { dir } = fixture(t);
  const userDir = require('../user-path').userPath(path.join(dir, 'user-data'), 'local');
  fs.mkdirSync(userDir, { recursive: true });
  const file = path.join(userDir, 'scanned-subscriptions.json');
  const python = `
import sub_store
sub_store.LOCK_TIMEOUT_S = 0.05
try:
    sub_store.merge_all('local', [{'id': 'python-import', 'monthly_cost': 5}])
except TimeoutError:
    print('busy')
else:
    print('saved')
`;
  const options = { cwd: root, env: { ...process.env, DATA_DIR: dir }, timeout: 5000 };
  await withFileLock(file, async () => {
    const { stdout } = await run('python3', ['-c', python], options);
    assert.equal(stdout.trim(), 'busy');
    assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), `${process.pid}\n`);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, JSON.stringify({ subscriptions: [{ id: 'manual', notes: 'keep me' }] }));
  });
  const { stdout } = await run('python3', ['-c', python], options);
  assert.equal(stdout.trim(), 'saved');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).subscriptions.map(s => s.id), ['manual', 'python-import']);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('Node respects a lock held by Python and can write after Python releases it', async t => {
  const { file } = fixture(t);
  const child = spawn('python3', ['-u', '-c', `
import sys
from pathlib import Path
from sub_store import _file_lock
with _file_lock(Path(sys.argv[1] + '.lock')):
    print('locked', flush=True)
    sys.stdin.readline()
`, file], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  await assert.rejects(withFileLock(file, () => assert.fail('entered Python lock'), shortWait), { code: 'ELOCKTIMEOUT' });
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), `${child.pid}\n`);
  child.stdin.end('\n');
  const [code] = await exited;
  assert.equal(code, 0);
  await withFileLock(file, () => fs.writeFileSync(file, 'saved'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
});

test('Express returns a retryable 503 on lock timeout and accepts the next write', async t => {
  const { file } = fixture(t);
  const app = express();
  app.post('/write', asyncRoute(async (req, res) => {
    await withFileLock(file, () => fs.writeFileSync(file, 'saved'), shortWait);
    res.json({ ok: true });
  }));
  app.use(storageErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/write`;
  await withFileLock(file, async () => {
    const response = await fetch(url, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.match((await response.json()).error, /Storage is busy/);
    assert.equal(fs.existsSync(file), false);
  });
  const response = await fetch(url, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
