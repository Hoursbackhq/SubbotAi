#!/usr/bin/env node
/**
 * SubBot API Bridge — localhost:3747
 * Connects the browser extension to the Hermes agent Python scripts.
 * Run: node ~/.hermes/api-bridge.js
 */

require('./load-env');
const express = require('express');
const cors    = require('cors');
const { exec, spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const crypto  = require('crypto');
const { ethers } = require('ethers');

// On-chain contracts (SubBotLog + SubBotCredits)
let logContract    = null;
let creditsContract = null;
let jarsContract    = null;
let gdAutopay       = null; // agent wallet that pulls approved G$ for jar autopay

(async () => {
  const privateKey = process.env.AGENT_PRIVATE_KEY;
  if (!privateKey) return;
  try {
    const { ethers } = require('ethers');
    const CELO_RPC   = 'https://forno.celo.org';
    const provider   = new ethers.JsonRpcProvider(CELO_RPC);
    const wallet     = new ethers.Wallet(privateKey, provider);

    if (process.env.LOG_CONTRACT_ADDRESS) {
      const LOG_ABI = [
        "function logDecision(string calldata userId, string calldata action, uint256 amountSavedUSD) external",
        "function getDecisionCount() external view returns (uint256)",
        "function getTotalSavingsUSD() external view returns (uint256)",
        "event DecisionLogged(address indexed agent, bytes32 indexed userHash, string action, uint256 amountSavedUSD, uint256 timestamp)"
      ];
      logContract = new ethers.Contract(process.env.LOG_CONTRACT_ADDRESS, LOG_ABI, wallet);
      console.log(`[SubBot] Decision log active → ${process.env.LOG_CONTRACT_ADDRESS}`);
    }

    if (process.env.CREDITS_CONTRACT_ADDRESS) {
      const creditsABI = require('./build/SubBotCredits.abi.json');
      creditsContract  = new ethers.Contract(process.env.CREDITS_CONTRACT_ADDRESS, creditsABI, wallet);
      console.log(`[SubBot] Credits active        → ${process.env.CREDITS_CONTRACT_ADDRESS}`);
    }

    gdAutopay = require('./bills').createGdAutopay(wallet);

    if (process.env.JARS_CONTRACT_ADDRESS) {
      const jarsABI = require('./build/SubBotJars.abi.json');
      jarsContract  = new ethers.Contract(process.env.JARS_CONTRACT_ADDRESS, jarsABI, wallet);
      console.log(`[SubBot] Bill jars active      → ${process.env.JARS_CONTRACT_ADDRESS}`);
    }
  } catch (e) {
    console.warn('[SubBot] Contract init failed:', e.message);
  }
})();

const app  = express();
const PORT = process.env.PORT || 3747;
const HERMES_HOME = process.env.DATA_DIR || path.join(process.env.HOME || '/tmp', '.hermes');
const USER_DATA   = path.join(HERMES_HOME, 'user-data');
const CELO_RPC    = 'https://rpc.ankr.com/celo';
const CUSD_ADDR   = '0x765DE816845861e75A25fCA122bb6898B8B1282a'; // cUSD mainnet


app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' })); // statement CSV uploads can be a few hundred KB of text
// No-cache for sw.js so updates propagate immediately
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ────────────────────────────────────────────────────────────────

function userDir(userId = 'local') {
  // userId flows into a filesystem path — strip anything that isn't part of
  // the established w3a:/telegram-numeric formats to block path traversal.
  const safe = String(userId).replace(/[^a-zA-Z0-9:_.\-]/g, '_');
  const d = path.join(USER_DATA, safe);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── Session auth (session-auth.js — extracted so it's unit-testable) ─────
const { issueSessionToken, verifySessionToken, requireSession, requireInternalToken } = require('./session-auth');

// Single source of truth shared with statement-scanner.py
const CANCEL_URLS = readJSON(path.join(__dirname, 'cancel-urls.json')) || {};

function getCancelUrl(name = '') {
  const match = CANCEL_URLS[name.toLowerCase()];
  if (match) return match;
  const query = encodeURIComponent(`how to cancel ${name} subscription`);
  return `https://www.google.com/search?q=${query}`;
}

function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return null; }
}

function writeJSON(file, data) {
  // Write to a temp file then rename — rename is atomic on the same filesystem,
  // so a reader never sees a half-written file if the process dies mid-write.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const LOCK_STALE_AFTER_MS = 10000;
const LOCK_RETRY_MS       = 50;
const LOCK_TIMEOUT_MS     = 3000;

// Exclusive-create lockfile shared with sub_store.py's _file_lock — guards
// read-modify-write endpoints against a Python scan/import process writing
// the same user's file at the same moment.
async function withFileLock(file, fn) {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_AFTER_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (_) { continue; }
      if (Date.now() > deadline) break; // proceed anyway rather than hang indefinitely
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

function runPy(cmd) {
  return new Promise((resolve, reject) => {
    exec(`python3 ${HERMES_HOME}/${cmd}`, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject({ error: err.message, stderr });
      else resolve(stdout);
    });
  });
}

// cUSD balance via Celo JSON-RPC (eth_call for ERC-20 balanceOf)
function celoRPC(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc:'2.0', id:1, method, params });
    const req = https.request(CELO_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getCUSDBalance(address) {
  // ERC-20 balanceOf(address) selector = 0x70a08231
  const padded = address.slice(2).padStart(64, '0');
  const data   = '0x70a08231' + padded;
  const result = await celoRPC('eth_call', [{ to: CUSD_ADDR, data }, 'latest']);
  if (!result.result || result.result === '0x') return '0';
  const wei = BigInt(result.result);
  const cusd = Number(wei) / 1e18;
  return cusd.toFixed(4);
}

// ── Web3Auth JWT verification ──────────────────────────────────────────────

const WEB3AUTH_JWKS_URI = 'https://api-auth.web3auth.io/.well-known/jwks.json';
const WEB3AUTH_CLIENT_ID = 'BCkzpmFTjh9pTHe7LGNlrg_jo22W7DNHGkkZSbgrQlOeSf7AzRZ1qdZXDRyxplEq5knOTiCjhH-uga6tpnASP1o';

let jwksCache = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchJWKS() {
  if (jwksCache && Date.now() - jwksCacheTime < JWKS_CACHE_TTL) return jwksCache;
  const data = await new Promise((resolve, reject) => {
    https.get(WEB3AUTH_JWKS_URI, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
  jwksCache     = data.keys || [];
  jwksCacheTime = Date.now();
  return jwksCache;
}

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parseJWTHeader(token) {
  const [headerB64] = token.split('.');
  return JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
}

function parseJWTPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  return JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
}

async function verifyWeb3AuthJWT(idToken) {
  const { createPublicKey, createVerify } = require('crypto');

  const header  = parseJWTHeader(idToken);
  const payload = parseJWTPayload(idToken);
  const keys    = await fetchJWKS();

  const jwk = keys.find(k => k.kid === header.kid) || keys[0];
  if (!jwk) throw new Error('No matching JWK found');

  // Build PEM from JWK
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const [headerB64, payloadB64, signatureB64] = idToken.split('.');
  const data = `${headerB64}.${payloadB64}`;
  const sig  = base64UrlDecode(signatureB64);

  const verify = createVerify(header.alg === 'RS256' ? 'RSA-SHA256' : 'SHA256');
  verify.update(data);
  const valid = verify.verify(publicKey, sig);
  if (!valid) throw new Error('JWT signature verification failed');

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT has expired');
  }

  // Check audience contains our client ID
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(WEB3AUTH_CLIENT_ID)) {
    throw new Error('JWT audience mismatch');
  }

  return payload;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ ok: true, version: '1.0' }));

