const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const realRequire = createRequire(path.join(root, 'api-bridge.js'));
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'subbot-security-'));
const pythonCalls = [];
Object.assign(process.env, { DATA_DIR: scratch, SESSION_SECRET: 'audit-dummy-secret', INTERNAL_SERVICE_TOKEN: 'audit-internal', TELEMETRY_KEY: 'audit-telemetry', OPENAI_API_KEY: 'dummy-no-network', AGENT_PRIVATE_KEY: '' });
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'audit', alg: 'RS256' };
const express = realRequire('express');
let app;
const expressShim = (...args) => { app = express(...args); app.listen = () => {}; return app; };
Object.assign(expressShim, express);
const https = {
  get(url, callback) {
    assert.equal(url, 'https://api-auth.web3auth.io/jwks');
    const req = new EventEmitter();
    queueMicrotask(() => { const res = new EventEmitter(); callback(res); res.emit('data', JSON.stringify({ keys: [jwk] })); res.emit('end'); });
    return req;
  },
  request() { throw new Error('network forbidden'); },
};
const context = vm.createContext({ console, process, Buffer, URL, setTimeout, clearTimeout, __dirname: root,
  require(name) {
    if (name === './load-env') return {};
    if (name === './run-python') return { runPython: async (...args) => { pythonCalls.push(args); return '{}'; } };
    if (name === 'express') return expressShim;
    if (name === 'https') return https;
    return realRequire(name);
  },
});
vm.runInContext(fs.readFileSync(path.join(root, 'api-bridge.js'), 'utf8'), context);
function layerFor(router, method, route) {
  for (const layer of router.stack || router._router.stack) {
    if (layer.route?.path === route && layer.route.methods[method]) return layer.route.stack;
    if (!layer.route && layer.handle?.stack) { const found = layerFor(layer.handle, method, route); if (found) return found; }
  }
}
async function request(method, route, { body = {}, query = {}, params = {}, token, router = app } = {}) {
  const handlers = layerFor(router, method, route);
  assert.ok(handlers, route);
  const req = { body, query, params, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; }, send(x) { this.body = x; return this; }, setHeader(k,v) { this.headers[k] = v; } };
  async function step(i) { if (i >= handlers.length) return; let next; await handlers[i].handle(req, res, err => { if (err) throw err; next = step(i+1); }); await next; }
  await step(0); return res;
}
function signedJWT(claims) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'audit' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ aud: 'BCkzpmFTjh9pTHe7LGNlrg_jo22W7DNHGkkZSbgrQlOeSf7AzRZ1qdZXDRyxplEq5knOTiCjhH-uga6tpnASP1o', iss: 'https://api-auth.web3auth.io', exp: Math.floor(Date.now()/1000)+300, verifier: 'google', verifierId: 'attacker', sub: 'attacker', ...claims })).toString('base64url');
  const input = `${head}.${payload}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

module.exports = { request, signedJWT, scratch, root, pythonCalls };
