#!/usr/bin/env node
/**
 * SubBot API Bridge — localhost:3747
 * Connects the browser extension to the Hermes agent Python scripts.
 * Run: node ~/.hermes/api-bridge.js
 */

require('./load-env');
const express = require('express');
const cors    = require('cors');
const { exec } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

// On-chain contracts (SubBotLog + SubBotVault)
let logContract   = null;
let vaultContract = null;

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

    if (process.env.VAULT_CONTRACT_ADDRESS) {
      const vaultABI = require('./build/SubBotVault.abi.json');
      vaultContract  = new ethers.Contract(process.env.VAULT_CONTRACT_ADDRESS, vaultABI, wallet);
      console.log(`[SubBot] Vault active         → ${process.env.VAULT_CONTRACT_ADDRESS}`);
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ────────────────────────────────────────────────────────────────

function userDir(userId = 'local') {
  const d = path.join(USER_DATA, userId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return null; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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

    res.json({ ok: true, userId, email: payload.email || '', sub: payload.sub });
  } catch (err) {
    console.warn('[web3auth] JWT verification failed:', err.message);
    res.status(401).json({ error: 'Invalid Web3Auth token', detail: err.message });
  }
});

// GET /auth/me — returns Web3Auth profile for a verified userId
app.get('/auth/me', (req, res) => {
  const { userId } = req.query;
  if (!userId || !userId.startsWith('w3a:')) return res.status(400).json({ error: 'w3a userId required' });
  const metaFile = path.join(userDir(userId), 'web3auth-meta.json');
  const meta     = readJSON(metaFile);
  if (!meta) return res.status(404).json({ error: 'User not found' });
  res.json(meta);
});

// Bulk sync — bot pushes full data file to Railway after every update
app.post('/sync', (req, res) => {
  const { userId = 'local', data } = req.body;
  if (!data) return res.status(400).json({ error: 'data required' });
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  writeJSON(file, data);
  res.json({ ok: true, count: (data.subscriptions || []).length });
});

// Get subscriptions
app.get('/subs', (req, res) => {
  const userId = req.query.userId || 'local';
  const file   = path.join(userDir(userId), 'scanned-subscriptions.json');
  const data   = readJSON(file);
  res.json(data || { subscriptions: [], cancellation_history: [], monthly_budget: null });
});

// Add a single subscription (from extension manual add)
app.post('/add-sub', (req, res) => {
  const { sub, userId = 'local' } = req.body;
  if (!sub || !sub.name) return res.status(400).json({ error: 'sub.name required' });
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  const data = readJSON(file) || { subscriptions: [], cancellation_history: [], monthly_budget: null };
  // Avoid duplicates by id
  data.subscriptions = data.subscriptions.filter(s => s.id !== sub.id);
  data.subscriptions.push(sub);
  writeJSON(file, data);
  res.json({ ok: true, count: data.subscriptions.length });
});

// Scan Gmail inbox
app.post('/scan', async (req, res) => {
  const { email, password, userId = 'local' } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const out = await runPy(`gmail-scanner.py --email "${email}" --password "${password}" --user-id ${userId}`);
    const file = path.join(userDir(userId), 'scanned-subscriptions.json');
    const data = readJSON(file);
    res.json(data || { subscriptions: [] });
  } catch(e) {
    res.status(500).json({ error: e.error || 'Scan failed', detail: e.stderr });
  }
});

