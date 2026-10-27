/**
 * Session auth for api-bridge.js — split into its own module so it can be
 * unit-tested without booting the whole Express app (contract init,
 * telemetry load, etc).
 *
 * Closes the IDOR where any client could read/write another user's data by
 * just naming their userId — every user-scoped endpoint requires a session
 * token that was issued for that exact userId.
 */
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn('[SubBot] SESSION_SECRET not set — using an ephemeral secret. All sessions will invalidate on the next restart. Set SESSION_SECRET in .env for production.');
  return generated;
})();
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
if (!INTERNAL_SERVICE_TOKEN) {
  console.warn('[SubBot] INTERNAL_SERVICE_TOKEN not set — /log-decision and /decisions will reject all requests until it is configured.');
}
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — personal-finance app, avoid re-login churn

function issueSessionToken(userId, secret = SESSION_SECRET) {
  const expiry  = Date.now() + SESSION_TTL_MS;
  const payload = `${Buffer.from(String(userId)).toString('base64url')}.${expiry}`;
  const sig     = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token, secret = SESSION_SECRET) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userIdB64, expiryStr, sig] = parts;
  const payload     = `${userIdB64}.${expiryStr}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf      = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  const expiry = parseInt(expiryStr, 10);
  if (!expiry || Date.now() > expiry) return null;
  try {
    return Buffer.from(userIdB64, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
}

// Every supplied identifier must name the same authenticated account. Checking
// only the first one lets a GET body mask a different query/path account.
function requireSession(req, res, next) {
  const ids = [req.body?.userId, req.query?.userId, req.params?.userId].filter(id => id !== undefined);
  if (!ids.length || ids.some(id => typeof id !== 'string' || !id || id === 'local')) {
    return res.status(401).json({ error: 'Sign in to access account data' });
  }
  const userId = ids[0];
  if (ids.some(id => id !== userId)) return res.status(400).json({ error: 'Conflicting user IDs' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const verifiedUserId = verifySessionToken(token);
  if (!verifiedUserId || verifiedUserId !== userId) {
    return res.status(401).json({ error: 'Unauthorized — session missing or does not match userId' });
  }
  req.userId = verifiedUserId;
  next();
}

// Guards server-to-server calls (the cron scripts logging decisions on-chain)
// — this is the only path that spends real gas, so it's the highest-value
// target for abuse if left open to anyone who can reach the API.
function requireInternalToken(req, res, next) {
  const provided = req.headers['x-internal-token'] || '';
  if (!INTERNAL_SERVICE_TOKEN || !provided) return res.status(401).json({ error: 'Unauthorized' });
  const a = Buffer.from(String(provided));
  const b = Buffer.from(INTERNAL_SERVICE_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { issueSessionToken, verifySessionToken, requireSession, requireInternalToken };