// Web3Auth JWT verification endpoint
// The extension calls this after login to validate the idToken using JWKS.
// Returns a stable userId (verifier:verifierId) for data isolation.
app.post('/auth/verify-web3auth', async (req, res) => {
  const { idToken, verifier, verifierId } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  try {
    const payload = await verifyWeb3AuthJWT(idToken);
    const userId  = `w3a:${verifier || payload.verifier || 'unknown'}:${verifierId || payload.verifierId || payload.sub}`;

    // Create user directory and record first-seen timestamp if new
    const dir      = userDir(userId);
    const metaFile = path.join(dir, 'web3auth-meta.json');
    const existing = readJSON(metaFile);
    if (!existing) {
      writeJSON(metaFile, {
        userId,
        verifier: verifier || payload.verifier,
        verifierId: verifierId || payload.verifierId || payload.sub,
        email: payload.email || '',
        firstSeenAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      });
    } else {
      writeJSON(metaFile, { ...existing, lastLoginAt: new Date().toISOString() });
    }

    res.json({ ok: true, userId, email: payload.email || '', sub: payload.sub, sessionToken: issueSessionToken(userId) });
  } catch (err) {
    console.warn('[web3auth] JWT verification failed:', err.message);
    res.status(401).json({ error: 'Invalid Web3Auth token', detail: err.message });
  }
});