// Run LLM-powered audit (delegates to llm-analyze.py for contextual reasoning)
app.post('/audit', async (req, res) => {
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
  const monthly = subs.reduce((sum, s) => sum + (s.monthly_cost_usd || s.monthly_cost || 0), 0);

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
app.get('/analysis', (req, res) => {
  const userId       = req.query.userId || 'local';
  const analysisFile = path.join(userDir(userId), 'llm-analysis.json');
  const analysis     = readJSON(analysisFile);
  if (!analysis) return res.status(404).json({ error: 'No analysis yet — run /audit first' });
  res.json(analysis);
});

// Export CSV (calls export.py)
app.post('/export', async (req, res) => {
  const { userId = 'local' } = req.body;
  try {
    await runPy(`export.py --user-id ${userId} --notify`);
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
app.post('/negotiate', async (req, res) => {
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
app.post('/log-decision', async (req, res) => {
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
app.get('/decisions', (req, res) => {
  const userId = req.query.userId || 'local';
  const file   = path.join(userDir(userId), 'decision-log.json');
  res.json(readJSON(file) || { decisions: [], totalSavedUSD: 0 });
});

// ── Vault routes ────────────────────────────────────────────────────────────

// GET /vault/:userId — full vault state
app.get('/vault/:userId', async (req, res) => {
  if (!vaultContract) return res.status(503).json({ error: 'Vault not configured', configured: false });
  const { ethers } = require('ethers');
  try {
    const r = await vaultContract.getVault(req.params.userId);
    res.json({
      principal:        ethers.formatEther(r.principal),
      credits:          ethers.formatEther(r.credits),
      pending:          ethers.formatEther(r.pending),
      totalYieldEarned: ethers.formatEther(r.totalYieldEarned),
      totalSpent:       ethers.formatEther(r.totalSpent),
      selfSustaining:   r.selfSustaining,
      vaultAddress:     process.env.VAULT_CONTRACT_ADDRESS,
      apy:              '10%',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /vault/harvest — agent harvests pending yield into credits
app.post('/vault/harvest', async (req, res) => {
  if (!vaultContract) return res.status(503).json({ error: 'Vault not configured' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const tx    = await vaultContract.harvestYield(userId);
    const rcpt  = await tx.wait();
    const { ethers } = require('ethers');
    const r     = await vaultContract.getVault(userId);
    res.json({ ok: true, txHash: tx.hash, credits: ethers.formatEther(r.credits) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /vault/spend — agent spends credits for an operation
app.post('/vault/spend', async (req, res) => {
  if (!vaultContract) return res.status(503).json({ error: 'Vault not configured' });
  const { userId, action } = req.body;
  if (!userId || !action) return res.status(400).json({ error: 'userId and action required' });

  const COSTS = { scan: '2000000000000000', audit: '2000000000000000',
                  negotiate: '5000000000000000', export: '1000000000000000' };
  const cost = COSTS[action];
  if (!cost) return res.status(400).json({ error: `Unknown action: ${action}` });

  try {
    const tx = await vaultContract.spendCredits(userId, cost, action);
    await tx.wait();
    const { ethers } = require('ethers');
    const r  = await vaultContract.getVault(userId);
    res.json({ ok: true, txHash: tx.hash, action, costCUSD: ethers.formatEther(cost),
               creditsRemaining: ethers.formatEther(r.credits) });
  } catch (e) {
    // If vault credits are insufficient, fall back to wallet balance (old pay-per-run)
    res.status(402).json({ error: e.message, fallback: 'wallet_balance' });
  }
});

// POST /vault/withdraw — return principal to user's wallet
app.post('/vault/withdraw', async (req, res) => {
  if (!vaultContract) return res.status(503).json({ error: 'Vault not configured' });
  const { userId, amount, toAddress } = req.body;
  if (!userId || !amount || !toAddress) return res.status(400).json({ error: 'userId, amount, toAddress required' });
  try {
    const { ethers } = require('ethers');
    const tx = await vaultContract.withdrawPrincipal(userId, ethers.parseEther(String(amount)), toAddress);
    await tx.wait();
    res.json({ ok: true, txHash: tx.hash, amount, toAddress });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /vault/fund-reserve — fund yield reserve (admin)
app.post('/vault/fund-reserve', async (req, res) => {
  res.json({ vaultAddress: process.env.VAULT_CONTRACT_ADDRESS,
             instructions: 'Deposit G$ into the vault — it is supplied to Aave automatically.' });
});

// ── Unified charge endpoint ────────────────────────────────────────────────
// Tries vault first (yield credits). Falls back to pay-per-run if no vault.
// Python scripts call this instead of /vault/spend directly.
//
// Response when vault covers it:  { ok:true, mode:'vault', txHash, costCUSD }
// Response when pay-per-run:      { ok:false, mode:'pay_per_run', costCUSD, payTo, instructions }

const OP_COSTS_CUSD = { scan: 0.002, audit: 0.002, negotiate: 0.005, export: 0.001 };

app.post('/charge', async (req, res) => {
  const { userId, action } = req.body;
  if (!userId || !action) return res.status(400).json({ error: 'userId and action required' });

  const costCUSD = OP_COSTS_CUSD[action];
  if (costCUSD === undefined) return res.status(400).json({ error: `Unknown action: ${action}` });

  const { ethers } = require('ethers');
  const costWei = ethers.parseEther(String(costCUSD)).toString();

  // ── Try vault mode first ──────────────────────────────────────────────────
  if (vaultContract) {
    try {
      const vault = await vaultContract.getVault(userId);
      if (vault.credits >= BigInt(costWei)) {
        const tx = await vaultContract.spendCredits(userId, costWei, action);
        await tx.wait();
        const updated = await vaultContract.getVault(userId);
        return res.json({
          ok: true,
          mode: 'vault',
          txHash: tx.hash,
          action,
          costCUSD,
          creditsRemaining: ethers.formatEther(updated.credits)
        });
      }
    } catch (e) {
      // vault call failed — fall through to pay-per-run
    }
  }

  // ── Free tier fallback ────────────────────────────────────────────────────
  // No vault deposit? Operations run free. Usage is tracked so users can see
  // what the vault would cover. The vault pitch lands after they've seen value.
  const file   = path.join(userDir(userId), 'free-usage.json');
  const usage  = readJSON(file) || { total: 0, actions: [] };
  usage.total  += 1;
  usage.actions = [{ action, costCUSD, ts: new Date().toISOString() }, ...usage.actions].slice(0, 100);
  writeJSON(file, usage);

  res.json({
    ok: true,
    mode: 'free',
    action,
    costCUSD,
    totalFreeRuns: usage.total,
    hint: usage.total >= 5 ? `You've run ${usage.total} operations free. Deposit G$ into the vault and it runs forever from yield.` : null
  });
});

// GET /charge-mode/:userId — tells the bot/frontend which mode the user is in
app.get('/charge-mode/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!vaultContract) return res.json({ mode: 'free', canRunNow: true });

  try {
    const { ethers } = require('ethers');
    const vault = await vaultContract.getVault(userId);
    const hasPrincipal = vault.principal > 0n;
    const hasCredits   = vault.credits > 0n;
    res.json({
      mode: hasPrincipal ? 'vault' : 'free',
      principal: ethers.formatEther(vault.principal),
      credits:   ethers.formatEther(vault.credits),
      selfSustaining: vault.selfSustaining,
      vaultActive: hasPrincipal,
      canRunNow: true   // always true — free tier has no gate
    });
  } catch (e) {
    res.json({ mode: 'pay_per_run', error: e.message });
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
app.post('/deduct', (req, res) => {
  const { action, cost, walletAddress, userId = 'local' } = req.body;
  const file   = path.join(userDir(userId), 'credits.json');
  const ledger = readJSON(file) || { walletAddress, transactions: [] };
  ledger.walletAddress = walletAddress || ledger.walletAddress;
  ledger.transactions  = [{ type:'deduct', action, amount: cost, ts: new Date().toISOString() }, ...ledger.transactions].slice(0, 200);
  writeJSON(file, ledger);
  res.json({ ok: true });
});

// Get credit history
app.get('/history', (req, res) => {
  const userId = req.query.userId || 'local';
  const file   = path.join(userDir(userId), 'credits.json');
  res.json(readJSON(file) || { transactions: [] });
});

// Save budget
app.post('/budget', (req, res) => {
  const { budget, userId = 'local' } = req.body;
  const file = path.join(userDir(userId), 'scanned-subscriptions.json');
  const data = readJSON(file) || { subscriptions: [], cancellation_history: [] };
  data.monthly_budget = budget;
  writeJSON(file, data);
  res.json({ ok: true, budget });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SubBot Bridge] Running at http://0.0.0.0:${PORT}`);
  console.log(`[SubBot Bridge] HERMES_HOME: ${HERMES_HOME}`);
});
