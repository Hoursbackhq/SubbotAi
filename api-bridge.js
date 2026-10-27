#!/usr/bin/env node
/**
 * SubBot API Bridge — localhost:3747
 * Connects the browser extension to the Hermes agent Python scripts.
 * Run: node ~/.hermes/api-bridge.js
 */

require('./load-env');
const express = require('express');
const cors    = require('cors');
const { runPython } = require('./run-python');
const runTask = require('./task-limits').createTaskLimiter();
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
// Landing page at /, the app itself at /app
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ────────────────────────────────────────────────────────────────

function userDir(userId = 'local') {
  const d = require('./user-path').userPath(USER_DATA, userId);
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

const { withFileLock } = require('./file-lock');
const { asyncRoute, storageErrorHandler } = require('./http-errors');

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

const WEB3AUTH_JWKS_URI = process.env.WEB3AUTH_JWKS_URI || 'https://api-auth.web3auth.io/jwks';
const WEB3AUTH_ISSUER = process.env.WEB3AUTH_ISSUER || 'https://api-auth.web3auth.io';
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

  if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') throw new Error('Unsupported JWT header');
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('No matching JWK found');

  // Build PEM from JWK
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const [headerB64, payloadB64, signatureB64] = idToken.split('.');
  const data = `${headerB64}.${payloadB64}`;
  const sig  = base64UrlDecode(signatureB64);

  const verify = createVerify(header.alg === 'RS256' ? 'RSA-SHA256' : 'SHA256');
  verify.update(data);
  if ((header.alg === 'RS256' && jwk.kty !== 'RSA') || (header.alg === 'ES256' && jwk.kty !== 'EC')) throw new Error('JWT key type mismatch');
  const valid = verify.verify(header.alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey, sig);
  if (!valid) throw new Error('JWT signature verification failed');

  // Check expiry
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('JWT has expired');
  }

  if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > Math.floor(Date.now() / 1000))) throw new Error('JWT not active');

  // Check audience contains our client ID
  if (payload.iss !== WEB3AUTH_ISSUER) throw new Error('JWT issuer mismatch');
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
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  try {
    const payload = await verifyWeb3AuthJWT(idToken);
    const verifier = payload.verifier || payload.groupedAuthConnectionId || payload.authConnectionId || payload.authConnection;
    const verifierId = payload.verifierId || payload.userId || payload.sub;
    if (typeof verifier !== 'string' || !verifier || typeof verifierId !== 'string' || !verifierId || verifier.length > 100 || verifierId.length > 512) throw new Error('JWT identity missing or invalid');
    const userId = `w3a:${verifier}:${verifierId}`;

    // Create user directory and record first-seen timestamp if new
    const dir      = userDir(userId);
    const metaFile = path.join(dir, 'web3auth-meta.json');
    const existing = readJSON(metaFile);
    if (!existing) {
      writeJSON(metaFile, {
        userId,
        verifier,
        verifierId,
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
app.post('/sync', requireSession, asyncRoute(async (req, res) => {
  const { userId = 'local', data } = req.body;
  if (!data) return res.status(400).json({ error: 'data required' });
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  await withFileLock(file, () => writeJSON(file, data));
  res.json({ ok: true, count: (data.subscriptions || []).length });
}));

// Get subscriptions
app.get('/subs', requireSession, (req, res) => {
  const userId = req.query.userId || 'local';
  const file   = path.join(userDir(userId), 'scanned-subscriptions.json');
  const data   = readJSON(file) || { subscriptions: [], cancellation_history: [], monthly_budget: null };
  data.subscriptions = (data.subscriptions || []).map(s => ({ ...s, cancel_url: getCancelUrl(s.name) }));
  res.json(data);
});

// Add a single subscription (from extension manual add)
app.post('/add-sub', requireSession, asyncRoute(async (req, res) => {
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
}));

// Delete a subscription
app.post('/delete-sub', requireSession, asyncRoute(async (req, res) => {
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
}));

// Update a subscription
app.post('/update-sub', requireSession, asyncRoute(async (req, res) => {
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
}));

// Scan Gmail inbox. Off until the Google review is done; the web app shows it as coming soon.
app.post('/scan', requireSession, async (req, res) => {
  if (process.env.EMAIL_SCAN_ENABLED !== 'true') return res.status(410).json({ error: 'Email scan is coming soon' });
  const { email, password, userId = 'local' } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    await runTask(userId, () => runPython('gmail-scanner.py', ['--email', email, '--user-id', userId], { input: JSON.stringify([password]), timeout: 120000 }));
    const file = path.join(userDir(userId), 'scanned-subscriptions.json');
    const data = readJSON(file);
    res.json(data || { subscriptions: [] });
  } catch(e) {
    // Sanitize error — never leak credentials
    const safeError = (e.error || 'Scan failed').replace(/[^\s]{16,}/g, '***');
    res.status(e.status || 500).json({ error: safeError });
  }
});

// Import a bank/card statement CSV — detects recurring charges Gmail never sees a receipt for
app.post('/import-statement', requireSession, async (req, res) => {
  const { csvText, userId = 'local' } = req.body;
  if (!csvText) return res.status(400).json({ error: 'csvText required' });
  try {
    await runTask(userId, () => runPython('statement-scanner.py', ['--user-id', userId], { input: csvText }));
    const file = path.join(userDir(userId), 'scanned-subscriptions.json');
    const data = readJSON(file);
    res.json(data || { subscriptions: [] });
  } catch(e) {
    res.status(e.status || 500).json({ error: 'Statement import failed or task limit reached' });
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

  // Keep the per-user task slot until analysis completes.
  const subs    = (data.subscriptions || []).filter(s => s.status === 'active');
  const monthly = subs.reduce((sum, s) => sum + (s.monthly_cost || 0), 0);

  try {
    await runTask(userId, () => runPython('llm-analyze.py', ['--user-id', userId]));
    const result = readJSON(analysisFile);
    if (result) return res.json({ ...result, source: 'llm' });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.status ? e.message : 'Analysis failed' });
  }

  res.json({
    monthly,
    annual:   monthly * 12,
    subs,
    budget:   data.monthly_budget,
    source:   'basic',
    message: 'Analysis completed without a saved result',
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
    await runTask(userId, () => runPython('export.py', ['--user-id', userId]));
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
      const out = await runTask(userId, () => runPython(
        'negotiate.py', ['--user-id', userId, '--service', serviceName]
      ));
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
app.post('/deduct', requireSession, asyncRoute(async (req, res) => {
  const { action, cost, walletAddress, userId = 'local' } = req.body;
  const file = path.join(userDir(userId), 'credits.json');
  await withFileLock(file, () => {
    const ledger = readJSON(file) || { walletAddress, transactions: [] };
    ledger.walletAddress = walletAddress || ledger.walletAddress;
    ledger.transactions  = [{ type:'deduct', action, amount: cost, ts: new Date().toISOString() }, ...ledger.transactions].slice(0, 200);
    writeJSON(file, ledger);
  });
  res.json({ ok: true });
}));

// Get credit history
app.get('/history', requireSession, (req, res) => {
  const userId = req.query.userId || 'local';
  const file   = path.join(userDir(userId), 'credits.json');
  res.json(readJSON(file) || { transactions: [] });
});

// Save budget
app.post('/budget', requireSession, asyncRoute(async (req, res) => {
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
}));

// ── Telemetry ──────────────────────────────────────────────────────────────
app.use(require('./telemetry').createTelemetryRouter({
  file: path.join(HERMES_HOME, 'telemetry.ndjson'),
  key: process.env.TELEMETRY_KEY || '',
}));

// ── Bills, jars and data (bills.js) ───────────────────────────────────────
app.use(require('./bills').createBillsRouter({
  userDir, readJSON, writeJSON, withFileLock, requireSession, requireInternalToken,
  provider: new ethers.JsonRpcProvider('https://forno.celo.org'),
  getJarsContract: () => jarsContract,
  getCreditsContract: () => creditsContract,
  getAutopay: () => gdAutopay,
  usedTxFile: path.join(HERMES_HOME, 'bills-used-tx.json'),
}));

app.use(storageErrorHandler);

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SubBot Bridge] Running at http://0.0.0.0:${PORT}`);
  console.log(`[SubBot Bridge] HERMES_HOME: ${HERMES_HOME}`);
});