// GET /auth/me — returns Web3Auth profile for a verified userId
app.get('/auth/me', requireSession, (req, res) => {
  const { userId } = req.query;
  if (!userId || !userId.startsWith('w3a:')) return res.status(400).json({ error: 'w3a userId required' });
  const metaFile = path.join(userDir(userId), 'web3auth-meta.json');
  const meta     = readJSON(metaFile);
  if (!meta) return res.status(404).json({ error: 'User not found' });
  res.json(meta);
});

// ── Wallet-signature auth ─────────────────────────────────────────────────
// External wallet logins (MetaMask, MiniPay) never get a Web3Auth idToken,
// so they can't go through JWT verification — prove ownership with a
// signed nonce instead, using the ethers.js already loaded for the contracts.
const walletNonces = new Map(); // address (lowercase) → { nonce, expiresAt }
const NONCE_TTL_MS = 5 * 60 * 1000;

app.post('/auth/nonce', (req, res) => {
  const address = String(req.body?.address || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return res.status(400).json({ error: 'valid address required' });
  const nonce = crypto.randomBytes(16).toString('hex');
  walletNonces.set(address, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  res.json({ message: `Sign in to SubBot\n\nNonce: ${nonce}` });
});

app.post('/auth/verify-wallet', (req, res) => {
  const address   = String(req.body?.address || '').toLowerCase();
  const signature = req.body?.signature;
  if (!address || !signature) return res.status(400).json({ error: 'address and signature required' });

  const entry = walletNonces.get(address);
  if (!entry || Date.now() > entry.expiresAt) {
    return res.status(401).json({ error: 'Nonce missing or expired — request a new one via /auth/nonce' });
  }
  walletNonces.delete(address); // one-time use

  const message = `Sign in to SubBot\n\nNonce: ${entry.nonce}`;
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (recovered !== address) return res.status(401).json({ error: 'Signature does not match address' });

  const userId   = `w3a:wallet:${address}`;
  const metaFile = path.join(userDir(userId), 'web3auth-meta.json');
  const existing = readJSON(metaFile);
  writeJSON(metaFile, {
    userId, verifier: 'wallet', verifierId: address, email: '',
    firstSeenAt: existing?.firstSeenAt || new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  });

  res.json({ ok: true, userId, sessionToken: issueSessionToken(userId) });
});

// Bulk sync — bot pushes full data file to Railway after every update
app.post('/sync', requireSession, (req, res) => {
  const { userId = 'local', data } = req.body;
  if (!data) return res.status(400).json({ error: 'data required' });
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  writeJSON(file, data);
  res.json({ ok: true, count: (data.subscriptions || []).length });
});

// Get subscriptions
app.get('/subs', requireSession, (req, res) => {
  const userId = req.query.userId || 'local';
  const file   = path.join(userDir(userId), 'scanned-subscriptions.json');
  const data   = readJSON(file) || { subscriptions: [], cancellation_history: [], monthly_budget: null };
  data.subscriptions = (data.subscriptions || []).map(s => ({ ...s, cancel_url: getCancelUrl(s.name) }));
  res.json(data);
});

// Add a single subscription (from extension manual add)
app.post('/add-sub', requireSession, async (req, res) => {
  const { sub, userId = 'local' } = req.body;
  if (!sub || !sub.name) return res.status(400).json({ error: 'sub.name required' });
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  const count = await withFileLock(file, () => {
    const data = readJSON(file) || { subscriptions: [], cancellation_history: [], monthly_budget: null };
    // Avoid duplicates by id
    data.subscriptions = data.subscriptions.filter(s => s.id !== sub.id);
    data.subscriptions.push(sub);
    writeJSON(file, data);
    return data.subscriptions.length;
  });
  res.json({ ok: true, count });
});

// Delete a subscription
app.post('/delete-sub', requireSession, async (req, res) => {
  const { subId, userId = 'local' } = req.body;
  if (!subId) return res.status(400).json({ error: 'subId required' });
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  const count = await withFileLock(file, () => {
    const data = readJSON(file) || { subscriptions: [], cancellation_history: [], monthly_budget: null };
    data.subscriptions = data.subscriptions.filter(s => s.id !== subId);
    writeJSON(file, data);
    return data.subscriptions.length;
  });
  res.json({ ok: true, count });
});

// Update a subscription
app.post('/update-sub', requireSession, async (req, res) => {
  const { sub, userId = 'local' } = req.body;
  if (!sub || !sub.id) return res.status(400).json({ error: 'sub.id required' });
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  const count = await withFileLock(file, () => {
    const data = readJSON(file) || { subscriptions: [], cancellation_history: [], monthly_budget: null };
    data.subscriptions = data.subscriptions.map(s => s.id === sub.id ? { ...s, ...sub } : s);
    writeJSON(file, data);
    return data.subscriptions.length;
  });
  res.json({ ok: true, count });
});

// Scan Gmail inbox
app.post('/scan', requireSession, async (req, res) => {
  const { email, password, userId = 'local' } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    // Use spawn() + stdin so password never appears in process args (invisible to `ps`)
    const out = await new Promise((resolve, reject) => {
      const child = spawn('python3', [
        path.join(HERMES_HOME, 'gmail-scanner.py'),
        '--email', email,
        '--user-id', userId,
      ], { timeout: 120000 });
      // Send password via stdin as JSON array
      child.stdin.write(JSON.stringify([password]));
      child.stdin.end();
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);
      child.on('close', code => {
        if (code !== 0) reject({ error: stderr || `exit code ${code}` });
        else resolve(stdout);
      });
      child.on('error', err => reject({ error: err.message }));
    });
    const file = path.join(userDir(userId), 'scanned-subscriptions.json');
    const data = readJSON(file);
    res.json(data || { subscriptions: [] });
  } catch(e) {
    // Sanitize error — never leak credentials
    const safeError = (e.error || 'Scan failed').replace(/[^\s]{16,}/g, '***');
    res.status(500).json({ error: safeError });
  }
});

