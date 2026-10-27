const fs = require('fs');
const express = require('express');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function createTelemetryRouter({ file, key = '' }) {
  const router = express.Router();
  const TELE_FILE = file;
  const TELE_KEY = key;
  if (!TELE_KEY) console.warn('[SubBot] TELEMETRY_KEY not set — /telemetry/stats will reject all requests until it is configured.');
  const teleEvents = [];
  const userMap    = Object.create(null); // userId → { email, subCount, sessions, lastSeen, pwa, loginCount }

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

  router.post('/telemetry', (req, res) => {
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

  router.get('/telemetry/stats', (req, res) => {
    if (!TELE_KEY || req.query.key !== TELE_KEY) return res.status(401).send('Unauthorized');
    const now = Date.now();
    const DAY = 86400000;
    const e1d = teleEvents.filter(e => now - e.ts < DAY);
    const e7d = teleEvents.filter(e => now - e.ts < 7 * DAY);

    const countBy = (arr, fn) => {
      const m = Object.create(null);
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
    const row = (...cells) => `<tr>${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
    const tbl = (heads, rows) => `<table><thead><tr>${heads.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

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
    users.map(u => `<tr>${[
      u.email,
      u.subCount,
      u.sessions,
      u.loginCount,
      fmt(u.lastSeen),
    ].map(c => `<td>${escapeHtml(c)}</td>`).join('')}<td><span class="badge ${u.pwa?'pwa':'web'}">${u.pwa?'PWA':'Browser'}</span></td></tr>`)
  )}

  <h2>Screen Views</h2>
  ${tbl(['Screen','Views'], screens.map(([s,c]) => row(s,c)))}

  <h2>Actions</h2>
  ${tbl(['Action','Count'], actions.map(([a,c]) => row(a,c)))}

  <h2>Daily Sessions (7d)</h2>
  ${tbl(['Date','Sessions'], dailyRows.map(([d,c]) => row(d,c)))}

  <p style="margin-top:24px;font-size:11px;color:#444">Last updated: ${fmt(now)}</p>
  </body></html>`;

    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });
  return router;
}

module.exports = { createTelemetryRouter };