// Import a bank/card statement CSV — detects recurring charges Gmail never sees a receipt for
app.post('/import-statement', requireSession, async (req, res) => {
  const { csvText, userId = 'local' } = req.body;
  if (!csvText) return res.status(400).json({ error: 'csvText required' });
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn('python3', [
        path.join(HERMES_HOME, 'statement-scanner.py'),
        '--user-id', userId,
      ], { timeout: 60000 });
      child.stdin.write(csvText);
      child.stdin.end();
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);
      child.on('close', code => {
        if (code !== 0) reject({ error: stderr || `exit code ${code}` });
        else resolve(stdout);
      });
      child.on('error', err => reject({ error: err.message }));
    });
    const file = path.join(userDir(userId), 'scanned-subscriptions.json');
    const data = readJSON(file);
    res.json(data || { subscriptions: [] });
  } catch(e) {
    res.status(500).json({ error: e.error || 'Statement import failed' });
  }
});

// Run LLM-powered audit (delegates to llm-analyze.py for contextual reasoning)
app.post('/audit', requireSession, async (req, res) => {
  const { userId = 'local' } = req.body;
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  const data = readJSON(file);
  if (!data) return res.json({ monthly: 0, annual: 0, overlaps: [], subs: [] });

  // Return cached LLM analysis if it's fresh (< 1 hour old)
  const analysisFile = path.join(userDir(userId), 'llm-analysis.json');
  const cached = readJSON(analysisFile);
  if (cached && cached.generated_at) {
    const ageMs = Date.now() - new Date(cached.generated_at).getTime();
    if (ageMs < 60 * 60 * 1000) {
      return res.json({ ...cached, source: 'cache' });
    }
  }

  // Run LLM analysis in background — return basic summary immediately,
  // full results available via GET /analysis once complete
  const subs    = (data.subscriptions || []).filter(s => s.status === 'active');
  const monthly = subs.reduce((sum, s) => sum + (s.monthly_cost || 0), 0);

  // Fire off LLM analysis asynchronously
  runPy(`llm-analyze.py --user-id ${userId}`)
    .then(() => console.log(`[audit] LLM analysis complete for ${userId}`))
    .catch(e  => console.warn(`[audit] LLM analysis failed: ${e.error}`));

  res.json({
    monthly,
    annual:   monthly * 12,
    subs,
    budget:   data.monthly_budget,
    source:   'basic',
    message:  'Full LLM analysis running — check GET /analysis in a few seconds',
  });
});

// Get latest LLM analysis result
app.get('/analysis', requireSession, (req, res) => {
  const userId       = req.query.userId || 'local';
  const analysisFile = path.join(userDir(userId), 'llm-analysis.json');
  const analysis     = readJSON(analysisFile);
  if (!analysis) return res.status(404).json({ error: 'No analysis yet — run /audit first' });
  res.json(analysis);
});

// Export CSV (calls export.py)
app.post('/export', requireSession, async (req, res) => {
  const { userId = 'local' } = req.body;
  try {
    await runPy(`export.py --user-id ${userId}`);
    res.json({ ok: true, message: 'CSV exported' });
  } catch(e) {
    // Fallback — return CSV data for browser download
    const file = path.join(userDir(userId), 'scanned-subscriptions.json');
    const data = readJSON(file);
    if (!data) return res.status(500).json({ error: 'No data to export' });
    const subs = data.subscriptions || [];
    const csv  = ['Name,Provider,Category,Monthly Cost,Currency,Renewal,Status,Health']
      .concat(subs.map(s => `${s.name},${s.provider},${s.category},${s.monthly_cost},${s.currency},${s.next_renewal},${s.status},${s.health_score}`))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=subbot-subscriptions.csv');
    res.send(csv);
  }
});

// Draft LLM-personalized negotiation email
app.post('/negotiate', requireSession, async (req, res) => {
  const { serviceName, userId = 'local' } = req.body;
  if (!serviceName) return res.status(400).json({ error: 'serviceName required' });

  // Load subscription context for this service
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  const data = readJSON(file) || {};
  const subs = data.subscriptions || [];
  const sub  = subs.find(s => s.name.toLowerCase() === serviceName.toLowerCase());

  // Check if LLM analysis has a strategy for this service
  const analysisFile = path.join(userDir(userId), 'llm-analysis.json');
  const analysis     = readJSON(analysisFile);
  const candidate    = analysis?.negotiation_candidates?.find(
    c => c.service.toLowerCase() === serviceName.toLowerCase()
  );

  // If we have full context, run LLM negotiation script
  if (sub && process.env.OPENAI_API_KEY) {
    try {
      const out = await runPy(
        `negotiate.py --user-id ${userId} --service "${serviceName}"`
      );
      const result = JSON.parse(out.trim());
      return res.json(result);
    } catch (_) {
      // Fall through to contextual fallback below
    }
  }

  // Contextual fallback: better than generic template, uses whatever data we have
  const healthScore  = sub?.health_score;
  const monthlyCost  = sub?.monthly_cost_usd || sub?.monthly_cost || 0;
  const renewalDate  = sub?.next_renewal || '';
  const strategy     = candidate?.strategy || '';
  const expectedDisc = candidate?.expected_discount_pct || 20;

  // Find overlapping services as leverage
  const overlaps = analysis?.overlaps?.find(o =>
    o.services.some(s => s.toLowerCase() === serviceName.toLowerCase())
  );
  const competitor = overlaps?.services?.find(
    s => s.toLowerCase() !== serviceName.toLowerCase()
  ) || '';

  const competitorLine = competitor
    ? `\n\nI'm currently also evaluating ${competitor} as an alternative.`
    : '';

  const email = {
    to:       `support@${serviceName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '')}.com`,
    subject:  `Subscription Review — ${serviceName}`,
    body:     `Hi team,\n\nI've been a ${serviceName} subscriber and I'm currently doing a full review of my AI/SaaS spending.${competitorLine}\n\nBefore I make any changes, I wanted to check — do you have any retention offers, annual plan discounts, or paused-subscription options? I've seen ${expectedDisc}% discounts mentioned in the community.\n\nIf there's a plan that works better for my budget, I'd love to stay. Please let me know what's available.\n\nThank you,\n[Your Name]`,
    context:  {
      healthScore,
      monthlyCost,
      renewalDate,
      strategy,
      competitor,
    },
  };

  res.json(email);
});

// Log agent decision on Celo blockchain
// Called by the LLM (via Python scripts) after every significant recommendation.
// Creates an immutable on-chain audit trail of the agent's decisions.
app.post('/log-decision', requireInternalToken, async (req, res) => {
  const { userId = 'local', action, amountSavedUSD = 0 } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });

  // Always save locally regardless of on-chain status
  const file   = path.join(userDir(userId), 'decision-log.json');
  const log    = readJSON(file) || { decisions: [], totalSavedUSD: 0 };
  const entry  = {
    action,
    amountSavedUSD,
    timestamp: new Date().toISOString(),
    onChain:   false,
    txHash:    null,
  };

  if (logContract) {
    try {
      // Convert USD to cents for the contract (avoids decimals)
      const cents = Math.round(amountSavedUSD * 100);
      const tx    = await logContract.logDecision(userId, action, cents);
      await tx.wait();
      entry.onChain = true;
      entry.txHash  = tx.hash;
      console.log(`[chain] ${action} for ${userId} → ${tx.hash}`);
    } catch (e) {
      console.warn(`[chain] logDecision failed: ${e.message}`);
    }
  }

  log.decisions  = [entry, ...log.decisions].slice(0, 500);
  log.totalSavedUSD = (log.totalSavedUSD || 0) + amountSavedUSD;
  writeJSON(file, log);

  res.json({
    ok:      true,
    onChain: entry.onChain,
    txHash:  entry.txHash,
    action,
    amountSavedUSD,
  });
});

// Get agent decision history (local + on-chain status)
app.get('/decisions', requireInternalToken, (req, res) => {
  const userId = req.query.userId || 'local';
  const file   = path.join(userDir(userId), 'decision-log.json');
  res.json(readJSON(file) || { decisions: [], totalSavedUSD: 0 });
});

// ── Credits routes (SubBotCredits contract — pure G$) ─────────────────────

// G$ operation costs in G$ (matches contract constants)
const OP_COSTS_GD = { scan: 0.10, audit: 0.05, negotiate: 0.10, export: 0.05 };

// GET /credits/:userId — balance, totalDeposited, totalSpent, opsRemaining
app.get('/credits/:userId', requireSession, async (req, res) => {
  if (!creditsContract) return res.json({ balance: '0', totalDeposited: '0', totalSpent: '0', opsRemaining: 0, configured: false });
  try {
    const { ethers } = require('ethers');
    const [balance, totalDeposited, totalSpent, opsRemaining] = await creditsContract.getCredits(req.params.userId);
    res.json({
      balance:        ethers.formatEther(balance),
      totalDeposited: ethers.formatEther(totalDeposited),
      totalSpent:     ethers.formatEther(totalSpent),
      opsRemaining:   Number(opsRemaining),
      configured:     true,
      creditsAddress: process.env.CREDITS_CONTRACT_ADDRESS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /credits/spend — agent spends credits for an action
app.post('/credits/spend', requireSession, async (req, res) => {
  if (!creditsContract) return res.status(503).json({ error: 'Credits contract not configured' });
  const { userId, action } = req.body;
  if (!userId || !action) return res.status(400).json({ error: 'userId and action required' });

  try {
    const tx = await creditsContract.spendCredits(userId, action);
    await tx.wait();
    const { ethers } = require('ethers');
    const [balance] = await creditsContract.getCredits(userId);
    res.json({ ok: true, txHash: tx.hash, action, creditsRemaining: ethers.formatEther(balance) });
  } catch (e) {
    res.status(402).json({ error: e.message });
  }
});

// ── Unified charge endpoint ────────────────────────────────────────────────
// Tries SubBotCredits first (G$ credits). Falls back to free tier.

app.post('/charge', requireSession, async (req, res) => {
  const { userId, action } = req.body;
  if (!userId || !action) return res.status(400).json({ error: 'userId and action required' });

  const costGD = OP_COSTS_GD[action];
  if (costGD === undefined) return res.status(400).json({ error: `Unknown action: ${action}` });

  // ── Try SubBotCredits first ───────────────────────────────────────────────
  if (creditsContract) {
    try {
      const canAfford = await creditsContract.canAfford(userId, action);
      if (canAfford) {
        const tx = await creditsContract.spendCredits(userId, action);
        await tx.wait();
        const { ethers } = require('ethers');
        const [balance] = await creditsContract.getCredits(userId);
        return res.json({
          ok: true,
          mode: 'credits',
          txHash: tx.hash,
          action,
          costGD,
          creditsRemaining: ethers.formatEther(balance),
        });
      }
    } catch (e) {
      // credits call failed — fall through to free tier
    }
  }

  // ── Free tier fallback ────────────────────────────────────────────────────
  const file   = path.join(userDir(userId), 'free-usage.json');
  const usage  = readJSON(file) || { total: 0, actions: [] };
  usage.total  += 1;
  usage.actions = [{ action, costGD, ts: new Date().toISOString() }, ...usage.actions].slice(0, 100);
  writeJSON(file, usage);

  res.json({
    ok: true,
    mode: 'free',
    action,
    costGD,
    totalFreeRuns: usage.total,
    hint: usage.total >= 5 ? `You've used ${usage.total} free runs. Deposit G$ into credits to keep going.` : null,
  });
});

// GET /charge-mode/:userId — tells the bot/frontend which mode the user is in
app.get('/charge-mode/:userId', requireSession, async (req, res) => {
  const { userId } = req.params;
  if (!creditsContract) return res.json({ mode: 'free', canRunNow: true });

  try {
    const { ethers } = require('ethers');
    const [balance, totalDeposited, totalSpent, opsRemaining] = await creditsContract.getCredits(userId);
    const hasCredits = balance > 0n;
    res.json({
      mode: hasCredits ? 'credits' : 'free',
      balance: ethers.formatEther(balance),
      totalDeposited: ethers.formatEther(totalDeposited),
      opsRemaining: Number(opsRemaining),
      creditsActive: hasCredits,
      canRunNow: true,
    });
  } catch (e) {
    res.json({ mode: 'free', error: e.message, canRunNow: true });
  }
});

// Celo cUSD balance
app.get('/balance', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });
  try {
    const balance = await getCUSDBalance(address);
    res.json({ address, balance, currency: 'G$' });
  } catch(e) {
    res.status(500).json({ error: 'RPC error', detail: e.message, balance: '0' });
  }
});

// Record credit deduction
app.post('/deduct', requireSession, async (req, res) => {
  const { action, cost, walletAddress, userId = 'local' } = req.body;
  const file = path.join(userDir(userId), 'credits.json');
  await withFileLock(file, () => {
    const ledger = readJSON(file) || { walletAddress, transactions: [] };
    ledger.walletAddress = walletAddress || ledger.walletAddress;
    ledger.transactions  = [{ type:'deduct', action, amount: cost, ts: new Date().toISOString() }, ...ledger.transactions].slice(0, 200);
    writeJSON(file, ledger);
  });
  res.json({ ok: true });
});

// Get credit history
app.get('/history', requireSession, (req, res) => {
  const userId = req.query.userId || 'local';
  const file   = path.join(userDir(userId), 'credits.json');
  res.json(readJSON(file) || { transactions: [] });
});

// Save budget
app.post('/budget', requireSession, async (req, res) => {
  const { budget, budgetCurrency, userId = 'local' } = req.body;
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  const finalCurrency = await withFileLock(file, () => {
    const data = readJSON(file) || { subscriptions: [], cancellation_history: [] };
    data.monthly_budget = budget;
    if (budgetCurrency) data.budget_currency = budgetCurrency;
    writeJSON(file, data);
    return data.budget_currency;
  });
  res.json({ ok: true, budget, budgetCurrency: finalCurrency });
});

// ── Telemetry ──────────────────────────────────────────────────────────────
const TELE_FILE = path.join(HERMES_HOME, 'telemetry.ndjson');
const TELE_KEY  = process.env.TELEMETRY_KEY || '';
if (!TELE_KEY) console.warn('[SubBot] TELEMETRY_KEY not set — /telemetry/stats will reject all requests until it is configured.');
const teleEvents = [];
const userMap    = {}; // userId → { email, subCount, sessions, lastSeen, pwa, loginCount }

// Load last 5000 persisted events on startup
try {
  if (fs.existsSync(TELE_FILE)) {
    const lines = fs.readFileSync(TELE_FILE, 'utf8').trim().split('\n').filter(Boolean);
    lines.slice(-5000).forEach(l => {
      try {
        const e = JSON.parse(l);
        teleEvents.push(e);
        if (e.event === 'login' && e.userId) {
          if (!userMap[e.userId]) userMap[e.userId] = { email: '', subCount: 0, sessions: new Set(), loginCount: 0, lastSeen: 0, pwa: false };
          if (e.email) userMap[e.userId].email = e.email;
          userMap[e.userId].sessions.add(e.session);
          userMap[e.userId].loginCount++;
          if (e.ts > userMap[e.userId].lastSeen) { userMap[e.userId].lastSeen = e.ts; userMap[e.userId].pwa = e.pwa; }
        }
        if (e.event === 'subs_loaded' && e.userId) {
          if (!userMap[e.userId]) userMap[e.userId] = { email: '', subCount: 0, sessions: new Set(), loginCount: 0, lastSeen: 0, pwa: false };
          userMap[e.userId].subCount = e.count || 0;
        }
      } catch (_) {}
    });
    console.log(`[SubBot] Telemetry loaded: ${teleEvents.length} events, ${Object.keys(userMap).length} users`);
  }
} catch (_) {}

app.post('/telemetry', (req, res) => {
  const { event, screen, action, session, theme, pwa, email, userId, count } = req.body || {};
  if (!event) return res.status(400).json({ error: 'missing event' });
  const entry = {
    event, screen: screen || null, action: action || null,
    session: session || 'anon', theme: theme || 'dark', pwa: !!pwa,
    email: email || null, userId: userId || null, count: count ?? null,
    ua: (req.headers['user-agent'] || '').slice(0, 200),
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
    ts: Date.now()
  };
  teleEvents.push(entry);
  if (teleEvents.length > 10000) teleEvents.shift();
  fs.appendFile(TELE_FILE, JSON.stringify(entry) + '\n', () => {});

  // Update user registry
  if (event === 'login' && userId) {
    if (!userMap[userId]) userMap[userId] = { email: '', subCount: 0, sessions: new Set(), loginCount: 0, lastSeen: 0, pwa: false };
    if (email) userMap[userId].email = email;
    userMap[userId].sessions.add(session || 'anon');
    userMap[userId].loginCount++;
    userMap[userId].lastSeen = entry.ts;
    userMap[userId].pwa = !!pwa;
  }
  if (event === 'subs_loaded' && userId) {
    if (!userMap[userId]) userMap[userId] = { email: '', subCount: 0, sessions: new Set(), loginCount: 0, lastSeen: 0, pwa: false };
    userMap[userId].subCount = count || 0;
    if (entry.ts > userMap[userId].lastSeen) userMap[userId].lastSeen = entry.ts;
  }

  res.json({ ok: true });
});

app.get('/telemetry/stats', (req, res) => {
  if (!TELE_KEY || req.query.key !== TELE_KEY) return res.status(401).send('Unauthorized');
  const now = Date.now();
  const DAY = 86400000;
  const e1d = teleEvents.filter(e => now - e.ts < DAY);
  const e7d = teleEvents.filter(e => now - e.ts < 7 * DAY);

  const countBy = (arr, fn) => {
    const m = {};
    arr.forEach(e => { const k = fn(e); if (k) m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  const daily = {};
  e7d.forEach(e => {
    const d = new Date(e.ts).toISOString().slice(0, 10);
    if (!daily[d]) daily[d] = new Set();
    daily[d].add(e.session);
  });
  const dailyRows = Object.entries(daily).sort().map(([date, s]) => [date, s.size]);

  const screens = countBy(teleEvents.filter(e => e.event === 'screen_view'), e => e.screen);
  const actions = countBy(teleEvents.filter(e => e.event === 'action'), e => e.action);
  const users   = Object.entries(userMap)
    .map(([uid, u]) => ({ uid, email: u.email || '—', subCount: u.subCount, sessions: u.sessions.size, loginCount: u.loginCount, lastSeen: u.lastSeen, pwa: u.pwa }))
    .sort((a, b) => b.lastSeen - a.lastSeen);

  const fmt = ts => ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  const row = (...cells) => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
  const tbl = (heads, rows) => `<table><thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

  const stat = (label, val) => `<div class="card"><div class="val">${val}</div><div class="lbl">${label}</div></div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>SubBot Analytics</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#f0f0f0;padding:24px}
  h1{font-size:20px;font-weight:700;margin-bottom:20px;color:#34d399}
  h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin:28px 0 10px}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  .card{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:10px;padding:14px 18px;min-width:120px}
  .card .val{font-size:26px;font-weight:700;color:#34d399;font-variant-numeric:tabular-nums}
  .card .lbl{font-size:11px;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:.06em}
  table{width:100%;border-collapse:collapse;font-size:13px;background:#1c1c1c;border-radius:10px;overflow:hidden}
  th{background:#242424;padding:9px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;font-weight:600}
  td{padding:9px 14px;border-top:1px solid #2a2a2a;color:#e0e0e0}
  tr:hover td{background:#242424}
  .badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;text-transform:uppercase}
  .pwa{background:#34d399/20;color:#34d399;border:1px solid #34d399}
  .web{background:#1c1c1c;color:#888;border:1px solid #2a2a2a}
</style></head><body>
<h1>SubBot Analytics</h1>
<div class="stats">
  ${stat('Total Events', teleEvents.length)}
  ${stat('Sessions Today', new Set(e1d.map(e=>e.session)).size)}
  ${stat('Sessions 7d', new Set(e7d.map(e=>e.session)).size)}
  ${stat('Unique IPs Today', new Set(e1d.map(e=>e.ip)).size)}
  ${stat('Registered Users', users.length)}
  ${stat('Logins Today', e1d.filter(e=>e.event==='login').length)}
</div>

<h2>Users</h2>
${tbl(['Email','Subs Tracked','Sessions','Logins','Last Seen','Client'],
  users.map(u => row(
    u.email,
    u.subCount,
    u.sessions,
    u.loginCount,
    fmt(u.lastSeen),
    `<span class="badge ${u.pwa?'pwa':'web'}">${u.pwa?'PWA':'Browser'}</span>`
  ))
)}

<h2>Screen Views</h2>
${tbl(['Screen','Views'], screens.map(([s,c]) => row(s,c)))}

<h2>Actions</h2>
${tbl(['Action','Count'], actions.map(([a,c]) => row(a,c)))}

<h2>Daily Sessions (7d)</h2>
${tbl(['Date','Sessions'], dailyRows.map(([d,c]) => row(d,c)))}

<p style="margin-top:24px;font-size:11px;color:#444">Last updated: ${fmt(now)}</p>
</body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ── Bills, jars and data (bills.js) ───────────────────────────────────────
app.use(require('./bills').createBillsRouter({
  userDir, readJSON, writeJSON, withFileLock, requireSession, requireInternalToken,
  provider: new ethers.JsonRpcProvider('https://forno.celo.org'),
  getJarsContract: () => jarsContract,
  getAutopay: () => gdAutopay,
  usedTxFile: path.join(HERMES_HOME, 'bills-used-tx.json'),
}));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SubBot Bridge] Running at http://0.0.0.0:${PORT}`);
  console.log(`[SubBot Bridge] HERMES_HOME: ${HERMES_HOME}`);
});
